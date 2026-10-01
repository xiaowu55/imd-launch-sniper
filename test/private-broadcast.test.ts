import assert from "node:assert/strict";
import test from "node:test";
import { keccak256, recoverMessageAddress, serializeTransaction, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  PRIVATE_RELAY_URL, PrivateBroadcastError, sendPrivateTransaction,
  type PrivateBroadcastErrorCode, type PrivateBroadcastOptions,
} from "../src/private-broadcast.js";

// Public fixture keys, local signing only. Every transport in this file is injected.
const buyer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const auth = privateKeyToAccount(`0x${"22".repeat(32)}`);
const transaction = {
  type: "eip1559" as const, chainId: 1, nonce: 0,
  to: `0x${"33".repeat(20)}` as const, value: 1n, gas: 21000n,
  maxFeePerGas: 10n, maxPriorityFeePerGas: 1n,
};
const rawTransaction = await buyer.signTransaction(transaction);
const expectedHash = keccak256(rawTransaction);
const request = { rawTransaction, headBlockNumber: 100n };
const success = () => Response.json({ jsonrpc: "2.0", id: 1, result: expectedHash });
const transport = (work: (url: string, init: RequestInit) => Promise<Response>): typeof fetch =>
  (async (url, init) => work(String(url), init!)) as typeof fetch;
function errorCode(code: PrivateBroadcastErrorCode, uncertain: boolean) {
  return (error: unknown) => {
    assert.ok(error instanceof PrivateBroadcastError);
    assert.equal(error.code, code);
    assert.equal(error.uncertain, uncertain);
    assert.equal(error.cause, undefined);
    assert.equal(error.message.includes(rawTransaction), false);
    assert.equal(error.message.includes("SECRET"), false);
    return true;
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("submits exactly one authenticated, hash-only private request for the next block", async () => {
  let calls = 0;
  const result = await sendPrivateTransaction(request, { authSigner: auth, fetch: transport(async (url, init) => {
    calls++;
    assert.equal(url, `${PRIVATE_RELAY_URL}/`);
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    const body = String(init.body);
    assert.deepEqual(JSON.parse(body), { jsonrpc: "2.0", id: 1, method: "eth_sendPrivateTransaction", params: [{
      tx: rawTransaction, maxBlockNumber: "0x65",
      preferences: { fast: false, privacy: { hints: ["hash"], builders: ["flashbots"] } },
    }] });
    const headers = new Headers(init.headers);
    assert.equal(headers.get("content-type"), "application/json");
    const [address, signature] = headers.get("x-flashbots-signature")!.split(":");
    assert.equal(address, auth.address);
    assert.equal(await recoverMessageAddress({ message: keccak256(stringToHex(body)), signature: signature as Hex }), auth.address);
    return success();
  }) });
  assert.equal(result, expectedHash);
  assert.equal(calls, 1);
});

test("default authentication uses a new account distinct from the funded transaction signer", async () => {
  const identities: string[] = [];
  for (let i = 0; i < 2; i++) await sendPrivateTransaction(request, { fetch: transport(async (_, init) => {
    const [address, signature] = new Headers(init.headers).get("x-flashbots-signature")!.split(":");
    identities.push(address!);
    assert.notEqual(address!.toLowerCase(), buyer.address.toLowerCase());
    assert.equal(await recoverMessageAddress({ message: keccak256(stringToHex(String(init.body))), signature: signature as Hex }), address);
    return success();
  }) });
  assert.notEqual(identities[0], identities[1]);
});

test("bounds the inclusion window and rejects unsafe relay URLs before transport", async () => {
  let calls = 0;
  const fetch = transport(async () => { calls++; return success(); });
  for (const options of [
    { url: "http://relay.flashbots.net" }, { url: "https://user:SECRET@example.invalid" },
    { url: "https://relay.flashbots.net/#SECRET" }, { url: "invalid" },
    { timeoutMs: 0 }, { timeoutMs: 30001 }, { maxBlockDistance: 0 }, { maxBlockDistance: 26 },
    { maxBlockDistance: 1.5 },
  ]) await assert.rejects(sendPrivateTransaction(request, { ...options, fetch }), errorCode("INVALID_CONFIG", false));
  assert.equal(calls, 0);
  await sendPrivateTransaction(request, { maxBlockDistance: 25, authSigner: auth, fetch: transport(async (_, init) => {
    assert.equal(JSON.parse(String(init.body)).params[0].maxBlockNumber, "0x7d");
    return success();
  }) });
});

test("rejects wrong-chain, unsigned, zero-tip, malformed and oversized transactions without transmission", async () => {
  let calls = 0;
  const fetch = transport(async () => { calls++; return success(); });
  for (const raw of [
    await buyer.signTransaction({ ...transaction, chainId: 11155111 }),
    await buyer.signTransaction({ ...transaction, maxPriorityFeePerGas: 0n }),
    serializeTransaction(transaction), "0x1", "0x00", `0x${"11".repeat(300001)}`,
  ]) await assert.rejects(sendPrivateTransaction({ ...request, rawTransaction: raw as Hex }, { fetch }), errorCode("INVALID_TRANSACTION", false));
  for (const headBlockNumber of [0n, -1n, 2n ** 64n - 1n])
    await assert.rejects(sendPrivateTransaction({ ...request, headBlockNumber }, { fetch }), errorCode("INVALID_TRANSACTION", false));
  assert.equal(calls, 0);
});

test("refuses the funded account for authentication and sanitizes signer failures", async () => {
  let calls = 0;
  const fetch = transport(async () => { calls++; return success(); });
  await assert.rejects(sendPrivateTransaction(request, { fetch, authSigner: buyer }), errorCode("INVALID_CONFIG", false));
  for (const signMessage of [
    async () => { throw Error(`SECRET ${rawTransaction}`); },
    async () => "0x1234" as Hex,
    async ({ message }: { message: string }) => buyer.signMessage({ message }),
  ]) await assert.rejects(sendPrivateTransaction(request, { fetch, authSigner: { address: auth.address, signMessage } }), errorCode("AUTH_FAILED", false));
  assert.equal(calls, 0);
});

test("rejects mismatched hashes, IDs, RPC errors and malformed responses without a retry or public fallback", async () => {
  const responses = [
    { value: { jsonrpc: "2.0", id: 1, result: `0x${"ff".repeat(32)}` }, code: "INVALID_RESPONSE" },
    { value: { jsonrpc: "2.0", id: 2, result: expectedHash }, code: "INVALID_RESPONSE" },
    { value: { jsonrpc: "1.0", id: 1, result: expectedHash }, code: "INVALID_RESPONSE" },
    { value: { jsonrpc: "2.0", id: 1, result: null }, code: "INVALID_RESPONSE" },
    { value: { jsonrpc: "2.0", id: 1, error: { message: `SECRET ${rawTransaction}` } }, code: "RPC_FAILED" },
    { value: { jsonrpc: "2.0", id: 1, result: expectedHash, error: null }, code: "RPC_FAILED" },
  ] as const;
  for (const { value, code } of responses) {
    let calls = 0;
    await assert.rejects(sendPrivateTransaction(request, { authSigner: auth, fetch: transport(async (_, init) => {
      calls++;
      assert.equal(JSON.parse(String(init.body)).method, "eth_sendPrivateTransaction");
      return Response.json(value);
    }) }), errorCode(code, true));
    assert.equal(calls, 1);
  }
});

test("HTTP failures and transport exceptions preserve uncertainty without exposing their contents", async () => {
  for (const failure of ["http", "network"] as const) {
    let calls = 0;
    await assert.rejects(sendPrivateTransaction(request, { authSigner: auth, fetch: transport(async () => {
      calls++;
      if (failure === "network") throw Error(`SECRET ${rawTransaction}`);
      return new Response(`SECRET ${rawTransaction}`, { status: 503 });
    }) }), errorCode(failure === "http" ? "HTTP_FAILED" : "TRANSPORT_FAILED", true));
    assert.equal(calls, 1);
  }
});

test("bounds response bytes for declared and chunked bodies and rejects invalid JSON/UTF-8", async () => {
  let cancelled = 0;
  const responses = [
    new Response("SECRET invalid JSON"),
    new Response(new Uint8Array([0xff, 0xfe])),
    new Response("small", { headers: { "Content-Length": "65537" } }),
    new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(65537)); },
      cancel() { cancelled++; },
    })),
  ];
  for (const response of responses) await assert.rejects(sendPrivateTransaction(request, {
    authSigner: auth, fetch: transport(async () => response),
  }), errorCode("INVALID_RESPONSE", true));
  assert.equal(cancelled, 1);
});

test("a pre-cancelled request never authenticates or reaches any transport", async () => {
  let signs = 0, calls = 0;
  await assert.rejects(sendPrivateTransaction({ ...request, signal: AbortSignal.abort(Error("SECRET")) }, {
    authSigner: { address: auth.address, async signMessage({ message }) { signs++; return auth.signMessage({ message }); } },
    fetch: transport(async () => { calls++; return success(); }),
  }), errorCode("CANCELLED", false));
  assert.equal(signs, 0); assert.equal(calls, 0);
});

test("abort during asynchronous authentication prevents a late signature from sending", async () => {
  const entered = deferred<void>(), signature = deferred<Hex>();
  const controller = new AbortController();
  let calls = 0;
  const pending = sendPrivateTransaction({ ...request, signal: controller.signal }, {
    authSigner: { address: auth.address, async signMessage() { entered.resolve(); return signature.promise; } },
    fetch: transport(async () => { calls++; return success(); }),
  });
  await entered.promise;
  controller.abort(Error("SECRET"));
  await assert.rejects(pending, errorCode("CANCELLED", false));
  signature.resolve(`0x${"11".repeat(65)}`);
  await Promise.resolve();
  assert.equal(calls, 0);
});

test("final authorization is rechecked after asynchronous authentication, before the raw transaction leaves", async () => {
  const entered = deferred<void>(), release = deferred<void>();
  let current = true, guards = 0, calls = 0;
  const pending = sendPrivateTransaction({ ...request, assertCanSubmit() {
    guards++;
    if (!current) throw Error(`SECRET stale authorization ${rawTransaction}`);
  } }, {
    authSigner: { address: auth.address, async signMessage({ message }) {
      entered.resolve(); await release.promise; return auth.signMessage({ message });
    } },
    fetch: transport(async () => { calls++; return success(); }),
  });
  await entered.promise;
  assert.equal(guards, 0);
  current = false;
  release.resolve();
  await assert.rejects(pending, errorCode("PRECONDITION_FAILED", false));
  assert.equal(guards, 1); assert.equal(calls, 0);
});

test("the final authorization guard and transport run without an intervening asynchronous step", async () => {
  const order: string[] = [];
  await sendPrivateTransaction({ ...request, assertCanSubmit() {
    order.push("guard");
    queueMicrotask(() => order.push("microtask"));
  } }, { authSigner: auth, fetch: transport(async () => { order.push("send"); return success(); }) });
  assert.deepEqual(order, ["guard", "send", "microtask"]);
});

test("an accidentally asynchronous authorization guard fails closed instead of being ignored", async () => {
  let calls = 0;
  await assert.rejects(sendPrivateTransaction({ ...request, async assertCanSubmit() {
    throw Error("SECRET authorization failure");
  } }, { authSigner: auth, fetch: transport(async () => { calls++; return success(); }) }), errorCode("PRECONDITION_FAILED", false));
  assert.equal(calls, 0);
});

test("abort after dispatch remains uncertain even when the transport ignores AbortSignal", async () => {
  const entered = deferred<void>(), response = deferred<Response>();
  const controller = new AbortController();
  let calls = 0;
  const pending = sendPrivateTransaction({ ...request, signal: controller.signal }, {
    authSigner: auth, fetch: transport(async () => { calls++; entered.resolve(); return response.promise; }),
  });
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, errorCode("CANCELLED", true));
  response.resolve(success());
  await Promise.resolve();
  assert.equal(calls, 1);
});

test("timeout bounds stalled authentication without transmission", async () => {
  let calls = 0;
  await assert.rejects(sendPrivateTransaction(request, {
    timeoutMs: 100,
    authSigner: { address: auth.address, signMessage: () => new Promise<Hex>(() => {}) },
    fetch: transport(async () => { calls++; return success(); }),
  }), errorCode("TIMEOUT", false));
  assert.equal(calls, 0);
});

test("timeout during response streaming cancels the body and never resubmits", async () => {
  let calls = 0, cancelled = 0;
  await assert.rejects(sendPrivateTransaction(request, {
    timeoutMs: 100, authSigner: auth,
    fetch: transport(async () => {
      calls++;
      return new Response(new ReadableStream({ cancel() { cancelled++; } }));
    }),
  }), errorCode("TIMEOUT", true));
  assert.equal(calls, 1); assert.equal(cancelled, 1);
});

test("a transport that ignores timeout cannot keep the caller pending", async () => {
  let calls = 0;
  const options: PrivateBroadcastOptions = {
    timeoutMs: 100, authSigner: auth,
    fetch: transport(async () => { calls++; return new Promise<Response>(() => {}); }),
  };
  await assert.rejects(sendPrivateTransaction(request, options), errorCode("TIMEOUT", true));
  assert.equal(calls, 1);
});
