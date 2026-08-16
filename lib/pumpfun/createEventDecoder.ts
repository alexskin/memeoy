// Decodes pump.fun's Anchor `CreateEvent` directly out of the log lines a
// normal `connection.onLogs` subscription already delivers - zero extra RPC
// calls needed (no getParsedTransaction). Anchor emits an event as a
// "Program data: <base64>" log line where the decoded bytes are
// [8-byte event discriminator][borsh-encoded event fields]. Discriminator
// and field order below are taken verbatim from the official IDL at
// https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json
// (fetched live 2026-08-14) - if pump.fun ever changes the event shape this
// is the file to update; decoding fails safe (returns null) rather than
// throwing, same convention as decodeBondingCurveAccount.
import { PublicKey } from '@solana/web3.js';

// events[] entry for "CreateEvent" in the IDL linked above.
const CREATE_EVENT_DISCRIMINATOR = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);

export interface PumpFunCreateEvent {
  name: string;
  symbol: string;
  mint: PublicKey;
  bondingCurve: PublicKey;
  creator: PublicKey;
  timestamp: number;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  tokenTotalSupply: bigint;
}

class BorshReader {
  private offset = 0;
  constructor(private readonly data: Buffer) {}

  private ensure(len: number) {
    if (this.offset + len > this.data.length) throw new Error('CreateEvent: unexpected end of data');
  }

  readString(): string {
    this.ensure(4);
    const len = this.data.readUInt32LE(this.offset);
    this.offset += 4;
    this.ensure(len);
    const value = this.data.subarray(this.offset, this.offset + len).toString('utf8');
    this.offset += len;
    return value;
  }

  readPubkey(): PublicKey {
    this.ensure(32);
    const value = new PublicKey(this.data.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return value;
  }

  readI64(): bigint {
    this.ensure(8);
    const value = this.data.readBigInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  readU64(): bigint {
    this.ensure(8);
    const value = this.data.readBigUInt64LE(this.offset);
    this.offset += 8;
    return value;
  }
}

// IDL field order (only the fields we actually use are read - trailing
// fields like token_program/is_mayhem_mode/quote_mint/virtual_quote_reserves
// are deliberately left unread, same "decode what you need, ignore the
// rest" spirit as decodeBondingCurveAccount tolerating longer accounts).
function decodeCreateEventPayload(payload: Buffer): PumpFunCreateEvent | null {
  try {
    const reader = new BorshReader(payload);
    const name = reader.readString();
    const symbol = reader.readString();
    reader.readString(); // uri - not needed
    const mint = reader.readPubkey();
    const bondingCurve = reader.readPubkey();
    reader.readPubkey(); // user - superseded by creator below
    const creator = reader.readPubkey();
    const timestamp = Number(reader.readI64()) * 1000;
    const virtualTokenReserves = reader.readU64();
    const virtualSolReserves = reader.readU64();
    reader.readU64(); // real_token_reserves - not needed
    const tokenTotalSupply = reader.readU64();

    return { name, symbol, mint, bondingCurve, creator, timestamp, virtualTokenReserves, virtualSolReserves, tokenTotalSupply };
  } catch {
    return null;
  }
}

// Scans a transaction's log lines for a CreateEvent - returns null if this
// transaction isn't a token creation (the overwhelmingly common case; every
// buy/sell against an existing curve also flows through onLogs).
export function decodeCreateEventFromLogs(logs: string[]): PumpFunCreateEvent | null {
  const PREFIX = 'Program data: ';
  for (const line of logs) {
    if (!line.startsWith(PREFIX)) continue;

    let raw: Buffer;
    try {
      raw = Buffer.from(line.slice(PREFIX.length), 'base64');
    } catch {
      continue;
    }
    if (raw.length < 8 || !raw.subarray(0, 8).equals(CREATE_EVENT_DISCRIMINATOR)) continue;

    const event = decodeCreateEventPayload(raw.subarray(8));
    if (event) return event;
  }
  return null;
}
