// "Wallet sizes" signal the user asked for: rejects a candidate whose top
// non-pool holder controls too much of the supply (rug/dump risk). Runs
// ONCE per candidate right after the safety-filter loop passes in
// scripts/worker.ts's handleDetection - not inside the retry loop, not on
// every watchlist sweep - specifically to control RPC load (Helius free
// tier already hits 429s under load).
//
// Two different strategies depending on which token program the mint uses,
// both confirmed live:
// - Classic Token program: connection.getTokenLargestAccounts() works
//   directly and cheaply (one call, top 20 holders pre-sorted by balance,
//   no scan). This is now the common case since PumpSwap's origin-agnostic
//   detection (Increment 6) surfaces non-pump.fun-originated tokens too,
//   not just Token-2022 pump.fun mints.
// - Token-2022 program: getTokenLargestAccounts fails with "Invalid param:
//   not a Token mint" for every pump.fun mint (confirmed live - a 100%
//   failure rate that silently blocked the entire watchlist pipeline before
//   this was caught). Falls back to enumerating holder accounts via
//   getProgramAccounts against whichever program actually owns the mint.
//   This path used to also serve classic-Token mints, but a memcmp-filtered
//   getProgramAccounts scan against the classic Token program (used by
//   nearly everything on Solana) can still exceed Helius's non-paginated
//   getProgramAccounts result-size limit ("Too many accounts requested...
//   use getProgramAccountsV2 with pagination") - confirmed live once
//   PumpSwap started surfacing classic-Token candidates. Token-2022 has far
//   fewer total accounts on Solana today, so this scan stays well under
//   that limit for it.
//
// excludeOwners is matched against each token account's OWNER field, not
// its own address - a pool's holdings sit in an associated token account
// (ATA) whose address is a hash of (owner, mint, tokenProgram), not the
// pool/curve's own address, so matching by account pubkey would never
// exclude the pool's legitimate near-100% pre-trade balance (confirmed live
// - this exact bug initially rejected every real candidate at ~99%
// concentration before the owner-based match was added).
import { Connection, PublicKey } from '@solana/web3.js';
import { MintLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { FilterResult } from './types';
import { StrategyConfig } from '../types';
import { logger } from '../logger';

function supplyAsNumber(supply: bigint | { toString(): string }): number {
  return typeof supply === 'bigint' ? Number(supply) : Number(supply.toString());
}

async function findMaxHolderAmountClassicToken(
  connection: Connection,
  mint: PublicKey,
  excludeSet: Set<string>,
): Promise<bigint> {
  const largest = await connection.getTokenLargestAccounts(mint);
  if (largest.value.length === 0) return 0n;

  // getTokenLargestAccounts doesn't return the owner, only the token
  // account address - one batched follow-up call to read owners, rather
  // than a per-account fetch.
  const accountInfos = await connection.getMultipleAccountsInfo(largest.value.map((v) => v.address));

  let maxHolderAmount = 0n;
  for (let i = 0; i < largest.value.length; i++) {
    const accountInfo = accountInfos[i];
    if (!accountInfo?.data || accountInfo.data.length < 64) continue;
    const owner = new PublicKey(accountInfo.data.subarray(32, 64));
    if (excludeSet.has(owner.toBase58())) continue;
    const amount = BigInt(largest.value[i].amount);
    if (amount > maxHolderAmount) maxHolderAmount = amount;
  }
  return maxHolderAmount;
}

async function findMaxHolderAmountViaProgramScan(
  connection: Connection,
  mint: PublicKey,
  tokenProgramId: PublicKey,
  excludeSet: Set<string>,
): Promise<bigint> {
  // Token account layout (classic + Token-2022 base fields, both
  // compatible at these offsets): owner at [32,64), amount at [64,72).
  const holderAccounts = await connection.getProgramAccounts(tokenProgramId, {
    filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }],
    dataSlice: { offset: 32, length: 40 },
  });

  let maxHolderAmount = 0n;
  for (const account of holderAccounts) {
    if (account.account.data.length < 40) continue;
    const owner = new PublicKey(account.account.data.subarray(0, 32));
    if (excludeSet.has(owner.toBase58())) continue;
    const amount = account.account.data.readBigUInt64LE(32);
    if (amount > maxHolderAmount) maxHolderAmount = amount;
  }
  return maxHolderAmount;
}

export async function checkHolderConcentration(
  connection: Connection,
  baseMint: string,
  excludeOwners: PublicKey[],
  config: StrategyConfig,
): Promise<FilterResult> {
  try {
    const mint = new PublicKey(baseMint);
    const mintAccountInfo = await connection.getAccountInfo(mint);
    if (!mintAccountInfo?.data) {
      return { ok: false, message: 'HolderConcentration -> mint account not found' };
    }

    const decoded = MintLayout.decode(mintAccountInfo.data);
    const totalSupply = supplyAsNumber(decoded.supply);
    if (totalSupply === 0) {
      return { ok: false, message: 'HolderConcentration -> zero supply reported' };
    }

    const excludeSet = new Set(excludeOwners.map((a) => a.toBase58()));
    const isClassicToken = mintAccountInfo.owner.equals(TOKEN_PROGRAM_ID);
    const maxHolderAmount = isClassicToken
      ? await findMaxHolderAmountClassicToken(connection, mint, excludeSet)
      : await findMaxHolderAmountViaProgramScan(connection, mint, mintAccountInfo.owner, excludeSet);

    const pct = (Number(maxHolderAmount) / totalSupply) * 100;

    return {
      ok: pct <= config.momentumMaxTopHolderPct,
      message: `HolderConcentration -> top non-pool holder ${pct.toFixed(1)}% (max ${config.momentumMaxTopHolderPct}%)`,
    };
  } catch (error) {
    logger.error({ mint: baseMint, error: String(error) }, 'HolderConcentration -> failed to check');
    return { ok: false, message: `HolderConcentration -> failed: ${String(error)}` };
  }
}
