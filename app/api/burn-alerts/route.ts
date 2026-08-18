import { NextResponse } from 'next/server';
import { getRecentBurnAlerts } from '../../../lib/dbRead';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const limit = Number(new URL(request.url).searchParams.get('limit') ?? 100);
  const alerts = await getRecentBurnAlerts(limit);
  return NextResponse.json({ alerts });
}
