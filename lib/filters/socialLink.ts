// Shared social-link sourcing, used by both MutableFilter's existing
// on-chain hasSocials() check (mutableFilter.ts) and the new degen-score
// client (lib/degenScore/client.ts), which needs an actual URL rather than
// just a boolean. Priority for the degen-score use case is DexScreener's
// `info.socials`/`info.websites` first (already fetched by getTokensBatch,
// no extra request) - getOnchainSocialLink below is the fallback, factored
// out of what used to be mutableFilter.ts's private inline fetch so both
// call sites share one fetch-with-timeout implementation.
import { DexScreenerPair } from '../dexscreener/types';
import { logger } from '../logger';

const METADATA_FETCH_TIMEOUT_MS = 5000;

export function getSocialLinkFromPair(pair: DexScreenerPair | null): string | null {
  if (!pair?.info) return null;
  const twitter = pair.info.socials?.find((s) => s.type === 'twitter');
  if (twitter?.url) return twitter.url;
  const anySocial = pair.info.socials?.[0];
  if (anySocial?.url) return anySocial.url;
  const website = pair.info.websites?.[0];
  return website?.url ?? null;
}

// Returns the first non-empty extension value from an off-chain metadata
// JSON blob (Metaplex token-metadata's `extensions` object, e.g. {twitter,
// website, telegram}). Pure - no I/O.
export function extractSocialLinkFromMetadataJson(data: any): string | null {
  const extensions = data?.extensions ?? {};
  const twitter = extensions.twitter;
  if (typeof twitter === 'string' && twitter.length > 0) return twitter;
  for (const value of Object.values(extensions)) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

// Fallback source when a DexScreener pair has no `info` block - fetches the
// on-chain metadata URI directly (same timeout convention as
// rugcheck/client.ts). NOT currently called from the watchlist/decision-
// engine path (lib/watchlist/watchlistMonitor.ts only has the DexScreenerPair
// on hand, not a Connection) - wired here only for MutableFilter's existing
// use and for reuse if a caller with RPC access wants it later.
export async function getOnchainSocialLink(uri: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), METADATA_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(uri, { signal: controller.signal });
    const data = await response.json();
    return extractSocialLinkFromMetadataJson(data);
  } catch (error) {
    logger.debug({ uri, error: String(error) }, 'getOnchainSocialLink: fetch failed');
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
