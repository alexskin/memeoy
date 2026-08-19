import { NextResponse } from 'next/server';
import { getLatestAgentDecisionsBatch, getLatestMomentumSnapshotsBatch, getPoolFilterResultsBatch, getRecentPools } from '../../../lib/dbRead';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const limit = Number(new URL(request.url).searchParams.get('limit') ?? 100);
  const pools = await getRecentPools(limit);
  // Enriched with the momentum + AI-decision pipeline's latest state per
  // pool, so the dashboard's Watcher tab can show a token's whole lifecycle
  // (filters -> momentum -> revival -> degen score -> decision -> outcome)
  // from this one endpoint. Batched (one query per sub-table, not one per
  // pool) - the old per-pool Promise.all fan-out ran `limit` pools x 3
  // queries EACH as separate Turso round-trips (300+ for a 100-pool page),
  // which only got parallelized, never actually reduced in count.
  const poolIds = pools.map((p) => p.id);
  const [filterResultsByPool, momentumByPool, decisionByPool] = await Promise.all([
    getPoolFilterResultsBatch(poolIds),
    getLatestMomentumSnapshotsBatch(poolIds),
    getLatestAgentDecisionsBatch(poolIds),
  ]);
  const enriched = pools.map((pool) => ({
    ...pool,
    filterResults: filterResultsByPool.get(pool.id) ?? [],
    latestMomentumSnapshot: momentumByPool.get(pool.id) ?? null,
    latestAgentDecision: decisionByPool.get(pool.id) ?? null,
  }));
  return NextResponse.json({ pools: enriched });
}
