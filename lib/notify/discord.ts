// Fire-and-forget Discord webhook notification - never throws to the
// caller, a notification failure must never affect a real trade decision.
// Read-only-adjacent: this only ever POSTs a text message, no OAuth, no
// bot token, nothing wallet-related.
import { DISCORD_WEBHOOK_URL } from '../config/env';
import { logger } from '../logger';
import { Position, PositionStatus } from '../types';

export async function sendDiscordNotification(content: string): Promise<void> {
  if (!DISCORD_WEBHOOK_URL) return;

  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Discord webhook post failed');
    }
  } catch (error) {
    logger.warn({ error: String(error) }, 'Discord webhook post failed');
  }
}

export function formatPositionOpenedMessage(params: {
  baseMint: string;
  tokenName?: string | null;
  entryMarketCapUsd?: number | null;
  source: string;
  quoteAmountUi: number;
  entryPrice: number;
  config: {
    stopLossPct: number;
    exitStrategy: 'fixed' | 'trailing';
    takeProfitPct: number;
    trailingActivationPct: number;
    trailingStopPct: number;
    takeProfitTargets: { pct: number; sellFraction: number }[];
  };
}): string {
  const { baseMint, tokenName, entryMarketCapUsd, source, quoteAmountUi, entryPrice, config } = params;
  const targets = config.takeProfitTargets.map((t) => `+${t.pct}% (${(t.sellFraction * 100).toFixed(0)}%)`).join(', ');
  const exitLine =
    config.exitStrategy === 'trailing'
      ? `Trailing: aktiválás +${config.trailingActivationPct}% / -${config.trailingStopPct}pt a csúcstól`
      : `Fix take-profit: +${config.takeProfitPct}%`;

  return [
    `🟢 **Pozíció nyitva** — \`${source}\`${tokenName ? ` — **${tokenName}**` : ''}`,
    `Token: \`${baseMint}\``,
    entryMarketCapUsd != null ? `Nyitó MC: $${entryMarketCapUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : null,
    `Méret: ${quoteAmountUi.toFixed(4)} SOL @ ${entryPrice}`,
    `Stop-loss: -${config.stopLossPct}%`,
    targets ? `Célok: ${targets}` : null,
    exitLine,
  ]
    .filter(Boolean)
    .join('\n');
}

const CLOSE_REASON_LABEL: Record<Exclude<PositionStatus, 'open'>, string> = {
  closed_tp: 'Take profit',
  closed_sl: 'Stop-loss',
  closed_timeout: 'Timeout',
  closed_manual: 'Manuális zárás',
  closed_ai_exit: 'AI kilépés',
  closed_structural: 'Struktúra törés',
};

// Called once a position is FULLY closed (final leg, not an intermediate
// scaled-take-profit partial) - same convention as the 'position.closed'
// broadcast in positionMonitor.ts, which this mirrors.
export function formatPositionClosedMessage(position: Position): string {
  const { baseMint, tokenName, source, status, entryMarketCapUsd, exitMarketCapUsd, realizedPnlQuote, realizedPnlPct, aiExitReasoning } = position;
  const pnlQuote = realizedPnlQuote ?? 0;
  const pnlPct = realizedPnlPct ?? 0;
  const emoji = pnlQuote >= 0 ? '🟢' : '🔴';
  const reasonLabel = status === 'open' ? status : CLOSE_REASON_LABEL[status];

  return [
    `${emoji} **Pozíció zárva** — \`${source}\`${tokenName ? ` — **${tokenName}**` : ''} — ${reasonLabel}`,
    `Token: \`${baseMint}\``,
    entryMarketCapUsd != null || exitMarketCapUsd != null
      ? `MC: $${entryMarketCapUsd?.toLocaleString('en-US', { maximumFractionDigits: 0 }) ?? '—'} → $${exitMarketCapUsd?.toLocaleString('en-US', { maximumFractionDigits: 0 }) ?? '—'}`
      : null,
    `P&L: ${pnlQuote >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% (${pnlQuote >= 0 ? '+' : ''}${pnlQuote.toFixed(4)} SOL)`,
    aiExitReasoning ? `Indoklás: ${aiExitReasoning}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}
