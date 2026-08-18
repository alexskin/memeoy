// Read-only client for RugCheck.xyz's free public API (no API key) - real
// wallet-clustering-based "insiders" detection, confirmed live against
// several real pump.fun/PumpSwap mints. Fails safe: any network error,
// timeout, or unexpected shape returns null, and the caller (insiderFilter.ts)
// treats null as "couldn't verify" and rejects (fail-closed, same convention
// as holderConcentrationFilter.ts).
//
// Deliberately does NOT use the /insiders/graph endpoint's `holdings` field
// to compute a percentage - confirmed live that it's a TRANSFER graph
// (network_type:"transfer"), not a current-balance snapshot, so summing it
// double/triple-counts tokens as they move between wallets (one real token
// showed 193% of its own supply "held" by insiders, which is impossible).
// Instead: `topHolders[].insider` from the main report gives a clean,
// bounded, correctly-scoped current-balance percentage - its only
// limitation is it can't see past the top 20 holders, so a token with many
// SMALL insider wallets (confirmed live: one had graphInsidersDetected=223
// but 0% inside the top 20) would show 0% and slip through on pct alone.
// checkInsiderConcentration therefore also gates on the raw insider WALLET
// COUNT (graphInsidersDetected) as an independent signal.
import { logger } from '../logger';

const API_BASE = 'https://api.rugcheck.xyz/v1';
const FETCH_TIMEOUT_MS = 8000;

interface RugCheckTopHolder {
  owner: string;
  pct: number;
  insider: boolean;
}
interface RugCheckReport {
  token: { supply: number; decimals: number };
  topHolders: RugCheckTopHolder[] | null;
  graphInsidersDetected: number;
  // Raw token amount (same units as token.supply, i.e. NOT decimal-adjusted)
  // currently held by the token's creator wallet - confirmed present live.
  creatorBalance: number | null;
}

export interface InsiderInfo {
  topHolderInsiderPct: number;
  insiderWalletCount: number;
}

// Superset of InsiderInfo for the premigration watchlist (lib/watchlist/
// premigrationWatchlistMonitor.ts), which additionally wants creator
// (dev) holding % and the aggregate top-10-holders % the user's screener
// criteria call for. One RugCheck report fetch covers both call sites'
// needs - kept as a separate function (rather than folding into
// getInsiderInfo) so the existing insiderFilter.ts call site's return shape
// doesn't change.
export interface RiskInfo extends InsiderInfo {
  devHoldingPct: number;
  top10HoldersPct: number;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      logger.warn({ status: res.status, url }, 'RugCheck request failed');
      return null;
    }
    return (await res.json()) as T;
  } catch (error) {
    logger.warn({ error: String(error), url }, 'RugCheck request failed');
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getInsiderInfo(mint: string): Promise<InsiderInfo | null> {
  const report = await fetchJson<RugCheckReport>(`${API_BASE}/tokens/${mint}/report`);
  if (!report?.token) return null;

  const topHolderInsiderPct = (report.topHolders ?? []).filter((h) => h.insider).reduce((sum, h) => sum + h.pct, 0);

  return {
    topHolderInsiderPct,
    insiderWalletCount: report.graphInsidersDetected ?? 0,
  };
}

export interface TopHolderInfo {
  topNonExcludedHolderPct: number;
}

// Same top-20-holders data as getInsiderInfo, filtered down to the largest
// holder that ISN'T one of the given owners (a pool/bonding-curve owner
// legitimately holds most of the supply pre-trade - that's not a real
// concentration risk, same exclusion semantics the old RPC-based
// holderConcentrationFilter.ts used). Replaces raw
// getTokenLargestAccounts/getProgramAccounts calls entirely - both are
// blocked on Chainstack's free tier ("Method requires plan upgrade",
// confirmed live 2026-08-18), and free RPC tiers restrict these same heavy
// indexing methods near-universally, so relying on RugCheck's already-fetched
// top-20 snapshot sidesteps the whole "which provider allows this" problem.
// A holder ranked below the top 20 is, by construction, smaller than
// whatever this returns, so the top-20 cap never misses a real concentration risk.
export async function getTopHolderInfo(mint: string, excludeOwners: string[]): Promise<TopHolderInfo | null> {
  const report = await fetchJson<RugCheckReport>(`${API_BASE}/tokens/${mint}/report`);
  if (!report?.token) return null;

  const excludeSet = new Set(excludeOwners);
  const topNonExcludedHolderPct = (report.topHolders ?? [])
    .filter((h) => !excludeSet.has(h.owner))
    .reduce((max, h) => Math.max(max, h.pct), 0);

  return { topNonExcludedHolderPct };
}

export async function getRiskInfo(mint: string): Promise<RiskInfo | null> {
  const report = await fetchJson<RugCheckReport>(`${API_BASE}/tokens/${mint}/report`);
  if (!report?.token || report.token.supply <= 0) return null;

  const topHolderInsiderPct = (report.topHolders ?? []).filter((h) => h.insider).reduce((sum, h) => sum + h.pct, 0);
  const devHoldingPct = ((report.creatorBalance ?? 0) / report.token.supply) * 100;
  const top10HoldersPct = (report.topHolders ?? [])
    .slice(0, 10)
    .reduce((sum, h) => sum + h.pct, 0);

  return {
    topHolderInsiderPct,
    insiderWalletCount: report.graphInsidersDetected ?? 0,
    devHoldingPct,
    top10HoldersPct,
  };
}
