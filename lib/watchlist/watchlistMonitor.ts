// Periodically evaluates every 'watching' candidate against DexScreener
// momentum data and graduates the ones that pass to an actual simulated
// buy. Same shared-interval + tickInFlight re-entrancy guard as
// lib/portfolio/positionMonitor.ts - mandatory, this is the exact bug class
// that caused a real balance-corruption incident earlier this session when
// a slow tick overlapped with the next timer fire.
import { getTokensBatch } from '../dexscreener/client';
import { evaluateMomentum } from '../dexscreener/momentumFilter';
import { evaluateRevival } from '../dexscreener/revivalFilter';
import { getSocialLinkFromPair } from '../filters/socialLink';
import { getDegenScore } from '../degenScore/client';
import { decideCandidate } from '../agent/decisionEngine';
import { summarizeMissedRunnersBySignal, summarizeRecentPerformanceBySignal } from '../agent/stats';
import { getLastRunnerReviewStats } from '../agent/runnerReview';
import { getWatchlistPoolsBySource, insertAgentDecision, insertMomentumSnapshot, updatePoolStatus } from '../db';
import { DetectedPool, StrategyConfig } from '../types';
import { logger } from '../logger';

export type BuyCallback = (pool: DetectedPool) => Promise<void>;
export type BroadcastFn = (event: string, payload: unknown) => void;
export type ConfigAccessor = () => { config: StrategyConfig; versionId: number };

// Bounds how many candidates can graduate (onGraduate -> rebuildPriceSourceForPool
// + executeBuy, both RPC-heavy) within a single tick. Momentum/revival
// evaluation itself is cheap (one batched DexScreener call for the whole
// watchlist), but graduating is not - confirmed live: resuming from a PAUSE/
// STOP lets the watchlist backlog build up, and the first tick after resume
// can find a dozen+ candidates clearing their gate at once, firing that many
// RPC-heavy graduations back-to-back and 429-ing a free-tier Helius plan.
// Candidates beyond the cap are left untouched (still 'watching') rather
// than recorded as a decision that never acts on - they're re-evaluated
// with fresh data on the next tick instead of using a stale decision.
const MAX_GRADUATIONS_PER_TICK = 3;

export class WatchlistMonitor {
  private tickInFlight = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly getActiveConfig: ConfigAccessor,
    private readonly broadcast: BroadcastFn,
    private readonly onGraduate: BuyCallback,
  ) {}

  start() {
    const { config } = this.getActiveConfig();
    this.timer = setInterval(() => {
      this.tick().catch((error) => logger.error({ error: String(error) }, 'watchlist tick failed'));
    }, Math.max(2000, config.momentumPollIntervalMs));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick() {
    if (this.tickInFlight) {
      logger.debug({}, 'Skipping watchlist tick - previous still in flight');
      return;
    }
    this.tickInFlight = true;

    try {
      const { config, versionId } = this.getActiveConfig();
      const now = Date.now();
      // 'pumpfun' candidates are exclusively handled by
      // premigrationWatchlistMonitor - DexScreener has no data for
      // unmigrated pump.fun pairs (see scripts/worker.ts's top comment), so
      // this monitor evaluating them would only ever produce a permanent
      // "no data" fail.
      let candidates = getWatchlistPoolsBySource(['raydium', 'pumpswap']);

      if (candidates.length > config.momentumMaxWatchlistSize) {
        const overflowCount = candidates.length - config.momentumMaxWatchlistSize;
        const overflow = candidates.slice(0, overflowCount); // oldest first (getWatchlistPools orders by detected_at ASC)
        for (const c of overflow) {
          updatePoolStatus(c.id, 'skipped');
          this.broadcast('pool.status', { id: c.id, status: 'skipped' });
        }
        candidates = candidates.slice(overflowCount);
        logger.warn({ evicted: overflow.length }, 'Watchlist exceeded momentumMaxWatchlistSize - evicted oldest candidates');
      }

      // The revival gate deliberately targets candidates OLDER than the
      // momentum gate ever considers (12h-14d vs. momentum's <=12h) - the
      // eviction cap has to cover whichever window is wider, or a revival
      // candidate would get evicted here long before it's old enough for
      // evaluateRevival to ever see it.
      const maxAgeMinutes = Math.max(config.momentumMaxAgeMinutes, config.revivalMaxAgeMinutes);
      const stillLive: DetectedPool[] = [];
      for (const c of candidates) {
        const ageMinutes = (now - c.detectedAt) / 60_000;
        if (ageMinutes > maxAgeMinutes) {
          updatePoolStatus(c.id, 'rejected');
          this.broadcast('pool.status', { id: c.id, status: 'rejected' });
        } else {
          stillLive.push(c);
        }
      }
      if (stillLive.length === 0) return;

      const pairsByMint = await getTokensBatch('solana', stillLive.map((c) => c.baseMint));

      let graduationsThisTick = 0;

      for (const c of stillLive) {
        try {
          const pair = pairsByMint.get(c.baseMint) ?? null;
          const evaluation = evaluateMomentum(pair, c.detectedAt, config, now);

          insertMomentumSnapshot({
            detectedPoolId: c.id,
            checkedAt: now,
            liquidityUsd: pair?.liquidity?.usd ?? null,
            volume24hUsd: pair?.volume.h24 ?? null,
            buys1h: pair?.txns.h1?.buys ?? null,
            buys5m: pair?.txns.m5?.buys ?? null,
            priceChange1hPct: pair?.priceChange.h1 ?? null,
            priceChange24hPct: pair?.priceChange.h24 ?? null,
            pairAgeMinutes: evaluation.pairAgeMinutes,
            hasData: evaluation.hasData,
            pass: evaluation.pass,
            criteria: evaluation.results,
            configVersionId: versionId,
          });
          this.broadcast('momentum.updated', { detectedPoolId: c.id, pass: evaluation.pass, results: evaluation.results });

          // Revival is an ALTERNATE path to a buy, not a second gate stacked
          // on top of momentum - a genuine revival candidate is, by
          // definition, too old to ever clear momentum's freshness bar (see
          // the eviction-cap comment above), and a fresh momentum candidate
          // is too young to ever match revival's age floor. Either one
          // clearing its own gate is enough to reach the judgment step.
          const revival = evaluateRevival(pair, config, now);

          if (evaluation.pass || revival.pass) {
            const degen = config.degenScoreEnabled ? await getDegenScore(getSocialLinkFromPair(pair)) : null;

            const decision = config.decisionEngineEnabled
              ? await decideCandidate({
                  baseMint: c.baseMint,
                  momentum: evaluation,
                  revival,
                  degenScore: degen,
                  recentPerformance: summarizeRecentPerformanceBySignal(),
                  missedRunnerCalibration: summarizeMissedRunnersBySignal(getLastRunnerReviewStats()),
                })
              : {
                  action: 'buy' as const,
                  confidence: 1,
                  reasoning: 'decision engine disabled - deterministic gate only',
                  source: 'fallback' as const,
                };

            if (decision.action === 'buy' && graduationsThisTick >= MAX_GRADUATIONS_PER_TICK) {
              // Per-tick graduation cap reached - leave this candidate
              // exactly as it was (still 'watching', no decision recorded)
              // so it's re-evaluated with fresh data next tick instead of
              // firing another RPC-heavy graduation into an already-busy tick.
              logger.debug({ detectedPoolId: c.id }, 'Deferring graduation to next tick - per-tick graduation cap reached');
              continue;
            }

            insertAgentDecision({
              detectedPoolId: c.id,
              checkedAt: now,
              momentumPass: evaluation.pass,
              revivalPass: revival.pass,
              revivalStrength: revival.strengthScore,
              degenScore: degen?.score ?? null,
              degenVerdict: degen?.verdict ?? null,
              action: decision.action,
              confidence: decision.confidence,
              reasoning: decision.reasoning,
              source: decision.source,
              configVersionId: versionId,
            });
            this.broadcast('agent.decision', {
              detectedPoolId: c.id,
              baseMint: c.baseMint,
              venue: c.source,
              checkedAt: now,
              momentumPass: evaluation.pass,
              revivalPass: revival.pass,
              revivalStrength: revival.strengthScore,
              degenScore: degen?.score ?? null,
              degenVerdict: degen?.verdict ?? null,
              action: decision.action,
              confidence: decision.confidence,
              reasoning: decision.reasoning,
              source: decision.source,
            });

            if (decision.action === 'buy') {
              graduationsThisTick++;
              updatePoolStatus(c.id, 'passed');
              this.broadcast('pool.status', { id: c.id, status: 'passed' });
              await this.onGraduate(c);
            } else {
              // A REFUSED candidate - stays visible in the pools list with its
              // reasoning in agent_decisions, not silently dropped.
              updatePoolStatus(c.id, 'rejected');
              this.broadcast('pool.status', { id: c.id, status: 'rejected' });
            }
          }
        } catch (error) {
          logger.error({ detectedPoolId: c.id, error: String(error) }, 'Failed to evaluate watchlist candidate');
        }
      }
    } finally {
      this.tickInFlight = false;
    }
  }
}
