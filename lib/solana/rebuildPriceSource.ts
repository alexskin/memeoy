// Rebuilds a Raydium PriceSource fresh from what's persisted in
// detected_pools (pool_id = AMM account, market_id) rather than holding a
// live closure in memory for the (potentially hours-long) time a candidate
// sits on the watchlist. Mirrors how pump.fun positions already reattach
// after a worker restart - same idea, applied at watchlist-graduation time
// instead of process-restart time. As a side effect this also means a
// Raydium position could theoretically be reattached after a restart too,
// though that's not wired up (out of scope for this pass).
import { Connection, PublicKey } from '@solana/web3.js';
import { LIQUIDITY_STATE_LAYOUT_V4, Token } from '@raydium-io/raydium-sdk';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { createPoolKeys } from './poolKeys';
import { getMinimalMarketV3 } from './market';
import { createRaydiumPriceSource } from '../fillSimulator/slippage';
import { createPumpFunPriceSource } from '../pumpfun/priceSource';
import { rebuildPumpSwapPriceSource } from '../pumpswap/priceSource';
import { NATIVE_SOL_DECIMALS } from '../pumpfun/constants';
import { PriceSource } from '../priceSource/types';
import { DetectedPool } from '../types';

export async function rebuildRaydiumPriceSource(
  connection: Connection,
  quoteToken: Token,
  pool: DetectedPool,
): Promise<PriceSource> {
  const poolAccountId = new PublicKey(pool.poolId);
  const accountInfo = await connection.getAccountInfo(poolAccountId);
  if (!accountInfo?.data) {
    throw new Error(`Raydium pool account not found: ${pool.poolId}`);
  }

  const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(accountInfo.data);
  const market = await getMinimalMarketV3(connection, new PublicKey(pool.marketId), connection.commitment);
  const poolKeys = createPoolKeys(poolAccountId, poolState, market);
  const baseToken = new Token(TOKEN_PROGRAM_ID, poolKeys.baseMint, poolKeys.baseDecimals);

  return createRaydiumPriceSource(connection, poolKeys, quoteToken, baseToken);
}

// Shared venue dispatch, used by both the watchlist's onGraduate callback
// and the position-reattach-after-restart loop in scripts/worker.ts - both
// are really the same operation ("rebuild a fresh PriceSource for this
// persisted pool"), so this is the one place that needs to know about all
// three venues. The `never` check makes a future 4th venue a compile error
// here if this dispatch is forgotten.
export async function rebuildPriceSourceForPool(
  connection: Connection,
  quoteToken: Token,
  pool: DetectedPool,
): Promise<PriceSource> {
  switch (pool.source) {
    case 'raydium':
      return rebuildRaydiumPriceSource(connection, quoteToken, pool);
    case 'pumpfun':
      return createPumpFunPriceSource(connection, new PublicKey(pool.baseMint), new PublicKey(pool.poolId));
    case 'pumpswap':
      return rebuildPumpSwapPriceSource(connection, new PublicKey(pool.poolId), pool.baseDecimals, NATIVE_SOL_DECIMALS);
    default: {
      const _exhaustive: never = pool.source;
      throw new Error(`Unknown venue: ${_exhaustive}`);
    }
  }
}
