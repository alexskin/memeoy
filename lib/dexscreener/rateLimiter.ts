// DexScreener's documented limit is 60 requests/minute - this caps at 55
// (5-request headroom since our own batching can be bursty) and is a
// process-global singleton because the cap applies to the whole process,
// not per-caller. FIFO: calls are serialized through queueTail so slot
// checks never race each other.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class DexScreenerRateLimiter {
  private timestamps: number[] = [];
  private queueTail: Promise<void> = Promise.resolve();

  constructor(private readonly maxPerMinute: number) {}

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const turn = this.queueTail.then(() => this.waitForSlot());
    this.queueTail = turn.catch(() => undefined);
    return turn.then(fn);
  }

  private async waitForSlot(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 60_000);

    if (this.timestamps.length >= this.maxPerMinute) {
      const oldest = this.timestamps[0];
      const waitMs = 60_000 - (now - oldest) + 10;
      await sleep(waitMs);
      return this.waitForSlot();
    }

    this.timestamps.push(Date.now());
  }
}

export const dexScreenerRateLimiter = new DexScreenerRateLimiter(55);
