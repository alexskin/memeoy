import { NextResponse } from 'next/server';
import { getActiveConfigVersion, insertConfigVersion } from '../../../lib/db';
import { StrategyConfig } from '../../../lib/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ activeVersion: getActiveConfigVersion() });
}

// Manual override: creates and applies a brand-new version (append-only
// history - see plan section on strategy_config_versions).
export async function POST(request: Request) {
  const body = (await request.json()) as { config: StrategyConfig; rationale?: string };
  const current = getActiveConfigVersion();
  const version = insertConfigVersion(
    body.config,
    'user',
    current.id,
    body.rationale ?? 'Manual edit via dashboard',
    true,
  );
  return NextResponse.json({ version });
}
