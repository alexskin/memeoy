import { NextResponse } from 'next/server';
import { isReadOnlyDeployment } from '../../../../../lib/dbRead';
import { applyAgentSuggestion, rejectAgentSuggestion } from '../../../../../lib/agent/agentRunner';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (isReadOnlyDeployment()) {
    return NextResponse.json({ error: 'read-only' }, { status: 403 });
  }

  const id = Number(params.id);
  const body = (await request.json().catch(() => ({}))) as { action?: 'accept' | 'reject' };

  if (body.action === 'accept') {
    const version = applyAgentSuggestion(id);
    return NextResponse.json({ status: 'applied', version });
  }
  if (body.action === 'reject') {
    rejectAgentSuggestion(id);
    return NextResponse.json({ status: 'rejected' });
  }
  return NextResponse.json({ error: 'action must be "accept" or "reject"' }, { status: 400 });
}
