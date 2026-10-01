import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import {
  decodeEventLog, encodeAbiParameters, parseAbiParameters, zeroAddress,
  type Address, type Hex, type PublicClient, type TransactionReceipt,
} from "viem";
import {
  ApiLaunchError, isVerifiedApiLaunch, resolveApiLaunch, reviewedProjectDeployments, type ApiLaunchDetail,
} from "../src/api-launch.js";
import { projectAbi, registryAbi } from "../src/discovery.js";
import type { PoolKey } from "../src/types.js";

type DeploymentRead = {
  manifest: ApiLaunchDetail["attestation"]["manifest"];
  contracts: { address: Address; name: string; txHash: Hex; blockNumber: number }[];
  poolKey?: PoolKey;
};
type Sample = {
  detail: ApiLaunchDetail;
  reads: { files: { path: string; content: string }[] };
  transaction: { to: Address; chainId: number };
  receipt: TransactionReceipt;
  block: { number: string; hash: Hex };
};
const saved = JSON.parse(readFileSync(new URL("./fixtures/project-guard-v1.json", import.meta.url), "utf8")) as {
  samples: Sample[]; codeGzip: string;
};
const code = JSON.parse(gunzipSync(Buffer.from(saved.codeGzip, "base64")).toString()) as Record<string, Hex>;
const reviewed = reviewedProjectDeployments(11155111)[0]!;
const wrongAddress = "0x1111111111111111111111111111111111111111" as Address;

function fixture(index = 0) {
  const sample = JSON.parse(JSON.stringify(saved.samples[index]), (key, value) =>
    key === "blockNumber" ? BigInt(value) : value) as Sample;
  // Only RPC block fields are bigint; API artifact block numbers remain JSON numbers.
  for (const artifact of sample.detail.artifacts) artifact.blockNumber = Number(artifact.blockNumber);
  const deploymentFile = sample.reads.files.find((file) => file.path.endsWith("deployment.json"))!;
  const deployment = JSON.parse(deploymentFile.content) as DeploymentRead;
  const rpc = {
    getChainId: async () => 11155111,
    getTransaction: async () => sample.transaction,
    getTransactionReceipt: async () => sample.receipt,
    getBlock: async () => ({ number: BigInt(sample.block.number), hash: sample.block.hash }),
    getCode: async ({ address }: { address: Address }) => code[address.toLowerCase()] ?? "0x6000" as Hex,
  };
  const fetchImpl = (async (url: string | URL | Request) => {
    deploymentFile.content = JSON.stringify(deployment);
    return new Response(JSON.stringify(String(url).includes("/reads/") ? sample.reads : sample.detail));
  }) as typeof fetch;
  return { ...sample, deployment, rpc, client: rpc as unknown as PublicClient, fetchImpl };
}
function resolve(f: ReturnType<typeof fixture>) {
  return resolveApiLaunch(f.detail.id, f.client, { fetchImpl: f.fetchImpl, chainId: 11155111 });
}
const errorCode = (code: string) => (error: unknown) => error instanceof ApiLaunchError && error.code === code && !error.retryable;

test("reviewed policy 5 projects and policy 6 custom token use exact on-chain guard and trading fee", async () => {
  for (let index = 0; index < saved.samples.length; index++) {
    const f = fixture(index);
    const result = await resolve(f);
    assert.equal(result.protocolVersion, reviewed.version);
    assert.equal(result.candidate.pool.fee, 12500);
    assert.equal(result.detail.attestation.manifest.pool.fee, 3000);
    assert.equal(result.candidate.pool.hooks.toLowerCase(), reviewed.guard.address);
    assert.equal(result.deployment.factories[0]!.codeHash, reviewed.factory.codeHash);
    assert.equal(result.deployment.registries[0]!.codeHash, reviewed.registry.codeHash);
    assert.equal(isVerifiedApiLaunch(result, f.detail.id, 11155111), true);
    assert.deepEqual(result.deployment.taxPolicies, [], "pool fees and plain guard bytecode do not prove token transfer tax");
    assert.equal(result.deployment.factories[0]!.autoStartSafe, false);
  }
});

test("Sepolia reviewed identities do not silently authorize mainnet or another chain", async () => {
  assert.deepEqual(reviewedProjectDeployments(1), []);
  assert.deepEqual(reviewedProjectDeployments(31337), []);
  const f = fixture();
  f.detail.chainId = 1;
  f.rpc.getChainId = async () => 1;
  await assert.rejects(resolveApiLaunch(f.detail.id, f.client, { fetchImpl: f.fetchImpl, chainId: 1 }), errorCode("unsupported_project_version"));
  assert.throws(() => { (reviewed.factory as { address: Address }).address = wrongAddress; }, TypeError);
  assert.throws(() => { (reviewed.policyVersions as number[]).push(7); }, TypeError);
});

test("guard semantics require one exact recognized guard, an explicit reviewed policy and a project kind", async () => {
  for (const mutation of ["future-policy", "absent-policy", "name", "address", "duplicate", "missing"] as const) {
    const f = fixture();
    const guard = f.detail.artifacts.find((artifact) => artifact.role === "hook")!;
    if (mutation === "future-policy") f.detail.policyVersion = 7;
    if (mutation === "absent-policy") delete f.detail.policyVersion;
    if (mutation === "name") guard.name = "ContributorHook";
    if (mutation === "address") guard.address = wrongAddress;
    if (mutation === "duplicate") f.detail.artifacts.push({ ...guard });
    if (mutation === "missing") f.detail.artifacts = f.detail.artifacts.filter((artifact) => artifact !== guard);
    await assert.rejects(resolve(f), errorCode("unsupported_project_version"), mutation);
  }
});

test("new factory cannot fall back to legacy semantics when guard and version are removed", async () => {
  const f = fixture();
  delete f.detail.policyVersion;
  f.detail.artifacts = f.detail.artifacts.filter((artifact) => artifact.role !== "hook");
  await assert.rejects(resolve(f), errorCode("unsupported_project_version"));
});

test("project guard address, factory address and registry address have independently pinned identities", async () => {
  const f = fixture();
  f.transaction.to = wrongAddress;
  f.receipt.to = wrongAddress;
  f.receipt.logs.find((log) => log.address.toLowerCase() === reviewed.factory.address)!.address = wrongAddress;
  await assert.rejects(resolve(f), errorCode("project_identity"));
  const other = fixture();
  other.receipt.logs.find((log) => log.address.toLowerCase() === reviewed.registry.address)!.address = wrongAddress;
  await assert.rejects(resolve(other), errorCode("launch_provenance"));
  for (const identity of [reviewed.factory, reviewed.registry, reviewed.guard]) {
    const replaced = fixture();
    const original = replaced.rpc.getCode;
    replaced.rpc.getCode = async (args) => args.address.toLowerCase() === identity.address ? "0x6000" : original(args);
    await assert.rejects(resolve(replaced), errorCode("project_code"), identity.address);
  }
});

test("admission fee exception requires exact API trading fee and every deployment PoolKey field", async () => {
  for (const mutation of ["api-fee", "api-fee-missing", "handoff-missing", "currency0", "currency1", "fee", "tickSpacing", "hooks", "manifest-fee"] as const) {
    const f = fixture();
    if (mutation === "api-fee") f.detail.poolFee = 3000;
    else if (mutation === "api-fee-missing") delete f.detail.poolFee;
    else if (mutation === "handoff-missing") delete f.deployment.poolKey;
    else if (mutation === "manifest-fee") {
      f.detail.attestation.manifest.pool.fee = 12500;
      f.deployment.manifest.pool.fee = 12500;
    } else if (mutation === "fee") f.deployment.poolKey!.fee = 3000;
    else if (mutation === "tickSpacing") f.deployment.poolKey!.tickSpacing = 10;
    else f.deployment.poolKey![mutation] = mutation === "hooks" ? zeroAddress : wrongAddress;
    await assert.rejects(resolve(f), errorCode("pool_mismatch"), mutation);
  }
});

test("guarded project registry must attest the full exact artifact set", async () => {
  for (const mutation of ["missing-guard", "extra", "duplicate", "attestation"] as const) {
    const f = fixture();
    const log = f.receipt.logs.find((log) => log.address.toLowerCase() === reviewed.registry.address)!;
    const event = decodeEventLog({ abi: registryAbi, data: log.data, topics: log.topics, strict: true }).args;
    const artifacts = [...event.artifacts];
    if (mutation === "missing-guard") artifacts.splice(artifacts.findIndex((address) => address.toLowerCase() === reviewed.guard.address), 1);
    if (mutation === "extra") artifacts.push(wrongAddress);
    if (mutation === "duplicate") artifacts.push(artifacts[0]!);
    log.data = encodeAbiParameters(parseAbiParameters("bytes32,bytes32,address[],uint256[]"), [
      event.sourceCommit, mutation === "attestation" ? `0x${"0".repeat(64)}` : event.attestationHash, artifacts, event.lpTokenIds,
    ]);
    await assert.rejects(resolve(f), errorCode("launch_provenance"), mutation);
  }
});

test("guarded project handoff cannot add, omit or relabel contributor contracts", async () => {
  for (const mutation of ["extra", "missing", "renamed", "guard-as-contributor", "other-transaction"] as const) {
    const f = fixture();
    if (mutation === "extra") f.deployment.contracts.push({ ...f.deployment.contracts[0]!, address: wrongAddress });
    if (mutation === "missing") f.deployment.contracts.pop();
    if (mutation === "renamed") f.deployment.contracts[0]!.name = "UnrelatedContract";
    if (mutation === "guard-as-contributor") f.deployment.contracts.push({ ...f.detail.artifacts.find((artifact) => artifact.role === "hook")!, address: reviewed.guard.address, txHash: f.receipt.transactionHash });
    if (mutation === "other-transaction") f.detail.artifacts.find((artifact) => artifact.role === "other")!.txHash = `0x${"0".repeat(64)}`;
    await assert.rejects(resolve(f), errorCode("artifact_mismatch"), mutation);
  }
});

test("ProjectLaunched, not hook Launched, must bind the exact distributor and application contracts", async () => {
  for (const mutation of ["distributor", "contracts", "missing", "duplicate"] as const) {
    const f = fixture();
    const log = f.receipt.logs.find((log) => log.address.toLowerCase() === reviewed.factory.address)!;
    const event = decodeEventLog({ abi: projectAbi, data: log.data, topics: log.topics, strict: true }).args;
    if (mutation === "missing") f.receipt.logs = f.receipt.logs.filter((candidate) => candidate !== log);
    else if (mutation === "duplicate") f.receipt.logs.push({ ...log, logIndex: log.logIndex + 1 });
    else log.data = encodeAbiParameters(parseAbiParameters("address,address[]"), [
      mutation === "distributor" ? wrongAddress : event.distributor,
      mutation === "contracts" ? [wrongAddress] : event.contracts,
    ]);
    await assert.rejects(resolve(f), errorCode("launch_provenance"), mutation);
  }
});
