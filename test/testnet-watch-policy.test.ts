import assert from "node:assert/strict";
import test from "node:test";
import { eligibleHints, orderFreshCandidates } from "../scripts/testnet-watch-policy.js";
import type { Candidate } from "../src/types.js";

const oldId = "00000000-0000-4000-8000-000000000001";
const pendingId = "00000000-0000-4000-8000-000000000002";
const base = { id: pendingId, launchNumber: 444, chainId: 11155111, status: "live" };
test("fresh testnet discovery excludes baseline IDs, wrong chain and non-live records, not lower launch numbers", () => {
  const result = eligibleHints([
    { ...base, id: oldId, launchNumber: 445 }, base,
    { ...base, id: "00000000-0000-4000-8000-000000000003", chainId: 1 },
    { ...base, id: "00000000-0000-4000-8000-000000000004", status: "parked" },
  ], new Set([oldId]), new Set());
  assert.deepEqual(result, [base]);
  assert.deepEqual(eligibleHints([base], new Set(), new Set([pendingId])), []);
});
test("fresh candidate ordering excludes cached old deployments and uses canonical block/transaction/log order", () => {
  const make = (id: string, blockNumber: bigint, transactionIndex: number, logIndex: number) =>
    ({ id, blockNumber, transactionIndex, logIndex }) as Candidate;
  const ordered = orderFreshCandidates([
    make("cached-old", 100n, 1, 1), make("higher-log", 101n, 2, 4),
    make("newer", 102n, 0, 0), make("lower-log", 101n, 2, 3), make("earlier-tx", 101n, 1, 5),
  ], 100n);
  assert.deepEqual(ordered.map((candidate) => candidate.id), ["earlier-tx", "lower-log", "higher-log", "newer"]);
});
