// Resolves which risk thresholds apply to a position based on its venue.
// Pre-migration pump.fun candidates (lib/watchlist/premigrationWatchlistMonitor.ts)
// are a deliberately higher-risk cohort per the user's request - wider stop,
// higher targets than the general PumpSwap/Raydium momentum strategy. Every
// other venue uses the standard global config unchanged.
//
// Resolved once, at the moment a position starts being tracked (buy-time in
// scripts/worker.ts's executeBuy, or reattach-time after a restart) - NOT
// re-read live every tick the way the rest of positionMonitor's config
// reads are. This is a deliberate behavior change from before this cohort
// existed: a position's risk terms are now fixed for its lifetime at the
// moment it opens, matching what positions.stop_loss_pct_snapshot /
// take_profit_pct_snapshot already claimed to represent (previously true
// only for display, not actually enforced - this makes that snapshot
// accurate too).
import { StrategyConfig } from '../types';
import { Venue } from '../priceSource/types';

export interface ResolvedRiskParams {
  stopLossPct: number;
  exitStrategy: 'fixed' | 'trailing';
  takeProfitPct: number;
  trailingActivationPct: number;
  trailingStopPct: number;
  takeProfitTargets: { pct: number; sellFraction: number }[];
}

export function resolveRiskParams(config: StrategyConfig, source: Venue): ResolvedRiskParams {
  if (source === 'pumpfun') {
    return {
      stopLossPct: config.pumpfunPremigrationStopLossPct,
      exitStrategy: config.pumpfunPremigrationExitStrategy,
      takeProfitPct: config.pumpfunPremigrationTakeProfitPct,
      trailingActivationPct: config.pumpfunPremigrationTrailingActivationPct,
      trailingStopPct: config.pumpfunPremigrationTrailingStopPct,
      takeProfitTargets: config.pumpfunPremigrationTakeProfitTargets,
    };
  }

  return {
    stopLossPct: config.stopLossPct,
    exitStrategy: config.exitStrategy,
    takeProfitPct: config.takeProfitPct,
    trailingActivationPct: config.trailingActivationPct,
    trailingStopPct: config.trailingStopPct,
    takeProfitTargets: config.takeProfitTargets,
  };
}
