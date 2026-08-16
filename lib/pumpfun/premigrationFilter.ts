// Pure evaluation function, no I/O - mirrors lib/dexscreener/momentumFilter.ts's
// shape but for pre-migration pump.fun candidates, which have no DexScreener
// data to evaluate against (dexId:"pumpfun" pairs never carry a `liquidity`
// field - confirmed live, see scripts/worker.ts's top comment). Data instead
// comes from two independent best-effort sources the caller (premigration-
// WatchlistMonitor) fetches per tick: our own on-chain bonding-curve reserve
// read (market cap) and RugCheck (dev/insider/top10-holder %). Both must be
// present for hasData=true - a candidate with only one available is treated
// the same as "not ready yet" (fail-open to "keep watching", not a criteria
// failure), same convention as evaluateMomentum's missing-pair case.
import { PremigrationCriterionResult, StrategyConfig } from '../types';

export interface PremigrationCandidateData {
  marketCapUsd: number | null;
  devHoldingPct: number | null;
  insiderPct: number | null;
  top10HoldersPct: number | null;
}

export interface PremigrationEvaluation {
  pass: boolean;
  results: PremigrationCriterionResult[];
  ageMinutes: number;
  hasData: boolean;
}

export function evaluatePremigration(
  data: PremigrationCandidateData | null,
  detectedAtMs: number,
  config: StrategyConfig,
  now = Date.now(),
): PremigrationEvaluation {
  const ageMinutes = (now - detectedAtMs) / 60_000;

  if (
    !data ||
    data.marketCapUsd == null ||
    data.devHoldingPct == null ||
    data.insiderPct == null ||
    data.top10HoldersPct == null
  ) {
    return {
      pass: false,
      hasData: false,
      ageMinutes,
      results: [{ criterionName: 'maxAge', ok: ageMinutes <= config.pumpfunPremigrationMaxAgeMinutes, message: 'Curve/RugCheck data not ready yet' }],
    };
  }

  const results: PremigrationCriterionResult[] = [
    { criterionName: 'maxAge', ok: ageMinutes <= config.pumpfunPremigrationMaxAgeMinutes, message: `age ${ageMinutes.toFixed(1)}min (must be <= ${config.pumpfunPremigrationMaxAgeMinutes}min)` },
    { criterionName: 'minMarketCap', ok: data.marketCapUsd >= config.pumpfunPremigrationMinMarketCapUsd, message: `market cap $${data.marketCapUsd.toFixed(0)} (need >= $${config.pumpfunPremigrationMinMarketCapUsd})` },
    { criterionName: 'maxDevHolding', ok: data.devHoldingPct <= config.pumpfunPremigrationMaxDevHoldingPct, message: `dev holding ${data.devHoldingPct.toFixed(1)}% (must be <= ${config.pumpfunPremigrationMaxDevHoldingPct}%)` },
    { criterionName: 'maxInsider', ok: data.insiderPct <= config.pumpfunPremigrationMaxInsiderPct, message: `insiders ${data.insiderPct.toFixed(1)}% (must be <= ${config.pumpfunPremigrationMaxInsiderPct}%)` },
    { criterionName: 'maxTop10Holders', ok: data.top10HoldersPct <= config.pumpfunPremigrationMaxTop10HoldersPct, message: `top10 holders ${data.top10HoldersPct.toFixed(1)}% (must be <= ${config.pumpfunPremigrationMaxTop10HoldersPct}%)` },
  ];

  return { pass: results.every((r) => r.ok), hasData: true, ageMinutes, results };
}
