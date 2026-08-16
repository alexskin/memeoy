// Growth watchlist for pre-migration pump.fun bonding-curve candidates -
// same shared-interval + tickInFlight re-entrancy guard as
// lib/watchlist/watchlistMonitor.ts (mandatory, see that file's header
// comment for the balance-corruption incident this pattern prevents), but a
// SEPARATE monitor because the data source is completely different:
// DexScreener has no data for unmigrated pump.fun pairs, so this reads
// bonding-curve reserves directly off-chain (market cap - the actual
// "growth" signal, refreshed every tick) and RugCheck (dev/insider/top10
// holder % - cached per mint for CACHE_TTL_MS since those don't move
// block-to-block the way price does, and re-fetching on every tick would
// hammer RugCheck's rate limits for no benefit).
//
// getMultipleAccountsInfo batches every tracked candidate's bonding-curve
// read into as few RPC calls as possible (chunked at 100, the practical
// per-call cap) rather than one getAccountInfo per candidate - at up to
// pumpfunPremigrationMaxWatchlistSize candidates on a short poll interval,
// N separate calls per tick would burn through RPC quota fast (exactly the
// failure mode that took the whole worker down once already this session).
import { Connection, PublicKey } from '@solana/web3.js';
import { decodeBondingCurveAccount } from '../pumpfun/state';
import { bondingCurveMarketCapUsd } from '../pumpfun/curve';
import { PUMPFUN_TOKEN_DECIMALS, NATIVE_SOL_DECIMALS } from '../pumpfun/constants';
import { getSolUsdPrice } from '../dexscreener/solPrice';
import { getRiskInfo, RiskInfo } from '../rugcheck/client';
import { evaluatePremigration } from '../pumpfun/premigrationFilter';
import { getWatchlistPoolsBySource, insertPremigrationSnapshot, updatePoolStatus } from '../db';
import { DetectedPool, StrategyConfig } from '../types';
import { logger } from '../logger';

export type BuyCallback = (pool: DetectedPool) => Promise<void>;
export type BroadcastFn = (event: string, payload: unknown) => void;
export type ConfigAccessor = () => { config: StrategyConfig; versionId: number };

const ACCOUNT_BATCH_SIZE = 100;
const RISK_INFO_CACHE_TTL_MS = 30_000;

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

export class PremigrationWatchlistMonitor {
  private tickInFlight = false;
  private timer: NodeJS.Timeout | null = null;
  private riskInfoCache = new Map<string, { data: RiskInfo | null; fetchedAt: number }>();

  constructor(
    private readonly connection: Connection,
    private readonly getActiveConfig: ConfigAccessor,
    private readonly broadcast: BroadcastFn,
    private readonly onGraduate: BuyCallback,
  ) {}

  start() {
    const { config } = this.getActiveConfig();
    this.timer = setInterval(() => {
      this.tick().catch((error) => logger.error({ error: String(error) }, 'premigration watchlist tick failed'));
    }, Math.max(2000, config.pumpfunPremigrationPollIntervalMs));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async getCachedRiskInfo(mint: string): Promise<RiskInfo | null> {
    const cached = this.riskInfoCache.get(mint);
    if (cached && Date.now() - cached.fetchedAt < RISK_INFO_CACHE_TTL_MS) return cached.data;

    const data = await getRiskInfo(mint);
    this.riskInfoCache.set(mint, { data, fetchedAt: Date.now() });
    return data;
  }

  private async tick() {
    if (this.tickInFlight) {
      logger.debug({}, 'Skipping premigration watchlist tick - previous still in flight');
      return;
    }
    this.tickInFlight = true;

    try {
      const { config, versionId } = this.getActiveConfig();
      if (!config.pumpfunPremigrationEnabled) return;

      const now = Date.now();
      let candidates = getWatchlistPoolsBySource(['pumpfun']);

      if (candidates.length > config.pumpfunPremigrationMaxWatchlistSize) {
        const overflowCount = candidates.length - config.pumpfunPremigrationMaxWatchlistSize;
        const overflow = candidates.slice(0, overflowCount); // oldest first
        for (const c of overflow) {
          updatePoolStatus(c.id, 'skipped');
          this.broadcast('pool.status', { id: c.id, status: 'skipped' });
        }
        candidates = candidates.slice(overflowCount);
        logger.warn({ evicted: overflow.length }, 'Premigration watchlist exceeded max size - evicted oldest candidates');
      }

      const stillLive: DetectedPool[] = [];
      for (const c of candidates) {
        const ageMinutes = (now - c.detectedAt) / 60_000;
        if (ageMinutes > config.pumpfunPremigrationMaxAgeMinutes) {
          updatePoolStatus(c.id, 'rejected');
          this.broadcast('pool.status', { id: c.id, status: 'rejected' });
        } else {
          stillLive.push(c);
        }
      }
      if (stillLive.length === 0) return;

      const solUsdPrice = await getSolUsdPrice();

      const poolBatches = chunk(stillLive, ACCOUNT_BATCH_SIZE);
      const accountsByMint = new Map<string, ReturnType<typeof decodeBondingCurveAccount> | null>();
      for (const poolBatch of poolBatches) {
        const infos = await this.connection.getMultipleAccountsInfo(poolBatch.map((c) => new PublicKey(c.poolId)));
        infos.forEach((info, i) => {
          const pool = poolBatch[i];
          if (!info?.data) {
            accountsByMint.set(pool.baseMint, null);
            return;
          }
          try {
            accountsByMint.set(pool.baseMint, decodeBondingCurveAccount(info.data));
          } catch {
            accountsByMint.set(pool.baseMint, null);
          }
        });
      }

      for (const c of stillLive) {
        try {
          const curve = accountsByMint.get(c.baseMint) ?? null;

          if (curve?.complete) {
            // Migrated away mid-watch - no longer a premigration candidate.
            // The PumpSwap listener will independently pick it up as its own
            // fresh detection if/when it sees the resulting pool.
            updatePoolStatus(c.id, 'rejected');
            this.broadcast('pool.status', { id: c.id, status: 'rejected' });
            continue;
          }

          const marketCapUsd = curve && solUsdPrice != null
            ? bondingCurveMarketCapUsd(curve, PUMPFUN_TOKEN_DECIMALS, NATIVE_SOL_DECIMALS, solUsdPrice)
            : null;
          const risk = await this.getCachedRiskInfo(c.baseMint);

          const evaluation = evaluatePremigration(
            {
              marketCapUsd,
              devHoldingPct: risk?.devHoldingPct ?? null,
              insiderPct: risk?.topHolderInsiderPct ?? null,
              top10HoldersPct: risk?.top10HoldersPct ?? null,
            },
            c.detectedAt,
            config,
            now,
          );

          insertPremigrationSnapshot({
            detectedPoolId: c.id,
            checkedAt: now,
            marketCapUsd,
            devHoldingPct: risk?.devHoldingPct ?? null,
            insiderPct: risk?.topHolderInsiderPct ?? null,
            top10HoldersPct: risk?.top10HoldersPct ?? null,
            ageMinutes: evaluation.ageMinutes,
            hasData: evaluation.hasData,
            pass: evaluation.pass,
            criteria: evaluation.results,
            configVersionId: versionId,
          });
          this.broadcast('premigration.updated', { detectedPoolId: c.id, pass: evaluation.pass, results: evaluation.results, marketCapUsd });

          if (evaluation.pass) {
            updatePoolStatus(c.id, 'passed');
            this.broadcast('pool.status', { id: c.id, status: 'passed' });
            await this.onGraduate(c);
          }
        } catch (error) {
          logger.error({ detectedPoolId: c.id, error: String(error) }, 'Failed to evaluate premigration candidate');
        }
      }
    } finally {
      this.tickInFlight = false;
    }
  }
}
