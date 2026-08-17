// Aggregate performance stats the heuristic tuner reasons about. All prices/
// fills are simulated but computed from real market data, so these numbers
// reflect how the strategy actually would have performed.
import { AgentDecision, MomentumSnapshot, Position, SimulatedFill } from '../types';
import { getClosedPositions, getLatestAgentDecisionBeforeBuy } from '../db';
import { RunnerReviewStats } from './runnerReview';

export interface TradeWithFills extends Position {
  entryFill: SimulatedFill | null;
  exitFill: SimulatedFill | null;
  /** The momentum snapshot that triggered the buy, if this trade came through the watchlist. */
  entryMomentumSnapshot: MomentumSnapshot | null;
  /** The decisionEngine judgment that triggered the buy, if any (null for trades from before this feature, or with decisionEngineEnabled=false). */
  entryAgentDecision: AgentDecision | null;
}

export interface AgentStats {
  sampleSize: number;
  winRate: number;
  avgPnlPct: number;
  profitFactor: number;
  avgLatencyMs: number;
  avgLatencyDriftPct: number;
  avgPriceImpactPct: number;
  revertedSlippageRate: number;
  maxDrawdownPct: number;
  // Winner-vs-loser breakdown by entry-time momentum reading - lets the
  // heuristic tuner reason about whether a threshold is set too loose
  // (heuristic depth, not a feature-importance model).
  avgEntryLiquidityUsdWinners: number;
  avgEntryLiquidityUsdLosers: number;
  avgEntry1hBuysWinners: number;
  avgEntry1hBuysLosers: number;
  momentumSampleSize: number;
  // Populated externally by agentRunner.ts (needs a raw momentum_snapshots
  // query, not derivable from closed trades alone) - see
  // lib/db.ts::getMinAgeOnlyRejectionStats and heuristicTuner.ts Rule F.
  minAgeOnlyRejectionRate: number;
  minAgeEvaluatedCount: number;
  // Populated externally by agentRunner.ts (needs a raw positions query) -
  // see lib/db.ts::getStopLossOvershootStats and heuristicTuner.ts Rule G/H.
  stopLossCount: number;
  takeProfitCount: number;
  stopLossNetPnlQuote: number;
  stopLossOvershootRatio: number;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Unlike computeStats above (pure, takes trades as input), this one queries
// the DB directly - it's the "learning" input for lib/agent/decisionEngine.ts:
// a compact win-rate-by-signal-bucket summary gets embedded in every future
// judgment prompt, so the agent's calls are grounded in what similar past
// signals actually produced, without a separate weight-update/ML system (see
// the plan's rationale for why this stays in-context rather than becoming a
// heuristicTuner-style numeric rule).
export function summarizeRecentPerformanceBySignal(limit = 200): string {
  const withDecisions: { position: Position; decision: AgentDecision }[] = [];
  for (const p of getClosedPositions(limit)) {
    const decision = getLatestAgentDecisionBeforeBuy(p.detectedPoolId, p.openedAt);
    if (decision) withDecisions.push({ position: p, decision });
  }
  const trades = withDecisions;

  if (trades.length === 0) {
    return 'No closed trades yet with a recorded agent decision - no track record to lean on, judge this candidate on its own signals.';
  }

  function bucketLabel(value: number, edges: number[], labels: string[]): string {
    for (let i = 0; i < edges.length; i++) {
      if (value < edges[i]) return labels[i];
    }
    return labels[labels.length - 1];
  }

  const buckets = new Map<string, { wins: number; total: number }>();
  for (const t of trades) {
    const degenLabel = t.decision.degenScore == null ? 'degen:unknown' : `degen:${bucketLabel(t.decision.degenScore, [40, 70], ['low', 'mid', 'high'])}`;
    const revivalLabel = `revival:${bucketLabel(t.decision.revivalStrength, [60, 85], ['weak', 'moderate', 'strong'])}`;
    const key = `${degenLabel} / ${revivalLabel}`;
    const entry = buckets.get(key) ?? { wins: 0, total: 0 };
    entry.total++;
    if ((t.position.realizedPnlQuote ?? 0) > 0) entry.wins++;
    buckets.set(key, entry);
  }

  const lines = [...buckets.entries()]
    .filter(([, b]) => b.total >= 2) // skip buckets too thin to mean anything
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 6)
    .map(([key, b]) => `${key}: ${b.wins}/${b.total} won (${((b.wins / b.total) * 100).toFixed(0)}%)`);

  return lines.length > 0
    ? `Recent outcomes by signal bucket (last ${trades.length} decided trades): ${lines.join('; ')}.`
    : `${trades.length} recent decided trades, but no signal bucket has 2+ samples yet - too early to see a pattern.`;
}

// Sibling to summarizeRecentPerformanceBySignal above, but reasons about
// SKIPPED candidates instead of trade outcomes - specifically, where the
// degen-score judgment was wrong (skipped it, but it went on to become a
// real runner - see lib/agent/runnerReview.ts). Deliberately advisory only:
// this is fed into decisionEngine.ts's prompt as context for the LLM to
// recalibrate its OWN weighting of degen score, not a hard numeric gate -
// degen score stays LLM-context-only by design (see heuristicTuner.ts's
// BOUNDS comment and decisionEngine.ts's header).
export function summarizeMissedRunnersBySignal(runnerStats: RunnerReviewStats | null): string {
  if (!runnerStats || runnerStats.degenBuckets.every((b) => b.skippedCount === 0)) {
    return 'No runner-review data yet for missed-runner calibration by degen score.';
  }

  const lines = runnerStats.degenBuckets
    .filter((b) => b.skippedCount >= 2)
    .map(
      (b) =>
        `degen:${b.bucket} skipped: ${b.missedRunnerCount}/${b.skippedCount} turned into runners we missed (${((b.missedRunnerCount / b.skippedCount) * 100).toFixed(0)}%)`,
    );

  return lines.length > 0
    ? `Missed-runner calibration by degen-score bucket (last ${runnerStats.windowHours}h, +${runnerStats.runnerThresholdPct}% threshold): ${lines.join('; ')}.`
    : `Runner-review data exists but no degen-score bucket has 2+ skipped samples yet - too early to calibrate.`;
}

export function computeStats(trades: TradeWithFills[], equitySeries: number[] = []): AgentStats {
  const sampleSize = trades.length;
  if (sampleSize === 0) {
    return {
      sampleSize: 0,
      winRate: 0,
      avgPnlPct: 0,
      profitFactor: 0,
      avgLatencyMs: 0,
      avgLatencyDriftPct: 0,
      avgPriceImpactPct: 0,
      revertedSlippageRate: 0,
      maxDrawdownPct: 0,
      avgEntryLiquidityUsdWinners: 0,
      avgEntryLiquidityUsdLosers: 0,
      avgEntry1hBuysWinners: 0,
      avgEntry1hBuysLosers: 0,
      momentumSampleSize: 0,
      minAgeOnlyRejectionRate: 0,
      minAgeEvaluatedCount: 0,
      stopLossCount: 0,
      takeProfitCount: 0,
      stopLossNetPnlQuote: 0,
      stopLossOvershootRatio: 0,
    };
  }

  const winners = trades.filter((t) => (t.realizedPnlQuote ?? 0) > 0);
  const losers = trades.filter((t) => (t.realizedPnlQuote ?? 0) < 0);
  const wins = winners.length;
  const grossProfit = winners.reduce((s, t) => s + (t.realizedPnlQuote ?? 0), 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + (t.realizedPnlQuote ?? 0), 0));

  const latencies: number[] = [];
  const latencyDrifts: number[] = [];
  const priceImpacts: number[] = [];
  let revertedTrades = 0;

  for (const t of trades) {
    if (t.entryFill) {
      latencies.push(t.entryFill.actualElapsedMs);
      if (t.entryFill.latencyDriftPct !== null) latencyDrifts.push(t.entryFill.latencyDriftPct);
      if (t.entryFill.priceImpactPct !== null) priceImpacts.push(t.entryFill.priceImpactPct);
      if (t.entryFill.attemptNumber > 1) revertedTrades++;
    }
    if (t.exitFill) {
      latencies.push(t.exitFill.actualElapsedMs);
      if (t.exitFill.latencyDriftPct !== null) latencyDrifts.push(t.exitFill.latencyDriftPct);
      if (t.exitFill.priceImpactPct !== null) priceImpacts.push(t.exitFill.priceImpactPct);
    }
  }

  let maxDrawdownPct = 0;
  if (equitySeries.length > 1) {
    let peak = equitySeries[0];
    for (const value of equitySeries) {
      peak = Math.max(peak, value);
      if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - value) / peak) * 100);
    }
  }

  const winnerLiquidity = winners.map((t) => t.entryMomentumSnapshot?.liquidityUsd).filter((v): v is number => v != null);
  const loserLiquidity = losers.map((t) => t.entryMomentumSnapshot?.liquidityUsd).filter((v): v is number => v != null);
  const winnerBuys1h = winners.map((t) => t.entryMomentumSnapshot?.buys1h).filter((v): v is number => v != null);
  const loserBuys1h = losers.map((t) => t.entryMomentumSnapshot?.buys1h).filter((v): v is number => v != null);

  return {
    sampleSize,
    winRate: wins / sampleSize,
    avgPnlPct: mean(trades.map((t) => t.realizedPnlPct ?? 0)),
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / grossLoss,
    avgLatencyMs: mean(latencies),
    avgLatencyDriftPct: mean(latencyDrifts),
    avgPriceImpactPct: mean(priceImpacts),
    revertedSlippageRate: revertedTrades / sampleSize,
    maxDrawdownPct,
    avgEntryLiquidityUsdWinners: mean(winnerLiquidity),
    avgEntryLiquidityUsdLosers: mean(loserLiquidity),
    avgEntry1hBuysWinners: mean(winnerBuys1h),
    avgEntry1hBuysLosers: mean(loserBuys1h),
    momentumSampleSize: winnerLiquidity.length + loserLiquidity.length,
    // Placeholders - agentRunner.ts overwrites these with a real
    // momentum_snapshots query right after calling computeStats().
    minAgeOnlyRejectionRate: 0,
    minAgeEvaluatedCount: 0,
    // Placeholders - agentRunner.ts overwrites these with a real positions
    // query right after calling computeStats().
    stopLossCount: 0,
    takeProfitCount: 0,
    stopLossNetPnlQuote: 0,
    stopLossOvershootRatio: 0,
  };
}
