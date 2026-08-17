// One-time schema setup for the OPTIONAL public read-only dashboard (see
// README.md's "Public read-only dashboard on Vercel" section). Mirrors
// scripts/migrate.ts's final schema (libSQL is SQLite-compatible, same SQL)
// but as a fresh CREATE with every column already present - a new Turso DB
// has no old rows to incrementally ALTER TABLE forward, unlike migrate.ts's
// local-DB history. Run once: `npx tsx --env-file=.env.local scripts/migrateTurso.ts`.
//
// Maintenance note: a future schema change needs to be added here too, not
// just in scripts/migrate.ts - these two are deliberately kept as separate,
// parallel schema definitions rather than sharing code, since migrate.ts's
// incremental ALTER TABLE logic doesn't translate to a from-scratch create.
import { createClient } from '@libsql/client';

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS detected_pools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pool_id TEXT NOT NULL UNIQUE,
    base_mint TEXT NOT NULL,
    quote_mint TEXT NOT NULL,
    lp_mint TEXT NOT NULL,
    market_id TEXT NOT NULL,
    base_decimals INTEGER NOT NULL,
    quote_decimals INTEGER NOT NULL,
    pool_open_time INTEGER,
    detected_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    source TEXT NOT NULL DEFAULT 'raydium'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_detected_pools_detected_at ON detected_pools(detected_at)`,
  `CREATE TABLE IF NOT EXISTS filter_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    detected_pool_id INTEGER NOT NULL REFERENCES detected_pools(id),
    filter_name TEXT NOT NULL,
    pass INTEGER NOT NULL,
    message TEXT,
    attempt_number INTEGER NOT NULL,
    config_version_id INTEGER NOT NULL,
    checked_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_filter_results_pool ON filter_results(detected_pool_id)`,
  `CREATE TABLE IF NOT EXISTS fills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id INTEGER,
    side TEXT NOT NULL,
    attempt_number INTEGER NOT NULL,
    execution_mode TEXT NOT NULL,
    decision_at INTEGER NOT NULL,
    decision_mid_price REAL NOT NULL,
    decision_amount_in TEXT NOT NULL,
    modeled_latency_ms INTEGER NOT NULL,
    actual_elapsed_ms INTEGER NOT NULL,
    fill_at INTEGER NOT NULL,
    fill_mid_price REAL,
    fill_execution_price REAL,
    fill_amount_out TEXT,
    latency_drift_pct REAL,
    price_impact_pct REAL,
    total_slippage_pct REAL,
    slippage_tolerance_pct REAL NOT NULL,
    outcome TEXT NOT NULL,
    config_version_id INTEGER NOT NULL,
    fee_quote REAL NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fills_position ON fills(position_id)`,
  `CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    detected_pool_id INTEGER NOT NULL REFERENCES detected_pools(id),
    base_mint TEXT NOT NULL,
    status TEXT NOT NULL,
    entry_fill_id INTEGER NOT NULL REFERENCES fills(id),
    exit_fill_id INTEGER REFERENCES fills(id),
    quote_size_in TEXT NOT NULL,
    base_amount_held TEXT NOT NULL,
    entry_price REAL NOT NULL,
    exit_price REAL,
    take_profit_pct_snapshot REAL NOT NULL,
    stop_loss_pct_snapshot REAL NOT NULL,
    realized_pnl_quote REAL,
    realized_pnl_pct REAL,
    opened_at INTEGER NOT NULL,
    closed_at INTEGER,
    config_version_id INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'raydium',
    peak_profit_pct REAL NOT NULL DEFAULT -1000,
    original_quote_size_in REAL NOT NULL DEFAULT 0,
    original_base_amount_held TEXT NOT NULL DEFAULT '0',
    token_name TEXT,
    entry_market_cap_usd REAL,
    exit_market_cap_usd REAL,
    ai_exit_reasoning TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status)`,
  `CREATE TABLE IF NOT EXISTS equity_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    virtual_balance_quote REAL NOT NULL,
    open_unrealized_quote REAL NOT NULL,
    total_equity_quote REAL NOT NULL,
    realized_pnl_cumulative REAL NOT NULL,
    num_open_positions INTEGER NOT NULL,
    num_closed_trades INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_equity_ts ON equity_snapshots(ts)`,
  `CREATE TABLE IF NOT EXISTS strategy_config_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version_number INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    parent_version_id INTEGER,
    applied INTEGER NOT NULL DEFAULT 0,
    config_json TEXT NOT NULL,
    rationale TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS agent_suggestions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    based_on_version_id INTEGER NOT NULL,
    proposed_version_id INTEGER,
    status TEXT NOT NULL,
    source TEXT NOT NULL,
    rationale TEXT NOT NULL,
    stats_snapshot_json TEXT NOT NULL,
    diff_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS momentum_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    detected_pool_id INTEGER NOT NULL REFERENCES detected_pools(id),
    checked_at INTEGER NOT NULL,
    liquidity_usd REAL,
    volume_24h_usd REAL,
    buys_1h INTEGER,
    buys_5m INTEGER,
    price_change_1h_pct REAL,
    price_change_24h_pct REAL,
    pair_age_minutes REAL,
    has_data INTEGER NOT NULL,
    pass INTEGER NOT NULL,
    criteria_json TEXT NOT NULL,
    config_version_id INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_momentum_snapshots_pool ON momentum_snapshots(detected_pool_id)`,
  `CREATE TABLE IF NOT EXISTS wallet_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL,
    signature TEXT NOT NULL UNIQUE,
    mint TEXT NOT NULL,
    detected_at INTEGER NOT NULL,
    buy_sol_amount REAL,
    venue TEXT,
    suggested_stop_loss_pct REAL NOT NULL,
    suggested_target1_pct REAL NOT NULL,
    suggested_target2_pct REAL NOT NULL,
    suggested_trailing_stop_pct REAL NOT NULL,
    suggested_max_hold_minutes REAL NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_wallet_alerts_detected_at ON wallet_alerts(detected_at)`,
  `CREATE TABLE IF NOT EXISTS creator_launches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_address TEXT NOT NULL,
    mint TEXT NOT NULL,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    detected_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_creator_launches_detected_at ON creator_launches(detected_at)`,
  `CREATE TABLE IF NOT EXISTS partial_exits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id INTEGER NOT NULL REFERENCES positions(id),
    exit_fill_id INTEGER NOT NULL REFERENCES fills(id),
    target_pct REAL,
    sell_fraction_of_original REAL NOT NULL,
    base_amount_sold TEXT NOT NULL,
    quote_size_in_portion REAL NOT NULL,
    quote_received_ui REAL NOT NULL,
    exit_price REAL NOT NULL,
    realized_pnl_quote REAL NOT NULL,
    realized_pnl_pct REAL NOT NULL,
    reason TEXT NOT NULL,
    closed_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_partial_exits_position ON partial_exits(position_id)`,
  `CREATE TABLE IF NOT EXISTS agent_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    detected_pool_id INTEGER NOT NULL REFERENCES detected_pools(id),
    checked_at INTEGER NOT NULL,
    momentum_pass INTEGER NOT NULL,
    revival_pass INTEGER NOT NULL,
    revival_strength REAL NOT NULL,
    degen_score REAL,
    degen_verdict TEXT,
    action TEXT NOT NULL,
    confidence REAL NOT NULL,
    reasoning TEXT NOT NULL,
    source TEXT NOT NULL,
    config_version_id INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_decisions_pool ON agent_decisions(detected_pool_id)`,
];

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) {
    throw new Error('TURSO_DATABASE_URL is not set - create a Turso DB first (see README.md) and set it in .env.local');
  }

  const client = createClient({ url, authToken });
  for (const sql of STATEMENTS) {
    await client.execute(sql);
  }

  // ALTER-forward for a DB that already existed before this column was
  // added - CREATE TABLE IF NOT EXISTS above is a no-op there. Safe to
  // re-run: swallows the "duplicate column" error a second run would hit.
  try {
    await client.execute(`ALTER TABLE positions ADD COLUMN ai_exit_reasoning TEXT`);
  } catch (error) {
    if (!String(error).includes('duplicate column')) throw error;
  }

  console.log(`Turso schema migration complete (${STATEMENTS.length} statements).`);
}

main().catch((error) => {
  console.error('Turso migration failed:', error);
  process.exit(1);
});
