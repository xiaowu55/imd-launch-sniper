import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { once } from "node:events";
import { createControlServer } from "../src/control-server.js";
import { configSchema } from "../src/config.js";
import type { Engine } from "../src/engine.js";

async function fixture(t: TestContext) {
  let saves = 0, starts = 0;
  const wallet = { configured: true, address: `0x${"a".repeat(40)}`, source: "server-env" as const };
  const engine = {
    config: configSchema.parse({}), mode: "live" as Engine["mode"], running: false,
    get canConfigure() { return !this.running; },
    readiness: { ok: false, checks: [] }, state: {}, monitor: { status: "pending" as const, detail: "" },
    logs: [], research: {}, launchFeed: null,
    resetMonitor() {}, async check() { return this.readiness; },
    async start(mode: Engine["mode"]) { starts++; this.mode = mode; this.running = true; },
    stop() { this.running = false; },
  };
  const server = createControlServer(engine, {
    saveConfig: (value) => { saves++; return configSchema.parse(value); },
    walletStatus: () => wallet,
    reloadWallet: () => wallet,
    walletChangeAllowed: () => true,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("missing port");
  const url = `http://127.0.0.1:${address.port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });
  const post = (path: string, value: unknown = {}) => fetch(url + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
  });
  const slow = (path: string, method: string) => {
    let finish!: (status: number) => void;
    const done = new Promise<number>((r) => { finish = r; });
    const req = request(url + path, { method, headers: { "content-type": "application/json" } }, (res) => {
      res.resume(); res.on("end", () => finish(res.statusCode!));
    });
    req.on("error", () => finish(0));
    const received = once(server, "request");
    req.flushHeaders();
    return { req, done, received };
  };
  const liveInput = () => ({ mode: "live", expectedConfig: structuredClone(engine.config), expectedWalletAddress: wallet.address });
  return { engine, server, wallet, url, post, slow, liveInput, counts: () => ({ saves, starts }) };
}

test("slow config body cannot change a run that started while the request was pending", async (t) => {
  const f = await fixture(t);
  const pending = f.slow("/api/config", "PUT");
  await pending.received;
  assert.equal((await f.post("/api/start", f.liveInput())).status, 200);
  pending.req.end(JSON.stringify({ buyAmountEth: "5" }));
  assert.equal(await pending.done, 409);
  assert.equal(f.engine.config.buyAmountEth, "0.01");
  assert.equal(f.counts().saves, 0);
});

test("stop cancels a start whose request body has not finished arriving", async (t) => {
  const f = await fixture(t);
  const pending = f.slow("/api/start", "POST");
  await pending.received;
  assert.equal((await f.post("/api/stop")).status, 200);
  pending.req.end(JSON.stringify({ mode: "dry-run" }));
  assert.equal(await pending.done, 409);
  assert.equal(f.counts().starts, 0);
  assert.equal(f.engine.running, false);
});

test("live start requires the exact configuration and wallet the user reviewed", async (t) => {
  const f = await fixture(t);
  const input = { mode: "live", expectedConfig: structuredClone(f.engine.config), expectedWalletAddress: f.wallet.address };
  assert.equal((await f.post("/api/start", { mode: "live" })).status, 409);
  f.engine.config.buyAmountEth = "0.2";
  assert.equal((await f.post("/api/start", input)).status, 409);
  f.engine.config = structuredClone(input.expectedConfig);
  f.wallet.address = `0x${"b".repeat(40)}`;
  assert.equal((await f.post("/api/start", input)).status, 409);
  assert.equal(f.counts().starts, 0);
  input.expectedWalletAddress = f.wallet.address;
  assert.equal((await f.post("/api/start", input)).status, 200);
  assert.equal(f.counts().starts, 1);
});

test("the product control surface refuses rehearsal mode and never starts it", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post("/api/start", { mode: "dry-run" })).status, 400);
  assert.equal(f.counts().starts, 0);
  assert.equal(f.engine.running, false);
});

test("cross-site, rebinding hosts, opaque origins and simple-form submissions cannot operate the server", async (t) => {
  const f = await fixture(t);
  for (const headers of [
    { origin: "https://attacker.invalid" },
    { origin: "null" },
    { host: "attacker.invalid" },
    { "sec-fetch-site": "cross-site" },
  ]) {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(f.url + "/api/start", {
        method: "POST", headers: { "content-type": "application/json", ...headers },
      }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
      req.on("error", reject);
      req.end('{"mode":"dry-run"}');
    });
    assert.equal(status, 403, JSON.stringify(headers));
  }
  for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "application/jsonp"]) {
    const response = await fetch(f.url + "/api/start", { method: "POST", headers: { "content-type": contentType }, body: '{"mode":"dry-run"}' });
    assert.equal(response.status, 415);
  }
  assert.equal(f.counts().starts, 0);
});

test("malformed and oversized bodies fail closed without disabling later requests", async (t) => {
  const f = await fixture(t);
  for (const value of [null, [], "live", 1]) assert.equal((await f.post("/api/start", value)).status, 400);
  for (const raw of ["{", JSON.stringify({ x: "界".repeat(12000), mode: "dry-run" })]) {
    try {
      const response = await fetch(f.url + "/api/start", { method: "POST", headers: { "content-type": "application/json" }, body: raw });
      assert.ok(response.status === 400 || response.status === 413);
    } catch (error) { assert.ok(error instanceof TypeError); /* oversize stream may close the connection */ }
  }
  assert.equal(f.counts().starts, 0);
  assert.equal((await fetch(f.url + "/api/status")).status, 200);
});

test("private files are not served and status exposes wallet metadata only", async (t) => {
  const f = await fixture(t);
  for (const path of ["/.env", "/runtime/settings.json", "/.git/config", "/src/server.ts", "/%2e%2e/.env"])
    assert.equal((await fetch(f.url + path)).status, 404);
  const response = await fetch(f.url + "/api/status");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  const value = await response.json();
  assert.deepEqual(value.wallet, f.wallet);
  assert.equal(value.canConfigure, true);
});

test("malformed absolute request targets stay inside the HTTP error boundary", async (t) => {
  const f = await fixture(t);
  for (const path of ["http://[", "//[", "http://attacker.invalid/api/start"]) {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(f.url, { path, method: "GET" }, (res) => {
        res.resume(); res.on("end", () => resolve(res.statusCode!));
      });
      req.on("error", reject); req.end();
    });
    assert.equal(status, 400);
  }
  assert.equal((await fetch(f.url + "/api/status")).status, 200);
});

test("unserializable upstream state cannot crash the HTTP listener or send headers twice", async (t) => {
  const f = await fixture(t);
  let nested: object = {};
  for (let i = 0; i < 10000; i++) nested = { nested };
  for (const value of [{ unexpected: 1n }, nested]) {
    f.engine.research = value;
    assert.equal((await fetch(f.url + "/api/status")).status, 400);
    f.engine.research = {};
    assert.equal((await fetch(f.url + "/api/status")).status, 200);
  }
});
