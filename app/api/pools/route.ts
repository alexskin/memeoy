import { NextResponse } from 'next/server';
import { getLatestAgentDecisionForPool, getLatestMomentumSnapshot, getPoolFilterResults, getRecentPools } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const limit = Number(new URL(request.url).searchParams.get('limit') ?? 100);
  const pools = getRecentPools(limit);
  // Enriched with the momentum + AI-decision pipeline's latest state per
  // pool, so the dashboard's Watcher tab can show a token's whole lifecycle
  // (filters -> momentum -> revival -> degen score -> decision -> outcome)
  // from this one endpoint - same N+1-per-row pattern this route already
  // used for filterResults, `limit` keeps it bounded.
  const enriched = pools.map((pool) => ({
    ...pool,
    filterResults: getPoolFilterResults(pool.id),
    latestMomentumSnapshot: getLatestMomentumSnapshot(pool.id),
    latestAgentDecision: getLatestAgentDecisionForPool(pool.id),
  }));
  return NextResponse.json({ pools: enriched });
}
