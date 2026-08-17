'use client';
import { useCallback, useEffect, useState } from 'react';
import { useWorkerSocket, WorkerMessage } from '../lib/ws/client';
import { AgentDecisionDetailed, AgentSuggestion, CreatorLaunch, DetectedPool, EquitySnapshot, FilterOutcome, MomentumCriterionResult, StrategyConfig, StrategyConfigVersion, WalletAlert } from '../lib/types';
import { WatcherTable, WatcherRow } from '../components/dashboard/WatcherTable';
import { DecisionLog } from '../components/dashboard/DecisionLog';
import { CreatorLaunchLog } from '../components/dashboard/CreatorLaunchLog';
import { StatsStrip } from '../components/dashboard/StatsStrip';
import { PositionsTable, LivePositionInfo, PositionRow } from '../components/dashboard/PositionsTable';
import { TradeHistoryTable, TradeRow } from '../components/dashboard/TradeHistoryTable';
import { EquityChart } from '../components/dashboard/EquityChart';
import { StrategyConfigPanel } from '../components/dashboard/StrategyConfigPanel';
import { AgentLog } from '../components/dashboard/AgentLog';
import { ConnectionStatus } from '../components/dashboard/ConnectionStatus';
import { WorkerControls, WorkerControlState } from '../components/dashboard/WorkerControls';
import { WalletAlerts } from '../components/dashboard/WalletAlerts';

const WS_PORT = Number(process.env.NEXT_PUBLIC_WORKER_WS_PORT ?? 8787);
// Only set to 'true' in the Vercel project's env vars for the public
// read-only deployment (see README.md's "Public read-only dashboard on
// Vercel" section) - a local `npm run dev` never sets this.
const READ_ONLY = process.env.NEXT_PUBLIC_READ_ONLY === 'true';
// Consolidated from the old 8-tab layout (Live/Watchlist/Wallet
// Alerts/Positions/History/Equity/Strategy/Agent) around what's actually a
// different concern, not what table happened to exist: Watcher owns the
// whole detection->decision lifecycle, Portfolio owns "what did the money
// do", Strategy owns the config+tuner feedback loop.
const TABS = ['Watcher', 'Portfolio', 'Strategy', 'Wallet Alerts'] as const;
type Tab = (typeof TABS)[number];

export default function Page() {
  const [tab, setTab] = useState<Tab>('Watcher');

  const [pools, setPools] = useState<WatcherRow[]>([]);
  const [decisions, setDecisions] = useState<AgentDecisionDetailed[]>([]);
  const [creatorLaunches, setCreatorLaunches] = useState<CreatorLaunch[]>([]);
  const [walletAlerts, setWalletAlerts] = useState<WalletAlert[]>([]);
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [livePositions, setLivePositions] = useState<Record<number, LivePositionInfo>>({});
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [snapshots, setSnapshots] = useState<EquitySnapshot[]>([]);
  const [activeVersion, setActiveVersion] = useState<StrategyConfigVersion | null>(null);
  const [history, setHistory] = useState<StrategyConfigVersion[]>([]);
  const [suggestions, setSuggestions] = useState<AgentSuggestion[]>([]);
  const [workerAlive, setWorkerAlive] = useState<boolean | null>(null);
  const [virtualBalance, setVirtualBalance] = useState<number | null>(null);
  const [controlState, setControlState] = useState<WorkerControlState>('running');

  const refreshAll = useCallback(async () => {
    // Smaller page sizes on the public read-only deployment too - fewer
    // rows means less of app/api/pools's per-row Turso fan-out per request.
    const poolsLimit = READ_ONLY ? 40 : 100;
    const decisionsLimit = READ_ONLY ? 25 : 50;
    const [poolsRes, decisionsRes, positionsRes, tradesRes, equityRes, configRes, historyRes, suggestionsRes, healthRes, controlRes, walletAlertsRes, creatorLaunchesRes] =
      await Promise.all([
        fetch(`/api/pools?limit=${poolsLimit}`).then((r) => r.json()),
        fetch(`/api/decisions?limit=${decisionsLimit}`).then((r) => r.json()),
        fetch('/api/positions').then((r) => r.json()),
        fetch('/api/trades').then((r) => r.json()),
        fetch('/api/equity').then((r) => r.json()),
        fetch('/api/config').then((r) => r.json()),
        fetch('/api/config/history').then((r) => r.json()),
        fetch('/api/agent/suggestions').then((r) => r.json()),
        fetch('/api/health').then((r) => r.json()),
        fetch('/api/control').then((r) => r.json()),
        fetch('/api/wallet-alerts').then((r) => r.json()),
        fetch('/api/creator-launches').then((r) => r.json()),
      ]);
    setPools(poolsRes.pools);
    setDecisions(decisionsRes.decisions);
    setCreatorLaunches(creatorLaunchesRes.launches);
    setPositions(positionsRes.positions);
    setTrades(tradesRes.trades);
    setSnapshots(equityRes.snapshots);
    setActiveVersion(configRes.activeVersion);
    setHistory(historyRes.versions);
    setSuggestions(suggestionsRes.suggestions);
    setWorkerAlive(healthRes.workerAlive);
    setVirtualBalance(healthRes.virtualBalanceQuote);
    setControlState(controlRes.state);
    setWalletAlerts(walletAlertsRes.alerts);
  }, []);

  useEffect(() => {
    refreshAll();
    // READ_ONLY (the public Vercel deployment) polls slower - freshness
    // matters less for a public view than for the local operator dashboard,
    // and every tick here is real Vercel function invocations against Turso
    // that count toward the monthly usage budget. Cost-conscious per the
    // user's explicit ask to trim Vercel spend.
    const interval = setInterval(refreshAll, READ_ONLY ? 90_000 : 30_000);
    return () => clearInterval(interval);
  }, [refreshAll]);

  const onMessage = useCallback(
    (msg: WorkerMessage) => {
      switch (msg.event) {
        case 'pool.detected': {
          const p = msg.payload as DetectedPool;
          setPools((prev) => [{ ...p, filterResults: [], latestMomentumSnapshot: null, latestAgentDecision: null }, ...prev].slice(0, 200));
          break;
        }
        case 'filter.result': {
          const f = msg.payload as FilterOutcome;
          setPools((prev) =>
            prev.map((pool) =>
              pool.id === f.detectedPoolId ? { ...pool, filterResults: [...pool.filterResults, f] } : pool,
            ),
          );
          break;
        }
        case 'pool.status': {
          const { id, status } = msg.payload as { id: number; status: DetectedPool['status'] };
          setPools((prev) => prev.map((pool) => (pool.id === id ? { ...pool, status } : pool)));
          break;
        }
        case 'momentum.updated': {
          const { detectedPoolId, pass, results } = msg.payload as {
            detectedPoolId: number;
            pass: boolean;
            results: MomentumCriterionResult[];
          };
          setPools((prev) =>
            prev.map((row) =>
              row.id === detectedPoolId && row.latestMomentumSnapshot
                ? { ...row, latestMomentumSnapshot: { ...row.latestMomentumSnapshot, pass, criteria: results, hasData: true } }
                : row,
            ),
          );
          break;
        }
        case 'agent.decision': {
          const payload = msg.payload as {
            detectedPoolId: number;
            baseMint: string;
            venue: string;
            checkedAt: number;
            momentumPass: boolean;
            revivalPass: boolean;
            revivalStrength: number;
            degenScore: number | null;
            degenVerdict: string | null;
            action: 'buy' | 'skip';
            confidence: number;
            reasoning: string;
            source: 'llm' | 'fallback';
          };
          setPools((prev) =>
            prev.map((row) =>
              row.id === payload.detectedPoolId
                ? {
                    ...row,
                    latestAgentDecision: {
                      id: -1,
                      configVersionId: -1,
                      detectedPoolId: payload.detectedPoolId,
                      checkedAt: payload.checkedAt,
                      momentumPass: payload.momentumPass,
                      revivalPass: payload.revivalPass,
                      revivalStrength: payload.revivalStrength,
                      degenScore: payload.degenScore,
                      degenVerdict: payload.degenVerdict,
                      action: payload.action,
                      confidence: payload.confidence,
                      reasoning: payload.reasoning,
                      source: payload.source,
                    },
                  }
                : row,
            ),
          );
          // Synthetic negative id - reconciled with the real DB id on the
          // next 30s refreshAll() poll, same as the pools patch above.
          setDecisions((prev) =>
            [
              {
                id: -Date.now(),
                configVersionId: -1,
                detectedPoolId: payload.detectedPoolId,
                baseMint: payload.baseMint,
                venue: payload.venue,
                checkedAt: payload.checkedAt,
                momentumPass: payload.momentumPass,
                revivalPass: payload.revivalPass,
                revivalStrength: payload.revivalStrength,
                degenScore: payload.degenScore,
                degenVerdict: payload.degenVerdict,
                action: payload.action,
                confidence: payload.confidence,
                reasoning: payload.reasoning,
                source: payload.source,
              },
              ...prev,
            ].slice(0, 50),
          );
          break;
        }
        case 'position.opened':
          refreshAll();
          break;
        case 'position.updated': {
          const info = msg.payload as { positionId: number } & LivePositionInfo;
          setLivePositions((prev) => ({ ...prev, [info.positionId]: info }));
          break;
        }
        case 'position.partialExit':
          refreshAll();
          break;
        case 'position.closed':
          refreshAll();
          break;
        case 'equity.snapshot':
          refreshAll();
          break;
        case 'agent.suggestion':
          refreshAll();
          break;
        case 'worker.heartbeat':
          setWorkerAlive(true);
          break;
        case 'worker.state': {
          const { state } = msg.payload as { state: WorkerControlState };
          setControlState(state);
          break;
        }
        case 'worker.sellAll':
          refreshAll();
          break;
        case 'wallet.alert':
          refreshAll();
          break;
        case 'creator.launch': {
          const launch = msg.payload as CreatorLaunch;
          setCreatorLaunches((prev) => [launch, ...prev].slice(0, 100));
          break;
        }
      }
    },
    [refreshAll],
  );

  const { connected } = useWorkerSocket(WS_PORT, onMessage);

  const saveConfig = useCallback(
    async (config: StrategyConfig) => {
      await fetch('/api/config', { method: 'POST', body: JSON.stringify({ config }) });
      await refreshAll();
    },
    [refreshAll],
  );

  const acceptSuggestion = useCallback(
    async (id: number) => {
      await fetch(`/api/agent/suggestions/${id}`, { method: 'POST', body: JSON.stringify({ action: 'accept' }) });
      await refreshAll();
    },
    [refreshAll],
  );

  const rejectSuggestion = useCallback(
    async (id: number) => {
      await fetch(`/api/agent/suggestions/${id}`, { method: 'POST', body: JSON.stringify({ action: 'reject' }) });
      await refreshAll();
    },
    [refreshAll],
  );

  return (
    <div className="wrap">
      <div className="header">
        <div>
          <div className="eyebrow">Paper trading · no real funds</div>
          <h1 className="title">Memeoy</h1>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 10 }}>
          <a href="https://github.com/alexskin/memeoy" target="_blank" rel="noopener noreferrer" className="action">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
            GitHub
          </a>
          {activeVersion && (
            <span
              className="badge"
              style={
                activeVersion.config.tradingMode === 'live'
                  ? { color: 'var(--short)', background: 'var(--short-dim)', fontSize: 11, padding: '4px 10px' }
                  : { color: 'var(--long)', background: 'var(--long-dim)', fontSize: 11, padding: '4px 10px' }
              }
            >
              {activeVersion.config.tradingMode === 'live' ? 'LIVE — REAL FUNDS' : 'PAPER'}
            </span>
          )}
          {!READ_ONLY && <WorkerControls state={controlState} onRefresh={refreshAll} />}
          <ConnectionStatus wsConnected={connected} workerAlive={workerAlive} virtualBalance={virtualBalance} />
        </div>
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {tab === 'Watcher' && (
        <>
          <StatsStrip openPositionsCount={positions.length} pools={pools} virtualBalance={virtualBalance} />
          <div className="panel">
            <h2>AI watcher — detection → decision → outcome</h2>
            <WatcherTable rows={pools} />
          </div>
          <div className="panel">
            <h2>Recent AI decisions</h2>
            <DecisionLog decisions={decisions} />
          </div>
          <div className="panel">
            <h2>Tracked creator launches</h2>
            <CreatorLaunchLog launches={creatorLaunches} />
          </div>
        </>
      )}

      {tab === 'Portfolio' && (
        <>
          <div className="panel">
            <h2>Equity curve</h2>
            <EquityChart snapshots={snapshots} />
          </div>
          <div className="panel">
            <h2>Open positions</h2>
            <PositionsTable positions={positions} live={livePositions} />
          </div>
          <div className="panel">
            <h2>Closed trades</h2>
            <TradeHistoryTable trades={trades} />
          </div>
          <div className="panel">
            <h2>Recent AI decisions</h2>
            <DecisionLog decisions={decisions} />
          </div>
        </>
      )}

      {tab === 'Strategy' && (
        <>
          {activeVersion && (
            <div className="panel">
              <h2>Strategy configuration</h2>
              <StrategyConfigPanel activeVersion={activeVersion} history={history} onSave={saveConfig} readOnly={READ_ONLY} />
            </div>
          )}
          <div className="panel">
            <h2>Self-tuning agent</h2>
            <AgentLog suggestions={suggestions} onAccept={acceptSuggestion} onReject={rejectSuggestion} readOnly={READ_ONLY} />
          </div>
        </>
      )}

      {tab === 'Wallet Alerts' && activeVersion && (
        <div className="panel">
          <h2>Wallet alerts</h2>
          <WalletAlerts alerts={walletAlerts} config={activeVersion.config} onSave={saveConfig} readOnly={READ_ONLY} />
        </div>
      )}
    </div>
  );
}
