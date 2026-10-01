import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers";
import { InvalidInputRpcError, RpcRequestError, keccak256, type Hex, type PublicClient } from "viem";
import { startChainSignals } from "../src/chain-signals.js";

const hash = (number: bigint) => `0x${number.toString(16).padStart(64, "0")}` as Hex;
const address = `0x${"11".repeat(20)}` as const;
const registries = [{ address, codeHash: keccak256("0x1234") }];
const settle = async () => { for (let index = 0; index < 12; index++) await new Promise<void>(resolve => setImmediate(resolve)); };
const advance = async (t: TestContext, ms: number) => { t.mock.timers.tick(ms); await settle(); };
function indexingError(details = "block 2 is beyond the latest block 1 of this node, retry later") {
  return new InvalidInputRpcError(new RpcRequestError({ url: "https://fixture.invalid", body: {method: "eth_getLogs"},
    error: {code: -32000, message: details} }));
}
function rpc(onLogs: () => Promise<never[]>, head = 2n) {
  return { getChainId: async () => 11155111, getCode: async () => "0x1234",
    getBlock: async ({blockNumber}: {blockNumber?: bigint} = {}) => ({number: blockNumber ?? head, hash: hash(blockNumber ?? head)}),
    getLogs: onLogs,
  } as unknown as PublicClient;
}
const base = {chainId: 11155111, registries, startAfter: {number: 1n, hash: hash(1n)}, onSignal: () => {}};

test("actual viem indexing-lag shape retries only the affected provider after 150 ms", async t => {
  t.mock.timers.enable({apis: ["setTimeout", "setInterval"]});
  const calls = [0, 0], cursors: bigint[] = [], events: Array<{name: string; detail: Record<string, unknown>}> = [];
  const error = indexingError();
  assert.equal(error.name, "InvalidInputRpcError");
  assert.equal(error.details, "block 2 is beyond the latest block 1 of this node, retry later");
  const source = startChainSignals({...base,
    client: rpc(async () => { if (++calls[0]! === 1) throw error; return []; }),
    peer: rpc(async () => { calls[1]!++; return []; }),
    onCursor: cursor => { cursors.push(cursor.number); }, onEvent: (name, detail) => { events.push({name, detail}); },
  });
  try {
    await source.ready; await settle(); assert.deepEqual(calls, [1,1]); assert.deepEqual(cursors, []);
    await advance(t, 149); assert.deepEqual(calls, [1,1]);
    await advance(t, 1); assert.deepEqual(calls, [2,1]); assert.deepEqual(cursors, [2n]);
    assert.deepEqual(events.filter(event => event.name === "chain_signal_indexing_lag"), [
      {name: "chain_signal_indexing_lag", detail: {provider: 0, attempt: 1}},
    ]);
  } finally { await source.stop(); }
});

test("indexing retries stop after 150/300/600 ms and retain the unproven cursor for outer backoff", async t => {
  t.mock.timers.enable({apis: ["setTimeout", "setInterval"]});
  const calls = [0,0], cursors: bigint[] = [], attempts: unknown[] = [];
  const source = startChainSignals({...base,
    client: rpc(async () => { calls[0]!++; throw indexingError(); }),
    peer: rpc(async () => { calls[1]!++; return []; }),
    onCursor: cursor => { cursors.push(cursor.number); },
    onEvent: (name, detail) => { if (name === "chain_signal_indexing_lag") attempts.push(detail.attempt); },
  });
  try {
    await source.ready; await settle();
    for (const [delay, expected] of [[150,2],[300,3],[600,4]]) { await advance(t, delay!); assert.equal(calls[0], expected); }
    assert.deepEqual(attempts, [1,2,3]); assert.deepEqual(cursors, []); assert.equal(calls[1], 1);
    await advance(t, 999); assert.deepEqual(calls, [4,1]);
    await advance(t, 1); assert.deepEqual(calls, [5,2]); assert.deepEqual(cursors, []);
  } finally { await source.stop(); }
});

test("unrecognized errors, wrong ranges and timeouts do not receive short indexing retries", async t => {
  t.mock.timers.enable({apis: ["setTimeout", "setInterval"]});
  for (const error of [new Error("RPC timed out"), indexingError("method unavailable"),
    indexingError("block 3 is beyond the latest block 1 of this node, retry later"),
    indexingError("block 2 is beyond the latest block 2 of this node, retry later"),
    Object.assign(new Error("wrong error type"), {details: "block 2 is beyond the latest block 1 of this node, retry later"})]) {
    let calls = 0; const events: string[] = [], cursors: bigint[] = [];
    const source = startChainSignals({...base, client: rpc(async () => { calls++; throw error; }), peer: rpc(async () => []),
      onEvent: name => { events.push(name); }, onCursor: cursor => { cursors.push(cursor.number); },
    });
    try {
      await source.ready; await settle(); await advance(t, 600);
      assert.equal(calls, 1); assert.equal(events.includes("chain_signal_indexing_lag"), false);
      assert.ok(events.includes("chain_signal_logs_unavailable")); assert.deepEqual(cursors, []);
    } finally { await source.stop(); }
  }
});

test("stopping parallel provider retry waits drains both and prevents new RPC calls", {timeout: 3000}, async t => {
  t.mock.timers.enable({apis: ["setTimeout", "setInterval"]});
  const calls = [0,0], cursors: bigint[] = [];
  const source = startChainSignals({...base,
    client: rpc(async () => { calls[0]!++; throw indexingError(); }),
    peer: rpc(async () => { calls[1]!++; throw indexingError(); }),
    onCursor: cursor => { cursors.push(cursor.number); },
  });
  await source.ready; await settle(); assert.deepEqual(calls, [1,1]);
  await source.stop(); await advance(t, 10_000);
  assert.deepEqual(calls, [1,1]); assert.deepEqual(cursors, []);
});

class FakeSocket extends EventTarget {
  readyState = 0;
  closed = false;
  sent: unknown[] = [];
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  message(data: unknown) { this.dispatchEvent(new MessageEvent("message", {data: JSON.stringify(data)})); }
  close() { if (this.closed) return; this.closed = true; this.readyState = 3; this.dispatchEvent(new Event("close")); }
}

test("WS identity/subscription JSON-RPC errors close immediately and log only safe numeric codes", async t => {
  t.mock.timers.enable({apis: ["setTimeout", "setInterval"]});
  for (const id of [1,2]) {
    const socket = new FakeSocket(), events: Array<{name: string; detail: Record<string, unknown>}> = [];
    const source = startChainSignals({...base, client: rpc(async () => [], 1n), peer: rpc(async () => [], 1n),
      wsUrls: ["wss://fixture.invalid"], socketFactory: () => socket as unknown as WebSocket,
      onEvent: (name, detail) => { events.push({name, detail}); },
    });
    try {
      await source.ready; socket.open();
      if (id === 2) socket.message({jsonrpc: "2.0", id: 1, result: "0xaa36a7"});
      socket.message({jsonrpc: "2.0", id, error: {code: -32601, message: "SECRET provider URL and free-plan details"}});
      assert.equal(socket.closed, true, "do not wait for the ten-second handshake deadline");
      assert.deepEqual(events.filter(event => event.name === "chain_signal_ws_rpc_error"), [
        {name: "chain_signal_ws_rpc_error", detail: {provider: 0, requestId: id, code: -32601}},
      ]);
      assert.equal(JSON.stringify(events).includes("SECRET"), false);
      assert.equal(events.some(event => event.name === "chain_signal_ws_invalid"), false);
    } finally { await source.stop(); }
  }
});

test("non-numeric WS error codes are omitted from diagnostics and still terminate the handshake", async t => {
  t.mock.timers.enable({apis: ["setTimeout", "setInterval"]});
  const socket = new FakeSocket(); const diagnostics: Record<string, unknown>[] = [];
  const source = startChainSignals({...base, client: rpc(async () => [], 1n), peer: rpc(async () => [], 1n),
    wsUrls: ["wss://fixture.invalid"], socketFactory: () => socket as unknown as WebSocket,
    onEvent: (name, detail) => { if (name === "chain_signal_ws_rpc_error") diagnostics.push(detail); },
  });
  try {
    await source.ready; socket.open(); socket.message({jsonrpc: "2.0", id: 1, error: {code: "SECRET"}});
    assert.equal(socket.closed, true); assert.deepEqual(diagnostics, [{provider: 0, requestId: 1}]);
  } finally { await source.stop(); }
});

test("successful in-flight log replies after stop do not start another canonical RPC read", async t => {
  t.mock.timers.enable({apis: ["setTimeout", "setInterval"]});
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let logCalls = 0, blockCalls = 0;
  const client = rpc(async () => { logCalls++; await gate; return []; });
  const peer = rpc(async () => { logCalls++; await gate; return []; });
  for (const provider of [client, peer]) {
    const original = provider.getBlock;
    provider.getBlock = ((...args: Parameters<typeof original>) => { blockCalls++; return original(...args); }) as typeof original;
  }
  const source = startChainSignals({...base, client, peer});
  await source.ready; await settle(); assert.equal(logCalls, 2);
  const before = blockCalls;
  const stopped = source.stop(); release(); await stopped;
  assert.equal(blockCalls, before);
  await advance(t, 10_000); assert.equal(blockCalls, before); assert.equal(logCalls, 2);
});
