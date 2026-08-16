// Pure evaluation function, no I/O - checks a DexScreener pair against the
// user's momentum thresholds (mirrors their DexScreener /new-pairs screener
// URL 1:1). Shape mirrors lib/filters/types.ts's NamedFilterResult spirit so
// the dashboard's existing pass/fail badge rendering pattern extends here
// naturally.
import { MomentumCriterionResult, StrategyConfig } from '../types';
import { DexScreenerPair } from './types';

export interface MomentumEvaluation {
  pass: boolean;
  results: MomentumCriterionResult[];
  pairAgeMinutes: number | null;
  hasData: boolean;
}

export function evaluateMomentum(
  pair: DexScreenerPair | null,
  detectedAtMs: number,
  config: StrategyConfig,
  now = Date.now(),
): MomentumEvaluation {
  // Fall back to our own detection time if DexScreener hasn't indexed this
  // mint yet, so "age" is still meaningful for the maxAge eviction check.
  const ageMinutes = pair?.pairCreatedAt != null ? (now - pair.pairCreatedAt) / 60_000 : (now - detectedAtMs) / 60_000;

  if (!pair) {
    return {
      pass: false,
      hasData: false,
      pairAgeMinutes: ageMinutes,
      results: [{ criterionName: 'maxAge', ok: ageMinutes <= config.momentumMaxAgeMinutes, message: 'No DexScreener data yet' }],
    };
  }

  const liquidity = pair.liquidity?.usd ?? 0;
  const vol24h = pair.volume.h24 ?? 0;
  const buys1h = pair.txns.h1?.buys ?? 0;
  const buys5m = pair.txns.m5?.buys ?? 0;
  const chg24h = pair.priceChange.h24 ?? 0;
  const chg1h = pair.priceChange.h1 ?? 0;

  const results: MomentumCriterionResult[] = [
    { criterionName: 'minLiquidity', ok: liquidity >= config.momentumMinLiquidityUsd, message: `liquidity $${liquidity.toFixed(0)} (need >= $${config.momentumMinLiquidityUsd})` },
    { criterionName: 'minAge', ok: ageMinutes >= config.momentumMinAgeMinutes, message: `age ${ageMinutes.toFixed(1)}min (need >= ${config.momentumMinAgeMinutes}min)` },
    { criterionName: 'maxAge', ok: ageMinutes <= config.momentumMaxAgeMinutes, message: `age ${ageMinutes.toFixed(1)}min (must be <= ${config.momentumMaxAgeMinutes}min)` },
    { criterionName: 'min1hBuys', ok: buys1h >= config.momentumMin1hBuys, message: `1h buys ${buys1h} (need >= ${config.momentumMin1hBuys})` },
    { criterionName: 'min5mBuys', ok: buys5m >= config.momentumMin5mBuys, message: `5m buys ${buys5m} (need >= ${config.momentumMin5mBuys})` },
    { criterionName: 'min24hVolume', ok: vol24h >= config.momentumMin24hVolumeUsd, message: `24h vol $${vol24h.toFixed(0)} (need >= $${config.momentumMin24hVolumeUsd})` },
    { criterionName: 'min24hChange', ok: chg24h >= config.momentumMin24hChangePct, message: `24h chg ${chg24h.toFixed(1)}% (need >= ${config.momentumMin24hChangePct}%)` },
    { criterionName: 'max24hChange', ok: chg24h <= config.momentumMax24hChangePct, message: `24h chg ${chg24h.toFixed(1)}% (must be <= ${config.momentumMax24hChangePct}%)` },
    { criterionName: 'min1hChange', ok: chg1h >= config.momentumMin1hChangePct, message: `1h chg ${chg1h.toFixed(1)}% (need >= ${config.momentumMin1hChangePct}%)` },
  ];

  return { pass: results.every((r) => r.ok), hasData: true, pairAgeMinutes: ageMinutes, results };
}
