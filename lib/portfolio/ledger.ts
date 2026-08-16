// Virtual balance bookkeeping. All amounts here are UI-unit numbers (e.g.
// 0.05 SOL), not raw base units - the fills table keeps raw-precision
// records for the slippage math, but position/ledger bookkeeping only needs
// paper-trading-grade precision.
import {
  applyPartialExit,
  closePosition as dbClosePosition,
  finalizePosition,
  getMeta,
  getOpenPositions,
  getPositionById,
  insertEquitySnapshot,
  insertPartialExit,
  insertPosition,
  setFillPositionId,
  setMeta,
} from '../db';
import { PartialExit, PEAK_PROFIT_UNSET, PositionStatus, StrategyConfig } from '../types';
import { Venue } from '../priceSource/types';
import { resolveRiskParams } from './riskParams';

const BALANCE_KEY = 'virtual_balance_quote';
const REALIZED_PNL_KEY = 'realized_pnl_cumulative';

export function getVirtualBalance(config: StrategyConfig): number {
  const raw = getMeta(BALANCE_KEY);
  if (raw === null) {
    setMeta(BALANCE_KEY, String(config.startingBalanceQuote));
    return config.startingBalanceQuote;
  }
  return Number(raw);
}

function setVirtualBalance(value: number) {
  setMeta(BALANCE_KEY, String(value));
}

export function getRealizedPnlCumulative(): number {
  const raw = getMeta(REALIZED_PNL_KEY);
  return raw === null ? 0 : Number(raw);
}

function addRealizedPnl(delta: number) {
  setMeta(REALIZED_PNL_KEY, String(getRealizedPnlCumulative() + delta));
}

export function positionSizeQuote(config: StrategyConfig, balance: number): number {
  return config.positionSizeMode === 'fixed' ? config.positionSizeValue : balance * config.positionSizeValue;
}

export function canOpenPosition(config: StrategyConfig): boolean {
  const balance = getVirtualBalance(config);
  if (getOpenPositions().length >= config.maxConcurrentPositions) return false;
  return balance >= positionSizeQuote(config, balance);
}

// Deducts execution-fee cost that wasn't wrapped into a position's cost
// basis - specifically, fees paid on buy/sell attempts that never actually
// filled (every retry that landed on-chain and reverted still cost a real
// fee). Also dings realized P&L so drawdown/equity stats see the loss.
export function chargeFees(config: StrategyConfig, feesQuote: number) {
  if (feesQuote <= 0) return;
  const balance = getVirtualBalance(config);
  setVirtualBalance(balance - feesQuote);
  addRealizedPnl(-feesQuote);
}

export interface OpenPositionParams {
  detectedPoolId: number;
  baseMint: string;
  entryFillId: number;
  /** All-in cost basis: the trade amount PLUS any entry execution fees already paid - caller (scripts/worker.ts) folds fees in before calling. */
  quoteSizeInUi: number;
  baseAmountHeldUi: number;
  entryPrice: number;
  config: StrategyConfig;
  configVersionId: number;
  openedAt: number;
  source: Venue;
  /** From DexScreener at buy time, best-effort - null if not yet indexed. */
  tokenName?: string | null;
  entryMarketCapUsd?: number | null;
}

export function openPosition(p: OpenPositionParams): number {
  const riskParams = resolveRiskParams(p.config, p.source);
  const positionId = insertPosition({
    detectedPoolId: p.detectedPoolId,
    baseMint: p.baseMint,
    status: 'open',
    entryFillId: p.entryFillId,
    exitFillId: null,
    quoteSizeIn: String(p.quoteSizeInUi),
    baseAmountHeld: String(p.baseAmountHeldUi),
    entryPrice: p.entryPrice,
    exitPrice: null,
    takeProfitPctSnapshot: riskParams.takeProfitPct,
    stopLossPctSnapshot: riskParams.stopLossPct,
    realizedPnlQuote: null,
    realizedPnlPct: null,
    openedAt: p.openedAt,
    closedAt: null,
    configVersionId: p.configVersionId,
    source: p.source,
    peakProfitPct: PEAK_PROFIT_UNSET,
    originalQuoteSizeIn: String(p.quoteSizeInUi),
    originalBaseAmountHeld: String(p.baseAmountHeldUi),
    tokenName: p.tokenName ?? null,
    entryMarketCapUsd: p.entryMarketCapUsd ?? null,
    exitMarketCapUsd: null,
  });
  setFillPositionId(p.entryFillId, positionId);

  const balance = getVirtualBalance(p.config);
  setVirtualBalance(balance - p.quoteSizeInUi);

  return positionId;
}

export interface ClosePositionParams {
  positionId: number;
  status: Exclude<PositionStatus, 'open'>;
  exitFillId: number;
  quoteSizeInUi: number;
  /** Net proceeds: the gross swap output MINUS any exit execution fees already paid - caller (lib/portfolio/positionMonitor.ts) folds fees in before calling. */
  quoteReceivedUi: number;
  exitPrice: number;
  config: StrategyConfig;
  closedAt: number;
  /** From DexScreener at close time, best-effort - null if unavailable. */
  exitMarketCapUsd?: number | null;
}

export function closePositionAndSettle(p: ClosePositionParams) {
  // Adds to any prior partial-exit realized P&L instead of overwriting -
  // behaviorally identical to before for the common case (zero partials,
  // where priorRealizedPnlQuote is null/0), but correct once a position has
  // already banked some P&L via recordPartialExit() below.
  const existing = getPositionById(p.positionId);
  const priorRealizedPnlQuote = existing?.realizedPnlQuote ?? 0;
  const originalQuoteSizeIn = existing ? Number(existing.originalQuoteSizeIn) : p.quoteSizeInUi;

  const legPnlQuote = p.quoteReceivedUi - p.quoteSizeInUi;
  const cumulativeRealizedPnlQuote = priorRealizedPnlQuote + legPnlQuote;
  const cumulativeRealizedPnlPct = originalQuoteSizeIn === 0 ? 0 : (cumulativeRealizedPnlQuote / originalQuoteSizeIn) * 100;

  dbClosePosition(
    p.positionId,
    p.status,
    p.exitFillId,
    p.exitPrice,
    cumulativeRealizedPnlQuote,
    cumulativeRealizedPnlPct,
    p.closedAt,
    p.exitMarketCapUsd ?? null,
  );

  const balance = getVirtualBalance(p.config);
  setVirtualBalance(balance + p.quoteReceivedUi);
  addRealizedPnl(legPnlQuote);
}

export interface RecordPartialExitParams {
  positionId: number;
  exitFillId: number;
  targetPct: number | null;
  sellFractionOfOriginal: number;
  baseAmountSoldUi: number;
  quoteSizeInPortionUi: number;
  quoteReceivedUi: number;
  exitPrice: number;
  config: StrategyConfig;
  reason: PartialExit['reason'];
  closedAt: number;
}

// Settles one scaled take-profit leg against a still-open position: credits
// balance, records the leg, and decrements the position's remaining size.
// Reused by every partial-exit reason (though currently only 'target' fires
// this - trailing/stop_loss/timeout/manual go through closePositionAndSettle
// above, which fully closes the position).
export function recordPartialExit(p: RecordPartialExitParams): {
  realizedPnlQuote: number;
  remainingBaseAmountHeldUi: number;
  remainingQuoteSizeInUi: number;
} {
  const position = getPositionById(p.positionId);
  if (!position) throw new Error(`recordPartialExit: position ${p.positionId} not found`);

  const legPnlQuote = p.quoteReceivedUi - p.quoteSizeInPortionUi;
  const cumulativeRealizedPnlQuote = (position.realizedPnlQuote ?? 0) + legPnlQuote;
  const originalQuoteSizeIn = Number(position.originalQuoteSizeIn);
  const cumulativeRealizedPnlPct = originalQuoteSizeIn === 0 ? 0 : (cumulativeRealizedPnlQuote / originalQuoteSizeIn) * 100;

  const remainingBaseAmountHeldUi = Math.max(0, Number(position.baseAmountHeld) - p.baseAmountSoldUi);
  const remainingQuoteSizeInUi = Math.max(0, Number(position.quoteSizeIn) - p.quoteSizeInPortionUi);

  insertPartialExit({
    positionId: p.positionId,
    exitFillId: p.exitFillId,
    targetPct: p.targetPct,
    sellFractionOfOriginal: p.sellFractionOfOriginal,
    baseAmountSold: String(p.baseAmountSoldUi),
    quoteSizeInPortion: p.quoteSizeInPortionUi,
    quoteReceivedUi: p.quoteReceivedUi,
    exitPrice: p.exitPrice,
    realizedPnlQuote: legPnlQuote,
    realizedPnlPct: p.quoteSizeInPortionUi === 0 ? 0 : (legPnlQuote / p.quoteSizeInPortionUi) * 100,
    reason: p.reason,
    closedAt: p.closedAt,
  });

  applyPartialExit(p.positionId, {
    baseAmountHeld: remainingBaseAmountHeldUi,
    quoteSizeIn: remainingQuoteSizeInUi,
    realizedPnlQuote: cumulativeRealizedPnlQuote,
    realizedPnlPct: cumulativeRealizedPnlPct,
  });

  const balance = getVirtualBalance(p.config);
  setVirtualBalance(balance + p.quoteReceivedUi);
  addRealizedPnl(legPnlQuote);

  return { realizedPnlQuote: legPnlQuote, remainingBaseAmountHeldUi, remainingQuoteSizeInUi };
}

// Stamps a position closed after its LAST partial exit already drained it to
// ~0 - money already moved via recordPartialExit(), this just marks status.
export function finalizeFullyLiquidated(
  positionId: number,
  status: Exclude<PositionStatus, 'open'>,
  exitFillId: number,
  exitPrice: number,
  closedAt: number,
  exitMarketCapUsd: number | null = null,
) {
  finalizePosition(positionId, status, exitFillId, exitPrice, closedAt, exitMarketCapUsd);
}

// Called periodically (and on every open/close) so the equity curve stays
// continuous even during quiet periods, not just at trade events.
export function recordEquitySnapshot(config: StrategyConfig, openUnrealizedQuote: number, ts = Date.now()) {
  const balance = getVirtualBalance(config);
  const open = getOpenPositions();
  insertEquitySnapshot({
    ts,
    virtualBalanceQuote: balance,
    openUnrealizedQuote,
    totalEquityQuote: balance + openUnrealizedQuote,
    realizedPnlCumulative: getRealizedPnlCumulative(),
    numOpenPositions: open.length,
    numClosedTrades: 0,
  });
}
