import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, type Hex, type PublicClient } from "viem";
import { settleChecks, StageBlockReads, TestnetProtocolVerifier, validateActionAge } from "../scripts/testnet-execution-cache.js";

const hashA = `0x${"a".repeat(64)}` as Hex;
const hashB = `0x${"b".repeat(64)}` as Hex;
const code = "0x123456" as const;
const contract = { address: `0x${"1".repeat(40)}` as Hex, codeHash: keccak256(code) };
function fixture() {
  const state = { chain: 11155111, hash: hashA, code: code as Hex, blockReads: 0, codeReads: 0 };
  const client = {
    async getChainId() { return state.chain; },
    async getBlock() { state.blockReads++; return { number: 100n, hash: state.hash }; },
    async getCode() { state.codeReads++; return state.code; },
  } as unknown as PublicClient;
  return { state, client };
}

test("parallel validation waits for every sibling to settle before reporting failure", async () => {
  let release!: () => void;
  let siblingFinished = false;
  let rejected = false;
  const slow = new Promise<void>((resolve) => { release = () => { siblingFinished = true; resolve(); }; });
  const result = settleChecks([Promise.reject(Error("failed_check")), slow]);
  void result.catch(() => { rejected = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(rejected, false);
  assert.equal(siblingFinished, false);
  release();
  await assert.rejects(result, /failed_check/);
  assert.equal(siblingFinished, true);
});

test("protocol code is reused only on the same block hash while chain and canonical blocks are refreshed", async () => {
  const a = fixture(); const b = fixture();
  const verifier = new TestnetProtocolVerifier([contract]);
  await verifier.verify([a.client, b.client], 100n, hashA, new StageBlockReads());
  assert.equal(a.state.codeReads, 1); assert.equal(b.state.codeReads, 1);
  await verifier.verify([a.client, b.client], 100n, hashA, new StageBlockReads());
  assert.equal(a.state.codeReads, 1); assert.equal(b.state.codeReads, 1);
  assert.equal(a.state.blockReads, 2); assert.equal(b.state.blockReads, 2);
  b.state.hash = hashB;
  await assert.rejects(verifier.verify([a.client, b.client], 100n, hashA, new StageBlockReads()), /testnet_block_mismatch/);
  a.state.hash = hashB;
  await verifier.verify([a.client, b.client], 100n, hashB, new StageBlockReads());
  assert.equal(a.state.codeReads, 2); assert.equal(b.state.codeReads, 2);
  b.state.chain = 1;
  await assert.rejects(verifier.verify([a.client, b.client], 100n, hashB, new StageBlockReads()), /testnet_rpc_chain_mismatch/);
});

test("failed joint protocol verification does not warm either peer's code cache", async () => {
  const a = fixture(); const b = fixture();
  const verifier = new TestnetProtocolVerifier([contract]);
  b.state.code = "0x00";
  await assert.rejects(verifier.verify([a.client, b.client], 100n, hashA, new StageBlockReads()), /testnet_protocol_changed/);
  b.state.code = code;
  await verifier.verify([a.client, b.client], 100n, hashA, new StageBlockReads());
  assert.equal(a.state.codeReads, 2); assert.equal(b.state.codeReads, 2);
});

test("block read reuse is bounded to a validation stage and an exact client and request", async () => {
  const a = fixture(); const b = fixture(); const reads = new StageBlockReads();
  await settleChecks([reads.block(a.client, 100n), reads.block(a.client, 100n), reads.block(a.client), reads.block(b.client, 100n)]);
  assert.equal(a.state.blockReads, 2); assert.equal(b.state.blockReads, 1);
  await new StageBlockReads().block(a.client, 100n);
  assert.equal(a.state.blockReads, 3);
});

test("a slow parallel sibling cannot keep an expired launch-age snapshot valid at the action boundary", async () => {
  const launch = 1790000000n;
  let wallMs = Number(launch + 119n) * 1000;
  const age = { launchTimestamp: launch, headTimestamp: launch + 119n };
  validateActionAge(age, wallMs);
  await settleChecks([
    Promise.resolve(age),
    Promise.resolve().then(() => { wallMs += 5000; }),
  ]);
  assert.throws(() => validateActionAge(age, wallMs), /continuous_launch_stale/);
});
