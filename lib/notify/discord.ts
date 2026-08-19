// Fire-and-forget Discord webhook notifications - never throw to the
// caller, a notification failure must never affect a real trade decision.
// Read-only-adjacent: this only ever POSTs a message (plain content or a
// rich embed), no OAuth, no bot token, nothing wallet-related.
//
// Buy/sell notifications use Discord embeds (structured fields, not a wall
// of markdown text) - deliberately mirrors only the data we actually have
// and compute (filter_results, agent_decisions, wallet-reputation,
// DexScreener paid-status), never a placeholder for something we don't
// track (e.g. no "developer"/"paid promotion" field like some third-party
// scanners show - we have no way to know either of those).
import { DISCORD_WEBHOOK_URL } from '../config/env';
import { logger } from '../logger';
import { AgentDecision, FilterOutcome, Position, PositionStatus } from '../types';

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title: string;
  url?: string;
  color: number;
  fields: DiscordEmbedField[];
  footer?: { text: string };
  timestamp?: string;
}

async function postToDiscord(payload: { content?: string; embeds?: DiscordEmbed[] }): Promise<void> {
  if (!DISCORD_WEBHOOK_URL) return;

  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Discord webhook post failed');
    }
  } catch (error) {
    logger.warn({ error: String(error) }, 'Discord webhook post failed');
  }
}

export async function sendDiscordNotification(content: string): Promise<void> {
  return postToDiscord({ content });
}

export async function sendDiscordEmbed(embed: DiscordEmbed): Promise<void> {
  return postToDiscord({ embeds: [embed] });
}

const COLOR_GREEN = 0x22c55e;
const COLOR_RED = 0xef4444;

function formatUsd(v: number | null | undefined): string | null {
  if (v == null) return null;
  return `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

// Filter messages are already human-written (e.g. "HolderConcentration ->
// top non-pool holder 4.2% (max 15%)") - pull just the first percentage out
// for a compact field value, matching the dense scanner-style layout this
// mirrors, rather than dumping the whole sentence into a small field.
function firstPct(message: string | null | undefined): string | null {
  const match = message?.match(/(\d+(?:\.\d+)?)%/);
  return match ? `${match[1]}%` : null;
}

function latestFilterMessage(filters: FilterOutcome[], filterName: string): string | null {
  const matches = filters.filter((f) => f.filterName === filterName);
  return matches.length > 0 ? (matches[matches.length - 1].message ?? null) : null;
}

function links(mint: string): string {
  return `[Dexscreener](https://dexscreener.com/solana/${mint}) · [pump.fun](https://pump.fun/coin/${mint})`;
}

export interface OpenedEmbedParams {
  baseMint: string;
  tokenName?: string | null;
  entryMarketCapUsd?: number | null;
  source: string;
  quoteAmountUi: number;
  config: {
    stopLossPct: number;
    exitStrategy: 'fixed' | 'trailing';
    takeProfitPct: number;
    trailingActivationPct: number;
    trailingStopPct: number;
  };
  /** Filter results for this candidate (holderConcentration/insiderConcentration/devRisk/freshWallet), if available. */
  filters?: FilterOutcome[];
  /** The AI decision that approved this buy, if available. */
  decision?: AgentDecision | null;
  /** From lib/agent/walletReputation.ts::summarizeWalletReputation. */
  walletReputationNote?: string | null;
  /** From lib/dexscreener/client.ts::getDexPaidStatus. */
  dexPaid?: { hasApprovedProfile: boolean; hasAnyBoost: boolean } | null;
}

export function buildPositionOpenedEmbed(params: OpenedEmbedParams): DiscordEmbed {
  const { baseMint, tokenName, entryMarketCapUsd, source, quoteAmountUi, config, filters = [], decision, walletReputationNote, dexPaid } = params;

  const fields: DiscordEmbedField[] = [
    { name: 'Forrás', value: source, inline: true },
    { name: 'Méret', value: `${quoteAmountUi.toFixed(4)} SOL`, inline: true },
  ];
  const mc = formatUsd(entryMarketCapUsd);
  if (mc) fields.push({ name: 'Piaci sapka', value: mc, inline: true });

  if (decision) {
    fields.push({ name: 'AI döntés', value: `${decision.action.toUpperCase()} ${(decision.confidence * 100).toFixed(0)}%`, inline: true });
    const qualifiedVia = decision.momentumPass && decision.revivalPass ? 'momentum + revival' : decision.revivalPass ? 'revival' : 'momentum';
    fields.push({ name: 'Minősítés', value: qualifiedVia, inline: true });
  }

  const topHolder = firstPct(latestFilterMessage(filters, 'holderConcentration'));
  if (topHolder) fields.push({ name: 'Top holder', value: topHolder, inline: true });
  const insider = firstPct(latestFilterMessage(filters, 'insiderConcentration'));
  if (insider) fields.push({ name: 'Insider', value: insider, inline: true });
  const devRiskMsg = latestFilterMessage(filters, 'devRisk');
  const devPctMatch = devRiskMsg?.match(/dev holding (\d+(?:\.\d+)?)%/);
  const top10Match = devRiskMsg?.match(/top10 non-pool holders (\d+(?:\.\d+)?)%/);
  if (devPctMatch) fields.push({ name: 'Dev holding', value: `${devPctMatch[1]}%`, inline: true });
  if (top10Match) fields.push({ name: 'Top 10 holder', value: `${top10Match[1]}%`, inline: true });
  const freshWallet = firstPct(latestFilterMessage(filters, 'freshWallet'));
  if (freshWallet) fields.push({ name: 'Fresh wallet', value: freshWallet, inline: true });

  if (dexPaid) {
    const label = dexPaid.hasApprovedProfile && dexPaid.hasAnyBoost ? '✅ Profil + Boost' : dexPaid.hasApprovedProfile ? '✅ Profil' : dexPaid.hasAnyBoost ? '✅ Boost' : '❌ Nem fizetett';
    fields.push({ name: 'DexScreener', value: label, inline: true });
  }

  if (decision?.degenScore != null) {
    fields.push({ name: 'Degen score', value: `${decision.degenScore}/100${decision.degenVerdict ? ` — ${decision.degenVerdict.slice(0, 200)}` : ''}` });
  }
  if (walletReputationNote) {
    // Strip the self-labeling prefix (needed when this string is spliced
    // into decisionEngine's LLM prompt) - redundant here since the field
    // name already says what it is.
    const value = walletReputationNote.replace(/^Wallet-reputation:\s*/, '');
    fields.push({ name: 'Wallet-reputáció', value: value.slice(0, 300) });
  }

  const exitLine = config.exitStrategy === 'trailing'
    ? `SL -${config.stopLossPct}% · Trailing: aktiválás +${config.trailingActivationPct}% / -${config.trailingStopPct}pt`
    : `SL -${config.stopLossPct}% · TP +${config.takeProfitPct}%`;
  fields.push({ name: 'Kilépési szabály', value: exitLine });

  fields.push({ name: 'CA', value: `\`${baseMint}\`` });
  fields.push({ name: 'Linkek', value: links(baseMint) });

  return {
    title: `🟢 Pozíció nyitva${tokenName ? ` — ${tokenName}` : ''}`,
    color: COLOR_GREEN,
    fields,
    footer: { text: 'Paper trading · no real funds' },
    timestamp: new Date().toISOString(),
  };
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
export function buildPositionClosedEmbed(position: Position): DiscordEmbed {
  const { baseMint, tokenName, source, status, entryMarketCapUsd, exitMarketCapUsd, realizedPnlQuote, realizedPnlPct, aiExitReasoning } = position;
  const pnlQuote = realizedPnlQuote ?? 0;
  const pnlPct = realizedPnlPct ?? 0;
  const reasonLabel = status === 'open' ? status : CLOSE_REASON_LABEL[status];

  const fields: DiscordEmbedField[] = [
    { name: 'Forrás', value: source, inline: true },
    { name: 'Ok', value: reasonLabel, inline: true },
    { name: 'P&L (valós, kötési áron)', value: `${pnlQuote >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% (${pnlQuote >= 0 ? '+' : ''}${pnlQuote.toFixed(4)} SOL)`, inline: true },
  ];

  const entryMc = formatUsd(entryMarketCapUsd);
  const exitMc = formatUsd(exitMarketCapUsd);
  if (entryMc || exitMc) {
    fields.push({ name: 'MC (DexScreener becslés)', value: `${entryMc ?? '—'} → ${exitMc ?? '—'}` });
  }
  if (aiExitReasoning) {
    fields.push({ name: 'AI indoklás', value: aiExitReasoning.slice(0, 500) });
  }
  fields.push({ name: 'CA', value: `\`${baseMint}\`` });
  fields.push({ name: 'Linkek', value: links(baseMint) });

  return {
    title: `${pnlQuote >= 0 ? '🟢' : '🔴'} Pozíció zárva${tokenName ? ` — ${tokenName}` : ''}`,
    color: pnlQuote >= 0 ? COLOR_GREEN : COLOR_RED,
    fields,
    footer: { text: 'Paper trading · no real funds' },
    timestamp: new Date().toISOString(),
  };
}
