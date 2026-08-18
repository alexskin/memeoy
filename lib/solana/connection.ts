// Solana RPC connection. In paper mode (StrategyConfig.tradingMode ===
// 'paper', the default) this is used strictly read-only: account reads,
// program-account subscriptions, and the Raydium SDK's pure pricing math
// (Liquidity.fetchInfo/computeAmountOut) - never paired with a Keypair,
// never sends a transaction. In live mode, this same connection IS used to
// send real signed transactions - but only from
// lib/fillSimulator/slippage.ts's executeSwap, the one deliberately narrow
// place in this codebase that does that, gated on tradingMode === 'live'
// and a real wallet loaded via lib/solana/wallet.ts's getLiveWallet().
import { Connection } from '@solana/web3.js';
import {
  COMMITMENT_LEVEL,
  RPC_ENDPOINT,
  RPC_ENDPOINT_FALLBACK,
  RPC_PROVIDER,
  RPC_PROVIDER_FALLBACK,
  RPC_WEBSOCKET_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT_FALLBACK,
} from '../config/env';
import { RpcRateLimiter, rpsForProvider } from './rpcRateLimiter';
import { logger } from '../logger';

let _connection: Connection | null = null;

// Only the known-heavy, known-async READ methods this codebase actually
// calls (see lib/filters/*, lib/burnTracker/burnWatcher.ts,
// lib/pumpswap/priceSource.ts, ...) - an explicit allowlist rather than
// "everything except sends", so WebSocket subscription methods (onLogs,
// onProgramAccountChange, ...), which return a subscription id
// SYNCHRONOUSLY, are never accidentally wrapped into a Promise and broken,
// and sendTransaction/simulateTransaction (live-trading path) are never
// delayed behind a burst of read-only filter checks.
const THROTTLED_METHODS = new Set([
  'getAccountInfo',
  'getMultipleAccountsInfo',
  'getParsedAccountInfo',
  'getProgramAccounts',
  'getTokenSupply',
  'getTokenLargestAccounts',
  'getTokenAccountBalance',
  'getTokenAccountsByOwner',
  'getParsedTransaction',
  'getTransaction',
  'getSignaturesForAddress',
  'getBalance',
  'getLatestBlockhash',
]);

function isRateLimitError(error: unknown): boolean {
  return /429|rate.?limit|too many requests|requests per second|deprioritized/i.test(String(error));
}

function throttle(connection: Connection, limiter: RpcRateLimiter, fallback?: { connection: Connection; limiter: RpcRateLimiter; provider: string }): Connection {
  return new Proxy(connection, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string' || !THROTTLED_METHODS.has(prop)) {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      const method = value as (...args: unknown[]) => Promise<unknown>;
      return (...args: unknown[]) =>
        limiter.schedule(() => method.apply(target, args)).catch(async (error: unknown) => {
          if (!fallback || !isRateLimitError(error)) throw error;
          logger.warn({ method: prop, provider: fallback.provider, error: String(error) }, 'Solana RPC: primary rate-limited, retrying via fallback endpoint');
          const fallbackMethod = Reflect.get(fallback.connection, prop) as (...args: unknown[]) => Promise<unknown>;
          return fallback.limiter.schedule(() => fallbackMethod.apply(fallback.connection, args));
        });
    },
  });
}

export function getConnection(): Connection {
  if (!_connection) {
    if (!RPC_ENDPOINT || !RPC_WEBSOCKET_ENDPOINT) {
      throw new Error('RPC_ENDPOINT/RPC_WEBSOCKET_ENDPOINT are not set - copy .env.example to .env.local and fill them in');
    }
    const primary = new Connection(RPC_ENDPOINT, {
      wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
      commitment: COMMITMENT_LEVEL,
    });
    const primaryLimiter = new RpcRateLimiter(rpsForProvider(RPC_PROVIDER, process.env.RPC_MAX_REQUESTS_PER_SECOND || ''));

    let fallback: { connection: Connection; limiter: RpcRateLimiter; provider: string } | undefined;
    if (RPC_ENDPOINT_FALLBACK) {
      const fallbackConnection = new Connection(RPC_ENDPOINT_FALLBACK, {
        wsEndpoint: RPC_WEBSOCKET_ENDPOINT_FALLBACK || undefined,
        commitment: COMMITMENT_LEVEL,
      });
      fallback = {
        connection: fallbackConnection,
        limiter: new RpcRateLimiter(rpsForProvider(RPC_PROVIDER_FALLBACK, process.env.RPC_FALLBACK_MAX_REQUESTS_PER_SECOND || '')),
        provider: RPC_PROVIDER_FALLBACK,
      };
    }

    _connection = throttle(primary, primaryLimiter, fallback);
  }
  return _connection;
}
