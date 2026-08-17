// Purely additive, purely optional: pushes a bounded window of the local
// worker DB to a Turso mirror so the read-only Vercel dashboard (see
// lib/dbRead.ts) has something to read. Gated entirely behind
// TURSO_DATABASE_URL/TURSO_AUTH_TOKEN being set - a user who never sets
// these sees zero behavior change, not even a timer created (see the
// tursoSyncEnabled() check in scripts/worker.ts's wiring).
//
// Deliberately does NOT touch the local DB's write path or the trading
// logic - this only ever READS from the local better-sqlite3 DB (via
// getDb(), the same connection the worker already uses) and WRITES to
// Turso. If a sync tick fails (network blip, Turso quota, whatever), it
// just logs and retries next tick - never throws into the worker's main
// loop, never blocks a trade decision on network I/O.
//
// Strategy: re-upsert a bounded recent-or-still-active window every tick,
// not precise dirty-tracking - simpler, self-correcting (a missed tick just
// catches up next tick), and cheap enough at this data volume. Rows are
// upserted verbatim (same column names as the local schema, which
// scripts/migrateTurso.ts creates identically) - no domain-object mapping
// needed here, this is a raw table mirror, not an application read.
import { createClient, type Client } from '@libsql/client';
import { getDb } from '../db';
import { logger } from '../logger';

const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || '';
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
const DEFAULT_WINDOW = 150;

export function tursoSyncEnabled(): boolean {
  return !!TURSO_DATABASE_URL;
}

let _client: Client | null = null;
function getTursoClient(): Client {
  if (!_client) {
    _client = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });
  }
  return _client;
}

// Builds an upsert from whatever columns are actually present on the row
// object - better-sqlite3 rows already come back keyed by exact column
// name, so this avoids hand-writing 11 near-identical upsert statements.
async function upsertRows(client: Client, table: string, rows: any[], conflictColumn = 'id') {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]);
  const updateSet = columns.filter((c) => c !== conflictColumn).map((c) => `${c}=excluded.${c}`).join(',');
  const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')}) ON CONFLICT(${conflictColumn}) DO UPDATE SET ${updateSet}`;

  await client.batch(
    rows.map((row) => ({ sql, args: columns.map((c) => row[c]) })),
    'write',
  );
}

async function pushRows(client: Client, table: string, rows: any[], conflictColumn = 'id') {
  try {
    await upsertRows(client, table, rows, conflictColumn);
  } catch (error) {
    logger.warn({ table, rowCount: rows.length, error: String(error) }, 'tursoSync: table sync failed, will retry next tick');
  }
}

async function syncQuery(client: Client, table: string, sql: string, args: unknown[] = [], conflictColumn = 'id') {
  const rows = getDb().prepare(sql).all(...(args as any[])) as any[];
  await pushRows(client, table, rows, conflictColumn);
}

export async function runTursoSync(window = DEFAULT_WINDOW): Promise<void> {
  if (!tursoSyncEnabled()) return;
  const client = getTursoClient();
  const db = getDb();

  await syncQuery(client, 'strategy_config_versions', `SELECT * FROM strategy_config_versions WHERE applied = 1 OR id IN (SELECT id FROM strategy_config_versions ORDER BY id DESC LIMIT ?)`, [window]);

  // Turso enforces FKs the local better-sqlite3 DB does not (positions ->
  // detected_pools/fills, filter_results/agent_decisions -> detected_pools),
  // and ONE row failing its FK check fails the WHOLE batch, not just that
  // row - so any parent missing from its child's sync tick silently blocks
  // the whole child table from ever reaching Turso.
  //
  // The naive fix (re-querying "referenced pool/fill ids" via a fresh SELECT
  // run moments after the child rows were read) has a real race: this
  // function is not a DB transaction/snapshot, and each Turso upsert below
  // is a real network round-trip the local worker keeps writing through -
  // by the time a later SELECT re-runs, newer child rows can exist that a
  // slightly-earlier parent-coverage SELECT never saw (confirmed live: high
  // filter_results insert volume outpaced the gap between two sequential
  // local queries). The actual fix is to never re-query: read each child
  // table's rows ONCE here, and derive every parent id directly from those
  // exact in-memory rows - there is then no window for the two to disagree,
  // regardless of how much the local DB changes underneath us afterward.
  const positionsRows = db
    .prepare(`SELECT * FROM positions WHERE status = 'open' OR id IN (SELECT id FROM positions ORDER BY id DESC LIMIT ?)`)
    .all(window) as any[];
  const filterResultsRows = db.prepare(`SELECT * FROM filter_results ORDER BY id DESC LIMIT ?`).all(window) as any[];
  const agentDecisionsRows = db.prepare(`SELECT * FROM agent_decisions ORDER BY id DESC LIMIT ?`).all(window) as any[];

  const referencedPoolIds = new Set<number>();
  for (const r of positionsRows) if (r.detected_pool_id != null) referencedPoolIds.add(r.detected_pool_id);
  for (const r of filterResultsRows) referencedPoolIds.add(r.detected_pool_id);
  for (const r of agentDecisionsRows) referencedPoolIds.add(r.detected_pool_id);
  const poolIdList = [...referencedPoolIds];
  const poolIdPlaceholder = poolIdList.length > 0 ? poolIdList.map(() => '?').join(',') : 'NULL';

  const detectedPoolsRows = db
    .prepare(
      `SELECT * FROM detected_pools WHERE status IN ('pending','filtering','watching') OR id IN (${poolIdPlaceholder}) OR id IN (SELECT id FROM detected_pools ORDER BY detected_at DESC LIMIT ?)`,
    )
    .all(...poolIdList, window) as any[];

  const referencedFillIds = new Set<number>();
  for (const r of positionsRows) {
    if (r.entry_fill_id != null) referencedFillIds.add(r.entry_fill_id);
    if (r.exit_fill_id != null) referencedFillIds.add(r.exit_fill_id);
  }
  const fillIdList = [...referencedFillIds];
  const fillIdPlaceholder = fillIdList.length > 0 ? fillIdList.map(() => '?').join(',') : 'NULL';

  const fillsRows = db
    .prepare(`SELECT * FROM fills WHERE id IN (${fillIdPlaceholder}) OR id IN (SELECT id FROM fills ORDER BY id DESC LIMIT ?)`)
    .all(...fillIdList, window) as any[];

  // Order matters a little (referenced-before-referencing keeps the public
  // mirror's transient inconsistency window smaller, though Turso itself
  // enforces nothing about the order these arrive in within one tick) but a
  // lagging table just catches up next tick either way.
  await pushRows(client, 'detected_pools', detectedPoolsRows);
  await pushRows(client, 'filter_results', filterResultsRows);
  await syncQuery(client, 'momentum_snapshots', `SELECT * FROM momentum_snapshots ORDER BY id DESC LIMIT ?`, [window]);
  await pushRows(client, 'agent_decisions', agentDecisionsRows);
  await pushRows(client, 'fills', fillsRows);
  await pushRows(client, 'positions', positionsRows);
  await syncQuery(client, 'partial_exits', `SELECT * FROM partial_exits ORDER BY id DESC LIMIT ?`, [window]);
  await syncQuery(client, 'equity_snapshots', `SELECT * FROM equity_snapshots ORDER BY id DESC LIMIT ?`, [window]);
  await syncQuery(client, 'agent_suggestions', `SELECT * FROM agent_suggestions ORDER BY id DESC LIMIT ?`, [window]);
  await syncQuery(client, 'wallet_alerts', `SELECT * FROM wallet_alerts ORDER BY id DESC LIMIT ?`, [window]);
  await syncQuery(client, 'creator_launches', `SELECT * FROM creator_launches ORDER BY id DESC LIMIT ?`, [window]);
  await syncQuery(
    client,
    'meta',
    `SELECT * FROM meta WHERE key IN ('worker_control_state','virtual_balance_quote','last_heartbeat_at','realized_pnl_cumulative')`,
    [],
    'key',
  );
}
