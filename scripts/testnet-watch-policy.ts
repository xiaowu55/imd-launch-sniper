import type { LaunchHint } from "../src/launch-feed.js";
import type { Candidate } from "../src/types.js";

export const WATCH_WINDOW_MS = 30 * 60 * 1000;
export function eligibleHints(rows: LaunchHint[], baseline: Set<string>, excluded: Set<string>) {
  return rows.filter((row) => row.chainId === 11155111 && row.status === "live" &&
    !baseline.has(row.id) && !excluded.has(row.id) &&
    /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(row.id));
}
export function orderFreshCandidates(candidates: Candidate[], anchor: bigint) {
  return candidates.filter((candidate) => candidate.blockNumber > anchor).sort((a, b) =>
    a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 :
      a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex);
}
