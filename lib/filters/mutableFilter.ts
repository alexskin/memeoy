// Adapted from repo-reference/filters/mutable.filter.ts. hasSocials() fetches
// an arbitrary URI from on-chain metadata (untrusted, attacker-controlled
// host) - the timeout + fetch logic now lives in socialLink.ts's
// getOnchainSocialLink(), shared with lib/degenScore/client.ts's link
// sourcing rather than duplicated here.
import { Connection } from '@solana/web3.js';
import { getPdaMetadataKey } from '@raydium-io/raydium-sdk';
import { MetadataAccountData, MetadataAccountDataArgs } from '@metaplex-foundation/mpl-token-metadata';
import { Serializer } from '@metaplex-foundation/umi/serializers';
import { Filter, FilterResult, MintLike } from './types';
import { getOnchainSocialLink } from './socialLink';
import { logger } from '../logger';

export class MutableFilter implements Filter<MintLike> {
  public readonly name = 'mutable' as const;

  constructor(
    private readonly connection: Connection,
    private readonly metadataSerializer: Serializer<MetadataAccountDataArgs, MetadataAccountData>,
    private readonly checkMutable: boolean,
    private readonly checkSocials: boolean,
  ) {}

  async execute(input: MintLike): Promise<FilterResult> {
    try {
      const metadataPDA = getPdaMetadataKey(input.baseMint);
      const metadataAccount = await this.connection.getAccountInfo(metadataPDA.publicKey, this.connection.commitment);

      if (!metadataAccount?.data) {
        return { ok: false, message: 'Mutable -> Failed to fetch account data' };
      }

      const deserialize = this.metadataSerializer.deserialize(metadataAccount.data);
      const mutable = !this.checkMutable || deserialize[0].isMutable;
      const hasSocials = !this.checkSocials || (await this.hasSocials(deserialize[0]));
      const ok = !mutable && hasSocials;
      const message: string[] = [];

      if (mutable) message.push('metadata can be changed');
      if (!hasSocials) message.push('has no socials');

      return { ok, message: ok ? undefined : `MutableSocials -> Token ${message.join(' and ')}` };
    } catch (e) {
      logger.error({ mint: input.baseMint.toString() }, 'MutableSocials -> Failed to check metadata');
    }

    return { ok: false, message: 'MutableSocials -> Failed to check metadata' };
  }

  private async hasSocials(metadata: MetadataAccountData): Promise<boolean> {
    return (await getOnchainSocialLink(metadata.uri)) !== null;
  }
}
