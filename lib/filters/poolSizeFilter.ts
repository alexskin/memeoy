// Ported from repo-reference/filters/pool-size.filter.ts.
import { Connection } from '@solana/web3.js';
import { LiquidityPoolKeysV4, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { Filter, FilterResult } from './types';
import { logger } from '../logger';

export class PoolSizeFilter implements Filter {
  public readonly name = 'poolSize' as const;

  constructor(
    private readonly connection: Connection,
    private readonly quoteToken: Token,
    private readonly minPoolSize: TokenAmount,
    private readonly maxPoolSize: TokenAmount,
  ) {}

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    try {
      const response = await this.connection.getTokenAccountBalance(poolKeys.quoteVault, this.connection.commitment);
      const poolSize = new TokenAmount(this.quoteToken, response.value.amount, true);
      let inRange = true;

      if (!this.maxPoolSize.isZero()) {
        inRange = poolSize.raw.lte(this.maxPoolSize.raw);
        if (!inRange) {
          return { ok: false, message: `PoolSize -> Pool size ${poolSize.toFixed()} > ${this.maxPoolSize.toFixed()}` };
        }
      }

      if (!this.minPoolSize.isZero()) {
        inRange = poolSize.raw.gte(this.minPoolSize.raw);
        if (!inRange) {
          return { ok: false, message: `PoolSize -> Pool size ${poolSize.toFixed()} < ${this.minPoolSize.toFixed()}` };
        }
      }

      return { ok: inRange };
    } catch (error) {
      logger.error({ mint: poolKeys.baseMint.toString() }, 'Failed to check pool size');
    }

    return { ok: false, message: 'PoolSize -> Failed to check pool size' };
  }
}
