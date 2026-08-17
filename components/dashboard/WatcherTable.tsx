'use client';
// The AI-watcher centerpiece - supersedes PoolFeed.tsx + WatchlistTable.tsx.
// One row per detected pool, its whole lifecycle in one place: filters ->
// momentum -> revival -> degen score -> decision -> outcome. Color buckets
// for revival strength (weak<60/moderate/strong>=85) and degen score
// (<40/40-70/>=70) match the same boundaries lib/agent/stats.ts's
// summarizeRecentPerformanceBySignal() uses, so the UI and the agent's own
// "learning" read the signals the same way.
import { AgentDecision, DetectedPool, FilterOutcome, MomentumSnapshot } from '../../lib/types';
import { CopyableCA } from './CopyableCA';

export interface WatcherRow extends DetectedPool {
  filterResults: FilterOutcome[];
  latestMomentumSnapshot: MomentumSnapshot | null;
  latestAgentDecision: AgentDecision | null;
}

const STATUS_BADGE: Record<string, string> = {
  pending: 'neutral',
  filtering: 'pending',
  passed: 'ok',
  rejected: 'fail',
  bought: 'ok',
  skipped: 'neutral',
  watching: 'pending',
};

const VENUE_BADGE: Record<string, string> = {
  raydium: 'neutral',
  pumpfun: 'pending',
  pumpswap: 'ok',
};

function ageMinutesLabel(detectedAt: number): string {
  const minutes = (Date.now() - detectedAt) / 60_000;
  return minutes < 60 ? `${minutes.toFixed(0)}m` : `${(minutes / 60).toFixed(1)}h`;
}

function latestPerFilter(results: FilterOutcome[]) {
  const byFilter = new Map<string, FilterOutcome>();
  for (const r of results) byFilter.set(r.filterName, r);
  return Array.from(byFilter.values());
}

function revivalBadgeClass(strength: number): string {
  if (strength >= 85) return 'ok';
  if (strength >= 60) return 'pending';
  return 'fail';
}

function degenBadgeClass(score: number): string {
  if (score >= 70) return 'ok';
  if (score >= 40) return 'pending';
  return 'fail';
}

export function WatcherTable({ rows }: { rows: WatcherRow[] }) {
  if (rows.length === 0) {
    return <div className="empty">No pools detected yet - waiting on live Raydium and PumpSwap launches.</div>;
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Detected</th>
          <th>Age</th>
          <th>Venue</th>
          <th>Mint</th>
          <th>Filters</th>
          <th>Momentum</th>
          <th>Revival</th>
          <th>Degen</th>
          <th>Decision</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const m = r.latestMomentumSnapshot;
          const d = r.latestAgentDecision;
          const failingMomentum = m?.hasData ? m.criteria.filter((c) => !c.ok) : [];

          return (
            <tr key={r.id}>
              <td>{new Date(r.detectedAt).toLocaleTimeString()}</td>
              <td>{ageMinutesLabel(r.detectedAt)}</td>
              <td><span className={`badge ${VENUE_BADGE[r.source] ?? 'neutral'}`}>{r.source}</span></td>
              <td><CopyableCA address={r.baseMint} /></td>
              <td>
                {latestPerFilter(r.filterResults).map((f) => (
                  <span key={f.filterName} className={`badge ${f.pass ? 'ok' : 'fail'}`} title={f.message} style={{ marginRight: 4 }}>
                    {f.filterName}
                  </span>
                ))}
              </td>
              <td>
                {!m ? (
                  <span className="badge neutral">waiting</span>
                ) : !m.hasData ? (
                  <span className="badge pending">not indexed</span>
                ) : m.pass ? (
                  <span className="badge ok">pass</span>
                ) : (
                  <span className="badge fail" title={failingMomentum.map((c) => c.message).join('; ')}>
                    fail ({failingMomentum.length})
                  </span>
                )}
              </td>
              <td>
                {!d ? (
                  <span className="badge neutral">—</span>
                ) : (
                  <span className={`badge ${revivalBadgeClass(d.revivalStrength)}`} title={d.revivalPass ? 'revival pattern matched' : 'revival pattern not matched'}>
                    {d.revivalPass ? 'pass' : 'no'} {d.revivalStrength}
                  </span>
                )}
              </td>
              <td>
                {!d || d.degenScore == null ? (
                  <span className="badge neutral">—</span>
                ) : (
                  <span className={`badge ${degenBadgeClass(d.degenScore)}`} title={d.degenVerdict ?? undefined}>
                    {d.degenScore}
                  </span>
                )}
              </td>
              <td className="reason-cell">
                {!d ? (
                  <span className="badge neutral">pending</span>
                ) : (
                  <>
                    <span className={`badge ${d.action === 'buy' ? 'ok' : 'pending'}`}>
                      {d.action.toUpperCase()} {(d.confidence * 100).toFixed(0)}%
                    </span>
                    <div className="reason-text">
                      {d.reasoning} <span className="reason-source">({d.source})</span>
                    </div>
                  </>
                )}
              </td>
              <td>
                <span className={`badge ${STATUS_BADGE[r.status] ?? 'neutral'}`}>{r.status}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
