// Infra-level env vars only - NEVER a wallet/private key. See .env.example.
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set - copy .env.example to .env.local and fill it in`);
  }
  return value;
}

export const RPC_ENDPOINT = required('RPC_ENDPOINT');
export const RPC_WEBSOCKET_ENDPOINT = required('RPC_WEBSOCKET_ENDPOINT');

// Derived from RPC_ENDPOINT rather than a separate env var, since the
// Helius RPC URL already carries it (?api-key=...) - used only for the
// read-only Enhanced Transactions API (lib/walletTracker/), never for
// anything wallet/signing-related. Empty string if not a Helius endpoint;
// callers must treat that as "wallet tracking unavailable," not throw.
const heliusApiKeyMatch = RPC_ENDPOINT.match(/api-key=([^&]+)/);
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
