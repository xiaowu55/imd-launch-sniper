import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { parse } from "dotenv";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

export type WalletStatus = {
  configured: boolean;
  address: string | null;
  source: "server-env";
};

export function normalizePrivateKey(input: string): Hex {
  if (input.length > 256) throw new Error("私钥输入过长，未保存");
  const value = input.trim();
  const key = (value.startsWith("0x") ? value : `0x${value}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key))
    throw new Error("私钥应为 64 位十六进制字符，可带 0x 前缀");
  try {
    privateKeyToAccount(key);
  } catch {
    throw new Error("私钥无效，未保存");
  }
  return key;
}

// Never return the private key to an API, UI, log or error response.
export function walletStatus(
  key = process.env.TRADING_PRIVATE_KEY,
): WalletStatus {
  try {
    if (!key) throw new Error("missing");
    const account = privateKeyToAccount(normalizePrivateKey(key));
    return { configured: true, address: account.address, source: "server-env" };
  } catch {
    return { configured: false, address: null, source: "server-env" };
  }
}

function readEnv(path: string, requirePrivate = false): string {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new Error("钱包配置必须是可读取的本机普通文件");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536)
      throw new Error("钱包配置必须是小于 64 KiB 的本机普通文件");
    if (
      requirePrivate &&
      ((stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid()))
    )
      throw new Error("钱包配置必须仅限当前用户读写，请重新运行钱包导入");
    const buffer = Buffer.alloc(65537);
    let size = 0;
    try {
      while (size < buffer.length) {
        const count = readSync(fd, buffer, size, buffer.length - size, null);
        if (!count) return buffer.toString("utf8", 0, size);
        size += count;
      }
      throw new Error("钱包配置文件过大，未读取");
    } finally {
      buffer.fill(0);
    }
  } finally {
    closeSync(fd);
  }
}

/** Local terminal import only. The .env is plaintext and owner-readable, not encrypted. */
export function saveWalletEnv(input: string, path: string): string {
  const key = normalizePrivateKey(input);
  const previous = readEnv(path);
  // Match complete dotenv assignments so unrelated quoted multiline values are preserved.
  // dotenv accepts '=' and ': ' separators, plus single, double and backtick quotes.
  const assignment =
    /^[ \t]*(?:export[ \t]+)?([\w.-]+)(?:[ \t]*=[ \t]*|:[ \t]+)([ \t]*'(?:\\'|[^'])*'|[ \t]*"(?:\\"|[^"])*"|[ \t]*`(?:\\`|[^`])*`|[^#\r\n]*)[ \t]*(?:#.*)?$/gm;
  const preserved = previous
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(assignment, (line, name: string, value: string) => {
      if (name !== "TRADING_PRIVATE_KEY") return line;
      const rhs = value.trim();
      if (
        /[\r\n]/.test(value) ||
        (["'", '"', "`"].includes(rhs[0] ?? "") && rhs.at(-1) !== rhs[0])
      )
        throw new Error("现有私钥配置不是单行格式，请先在本机检查 .env");
      return "";
    })
    .replace(/\n*$/, "");
  const updated = `${preserved}${preserved ? "\n" : ""}TRADING_PRIVATE_KEY=${key}\n`;
  const parsedBefore = parse(previous);
  const parsedAfter = parse(updated);
  if (Buffer.byteLength(updated) > 65536)
    throw new Error("钱包配置文件过大，未保存");
  if (
    parsedAfter.TRADING_PRIVATE_KEY !== key ||
    Object.entries(parsedBefore).some(
      ([name, value]) =>
        name !== "TRADING_PRIVATE_KEY" && parsedAfter[name] !== value,
    )
  )
    throw new Error("钱包配置解析失败，未保存");
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, updated, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return privateKeyToAccount(key).address;
}

export function reloadWalletEnv(path: string): WalletStatus {
  const value = parse(readEnv(path, true)).TRADING_PRIVATE_KEY;
  if (!value)
    throw new Error("未找到已保存的钱包，请先运行 npm run wallet:import");
  const key = normalizePrivateKey(value);
  process.env.TRADING_PRIVATE_KEY = key;
  return walletStatus();
}

/** Startup uses the same file boundary as wallet reload, not dotenv's unchecked file reader. */
export function loadServerEnvironment(path: string): void {
  const values = parse(readEnv(path, true));
  for (const [name, value] of Object.entries(values))
    if (process.env[name] === undefined) process.env[name] = value;
}
