// Venue-neutral abstraction so the fill simulator / position monitor can
// drive a Raydium AMM pool, a pump.fun bonding curve, or a PumpSwap AMM pool
// through the identical decision -> latency -> re-quote -> revert-check
// pipeline without knowing which venue they're looking at. See
// lib/fillSimulator/slippage.ts (createRaydiumPriceSource),
// lib/pumpfun/priceSource.ts (createPumpFunPriceSource), and
// lib/pumpswap/priceSource.ts (createPumpSwapPriceSource).
export type SwapDirection = 'buy' | 'sell';
export type Venue = 'raydium' | 'pumpfun' | 'pumpswap';

export interface QuoteResult {
  midPrice: number; // quote per base, size-independent (e.g. reserve ratio)
  executionPrice: number; // quote per base, this trade's actual average fill price
  amountOutRaw: string;
  minAmountOutRaw: string;
}

export interface LiveSwapResult {
  confirmed: boolean;
  signature: string;
  /** Only meaningful when confirmed=true - the real executed price/amountOut, read back from the transaction. */
  amountOutRaw?: string;
  executionPrice?: number;
  error?: string;
}

export interface PriceSource {
  readonly venue: Venue;
  readonly baseMint: string;
  readonly baseDecimals: number;
  readonly quoteDecimals: number;
  getQuote(direction: SwapDirection, amountInRaw: string, slippagePct: number): Promise<QuoteResult>;
  /**
   * Builds, signs, and sends a REAL on-chain swap - only present on venues
   * with a verified, working instruction-building path (Raydium only today,
   * see lib/fillSimulator/slippage.ts). Absent on venues without one
   * (PumpSwap, pump.fun) - callers must treat a missing executeSwap as "live
   * trading unsupported on this venue" and fail safe, never fall back to
   * paper-simulating a trade the user asked to be real.
   */
  executeSwap?(
    direction: SwapDirection,
    amountInRaw: string,
    minAmountOutRaw: string,
    feeParams: { computeUnitLimit: number; computeUnitPriceMicroLamports: number },
  ): Promise<LiveSwapResult>;
}

// "Cost" framing so both directions read the same way: positive = worse for
// the trader (paid more on a buy, received less on a sell), regardless of
// direction. Used for latency-drift, price-impact, and total-slippage %.
export function costPct(direction: SwapDirection, referencePrice: number, actualPrice: number): number {
  if (referencePrice === 0) return 0;
  return direction === 'buy'
    ? ((actualPrice - referencePrice) / referencePrice) * 100
    : ((referencePrice - actualPrice) / referencePrice) * 100;
}

// Replaces Raydium SDK's TokenAmount(ui, false) UI->raw conversion for
// venue-agnostic callers. Math.round avoids float artifacts like
// 0.05 * 1e9 === 50000000.000000007.
export function uiAmountToRaw(amountUi: number, decimals: number): string {
  return Math.round(amountUi * 10 ** decimals).toString();
}
