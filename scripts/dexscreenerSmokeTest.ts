// Throwaway verification script for Phase A - confirms real batch size,
// response shape, and whether pre-migration pump.fun tokens are indexed by
// DexScreener at all. Run: npx tsx scripts/dexscreenerSmokeTest.ts
import { getTokensBatch } from '../lib/dexscreener/client';

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

async function main() {
  const pumpfunMints = process.argv.slice(2);
  const addresses = [WSOL, USDC, ...pumpfunMints];

  console.log(`Querying ${addresses.length} addresses...`);
  const start = Date.now();
  const result = await getTokensBatch('solana', addresses);
  console.log(`Took ${Date.now() - start}ms`);

  for (const [mint, pair] of result) {
    if (!pair) {
      console.log(`${mint}: NO DATA (not indexed by DexScreener, or too new)`);
      continue;
    }
    console.log(`${mint}:`, JSON.stringify({
      dexId: pair.dexId,
      liquidityUsd: pair.liquidity?.usd,
      volume24h: pair.volume.h24,
      priceChange1h: pair.priceChange.h1,
      priceChange24h: pair.priceChange.h24,
      buys1h: pair.txns.h1?.buys,
      buys5m: pair.txns.m5?.buys,
      pairCreatedAt: pair.pairCreatedAt ? new Date(pair.pairCreatedAt).toISOString() : null,
    }, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
