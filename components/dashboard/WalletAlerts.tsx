'use client';
import { useState } from 'react';
import { StrategyConfig, WalletAlert } from '../../lib/types';

const NEW_ALERT_WINDOW_MS = 5 * 60_000;

export function WalletAlerts({
  alerts,
  config,
  onSave,
  readOnly,
}: {
  alerts: WalletAlert[];
  config: StrategyConfig;
  onSave: (config: StrategyConfig) => Promise<void>;
  readOnly?: boolean;
}) {
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  const addWallet = async () => {
    const trimmed = address.trim();
    if (!trimmed || config.trackedWallets.some((w) => w.address === trimmed)) return;
    setBusy(true);
    try {
      await onSave({ ...config, trackedWallets: [...config.trackedWallets, { address: trimmed, label: label.trim() }] });
      setAddress('');
      setLabel('');
    } finally {
      setBusy(false);
    }
  };

  const removeWallet = async (addr: string) => {
    setBusy(true);
    try {
      await onSave({ ...config, trackedWallets: config.trackedWallets.filter((w) => w.address !== addr) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="panel" style={{ margin: '0 0 16px' }}>
        <h2>Tracked wallets</h2>
        {!readOnly && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <input
              type="text"
              placeholder="Wallet address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              style={{ flex: '2 1 260px', width: 'auto' }}
            />
            <input
              type="text"
              placeholder="Label (optional)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              style={{ flex: '1 1 140px', width: 'auto' }}
            />
            <button className="action accept" disabled={busy || !address.trim()} onClick={addWallet}>
              Add wallet
            </button>
          </div>
        )}

        {config.trackedWallets.length === 0 ? (
          <div className="empty">No wallets tracked yet - add one above to get advisory alerts whenever it buys something.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Label</th>
                <th>Address</th>
                {!readOnly && <th></th>}
              </tr>
            </thead>
            <tbody>
              {config.trackedWallets.map((w) => (
                <tr key={w.address}>
                  <td>{w.label || '—'}</td>
                  <td style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{w.address}</td>
                  {!readOnly && (
                    <td>
                      <button className="action reject" disabled={busy} onClick={() => removeWallet(w.address)}>
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {alerts.length === 0 ? (
        <div className="empty">
          No alerts yet - a row only appears here once a tracked wallet actually buys something. This never opens a
          position automatically, it's a suggestion only.
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Detected</th>
              <th>Token (CA)</th>
              <th>Venue</th>
              <th>They bought (SOL)</th>
              <th>Suggested SL</th>
              <th>Suggested TP1</th>
              <th>Trailing activation</th>
              <th>Trailing stop</th>
              <th>Max hold</th>
            </tr>
          </thead>
          <tbody>
            {alerts.map((a) => {
              const isNew = Date.now() - a.detectedAt < NEW_ALERT_WINDOW_MS;
              return (
                <tr key={a.id}>
                  <td>
                    {isNew && (
                      <span className="badge ok" style={{ marginRight: 6 }}>
                        NEW
                      </span>
                    )}
                    {new Date(a.detectedAt).toLocaleTimeString()}
                  </td>
                  <td style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{a.mint}</td>
                  <td>
                    <span className="badge neutral">{a.venue ?? '—'}</span>
                  </td>
                  <td>{a.buySolAmount != null ? a.buySolAmount.toFixed(4) : '—'}</td>
                  <td className="neg">-{a.suggestedStopLossPct}%</td>
                  <td className="pos">+{a.suggestedTarget1Pct}%</td>
                  <td>+{a.suggestedTarget2Pct}%</td>
                  <td>-{a.suggestedTrailingStopPct}pt from peak</td>
                  <td>{a.suggestedMaxHoldMinutes} min</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
