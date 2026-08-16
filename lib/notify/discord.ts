// Fire-and-forget Discord webhook notification - never throws to the
// caller, a notification failure must never affect a real trade decision.
// Read-only-adjacent: this only ever POSTs a text message, no OAuth, no
// bot token, nothing wallet-related.
import { DISCORD_WEBHOOK_URL } from '../config/env';
import { logger } from '../logger';

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
