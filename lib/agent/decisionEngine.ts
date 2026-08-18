// The actual per-candidate judgment step, replacing the old "momentum pass
// == buy" hard gate. Called once a candidate has already cleared the
// deterministic momentum + revival gates (lib/watchlist/watchlistMonitor.ts)
// - never on every watchlist tick - to keep Anthropic API usage bounded to
// real near-buy candidates.
//
// Fail-CLOSED by design (deliberate, not an oversight): this bot's whole
// buy premise is that an actual AI judgment approved the candidate, not
// just that it cleared the numeric gates - so if ANTHROPIC_API_KEY is
// unset, or every retry attempt errors/times out/fails to parse, the
// fallback is always 'skip', never a deterministic buy. Clearing
// momentum/revival gets a candidate to this judgment step; it does not
// substitute for the judgment itself. Every call - buy AND skip - gets
// persisted (lib/db.ts's insertAgentDecision) with its reasoning, so a
// "REFUSED" candidate (including an LLM-unavailable one) stays visible
// with a reason instead of silently vanishing (inspired by omotrades.com's
// live reasoning feed, which explicitly logs refused setups, not just
// accepted trades - see the plan's Context section).
import { ANTHROPIC_API_KEY } from '../config/env';
import { MomentumEvaluation } from '../dexscreener/momentumFilter';
import { RevivalEvaluation } from '../dexscreener/revivalFilter';
import { DegenScoreResult } from '../degenScore/client';
import { AgentDecisionAction, AgentDecisionSource } from '../types';
import { logger } from '../logger';

const LLM_TIMEOUT_MS = 15000;
// A single flaky call (network blip, momentary API error, one malformed
// response) shouldn't cost a real candidate its shot at an actual AI
// judgment - retry several times before giving up and skipping the buy.
const MAX_ATTEMPTS = 5;

export interface DecisionInput {
  baseMint: string;
  momentum: MomentumEvaluation;
  revival: RevivalEvaluation;
  degenScore: DegenScoreResult | null;
  recentPerformance: string;
  /** From lib/agent/stats.ts::summarizeMissedRunnersBySignal - where the
   * degen-score judgment missed a real runner before, by score bucket.
   * Advisory context only, same as recentPerformance - never a hard gate. */
  missedRunnerCalibration: string;
}

function describeQualification(momentumPass: boolean, revivalPass: boolean): string {
  if (momentumPass && revivalPass) return 'momentum AND revival (rare - cleared both alternate gates)';
  if (revivalPass) return 'revival only (an older pool showing a fresh second-wind uptick after going flat)';
  return 'momentum only (a fresh, still-actively-pumping pool)';
}

export interface Decision {
  action: AgentDecisionAction;
  confidence: number;
  reasoning: string;
  source: AgentDecisionSource;
}

function fallbackDecision(reasoning: string): Decision {
  // Always 'skip', never a deterministic buy - see the file header. Clearing
  // momentum/revival got this candidate to the judgment step; without an
  // actual AI response there was no judgment, so there's no buy.
  return {
    action: 'skip',
    confidence: 1,
    reasoning,
    source: 'fallback',
  };
}

const SYSTEM_PROMPT = `You are the final judgment gate for a Solana memecoin PAPER-TRADING bot (simulated fills, no real funds, no real wallet). A candidate reaches you by clearing AT LEAST ONE of two deliberately mutually-exclusive deterministic gates: "momentum" (a fresh pool, still actively pumping, always <= 12h old) or "revival" (an older pool, 12h-14d old, that went flat and just started a fresh small second-wind uptick). These target disjoint age ranges by design - a momentum candidate is structurally too young to ever also pass revival's age floor, and vice versa. You will be told which gate this specific candidate actually qualified through.

**Do not treat failing the OTHER gate's criteria as a red flag or as evidence of a "fake" pattern** - that failure is expected and means nothing (e.g. a fresh momentum candidate SHOULD fail revival's 12h+ age requirement; that is not suspicious). Only judge the candidate on the gate it actually qualified through, plus the degen score and performance context below.

You will be given: which gate qualified this candidate, the momentum criteria results, the revival criteria results and a 0-100 strength score, an optional 0-100 "degen score" (how organic vs. manufactured the token's social/website presence feels - null if no link was found), a summary of how similar past signal combinations actually performed, and a missed-runner calibration line showing what fraction of past skips in each degen-score bucket later turned into a real big mover. Use that last line to recalibrate how much weight you give degen score - if low-degen-score skips have been missing real runners often, don't let a low score alone drive a skip.

Weigh it together - don't just check that the numbers cleared their bars, and don't manufacture suspicion from the non-qualifying gate's criteria. A candidate that qualified cleanly via its relevant gate but has a low degen score (numbers look right, narrative looks fake) is exactly the kind of case where you should lean toward skipping. Use the recent-performance summary to calibrate how much to trust a given signal combination, not as a hard rule.

Reply with EXACTLY this JSON shape, nothing else, no markdown fences: {"action": "buy" | "skip", "confidence": <0-1 number>, "reasoning": "<one sentence, under 40 words>"}`;

// One attempt: returns a real llm Decision, or throws/returns an error
// string on anything that should be retried (network error, non-2xx,
// unparseable/invalid JSON).
async function attemptDecision(input: DecisionInput, userPrompt: string): Promise<Decision | string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 200,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!response.ok) {
      return `API call failed with status ${response.status}`;
    }

    const data = (await response.json()) as { content?: { type: string; text?: string }[] };
    const text = data.content?.find((c) => c.type === 'text')?.text?.trim() ?? '';

    const parsed = JSON.parse(text) as { action?: string; confidence?: number; reasoning?: string };
    if (parsed.action !== 'buy' && parsed.action !== 'skip') {
      return `unexpected action: ${parsed.action}`;
    }
    const confidence = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5;

    return {
      action: parsed.action,
      confidence,
      reasoning: parsed.reasoning ?? '(no reasoning provided)',
      source: 'llm',
    };
  } catch (error) {
    return String(error);
  } finally {
    clearTimeout(timeout);
  }
}

export async function decideCandidate(input: DecisionInput): Promise<Decision> {
  if (!ANTHROPIC_API_KEY) {
    return fallbackDecision('fallback: no ANTHROPIC_API_KEY configured, skipping - buy decisions require an actual AI judgment');
  }

  const userPrompt = `Mint: ${input.baseMint}
Qualified via: ${describeQualification(input.momentum.pass, input.revival.pass)}
Momentum criteria: ${JSON.stringify(input.momentum.results)}
Revival criteria: ${JSON.stringify(input.revival.results)}
Revival strength: ${input.revival.strengthScore}/100
Degen score: ${input.degenScore ? `${input.degenScore.score}/100 - ${input.degenScore.verdict}` : 'not available (no social link found, or scoring failed)'}
${input.recentPerformance}
${input.missedRunnerCalibration}`;

  let lastError = '(no attempts made)';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await attemptDecision(input, userPrompt);
    if (typeof result !== 'string') return result;

    lastError = result;
    logger.warn({ error: result, baseMint: input.baseMint, attempt, maxAttempts: MAX_ATTEMPTS }, 'decisionEngine: attempt failed');
  }

  logger.warn({ baseMint: input.baseMint, attempts: MAX_ATTEMPTS }, 'decisionEngine: all attempts failed, skipping - no deterministic buy without a real AI judgment');
  return fallbackDecision(`fallback: LLM failed after ${MAX_ATTEMPTS} attempts (${lastError}), skipping`);
}
