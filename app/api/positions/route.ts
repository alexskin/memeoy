import { NextResponse } from 'next/server';
import { getOpenPositions, getPartialExitsForPosition } from '../../../lib/dbRead';

export const dynamic = 'force-dynamic';

export async function GET() {
  const positions = await Promise.all(
    (await getOpenPositions()).map(async (p) => ({ ...p, partialExits: await getPartialExitsForPosition(p.id) })),
  );
  return NextResponse.json({ positions });
}
