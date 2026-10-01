import assert from "node:assert/strict";
import test from "node:test";
import { actionableHints, nextPollDelay, settleRequired, waitForNextPoll } from "../scripts/testnet-poll.js";

test("poll cadence subtracts completed work and never queues catch-up requests", () => {
  assert.equal(nextPollDelay(0), 2000);
  assert.equal(nextPollDelay(750), 1250);
  assert.equal(nextPollDelay(2000), 100);
  assert.equal(nextPollDelay(7800), 100);
  assert.throws(() => nextPollDelay(Number.NaN), /invalid_poll_duration/);
  assert.throws(() => nextPollDelay(-1), /invalid_poll_duration/);
});

test("parallel reads drain a slow sibling before surfacing an error or starting another cycle", async () => {
  let finish!: (value: number) => void;
  let settled = false;
  const pending = new Promise<number>((resolve) => { finish = resolve; });
  const result = settleRequired([Promise.reject(Error("api_failed")), pending] as const)
    .catch((error) => { settled = true; return error; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false);
  finish(7);
  assert.equal((await result).message, "api_failed");
});

test("wrong chain or reorg cannot be hidden by a concurrent API failure", async () => {
  await assert.rejects(settleRequired([
    Promise.reject(Error("api_failed")), Promise.reject(Error("fatal_wrong_chain")),
  ] as const), /fatal_wrong_chain/);
  assert.deepEqual(await settleRequired([Promise.resolve(5), Promise.resolve("snapshot")] as const), [5, "snapshot"]);
});

test("spent sessions stop rechecking the selected ID but still record new discoveries", () => {
  const hints = [{ id: "selected" }, { id: "unresolved" }];
  const discoveries = { selected: {} };
  assert.deepEqual(actionableHints(hints, { attempted: true, discoveries }), [{ id: "unresolved" }]);
  assert.deepEqual(actionableHints(hints, { attempted: false, discoveries }), hints);
});

test("a stop interrupts even a Retry-After beyond the native timer limit", async () => {
  const controller = new AbortController();
  const waiting = waitForNextPoll(2 ** 32, controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  await assert.rejects(waitForNextPoll(-1, controller.signal), /invalid_poll_delay/);
});
