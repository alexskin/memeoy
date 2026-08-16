import { PublicKey } from '@solana/web3.js';

export const PUMPSWAP_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');

export const ANCHOR_DISCRIMINATOR_LEN = 8;

// Anchor account discriminator for the `Pool` struct - confirmed live
// (subscribed to the program, decoded a real pool, cross-checked base/quote
// mint + liquidity against DexScreener for the same pair).
export const POOL_DISCRIMINATOR = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);

// Deliberately NOT filtering onProgramAccountChange by dataSize - a live
// 45s sample saw Pool accounts at 301, 300, AND 261 bytes (all matching the
// same 8-byte discriminator, presumably different on-chain schema-version
// ages), so any single dataSize would silently miss real pools. The
// discriminator memcmp alone is sufficient and collision-safe.
export const GLOBAL_CONFIG_SEED = 'global_config';

// Best-effort fallback only - lib/pumpswap/priceSource.ts fetches the real
// value from the on-chain GlobalConfig singleton once per process lifetime
// and uses this only if that fetch fails. Confirmed live via GlobalConfig:
// lp_fee_basis_points=20 (0.20%) + protocol_fee_basis_points=5 (0.05%).
export const PUMPSWAP_TOTAL_FEE_BPS = 25;
