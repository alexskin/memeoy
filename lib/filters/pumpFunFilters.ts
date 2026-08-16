// pump.fun (pre-migration) analog of pumpSwapFilters.ts - same reused
// RenouncedFreezeFilter/MutableFilter against the mint, no curve-progress
// equivalent needed here since the premigration watchlist's own maxAge/
// minMarketCap criteria (premigrationFilter.ts) already gate on how far
// along the curve is.
import { Connection, PublicKey } from '@solana/web3.js';
import { getMetadataAccountDataSerializer } from '@metaplex-foundation/mpl-token-metadata';
import { Filter, MintLike, NamedFilterResult } from './types';
import { RenouncedFreezeFilter } from './renouncedFreezeFilter';
import { MutableFilter } from './mutableFilter';
import { StrategyConfig } from '../types';

export class PumpFunFilters {
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
