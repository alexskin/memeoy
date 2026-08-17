import { NextResponse } from 'next/server';
import { getClosedPositions, getFillById, getPartialExitsForPosition } from '../../../lib/dbRead';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const limit = Number(new URL(request.url).searchParams.get('limit') ?? 200);
  const positions = await getClosedPositions(limit);
  const trades = await Promise.all(
    positions.map(async (position) => {
      // 3 independent lookups per position - run concurrently, same reason
      // as app/api/pools/route.ts's identical fix.
      const [entryFill, exitFill, partialExits] = await Promise.all([
        getFillById(position.entryFillId),
        getFillById(position.exitFillId),
        getPartialExitsForPosition(position.id),
      ]);
      return { ...position, entryFill, exitFill, partialExits };
    }),
  );
  return NextResponse.json({ trades });
}
