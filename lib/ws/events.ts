// Typed event names/payloads broadcast by the worker over the local ws
// server and consumed by the dashboard (lib/ws/client.ts).
import { Venue } from '../priceSource/types';
import { MomentumCriterionResult, WalletAlert } from '../types';

export type WorkerEvent =
  | { event: 'pool.detected'; payload: { id: number; baseMint: string; detectedAt: number; source: Venue } }
  | { event: 'wallet.alert'; payload: WalletAlert }
  | { event: 'momentum.updated'; payload: { detectedPoolId: number; pass: boolean; results: MomentumCriterionResult[] } }
  | {
      event: 'position.partialExit';
      payload: {
        positionId: number;
        targetPct: number;
        baseAmountSoldUi: number;
        quoteReceivedUi: number;
        realizedPnlQuote: number;
        remainingBaseAmountHeldUi: number;
      };
    }
  | { event: 'filter.result'; payload: { detectedPoolId: number; filterName: string; pass: boolean; message?: string } }
  | { event: 'pool.status'; payload: { id: number; status: string } }
  | { event: 'position.opened'; payload: { positionId: number; baseMint: string; quoteSizeInUi: number } }
  | {
      event: 'position.updated';
      payload: {
        positionId: number;
        markPrice: number;
        unrealizedPnlQuote: number;
        unrealizedPnlPct: number;
        peakProfitPct?: number;
        exitPending?: boolean;
      };
    }
  | { event: 'position.closed'; payload: { positionId: number; status: string; realizedPnlQuote: number } }
  | { event: 'equity.snapshot'; payload: { ts: number; openUnrealizedQuote: number } }
  | { event: 'agent.suggestion'; payload: { id: number; rationale: string } }
  | { event: 'worker.heartbeat'; payload: { ts: number; rpcLabel: string } }
  | { event: 'worker.state'; payload: { state: 'running' | 'paused' | 'stopped' } }
  | { event: 'worker.sellAll'; payload: { closed: number } };

export type WorkerEventName = WorkerEvent['event'];
