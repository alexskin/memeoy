// Ported from repo-reference/transactions/default-transaction-executor.ts -
// the "default" (non-Warp/Jito) executor, the only one this project ports.
// The only place in this codebase that sends a real transaction. Only ever
// called from lib/fillSimulator/slippage.ts's executeSwap, which is only
// ever reached when StrategyConfig.tradingMode === 'live'.
import { BlockhashWithExpiryBlockHeight, Connection, VersionedTransaction } from '@solana/web3.js';

export async function executeAndConfirm(
  connection: Connection,
  transaction: VersionedTransaction,
  latestBlockhash: BlockhashWithExpiryBlockHeight,
): Promise<{ confirmed: boolean; signature: string; error?: string }> {
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    preflightCommitment: connection.commitment,
  });

  try {
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash: latestBlockhash.blockhash, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight },
      connection.commitment,
    );
    return { confirmed: !confirmation.value.err, signature, error: confirmation.value.err ? String(confirmation.value.err) : undefined };
  } catch (error) {
    return { confirmed: false, signature, error: String(error) };
  }
}
