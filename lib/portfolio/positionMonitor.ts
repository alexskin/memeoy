// Simulated equivalent of repo-reference/bot.ts's priceMatch(): one shared
// interval (not per-position timers) marks every open position to market,
// closes on take-profit/stop-loss/timeout, and pays the same simulated
// latency+slippage cost on the way out that an entry pays on the way in
// (fillSimulator.simulateSell runs the identical decision->latency->fill
// pipeline as a buy). Venue-agnostic: each tracked position carries its own
// PriceSource (Raydium AMM pool, pump.fun bonding curve, ...) so this file
// has no venue-specific code at all.
import { simulateSell, totalFeesPaid } from '../fillSimulator/fillSimulator';
import { insertFill, updatePositionPeak } from '../db';
import * as ledger from './ledger';
import { PriceSource, uiAmountToRaw } from '../priceSource/types';
import { PEAK_PROFIT_UNSET, PositionStatus, StrategyConfig } from '../types';
import { getTokensBatch } from '../dexscreener/client';
import { DexScreenerPair } from '../dexscreener/types';
import { logger } from '../logger';
import { withTimeout } from '../solana/withTimeout';
import { ResolvedRiskParams } from './riskParams';
import { decideExit } from '../agent/exitDecisionEngine';
import { summarizeRecentPerformanceBySignal } from '../agent/stats';

const QUOTE_TIMEOUT_MS = 15_000;

// Best-effort DexScreener market-cap snapshot at the moment a position (or
// its final leg) closes - never blocks the close itself if unavailable.
async function fetchExitMarketCapUsd(baseMint: string): Promise<number | null> {
  try {
    const pairs = await getTokensBatch('solana', [baseMint]);
    const pair = pairs.get(baseMint);
    return pair?.marketCap ?? pair?.fdv ?? null;
  } catch {
    return null;
  }
}

// A position is treated as fully liquidated once its remaining size drops
// below this fraction of the original - avoids leaving a dust-sized
// leftover open forever due to float rounding across several partial exits.
const DUST_FRACTION_OF_ORIGINAL = 0.001;

export interface TrackedPosition {
  positionId: number;
  priceSource: PriceSource;
  baseMint: string;
  quoteSizeInUi: number;
  baseAmountHeldUi: number;
  openedAt: number;
  peakProfitPct: number;
  originalBaseAmountHeldUi: number;
  originalQuoteSizeInUi: number;
  /** Target pcts (from riskParams.takeProfitTargets) already fired for this position, so a live-edited config doesn't refire one or lose track across a hot-reload. */
  targetsFired: Set<number>;
  /** Resolved once at track()-time via lib/portfolio/riskParams.ts (source-dependent - see that file) - NOT re-read from the live global config on every tick, unlike priceCheckIntervalMs/priceCheckDurationMs below. */
  riskParams: ResolvedRiskParams;
}

export type BroadcastFn = (event: string, payload: unknown) => void;
export type ConfigAccessor = () => { config: StrategyConfig; versionId: number };

const EQUITY_SNAPSHOT_INTERVAL_MS = 60_000;

export class PositionMonitor {
  private tracked = new Map<number, TrackedPosition>();
  private timer: NodeJS.Timeout | null = null;
  private lastSnapshotAt = 0;
  // Kept out of TrackedPosition (a caller-constructed shape from
  // scripts/worker.ts) so wiring in the AI exit review didn't require
  // touching every track() call site - defaults to the position's openedAt
  // the first time it's checked, so a fresh position gets its first review
  // aiExitReviewIntervalMs after opening, not immediately.
  private lastAiExitReviewAt = new Map<number, number>();
  // Effective timeout deadline per position, once it's been pushed out by a
  // granted extension - absent means "use openedAt + priceCheckDurationMs
  // unmodified". timeoutExtensionUsed caps this at exactly one grant per
  // position, ever, regardless of how many more times nearingTimeout is
  // true afterward (it won't be, once the deadline itself has moved, but
  // the flag is the actual source of truth in case of an edge case where
  // it's checked again right at the new deadline).
  private timeoutDeadlineOverride = new Map<number, number>();
  private timeoutExtensionUsed = new Set<number>();
  // Confirmed bug: setInterval doesn't wait for the previous tick() to
  // finish. Under RPC rate-limiting a tick can take far longer than
  // priceCheckIntervalMs, so several ticks were running concurrently, each
  // independently evaluating and closing the SAME tracked position -
  // observed live as up to 12 duplicate "successful sell" fills and a
  // balance credited once per duplicate close. This flag makes overlapping
  // timer fires (and a concurrent forceCloseAll()) a no-op instead of a
  // re-entrant run.
  private tickInFlight = false;
  // Set at the end of every completed tick (success or handled error) - lets
  // an external watchdog (scripts/worker.ts) tell "tick is legitimately idle
  // because nothing's tracked" apart from "tick is wedged" without needing
  // its own copy of the interval math.
  private lastTickCompletedAt = 0;

  getLastTickCompletedAt(): number {
    return this.lastTickCompletedAt;
  }

  constructor(
    private readonly getActiveConfig: ConfigAccessor,
    private readonly broadcast: BroadcastFn,
  ) {}

  track(position: TrackedPosition) {
    this.tracked.set(position.positionId, position);
  }

  untrack(positionId: number) {
    this.tracked.delete(positionId);
    this.lastAiExitReviewAt.delete(positionId);
    this.timeoutDeadlineOverride.delete(positionId);
    this.timeoutExtensionUsed.delete(positionId);
  }

  trackedCount(): number {
    return this.tracked.size;
  }

  start() {
    const { config } = this.getActiveConfig();
    this.timer = setInterval(() => {
      this.tick().catch((error) => logger.error({ error: String(error) }, 'positionMonitor tick failed'));
    }, Math.max(500, config.priceCheckIntervalMs));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick() {
    if (this.tickInFlight) {
      logger.debug({}, 'Skipping tick - previous tick still in flight (RPC likely rate-limited)');
      return;
    }
    this.tickInFlight = true;

    try {
      const { config, versionId } = this.getActiveConfig();
      let openUnrealizedQuote = 0;
      const now = Date.now();
      const trackedPositions = Array.from(this.tracked.values());

      // One batched DexScreener call for every tracked position's momentum,
      // not one per position - same reasoning as watchlistMonitor.ts. Only
      // fetched when the AI exit review is actually enabled; a fetch
      // failure just means every position's momentum context is null this
      // tick, not a tick failure (decideExit treats null as "unavailable").
      let momentumByMint = new Map<string, DexScreenerPair | null>();
      if (config.aiExitReviewEnabled && trackedPositions.length > 0) {
        try {
          momentumByMint = await getTokensBatch('solana', trackedPositions.map((p) => p.baseMint));
        } catch (error) {
          logger.debug({ error: String(error) }, 'positionMonitor: momentum batch fetch failed, exit reviews will see null momentum this tick');
        }
      }

      for (const position of trackedPositions) {
        try {
          openUnrealizedQuote += await this.evaluatePosition(position, config, versionId, now, momentumByMint.get(position.baseMint) ?? null);
        } catch (error) {
          logger.error({ positionId: position.positionId, error: String(error) }, 'Failed to evaluate position');
        }
      }

      if (now - this.lastSnapshotAt >= EQUITY_SNAPSHOT_INTERVAL_MS) {
        this.lastSnapshotAt = now;
        ledger.recordEquitySnapshot(config, openUnrealizedQuote, now);
        this.broadcast('equity.snapshot', { ts: now, openUnrealizedQuote });
      }
    } finally {
      this.tickInFlight = false;
      this.lastTickCompletedAt = Date.now();
    }
  }

  // "SELL ALL" dashboard control: force-closes every tracked position right
  // now regardless of TP/SL/trailing state. Shares the tickInFlight guard so
  // it can never race a normal tick - if one is in flight this returns
  // skipped>0 and the caller (scripts/worker.ts's control poll) just retries
  // on its next cycle, since the request stays pending until fully processed.
  async forceCloseAll(): Promise<{ closed: number; skipped: number }> {
    if (this.tickInFlight) {
      return { closed: 0, skipped: this.tracked.size };
    }
    this.tickInFlight = true;

    try {
      const { config, versionId } = this.getActiveConfig();
      const now = Date.now();
      let closed = 0;

      for (const position of Array.from(this.tracked.values())) {
        try {
          const didClose = await this.closeNow(position, config, versionId, now, 'closed_manual');
          if (didClose) closed++;
        } catch (error) {
          logger.error({ positionId: position.positionId, error: String(error) }, 'Failed to force-close position');
        }
      }

      return { closed, skipped: 0 };
    } finally {
      this.tickInFlight = false;
    }
  }

  // Returns this position's current unrealized value in quote units (0 if it closed this tick).
  private async evaluatePosition(
    position: TrackedPosition,
    config: StrategyConfig,
    versionId: number,
    now: number,
    momentum: DexScreenerPair | null,
  ): Promise<number> {
    const amountInRaw = uiAmountToRaw(position.baseAmountHeldUi, position.priceSource.baseDecimals);
    const markQuote = await withTimeout(position.priceSource.getQuote('sell', amountInRaw, 0), QUOTE_TIMEOUT_MS, 'mark-to-market quote');

    const currentValueQuote = position.baseAmountHeldUi * markQuote.executionPrice;
    const profitPct = ((currentValueQuote - position.quoteSizeInUi) / position.quoteSizeInUi) * 100;

    if (profitPct > position.peakProfitPct) {
      position.peakProfitPct = profitPct;
      updatePositionPeak(position.positionId, profitPct);
    }

    const hitStopLoss = profitPct <= -position.riskParams.stopLossPct;

    // The hard deadline starts at openedAt + priceCheckDurationMs, but can
    // be pushed out ONCE by a real (non-fallback) AI 'hold' judgment made
    // on the review closest to that deadline - see the AI review block
    // below. Absent from the override map means "never extended".
    const baseDeadline = position.openedAt + config.priceCheckDurationMs;
    const effectiveDeadline = this.timeoutDeadlineOverride.get(position.positionId) ?? baseDeadline;
    const timedOut = config.priceCheckDurationMs > 0 && now >= effectiveDeadline;

    // Stop-loss/timeout are safety-first and always fully close whatever
    // remains, skipping the scaled-target logic below entirely.
    if (hitStopLoss || timedOut) {
      const status = hitStopLoss ? 'closed_sl' : 'closed_timeout';
      const didClose = await this.closeNow(position, config, versionId, now, status, {
        markPrice: markQuote.executionPrice,
        currentValueQuote,
        profitPct,
      });
      return didClose ? 0 : currentValueQuote;
    }

    if (config.aiExitReviewEnabled) {
      const lastReview = this.lastAiExitReviewAt.get(position.positionId) ?? position.openedAt;
      if (now - lastReview >= config.aiExitReviewIntervalMs) {
        this.lastAiExitReviewAt.set(position.positionId, now);

        const extensionUsed = this.timeoutExtensionUsed.has(position.positionId);
        const nearingTimeout =
          config.priceCheckDurationMs > 0 && !extensionUsed && effectiveDeadline - now <= config.aiExitReviewIntervalMs;

        const decision = await decideExit({
          baseMint: position.baseMint,
          unrealizedPnlPct: profitPct,
          peakProfitPct: position.peakProfitPct === PEAK_PROFIT_UNSET ? profitPct : position.peakProfitPct,
          minutesHeld: (now - position.openedAt) / 60_000,
          stopLossPct: position.riskParams.stopLossPct,
          takeProfitPct: position.riskParams.takeProfitPct,
          recentPerformance: summarizeRecentPerformanceBySignal(),
          recentBuys5m: momentum?.txns.m5?.buys ?? null,
          recentBuys1h: momentum?.txns.h1?.buys ?? null,
          volume24hUsd: momentum?.volume.h24 ?? null,
          priceChange1hPct: momentum?.priceChange.h1 ?? null,
          nearingTimeout,
          timeoutExtensionAvailable: nearingTimeout,
        });
        logger.info(
          { positionId: position.positionId, baseMint: position.baseMint, action: decision.action, source: decision.source, reasoning: decision.reasoning, nearingTimeout },
          'AI exit review',
        );

        if (decision.action === 'exit') {
          const didClose = await this.closeNow(
            position,
            config,
            versionId,
            now,
            'closed_ai_exit',
            { markPrice: markQuote.executionPrice, currentValueQuote, profitPct },
            decision.reasoning,
          );
          return didClose ? 0 : currentValueQuote;
        }

        // A real LLM judgment (never a fallback - see decideExit's
        // fallbackDecision comment) choosing to hold while nearingTimeout
        // is the one-time permission to push the deadline out. Applies
        // immediately so later ticks this same session see the new
        // deadline before it would otherwise have fired.
        if (nearingTimeout && decision.source === 'llm') {
          this.timeoutDeadlineOverride.set(position.positionId, baseDeadline + config.aiTimeoutExtensionMs);
          this.timeoutExtensionUsed.add(position.positionId);
          logger.info(
            { positionId: position.positionId, baseMint: position.baseMint, extensionMs: config.aiTimeoutExtensionMs },
            'AI granted a one-time timeout extension',
          );
        }
      }
    }

    // Multi-target scaled take-profit: sell a fraction of the ORIGINAL size
    // at each not-yet-fired ascending target crossed this tick, before the
    // exitStrategy logic below runs on whatever fraction remains. Relies on
    // profitPct being a price ratio, not size-dependent - decrementing
    // baseAmountHeldUi/quoteSizeInUi proportionally leaves it unchanged, so
    // the trailing/stop-loss math needs no further changes.
    const targets = [...position.riskParams.takeProfitTargets].sort((a, b) => a.pct - b.pct);
    for (const target of targets) {
      if (position.targetsFired.has(target.pct)) continue;
      if (profitPct < target.pct) continue;
      if (position.baseAmountHeldUi <= position.originalBaseAmountHeldUi * DUST_FRACTION_OF_ORIGINAL) break;

      const amountToSellUi = Math.min(position.originalBaseAmountHeldUi * target.sellFraction, position.baseAmountHeldUi);
      const fired = await this.fireTarget(position, config, versionId, now, target, amountToSellUi);
      if (fired) position.targetsFired.add(target.pct);

      if (!this.tracked.has(position.positionId)) return 0; // fully liquidated by this target
    }

    let hitTakeProfit: boolean;
    if (position.riskParams.exitStrategy === 'trailing') {
      // Don't sell the instant the target is hit - keep tracking the peak
      // and only sell once price has pulled back trailingStopPct from it,
      // so a genuine pump keeps running instead of being capped early.
      const activated = position.peakProfitPct >= position.riskParams.trailingActivationPct;
      hitTakeProfit = activated && profitPct <= position.peakProfitPct - position.riskParams.trailingStopPct;
    } else {
      hitTakeProfit = profitPct >= position.riskParams.takeProfitPct;
    }

    if (!hitTakeProfit) {
      this.broadcast('position.updated', {
        positionId: position.positionId,
        markPrice: markQuote.executionPrice,
        unrealizedPnlQuote: currentValueQuote - position.quoteSizeInUi,
        unrealizedPnlPct: profitPct,
        peakProfitPct: position.peakProfitPct === PEAK_PROFIT_UNSET ? profitPct : position.peakProfitPct,
      });
      return currentValueQuote;
    }

    const didClose = await this.closeNow(position, config, versionId, now, 'closed_tp', {
      markPrice: markQuote.executionPrice,
      currentValueQuote,
      profitPct,
    });

    return didClose ? 0 : currentValueQuote;
  }

  // Fires one scaled take-profit leg. Returns true if it actually sold
  // (caller marks the target as fired) - false on a failed sell, which
  // leaves the target un-fired so it's retried next tick (same "gas war
  // costs money even when it loses" pattern as closeNow()).
  private async fireTarget(
    position: TrackedPosition,
    config: StrategyConfig,
    versionId: number,
    now: number,
    target: { pct: number; sellFraction: number },
    amountToSellUi: number,
  ): Promise<boolean> {
    const outcome = await simulateSell(position.priceSource, amountToSellUi, config, position.positionId, versionId);

    for (const fill of outcome.fills) {
      fill.id = insertFill(fill);
    }
    const exitFeesQuote = totalFeesPaid(outcome.fills);

    if (!outcome.success || !outcome.finalFill) {
      ledger.chargeFees(config, exitFeesQuote);
      logger.warn({ positionId: position.positionId, targetPct: target.pct }, 'Partial take-profit sell failed after retries - will retry next tick');
      return false;
    }

    const grossQuoteReceivedUi = Number(outcome.finalFill.fillAmountOut) / 10 ** position.priceSource.quoteDecimals;
    const netQuoteReceivedUi = grossQuoteReceivedUi - exitFeesQuote;
    const quoteSizeInPortionUi = position.originalQuoteSizeInUi * target.sellFraction;

    const result = ledger.recordPartialExit({
      positionId: position.positionId,
      exitFillId: outcome.finalFill.id!,
      targetPct: target.pct,
      sellFractionOfOriginal: target.sellFraction,
      baseAmountSoldUi: amountToSellUi,
      quoteSizeInPortionUi,
      quoteReceivedUi: netQuoteReceivedUi,
      exitPrice: outcome.finalFill.fillExecutionPrice!,
      config,
      reason: 'target',
      closedAt: now,
    });

    position.baseAmountHeldUi = result.remainingBaseAmountHeldUi;
    position.quoteSizeInUi = result.remainingQuoteSizeInUi;

    this.broadcast('position.partialExit', {
      positionId: position.positionId,
      targetPct: target.pct,
      baseAmountSoldUi: amountToSellUi,
      quoteReceivedUi: netQuoteReceivedUi,
      realizedPnlQuote: result.realizedPnlQuote,
      remainingBaseAmountHeldUi: position.baseAmountHeldUi,
    });

    const isFinalLiquidation = position.baseAmountHeldUi <= position.originalBaseAmountHeldUi * DUST_FRACTION_OF_ORIGINAL;
    if (isFinalLiquidation) {
      const exitMarketCapUsd = await fetchExitMarketCapUsd(position.baseMint);
      ledger.finalizeFullyLiquidated(position.positionId, 'closed_tp', outcome.finalFill.id!, outcome.finalFill.fillExecutionPrice!, now, exitMarketCapUsd);
      this.untrack(position.positionId);
      this.broadcast('position.closed', { positionId: position.positionId, status: 'closed_tp', realizedPnlQuote: result.realizedPnlQuote });
    }

    return true;
  }

  // Shared by the normal TP/SL/timeout path and forceCloseAll(). Returns
  // true if the position actually closed (false if the sell failed after
  // retries and remains open/tracked for a later attempt).
  private async closeNow(
    position: TrackedPosition,
    config: StrategyConfig,
    versionId: number,
    now: number,
    status: Exclude<PositionStatus, 'open'>,
    markInfo?: { markPrice: number; currentValueQuote: number; profitPct: number },
    aiExitReasoning?: string,
  ): Promise<boolean> {
    const outcome = await simulateSell(position.priceSource, position.baseAmountHeldUi, config, position.positionId, versionId);

    for (const fill of outcome.fills) {
      fill.id = insertFill(fill);
    }
    const exitFeesQuote = totalFeesPaid(outcome.fills);

    if (!outcome.success || !outcome.finalFill) {
      // Failed exit attempts still paid fees, even though the position stays open.
      ledger.chargeFees(config, exitFeesQuote);
      logger.warn({ positionId: position.positionId }, `Simulated exit (${status}) failed after retries - will retry next tick`);
      this.broadcast('position.updated', {
        positionId: position.positionId,
        markPrice: markInfo?.markPrice,
        unrealizedPnlQuote: markInfo ? markInfo.currentValueQuote - position.quoteSizeInUi : undefined,
        unrealizedPnlPct: markInfo?.profitPct,
        exitPending: true,
      });
      return false;
    }

    const grossQuoteReceivedUi = Number(outcome.finalFill.fillAmountOut) / 10 ** position.priceSource.quoteDecimals;
    const netQuoteReceivedUi = grossQuoteReceivedUi - exitFeesQuote;
    const exitMarketCapUsd = await fetchExitMarketCapUsd(position.baseMint);

    ledger.closePositionAndSettle({
      positionId: position.positionId,
      status,
      exitFillId: outcome.finalFill.id!,
      quoteSizeInUi: position.quoteSizeInUi,
      quoteReceivedUi: netQuoteReceivedUi,
      exitPrice: outcome.finalFill.fillExecutionPrice!,
      config,
      closedAt: now,
      exitMarketCapUsd,
      aiExitReasoning: aiExitReasoning ?? null,
    });

    this.untrack(position.positionId);
    this.broadcast('position.closed', {
      positionId: position.positionId,
      status,
      realizedPnlQuote: netQuoteReceivedUi - position.quoteSizeInUi,
      aiExitReasoning,
    });

    return true;
  }
}
