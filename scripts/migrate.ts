// Idempotent schema creation. Run standalone (`npm run migrate`) or via
// lib/db.ts's getDb() which calls this automatically on first connection.
import Database from 'better-sqlite3';

export function migrate(db: Database.Database) {
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS detected_pools (
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
      status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS idx_detected_pools_detected_at ON detected_pools(detected_at);

    CREATE TABLE IF NOT EXISTS filter_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      detected_pool_id INTEGER NOT NULL REFERENCES detected_pools(id),
      filter_name TEXT NOT NULL,
      pass INTEGER NOT NULL,
      message TEXT,
      attempt_number INTEGER NOT NULL,
      config_version_id INTEGER NOT NULL,
      checked_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_filter_results_pool ON filter_results(detected_pool_id);

    CREATE TABLE IF NOT EXISTS fills (
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
      config_version_id INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fills_position ON fills(position_id);

    CREATE TABLE IF NOT EXISTS positions (
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
      config_version_id INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);

    CREATE TABLE IF NOT EXISTS equity_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      virtual_balance_quote REAL NOT NULL,
      open_unrealized_quote REAL NOT NULL,
      total_equity_quote REAL NOT NULL,
      realized_pnl_cumulative REAL NOT NULL,
      num_open_positions INTEGER NOT NULL,
      num_closed_trades INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_equity_ts ON equity_snapshots(ts);

    CREATE TABLE IF NOT EXISTS strategy_config_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version_number INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      parent_version_id INTEGER,
      applied INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL,
      rationale TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      based_on_version_id INTEGER NOT NULL,
      proposed_version_id INTEGER,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      rationale TEXT NOT NULL,
      stats_snapshot_json TEXT NOT NULL,
      diff_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS momentum_snapshots (
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
    );
    CREATE INDEX IF NOT EXISTS idx_momentum_snapshots_pool ON momentum_snapshots(detected_pool_id);

    CREATE TABLE IF NOT EXISTS wallet_alerts (
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
    );
    CREATE INDEX IF NOT EXISTS idx_wallet_alerts_detected_at ON wallet_alerts(detected_at);

    CREATE TABLE IF NOT EXISTS creator_launches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creator_address TEXT NOT NULL,
      mint TEXT NOT NULL,
      name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      detected_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_creator_launches_detected_at ON creator_launches(detected_at);

    CREATE TABLE IF NOT EXISTS partial_exits (
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
    );
    CREATE INDEX IF NOT EXISTS idx_partial_exits_position ON partial_exits(position_id);

    CREATE TABLE IF NOT EXISTS agent_decisions (
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
    );
    CREATE INDEX IF NOT EXISTS idx_agent_decisions_pool ON agent_decisions(detected_pool_id);

    CREATE TABLE IF NOT EXISTS premigration_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      detected_pool_id INTEGER NOT NULL REFERENCES detected_pools(id),
      checked_at INTEGER NOT NULL,
      market_cap_usd REAL,
      dev_holding_pct REAL,
      insider_pct REAL,
      top10_holders_pct REAL,
      age_minutes REAL,
      has_data INTEGER NOT NULL,
      pass INTEGER NOT NULL,
      criteria_json TEXT NOT NULL,
      config_version_id INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_premigration_snapshots_pool ON premigration_snapshots(detected_pool_id);
  `);

  db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')`).run();

  // Additive-column migration - safe to call repeatedly (checks PRAGMA
  // table_info before altering, since bare ALTER TABLE ADD COLUMN errors if
  // the column already exists).
  addColumnIfMissing(db, 'detected_pools', 'source', `source TEXT NOT NULL DEFAULT 'raydium'`);
  addColumnIfMissing(db, 'positions', 'source', `source TEXT NOT NULL DEFAULT 'raydium'`);
  addColumnIfMissing(db, 'fills', 'fee_quote', `fee_quote REAL NOT NULL DEFAULT 0`);
  addColumnIfMissing(db, 'positions', 'peak_profit_pct', `peak_profit_pct REAL NOT NULL DEFAULT -1000`);

  // Multi-target take-profit: quoteSizeIn/baseAmountHeld now mean "currently
  // remaining open" (decremented by partial exits) - these two columns keep
  // an immutable snapshot of the entry values. Backfill only touches rows
  // still at the just-added default, so it's safe to run on every migrate().
  const hadOriginalQuoteSizeIn = columnExists(db, 'positions', 'original_quote_size_in');
  addColumnIfMissing(db, 'positions', 'original_quote_size_in', `original_quote_size_in REAL NOT NULL DEFAULT 0`);
  if (!hadOriginalQuoteSizeIn) {
    db.exec(`UPDATE positions SET original_quote_size_in = CAST(quote_size_in AS REAL) WHERE original_quote_size_in = 0`);
  }
  const hadOriginalBaseAmountHeld = columnExists(db, 'positions', 'original_base_amount_held');
  addColumnIfMissing(db, 'positions', 'original_base_amount_held', `original_base_amount_held TEXT NOT NULL DEFAULT '0'`);
  if (!hadOriginalBaseAmountHeld) {
    db.exec(`UPDATE positions SET original_base_amount_held = base_amount_held WHERE original_base_amount_held = '0'`);
  }

  // Token name + entry/exit market cap (USD, from DexScreener at the moment
  // of buy/close) - all nullable, best-effort (DexScreener may not have
  // indexed a brand-new mint yet).
  addColumnIfMissing(db, 'positions', 'token_name', `token_name TEXT`);
  addColumnIfMissing(db, 'positions', 'entry_market_cap_usd', `entry_market_cap_usd REAL`);
  addColumnIfMissing(db, 'positions', 'exit_market_cap_usd', `exit_market_cap_usd REAL`);

  // AI exit review (lib/agent/exitDecisionEngine.ts) - set only when status = 'closed_ai_exit'.
  addColumnIfMissing(db, 'positions', 'ai_exit_reasoning', `ai_exit_reasoning TEXT`);
}

function columnExists(db: Database.Database, table: string, columnName: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === columnName);
}

function addColumnIfMissing(db: Database.Database, table: string, columnName: string, columnDefSql: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === columnName)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDefSql}`);
  }
}

// Allow `npm run migrate` standalone in addition to being called from lib/db.ts.
if (require.main === module) {
  const path = require('path') as typeof import('path');
  const fs = require('fs') as typeof import('fs');
  const dataDir = path.join(process.cwd(), '.local-data');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'snipe.db'));
  migrate(db);
  console.log('Migration complete.');
  db.close();
}
