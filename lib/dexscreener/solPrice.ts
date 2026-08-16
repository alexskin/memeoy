// SOL/USD price via DexScreener's own WSOL pair data - reuses the existing
// rate-limited client (lib/dexscreener/client.ts) rather than adding a
// second HTTP dependency. Cached, since SOL's price doesn't move fast
// enough to need a fresh read on every premigration-watchlist tick and this
// keeps it off the DexScreener rate-limiter's hot path.
import { getTokensBatch } from './client';
import { logger } from '../logger';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const CACHE_TTL_MS = 60_000;

let cachedPrice: number | null = null;
let cachedAt = 0;

export async function getSolUsdPrice(): Promise<number | null> {
  if (cachedPrice !== null && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedPrice;
  }

  try {
    const pairs = await getTokensBatch('solana', [WSOL_MINT]);
    const pair = pairs.get(WSOL_MINT);
    const priceUsd = pair?.priceUsd ? Number(pair.priceUsd) : null;
    if (priceUsd && priceUsd > 0) {
      cachedPrice = priceUsd;
      cachedAt = Date.now();
      return priceUsd;
    }
  } catch (error) {
    logger.warn({ error: String(error) }, 'Failed to fetch SOL/USD price from DexScreener');
  }

  // Stale-but-present beats null if DexScreener hiccups on one poll - only
  // a hard failure on the very first-ever call returns null.
  return cachedPrice;
}
