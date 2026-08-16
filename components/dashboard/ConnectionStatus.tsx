'use client';

// On the public read-only deployment (NEXT_PUBLIC_DISABLE_WS=true, see
// README.md's Vercel section) there's no local worker WS server to reach at
// all, by design - showing "Dashboard link disconnected" there would read
// as broken rather than expected, so that line is skipped entirely. The
// worker-liveness line still shows either way, worded so a genuinely
// offline worker (no RPC access, or just not running) reads as a normal
// status rather than an error.
const WS_DISABLED = process.env.NEXT_PUBLIC_DISABLE_WS === 'true';

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
      {!WS_DISABLED && (
        <span>
          <span className={`dot ${wsConnected ? 'on' : 'off'}`} />
          Dashboard link {wsConnected ? 'connected' : 'disconnected'}
        </span>
      )}
      <span>
        <span className={`dot ${workerAlive ? 'on' : 'off'}`} />
        Worker {workerAlive ? 'alive' : workerAlive === null ? 'checking…' : 'currently offline — no RPC connected'}
      </span>
      {virtualBalance !== null && <span style={{ color: 'var(--muted)' }}>Balance: {virtualBalance.toFixed(4)}</span>}
    </div>
  );
}
