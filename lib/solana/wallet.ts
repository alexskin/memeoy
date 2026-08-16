// Loads the real signing wallet for live trading, ONLY reached when
// StrategyConfig.tradingMode === 'live' and a swap is actually about to
// execute (see lib/fillSimulator/slippage.ts's executeSwap). Never imported
// by anything on the paper-mode path. Supports the two secret-key formats
// most wallets (Phantom, Solflare, ...) export directly - base58 and a raw
// JSON byte array - deliberately NOT mnemonic phrases (repo-reference's
// getWallet() supports those too, but that needs extra dependencies
// (bip39/ed25519-hd-key) not otherwise used anywhere in this project; fewer
// parsing branches is a smaller surface area for a bug in code that signs
// real transactions).
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { WALLET_PRIVATE_KEY } from '../config/env';

function parseSecretKey(secret: string): Keypair {
  if (secret.startsWith('[')) {
    return Keypair.fromSecretKey(new Uint8Array(JSON.parse(secret)));
  }
  return Keypair.fromSecretKey(bs58.decode(secret));
}

let _wallet: Keypair | null = null;

export function getLiveWallet(): Keypair {
  if (_wallet) return _wallet;
  if (!WALLET_PRIVATE_KEY) {
    throw new Error(
      'tradingMode is "live" but WALLET_PRIVATE_KEY is not set in .env.local - see README.md\'s "Going live" section.',
    );
  }
  _wallet = parseSecretKey(WALLET_PRIVATE_KEY);
  return _wallet;
}
