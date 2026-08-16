// Ported from repo-reference/filters/burn.filter.ts.
import { Connection } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { Filter, FilterResult } from './types';
import { logger } from '../logger';

export class BurnFilter implements Filter {
  public readonly name = 'burn' as const;

  constructor(private readonly connection: Connection) {}

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    try {
      const amount = await this.connection.getTokenSupply(poolKeys.lpMint, this.connection.commitment);
      const burned = amount.value.uiAmount === 0;
      return { ok: burned, message: burned ? undefined : "Burn -> Creator didn't burn LP" };
    } catch (e: any) {
      if (e?.code === -32602) {
        return { ok: true };
      }
      logger.error({ mint: poolKeys.baseMint.toString() }, 'Failed to check if LP is burned');
    }

    return { ok: false, message: 'Burn -> Failed to check if LP is burned' };
  }
}
