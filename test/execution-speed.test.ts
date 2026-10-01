import assert from "node:assert/strict";
import test from "node:test";
import type { PublicClient } from "viem";
import { mapBounded, pollDelay, scheduleAfter, settleChecks, StageBlockReads } from "../src/execution-speed.js";
const settle = async () => { for (let i=0;i<5;i++) await Promise.resolve(); };
test("bounded candidate resolution drains the whole batch and keeps input positions after failure", async () => {
  let running = 0, maximum = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const work = mapBounded([0,1,2,3], 2, async item => {
    running++; maximum = Math.max(maximum, running);
    await gate;
    running--;
    if (item === 1) throw Error("not synchronized");
    return item;
  });
  await settle(); assert.equal(maximum, 2); release();
  const results = await work;
  assert.deepEqual(results.map(result => result.status), ["fulfilled", "rejected", "fulfilled", "fulfilled"]);
  assert.equal(running, 0); assert.equal(maximum, 2);
});
test("parallel failed check cannot leave another sibling executing into a later action", async () => {
  let release!: () => void, done = false;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const result = settleChecks([Promise.reject(Error("bad")), pending]).finally(() => { done = true; });
  await settle(); assert.equal(done, false); release(); await assert.rejects(result, /bad/);
});
test("block reads deduplicate only within the same stage and client", async () => {
  let count = 0;
  const client = { getBlock: async () => { count++; return {number: 1n, hash: `0x${count}`}; } } as unknown as PublicClient;
  const stage = new StageBlockReads();
  const [first, same] = await Promise.all([stage.block(client, 1n), stage.block(client, 1n)]);
  assert.equal(first.hash, same.hash); assert.equal(count, 1);
  assert.notEqual((await new StageBlockReads().block(client, 1n)).hash, first.hash);
});
test("poll delay is measured start-to-start without overlapping catch-up", () => {
  assert.equal(pollDelay(2000, 400), 1600);
  assert.equal(pollDelay(2000, 3000), 100);
});
test("long server cooldown is chunked and cancellable, never a timer overflow", t => {
  t.mock.timers.enable({apis: ["setTimeout"]});
  let fired = 0;
  const cancel = scheduleAfter(2 ** 31 + 100, () => { fired++; });
  t.mock.timers.tick(60_000); assert.equal(fired, 0);
  cancel(); t.mock.timers.tick(2 ** 31 + 100); assert.equal(fired, 0);
});
