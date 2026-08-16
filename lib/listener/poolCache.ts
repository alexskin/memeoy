// Ported verbatim from repo-reference/cache/pool.cache.ts.
import { LiquidityStateV4 } from '@raydium-io/raydium-sdk';

export class PoolCache {
  private readonly keys: Map<string, { id: string; state: LiquidityStateV4 }> = new Map();

  public save(id: string, state: LiquidityStateV4) {
    if (!this.keys.has(state.baseMint.toString())) {
      this.keys.set(state.baseMint.toString(), { id, state });
    }
  }

  public async get(mint: string): Promise<{ id: string; state: LiquidityStateV4 } | undefined> {
    return this.keys.get(mint);
  }
}
