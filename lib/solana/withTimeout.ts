// @solana/web3.js gives Connection RPC calls no default timeout - if the
// underlying HTTP/WS transport stalls (dead socket, ISP blip, provider
// outage) the call just hangs forever instead of rejecting. That's fatal
// here: positionMonitor's tick() relies on every awaited call eventually
// settling (its try/finally can't run mid-hang), so one stuck RPC call
// permanently wedges tickInFlight and silently stops all position
// monitoring - confirmed live (a position sat open 15.8h past its timeout
// after the connection stalled). Wrapping the hang-prone calls in this
// turns "hangs forever" into "rejects after N ms", which the existing
// try/catch + retry-next-tick paths already handle correctly.
export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
