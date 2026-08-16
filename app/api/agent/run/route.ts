import { NextResponse } from 'next/server';
import { runAgentNow } from '../../../../lib/agent/agentRunner';

export const dynamic = 'force-dynamic';

export async function POST() {
  const result = await runAgentNow();
  return NextResponse.json(result);
}
