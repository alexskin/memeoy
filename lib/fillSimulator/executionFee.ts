// Real Solana behavior this models: a transaction that lands in a block
// pays its priority fee / tip regardless of whether its own instruction
// logic then reverts (e.g. a slippage-check failure) - only a transaction
// that never got submitted (RPC error, etc.) pays nothing. So every
// 'filled' or 'reverted_slippage' fill attempt in fillSimulator.ts pays
// this; 'error' attempts don't.
import { ExecutionMode, StrategyConfig } from '../types';
import { DEFAULT_STRATEGY_CONFIG } from '../config/defaultConfig';

const LAMPORTS_PER_SOL = 1_000_000_000;

export function computeExecutionFeeSol(config: StrategyConfig, mode: ExecutionMode): number {
  // Config versions persisted before executionFees existed won't have this
  // key after JSON.parse - fall back to the current defaults rather than
  // crashing every buy/sell attempt under an old version.
  const fees = config.executionFees ?? DEFAULT_STRATEGY_CONFIG.executionFees;

  if (mode === 'priority') {
    return fees.priority.flatFeeSol;
  }

  const { computeUnitLimit, computeUnitPriceMicroLamports } = fees.standard;
  const lamports = (computeUnitLimit * computeUnitPriceMicroLamports) / 1_000_000;
  return lamports / LAMPORTS_PER_SOL;
}
