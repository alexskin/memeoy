import { NextResponse } from 'next/server';
import { getActiveConfigVersion, isReadOnlyDeployment } from '../../../lib/dbRead';
import { insertConfigVersion } from '../../../lib/db';
import { StrategyConfig } from '../../../lib/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ activeVersion: await getActiveConfigVersion() });
}

// Manual override: creates and applies a brand-new version (append-only
// history - see plan section on strategy_config_versions). Disabled on the
// public read-only deployment (NEXT_PUBLIC_READ_ONLY=true, Vercel-only) -
// writes only ever happen against the local worker's DB, never against the
// Turso mirror.
export async function POST(request: Request) {
  if (isReadOnlyDeployment()) {
    return NextResponse.json({ error: 'read-only' }, { status: 403 });
  }
  const body = (await request.json()) as { config: StrategyConfig; rationale?: string };
  const currentVersion = await getActiveConfigVersion();
  const version = insertConfigVersion(
    body.config,
    'user',
    currentVersion.id,
    body.rationale ?? 'Manual edit via dashboard',
    true,
  );
  return NextResponse.json({ version });
}
