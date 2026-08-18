'use client';
// Deliberately NOT linked from the main dashboard's tab nav (app/page.tsx)
// - a standalone, unlisted route, reachable only via direct URL. Alerts
// (never trades) when a tracked wallet CREATES a brand-new pump.fun token;
// see lib/pumpfun/createEventDecoder.ts + scripts/worker.ts's
// handleCreatorTracking for how the alert actually fires (also posts to
// Discord).
import { useCallback, useEffect, useState } from 'react';
import { useWorkerSocket, WorkerMessage } from '../../lib/ws/client';
import { BurnAlert, CreatorLaunch } from '../../lib/types';
import { CopyableCA } from '../../components/dashboard/CopyableCA';

const WS_PORT = Number(process.env.NEXT_PUBLIC_WORKER_WS_PORT ?? 8787);

export default function CreatorLaunchesPage() {
  const [launches, setLaunches] = useState<CreatorLaunch[]>([]);
  const [trackedCount, setTrackedCount] = useState<number | null>(null);
  const [trackedAddresses, setTrackedAddresses] = useState<string[]>([]);
  const [burnAlerts, setBurnAlerts] = useState<BurnAlert[]>([]);
  const [trackedBurnMints, setTrackedBurnMints] = useState<{ mint: string; thresholdTokens: number }[]>([]);

  const refresh = useCallback(async () => {
    // Full history, not windowed - alerts are rare (only fires for a
    // tracked wallet's own creations, no volume concern), so there's no
    // reason to hide older ones.
    const [launchesRes, configRes, burnAlertsRes] = await Promise.all([
      fetch('/api/creator-launches?limit=1000').then((r) => r.json()),
      fetch('/api/config').then((r) => r.json()),
      fetch('/api/burn-alerts?limit=1000').then((r) => r.json()),
    ]);
    setLaunches(launchesRes.launches);
    const tracked: string[] = configRes.activeVersion?.config?.trackedCreators ?? [];
    setTrackedAddresses(tracked);
    setTrackedCount(tracked.length);
    setTrackedBurnMints(configRes.activeVersion?.config?.trackedBurnMints ?? []);
    setBurnAlerts(burnAlertsRes.alerts);
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const onMessage = useCallback((msg: WorkerMessage) => {
    if (msg.event === 'creator.launch') {
      const launch = msg.payload as CreatorLaunch;
      setLaunches((prev) => [launch, ...prev].slice(0, 1000));
    }
    if (msg.event === 'burn.alert') {
      const alert = msg.payload as BurnAlert;
      setBurnAlerts((prev) => [alert, ...prev].slice(0, 1000));
    }
    if (msg.event === 'burn.alert.update') {
      const { id, burners } = msg.payload as { id: number; burners: BurnAlert['burners'] };
      setBurnAlerts((prev) => prev.map((b) => (b.id === id ? { ...b, burners } : b)));
    }
  }, []);

  const { connected } = useWorkerSocket(WS_PORT, onMessage);

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
        <h2>Tracked creator launches</h2>
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
        {launches.length === 0 ? (
          <div className="empty">No launches from a tracked creator wallet yet.</div>
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
              {launches.map((l) => (
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

      <div className="panel">
        <h2>Large burns</h2>
        <div style={{ marginBottom: 12, fontSize: 11.5, color: 'var(--muted)' }}>
          Watching {trackedBurnMints.length} mint{trackedBurnMints.length === 1 ? '' : 's'}
          {trackedBurnMints.length > 0 && (
            <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {trackedBurnMints.map((t) => (
                <span key={t.mint} className="badge neutral" title={`threshold: ${t.thresholdTokens.toLocaleString('en-US')} tokens`}>
                  <CopyableCA address={t.mint} />
                </span>
              ))}
            </div>
          )}
        </div>
        {burnAlerts.length === 0 ? (
          <div className="empty">No large burns detected yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Detected</th>
                <th>Mint</th>
                <th>Burned</th>
                <th>Supply after</th>
                <th>Burner</th>
              </tr>
            </thead>
            <tbody>
              {burnAlerts.map((b) => (
                <tr key={b.id}>
                  <td>{new Date(b.detectedAt).toLocaleString()}</td>
                  <td><CopyableCA address={b.mint} /></td>
                  <td className="pos">{b.burnedAmount.toLocaleString('en-US', { maximumFractionDigits: 0 })}</td>
                  <td>{b.supplyAfter.toLocaleString('en-US', { maximumFractionDigits: 0 })}</td>
                  <td>
                    {!b.burners || b.burners.length === 0 ? (
                      <span style={{ color: 'var(--muted)' }}>looking up…</span>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {b.burners.map((burner) => (
                          <div key={burner.address} title={`${burner.amount.toLocaleString('en-US', { maximumFractionDigits: 0 })} token`}>
                            <CopyableCA address={burner.address} />
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
