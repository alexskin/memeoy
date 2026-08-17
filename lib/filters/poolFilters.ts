// Adapted from repo-reference/filters/pool-filters.ts. Two behavioral changes
// from the reference: (1) config is injected per-call from the active
// StrategyConfig instead of read from static process.env constants, so a
// dashboard-driven config change takes effect on the next pool without a
// restart; (2) execute() always runs every filter and returns the full
// FilterResult[] (not a collapsed boolean) so each check can be persisted
// and shown in the dashboard's pass/fail feed.
import { Connection } from '@solana/web3.js';
import { LiquidityPoolKeysV4, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { getMetadataAccountDataSerializer } from '@metaplex-foundation/mpl-token-metadata';
import { Filter, NamedFilterResult } from './types';
import { BurnFilter } from './burnFilter';
import { RenouncedFreezeFilter } from './renouncedFreezeFilter';
import { PoolSizeFilter } from './poolSizeFilter';
import { MutableFilter } from './mutableFilter';
import { StickyPassFilter } from './stickyPassFilter';
import { StrategyConfig } from '../types';

export type { NamedFilterResult };

export class PoolFilters {
  private readonly filters: Filter[] = [];

  constructor(connection: Connection, quoteToken: Token, config: StrategyConfig) {
    if (config.checkBurned) {
      // Sticky: LP burn is a one-way on-chain fact - once burned it can
      // never be un-burned, so a passing result never needs re-fetching for
      // the rest of this pool's filter-match loop (see stickyPassFilter.ts).
      this.filters.push(new StickyPassFilter(new BurnFilter(connection)));
    }

    if (config.checkRenounced || config.checkFreezable) {
      // Sticky for the same reason - mint/freeze authority set to None can
      // never be reassigned.
      this.filters.push(new StickyPassFilter(new RenouncedFreezeFilter(connection, config.checkRenounced, config.checkFreezable)));
    }

    if (config.checkMutable || config.checkSocials) {
      this.filters.push(
        new MutableFilter(connection, getMetadataAccountDataSerializer(), config.checkMutable, config.checkSocials),
      );
    }

    if (config.minPoolSizeQuote > 0 || config.maxPoolSizeQuote > 0) {
      this.filters.push(
        new PoolSizeFilter(
          connection,
          quoteToken,
          new TokenAmount(quoteToken, config.minPoolSizeQuote, false),
          new TokenAmount(quoteToken, config.maxPoolSizeQuote, false),
        ),
      );
    }
  }

  public async execute(poolKeys: LiquidityPoolKeysV4): Promise<NamedFilterResult[]> {
    if (this.filters.length === 0) return [];

    return Promise.all(
      this.filters.map(async (f) => ({ filterName: f.name, ...(await f.execute(poolKeys)) })),
    );
  }
}
