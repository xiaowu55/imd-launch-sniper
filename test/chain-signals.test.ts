import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, keccak256, stringToHex, type Hex, type PublicClient } from "viem";
import { registryAbi } from "../src/discovery.js";
import { ChainSignalDeduper, decodeChainSignal, startChainSignals } from "../src/chain-signals.js";
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const address = `0x${"11".repeat(20)}` as const;
const registries = [{ address, codeHash: keccak256("0x1234") }];
const raw = (blockNumber = 2n, number = 9n, logIndex = 1) => ({ address, blockNumber, blockHash: hash(Number(blockNumber)),
  transactionHash: hash(Number(number) + 100), transactionIndex: 1, logIndex, removed: false,
  topics: encodeEventTopics({ abi: registryAbi, eventName: "LaunchRecorded", args: {
    launchNumber: number, kind: stringToHex("evm_project", { size: 32 }),
  } }),
  data: encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "address[]" }, { type: "uint256[]" }],
    [hash(5), hash(6), [address], [1n]]),
});
const options = { chainId: 11155111, registries, source: "ws" as const };
test("chain log hints require the right registry, complete identity and recognized event", () => {
  const hint = decodeChainSignal(raw(), options);
  assert.equal(hint.launchNumber, 9); assert.equal(hint.canonical, false); assert.ok(Object.isFrozen(hint));
  for (const patch of [{ address: `0x${"22".repeat(20)}` }, { blockHash: null }, { topics: [] },
    { transactionIndex: null }, { logIndex: Number.MAX_SAFE_INTEGER + 1 }, { removed: "false" }])
    assert.throws(() => decodeChainSignal({ ...raw(), ...patch }, options));
});
test("dual WS duplicates coalesce but HTTP verification and reorg removal remain observable", () => {
  const seen = new ChainSignalDeduper(2), hint = decodeChainSignal(raw(), options);
  assert.equal(seen.accept(hint), true); assert.equal(seen.accept(hint), false);
  assert.equal(seen.accept({ ...hint, source: "http", canonical: true }), true);
  assert.equal(seen.accept(hint), false);
  assert.equal(seen.accept({ ...hint, removed: true }), true);
  assert.equal(seen.accept({ ...hint, removed: true }), false);
  assert.equal(seen.accept(hint), false);
  assert.equal(seen.accept({ ...hint, blockHash: hash(10), canonical: true }), true);
});
function rpc(logs = [raw(3n, 12n, 2), raw(2n, 11n, 3)]) {
  return { getChainId: async () => 11155111, getCode: async () => "0x1234",
    getBlock: async ({ blockNumber }: { blockNumber?: bigint } = {}) => ({ number: blockNumber ?? 3n, hash: hash(Number(blockNumber ?? 3n)) }),
    getLogs: async () => logs,
  } as unknown as PublicClient;
}
test("HTTP gap replay sorts full ranges and persists cursor only after all deliveries", async () => {
  const events: number[] = [], cursors: bigint[] = [];
  let finish!: () => void; const done = new Promise<void>(r => { finish = r; });
  const source = startChainSignals({ ...options, client: rpc(), peer: rpc(), startAfter: { number: 1n, hash: hash(1) },
    pollIntervalMs: 100, onSignal: hint => { assert.equal(hint.canonical, true); events.push(hint.launchNumber); },
    onCursor: cursor => { assert.deepEqual(events, [11, 12]); cursors.push(cursor.number); finish(); } });
  await source.ready; await done; await source.stop(); assert.deepEqual(cursors, [3n]);
});
test("wrong chain or registry code never starts subscriptions or advances cursor", async () => {
  for (const mutation of [{ getChainId: async () => 1 }, { getCode: async () => "0x5678" }]) {
    let delivered = 0;
    const source = startChainSignals({ ...options, client: { ...rpc(), ...mutation } as PublicClient, peer: rpc(),
      startAfter: { number: 1n, hash: hash(1) }, onSignal: () => { delivered++; }, onCursor: () => { delivered++; } });
    await assert.rejects(source.ready, /fatal_chain_signal/); await source.stop(); assert.equal(delivered, 0);
  }
});
test("a mismatched block log does not advance the gap cursor or deliver canonical evidence", async () => {
  let delivered = 0, finish!: () => void; const done = new Promise<void>(r => { finish = r; });
  const source = startChainSignals({ ...options, client: rpc([{ ...raw(), blockHash: hash(999) }]), peer: rpc([{ ...raw(), blockHash: hash(999) }]),
    startAfter: { number: 1n, hash: hash(1) }, onSignal: () => { delivered++; }, onCursor: () => { delivered++; },
    onEvent: name => { if (name === "chain_signal_log_reorg") finish(); } });
  await source.ready; await done; await source.stop(); assert.equal(delivered, 0);
});
test("resume rechecks cursor hash, rewinds a reorg and replays rather than skipping gaps", async () => {
  const cursors: bigint[] = [], events: number[] = [];
  let finish!: () => void; const done = new Promise<void>(r => { finish = r; });
  const source = startChainSignals({ ...options, client: rpc(), peer: rpc(), startAfter: { number: 1n, hash: hash(1) },
    cursor: { number: 2n, hash: hash(998) }, onSignal: e => { events.push(e.launchNumber); },
    onCursor: c => { cursors.push(c.number); if (c.number === 3n) finish(); } });
  await source.ready; await done; await source.stop(); assert.deepEqual(cursors, [1n, 3n]); assert.deepEqual(events, [11, 12]);
});
test("stopping an in-flight scan prevents later callbacks and cursor advancement", async () => {
  let release!: (value: ReturnType<typeof raw>[]) => void, requested!: () => void;
  const started = new Promise<void>(r => { requested = r; });
  const client = { ...rpc(), getLogs: () => { requested(); return new Promise<ReturnType<typeof raw>[]>(r => { release = r; }); } } as unknown as PublicClient;
  let delivered = 0;
  const source = startChainSignals({ ...options, client, peer: rpc(), startAfter: { number: 1n, hash: hash(1) },
    onSignal: () => { delivered++; }, onCursor: () => { delivered++; } });
  await source.ready; await started; const stopped = source.stop(); release([raw()]); await stopped; assert.equal(delivered, 0);
});
