'use client';
// Alerts (never trades) when a tracked wallet CREATES a brand-new pump.fun
// token - distinct from WalletAlerts.tsx, which watches for the same
// wallets BUYING an existing token.
import { CreatorLaunch } from '../../lib/types';
import { CopyableCA } from './CopyableCA';

export function CreatorLaunchLog({ launches }: { launches: CreatorLaunch[] }) {
  if (launches.length === 0) {
    return <div className="empty">No launches yet from a tracked creator wallet.</div>;
  }

  return (
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
  );
}
