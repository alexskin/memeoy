// Pure constant-product AMM math on REAL reserves (unlike pump.fun's
// bonding curve, which uses virtual reserves) - no I/O, independently
// testable. k = baseReserveRaw * quoteReserveRaw stays constant across a
// trade, fee taken off the input side. Same bigint discipline as
// lib/pumpfun/curve.ts: real reserves can reach ~1e11 (SOL lamports) *
// ~1e15 (raw token units at 6 decimals for a billion-supply token) ~= 1e26,
// past Number.MAX_SAFE_INTEGER, so the k step must stay in bigint.
import { QuoteResult, SwapDirection } from '../priceSource/types';

export interface PumpSwapQuoteParams {
  baseReserveRaw: bigint;
  quoteReserveRaw: bigint;
  direction: SwapDirection;
  amountInRaw: bigint;
  slippagePct: number;
  baseDecimals: number;
  quoteDecimals: number;
  feeBps: number;
}

const BPS_DENOMINATOR = 10_000n;

export function computePumpSwapQuote(params: PumpSwapQuoteParams): QuoteResult {
  const { baseReserveRaw, quoteReserveRaw, direction, amountInRaw, slippagePct, baseDecimals, quoteDecimals } = params;
  const feeBps = BigInt(params.feeBps);

  const k = baseReserveRaw * quoteReserveRaw;
  const effectiveIn = amountInRaw - (amountInRaw * feeBps) / BPS_DENOMINATOR;

  let amountOutRaw: bigint;
  if (direction === 'buy') {
    // Input is quote (SOL), output is base (token).
    const newQuoteReserves = quoteReserveRaw + effectiveIn;
    const newBaseReserves = newQuoteReserves > 0n ? k / newQuoteReserves : baseReserveRaw;
    amountOutRaw = baseReserveRaw > newBaseReserves ? baseReserveRaw - newBaseReserves : 0n;
  } else {
    // Input is base (token), output is quote (SOL).
    const newBaseReserves = baseReserveRaw + effectiveIn;
    const newQuoteReserves = newBaseReserves > 0n ? k / newBaseReserves : quoteReserveRaw;
    amountOutRaw = quoteReserveRaw > newQuoteReserves ? quoteReserveRaw - newQuoteReserves : 0n;
  }

  const slippageBps = BigInt(Math.max(0, Math.round(slippagePct * 100)));
  const minAmountOutRaw = (amountOutRaw * (BPS_DENOMINATOR - slippageBps)) / BPS_DENOMINATOR;

  const baseReservesUi = Number(baseReserveRaw) / 10 ** baseDecimals;
  const quoteReservesUi = Number(quoteReserveRaw) / 10 ** quoteDecimals;
  const midPrice = baseReservesUi === 0 ? 0 : quoteReservesUi / baseReservesUi;

  const amountInUi = Number(amountInRaw) / 10 ** (direction === 'buy' ? quoteDecimals : baseDecimals);
  const amountOutUi = Number(amountOutRaw) / 10 ** (direction === 'buy' ? baseDecimals : quoteDecimals);
  const executionPrice =
    amountOutUi === 0 ? midPrice : direction === 'buy' ? amountInUi / amountOutUi : amountOutUi / amountInUi;

  return {
    midPrice,
    executionPrice,
    amountOutRaw: amountOutRaw.toString(),
    minAmountOutRaw: minAmountOutRaw.toString(),
  };
}
