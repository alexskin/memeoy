// Rejects a candidate whose top holders are disproportionately "fresh"
// wallets (little to no on-chain history) - a signature of bot-swarm/insider
// sniping (many freshly-funded wallets buying in sync right at launch) that
// holderConcentration/insiderConcentration/devRisk can all miss, since a
// coordinated sniper ring can spread its buy across many small,
// individually-clean-looking wallets rather than one big one. RugCheck's
// report has no wallet-age field, so this is the one filter in this group
// that needs real Solana RPC (getSignaturesForAddress, already rate-limited
// and fallback-protected via lib/solana/connection.ts's THROTTLED_METHODS).
// Deliberately gated behind devRiskFilter already passing (scripts/worker.ts
// wiring) and capped to a small holder sample, to bound the added RPC cost -
// this runs on the same small late-stage population as devRisk, not on
// every raw detection.
//
// "Fresh" is defined relative to NOW (wallet's oldest visible signature
// happened within freshWalletMaxAgeHours), not relative to this token's own
// launch time - simpler to wire (no pool-open-time plumbing needed) and
// still a solid "is this a wallet spun up just to snipe pumps" signal.
import { Connection, PublicKey } from '@solana/web3.js';
import { FilterResult } from './types';
import { StrategyConfig } from '../types';
import { logger } from '../logger';

const FRESH_WALLET_SAMPLE_SIZE = 15;
// One bounded getSignaturesForAddress call per wallet rather than paginating
// back to true genesis - a wallet with this many or more prior signatures
// unambiguously has substantial history and can't be "fresh" regardless of
// how old the oldest visible one is.
const SIGNATURE_SAMPLE_LIMIT = 1000;

async function isWalletFresh(connection: Connection, walletAddress: string, maxAgeHours: number): Promise<boolean | null> {
  try {
    const pubkey = new PublicKey(walletAddress);
    const sigs = await connection.getSignaturesForAddress(pubkey, { limit: SIGNATURE_SAMPLE_LIMIT });
    if (sigs.length === 0) return true; // never transacted before - as fresh as it gets
    if (sigs.length >= SIGNATURE_SAMPLE_LIMIT) return false; // substantial prior history
    const oldest = sigs[sigs.length - 1];
    if (oldest.blockTime == null) return null;
    const ageHours = (Date.now() / 1000 - oldest.blockTime) / 3600;
    return ageHours <= maxAgeHours;
  } catch (error) {
    logger.warn({ error: String(error), walletAddress }, 'freshWalletFilter: getSignaturesForAddress failed');
    return null;
  }
}

export async function checkFreshWallet(
  connection: Connection,
  holders: { walletAddress: string; pct: number }[],
  config: StrategyConfig,
): Promise<FilterResult> {
  const sample = holders.slice(0, FRESH_WALLET_SAMPLE_SIZE);
  if (sample.length === 0) {
    return { ok: true, message: 'FreshWallet -> no non-pool holders to sample' };
  }

  const results = await Promise.all(sample.map((h) => isWalletFresh(connection, h.walletAddress, config.freshWalletMaxAgeHours)));
  const verifiable = results.filter((r): r is boolean => r != null);
  if (verifiable.length === 0) {
    return { ok: false, message: 'FreshWallet -> could not verify any holder wallet age' };
  }

  const freshCount = verifiable.filter(Boolean).length;
  const freshPct = (freshCount / verifiable.length) * 100;

  return {
    ok: freshPct <= config.momentumMaxFreshWalletPct,
    message: `FreshWallet -> ${freshPct.toFixed(0)}% of sampled holders (${freshCount}/${verifiable.length}) look freshly created (max ${config.momentumMaxFreshWalletPct}%)`,
  };
}
