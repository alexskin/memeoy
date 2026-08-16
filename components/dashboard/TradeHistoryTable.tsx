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
          <th>Venue</th>
          <th>Token</th>
          <th>Base mint</th>
          <th>Entry</th>
          <th>Exit</th>
          <th>Entry MC</th>
          <th>Exit MC</th>
          <th>Latency drift</th>
          <th>Price impact</th>
          <th>Latency (ms)</th>
          <th>Fees</th>
          <th>Legs</th>
          <th>Exit reason</th>
          <th>P&L</th>
        </tr>
      </thead>
      <tbody>
        {trades.map((t) => {
          const pnlPct = t.realizedPnlPct ?? 0;
          const latDrift = ((t.entryFill?.latencyDriftPct ?? 0) + (t.exitFill?.latencyDriftPct ?? 0)) / 2;
          const impact = ((t.entryFill?.priceImpactPct ?? 0) + (t.exitFill?.priceImpactPct ?? 0)) / 2;
          const latMs = (t.entryFill?.actualElapsedMs ?? 0) + (t.exitFill?.actualElapsedMs ?? 0);
          const feesQuote = (t.entryFill?.feeQuote ?? 0) + (t.exitFill?.feeQuote ?? 0);
          return (
            <tr key={t.id}>
              <td>{t.closedAt ? new Date(t.closedAt).toLocaleTimeString() : '—'}</td>
              <td><span className="badge neutral">{t.source}</span></td>
              <td>{t.tokenName ?? '—'}</td>
              <td><CopyableCA address={t.baseMint} /></td>
              <td>{t.entryPrice.toPrecision(6)}</td>
              <td>{t.exitPrice ? t.exitPrice.toPrecision(6) : '—'}</td>
              <td>{formatMc(t.entryMarketCapUsd)}</td>
              <td>{formatMc(t.exitMarketCapUsd)}</td>
              <td className={latDrift <= 0 ? 'pos' : 'neg'}>{latDrift.toFixed(2)}%</td>
              <td className={impact <= 0 ? 'pos' : 'neg'}>{impact.toFixed(2)}%</td>
              <td>{latMs}</td>
              <td>{feesQuote.toFixed(5)}</td>
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
              <td>{STATUS_LABEL[t.status] ?? t.status}</td>
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
