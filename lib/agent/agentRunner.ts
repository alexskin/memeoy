// Orchestrates stats -> heuristic -> optional llm -> versioned proposal.
// Default mode is 'propose-only' (see StrategyConfig.agentMode): every run
// writes an agent_suggestions row with full rationale, and only actually
// changes the live config if the user accepts it via the dashboard (or if
// agentMode is switched to 'auto-apply'). Full history is always preserved
// in strategy_config_versions (append-only) - rollback = re-applying an
// old version's config as a new version.
import {
  getActiveConfigVersion,
  getAgentSuggestion,
  getClosedPositions,
  getEquitySnapshots,
  getFillById,
  getLatestAgentDecisionBeforeBuy,
  getLatestMomentumSnapshotBeforeBuy,
  getMeta,
  getMinAgeOnlyRejectionStats,
  getStopLossOvershootStats,
  insertAgentSuggestion,
  insertConfigVersion,
  countClosedPositionsSince,
  setMeta,
  updateAgentSuggestionStatus,
} from '../db';
import { computeStats, TradeWithFills } from './stats';
import { applyDiff, proposeChanges } from './heuristicTuner';
import { annotateProposal } from './llmTuner';
import { logger } from '../logger';
import { StrategyConfigVersion } from '../types';

const LAST_RUN_META_KEY = 'last_agent_run_at';

export async function maybeRunAgent(broadcast: (event: string, payload: unknown) => void): Promise<void> {
  const { config } = { config: getActiveConfigVersion().config };
  const lastRunAt = Number(getMeta(LAST_RUN_META_KEY) ?? 0);
  const closedSinceLastRun = countClosedPositionsSince(lastRunAt);
  const intervalElapsed = Date.now() - lastRunAt >= config.agentMinIntervalMs;

  if (closedSinceLastRun < config.agentTriggerEveryNTrades && !intervalElapsed) {
    return;
  }

  await runAgentNow(broadcast);
}

export async function runAgentNow(
  broadcast?: (event: string, payload: unknown) => void,
): Promise<{ ran: boolean; suggestionId: number | null }> {
  const activeVersion = getActiveConfigVersion();
  const config = activeVersion.config;
  setMeta(LAST_RUN_META_KEY, String(Date.now()));

  if (getClosedPositions(1).length === 0) {
    return { ran: true, suggestionId: null };
  }

  const trades: TradeWithFills[] = getClosedPositions(config.agentMinTradesForProposal * 5).map((p) => ({
    ...p,
    entryFill: getFillById(p.entryFillId),
    exitFill: getFillById(p.exitFillId),
    entryMomentumSnapshot: getLatestMomentumSnapshotBeforeBuy(p.detectedPoolId, p.openedAt),
    entryAgentDecision: getLatestAgentDecisionBeforeBuy(p.detectedPoolId, p.openedAt),
  }));

  if (trades.length < config.agentMinTradesForProposal) {
    return { ran: true, suggestionId: null };
  }

  const equitySeries = getEquitySnapshots(500).map((s) => s.totalEquityQuote);
  const stats = computeStats(trades, equitySeries);

  // Look-back window matches how far back the trades sample itself reaches
  // (roughly) - a fixed 24h is simpler and good enough for this heuristic.
  const { totalEvaluated, minAgeOnlyRejections } = getMinAgeOnlyRejectionStats(Date.now() - 24 * 60 * 60 * 1000);
  stats.minAgeEvaluatedCount = totalEvaluated;
  stats.minAgeOnlyRejectionRate = totalEvaluated > 0 ? minAgeOnlyRejections / totalEvaluated : 0;

  const { slCount, tpCount, slNetPnlQuote, avgOvershootRatio } = getStopLossOvershootStats(Date.now() - 24 * 60 * 60 * 1000);
  stats.stopLossCount = slCount;
  stats.takeProfitCount = tpCount;
  stats.stopLossNetPnlQuote = slNetPnlQuote;
  stats.stopLossOvershootRatio = avgOvershootRatio;

  const proposal = proposeChanges(stats, config);

  if (!proposal) {
    logger.info({ sampleSize: stats.sampleSize }, 'Agent ran, no change proposed this cycle');
    return { ran: true, suggestionId: null };
  }

  let source: 'heuristic' | 'llm' = 'heuristic';
  let rationale = proposal.rationale;
  let vetoed = false;

  const llm = await annotateProposal(stats, proposal, config);
  if (llm) {
    source = 'llm';
    rationale = `${proposal.rationale} [LLM review: ${llm.note}]`;
    vetoed = llm.veto;
  }

  const suggestionId = insertAgentSuggestion({
    createdAt: Date.now(),
    basedOnVersionId: activeVersion.id,
    proposedVersionId: null,
    status: vetoed ? 'rejected' : 'proposed',
    source,
    rationale,
    statsSnapshot: stats,
    diff: proposal.diff,
  });

  if (!vetoed && config.agentMode === 'auto-apply') {
    const newConfig = applyDiff(config, proposal.diff);
    const version = insertConfigVersion(newConfig, 'agent', activeVersion.id, rationale, true);
    updateAgentSuggestionStatus(suggestionId, 'applied', version.id);
  }

  broadcast?.('agent.suggestion', { id: suggestionId, rationale });
  return { ran: true, suggestionId };
}

export function applyAgentSuggestion(suggestionId: number): StrategyConfigVersion {
  const suggestion = getAgentSuggestion(suggestionId);
  if (!suggestion) throw new Error(`Agent suggestion ${suggestionId} not found`);
  if (suggestion.status !== 'proposed') throw new Error(`Agent suggestion ${suggestionId} is not pending`);

  const baseVersion = getActiveConfigVersion();
  const newConfig = applyDiff(baseVersion.config, suggestion.diff as Record<string, { old: unknown; new: unknown }>);
  const version = insertConfigVersion(newConfig, 'agent', baseVersion.id, suggestion.rationale, true);
  updateAgentSuggestionStatus(suggestionId, 'applied', version.id);
  return version;
}

export function rejectAgentSuggestion(suggestionId: number): void {
  const suggestion = getAgentSuggestion(suggestionId);
  if (!suggestion) throw new Error(`Agent suggestion ${suggestionId} not found`);
  updateAgentSuggestionStatus(suggestionId, 'rejected');
}
