import { Connection, PublicKey } from '@solana/web3.js';
import { PriceSource } from '../priceSource/types';
import { PumpSwapPool, decodePoolAccount } from './state';
import { computePumpSwapQuote } from './curve';
import { GLOBAL_CONFIG_SEED, PUMPSWAP_PROGRAM_ID, PUMPSWAP_TOTAL_FEE_BPS } from './constants';
import { logger } from '../logger';

// Lazily-memoized one-time fetch of the real on-chain fee (GlobalConfig is a
// singleton PDA: lp_fee_basis_points + protocol_fee_basis_points, confirmed
// live at 20+5=25 bps). Memoized after the FIRST attempt (success or
// failure) so this only ever costs one RPC call for the process's whole
// lifetime, never per-quote. Falls back to the best-effort constant.
let cachedFeeBpsPromise: Promise<number> | null = null;

export function getPumpSwapFeeBps(connection: Connection): Promise<number> {
  if (!cachedFeeBpsPromise) {
    cachedFeeBpsPromise = (async () => {
      try {
        const [globalConfigPda] = PublicKey.findProgramAddressSync(
          [Buffer.from(GLOBAL_CONFIG_SEED)],
          PUMPSWAP_PROGRAM_ID,
        );
        const accountInfo = await connection.getAccountInfo(globalConfigPda);
        if (!accountInfo?.data) return PUMPSWAP_TOTAL_FEE_BPS;

        // discriminator(8) + admin(32) + lp_fee_basis_points(8) + protocol_fee_basis_points(8)
        const lpFeeBps = accountInfo.data.readBigUInt64LE(8 + 32);
        const protocolFeeBps = accountInfo.data.readBigUInt64LE(8 + 32 + 8);
        return Number(lpFeeBps + protocolFeeBps);
      } catch (error) {
        logger.warn({ error: String(error) }, 'PumpSwap: GlobalConfig fee fetch failed, using best-effort default');
        return PUMPSWAP_TOTAL_FEE_BPS;
      }
    })();
  }
  return cachedFeeBpsPromise;
}

// Synchronous factory - mirrors createRaydiumPriceSource's shape exactly,
// taking an already-decoded pool (from the onProgramAccountChange callback
// that detected it, or from rebuildPumpSwapPriceSource below). Each
// getQuote() call re-fetches ONLY the two vault balances fresh - this is
// what preserves the "price can genuinely drift during simulated latency"
// realism the fill simulator depends on; the pool's own metadata (vault
// addresses) never changes so it's read once, not per-quote.
export function createPumpSwapPriceSource(
  connection: Connection,
  pool: PumpSwapPool,
  baseDecimals: number,
  quoteDecimals: number,
): PriceSource {
  return {
    venue: 'pumpswap',
    baseMint: pool.baseMint.toString(),
    baseDecimals,
    quoteDecimals,
    async getQuote(direction, amountInRaw, slippagePct) {
      const [baseBalance, quoteBalance, feeBps] = await Promise.all([
        connection.getTokenAccountBalance(pool.poolBaseTokenAccount),
        connection.getTokenAccountBalance(pool.poolQuoteTokenAccount),
        getPumpSwapFeeBps(connection),
      ]);

      return computePumpSwapQuote({
        baseReserveRaw: BigInt(baseBalance.value.amount),
        quoteReserveRaw: BigInt(quoteBalance.value.amount),
        direction,
        amountInRaw: BigInt(amountInRaw),
        slippagePct,
        baseDecimals,
        quoteDecimals,
        feeBps,
      });
    },
  };
}

// Async rebuild path - used only for reattaching an open position after a
// restart, or graduating a watchlist candidate to a buy (same shape as
// rebuildRaydiumPriceSource / createPumpFunPriceSource's restart story).
// Re-fetches+decodes the Pool account fresh, then delegates to the sync
// factory above.
export async function rebuildPumpSwapPriceSource(
  connection: Connection,
  poolAddress: PublicKey,
  baseDecimals: number,
  quoteDecimals: number,
): Promise<PriceSource> {
  const accountInfo = await connection.getAccountInfo(poolAddress);
  if (!accountInfo?.data) {
    throw new Error(`PumpSwap pool account not found: ${poolAddress.toString()}`);
  }
  const pool = decodePoolAccount(poolAddress, accountInfo.data);
  return createPumpSwapPriceSource(connection, pool, baseDecimals, quoteDecimals);
}
