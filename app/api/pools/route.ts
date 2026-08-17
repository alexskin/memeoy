import { NextResponse } from 'next/server';
import { getLatestAgentDecisionForPool, getLatestMomentumSnapshot, getPoolFilterResults, getRecentPools } from '../../../lib/dbRead';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const limit = Number(new URL(request.url).searchParams.get('limit') ?? 100);
  const pools = await getRecentPools(limit);
  // Enriched with the momentum + AI-decision pipeline's latest state per
  // pool, so the dashboard's Watcher tab can show a token's whole lifecycle
  // (filters -> momentum -> revival -> degen score -> decision -> outcome)
  // from this one endpoint - same N+1-per-row pattern this route already
  // used for filterResults, `limit` keeps it bounded.
  const enriched = await Promise.all(
    pools.map(async (pool) => {
      // The 3 sub-fetches are independent (different tables, same pool.id) -
      // run them concurrently instead of sequentially. Each is a real
      // network round trip against Turso in the hosted read-only deployment
      // (lib/dbRead.ts), so this cuts this route's wall-clock duration to
      // roughly 1/3 - Vercel's Fluid compute bills provisioned duration, not
      // just CPU time, so a slow N+1 fan-out here directly inflates cost.
      const [filterResults, latestMomentumSnapshot, latestAgentDecision] = await Promise.all([
        getPoolFilterResults(pool.id),
        getLatestMomentumSnapshot(pool.id),
        getLatestAgentDecisionForPool(pool.id),
      ]);
      return { ...pool, filterResults, latestMomentumSnapshot, latestAgentDecision };
    }),
  );
  return NextResponse.json({ pools: enriched });
}
