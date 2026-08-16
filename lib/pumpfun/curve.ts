// Pure constant-product bonding-curve math, no I/O - independently testable
// and kept separate from priceSource.ts's account-fetching. Uses the
// VIRTUAL reserves (not real reserves) per pump.fun's pricing model:
// k = virtualSolReserves * virtualTokenReserves stays constant across a
// trade. Must do the k multiplication/division in bigint - virtual reserves
// reach roughly 3e10 (lamports) * 1e15 (raw token units) ~= 3.2e25, far past
// Number.MAX_SAFE_INTEGER (~9e15). Individual reserve values stay under that
// safe range, so only the intermediate product needs bigint.
import { QuoteResult, SwapDirection } from '../priceSource/types';
import { BondingCurveAccount } from './state';
import { TRADING_FEE_BPS } from './constants';

export interface BondingCurveQuoteParams {
  curve: BondingCurveAccount;
  direction: SwapDirection;
  amountInRaw: bigint;
  slippagePct: number;
  baseDecimals: number;
  quoteDecimals: number;
  feeBps?: number;
}

const BPS_DENOMINATOR = 10_000n;

export function computeBondingCurveQuote(params: BondingCurveQuoteParams): QuoteResult {
  const { curve, direction, amountInRaw, slippagePct, baseDecimals, quoteDecimals } = params;
  const feeBps = BigInt(params.feeBps ?? TRADING_FEE_BPS);

  const k = curve.virtualSolReserves * curve.virtualTokenReserves;
  const effectiveIn = amountInRaw - (amountInRaw * feeBps) / BPS_DENOMINATOR;

  let amountOutRaw: bigint;
  if (direction === 'buy') {
    const newVirtualSolReserves = curve.virtualSolReserves + effectiveIn;
    const newVirtualTokenReserves = newVirtualSolReserves > 0n ? k / newVirtualSolReserves : curve.virtualTokenReserves;
    amountOutRaw = curve.virtualTokenReserves > newVirtualTokenReserves ? curve.virtualTokenReserves - newVirtualTokenReserves : 0n;
  } else {
    const newVirtualTokenReserves = curve.virtualTokenReserves + effectiveIn;
    const newVirtualSolReserves = newVirtualTokenReserves > 0n ? k / newVirtualTokenReserves : curve.virtualSolReserves;
    amountOutRaw = curve.virtualSolReserves > newVirtualSolReserves ? curve.virtualSolReserves - newVirtualSolReserves : 0n;
  }

  const slippageBps = BigInt(Math.max(0, Math.round(slippagePct * 100)));
  const minAmountOutRaw = (amountOutRaw * (BPS_DENOMINATOR - slippageBps)) / BPS_DENOMINATOR;

  const solReservesUi = Number(curve.virtualSolReserves) / 10 ** quoteDecimals;
  const tokenReservesUi = Number(curve.virtualTokenReserves) / 10 ** baseDecimals;
  const midPrice = tokenReservesUi === 0 ? 0 : solReservesUi / tokenReservesUi;

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

// Same virtual-reserves price ratio computeBondingCurveQuote's midPrice
// uses, just exposed standalone so the premigration watchlist can compute a
// market cap without also computing a throwaway trade quote.
export function bondingCurveMarketCapUsd(
  curve: BondingCurveAccount,
  baseDecimals: number,
  quoteDecimals: number,
  solUsdPrice: number,
): number {
  const solReservesUi = Number(curve.virtualSolReserves) / 10 ** quoteDecimals;
  const tokenReservesUi = Number(curve.virtualTokenReserves) / 10 ** baseDecimals;
  const priceInSol = tokenReservesUi === 0 ? 0 : solReservesUi / tokenReservesUi;
  const totalSupplyUi = Number(curve.tokenTotalSupply) / 10 ** baseDecimals;
  return priceInSol * totalSupplyUi * solUsdPrice;
}
