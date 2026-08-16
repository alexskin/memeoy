'use client';
import { AgentSuggestion } from '../../lib/types';

function formatDiffValue(value: unknown): string {
  if (value === null || typeof value !== 'object') return String(value);
  return JSON.stringify(value); // e.g. takeProfitTargets is an array of {pct, sellFraction}
}

export function AgentLog({
  suggestions,
  onAccept,
  onReject,
}: {
  suggestions: AgentSuggestion[];
  onAccept: (id: number) => Promise<void>;
  onReject: (id: number) => Promise<void>;
}) {
  if (suggestions.length === 0) {
    return (
      <div className="empty">
        No agent suggestions yet - the tuner needs at least a handful of closed trades before it proposes anything.
      </div>
    );
  }

  return (
    <div>
      {suggestions.map((s) => (
        <div key={s.id} className="panel" style={{ margin: '0 0 12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="badge neutral">{s.source}</span>
            <span
              className={`badge ${s.status === 'applied' ? 'ok' : s.status === 'rejected' ? 'fail' : 'pending'}`}
            >
              {s.status}
            </span>
          </div>
          <p className="rationale">{s.rationale}</p>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted)', marginBottom: 10 }}>
            {Object.entries(s.diff).map(([key, change]) => (
              <div key={key}>
                {key}: {formatDiffValue((change as any).old)} → {formatDiffValue((change as any).new)}
              </div>
            ))}
          </div>
          {s.status === 'proposed' && (
            <div>
              <button className="action accept" onClick={() => onAccept(s.id)}>
                Accept
              </button>
              <button className="action reject" style={{ marginLeft: 8 }} onClick={() => onReject(s.id)}>
                Reject
              </button>
            </div>
          )}
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--muted-2)', marginTop: 8 }}>
            {new Date(s.createdAt).toLocaleString()}
          </div>
        </div>
      ))}
    </div>
  );
}
