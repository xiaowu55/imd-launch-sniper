import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, keccak256, stringToHex, type Hex, type PublicClient } from "viem";
import { registryAbi } from "../src/discovery.js";
import { startChainSignals, type ChainLaunchSignal, type ChainSignalOptions } from "../src/chain-signals.js";

const hash = (n: bigint | number) => `0x${BigInt(n).toString(16).padStart(64, "0")}` as Hex;
const address = `0x${"11".repeat(20)}` as const;
const registries = [{ address, codeHash: keccak256("0x1234") }];
const log = (blockNumber = 2n, launchNumber = 11n) => ({
  address, blockNumber, blockHash: hash(blockNumber), transactionHash: hash(launchNumber + 100n),
  transactionIndex: 1, logIndex: Number(launchNumber), removed: false,
  topics: encodeEventTopics({ abi: registryAbi, eventName: "LaunchRecorded", args: {
    launchNumber, kind: stringToHex("evm_project", { size: 32 }),
  } }) as Hex[],
  data: encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "address[]" }, { type: "uint256[]" }],
    [hash(5), hash(6), [address], [1n]]),
});
type RawLog = ReturnType<typeof log>;
function rpc(head = 3n, logs: RawLog[] = [log(2n, 11n), log(3n, 12n)]) {
  return {
    ranges: [] as Array<[bigint, bigint]>,
    getChainId: async () => 11155111,
    getCode: async () => "0x1234" as Hex,
    getBlock: async ({ blockNumber }: { blockNumber?: bigint } = {}) => ({ number: blockNumber ?? head, hash: hash(blockNumber ?? head) }),
    async getLogs({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) {
      this.ranges.push([fromBlock, toBlock]);
      return logs.filter(log => log.blockNumber >= fromBlock && log.blockNumber <= toBlock);
    },
  };
}
const client = (value: ReturnType<typeof rpc>) => value as unknown as PublicClient;
const base = (primary = rpc(), peer = rpc()): ChainSignalOptions => ({
  chainId: 11155111, client: client(primary), peer: client(peer), registries,
  startAfter: { number: 1n, hash: hash(1) }, pollIntervalMs: 100,
  onSignal: () => {},
});
// RPC and callback boundaries need several microtasks; this does not advance timers.
async function settle() { for (let i = 0; i < 100; i++) await Promise.resolve(); }

class FakeSocket extends EventTarget {
  readyState = WebSocket.CONNECTING as number;
  closeCalls = 0;
  sendAttempts = 0;
  throwOnSend = false;
  sent: Array<{ id: number; method: string; params: unknown[] }> = [];
  send(text: string) {
    this.sendAttempts++;
    if (this.throwOnSend) throw Error("socket closed during send");
    this.sent.push(JSON.parse(text));
  }
  // Deliberately no close event: cleanup must not depend on peer cooperation.
  close() { this.closeCalls++; this.readyState = WebSocket.CLOSED; }
  open() { this.readyState = WebSocket.OPEN; this.dispatchEvent(new Event("open")); }
  message(value: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value, (_, item) =>
      typeof item === "bigint" ? `0x${item.toString(16)}` : item) }));
  }
  asWebSocket() { return this as unknown as WebSocket; }
}

test("failed signal delivery leaves the cursor behind and retries the entire undelivered range", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const primary = rpc(); const cursors: bigint[] = []; const delivered: number[] = [];
  let failed = false;
  const source = startChainSignals({ ...base(primary), onSignal: hint => {
    if (hint.launchNumber === 12 && !failed) { failed = true; throw Error("durable write failed"); }
    delivered.push(hint.launchNumber);
  }, onCursor: cursor => { cursors.push(cursor.number); } });
  try {
    await source.ready; await settle();
    assert.equal(failed, true); assert.deepEqual(cursors, []); assert.deepEqual(delivered, [11]);
    t.mock.timers.tick(1000); await settle();
    assert.deepEqual(cursors, [3n]); assert.equal(delivered.at(-1), 12);
    assert.deepEqual(primary.ranges, [[2n, 3n], [2n, 3n]]);
  } finally { await source.stop(); }
});

test("failed cursor persistence retries the same range without skipping or repeating successful signal delivery", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const primary = rpc(); const persisted: bigint[] = []; let cursorCalls = 0, delivered = 0;
  const source = startChainSignals({ ...base(primary), onSignal: () => { delivered++; }, onCursor: cursor => {
    if (++cursorCalls === 1) throw Error("cursor disk failure");
    persisted.push(cursor.number);
  } });
  try {
    await source.ready; await settle(); assert.equal(delivered, 2); assert.deepEqual(persisted, []);
    t.mock.timers.tick(1000); await settle();
    assert.deepEqual(primary.ranges, [[2n, 3n], [2n, 3n]]);
    assert.deepEqual(persisted, [3n]); assert.equal(delivered, 2);
  } finally { await source.stop(); }
});

test("an empty or altered peer log set cannot advance a supposedly complete HTTP range", async t => {
  for (const peerLogs of [[], [{ ...log(2n, 11n), data: log(2n, 99n).data.replace(hash(5).slice(2), hash(9).slice(2)) as Hex }, log(3n, 12n)]]) {
    const notices: string[] = []; let delivered = 0, cursors = 0;
    const source = startChainSignals({ ...base(rpc(), rpc(3n, peerLogs)), onSignal: () => { delivered++; },
      onCursor: () => { cursors++; }, onEvent: event => { notices.push(event); } });
    try {
      await source.ready; await settle();
      assert.ok(notices.includes("chain_signal_log_mismatch")); assert.equal(delivered, 0); assert.equal(cursors, 0);
    } finally { await source.stop(); }
  }
});

test("a fork deeper than twelve blocks replays from the proven anchor and finds an earlier replacement launch", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const primary = rpc(100n, [log(50n, 50n)]), peer = rpc(100n, [log(50n, 50n)]);
  const cursors: bigint[] = [], delivered: number[] = [];
  const source = startChainSignals({ ...base(primary, peer), cursor: { number: 100n, hash: hash(999) },
    onSignal: event => { delivered.push(event.launchNumber); }, onCursor: cursor => { cursors.push(cursor.number); } });
  try {
    await source.ready; await settle(); t.mock.timers.tick(100); await settle();
    assert.deepEqual(primary.ranges, [[2n, 65n], [66n, 100n]]);
    assert.deepEqual(cursors, [1n, 65n, 100n]); assert.deepEqual(delivered, [50]);
  } finally { await source.stop(); }
});

test("a changed session anchor stops discovery without replacing it or persisting any cursor", async () => {
  const primary = rpc(), peer = rpc();
  for (const provider of [primary, peer]) provider.getBlock = async ({ blockNumber } = {}) => ({
    number: blockNumber ?? 3n, hash: blockNumber === 1n ? hash(999) : hash(blockNumber ?? 3n),
  });
  let delivered = 0;
  const source = startChainSignals({ ...base(primary, peer), onSignal: () => { delivered++; }, onCursor: () => { delivered++; } });
  await assert.rejects(source.ready, /fatal_chain_signal_anchor_reorg/);
  await source.stop(); assert.equal(delivered, 0); assert.deepEqual(primary.ranges, []);
});

test("WS verifies the chain before subscribing, rejects foreign subscriptions and stops without a close event", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const socket = new FakeSocket(), delivered: ChainLaunchSignal[] = [];
  let creations = 0;
  const source = startChainSignals({ ...base(rpc(1n, []), rpc(1n, [])), wsUrls: ["wss://fixture.invalid"],
    socketFactory: () => { creations++; return socket.asWebSocket(); }, onSignal: event => { delivered.push(event); } });
  try {
    await source.ready; await settle(); socket.open();
    assert.deepEqual(socket.sent.map(message => message.method), ["eth_chainId"]);
    socket.message({ id: 1, result: "0xaa36a7" });
    assert.deepEqual(socket.sent.map(message => message.method), ["eth_chainId", "eth_subscribe"]);
    socket.message({ id: 2, result: "known-subscription" });
    socket.message({ method: "eth_subscription", params: { subscription: "foreign", result: log() } });
    socket.message({ method: "eth_subscription", params: { subscription: "known-subscription", result: log() } });
    await settle(); assert.equal(delivered.length, 1); assert.equal(delivered[0]!.canonical, false);
    await source.stop(); const sends = socket.sendAttempts;
    t.mock.timers.tick(120000); await settle();
    assert.equal(socket.sendAttempts, sends); assert.equal(socket.closeCalls, 1); assert.equal(creations, 1);
  } finally { await source.stop(); }
});

test("a stalled CONNECTING socket times out, reconnects once, and cannot restart after stop", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const sockets: FakeSocket[] = [];
  const source = startChainSignals({ ...base(rpc(1n, []), rpc(1n, [])), wsUrls: ["wss://fixture.invalid"],
    socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket.asWebSocket(); } });
  try {
    await source.ready; await settle(); assert.equal(sockets.length, 1);
    t.mock.timers.tick(9999); await settle(); assert.equal(sockets[0]!.closeCalls, 0);
    t.mock.timers.tick(1); await settle(); assert.equal(sockets[0]!.closeCalls, 1);
    t.mock.timers.tick(1000); await settle(); assert.equal(sockets.length, 2);
    await source.stop(); t.mock.timers.tick(60000); await settle();
    assert.equal(sockets.length, 2); assert.equal(sockets[1]!.closeCalls, 1);
  } finally { await source.stop(); }
});

test("unsolicited subscription acknowledgements and wrong-chain WS replies cannot deliver launch hints", async () => {
  for (const reply of ["unsolicited-subscription", "wrong-chain"] as const) {
    const socket = new FakeSocket(); let delivered = 0;
    const source = startChainSignals({ ...base(rpc(1n, []), rpc(1n, [])), wsUrls: ["wss://fixture.invalid"],
      socketFactory: () => socket.asWebSocket(), onSignal: () => { delivered++; } });
    try {
      await source.ready; await settle(); socket.open();
      if (reply === "wrong-chain") socket.message({ id: 1, result: "0x1" });
      socket.message({ id: 2, result: "unsolicited" });
      socket.message({ method: "eth_subscription", params: { subscription: "unsolicited", result: log() } });
      await settle(); assert.equal(delivered, 0, reply);
      assert.equal(socket.sent.some(message => message.method === "eth_subscribe"), false);
    } finally { await source.stop(); }
  }
});

test("send exceptions and explicit WS errors clean up once and retry without uncaught callbacks", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const sockets: FakeSocket[] = [];
  const source = startChainSignals({ ...base(rpc(1n, []), rpc(1n, [])), wsUrls: ["wss://fixture.invalid"],
    socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket.asWebSocket(); } });
  try {
    await source.ready; await settle(); const first = sockets[0]!; first.throwOnSend = true;
    assert.doesNotThrow(() => first.open()); assert.equal(first.closeCalls, 1);
    first.dispatchEvent(new Event("error")); assert.equal(first.closeCalls, 1);
    t.mock.timers.tick(1000); await settle(); assert.equal(sockets.length, 2);
    const second = sockets[1]!; second.open(); second.message({ id: 1, result: "0xaa36a7" });
    second.message({ id: 2, result: "sub" }); second.throwOnSend = true;
    t.mock.timers.tick(15000); await settle(); assert.equal(second.closeCalls, 1);
    t.mock.timers.tick(1000); await settle(); assert.equal(sockets.length, 3);
    const third = sockets[2]!; third.open(); third.message({ id: 1, result: "0xaa36a7" });
    third.message({ id: 2, result: "sub-3" }); third.dispatchEvent(new Event("error"));
    assert.equal(third.closeCalls, 1);
    t.mock.timers.tick(1000); await settle(); assert.equal(sockets.length, 4);
    await source.stop(); const count = sockets.length;
    t.mock.timers.tick(60000); await settle(); assert.equal(sockets.length, count);
  } finally { await source.stop(); }
});

test("temporary setup RPC failure retries instead of permanently disabling chain observation", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const primary = rpc(1n, []); let calls = 0, ready = false;
  primary.getChainId = async () => { if (++calls === 1) throw Error("temporary network timeout"); return 11155111; };
  const source = startChainSignals({ ...base(primary, rpc(1n, [])) });
  void source.ready.then(() => { ready = true; });
  try {
    await settle(); assert.equal(ready, false); assert.equal(calls, 1);
    t.mock.timers.tick(1000); await settle();
    await source.ready; assert.equal(ready, true); assert.equal(calls, 2);
  } finally { await source.stop(); }
});
