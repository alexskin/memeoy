// Periodic AI judgment on an already-open position: "keep holding, or exit
// now even though SL/TP haven't fired?" Mirrors decisionEngine.ts's shape
// and fail-safe philosophy (no ANTHROPIC_API_KEY / API error / unparseable
// response -> 'hold', never blocks position management on an LLM hiccup).
//
// Deliberately does NOT see or influence stopLossPct - that stays a hard,
// unconditional floor enforced by lib/portfolio/positionMonitor.ts
// regardless of what this returns. This only ever gets a chance to trigger
// a VOLUNTARY early exit; it can't override or delay a stop-loss.
//
// Also carries live momentum data (recent buys/volume/price change) so the
// judgment isn't blind to whether the token is actually still active right
// now, not just where its price sits - and near-timeout context, since
// positionMonitor.ts treats a 'hold' returned with source:'llm' while
// nearingTimeout as a one-time, capped permission to extend the hard
// timeout floor (see positionMonitor.ts for why this only applies to a
// real LLM judgment, never a fallback).
import { ANTHROPIC_API_KEY } from '../config/env';
import { logger } from '../logger';

const LLM_TIMEOUT_MS = 15000;

export interface ExitDecisionInput {
  baseMint: string;
  unrealizedPnlPct: number;
  peakProfitPct: number;
  minutesHeld: number;
  stopLossPct: number;
  takeProfitPct: number;
  recentPerformance: string;
  /** Live DexScreener momentum - null fields mean "not available", not "zero". */
  recentBuys5m: number | null;
  recentBuys1h: number | null;
  volume24hUsd: number | null;
  priceChange1hPct: number | null;
  /** True when the position is close enough to its hard timeout that a
   * 'hold' decision here (only when source ends up 'llm') grants a
   * one-time extension instead of just declining an early voluntary exit. */
  nearingTimeout: boolean;
  timeoutExtensionAvailable: boolean;
}

export interface ExitDecision {
  action: 'hold' | 'exit';
  reasoning: string;
  source: 'llm' | 'fallback';
}

function fallbackDecision(reasoning: string): ExitDecision {
  // Deterministic default is always 'hold' - the mechanical SL/TP/trailing/
  // timeout checks in positionMonitor.ts run every tick regardless of this
  // module, so falling back to "do nothing extra" is the safe choice, not
  // a gap in coverage. Because source is 'fallback' here, positionMonitor.ts
  // will NOT treat this as timeout-extension permission, even if
  // nearingTimeout was true - an unavailable/failed LLM call must never
  // itself extend the safety-net timeout.
  return { action: 'hold', reasoning, source: 'fallback' };
}

const SYSTEM_PROMPT = `You are reviewing an OPEN position in a Solana memecoin PAPER-TRADING bot (simulated fills, no real funds). This is a periodic check-in, not the buy decision - the token already passed the buy gate. Stop-loss is enforced separately and unconditionally; you are never asked to prevent a loss, only to judge whether to voluntarily exit NOW to lock in or protect gains, or keep holding for more upside.

You'll get the current unrealized P&L%, the peak P&L% reached so far (a big pullback from peak is a stronger signal than the raw P&L number alone), how long it's been held, the configured stop-loss/take-profit levels for context, live momentum (recent buy counts, 24h volume, 1h price change - null means unavailable, not zero), and a summary of how similar situations performed recently.

Weigh momentum alongside P&L: a position sitting flat with fading buys/volume is a weaker hold than one flat but still seeing active buying - dead volume is itself a reason to consider exiting even without a price move yet.

Default to holding unless you see a clear reason to exit early (e.g. a strong pullback from peak, or fading/dead momentum with no real gain to show for it). Don't exit just because P&L is modestly positive - let winners run toward the configured take-profit unless something looks wrong.

If you're told this position is nearing its maximum hold time and an extension is available: a 'hold' here specifically grants it more time past that limit, so only choose 'hold' if momentum genuinely still looks alive (real recent buys/volume, not just "no clear reason to exit"). If it's gone quiet, 'exit' and let the timeout do its job.

Reply with EXACTLY this JSON shape, nothing else, no markdown fences: {"action": "hold" | "exit", "reasoning": "<one sentence, under 40 words>"}`;

export async function decideExit(input: ExitDecisionInput): Promise<ExitDecision> {
  if (!ANTHROPIC_API_KEY) {
    return fallbackDecision('fallback: no ANTHROPIC_API_KEY configured, mechanical exits only');
  }

  const momentumLine = `Recent buys: ${input.recentBuys5m ?? 'n/a'} (5m), ${input.recentBuys1h ?? 'n/a'} (1h). 24h volume: ${input.volume24hUsd != null ? '$' + Math.round(input.volume24hUsd).toLocaleString() : 'n/a'}. 1h price change: ${input.priceChange1hPct != null ? input.priceChange1hPct.toFixed(1) + '%' : 'n/a'}.`;
  const timeoutLine = input.nearingTimeout
    ? input.timeoutExtensionAvailable
      ? `This position is nearing its maximum hold time. Choosing "hold" now grants a one-time extension - only do so if momentum genuinely still looks alive.`
      : `This position is nearing its maximum hold time and has already used its one-time extension - the timeout will apply regardless of this review.`
    : '';

  const userPrompt = `Mint: ${input.baseMint}
Unrealized P&L: ${input.unrealizedPnlPct.toFixed(1)}%
Peak P&L since entry: ${input.peakProfitPct.toFixed(1)}%
Held for: ${input.minutesHeld.toFixed(1)} minutes
Configured stop-loss: -${input.stopLossPct}% (enforced separately, not your call)
Configured take-profit: ${input.takeProfitPct}%
${momentumLine}
${timeoutLine}
${input.recentPerformance}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 150,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status, baseMint: input.baseMint }, 'exitDecisionEngine: API call failed, falling back to mechanical exits');
      return fallbackDecision('fallback: LLM API call failed');
    }

    const data = (await response.json()) as { content?: { type: string; text?: string }[] };
    const text = data.content?.find((c) => c.type === 'text')?.text?.trim() ?? '';

    const parsed = JSON.parse(text) as { action?: string; reasoning?: string };
    if (parsed.action !== 'hold' && parsed.action !== 'exit') {
      throw new Error(`unexpected action: ${parsed.action}`);
    }

    return {
      action: parsed.action,
      reasoning: parsed.reasoning ?? '(no reasoning provided)',
      source: 'llm',
    };
  } catch (error) {
    logger.warn({ error: String(error), baseMint: input.baseMint }, 'exitDecisionEngine: request failed or unparseable, falling back to mechanical exits');
    return fallbackDecision('fallback: LLM response failed or did not parse');
  } finally {
    clearTimeout(timeout);
  }
}
