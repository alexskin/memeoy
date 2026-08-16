// Shapes returned by DexScreener's public API (api.dexscreener.com, 60
// req/min documented limit). Confirmed live against a real Solana pair this
// session - volume/priceChange/txns are keyed by timeframe, liquidity is in
// USD, pairCreatedAt is unix ms. Fields are optional/nullable throughout
// because a freshly-created pair (which is exactly what we query, since our
// own on-chain listener is faster than DexScreener's indexer) often has
// several of these still unset.
export type DexScreenerTimeframe = 'm5' | 'h1' | 'h6' | 'h24';

export interface DexScreenerTxns {
  buys: number;
  sells: number;
}

export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; symbol: string; name?: string };
  quoteToken: { address: string; symbol: string };
  priceUsd: string | null;
  liquidity: { usd: number } | null;
  volume: Partial<Record<DexScreenerTimeframe, number>>;
  priceChange: Partial<Record<DexScreenerTimeframe, number>>;
  txns: Partial<Record<DexScreenerTimeframe, DexScreenerTxns>>;
  pairCreatedAt: number | null;
  /** USD, confirmed present live on real pairs. Absent on some very fresh pairs. */
  marketCap?: number;
  fdv?: number;
  /** Not previously modeled here - primary source for the degen-score link (lib/degenScore/client.ts), preferred over parsing on-chain metadata since it's already fetched by getTokensBatch. Absent on many fresh/low-effort pairs. */
  info?: {
    socials?: { type: string; url: string }[];
    websites?: { url: string }[];
  };
}
