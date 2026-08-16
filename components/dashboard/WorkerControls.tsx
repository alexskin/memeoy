'use client';
import { useState } from 'react';

export type WorkerControlState = 'running' | 'paused' | 'stopped';

export function WorkerControls({
  state,
  onRefresh,
}: {
  state: WorkerControlState;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmSellAll, setConfirmSellAll] = useState(false);

  const act = async (action: 'pause' | 'start' | 'stop' | 'sellAll') => {
    setBusy(action);
    try {
      await fetch('/api/control', { method: 'POST', body: JSON.stringify({ action }) });
      await onRefresh();
    } finally {
      setBusy(null);
      setConfirmSellAll(false);
    }
  };

  const btn = (
    label: string,
    action: 'pause' | 'start' | 'stop' | 'sellAll',
    active: boolean,
    variant?: 'accept' | 'reject',
  ) => (
    <button
      className={`action ${variant ?? ''} ${active ? 'active-control' : ''}`}
      disabled={busy !== null}
      onClick={() => (action === 'sellAll' ? setConfirmSellAll(true) : act(action))}
      style={active ? { outline: '1px solid var(--gold)' } : undefined}
    >
      {busy === action ? '…' : label}
    </button>
  );

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      {btn('PAUSE', 'pause', state === 'paused')}
      {btn('SELL ALL', 'sellAll', false, 'reject')}
      {btn('STOP', 'stop', state === 'stopped', 'reject')}
      {btn('START', 'start', state === 'running', 'accept')}

      {confirmSellAll && (
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--short)', marginLeft: 4 }}>
          Really sell everything right now?
          <button className="action reject" style={{ marginLeft: 6 }} onClick={() => act('sellAll')}>
            Yes, sell everything
          </button>
          <button className="action" style={{ marginLeft: 4 }} onClick={() => setConfirmSellAll(false)}>
            Cancel
          </button>
        </span>
      )}
    </div>
  );
}
