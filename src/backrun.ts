import {
  isAddress,
  keccak256,
  parseEther,
  parseGwei,
  parseTransaction,
  recoverTransactionAddress,
  zeroAddress,
  type Hex,
  type LocalAccount,
  type TransactionSerialized,
} from "viem";
import {
  configSchema,
  deploymentSchema,
  type Config,
  type Deployment,
} from "./config.js";
import type { PoolKey } from "./types.js";
import { encodeBuy, minimumOut } from "./v4.js";

/**
 * Data supplied by a future protocol-specific pending decoder and post-launch-state simulator.
 * These fields are NOT cryptographic proof of a prediction or a quote. The adapter must bind
 * the predicted pool, token/hook runtime hashes, kind, number and expectedAmountOut to this
 * exact launch transaction, configured buy amount and pinned head. This helper checks the
 * supplied values against local policies; it cannot establish their on-chain truth itself.
 */
export interface PendingValidation {
  readonly launchTxHash: Hex;
  readonly kind: string;
  readonly launchNumber: number;
  readonly tokenCodeHash: Hex;
  readonly hookCodeHash: Hex | null;
}

export interface BackrunInput {
  /** A local signer; this function never receives or logs a private-key string. */
  readonly signer: LocalAccount;
  readonly chainId: number;
  readonly deployment: Deployment;
  readonly config: Config;
  readonly rawLaunchTx: Hex;
  readonly pool: PoolKey;
  /** Net expected output for config.buyAmountEth, proven by the caller's post-launch simulation. */
  readonly expectedAmountOut: bigint;
  readonly pendingValidation: PendingValidation;
  /** The caller must refresh the entire snapshot when the canonical head changes. */
  readonly head: {
    readonly number: bigint;
    readonly timestamp: bigint;
    readonly baseFeePerGas: bigint;
  };
  readonly nonce: number;
  readonly pendingNonce: number;
  readonly walletBalance: bigint;
  /** Upper bound for the buy transaction. A later full-bundle simulation must confirm sufficiency. */
  readonly gasLimit: bigint;
}

export interface PreparedBackrun {
  txs: [Hex, Hex];
  buyHash: Hex;
  targetBlock: bigint;
  nonce: number;
}

export type BackrunErrorCode =
  | "INVALID_INPUT"
  | "INVALID_LAUNCH"
  | "POLICY_REJECTED"
  | "NONCE_CONFLICT"
  | "FEE_LIMIT"
  | "INSUFFICIENT_BALANCE"
  | "SIGNING_FAILED";

/** Error messages deliberately exclude signed transactions and signer/RPC error details. */
export class BackrunError extends Error {
  constructor(
    readonly code: BackrunErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BackrunError";
  }
}

const HASH = /^0x[0-9a-fA-F]{64}$/;
const RAW = /^0x(?:[0-9a-fA-F]{2})+$/;
const EMPTY_CODE_HASH = keccak256("0x");
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function reject(code: BackrunErrorCode, message: string): never {
  throw new BackrunError(code, message);
}

/**
 * Prepare, sign and return [launch, buy] for the next Ethereum block. Does not perform RPC,
 * submit to a relay, or implement IMD's still-unavailable mainnet pending-transaction decoder.
 * Never submit the buy alone: first simulate these exact transactions together against head,
 * then send the successful bundle through the relay module. Preparation does not guarantee
 * inclusion, ordering against competing bundles, or the authenticity of caller-supplied quotes.
 */
export async function buildBackrun(
  input: BackrunInput,
): Promise<PreparedBackrun> {
  const parsedConfig = configSchema.safeParse(input.config);
  const parsedDeployment = deploymentSchema.safeParse(input.deployment);
  if (
    !parsedConfig.success ||
    !parsedDeployment.success ||
    input.chainId !== 1
  ) {
    reject(
      "INVALID_INPUT",
      "A valid Ethereum mainnet configuration and reviewed deployment are required.",
    );
  }
  const config = parsedConfig.data;
  const deployment = parsedDeployment.data;
  if (
    !input.signer ||
    !isAddress(input.signer.address) ||
    typeof input.signer.signTransaction !== "function"
  ) {
    reject("INVALID_INPUT", "A local transaction signer is required.");
  }
  if (
    typeof input.rawLaunchTx !== "string" ||
    !RAW.test(input.rawLaunchTx) ||
    input.rawLaunchTx.length > 600_002
  ) {
    reject(
      "INVALID_LAUNCH",
      "The launch transaction must be a bounded, signed transaction encoding.",
    );
  }

  let launch: ReturnType<typeof parseTransaction>;
  let launcher: string;
  try {
    launch = parseTransaction(input.rawLaunchTx);
    launcher = await recoverTransactionAddress({
      serializedTransaction: input.rawLaunchTx as TransactionSerialized,
    });
  } catch {
    reject(
      "INVALID_LAUNCH",
      "The signed launch transaction cannot be decoded or authenticated.",
    );
  }
  if (
    (launch.type !== "legacy" && launch.type !== "eip1559") ||
    launch.chainId !== 1
  ) {
    reject(
      "INVALID_LAUNCH",
      "Only chain-protected mainnet legacy or EIP-1559 launch transactions are supported.",
    );
  }
  if (
    !launch.to ||
    !deployment.factories.some((factory) =>
      same(factory.address, launch.to!),
    ) ||
    !deployment.deployers.some((deployer) => same(deployer, launcher))
  ) {
    reject(
      "INVALID_LAUNCH",
      "The launch transaction is not from an approved deployer to an approved factory.",
    );
  }
  if (same(launcher, input.signer.address)) {
    reject(
      "INVALID_LAUNCH",
      "The buy wallet must be separate from the launch sender.",
    );
  }

  const { head, pool, pendingValidation: evidence } = input;
  if (
    !head ||
    typeof head.number !== "bigint" ||
    head.number < 0n ||
    typeof head.timestamp !== "bigint" ||
    head.timestamp <= 0n ||
    typeof head.baseFeePerGas !== "bigint" ||
    head.baseFeePerGas < 0n ||
    typeof input.gasLimit !== "bigint" ||
    input.gasLimit < 21_000n ||
    typeof input.walletBalance !== "bigint" ||
    input.walletBalance < 0n ||
    typeof input.expectedAmountOut !== "bigint" ||
    input.expectedAmountOut <= 0n ||
    input.expectedAmountOut >= 2n ** 128n
  ) {
    reject(
      "INVALID_INPUT",
      "Head, gas, balance and expected output must be valid bounded transaction quantities.",
    );
  }
  if (
    !Number.isSafeInteger(input.nonce) ||
    input.nonce < 0 ||
    !Number.isSafeInteger(input.pendingNonce) ||
    input.pendingNonce < 0 ||
    input.nonce !== input.pendingNonce
  ) {
    reject(
      "NONCE_CONFLICT",
      "Confirmed and pending nonces must match for the dedicated buy wallet.",
    );
  }
  if (
    !pool ||
    !isAddress(pool.currency0) ||
    !isAddress(pool.currency1) ||
    !isAddress(pool.hooks) ||
    !same(pool.currency0, zeroAddress) ||
    same(pool.currency1, zeroAddress) ||
    !Number.isInteger(pool.fee) ||
    pool.fee < 0 ||
    pool.fee >= 2 ** 24 ||
    !Number.isInteger(pool.tickSpacing) ||
    pool.tickSpacing <= 0 ||
    pool.tickSpacing > 32_767
  ) {
    reject(
      "POLICY_REJECTED",
      "Only a valid native-ETH-to-token Uniswap v4 pool is supported.",
    );
  }
  if (
    !evidence ||
    !HASH.test(evidence.launchTxHash) ||
    !same(evidence.launchTxHash, keccak256(input.rawLaunchTx)) ||
    !Number.isSafeInteger(evidence.launchNumber) ||
    evidence.launchNumber < config.minLaunchNumber ||
    !config.allowedKinds.includes(
      evidence.kind as Config["allowedKinds"][number],
    ) ||
    !config.allowedHooks.some((hook) => same(hook, pool.hooks))
  ) {
    reject(
      "POLICY_REJECTED",
      "Pending validation is missing, not bound to this launch, or outside launch policy.",
    );
  }
  const targetBlock = head.number + 1n;
  if (targetBlock < BigInt(config.startBlock)) {
    reject(
      "POLICY_REJECTED",
      "The next block precedes the configured deployment start block.",
    );
  }
  const noHook = same(pool.hooks, zeroAddress);
  if (
    !HASH.test(evidence.tokenCodeHash) ||
    same(evidence.tokenCodeHash, EMPTY_CODE_HASH) ||
    (noHook
      ? evidence.hookCodeHash !== null
      : evidence.hookCodeHash === null ||
        !HASH.test(evidence.hookCodeHash) ||
        same(evidence.hookCodeHash, EMPTY_CODE_HASH))
  ) {
    reject(
      "POLICY_REJECTED",
      "Predicted token and hook runtime hashes must identify nonempty reviewed code.",
    );
  }
  const taxPolicy = deployment.taxPolicies.find(
    (policy) =>
      same(policy.tokenCodeHash, evidence.tokenCodeHash) &&
      (noHook
        ? policy.hookCodeHash === null
        : policy.hookCodeHash !== null &&
          same(policy.hookCodeHash, evidence.hookCodeHash!)),
  );
  if (
    !taxPolicy ||
    taxPolicy.immutable !== true ||
    taxPolicy.buyTaxBps > config.maxBuyTaxBps ||
    taxPolicy.sellTaxBps > config.maxSellTaxBps
  ) {
    reject(
      "POLICY_REJECTED",
      "Tax evidence is unknown or exceeds the configured buy/sell tax limits.",
    );
  }
  if (parseEther(config.minLiquidityEth) > 0n) {
    reject(
      "POLICY_REJECTED",
      "An actual pool ETH-reserve threshold cannot be verified by this pending adapter.",
    );
  }

  // EIP-1559's maximum increase for the next block is max(floor(baseFee / 8), 1).
  const maximumNextBaseFee =
    head.baseFeePerGas + (head.baseFeePerGas / 8n || 1n);
  const maxPriorityFeePerGas = parseGwei(config.priorityFeeGwei);
  const maxFeePerGas = maximumNextBaseFee + maxPriorityFeePerGas;
  if (
    maxFeePerGas > parseGwei(config.maxFeeGwei) ||
    input.gasLimit * maxFeePerGas > parseEther(config.maxGasEth)
  ) {
    reject(
      "FEE_LIMIT",
      "The next-block maximum fee or total gas cost exceeds the configured limit.",
    );
  }
  const amountIn = parseEther(config.buyAmountEth);
  if (input.walletBalance < amountIn + input.gasLimit * maxFeePerGas) {
    reject(
      "INSUFFICIENT_BALANCE",
      "Wallet balance is below the purchase plus maximum gas cost.",
    );
  }

  let data: Hex;
  try {
    data = encodeBuy(
      pool,
      amountIn,
      minimumOut(input.expectedAmountOut, config.slippageBps),
      head.timestamp + BigInt(config.deadlineSeconds),
    );
  } catch {
    reject(
      "INVALID_INPUT",
      "The bounded swap and minimum output cannot be encoded.",
    );
  }
  let signedBuy: Hex;
  try {
    signedBuy = await input.signer.signTransaction({
      type: "eip1559",
      chainId: 1,
      to: deployment.router.address as `0x${string}`,
      nonce: input.nonce,
      value: amountIn,
      gas: input.gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
      data,
    });
    if (
      !RAW.test(signedBuy) ||
      !same(
        await recoverTransactionAddress({
          serializedTransaction: signedBuy as TransactionSerialized,
        }),
        input.signer.address,
      )
    ) {
      reject(
        "SIGNING_FAILED",
        "The signer returned an invalid signed buy transaction.",
      );
    }
    const buy = parseTransaction(signedBuy);
    if (
      buy.type !== "eip1559" ||
      buy.chainId !== 1 ||
      !buy.to ||
      !same(buy.to, deployment.router.address) ||
      buy.nonce !== input.nonce ||
      buy.value !== amountIn ||
      buy.gas !== input.gasLimit ||
      buy.maxFeePerGas !== maxFeePerGas ||
      buy.maxPriorityFeePerGas !== maxPriorityFeePerGas ||
      buy.data !== data
    ) {
      reject(
        "SIGNING_FAILED",
        "The signer changed the prepared buy transaction.",
      );
    }
  } catch {
    reject("SIGNING_FAILED", "The buy transaction could not be signed.");
  }
  if ((input.rawLaunchTx.length + signedBuy.length - 4) / 2 > 300_000) {
    reject(
      "INVALID_INPUT",
      "The two-transaction bundle exceeds the relay size limit.",
    );
  }
  return {
    txs: [input.rawLaunchTx, signedBuy],
    buyHash: keccak256(signedBuy),
    targetBlock,
    nonce: input.nonce,
  };
}
