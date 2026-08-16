import { NextResponse } from 'next/server';
import { getOpenPositions, getPartialExitsForPosition } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const positions = getOpenPositions().map((p) => ({ ...p, partialExits: getPartialExitsForPosition(p.id) }));
  return NextResponse.json({ positions });
}
