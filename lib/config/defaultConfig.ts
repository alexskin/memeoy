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
  aiExitReviewIntervalMs: 60_000, // token-conscious - well below priceCheckIntervalMs's 2s tick
  aiTimeoutExtensionMs: 600_000, // +10min (half of the 20min default priceCheckDurationMs), one-time only

  filterCheckIntervalMs: 2000,
  filterCheckDurationMs: 60_000,
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
  momentumMax24hChangePct: 300,
  momentumMin1hChangePct: -20,
  momentumPollIntervalMs: 20_000,
  momentumMaxWatchlistSize: 300,

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
  walletAlertsEnabled: true,
  walletTrackerPollIntervalMs: 20_000,
  walletAlertStopLossPct: 20,
  walletAlertTarget1Pct: 35,
  walletAlertTarget2Pct: 70,
  walletAlertTrailingStopPct: 15,
  walletAlertMaxHoldMinutes: 15,

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
