// PumpSwap Pool account decode. Field layout (after the 8-byte anchor
// discriminator) confirmed live: subscribed to the program, decoded a real
// pool, cross-checked base_mint/quote_mint/liquidity against DexScreener's
// data for the same pair. Only the first 211 bytes are read here (up
// through lp_supply) - real accounts run to 301/300/261 bytes depending on
// on-chain schema-version age, but nothing past lp_supply is needed: swap
// reserves live in the two token accounts named here, not on this struct.
import { PublicKey } from '@solana/web3.js';
import { ANCHOR_DISCRIMINATOR_LEN } from './constants';

export interface PumpSwapPool {
  poolAddress: PublicKey;
  poolBump: number;
  index: number;
  creator: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  lpMint: PublicKey;
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
  lpSupply: bigint;
}

export class PoolDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PoolDecodeError';
  }
}

const MIN_LEN = ANCHOR_DISCRIMINATOR_LEN + 1 + 2 + 32 * 6 + 8; // 211

export function decodePoolAccount(poolAddress: PublicKey, data: Buffer): PumpSwapPool {
  if (data.length < MIN_LEN) {
    throw new PoolDecodeError(`Pool account too short: ${data.length} < ${MIN_LEN} bytes`);
  }

  let offset = ANCHOR_DISCRIMINATOR_LEN;
  const readPubkey = () => {
    const pk = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    return pk;
  };

  const poolBump = data.readUInt8(offset);
  offset += 1;
  const index = data.readUInt16LE(offset);
  offset += 2;
  const creator = readPubkey();
  const baseMint = readPubkey();
  const quoteMint = readPubkey();
  const lpMint = readPubkey();
  const poolBaseTokenAccount = readPubkey();
  const poolQuoteTokenAccount = readPubkey();
  const lpSupply = data.readBigUInt64LE(offset);

  return {
    poolAddress,
    poolBump,
    index,
    creator,
    baseMint,
    quoteMint,
    lpMint,
    poolBaseTokenAccount,
    poolQuoteTokenAccount,
    lpSupply,
  };
}
