import { NextResponse } from 'next/server';
import { getRecentWalletAlerts } from '../../../lib/dbRead';

export const dynamic = 'force-dynamic';

export async function GET() {
  const alerts = await getRecentWalletAlerts();
  return NextResponse.json({ alerts });
}
