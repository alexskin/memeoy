// Ported from repo-reference/filters/renounced.filter.ts.
import { Connection } from '@solana/web3.js';
import { MintLayout } from '@solana/spl-token';
import { Filter, FilterResult, MintLike } from './types';
import { logger } from '../logger';

export class RenouncedFreezeFilter implements Filter<MintLike> {
  public readonly name = 'renouncedFreeze' as const;

  constructor(
    private readonly connection: Connection,
    private readonly checkRenounced: boolean,
    private readonly checkFreezable: boolean,
  ) {}

  async execute(input: MintLike): Promise<FilterResult> {
    try {
      const accountInfo = await this.connection.getAccountInfo(input.baseMint, this.connection.commitment);
      if (!accountInfo?.data) {
        return { ok: false, message: 'RenouncedFreeze -> Failed to fetch account data' };
      }

      const deserialize = MintLayout.decode(accountInfo.data);
      const renounced = !this.checkRenounced || deserialize.mintAuthorityOption === 0;
      // NOTE: repo-reference/filters/renounced.filter.ts has this inverted
      // (`!this.checkFreezable || ...`), which makes `freezable` true
      // whenever the check is disabled and so `ok` always false by default
      // (CHECK_IF_FREEZABLE=false in .env.copy) - confirmed live here as
      // every pool failing this filter. Fixed: disabled means "don't block",
      // i.e. freezable should be false when checkFreezable is false.
      const freezable = this.checkFreezable && deserialize.freezeAuthorityOption !== 0;
      const ok = renounced && !freezable;
      const message: string[] = [];

      if (!renounced) message.push('mint');
      if (freezable) message.push('freeze');

      return { ok, message: ok ? undefined : `RenouncedFreeze -> Creator can ${message.join(' and ')} tokens` };
    } catch (e) {
      logger.error({ mint: input.baseMint.toString() }, 'RenouncedFreeze -> Failed to check mint/freeze authority');
    }

    return { ok: false, message: 'RenouncedFreeze -> Failed to check mint/freeze authority' };
  }
}
