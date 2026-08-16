// Models the delay between "decision to trade" and "simulated fill" - RPC
// round-trip + tx build + network propagation + block confirmation in the
// real bot. Deliberately NOT part of the tuning agent's tunable-parameter
// set (see lib/agent/heuristicTuner.ts TUNABLE_KEYS) - these presets
// describe infra realism, not strategy, and letting the agent "tune" them
// toward zero would let it cheat instead of improving the actual strategy.
import { ExecutionMode, StrategyConfig } from '../types';

interface LatencyRange {
  minMs: number;
  p95Ms: number;
  maxMs: number;
}

// Skewed toward the low end with an occasional long tail, derived so that
// the 95th percentile of the sampled distribution lands at range.p95Ms.
// value = min + (max-min) * u^skew, u ~ Uniform(0,1); solving
// CDF(p95Ms) = 0.95 for skew gives the closed form below.
export function sampleLatencyMs(range: LatencyRange): number {
  const { minMs, p95Ms, maxMs } = range;
  if (maxMs <= minMs) return minMs;

  const ratio = Math.min(0.999, Math.max(0.001, (p95Ms - minMs) / (maxMs - minMs)));
  const skew = Math.log(ratio) / Math.log(0.95);
  const u = Math.random();
  const value = minMs + (maxMs - minMs) * Math.pow(u, skew);
  return Math.round(Math.min(maxMs, Math.max(minMs, value)));
}

export function sampleLatencyForMode(config: StrategyConfig, mode: ExecutionMode): number {
  return sampleLatencyMs(config.latencyModel[mode]);
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
