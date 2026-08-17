'use client';
// Alerts (never trades) when a tracked wallet CREATES a brand-new pump.fun
// token - distinct from WalletAlerts.tsx, which watches for the same
// wallets BUYING an existing token.
import { CreatorLaunch } from '../../lib/types';
import { CopyableCA } from './CopyableCA';

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

export function CreatorLaunchLog({ launches, trackedAddresses }: { launches: CreatorLaunch[]; trackedAddresses: string[] }) {
  // Only the last 2h - recency is the point here ("who's launching right
  // now"), not a full history. Already newest-first: the API orders by
  // detected_at DESC and the live WS handler prepends new ones.
  const cutoff = Date.now() - TWO_HOURS_MS;
  const recentLaunches = launches.filter((l) => l.detectedAt >= cutoff);

  return (
    <div>
      <div style={{ marginBottom: 12, fontSize: 11.5, color: 'var(--muted)' }}>
        Watching {trackedAddresses.length} wallet{trackedAddresses.length === 1 ? '' : 's'}
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
  );
}
