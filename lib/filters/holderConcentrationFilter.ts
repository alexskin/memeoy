// "Wallet sizes" signal the user asked for: rejects a candidate whose top
// non-pool holder controls too much of the supply (rug/dump risk). Runs
// ONCE per candidate right after the safety-filter loop passes in
// scripts/worker.ts's handleDetection - not inside the retry loop, not on
// every watchlist sweep.
//
// Uses RugCheck.xyz's already-fetched top-20-holders snapshot (same source
// as insiderFilter.ts) instead of raw Solana RPC. Previously called
// connection.getTokenLargestAccounts()/getProgramAccounts() directly, but
// both are blocked outright on Chainstack's free tier ("Method requires
// plan upgrade", confirmed live 2026-08-18) and free RPC tiers restrict
// these same heavy indexing methods almost universally - RugCheck's data
// sidesteps the "which provider allows this" problem entirely, for free,
// no API key.
import { getTopHolderInfo } from '../rugcheck/client';
import { FilterResult } from './types';
import { StrategyConfig } from '../types';

export async function checkHolderConcentration(
  baseMint: string,
  excludeOwners: string[],
  config: StrategyConfig,
): Promise<FilterResult> {
  const info = await getTopHolderInfo(baseMint, excludeOwners);
  if (info === null) {
    return { ok: false, message: 'HolderConcentration -> RugCheck data unavailable' };
  }

  return {
    ok: info.topNonExcludedHolderPct <= config.momentumMaxTopHolderPct,
    message: `HolderConcentration -> top non-pool holder ${info.topNonExcludedHolderPct.toFixed(1)}% (max ${config.momentumMaxTopHolderPct}%)`,
  };
}
