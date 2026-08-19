// Purely additive, purely optional: pushes the local worker DB to a Turso
// mirror so the read-only Vercel dashboard (see lib/dbRead.ts) has
// something to read. Gated entirely behind TURSO_DATABASE_URL/
// TURSO_AUTH_TOKEN being set - a user who never sets these sees zero
// behavior change, not even a timer created (see the tursoSyncEnabled()
// check in scripts/worker.ts's wiring).
//
// Deliberately does NOT touch the local DB's write path or the trading
// logic - this only ever READS from the local better-sqlite3 DB (via
// getDb(), the same connection the worker already uses) and WRITES to
// Turso. If a sync tick fails (network blip, Turso quota, whatever), it
// just logs and retries next tick - never throws into the worker's main
// loop, never blocks a trade decision on network I/O.
//
// Incremental by row id (persisted per-table cursor via getMeta/setMeta),
// not a blind "re-upsert the last N rows every tick" - that earlier design
// re-wrote the SAME already-synced, already-unchanged rows on every 20s
// tick forever, which at this data volume burned through Turso's free
// monthly write quota in days (confirmed live 2026-08-19: ~1300 rows
// re-upserted per tick x 4320 ticks/day). Append-only tables (never updated
// after insert) now sync purely "id > last synced id". Tables whose rows
// genuinely mutate after insert (open positions, non-terminal pool status,
// the applied config version) still re-sync that small still-changing
// subset every tick - that part is unavoidable without an updated_at
// column - but no longer ALSO re-pays for the large already-settled tail.
import { createClient, type Client } from '@libsql/client';
import { getDb, getMeta, setMeta } from '../db';
import { logger } from '../logger';

const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || '';
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
// Per-tick cap on how many NEW rows a single table catches up on - only
// matters right after enabling sync or recovering from a long outage;
// steady-state incremental volume is far below this. Self-correcting: an
// under-cap backlog just finishes over a few more ticks.
const CATCHUP_BATCH_SIZE = 300;
// Small tables that mutate after insert (see the two call sites below) -
// bounded re-sync every tick is cheap enough at their real row counts.
const SMALL_MUTABLE_TABLE_WINDOW = 50;

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

const LAST_SYNCED_ID_PREFIX = 'tursoSync_lastId_';

function getLastSyncedId(table: string): number {
  const raw = getMeta(LAST_SYNCED_ID_PREFIX + table);
  return raw === null ? 0 : Number(raw);
}

function setLastSyncedId(table: string, id: number) {
  setMeta(LAST_SYNCED_ID_PREFIX + table, String(id));
}

// Builds an upsert from whatever columns are actually present on the row
// object - better-sqlite3 rows already come back keyed by exact column
// name, so this avoids hand-writing 11 near-identical upsert statements.
async function upsertRows(client: Client, table: string, rows: any[], conflictColumn = 'id'): Promise<boolean> {
  if (rows.length === 0) return true;
  const columns = Object.keys(rows[0]);
  const updateSet = columns.filter((c) => c !== conflictColumn).map((c) => `${c}=excluded.${c}`).join(',');
  const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')}) ON CONFLICT(${conflictColumn}) DO UPDATE SET ${updateSet}`;

  await client.batch(
    rows.map((row) => ({ sql, args: columns.map((c) => row[c]) })),
    'write',
  );
  return true;
}

// Returns whether the push succeeded - callers that track an incremental
// id cursor must only advance it on success, or a failed batch's rows
// would be silently skipped forever on the next tick.
async function pushRows(client: Client, table: string, rows: any[], conflictColumn = 'id'): Promise<boolean> {
  try {
    await upsertRows(client, table, rows, conflictColumn);
    return true;
  } catch (error) {
    logger.warn({ table, rowCount: rows.length, error: String(error) }, 'tursoSync: table sync failed, will retry next tick');
    return false;
  }
}

// For append-only tables (never UPDATEd after insert): syncs only rows
// newer than the last successfully-synced id, advancing the cursor only on
// success.
async function syncIncremental(client: Client, table: string, idColumn = 'id') {
  const lastId = getLastSyncedId(table);
  const rows = getDb()
    .prepare(`SELECT * FROM ${table} WHERE ${idColumn} > ? ORDER BY ${idColumn} ASC LIMIT ?`)
    .all(lastId, CATCHUP_BATCH_SIZE) as any[];
  if (rows.length === 0) return;

  const ok = await pushRows(client, table, rows);
  if (ok) setLastSyncedId(table, rows[rows.length - 1][idColumn]);
}

export async function runTursoSync(): Promise<void> {
  if (!tursoSyncEnabled()) return;
  const client = getTursoClient();
  const db = getDb();

  // strategy_config_versions: mutates rarely (the `applied` flag flips when
  // a new version activates) - keep re-syncing whichever version is
  // currently applied every tick (tiny, 1 row) plus incremental catch-up
  // for the rest.
  const appliedConfigRows = db.prepare(`SELECT * FROM strategy_config_versions WHERE applied = 1`).all() as any[];
  await pushRows(client, 'strategy_config_versions', appliedConfigRows);
  await syncIncremental(client, 'strategy_config_versions');

  // Turso enforces FKs the local better-sqlite3 DB does not (positions ->
  // detected_pools/fills, filter_results/agent_decisions -> detected_pools),
  // and ONE row failing its FK check fails the WHOLE batch, not just that
  // row - so any parent missing from its child's sync tick silently blocks
  // the whole child table from ever reaching Turso. Read each child table's
  // NEW rows ONCE here and derive every parent id directly from those exact
  // in-memory rows, so there's no window for a parent-coverage query to
  // disagree with what the child rows actually reference.
  const positionsLastId = getLastSyncedId('positions');
  const newPositionsRows = db
    .prepare(`SELECT * FROM positions WHERE id > ? ORDER BY id ASC LIMIT ?`)
    .all(positionsLastId, CATCHUP_BATCH_SIZE) as any[];
  const openPositionsRows = db.prepare(`SELECT * FROM positions WHERE status = 'open'`).all() as any[];
  // Open positions mutate every tick (peak/pnl) and are always re-pushed;
  // don't let them also count toward the incremental cursor twice.
  const openIds = new Set(openPositionsRows.map((r) => r.id));
  const positionsRows = [...openPositionsRows, ...newPositionsRows.filter((r) => !openIds.has(r.id))];

  const filterResultsLastId = getLastSyncedId('filter_results');
  const filterResultsRows = db
    .prepare(`SELECT * FROM filter_results WHERE id > ? ORDER BY id ASC LIMIT ?`)
    .all(filterResultsLastId, CATCHUP_BATCH_SIZE) as any[];

  const agentDecisionsLastId = getLastSyncedId('agent_decisions');
  const agentDecisionsRows = db
    .prepare(`SELECT * FROM agent_decisions WHERE id > ? ORDER BY id ASC LIMIT ?`)
    .all(agentDecisionsLastId, CATCHUP_BATCH_SIZE) as any[];

  // Also FK-dependent on detected_pools, same as the three above - pulled
  // up here (not the generic syncIncremental helper) so its referenced pool
  // ids feed the same referencedPoolIds set. Missing this was a real bug:
  // momentum_snapshots is by far the highest-volume child table, so leaving
  // it out of the FK-safety net meant its batch could reference a pool
  // detected_pools hadn't synced yet, failing the whole batch with
  // "FOREIGN KEY constraint failed" (confirmed live 2026-08-19).
  const momentumSnapshotsLastId = getLastSyncedId('momentum_snapshots');
  const momentumSnapshotsRows = db
    .prepare(`SELECT * FROM momentum_snapshots WHERE id > ? ORDER BY id ASC LIMIT ?`)
    .all(momentumSnapshotsLastId, CATCHUP_BATCH_SIZE) as any[];

  const referencedPoolIds = new Set<number>();
  for (const r of positionsRows) if (r.detected_pool_id != null) referencedPoolIds.add(r.detected_pool_id);
  for (const r of filterResultsRows) referencedPoolIds.add(r.detected_pool_id);
  for (const r of agentDecisionsRows) referencedPoolIds.add(r.detected_pool_id);
  for (const r of momentumSnapshotsRows) referencedPoolIds.add(r.detected_pool_id);
  const poolIdList = [...referencedPoolIds];
  const poolIdPlaceholder = poolIdList.length > 0 ? poolIdList.map(() => '?').join(',') : 'NULL';

  const detectedPoolsLastId = getLastSyncedId('detected_pools');
  const detectedPoolsRows = db
    .prepare(
      `SELECT * FROM detected_pools WHERE status IN ('pending','filtering','watching') OR id IN (${poolIdPlaceholder}) OR id > ? ORDER BY id ASC LIMIT ?`,
    )
    .all(...poolIdList, detectedPoolsLastId, CATCHUP_BATCH_SIZE) as any[];

  const referencedFillIds = new Set<number>();
  for (const r of positionsRows) {
    if (r.entry_fill_id != null) referencedFillIds.add(r.entry_fill_id);
    if (r.exit_fill_id != null) referencedFillIds.add(r.exit_fill_id);
  }
  const fillIdList = [...referencedFillIds];
  const fillIdPlaceholder = fillIdList.length > 0 ? fillIdList.map(() => '?').join(',') : 'NULL';

  const fillsLastId = getLastSyncedId('fills');
  const fillsRows = db
    .prepare(`SELECT * FROM fills WHERE id IN (${fillIdPlaceholder}) OR id > ? ORDER BY id ASC LIMIT ?`)
    .all(...fillIdList, fillsLastId, CATCHUP_BATCH_SIZE) as any[];

  // Order matters a little (referenced-before-referencing keeps the public
  // mirror's transient inconsistency window smaller, though Turso itself
  // enforces nothing about the order these arrive in within one tick) but a
  // lagging table just catches up next tick either way. Cursors only
  // advance past a row's id on a successful push AND only up to the
  // highest id actually seen in this batch (not the whole fetched set,
  // since detected_pools/fills mix "still active"/"referenced" rows with
  // genuinely-new-by-id ones).
  if (await pushRows(client, 'detected_pools', detectedPoolsRows)) {
    const maxNewId = Math.max(detectedPoolsLastId, ...detectedPoolsRows.filter((r) => r.id > detectedPoolsLastId).map((r) => r.id));
    setLastSyncedId('detected_pools', maxNewId);
  }
  if (await pushRows(client, 'filter_results', filterResultsRows)) {
    if (filterResultsRows.length > 0) setLastSyncedId('filter_results', filterResultsRows[filterResultsRows.length - 1].id);
  }
  if (await pushRows(client, 'momentum_snapshots', momentumSnapshotsRows)) {
    if (momentumSnapshotsRows.length > 0) setLastSyncedId('momentum_snapshots', momentumSnapshotsRows[momentumSnapshotsRows.length - 1].id);
  }
  if (await pushRows(client, 'agent_decisions', agentDecisionsRows)) {
    if (agentDecisionsRows.length > 0) setLastSyncedId('agent_decisions', agentDecisionsRows[agentDecisionsRows.length - 1].id);
  }
  if (await pushRows(client, 'fills', fillsRows)) {
    const maxNewId = Math.max(fillsLastId, ...fillsRows.filter((r) => r.id > fillsLastId).map((r) => r.id));
    setLastSyncedId('fills', maxNewId);
  }
  if (await pushRows(client, 'positions', positionsRows)) {
    const maxNewId = Math.max(positionsLastId, ...newPositionsRows.map((r) => r.id));
    setLastSyncedId('positions', maxNewId);
  }
  await syncIncremental(client, 'partial_exits');
  await syncIncremental(client, 'equity_snapshots');
  await syncIncremental(client, 'wallet_alerts');
  await syncIncremental(client, 'creator_launches');
  // Not pure-incremental: both mutate after insert (agent_suggestions'
  // status flips on accept/reject; burn_alerts' burners_json fills in
  // asynchronously later - see lib/burnTracker/burnWatcher.ts) and a row
  // already synced once in its pre-mutation state would never get the
  // update pushed otherwise. Both are tiny tables in practice, so a small
  // bounded re-sync every tick is negligible cost.
  await syncQuery(client, 'agent_suggestions', `SELECT * FROM agent_suggestions ORDER BY id DESC LIMIT ?`, [SMALL_MUTABLE_TABLE_WINDOW]);
  await syncQuery(client, 'burn_alerts', `SELECT * FROM burn_alerts ORDER BY id DESC LIMIT ?`, [SMALL_MUTABLE_TABLE_WINDOW]);
  await syncQuery(
    client,
    'meta',
    `SELECT * FROM meta WHERE key IN ('worker_control_state','virtual_balance_quote','last_heartbeat_at','realized_pnl_cumulative')`,
    [],
    'key',
  );
}

async function syncQuery(client: Client, table: string, sql: string, args: unknown[] = [], conflictColumn = 'id') {
  const rows = getDb().prepare(sql).all(...(args as any[])) as any[];
  await pushRows(client, table, rows, conflictColumn);
}
