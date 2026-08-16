import { NextResponse } from 'next/server';
import { getRecentWalletAlerts } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const alerts = getRecentWalletAlerts();
  return NextResponse.json({ alerts });
}
