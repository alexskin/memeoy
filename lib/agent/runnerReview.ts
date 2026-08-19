// Periodic (interval-based, NOT trade-count-triggered like heuristicTuner)
// review of everything detected in a recent window - bought or skipped -
// against CURRENT DexScreener data. heuristicTuner.ts can only ever learn
// from trades we actually opened; this fills the real blind spot: a token
// we skipped or a filter rejected that then went on to pump hard, which
// heuristicTuner has no way to see. Produces two kinds of output:
//
// 1. Bounded config-diff suggestions (filters, entry/exit) through the
//    exact same lib/agent/agentRunner.ts pipeline (agent_suggestions,
//    propose→accept/reject in the dashboard's Strategy tab) - see
//    proposeChangesFromRunners below.
// 2. An advisory calibration string for decisionEngine.ts's prompt (see
//    lib/agent/stats.ts::summarizeMissedRunnersBySignal) reporting where the
//    degen-score judgment specifically missed a real runner - deliberately
//    NOT a new hard numeric gate (explicit product decision: degen score
//    stays LLM context, same as it is today).
import { getTokensBatch } from '../dexscreener/client';
import {
  getActiveConfigVersion,
  getDetectedPoolsInWindow,
  getEarliestMomentumSnapshotForPool,
  getLatestAgentDecisionForPool,
  getMeta,
  getPoolFilterResults,
  getPositionByDetectedPoolId,
  insertAgentSuggestion,
  insertConfigVersion,
  markPoolAsConfirmedRunner,
  setMeta,
  updateAgentSuggestionStatus,
} from '../db';
import { AgentDecision, DetectedPool, FilterOutcome, MomentumSnapshot, Position, StrategyConfig } from '../types';
import { applyDiff, BOUNDS, clampStep, ProposedDiff } from './heuristicTuner';
import { logger } from '../logger';

const LAST_RUN_META_KEY = 'last_runner_review_at';
const MIN_RUNNER_SAMPLE = 3;
const MIN_FILTER_SAMPLE = 5;
const MIN_BOUGHT_RUNNER_SAMPLE = 3;

export interface FilterPassRateStat {
  filterName: string;
  runnerPassRate: number | null;
  runnerSampleSize: number;
  nonRunnerPassRate: number | null;
  nonRunnerSampleSize: number;
}

// Same degen-score bucketing as lib/agent/stats.ts::summarizeRecentPerformanceBySignal.
export type DegenBucket = 'low' | 'mid' | 'high' | 'unknown';

export interface DegenBucketStat {
  bucket: DegenBucket;
  skippedCount: number;
  missedRunnerCount: number;
}

export interface RunnerReviewStats {
  windowHours: number;
  runnerThresholdPct: number;
  totalPoolsScanned: number;
  runnerCount: number;
  nonRunnerCount: number;
  avgEntryLiquidityUsdRunners: number;
  avgEntryLiquidityUsdNonRunners: number;
  avgEntry1hBuysRunners: number;
  avgEntry1hBuysNonRunners: number;
  avgEntry5mBuysRunners: number;
  avgEntry5mBuysNonRunners: number;
  avgEntryAgeMinutesRunners: number;
  avgEntryAgeMinutesNonRunners: number;
  filterPassRates: FilterPassRateStat[];
  boughtRunnerCount: number;
  boughtRunnerEarlyExitCount: number; // closed_sl, closed_timeout, or closed_structural
  boughtRunnerGoodExitCount: number; // closed_tp or closed_ai_exit
  degenBuckets: DegenBucketStat[];
}

function emptyStats(windowHours: number, runnerThresholdPct: number): RunnerReviewStats {
  return {
    windowHours,
    runnerThresholdPct,
    totalPoolsScanned: 0,
    runnerCount: 0,
    nonRunnerCount: 0,
    avgEntryLiquidityUsdRunners: 0,
    avgEntryLiquidityUsdNonRunners: 0,
    avgEntry1hBuysRunners: 0,
    avgEntry1hBuysNonRunners: 0,
    avgEntry5mBuysRunners: 0,
    avgEntry5mBuysNonRunners: 0,
    avgEntryAgeMinutesRunners: 0,
    avgEntryAgeMinutesNonRunners: 0,
    filterPassRates: [],
    boughtRunnerCount: 0,
    boughtRunnerEarlyExitCount: 0,
    boughtRunnerGoodExitCount: 0,
    degenBuckets: [],
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function degenBucket(score: number | null | undefined): DegenBucket {
  if (score == null) return 'unknown';
  if (score < 40) return 'low';
  if (score < 70) return 'mid';
  return 'high';
}

interface PoolContext {
  pool: DetectedPool;
  isRunner: boolean;
  entrySnapshot: MomentumSnapshot | null;
  filters: FilterOutcome[];
  decision: AgentDecision | null;
  position: Position | null;
}

// getPoolFilterResults orders by checkedAt ASC - the last match for a given
// filterName is that pool's final outcome for it (a filter can be retried
// several times, e.g. renouncedFreeze polling for the authority to clear).
function latestFilterPass(filters: FilterOutcome[], filterName: string): boolean | null {
  const matches = filters.filter((f) => f.filterName === filterName);
  return matches.length > 0 ? matches[matches.length - 1].pass : null;
}

let lastStats: RunnerReviewStats | null = null;

// lib/watchlist/watchlistMonitor.ts reads this synchronously on every
// decision to build the missed-runner calibration line - it must never
// block a live buy/skip judgment on a fresh multi-hundred-pool DexScreener
// scan, so it always reads whatever the last completed run produced.
export function getLastRunnerReviewStats(): RunnerReviewStats | null {
  return lastStats;
}

export async function computeRunnerReviewStats(config: StrategyConfig): Promise<RunnerReviewStats> {
  const sinceMs = Date.now() - config.runnerLookbackHours * 60 * 60 * 1000;
  const pools = getDetectedPoolsInWindow(sinceMs);
  if (pools.length === 0) {
    const stats = emptyStats(config.runnerLookbackHours, config.runnerThresholdPct);
    lastStats = stats;
    return stats;
  }

  const pairsByMint = await getTokensBatch('solana', pools.map((p) => p.baseMint));

  const contexts: PoolContext[] = pools.map((pool) => {
    const pair = pairsByMint.get(pool.baseMint) ?? null;
    const isRunner =
      !!pair &&
      (pair.priceChange.h24 ?? 0) >= config.runnerThresholdPct &&
      (pair.liquidity?.usd ?? 0) >= config.runnerMinLiquidityUsd;
    return {
      pool,
      isRunner,
      entrySnapshot: getEarliestMomentumSnapshotForPool(pool.id),
      filters: getPoolFilterResults(pool.id),
      decision: getLatestAgentDecisionForPool(pool.id),
      position: getPositionByDetectedPoolId(pool.id),
    };
  });

  const runners = contexts.filter((c) => c.isRunner);
  const nonRunners = contexts.filter((c) => !c.isRunner);

  // Persist the classification (lib/agent/walletReputation.ts joins against
  // this) - idempotent, harmless to re-mark the same pool across later
  // review cycles while it's still in the lookback window.
  for (const c of runners) markPoolAsConfirmedRunner(c.pool.id);

  function avgSnapshot(ctxs: PoolContext[], pick: (s: MomentumSnapshot) => number | null): number {
    return mean(ctxs.map((c) => (c.entrySnapshot ? pick(c.entrySnapshot) : null)).filter((v): v is number => v != null));
  }

  const filterNames = new Set<string>();
  for (const c of contexts) for (const f of c.filters) filterNames.add(f.filterName);

  const filterPassRates: FilterPassRateStat[] = [...filterNames].map((filterName) => {
    const runnerOutcomes = runners.map((c) => latestFilterPass(c.filters, filterName)).filter((v): v is boolean => v != null);
    const nonRunnerOutcomes = nonRunners.map((c) => latestFilterPass(c.filters, filterName)).filter((v): v is boolean => v != null);
    return {
      filterName,
      runnerPassRate: runnerOutcomes.length ? runnerOutcomes.filter(Boolean).length / runnerOutcomes.length : null,
      runnerSampleSize: runnerOutcomes.length,
      nonRunnerPassRate: nonRunnerOutcomes.length ? nonRunnerOutcomes.filter(Boolean).length / nonRunnerOutcomes.length : null,
      nonRunnerSampleSize: nonRunnerOutcomes.length,
    };
  });

  const boughtRunners = runners.filter((c) => c.position && c.position.status !== 'open');
  const boughtRunnerEarlyExitCount = boughtRunners.filter(
    (c) => c.position!.status === 'closed_sl' || c.position!.status === 'closed_timeout' || c.position!.status === 'closed_structural',
  ).length;
  const boughtRunnerGoodExitCount = boughtRunners.filter(
    (c) => c.position!.status === 'closed_tp' || c.position!.status === 'closed_ai_exit',
  ).length;

  const degenBuckets: DegenBucketStat[] = (['low', 'mid', 'high', 'unknown'] as const).map((bucket) => {
    const skipped = contexts.filter((c) => c.decision?.action === 'skip' && degenBucket(c.decision.degenScore) === bucket);
    return { bucket, skippedCount: skipped.length, missedRunnerCount: skipped.filter((c) => c.isRunner).length };
  });

  const stats: RunnerReviewStats = {
    windowHours: config.runnerLookbackHours,
    runnerThresholdPct: config.runnerThresholdPct,
    totalPoolsScanned: pools.length,
    runnerCount: runners.length,
    nonRunnerCount: nonRunners.length,
    avgEntryLiquidityUsdRunners: avgSnapshot(runners, (s) => s.liquidityUsd),
    avgEntryLiquidityUsdNonRunners: avgSnapshot(nonRunners, (s) => s.liquidityUsd),
    avgEntry1hBuysRunners: avgSnapshot(runners, (s) => s.buys1h),
    avgEntry1hBuysNonRunners: avgSnapshot(nonRunners, (s) => s.buys1h),
    avgEntry5mBuysRunners: avgSnapshot(runners, (s) => s.buys5m),
    avgEntry5mBuysNonRunners: avgSnapshot(nonRunners, (s) => s.buys5m),
    avgEntryAgeMinutesRunners: avgSnapshot(runners, (s) => s.pairAgeMinutes),
    avgEntryAgeMinutesNonRunners: avgSnapshot(nonRunners, (s) => s.pairAgeMinutes),
    filterPassRates,
    boughtRunnerCount: boughtRunners.length,
    boughtRunnerEarlyExitCount,
    boughtRunnerGoodExitCount,
    degenBuckets,
  };
  lastStats = stats;
  return stats;
}

// Same bounded-step, single-change-per-run style as heuristicTuner.ts's
// proposeChanges - deliberately never touches degenScoreEnabled or any
// degen threshold (see the file header).
export function proposeChangesFromRunners(stats: RunnerReviewStats, config: StrategyConfig): ProposedDiff | null {
  if (stats.runnerCount < MIN_RUNNER_SAMPLE) return null;

  const diff: Record<string, { old: unknown; new: unknown }> = {};
  const reasons: string[] = [];

  // Rule 1: runners' entry liquidity sits at/below the current floor and
  // below what non-runners typically had - the floor may be filtering out
  // real movers, not just noise.
  if (
    stats.avgEntryLiquidityUsdRunners > 0 &&
    stats.avgEntryLiquidityUsdRunners < config.momentumMinLiquidityUsd * 1.2 &&
    stats.avgEntryLiquidityUsdRunners < stats.avgEntryLiquidityUsdNonRunners
  ) {
    const next = clampStep(config.momentumMinLiquidityUsd, -1, 0.15, BOUNDS.momentumMinLiquidityUsd);
    if (next !== config.momentumMinLiquidityUsd) {
      diff.momentumMinLiquidityUsd = { old: config.momentumMinLiquidityUsd, new: next };
      reasons.push(
        `${stats.runnerCount} runners in the last ${stats.windowHours}h had avg entry liquidity $${stats.avgEntryLiquidityUsdRunners.toFixed(0)} - at/below the current $${config.momentumMinLiquidityUsd} floor and below non-runners' $${stats.avgEntryLiquidityUsdNonRunners.toFixed(0)} avg - lowering the floor ${config.momentumMinLiquidityUsd} -> ${next}.`,
      );
    }
  }

  // Rule 2: same shape for 1h buys.
  if (
    Object.keys(diff).length === 0 &&
    stats.avgEntry1hBuysRunners > 0 &&
    stats.avgEntry1hBuysRunners < config.momentumMin1hBuys * 1.2 &&
    stats.avgEntry1hBuysRunners < stats.avgEntry1hBuysNonRunners
  ) {
    const next = clampStep(config.momentumMin1hBuys, -1, 0.15, BOUNDS.momentumMin1hBuys);
    if (next !== config.momentumMin1hBuys) {
      diff.momentumMin1hBuys = { old: config.momentumMin1hBuys, new: next };
      reasons.push(
        `Runners' avg entry 1h buys (${stats.avgEntry1hBuysRunners.toFixed(0)}) sits close to or below the current floor (${config.momentumMin1hBuys}) and below non-runners' (${stats.avgEntry1hBuysNonRunners.toFixed(0)}) - lowering the floor ${config.momentumMin1hBuys} -> ${next}.`,
      );
    }
  }

  // Rule 3: same for 5m buys.
  if (
    Object.keys(diff).length === 0 &&
    stats.avgEntry5mBuysRunners > 0 &&
    stats.avgEntry5mBuysRunners < config.momentumMin5mBuys * 1.2 &&
    stats.avgEntry5mBuysRunners < stats.avgEntry5mBuysNonRunners
  ) {
    const next = clampStep(config.momentumMin5mBuys, -1, 0.15, BOUNDS.momentumMin5mBuys);
    if (next !== config.momentumMin5mBuys) {
      diff.momentumMin5mBuys = { old: config.momentumMin5mBuys, new: next };
      reasons.push(
        `Runners' avg entry 5m buys (${stats.avgEntry5mBuysRunners.toFixed(1)}) sits close to or below the current floor (${config.momentumMin5mBuys}) and below non-runners' (${stats.avgEntry5mBuysNonRunners.toFixed(1)}) - lowering the floor ${config.momentumMin5mBuys} -> ${next}.`,
      );
    }
  }

  // Rule 4: a specific on-chain filter disproportionately rejects runners
  // relative to non-runners - loosen the matching numeric threshold.
  if (Object.keys(diff).length === 0) {
    for (const fp of stats.filterPassRates) {
      if (
        fp.runnerSampleSize < MIN_FILTER_SAMPLE ||
        fp.nonRunnerSampleSize < MIN_FILTER_SAMPLE ||
        fp.runnerPassRate == null ||
        fp.nonRunnerPassRate == null ||
        fp.nonRunnerPassRate - fp.runnerPassRate < 0.2 // not a meaningful gap
      ) {
        continue;
      }

      if (fp.filterName === 'holderConcentration' && config.checkHolderConcentration) {
        const next = clampStep(config.momentumMaxTopHolderPct, 1, 0.15, BOUNDS.momentumMaxTopHolderPct);
        if (next !== config.momentumMaxTopHolderPct) {
          diff.momentumMaxTopHolderPct = { old: config.momentumMaxTopHolderPct, new: next };
          reasons.push(
            `holderConcentration passed for only ${(fp.runnerPassRate * 100).toFixed(0)}% of runners vs ${(fp.nonRunnerPassRate * 100).toFixed(0)}% of non-runners - raising the top-holder cap ${config.momentumMaxTopHolderPct}% -> ${next}%.`,
          );
        }
      } else if (fp.filterName === 'insiderConcentration' && config.checkInsiderConcentration) {
        const next = clampStep(config.momentumMaxInsiderPct, 1, 0.15, BOUNDS.momentumMaxInsiderPct);
        if (next !== config.momentumMaxInsiderPct) {
          diff.momentumMaxInsiderPct = { old: config.momentumMaxInsiderPct, new: next };
          reasons.push(
            `insiderConcentration passed for only ${(fp.runnerPassRate * 100).toFixed(0)}% of runners vs ${(fp.nonRunnerPassRate * 100).toFixed(0)}% of non-runners - raising the insider cap ${config.momentumMaxInsiderPct}% -> ${next}%.`,
          );
        }
      } else if (fp.filterName === 'devRisk' && config.checkDevRisk) {
        const next = clampStep(config.momentumMaxDevHoldingPct, 1, 0.15, BOUNDS.momentumMaxDevHoldingPct);
        if (next !== config.momentumMaxDevHoldingPct) {
          diff.momentumMaxDevHoldingPct = { old: config.momentumMaxDevHoldingPct, new: next };
          reasons.push(
            `devRisk passed for only ${(fp.runnerPassRate * 100).toFixed(0)}% of runners vs ${(fp.nonRunnerPassRate * 100).toFixed(0)}% of non-runners - raising the dev-holding cap ${config.momentumMaxDevHoldingPct}% -> ${next}%.`,
          );
        }
      } else if (fp.filterName === 'freshWallet' && config.checkFreshWallet) {
        // Small step size (0.08 vs. the usual 0.15) - BOUNDS caps this at
        // 40% regardless, but even within that range the fresh-wallet ratio
        // should move cautiously per the explicit "must stay low" decision.
        const next = clampStep(config.momentumMaxFreshWalletPct, 1, 0.08, BOUNDS.momentumMaxFreshWalletPct);
        if (next !== config.momentumMaxFreshWalletPct) {
          diff.momentumMaxFreshWalletPct = { old: config.momentumMaxFreshWalletPct, new: next };
          reasons.push(
            `freshWallet passed for only ${(fp.runnerPassRate * 100).toFixed(0)}% of runners vs ${(fp.nonRunnerPassRate * 100).toFixed(0)}% of non-runners - raising the fresh-wallet cap ${config.momentumMaxFreshWalletPct}% -> ${next}% (small step, capped low by design).`,
          );
        }
      }
      if (Object.keys(diff).length > 0) break;
    }
  }

  // Rule 5: bought runners are mostly getting stopped out or timing out
  // rather than reaching a good exit - the exit side is cutting real moves
  // short. Widen the max-hold window rather than the stop-loss itself,
  // since a wider stop increases per-trade risk while a longer hold window
  // just gives a genuine mover more time before the mechanical cutoff.
  if (
    Object.keys(diff).length === 0 &&
    stats.boughtRunnerCount >= MIN_BOUGHT_RUNNER_SAMPLE &&
    stats.boughtRunnerEarlyExitCount / stats.boughtRunnerCount > 0.5
  ) {
    const next = clampStep(config.priceCheckDurationMs, 1, 0.2, BOUNDS.priceCheckDurationMs);
    if (next !== config.priceCheckDurationMs) {
      diff.priceCheckDurationMs = { old: config.priceCheckDurationMs, new: next };
      reasons.push(
        `${stats.boughtRunnerEarlyExitCount}/${stats.boughtRunnerCount} bought runners closed via stop-loss/timeout rather than take-profit/AI-exit - extending the max-hold window ${(config.priceCheckDurationMs / 60_000).toFixed(0)}min -> ${(next / 60_000).toFixed(0)}min so real moves have more room.`,
      );
    }
  }

  if (Object.keys(diff).length === 0) return null;

  return {
    diff,
    rationale: `Runner review over the last ${stats.windowHours}h (${stats.runnerCount} runners / ${stats.totalPoolsScanned} pools scanned at +${stats.runnerThresholdPct}% threshold): ${reasons.join(' ')}`,
  };
}

export async function maybeRunRunnerReview(broadcast?: (event: string, payload: unknown) => void): Promise<void> {
  const { config } = getActiveConfigVersion();
  if (!config.runnerReviewEnabled) return;

  const lastRunAt = Number(getMeta(LAST_RUN_META_KEY) ?? 0);
  if (Date.now() - lastRunAt < config.runnerReviewIntervalMs) return;

  await runRunnerReviewNow(broadcast);
}

export async function runRunnerReviewNow(
  broadcast?: (event: string, payload: unknown) => void,
): Promise<{ ran: boolean; suggestionId: number | null }> {
  const activeVersion = getActiveConfigVersion();
  const config = activeVersion.config;
  setMeta(LAST_RUN_META_KEY, String(Date.now()));

  const stats = await computeRunnerReviewStats(config);

  if (stats.totalPoolsScanned === 0) {
    logger.info({}, 'Runner review ran, no pools in the lookback window');
    return { ran: true, suggestionId: null };
  }

  const proposal = proposeChangesFromRunners(stats, config);
  if (!proposal) {
    logger.info(
      { runnerCount: stats.runnerCount, totalPoolsScanned: stats.totalPoolsScanned },
      'Runner review ran, no change proposed this cycle',
    );
    return { ran: true, suggestionId: null };
  }

  const suggestionId = insertAgentSuggestion({
    createdAt: Date.now(),
    basedOnVersionId: activeVersion.id,
    proposedVersionId: null,
    status: 'proposed',
    source: 'runner-review',
    rationale: proposal.rationale,
    statsSnapshot: stats,
    diff: proposal.diff,
  });

  if (config.agentMode === 'auto-apply') {
    const newConfig = applyDiff(config, proposal.diff);
    const version = insertConfigVersion(newConfig, 'agent', activeVersion.id, proposal.rationale, true);
    updateAgentSuggestionStatus(suggestionId, 'applied', version.id);
  }

  broadcast?.('agent.suggestion', { id: suggestionId, rationale: proposal.rationale });
  return { ran: true, suggestionId };
}
