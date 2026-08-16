'use client';
// Glanceable top-of-page summary - uses the .stat/.grid-4 CSS classes that
// existed in globals.css but no component used yet. Computed client-side
// from state the page already fetches, no new endpoint.
import { WatcherRow } from './WatcherTable';

function isToday(ts: number): boolean {
  const d = new Date(ts);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

export function StatsStrip({
  openPositionsCount,
  pools,
  virtualBalance,
}: {
  openPositionsCount: number;
  pools: WatcherRow[];
  virtualBalance: number | null;
}) {
  const watchingNow = pools.filter((p) => p.status === 'watching').length;

  let buysToday = 0;
  let skipsToday = 0;
  for (const p of pools) {
    const d = p.latestAgentDecision;
    if (!d || !isToday(d.checkedAt)) continue;
    if (d.action === 'buy') buysToday++;
    else skipsToday++;
  }

  return (
    <div className="grid grid-4" style={{ marginBottom: 16 }}>
      <div className="stat">
        <div className="label">Open positions</div>
        <div className="value">{openPositionsCount}</div>
      </div>
      <div className="stat">
        <div className="label">Watching now</div>
        <div className="value">{watchingNow}</div>
      </div>
      <div className="stat">
        <div className="label">Decisions today</div>
        <div className="value">
          <span className="pos">{buysToday} buy</span> / <span className="neg">{skipsToday} skip</span>
        </div>
      </div>
      <div className="stat">
        <div className="label">Balance</div>
        <div className="value">{virtualBalance != null ? virtualBalance.toFixed(4) : '—'}</div>
      </div>
    </div>
  );
}
