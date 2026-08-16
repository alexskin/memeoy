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
import { COMMITMENT_LEVEL, RPC_ENDPOINT, RPC_WEBSOCKET_ENDPOINT } from '../config/env';

let _connection: Connection | null = null;

export function getConnection(): Connection {
  if (!_connection) {
    if (!RPC_ENDPOINT || !RPC_WEBSOCKET_ENDPOINT) {
      throw new Error('RPC_ENDPOINT/RPC_WEBSOCKET_ENDPOINT are not set - copy .env.example to .env.local and fill them in');
    }
    _connection = new Connection(RPC_ENDPOINT, {
      wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
      commitment: COMMITMENT_LEVEL,
    });
  }
  return _connection;
}
