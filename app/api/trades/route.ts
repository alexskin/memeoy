import { NextResponse } from 'next/server';
import { getClosedPositions, getFillById, getPartialExitsForPosition } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const limit = Number(new URL(request.url).searchParams.get('limit') ?? 200);
  const trades = getClosedPositions(limit).map((position) => ({
    ...position,
    entryFill: getFillById(position.entryFillId),
    exitFill: getFillById(position.exitFillId),
    partialExits: getPartialExitsForPosition(position.id),
  }));
  return NextResponse.json({ trades });
}
