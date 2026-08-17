'use client';
// A standalone feed of the agent's actual buy/skip judgments (agent_decisions),
// independent of the Watcher tab's pools list. That list is capped at the
// most recent 200 detections and churns fast on a busy watchlist, so a
// decision from even 20-30 minutes ago (especially a 'skip' - it never
// becomes a position, so it appears nowhere else in the app) can already
// have scrolled out of view there. This reads the decisions themselves,
// oldest-evicted-first, so "why did/didn't it buy X" stays answerable.
import { AgentDecisionDetailed } from '../../lib/types';
import { CopyableCA } from './CopyableCA';

export function DecisionLog({ decisions }: { decisions: AgentDecisionDetailed[] }) {
  if (decisions.length === 0) {
    return <div className="empty">No AI decisions yet - waiting on a candidate to clear the momentum or revival gate.</div>;
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Venue</th>
          <th>Mint</th>
          <th>Decision</th>
        </tr>
      </thead>
      <tbody>
        {decisions.map((d) => (
          <tr key={d.id}>
            <td>{new Date(d.checkedAt).toLocaleTimeString()}</td>
            <td><span className="badge neutral">{d.venue}</span></td>
            <td><CopyableCA address={d.baseMint} /></td>
            <td className="reason-cell">
              <span className={`badge ${d.action === 'buy' ? 'ok' : 'pending'}`}>
                {d.action.toUpperCase()} {(d.confidence * 100).toFixed(0)}%
              </span>
              <div className="reason-text">
                {d.reasoning} <span className="reason-source">({d.source})</span>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
