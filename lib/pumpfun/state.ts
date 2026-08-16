// Bonding-curve account decode. Field layout (after the 8-byte anchor
// discriminator) is the widely-documented pump.fun BondingCurve struct:
// virtualTokenReserves/virtualSolReserves/realTokenReserves/realSolReserves/
// tokenTotalSupply (u64 each) + complete (bool). Plain Buffer reads, no
// borsh/anchor dependency needed for a struct this simple.
import { ANCHOR_DISCRIMINATOR_LEN } from './constants';

export interface BondingCurveAccount {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
}

export class BondingCurveDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BondingCurveDecodeError';
  }
}

const MIN_LEN = ANCHOR_DISCRIMINATOR_LEN + 8 * 5 + 1;

export function decodeBondingCurveAccount(data: Buffer): BondingCurveAccount {
  if (data.length < MIN_LEN) {
    throw new BondingCurveDecodeError(`Bonding curve account too short: ${data.length} < ${MIN_LEN} bytes`);
  }

  let offset = ANCHOR_DISCRIMINATOR_LEN;
  const readU64 = () => {
    const value = data.readBigUInt64LE(offset);
    offset += 8;
    return value;
  };

  const virtualTokenReserves = readU64();
  const virtualSolReserves = readU64();
  const realTokenReserves = readU64();
  const realSolReserves = readU64();
  const tokenTotalSupply = readU64();
  const complete = data.readUInt8(offset) !== 0;

  return { virtualTokenReserves, virtualSolReserves, realTokenReserves, realSolReserves, tokenTotalSupply, complete };
}
