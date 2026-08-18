// Polls a tracked mint's on-chain total supply and alerts (never trades)
// when it drops by at least thresholdTokens since the last check. Supply
// dropping IS the burn, for any mint whose mint authority is renounced
// (the pump.fun norm - confirmed via holderConcentrationFilter.ts's
// MintLayout decode already used elsewhere in this codebase) - no raw
// Burn-instruction log parsing needed, since SPL Token's Burn instruction
// carries no amount in its log output anyway (only Anchor-style programs
// emit structured event logs the way pump.fun's CreateEvent does). Same
// shared-interval + tickInFlight re-entrancy guard as every other poller
// in this codebase (WalletWatcher, WatchlistMonitor) - mandatory here too.
import { Connection, PublicKey } from '@solana/web3.js';
import { getMeta, insertBurnAlert, setMeta } from '../db';
import { sendDiscordNotification } from '../notify/discord';
import { StrategyConfig } from '../types';
import { logger } from '../logger';

export type BroadcastFn = (event: string, payload: unknown) => void;
export type ConfigAccessor = () => { config: StrategyConfig; versionId: number };

// Persisted (not in-memory) so a worker restart doesn't compare against a
// fresh baseline of 0/undefined and either miss a burn that happened during
// the gap or, worse, misreport the mint's ENTIRE supply as "burned since
// last check" the first tick after restart.
const META_KEY_PREFIX = 'burn_watch_supply_';

export class BurnWatcher {
  private tickInFlight = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly connection: Connection,
    private readonly getActiveConfig: ConfigAccessor,
    private readonly broadcast: BroadcastFn,
  ) {}

  start(intervalMs = 20_000) {
    this.timer = setInterval(() => {
      this.tick().catch((error) => logger.error({ error: String(error) }, 'burnWatcher tick failed'));
    }, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick() {
    if (this.tickInFlight) return;
    this.tickInFlight = true;

    try {
      const { config } = this.getActiveConfig();
      if (config.trackedBurnMints.length === 0) return;

      for (const tracked of config.trackedBurnMints) {
        try {
          const supplyResp = await this.connection.getTokenSupply(new PublicKey(tracked.mint));
          const currentSupply = supplyResp.value.uiAmount ?? 0;

          const metaKey = META_KEY_PREFIX + tracked.mint;
          const lastRaw = getMeta(metaKey);
          setMeta(metaKey, String(currentSupply));

          if (lastRaw === null) continue; // first tick for this mint - establish a baseline only
          const lastSupply = Number(lastRaw);
          const burned = lastSupply - currentSupply;
          if (burned < tracked.thresholdTokens) continue;

          const alert = { mint: tracked.mint, burnedAmount: burned, supplyAfter: currentSupply, detectedAt: Date.now() };
          const id = insertBurnAlert(alert);
          logger.info({ mint: tracked.mint, burned, currentSupply }, 'Large burn detected for tracked mint');
          this.broadcast('burn.alert', { ...alert, id });
          sendDiscordNotification(
            [
              `🔥 **Nagy égetés észlelve**`,
              `Mint: \`${tracked.mint}\``,
              `Elégetve: ${burned.toLocaleString('en-US', { maximumFractionDigits: 0 })} token`,
              `Supply utána: ${currentSupply.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
            ].join('\n'),
          ).catch(() => {}); // sendDiscordNotification already never throws; belt-and-suspenders
        } catch (error) {
          logger.warn({ mint: tracked.mint, error: String(error) }, 'burnWatcher: failed to check mint supply');
        }
      }
    } finally {
      this.tickInFlight = false;
    }
  }
}
