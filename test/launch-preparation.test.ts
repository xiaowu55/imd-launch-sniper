import test from "node:test";
import assert from "node:assert/strict";
import type { PublicClient } from "viem";
import { LaunchPreparation } from "../src/launch-preparation.js";
import { ApiLaunchError, type ResolvedApiLaunch, type resolveApiLaunch } from "../src/api-launch.js";
test("one candidate has one in-flight resolution and its original immutable result is reused briefly", async () => {
  let calls = 0, now = 0, finish!: (v: ResolvedApiLaunch<11155111>) => void;
  const launch = Object.freeze({ fixture: true }) as unknown as ResolvedApiLaunch<11155111>;
  const resolver = (async () => { calls++; return new Promise(r => { finish = r; }); }) as typeof resolveApiLaunch<11155111>;
  const prep = new LaunchPreparation({} as PublicClient, 11155111, new AbortController().signal, resolver, () => now);
  const first = prep.prepare("id"), second = prep.prepare("id"); assert.equal(first, second); assert.equal(calls, 1);
  finish(launch); assert.equal(await first, launch); assert.equal(await prep.prepare("id"), launch); assert.equal(calls, 1);
  now = 10001; const fresh = prep.prepare("id"); assert.equal(calls, 2); finish(launch); await fresh;
  prep.clear(); const again = prep.prepare("id"); assert.equal(calls, 3); finish(launch); await again;
});
test("preparation is bounded and cancellation prevents queued work from reaching RPC", async () => {
  const controller = new AbortController(); let calls = 0;
  const releases: Array<() => void> = [];
  const resolver = (async () => { calls++; await new Promise<void>(r => releases.push(r)); return {} as ResolvedApiLaunch<11155111>; }) as typeof resolveApiLaunch<11155111>;
  const prep = new LaunchPreparation({} as PublicClient, 11155111, controller.signal, resolver);
  const results = Array.from({ length: 4 }, (_, i) => prep.prepare(String(i)));
  const settled = Promise.allSettled(results); assert.equal(calls, 2); controller.abort(); releases.forEach(r => r());
  assert.ok((await settled).every(r => r.status === "rejected")); assert.equal(calls, 2);
});
test("clear isolates pending generations and an older completion cannot evict a newer request", async () => {
  const releases: Array<(value: ResolvedApiLaunch<11155111>) => void> = [];
  const resolver = (async () => new Promise(r => releases.push(r))) as typeof resolveApiLaunch<11155111>;
  const prep = new LaunchPreparation({} as PublicClient, 11155111, new AbortController().signal, resolver);
  const old = prep.prepare("same"); const rejected = assert.rejects(old, e => e instanceof ApiLaunchError && e.code === "preparation_invalidated");
  prep.clear(); const current = prep.prepare("same"); assert.notEqual(old, current);
  releases[0]!({} as ResolvedApiLaunch<11155111>); await rejected;
  assert.equal(prep.prepare("same"), current);
  const value = {} as ResolvedApiLaunch<11155111>; releases[1]!(value); assert.equal(await current, value);
});
test("a Retry-After stops queued and newly requested work across cache clears", async () => {
  let calls = 0, now = 0;
  const resolver = (async () => { calls++; throw new ApiLaunchError("api_unavailable", "cooldown", true, 60000); }) as typeof resolveApiLaunch<11155111>;
  const prep = new LaunchPreparation({} as PublicClient, 11155111, new AbortController().signal, resolver, () => now);
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => prep.prepare(String(i))));
  assert.equal(calls, 2); assert.ok(results.every(r => r.status === "rejected" && r.reason.retryAfterMs === 60000));
  prep.clear(); await assert.rejects(prep.prepare("new"), e => e instanceof ApiLaunchError && e.retryAfterMs === 60000); assert.equal(calls, 2);
  now = 60001; await assert.rejects(prep.prepare("new")); assert.equal(calls, 3);
});

test("external API cooldown blocks queued preparation, survives clear and shorter defers, then expires", async () => {
  let now = 0;
  const calls: string[] = [];
  const releases: Array<(value: ResolvedApiLaunch<11155111>) => void> = [];
  const launch = Object.freeze({fixture: "externally-deferred"}) as unknown as ResolvedApiLaunch<11155111>;
  const resolver = (async (id: string) => {
    calls.push(id);
    return new Promise(resolve => { releases.push(resolve); });
  }) as typeof resolveApiLaunch<11155111>;
  const prep = new LaunchPreparation({} as PublicClient, 11155111, new AbortController().signal, resolver, () => now);
  const batch = Promise.allSettled(["active-1", "active-2", "queued-1", "queued-2"].map(id => prep.prepare(id)));
  assert.deepEqual(calls, ["active-1", "active-2"]);

  // The list endpoint returns 429 while two detail reads are already running.
  prep.defer(60000);
  releases[0]!(launch); releases[1]!(launch);
  const results = await batch;
  await prep.settle();
  assert.deepEqual(results.map(result => result.status), ["fulfilled", "fulfilled", "rejected", "rejected"]);
  for (const result of results.slice(2)) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") {
      assert.ok(result.reason instanceof ApiLaunchError);
      assert.equal(result.reason.retryAfterMs, 60000);
    }
  }
  assert.deepEqual(calls, ["active-1", "active-2"], "queued work must never contact its resolver during external cooldown");
  await assert.rejects(prep.prepare("active-1"), error => error instanceof ApiLaunchError && error.retryAfterMs === 60000,
    "a cached completion cannot bypass the list endpoint's cooldown");

  now = 1000;
  prep.clear(); prep.defer(5000);
  await assert.rejects(prep.prepare("new"), error => error instanceof ApiLaunchError && error.retryAfterMs === 59000);
  now = 59999;
  prep.clear(); prep.defer(0);
  await assert.rejects(prep.prepare("new"), error => error instanceof ApiLaunchError && error.retryAfterMs === 1);
  assert.equal(calls.length, 2, "cache invalidation and shorter defers cannot shorten the existing server deadline");

  now = 60000;
  const resumed = prep.prepare("after-expiry");
  assert.deepEqual(calls, ["active-1", "active-2", "after-expiry"]);
  releases[2]!(launch);
  assert.equal(await resumed, launch);
  await prep.settle();
});
