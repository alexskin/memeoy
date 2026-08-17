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
  // Effective timeout deadline per position, once pushed out by one or more
  // granted extensions - absent means "use openedAt + priceCheckDurationMs
  // unmodified". Uncapped in count by design (see exitDecisionEngine.ts) -
  // each extension still requires a fresh real LLM judgment, and the AI is
  // told how many times it's already extended so it can hold itself to a
  // higher bar the more this has already happened.
  private timeoutDeadlineOverride = new Map<number, number>();
  private timeoutExtendCount = new Map<number, number>();
  private rodePastStopLossCount = new Map<number, number>();
  private rodePastTakeProfitCount = new Map<number, number>();
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
    this.timeoutExtendCount.delete(positionId);
    this.rodePastStopLossCount.delete(positionId);
    this.rodePastTakeProfitCount.delete(positionId);
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

  private broadcastPositionUpdate(position: TrackedPosition, markPrice: number, currentValueQuote: number, profitPct: number) {
    this.broadcast('position.updated', {
      positionId: position.positionId,
      markPrice,
      unrealizedPnlQuote: currentValueQuote - position.quoteSizeInUi,
      unrealizedPnlPct: profitPct,
      peakProfitPct: position.peakProfitPct === PEAK_PROFIT_UNSET ? profitPct : position.peakProfitPct,
    });
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

    // Multi-target scaled take-profit still fires mechanically and
    // unconditionally regardless of the AI layer below - these are
    // moderate partial profit-locks on ascending thresholds (e.g. 20%/50%),
    // not the final exit call, so they keep locking in some gain even on a
    // position the AI later chooses to ride hard on the remaining size.
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

    const hitStopLoss = profitPct <= -position.riskParams.stopLossPct;

    // The deadline starts at openedAt + priceCheckDurationMs and can be
    // pushed out repeatedly by real AI judgments below - absent from the
    // override map means "never extended yet".
    const baseDeadline = position.openedAt + config.priceCheckDurationMs;
    const effectiveDeadline = this.timeoutDeadlineOverride.get(position.positionId) ?? baseDeadline;
    const hitTimeout = config.priceCheckDurationMs > 0 && now >= effectiveDeadline;

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

    // AI exit review OFF entirely: fall back to the fully mechanical
    // behavior this file had before any of this existed - unconditional
    // stop-loss/timeout/take-profit, no LLM involved at all.
    if (!config.aiExitReviewEnabled) {
      if (hitStopLoss || hitTimeout) {
        const status = hitStopLoss ? 'closed_sl' : 'closed_timeout';
        const didClose = await this.closeNow(position, config, versionId, now, status, { markPrice: markQuote.executionPrice, currentValueQuote, profitPct });
        return didClose ? 0 : currentValueQuote;
      }
      if (hitTakeProfit) {
        const didClose = await this.closeNow(position, config, versionId, now, 'closed_tp', { markPrice: markQuote.executionPrice, currentValueQuote, profitPct });
        return didClose ? 0 : currentValueQuote;
      }
      this.broadcastPositionUpdate(position, markQuote.executionPrice, currentValueQuote, profitPct);
      return currentValueQuote;
    }

    // AI-driven path. Any trigger becoming active forces an immediate
    // review instead of waiting up to aiExitReviewIntervalMs to ask about a
    // fresh stop-loss/take-profit/timeout hit; otherwise reviews stay on
    // the normal cadence (token-conscious - not every 1s price tick).
    const anyTriggerActive = hitStopLoss || hitTakeProfit || hitTimeout;
    const lastReview = this.lastAiExitReviewAt.get(position.positionId) ?? position.openedAt;
    const reviewDue = anyTriggerActive || now - lastReview >= config.aiExitReviewIntervalMs;

    if (!reviewDue) {
      this.broadcastPositionUpdate(position, markQuote.executionPrice, currentValueQuote, profitPct);
      return currentValueQuote;
    }
    this.lastAiExitReviewAt.set(position.positionId, now);

    const slRideCount = this.rodePastStopLossCount.get(position.positionId) ?? 0;
    const tpRideCount = this.rodePastTakeProfitCount.get(position.positionId) ?? 0;
    const extendCount = this.timeoutExtendCount.get(position.positionId) ?? 0;

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
      stopLossReached: hitStopLoss,
      timesRodePastStopLoss: slRideCount,
      takeProfitReached: hitTakeProfit,
      timesRodePastTakeProfit: tpRideCount,
      timeoutReached: hitTimeout,
      timesAlreadyExtended: extendCount,
    });
    logger.info(
      { positionId: position.positionId, baseMint: position.baseMint, action: decision.action, source: decision.source, reasoning: decision.reasoning, hitStopLoss, hitTakeProfit, hitTimeout },
      'AI exit review',
    );

    const isRealJudgment = decision.source === 'llm';

    // Close if the AI actually chose to exit, OR a trigger is active but no
    // real judgment was available (fallback) - an unavailable/failed LLM
    // call must never itself grant a ride-past on a live trigger, so this
    // reverts to the mechanical behavior for whichever fired, most severe
    // first. A voluntary exit with no trigger active (plain early-exit
    // check) falls through to closed_ai_exit.
    if (decision.action === 'exit' || (anyTriggerActive && !isRealJudgment)) {
      const status: Exclude<PositionStatus, 'open'> = hitStopLoss ? 'closed_sl' : hitTimeout ? 'closed_timeout' : hitTakeProfit ? 'closed_tp' : 'closed_ai_exit';
      const didClose = await this.closeNow(
        position,
        config,
        versionId,
        now,
        status,
        { markPrice: markQuote.executionPrice, currentValueQuote, profitPct },
        isRealJudgment ? decision.reasoning : undefined,
      );
      return didClose ? 0 : currentValueQuote;
    }

    // Real LLM 'hold' - apply whichever overrides are relevant. Uncapped in
    // count; each one still required a fresh judgment this same tick.
    if (isRealJudgment) {
      if (hitStopLoss) {
        this.rodePastStopLossCount.set(position.positionId, slRideCount + 1);
        logger.info({ positionId: position.positionId, baseMint: position.baseMint, count: slRideCount + 1 }, 'AI rode past stop-loss');
      }
      if (hitTakeProfit) {
        this.rodePastTakeProfitCount.set(position.positionId, tpRideCount + 1);
        logger.info({ positionId: position.positionId, baseMint: position.baseMint, count: tpRideCount + 1 }, 'AI rode past take-profit');
      }
      if (hitTimeout) {
        this.timeoutDeadlineOverride.set(position.positionId, effectiveDeadline + config.aiTimeoutExtensionMs);
        this.timeoutExtendCount.set(position.positionId, extendCount + 1);
        logger.info({ positionId: position.positionId, baseMint: position.baseMint, count: extendCount + 1, extensionMs: config.aiTimeoutExtensionMs }, 'AI granted a timeout extension');
      }
    }

    this.broadcastPositionUpdate(position, markQuote.executionPrice, currentValueQuote, profitPct);
    return currentValueQuote;
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
