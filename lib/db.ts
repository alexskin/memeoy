// Single shared better-sqlite3 connection (WAL mode) at .local-data/snipe.db.
// The worker process (writer) and Next.js API routes (readers, separate
// process) both open this same file - WAL allows that concurrency without a
// server. Every read/write in the app goes through the helpers below rather
// than raw SQL scattered around.
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { migrate } from '../scripts/migrate';
import { DEFAULT_STRATEGY_CONFIG, hydrateConfig } from './config/defaultConfig';
import {
  AgentDecision,
  AgentDecisionDetailed,
  AgentSuggestion,
  AgentSuggestionStatus,
  CreatorLaunch,
  DetectedPool,
  EquitySnapshot,
  FilterOutcome,
  MomentumSnapshot,
  PartialExit,
  Position,
  PositionStatus,
  PremigrationSnapshot,
  SimulatedFill,
  StrategyConfig,
  StrategyConfigVersion,
  WalletAlert,
} from './types';
import { Venue } from './priceSource/types';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dataDir = path.join(process.cwd(), '.local-data');
  fs.mkdirSync(dataDir, { recursive: true });
  _db = new Database(path.join(dataDir, 'snipe.db'));
  migrate(_db);
  seedConfigIfMissing(_db);
  return _db;
}

// ---------- meta ----------

export function getMeta(key: string): string | null {
  const row = getDb().prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string) {
  getDb()
    .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, value);
}

// ---------- worker control (dashboard PAUSE/START/STOP/SELL ALL buttons) ----------
// DB-mediated, same pattern as strategy-config hot-reload: the dashboard
// writes via a Next.js API route, the worker polls frequently and reacts.

export type WorkerControlState = 'running' | 'paused' | 'stopped';

export function getWorkerControlState(): WorkerControlState {
  const value = getMeta('worker_control_state');
  return value === 'paused' || value === 'stopped' ? value : 'running';
}

export function setWorkerControlState(state: WorkerControlState) {
  setMeta('worker_control_state', state);
}

// One-shot "sell everything now" trigger - a timestamp so the worker can
// tell a fresh request apart from one it already processed.
export function requestSellAll() {
  setMeta('sell_all_requested_at', String(Date.now()));
}

export function getSellAllRequestedAt(): number {
  return Number(getMeta('sell_all_requested_at') ?? 0);
}

// ---------- strategy config versions ----------

export function rowToConfigVersion(row: any): StrategyConfigVersion {
  return {
    id: row.id,
    versionNumber: row.version_number,
    createdAt: row.created_at,
    createdBy: row.created_by,
    parentVersionId: row.parent_version_id,
    applied: !!row.applied,
    config: hydrateConfig(JSON.parse(row.config_json)),
    rationale: row.rationale,
  };
}

function seedConfigIfMissing(db: Database.Database) {
  const existing = db.prepare(`SELECT COUNT(*) as n FROM strategy_config_versions`).get() as { n: number };
  if (existing.n > 0) return;

  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO strategy_config_versions (version_number, created_at, created_by, parent_version_id, applied, config_json, rationale)
       VALUES (1, ?, 'seed', NULL, 1, ?, 'Initial defaults, adapted from repo-reference/.env.copy')`,
    )
    .run(now, JSON.stringify(DEFAULT_STRATEGY_CONFIG));
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('active_config_version_id', ?)`).run(
    String(info.lastInsertRowid),
  );
}

export function getActiveConfigVersion(): StrategyConfigVersion {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM strategy_config_versions WHERE applied = 1 ORDER BY id DESC LIMIT 1`).get();
  if (!row) throw new Error('No applied strategy config version found - seeding must have failed');
  return rowToConfigVersion(row);
}

export function getConfigVersionHistory(limit = 50): StrategyConfigVersion[] {
  const rows = getDb()
    .prepare(`SELECT * FROM strategy_config_versions ORDER BY id DESC LIMIT ?`)
    .all(limit);
  return rows.map(rowToConfigVersion);
}

// Append-only: creates a new version row and (optionally) makes it active.
export function insertConfigVersion(
  config: StrategyConfig,
  createdBy: 'seed' | 'agent' | 'user',
  parentVersionId: number | null,
  rationale: string | null,
  apply: boolean,
): StrategyConfigVersion {
  const db = getDb();
  const maxVersion = db.prepare(`SELECT COALESCE(MAX(version_number), 0) as v FROM strategy_config_versions`).get() as {
    v: number;
  };
  const now = Date.now();

  const tx = db.transaction(() => {
    if (apply) {
      db.prepare(`UPDATE strategy_config_versions SET applied = 0 WHERE applied = 1`).run();
    }
    const info = db
      .prepare(
        `INSERT INTO strategy_config_versions (version_number, created_at, created_by, parent_version_id, applied, config_json, rationale)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(maxVersion.v + 1, now, createdBy, parentVersionId, apply ? 1 : 0, JSON.stringify(config), rationale);
    if (apply) {
      db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('active_config_version_id', ?)`).run(
        String(info.lastInsertRowid),
      );
    }
    return info.lastInsertRowid as number;
  });

  const id = tx();
  return rowToConfigVersion(db.prepare(`SELECT * FROM strategy_config_versions WHERE id = ?`).get(id));
}

export function applyConfigVersion(versionId: number) {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE strategy_config_versions SET applied = 0 WHERE applied = 1`).run();
    db.prepare(`UPDATE strategy_config_versions SET applied = 1 WHERE id = ?`).run(versionId);
    setMeta('active_config_version_id', String(versionId));
  });
  tx();
}

// ---------- detected pools ----------

export function insertDetectedPool(pool: Omit<DetectedPool, 'id'>): number {
  const info = getDb()
    .prepare(
      `INSERT OR IGNORE INTO detected_pools
       (pool_id, base_mint, quote_mint, lp_mint, market_id, base_decimals, quote_decimals, pool_open_time, detected_at, status, source)
       VALUES (@poolId, @baseMint, @quoteMint, @lpMint, @marketId, @baseDecimals, @quoteDecimals, @poolOpenTime, @detectedAt, @status, @source)`,
    )
    .run(pool);
  if (info.changes === 0) {
    const existing = getDb().prepare(`SELECT id FROM detected_pools WHERE pool_id = ?`).get(pool.poolId) as { id: number };
    return existing.id;
  }
  return info.lastInsertRowid as number;
}

export function updatePoolStatus(id: number, status: DetectedPool['status']) {
  getDb().prepare(`UPDATE detected_pools SET status = ? WHERE id = ?`).run(status, id);
}

// Exported for reuse by lib/dbRead.ts's Turso branch - libSQL result rows
// expose columns as named properties the same way better-sqlite3 rows do,
// so these mapping functions work unchanged against either source.
export function rowToDetectedPool(row: any): DetectedPool {
  return {
    id: row.id,
    poolId: row.pool_id,
    baseMint: row.base_mint,
    quoteMint: row.quote_mint,
    lpMint: row.lp_mint,
    marketId: row.market_id,
    baseDecimals: row.base_decimals,
    quoteDecimals: row.quote_decimals,
    poolOpenTime: row.pool_open_time,
    detectedAt: row.detected_at,
    status: row.status,
    source: row.source,
  };
}

export function getRecentPools(limit = 100): DetectedPool[] {
  return getDb()
    .prepare(`SELECT * FROM detected_pools ORDER BY detected_at DESC LIMIT ?`)
    .all(limit)
    .map(rowToDetectedPool);
}

export function getDetectedPoolById(id: number): DetectedPool | null {
  const row = getDb().prepare(`SELECT * FROM detected_pools WHERE id = ?`).get(id);
  return row ? rowToDetectedPool(row) : null;
}

// For lib/agent/runnerReview.ts - every pool detected since sinceMs,
// regardless of current status (bought/skipped/rejected/still watching).
// Rows are never deleted on eviction/rejection (see watchlistMonitor.ts),
// so this stays a complete, queryable history.
export function getDetectedPoolsInWindow(sinceMs: number): DetectedPool[] {
  return getDb()
    .prepare(`SELECT * FROM detected_pools WHERE detected_at >= ? ORDER BY detected_at ASC`)
    .all(sinceMs)
    .map(rowToDetectedPool);
}

// Partitions the shared 'watching' status by source - the PumpSwap/Raydium
// momentum watchlist (DexScreener-driven) and the pump.fun premigration
// growth watchlist (RPC+RugCheck-driven) both park candidates in the same
// detected_pools.status='watching' state but are evaluated by two different
// monitors that must not double-process each other's candidates.
export function getWatchlistPoolsBySource(sources: Venue[]): DetectedPool[] {
  const placeholders = sources.map(() => '?').join(',');
  return getDb()
    .prepare(`SELECT * FROM detected_pools WHERE status = 'watching' AND source IN (${placeholders}) ORDER BY detected_at ASC`)
    .all(...sources)
    .map(rowToDetectedPool);
}

// ---------- momentum snapshots ----------

export function insertMomentumSnapshot(s: Omit<MomentumSnapshot, 'id'>): number {
  const info = getDb()
    .prepare(
      `INSERT INTO momentum_snapshots
       (detected_pool_id, checked_at, liquidity_usd, volume_24h_usd, buys_1h, buys_5m,
        price_change_1h_pct, price_change_24h_pct, pair_age_minutes, has_data, pass, criteria_json, config_version_id)
       VALUES
       (@detectedPoolId, @checkedAt, @liquidityUsd, @volume24hUsd, @buys1h, @buys5m,
        @priceChange1hPct, @priceChange24hPct, @pairAgeMinutes, @hasData, @pass, @criteriaJson, @configVersionId)`,
    )
    .run({
      detectedPoolId: s.detectedPoolId,
      checkedAt: s.checkedAt,
      liquidityUsd: s.liquidityUsd,
      volume24hUsd: s.volume24hUsd,
      buys1h: s.buys1h,
      buys5m: s.buys5m,
      priceChange1hPct: s.priceChange1hPct,
      priceChange24hPct: s.priceChange24hPct,
      pairAgeMinutes: s.pairAgeMinutes,
      hasData: s.hasData ? 1 : 0,
      pass: s.pass ? 1 : 0,
      criteriaJson: JSON.stringify(s.criteria),
      configVersionId: s.configVersionId,
    });
  return info.lastInsertRowid as number;
}

export function rowToMomentumSnapshot(row: any): MomentumSnapshot {
  return {
    id: row.id,
    detectedPoolId: row.detected_pool_id,
    checkedAt: row.checked_at,
    liquidityUsd: row.liquidity_usd,
    volume24hUsd: row.volume_24h_usd,
    buys1h: row.buys_1h,
    buys5m: row.buys_5m,
    priceChange1hPct: row.price_change_1h_pct,
    priceChange24hPct: row.price_change_24h_pct,
    pairAgeMinutes: row.pair_age_minutes,
    hasData: !!row.has_data,
    pass: !!row.pass,
    criteria: JSON.parse(row.criteria_json),
    configVersionId: row.config_version_id,
  };
}

export function getLatestMomentumSnapshot(detectedPoolId: number): MomentumSnapshot | null {
  const row = getDb()
    .prepare(`SELECT * FROM momentum_snapshots WHERE detected_pool_id = ? ORDER BY checked_at DESC LIMIT 1`)
    .get(detectedPoolId);
  return row ? rowToMomentumSnapshot(row) : null;
}

// For lib/agent/runnerReview.ts - the pool's condition when we FIRST saw it
// (liquidity/1h-buys/5m-buys/age), as opposed to getLatestMomentumSnapshot's
// most-recent reading - entry-time metrics are what a threshold tune should
// reason about, not whatever the last poll before eviction happened to see.
export function getEarliestMomentumSnapshotForPool(detectedPoolId: number): MomentumSnapshot | null {
  const row = getDb()
    .prepare(`SELECT * FROM momentum_snapshots WHERE detected_pool_id = ? ORDER BY checked_at ASC LIMIT 1`)
    .get(detectedPoolId);
  return row ? rowToMomentumSnapshot(row) : null;
}

export function getLatestMomentumSnapshotBeforeBuy(detectedPoolId: number, boughtAt: number): MomentumSnapshot | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM momentum_snapshots WHERE detected_pool_id = ? AND checked_at <= ? ORDER BY checked_at DESC LIMIT 1`,
    )
    .get(detectedPoolId, boughtAt);
  return row ? rowToMomentumSnapshot(row) : null;
}

// Counts how often a watchlist candidate failed the momentum gate for
// exactly one reason: minAge. If that's common, the age floor is filtering
// out otherwise-strong, genuinely-fresh momentum rather than protecting
// against anything - see heuristicTuner.ts Rule F.
export function getMinAgeOnlyRejectionStats(sinceTs: number): { totalEvaluated: number; minAgeOnlyRejections: number } {
  const rows = getDb()
    .prepare(`SELECT criteria_json, pass FROM momentum_snapshots WHERE checked_at >= ? AND has_data = 1`)
    .all(sinceTs) as { criteria_json: string; pass: number }[];

  let minAgeOnlyRejections = 0;
  for (const row of rows) {
    if (row.pass) continue;
    const criteria = JSON.parse(row.criteria_json) as { criterionName: string; ok: boolean }[];
    const failing = criteria.filter((c) => !c.ok);
    if (failing.length === 1 && failing[0].criterionName === 'minAge') {
      minAgeOnlyRejections++;
    }
  }
  return { totalEvaluated: rows.length, minAgeOnlyRejections };
}

// Compares how stop-loss-closed trades actually closed vs. their configured
// floor, and how many trades closed each way overall - see heuristicTuner.ts
// Rule G/H. A trade that stops out AT ~1x its configured stopLossPct is
// ordinary noise; one that closes at 2-3x its floor gapped straight through
// it (rug-pull-speed collapse the poll interval couldn't catch) - these two
// cases call for opposite fixes (widen the stop vs. tighten entry filters),
// so the tuner needs to tell them apart rather than treating every
// stop-loss close as "the stop is too tight."
export function getStopLossOvershootStats(sinceTs: number): {
  slCount: number;
  tpCount: number;
  slNetPnlQuote: number;
  avgOvershootRatio: number;
} {
  const rows = getDb()
    .prepare(
      `SELECT status, realized_pnl_pct, realized_pnl_quote, stop_loss_pct_snapshot FROM positions
       WHERE closed_at >= ? AND status IN ('closed_sl', 'closed_tp')`,
    )
    .all(sinceTs) as { status: string; realized_pnl_pct: number | null; realized_pnl_quote: number | null; stop_loss_pct_snapshot: number }[];

  let slCount = 0;
  let tpCount = 0;
  let slNetPnlQuote = 0;
  const overshootRatios: number[] = [];

  for (const row of rows) {
    if (row.status === 'closed_tp') {
      tpCount++;
      continue;
    }
    slCount++;
    slNetPnlQuote += row.realized_pnl_quote ?? 0;
    if (row.stop_loss_pct_snapshot > 0 && row.realized_pnl_pct != null) {
      overshootRatios.push(Math.abs(row.realized_pnl_pct) / row.stop_loss_pct_snapshot);
    }
  }

  const avgOvershootRatio = overshootRatios.length > 0 ? overshootRatios.reduce((a, b) => a + b, 0) / overshootRatios.length : 0;
  return { slCount, tpCount, slNetPnlQuote, avgOvershootRatio };
}

// ---------- agent decisions (lib/agent/decisionEngine.ts) ----------
// One row per candidate that reached the judgment step, whether bought or
// skipped - the "REFUSED with a reason" log, same style/timing as
// momentum_snapshots above but written once per candidate (at the judgment
// moment) rather than on every watchlist tick.

export function insertAgentDecision(d: Omit<AgentDecision, 'id'>): number {
  const info = getDb()
    .prepare(
      `INSERT INTO agent_decisions
       (detected_pool_id, checked_at, momentum_pass, revival_pass, revival_strength, degen_score, degen_verdict,
        action, confidence, reasoning, source, config_version_id)
       VALUES
       (@detectedPoolId, @checkedAt, @momentumPass, @revivalPass, @revivalStrength, @degenScore, @degenVerdict,
        @action, @confidence, @reasoning, @source, @configVersionId)`,
    )
    .run({
      detectedPoolId: d.detectedPoolId,
      checkedAt: d.checkedAt,
      momentumPass: d.momentumPass ? 1 : 0,
      revivalPass: d.revivalPass ? 1 : 0,
      revivalStrength: d.revivalStrength,
      degenScore: d.degenScore,
      degenVerdict: d.degenVerdict,
      action: d.action,
      confidence: d.confidence,
      reasoning: d.reasoning,
      source: d.source,
      configVersionId: d.configVersionId,
    });
  return info.lastInsertRowid as number;
}

export function rowToAgentDecision(row: any): AgentDecision {
  return {
    id: row.id,
    detectedPoolId: row.detected_pool_id,
    checkedAt: row.checked_at,
    momentumPass: !!row.momentum_pass,
    revivalPass: !!row.revival_pass,
    revivalStrength: row.revival_strength,
    degenScore: row.degen_score,
    degenVerdict: row.degen_verdict,
    action: row.action,
    confidence: row.confidence,
    reasoning: row.reasoning,
    source: row.source,
    configVersionId: row.config_version_id,
  };
}

export function getRecentAgentDecisions(limit = 100): AgentDecision[] {
  return getDb().prepare(`SELECT * FROM agent_decisions ORDER BY id DESC LIMIT ?`).all(limit).map(rowToAgentDecision);
}

// Same rows as getRecentAgentDecisions, joined with the parent pool's
// base_mint/source - agent_decisions itself doesn't carry those, and the
// standalone decision-log panel (unlike WatcherTable, which already has the
// pool loaded) needs to say which token was judged.
export function getRecentAgentDecisionsDetailed(limit = 100): AgentDecisionDetailed[] {
  return getDb()
    .prepare(
      `SELECT ad.*, dp.base_mint AS base_mint, dp.source AS venue
       FROM agent_decisions ad JOIN detected_pools dp ON dp.id = ad.detected_pool_id
       ORDER BY ad.id DESC LIMIT ?`,
    )
    .all(limit)
    .map((row: any) => ({ ...rowToAgentDecision(row), baseMint: row.base_mint, venue: row.venue }));
}

// "What's the latest verdict on this pool right now" - unlike
// getLatestAgentDecisionBeforeBuy (which anchors to a buy timestamp for the
// stats/learning join), this has no time constraint - used by the dashboard
// (app/api/pools/route.ts) to show a pool's current decision regardless of
// whether it ever led to a buy.
export function getLatestAgentDecisionForPool(detectedPoolId: number): AgentDecision | null {
  const row = getDb()
    .prepare(`SELECT * FROM agent_decisions WHERE detected_pool_id = ? ORDER BY checked_at DESC LIMIT 1`)
    .get(detectedPoolId);
  return row ? rowToAgentDecision(row) : null;
}

export function getLatestAgentDecisionBeforeBuy(detectedPoolId: number, boughtAt: number): AgentDecision | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM agent_decisions WHERE detected_pool_id = ? AND checked_at <= ? ORDER BY checked_at DESC LIMIT 1`,
    )
    .get(detectedPoolId, boughtAt);
  return row ? rowToAgentDecision(row) : null;
}

// ---------- premigration snapshots ----------

export function insertPremigrationSnapshot(s: Omit<PremigrationSnapshot, 'id'>): number {
  const info = getDb()
    .prepare(
      `INSERT INTO premigration_snapshots
       (detected_pool_id, checked_at, market_cap_usd, dev_holding_pct, insider_pct, top10_holders_pct,
        age_minutes, has_data, pass, criteria_json, config_version_id)
       VALUES
       (@detectedPoolId, @checkedAt, @marketCapUsd, @devHoldingPct, @insiderPct, @top10HoldersPct,
        @ageMinutes, @hasData, @pass, @criteriaJson, @configVersionId)`,
    )
    .run({
      detectedPoolId: s.detectedPoolId,
      checkedAt: s.checkedAt,
      marketCapUsd: s.marketCapUsd,
      devHoldingPct: s.devHoldingPct,
      insiderPct: s.insiderPct,
      top10HoldersPct: s.top10HoldersPct,
      ageMinutes: s.ageMinutes,
      hasData: s.hasData ? 1 : 0,
      pass: s.pass ? 1 : 0,
      criteriaJson: JSON.stringify(s.criteria),
      configVersionId: s.configVersionId,
    });
  return info.lastInsertRowid as number;
}

function rowToPremigrationSnapshot(row: any): PremigrationSnapshot {
  return {
    id: row.id,
    detectedPoolId: row.detected_pool_id,
    checkedAt: row.checked_at,
    marketCapUsd: row.market_cap_usd,
    devHoldingPct: row.dev_holding_pct,
    insiderPct: row.insider_pct,
    top10HoldersPct: row.top10_holders_pct,
    ageMinutes: row.age_minutes,
    hasData: !!row.has_data,
    pass: !!row.pass,
    criteria: JSON.parse(row.criteria_json),
    configVersionId: row.config_version_id,
  };
}

export function getLatestPremigrationSnapshot(detectedPoolId: number): PremigrationSnapshot | null {
  const row = getDb()
    .prepare(`SELECT * FROM premigration_snapshots WHERE detected_pool_id = ? ORDER BY checked_at DESC LIMIT 1`)
    .get(detectedPoolId);
  return row ? rowToPremigrationSnapshot(row) : null;
}

export function getFirstPremigrationSnapshot(detectedPoolId: number): PremigrationSnapshot | null {
  const row = getDb()
    .prepare(`SELECT * FROM premigration_snapshots WHERE detected_pool_id = ? ORDER BY checked_at ASC LIMIT 1`)
    .get(detectedPoolId);
  return row ? rowToPremigrationSnapshot(row) : null;
}

export function getLatestPremigrationSnapshotBeforeBuy(detectedPoolId: number, boughtAt: number): PremigrationSnapshot | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM premigration_snapshots WHERE detected_pool_id = ? AND checked_at <= ? ORDER BY checked_at DESC LIMIT 1`,
    )
    .get(detectedPoolId, boughtAt);
  return row ? rowToPremigrationSnapshot(row) : null;
}

export function rowToFilterOutcome(row: any): FilterOutcome {
  return {
    detectedPoolId: row.detected_pool_id,
    filterName: row.filter_name,
    pass: !!row.pass,
    message: row.message ?? undefined,
    attemptNumber: row.attempt_number,
    configVersionId: row.config_version_id,
    checkedAt: row.checked_at,
  };
}

export function getPoolFilterResults(detectedPoolId: number): FilterOutcome[] {
  return getDb()
    .prepare(`SELECT * FROM filter_results WHERE detected_pool_id = ? ORDER BY checked_at ASC`)
    .all(detectedPoolId)
    .map(rowToFilterOutcome);
}

// ---------- filter results ----------

export function insertFilterResult(outcome: FilterOutcome) {
  getDb()
    .prepare(
      `INSERT INTO filter_results (detected_pool_id, filter_name, pass, message, attempt_number, config_version_id, checked_at)
       VALUES (@detectedPoolId, @filterName, @pass, @message, @attemptNumber, @configVersionId, @checkedAt)`,
    )
    .run({ ...outcome, pass: outcome.pass ? 1 : 0, message: outcome.message ?? null });
}

// ---------- fills ----------

export function insertFill(fill: SimulatedFill): number {
  const info = getDb()
    .prepare(
      `INSERT INTO fills
       (position_id, side, attempt_number, execution_mode, decision_at, decision_mid_price, decision_amount_in,
        modeled_latency_ms, actual_elapsed_ms, fill_at, fill_mid_price, fill_execution_price, fill_amount_out,
        latency_drift_pct, price_impact_pct, total_slippage_pct, slippage_tolerance_pct, outcome, config_version_id, fee_quote)
       VALUES
       (@positionId, @side, @attemptNumber, @executionMode, @decisionAt, @decisionMidPrice, @decisionAmountIn,
        @modeledLatencyMs, @actualElapsedMs, @fillAt, @fillMidPrice, @fillExecutionPrice, @fillAmountOut,
        @latencyDriftPct, @priceImpactPct, @totalSlippagePct, @slippageTolerancePct, @outcome, @configVersionId, @feeQuote)`,
    )
    .run(fill as any);
  return info.lastInsertRowid as number;
}

export function setFillPositionId(fillId: number, positionId: number) {
  getDb().prepare(`UPDATE fills SET position_id = ? WHERE id = ?`).run(positionId, fillId);
}

export function rowToFill(row: any): SimulatedFill {
  return {
    id: row.id,
    positionId: row.position_id,
    side: row.side,
    attemptNumber: row.attempt_number,
    executionMode: row.execution_mode,
    decisionAt: row.decision_at,
    decisionMidPrice: row.decision_mid_price,
    decisionAmountIn: row.decision_amount_in,
    modeledLatencyMs: row.modeled_latency_ms,
    actualElapsedMs: row.actual_elapsed_ms,
    fillAt: row.fill_at,
    fillMidPrice: row.fill_mid_price,
    fillExecutionPrice: row.fill_execution_price,
    fillAmountOut: row.fill_amount_out,
    latencyDriftPct: row.latency_drift_pct,
    priceImpactPct: row.price_impact_pct,
    totalSlippagePct: row.total_slippage_pct,
    slippageTolerancePct: row.slippage_tolerance_pct,
    outcome: row.outcome,
    configVersionId: row.config_version_id,
    feeQuote: row.fee_quote,
  };
}

export function getFillById(id: number | null): SimulatedFill | null {
  if (id === null) return null;
  const row = getDb().prepare(`SELECT * FROM fills WHERE id = ?`).get(id);
  return row ? rowToFill(row) : null;
}

export function getFillsForPosition(positionId: number): SimulatedFill[] {
  return getDb()
    .prepare(`SELECT * FROM fills WHERE position_id = ? ORDER BY id ASC`)
    .all(positionId)
    .map(rowToFill);
}

// ---------- positions ----------

export function insertPosition(position: Omit<Position, 'id'>): number {
  const info = getDb()
    .prepare(
      `INSERT INTO positions
       (detected_pool_id, base_mint, status, entry_fill_id, exit_fill_id, quote_size_in, base_amount_held,
        entry_price, exit_price, take_profit_pct_snapshot, stop_loss_pct_snapshot, realized_pnl_quote,
        realized_pnl_pct, opened_at, closed_at, config_version_id, source, peak_profit_pct,
        original_quote_size_in, original_base_amount_held, token_name, entry_market_cap_usd, exit_market_cap_usd,
        ai_exit_reasoning)
       VALUES
       (@detectedPoolId, @baseMint, @status, @entryFillId, @exitFillId, @quoteSizeIn, @baseAmountHeld,
        @entryPrice, @exitPrice, @takeProfitPctSnapshot, @stopLossPctSnapshot, @realizedPnlQuote,
        @realizedPnlPct, @openedAt, @closedAt, @configVersionId, @source, @peakProfitPct,
        @originalQuoteSizeIn, @originalBaseAmountHeld, @tokenName, @entryMarketCapUsd, @exitMarketCapUsd,
        @aiExitReasoning)`,
    )
    .run(position as any);
  return info.lastInsertRowid as number;
}

export function updatePositionPeak(id: number, peakProfitPct: number) {
  getDb().prepare(`UPDATE positions SET peak_profit_pct = ? WHERE id = ?`).run(peakProfitPct, id);
}

export function closePosition(
  id: number,
  status: PositionStatus,
  exitFillId: number,
  exitPrice: number,
  realizedPnlQuote: number,
  realizedPnlPct: number,
  closedAt: number,
  exitMarketCapUsd: number | null = null,
  aiExitReasoning: string | null = null,
) {
  getDb()
    .prepare(
      `UPDATE positions SET status = ?, exit_fill_id = ?, exit_price = ?, realized_pnl_quote = ?, realized_pnl_pct = ?, closed_at = ?, exit_market_cap_usd = ?, ai_exit_reasoning = ?
       WHERE id = ?`,
    )
    .run(status, exitFillId, exitPrice, realizedPnlQuote, realizedPnlPct, closedAt, exitMarketCapUsd, aiExitReasoning, id);
}

// Stamps only status/exit_fill_id/exit_price/closed_at (+ exit market cap) -
// used when a position is fully liquidated via partial exits, whose money
// already moved through applyPartialExit() calls (unlike closePosition()
// above, which also writes realized_pnl_quote/pct for a plain single-shot close).
export function finalizePosition(
  id: number,
  status: PositionStatus,
  exitFillId: number,
  exitPrice: number,
  closedAt: number,
  exitMarketCapUsd: number | null = null,
) {
  getDb()
    .prepare(`UPDATE positions SET status = ?, exit_fill_id = ?, exit_price = ?, closed_at = ?, exit_market_cap_usd = ? WHERE id = ?`)
    .run(status, exitFillId, exitPrice, closedAt, exitMarketCapUsd, id);
}

export function applyPartialExit(
  id: number,
  fields: { baseAmountHeld: number; quoteSizeIn: number; realizedPnlQuote: number; realizedPnlPct: number },
) {
  getDb()
    .prepare(
      `UPDATE positions SET base_amount_held = ?, quote_size_in = ?, realized_pnl_quote = ?, realized_pnl_pct = ? WHERE id = ?`,
    )
    .run(String(fields.baseAmountHeld), String(fields.quoteSizeIn), fields.realizedPnlQuote, fields.realizedPnlPct, id);
}

export function getPositionById(id: number): Position | null {
  const row = getDb().prepare(`SELECT * FROM positions WHERE id = ?`).get(id);
  return row ? rowToPosition(row) : null;
}

// For lib/agent/runnerReview.ts - "did we ever buy this pool, and how did it
// go" for a pool we're checking against fresh runner data. A pool can only
// ever produce at most one position (canOpenPosition in ledger.ts refuses a
// second open position in the same baseMint), so LIMIT 1 is exact, not a
// heuristic pick.
export function getPositionByDetectedPoolId(detectedPoolId: number): Position | null {
  const row = getDb().prepare(`SELECT * FROM positions WHERE detected_pool_id = ? ORDER BY id DESC LIMIT 1`).get(detectedPoolId);
  return row ? rowToPosition(row) : null;
}

export function insertPartialExit(exit: Omit<PartialExit, 'id'>): number {
  const info = getDb()
    .prepare(
      `INSERT INTO partial_exits
       (position_id, exit_fill_id, target_pct, sell_fraction_of_original, base_amount_sold,
        quote_size_in_portion, quote_received_ui, exit_price, realized_pnl_quote, realized_pnl_pct, reason, closed_at)
       VALUES
       (@positionId, @exitFillId, @targetPct, @sellFractionOfOriginal, @baseAmountSold,
        @quoteSizeInPortion, @quoteReceivedUi, @exitPrice, @realizedPnlQuote, @realizedPnlPct, @reason, @closedAt)`,
    )
    .run(exit as any);
  return info.lastInsertRowid as number;
}

export function rowToPartialExit(row: any): PartialExit {
  return {
    id: row.id,
    positionId: row.position_id,
    exitFillId: row.exit_fill_id,
    targetPct: row.target_pct,
    sellFractionOfOriginal: row.sell_fraction_of_original,
    baseAmountSold: row.base_amount_sold,
    quoteSizeInPortion: row.quote_size_in_portion,
    quoteReceivedUi: row.quote_received_ui,
    exitPrice: row.exit_price,
    realizedPnlQuote: row.realized_pnl_quote,
    realizedPnlPct: row.realized_pnl_pct,
    reason: row.reason,
    closedAt: row.closed_at,
  };
}

export function getPartialExitsForPosition(positionId: number): PartialExit[] {
  return getDb()
    .prepare(`SELECT * FROM partial_exits WHERE position_id = ? ORDER BY closed_at ASC`)
    .all(positionId)
    .map(rowToPartialExit);
}

export function rowToPosition(row: any): Position {
  return {
    id: row.id,
    detectedPoolId: row.detected_pool_id,
    baseMint: row.base_mint,
    status: row.status,
    entryFillId: row.entry_fill_id,
    exitFillId: row.exit_fill_id,
    quoteSizeIn: row.quote_size_in,
    baseAmountHeld: row.base_amount_held,
    entryPrice: row.entry_price,
    exitPrice: row.exit_price,
    takeProfitPctSnapshot: row.take_profit_pct_snapshot,
    stopLossPctSnapshot: row.stop_loss_pct_snapshot,
    realizedPnlQuote: row.realized_pnl_quote,
    realizedPnlPct: row.realized_pnl_pct,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    configVersionId: row.config_version_id,
    source: row.source,
    peakProfitPct: row.peak_profit_pct,
    originalQuoteSizeIn: String(row.original_quote_size_in),
    originalBaseAmountHeld: row.original_base_amount_held,
    tokenName: row.token_name ?? null,
    entryMarketCapUsd: row.entry_market_cap_usd ?? null,
    exitMarketCapUsd: row.exit_market_cap_usd ?? null,
    aiExitReasoning: row.ai_exit_reasoning ?? null,
  };
}

export function getOpenPositions(): Position[] {
  return getDb().prepare(`SELECT * FROM positions WHERE status = 'open' ORDER BY opened_at ASC`).all().map(rowToPosition);
}

export function getClosedPositions(limit = 200): Position[] {
  return getDb()
    .prepare(`SELECT * FROM positions WHERE status != 'open' ORDER BY closed_at DESC LIMIT ?`)
    .all(limit)
    .map(rowToPosition);
}

export function countClosedPositionsSince(ts: number): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) as n FROM positions WHERE status != 'open' AND closed_at >= ?`)
    .get(ts) as { n: number };
  return row.n;
}

// ---------- equity snapshots ----------

export function insertEquitySnapshot(snapshot: EquitySnapshot) {
  getDb()
    .prepare(
      `INSERT INTO equity_snapshots
       (ts, virtual_balance_quote, open_unrealized_quote, total_equity_quote, realized_pnl_cumulative, num_open_positions, num_closed_trades)
       VALUES (@ts, @virtualBalanceQuote, @openUnrealizedQuote, @totalEquityQuote, @realizedPnlCumulative, @numOpenPositions, @numClosedTrades)`,
    )
    .run(snapshot as any);
}

export function rowToEquitySnapshot(row: any): EquitySnapshot {
  return {
    ts: row.ts,
    virtualBalanceQuote: row.virtual_balance_quote,
    openUnrealizedQuote: row.open_unrealized_quote,
    totalEquityQuote: row.total_equity_quote,
    realizedPnlCumulative: row.realized_pnl_cumulative,
    numOpenPositions: row.num_open_positions,
    numClosedTrades: row.num_closed_trades,
  };
}

export function getEquitySnapshots(limit = 1000): EquitySnapshot[] {
  return getDb()
    .prepare(`SELECT * FROM equity_snapshots ORDER BY ts DESC LIMIT ?`)
    .all(limit)
    .reverse()
    .map(rowToEquitySnapshot);
}

// ---------- agent suggestions ----------

export function insertAgentSuggestion(s: Omit<AgentSuggestion, 'id'>): number {
  const info = getDb()
    .prepare(
      `INSERT INTO agent_suggestions (created_at, based_on_version_id, proposed_version_id, status, source, rationale, stats_snapshot_json, diff_json)
       VALUES (@createdAt, @basedOnVersionId, @proposedVersionId, @status, @source, @rationale, @statsSnapshotJson, @diffJson)`,
    )
    .run({
      createdAt: s.createdAt,
      basedOnVersionId: s.basedOnVersionId,
      proposedVersionId: s.proposedVersionId,
      status: s.status,
      source: s.source,
      rationale: s.rationale,
      statsSnapshotJson: JSON.stringify(s.statsSnapshot),
      diffJson: JSON.stringify(s.diff),
    });
  return info.lastInsertRowid as number;
}

export function updateAgentSuggestionStatus(id: number, status: AgentSuggestionStatus, proposedVersionId?: number) {
  if (proposedVersionId !== undefined) {
    getDb()
      .prepare(`UPDATE agent_suggestions SET status = ?, proposed_version_id = ? WHERE id = ?`)
      .run(status, proposedVersionId, id);
  } else {
    getDb().prepare(`UPDATE agent_suggestions SET status = ? WHERE id = ?`).run(status, id);
  }
}

export function rowToSuggestion(row: any): AgentSuggestion {
  return {
    id: row.id,
    createdAt: row.created_at,
    basedOnVersionId: row.based_on_version_id,
    proposedVersionId: row.proposed_version_id,
    status: row.status,
    source: row.source,
    rationale: row.rationale,
    statsSnapshot: JSON.parse(row.stats_snapshot_json),
    diff: JSON.parse(row.diff_json),
  };
}

export function getAgentSuggestions(limit = 100): AgentSuggestion[] {
  return getDb().prepare(`SELECT * FROM agent_suggestions ORDER BY id DESC LIMIT ?`).all(limit).map(rowToSuggestion);
}

export function getAgentSuggestion(id: number): AgentSuggestion | null {
  const row = getDb().prepare(`SELECT * FROM agent_suggestions WHERE id = ?`).get(id);
  return row ? rowToSuggestion(row) : null;
}

// ---------- wallet alerts (copy-trade advisory, never opens a position) ----------

export function insertWalletAlert(a: Omit<WalletAlert, 'id'>): number | null {
  const info = getDb()
    .prepare(
      `INSERT OR IGNORE INTO wallet_alerts
       (wallet_address, signature, mint, detected_at, buy_sol_amount, venue,
        suggested_stop_loss_pct, suggested_target1_pct, suggested_target2_pct,
        suggested_trailing_stop_pct, suggested_max_hold_minutes)
       VALUES (@walletAddress, @signature, @mint, @detectedAt, @buySolAmount, @venue,
        @suggestedStopLossPct, @suggestedTarget1Pct, @suggestedTarget2Pct,
        @suggestedTrailingStopPct, @suggestedMaxHoldMinutes)`,
    )
    .run(a);
  return info.changes === 0 ? null : (info.lastInsertRowid as number); // null = already seen this signature
}

export function getRecentWalletAlerts(limit = 100): WalletAlert[] {
  return getDb().prepare(`SELECT * FROM wallet_alerts ORDER BY detected_at DESC LIMIT ?`).all(limit).map(rowToWalletAlert);
}

export function getLatestWalletAlertSignatures(walletAddress: string, limit = 50): Set<string> {
  const rows = getDb()
    .prepare(`SELECT signature FROM wallet_alerts WHERE wallet_address = ? ORDER BY detected_at DESC LIMIT ?`)
    .all(walletAddress, limit) as { signature: string }[];
  return new Set(rows.map((r) => r.signature));
}

export function rowToWalletAlert(row: any): WalletAlert {
  return {
    id: row.id,
    walletAddress: row.wallet_address,
    signature: row.signature,
    mint: row.mint,
    detectedAt: row.detected_at,
    buySolAmount: row.buy_sol_amount,
    venue: row.venue,
    suggestedStopLossPct: row.suggested_stop_loss_pct,
    suggestedTarget1Pct: row.suggested_target1_pct,
    suggestedTarget2Pct: row.suggested_target2_pct,
    suggestedTrailingStopPct: row.suggested_trailing_stop_pct,
    suggestedMaxHoldMinutes: row.suggested_max_hold_minutes,
  };
}

export function insertCreatorLaunch(c: Omit<CreatorLaunch, 'id'>): number {
  const info = getDb()
    .prepare(
      `INSERT INTO creator_launches (creator_address, mint, name, symbol, detected_at)
       VALUES (@creatorAddress, @mint, @name, @symbol, @detectedAt)`,
    )
    .run(c);
  return info.lastInsertRowid as number;
}

export function getRecentCreatorLaunches(limit = 100): CreatorLaunch[] {
  return getDb().prepare(`SELECT * FROM creator_launches ORDER BY detected_at DESC LIMIT ?`).all(limit).map(rowToCreatorLaunch);
}

export function rowToCreatorLaunch(row: any): CreatorLaunch {
  return {
    id: row.id,
    creatorAddress: row.creator_address,
    mint: row.mint,
    name: row.name,
    symbol: row.symbol,
    detectedAt: row.detected_at,
  };
}
