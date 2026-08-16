import { NextResponse } from 'next/server';
import { getMeta } from '../../../lib/dbRead';

export const dynamic = 'force-dynamic';

export async function GET() {
  const lastHeartbeatAt = await getMeta('last_heartbeat_at');
  const now = Date.now();
  const heartbeatAgeMs = lastHeartbeatAt ? now - Number(lastHeartbeatAt) : null;
  return NextResponse.json({
    workerAlive: heartbeatAgeMs !== null && heartbeatAgeMs < 30_000,
    lastHeartbeatAt: lastHeartbeatAt ? Number(lastHeartbeatAt) : null,
    virtualBalanceQuote: Number((await getMeta('virtual_balance_quote')) ?? 0),
  });
}
