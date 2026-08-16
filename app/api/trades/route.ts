import { NextResponse } from 'next/server';
import { getClosedPositions, getFillById, getPartialExitsForPosition } from '../../../lib/dbRead';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const limit = Number(new URL(request.url).searchParams.get('limit') ?? 200);
  const positions = await getClosedPositions(limit);
  const trades = await Promise.all(
    positions.map(async (position) => ({
      ...position,
      entryFill: await getFillById(position.entryFillId),
      exitFill: await getFillById(position.exitFillId),
      partialExits: await getPartialExitsForPosition(position.id),
    })),
  );
  return NextResponse.json({ trades });
}
