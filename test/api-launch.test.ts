import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import {
  encodeAbiParameters, encodeEventTopics, parseAbi, parseAbiParameters,
  stringToHex, zeroAddress, type Address, type Hex, type PublicClient,
} from "viem";
import { ApiLaunchError, resolveApiLaunch, trustedUniswap } from "../src/api-launch.js";
import { projectAbi, registryAbi } from "../src/discovery.js";
import { poolAbi, poolId } from "../src/v4.js";

const id = "00000000-0000-4000-8000-000000000001";
const address = (n: string) => `0x${n.repeat(40)}` as Address;
const token = address("1"), hook = address("2"), factory = address("3"), registry = address("4"), deployer = address("5");
const txHash = `0x${"a".repeat(64)}` as Hex;
const blockHash = `0x${"b".repeat(64)}` as Hex;
const attestationHash = "c".repeat(64);
const sourceCommit = "d".repeat(40);
const hookAbi = parseAbi(["event Launched(uint64 indexed launchNumber,address indexed token,address indexed hook,address distributor,uint128 liquidity)"]);
const protocol = trustedUniswap();

function fixture(withHook = false) {
  const pool = { currency0: zeroAddress, currency1: token, fee: 3000, tickSpacing: 60, hooks: withHook ? hook : zeroAddress };
  const kind = withHook ? "univ4_hook" : "evm_project";
  const manifest = { kind, token: { contract: "Token" }, pool: { pairedCurrency: zeroAddress, fee: 3000, tickSpacing: 60 } };
  const artifact = (role: string, name: string, address: Address) => ({ role, name, address, txHash, blockNumber: 100 });
  const detail = {
    id, launchNumber: 42, chainId: 1, status: "live", kind,
    sourceRepoUrl: "https://github.com/identity-md-launches/fixture", sourceCommit, attestationHash,
    artifacts: [artifact("token", "Token", token), ...(withHook ? [artifact("hook", "Hook", hook)] : [])],
    attestation: { manifest },
  };
  const deploymentRead = {
    launchId: id, chainId: 1, sourceCommit, attestationHash, manifest,
    contracts: detail.artifacts.map((a) => ({ ...a })),
  };
  const networkRead = { network: { chainId: 1, uniswapV4: {
    poolManager: protocol.poolManager.address, universalRouter: protocol.router.address,
    quoter: protocol.quoter.address, stateView: protocol.stateView.address,
  } } };
  const log = (address: Address, topics: readonly Hex[], data: Hex, index: number) => ({
    address, topics, data, logIndex: index, transactionIndex: 3,
    transactionHash: txHash, blockHash, blockNumber: 100n, removed: false,
  });
  const initialize = log(protocol.poolManager.address, encodeEventTopics({
    abi: poolAbi, eventName: "Initialize", args: { id: poolId(pool), currency0: zeroAddress, currency1: token },
  }) as Hex[], encodeAbiParameters(parseAbiParameters("uint24,int24,address,uint160,int24"), [3000, 60, pool.hooks, 2n ** 96n, 0]), 1);
  const record = log(registry, encodeEventTopics({
    abi: registryAbi, eventName: "LaunchRecorded", args: { launchNumber: 42n, kind: stringToHex(kind, { size: 32 }) },
  }) as Hex[], encodeAbiParameters(parseAbiParameters("bytes32,bytes32,address[],uint256[]"), [
    `0x${sourceCommit.padEnd(64, "0")}`, `0x${attestationHash}`, [token, ...(withHook ? [hook] : [])], [],
  ]), 2);
  const launched = withHook
    ? log(factory, encodeEventTopics({ abi: hookAbi, eventName: "Launched", args: { launchNumber: 42n, token, hook } }) as Hex[], encodeAbiParameters(parseAbiParameters("address,uint128"), [address("6"), 100n]), 3)
    : log(factory, encodeEventTopics({ abi: projectAbi, eventName: "ProjectLaunched", args: { launchNumber: 42n, token } }) as Hex[], encodeAbiParameters(parseAbiParameters("address,address[]"), [address("6"), []]), 3);
  const transaction = { hash: txHash, to: factory, from: deployer, chainId: 1, blockNumber: 100n, blockHash, transactionIndex: 3 };
  const receipt = { transactionHash: txHash, to: factory, from: deployer, status: "success", blockNumber: 100n, blockHash, transactionIndex: 3, logs: [initialize, record, launched] };
  const protocolCode = JSON.parse(gunzipSync(Buffer.from(PROTOCOL_CODE_GZIP, "base64")).toString()) as Record<string, Hex>;
  const rpc = {
    getChainId: async () => 1,
    getTransaction: async () => transaction,
    getTransactionReceipt: async () => receipt,
    getBlock: async () => ({ number: 100n, hash: blockHash }),
    getCode: async ({ address }: { address: Address }) => protocolCode[address.toLowerCase()] ?? "0x6000" as Hex,
  };
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    urls.push(String(url));
    const body = String(url).includes("/reads/")
      ? { files: [
        { path: ".imd/reads/deployment.json", content: JSON.stringify(deploymentRead) },
        { path: ".imd/reads/network.json", content: JSON.stringify(networkRead) },
      ] } : detail;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { detail, deploymentRead, networkRead, transaction, receipt, rpc, client: rpc as unknown as PublicClient, fetchImpl, urls, pool };
}
const errorCode = (code: string, retryable?: boolean) => (e: unknown) =>
  e instanceof ApiLaunchError && e.code === code && (retryable === undefined || e.retryable === retryable);

test("official API project yields exact chain-backed candidate without an IMD manifest", async () => {
  const f = fixture();
  const result = await resolveApiLaunch(id, f.client, { fetchImpl: f.fetchImpl });
  assert.equal(result.candidate.token.toLowerCase(), token);
  assert.equal(result.candidate.launchNumber, 42);
  assert.equal(result.candidate.blockNumber, 100n);
  assert.equal(result.deployment.chainId, 1);
  assert.equal(result.deployment.factories[0]!.address, factory);
  assert.equal(result.deployment.registries[0]!.address, registry);
  assert.deepEqual(result.deployment.taxPolicies, [], "code existence is not a tax proof");
  assert.equal(result.deployment.factories[0]!.autoStartSafe, false);
  assert.deepEqual(f.urls, [`https://api.imd.fun/launches/${id}`, `https://api.imd.fun/reads/launch/${id}`]);
});

test("official API hook launch binds exact hook in artifacts, registry, and pool", async () => {
  const f = fixture(true);
  const result = await resolveApiLaunch(id, f.client, { fetchImpl: f.fetchImpl });
  assert.equal(result.candidate.pool.hooks.toLowerCase(), hook);
  assert.equal(result.candidate.kind, "univ4_hook");
});

test("wrong networks and alternate API identifiers cannot select a different token", async () => {
  const f = fixture();
  f.detail.chainId = 11155111;
  await assert.rejects(resolveApiLaunch(id, f.client, { fetchImpl: f.fetchImpl }), errorCode("wrong_launch", false));
  f.detail.chainId = 1;
  f.detail.id = "00000000-0000-4000-8000-000000000002";
  await assert.rejects(resolveApiLaunch(id, f.client, { fetchImpl: f.fetchImpl }), errorCode("wrong_launch"));
  await assert.rejects(resolveApiLaunch("../../host", f.client, { fetchImpl: f.fetchImpl }), errorCode("invalid_id"));
});

test("not-yet-live or missing deployment API response is retryable", async () => {
  const f = fixture();
  f.detail.status = "admitted";
  await assert.rejects(resolveApiLaunch(id, f.client, { fetchImpl: f.fetchImpl }), errorCode("not_ready", true));
  await assert.rejects(resolveApiLaunch(id, f.client, { fetchImpl: (async () => new Response(null, { status: 404 })) as typeof fetch }), errorCode("api_unavailable", true));
});

test("a live record missing attestation or identity fields is retained for retry", async () => {
  for (const field of ["attestation", "id", "chainId"]) {
    const f = fixture();
    delete (f.detail as Record<string, unknown>)[field];
    await assert.rejects(resolveApiLaunch(id, f.client, { fetchImpl: f.fetchImpl }), errorCode("invalid_detail", true));
  }
});

test("partial official read files remain retryable instead of skipping the first launch", async () => {
  for (const incomplete of ["file-list", "deployment-structure", "network-structure", "network-missing", "network-json"]) {
    const f = fixture();
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const response = await f.fetchImpl(url, init);
      if (!String(url).includes("/reads/")) return response;
      const data = await response.json() as { files: { path: string; content: string }[] };
      if (incomplete === "file-list") return new Response(JSON.stringify({ name: "pending" }));
      if (incomplete === "network-missing") data.files = data.files.filter((file) => !file.path.endsWith("network.json"));
      else {
        const path = incomplete === "deployment-structure" ? "deployment.json" : "network.json";
        data.files.find((file) => file.path.endsWith(path))!.content = incomplete === "network-json" ? "{incomplete" : "{}";
      }
      return new Response(JSON.stringify(data));
    }) as typeof fetch;
    await assert.rejects(resolveApiLaunch(id, f.client, { fetchImpl }), errorCode(incomplete === "network-missing" ? "reads_pending" : "invalid_reads", true));
  }
});

test("arbitrary API router and mismatched deployment chain are rejected", async () => {
  const f = fixture();
  f.networkRead.network.uniswapV4.universalRouter = address("9");
  await assert.rejects(resolveApiLaunch(id, f.client, { fetchImpl: f.fetchImpl }), errorCode("unsupported_protocol", false));
  f.networkRead.network.uniswapV4.universalRouter = protocol.router.address;
  f.deploymentRead.chainId = 11155111;
  await assert.rejects(resolveApiLaunch(id, f.client, { fetchImpl: f.fetchImpl }), errorCode("read_mismatch"));
});

test("tokens must uniquely agree between API detail and deployment files", async () => {
  const f = fixture();
  f.detail.artifacts.push({ ...f.detail.artifacts[0]! });
  await assert.rejects(resolveApiLaunch(id, f.client, { fetchImpl: f.fetchImpl }), errorCode("token_ambiguous"));
  f.detail.artifacts.pop();
  f.deploymentRead.contracts[0]!.address = address("9");
  await assert.rejects(resolveApiLaunch(id, f.client, { fetchImpl: f.fetchImpl }), errorCode("artifact_mismatch"));
});

test("failed, wrong, and noncanonical receipts never become candidates", async () => {
  const f = fixture();
  f.receipt.status = "reverted";
  await assert.rejects(resolveApiLaunch(id, f.client, { fetchImpl: f.fetchImpl }), errorCode("transaction_mismatch"));
  f.receipt.status = "success";
  f.rpc.getBlock = async () => ({ number: 100n, hash: `0x${"e".repeat(64)}` });
  await assert.rejects(resolveApiLaunch(id, f.client, { fetchImpl: f.fetchImpl }), errorCode("reorg", true));
});

test("unrelated pool, missing factory event and altered attestation fail provenance", async () => {
  const f = fixture();
  const originalAddress = f.receipt.logs[0]!.address;
  f.receipt.logs[0]!.address = address("9");
  await assert.rejects(resolveApiLaunch(id, f.client, { fetchImpl: f.fetchImpl }), errorCode("pool_ambiguous"));
  f.receipt.logs[0]!.address = originalAddress;
  const factoryLog = f.receipt.logs.pop()!;
  await assert.rejects(resolveApiLaunch(id, f.client, { fetchImpl: f.fetchImpl }), errorCode("launch_provenance"));
  f.receipt.logs.push(factoryLog);
  f.detail.attestationHash = "e".repeat(64);
  f.deploymentRead.attestationHash = f.detail.attestationHash;
  await assert.rejects(resolveApiLaunch(id, f.client, { fetchImpl: f.fetchImpl }), errorCode("launch_provenance"));
});

test("hook in official artifact must be the exact initialized hook", async () => {
  const f = fixture(true);
  f.detail.artifacts[1]!.address = address("9");
  f.deploymentRead.contracts[1]!.address = address("9");
  await assert.rejects(resolveApiLaunch(id, f.client, { fetchImpl: f.fetchImpl }), errorCode("pool_mismatch"));
});

test("pinned Uniswap code cannot be replaced by a same-address RPC claim", async () => {
  const f = fixture();
  f.rpc.getCode = async () => "0x6000";
  await assert.rejects(resolveApiLaunch(id, f.client, { fetchImpl: f.fetchImpl }), errorCode("protocol_code", false));
});

test("RPC failure messages are sanitized and never expose endpoint keys", async () => {
  const f = fixture();
  f.rpc.getTransaction = async () => { throw Error("https://rpc.invalid/private_key"); };
  await assert.rejects(resolveApiLaunch(id, f.client, { fetchImpl: f.fetchImpl }), (e: unknown) => {
    assert.ok(e instanceof ApiLaunchError);
    assert.equal(e.retryable, true);
    assert.equal(e.message.includes("private_key"), false);
    return true;
  });
});

test("protocol catalog returned to callers cannot change pinned addresses", () => {
  const copied = trustedUniswap();
  copied.router.address = address("9");
  assert.equal(trustedUniswap().router.address, protocol.router.address);
});

test("oversized official API responses fail closed while streaming and remain retryable", async () => {
  const f = fixture();
  let cancelled = false;
  const fetchImpl = (async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(600_000)); },
    cancel() { cancelled = true; },
  }))) as typeof fetch;
  await assert.rejects(resolveApiLaunch(id, f.client, { fetchImpl }), errorCode("api_invalid", true));
  assert.equal(cancelled, true);
});

test("duplicate matching factory events are ambiguous provenance and cannot authorize a token", async () => {
  for (const hook of [false, true]) {
    const f = fixture(hook);
    f.receipt.logs.push({ ...f.receipt.logs.at(-1)!, logIndex: 4 });
    await assert.rejects(resolveApiLaunch(id, f.client, { fetchImpl: f.fetchImpl }), errorCode("launch_provenance"));
  }
});

// Public mainnet runtime bytecode fixture captured from the pinned contracts on
// 2026-09-29. Compressed only to keep this hermetic test fixture compact.
const PROTOCOL_CODE_GZIP = "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";
