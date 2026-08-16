// Pure evaluation function, no I/O - same spirit as momentumFilter.ts, reuses
// the same already-fetched DexScreenerPair. Detects a "bait revival" shape:
// pumped at some point, went flat, and just started showing a fresh small
// volume+price uptick. One age range (12h-14d by default) deliberately spans
// both a ~1-day-old and a multi-day-old flatline - the flat-then-uptick shape
// itself is what matters, not exactly how long ago the original pump was, so
// there's no need for two separate evaluators.
import { RevivalCriterionResult, StrategyConfig } from '../types';
import { DexScreenerPair } from './types';

export interface RevivalEvaluation {
  pass: boolean;
  // 0-100, continuous - fraction of criteria passed, boosted if 24h change
  // is also elevated (the signature of a T-1-specific pump still baked into
  // the 24h window). Lets the decision engine weigh "how strong" a revival
  // looks instead of only seeing a boolean, per the user's explicit request
  // not to blindly gate on parameters alone.
  strengthScore: number;
  results: RevivalCriterionResult[];
  hasData: boolean;
}

export function evaluateRevival(pair: DexScreenerPair | null, config: StrategyConfig, now = Date.now()): RevivalEvaluation {
  if (!pair) {
    return { pass: false, strengthScore: 0, hasData: false, results: [] };
  }

  const ageMinutes = pair.pairCreatedAt != null ? (now - pair.pairCreatedAt) / 60_000 : null;
  const chg6h = pair.priceChange.h6 ?? null;
  const chg1h = pair.priceChange.h1 ?? null;
  const chg24h = pair.priceChange.h24 ?? null;
  const vol5m = pair.volume.m5 ?? 0;
  const buys1h = pair.txns.h1?.buys ?? 0;
  const liquidity = pair.liquidity?.usd ?? 0;

  const results: RevivalCriterionResult[] = [
    { criterionName: 'minAge', ok: ageMinutes !== null && ageMinutes >= config.revivalMinAgeMinutes, message: ageMinutes !== null ? `age ${ageMinutes.toFixed(0)}min (need >= ${config.revivalMinAgeMinutes}min)` : 'no age data' },
    { criterionName: 'maxAge', ok: ageMinutes !== null && ageMinutes <= config.revivalMaxAgeMinutes, message: ageMinutes !== null ? `age ${ageMinutes.toFixed(0)}min (must be <= ${config.revivalMaxAgeMinutes}min)` : 'no age data' },
    { criterionName: 'min6hChange', ok: chg6h !== null && chg6h >= config.revivalMin6hChangePct, message: chg6h !== null ? `6h chg ${chg6h.toFixed(1)}% (need >= ${config.revivalMin6hChangePct}%)` : 'no 6h data' },
    { criterionName: 'max6hChange', ok: chg6h !== null && chg6h <= config.revivalMax6hChangePct, message: chg6h !== null ? `6h chg ${chg6h.toFixed(1)}% (must be <= ${config.revivalMax6hChangePct}%)` : 'no 6h data' },
    { criterionName: 'min1hChange', ok: chg1h !== null && chg1h >= config.revivalMin1hChangePct, message: chg1h !== null ? `1h chg ${chg1h.toFixed(1)}% (need >= ${config.revivalMin1hChangePct}%)` : 'no 1h data' },
    { criterionName: 'max1hChange', ok: chg1h !== null && chg1h <= config.revivalMax1hChangePct, message: chg1h !== null ? `1h chg ${chg1h.toFixed(1)}% (must be <= ${config.revivalMax1hChangePct}%)` : 'no 1h data' },
    { criterionName: 'min5mVolume', ok: vol5m >= config.revivalMin5mVolumeUsd, message: `5m volume $${vol5m.toFixed(0)} (need >= $${config.revivalMin5mVolumeUsd})` },
    { criterionName: 'min1hBuys', ok: buys1h >= config.revivalMin1hBuys, message: `1h buys ${buys1h} (need >= ${config.revivalMin1hBuys})` },
    { criterionName: 'minLiquidity', ok: liquidity >= config.revivalMinLiquidityUsd, message: `liquidity $${liquidity.toFixed(0)} (need >= $${config.revivalMinLiquidityUsd})` },
  ];

  const passCount = results.filter((r) => r.ok).length;
  let strengthScore = (passCount / results.length) * 100;
  // T-1-specific signature: the original pump is still visible in the 24h
  // window on top of the flat-then-uptick shape - boost strength rather than
  // gating on it (a multi-day-old revival legitimately won't have this).
  if (chg24h !== null && chg24h >= 20) {
    strengthScore = Math.min(100, strengthScore + 10);
  }

  return { pass: results.every((r) => r.ok), strengthScore: Math.round(strengthScore), hasData: true, results };
}
