import {
  keccak256, parseTransaction, recoverMessageAddress, recoverTransactionAddress,
  stringToHex, toHex, type Address, type Hex, type TransactionSerialized,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readBoundedJson } from "./bounded-json.js";

export const PRIVATE_RELAY_URL = "https://relay.flashbots.net";
export type PrivateBroadcastRequest = {
  readonly rawTransaction: Hex;
  /** The caller must obtain and verify this head immediately before submission. */
  readonly headBlockNumber: bigint;
  readonly signal?: AbortSignal;
  /** Synchronous final authorization check after authentication, before transport. */
  readonly assertCanSubmit?: () => void;
};
export type PrivateBroadcastOptions = {
  /** A trusted eth_sendPrivateTransaction relay; HTTPS alone cannot prove relay privacy. */
  readonly url?: string;
  readonly timeoutMs?: number;
  readonly maxBlockDistance?: number;
  readonly fetch?: typeof globalThis.fetch;
  /** Optional separate, unfunded authentication account. Never the transaction signer. */
  readonly authSigner?: {
    readonly address: Address;
    signMessage(args: { message: string }): Promise<Hex>;
  };
};

export type PrivateBroadcastErrorCode =
  | "INVALID_CONFIG" | "INVALID_TRANSACTION" | "AUTH_FAILED" | "CANCELLED"
  | "TIMEOUT" | "PRECONDITION_FAILED" | "HTTP_FAILED" | "TRANSPORT_FAILED" | "RPC_FAILED" | "INVALID_RESPONSE";

/** No nested errors, relay response bodies, signed payloads or credentials escape this boundary. */
export class PrivateBroadcastError extends Error {
  constructor(readonly code: PrivateBroadcastErrorCode, readonly uncertain = false) {
    super(`Private transaction submission failed: ${code}${uncertain ? "; review the existing transaction before any retry" : ""}`);
    this.name = "PrivateBroadcastError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Submit once, privately, with no public RPC or automatic retry/fallback.
 * https://docs.flashbots.net/flashbots-protect/additional-documentation/eth-sendPrivateTransaction
 * Hash-only hints avoid publishing calldata to MEV-Share; fast mode is disabled.
 * An accepted hash is not inclusion. Abort/timeout cannot recall a request already
 * received by the relay; preserve the caller's consumed journal and reconcile it.
 */
export async function sendPrivateTransaction(
  request: PrivateBroadcastRequest,
  options: PrivateBroadcastOptions = {},
): Promise<Hex> {
  const { rawTransaction, headBlockNumber, signal: callerSignal, assertCanSubmit } = request;
  const timeoutMs = options.timeoutMs ?? 10000;
  const maxBlockDistance = options.maxBlockDistance ?? 1;
  const transport = options.fetch ?? globalThis.fetch;
  const configuredSigner = options.authSigner;
  let url: URL;
  try { url = new URL(options.url ?? PRIVATE_RELAY_URL); }
  catch { throw new PrivateBroadcastError("INVALID_CONFIG"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 ||
      !Number.isSafeInteger(maxBlockDistance) || maxBlockDistance < 1 || maxBlockDistance > 25 ||
      typeof transport !== "function") throw new PrivateBroadcastError("INVALID_CONFIG");
  if (typeof rawTransaction !== "string" || rawTransaction.length > 600002 ||
      !/^0x(?:[\da-f]{2})+$/i.test(rawTransaction) || typeof headBlockNumber !== "bigint" ||
      headBlockNumber < 1n || headBlockNumber + BigInt(maxBlockDistance) >= 2n ** 64n)
    throw new PrivateBroadcastError("INVALID_TRANSACTION");

  let sent = false;
  let timedOut = false;
  const controller = new AbortController();
  const abort = () => controller.abort();
  callerSignal?.addEventListener("abort", abort, { once: true });
  if (callerSignal?.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  const stopped = () => new PrivateBroadcastError(timedOut ? "TIMEOUT" : "CANCELLED", sent);
  const checkActive = () => { if (controller.signal.aborted) throw stopped(); };
  // Bound even an injected signer/transport that fails to implement cancellation.
  const interruptible = async <T>(work: Promise<T>): Promise<T> => {
    let onAbort!: () => void;
    const interrupted = new Promise<never>((_, reject) => {
      onAbort = () => reject(stopped());
      controller.signal.addEventListener("abort", onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    try { return await Promise.race([work, interrupted]); }
    finally { controller.signal.removeEventListener("abort", onAbort); }
  };
  try {
    checkActive();
    let transactionSender: Address;
    try {
      const transaction = parseTransaction(rawTransaction);
      // This path receives the engine's EIP-1559 mainnet transaction only. A
      // positive tip is required for private transactions to reach builders.
      if (transaction.type !== "eip1559" || transaction.chainId !== 1 || !transaction.r || !transaction.s ||
          (transaction.maxPriorityFeePerGas ?? 0n) <= 0n ||
          (transaction.maxFeePerGas ?? 0n) < transaction.maxPriorityFeePerGas!)
        throw new PrivateBroadcastError("INVALID_TRANSACTION");
      transactionSender = await interruptible(recoverTransactionAddress({
        serializedTransaction: rawTransaction as TransactionSerialized,
      }));
    } catch (error) {
      checkActive();
      throw error instanceof PrivateBroadcastError ? error : new PrivateBroadcastError("INVALID_TRANSACTION");
    }
    checkActive();
    // A fresh identity authenticates the request without access to the funded key.
    const signer = configuredSigner ?? privateKeyToAccount(generatePrivateKey());
    const authAddress = signer.address;
    if (!/^0x[\da-f]{40}$/i.test(authAddress) || typeof signer.signMessage !== "function" ||
        authAddress.toLowerCase() === transactionSender.toLowerCase())
      throw new PrivateBroadcastError("INVALID_CONFIG");
    const expectedHash = keccak256(rawTransaction);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendPrivateTransaction", params: [{
      tx: rawTransaction, maxBlockNumber: toHex(headBlockNumber + BigInt(maxBlockDistance)),
      preferences: { fast: false, privacy: { hints: ["hash"], builders: ["flashbots"] } },
    }] });
    // Flashbots authenticates the UTF-8 digest string with EIP-191, not raw digest bytes.
    const message = keccak256(stringToHex(body));
    let signature: Hex;
    try {
      signature = await interruptible(signer.signMessage({ message }));
      checkActive();
      if (!/^0x[\da-f]{130}$/i.test(signature) ||
          (await interruptible(recoverMessageAddress({ message, signature }))).toLowerCase() !== authAddress.toLowerCase())
        throw new PrivateBroadcastError("AUTH_FAILED");
    } catch {
      checkActive();
      throw new PrivateBroadcastError("AUTH_FAILED");
    }
    checkActive();
    // Authentication contains await boundaries. Recheck the caller's candidate,
    // deadline and consent without another await before dispatching authority.
    try {
      const result: unknown = assertCanSubmit?.();
      // TypeScript permits async functions where a void callback is expected.
      // Fail closed rather than silently ignoring an unfinished authorization.
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => {});
        throw new PrivateBroadcastError("PRECONDITION_FAILED");
      }
    }
    catch { throw new PrivateBroadcastError("PRECONDITION_FAILED"); }
    checkActive();
    sent = true;
    let response: Response;
    try {
      response = await interruptible(transport(url.toString(), {
        method: "POST", headers: { "Content-Type": "application/json", "X-Flashbots-Signature": `${authAddress}:${signature}` },
        body, redirect: "error", signal: controller.signal,
      }));
    } catch {
      checkActive();
      throw new PrivateBroadcastError("TRANSPORT_FAILED", true);
    }
    checkActive();
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new PrivateBroadcastError("HTTP_FAILED", true);
    }
    let value: unknown;
    try { value = await interruptible(readBoundedJson(response, 65536, controller.signal)); }
    catch {
      checkActive();
      throw new PrivateBroadcastError("INVALID_RESPONSE", true);
    }
    checkActive();
    if (!record(value) || value.jsonrpc !== "2.0" || value.id !== 1)
      throw new PrivateBroadcastError("INVALID_RESPONSE", true);
    if (Object.hasOwn(value, "error")) throw new PrivateBroadcastError("RPC_FAILED", true);
    if (typeof value.result !== "string" || !/^0x[\da-f]{64}$/i.test(value.result) ||
        value.result.toLowerCase() !== expectedHash)
      throw new PrivateBroadcastError("INVALID_RESPONSE", true);
    return expectedHash;
  } catch (error) {
    if (error instanceof PrivateBroadcastError) throw error;
    checkActive();
    throw new PrivateBroadcastError(sent ? "TRANSPORT_FAILED" : "AUTH_FAILED", sent);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abort);
  }
}
