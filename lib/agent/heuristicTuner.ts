// Deterministic, dependency-free baseline tuner - must work with no LLM key
// configured. Only ever proposes small, bounded steps on a fixed whitelist
// of parameters, and only once there's enough sample size to not be tuning
// on noise. lib/agent/llmTuner.ts may only annotate or veto what this
// produces - it can never invent an unlisted change.
import { StrategyConfig } from '../types';
import { AgentStats } from './stats';

export interface ProposedDiff {
  diff: Record<string, { old: unknown; new: unknown }>;
  rationale: string;
}

// Infra-realism knobs (latencyModel) are deliberately excluded - see
// lib/fillSimulator/latencyModel.ts. Everything else here is a genuine
// strategy lever.
const BOUNDS = {
  buySlippagePct: [1, 50],
  sellSlippagePct: [1, 50],
  takeProfitPct: [5, 200],
  stopLossPct: [5, 60],
  minPoolSizeQuote: [0, 500],
  maxPoolSizeQuote: [0, 2000],
  consecutiveFilterMatches: [1, 10],
  positionSizeValue: [0.001, 1],
  momentumMinLiquidityUsd: [2_000, 100_000],
  momentumMin1hBuys: [5, 300],
  momentumMin5mBuys: [2, 100],
  momentumMin24hVolumeUsd: [10_000, 1_000_000],
  momentumMaxTopHolderPct: [5, 40],
  momentumMinAgeMinutes: [0, 15],
  momentumMaxInsiderPct: [5, 40],
  // Revival gate (lib/dexscreener/revivalFilter.ts) is a deterministic
  // threshold gate exactly like the momentum bounds above, so it's tunable
  // the same way. degenScore/decisionEngine are NOT here - those are
  // judgment inputs to lib/agent/decisionEngine.ts's LLM call, not hard
  // numeric gates, so their "learning" happens via the recentPerformance
  // context string passed into that prompt instead (see decisionEngine.ts).
  revivalMin1hBuys: [5, 100],
  revivalMinLiquidityUsd: [5_000, 100_000],
} as const;

function clampStep(current: number, direction: 1 | -1, pct: number, bounds: readonly [number, number]): number {
  const stepped = current * (1 + direction * pct);
  return Math.min(bounds[1], Math.max(bounds[0], Number(stepped.toFixed(4))));
}

export function proposeChanges(stats: AgentStats, config: StrategyConfig): ProposedDiff | null {
  const diff: Record<string, { old: unknown; new: unknown }> = {};
  const reasons: string[] = [];

  // Rule A: too many buy attempts reverting on slippage -> the market is
  // moving faster than the modeled latency allows for. Prefer switching to
  // priority execution (addresses the root cause) over just loosening the
  // slippage tolerance (which papers over it with worse fills).
  if (stats.revertedSlippageRate > 0.25) {
    if (config.executionMode === 'standard') {
      diff.executionMode = { old: 'standard', new: 'priority' };
      reasons.push(
        `${(stats.revertedSlippageRate * 100).toFixed(0)}% of recent buys reverted on slippage - switching to priority execution mode to cut latency instead of just loosening the slippage tolerance.`,
      );
    } else {
      const next = clampStep(config.buySlippagePct, 1, 0.2, BOUNDS.buySlippagePct);
      if (next !== config.buySlippagePct) {
        diff.buySlippagePct = { old: config.buySlippagePct, new: next };
        reasons.push(
          `Still reverting often on slippage even in priority mode - raising buy slippage tolerance ${config.buySlippagePct}% -> ${next}%.`,
        );
      }
    }
  }

  // Rule B: losing overall with a low win rate suggests the stop-loss is
  // getting clipped by ordinary noise/slippage rather than a genuine
  // reversal - widen it a step. Gated on stop-loss trades actually closing
  // near their configured floor (overshootRatio < 1.3) - if they're instead
  // gapping 1.5-3x past it, that's rug-pull-speed collapse, not noise, and
  // widening the stop would only make each rug more expensive. Rule G
  // handles that case instead.
  if (stats.winRate < 0.35 && stats.avgPnlPct < 0 && stats.stopLossOvershootRatio < 1.3 && !diff.stopLossPct) {
    const next = clampStep(config.stopLossPct, 1, 0.2, BOUNDS.stopLossPct);
    if (next !== config.stopLossPct) {
      diff.stopLossPct = { old: config.stopLossPct, new: next };
      reasons.push(
        `Win rate ${(stats.winRate * 100).toFixed(0)}% with negative average P&L - widening stop-loss ${config.stopLossPct}% -> ${next}% so ordinary volatility stops fewer trades out early.`,
      );
    }
  }

  // Rule C: strategy is working well (healthy profit factor, low drawdown) -
  // let winners run a bit more instead of capping them early.
  if (Object.keys(diff).length === 0 && stats.profitFactor > 1.5 && stats.winRate > 0.5 && stats.maxDrawdownPct < 15) {
    const next = clampStep(config.takeProfitPct, 1, 0.15, BOUNDS.takeProfitPct);
    if (next !== config.takeProfitPct) {
      diff.takeProfitPct = { old: config.takeProfitPct, new: next };
      reasons.push(
        `Profit factor ${stats.profitFactor.toFixed(2)} with ${(stats.maxDrawdownPct).toFixed(1)}% max drawdown - raising take-profit ${config.takeProfitPct}% -> ${next}% to let winners run further.`,
      );
    }
  }

  // Rule D: losing trades that barely cleared a momentum bar suggest the bar
  // itself is too loose - nudge it up a step. Never loosens a threshold on
  // its own, only tightens, so this can't drift the strategy toward more risk.
  if (Object.keys(diff).length === 0 && stats.momentumSampleSize >= 5) {
    if (
      stats.avgEntryLiquidityUsdLosers > 0 &&
      stats.avgEntryLiquidityUsdLosers < config.momentumMinLiquidityUsd * 1.2 &&
      stats.avgEntryLiquidityUsdLosers < stats.avgEntryLiquidityUsdWinners
    ) {
      const next = clampStep(config.momentumMinLiquidityUsd, 1, 0.15, BOUNDS.momentumMinLiquidityUsd);
      if (next !== config.momentumMinLiquidityUsd) {
        diff.momentumMinLiquidityUsd = { old: config.momentumMinLiquidityUsd, new: next };
        reasons.push(
          `Losing trades entered with avg liquidity $${stats.avgEntryLiquidityUsdLosers.toFixed(0)} - close to the $${config.momentumMinLiquidityUsd} floor and well below winners' $${stats.avgEntryLiquidityUsdWinners.toFixed(0)} avg - raising the liquidity floor ${config.momentumMinLiquidityUsd} -> ${next}.`,
        );
      }
    } else if (
      stats.avgEntry1hBuysLosers > 0 &&
      stats.avgEntry1hBuysLosers < config.momentumMin1hBuys * 1.2 &&
      stats.avgEntry1hBuysLosers < stats.avgEntry1hBuysWinners
    ) {
      const next = clampStep(config.momentumMin1hBuys, 1, 0.15, BOUNDS.momentumMin1hBuys);
      if (next !== config.momentumMin1hBuys) {
        diff.momentumMin1hBuys = { old: config.momentumMin1hBuys, new: next };
        reasons.push(
          `Losing trades entered with avg 1h buys ${stats.avgEntry1hBuysLosers.toFixed(0)} - close to the ${config.momentumMin1hBuys} floor and well below winners' ${stats.avgEntry1hBuysWinners.toFixed(0)} avg - raising the 1h-buys floor ${config.momentumMin1hBuys} -> ${next}.`,
        );
      }
    }
  }

  // Rule E: winners consistently stop growing right around the first
  // take-profit rung suggests it's leaving upside on the table - raise it a
  // step, same "let winners run" spirit as Rule C but for the first target.
  if (
    Object.keys(diff).length === 0 &&
    config.takeProfitTargets.length > 0 &&
    stats.winRate > 0.5 &&
    stats.avgPnlPct > 0 &&
    Math.abs(stats.avgPnlPct - config.takeProfitTargets[0].pct) < config.takeProfitTargets[0].pct * 0.25
  ) {
    const currentPct = config.takeProfitTargets[0].pct;
    const nextPct = Number((currentPct * 1.15).toFixed(2));
    const nextTargets = config.takeProfitTargets.map((t, i) => (i === 0 ? { ...t, pct: nextPct } : t));
    diff.takeProfitTargets = { old: config.takeProfitTargets, new: nextTargets };
    reasons.push(
      `Avg realized P&L ${stats.avgPnlPct.toFixed(1)}% is clustering right around the first take-profit target (${currentPct}%) - raising it ${currentPct}% -> ${nextPct}% to let winners run further before the first partial exit.`,
    );
  }

  // Rule F: unlike every other rule here, this one LOOSENS a threshold -
  // gated behind a high bar (>20% of evaluated candidates, and a minimum
  // sample size) specifically because it's the only rule that moves in this
  // direction. If a large share of watchlist candidates fail the momentum
  // gate for exactly one reason - too fresh (minAge) - genuinely explosive
  // early momentum is being filtered out purely for being new, not because
  // anything about it looks bad. Small step, never below 0.
  if (
    Object.keys(diff).length === 0 &&
    stats.minAgeEvaluatedCount >= 20 &&
    stats.minAgeOnlyRejectionRate > 0.2 &&
    config.momentumMinAgeMinutes > 0.5
  ) {
    const next = clampStep(config.momentumMinAgeMinutes, -1, 0.25, BOUNDS.momentumMinAgeMinutes);
    if (next !== config.momentumMinAgeMinutes) {
      diff.momentumMinAgeMinutes = { old: config.momentumMinAgeMinutes, new: next };
      reasons.push(
        `${(stats.minAgeOnlyRejectionRate * 100).toFixed(0)}% of the last ${stats.minAgeEvaluatedCount} evaluated watchlist candidates failed ONLY the minimum-age check (every other criterion passed) - lowering the age floor ${config.momentumMinAgeMinutes}min -> ${next}min so sudden, genuinely strong early momentum isn't rejected purely for being fresh.`,
      );
    }
  }

  // Rule G: stop-loss trades are closing well past their configured floor
  // (avg overshoot >=1.3x) - a sign of gap risk (the price collapsed faster
  // than the poll interval could react, e.g. a rug pull), not ordinary
  // volatility. Widening the stop-loss number wouldn't fix this - the price
  // already blew through whatever floor was set. Instead tighten entry-side
  // risk filters (holder/insider concentration) to reduce exposure to the
  // kind of token that produces these collapses in the first place.
  if (
    Object.keys(diff).length === 0 &&
    stats.stopLossCount >= 15 &&
    stats.stopLossOvershootRatio >= 1.3 &&
    config.checkInsiderConcentration
  ) {
    const next = clampStep(config.momentumMaxInsiderPct, -1, 0.15, BOUNDS.momentumMaxInsiderPct);
    if (next !== config.momentumMaxInsiderPct) {
      diff.momentumMaxInsiderPct = { old: config.momentumMaxInsiderPct, new: next };
      reasons.push(
        `${stats.stopLossCount} stop-loss trades closed at ${stats.stopLossOvershootRatio.toFixed(1)}x their configured stop-loss floor on average - that's gap risk (price collapsing faster than the poll can react), not ordinary noise a wider stop would fix. Tightening the insider-concentration cap ${config.momentumMaxInsiderPct}% -> ${next}% to reduce exposure to that failure mode at entry instead.`,
      );
    }
  }

  // Rule H: far more trades are hitting stop-loss than take-profit, with the
  // stop-loss trades net-negative - reduce position size as an immediate,
  // low-risk lever to cap the SOL-denominated damage per rug while entry
  // filters (Rule D/G) catch up. Doesn't touch entry/exit logic at all, so
  // it can't conflict with whichever of Rule B/G is also addressing the
  // underlying cause.
  if (
    Object.keys(diff).length === 0 &&
    stats.stopLossCount >= 15 &&
    stats.takeProfitCount > 0 &&
    stats.stopLossCount / stats.takeProfitCount > 1.5 &&
    stats.stopLossNetPnlQuote < 0
  ) {
    const next = clampStep(config.positionSizeValue, -1, 0.15, BOUNDS.positionSizeValue);
    if (next !== config.positionSizeValue) {
      diff.positionSizeValue = { old: config.positionSizeValue, new: next };
      reasons.push(
        `Stop-loss trades (${stats.stopLossCount}) are outnumbering take-profit trades (${stats.takeProfitCount}) by more than 1.5x and net losing ${stats.stopLossNetPnlQuote.toFixed(3)} - shrinking position size ${config.positionSizeValue} -> ${next} to cap damage per losing trade while entry filters catch up.`,
      );
    }
  }

  if (Object.keys(diff).length === 0) return null;

  return {
    diff,
    rationale: `Based on ${stats.sampleSize} closed trades (win rate ${(stats.winRate * 100).toFixed(0)}%, avg P&L ${stats.avgPnlPct.toFixed(1)}%, profit factor ${Number.isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞'}): ${reasons.join(' ')}`,
  };
}

export function applyDiff(config: StrategyConfig, diff: Record<string, { old: unknown; new: unknown }>): StrategyConfig {
  const next: StrategyConfig = { ...config };
  for (const [key, change] of Object.entries(diff)) {
    (next as any)[key] = change.new;
  }
  return next;
}
