// Live-mode balance bootstrap. Deliberately does NOT duplicate ledger.ts's
// virtual_balance_quote bookkeeping - once seeded correctly here, the
// existing debit-on-open/credit-on-close logic in ledger.ts (unchanged,
// same code paper mode uses) keeps tracking it accurately for free, because
// in live mode every debit/credit now corresponds to a REAL swap that just
// executed (see lib/fillSimulator/fillSimulator.ts's tradingMode branch) -
// the numbers flowing into openPosition()/closePositionAndSettle() are real
// SOL amounts, not simulated ones. This just needs to run once at startup so
// the counter starts from reality instead of StrategyConfig.startingBalanceQuote.
import { Connection, PublicKey } from '@solana/web3.js';
import { setMeta } from '../db';
import { logger } from '../logger';

const LAMPORTS_PER_SOL = 1_000_000_000;
const BALANCE_META_KEY = 'virtual_balance_quote';

export async function initializeLiveBalance(connection: Connection, walletPubkey: PublicKey): Promise<void> {
  const lamports = await connection.getBalance(walletPubkey);
  const sol = lamports / LAMPORTS_PER_SOL;
  setMeta(BALANCE_META_KEY, String(sol));
  logger.info({ wallet: walletPubkey.toString(), balanceSol: sol }, 'Live trading mode: seeded balance from real wallet');
}
