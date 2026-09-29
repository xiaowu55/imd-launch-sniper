import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { keccak256, type Address, type Hex, type PublicClient } from "viem";
import type { Deployment } from "./config.js";

export type Boundary = {
  startBlock: string;
  blockHash: Hex;
  source: "factory-history" | "deployment-hint" | "manual";
  fingerprint: string;
};
export type MonitorCursor = {
  nextBlock: string;
  lastScanned?: { number: string; hash: Hex };
};

type ReviewedFactory = Deployment["factories"][number] & {
  autoStartSafe?: boolean;
  deploymentBlock?: string;
};
const decimal = /^\d+$/;
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const fingerprintPattern = /^[0-9a-f]{64}$/;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function blockNumber(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !decimal.test(value))
    throw Error(`${label} 格式不正确`);
  return BigInt(value);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validHash(value: unknown): value is Hex {
  return typeof value === "string" && hashPattern.test(value);
}
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw Error("监控记录损坏或无法读取，请先核对记录，不能自动重新设定起点");
  }
}
function durableWrite(directory: string, filename: string, value: unknown) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${filename}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, join(directory, filename));
    const directoryFd = openSync(directory, "r");
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
function parseBoundary(value: unknown, fingerprint?: string): Boundary {
  if (
    !object(value) ||
    !validHash(value.blockHash) ||
    !["factory-history", "deployment-hint", "manual"].includes(
      value.source as string,
    ) ||
    typeof value.fingerprint !== "string" ||
    !fingerprintPattern.test(value.fingerprint) ||
    (fingerprint !== undefined && value.fingerprint !== fingerprint) ||
    blockNumber(value.startBlock, "监控起点") === 0n
  )
    throw Error("监控起点记录不正确，禁止自动覆盖");
  return {
    startBlock: String(value.startBlock),
    blockHash: value.blockHash,
    source: value.source as Boundary["source"],
    fingerprint: value.fingerprint,
  };
}

/** Resolve only the reviewed factory scope. This does not prove the factory list
 * covers every historical IMD deployment or identify an official public opening. */
export async function resolveBoundary(
  client: PublicClient,
  deployment: Deployment,
  configuredStart: string,
  directory = "runtime/monitor",
): Promise<Boundary> {
  const manual = blockNumber(configuredStart, "监控起点");
  if (deployment.chainId !== 1 || (await client.getChainId()) !== 1)
    throw Error("自动监控起点只支持 Ethereum 主网");
  const factories = (deployment.factories as ReviewedFactory[])
    .map((factory) => ({
      address: factory.address.toLowerCase() as Address,
      codeHash: factory.codeHash.toLowerCase() as Hex,
      autoStartSafe: factory.autoStartSafe === true,
      deploymentBlock: factory.deploymentBlock ?? null,
    }))
    .sort((a, b) => a.address.localeCompare(b.address));
  if (factories.length === 0) throw Error("缺少已核实官方工厂");
  if (!manual && factories.some((factory) => !factory.autoStartSafe))
    throw Error("等待核实工厂无代理升级及销毁重部署风险，暂不能自动推断起点");
  const fingerprint = digest({
    version: 1,
    chainId: deployment.chainId,
    factories,
    registries: deployment.registries
      .map((registry) => ({
        address: registry.address.toLowerCase(),
        codeHash: registry.codeHash.toLowerCase(),
      }))
      .sort((a, b) => a.address.localeCompare(b.address)),
    configuredStart: manual.toString(),
  });
  const filename = `boundary-${fingerprint}.json`;
  const path = join(directory, filename);
  const head = await client.getBlock();
  if (head.number === null || !validHash(head.hash))
    throw Error("无法取得已落块的主网区块");
  for (const factory of factories) {
    const code = await client.getCode({
      address: factory.address,
      blockNumber: head.number,
    });
    if (!code || code === "0x" || keccak256(code) !== factory.codeHash)
      throw Error("官方工厂当前字节码与已核实指纹不一致");
  }
  if (existsSync(path)) {
    const cached = parseBoundary(readJson(path), fingerprint);
    const anchor = await client.getBlock({
      blockNumber: BigInt(cached.startBlock),
    });
    if (anchor.hash?.toLowerCase() !== cached.blockHash.toLowerCase())
      throw Error("监控起点区块发生重组，必须重新核对，不能自动移动起点");
    return cached;
  }
  let start = manual;
  let source: Boundary["source"] = "manual";
  if (!manual) {
    const found: bigint[] = [];
    for (const factory of factories) {
      // An archive error is deliberately propagated. Empty code is meaningful
      // only when the RPC successfully returned it for the requested block.
      const codeAt = async (number: bigint) => {
        const code = await client.getCode({
          address: factory.address,
          blockNumber: number,
        });
        if (!code || code === "0x") return false;
        if (keccak256(code) !== factory.codeHash)
          throw Error("工厂历史字节码改变，不能自动推断首次部署起点");
        return true;
      };
      if (await codeAt(0n))
        throw Error("工厂在创世区块已有代码，无法确定首次部署边界");
      let deployed: bigint;
      if (factory.deploymentBlock !== null) {
        deployed = blockNumber(factory.deploymentBlock, "工厂部署区块");
        if (deployed <= 0n || deployed > head.number)
          throw Error("工厂部署区块不在已落块范围内");
      } else {
        let low = 1n;
        let high = head.number;
        while (low < high) {
          const middle = (low + high) / 2n;
          if (await codeAt(middle)) high = middle;
          else low = middle + 1n;
        }
        deployed = low;
      }
      if (!(await codeAt(deployed)) || (await codeAt(deployed - 1n)))
        throw Error("工厂部署区块证据不完整：需部署块有匹配代码、前一块无代码");
      found.push(deployed);
    }
    start = found.reduce((a, b) => (a < b ? a : b));
    source = factories.every((factory) => factory.deploymentBlock !== null)
      ? "deployment-hint"
      : "factory-history";
  }
  if (start <= 0n || start > head.number)
    throw Error("监控起点必须是已经存在的正整数区块");
  const anchor = await client.getBlock({ blockNumber: start });
  if (!validHash(anchor.hash)) throw Error("监控起点区块哈希不可验证");
  if (
    (await client.getBlock({ blockNumber: head.number })).hash !== head.hash
  )
    throw Error("确定监控起点时链发生重组，请重试");
  const boundary: Boundary = {
    startBlock: start.toString(),
    blockHash: anchor.hash,
    source,
    fingerprint,
  };
  durableWrite(directory, filename, boundary);
  return boundary;
}

export class CursorStore {
  private readonly filename: string;
  private readonly boundary: Boundary;
  constructor(
    boundary: Boundary,
    strategyFingerprint: string,
    mode: "live" | "dry-run",
    private readonly directory = "runtime/monitor",
  ) {
    this.boundary = parseBoundary(boundary);
    if (!strategyFingerprint || !["live", "dry-run"].includes(mode))
      throw Error("扫描策略或运行模式不正确");
    this.filename = `cursor-${digest({
      version: 1,
      boundary: boundary.fingerprint,
      strategyFingerprint,
      mode,
    })}.json`;
  }
  private validate(value: unknown): MonitorCursor {
    if (!object(value)) throw Error("扫描游标记录不正确");
    const next = blockNumber(value.nextBlock, "扫描游标");
    const start = BigInt(this.boundary.startBlock);
    if (next < start) throw Error("扫描游标不得早于监控起点");
    if (value.lastScanned !== undefined) {
      if (
        !object(value.lastScanned) ||
        !validHash(value.lastScanned.hash) ||
        blockNumber(value.lastScanned.number, "已扫描区块") + 1n !== next ||
        BigInt(String(value.lastScanned.number)) < start
      )
        throw Error("扫描游标与已扫描区块不连续");
      return {
        nextBlock: next.toString(),
        lastScanned: {
          number: String(value.lastScanned.number),
          hash: value.lastScanned.hash,
        },
      };
    }
    if (next !== start) throw Error("缺少已扫描区块凭据，禁止跳过历史记录");
    return { nextBlock: next.toString() };
  }
  load(): MonitorCursor {
    const path = join(this.directory, this.filename);
    return existsSync(path)
      ? this.validate(readJson(path))
      : { nextBlock: this.boundary.startBlock };
  }
  save(cursor: MonitorCursor): void {
    durableWrite(this.directory, this.filename, this.validate(cursor));
  }
}
