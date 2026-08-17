import { NextResponse } from 'next/server';
import { getLatestAgentDecisionBeforeBuy, getOpenPositions, getPartialExitsForPosition } from '../../../lib/dbRead';

export const dynamic = 'force-dynamic';

export async function GET() {
  const positions = await Promise.all(
    (await getOpenPositions()).map(async (p) => {
      const [decision, partialExits] = await Promise.all([
        getLatestAgentDecisionBeforeBuy(p.detectedPoolId, p.openedAt),
        getPartialExitsForPosition(p.id),
      ]);
      return {
        ...p,
        partialExits,
        entryReasoning: decision?.reasoning ?? null,
        entrySource: decision?.source ?? null,
      };
    }),
  );
  return NextResponse.json({ positions });
}
