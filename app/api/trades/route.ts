import { NextResponse } from 'next/server';
import { getClosedPositions, getFillsBatch, getPartialExitsBatch } from '../../../lib/dbRead';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const limit = Number(new URL(request.url).searchParams.get('limit') ?? 200);
  const positions = await getClosedPositions(limit);
  // Batched (one query per sub-table, not one per position) - the old
  // per-position Promise.all fan-out ran up to `limit` positions x 3
  // queries EACH as separate Turso round-trips (600+ for the 200-position
  // default), which only got parallelized, never actually reduced in count.
  const fillIds = positions.flatMap((p) => [p.entryFillId, p.exitFillId]);
  const positionIds = positions.map((p) => p.id);
  const [fillsById, partialExitsByPosition] = await Promise.all([
    getFillsBatch(fillIds),
    getPartialExitsBatch(positionIds),
  ]);
  const trades = positions.map((position) => ({
    ...position,
    entryFill: position.entryFillId != null ? (fillsById.get(position.entryFillId) ?? null) : null,
    exitFill: position.exitFillId != null ? (fillsById.get(position.exitFillId) ?? null) : null,
    partialExits: partialExitsByPosition.get(position.id) ?? [],
  }));
  return NextResponse.json({ trades });
}
