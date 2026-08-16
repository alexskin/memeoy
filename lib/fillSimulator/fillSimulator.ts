// Core paper-trading fill simulator. Mirrors repo-reference/bot.ts's swap()
// retry loop and price math, but NEVER builds/signs/sends a transaction -
// every "fill" here is a ledger row computed from real market data. Venue-
// agnostic: drives whatever PriceSource it's given (Raydium AMM pool,
// pump.fun bonding curve, ...) through the identical pipeline.
//
// Mechanics per attempt (see plan section 4):
//  1. At decision time, quote the trade at the configured slippage
//     tolerance -> decisionMidPrice + the minAmountOut that would have been
//     submitted on-chain as the revert floor.
//  2. Sample a modeled latency and wait it out (lib/fillSimulator/latencyModel.ts).
//  3. Re-quote at slippage=0 against the source's state AFTER the delay -
//     this is "what the chain would actually give you right now" for the
//     same amountIn.
//  4. If that actual amountOut is below the floor from step 1, the trade
//     would have reverted on-chain -> outcome 'reverted_slippage', retry.
//     Otherwise it fills at the actual amountOut/executionPrice.
import BN from 'bn.js';
import { costPct, PriceSource, SwapDirection, uiAmountToRaw } from '../priceSource/types';
import { sampleLatencyForMode, sleep } from './latencyModel';
import { computeExecutionFeeSol } from './executionFee';
import { ExecutionMode, SimulatedFill, StrategyConfig } from '../types';
import { logger } from '../logger';
import { withTimeout } from '../solana/withTimeout';

const QUOTE_TIMEOUT_MS = 15_000;

export interface SimulateSwapParams {
  priceSource: PriceSource;
  direction: SwapDirection;
  side: 'buy' | 'sell';
  amountInRaw: string;
  slippagePct: number;
  maxRetries: number;
  config: StrategyConfig;
  positionId: number | null;
  configVersionId: number;
}

export interface SimulateSwapOutcome {
  fills: SimulatedFill[];
  success: boolean;
  finalFill?: SimulatedFill;
}

export async function simulateSwap(params: SimulateSwapParams): Promise<SimulateSwapOutcome> {
  const { priceSource, direction, side, amountInRaw, slippagePct, maxRetries, config, positionId, configVersionId } =
    params;

  const executionMode: ExecutionMode = config.executionMode;
  const fills: SimulatedFill[] = [];

  for (let attempt = 1; attempt <= Math.max(1, maxRetries); attempt++) {
    const decisionAt = Date.now();

    if (config.tradingMode === 'live') {
      const fill = await executeLiveSwapAttempt({ priceSource, direction, side, amountInRaw, slippagePct, config, positionId, configVersionId, attempt, executionMode, decisionAt });
      fills.push(fill);
      if (fill.outcome === 'filled') return { fills, success: true, finalFill: fill };
      logger.warn({ mint: priceSource.baseMint, attempt, error: fill.outcome }, `Live ${side} attempt did not confirm`);
      continue;
    }

    try {
      const decisionQuote = await withTimeout(priceSource.getQuote(direction, amountInRaw, slippagePct), QUOTE_TIMEOUT_MS, 'decision quote');

      const latencyMs = sampleLatencyForMode(config, executionMode);
      await sleep(latencyMs);

      const fillAt = Date.now();
      const actualQuote = await withTimeout(priceSource.getQuote(direction, amountInRaw, 0), QUOTE_TIMEOUT_MS, 'fill quote');

      const reverted = new BN(actualQuote.amountOutRaw).lt(new BN(decisionQuote.minAmountOutRaw));
      // Lands in a block either way (filled or program-reverted) - pays the fee either way.
      const feeQuote = computeExecutionFeeSol(config, executionMode);

      const fill: SimulatedFill = {
        positionId,
        side,
        attemptNumber: attempt,
        executionMode,
        decisionAt,
        decisionMidPrice: decisionQuote.midPrice,
        decisionAmountIn: amountInRaw,
        modeledLatencyMs: latencyMs,
        actualElapsedMs: fillAt - decisionAt,
        fillAt,
        fillMidPrice: actualQuote.midPrice,
        fillExecutionPrice: reverted ? null : actualQuote.executionPrice,
        fillAmountOut: reverted ? null : actualQuote.amountOutRaw,
        latencyDriftPct: costPct(direction, decisionQuote.midPrice, actualQuote.midPrice),
        priceImpactPct: reverted ? null : costPct(direction, actualQuote.midPrice, actualQuote.executionPrice),
        totalSlippagePct: reverted ? null : costPct(direction, decisionQuote.midPrice, actualQuote.executionPrice),
        slippageTolerancePct: slippagePct,
        outcome: reverted ? 'reverted_slippage' : 'filled',
        configVersionId,
        feeQuote,
      };

      fills.push(fill);

      if (!reverted) {
        return { fills, success: true, finalFill: fill };
      }

      logger.debug(
        { mint: priceSource.baseMint, attempt },
        `Simulated ${side} reverted (slippage exceeded), retrying`,
      );
    } catch (error) {
      const fill: SimulatedFill = {
        positionId,
        side,
        attemptNumber: attempt,
        executionMode,
        decisionAt,
        decisionMidPrice: 0,
        decisionAmountIn: amountInRaw,
        modeledLatencyMs: 0,
        actualElapsedMs: Date.now() - decisionAt,
        fillAt: Date.now(),
        fillMidPrice: null,
        fillExecutionPrice: null,
        fillAmountOut: null,
        latencyDriftPct: null,
        priceImpactPct: null,
        totalSlippagePct: null,
        slippageTolerancePct: slippagePct,
        outcome: 'error',
        configVersionId,
        feeQuote: 0,
      };
      fills.push(fill);
      logger.error({ mint: priceSource.baseMint, error: String(error) }, `Simulated ${side} attempt failed`);
    }
  }

  return { fills, success: false };
}

// Only reached when config.tradingMode === 'live'. Mirrors the shape of a
// paper fill (same SimulatedFill record downstream code already knows how
// to consume - see fillSimulator.ts's header comment) but the numbers come
// from a real confirmed transaction instead of quote math. No latency model
// or slippage-revert simulation applies here - either the real transaction
// confirmed with real proceeds, or it didn't and this attempt is 'error'
// (never 'reverted_slippage', which specifically describes the paper
// simulator's own revert detection).
async function executeLiveSwapAttempt(params: {
  priceSource: PriceSource;
  direction: SwapDirection;
  side: 'buy' | 'sell';
  amountInRaw: string;
  slippagePct: number;
  config: StrategyConfig;
  positionId: number | null;
  configVersionId: number;
  attempt: number;
  executionMode: ExecutionMode;
  decisionAt: number;
}): Promise<SimulatedFill> {
  const { priceSource, direction, side, amountInRaw, slippagePct, config, positionId, configVersionId, attempt, executionMode, decisionAt } = params;

  const base = {
    positionId,
    side,
    attemptNumber: attempt,
    executionMode,
    decisionAt,
    decisionAmountIn: amountInRaw,
    modeledLatencyMs: 0,
    slippageTolerancePct: slippagePct,
    configVersionId,
  };

  if (!priceSource.executeSwap) {
    logger.error(
      { mint: priceSource.baseMint, venue: priceSource.venue },
      `Live trading requested but "${priceSource.venue}" has no verified live-execution support - refusing to guess an instruction format for a real-money trade`,
    );
    return { ...base, decisionMidPrice: 0, fillAt: Date.now(), actualElapsedMs: Date.now() - decisionAt, fillMidPrice: null, fillExecutionPrice: null, fillAmountOut: null, latencyDriftPct: null, priceImpactPct: null, totalSlippagePct: null, outcome: 'error', feeQuote: 0 };
  }

  try {
    const quote = await withTimeout(priceSource.getQuote(direction, amountInRaw, slippagePct), QUOTE_TIMEOUT_MS, 'live pre-swap quote');
    // Live execution always uses standard compute-budget instructions
    // (the only path with a verified working reference, repo-reference's
    // "default" executor) regardless of config.executionMode - Warp/Jito
    // execution isn't implemented for live trading.
    const result = await priceSource.executeSwap(direction, amountInRaw, quote.minAmountOutRaw, config.executionFees.standard);
    const feeQuote = computeExecutionFeeSol(config, 'standard');
    const fillAt = Date.now();
    const common = { ...base, decisionMidPrice: quote.midPrice, fillAt, actualElapsedMs: fillAt - decisionAt, latencyDriftPct: null, priceImpactPct: null, totalSlippagePct: null, feeQuote };

    if (!result.confirmed) {
      logger.warn({ mint: priceSource.baseMint, signature: result.signature, error: result.error }, `Live ${side} transaction did not confirm`);
      return { ...common, fillMidPrice: null, fillExecutionPrice: null, fillAmountOut: null, outcome: 'error' };
    }

    return {
      ...common,
      fillMidPrice: result.executionPrice ?? quote.midPrice,
      fillExecutionPrice: result.executionPrice ?? null,
      fillAmountOut: result.amountOutRaw ?? null,
      outcome: 'filled',
    };
  } catch (error) {
    logger.error({ mint: priceSource.baseMint, error: String(error) }, `Live ${side} attempt threw`);
    return { ...base, decisionMidPrice: 0, fillAt: Date.now(), actualElapsedMs: Date.now() - decisionAt, fillMidPrice: null, fillExecutionPrice: null, fillAmountOut: null, latencyDriftPct: null, priceImpactPct: null, totalSlippagePct: null, outcome: 'error', feeQuote: 0 };
  }
}

// Sum of fees actually paid across every attempt in an outcome, including
// failed/reverted retries - real gas wars cost money even when you lose them.
export function totalFeesPaid(fills: SimulatedFill[]): number {
  return fills.reduce((sum, f) => sum + f.feeQuote, 0);
}

export function simulateBuy(
  priceSource: PriceSource,
  quoteAmountInUi: number,
  config: StrategyConfig,
  configVersionId: number,
): Promise<SimulateSwapOutcome> {
  return simulateSwap({
    priceSource,
    direction: 'buy',
    side: 'buy',
    amountInRaw: uiAmountToRaw(quoteAmountInUi, priceSource.quoteDecimals),
    slippagePct: config.buySlippagePct,
    maxRetries: config.maxBuyRetries,
    config,
    positionId: null,
    configVersionId,
  });
}

export function simulateSell(
  priceSource: PriceSource,
  baseAmountInUi: number,
  config: StrategyConfig,
  positionId: number,
  configVersionId: number,
): Promise<SimulateSwapOutcome> {
  return simulateSwap({
    priceSource,
    direction: 'sell',
    side: 'sell',
    amountInRaw: uiAmountToRaw(baseAmountInUi, priceSource.baseDecimals),
    slippagePct: config.sellSlippagePct,
    maxRetries: config.maxSellRetries,
    config,
    positionId,
    configVersionId,
  });
}
