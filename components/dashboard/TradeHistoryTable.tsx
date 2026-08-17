'use client';
import { PartialExit, Position, SimulatedFill } from '../../lib/types';
import { CopyableCA } from './CopyableCA';

export interface TradeRow extends Position {
  entryFill: SimulatedFill | null;
  exitFill: SimulatedFill | null;
  partialExits: PartialExit[];
}

const STATUS_LABEL: Record<string, string> = {
  closed_tp: 'take profit',
  closed_sl: 'stop loss',
  closed_timeout: 'timeout',
  closed_manual: 'manual',
  closed_ai_exit: 'AI exit',
};

function formatMc(mc: number | null): string {
  if (mc == null) return '—';
  return `$${mc.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export function TradeHistoryTable({ trades }: { trades: TradeRow[] }) {
  if (trades.length === 0) {
    return <div className="empty">No closed trades yet.</div>;
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Closed</th>
          <th>Exit reason</th>
          <th>Token</th>
          <th>Base mint</th>
          <th>Entry MC</th>
          <th>Exit MC</th>
          <th>Price impact</th>
          <th>Legs</th>
          <th>Venue</th>
          <th>P&L</th>
        </tr>
      </thead>
      <tbody>
        {trades.map((t) => {
          const pnlPct = t.realizedPnlPct ?? 0;
          const impact = ((t.entryFill?.priceImpactPct ?? 0) + (t.exitFill?.priceImpactPct ?? 0)) / 2;
          return (
            <tr key={t.id}>
              <td>{t.closedAt ? new Date(t.closedAt).toLocaleTimeString() : '—'}</td>
              <td className="reason-cell">
                <span className="badge neutral">{STATUS_LABEL[t.status] ?? t.status}</span>
                {t.aiExitReasoning && <div className="reason-text">{t.aiExitReasoning}</div>}
              </td>
              <td>{t.tokenName ?? '—'}</td>
              <td><CopyableCA address={t.baseMint} /></td>
              <td>{formatMc(t.entryMarketCapUsd)}</td>
              <td>{formatMc(t.exitMarketCapUsd)}</td>
              <td className={impact <= 0 ? 'pos' : 'neg'}>{impact.toFixed(2)}%</td>
              <td>
                {t.partialExits.length > 0 ? (
                  <span
                    className="badge ok"
                    title={t.partialExits.map((e) => `${e.reason}${e.targetPct ? ` @+${e.targetPct}%` : ''}: ${e.realizedPnlQuote.toFixed(4)}`).join(', ')}
                  >
                    {t.partialExits.length}
                  </span>
                ) : (
                  '—'
                )}
              </td>
              <td><span className="badge neutral">{t.source}</span></td>
              <td className={pnlPct >= 0 ? 'pos' : 'neg'}>
                {pnlPct >= 0 ? '+' : ''}
                {pnlPct.toFixed(1)}%
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
