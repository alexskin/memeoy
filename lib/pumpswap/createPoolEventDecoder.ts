// Decodes PumpSwap's Anchor `CreatePoolEvent` directly out of the log lines
// a normal `connection.onLogs` subscription already delivers - same
// "Program data: <base64>" convention as lib/pumpfun/createEventDecoder.ts.
// Discriminator and field order below are taken verbatim from the official
// IDL at https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json
// (fetched live 2026-08-19) - if PumpSwap ever changes the event shape this
// is the file to update; decoding fails safe (returns null) rather than
// throwing.
//
// The event does NOT carry the pool's own two vault token accounts
// (poolBaseTokenAccount/poolQuoteTokenAccount) - only the creator's deposit
// accounts (user_base_token_account/user_quote_token_account), which are
// different addresses. The caller (lib/listener/listeners.ts) still needs
// one follow-up getAccountInfo + decodePoolAccount() to get those - a single
// one-shot read per newly-created pool, not a continuous subscription, so
// it's a negligible RPC cost compared to what programSubscribe used to cost.
import { PublicKey } from '@solana/web3.js';

const CREATE_POOL_EVENT_DISCRIMINATOR = Buffer.from([177, 49, 12, 210, 160, 118, 167, 116]);

export interface PumpSwapCreatePoolEvent {
  pool: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  creator: PublicKey;
  timestamp: number;
}

class BorshReader {
  private offset = 0;
  constructor(private readonly data: Buffer) {}

  private ensure(len: number) {
    if (this.offset + len > this.data.length) throw new Error('CreatePoolEvent: unexpected end of data');
  }

  skip(len: number) {
    this.ensure(len);
    this.offset += len;
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
}

// IDL field order (only what's needed to identify+locate the new pool is
// read - trailing fields like pool_base_amount/minimum_liquidity/
// is_mayhem_mode etc. are deliberately left unread, same "decode what you
// need, ignore the rest" spirit as pumpfun/createEventDecoder.ts).
function decodeCreatePoolEventPayload(payload: Buffer): PumpSwapCreatePoolEvent | null {
  try {
    const reader = new BorshReader(payload);
    const timestamp = Number(reader.readI64()) * 1000;
    reader.skip(2); // index (u16)
    const creator = reader.readPubkey();
    const baseMint = reader.readPubkey();
    const quoteMint = reader.readPubkey();
    reader.skip(1 + 1); // base_mint_decimals, quote_mint_decimals (u8 each)
    reader.skip(8 * 6); // base_amount_in, quote_amount_in, pool_base_amount, pool_quote_amount, minimum_liquidity, initial_liquidity (u64 each)
    reader.skip(8); // lp_token_amount_out (u64)
    reader.skip(1); // pool_bump (u8)
    const pool = reader.readPubkey();

    return { pool, baseMint, quoteMint, creator, timestamp };
  } catch {
    return null;
  }
}

// Scans a transaction's log lines for a CreatePoolEvent - returns null if
// this transaction isn't a pool creation (the overwhelmingly common case;
// every swap against an existing pool also flows through the same onLogs
// subscription).
export function decodeCreatePoolEventFromLogs(logs: string[]): PumpSwapCreatePoolEvent | null {
  const PREFIX = 'Program data: ';
  for (const line of logs) {
    if (!line.startsWith(PREFIX)) continue;

    let raw: Buffer;
    try {
      raw = Buffer.from(line.slice(PREFIX.length), 'base64');
    } catch {
      continue;
    }
    if (raw.length < 8 || !raw.subarray(0, 8).equals(CREATE_POOL_EVENT_DISCRIMINATOR)) continue;

    const event = decodeCreatePoolEventPayload(raw.subarray(8));
    if (event) return event;
  }
  return null;
}
