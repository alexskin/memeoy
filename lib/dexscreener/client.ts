// Client for DexScreener's official public API - reads only, no scraping of
// the website's internal /new-pairs screener endpoint (unstable, likely
// against ToS, ungoverned rate limits). Our own on-chain listeners already
// do real-time discovery; this just fetches momentum metrics for candidates
// we already found.
import { dexScreenerRateLimiter } from './rateLimiter';
import { DexScreenerPair } from './types';
import { logger } from '../logger';

const API_BASE = 'https://api.dexscreener.com';

// Plain fetch() has no default timeout - a stalled connection would hang
// this call forever, which sits directly in positionMonitor's close path
// (fetchExitMarketCapUsd) and could wedge the same way an un-timed-out RPC
// call did (see lib/solana/withTimeout.ts). AbortController actually cancels
// the in-flight request, unlike a bare Promise.race.
const FETCH_TIMEOUT_MS = 10_000;

// DexScreener documents a comma-separated batch on /tokens/v1/{chainId}/{tokenAddresses}.
// Phase A must confirm the real ceiling against a live call - kept as a
// single const so a correction is a one-line change.
export const DEXSCREENER_BATCH_SIZE = 30;

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

// The API's response for /tokens/v1 has been seen as either a bare array or
// a `{ pairs: [...] }` wrapper depending on endpoint/version - handle both
// rather than assume, since this is exactly the kind of thing Phase A's live
// verification is meant to pin down.
function extractPairs(json: unknown): DexScreenerPair[] {
  if (Array.isArray(json)) return json as DexScreenerPair[];
  if (json && typeof json === 'object' && Array.isArray((json as any).pairs)) {
    return (json as any).pairs as DexScreenerPair[];
  }
  return [];
}

async function fetchChunk(chainId: string, addresses: string[]): Promise<DexScreenerPair[]> {
  return dexScreenerRateLimiter.schedule(async () => {
    const url = `${API_BASE}/tokens/v1/${chainId}/${addresses.join(',')}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        logger.warn({ status: response.status, addresses: addresses.length }, 'DexScreener request failed');
        return [];
      }
      const json = await response.json();
      return extractPairs(json);
    } finally {
      clearTimeout(timer);
    }
  });
}

// Returns a Map keyed by the requested mint address (lowercase-insensitive
// as-given). A mint DexScreener hasn't indexed yet (very common right after
// our own faster on-chain detection) maps to null - callers must treat that
// as "not passing yet", never as a hard failure.
export async function getTokensBatch(chainId: string, addresses: string[]): Promise<Map<string, DexScreenerPair | null>> {
  const unique = Array.from(new Set(addresses));
  const result = new Map<string, DexScreenerPair | null>(unique.map((a) => [a, null]));
  if (unique.length === 0) return result;

  const chunks = chunk(unique, DEXSCREENER_BATCH_SIZE);
  const chunkResults = await Promise.all(chunks.map((c) => fetchChunk(chainId, c)));

  for (const pairs of chunkResults) {
    for (const pair of pairs) {
      const mint = pair.baseToken?.address;
      if (!mint || !result.has(mint)) continue;

      const existing = result.get(mint);
      // A mint can have multiple pairs across dexes/quote assets - prefer
      // the one with the most liquidity if we see more than one.
      if (!existing || (pair.liquidity?.usd ?? 0) > (existing.liquidity?.usd ?? 0)) {
        result.set(mint, pair);
      }
    }
  }

  return result;
}
