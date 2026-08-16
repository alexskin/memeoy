// Rejects a candidate on either of two independent insider signals from
// RugCheck.xyz (see lib/rugcheck/client.ts for why both are needed - the
// top-20-holder pct alone can show a clean 0% on a token with hundreds of
// small insider wallets spread below the top 20). Runs ONCE per candidate
// right after the safety-filter loop passes, same convention as
// holderConcentrationFilter.ts.
import { getInsiderInfo } from '../rugcheck/client';
import { FilterResult } from './types';
import { StrategyConfig } from '../types';

export async function checkInsiderConcentration(mint: string, config: StrategyConfig): Promise<FilterResult> {
  const info = await getInsiderInfo(mint);
  if (info === null) {
    return { ok: false, message: 'InsiderConcentration -> RugCheck data unavailable' };
  }

  const pctOk = info.topHolderInsiderPct <= config.momentumMaxInsiderPct;
  const countOk = info.insiderWalletCount <= config.momentumMaxInsiderWalletCount;
  const ok = pctOk && countOk;

  return {
    ok,
    message: `InsiderConcentration -> ${info.topHolderInsiderPct.toFixed(1)}% of top holders (max ${config.momentumMaxInsiderPct}%), ${info.insiderWalletCount} insider wallets detected (max ${config.momentumMaxInsiderWalletCount})`,
  };
}
