// Read-only wallet transaction history via Helius's Enhanced Transactions
// API. Confirmed live (2026-08-12 wallet analysis) that this endpoint does
// NOT populate `events.swap` for this account's transactions - reconstructs
// buy/sell directly from `accountData` (the wallet's own native SOL balance
// change plus any tokenBalanceChanges owned by the wallet) instead, which is
// reliable regardless of which DEX/program the swap went through.
import { HELIUS_API_KEY } from '../config/env';
import { logger } from '../logger';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const API_BASE = 'https://api.helius.xyz/v0';

interface TokenBalanceChange {
  userAccount: string;
  mint: string;
  rawTokenAmount: { tokenAmount: string; decimals: number };
}
interface AccountDataEntry {
  account: string;
  nativeBalanceChange: number;
  tokenBalanceChanges: TokenBalanceChange[];
}
interface HeliusTx {
  signature: string;
  timestamp: number;
  type: string;
  source: string;
  accountData: AccountDataEntry[];
}

export interface WalletBuyEvent {
  signature: string;
  timestamp: number;
  mint: string;
  solSpent: number;
  venue: string;
}

// Fetches the wallet's most recent transactions (newest first, Helius
// default order) and returns only the BUY swaps (wallet's own SOL balance
// went down, a non-WSOL token balance went up) - sells are irrelevant here,
// this is purely "what is this wallet entering right now."
export async function getRecentBuys(walletAddress: string, limit = 30): Promise<WalletBuyEvent[]> {
  if (!HELIUS_API_KEY) {
    logger.warn({}, 'WalletTracker: no Helius API key available (RPC_ENDPOINT is not a Helius URL) - skipping');
    return [];
  }

  const url = new URL(`${API_BASE}/addresses/${walletAddress}/transactions`);
  url.searchParams.set('api-key', HELIUS_API_KEY);
  url.searchParams.set('limit', String(limit));

  const res = await fetch(url.toString());
  if (!res.ok) {
    logger.warn({ status: res.status, walletAddress }, 'WalletTracker: Helius request failed');
    return [];
  }

  const txs: HeliusTx[] = await res.json();
  const buys: WalletBuyEvent[] = [];

  for (const tx of txs) {
    if (tx.type !== 'SWAP') continue;

    const walletAccountData = tx.accountData.find((a) => a.account === walletAddress);
    const solChangeUi = (walletAccountData?.nativeBalanceChange ?? 0) / 1e9;
    if (solChangeUi >= 0) continue; // not a net SOL outflow - not a buy from this wallet's perspective

    for (const acc of tx.accountData) {
      for (const tbc of acc.tokenBalanceChanges) {
        if (tbc.userAccount !== walletAddress) continue;
        if (tbc.mint === WSOL_MINT) continue;
        const raw = BigInt(tbc.rawTokenAmount.tokenAmount);
        if (raw <= 0n) continue; // only the token(s) that increased - i.e. what was bought

        buys.push({
          signature: tx.signature,
          timestamp: tx.timestamp,
          mint: tbc.mint,
          solSpent: -solChangeUi,
          venue: tx.source,
        });
      }
    }
  }

  return buys;
}
