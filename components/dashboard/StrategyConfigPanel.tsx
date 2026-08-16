'use client';
import { useState } from 'react';
import { StrategyConfig, StrategyConfigVersion } from '../../lib/types';

const EDITABLE_FIELDS: { key: keyof StrategyConfig; label: string; type: 'number' | 'select' }[] = [
  { key: 'tradingMode', label: 'Trading mode (paper = simulated, live = real funds)', type: 'select' },
  { key: 'positionSizeMode', label: 'Position size mode', type: 'select' },
  { key: 'positionSizeValue', label: 'Position size value', type: 'number' },
  { key: 'buySlippagePct', label: 'Buy slippage %', type: 'number' },
  { key: 'sellSlippagePct', label: 'Sell slippage %', type: 'number' },
  { key: 'exitStrategy', label: 'Exit strategy', type: 'select' },
  { key: 'takeProfitPct', label: 'Take profit % (fixed mode)', type: 'number' },
  { key: 'trailingActivationPct', label: 'Trailing activation %', type: 'number' },
  { key: 'trailingStopPct', label: 'Trailing stop (pts from peak)', type: 'number' },
  { key: 'stopLossPct', label: 'Stop loss % (hard floor)', type: 'number' },
  { key: 'minPoolSizeQuote', label: 'Min pool size (quote)', type: 'number' },
  { key: 'maxPoolSizeQuote', label: 'Max pool size (quote)', type: 'number' },
  { key: 'consecutiveFilterMatches', label: 'Consecutive filter matches', type: 'number' },
  { key: 'checkHolderConcentration', label: 'Check holder concentration', type: 'select' },
  { key: 'momentumMaxTopHolderPct', label: 'Max top holder %', type: 'number' },
  { key: 'checkInsiderConcentration', label: 'Check insider concentration', type: 'select' },
  { key: 'momentumMaxInsiderPct', label: 'Max insider % (top 20)', type: 'number' },
  { key: 'momentumMaxInsiderWalletCount', label: 'Max insider wallet count', type: 'number' },
  { key: 'momentumEnabled', label: 'Momentum watchlist enabled', type: 'select' },
  { key: 'momentumMinLiquidityUsd', label: 'Min liquidity ($)', type: 'number' },
  { key: 'momentumMinAgeMinutes', label: 'Min age (minutes)', type: 'number' },
  { key: 'momentumMaxAgeMinutes', label: 'Max age (minutes)', type: 'number' },
  { key: 'momentumMin1hBuys', label: 'Min 1h buys', type: 'number' },
  { key: 'momentumMin5mBuys', label: 'Min 5m buys', type: 'number' },
  { key: 'momentumMin24hVolumeUsd', label: 'Min 24h volume ($)', type: 'number' },
  { key: 'momentumMin24hChangePct', label: 'Min 24h change %', type: 'number' },
  { key: 'momentumMax24hChangePct', label: 'Max 24h change %', type: 'number' },
  { key: 'momentumMin1hChangePct', label: 'Min 1h change %', type: 'number' },
  { key: 'momentumPollIntervalMs', label: 'Watchlist poll interval (ms)', type: 'number' },
  { key: 'momentumMaxWatchlistSize', label: 'Max watchlist size', type: 'number' },
  { key: 'executionMode', label: 'Execution mode', type: 'select' },
  { key: 'maxConcurrentPositions', label: 'Max concurrent positions', type: 'number' },
  { key: 'agentMode', label: 'Agent mode', type: 'select' },
];

const SELECT_OPTIONS: Record<string, string[]> = {
  tradingMode: ['paper', 'live'],
  positionSizeMode: ['fixed', 'pctEquity'],
  executionMode: ['standard', 'priority'],
  agentMode: ['propose-only', 'auto-apply'],
  exitStrategy: ['trailing', 'fixed'],
  checkHolderConcentration: ['true', 'false'],
  checkInsiderConcentration: ['true', 'false'],
  momentumEnabled: ['true', 'false'],
};

const BOOLEAN_FIELDS = new Set(['checkHolderConcentration', 'checkInsiderConcentration', 'momentumEnabled']);

export function StrategyConfigPanel({
  activeVersion,
  history,
  onSave,
  readOnly,
}: {
  activeVersion: StrategyConfigVersion;
  history: StrategyConfigVersion[];
  onSave: (config: StrategyConfig) => Promise<void>;
  readOnly?: boolean;
}) {
  const [draft, setDraft] = useState<StrategyConfig>(activeVersion.config);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(activeVersion.config);

  return (
    <div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 16 }}>
        {EDITABLE_FIELDS.map(({ key, label, type }) => (
          <div className="field" key={key}>
            <label>{label}</label>
            {type === 'select' ? (
              <select
                value={String(draft[key])}
                disabled={readOnly}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    [key]: BOOLEAN_FIELDS.has(key) ? e.target.value === 'true' : e.target.value,
                  } as StrategyConfig)
                }
              >
                {SELECT_OPTIONS[key].map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="number"
                value={draft[key] as number}
                disabled={readOnly}
                onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) } as StrategyConfig)}
              />
            )}
          </div>
        ))}
      </div>

      {!readOnly && (
        <>
          <button
            className="action accept"
            disabled={!dirty || saving}
            onClick={async () => {
              setSaving(true);
              try {
                await onSave(draft);
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? 'Saving…' : 'Save as new version'}
          </button>
          {dirty && (
            <button className="action" style={{ marginLeft: 8 }} onClick={() => setDraft(activeVersion.config)}>
              Reset
            </button>
          )}
        </>
      )}

      <h2 style={{ marginTop: 24 }}>Version history</h2>
      <table>
        <thead>
          <tr>
            <th>Version</th>
            <th>Created</th>
            <th>By</th>
            <th>Rationale</th>
          </tr>
        </thead>
        <tbody>
          {history.map((v) => (
            <tr key={v.id}>
              <td>
                v{v.versionNumber} {v.applied && <span className="badge ok">active</span>}
              </td>
              <td>{new Date(v.createdAt).toLocaleString()}</td>
              <td>{v.createdBy}</td>
              <td>{v.rationale ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
