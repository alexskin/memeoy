// Periodic AI judgment on an already-open position. Unlike the entry-side
// decisionEngine.ts (fires once), this is asked repeatedly and now has real
// authority over ALL THREE exit triggers - stop-loss, take-profit, and the
// max-hold timeout - as many times as it judges warranted for each. This is
// a paper-trading bot (no real funds), and the explicit design choice here:
// nothing is a hard, AI-unreachable floor anymore. The safety net is
// structural instead - see lib/portfolio/positionMonitor.ts's fallback
// handling: a 'hold' returned via the fallback path (no ANTHROPIC_API_KEY,
// API error, unparseable response) is NEVER treated as permission to ride
// past a triggered exit - positionMonitor.ts reverts to closing on whatever
// mechanical trigger is active whenever a real LLM judgment isn't available,
// so an outage or bug can never leave a position silently unprotected.
import { ANTHROPIC_API_KEY } from '../config/env';
import { logger } from '../logger';

const LLM_TIMEOUT_MS = 15000;
// A single flaky call shouldn't silently demote a real exit judgment to the
// fallback path (which, per the invariant above, always reverts to closing
// on whatever trigger is active) - retry once before actually falling back.
// Kept lower than decisionEngine.ts's 5 deliberately: unlike a missed buy,
// giving up here is never unsafe (the fallback always closes on the active
// trigger), and this call fires far more often (every open position, every
// review interval) - cost-conscious per the user's explicit ask to trim
// Anthropic spend.
const MAX_ATTEMPTS = 2;

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
  volume5mUsd: number | null;
  volume24hUsd: number | null;
  priceChange1hPct: number | null;
  /** The position has hit its configured stop-loss. "hold" (only when
   * source ends up 'llm') means riding past it - the highest-risk override,
   * only warranted with strong, specific evidence the drop is noise, not
   * the start of a real breakdown. */
  stopLossReached: boolean;
  timesRodePastStopLoss: number;
  /** The position just hit its take-profit/trailing exit. "hold" means
   * riding past it instead of selling now. */
  takeProfitReached: boolean;
  timesRodePastTakeProfit: number;
  /** The position hit its max-hold deadline. "hold" grants another
   * extension. */
  timeoutReached: boolean;
  timesAlreadyExtended: number;
  /** The token's own live activity (5m volume or 1h buys) has fallen below
   * the floor that justified opening this position, independent of current
   * P&L - "hold" means judging the collapse as temporary noise rather than
   * a real breakdown of the setup. */
  structuralBreakReached: boolean;
  timesRodePastStructuralBreak: number;
}

export interface ExitDecision {
  action: 'hold' | 'exit';
  reasoning: string;
  source: 'llm' | 'fallback';
}

function fallbackDecision(reasoning: string): ExitDecision {
  return { action: 'hold', reasoning, source: 'fallback' };
}

const SYSTEM_PROMPT = `You are reviewing an OPEN position in a Solana memecoin PAPER-TRADING bot (simulated fills, no real funds). This is a periodic check-in, not the buy decision - the token already passed the buy gate.

You have real authority here: you can end the position early, and you can override all four of its mechanical exit triggers - stop-loss, take-profit, max-hold time, and structural break - repeatedly, for as long as you keep seeing genuine evidence that overriding is the right call. A memecoin that's up 800% and still getting real buy volume should not be force-sold just because it crossed a static target price set before anyone knew how big the move would be. Fresh Solana memecoins are also naturally violent in the other direction - sharp, fast red wicks within the first minute or two of a position are normal texture, not proof the trade failed, and a rigid stop-loss alone will get shaken out of real winners right before they run. Lean toward giving a position room to breathe; only treat a drop as the real thing when there's a genuine breakdown signal behind it (buying has actually dried up, volume is gone, or the dump looks coordinated/sustained), not just because a static price floor got touched.

You'll get: current unrealized P&L% and peak P&L% since entry (a big pullback from peak matters more than the raw number), how long it's been held, live momentum (recent buy counts, 5m/24h volume, 1h price change - null means unavailable, not zero), and a summary of how similar situations performed recently.

Up to four specific situations may be flagged, each with how many times you've already overridden it for this same position - the more times, the stronger the evidence needs to be to do it again. Don't rubber-stamp every review, but don't default to bailing at the first red candle either:
- stopLossReached: the position hit its stop-loss. "hold" = ride past it. Ride past it whenever buying activity is still present and there's no sign of a coordinated/sustained dump - a fast, sharp drawdown early in a position's life is exactly the kind of noise a fixed stop-loss can't tell apart from a real breakdown, so lean toward giving it room unless the momentum data itself confirms the move is real (buys gone, volume dead, or the position has already been ridden past this same trigger several times with no recovery).
- takeProfitReached: the position hit its take-profit/trailing exit. "hold" = ride past it. Needs real evidence of continued momentum (active buying, volume, no reversal signal), not just "no reason not to."
- timeoutReached: the position hit its max hold time. "hold" = grant another extension.
- structuralBreakReached: the token's own live 5m volume or 1h buy count has fallen below the floor that justified opening this position, regardless of current price. "hold" = judge the drop-off as temporary (e.g. a brief lull between waves, with price and other signals still healthy) rather than the setup genuinely dying - this is about whether the token is still actually alive, not about price.

Outside those situations, this is a plain early-exit check: default to holding unless you see a clear reason to exit now.

Reply with EXACTLY this JSON shape, nothing else, no markdown fences: {"action": "hold" | "exit", "reasoning": "<one sentence, under 40 words>"}`;

// One attempt: returns a real llm ExitDecision, or an error string on
// anything that should be retried (network error, non-2xx, unparseable/
// invalid JSON).
async function attemptDecision(input: ExitDecisionInput, userPrompt: string): Promise<ExitDecision | string> {
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
        // Was 150 - confirmed live 2026-08-19 this was too tight: a
        // reasoning sentence occasionally ran past the cap, truncating the
        // response mid-JSON and throwing "Unexpected end of JSON input" on
        // parse, which forces the fail-closed mechanical fallback (a real
        // stop-loss fired this way on a token that mooned right after,
        // with the AI never actually getting to weigh in).
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!response.ok) {
      return `API call failed with status ${response.status}`;
    }

    const data = (await response.json()) as { content?: { type: string; text?: string }[] };
    const text = data.content?.find((c) => c.type === 'text')?.text?.trim() ?? '';

    const parsed = JSON.parse(text) as { action?: string; reasoning?: string };
    if (parsed.action !== 'hold' && parsed.action !== 'exit') {
      return `unexpected action: ${parsed.action}`;
    }

    return {
      action: parsed.action,
      reasoning: parsed.reasoning ?? '(no reasoning provided)',
      source: 'llm',
    };
  } catch (error) {
    return String(error);
  } finally {
    clearTimeout(timeout);
  }
}

export async function decideExit(input: ExitDecisionInput): Promise<ExitDecision> {
  if (!ANTHROPIC_API_KEY) {
    return fallbackDecision('fallback: no ANTHROPIC_API_KEY configured, mechanical exits only');
  }

  const momentumLine = `Recent buys: ${input.recentBuys5m ?? 'n/a'} (5m), ${input.recentBuys1h ?? 'n/a'} (1h). 5m volume: ${input.volume5mUsd != null ? '$' + Math.round(input.volume5mUsd).toLocaleString() : 'n/a'}. 24h volume: ${input.volume24hUsd != null ? '$' + Math.round(input.volume24hUsd).toLocaleString() : 'n/a'}. 1h price change: ${input.priceChange1hPct != null ? input.priceChange1hPct.toFixed(1) + '%' : 'n/a'}.`;

  const situationLines: string[] = [];
  if (input.stopLossReached) {
    situationLines.push(`STOP-LOSS REACHED. "hold" = ride past it. Already ridden past ${input.timesRodePastStopLoss} time(s) before this.`);
  }
  if (input.takeProfitReached) {
    situationLines.push(`TAKE-PROFIT REACHED. "hold" = ride past it. Already ridden past ${input.timesRodePastTakeProfit} time(s) before this.`);
  }
  if (input.timeoutReached) {
    situationLines.push(`MAX HOLD TIME REACHED. "hold" = grant another extension. Already extended ${input.timesAlreadyExtended} time(s) before this.`);
  }
  if (input.structuralBreakReached) {
    situationLines.push(`STRUCTURAL BREAK: live activity has fallen below the entry floor. "hold" = judge it as temporary. Already ridden past ${input.timesRodePastStructuralBreak} time(s) before this.`);
  }

  const userPrompt = `Mint: ${input.baseMint}
Unrealized P&L: ${input.unrealizedPnlPct.toFixed(1)}%
Peak P&L since entry: ${input.peakProfitPct.toFixed(1)}%
Held for: ${input.minutesHeld.toFixed(1)} minutes
Configured stop-loss: -${input.stopLossPct}%
Configured take-profit: ${input.takeProfitPct}%
${momentumLine}
${situationLines.join('\n')}
${input.recentPerformance}`;

  let lastError = '(no attempts made)';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await attemptDecision(input, userPrompt);
    if (typeof result !== 'string') return result;

    lastError = result;
    logger.warn({ error: result, baseMint: input.baseMint, attempt, maxAttempts: MAX_ATTEMPTS }, 'exitDecisionEngine: attempt failed');
  }

  logger.warn({ baseMint: input.baseMint, attempts: MAX_ATTEMPTS }, 'exitDecisionEngine: all attempts failed, falling back to mechanical exits');
  return fallbackDecision(`fallback: LLM failed after ${MAX_ATTEMPTS} attempts (${lastError})`);
}
