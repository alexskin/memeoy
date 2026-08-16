'use client';
import { useMemo, useState } from 'react';
import { PartialExit, Position } from '../../lib/types';
import { CopyableCA } from './CopyableCA';

function formatMc(mc: number | null): string {
  if (mc == null) return '—';
  return `$${mc.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export interface LivePositionInfo {
  markPrice?: number;
  unrealizedPnlQuote?: number;
  unrealizedPnlPct?: number;
  peakProfitPct?: number;
  exitPending?: boolean;
}

export interface PositionRow extends Position {
  partialExits: PartialExit[];
}

const PEAK_UNSET = -1000; // mirrors lib/types.ts PEAK_PROFIT_UNSET
type SortDir = 'asc' | 'desc' | null;

export function PositionsTable({ positions, live }: { positions: PositionRow[]; live: Record<number, LivePositionInfo> }) {
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const rows = useMemo(() => {
    const withPnl = positions.map((p) => ({ p, pnlPct: live[p.id]?.unrealizedPnlPct }));
    if (!sortDir) return withPnl;

    return [...withPnl].sort((a, b) => {
      // Positions without a live reading yet always sort to the bottom, regardless of direction.
      if (a.pnlPct === undefined && b.pnlPct === undefined) return 0;
      if (a.pnlPct === undefined) return 1;
      if (b.pnlPct === undefined) return -1;
      return sortDir === 'desc' ? b.pnlPct - a.pnlPct : a.pnlPct - b.pnlPct;
    });
  }, [positions, live, sortDir]);

  const cycleSort = () => setSortDir((d) => (d === 'desc' ? 'asc' : d === 'asc' ? null : 'desc'));
  const sortArrow = sortDir === 'desc' ? ' ▼' : sortDir === 'asc' ? ' ▲' : '';

  if (positions.length === 0) {
    return <div className="empty">No open positions.</div>;
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Opened</th>
          <th>Venue</th>
          <th>Token</th>
          <th>Base mint</th>
          <th>Entry price</th>
          <th>Mark price</th>
          <th>Entry MC</th>
          <th>Size (quote)</th>
          <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={cycleSort} title="Click to sort by unrealized P&L">
            Unrealized P&L{sortArrow}
          </th>
          <th>Peak P&L</th>
          <th>Targets</th>
          <th>TP / SL</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ p, pnlPct }) => {
          const info = live[p.id] ?? {};
          const peakPct = info.peakProfitPct ?? (p.peakProfitPct > PEAK_UNSET ? p.peakProfitPct : undefined);
          return (
            <tr key={p.id}>
              <td>{new Date(p.openedAt).toLocaleTimeString()}</td>
              <td><span className="badge neutral">{p.source}</span></td>
              <td>{p.tokenName ?? '—'}</td>
              <td><CopyableCA address={p.baseMint} /></td>
              <td>{p.entryPrice.toPrecision(6)}</td>
              <td>{info.markPrice ? info.markPrice.toPrecision(6) : '—'}</td>
              <td>{formatMc(p.entryMarketCapUsd)}</td>
              <td>{Number(p.quoteSizeIn).toFixed(4)}</td>
              <td className={pnlPct === undefined ? '' : pnlPct >= 0 ? 'pos' : 'neg'}>
                {pnlPct === undefined ? '—' : `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`}
                {info.exitPending && <span className="badge pending" style={{ marginLeft: 6 }}>exit pending</span>}
              </td>
              <td className={peakPct === undefined ? '' : peakPct >= 0 ? 'pos' : 'neg'}>
                {peakPct === undefined ? '—' : `${peakPct >= 0 ? '+' : ''}${peakPct.toFixed(1)}%`}
              </td>
              <td>
                {p.partialExits.length > 0 ? (
                  <span className="badge ok" title={p.partialExits.map((e) => `+${e.targetPct}% -> ${e.realizedPnlQuote.toFixed(4)}`).join(', ')}>
                    {p.partialExits.length} fired
                  </span>
                ) : (
                  '—'
                )}
              </td>
              <td>
                +{p.takeProfitPctSnapshot}% / -{p.stopLossPctSnapshot}%
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
