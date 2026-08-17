// Periodic AI judgment on an already-open position: "keep holding, or exit
// now even though SL/TP haven't fired?" Mirrors decisionEngine.ts's shape
// and fail-safe philosophy (no ANTHROPIC_API_KEY / API error / unparseable
// response -> 'hold', never blocks position management on an LLM hiccup).
//
// Deliberately does NOT see or influence stopLossPct - that stays a hard,
// unconditional floor enforced by lib/portfolio/positionMonitor.ts
// regardless of what this returns. This only ever gets a chance to trigger
// a VOLUNTARY early exit; it can't override or delay a stop-loss.
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
  // a gap in coverage.
  return { action: 'hold', reasoning, source: 'fallback' };
}

const SYSTEM_PROMPT = `You are reviewing an OPEN position in a Solana memecoin PAPER-TRADING bot (simulated fills, no real funds). This is a periodic check-in, not the buy decision - the token already passed the buy gate. Stop-loss is enforced separately and unconditionally; you are never asked to prevent a loss, only to judge whether to voluntarily exit NOW to lock in or protect gains, or keep holding for more upside.

You'll get the current unrealized P&L%, the peak P&L% reached so far (a big pullback from peak is a stronger signal than the raw P&L number alone), how long it's been held, the configured stop-loss/take-profit levels for context, and a summary of how similar situations performed recently.

Default to holding unless you see a clear reason to exit early (e.g. a strong pullback from peak suggesting the move is over, or a long hold with fading momentum and no real gain to show for it). Don't exit just because P&L is modestly positive - let winners run toward the configured take-profit unless something looks wrong.

Reply with EXACTLY this JSON shape, nothing else, no markdown fences: {"action": "hold" | "exit", "reasoning": "<one sentence, under 40 words>"}`;

export async function decideExit(input: ExitDecisionInput): Promise<ExitDecision> {
  if (!ANTHROPIC_API_KEY) {
    return fallbackDecision('fallback: no ANTHROPIC_API_KEY configured, mechanical exits only');
  }

  const userPrompt = `Mint: ${input.baseMint}
Unrealized P&L: ${input.unrealizedPnlPct.toFixed(1)}%
Peak P&L since entry: ${input.peakProfitPct.toFixed(1)}%
Held for: ${input.minutesHeld.toFixed(1)} minutes
Configured stop-loss: -${input.stopLossPct}% (enforced separately, not your call)
Configured take-profit: ${input.takeProfitPct}%
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
