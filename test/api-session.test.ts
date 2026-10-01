import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import { ApiHttpError, ApiSession, fetchApiBaseline, parseApiRetryAfter, type ApiFetchTiming } from "../src/api-session.js";
import type { LaunchHint, LaunchSnapshot } from "../src/launch-feed.js";

const token = `0x${"a".repeat(40)}` as const;
const anchor = { number: 123456n, hash: `0x${"b".repeat(64)}` as Hex };

function directory(t: TestContext) {
  const path = mkdtempSync(join(tmpdir(), "imd-api-session-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function hint(number: number, overrides: Partial<LaunchHint> = {}): LaunchHint {
  return {
    id: `launch-${number}`,
    launchNumber: number,
    chainId: 1,
    status: "live",
    kind: "evm_project",
    token,
    ...overrides,
  };
}

function snapshot(launches: LaunchHint[]): LaunchSnapshot {
  return {
    source: "https://api.imd.fun/launches?limit=500",
    checkedAt: "2026-09-28T00:00:00.000Z",
    cacheMaxAgeSeconds: 10,
    launches,
  };
}

function body(launches: LaunchHint[]) {
  return {
    count: launches.length,
    launches: launches.map(({ token: address, ...item }) => ({
      ...item,
      artifacts: address ? [{ role: "token", address }] : [],
    })),
  };
}

function response(launches: LaunchHint[]) {
  return Response.json(body(launches), {
    headers: { "cache-control": "public, max-age=10" },
  });
}

function page(newest: number) {
  return Array.from({ length: 500 }, (_, index) => hint(newest - index));
}

test("initial live mainnet launches stay excluded after restart and reinitialization", (t) => {
  const path = directory(t);
  const baseline = snapshot([
    hint(1),
    hint(2, { chainId: 11155111 }),
    hint(3, { status: "assembling", token: undefined }),
  ]);
  const session = new ApiSession("live", path);
  session.initialize(baseline, anchor);
  assert.deepEqual(session.state?.excluded, ["launch-1"]);
  assert.deepEqual(session.pending(), []);
  assert.deepEqual(session.state?.anchor, {
    number: anchor.number.toString(),
    hash: anchor.hash,
  });

  const persisted = readFileSync(join(path, "live.json"), "utf8");
  const restarted = new ApiSession("live", path);
  restarted.initialize(snapshot([hint(4)]), { ...anchor, number: 999999n });
  assert.equal(readFileSync(join(path, "live.json"), "utf8"), persisted);
  restarted.enqueue(snapshot([hint(1), hint(4)]));
  assert.deepEqual(
    restarted.pending().map((item) => item.id),
    ["launch-4"],
  );
});

test("enqueue accepts only live Ethereum records and requires an initial baseline", (t) => {
  const session = new ApiSession("live", directory(t));
  assert.throws(() => session.enqueue(snapshot([hint(1)])), /baseline missing/);
  assert.throws(
    () => session.finish("launch-1", "rejected"),
    /baseline missing/,
  );
  session.initialize(snapshot([]), anchor);
  session.enqueue(
    snapshot([
      hint(1, { chainId: 11155111 }),
      hint(2, { chainId: 42161 }),
      hint(3, { status: "assembling" }),
      hint(4, { status: "admitted" }),
      hint(5, { status: "abandoned" }),
      hint(6),
    ]),
  );
  assert.deepEqual(
    session.pending().map((item) => item.id),
    ["launch-6"],
  );
});

test("a mainnet project assembling at baseline becomes eligible when it turns live", (t) => {
  const path = directory(t);
  const session = new ApiSession("live", path);
  session.initialize(
    snapshot([hint(1, { status: "assembling", token: undefined })]),
    anchor,
  );
  session.enqueue(
    snapshot([hint(1, { status: "admitted", token: undefined })]),
  );
  assert.deepEqual(session.pending(), []);
  const restarted = new ApiSession("live", path);
  restarted.enqueue(snapshot([hint(1)]));
  assert.deepEqual(restarted.pending(), [hint(1)]);
});

test("repeated IDs update one pending item without dropping other pending launches", (t) => {
  const session = new ApiSession("live", directory(t));
  session.initialize(snapshot([]), anchor);
  session.enqueue(snapshot([hint(1), hint(2)]));
  session.enqueue(snapshot([hint(1), hint(1)]));
  session.enqueue(snapshot([hint(1, { kind: "univ4_hook" })]));
  assert.deepEqual(session.pending(), [
    hint(1, { kind: "univ4_hook" }),
    hint(2),
  ]);
  session.enqueue(snapshot([]));
  assert.equal(session.pending().length, 2);
});

test("pending candidates survive restart even when they rotate off the API list", (t) => {
  const path = directory(t);
  const session = new ApiSession("live", path);
  session.initialize(snapshot([]), anchor);
  session.enqueue(snapshot([hint(1), hint(2)]));
  const restarted = new ApiSession("live", path);
  restarted.enqueue(snapshot([hint(3)]));
  assert.deepEqual(restarted.pending(), [hint(1), hint(2), hint(3)]);
  assert.deepEqual(new ApiSession("live", path).pending(), restarted.pending());
});

test("explicit withdrawals remove stale pending evidence but later live records can return", (t) => {
  const path = directory(t);
  const session = new ApiSession("live", path);
  session.initialize(snapshot([]), anchor);
  session.enqueue(snapshot([hint(1), hint(2), hint(3)]));
  session.enqueue(snapshot([
    hint(1, { status: "abandoned" }),
    hint(2, { chainId: 11155111 }),
  ]));
  assert.deepEqual(session.pending(), [hint(3)]);
  const restarted = new ApiSession("live", path);
  assert.deepEqual(restarted.pending(), [hint(3)]);
  restarted.enqueue(snapshot([hint(1)]));
  assert.deepEqual(restarted.pending(), [hint(3), hint(1)]);
});

test("durable finish decisions prevent rejected and completed candidates reappearing", (t) => {
  const path = directory(t);
  const session = new ApiSession("live", path);
  session.initialize(snapshot([]), anchor);
  session.enqueue(snapshot([hint(1), hint(2), hint(3)]));
  session.finish("launch-1", "tax rejected");
  session.finish("launch-2", "confirmed");
  assert.deepEqual(session.pending(), [hint(3)]);
  const restarted = new ApiSession("live", path);
  restarted.enqueue(
    snapshot([hint(1, { kind: "custom_token" }), hint(2), hint(3)]),
  );
  assert.deepEqual(restarted.pending(), [hint(3)]);
  assert.equal(restarted.state?.decisions["launch-1"], "tax rejected");
  assert.equal(restarted.state?.decisions["launch-2"], "confirmed");
});

test("dry run and live use independent persisted baselines, queues and decisions", (t) => {
  const path = directory(t);
  const dry = new ApiSession("dry-run", path);
  dry.initialize(snapshot([hint(1)]), anchor);
  dry.enqueue(snapshot([hint(2)]));
  dry.finish("launch-2", "simulated");

  const live = new ApiSession("live", path);
  assert.equal(live.state, null);
  live.initialize(snapshot([]), anchor);
  live.enqueue(snapshot([hint(1), hint(2)]));
  assert.deepEqual(live.pending(), [hint(1), hint(2)]);
  assert.deepEqual(new ApiSession("dry-run", path).pending(), []);
  assert.equal(
    new ApiSession("dry-run", path).state?.decisions["launch-2"],
    "simulated",
  );
  assert.deepEqual(new ApiSession("live", path).state?.decisions, {});
});

test("corrupt persisted API state fails closed without replacing the original file", (t) => {
  const path = directory(t);
  const session = new ApiSession("live", path);
  session.initialize(snapshot([]), anchor);
  const valid = session.state!;
  const corruptions = [
    "{broken JSON",
    JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, baselineAt: "yesterday" }),
    JSON.stringify({ ...valid, anchor: { number: "bad", hash: anchor.hash } }),
    JSON.stringify({ ...valid, pending: [hint(1, { chainId: 0 })] }),
    JSON.stringify({ ...valid, decisions: { "launch-1": null } }),
  ];
  for (const content of corruptions) {
    writeFileSync(join(path, "live.json"), content);
    assert.throws(() => new ApiSession("live", path));
    assert.equal(readFileSync(join(path, "live.json"), "utf8"), content);
  }
});

test("baseline fetch exhausts all pages before returning a complete historical snapshot", async () => {
  const pages = [page(1002), page(502), [hint(2), hint(1)]];
  const requests: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    requests.push(String(input));
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    return response(pages[requests.length - 1]!);
  };
  const result = await fetchApiBaseline(undefined, fakeFetch);
  assert.deepEqual(requests, [
    "https://api.imd.fun/launches?limit=500",
    "https://api.imd.fun/launches?limit=500&before=503",
    "https://api.imd.fun/launches?limit=500&before=3",
  ]);
  assert.equal(result.launches.length, 1002);
  assert.equal(result.launches[0]!.launchNumber, 1002);
  assert.equal(result.launches.at(-1)!.launchNumber, 1);
  assert.equal(result.cacheMaxAgeSeconds, 10);
  assert.equal(result.source, "https://api.imd.fun/launches?limit=500");
});

test("an exactly full final page still requires an empty page to finish the baseline", async () => {
  let calls = 0;
  const result = await fetchApiBaseline(undefined, async () => {
    calls++;
    return response(calls === 1 ? page(500) : []);
  });
  assert.equal(calls, 2);
  assert.equal(result.launches.length, 500);
});

test("baseline rejects repeated IDs across pages rather than treating partial history as complete", async () => {
  let calls = 0;
  await assert.rejects(
    fetchApiBaseline(undefined, async () => {
      calls++;
      return response(calls === 1 ? page(1000) : [hint(501)]);
    }),
    /分页重复/,
  );
  assert.equal(calls, 2);
});

test("baseline rejects a pagination cursor that stops advancing even with new IDs", async () => {
  let calls = 0;
  await assert.rejects(
    fetchApiBaseline(undefined, async () => {
      calls++;
      return response(
        calls === 1
          ? page(1000)
          : page(1000).map((item) => ({ ...item, id: `other-${item.id}` })),
      );
    }),
    /分页起点未推进/,
  );
  assert.equal(calls, 2);
});

test("baseline HTTP failures and network failures do not return already collected pages", async () => {
  let calls = 0;
  await assert.rejects(
    fetchApiBaseline(undefined, async () => {
      calls++;
      return calls === 1
        ? response(page(1000))
        : new Response(null, { status: 503 });
    }),
    /官方 API 当前不可用/,
  );
  assert.equal(calls, 2);
  await assert.rejects(
    fetchApiBaseline(undefined, async () => {
      throw new Error("fixture network unavailable");
    }),
    /fixture network unavailable/,
  );
});

test("baseline rejects malformed lists, rows and JSON without seeding a usable snapshot", async () => {
  for (const value of [
    null,
    {},
    { launches: "bad" },
    {
      launches: [{ id: "bad", launchNumber: 1, chainId: "1", status: "live" }],
    },
    body([hint(1), hint(1)]),
    body([hint(1, { token: "0xbad" })]),
  ]) {
    await assert.rejects(
      fetchApiBaseline(undefined, async () => Response.json(value)),
      /格式不正确|字段不正确/,
    );
  }
  await assert.rejects(
    fetchApiBaseline(undefined, async () => new Response("not-json")),
    /invalid_json/,
  );
});

test("baseline streaming JSON has a finite body limit before parsing", async () => {
  await assert.rejects(
    fetchApiBaseline(undefined, async () => new Response("x".repeat(4 * 1024 * 1024 + 1))),
    /too_large/,
  );
});

test("an API that keeps returning full pages is bounded and cannot yield an incomplete baseline", async () => {
  let calls = 0;
  await assert.rejects(
    fetchApiBaseline(undefined, async () => {
      const rows = page(50000 - calls * 500);
      calls++;
      return response(rows);
    }),
    /历史过大/,
  );
  assert.equal(calls, 100);
});

test("caller cancellation reaches the baseline fetch signal", async () => {
  const controller = new AbortController();
  const cancelReason = new Error("fixture cancelled");
  controller.abort(cancelReason);
  await assert.rejects(
    fetchApiBaseline(controller.signal, async (_input, init) => {
      assert.equal(init?.signal?.aborted, true);
      throw init?.signal?.reason;
    }),
    /fixture cancelled/,
  );
});

test("Retry-After parsing preserves seconds and HTTP dates without shortening long server cooldowns", () => {
  const now = Date.parse("2026-10-01T12:00:00.000Z");
  assert.equal(parseApiRetryAfter("120", now), 120000);
  assert.equal(parseApiRetryAfter("1.25", now), 1250);
  assert.equal(parseApiRetryAfter("Thu, 01 Oct 2026 12:02:00 GMT", now), 120000);
  assert.equal(parseApiRetryAfter("Thu, 01 Oct 2026 11:59:00 GMT", now), 0);
  assert.equal(parseApiRetryAfter("2147484", now), 2147484000);
  for (const invalid of [null, "", "-1", "nonsense", "1e3", "999999999999999999999", "1\n", "x".repeat(129)])
    assert.equal(parseApiRetryAfter(invalid, now), null);
});

test("HTTP 429/503 errors carry typed cooldowns without exposing or downloading error payloads", async () => {
  for (const status of [429, 503, 403]) {
    let cancelled = false;
    const timings: ApiFetchTiming[] = [];
    await assert.rejects(fetchApiBaseline(undefined, async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("SECRET_BODY")); },
      cancel() { cancelled = true; },
    }), { status, statusText: "SECRET_STATUS", headers: { "retry-after": "120", "set-cookie": "SECRET_COOKIE" } }),
    { onTiming: (timing) => { timings.push(timing); } }), (error: unknown) => {
      assert.ok(error instanceof ApiHttpError);
      assert.equal(error.status, status);
      assert.equal(error.retryAfterMs, 120000);
      assert.equal(error.retryable, status === 429 || status === 503);
      assert.doesNotMatch(String(error), /SECRET/);
      return true;
    });
    assert.equal(cancelled, true);
    assert.equal(timings.length, 1);
    assert.equal(timings[0]!.outcome, "http_error");
    assert.equal(timings[0]!.bodyAndParseMs, null);
    assert.equal(timings[0]!.retryAfterMs, 120000);
    assert.doesNotMatch(JSON.stringify(timings), /SECRET/);
  }
});

test("baseline timing preserves full pagination and records only bounded header metadata", async () => {
  const timings: ApiFetchTiming[] = [];
  let calls = 0;
  const result = await fetchApiBaseline(undefined, async () => {
    calls++;
    return Response.json(body(calls === 1 ? page(501) : [hint(1)]), { headers: {
      "cache-control": "public, max-age=10", age: "8", etag: 'W/"snapshot-v1"',
      date: "Thu, 01 Oct 2026 12:00:00 GMT", "set-cookie": "SECRET_COOKIE", authorization: "SECRET_AUTH",
    } });
  }, { onTiming: (timing) => { timings.push(timing); } });
  assert.equal(result.launches.length, 501);
  assert.equal(result.launches.at(-1)?.launchNumber, 1);
  assert.equal(result.cacheMaxAgeSeconds, 10);
  assert.deepEqual(timings.map((timing) => [timing.page, timing.rowCount, timing.status, timing.outcome]),
    [[1, 500, 200, "success"], [2, 1, 200, "success"]]);
  for (const timing of timings) {
    assert.ok(timing.finishedMonotonicMs >= timing.startedMonotonicMs);
    assert.equal(timing.durationMs, timing.finishedMonotonicMs - timing.startedMonotonicMs);
    assert.ok(timing.headersMs! >= 0 && timing.bodyAndParseMs! >= 0 && timing.validationMs! >= 0);
    assert.equal(timing.headers.ageSeconds, 8);
    assert.equal(timing.headers.etag, 'W/"snapshot-v1"');
    assert.equal(Object.isFrozen(timing), true);
    assert.equal(Object.isFrozen(timing.headers), true);
  }
  assert.doesNotMatch(JSON.stringify(timings), /SECRET|artifacts/);
});

test("timing observers cannot change success or error semantics even when they throw asynchronously", async () => {
  const result = await fetchApiBaseline(undefined, async () => response([hint(1)]), {
    onTiming: () => { throw Error("observer failed"); },
  });
  assert.equal(result.launches.length, 1);
  await assert.rejects(fetchApiBaseline(undefined, async () => new Response(null, { status: 503 }), {
    onTiming: async () => { throw Error("observer failed asynchronously"); },
  }), ApiHttpError);
  await new Promise((resolve) => setImmediate(resolve));
});

test("timing records malformed responses and cancellation without exposing transport errors", async () => {
  const timings: ApiFetchTiming[] = [];
  await assert.rejects(fetchApiBaseline(undefined, async () => new Response("SECRET_INVALID_JSON"), {
    onTiming: (timing) => { timings.push(timing); },
  }), /invalid_json/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchApiBaseline(controller.signal, async () => { throw Error("SECRET_TRANSPORT"); }, {
    onTiming: (timing) => { timings.push(timing); },
  }));
  assert.deepEqual(timings.map((timing) => timing.outcome), ["invalid_response", "aborted"]);
  assert.equal(timings[1]!.status, null);
  assert.doesNotMatch(JSON.stringify(timings), /SECRET/);
});
