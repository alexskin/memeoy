// Standalone, always-on trading worker. Run with:
//   npx tsx --env-file=.env.local scripts/worker.ts
// (or `npm run worker`). Detects real Raydium pool creations AND real
// PumpSwap pool creations, runs safety filters, and by default (paper mode,
// StrategyConfig.tradingMode) simulates buy/sell fills with realistic
// slippage + latency - never holds a private key or sends a real
// transaction. Live mode (opt-in, see README.md "Going live") signs and
// sends real swaps on Raydium only - see lib/fillSimulator/slippage.ts's
// executeSwap, the one deliberately narrow place that does that.
//
// pump.fun tokens are NOT discovered pre-migration: DexScreener never
// reports a `liquidity` field for dexId:"pumpfun" pairs (confirmed live -
// the field is simply absent from the API response, not just unpopulated
// yet), so momentumMinLiquidityUsd can never pass for a bonding-curve-stage
// candidate regardless of how long it's watched. Since March 2025 pump.fun
// runs its own AMM (PumpSwap) and graduated tokens migrate there by default
// now, not to Raydium - confirmed live: the classic Raydium AmmV4+OpenBook
// listener alone detected ZERO pools in 20+ minutes. The PumpSwap listener
// below is origin-agnostic (catches any SOL-quoted PumpSwap pool, not
// exclusively pump.fun graduations) - acceptable since every candidate
// still runs the same safety filters + momentum gate regardless of origin.
// lib/pumpfun/ (priceSource.ts, state.ts, curve.ts) is kept only for
// reattaching an already-open pumpfun-sourced position after a restart.
import { KeyedAccountInfo, PublicKey } from '@solana/web3.js';
import { LIQUIDITY_STATE_LAYOUT_V4, MARKET_STATE_LAYOUT_V3, Token } from '@raydium-io/raydium-sdk';
import { MintLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';

import {
  CACHE_NEW_MARKETS,
  COMMITMENT_LEVEL,
  PRE_LOAD_EXISTING_MARKETS,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  WORKER_WS_PORT,
} from '../lib/config/env';
import { getConnection } from '../lib/solana/connection';
import { getToken } from '../lib/solana/quoteToken';
import { createPoolKeys } from '../lib/solana/poolKeys';
import { MarketCache } from '../lib/listener/marketCache';
import { PoolCache } from '../lib/listener/poolCache';
import { Listeners } from '../lib/listener/listeners';
import { PoolFilters } from '../lib/filters/poolFilters';
import { PumpSwapFilters } from '../lib/filters/pumpSwapFilters';
import { NamedFilterResult } from '../lib/filters/types';
import { simulateBuy, totalFeesPaid } from '../lib/fillSimulator/fillSimulator';
import { createRaydiumPriceSource } from '../lib/fillSimulator/slippage';
import { PositionMonitor } from '../lib/portfolio/positionMonitor';
import * as ledger from '../lib/portfolio/ledger';
import { WorkerWsServer } from '../lib/ws/server';
import { logger } from '../lib/logger';
import {
  getActiveConfigVersion,
  getDetectedPoolById,
  getMeta,
  getOpenPositions,
  getPartialExitsForPosition,
  getSellAllRequestedAt,
  getWorkerControlState,
  insertCreatorLaunch,
  insertDetectedPool,
  insertFilterResult,
  insertFill,
  setMeta,
  updatePoolStatus,
} from '../lib/db';
import { PEAK_PROFIT_UNSET, StrategyConfig } from '../lib/types';
import { PriceSource, Venue } from '../lib/priceSource/types';
import { maybeRunAgent } from '../lib/agent/agentRunner';
import { maybeRunRunnerReview } from '../lib/agent/runnerReview';
import { acquireWorkerLock } from '../lib/workerLock';
import { checkHolderConcentration } from '../lib/filters/holderConcentrationFilter';
import { checkInsiderConcentration } from '../lib/filters/insiderFilter';
import { WatchlistMonitor } from '../lib/watchlist/watchlistMonitor';
import { WalletWatcher } from '../lib/walletTracker/walletWatcher';
import { BurnWatcher } from '../lib/burnTracker/burnWatcher';
import { rebuildPriceSourceForPool } from '../lib/solana/rebuildPriceSource';
import { resolveRiskParams } from '../lib/portfolio/riskParams';
import { PumpSwapPool, decodePoolAccount } from '../lib/pumpswap/state';
import { createPumpSwapPriceSource } from '../lib/pumpswap/priceSource';
import { NATIVE_SOL_DECIMALS, PUMPFUN_TOKEN_DECIMALS } from '../lib/pumpfun/constants';
import { PumpFunListener } from '../lib/pumpfun/listener';
import { PumpFunCreateEvent } from '../lib/pumpfun/createEventDecoder';
import { PumpFunFilters } from '../lib/filters/pumpFunFilters';
import { PremigrationWatchlistMonitor } from '../lib/watchlist/premigrationWatchlistMonitor';
import { sendDiscordNotification, formatPositionOpenedMessage } from '../lib/notify/discord';
import { getTokensBatch } from '../lib/dexscreener/client';
import { DetectedPool } from '../lib/types';
import { getLiveWallet } from '../lib/solana/wallet';
import { initializeLiveBalance } from '../lib/portfolio/liveBalance';
import { runTursoSync, tursoSyncEnabled } from '../lib/sync/tursoSync';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Confirmed live: connection.onProgramAccountChange's underlying WS
// subscription can silently die (dead socket, provider blip) with no error
// event at all - the callback just stops firing forever. The 10s heartbeat
// below is a separate setInterval with no dependency on the listeners, so it
// keeps ticking and the dashboard kept showing "Worker alive" for 15.8h
// after detection had actually stopped. lastPoolEventAt is updated on every
// raw event from either listener (even duplicates/pre-existing pools it
// then ignores) - it's a liveness signal for the subscription itself, not
// for "a new pool was found."
let lastPoolEventAt = Date.now();
const POOL_EVENT_STALE_MS = 5 * 60_000; // PumpSwap alone fires multiple times/sec live - 5min silence is unambiguous
const WATCHDOG_INTERVAL_MS = 60_000;

interface DetectionContext {
  detectedPoolId: number;
  baseMint: string;
  source: Venue;
  priceSource: PriceSource;
  runFilterCheck: () => Promise<NamedFilterResult[]>;
  // Owner pubkey(s) whose token-account balance is excluded from the
  // holder-concentration check (matched against the account's OWNER field,
  // not the account's own address - a pool/curve's holdings sit in an ATA
  // derived from this owner, not at this owner's own address). Without this
  // the pool itself always "fails" as the ~99% holder by design.
  excludeFromConcentration: PublicKey[];
}

async function main() {
  logger.info({}, 'Memeoy worker starting...');

  // The worker (unlike the dashboard, which can run RPC-free against a
  // Turso mirror on Vercel - see lib/config/env.ts) genuinely cannot do
  // anything without chain access. Fail loudly and immediately rather than
  // leaving it to whichever RPC call happens to run first.
  if (!RPC_ENDPOINT || !RPC_WEBSOCKET_ENDPOINT) {
    logger.error({}, 'RPC_ENDPOINT/RPC_WEBSOCKET_ENDPOINT are not set - copy .env.example to .env.local and fill them in. The worker cannot run without RPC access.');
    process.exit(1);
  }

  // Must be first: refuses to start (rather than silently corrupting the
  // shared balance) if another worker is already running against this DB.
  acquireWorkerLock();

  // ---- active config, cached in-memory and polled for hot-reload ----
  let activeVersion = getActiveConfigVersion();
  const getActiveConfig = () => ({ config: activeVersion.config, versionId: activeVersion.id });

  // ---- dashboard PAUSE/START/STOP control, DB-mediated + polled below ----
  let workerState = getWorkerControlState();
  let lastProcessedSellAllAt = getSellAllRequestedAt(); // don't replay a request from before this process started

  const wsServer = new WorkerWsServer(WORKER_WS_PORT);
  const broadcast = (event: string, payload: unknown) => wsServer.broadcast(event, payload);

  const connection = getConnection();

  // Live trading bootstrap - fails fast with a clear error if tradingMode is
  // 'live' but WALLET_PRIVATE_KEY isn't set, rather than discovering that on
  // the first buy attempt. See README.md's "Going live" section.
  if (activeVersion.config.tradingMode === 'live') {
    const wallet = getLiveWallet();
    logger.warn(
      { wallet: wallet.publicKey.toString() },
      'LIVE TRADING MODE - this worker will sign and send REAL transactions with REAL funds.',
    );
    await initializeLiveBalance(connection, wallet.publicKey);
  }

  const quoteToken = getToken(activeVersion.config.quoteMint);
  const marketCache = new MarketCache(connection);
  const poolCache = new PoolCache();
  const positionMonitor = new PositionMonitor(getActiveConfig, broadcast);
  const walletWatcher = new WalletWatcher(getActiveConfig, broadcast);
  const burnWatcher = new BurnWatcher(connection, getActiveConfig, broadcast);

  // Re-attach positions that were left open by a previous run. pump.fun and
  // pumpswap positions carry everything needed to rebuild a PriceSource
  // (mint + pool/curve address, both persisted) so those resume live
  // tracking automatically. Raydium positions can't - reconstructing
  // LiquidityPoolKeys needs vault/market accounts that aren't persisted (see
  // plan's "not persisted across restarts" scope note) - those still need a
  // manual close.
  const preExistingOpen = getOpenPositions();
  let reattached = 0;
  for (const position of preExistingOpen) {
    if (position.source === 'raydium') continue;
    const pool = getDetectedPoolById(position.detectedPoolId);
    if (!pool) continue;

    try {
      const priceSource = await rebuildPriceSourceForPool(connection, quoteToken, pool);
      const firedTargets = new Set(
        getPartialExitsForPosition(position.id)
          .filter((e) => e.targetPct !== null)
          .map((e) => e.targetPct as number),
      );
      positionMonitor.track({
        positionId: position.id,
        priceSource,
        baseMint: position.baseMint,
        quoteSizeInUi: Number(position.quoteSizeIn),
        baseAmountHeldUi: Number(position.baseAmountHeld),
        openedAt: position.openedAt,
        peakProfitPct: position.peakProfitPct,
        originalBaseAmountHeldUi: Number(position.originalBaseAmountHeld),
        originalQuoteSizeInUi: Number(position.originalQuoteSizeIn),
        targetsFired: firedTargets,
        riskParams: resolveRiskParams(getActiveConfig().config, position.source),
      });
      reattached++;
    } catch (error) {
      logger.warn({ positionId: position.id, source: position.source, error: String(error) }, 'Failed to re-attach position');
    }
  }
  const stillOrphaned = preExistingOpen.length - reattached;
  if (reattached > 0) {
    logger.info({ reattached }, 'Re-attached pump.fun/pumpswap positions from a previous run to live monitoring');
  }
  if (stillOrphaned > 0) {
    logger.warn(
      { count: stillOrphaned },
      'Positions left open from a previous run could not be re-attached (Raydium - pool keys are not persisted across restarts) - they remain "open" in the DB. Close manually via the dashboard if needed.',
    );
  }

  if (PRE_LOAD_EXISTING_MARKETS) {
    await marketCache.init({ quoteToken });
  }

  // ---- shared detection pipeline (used by both venues) ----

  async function runFilterMatchLoop(
    ctx: Pick<DetectionContext, 'detectedPoolId' | 'runFilterCheck'>,
    config: StrategyConfig,
    versionId: number,
  ): Promise<boolean> {
    if (config.filterCheckIntervalMs === 0 || config.filterCheckDurationMs === 0) {
      return true;
    }

    const timesToCheck = Math.max(1, Math.floor(config.filterCheckDurationMs / config.filterCheckIntervalMs));
    let matchCount = 0;

    for (let timesChecked = 0; timesChecked < timesToCheck; timesChecked++) {
      const results = await ctx.runFilterCheck();

      for (const r of results) {
        insertFilterResult({
          detectedPoolId: ctx.detectedPoolId,
          filterName: r.filterName,
          pass: r.ok,
          message: r.message,
          attemptNumber: timesChecked + 1,
          configVersionId: versionId,
          checkedAt: Date.now(),
        });
        broadcast('filter.result', { detectedPoolId: ctx.detectedPoolId, filterName: r.filterName, pass: r.ok, message: r.message });
      }

      const shouldBuy = results.length === 0 || results.every((r) => r.ok);

      if (shouldBuy) {
        matchCount++;
        if (matchCount >= config.consecutiveFilterMatches) return true;
      } else {
        matchCount = 0;
      }

      await sleep(config.filterCheckIntervalMs);
    }

    return false;
  }

  async function handleDetection(ctx: DetectionContext) {
    const { config, versionId } = getActiveConfig();
    updatePoolStatus(ctx.detectedPoolId, 'filtering');

    const passed = await runFilterMatchLoop(ctx, config, versionId);

    if (!passed) {
      updatePoolStatus(ctx.detectedPoolId, 'rejected');
      broadcast('pool.status', { id: ctx.detectedPoolId, status: 'rejected' });
      return;
    }

    updatePoolStatus(ctx.detectedPoolId, 'passed');
    broadcast('pool.status', { id: ctx.detectedPoolId, status: 'passed' });

    if (config.checkHolderConcentration) {
      const holderResult = await checkHolderConcentration(connection, ctx.baseMint, ctx.excludeFromConcentration, config);
      insertFilterResult({
        detectedPoolId: ctx.detectedPoolId,
        filterName: 'holderConcentration',
        pass: holderResult.ok,
        message: holderResult.message,
        attemptNumber: 1,
        configVersionId: versionId,
        checkedAt: Date.now(),
      });
      broadcast('filter.result', { detectedPoolId: ctx.detectedPoolId, filterName: 'holderConcentration', pass: holderResult.ok, message: holderResult.message });

      if (!holderResult.ok) {
        updatePoolStatus(ctx.detectedPoolId, 'rejected');
        broadcast('pool.status', { id: ctx.detectedPoolId, status: 'rejected' });
        return;
      }
    }

    if (config.checkInsiderConcentration) {
      const insiderResult = await checkInsiderConcentration(ctx.baseMint, config);
      insertFilterResult({
        detectedPoolId: ctx.detectedPoolId,
        filterName: 'insiderConcentration',
        pass: insiderResult.ok,
        message: insiderResult.message,
        attemptNumber: 1,
        configVersionId: versionId,
        checkedAt: Date.now(),
      });
      broadcast('filter.result', { detectedPoolId: ctx.detectedPoolId, filterName: 'insiderConcentration', pass: insiderResult.ok, message: insiderResult.message });

      if (!insiderResult.ok) {
        updatePoolStatus(ctx.detectedPoolId, 'rejected');
        broadcast('pool.status', { id: ctx.detectedPoolId, status: 'rejected' });
        return;
      }
    }

    if (config.momentumEnabled === false) {
      // Legacy/manual-test escape hatch: skip the watchlist and buy immediately, like before this increment.
      await executeBuy(ctx, config, versionId);
      return;
    }

    updatePoolStatus(ctx.detectedPoolId, 'watching');
    broadcast('pool.status', { id: ctx.detectedPoolId, status: 'watching' });
    // Deliberately nothing held in memory for this candidate - it may sit
    // watching for hours (momentumMaxAgeMinutes). watchlistMonitor polls DB
    // state and rebuilds a fresh PriceSource only at graduation time.
  }

  async function executeBuy(ctx: DetectionContext, config: StrategyConfig, versionId: number) {
    if (!ledger.canOpenPosition(config, ctx.baseMint)) {
      updatePoolStatus(ctx.detectedPoolId, 'skipped');
      broadcast('pool.status', { id: ctx.detectedPoolId, status: 'skipped' });
      return;
    }

    if (workerState !== 'running') {
      // PAUSE (or STOP, though nothing should be graduating then anyway) -
      // never buy while paused.
      updatePoolStatus(ctx.detectedPoolId, 'skipped');
      broadcast('pool.status', { id: ctx.detectedPoolId, status: 'skipped' });
      logger.debug({ detectedPoolId: ctx.detectedPoolId, workerState }, 'Buying paused - skipping');
      return;
    }

    if (config.autoBuyDelayMs > 0) await sleep(config.autoBuyDelayMs);

    const balance = ledger.getVirtualBalance(config);
    const quoteAmountUi = ledger.positionSizeQuote(config, balance);

    const outcome = await simulateBuy(ctx.priceSource, quoteAmountUi, config, versionId);
    for (const fill of outcome.fills) {
      fill.id = insertFill(fill);
    }
    const entryFeesQuote = totalFeesPaid(outcome.fills);

    if (!outcome.success || !outcome.finalFill) {
      // Real gas wars cost money even when they lose - the failed attempts still paid fees.
      ledger.chargeFees(config, entryFeesQuote);
      updatePoolStatus(ctx.detectedPoolId, 'skipped');
      broadcast('pool.status', { id: ctx.detectedPoolId, status: 'skipped' });
      logger.info({ detectedPoolId: ctx.detectedPoolId, source: ctx.source }, 'Simulated buy failed after retries (slippage), skipping');
      return;
    }

    updatePoolStatus(ctx.detectedPoolId, 'bought');
    broadcast('pool.status', { id: ctx.detectedPoolId, status: 'bought' });

    const baseAmountHeldUi = Number(outcome.finalFill.fillAmountOut) / 10 ** ctx.priceSource.baseDecimals;
    const openedAt = Date.now();
    // All-in cost basis: the trade amount plus every entry-attempt fee paid, including reverted retries.
    const allInQuoteSizeUi = quoteAmountUi + entryFeesQuote;

    // Best-effort - a brand-new mint may not be indexed by DexScreener yet,
    // in which case this stays null (never blocks the buy itself).
    let tokenName: string | null = null;
    let entryMarketCapUsd: number | null = null;
    try {
      const pairs = await getTokensBatch('solana', [ctx.baseMint]);
      const pair = pairs.get(ctx.baseMint);
      tokenName = pair?.baseToken?.name ?? null;
      entryMarketCapUsd = pair?.marketCap ?? pair?.fdv ?? null;
    } catch (error) {
      logger.debug({ baseMint: ctx.baseMint, error: String(error) }, 'DexScreener entry snapshot failed, continuing without it');
    }

    const positionId = ledger.openPosition({
      detectedPoolId: ctx.detectedPoolId,
      baseMint: ctx.baseMint,
      entryFillId: outcome.finalFill.id!,
      quoteSizeInUi: allInQuoteSizeUi,
      baseAmountHeldUi,
      entryPrice: outcome.finalFill.fillExecutionPrice!,
      config,
      configVersionId: versionId,
      openedAt,
      source: ctx.source,
      tokenName,
      entryMarketCapUsd,
    });

    positionMonitor.track({
      positionId,
      priceSource: ctx.priceSource,
      baseMint: ctx.baseMint,
      quoteSizeInUi: allInQuoteSizeUi,
      baseAmountHeldUi,
      openedAt,
      peakProfitPct: PEAK_PROFIT_UNSET,
      originalBaseAmountHeldUi: baseAmountHeldUi,
      originalQuoteSizeInUi: allInQuoteSizeUi,
      targetsFired: new Set(),
      riskParams: resolveRiskParams(config, ctx.source),
    });

    broadcast('position.opened', { positionId, baseMint: ctx.baseMint, quoteSizeInUi: allInQuoteSizeUi });
    logger.info(
      { positionId, baseMint: ctx.baseMint, source: ctx.source, quoteAmountUi, entryFeesQuote },
      'Simulated buy filled, position opened',
    );

    void sendDiscordNotification(
      formatPositionOpenedMessage({
        baseMint: ctx.baseMint,
        tokenName,
        entryMarketCapUsd,
        source: ctx.source,
        quoteAmountUi: allInQuoteSizeUi,
        entryPrice: outcome.finalFill.fillExecutionPrice!,
        config,
      }),
    );

    void maybeRunAgent(broadcast);
  }

  // ---- momentum watchlist ----

  const watchlistMonitor = new WatchlistMonitor(getActiveConfig, broadcast, async (pool: DetectedPool) => {
    const { config, versionId } = getActiveConfig();
    try {
      const priceSource = await rebuildPriceSourceForPool(connection, quoteToken, pool);

      const ctx: DetectionContext = {
        detectedPoolId: pool.id,
        baseMint: pool.baseMint,
        source: pool.source,
        priceSource,
        runFilterCheck: async () => [],
        // Holder concentration already ran once at initial detection time
        // (handleDetection, before this candidate ever went on the
        // watchlist) - executeBuy doesn't re-check it, so this is unused here.
        excludeFromConcentration: [],
      };
      await executeBuy(ctx, config, versionId);
    } catch (error) {
      logger.error({ detectedPoolId: pool.id, error: String(error) }, 'Failed to graduate watchlist candidate to a buy');
      updatePoolStatus(pool.id, 'skipped');
      broadcast('pool.status', { id: pool.id, status: 'skipped' });
    }
  });

  // ---- Raydium AmmV4 listener ----

  const runTimestamp = Math.floor(Date.now() / 1000);
  const listeners = new Listeners(connection);

  listeners.on('market', (updatedAccountInfo: KeyedAccountInfo) => {
    const marketState = MARKET_STATE_LAYOUT_V3.decode(updatedAccountInfo.accountInfo.data);
    marketCache.save(updatedAccountInfo.accountId.toString(), marketState);
  });

  listeners.on('pool', async (updatedAccountInfo: KeyedAccountInfo) => {
    lastPoolEventAt = Date.now();
    try {
      const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(updatedAccountInfo.accountInfo.data);
      const poolOpenTime = parseInt(poolState.poolOpenTime.toString());
      const existing = await poolCache.get(poolState.baseMint.toString());

      if (existing || poolOpenTime <= runTimestamp) return;

      poolCache.save(updatedAccountInfo.accountId.toString(), poolState);

      const detectedPoolId = insertDetectedPool({
        poolId: updatedAccountInfo.accountId.toString(),
        baseMint: poolState.baseMint.toString(),
        quoteMint: poolState.quoteMint.toString(),
        lpMint: poolState.lpMint.toString(),
        marketId: poolState.marketId.toString(),
        baseDecimals: poolState.baseDecimal.toNumber(),
        quoteDecimals: poolState.quoteDecimal.toNumber(),
        poolOpenTime,
        detectedAt: Date.now(),
        status: 'pending',
        source: 'raydium',
      });
      broadcast('pool.detected', {
        id: detectedPoolId,
        baseMint: poolState.baseMint.toString(),
        detectedAt: Date.now(),
        source: 'raydium',
      });

      handleRaydiumPool(detectedPoolId, updatedAccountInfo.accountId.toString(), poolState).catch((error) =>
        logger.error({ detectedPoolId, error: String(error) }, 'handleRaydiumPool failed'),
      );
    } catch (error) {
      logger.error({ error: String(error) }, 'Failed to process pool update');
    }
  });

  async function handleRaydiumPool(detectedPoolId: number, accountId: string, poolState: any) {
    const { config } = getActiveConfig();
    const market = await marketCache.get(poolState.marketId.toString());
    const poolKeys = createPoolKeys(new PublicKey(accountId), poolState, market);
    const baseToken = new Token(TOKEN_PROGRAM_ID, poolKeys.baseMint, poolKeys.baseDecimals);
    const poolFilters = new PoolFilters(connection, quoteToken, config);

    await handleDetection({
      detectedPoolId,
      baseMint: poolKeys.baseMint.toString(),
      source: 'raydium',
      priceSource: createRaydiumPriceSource(connection, poolKeys, quoteToken, baseToken),
      runFilterCheck: () => poolFilters.execute(poolKeys),
      excludeFromConcentration: [poolKeys.authority],
    });
  }

  // ---- PumpSwap listener ----
  // onProgramAccountChange re-fires on every lp_supply change (deposits/
  // withdraws/trades against an EXISTING pool), not just creation - dedupe
  // by base mint before doing any DB/RPC work, same convention as
  // poolCache above.
  //
  // Two load-shedding guards, both confirmed necessary live: a fresh
  // connection immediately receives updates for hundreds of ALREADY-EXISTING
  // pools (PumpSwap does $16B/month - a live 45s sample saw 6120 matching
  // account updates), and unlike Raydium's pool account there's no
  // poolOpenTime-style field to tell "created before I started watching"
  // apart from "just traded". Without a guard, this "thundering herd" fires
  // a full filter+holder-concentration RPC pipeline for hundreds of pools
  // simultaneously at startup and 429s the RPC immediately (observed live).
  // 1) Startup grace window - ignore (but still mark seen) anything that
  //    shows up in the first 30s, mirroring Raydium's runTimestamp guard in
  //    spirit even though PumpSwap pools carry no equivalent timestamp field.
  // 2) A small concurrency cap on the detection pipeline itself, so even a
  //    later legitimate burst (many real graduations close together) can't
  //    fire unbounded concurrent RPC calls again.
  const pumpSwapSeenMints = new Set<string>();
  const pumpSwapStartupGraceUntil = Date.now() + 30_000;
  const PUMPSWAP_MAX_CONCURRENT = 2;
  let pumpSwapInFlight = 0;
  const pumpSwapQueue: PumpSwapPool[] = [];

  function runNextPumpSwapTask() {
    const pool = pumpSwapQueue.shift();
    if (!pool) return;
    pumpSwapInFlight++;
    handlePumpSwapPool(pool)
      .catch((error) => logger.error({ baseMint: pool.baseMint.toString(), error: String(error) }, 'handlePumpSwapPool failed'))
      .finally(() => {
        pumpSwapInFlight--;
        runNextPumpSwapTask();
      });
  }

  listeners.on('pumpswapPool', (updatedAccountInfo: KeyedAccountInfo) => {
    lastPoolEventAt = Date.now();
    try {
      const poolAddress = updatedAccountInfo.accountId;
      const pool = decodePoolAccount(poolAddress, updatedAccountInfo.accountInfo.data);
      const baseMintStr = pool.baseMint.toString();

      if (pumpSwapSeenMints.has(baseMintStr)) return;
      pumpSwapSeenMints.add(baseMintStr);

      if (Date.now() < pumpSwapStartupGraceUntil) return; // looks pre-existing, not newly created

      pumpSwapQueue.push(pool);
      if (pumpSwapInFlight < PUMPSWAP_MAX_CONCURRENT) runNextPumpSwapTask();
    } catch (error) {
      logger.debug({ error: String(error) }, 'Failed to decode a PumpSwap program account update (likely not a Pool account)');
    }
  });

  async function handlePumpSwapPool(pool: PumpSwapPool) {
    const { config } = getActiveConfig();

    // Base decimals aren't on the Pool struct - one cheap mint-account read,
    // same MintLayout technique already proven in holderConcentrationFilter.ts
    // (works for Token-2022 mints too, the base 82-byte layout is unaffected
    // by TLV extensions appended after it).
    const mintAccountInfo = await connection.getAccountInfo(pool.baseMint);
    if (!mintAccountInfo?.data) {
      logger.debug({ baseMint: pool.baseMint.toString() }, 'PumpSwap: could not fetch base mint account, skipping');
      return;
    }
    const baseDecimals = MintLayout.decode(mintAccountInfo.data).decimals;

    const detectedPoolId = insertDetectedPool({
      poolId: pool.poolAddress.toString(),
      baseMint: pool.baseMint.toString(),
      quoteMint: pool.quoteMint.toString(),
      lpMint: pool.lpMint.toString(),
      marketId: '', // not applicable - PumpSwap has no OpenBook market
      baseDecimals,
      quoteDecimals: NATIVE_SOL_DECIMALS,
      poolOpenTime: Math.floor(Date.now() / 1000),
      detectedAt: Date.now(),
      status: 'pending',
      source: 'pumpswap',
    });
    broadcast('pool.detected', {
      id: detectedPoolId,
      baseMint: pool.baseMint.toString(),
      detectedAt: Date.now(),
      source: 'pumpswap',
    });

    // REVERTED (2026-08-17): tried a pre-gate here using Raydium's
    // minPoolSizeQuote/maxPoolSizeQuote (5-50 SOL) to save RPC cost on
    // holder/insider concentration for obviously tiny/oversized pools.
    // Wrong assumption - confirmed live within 3 hours it rejected 63% of
    // ALL PumpSwap candidates (1033/1646) as "too big", because a PumpSwap
    // pool is typically POST pump.fun-migration and routinely carries
    // hundreds to thousands of SOL in liquidity from the start (observed
    // median of the rejected set: 121 SOL, p90: 543 SOL) - nothing like a
    // fresh small Raydium listing those thresholds were tuned for. This
    // silently starved the whole pipeline of real candidates. Removed
    // entirely rather than guessing a new PumpSwap-specific threshold with
    // no real distribution data yet - revisit once
    // lib/agent/runnerReview.ts has accumulated enough bought-runner
    // pool-size samples to calibrate one properly.

    const pumpSwapFilters = new PumpSwapFilters(connection, config);

    await handleDetection({
      detectedPoolId,
      baseMint: pool.baseMint.toString(),
      source: 'pumpswap',
      priceSource: createPumpSwapPriceSource(connection, pool, baseDecimals, NATIVE_SOL_DECIMALS),
      runFilterCheck: () => pumpSwapFilters.execute(pool.baseMint),
      // Confirmed live: the pool's vault token accounts are owned by the
      // Pool PDA itself (not a separate authority PDA the way Raydium's
      // poolKeys.authority is) - same shape as pump.fun's [curvePk].
      excludeFromConcentration: [pool.poolAddress],
    });
  }

  // ---- pump.fun (pre-migration) creation listener ----
  // Off by default (config.pumpfunPremigrationEnabled) until live-verified
  // against a working RPC connection - see lib/pumpfun/createEventDecoder.ts
  // for the discriminator/field-order source. Deliberately does NOT go
  // through the shared handleDetection() (which would tie its watchlist
  // decision to the unrelated general momentumEnabled escape hatch) - this
  // cohort always uses its own dedicated watchlist
  // (premigrationWatchlistMonitor) once it's enabled at all.
  const pumpFunListener = new PumpFunListener(connection);
  const pumpFunSeenMints = new Set<string>();

  pumpFunListener.on('creation', (event) => {
    lastPoolEventAt = Date.now();

    // Creator-launch tracking - deliberately independent of
    // pumpfunPremigrationEnabled below (a pure watch/alert feature, never
    // trades) and of the seen-mints dedupe (every mint is only ever created
    // once, so there's nothing to dedupe against here).
    handleCreatorTracking(event).catch((error) =>
      logger.error({ mint: event.mint.toString(), error: String(error) }, 'handleCreatorTracking failed'),
    );

    const mintStr = event.mint.toString();
    if (pumpFunSeenMints.has(mintStr)) return;
    pumpFunSeenMints.add(mintStr);

    handlePumpFunCreation(event).catch((error) =>
      logger.error({ mint: mintStr, error: String(error) }, 'handlePumpFunCreation failed'),
    );
  });

  async function handleCreatorTracking(event: PumpFunCreateEvent) {
    const { config } = getActiveConfig();
    if (config.trackedCreators.length === 0) return;

    const creatorStr = event.creator.toString();
    if (!config.trackedCreators.includes(creatorStr)) return;

    const launch = {
      creatorAddress: creatorStr,
      mint: event.mint.toString(),
      name: event.name,
      symbol: event.symbol,
      detectedAt: Date.now(),
    };
    const id = insertCreatorLaunch(launch);
    logger.info({ creator: creatorStr, mint: launch.mint, name: launch.name, symbol: launch.symbol }, 'Tracked creator launched a new token');
    broadcast('creator.launch', { ...launch, id });
    sendDiscordNotification(
      [
        `🆕 **Figyelt tárca új tokent hozott létre**`,
        `Creator: \`${creatorStr}\``,
        `Token: **${launch.name}** (${launch.symbol})`,
        `Mint: \`${launch.mint}\``,
      ].join('\n'),
    ).catch(() => {}); // sendDiscordNotification already never throws; belt-and-suspenders
  }

  async function handlePumpFunCreation(event: PumpFunCreateEvent) {
    const { config, versionId } = getActiveConfig();
    if (!config.pumpfunPremigrationEnabled) return;

    const detectedPoolId = insertDetectedPool({
      poolId: event.bondingCurve.toString(),
      baseMint: event.mint.toString(),
      quoteMint: 'So11111111111111111111111111111111111111112',
      lpMint: '', // not applicable - pre-migration, no LP mint yet
      marketId: '', // not applicable - no OpenBook market
      baseDecimals: PUMPFUN_TOKEN_DECIMALS,
      quoteDecimals: NATIVE_SOL_DECIMALS,
      poolOpenTime: Math.floor(event.timestamp / 1000),
      detectedAt: Date.now(),
      status: 'pending',
      source: 'pumpfun',
    });
    broadcast('pool.detected', {
      id: detectedPoolId,
      baseMint: event.mint.toString(),
      detectedAt: Date.now(),
      source: 'pumpfun',
    });

    updatePoolStatus(detectedPoolId, 'filtering');
    const pumpFunFilters = new PumpFunFilters(connection, config);
    const passed = await runFilterMatchLoop(
      { detectedPoolId, runFilterCheck: () => pumpFunFilters.execute(event.mint) },
      config,
      versionId,
    );

    if (!passed) {
      updatePoolStatus(detectedPoolId, 'rejected');
      broadcast('pool.status', { id: detectedPoolId, status: 'rejected' });
      return;
    }

    updatePoolStatus(detectedPoolId, 'passed');
    broadcast('pool.status', { id: detectedPoolId, status: 'passed' });

    if (config.checkHolderConcentration) {
      // Confirmed live convention for pump.fun (see reattach/priceSource
      // code elsewhere in this file): the associated bonding-curve token
      // account is owned by the bonding-curve PDA itself.
      const holderResult = await checkHolderConcentration(connection, event.mint.toString(), [event.bondingCurve], config);
      insertFilterResult({
        detectedPoolId,
        filterName: 'holderConcentration',
        pass: holderResult.ok,
        message: holderResult.message,
        attemptNumber: 1,
        configVersionId: versionId,
        checkedAt: Date.now(),
      });
      broadcast('filter.result', { detectedPoolId, filterName: 'holderConcentration', pass: holderResult.ok, message: holderResult.message });

      if (!holderResult.ok) {
        updatePoolStatus(detectedPoolId, 'rejected');
        broadcast('pool.status', { id: detectedPoolId, status: 'rejected' });
        return;
      }
    }

    if (config.checkInsiderConcentration) {
      const insiderResult = await checkInsiderConcentration(event.mint.toString(), config);
      insertFilterResult({
        detectedPoolId,
        filterName: 'insiderConcentration',
        pass: insiderResult.ok,
        message: insiderResult.message,
        attemptNumber: 1,
        configVersionId: versionId,
        checkedAt: Date.now(),
      });
      broadcast('filter.result', { detectedPoolId, filterName: 'insiderConcentration', pass: insiderResult.ok, message: insiderResult.message });

      if (!insiderResult.ok) {
        updatePoolStatus(detectedPoolId, 'rejected');
        broadcast('pool.status', { id: detectedPoolId, status: 'rejected' });
        return;
      }
    }

    updatePoolStatus(detectedPoolId, 'watching');
    broadcast('pool.status', { id: detectedPoolId, status: 'watching' });
  }

  const premigrationWatchlistMonitor = new PremigrationWatchlistMonitor(connection, getActiveConfig, broadcast, async (pool: DetectedPool) => {
    const { config, versionId } = getActiveConfig();
    try {
      const priceSource = await rebuildPriceSourceForPool(connection, quoteToken, pool);
      const ctx: DetectionContext = {
        detectedPoolId: pool.id,
        baseMint: pool.baseMint,
        source: pool.source,
        priceSource,
        runFilterCheck: async () => [],
        excludeFromConcentration: [],
      };
      await executeBuy(ctx, config, versionId);
    } catch (error) {
      logger.error({ detectedPoolId: pool.id, error: String(error) }, 'Failed to graduate premigration watchlist candidate to a buy');
      updatePoolStatus(pool.id, 'skipped');
      broadcast('pool.status', { id: pool.id, status: 'skipped' });
    }
  });

  // ---- start everything (unless a previous run left it STOPPED) ----
  //
  // Split into two independently-lifecycled halves, because PAUSE and STOP
  // now mean different things: PAUSE stops everything that *discovers* new
  // work (chain listeners, watchlist/premigration polling, the wallet
  // tracker's Helius Enhanced-Transactions polling) - the part that
  // actually burns RPC/Helius credits continuously - while STILL managing
  // any already-open positions (their stop-loss/take-profit still needs to
  // run; this is paper trading so the "risk" of pausing that too would only
  // ever be simulated P&L, but there's no reason to give that up for free).
  // STOP additionally halts position management too - the harder, full halt.

  async function startDiscovery() {
    lastPoolEventAt = Date.now(); // avoid an immediate false-positive stale reading before the first post-(re)start event arrives
    await listeners.start({ quoteToken, cacheNewMarkets: CACHE_NEW_MARKETS });
    pumpFunListener.start(COMMITMENT_LEVEL);
    watchlistMonitor.start();
    premigrationWatchlistMonitor.start();
    walletWatcher.start();
    burnWatcher.start();
  }

  async function stopDiscovery() {
    watchlistMonitor.stop();
    premigrationWatchlistMonitor.stop();
    walletWatcher.stop();
    burnWatcher.stop();
    await listeners.stop();
    await pumpFunListener.stop();
  }

  if (workerState === 'stopped') {
    logger.warn({}, 'Starting in STOPPED state (persisted from a previous run) - not watching the chain. Use START on the dashboard to resume.');
  } else {
    positionMonitor.start();
    if (workerState === 'running') {
      await startDiscovery();
    } else {
      logger.warn({}, 'Starting in PAUSED state (persisted from a previous run) - managing existing positions only, not discovering new pools/wallets. Use START on the dashboard to resume discovery.');
    }
  }

  // ---- config hot-reload poll ----
  setInterval(() => {
    const activeId = getMeta('active_config_version_id');
    if (activeId && Number(activeId) !== activeVersion.id) {
      activeVersion = getActiveConfigVersion();
      logger.info({ versionId: activeVersion.id }, 'Strategy config hot-reloaded');
    }
  }, 7000);

  // ---- dashboard control poll (PAUSE/START/STOP/SELL ALL) ----
  setInterval(async () => {
    const desired = getWorkerControlState();
    if (desired !== workerState) {
      try {
        if (desired === 'stopped') {
          if (workerState === 'running') await stopDiscovery();
          positionMonitor.stop();
          logger.info({}, 'Worker STOPPED via dashboard control');
        } else if (desired === 'running' && workerState === 'stopped') {
          positionMonitor.start();
          await startDiscovery();
          logger.info({}, 'Worker STARTED via dashboard control');
        } else if (desired === 'running' && workerState === 'paused') {
          await startDiscovery();
          logger.info({}, 'Worker RESUMED (unpaused) via dashboard control - discovery restarted');
        } else if (desired === 'paused' && workerState === 'stopped') {
          // No dashboard button reaches this directly (STOP only leads to
          // START), but handle it safely in case control state is ever set
          // this way some other way.
          positionMonitor.start();
          logger.info({}, 'Worker PAUSED via dashboard control (from stopped) - managing existing positions only');
        } else if (desired === 'paused') {
          await stopDiscovery();
          logger.info({}, 'Worker PAUSED via dashboard control - discovery stopped (saves RPC/Helius usage), still managing open positions');
        }
        workerState = desired;
        broadcast('worker.state', { state: workerState });
      } catch (error) {
        logger.error({ error: String(error), desired }, 'Failed to apply dashboard control state change');
      }
    }

    const sellAllAt = getSellAllRequestedAt();
    if (sellAllAt > lastProcessedSellAllAt) {
      const result = await positionMonitor.forceCloseAll();
      if (result.skipped === 0) {
        lastProcessedSellAllAt = sellAllAt;
        logger.info({ closed: result.closed }, 'SELL ALL executed via dashboard control');
        broadcast('worker.sellAll', { closed: result.closed });
      }
    }
  }, 2000);

  // ---- optional Turso sync (public read-only dashboard, see README.md) ----
  // No timer at all is created unless TURSO_DATABASE_URL is set - a user who
  // never sets it up sees zero behavior change here.
  if (tursoSyncEnabled()) {
    logger.info({}, 'Turso sync enabled - mirroring a bounded recent window to Turso every 20s for the public dashboard');
    setInterval(() => {
      runTursoSync().catch((error) => logger.warn({ error: String(error) }, 'tursoSync tick failed, will retry next tick'));
    }, 20_000);
  }

  // ---- runner review (lib/agent/runnerReview.ts) ----
  // Own interval, independent of the trade-count-triggered maybeRunAgent
  // call above - checks its own last-run meta timestamp against
  // runnerReviewIntervalMs internally, so this poll can run often (1min)
  // without spamming DexScreener; runnerReviewEnabled=false in the active
  // config makes every tick here a no-op.
  setInterval(() => {
    maybeRunRunnerReview(broadcast).catch((error) => logger.warn({ error: String(error) }, 'Runner review tick failed, will retry next tick'));
  }, 60_000);

  // ---- heartbeat ----
  // Reports actual pipeline liveness (last real pool event, last completed
  // position-monitor tick), not just "the setInterval itself is still
  // running" - that distinction is exactly what let the worker sit fully
  // stalled for 15.8h while this same heartbeat kept ticking and the
  // dashboard kept showing "Worker alive".
  setInterval(() => {
    const now = Date.now();
    setMeta('last_heartbeat_at', String(now));
    broadcast('worker.heartbeat', {
      ts: now,
      rpcLabel: RPC_ENDPOINT,
      lastPoolEventAt,
      lastPositionTickCompletedAt: positionMonitor.getLastTickCompletedAt(),
      trackedPositions: positionMonitor.trackedCount(),
      workerState,
    });
  }, 10_000);

  // ---- watchdog: detect a silently-dead listener subscription and try to
  // recover in-place by resubscribing. Only meaningful while we're supposed
  // to be watching at all (skip during a deliberate STOP). This can't fully
  // guarantee recovery if the underlying WS client itself is wedged (a known
  // @solana/web3.js rough edge), but resubscribing is cheap to attempt and,
  // per the fresh 10s heartbeat log line either way, at minimum turns a
  // silent 15+ hour blind spot into a loud one within ~5 minutes.
  setInterval(async () => {
    if (workerState === 'stopped') return;
    const staleMs = Date.now() - lastPoolEventAt;
    if (staleMs < POOL_EVENT_STALE_MS) return;

    logger.error(
      { staleMs, staleMinutes: (staleMs / 60_000).toFixed(1) },
      'WATCHDOG: no pool/pumpswapPool events received in over 5 minutes - the listener subscription looks dead. Attempting to resubscribe.',
    );
    broadcast('worker.watchdogAlert', { staleMs, action: 'resubscribing' });

    try {
      await listeners.stop();
      await listeners.start({ quoteToken, cacheNewMarkets: CACHE_NEW_MARKETS });
      lastPoolEventAt = Date.now();
      logger.info({}, 'WATCHDOG: resubscribed to pool listeners');
    } catch (error) {
      logger.error({ error: String(error) }, 'WATCHDOG: resubscribe attempt failed - manual worker restart likely needed');
    }
  }, WATCHDOG_INTERVAL_MS);

  logger.info(
    {
      quoteToken: quoteToken.symbol,
      commitment: COMMITMENT_LEVEL,
      wsPort: WORKER_WS_PORT,
    },
    'Worker is running (paper trading only). Press CTRL+C to stop.',
  );

  process.on('SIGINT', async () => {
    logger.info({}, 'Shutting down...');
    positionMonitor.stop();
    await stopDiscovery();
    wsServer.close();
    process.exit(0);
  });
}

main().catch((error) => {
  logger.error({ error: String(error) }, 'Worker crashed');
  process.exit(1);
});
