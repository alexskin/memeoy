// Advisory "smart money" signal, sibling to lib/agent/stats.ts's
// summarizeMissedRunnersBySignal/summarizeRecentPerformanceBySignal - feeds
// decisionEngine.ts's prompt, never a hard gate. Deliberately does NOT track
// early-buyer transaction history (would need ~6-11 RPC calls per raw
// detection, and this project runs ~2200 detections/day - far too RPC-heavy
// for a fresh paid Chainstack plan sized to last a month). Instead reuses
// data devRiskFilter.ts already fetches for free from RugCheck (the current
// top-holder list) at zero marginal cost: every candidate that reaches that
// stage gets its top-holder snapshot persisted (lib/db.ts's
// insertPoolHolderSnapshots), and lib/agent/runnerReview.ts's existing
// periodic scan marks which of those pools later became confirmed runners
// (detected_pools.confirmed_runner). A wallet that keeps showing up as a
// top holder in pools that went on to run is the "serial winner wallet"
// signal, built entirely from data already being collected for other
// reasons - no new RPC/API cost at all.
import { getPoolHolderSnapshot, getWalletReputationCounts } from '../db';

// A wallet needs to have shown up as a snapshotted top holder in at least
// this many pools, with at least one of them a confirmed runner, before it
// counts as "reputable" - guards against a single lucky one-off inflating
// the signal.
const MIN_SEEN_COUNT = 2;

export function summarizeWalletReputation(detectedPoolId: number): string {
  const holders = getPoolHolderSnapshot(detectedPoolId);
  if (holders.length === 0) {
    return 'Wallet-reputation: no top-holder snapshot for this candidate.';
  }

  const counts = getWalletReputationCounts(holders.map((h) => h.walletAddress));
  const reputable = holders.filter((h) => {
    const c = counts.get(h.walletAddress);
    return !!c && c.seenCount >= MIN_SEEN_COUNT && c.runnerCount > 0;
  });

  if (reputable.length === 0) {
    return 'Wallet-reputation: none of this candidate\'s top holders have a track record in our own confirmed-runner history yet.';
  }

  const combinedPct = reputable.reduce((sum, h) => sum + h.pct, 0);
  return `Wallet-reputation: ${reputable.length}/${holders.length} top holders (${combinedPct.toFixed(1)}% combined supply) have previously shown up as early top holders in confirmed runners - a positive signal, not a guarantee.`;
}
