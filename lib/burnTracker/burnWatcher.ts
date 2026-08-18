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
import { Connection, ConfirmedSignatureInfo, ParsedInstruction, PublicKey } from '@solana/web3.js';
import { getMeta, insertBurnAlert, setMeta, updateBurnAlertBurners } from '../db';
import { sendDiscordNotification } from '../notify/discord';
import { StrategyConfig } from '../types';
import { logger } from '../logger';

export type BroadcastFn = (event: string, payload: unknown) => void;
export type ConfigAccessor = () => { config: StrategyConfig; versionId: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Hard ceiling on parsed-transaction fetches per attribution attempt - a
// hyperactive mint can do 100+ tx/sec, which would otherwise make the
// window scan take many minutes. Best-effort forensics, not the trading hot
// path, so a bounded miss is acceptable; capped to keep RPC usage sane.
const MAX_TX_FETCHES = 1500;
const PER_TX_THROTTLE_MS = 90;

// Persisted (not in-memory) so a worker restart doesn't compare against a
// fresh baseline of 0/undefined and either miss a burn that happened during
// the gap or, worse, misreport the mint's ENTIRE supply as "burned since
// last check" the first tick after restart.
const META_KEY_PREFIX = 'burn_watch_supply_';

export class BurnWatcher {
  private tickInFlight = false;
  private timer: NodeJS.Timeout | null = null;
  private pollIntervalMs = 20_000;

  constructor(
    private readonly connection: Connection,
    private readonly getActiveConfig: ConfigAccessor,
    private readonly broadcast: BroadcastFn,
  ) {}

  start(intervalMs = 20_000) {
    this.pollIntervalMs = intervalMs;
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

          // Fire-and-forget: on-chain attribution is slow on high-volume
          // mints (can take minutes), so it must never block this tick's
          // loop over other tracked mints. Failure is logged, never thrown.
          this.attributeBurn(tracked.mint, id, alert.detectedAt, burned).catch((error) =>
            logger.warn({ mint: tracked.mint, alertId: id, error: String(error) }, 'burnWatcher: burner attribution failed'),
          );
        } catch (error) {
          logger.warn({ mint: tracked.mint, error: String(error) }, 'burnWatcher: failed to check mint supply');
        }
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  // Identifies the wallet(s) that performed a just-detected burn by
  // scanning the mint's transaction history around the poll window that
  // caught the supply drop. detectedAtMs is when we NOTICED the drop, not
  // when the tx landed - the actual burn could be anywhere in the
  // preceding poll interval, so the search window starts a full interval
  // before detection (plus a small buffer for clock/RPC skew).
  private async attributeBurn(mint: string, alertId: number, detectedAtMs: number, burnedAmount: number) {
    const mintPk = new PublicKey(mint);
    const targetSec = Math.floor(detectedAtMs / 1000);
    const windowStartSec = targetSec - Math.ceil(this.pollIntervalMs / 1000) - 5;
    const windowEndSec = targetSec + 2;

    // Phase 1: cheap pagination through signature LISTS only, to collect
    // every signature in the window without fetching full transactions yet.
    let before: string | undefined;
    const windowSigs: ConfirmedSignatureInfo[] = [];
    for (let page = 0; page < 150; page++) {
      const sigs = await this.connection.getSignaturesForAddress(mintPk, { before, limit: 1000 }, 'confirmed');
      if (sigs.length === 0) break;
      const newest = sigs[0].blockTime ?? 0;
      const oldest = sigs[sigs.length - 1].blockTime ?? 0;
      before = sigs[sigs.length - 1].signature;
      if (newest < windowStartSec) break; // fully past the window
      for (const s of sigs) {
        const t = s.blockTime ?? 0;
        if (t >= windowStartSec && t <= windowEndSec) windowSigs.push(s);
      }
      if (oldest <= windowStartSec) break;
    }

    if (windowSigs.length === 0) return;

    // Bound worst-case runtime on hyperactive mints - if over budget, keep
    // the signatures closest to the detection time (most likely candidates).
    const capped =
      windowSigs.length > MAX_TX_FETCHES
        ? [...windowSigs].sort((a, b) => Math.abs((a.blockTime ?? 0) - targetSec) - Math.abs((b.blockTime ?? 0) - targetSec)).slice(0, MAX_TX_FETCHES)
        : windowSigs;

    // Phase 2: fetch parsed transactions for the narrowed window, extract
    // Burn/BurnChecked instructions (top-level and CPI/inner) for this mint.
    const burnersByAuthority = new Map<string, number>();
    for (const sig of capped) {
      try {
        const tx = await this.connection.getParsedTransaction(sig.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
        if (!tx) continue;
        const allIx = [
          ...tx.transaction.message.instructions,
          ...(tx.meta?.innerInstructions?.flatMap((i) => i.instructions) ?? []),
        ];
        for (const ix of allIx) {
          if (!('parsed' in ix)) continue;
          const parsed = (ix as ParsedInstruction).parsed;
          if (!parsed || (parsed.type !== 'burn' && parsed.type !== 'burnChecked')) continue;
          if (parsed.info?.mint !== mint) continue;
          const authority: string | undefined = parsed.info.authority;
          if (!authority) continue;
          const rawAmount = parsed.info.tokenAmount?.amount ?? parsed.info.amount;
          const decimals = parsed.info.tokenAmount?.decimals ?? 6;
          const uiAmount = Number(rawAmount) / 10 ** decimals;
          burnersByAuthority.set(authority, (burnersByAuthority.get(authority) ?? 0) + uiAmount);
        }
      } catch {
        // best-effort forensics - a single failed tx fetch shouldn't abort the scan
      }
      await sleep(PER_TX_THROTTLE_MS);
    }

    if (burnersByAuthority.size === 0) {
      logger.warn({ mint, alertId, scanned: capped.length }, 'burnWatcher: no burner found in window');
      return;
    }

    const burners = [...burnersByAuthority.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([address, amount]) => ({ address, amount }));

    updateBurnAlertBurners(alertId, burners);
    this.broadcast('burn.alert.update', { id: alertId, burners });

    const label =
      burners.length === 1
        ? `\`${burners[0].address}\``
        : burners.map((b) => `\`${b.address}\` (${b.amount.toLocaleString('en-US', { maximumFractionDigits: 0 })})`).join(', ');
    sendDiscordNotification(`🔎 Az égetést végző cím (${mint}, ~${burnedAmount.toLocaleString('en-US', { maximumFractionDigits: 0 })} token): ${label}`).catch(() => {});
  }
}
