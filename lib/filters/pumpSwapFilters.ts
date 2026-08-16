// PumpSwap analog of poolFilters.ts - RenouncedFreezeFilter/MutableFilter
// are reused verbatim (both accept MintLike). No curve-progress equivalent:
// unlike a pump.fun bonding curve, a PumpSwap pool is already a real AMM
// from the moment it's created, so there's no "progress toward migration"
// concept to gate on here.
import { Connection, PublicKey } from '@solana/web3.js';
import { getMetadataAccountDataSerializer } from '@metaplex-foundation/mpl-token-metadata';
import { Filter, MintLike, NamedFilterResult } from './types';
import { RenouncedFreezeFilter } from './renouncedFreezeFilter';
import { MutableFilter } from './mutableFilter';
import { StrategyConfig } from '../types';

export class PumpSwapFilters {
  private readonly mintFilters: Filter<MintLike>[] = [];

  constructor(connection: Connection, config: StrategyConfig) {
    if (config.checkRenounced || config.checkFreezable) {
      this.mintFilters.push(new RenouncedFreezeFilter(connection, config.checkRenounced, config.checkFreezable));
    }

    if (config.checkMutable || config.checkSocials) {
      this.mintFilters.push(
        new MutableFilter(connection, getMetadataAccountDataSerializer(), config.checkMutable, config.checkSocials),
      );
    }
  }

  public async execute(mint: PublicKey): Promise<NamedFilterResult[]> {
    const results: NamedFilterResult[] = [];
    for (const filter of this.mintFilters) {
      results.push({ filterName: filter.name, ...(await filter.execute({ baseMint: mint })) });
    }
    return results;
  }
}
