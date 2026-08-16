// Pre-migration pump.fun token-creation detector. Mirrors
// lib/listener/listeners.ts's shape (an EventEmitter wrapping one
// connection subscription) but uses connection.onLogs instead of
// onProgramAccountChange - a bonding-curve account has no mint field of its
// own to reverse-lookup from an account-change notification (confirmed via
// the official IDL: BondingCurve stores reserves/creator, not the mint), so
// creation must be caught via the "Create" instruction's logs instead. Zero
// extra RPC calls: the CreateEvent is fully decodable from the log lines
// onLogs already delivers (see createEventDecoder.ts).
import { Connection, Logs } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { PUMP_FUN_PROGRAM_ID } from './constants';
import { decodeCreateEventFromLogs, PumpFunCreateEvent } from './createEventDecoder';

export declare interface PumpFunListener {
  on(event: 'creation', listener: (event: PumpFunCreateEvent) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
}

export class PumpFunListener extends EventEmitter {
  private subscriptionId: number | null = null;

  constructor(private readonly connection: Connection) {
    super();
  }

  start(commitment: Connection['commitment']) {
    this.subscriptionId = this.connection.onLogs(
      PUMP_FUN_PROGRAM_ID,
      (logs: Logs) => {
        if (logs.err) return; // failed tx - a Create attempt that reverted mints nothing
        try {
          const event = decodeCreateEventFromLogs(logs.logs);
          if (event) this.emit('creation', event);
        } catch {
          // Never let one malformed log entry take down the subscription callback.
        }
      },
      commitment,
    );
  }

  async stop() {
    if (this.subscriptionId !== null) {
      await this.connection.removeOnLogsListener(this.subscriptionId);
      this.subscriptionId = null;
    }
  }
}
