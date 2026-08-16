import { PublicKey } from '@solana/web3.js';

export const ANCHOR_DISCRIMINATOR_LEN = 8;

export const PUMP_FUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

// Best-effort estimate - pump.fun has changed fee parameters before. Not
// ground truth; treat computeBondingCurveQuote's output as an approximation
// appropriate for paper trading, not an exact on-chain replica.
export const TRADING_FEE_BPS = 100;

export const PUMPFUN_TOKEN_DECIMALS = 6;
export const NATIVE_SOL_DECIMALS = 9;
