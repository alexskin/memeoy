// Adapted from repo-reference/listeners/listeners.ts. The wallet-change
// subscription is deliberately dropped - it exists in the reference bot to
// detect real token deposits into a funded wallet, which does not apply
// here (no wallet, no real balances). OpenBook/Raydium subscriptions are
// kept verbatim (connection.onProgramAccountChange, i.e. programSubscribe) -
// PumpSwap is the one that matters in practice (it's carried ~100% of real
// detection volume for a while now) and programSubscribe is the single most
// commonly paid-tier-gated RPC method across providers, so it's rewritten
// below to use onLogs (logsSubscribe) instead, which is far more widely
// available for free.
import { LIQUIDITY_STATE_LAYOUT_V4, MAINNET_PROGRAM_ID, MARKET_STATE_LAYOUT_V3, Token } from '@raydium-io/raydium-sdk';
import bs58 from 'bs58';
import { Connection, KeyedAccountInfo, Logs } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { PUMPSWAP_PROGRAM_ID } from '../pumpswap/constants';
import { decodeCreatePoolEventFromLogs } from '../pumpswap/createPoolEventDecoder';
import { decodePoolAccount } from '../pumpswap/state';
import { logger } from '../logger';

export declare interface Listeners {
  on(event: 'pumpswapPool', listener: (info: KeyedAccountInfo) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
}

type Subscription = { id: number; kind: 'account' | 'logs' };

export class Listeners extends EventEmitter {
  private subscriptions: Subscription[] = [];

  constructor(private readonly connection: Connection) {
    super();
  }

  public async start(config: { quoteToken: Token; cacheNewMarkets: boolean }) {
    if (config.cacheNewMarkets) {
      const openBookSubscription = await this.subscribeToOpenBookMarkets(config);
      this.subscriptions.push({ id: openBookSubscription, kind: 'account' });
    }

    const raydiumSubscription = await this.subscribeToRaydiumPools(config);
    this.subscriptions.push({ id: raydiumSubscription, kind: 'account' });

    const pumpSwapSubscription = this.subscribeToPumpSwapPools(config);
    this.subscriptions.push({ id: pumpSwapSubscription, kind: 'logs' });
  }

  private async subscribeToOpenBookMarkets(config: { quoteToken: Token }) {
    return this.connection.onProgramAccountChange(
      MAINNET_PROGRAM_ID.OPENBOOK_MARKET,
      async (updatedAccountInfo) => {
        this.emit('market', updatedAccountInfo);
      },
      this.connection.commitment,
      [
        { dataSize: MARKET_STATE_LAYOUT_V3.span },
        {
          memcmp: {
            offset: MARKET_STATE_LAYOUT_V3.offsetOf('quoteMint'),
            bytes: config.quoteToken.mint.toBase58(),
          },
        },
      ],
    );
  }

  private async subscribeToRaydiumPools(config: { quoteToken: Token }) {
    return this.connection.onProgramAccountChange(
      MAINNET_PROGRAM_ID.AmmV4,
      async (updatedAccountInfo) => {
        this.emit('pool', updatedAccountInfo);
      },
      this.connection.commitment,
      [
        { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span },
        {
          memcmp: {
            offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint'),
            bytes: config.quoteToken.mint.toBase58(),
          },
        },
        {
          memcmp: {
            offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('marketProgramId'),
            bytes: MAINNET_PROGRAM_ID.OPENBOOK_MARKET.toBase58(),
          },
        },
        {
          memcmp: {
            offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('status'),
            bytes: bs58.encode([6, 0, 0, 0, 0, 0, 0, 0]),
          },
        },
      ],
    );
  }

  // onLogs (logsSubscribe) instead of onProgramAccountChange
  // (programSubscribe) - see the file header for why. Every transaction
  // touching the program flows through this callback (swaps included, not
  // just creates), so each batch of logs is checked for a CreatePoolEvent
  // and anything else is silently ignored - same filtering shape as
  // lib/pumpfun/listener.ts's onLogs subscription. The event itself doesn't
  // carry the pool's own two vault token accounts (only the creator's
  // deposit accounts - see createPoolEventDecoder.ts), so one follow-up
  // getAccountInfo + the existing decodePoolAccount() reconstructs the same
  // KeyedAccountInfo-shaped payload the old account-subscription path used
  // to emit - downstream consumers (scripts/worker.ts) need no changes.
  private subscribeToPumpSwapPools(config: { quoteToken: Token }): number {
    return this.connection.onLogs(
      PUMPSWAP_PROGRAM_ID,
      (logs: Logs) => {
        if (logs.err) return; // failed tx - a create attempt that reverted made no pool
        const event = decodeCreatePoolEventFromLogs(logs.logs);
        if (!event) return;
        if (!event.quoteMint.equals(config.quoteToken.mint)) return; // keep this to SOL-quoted pools only, same as the old memcmp filter

        this.connection
          .getAccountInfo(event.pool)
          .then((accountInfo) => {
            if (!accountInfo?.data) return;
            // Decoded here purely to fail fast/silent on a malformed or
            // not-yet-visible account - the emitted payload still carries
            // the raw KeyedAccountInfo, decoded again by the existing
            // pumpswapPool handler in scripts/worker.ts, unchanged from
            // before this rewrite.
            decodePoolAccount(event.pool, accountInfo.data);
            this.emit('pumpswapPool', { accountId: event.pool, accountInfo } satisfies KeyedAccountInfo);
          })
          .catch((error) => logger.debug({ pool: event.pool.toString(), error: String(error) }, 'PumpSwap: failed to fetch newly created pool account'));
      },
      this.connection.commitment,
    );
  }

  public async stop() {
    for (let i = this.subscriptions.length - 1; i >= 0; --i) {
      const { id, kind } = this.subscriptions[i];
      if (kind === 'logs') {
        await this.connection.removeOnLogsListener(id);
      } else {
        await this.connection.removeAccountChangeListener(id);
      }
      this.subscriptions.splice(i, 1);
    }
  }
}
