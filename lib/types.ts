import { Venue } from './priceSource/types';

export interface StrategyConfig {
  // 'paper' (default): simulated fills only, never touches a wallet. 'live':
  // real swaps signed by WALLET_PRIVATE_KEY (see lib/config/env.ts) - only
  // supported on the Raydium venue today (lib/fillSimulator/slippage.ts's
  // createRaydiumPriceSource is the only PriceSource with a real
  // executeSwap() implementation; no verified on-chain instruction format
  // exists in this project for PumpSwap, so a 'live' candidate on that venue
  // fails safe with a clear error instead of guessing an instruction layout
  // for a real-money transaction - see fillSimulator.ts's tradingMode branch).
  tradingMode: 'paper' | 'live';

  // Buy
  quoteMint: 'WSOL' | 'USDC';
  positionSizeMode: 'fixed' | 'pctEquity';
  positionSizeValue: number; // fixed: quote amount; pctEquity: fraction of equity 0-1
  autoBuyDelayMs: number;
  maxBuyRetries: number;
  buySlippagePct: number;

  // Progressive position sizing - layers on top of positionSizeMode/
  // positionSizeValue above rather than replacing it. Scales the base size
  // up by progressiveSizingScaleFactor only once BOTH are true: the last
  // progressiveSizingWinStreakRequired closed positions were all qualifying
  // wins (positive realized P&L, and not stopped out - see
  // lib/portfolio/ledger.ts's updateWinStreak), AND cumulative realized P&L
  // is at least progressiveSizingMinRealizedProfitQuote. Either a losing
  // close or a stop-loss close resets the streak to 0, dropping back to the
  // base size. Off by default - this changes real position-sizing behavior,
  // not just a threshold tweak.
  progressiveSizingEnabled: boolean;
  progressiveSizingWinStreakRequired: number;
  progressiveSizingMinRealizedProfitQuote: number;
  progressiveSizingScaleFactor: number;

  // Sell
  autoSellDelayMs: number;
  maxSellRetries: number;
  sellSlippagePct: number;
  priceCheckIntervalMs: number;
  priceCheckDurationMs: number; // 0 = hold indefinitely (no forced timeout close)
  stopLossPct: number; // hard floor from entry - always active regardless of exitStrategy

  // 'fixed': sell the instant unrealized P&L reaches takeProfitPct.
  // 'trailing': once P&L first reaches trailingActivationPct, stop selling
  // immediately and instead track the peak P&L seen since entry
  // (Position.peakProfitPct) - only sell once P&L pulls back
  // trailingStopPct percentage-points from that peak. Lets a pump keep
  // running instead of capping it at the first threshold cross, while still
  // locking in gains on the way back down.
  exitStrategy: 'fixed' | 'trailing';
  takeProfitPct: number; // used when exitStrategy === 'fixed'
  trailingActivationPct: number; // used when exitStrategy === 'trailing'
  trailingStopPct: number; // used when exitStrategy === 'trailing'

  // Structural exit - a deterministic trigger independent of price P&L,
  // alongside stopLossPct/takeProfitPct/priceCheckDurationMs below: if the
  // token's own live activity (not its price) collapses below these floors,
  // the reason the position was opened no longer holds regardless of
  // current P&L. Same AI-override treatment as the other triggers when
  // aiExitReviewEnabled (see lib/agent/exitDecisionEngine.ts).
  structuralExitEnabled: boolean;
  structuralExitMinVolume5mUsd: number;
  structuralExitMinBuys1h: number;

  // Periodic AI judgment on open positions - "should I still be holding
  // this, or exit now even though SL/TP haven't fired?" (lib/agent/
  // exitDecisionEngine.ts). Deliberately does NOT replace stopLossPct above,
  // which stays a hard, unconditional floor regardless of this setting - a
  // bad/slow/unavailable AI call should never be able to block a stop-loss.
  // Runs on its own interval, independent of priceCheckIntervalMs (which is
  // every 2s by default) - reviewing every tick would be both wasteful
  // (Anthropic tokens) and pointless (nothing meaningfully new to judge that
  // fast).
  aiExitReviewEnabled: boolean;
  aiExitReviewIntervalMs: number;
  // A position nearing priceCheckDurationMs's hard timeout gets exactly ONE
  // chance, on the review closest to that deadline, for a real LLM 'hold'
  // judgment (not a fallback) to push the deadline out by this much - never
  // more than once, so a stalled AI can't turn this into an unbounded
  // bag-hold excuse. See lib/portfolio/positionMonitor.ts.
  aiTimeoutExtensionMs: number;

  // Filters
  filterCheckIntervalMs: number;
  filterCheckDurationMs: number;
  consecutiveFilterMatches: number;
  checkRenounced: boolean;
  checkFreezable: boolean;
  checkBurned: boolean;
  checkMutable: boolean;
  checkSocials: boolean;
  minPoolSizeQuote: number;
  maxPoolSizeQuote: number;

  // Holder concentration - runs once per candidate right after the safety
  // filters pass (not on every watchlist sweep, to control RPC load).
  checkHolderConcentration: boolean;
  momentumMaxTopHolderPct: number;

  // Insider concentration (RugCheck.xyz funding-graph wallet clustering,
  // not just raw holder size) - same one-shot-per-candidate timing as
  // holder concentration above. No bundler-detection equivalent exists yet
  // - no free API was found that computes it, see lib/rugcheck/client.ts.
  checkInsiderConcentration: boolean;
  momentumMaxInsiderPct: number;
  // Independent signal from the pct check above - see lib/rugcheck/client.ts
  // for why the top-20-holder pct alone can miss a large, spread-out
  // insider network (confirmed live: a real token had 223 insider wallets
  // detected but 0% inside its top 20 holders).
  momentumMaxInsiderWalletCount: number;

  // Dev/aggregate concentration - catches the case checkHolderConcentration
  // (largest SINGLE non-pool holder) and checkInsiderConcentration (RugCheck's
  // insider-flagged wallets only) can both miss: several holders each sitting
  // safely under the single-holder threshold, none flagged "insider" by
  // RugCheck's clustering heuristic, that still add up to majority control
  // (confirmed live: a bought token had a 14.4% single largest holder and 0
  // RugCheck-flagged insiders, yet 56.3% dev holding and 57.9% top-10
  // aggregate per an external scanner). Same RugCheck report, same
  // fail-closed-on-missing-data convention as the two filters above.
  checkDevRisk: boolean;
  momentumMaxDevHoldingPct: number;
  momentumMaxTop10HoldersPct: number;

  // Fresh-wallet ratio among a candidate's top holders - a swarm of newly
  // created wallets buying in sync is a bot/insider-sniping signature that
  // none of the checks above catch (each wallet can look individually
  // clean). Needs real on-chain history per wallet (RugCheck has no
  // wallet-age field) - see lib/filters/freshWalletFilter.ts for the RPC
  // cost tradeoff. Explicit product decision: this must stay a LOW cap
  // (max % of holders allowed to be fresh), not a lenient one.
  checkFreshWallet: boolean;
  momentumMaxFreshWalletPct: number;
  /** A holder wallet counts as "fresh" if its oldest visible signature is
   *  within this many hours of now. */
  freshWalletMaxAgeHours: number;

  // Momentum watchlist - replaces instant-buy. A candidate that passes the
  // safety filters above goes onto a watchlist instead of being bought
  // immediately; these thresholds (mirroring a DexScreener "new pairs"
  // screener 1:1) gate the actual buy decision. See lib/watchlist/.
  momentumEnabled: boolean;
  momentumMinLiquidityUsd: number;
  momentumMinAgeMinutes: number;
  momentumMaxAgeMinutes: number;
  momentumMin1hBuys: number;
  momentumMin5mBuys: number;
  momentumMin24hVolumeUsd: number;
  momentumMin24hChangePct: number;
  momentumMax24hChangePct: number;
  momentumMin1hChangePct: number;
  // Guards against a one-sided tape (e.g. a single wallet buying against
  // itself with no real counterparty activity, or a pool with no organic
  // distribution yet) - requires at least this many real 1h sells to exist
  // AND buys to still outnumber them, so the candidate shows genuine
  // two-directional trading with buyers still in control, not just a raw
  // buy counter climbing in isolation.
  momentumMinSells1h: number;
  momentumPollIntervalMs: number;
  momentumMaxWatchlistSize: number;

  // Revival ("bait pump") watchlist gate - runs immediately after momentum
  // passes, same DexScreenerPair reads, no extra I/O. Detects a candidate
  // that pumped, went flat, and just started showing a small fresh
  // volume+price uptick (one age range covers both a ~1-day-old and a
  // multi-day-old flatline - see lib/dexscreener/revivalFilter.ts).
  revivalMinAgeMinutes: number;
  revivalMaxAgeMinutes: number;
  revivalMin6hChangePct: number;
  revivalMax6hChangePct: number;
  revivalMin1hChangePct: number;
  revivalMax1hChangePct: number;
  revivalMin5mVolumeUsd: number;
  revivalMin1hBuys: number;
  revivalMinLiquidityUsd: number;

  // Runner review (lib/agent/runnerReview.ts) - periodic, independent of the
  // trade-count-triggered heuristicTuner: re-checks recently detected pools
  // (bought or skipped) against CURRENT DexScreener data to find genuine
  // "runners" (big recent movers) regardless of whether we ever traded them,
  // and proposes filter/entry/exit tuning from that - the trade-outcome
  // tuner alone can never see a token we skipped and never bought.
  runnerReviewEnabled: boolean;
  runnerReviewIntervalMs: number;
  runnerLookbackHours: number;
  runnerThresholdPct: number;
  runnerMinLiquidityUsd: number;

  // AI judgment layer (lib/agent/decisionEngine.ts) - runs once a candidate
  // has already cleared momentum + revival, right before the buy would
  // otherwise fire automatically. Both are kill-switches: false reverts
  // instantly to the old deterministic "pass = buy" behavior.
  degenScoreEnabled: boolean;
  decisionEngineEnabled: boolean;
  // Whether a candidate's team paid DexScreener for an Enhanced Token Info
  // profile or a boost (lib/dexscreener/client.ts::getDexPaidStatus) - free
  // official API, one call per decision-stage candidate. Advisory context
  // for decisionEngine.ts only, same as degen score - absence is common for
  // legitimate tokens too, so this is never a hard gate.
  checkDexPaidStatus: boolean;

  // Multi-target scaled take-profit: sell a fraction of the ORIGINAL
  // position size at each pct level (ascending), before the exitStrategy
  // (fixed/trailing) logic above runs on whatever fraction remains. Empty
  // array = no scaled targets, exitStrategy handles the whole position
  // exactly like today.
  takeProfitTargets: { pct: number; sellFraction: number }[];

  // Execution / infra realism - deliberately excluded from agent's tunable set,
  // see lib/agent/heuristicTuner.ts TUNABLE_KEYS. `executionMode` itself
  // (which of these two profiles to use) IS agent-tunable - only the rate
  // structures below are not, same rationale as latencyModel.
  executionMode: 'standard' | 'priority';
  latencyModel: {
    standard: { minMs: number; p95Ms: number; maxMs: number };
    priority: { minMs: number; p95Ms: number; maxMs: number };
  };
  // Every simulated on-chain attempt (filled or reverted_slippage - a
  // program-level revert still lands in a block and still costs the fee on
  // Solana, only a pre-submission error doesn't) pays this. Mirrors
  // repo-reference's COMPUTE_UNIT_LIMIT/COMPUTE_UNIT_PRICE (standard) and
  // CUSTOM_FEE (warp/jito). Always denominated in native SOL - ledger
  // assumes quoteMint is SOL-equivalent (WSOL, or pump.fun which is always
  // SOL); a USDC-quoted Raydium config would need real SOL/USDC conversion
  // to be exact, not implemented here.
  executionFees: {
    standard: { computeUnitLimit: number; computeUnitPriceMicroLamports: number };
    priority: { flatFeeSol: number };
  };

  // Portfolio
  startingBalanceQuote: number;
  maxConcurrentPositions: number;

  // Agent
  agentMode: 'propose-only' | 'auto-apply';
  agentTriggerEveryNTrades: number;
  agentMinIntervalMs: number;
  agentMinTradesForProposal: number;

  // Wallet copy-trade advisory (lib/walletTracker/): watches each tracked
  // wallet's own buys and pushes a suggested stop-loss/target framework to
  // the dashboard - never opens a position automatically, purely advisory.
  // Empty array disables it. `label` is a free-text display name only, never
  // used for lookups (address is always the key).
  trackedWallets: { address: string; label: string }[];
  walletAlertsEnabled: boolean;
  walletTrackerPollIntervalMs: number;
  // Suggested numbers attached to every alert (stamped onto the wallet_alerts
  // row at insert time, so editing these later doesn't retroactively change
  // historical alerts). Defaults derived from a 2-week analysis of this
  // wallet's own trades: median hold ~2.2min, so a much tighter/faster
  // framework than the general momentum strategy's defaults.
  walletAlertStopLossPct: number;
  walletAlertTarget1Pct: number; // suggested first take-profit level
  walletAlertTarget2Pct: number; // suggested trailing-activation level
  walletAlertTrailingStopPct: number;
  walletAlertMaxHoldMinutes: number;

  // Creator-launch tracking: alerts (Discord + dashboard, never trades)
  // when a tracked wallet CREATES a brand-new pump.fun token, as opposed to
  // trackedWallets above which watches for BUYS. Reuses the same always-on
  // pump.fun creation log listener the pre-migration watchlist uses
  // (scripts/worker.ts), so this works regardless of whether
  // pumpfunPremigrationEnabled trading is on. Empty array disables it.
  trackedCreators: string[];

  // Pre-migration pump.fun growth watchlist (lib/watchlist/
  // premigrationWatchlistMonitor.ts): a SEPARATE cohort from the
  // PumpSwap/Raydium momentum watchlist above - candidates here are
  // bonding-curve-stage tokens that haven't migrated yet, evaluated via our
  // own on-chain reserve reads (market cap) + RugCheck (dev/insider/top10
  // holder %) instead of DexScreener, which has no data pre-migration.
  // "Snipers %" from the user's reference screener is deliberately NOT
  // implemented - no free/cheap data source was found for it (would require
  // walking each candidate's full tx history from creation, which is
  // RPC-heavy and unverified); maxTop10HoldersPct default of 100 means
  // "no effective cap" until tuned, matching the user's screenshot leaving
  // that field blank.
  pumpfunPremigrationEnabled: boolean;
  pumpfunPremigrationMaxAgeMinutes: number;
  pumpfunPremigrationMinMarketCapUsd: number;
  pumpfunPremigrationMaxDevHoldingPct: number;
  pumpfunPremigrationMaxInsiderPct: number;
  pumpfunPremigrationMaxTop10HoldersPct: number;
  pumpfunPremigrationPollIntervalMs: number;
  pumpfunPremigrationMaxWatchlistSize: number;
  // Deliberately separate from the standard stopLossPct/exitStrategy/etc.
  // above - this cohort is explicitly higher-risk (super-fresh, unmigrated,
  // thin liquidity) per the user's request for wider stops and higher
  // targets than the general strategy.
  pumpfunPremigrationStopLossPct: number;
  pumpfunPremigrationExitStrategy: 'fixed' | 'trailing';
  pumpfunPremigrationTakeProfitPct: number;
  pumpfunPremigrationTrailingActivationPct: number;
  pumpfunPremigrationTrailingStopPct: number;
  pumpfunPremigrationTakeProfitTargets: { pct: number; sellFraction: number }[];
}

export interface DetectedPool {
  id: number;
  /** Raydium AMM account id, or the bonding-curve PDA address for pump.fun. */
  poolId: string;
  baseMint: string;
  quoteMint: string;
  /** '' (sentinel, "not applicable") for pump.fun rows - no LP mint pre-migration. */
  lpMint: string;
  /** '' (sentinel, "not applicable") for pump.fun rows - no OpenBook market. */
  marketId: string;
  baseDecimals: number;
  quoteDecimals: number;
  poolOpenTime: number | null;
  detectedAt: number;
  status: 'pending' | 'filtering' | 'passed' | 'watching' | 'rejected' | 'bought' | 'skipped';
  source: Venue;
}

// Advisory only - detected from the tracked wallet's own on-chain buys, no
// position is ever opened automatically from this. suggestedTarget2Pct is
// the trailing-activation level (rides with suggestedTrailingStopPct beyond
// that, same shape as StrategyConfig.exitStrategy='trailing').
export interface WalletAlert {
  id: number;
  walletAddress: string;
  signature: string;
  mint: string;
  detectedAt: number;
  buySolAmount: number | null;
  venue: string | null;
  suggestedStopLossPct: number;
  suggestedTarget1Pct: number;
  suggestedTarget2Pct: number;
  suggestedTrailingStopPct: number;
  suggestedMaxHoldMinutes: number;
}

// A tracked creator wallet launching a brand-new token (pump.fun's Create
// instruction, decoded straight off the log stream - see
// lib/pumpfun/createEventDecoder.ts). Deliberately separate from
// WalletAlert (which tracks a wallet BUYING an existing token and carries
// copy-trade SL/TP suggestion fields that don't apply here) - "this wallet
// created a token" is a different signal from "this wallet bought one".
export interface CreatorLaunch {
  id: number;
  creatorAddress: string;
  mint: string;
  name: string;
  symbol: string;
  detectedAt: number;
}


export interface MomentumCriterionResult {
  criterionName:
    | 'minLiquidity' | 'minAge' | 'maxAge' | 'min1hBuys' | 'min5mBuys'
    | 'min24hVolume' | 'min24hChange' | 'max24hChange' | 'min1hChange' | 'twoSidedTape';
  ok: boolean;
  message?: string;
}

export interface MomentumSnapshot {
  id: number;
  detectedPoolId: number;
  checkedAt: number;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  buys1h: number | null;
  buys5m: number | null;
  priceChange1hPct: number | null;
  priceChange24hPct: number | null;
  pairAgeMinutes: number | null;
  hasData: boolean;
  pass: boolean;
  criteria: MomentumCriterionResult[];
  configVersionId: number;
  /** From DexScreener at the moment of this scan (marketCap, falling back to fdv) - null if not yet indexed. */
  marketCapUsd: number | null;
}

export interface RevivalCriterionResult {
  criterionName:
    | 'minAge' | 'maxAge' | 'min6hChange' | 'max6hChange' | 'min1hChange' | 'max1hChange'
    | 'min5mVolume' | 'min1hBuys' | 'minLiquidity';
  ok: boolean;
  message?: string;
}

// Persisted output of lib/agent/decisionEngine.ts - one row per candidate
// that reached the judgment step (both 'buy' and 'skip' outcomes are kept,
// not just accepted trades - see decisionEngine.ts header for why: an
// auditable "REFUSED with a reason" log is the whole point, not just a buy
// trigger).
export type AgentDecisionAction = 'buy' | 'skip';
export type AgentDecisionSource = 'llm' | 'fallback';

export interface AgentDecision {
  id: number;
  detectedPoolId: number;
  checkedAt: number;
  momentumPass: boolean;
  revivalPass: boolean;
  revivalStrength: number;
  degenScore: number | null;
  degenVerdict: string | null;
  action: AgentDecisionAction;
  confidence: number;
  reasoning: string;
  source: AgentDecisionSource;
  configVersionId: number;
}

// AgentDecision plus the parent pool's baseMint/venue - agent_decisions
// itself has no such columns (a pure decision-judgment row), but a
// standalone decision feed (independent of the 200-row-capped pools list -
// see components/dashboard/DecisionLog.tsx) needs to say which token was
// judged, so this is a read-side join, never persisted.
export interface AgentDecisionDetailed extends AgentDecision {
  baseMint: string;
  venue: string;
}

export interface PremigrationCriterionResult {
  criterionName: 'maxAge' | 'minMarketCap' | 'maxDevHolding' | 'maxInsider' | 'maxTop10Holders';
  ok: boolean;
  message?: string;
}

// Snapshot of a pre-migration pump.fun candidate's growth, taken every
// premigrationWatchlistMonitor tick - marketCapUsd is tracked over
// successive rows so "watch the growth" is visible as a time series, even
// though the current graduation gate (see premigrationFilter.ts) only
// requires the latest reading to clear the thresholds, not a strict
// upward trend.
export interface PremigrationSnapshot {
  id: number;
  detectedPoolId: number;
  checkedAt: number;
  marketCapUsd: number | null;
  devHoldingPct: number | null;
  insiderPct: number | null;
  top10HoldersPct: number | null;
  ageMinutes: number | null;
  hasData: boolean;
  pass: boolean;
  criteria: PremigrationCriterionResult[];
  configVersionId: number;
}

export interface FilterOutcome {
  detectedPoolId: number;
  filterName: 'burn' | 'renouncedFreeze' | 'poolSize' | 'mutable' | 'holderConcentration' | 'insiderConcentration' | 'devRisk' | 'freshWallet';
  pass: boolean;
  message?: string;
  attemptNumber: number;
  configVersionId: number;
  checkedAt: number;
}

export type FillOutcome = 'filled' | 'reverted_slippage' | 'error';
export type FillSide = 'buy' | 'sell';
export type ExecutionMode = 'standard' | 'priority';

export interface SimulatedFill {
  id?: number;
  positionId: number | null;
  side: FillSide;
  attemptNumber: number;
  executionMode: ExecutionMode;
  decisionAt: number;
  decisionMidPrice: number;
  decisionAmountIn: string;
  modeledLatencyMs: number;
  actualElapsedMs: number;
  fillAt: number;
  fillMidPrice: number | null;
  fillExecutionPrice: number | null;
  fillAmountOut: string | null;
  latencyDriftPct: number | null;
  priceImpactPct: number | null;
  totalSlippagePct: number | null;
  slippageTolerancePct: number;
  outcome: FillOutcome;
  configVersionId: number;
  /** Compute-unit priority fee / Jito tip paid for this attempt, in quote units. 0 for 'error' (never reached the chain). */
  feeQuote: number;
}

export type PositionStatus = 'open' | 'closed_tp' | 'closed_sl' | 'closed_timeout' | 'closed_manual' | 'closed_ai_exit' | 'closed_structural';

// Sentinel meaning "no peak recorded yet" - the first real unrealized P&L
// reading becomes the peak naturally via Math.max, avoiding a nullable field.
export const PEAK_PROFIT_UNSET = -1000;

export interface Position {
  id: number;
  detectedPoolId: number;
  baseMint: string;
  status: PositionStatus;
  entryFillId: number;
  exitFillId: number | null;
  quoteSizeIn: string;
  baseAmountHeld: string;
  entryPrice: number;
  exitPrice: number | null;
  takeProfitPctSnapshot: number;
  stopLossPctSnapshot: number;
  realizedPnlQuote: number | null;
  realizedPnlPct: number | null;
  openedAt: number;
  closedAt: number | null;
  configVersionId: number;
  source: Venue;
  /** Highest unrealized P&L % seen since entry - drives trailing exits. PEAK_PROFIT_UNSET until the first tick. */
  peakProfitPct: number;
  /** Immutable entry-time snapshot - quoteSizeIn above is the CURRENTLY REMAINING open size, decremented by each partial exit. Identical to quoteSizeIn for a position with zero partials. */
  originalQuoteSizeIn: string;
  /** Immutable entry-time snapshot - see originalQuoteSizeIn. */
  originalBaseAmountHeld: string;
  /** From DexScreener at buy time - best-effort, null if not yet indexed. */
  tokenName: string | null;
  entryMarketCapUsd: number | null;
  /** From DexScreener at the moment the position fully closes - null while still open or if unavailable. */
  exitMarketCapUsd: number | null;
  /** Set only when status === 'closed_ai_exit' - the AI's stated reason for exiting early. Null otherwise. */
  aiExitReasoning: string | null;
}

export interface PartialExit {
  id: number;
  positionId: number;
  exitFillId: number;
  /** The take-profit target's pct threshold that fired this leg; null for trailing/stop_loss/timeout/manual full closes. */
  targetPct: number | null;
  sellFractionOfOriginal: number;
  baseAmountSold: string;
  quoteSizeInPortion: number;
  quoteReceivedUi: number;
  exitPrice: number;
  realizedPnlQuote: number;
  realizedPnlPct: number;
  reason: 'target' | 'trailing' | 'stop_loss' | 'timeout' | 'manual';
  closedAt: number;
}

export interface EquitySnapshot {
  ts: number;
  virtualBalanceQuote: number;
  openUnrealizedQuote: number;
  totalEquityQuote: number;
  realizedPnlCumulative: number;
  numOpenPositions: number;
  numClosedTrades: number;
}

export interface StrategyConfigVersion {
  id: number;
  versionNumber: number;
  createdAt: number;
  createdBy: 'seed' | 'agent' | 'user';
  parentVersionId: number | null;
  applied: boolean;
  config: StrategyConfig;
  rationale: string | null;
}

export type AgentSuggestionStatus = 'proposed' | 'applied' | 'rejected' | 'superseded';

export interface AgentSuggestion {
  id: number;
  createdAt: number;
  basedOnVersionId: number;
  proposedVersionId: number | null;
  status: AgentSuggestionStatus;
  source: 'heuristic' | 'llm' | 'runner-review';
  rationale: string;
  statsSnapshot: unknown;
  diff: Record<string, { old: unknown; new: unknown }>;
}
