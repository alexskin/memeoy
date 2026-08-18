import { StrategyConfig } from '../types';

// Mirrors repo-reference/.env.copy defaults, adapted for paper trading
// (no wallet -> position sizing / starting balance / agent settings added).
export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  tradingMode: 'paper',

  quoteMint: 'WSOL',
  positionSizeMode: 'fixed',
  positionSizeValue: 0.05,
  autoBuyDelayMs: 0,
  maxBuyRetries: 10,
  buySlippagePct: 20,

  autoSellDelayMs: 0,
  maxSellRetries: 10,
  sellSlippagePct: 20,
  priceCheckIntervalMs: 2000,
  // Hard safety cap even in trailing mode - raised from the reference bot's
  // 10min default to give a genuine pump more room to keep running.
  priceCheckDurationMs: 1_200_000,
  stopLossPct: 20,

  exitStrategy: 'trailing',
  takeProfitPct: 40,
  trailingActivationPct: 40, // start trailing once a trade would have hit the old fixed target
  trailingStopPct: 15, // exit once P&L pulls back 15 percentage-points from its peak

  aiExitReviewEnabled: true,
  // 120s, not 60s - a trigger becoming active (SL/TP/timeout) still forces
  // an immediate review regardless of this interval (see
  // positionMonitor.ts's anyTriggerActive check), so this only slows down
  // the routine "nothing's happening, just checking in" cadence, not safety
  // reviews. Halves exit-review call volume - cost-conscious per the user's
  // explicit ask to trim Anthropic spend.
  aiExitReviewIntervalMs: 120_000,
  aiTimeoutExtensionMs: 600_000, // +10min (half of the 20min default priceCheckDurationMs), one-time only

  // 3000ms/45s, not 2000ms/60s - a doomed candidate (mint/freeze authority
  // never renounced) runs this whole loop to exhaustion, one Helius RPC call
  // per iteration: filterCheckDurationMs/filterCheckIntervalMs = up to 15
  // calls now, down from 30. Most detected pools never pass this loop (the
  // large majority get rejected here), so this is the single biggest Helius
  // cost lever available without restructuring the detection pipeline -
  // still leaves 45s for a dev to renounce shortly after launch, which is
  // when it typically happens if it happens at all. Cost-conscious per the
  // user's explicit ask to trim Helius spend.
  filterCheckIntervalMs: 3000,
  filterCheckDurationMs: 45_000,
  consecutiveFilterMatches: 3,
  checkRenounced: true,
  checkFreezable: false,
  checkBurned: true,
  checkMutable: false,
  checkSocials: false,
  minPoolSizeQuote: 5,
  maxPoolSizeQuote: 50,

  checkHolderConcentration: true,
  momentumMaxTopHolderPct: 15,

  checkInsiderConcentration: true,
  momentumMaxInsiderPct: 10,
  momentumMaxInsiderWalletCount: 30,

  // Originally mirrored the user's DexScreener /new-pairs reference screener
  // 1:1 (minLiq=10000, min1HBuys=50, min24HVol=100000, ...), but that's tuned
  // for filtering an already-large pool of live pairs, not for a fresh
  // Raydium pool our own on-chain listener just caught seconds/minutes old -
  // at that age, 24h volume/1h buys can't possibly have accumulated yet.
  // Deliberately widened so real candidates actually reach a buy and the
  // self-tuning agent (lib/agent/heuristicTuner.ts) has real trade outcomes
  // to learn from and tighten these back up over time, instead of us
  // guessing the right thresholds up front.
  momentumEnabled: true,
  momentumMinLiquidityUsd: 2_000,
  momentumMinAgeMinutes: 3,
  momentumMaxAgeMinutes: 720,
  momentumMin1hBuys: 8,
  momentumMin5mBuys: 3,
  momentumMin24hVolumeUsd: 5_000,
  momentumMin24hChangePct: -60,
  // Was 300 - live-traced 2026-08-17: every single real 24h+ runner we
  // detected (checked 4 by hand, e.g. one at 190,839% 24h change with 3,243
  // buys/1h and $566k liquidity - every other criterion passed cleanly)
  // failed ONLY this one, because it had already pumped past 300% by the
  // time our own PumpSwap-pool-creation listener even saw it (post
  // pump.fun-migration detection is inherently "after some price discovery
  // already happened", not "at the literal instant of creation"). A fresh
  // runner-review scan confirmed this isn't a fluke: 52 real runners
  // (>=100% in 24h) detected in 24h, only 1 ever bought. Raised to
  // effectively uncapped - min1hChangePct below already catches an actual
  // active reversal in real time, which is the risk this cap was meant to
  // guard against; a static 24h ceiling was just excluding the exact
  // population being chased. Not added to heuristicTuner.ts's tunable
  // BOUNDS (would need real trade outcomes at high 24h-change entries to
  // calibrate a real ceiling, which we have none of yet since this gate
  // blocked every one).
  momentumMax24hChangePct: 1_000_000,
  momentumMin1hChangePct: -20,
  momentumPollIntervalMs: 20_000,
  // Was 300 - live-checked 2026-08-18: the watchlist was CHRONICALLY at
  // capacity (300/300 pools in 'watching' status) with every ~20s tick
  // evicting 2-10 of the oldest candidates just to make room for new
  // pumpswap detections, before those candidates had time to accumulate
  // enough 1h/5m buys to ever clear momentum. Raised to 450 to give real
  // candidates more dwell time. getTokensBatch is rate-limited to 55
  // req/min in batches of 30 - at 450 pools/poll * 3 polls/min (20s
  // interval) that's ceil(450/30)*3 = 45 req/min, still under budget.
  momentumMaxWatchlistSize: 450,

  // Revival gate defaults mirror the DexScreener screener URL worked out
  // interactively this session (dexscreener.com/solana?minAge=...&min6HChg=
  // -8&max6HChg=8&min1HChg=3&max1HChg=25&min5MVol=3000&min1HBuys=15&
  // minLiq=20000): a candidate that's 12h-14d old, roughly flat over the
  // last 6h, and just started ticking up over the last 1h.
  revivalMinAgeMinutes: 12 * 60,
  revivalMaxAgeMinutes: 14 * 24 * 60,
  revivalMin6hChangePct: -8,
  revivalMax6hChangePct: 8,
  revivalMin1hChangePct: 3,
  revivalMax1hChangePct: 25,
  revivalMin5mVolumeUsd: 3_000,
  revivalMin1hBuys: 15,
  revivalMinLiquidityUsd: 20_000,

  // Runner review defaults: every 4h, look at pools detected in the last 6h
  // (bought or skipped) and re-check them against CURRENT DexScreener data -
  // "runner" = +150% in 24h with at least $3k of live liquidity (a floor
  // against illiquid wicks that swing wildly on trivial volume).
  runnerReviewEnabled: true,
  runnerReviewIntervalMs: 4 * 60 * 60 * 1000,
  runnerLookbackHours: 6,
  runnerThresholdPct: 150,
  runnerMinLiquidityUsd: 3_000,

  degenScoreEnabled: true,
  decisionEngineEnabled: true,

  takeProfitTargets: [
    { pct: 20, sellFraction: 0.33 },
    { pct: 50, sellFraction: 0.33 },
    // remaining ~34% rides the trailing-stop logic above
  ],

  executionMode: 'standard',
  latencyModel: {
    standard: { minMs: 300, p95Ms: 2200, maxMs: 3000 },
    priority: { minMs: 120, p95Ms: 600, maxMs: 900 },
  },
  executionFees: {
    // Mirrors repo-reference/.env.copy: COMPUTE_UNIT_LIMIT=101337, COMPUTE_UNIT_PRICE=421197
    standard: { computeUnitLimit: 101337, computeUnitPriceMicroLamports: 421197 },
    // Mirrors repo-reference/.env.copy: CUSTOM_FEE=0.006 (flat warp/jito tip)
    priority: { flatFeeSol: 0.006 },
  },

  startingBalanceQuote: 10,
  maxConcurrentPositions: 5,

  agentMode: 'propose-only',
  agentTriggerEveryNTrades: 10,
  agentMinIntervalMs: 6 * 60 * 60 * 1000,
  agentMinTradesForProposal: 10,

  // Wallet copy-trade advisory - empty by default (nobody forking this repo
  // should silently start tracking a stranger's wallet). See README for an
  // example of a wallet worth tracking and how to add one from the
  // dashboard's Wallet Alerts tab. Advisory only, never auto-buys.
  trackedWallets: [],
  // Off by default - lib/walletTracker/heliusClient.ts calls Helius's
  // proprietary Enhanced Transactions API (not standard RPC), so this only
  // works when RPC_ENDPOINT is a Helius URL. Taken offline 2026-08-18 when
  // switching the primary RPC away from Helius; re-enable if a Helius key
  // is configured again (doesn't need to be the primary RPC_ENDPOINT).
  walletAlertsEnabled: false,
  walletTrackerPollIntervalMs: 20_000,
  walletAlertStopLossPct: 20,
  walletAlertTarget1Pct: 35,
  walletAlertTarget2Pct: 70,
  walletAlertTrailingStopPct: 15,
  walletAlertMaxHoldMinutes: 15,

  // Creator-launch tracking - empty by default. Addresses here get a live
  // Discord + dashboard alert the instant they create a brand-new pump.fun
  // token, before it's even migrated - see lib/pumpfun/createEventDecoder.ts.
  trackedCreators: [],

  // Burn tracking - empty by default. thresholdTokens is a plain token
  // count, computed once from a USD target at setup time (price-at-setup),
  // not re-converted live.
  trackedBurnMints: [],

  // Pre-migration pump.fun growth watchlist - off by default until the
  // worker has live RPC access to verify creation detection actually works
  // (see lib/pumpfun/listener.ts). Thresholds mirror the user's reference
  // screener (age max 15min, dev holding max 9%, insiders max 15%) plus
  // their added $10k market-cap floor; top10HoldersPct default of 100 means
  // "no effective cap" since the screener left that field blank. Risk
  // params (stopLoss/targets) are a starting point roughly 2x the general
  // strategy's, per the user's explicit ask for a higher-risk profile on
  // this cohort - meant to be refined by the agent/real data like every
  // other threshold in this config, not a final answer.
  pumpfunPremigrationEnabled: false,
  pumpfunPremigrationMaxAgeMinutes: 15,
  pumpfunPremigrationMinMarketCapUsd: 10_000,
  pumpfunPremigrationMaxDevHoldingPct: 9,
  pumpfunPremigrationMaxInsiderPct: 15,
  pumpfunPremigrationMaxTop10HoldersPct: 100,
  pumpfunPremigrationPollIntervalMs: 5_000,
  pumpfunPremigrationMaxWatchlistSize: 150,
  pumpfunPremigrationStopLossPct: 35,
  pumpfunPremigrationExitStrategy: 'trailing',
  pumpfunPremigrationTakeProfitPct: 80,
  pumpfunPremigrationTrailingActivationPct: 60,
  pumpfunPremigrationTrailingStopPct: 25,
  pumpfunPremigrationTakeProfitTargets: [
    { pct: 50, sellFraction: 0.3 },
    { pct: 120, sellFraction: 0.3 },
  ],
};

// Config versions persisted before a field existed won't have it after
// JSON.parse (bit us once already with executionFees). Fixes that at the
// source instead of scattering `?? DEFAULT_STRATEGY_CONFIG.x` fallbacks
// through every read site - always hydrate a raw parsed config through this
// before using it.
export function hydrateConfig(raw: Partial<StrategyConfig>): StrategyConfig {
  return { ...DEFAULT_STRATEGY_CONFIG, ...raw };
}
