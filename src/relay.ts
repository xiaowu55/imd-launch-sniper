import { keccak256, stringToHex, toHex, type Address, type Hex } from "viem";
import { BoundedJsonError, readBoundedJson } from "./bounded-json.js";

/** Use a separate, unfunded account for relay authentication. */
export interface RelayAuthSigner {
  readonly address: Address;
  signMessage(args: { message: string }): Promise<Hex>;
}

export interface FlashbotsRelayConfig {
  readonly url: string;
  readonly authSigner: RelayAuthSigner;
  readonly timeoutMs?: number;
  /** Injectable HTTP transport for tests; defaults to the Node 22 fetch implementation. */
  readonly fetch?: typeof globalThis.fetch;
}

export interface BundleSimulationRequest {
  /** Signed launch transaction first, then the signed purchase transaction. */
  readonly txs: readonly Hex[];
  readonly blockNumber: bigint;
  /** Pin to the current head for reproducible simulation; latest is supported explicitly. */
  readonly stateBlockNumber?: bigint | "latest";
  readonly timestamp?: number;
}

export interface SimulatedTransaction {
  readonly txHash: Hex;
  readonly gasUsed: bigint;
}

/** Only the instance returned by simulateBundle can be submitted by that same relay client. */
export interface SuccessfulBundleSimulation {
  readonly blockNumber: bigint;
  readonly stateBlockNumber: bigint;
  readonly bundleHash: Hex;
  readonly totalGasUsed: bigint;
  readonly results: readonly SimulatedTransaction[];
}

export interface BundleSubmissionOptions {
  readonly builders?: readonly string[];
}

export interface BundleSubmission {
  readonly bundleHash: Hex;
  readonly smart?: boolean;
}

export type RelayErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_BUNDLE"
  | "AUTH_FAILED"
  | "TIMEOUT"
  | "TRANSPORT_FAILED"
  | "HTTP_FAILED"
  | "RPC_FAILED"
  | "INVALID_RESPONSE"
  | "SIMULATION_FAILED"
  | "SIMULATION_REQUIRED";

/** Deliberately excludes relay response text, signed transactions, credentials and nested errors. */
export class RelayError extends Error {
  constructor(
    readonly code: RelayErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

interface PreparedBundle {
  readonly txs: readonly Hex[];
  readonly blockNumber: Hex;
  readonly stateBlockNumber: Hex | "latest";
  readonly timestamp?: number;
}

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const RAW_PATTERN = /^0x(?:[0-9a-fA-F]{2})+$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hash(value: unknown): value is Hex {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function quantity(value: unknown): bigint | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
    return BigInt(value);
  if (
    typeof value === "string" &&
    /^(?:0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(value)
  ) {
    return BigInt(value);
  }
  return undefined;
}

function prepareBundle(request: BundleSimulationRequest): PreparedBundle {
  if (
    !Array.isArray(request.txs) ||
    request.txs.length === 0 ||
    request.txs.length > 100
  ) {
    throw new RelayError(
      "INVALID_BUNDLE",
      "Bundle must contain between 1 and 100 signed transactions.",
    );
  }
  let bytes = 0;
  for (const tx of request.txs) {
    if (typeof tx !== "string" || !RAW_PATTERN.test(tx)) {
      throw new RelayError(
        "INVALID_BUNDLE",
        "Bundle contains an invalid transaction encoding.",
      );
    }
    bytes += (tx.length - 2) / 2;
  }
  if (bytes > 300_000)
    throw new RelayError(
      "INVALID_BUNDLE",
      "Bundle exceeds the relay size limit.",
    );
  if (typeof request.blockNumber !== "bigint" || request.blockNumber <= 0n) {
    throw new RelayError(
      "INVALID_BUNDLE",
      "Target block must be a positive integer.",
    );
  }
  const stateBlock = request.stateBlockNumber ?? "latest";
  if (
    stateBlock !== "latest" &&
    (typeof stateBlock !== "bigint" ||
      stateBlock < 0n ||
      stateBlock >= request.blockNumber)
  ) {
    throw new RelayError(
      "INVALID_BUNDLE",
      "Simulation state block must precede the target block.",
    );
  }
  if (
    request.timestamp !== undefined &&
    (!Number.isSafeInteger(request.timestamp) || request.timestamp <= 0)
  ) {
    throw new RelayError(
      "INVALID_BUNDLE",
      "Simulation timestamp must be a positive integer.",
    );
  }
  return Object.freeze({
    txs: Object.freeze([...request.txs]),
    blockNumber: toHex(request.blockNumber),
    stateBlockNumber: stateBlock === "latest" ? "latest" : toHex(stateBlock),
    ...(request.timestamp !== undefined
      ? { timestamp: request.timestamp }
      : {}),
  });
}

/** Flashbots eth_callBundle / eth_sendBundle. Acceptance does not guarantee block inclusion. */
export class FlashbotsRelay {
  readonly #url: string;
  readonly #signer: RelayAuthSigner;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #simulations = new WeakMap<
    SuccessfulBundleSimulation,
    PreparedBundle
  >();
  #nextId = 1;

  constructor(config: FlashbotsRelayConfig) {
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      throw new RelayError("INVALID_CONFIG", "Relay URL is invalid.");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new RelayError(
        "INVALID_CONFIG",
        "Relay URL must use HTTPS without user information or fragment.",
      );
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(config.authSigner.address)) {
      throw new RelayError(
        "INVALID_CONFIG",
        "Relay authentication address is invalid.",
      );
    }
    const timeoutMs = config.timeoutMs ?? 3_000;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 120_000
    ) {
      throw new RelayError(
        "INVALID_CONFIG",
        "Relay timeout must be between 1 and 120000 milliseconds.",
      );
    }
    this.#url = url.toString();
    this.#signer = config.authSigner;
    this.#timeoutMs = timeoutMs;
    this.#fetch = config.fetch ?? globalThis.fetch;
  }

  async simulateBundle(
    request: BundleSimulationRequest,
  ): Promise<SuccessfulBundleSimulation> {
    const prepared = prepareBundle(request);
    const result = await this.#rpc("eth_callBundle", prepared);
    if (
      !record(result) ||
      !hash(result.bundleHash) ||
      !Array.isArray(result.results) ||
      result.results.length !== prepared.txs.length
    ) {
      throw new RelayError(
        "INVALID_RESPONSE",
        "Relay returned an incomplete bundle simulation.",
      );
    }
    if (result.error !== undefined || result.revert !== undefined) {
      throw new RelayError("SIMULATION_FAILED", "Bundle simulation failed.");
    }
    const results: SimulatedTransaction[] = result.results.map(
      (entry: unknown, index: number) => {
        if (!record(entry))
          throw new RelayError(
            "INVALID_RESPONSE",
            "Relay returned an invalid transaction simulation.",
          );
        if (entry.error !== undefined || entry.revert !== undefined) {
          throw new RelayError(
            "SIMULATION_FAILED",
            `Bundle transaction ${index + 1} failed simulation.`,
          );
        }
        const expectedTx = prepared.txs[index];
        const gasUsed = quantity(entry.gasUsed);
        if (
          !hash(entry.txHash) ||
          expectedTx === undefined ||
          entry.txHash.toLowerCase() !== keccak256(expectedTx).toLowerCase() ||
          gasUsed === undefined ||
          gasUsed <= 0n
        ) {
          throw new RelayError(
            "INVALID_RESPONSE",
            `Relay returned an invalid simulation for transaction ${index + 1}.`,
          );
        }
        return Object.freeze({ txHash: entry.txHash, gasUsed });
      },
    );
    const totalGasUsed = quantity(result.totalGasUsed);
    const stateBlockNumber = quantity(result.stateBlockNumber);
    if (
      totalGasUsed === undefined ||
      totalGasUsed !== results.reduce((sum, tx) => sum + tx.gasUsed, 0n) ||
      stateBlockNumber === undefined ||
      stateBlockNumber >= request.blockNumber ||
      (prepared.stateBlockNumber !== "latest" &&
        stateBlockNumber !== BigInt(prepared.stateBlockNumber))
    ) {
      throw new RelayError(
        "INVALID_RESPONSE",
        "Relay returned inconsistent simulation totals or state block.",
      );
    }
    const simulation = Object.freeze({
      blockNumber: request.blockNumber,
      stateBlockNumber,
      bundleHash: result.bundleHash,
      totalGasUsed,
      results: Object.freeze(results),
    });
    this.#simulations.set(simulation, prepared);
    return simulation;
  }

  /** Each target block requires a new successful simulation of those exact transactions. */
  async sendBundle(
    simulation: SuccessfulBundleSimulation,
    options: BundleSubmissionOptions = {},
  ): Promise<BundleSubmission> {
    const prepared = this.#simulations.get(simulation);
    if (prepared === undefined) {
      throw new RelayError(
        "SIMULATION_REQUIRED",
        "A successful simulation from this relay client is required.",
      );
    }
    if (
      options.builders !== undefined &&
      (!Array.isArray(options.builders) ||
        options.builders.length === 0 ||
        options.builders.some(
          (builder) =>
            typeof builder !== "string" ||
            builder.length === 0 ||
            builder.length > 128 ||
            /[\s\x00-\x1f\x7f]/.test(builder),
        ))
    ) {
      throw new RelayError(
        "INVALID_BUNDLE",
        "Builder names must be nonempty strings without whitespace.",
      );
    }
    // No revertingTxHashes: neither launch nor purchase may revert. Preserve the simulated ordering.
    const result = await this.#rpc("eth_sendBundle", {
      txs: prepared.txs,
      blockNumber: prepared.blockNumber,
      ...(prepared.timestamp !== undefined
        ? { minTimestamp: prepared.timestamp, maxTimestamp: prepared.timestamp }
        : {}),
      ...(options.builders !== undefined
        ? { builders: [...options.builders] }
        : {}),
    });
    if (
      !record(result) ||
      !hash(result.bundleHash) ||
      (result.smart !== undefined &&
        ![true, false, "true", "false"].includes(
          result.smart as boolean | string,
        ))
    ) {
      throw new RelayError(
        "INVALID_RESPONSE",
        "Relay returned an invalid bundle submission result.",
      );
    }
    return Object.freeze({
      bundleHash: result.bundleHash,
      ...(result.smart !== undefined
        ? { smart: result.smart === true || result.smart === "true" }
        : {}),
    });
  }

  async #rpc(
    method: "eth_callBundle" | "eth_sendBundle",
    params: unknown,
  ): Promise<unknown> {
    const id = this.#nextId++;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: [params],
    });
    let signature: Hex;
    try {
      // Flashbots signs the UTF-8 text of the 0x-prefixed digest, NOT { raw: digest }.
      // https://docs.flashbots.net/flashbots-auction/advanced/rpc-endpoint#authentication
      signature = await this.#signer.signMessage({
        message: keccak256(stringToHex(body)),
      });
    } catch {
      throw new RelayError(
        "AUTH_FAILED",
        "Relay authentication signing failed.",
      );
    }
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      throw new RelayError(
        "AUTH_FAILED",
        "Relay authentication signature is invalid.",
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: unknown;
    try {
      const http = await this.#fetch(this.#url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Flashbots-Signature": `${this.#signer.address}:${signature}`,
        },
        body,
        signal: controller.signal,
        redirect: "error",
      });
      if (!http.ok)
        throw new RelayError(
          "HTTP_FAILED",
          `Relay HTTP request failed (${http.status}).`,
        );
      try {
        response = await readBoundedJson(http, 1_000_000, controller.signal);
      } catch (error) {
        throw new RelayError(
          "INVALID_RESPONSE",
          error instanceof BoundedJsonError && error.code === "too_large"
            ? "Relay response exceeded the size limit."
            : "Relay response was not valid JSON.",
        );
      }
    } catch (error: unknown) {
      if (controller.signal.aborted)
        throw new RelayError("TIMEOUT", "Relay request timed out.");
      if (error instanceof RelayError) throw error;
      throw new RelayError("TRANSPORT_FAILED", "Relay request failed.");
    } finally {
      clearTimeout(timeout);
    }
    // Relay error strings can echo signed transactions; never include them in propagated errors.
    if (record(response) && response.error !== undefined) {
      throw new RelayError(
        "RPC_FAILED",
        "Relay rejected the JSON-RPC request.",
      );
    }
    if (
      !record(response) ||
      response.jsonrpc !== "2.0" ||
      (response.id !== id && response.id !== String(id)) ||
      !Object.hasOwn(response, "result")
    ) {
      throw new RelayError(
        "INVALID_RESPONSE",
        "Relay returned an invalid JSON-RPC response.",
      );
    }
    return response.result;
  }
}
