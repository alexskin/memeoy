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

export interface DexPaidStatus {
  /** An approved (paid, not just attempted/cancelled) "tokenProfile" order - DexScreener's ~$300 Enhanced Token Info product. */
  hasApprovedProfile: boolean;
  /** Any boost payment on record, active or expired - boosts are the separate, cheaper, repeatable "trending" product. */
  hasAnyBoost: boolean;
}

// GET /orders/v1/{chainId}/{tokenAddress} - confirmed live 2026-08-19: a
// token with no paid orders returns {orders:[],boosts:[]}; a real paid one
// returns e.g. {orders:[{type:"tokenProfile",status:"approved",...}],
// boosts:[{amount:10,...}]}. No batch variant (one mint per call) - fine
// since this only ever runs on the small late-stage candidate population
// (same as devRisk/freshWallet), not every raw detection. Reuses the shared
// dexScreenerRateLimiter rather than a second limiter - conservative, and
// real call volume here is small regardless.
// Advisory-only prompt line for decisionEngine.ts, same convention as
// lib/agent/stats.ts's summarize*BySignal functions - a paid profile/boost
// is a weak positive signal, never a hard gate (plenty of legitimate tokens
// never bother paying for visibility).
export function summarizeDexPaidStatus(status: DexPaidStatus | null): string {
  if (!status) return 'DexScreener paid-status: unavailable (lookup failed or not indexed yet).';
  if (status.hasApprovedProfile && status.hasAnyBoost) return 'DexScreener paid-status: team paid for BOTH an Enhanced Token Info profile and a boost - a real money commitment to visibility.';
  if (status.hasApprovedProfile) return 'DexScreener paid-status: team paid for an approved Enhanced Token Info profile.';
  if (status.hasAnyBoost) return 'DexScreener paid-status: team paid for a boost (no profile purchase on record).';
  return 'DexScreener paid-status: no paid profile or boost on record - common for both legit and rug tokens alike, so absence alone proves nothing.';
}

export async function getDexPaidStatus(chainId: string, mint: string): Promise<DexPaidStatus | null> {
  return dexScreenerRateLimiter.schedule(async () => {
    const url = `${API_BASE}/orders/v1/${chainId}/${mint}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        logger.warn({ status: response.status, mint }, 'DexScreener orders request failed');
        return null;
      }
      const json = (await response.json()) as { orders?: { type: string; status: string }[]; boosts?: unknown[] };
      return {
        hasApprovedProfile: (json.orders ?? []).some((o) => o.type === 'tokenProfile' && o.status === 'approved'),
        hasAnyBoost: (json.boosts ?? []).length > 0,
      };
    } catch (error) {
      logger.warn({ error: String(error), mint }, 'DexScreener orders request failed');
      return null;
    } finally {
      clearTimeout(timer);
    }
  });
}
