import { NextResponse } from 'next/server';
import { getWorkerControlState, requestSellAll, setWorkerControlState, WorkerControlState } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ state: getWorkerControlState() });
}

const VALID_ACTIONS = ['pause', 'start', 'stop', 'sellAll'] as const;
type Action = (typeof VALID_ACTIONS)[number];

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { action?: Action };

  if (!body.action || !VALID_ACTIONS.includes(body.action)) {
    return NextResponse.json({ error: `action must be one of ${VALID_ACTIONS.join(', ')}` }, { status: 400 });
  }

  if (body.action === 'sellAll') {
    // One-shot trigger - independent of pause/stop/run state. The worker
    // polls for this every ~2s and force-closes every tracked position.
    requestSellAll();
    return NextResponse.json({ status: 'sellAll requested' });
  }

  const stateMap: Record<Exclude<Action, 'sellAll'>, WorkerControlState> = {
    pause: 'paused',
    start: 'running',
    stop: 'stopped',
  };
  const newState = stateMap[body.action as Exclude<Action, 'sellAll'>];
  setWorkerControlState(newState);
  return NextResponse.json({ state: newState });
}
