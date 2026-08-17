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

async function syncQuery(client: Client, table: string, sql: string, args: unknown[] = [], conflictColumn = 'id') {
  const rows = getDb().prepare(sql).all(...(args as any[])) as any[];
  try {
    await upsertRows(client, table, rows, conflictColumn);
  } catch (error) {
    logger.warn({ table, rowCount: rows.length, error: String(error) }, 'tursoSync: table sync failed, will retry next tick');
  }
}

export async function runTursoSync(window = DEFAULT_WINDOW): Promise<void> {
  if (!tursoSyncEnabled()) return;
  const client = getTursoClient();

  // Order matters a little (referenced-before-referencing keeps the public
  // mirror's transient inconsistency window smaller, though nothing here
  // enforces foreign keys - same as the local DB) but a lagging table just
  // catches up next tick either way.
  //
  // detected_pools/fills must ALSO include whatever ANY position about to
  // be synced (open, OR within the positions table's own recency window
  // below - not just open ones) references, unconditionally, not just
  // their own recency window. Turso enforces the positions.
  // detected_pool_id/entry_fill_id/exit_fill_id foreign keys (the local
  // better-sqlite3 DB does not), so a position - open OR recently closed -
  // can easily outlive its parent pool/fill's place in a bounded window
  // (confirmed live: high pool-detection volume ages a pool out of the
  // last 150 well before the positions referencing it leave the positions
  // window). One row failing its FK check fails the WHOLE table's upsert
  // batch, not just that row - so this silently blocked positions from
  // reaching Turso at all. positionsWindow is duplicated inline (not
  // factored into a shared query fragment) because `?` placeholders are
  // positional across the whole statement - every appearance needs its own
  // `window` arg supplied in the same order.
  //
  // Same failure mode independently hit filter_results/agent_decisions:
  // both also carry a detected_pool_id FK, and their own "last window rows
  // by id" pull can easily reference a pool that's aged out of
  // detected_pools' own window (pool-detection volume is much higher than
  // filter/decision volume) - confirmed live via the exact same
  // whole-batch FK failure. Since filter_results/agent_decisions are only
  // ever synced as their last `window` rows (no other predicate), the fix
  // is the same shape: detected_pools must also include any pool
  // referenced by the last `window` rows of each.
  const positionsWindow = `status = 'open' OR id IN (SELECT id FROM positions ORDER BY id DESC LIMIT ?)`;
  await syncQuery(client, 'strategy_config_versions', `SELECT * FROM strategy_config_versions WHERE applied = 1 OR id IN (SELECT id FROM strategy_config_versions ORDER BY id DESC LIMIT ?)`, [window]);
  await syncQuery(
    client,
    'detected_pools',
    `SELECT * FROM detected_pools WHERE status IN ('pending','filtering','watching') OR id IN (SELECT detected_pool_id FROM positions WHERE ${positionsWindow}) OR id IN (SELECT detected_pool_id FROM filter_results ORDER BY id DESC LIMIT ?) OR id IN (SELECT detected_pool_id FROM agent_decisions ORDER BY id DESC LIMIT ?) OR id IN (SELECT id FROM detected_pools ORDER BY detected_at DESC LIMIT ?)`,
    [window, window, window, window],
  );
  await syncQuery(client, 'filter_results', `SELECT * FROM filter_results ORDER BY id DESC LIMIT ?`, [window]);
  await syncQuery(client, 'momentum_snapshots', `SELECT * FROM momentum_snapshots ORDER BY id DESC LIMIT ?`, [window]);
  await syncQuery(client, 'agent_decisions', `SELECT * FROM agent_decisions ORDER BY id DESC LIMIT ?`, [window]);
  await syncQuery(
    client,
    'fills',
    `SELECT * FROM fills WHERE id IN (SELECT entry_fill_id FROM positions WHERE ${positionsWindow}) OR id IN (SELECT exit_fill_id FROM positions WHERE ${positionsWindow}) OR id IN (SELECT id FROM fills ORDER BY id DESC LIMIT ?)`,
    [window, window, window],
  );
  await syncQuery(client, 'positions', `SELECT * FROM positions WHERE ${positionsWindow}`, [window]);
  await syncQuery(client, 'partial_exits', `SELECT * FROM partial_exits ORDER BY id DESC LIMIT ?`, [window]);
  await syncQuery(client, 'equity_snapshots', `SELECT * FROM equity_snapshots ORDER BY id DESC LIMIT ?`, [window]);
  await syncQuery(client, 'agent_suggestions', `SELECT * FROM agent_suggestions ORDER BY id DESC LIMIT ?`, [window]);
  await syncQuery(client, 'wallet_alerts', `SELECT * FROM wallet_alerts ORDER BY id DESC LIMIT ?`, [window]);
  await syncQuery(
    client,
    'meta',
    `SELECT * FROM meta WHERE key IN ('worker_control_state','virtual_balance_quote','last_heartbeat_at','realized_pnl_cumulative')`,
    [],
    'key',
  );
}
