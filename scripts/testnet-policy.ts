import { parseEther, parseTransaction, type Address, type Hex } from "viem";

// There is intentionally no chain, amount, recipient, or gas-budget CLI override.
export const TESTNET_CHAIN_ID = 11155111 as const;
export const TESTNET_BUY_WEI = parseEther("0.0001");
export const TESTNET_MAX_GAS_WEI = parseEther("0.002");
export const TESTNET_SLIPPAGE_BPS = 100;

export type TestnetTransaction = {
  chainId: number;
  to: Address;
  data: Hex;
  value: bigint;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

export function checkTestnetBudget(
  transaction: TestnetTransaction,
  balance: bigint,
  pendingNonce: number,
): void {
  if (transaction.chainId !== TESTNET_CHAIN_ID)
    throw new Error("testnet_chain_required");
  if (transaction.value !== TESTNET_BUY_WEI)
    throw new Error("testnet_amount_fixed");
  if (
    !Number.isSafeInteger(transaction.nonce) ||
    transaction.nonce < 0 ||
    transaction.nonce !== pendingNonce
  ) throw new Error("pending_transaction");
  if (
    transaction.gas <= 0n ||
    transaction.maxFeePerGas <= 0n ||
    transaction.maxPriorityFeePerGas < 0n ||
    transaction.maxPriorityFeePerGas > transaction.maxFeePerGas ||
    transaction.gas * transaction.maxFeePerGas > TESTNET_MAX_GAS_WEI
  ) throw new Error("testnet_gas_budget_exceeded");
  if (balance < transaction.value + transaction.gas * transaction.maxFeePerGas)
    throw new Error("insufficient_testnet_balance");
}

/** Decode our own signature before it can reach a broadcast transport. */
export function checkSignedTestnetTransaction(
  raw: Hex,
  expected: TestnetTransaction,
): void {
  const parsed = parseTransaction(raw);
  if (
    parsed.type !== "eip1559" ||
    parsed.chainId !== TESTNET_CHAIN_ID ||
    expected.chainId !== TESTNET_CHAIN_ID ||
    parsed.to?.toLowerCase() !== expected.to.toLowerCase() ||
    parsed.data !== expected.data ||
    parsed.value !== TESTNET_BUY_WEI ||
    parsed.value !== expected.value ||
    parsed.nonce !== expected.nonce ||
    parsed.gas !== expected.gas ||
    parsed.maxFeePerGas !== expected.maxFeePerGas ||
    parsed.maxPriorityFeePerGas !== expected.maxPriorityFeePerGas
  ) throw new Error("signed_testnet_transaction_mismatch");
}
