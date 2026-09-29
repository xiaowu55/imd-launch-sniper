import assert from "node:assert/strict";
import { test } from "node:test";
import { validateFreshLiveSet, validateFreshObservation, type FreshObservation } from "../scripts/testnet-fresh-policy.js";

const id = "a36cb67d-208f-4149-a31a-4a55cac4833c";
const older = "cd74e008-6a11-47be-b242-012cc4529697";
const start = Date.parse("2026-09-29T10:00:00.000Z");
const input: FreshObservation = {
  version: 1, chainId: 11155111,
  startedAt: new Date(start).toISOString(), deadlineAt: new Date(start + 1800000).toISOString(),
  anchor: { number: "11800000", hash: `0x${"a".repeat(64)}` }, baselineLiveIds: [older],
  selectionLiveIds: [older, id],
  discovery: { launchId: id, firstSeenAt: new Date(start + 1000).toISOString(),
    firstSeenHead: { number: "11800001", hash: `0x${"b".repeat(64)}` }, listCacheMaxAgeSeconds: 10 },
};

test("fresh observation permits only its discovered ID after the observation anchor", () => {
  assert.deepEqual(validateFreshObservation(input, id, start + 2000, 11800001n), input);
  assert.throws(() => validateFreshObservation(input, older, start + 2000, 11800001n), /fresh_launch_not_new/);
  assert.throws(() => validateFreshObservation({ ...input, baselineLiveIds: [id] }, id, start + 2000, 11800001n), /fresh_launch_not_new/);
  assert.throws(() => validateFreshObservation(input, id, start + 2000, 11800000n), /fresh_launch_before_anchor/);
  assert.throws(() => validateFreshObservation(input, id, start + 2000, 11700000n), /fresh_launch_before_anchor/);
  assert.throws(() => validateFreshObservation(input, id, start + 2000, 11800002n), /fresh_discovery_head_before_launch/);
  assert.throws(() => validateFreshObservation({ ...input, selectionLiveIds: [older] }, id, start + 2000, 11800001n), /fresh_launch_not_new/);
});

test("fresh API guard blocks withdrawn or changed-network candidates and newly live IDs", () => {
  const selected = { id, chainId: 11155111, status: "live" };
  const old = { id: older, chainId: 11155111, status: "live" };
  validateFreshLiveSet(input, [selected, old]);
  assert.throws(() => validateFreshLiveSet(input, [old]), /fresh_candidate_withdrawn/);
  assert.throws(() => validateFreshLiveSet(input, [{ ...selected, status: "failed" }, old]), /fresh_candidate_withdrawn/);
  assert.throws(() => validateFreshLiveSet(input, [{ ...selected, chainId: 1 }, old]), /fresh_candidate_withdrawn/);
  assert.throws(() => validateFreshLiveSet(input, [selected, selected, old]), /fresh_candidate_withdrawn/);
  const another = { id: "80fbf0ff-0ef1-4603-9351-9a626b87b2e0", chainId: 11155111, status: "live" };
  assert.throws(() => validateFreshLiveSet(input, [selected, old, another]), /fresh_api_candidates_changed/);
  validateFreshLiveSet(input, [selected, old, { ...another, status: "building" }]);
  validateFreshLiveSet(input, [selected, old, { ...another, chainId: 1 }]);
});

test("fresh observation rejects expiration, future discovery and extending the 30-minute budget", () => {
  assert.throws(() => validateFreshObservation(input, id, start + 1800000), /fresh_observation_expired/);
  assert.throws(() => validateFreshObservation(input, id, start - 1), /fresh_observation_expired/);
  assert.throws(() => validateFreshObservation(input, id, start + 999), /fresh_observation_expired/);
  assert.throws(() => validateFreshObservation({ ...input, deadlineAt: new Date(start + 1800001).toISOString() }, id, start + 2000), /fresh_observation_expired/);
  assert.throws(() => validateFreshObservation({ ...input, deadlineAt: input.startedAt }, id, start + 2000), /fresh_observation_expired/);
});

test("fresh observation fails closed on wrong chain, malformed evidence and block regression", () => {
  assert.throws(() => validateFreshObservation({ ...input, chainId: 1 }, id, start + 2000), /fresh_observation_invalid/);
  assert.throws(() => validateFreshObservation({ ...input, anchor: { number: "-1", hash: input.anchor.hash } }, id, start + 2000), /fresh_observation_invalid/);
  assert.throws(() => validateFreshObservation({ ...input, discovery: undefined }, id, start + 2000), /fresh_observation_invalid/);
  assert.throws(() => validateFreshObservation({ ...input, discovery: { ...input.discovery, firstSeenHead: { ...input.discovery.firstSeenHead, number: "11799999" } } }, id, start + 2000), /fresh_launch_before_anchor/);
  assert.throws(() => validateFreshObservation({ ...input, allowOldTokens: true }, id, start + 2000), /fresh_observation_invalid/);
});
