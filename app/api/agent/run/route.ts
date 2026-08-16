import { NextResponse } from 'next/server';
import { isHostedReadOnly } from '../../../../lib/dbRead';
import { runAgentNow } from '../../../../lib/agent/agentRunner';

export const dynamic = 'force-dynamic';

export async function POST() {
  if (isHostedReadOnly()) {
    return NextResponse.json({ error: 'read-only' }, { status: 403 });
  }
  const result = await runAgentNow();
  return NextResponse.json(result);
}
