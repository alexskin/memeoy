// Rejects a candidate whose dev/creator wallet or aggregate top-10 non-pool
// holders control too much of the supply - the dump risk that
// holderConcentrationFilter.ts (largest SINGLE non-pool holder) and
// insiderFilter.ts (RugCheck's insider-flagged wallets only) can both miss:
// several holders can each sit safely under the single-holder threshold,
// none flagged "insider" by RugCheck's wallet-clustering heuristic, and
// still add up to majority control (confirmed live: a bought token showed a
// 14.4% single largest holder and 0 RugCheck-flagged insiders, yet 56.3%
// dev holding and 57.9% top-10 aggregate per an external scanner). Same
// RugCheck report (via getRiskInfo), same fail-closed-on-missing-data
// convention as the other two filters.
import { getRiskInfo } from '../rugcheck/client';
import { FilterResult } from './types';
import { StrategyConfig } from '../types';

export async function checkDevRisk(baseMint: string, excludeOwners: string[], config: StrategyConfig): Promise<FilterResult> {
  const info = await getRiskInfo(baseMint, excludeOwners);
  if (info === null) {
    return { ok: false, message: 'DevRisk -> RugCheck data unavailable' };
  }

  const devOk = info.devHoldingPct <= config.momentumMaxDevHoldingPct;
  const top10Ok = info.top10HoldersPct <= config.momentumMaxTop10HoldersPct;

  return {
    ok: devOk && top10Ok,
    message: `DevRisk -> dev holding ${info.devHoldingPct.toFixed(1)}% (max ${config.momentumMaxDevHoldingPct}%), top10 non-pool holders ${info.top10HoldersPct.toFixed(1)}% (max ${config.momentumMaxTop10HoldersPct}%)`,
  };
}
