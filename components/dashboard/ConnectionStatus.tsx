'use client';

export function ConnectionStatus({
  wsConnected,
  workerAlive,
  virtualBalance,
}: {
  wsConnected: boolean;
  workerAlive: boolean | null;
  virtualBalance: number | null;
}) {
  return (
    <div style={{ display: 'flex', gap: 20, alignItems: 'center', fontFamily: 'var(--mono)', fontSize: 11.5 }}>
      <span>
        <span className={`dot ${wsConnected ? 'on' : 'off'}`} />
        Dashboard link {wsConnected ? 'connected' : 'disconnected'}
      </span>
      <span>
        <span className={`dot ${workerAlive ? 'on' : 'off'}`} />
        Worker {workerAlive ? 'alive' : workerAlive === null ? 'unknown' : 'not responding'}
      </span>
      {virtualBalance !== null && <span style={{ color: 'var(--muted)' }}>Balance: {virtualBalance.toFixed(4)}</span>}
    </div>
  );
}
