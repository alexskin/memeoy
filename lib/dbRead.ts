// Environment-aware async read layer for app/api/**/route.ts, the ONLY
// place in this codebase that needs to work both locally (against the
// worker's local better-sqlite3 file) and on Vercel (against a Turso
// mirror, since Vercel has no persistent local disk and can't load
// better-sqlite3's native binary the way this project uses it). The worker
// itself (scripts/worker.ts and everything it drives) never imports this -
// it keeps using lib/db.ts directly, synchronously, unchanged, since it
// never runs on Vercel and shouldn't take on network-dependent I/O in its
// hot path.
//
// When TURSO_DATABASE_URL is unset (local `npm run dev`, no setup needed),
// every function below is a thin async wrapper around the matching lib/db.ts
// export - local dev behaves exactly as it did before this file existed.
// When set, queries go to Turso instead, using the SAME rowToX() mapping
// functions lib/db.ts already exports (libSQL rows expose columns as named
// properties the same way better-sqlite3 rows do, so the mapping logic is
// correct unchanged against either source) - see lib/sync/tursoSync.ts for
// what actually populates the Turso side.
import { createClient, type Client } from '@libsql/client';
import * as localDb from './db';
import {
  AgentDecision,
  AgentSuggestion,
  DetectedPool,
  EquitySnapshot,
  FilterOutcome,
  MomentumSnapshot,
  PartialExit,
  Position,
  SimulatedFill,
  StrategyConfigVersion,
  WalletAlert,
} from './types';

const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || '';
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || '';

export function isHostedReadOnly(): boolean {
  return !!TURSO_DATABASE_URL;
}

let _client: Client | null = null;
function getTursoClient(): Client {
  if (!_client) {
    _client = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });
  }
  return _client;
}

async function tursoRows(sql: string, args: unknown[] = []): Promise<any[]> {
  const result = await getTursoClient().execute({ sql, args: args as any[] });
  return result.rows as any[];
}

export async function getRecentPools(limit = 100): Promise<DetectedPool[]> {
  if (!isHostedReadOnly()) return localDb.getRecentPools(limit);
  const rows = await tursoRows(`SELECT * FROM detected_pools ORDER BY detected_at DESC LIMIT ?`, [limit]);
  return rows.map(localDb.rowToDetectedPool);
}

export async function getPoolFilterResults(detectedPoolId: number): Promise<FilterOutcome[]> {
  if (!isHostedReadOnly()) return localDb.getPoolFilterResults(detectedPoolId);
  const rows = await tursoRows(`SELECT * FROM filter_results WHERE detected_pool_id = ? ORDER BY checked_at ASC`, [detectedPoolId]);
  return rows.map(localDb.rowToFilterOutcome);
}

export async function getLatestMomentumSnapshot(detectedPoolId: number): Promise<MomentumSnapshot | null> {
  if (!isHostedReadOnly()) return localDb.getLatestMomentumSnapshot(detectedPoolId);
  const rows = await tursoRows(`SELECT * FROM momentum_snapshots WHERE detected_pool_id = ? ORDER BY checked_at DESC LIMIT 1`, [detectedPoolId]);
  return rows[0] ? localDb.rowToMomentumSnapshot(rows[0]) : null;
}

export async function getLatestAgentDecisionForPool(detectedPoolId: number): Promise<AgentDecision | null> {
  if (!isHostedReadOnly()) return localDb.getLatestAgentDecisionForPool(detectedPoolId);
  const rows = await tursoRows(`SELECT * FROM agent_decisions WHERE detected_pool_id = ? ORDER BY checked_at DESC LIMIT 1`, [detectedPoolId]);
  return rows[0] ? localDb.rowToAgentDecision(rows[0]) : null;
}

export async function getOpenPositions(): Promise<Position[]> {
  if (!isHostedReadOnly()) return localDb.getOpenPositions();
  const rows = await tursoRows(`SELECT * FROM positions WHERE status = 'open' ORDER BY opened_at ASC`);
  return rows.map(localDb.rowToPosition);
}

export async function getClosedPositions(limit = 200): Promise<Position[]> {
  if (!isHostedReadOnly()) return localDb.getClosedPositions(limit);
  const rows = await tursoRows(`SELECT * FROM positions WHERE status != 'open' ORDER BY closed_at DESC LIMIT ?`, [limit]);
  return rows.map(localDb.rowToPosition);
}

export async function getPartialExitsForPosition(positionId: number): Promise<PartialExit[]> {
  if (!isHostedReadOnly()) return localDb.getPartialExitsForPosition(positionId);
  const rows = await tursoRows(`SELECT * FROM partial_exits WHERE position_id = ? ORDER BY closed_at ASC`, [positionId]);
  return rows.map(localDb.rowToPartialExit);
}

export async function getFillById(id: number | null): Promise<SimulatedFill | null> {
  if (id === null) return null;
  if (!isHostedReadOnly()) return localDb.getFillById(id);
  const rows = await tursoRows(`SELECT * FROM fills WHERE id = ?`, [id]);
  return rows[0] ? localDb.rowToFill(rows[0]) : null;
}

export async function getEquitySnapshots(limit = 1000): Promise<EquitySnapshot[]> {
  if (!isHostedReadOnly()) return localDb.getEquitySnapshots(limit);
  const rows = await tursoRows(`SELECT * FROM equity_snapshots ORDER BY ts DESC LIMIT ?`, [limit]);
  return rows.map(localDb.rowToEquitySnapshot).reverse();
}

export async function getActiveConfigVersion(): Promise<StrategyConfigVersion> {
  if (!isHostedReadOnly()) return localDb.getActiveConfigVersion();
  const rows = await tursoRows(`SELECT * FROM strategy_config_versions WHERE applied = 1 ORDER BY id DESC LIMIT 1`);
  if (!rows[0]) throw new Error('No applied strategy config version found in Turso - has tursoSync run yet?');
  return localDb.rowToConfigVersion(rows[0]);
}

export async function getConfigVersionHistory(limit = 50): Promise<StrategyConfigVersion[]> {
  if (!isHostedReadOnly()) return localDb.getConfigVersionHistory(limit);
  const rows = await tursoRows(`SELECT * FROM strategy_config_versions ORDER BY id DESC LIMIT ?`, [limit]);
  return rows.map(localDb.rowToConfigVersion);
}

export async function getAgentSuggestions(limit = 100): Promise<AgentSuggestion[]> {
  if (!isHostedReadOnly()) return localDb.getAgentSuggestions(limit);
  const rows = await tursoRows(`SELECT * FROM agent_suggestions ORDER BY id DESC LIMIT ?`, [limit]);
  return rows.map(localDb.rowToSuggestion);
}

export async function getRecentWalletAlerts(limit = 100): Promise<WalletAlert[]> {
  if (!isHostedReadOnly()) return localDb.getRecentWalletAlerts(limit);
  const rows = await tursoRows(`SELECT * FROM wallet_alerts ORDER BY detected_at DESC LIMIT ?`, [limit]);
  return rows.map(localDb.rowToWalletAlert);
}

export async function getMeta(key: string): Promise<string | null> {
  if (!isHostedReadOnly()) return localDb.getMeta(key);
  const rows = await tursoRows(`SELECT value FROM meta WHERE key = ?`, [key]);
  return rows[0]?.value ?? null;
}

export async function getWorkerControlState(): Promise<'running' | 'paused' | 'stopped'> {
  const value = await getMeta('worker_control_state');
  return value === 'paused' || value === 'stopped' ? value : 'running';
}
