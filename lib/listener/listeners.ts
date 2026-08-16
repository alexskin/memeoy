// Adapted from repo-reference/listeners/listeners.ts. The wallet-change
// subscription is deliberately dropped - it exists in the reference bot to
// detect real token deposits into a funded wallet, which does not apply
// here (no wallet, no real balances). Pool/market subscriptions are kept
// verbatim: connection.onProgramAccountChange is a pure read subscription.
import { LIQUIDITY_STATE_LAYOUT_V4, MAINNET_PROGRAM_ID, MARKET_STATE_LAYOUT_V3, Token } from '@raydium-io/raydium-sdk';
import bs58 from 'bs58';
import { Connection, KeyedAccountInfo } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { POOL_DISCRIMINATOR, PUMPSWAP_PROGRAM_ID } from '../pumpswap/constants';

export declare interface Listeners {
  on(event: 'pumpswapPool', listener: (info: KeyedAccountInfo) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
}

export class Listeners extends EventEmitter {
  private subscriptions: number[] = [];

  constructor(private readonly connection: Connection) {
    super();
  }

  public async start(config: { quoteToken: Token; cacheNewMarkets: boolean }) {
    if (config.cacheNewMarkets) {
      const openBookSubscription = await this.subscribeToOpenBookMarkets(config);
      this.subscriptions.push(openBookSubscription);
    }

    const raydiumSubscription = await this.subscribeToRaydiumPools(config);
    this.subscriptions.push(raydiumSubscription);

    const pumpSwapSubscription = await this.subscribeToPumpSwapPools(config);
    this.subscriptions.push(pumpSwapSubscription);
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

  // Deliberately no dataSize filter - a live sample saw real Pool accounts
  // at 301, 300, AND 261 bytes (same 8-byte discriminator, presumably
  // different on-chain schema-version ages), so any fixed dataSize would
  // silently miss real pools. The discriminator memcmp alone is sufficient.
  // quote_mint memcmp keeps this to SOL-quoted pools only, since the rest
  // of the system assumes SOL-denominated math throughout.
  private async subscribeToPumpSwapPools(config: { quoteToken: Token }) {
    return this.connection.onProgramAccountChange(
      PUMPSWAP_PROGRAM_ID,
      async (updatedAccountInfo) => {
        this.emit('pumpswapPool', updatedAccountInfo);
      },
      this.connection.commitment,
      [
        { memcmp: { offset: 0, bytes: bs58.encode(POOL_DISCRIMINATOR) } },
        { memcmp: { offset: 75, bytes: config.quoteToken.mint.toBase58() } },
      ],
    );
  }

  public async stop() {
    for (let i = this.subscriptions.length - 1; i >= 0; --i) {
      const subscription = this.subscriptions[i];
      await this.connection.removeAccountChangeListener(subscription);
      this.subscriptions.splice(i, 1);
    }
  }
}
