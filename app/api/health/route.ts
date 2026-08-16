import { NextResponse } from 'next/server';
import { getMeta } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const lastHeartbeatAt = getMeta('last_heartbeat_at');
  const now = Date.now();
  const heartbeatAgeMs = lastHeartbeatAt ? now - Number(lastHeartbeatAt) : null;
  return NextResponse.json({
    workerAlive: heartbeatAgeMs !== null && heartbeatAgeMs < 30_000,
    lastHeartbeatAt: lastHeartbeatAt ? Number(lastHeartbeatAt) : null,
    virtualBalanceQuote: Number(getMeta('virtual_balance_quote') ?? 0),
  });
}
