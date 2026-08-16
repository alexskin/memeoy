// Polls a tracked wallet's own buys and pushes a suggested stop-loss/target
// framework to the dashboard - purely advisory, this NEVER opens a
// simulated (or real) position. Same shared-interval + tickInFlight
// re-entrancy guard as every other poller in this codebase
// (WatchlistMonitor, the deleted PumpFunDiscoveryPoller) - mandatory
// pattern here, not optional, per this session's balance-corruption history.
import { getRecentBuys } from './heliusClient';
import { getLatestWalletAlertSignatures, insertWalletAlert } from '../db';
import { StrategyConfig, WalletAlert } from '../types';
import { logger } from '../logger';

export type BroadcastFn = (event: string, payload: unknown) => void;
export type ConfigAccessor = () => { config: StrategyConfig; versionId: number };

export class WalletWatcher {
  private tickInFlight = false;
  private timer: NodeJS.Timeout | null = null;
  // Primed from the DB at start() so a restart doesn't re-alert on
  // already-seen signatures; grows in-memory afterward, same convention as
  // every other dedupe cache in this codebase (no eviction - out of scope).
  private seenSignatures = new Set<string>();

  constructor(
    private readonly getActiveConfig: ConfigAccessor,
    private readonly broadcast: BroadcastFn,
  ) {}

  start() {
    const { config } = this.getActiveConfig();
    // Signatures are globally unique on-chain, so one flat Set correctly
    // dedupes across every tracked wallet - no per-wallet partitioning needed.
    for (const w of config.trackedWallets) {
      for (const sig of getLatestWalletAlertSignatures(w.address)) this.seenSignatures.add(sig);
    }
    this.timer = setInterval(() => {
      this.tick().catch((error) => logger.error({ error: String(error) }, 'walletWatcher tick failed'));
    }, Math.max(10_000, config.walletTrackerPollIntervalMs));
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
      if (!config.walletAlertsEnabled || config.trackedWallets.length === 0) return;

      for (const w of config.trackedWallets) {
        const buys = await getRecentBuys(w.address);

        // Oldest first, so alerts broadcast in the order they actually happened.
        for (const buy of [...buys].reverse()) {
          if (this.seenSignatures.has(buy.signature)) continue;
          this.seenSignatures.add(buy.signature);

          const alert: Omit<WalletAlert, 'id'> = {
            walletAddress: w.address,
            signature: buy.signature,
            mint: buy.mint,
            detectedAt: Date.now(),
            buySolAmount: buy.solSpent,
            venue: buy.venue,
            suggestedStopLossPct: config.walletAlertStopLossPct,
            suggestedTarget1Pct: config.walletAlertTarget1Pct,
            suggestedTarget2Pct: config.walletAlertTarget2Pct,
            suggestedTrailingStopPct: config.walletAlertTrailingStopPct,
            suggestedMaxHoldMinutes: config.walletAlertMaxHoldMinutes,
          };

          const id = insertWalletAlert(alert);
          if (id === null) continue; // already in the DB from a prior process, not actually new

          logger.info({ wallet: w.address, mint: buy.mint, solSpent: buy.solSpent, venue: buy.venue }, 'WalletWatcher: tracked wallet bought - alert sent');
          this.broadcast('wallet.alert', { ...alert, id });
        }
      }
    } finally {
      this.tickInFlight = false;
    }
  }
}
