import {
  decodeEventLog, hexToString, keccak256, parseAbi, zeroAddress,
  type Address, type Hex, type PublicClient,
} from "viem";
import { z } from "zod";
import type { Deployment } from "./config.js";
import { projectAbi, registryAbi } from "./discovery.js";
import { poolAbi, poolId } from "./v4.js";
import type { Candidate, PoolKey } from "./types.js";
import { readBoundedJson } from "./bounded-json.js";
import { parseApiRetryAfter } from "./api-session.js";
import { reviewedProjectDeployments } from "./protocol-version.js";
export { reviewedProjectDeployments } from "./protocol-version.js";

type SupportedChain = 1 | 11155111;
type Contract = { address: Address; codeHash: Hex };
type Protocol = { poolManager: Contract; router: Contract; quoter: Contract; stateView: Contract };
// Addresses: https://developers.uniswap.org/docs/protocols/v4/deployments
// Legacy five-field v4 router encoding. Mainnet code hashes cross-checked via
// PublicNode and dRPC on 2026-09-29; Sepolia hashes independently replayed in docs/evidence.
export const MAINNET_PROTOCOL: Protocol = {
  poolManager: { address: "0x000000000004444c5dc75cb358380d2e3de08a90", codeHash: "0x785f1014552b7ce7d5fb7d0c970ca60edee94fd00425d7ca21609acac7ce1293" },
  router: { address: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af", codeHash: "0x6a5f46971b50c6e1b7eef97902311444e479d734e4f80ad88367783cf373fe7f" },
  quoter: { address: "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203", codeHash: "0x06de58fa119c5deaa7a667fb92d3894e25d9160e62fb82c8d86d43b47eefe441" },
  stateView: { address: "0x7ffe42c4a5deea5b0fec41c94c136cf115597227", codeHash: "0xd7947778589cf4aac9a092a4451292a2056380941635ab7006d3c691d8dfd878" },
};
export const SEPOLIA_PROTOCOL: Protocol = {
  poolManager: { address: "0xe03a1074c86cfedd5c142c4f04f1a1536e203543", codeHash: "0x09930125a49f5b95caf8052991cc14d1240dca8b43f42b899115b86867e4bce1" },
  router: { address: "0x3a9d48ab9751398bbfa63ad67599bb04e4bdf98b", codeHash: "0x14f7c9253a5406bafa90cb512f4a2db2a10513886603e7a9b4a2e72329e944f4" },
  quoter: { address: "0x61b3f2011a92d183c7dbadbda940a7555ccf9227", codeHash: "0xf481a751ac453d40c46d12360b85b05472028c1b113ab63749d69a5f8b0e47d1" },
  stateView: { address: "0xe1dd9c3fa50edb962e442f60dfbc432e24537e4c", codeHash: "0xaaed3db8eb8ebde8014ce4c8a3938496687f4c6374e17a7d735288f6c65ceb9e" },
};
for (const catalog of [MAINNET_PROTOCOL, SEPOLIA_PROTOCOL]) {
  Object.values(catalog).forEach(Object.freeze);
  Object.freeze(catalog);
}
export function trustedUniswap(chainId: SupportedChain = 1): Protocol {
  if (chainId !== 1 && chainId !== 11155111)
    throw new ApiLaunchError("unsupported_chain", "不支持该交易网络", false);
  // Do not let a caller's policy changes mutate the process-wide trusted catalog.
  return structuredClone(chainId === 1 ? MAINNET_PROTOCOL : SEPOLIA_PROTOCOL);
}

export class ApiLaunchError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean,
    readonly retryAfterMs: number | null = null) {
    super(message);
    this.name = "ApiLaunchError";
  }
}
function fail(code: string, message: string, retryable = false, retryAfterMs: number | null = null): never {
  throw new ApiLaunchError(code, message, retryable, retryAfterMs);
}
const addr = z.string().regex(/^0x[\da-fA-F]{40}$/);
const hash = z.string().regex(/^0x[\da-fA-F]{64}$/);
const bareHash = z.string().regex(/^[\da-fA-F]{64}$/);
const block = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const manifestSchema = z.object({
  kind: z.enum(["evm_project", "custom_token", "univ4_hook"]),
  token: z.object({ contract: z.string().min(1) }).passthrough(),
  pool: z.object({ pairedCurrency: addr, fee: z.number().int().nonnegative(), tickSpacing: z.number().int() }).passthrough(),
}).passthrough();
const artifactSchema = z.object({
  role: z.string(), name: z.string(), address: addr, txHash: hash, blockNumber: block,
}).passthrough();
const detailSchema = z.object({
  id: z.string().uuid(), launchNumber: block, chainId: block, status: z.string(),
  kind: z.enum(["evm_project", "custom_token", "univ4_hook"]),
  sourceRepoUrl: z.string().url(), sourceCommit: z.string().regex(/^[\da-fA-F]{40}$/),
  attestationHash: bareHash,
  policyVersion: z.number().int().positive().optional(),
  poolFee: z.number().int().nonnegative().max(0xffffff).optional(),
  artifacts: z.array(artifactSchema).max(100),
  attestation: z.object({ manifest: manifestSchema }).passthrough(),
}).passthrough();
export type ApiLaunchDetail = z.infer<typeof detailSchema>;
export type ResolvedApiLaunch<C extends SupportedChain = 1> = {
  candidate: Candidate;
  deployment: Omit<Deployment, "chainId"> & { chainId: C };
  detail: ApiLaunchDetail;
  protocolVersion?: string;
};
const verifiedLaunches = new WeakMap<object, { id: string; chainId: SupportedChain }>();

/** Identity-only reuse inside this module instance; this is not a freshness or canonicality proof. */
export function isVerifiedApiLaunch<C extends SupportedChain>(
  value: unknown, id: string, chainId: C,
): value is ResolvedApiLaunch<C> {
  if (!value || typeof value !== "object" || typeof id !== "string") return false;
  const verified = verifiedLaunches.get(value);
  return verified !== undefined && verified.chainId === chainId && verified.id === id.toLowerCase();
}

function verifiedResult<C extends SupportedChain>(result: ResolvedApiLaunch<C>): ResolvedApiLaunch<C> {
  // Freeze iteratively: passthrough API metadata can be deeply nested. No caller
  // can change pool/calldata identities or a nested deployment after verification.
  const pending: object[] = [result];
  const seen = new WeakSet<object>();
  while (pending.length) {
    const value = pending.pop()!;
    if (seen.has(value)) continue;
    seen.add(value);
    for (const child of Object.values(value))
      if (child !== null && typeof child === "object") pending.push(child);
    Object.freeze(value);
  }
  verifiedLaunches.set(result, { id: result.detail.id.toLowerCase(), chainId: result.deployment.chainId });
  return result;
}
const readsSchema = z.object({
  files: z.array(z.object({ path: z.string(), content: z.string() })).max(100),
});
const deploymentReadSchema = z.object({
  launchId: z.string().uuid(), chainId: block, sourceCommit: z.string(), attestationHash: bareHash,
  manifest: manifestSchema,
  contracts: z.array(z.object({ name: z.string(), address: addr, txHash: hash, blockNumber: block })).max(100),
  poolKey: z.object({ currency0: addr, currency1: addr, fee: z.number().int().nonnegative().max(0xffffff),
    tickSpacing: z.number().int(), hooks: addr }).optional(),
});
const networkReadSchema = z.object({ network: z.object({
  chainId: block,
  uniswapV4: z.object({ poolManager: addr, universalRouter: addr, quoter: addr, stateView: addr }),
}) });
const hookAbi = parseAbi([
  "event Launched(uint64 indexed launchNumber,address indexed token,address indexed hook,address distributor,uint128 liquidity)",
]);
const equal = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** HTTPS IMD identifies the launch; exact receipt and pinned Uniswap contracts
 * corroborate it. This function never signs, broadcasts, or infers any tax rate. */
export async function resolveApiLaunch<C extends SupportedChain = 1>(
  id: string,
  client: PublicClient,
  options: { fetchImpl?: typeof fetch; chainId?: C; signal?: AbortSignal } = {},
): Promise<ResolvedApiLaunch<C>> {
  if (!z.string().uuid().safeParse(id).success)
    fail("invalid_id", "官方发射 ID 格式不正确");
  const chainId = (options.chainId ?? 1) as C;
  const protocol = trustedUniswap(chainId);
  const fetchImpl = options.fetchImpl ?? fetch;
  const source = `https://api.imd.fun/launches/${encodeURIComponent(id)}`;
  let observedRetryAfterMs: number | null = null;
  const readJson = async (url: string): Promise<unknown> => {
    let response: Response;
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(8000)])
      : AbortSignal.timeout(8000);
    try {
      response = await fetchImpl(url, {
        signal,
        redirect: "error",
      });
    } catch { return fail("api_unavailable", "官方 API 暂时不可用，等待重试", true); }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const retryAfterMs = response.status === 429 || response.status === 503
        ? Math.max(5000, parseApiRetryAfter(response.headers.get("retry-after")) ?? 5000) : null;
      return fail("api_unavailable", "官方部署资料尚未就绪或 API 暂时不可用",
        response.status === 404 || response.status === 429 || response.status >= 500, retryAfterMs);
    }
    try { return await readBoundedJson(response, 2_000_000, signal); }
    catch { return fail("api_invalid", "官方 API 返回无效 JSON", true); }
  };
  try {
    if (options.signal?.aborted) fail("cancelled", "发射核验已停止", true);
    if (await client.getChainId() !== chainId)
      fail("wrong_chain", "RPC 与目标网络不一致");
    // Both documents have fixed official URLs and are independent network reads.
    // Settle both promises before validation so a rejected sibling cannot escape
    // as an unhandled rejection; all existing identity checks still run below.
    const [detailRead, filesRead] = await Promise.allSettled([
      readJson(source),
      readJson(`https://api.imd.fun/reads/launch/${encodeURIComponent(id)}`),
    ]);
    // Both fixed routes were already contacted: honor the longer cooldown even
    // if their parallel responses contain different Retry-After headers.
    const cooldowns = [detailRead, filesRead].flatMap((read) => read.status === "rejected" &&
      read.reason instanceof ApiLaunchError && read.reason.retryAfterMs !== null ? [read.reason.retryAfterMs] : []);
    observedRetryAfterMs = cooldowns.length ? Math.max(...cooldowns) : null;
    if (detailRead.status === "rejected") throw detailRead.reason;
    const raw = detailRead.value;
    if (typeof raw !== "object" || raw === null) fail("invalid_detail", "官方发射详情格式尚不完整，等待重新读取", true);
    const pre = raw as Record<string, unknown>;
    if (pre.id == null || pre.chainId == null)
      fail("invalid_detail", "官方发射身份或网络字段尚不完整，等待重新读取", true);
    if (pre.id !== id || pre.chainId !== chainId)
      fail("wrong_launch", "官方发射 ID 或网络与目标不一致");
    if (pre.status !== "live" || (Array.isArray(pre.artifacts) && pre.artifacts.length === 0))
      fail("not_ready", "该官方发射尚未完成部署，继续等待", true);
    const parsed = detailSchema.safeParse(raw);
    if (!parsed.success) fail("invalid_detail", "官方发射详情缺少完整可核对的部署证据，等待重新读取", true);
    const detail = parsed.data;
    const tokens = detail.artifacts.filter((a) => a.role === "token");
    if (tokens.length !== 1) fail("token_ambiguous", "官方发射必须恰好包含一个代币产物");
    const token = tokens[0]!;
    const hooks = detail.artifacts.filter((a) => a.role === "hook");
    const guardedProject = detail.kind !== "univ4_hook" && (hooks.length > 0 || (detail.policyVersion ?? 0) >= 5);
    const projectVersion = guardedProject ? reviewedProjectDeployments(chainId).find((version) =>
      version.policyVersions.includes(detail.policyVersion ?? 0) && hooks.length === 1 &&
      hooks[0]!.name === "PoolInitializationGuard" && equal(hooks[0]!.address, version.guard.address)) : undefined;
    if (guardedProject && !projectVersion)
      fail("unsupported_project_version", "项目使用了尚未核验的网络、政策或池初始化守卫版本");
    if ((detail.kind === "univ4_hook" && hooks.length !== 1) || (!guardedProject && detail.kind !== "univ4_hook" && hooks.length !== 0))
      fail("hook_ambiguous", "官方 Hook 产物与发射类型不一致");
    const hook = hooks[0];
    if (hook && (!equal(hook.txHash, token.txHash) || hook.blockNumber !== token.blockNumber))
      fail("hook_transaction", "Hook 与代币不属于同一发射交易");
    if (filesRead.status === "rejected") throw filesRead.reason;
    const readsResult = readsSchema.safeParse(filesRead.value);
    if (!readsResult.success) fail("invalid_reads", "官方部署文件列表尚不完整，等待重新读取", true);
    const file = (path: string): unknown => {
      const matches = readsResult.data.files.filter((f) => f.path === path);
      if (matches.length === 0) fail("reads_pending", "官方部署文件尚未就绪", true);
      if (matches.length !== 1) fail("invalid_reads", "官方部署文件重复，无法确定来源");
      try { return JSON.parse(matches[0]!.content); }
      catch { return fail("invalid_reads", "官方部署文件尚不完整，等待重新读取", true); }
    };
    const dr = deploymentReadSchema.safeParse(file(".imd/reads/deployment.json"));
    const nr = networkReadSchema.safeParse(file(".imd/reads/network.json"));
    if (!dr.success || !nr.success) fail("invalid_reads", "官方部署或网络文件缺少核验字段，等待重新读取", true);
    const deployed = dr.data;
    const network = nr.data.network;
    if (deployed.launchId !== id || deployed.chainId !== chainId || network.chainId !== chainId || !equal(deployed.sourceCommit, detail.sourceCommit) || !equal(deployed.attestationHash, detail.attestationHash))
      fail("read_mismatch", "官方详情与部署文件的网络或来源凭据不一致");
    for (const [role, actual] of Object.entries({
      poolManager: network.uniswapV4.poolManager,
      router: network.uniswapV4.universalRouter,
      quoter: network.uniswapV4.quoter,
      stateView: network.uniswapV4.stateView,
    })) {
      if (!equal(actual, protocol[role as keyof Protocol].address))
        fail("unsupported_protocol", "官方文件使用了尚未支持的 Uniswap 合约版本，暂停该币核验");
    }
    // Protocol guards are supplied by ProjectFactory, not contributor contracts.
    // Their exact address/hash and receipt provenance are checked separately below.
    const contributorArtifacts = [token, ...(hook && !projectVersion ? [hook] : []),
      ...(projectVersion ? detail.artifacts.filter((artifact) => artifact.role === "other") : [])];
    if (projectVersion && deployed.contracts.length !== contributorArtifacts.length)
      fail("artifact_mismatch", "项目部署文件必须完整对应代币和应用合约，协议守卫须独立核验");
    for (const artifact of contributorArtifacts) {
      const matches = deployed.contracts.filter((c) => equal(c.address, artifact.address));
      if (matches.length !== 1 || !equal(matches[0]!.txHash, artifact.txHash) || matches[0]!.blockNumber !== artifact.blockNumber ||
          (projectVersion && matches[0]!.name !== artifact.name))
        fail("artifact_mismatch", "官方详情与部署文件的代币或 Hook 不一致");
    }
    const manifest = detail.attestation.manifest;
    if (manifest.kind !== detail.kind || deployed.manifest.kind !== detail.kind || manifest.token.contract !== deployed.manifest.token.contract)
      fail("manifest_mismatch", "官方发射类型或代币合约名不一致");
    if (!deployed.contracts.some((c) => equal(c.address, token.address) && c.name === manifest.token.contract))
      fail("manifest_token", "官方代币产物与部署合约名不一致");
    const [tx, receipt] = await Promise.all([
      client.getTransaction({ hash: token.txHash as Hex }),
      client.getTransactionReceipt({ hash: token.txHash as Hex }),
    ]);
    if (!tx.to || tx.chainId !== chainId || !equal(tx.hash, token.txHash) || !equal(receipt.transactionHash, token.txHash) || receipt.status !== "success" || receipt.blockNumber !== BigInt(token.blockNumber) || tx.blockNumber !== receipt.blockNumber || tx.blockHash !== receipt.blockHash || tx.transactionIndex !== receipt.transactionIndex || !equal(tx.from, receipt.from) || !equal(receipt.to ?? "", tx.to))
      fail("transaction_mismatch", "官方发射交易与链上成功回执不一致");
    if (projectVersion && !equal(tx.to, projectVersion.factory.address))
      fail("project_identity", "项目工厂地址不属于已核验版本");
    if (!projectVersion && detail.kind !== "univ4_hook" && reviewedProjectDeployments(chainId).some((version) => equal(tx.to!, version.factory.address)))
      fail("unsupported_project_version", "已核验的新项目工厂缺少对应政策或初始化守卫凭据");
    const launchBlock = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (launchBlock.hash !== receipt.blockHash)
      fail("reorg", "发射区块已变化，等待重新核对", true);
    const logs = receipt.logs.filter((l) => !l.removed && l.transactionHash === receipt.transactionHash && l.blockHash === receipt.blockHash && l.blockNumber === receipt.blockNumber && l.transactionIndex === receipt.transactionIndex && Number.isSafeInteger(l.logIndex) && l.logIndex >= 0);
    const pools: { pool: PoolKey; id: Hex; logIndex: number }[] = [];
    for (const log of logs) {
      if (!equal(log.address, protocol.poolManager.address)) continue;
      try {
        const decoded = decodeEventLog({ abi: poolAbi, data: log.data, topics: log.topics, strict: true });
        if (!equal(decoded.args.currency0, zeroAddress) || !equal(decoded.args.currency1, token.address)) continue;
        pools.push({ pool: {
          currency0: decoded.args.currency0, currency1: decoded.args.currency1,
          fee: decoded.args.fee, tickSpacing: decoded.args.tickSpacing, hooks: decoded.args.hooks,
        }, id: decoded.args.id, logIndex: log.logIndex });
      } catch { /* Other PoolManager events do not establish a new pool. */ }
    }
    if (pools.length !== 1) fail("pool_ambiguous", "同一发射回执必须有唯一的官方 ETH 代币新池");
    const chosen = pools[0]!;
    if (poolId(chosen.pool) !== chosen.id || !equal(chosen.pool.hooks, hook?.address ?? zeroAddress))
      fail("pool_mismatch", "链上 PoolKey 或 Hook 与官方代币产物不一致");
    for (const pool of [manifest.pool, deployed.manifest.pool]) {
      if (!equal(pool.pairedCurrency, zeroAddress) || pool.fee !== (projectVersion?.admissionFee ?? chosen.pool.fee) || pool.tickSpacing !== chosen.pool.tickSpacing)
        fail("pool_mismatch", "官方池参数与链上初始化事件不一致");
    }
    if (projectVersion) {
      const handoff = deployed.poolKey;
      if (!handoff || detail.poolFee !== projectVersion.tradingFee || chosen.pool.fee !== projectVersion.tradingFee ||
          chosen.pool.tickSpacing !== projectVersion.tickSpacing || poolId(handoff as PoolKey) !== chosen.id)
        fail("pool_mismatch", "已核验版本的交易费或部署 PoolKey 与链上初始化事件不一致");
    } else if (detail.poolFee !== undefined && detail.poolFee !== chosen.pool.fee) {
      fail("pool_mismatch", "官方实际池费用与链上初始化事件不一致");
    }
    const projectArtifacts = projectVersion ? detail.artifacts.map((artifact) => artifact.address.toLowerCase()) : [];
    const distributors = detail.artifacts.filter((artifact) => artifact.role === "distributor");
    if (projectVersion && (new Set(projectArtifacts).size !== projectArtifacts.length || distributors.length !== 1 ||
        distributors[0]!.name !== "MerkleDistributor" || detail.artifacts.some((artifact) =>
          !["token", "hook", "distributor", "other"].includes(artifact.role) || !equal(artifact.txHash, token.txHash) || artifact.blockNumber !== token.blockNumber)))
      fail("artifact_mismatch", "项目产物角色、地址或发射交易不一致");
    const sameAddresses = (actual: readonly string[], expected: readonly string[]) =>
      actual.length === expected.length && new Set(actual.map((address) => address.toLowerCase())).size === actual.length &&
      actual.every((address) => expected.some((other) => equal(address, other)));
    const registries: Address[] = [];
    let factoryEvents = 0;
    for (const log of logs) {
      try {
        const decoded = decodeEventLog({ abi: registryAbi, data: log.data, topics: log.topics, strict: true });
        if (decoded.args.launchNumber === BigInt(detail.launchNumber) && hexToString(decoded.args.kind, { size: 32 }).replace(/\0/g, "") === detail.kind && decoded.args.artifacts.some((a) => equal(a, token.address)) && (!hook || decoded.args.artifacts.some((a) => equal(a, hook.address))) && equal(decoded.args.sourceCommit, `0x${detail.sourceCommit.padEnd(64, "0")}`) && equal(decoded.args.attestationHash, `0x${detail.attestationHash}`) &&
            (!projectVersion || (equal(log.address, projectVersion.registry.address) && sameAddresses(decoded.args.artifacts, projectArtifacts))))
          registries.push(log.address);
      } catch { /* Require the recognized full launch provenance event. */ }
      if (!equal(log.address, tx.to)) continue;
      try {
        if (detail.kind === "univ4_hook") {
          const event = decodeEventLog({ abi: hookAbi, data: log.data, topics: log.topics, strict: true });
          if (event.args.launchNumber === BigInt(detail.launchNumber) && equal(event.args.token, token.address) && equal(event.args.hook, hook!.address)) factoryEvents++;
        } else {
          const event = decodeEventLog({ abi: projectAbi, data: log.data, topics: log.topics, strict: true });
          if (event.args.launchNumber === BigInt(detail.launchNumber) && equal(event.args.token, token.address) &&
              (!projectVersion || (equal(event.args.distributor, distributors[0]!.address) &&
                sameAddresses(event.args.contracts, detail.artifacts.filter((artifact) => artifact.role === "other").map((artifact) => artifact.address))))) factoryEvents++;
        }
      } catch { /* Unrelated factory events do not attest this token. */ }
    }
    if (registries.length !== 1 || factoryEvents !== 1)
      fail("launch_provenance", "链上发射登记与官方编号、源码或代币凭据不一致");
    const atLaunch = async (address: Address): Promise<Contract> => {
      const code = await client.getCode({ address, blockNumber: receipt.blockNumber });
      if (!code || code === "0x") fail("missing_code", "发射合约或代币的链上代码不可验证");
      const codeHash = keccak256(code);
      const expected = projectVersion && [projectVersion.factory, projectVersion.registry, projectVersion.guard]
        .find((contract) => equal(contract.address, address));
      if (expected && expected.codeHash !== codeHash)
        fail("project_code", "项目工厂、登记合约或初始化守卫代码与已核验版本不一致");
      return { address, codeHash };
    };
    const [factory, registry] = await Promise.all([
      atLaunch(tx.to), atLaunch(registries[0]!), atLaunch(token.address as Address),
      ...(hook ? [atLaunch(hook.address as Address)] : []),
      ...Object.values(protocol).map(async (contract) => {
        const actual = await atLaunch(contract.address);
        if (actual.codeHash !== contract.codeHash)
          fail("protocol_code", "Uniswap 链上代码与内置已核验版本不一致");
        return actual;
      }),
    ]);
    if ((await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash)
      fail("reorg", "核验时发射区块发生重组，请重试", true);
    if (options.signal?.aborted) fail("cancelled", "发射核验已停止", true);
    return verifiedResult({
      detail,
      ...(projectVersion ? { protocolVersion: projectVersion.version } : {}),
      candidate: {
        id: `${chainId}:${detail.launchNumber}:${token.address.toLowerCase()}`,
        token: token.address as Address, poolId: chosen.id, pool: chosen.pool,
        launchNumber: detail.launchNumber, kind: detail.kind,
        launchTxHash: token.txHash as Hex, blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash, transactionIndex: receipt.transactionIndex, logIndex: chosen.logIndex,
      },
      deployment: {
        chainId, verified: true, verifiedSource: source, ...protocol,
        factories: [{ ...factory, autoStartSafe: false }], registries: [registry],
        deployers: [tx.from], taxPolicies: [], relayUrl: "https://relay.flashbots.net",
      },
    });
  } catch (error) {
    if (error instanceof ApiLaunchError) {
      if (observedRetryAfterMs !== null)
        throw new ApiLaunchError(error.code, error.message, error.retryable, observedRetryAfterMs);
      throw error;
    }
    return fail("rpc_unavailable", "链上核验暂时不可用，等待重试", true);
  }
}
