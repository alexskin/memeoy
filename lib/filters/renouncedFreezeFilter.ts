// Ported from repo-reference/filters/renounced.filter.ts.
import { AccountInfo, Connection, PublicKey } from '@solana/web3.js';
import { MintLayout } from '@solana/spl-token';
import { Filter, FilterResult, MintLike } from './types';
import { logger } from '../logger';

// Batches getAccountInfo calls that land within BATCH_WINDOW_MS of each
// other into ONE getMultipleAccountsInfo call. This filter is the single
// largest source of sustained RPC volume in the bot: every detected
// candidate polls it repeatedly (up to filterCheckDurationMs/
// filterCheckIntervalMs times) in its OWN independent loop
// (scripts/worker.ts's runFilterMatchLoop) while waiting to see whether the
// creator renounces - with pool creations arriving continuously, many of
// those independent loops' calls land close together in time even though
// they started at different moments, so coalescing them cuts real RPC call
// volume roughly in proportion to how much of that overlap exists, with no
// change needed to the loop/orchestration logic itself (a 400ms coalescing
// delay is immaterial against a 3s+ poll interval).
const BATCH_WINDOW_MS = 400;

class MintAccountBatcher {
  private pending = new Map<string, { mint: PublicKey; resolvers: ((info: AccountInfo<Buffer> | null) => void)[] }>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly connection: Connection) {}

  request(mint: PublicKey): Promise<AccountInfo<Buffer> | null> {
    return new Promise((resolve) => {
      const key = mint.toBase58();
      const existing = this.pending.get(key);
      if (existing) {
        existing.resolvers.push(resolve);
      } else {
        this.pending.set(key, { mint, resolvers: [resolve] });
      }
      if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), BATCH_WINDOW_MS);
      }
    });
  }

  private async flush() {
    this.timer = null;
    const batch = [...this.pending.values()];
    this.pending.clear();
    if (batch.length === 0) return;

    try {
      const accounts = await this.connection.getMultipleAccountsInfo(batch.map((b) => b.mint));
      for (let i = 0; i < batch.length; i++) {
        for (const resolve of batch[i].resolvers) resolve(accounts[i]);
      }
    } catch (error) {
      logger.warn({ error: String(error), count: batch.length }, 'MintAccountBatcher: batched fetch failed, resolving all as unavailable');
      for (const entry of batch) {
        for (const resolve of entry.resolvers) resolve(null);
      }
    }
  }
}

// Keyed loosely on "one shared Connection per process" (true throughout
// this codebase - see lib/solana/connection.ts's own singleton) rather than
// threading a batcher instance through every call site.
let sharedBatcher: MintAccountBatcher | null = null;
function getMintAccountBatcher(connection: Connection): MintAccountBatcher {
  if (!sharedBatcher) sharedBatcher = new MintAccountBatcher(connection);
  return sharedBatcher;
}

export class RenouncedFreezeFilter implements Filter<MintLike> {
  public readonly name = 'renouncedFreeze' as const;

  constructor(
    private readonly connection: Connection,
    private readonly checkRenounced: boolean,
    private readonly checkFreezable: boolean,
  ) {}

  async execute(input: MintLike): Promise<FilterResult> {
    try {
      const accountInfo = await getMintAccountBatcher(this.connection).request(input.baseMint);
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
