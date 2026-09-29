import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, type Address, type Hex, type PublicClient } from "viem";
import { deploymentSchema, type Deployment } from "../src/config.js";
import { CursorStore, resolveBoundary } from "../src/monitor.js";

const address = (digit: string) => `0x${digit.repeat(40)}` as Address;
const code: Hex = "0x6000600055";
const codeHash = keccak256(code);
const hash = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const factoryA = address("a");
const factoryB = address("b");
type Factory = Deployment["factories"][number] & {
  autoStartSafe?: boolean;
  deploymentBlock?: string;
};

function deployment(factories: Factory[] = [{
  address: factoryA,
  codeHash,
  autoStartSafe: true,
}]): Deployment {
  const result = deploymentSchema.parse({
    chainId: 1,
    verified: true,
    verifiedSource: "https://example.invalid/reviewed",
    poolManager: { address: address("1"), codeHash },
    router: { address: address("2"), codeHash },
    quoter: { address: address("3"), codeHash },
    stateView: { address: address("4"), codeHash },
    factories,
    registries: [{ address: address("5"), codeHash }],
    deployers: [address("6")],
    taxPolicies: [],
  });
  result.factories = factories as Deployment["factories"];
  return result;
}
function fakeClient(created: Record<string, bigint> = { [factoryA]: 37n }) {
  const calls: { address: Address; blockNumber: bigint }[] = [];
  const hashes = new Map<bigint, Hex>();
  const rpc = {
    getChainId: async () => 1,
    getBlock: async (args?: { blockNumber: bigint }) => {
      const number = args?.blockNumber ?? 100n;
      if (number < 0n || number > 100n) throw Error("block not found");
      return { number, hash: hashes.get(number) ?? hash(number + 1n) };
    },
    getCode: async (args: { address: Address; blockNumber: bigint }) => {
      calls.push(args);
      const block = created[args.address.toLowerCase()];
      return block !== undefined && args.blockNumber >= block ? code : undefined;
    },
  };
  return { rpc, client: rpc as unknown as PublicClient, calls, hashes };
}
function temporary(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), "imd-monitor-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("automatic boundary locates the earliest official factory creation exactly", async (t) => {
  const directory = temporary(t);
  const { client, calls } = fakeClient({ [factoryA]: 37n, [factoryB]: 9n });
  const manifest = deployment([
    { address: factoryA, codeHash, autoStartSafe: true },
    { address: factoryB, codeHash, autoStartSafe: true },
  ]);
  const boundary = await resolveBoundary(client, manifest, "0", directory);
  assert.equal(boundary.startBlock, "9");
  assert.equal(boundary.blockHash, hash(10n));
  assert.equal(boundary.source, "factory-history");
  assert.ok(calls.some((c) => c.address === factoryA && c.blockNumber === 36n));
  assert.ok(calls.some((c) => c.address === factoryB && c.blockNumber === 8n));
  assert.ok(calls.length < 30, "discovery uses logarithmic historical reads");
});

test("manual boundary is explicit and does not require automatic safety proof", async (t) => {
  const directory = temporary(t);
  const { client, calls } = fakeClient();
  const manifest = deployment([{ address: factoryA, codeHash }]);
  const boundary = await resolveBoundary(client, manifest, "50", directory);
  assert.equal(boundary.startBlock, "50");
  assert.equal(boundary.source, "manual");
  assert.deepEqual(calls.map((x) => x.blockNumber), [100n]);
  await assert.rejects(resolveBoundary(client, manifest, "101", directory), /已.*区块/);
});

test("automatic discovery requires reviewed immutable factory evidence", async (t) => {
  const directory = temporary(t);
  await assert.rejects(
    resolveBoundary(fakeClient().client, deployment([{ address: factoryA, codeHash }]), "0", directory),
    /等待核实工厂/,
  );
  assert.deepEqual(readdirSync(directory), []);
});

test("wrong network and mismatched current code fail before caching", async (t) => {
  const directory = temporary(t);
  const wrongChain = fakeClient();
  wrongChain.rpc.getChainId = async () => 11155111;
  await assert.rejects(resolveBoundary(wrongChain.client, deployment(), "0", directory), /主网/);
  const wrongCode = fakeClient();
  wrongCode.rpc.getCode = async () => "0x6000";
  await assert.rejects(resolveBoundary(wrongCode.client, deployment(), "0", directory), /当前字节码/);
  assert.deepEqual(readdirSync(directory), []);
});

test("missing historical RPC state fails closed, never acts as empty code", async (t) => {
  const directory = temporary(t);
  const fake = fakeClient();
  const original = fake.rpc.getCode;
  fake.rpc.getCode = async (args) => {
    if (args.blockNumber < 90n) throw Error("historical state unavailable");
    return original(args);
  };
  await assert.rejects(resolveBoundary(fake.client, deployment(), "0", directory), /historical state/);
  assert.deepEqual(readdirSync(directory), []);
});

test("deployment hints verify code at the block and absence before it", async (t) => {
  const directory = temporary(t);
  const fake = fakeClient();
  const manifest = deployment([{ address: factoryA, codeHash, autoStartSafe: true, deploymentBlock: "37" }]);
  const boundary = await resolveBoundary(fake.client, manifest, "0", directory);
  assert.equal(boundary.source, "deployment-hint");
  assert.equal(boundary.startBlock, "37");
  assert.deepEqual(fake.calls.map((x) => x.blockNumber), [100n, 0n, 37n, 36n]);
  for (const deploymentBlock of ["36", "38", "101", "0"]) {
    await assert.rejects(async () => resolveBoundary(fake.client, deployment([{ address: factoryA, codeHash, autoStartSafe: true, deploymentBlock }]), "0", directory));
  }
});

test("genesis code and changed historical code cannot produce automatic boundaries", async (t) => {
  const directory = temporary(t);
  await assert.rejects(resolveBoundary(fakeClient({ [factoryA]: 0n }).client, deployment(), "0", directory), /创世/);
  const changed = fakeClient();
  const original = changed.rpc.getCode;
  changed.rpc.getCode = async (args) => args.blockNumber === 50n ? "0x6000" : original(args);
  await assert.rejects(resolveBoundary(changed.client, deployment(), "0", directory), /历史字节码改变/);
});

test("cached boundaries keep the original block and avoid binary search on restart", async (t) => {
  const directory = temporary(t);
  const fake = fakeClient();
  const boundary = await resolveBoundary(fake.client, deployment(), "0", directory);
  fake.calls.length = 0;
  assert.deepEqual(await resolveBoundary(fake.client, deployment(), "0", directory), boundary);
  assert.deepEqual(fake.calls.map((x) => x.blockNumber), [100n]);
});

test("cached boundary reorg never resets its block to a fresh head", async (t) => {
  const directory = temporary(t);
  const fake = fakeClient();
  const original = await resolveBoundary(fake.client, deployment(), "0", directory);
  fake.hashes.set(37n, hash(999n));
  await assert.rejects(resolveBoundary(fake.client, deployment(), "0", directory), /发生重组/);
  fake.hashes.delete(37n);
  assert.deepEqual(await resolveBoundary(fake.client, deployment(), "0", directory), original);
});

test("reorg during discovery leaves no boundary cache", async (t) => {
  const directory = temporary(t);
  const fake = fakeClient();
  const original = fake.rpc.getBlock;
  fake.rpc.getBlock = async (args) => {
    if (args?.blockNumber === 100n) return { number: 100n, hash: hash(999n) };
    return original(args);
  };
  await assert.rejects(resolveBoundary(fake.client, deployment(), "0", directory), /链发生重组/);
  assert.deepEqual(readdirSync(directory), []);
});

test("different registry, factory evidence, and manual boundary create separate identities", async (t) => {
  const directory = temporary(t);
  const { client } = fakeClient();
  const original = await resolveBoundary(client, deployment(), "0", directory);
  const registry = deployment();
  registry.registries[0]!.address = address("7");
  const registryBoundary = await resolveBoundary(client, registry, "0", directory);
  const hint = await resolveBoundary(client, deployment([{ address: factoryA, codeHash, autoStartSafe: true, deploymentBlock: "37" }]), "0", directory);
  const manual = await resolveBoundary(client, deployment(), "37", directory);
  assert.equal(new Set([original, registryBoundary, hint, manual].map((x) => x.fingerprint)).size, 4);
});

test("corrupt cached boundary fails instead of silently recomputing", async (t) => {
  const directory = temporary(t);
  const { client } = fakeClient();
  await resolveBoundary(client, deployment(), "0", directory);
  const filename = readdirSync(directory).find((f) => f.startsWith("boundary-"))!;
  writeFileSync(join(directory, filename), "{broken");
  await assert.rejects(resolveBoundary(client, deployment(), "0", directory), /记录损坏/);
});

test("cursor survives restart, separately for live, dry-run, and filter strategy", async (t) => {
  const directory = temporary(t);
  const boundary = await resolveBoundary(fakeClient().client, deployment(), "0", directory);
  const store = new CursorStore(boundary, "taxes-0", "live", directory);
  assert.deepEqual(store.load(), { nextBlock: "37" });
  const cursor = { nextBlock: "81", lastScanned: { number: "80", hash: hash(81n) } };
  store.save(cursor);
  assert.deepEqual(new CursorStore(boundary, "taxes-0", "live", directory).load(), cursor);
  assert.deepEqual(new CursorStore(boundary, "taxes-0", "dry-run", directory).load(), { nextBlock: "37" });
  assert.deepEqual(new CursorStore(boundary, "taxes-100", "live", directory).load(), { nextBlock: "37" });
});

test("cursor rejects malformed or discontinuous progress and never jumps history", async (t) => {
  const directory = temporary(t);
  const boundary = await resolveBoundary(fakeClient().client, deployment(), "0", directory);
  const store = new CursorStore(boundary, "filters", "live", directory);
  assert.throws(() => store.save({ nextBlock: "36" }), /不得早于/);
  assert.throws(() => store.save({ nextBlock: "50" }), /缺少已扫描/);
  assert.throws(() => store.save({ nextBlock: "50", lastScanned: { number: "48", hash: hash(49n) } }), /不连续/);
  store.save({ nextBlock: "50", lastScanned: { number: "49", hash: hash(50n) } });
  const filename = readdirSync(directory).find((f) => f.startsWith("cursor-"))!;
  writeFileSync(join(directory, filename), JSON.stringify({ nextBlock: "36" }));
  assert.throws(() => store.load(), /不得早于/);
});
