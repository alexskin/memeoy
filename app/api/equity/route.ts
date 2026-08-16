import { NextResponse } from 'next/server';
import { getEquitySnapshots } from '../../../lib/dbRead';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const limit = Number(new URL(request.url).searchParams.get('limit') ?? 1000);
  return NextResponse.json({ snapshots: await getEquitySnapshots(limit) });
}
