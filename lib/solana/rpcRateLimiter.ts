// Same sliding-window FIFO pattern as lib/dexscreener/rateLimiter.ts, per
// second instead of per minute. Solana RPC free tiers are RPS-capped (25/s
// on Chainstack, 10/s on Helius, ...) - live-confirmed 2026-08-18 by
// Chainstack itself rejecting calls with "running under the limit of 25
// requests per second" once several filter checks fired concurrently.
// lib/solana/connection.ts's Proxy wrapper is the only caller; nothing else
// should construct RpcRateLimiter directly.
import { RpcProvider } from '../config/env';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Deliberately below each provider's documented free-tier RPS ceiling, to
// leave headroom for bursts rather than skating right at the limit
// (Chainstack free = 25 RPS, confirmed live; Helius free = 10 RPS; Ankr
// free = 30 RPS). Unknown providers get a conservative default.
const DEFAULT_RPS_BY_PROVIDER: Record<RpcProvider, number> = {
  helius: 8,
  chainstack: 20,
  alchemy: 15,
  ankr: 24,
  drpc: 15,
  syndica: 15,
  quicknode: 15,
  shyft: 15,
  unknown: 10,
};

export class RpcRateLimiter {
  private timestamps: number[] = [];
  private queueTail: Promise<void> = Promise.resolve();

  constructor(private readonly maxPerSecond: number) {}

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const turn = this.queueTail.then(() => this.waitForSlot());
    this.queueTail = turn.catch(() => undefined);
    return turn.then(fn);
  }

  private async waitForSlot(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 1000);

    if (this.timestamps.length >= this.maxPerSecond) {
      const oldest = this.timestamps[0];
      const waitMs = 1000 - (now - oldest) + 5;
      await sleep(waitMs);
      return this.waitForSlot();
    }

    this.timestamps.push(Date.now());
  }
}

export function rpsForProvider(provider: RpcProvider, envOverride: string): number {
  const override = Number(envOverride);
  if (Number.isFinite(override) && override > 0) return override;
  return DEFAULT_RPS_BY_PROVIDER[provider];
}
