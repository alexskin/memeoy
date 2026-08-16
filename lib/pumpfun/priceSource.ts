import { Connection, PublicKey } from '@solana/web3.js';
import { PriceSource } from '../priceSource/types';
import { decodeBondingCurveAccount } from './state';
import { computeBondingCurveQuote } from './curve';
import { NATIVE_SOL_DECIMALS, PUMPFUN_TOKEN_DECIMALS } from './constants';

export class CurveGraduatedError extends Error {
  constructor(mint: string) {
    super(`Bonding curve for ${mint} has graduated to Raydium - pump.fun pricing no longer applies`);
    this.name = 'CurveGraduatedError';
  }
}

// Each getQuote() call re-fetches the bonding curve account fresh (mirrors
// the Raydium PriceSource's fresh Liquidity.fetchInfo per quote) so the
// decision -> latency -> re-quote pipeline in fillSimulator.ts measures a
// real price drift, not a cached snapshot.
export function createPumpFunPriceSource(
  connection: Connection,
  mint: PublicKey,
  bondingCurveAddress: PublicKey,
): PriceSource {
  return {
    venue: 'pumpfun',
    baseMint: mint.toString(),
    baseDecimals: PUMPFUN_TOKEN_DECIMALS,
    quoteDecimals: NATIVE_SOL_DECIMALS,
    async getQuote(direction, amountInRaw, slippagePct) {
      const accountInfo = await connection.getAccountInfo(bondingCurveAddress);
      if (!accountInfo?.data) {
        throw new Error(`Bonding curve account not found: ${bondingCurveAddress.toString()}`);
      }

      const curve = decodeBondingCurveAccount(accountInfo.data);
      if (curve.complete) {
        throw new CurveGraduatedError(mint.toString());
      }

      return computeBondingCurveQuote({
        curve,
        direction,
        amountInRaw: BigInt(amountInRaw),
        slippagePct,
        baseDecimals: PUMPFUN_TOKEN_DECIMALS,
        quoteDecimals: NATIVE_SOL_DECIMALS,
      });
    },
  };
}
