// Optional annotation layer - only runs if ANTHROPIC_API_KEY is set. It may
// ONLY annotate the heuristic proposal's rationale in plain English or
// veto/soften it - it must never invent a change the heuristic didn't
// already propose, keeping the agent auditable rather than a black box.
// Called via plain fetch, no SDK dependency, so it's zero-install unless
// the user opts in.
import { ANTHROPIC_API_KEY } from '../config/env';
import { StrategyConfig } from '../types';
import { AgentStats } from './stats';
import { ProposedDiff } from './heuristicTuner';
import { logger } from '../logger';

export interface LlmAnnotation {
  veto: boolean;
  note: string;
}

export async function annotateProposal(
  stats: AgentStats,
  proposal: ProposedDiff,
  config: StrategyConfig,
): Promise<LlmAnnotation | null> {
  if (!ANTHROPIC_API_KEY) return null;

  const prompt = `You are reviewing a proposed change to a Solana memecoin PAPER-TRADING strategy (simulated, no real money). \nStats: ${JSON.stringify(stats)}\nCurrent config subset: ${JSON.stringify(
    Object.fromEntries(Object.keys(proposal.diff).map((k) => [k, (config as any)[k]])),
  )}\nProposed diff: ${JSON.stringify(proposal.diff)}\nHeuristic rationale: ${proposal.rationale}\n\nYou may NOT propose any different parameter change - only judge this exact diff. Reply with exactly one line starting with either "APPROVE: " or "VETO: " followed by a short (<40 word) plain-English reason.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'llmTuner: API call failed, falling back to heuristic-only');
      return null;
    }

    const data = (await response.json()) as { content?: { type: string; text?: string }[] };
    const text = data.content?.find((c) => c.type === 'text')?.text?.trim() ?? '';

    if (text.toUpperCase().startsWith('VETO')) {
      return { veto: true, note: text };
    }
    return { veto: false, note: text || 'Reviewed and approved.' };
  } catch (error) {
    logger.warn({ error: String(error) }, 'llmTuner: request failed, falling back to heuristic-only');
    return null;
  }
}
