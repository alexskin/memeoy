// Standalone re-implementation of the interactive `degen-score` Claude Code
// skill (C:\Users\User\.claude\skills\degen-score\SKILL.md) as a direct
// Anthropic API call, because that skill only runs inside a Claude Code chat
// session (it uses the Browser tool to render the page) - this worker
// process is a plain Node script with no access to that tool. Same fetch
// pattern as lib/agent/llmTuner.ts throughout (plain `fetch`, no SDK,
// fail-open to null on any error/missing key).
//
// Known degradation vs. the interactive skill: X/Twitter often blocks
// unauthenticated fetches (no logged-in session, no JS rendering here), so
// the page-text fetch below frequently comes back empty for X links. The LLM
// call still proceeds in that case - same "don't fight a wall, still commit
// to a provisional score" spirit the skill itself describes, just with less
// to go on. Not a bug; a known, accepted limitation of running headless.
import { ANTHROPIC_API_KEY } from '../config/env';
import { logger } from '../logger';

const PAGE_FETCH_TIMEOUT_MS = 6000;
const LLM_TIMEOUT_MS = 15000;

export interface DegenScoreResult {
  score: number;
  verdict: string;
}

async function fetchPageText(link: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(link, {
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; snipe-degen-score/1.0)' },
    });
    if (!response.ok) return null;
    const html = await response.text();
    // Crude tag-strip, not a real HTML parser - good enough to hand the LLM
    // readable text instead of raw markup; the model doesn't need a DOM.
    return html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
  } catch (error) {
    logger.debug({ link, error: String(error) }, 'degenScore: page fetch failed, scoring with link only');
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

const SYSTEM_PROMPT = `Judge like a burnt-out, terminally-online Solana trencher who's watched ten thousand coins launch and can smell a larp from three tweets away - not like a neutral analyst. This is a vibe/authenticity check on the meme itself, not investment advice or a price prediction: rate whether the launch feels like real degen culture or manufactured hype.

High score = organic chaos. The coin was born from a joke, a reply, a shitpost - not a pitch. Low-effort execution that's charming because it's low-effort. Ticker/name is dumb in a good way. Nobody is explaining why it matters.

Don't weigh raw view/reply counts - judge the content of whatever is visible (are replies riffing/cloning the joke, or mocking it, or bots/shills) rather than the volume. Zero replies yet is neutral, not a red flag.

Low score = trying too hard. Marketing copy ("revolutionary", "the next 100x", "join the movement"), roadmaps, "utility" talk, generic AI-art branding. Reads like a project account cosplaying as a degen instead of an actual degen.

Websites: a page with nothing but a meme, a CA and socials beats one with tokenomics tables and a whitepaper.

Calibration: a joke-spawned coin with organic riffing in replies -> high 80s-90s. A post that reads like someone manufacturing a moment (forced enthusiasm, no organic backing) -> low 20s-30s. Most things land in the 40-65 middle - score honestly.

You may only have partial or no page content (fetch limitations) - if so, say so isn't needed, just still commit to a provisional number based on whatever is visible (URL, handle, whatever text came through). Never refuse to score.

Reply with EXACTLY this format, nothing else: "<0-100 integer>/100 — <1-2 short sentences of verdict>"`;

function parseDegenScoreResponse(text: string): DegenScoreResult | null {
  const match = text.trim().match(/^(\d{1,3})\s*\/\s*100\s*[—-]\s*(.+)$/s);
  if (!match) return null;
  const score = Math.max(0, Math.min(100, parseInt(match[1], 10)));
  if (Number.isNaN(score)) return null;
  return { score, verdict: match[2].trim() };
}

export async function getDegenScore(link: string | null): Promise<DegenScoreResult | null> {
  if (!link || !ANTHROPIC_API_KEY) return null;

  const pageText = await fetchPageText(link);
  const userPrompt = pageText
    ? `Link: ${link}\n\nFetched page text (may be partial/truncated):\n${pageText}`
    : `Link: ${link}\n\n(Page content could not be fetched - likely login-walled or blocked. Score provisionally based on the URL/handle alone.)`;

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
        // Haiku, not Sonnet - this is a coarse "does this look organic"
        // vibe check that only ever feeds decisionEngine.ts as advisory
        // context (never a hard buy/skip gate on its own), and it's called
        // for every candidate that clears momentum/revival, several times
        // an hour. Cost-conscious per the user's explicit ask; revisit if
        // score quality turns out to matter more than expected.
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!response.ok) {
      logger.warn({ status: response.status, link }, 'degenScore: API call failed');
      return null;
    }

    const data = (await response.json()) as { content?: { type: string; text?: string }[] };
    const text = data.content?.find((c) => c.type === 'text')?.text?.trim() ?? '';
    const parsed = parseDegenScoreResponse(text);
    if (!parsed) {
      logger.warn({ link, text }, 'degenScore: unparseable response');
    }
    return parsed;
  } catch (error) {
    logger.warn({ error: String(error), link }, 'degenScore: request failed');
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
