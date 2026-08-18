// Infra-level env vars only - NEVER a wallet/private key. See .env.example.
//
// RPC_ENDPOINT/RPC_WEBSOCKET_ENDPOINT are deliberately NOT validated here
// (used to throw at import time) - this module is transitively imported by
// code that's reachable from the Next.js app (e.g. app/api/agent/run/route.ts
// -> lib/agent/agentRunner.ts -> lib/agent/llmTuner.ts -> here, just for
// ANTHROPIC_API_KEY), and the public read-only Vercel dashboard legitimately
// never sets an RPC endpoint at all - it never touches Solana RPC, only
// Turso (see lib/dbRead.ts). A throwing top-level statement in a module
// touched from that path would crash the dashboard for a reason that has
// nothing to do with what it actually needed. The worker - which genuinely
// cannot function without RPC access - validates this explicitly and fails
// fast at the top of scripts/worker.ts's main() instead.
export const RPC_ENDPOINT = process.env.RPC_ENDPOINT || '';
export const RPC_WEBSOCKET_ENDPOINT = process.env.RPC_WEBSOCKET_ENDPOINT || '';

// Optional secondary RPC - only used as a per-call failover when the
// primary throws a rate-limit-shaped error (lib/solana/connection.ts), so a
// free-tier cap on the primary doesn't stall the whole worker. Leave unset
// to run single-provider, exactly as before.
export const RPC_ENDPOINT_FALLBACK = process.env.RPC_ENDPOINT_FALLBACK || '';
export const RPC_WEBSOCKET_ENDPOINT_FALLBACK = process.env.RPC_WEBSOCKET_ENDPOINT_FALLBACK || '';

// Auto-detected from RPC_ENDPOINT's hostname - deliberately no separate
// RPC_PROVIDER env var. Every provider speaks the same standard Solana
// JSON-RPC/WebSocket protocol (Connection/getProgramAccounts/subscriptions
// all work identically regardless of which one is configured); this is only
// used to (a) log which provider is actually active on worker startup, and
// (b) gate provider-SPECIFIC proprietary APIs (currently just Helius's
// Enhanced Transactions API below) so they fail with a clear reason instead
// of a confusing generic error when a different provider is configured.
export type RpcProvider = 'helius' | 'chainstack' | 'alchemy' | 'ankr' | 'drpc' | 'syndica' | 'quicknode' | 'shyft' | 'unknown';

function detectRpcProvider(url: string): RpcProvider {
  if (!url) return 'unknown';
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
  if (hostname.includes('helius')) return 'helius';
  if (hostname.includes('chainstack')) return 'chainstack';
  if (hostname.includes('alchemy')) return 'alchemy';
  if (hostname.includes('ankr')) return 'ankr';
  if (hostname.includes('drpc')) return 'drpc';
  if (hostname.includes('syndica')) return 'syndica';
  if (hostname.includes('quicknode')) return 'quicknode';
  if (hostname.includes('shyft')) return 'shyft';
  return 'unknown';
}

export const RPC_PROVIDER: RpcProvider = detectRpcProvider(RPC_ENDPOINT);
export const RPC_PROVIDER_FALLBACK: RpcProvider = detectRpcProvider(RPC_ENDPOINT_FALLBACK);

// Only meaningful when RPC_PROVIDER === 'helius' - the Helius RPC URL
// carries it (?api-key=...), used only for the read-only Enhanced
// Transactions API (lib/walletTracker/), never for anything
// wallet/signing-related. Empty string on any other provider; callers must
// treat that as "wallet tracking unavailable," not throw.
const heliusApiKeyMatch = RPC_PROVIDER === 'helius' ? RPC_ENDPOINT.match(/api-key=([^&]+)/) : null;
export const HELIUS_API_KEY = heliusApiKeyMatch ? heliusApiKeyMatch[1] : '';
export const COMMITMENT_LEVEL = (process.env.COMMITMENT_LEVEL || 'confirmed') as
  | 'processed'
  | 'confirmed'
  | 'finalized';
export const WORKER_WS_PORT = Number(process.env.WORKER_WS_PORT || 8787);
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

// Only read/required when StrategyConfig.tradingMode is actually 'live' AND
// a real swap is about to be attempted (see lib/solana/wallet.ts's
// getLiveWallet()) - a paper-mode user never needs this set. Never logged.
export const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || '';
export const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

// Performance toggles, not strategy - deliberately not part of StrategyConfig.
export const PRE_LOAD_EXISTING_MARKETS = process.env.PRE_LOAD_EXISTING_MARKETS === 'true';
export const CACHE_NEW_MARKETS = process.env.CACHE_NEW_MARKETS === 'true';
