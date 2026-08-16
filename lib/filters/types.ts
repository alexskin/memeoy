import { Connection, PublicKey } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';

export interface FilterResult {
  ok: boolean;
  message?: string;
}

export type FilterName = 'burn' | 'renouncedFreeze' | 'poolSize' | 'mutable';

// Narrow shape shared by Raydium's LiquidityPoolKeysV4 and pump.fun's mint -
// lets renouncedFreezeFilter/mutableFilter be reused verbatim by both venues
// (LiquidityPoolKeysV4 already structurally satisfies this).
export interface MintLike {
  baseMint: PublicKey;
}

export interface Filter<TInput = LiquidityPoolKeysV4> {
  name: FilterName;
  execute(input: TInput): Promise<FilterResult>;
}

export interface NamedFilterResult extends FilterResult {
  filterName: FilterName;
}

export type FilterCtor = new (connection: Connection, ...args: any[]) => Filter;
