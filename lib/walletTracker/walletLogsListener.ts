// Near-real-time wallet buy detection via connection.onLogs (WebSocket
// push), NOT polling - the user can manually execute a follow-buy in ~2s,
// so a 20s poll interval would throw away their entire speed advantage.
// onLogs fires whenever the wallet's address appears in ANY transaction
// (buys, sells, unrelated transfers) - each hit is resolved via
// getParsedTransaction and filtered down to "this wallet's own SOL balance
// went down AND some non-WSOL token balance it owns went up," i.e. a buy.
// Fails safe by design, same convention as every other onLogs-based
// listener in this codebase: a parse failure just means "detects nothing"
// for that transaction, never a crash.
import { Commitment, Connection, ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { logger } from '../logger';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const FETCH_RETRY_ATTEMPTS = 5;
const FETCH_RETRY_DELAY_MS = 300;

export interface WalletBuyEvent {
  signature: string;
  timestamp: number;
  mint: string;
  solSpent: number;
  venue: string;
}

export declare interface WalletLogsListener {
  on(event: 'buy', listener: (payload: WalletBuyEvent) => void): this;
  emit(event: 'buy', payload: WalletBuyEvent): boolean;
}

export class WalletLogsListener extends EventEmitter {
  private subscriptionId: number | null = null;

  constructor(
    private readonly connection: Connection,
    private readonly walletAddress: string,
  ) {
    super();
  }

  async start(commitment: Commitment) {
    const walletPk = new PublicKey(this.walletAddress);
    this.subscriptionId = this.connection.onLogs(
      walletPk,
      (logsResult) => {
        if (logsResult.err) return;
        this.handleSignature(logsResult.signature).catch((error) =>
          logger.debug({ signature: logsResult.signature, error: String(error) }, 'WalletLogsListener: failed to process signature'),
        );
      },
      commitment,
    );
  }

  private async handleSignature(signature: string) {
    const tx = await this.fetchWithRetry(signature);
    if (!tx?.meta) return;

    const walletIndex = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey.toString() === this.walletAddress);
    if (walletIndex === -1) return;

    const solChangeUi = (tx.meta.postBalances[walletIndex] - tx.meta.preBalances[walletIndex]) / 1e9;
    if (solChangeUi >= 0) return; // not a net SOL outflow for this wallet - not a buy from its perspective

    const preToken = (tx.meta.preTokenBalances ?? []).filter((b) => b.owner === this.walletAddress);
    const postToken = (tx.meta.postTokenBalances ?? []).filter((b) => b.owner === this.walletAddress);

    for (const post of postToken) {
      if (post.mint === WSOL_MINT) continue;
      const pre = preToken.find((p) => p.accountIndex === post.accountIndex);
      const preAmountRaw = pre ? BigInt(pre.uiTokenAmount.amount) : 0n;
      const postAmountRaw = BigInt(post.uiTokenAmount.amount);
      if (postAmountRaw <= preAmountRaw) continue; // this token account didn't increase - not the bought side

      this.emit('buy', {
        signature,
        timestamp: Date.now(),
        mint: post.mint,
        solSpent: -solChangeUi,
        venue: 'onchain',
      });
    }
  }

  // onLogs can fire slightly before the transaction is indexed for
  // getParsedTransaction - a short bounded retry, not a long poll.
  private async fetchWithRetry(signature: string): Promise<ParsedTransactionWithMeta | null> {
    for (let attempt = 0; attempt < FETCH_RETRY_ATTEMPTS; attempt++) {
      const tx = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (tx) return tx;
      await new Promise((r) => setTimeout(r, FETCH_RETRY_DELAY_MS));
    }
    return null;
  }

  async stop() {
    if (this.subscriptionId !== null) {
      await this.connection.removeOnLogsListener(this.subscriptionId);
      this.subscriptionId = null;
    }
  }
}
