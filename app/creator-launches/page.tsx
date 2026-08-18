'use client';
// Deliberately NOT linked from the main dashboard's tab nav (app/page.tsx)
// - a standalone, unlisted route, reachable only via direct URL. Alerts
// (never trades) when a tracked wallet CREATES a brand-new pump.fun token;
// see lib/pumpfun/createEventDecoder.ts + scripts/worker.ts's
// handleCreatorTracking for how the alert actually fires (also posts to
// Discord).
import { useCallback, useEffect, useState } from 'react';
import { useWorkerSocket, WorkerMessage } from '../../lib/ws/client';
import { CreatorLaunch } from '../../lib/types';
import { CopyableCA } from '../../components/dashboard/CopyableCA';

const WS_PORT = Number(process.env.NEXT_PUBLIC_WORKER_WS_PORT ?? 8787);
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

export default function CreatorLaunchesPage() {
  const [launches, setLaunches] = useState<CreatorLaunch[]>([]);
  const [trackedCount, setTrackedCount] = useState<number | null>(null);
  const [trackedAddresses, setTrackedAddresses] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    const [launchesRes, configRes] = await Promise.all([
      fetch('/api/creator-launches').then((r) => r.json()),
      fetch('/api/config').then((r) => r.json()),
    ]);
    setLaunches(launchesRes.launches);
    const tracked: string[] = configRes.activeVersion?.config?.trackedCreators ?? [];
    setTrackedAddresses(tracked);
    setTrackedCount(tracked.length);
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const onMessage = useCallback((msg: WorkerMessage) => {
    if (msg.event === 'creator.launch') {
      const launch = msg.payload as CreatorLaunch;
      setLaunches((prev) => [launch, ...prev].slice(0, 100));
    }
  }, []);

  const { connected } = useWorkerSocket(WS_PORT, onMessage);

  const cutoff = Date.now() - TWO_HOURS_MS;
  const recentLaunches = launches.filter((l) => l.detectedAt >= cutoff);

  return (
    <div className="wrap">
      <div className="header">
        <div>
          <div className="eyebrow">Paper trading · no real funds</div>
          <h1 className="title">Creator Launches</h1>
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>
          {connected ? 'live' : 'polling'}
        </div>
      </div>

      <div className="panel">
        <h2>Tracked creator launches — last 2h</h2>
        <div style={{ marginBottom: 12, fontSize: 11.5, color: 'var(--muted)' }}>
          Watching {trackedCount ?? '…'} wallet{trackedCount === 1 ? '' : 's'}
          {trackedAddresses.length > 0 && (
            <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {trackedAddresses.map((a) => (
                <span key={a} className="badge neutral">
                  <CopyableCA address={a} />
                </span>
              ))}
            </div>
          )}
        </div>
        {recentLaunches.length === 0 ? (
          <div className="empty">No launches from a tracked creator wallet in the last 2 hours.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Detected</th>
                <th>Creator</th>
                <th>Token</th>
                <th>Mint</th>
              </tr>
            </thead>
            <tbody>
              {recentLaunches.map((l) => (
                <tr key={l.id}>
                  <td>{new Date(l.detectedAt).toLocaleString()}</td>
                  <td><CopyableCA address={l.creatorAddress} /></td>
                  <td>{l.name} <span className="badge neutral">{l.symbol}</span></td>
                  <td><CopyableCA address={l.mint} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
