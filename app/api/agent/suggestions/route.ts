import { NextResponse } from 'next/server';
import { getAgentSuggestions } from '../../../../lib/dbRead';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const limit = Number(new URL(request.url).searchParams.get('limit') ?? 100);
  return NextResponse.json({ suggestions: await getAgentSuggestions(limit) });
}
