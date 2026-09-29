import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers";
import {
  LaunchFeedTracker,
  parseLaunchSnapshot,
  startLaunchFeed,
  type LaunchHint,
  type LaunchSnapshot,
} from "../src/launch-feed.js";

const token = `0x${"a".repeat(40)}`;
const row = (overrides: Record<string, unknown> = {}) => ({
  id: "launch-1",
  launchNumber: 1,
  chainId: 1,
  status: "assembling",
  kind: "evm_project",
  artifacts: [],
  ...overrides,
});
const snapshot = (rows: unknown[], age: string | null = null) =>
  parseLaunchSnapshot({ count: rows.length, launches: rows }, age);
const response = (rows: unknown[], headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ count: rows.length, launches: rows }), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("public snapshot keeps only bounded launch hints and exposes cache policy", () => {
  const result = snapshot([row({
    artifacts: [{ role: "token", address: token }],
    createdAt: "ignored",
    updatedAt: "ignored",
    arbitrary: { secret: "not included" },
  })], "public, max-age=10");
  assert.equal(result.cacheMaxAgeSeconds, 10);
  assert.equal(result.source, "https://api.imd.fun/launches?limit=50");
  assert.deepEqual(result.launches, [{
    id: "launch-1", launchNumber: 1, chainId: 1,
    status: "assembling", kind: "evm_project", token,
  }]);
  assert.equal(snapshot([], 'MAX-AGE="30", public').cacheMaxAgeSeconds, 30);
  assert.equal(snapshot([], "no-cache").cacheMaxAgeSeconds, null);
});

test("malformed API rows fail without producing candidate hints", () => {
  for (const value of [null, {}, { launches: "bad" }])
    assert.throws(() => parseLaunchSnapshot(value), /格式不正确/);
  for (const override of [
    { id: "" }, { launchNumber: 0 }, { chainId: "1" },
    { status: "" }, { kind: {} }, { artifacts: {} },
    { artifacts: [{ role: "token", address: "0xbad" }] },
    { artifacts: [{ role: "token", address: token }, { role: "token", address: token }] },
  ]) assert.throws(() => snapshot([row(override)]));
  assert.throws(() => snapshot([row(), row()]), /格式不正确/);
});

test("first successful response is baseline; new and changed Ethereum records wake a scan", () => {
  const tracker = new LaunchFeedTracker();
  assert.deepEqual(tracker.update(snapshot([row()])), []);
  assert.deepEqual(tracker.update(snapshot([row()])), []);
  assert.equal(tracker.update(snapshot([row({ status: "admitted" })]))[0]!.status, "admitted");
  assert.equal(tracker.update(snapshot([row({ status: "live", artifacts: [{ role: "token", address: token }] })]))[0]!.token, token);
  assert.equal(tracker.update(snapshot([row({ id: "launch-2", launchNumber: 2 })]))[0]!.id, "launch-2");
  assert.deepEqual(tracker.update(snapshot([row({ id: "sepolia", chainId: 11155111 })])), []);
});

test("record order, timestamps, and temporary list rotation do not retrigger unchanged launches", () => {
  const tracker = new LaunchFeedTracker();
  const a = row();
  const b = row({ id: "launch-2", launchNumber: 2 });
  tracker.update(snapshot([a, b]));
  assert.deepEqual(tracker.update(snapshot([b, { ...a, updatedAt: "changed" }])), []);
  assert.deepEqual(tracker.update(snapshot([])), []);
  assert.deepEqual(tracker.update(snapshot([a])), []);
});

test("a prior testnet row switching to mainnet is a change hint, not proof of deployment", () => {
  const tracker = new LaunchFeedTracker();
  tracker.update(snapshot([row({ chainId: 11155111 })]));
  const hints = tracker.update(snapshot([row({ status: "abandoned" })]));
  assert.equal(hints.length, 1);
  assert.equal(hints[0]!.status, "abandoned");
  assert.equal(hints[0]!.token, undefined);
});

test("watcher respects advertised max-age and only signals after baseline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requests = 0;
  const updates: LaunchSnapshot[] = [];
  const signals: LaunchHint[][] = [];
  const stop = startLaunchFeed({
    intervalMs: 1000,
    fetchImpl: (async () => {
      requests++;
      return response([row({ status: requests === 1 ? "assembling" : "admitted" })], { "cache-control": "public, max-age=10" });
    }) as typeof fetch,
    onUpdate: (s) => { updates.push(s); },
    onSignal: (h) => { signals.push(h); },
    onError: () => assert.fail("unexpected feed error"),
  });
  t.after(stop);
  await flush();
  assert.equal(updates.length, 1);
  assert.equal(signals.length, 0);
  t.mock.timers.tick(9999);
  await flush();
  assert.equal(requests, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(requests, 2);
  assert.equal(signals.length, 1);
  stop();
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(requests, 2);
});

test("watcher has one in-flight request and stop aborts without late callbacks", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requests = 0;
  let signal: AbortSignal | undefined;
  let resolveResponse!: (r: Response) => void;
  let callbacks = 0;
  const stop = startLaunchFeed({
    intervalMs: 1,
    fetchImpl: ((_input, init) => {
      requests++;
      signal = init?.signal as AbortSignal;
      return new Promise<Response>((resolve) => { resolveResponse = resolve; });
    }) as typeof fetch,
    onUpdate: () => { callbacks++; }, onSignal: () => { callbacks++; }, onError: () => { callbacks++; },
  });
  t.after(stop);
  t.mock.timers.tick(7000);
  await flush();
  assert.equal(requests, 1);
  stop();
  assert.equal(signal?.aborted, true);
  resolveResponse(response([row()]));
  await flush();
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(callbacks, 0);
  assert.equal(requests, 1);
});

test("HTTP 429 honors Retry-After with a sixty-second ceiling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requests = 0;
  let errors = 0;
  const stop = startLaunchFeed({
    intervalMs: 1000,
    fetchImpl: (async () => {
      requests++;
      return requests === 1
        ? new Response(null, { status: 429, headers: { "retry-after": "120" } })
        : response([]);
    }) as typeof fetch,
    onUpdate: () => {}, onSignal: () => {}, onError: () => { errors++; },
  });
  t.after(stop);
  await flush();
  assert.equal(errors, 1);
  t.mock.timers.tick(59999);
  await flush();
  assert.equal(requests, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(requests, 2);
});

test("network failures back off and expose no raw error to callbacks", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requests = 0;
  const errors: unknown[][] = [];
  const stop = startLaunchFeed({
    intervalMs: 1000,
    fetchImpl: (async () => { requests++; throw Error("private RPC URL must not escape"); }) as typeof fetch,
    onUpdate: () => {}, onSignal: () => {}, onError: (...args) => { errors.push(args); },
  });
  t.after(stop);
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(requests, 2);
  t.mock.timers.tick(1999);
  await flush();
  assert.equal(requests, 2);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(requests, 3);
  assert.deepEqual(errors, [[], [], []]);
});

test("a malformed response never seeds baseline and successful recovery does", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requests = 0;
  let errors = 0;
  let signals = 0;
  const stop = startLaunchFeed({
    intervalMs: 1000,
    fetchImpl: (async () => {
      requests++;
      return requests === 1 ? response([row({ chainId: "1" })]) : response([row()]);
    }) as typeof fetch,
    onUpdate: () => {}, onSignal: () => { signals++; }, onError: () => { errors++; },
  });
  t.after(stop);
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(requests, 2);
  assert.equal(errors, 1);
  assert.equal(signals, 0);
});
