import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEther, parseGwei, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  checkSignedTestnetTransaction, checkTestnetBudget, TESTNET_BUY_WEI,
  TESTNET_CHAIN_ID, TESTNET_MAX_GAS_WEI, type TestnetTransaction,
} from "../scripts/testnet-policy.js";
import { trustedUniswap } from "../src/api-launch.js";

// Public fixture only: never used by the testnet CLI or funded.
const account = privateKeyToAccount(`0x${"1".repeat(64)}` as Hex);
const transaction: TestnetTransaction = {
  chainId: TESTNET_CHAIN_ID,
  to: trustedUniswap(TESTNET_CHAIN_ID).router.address,
  data: "0x12345678", value: TESTNET_BUY_WEI, nonce: 0,
  gas: 100000n, maxFeePerGas: parseGwei("1"), maxPriorityFeePerGas: parseGwei("0.1"),
};

test("testnet budget forbids mainnet, arbitrary amounts and pending nonce reuse", () => {
  const balance = parseEther("0.01");
  checkTestnetBudget(transaction, balance, 0);
  assert.throws(() => checkTestnetBudget({ ...transaction, chainId: 1 }, balance, 0), /testnet_chain_required/);
  assert.throws(() => checkTestnetBudget({ ...transaction, value: parseEther("0.001") }, balance, 0), /testnet_amount_fixed/);
  assert.throws(() => checkTestnetBudget(transaction, balance, 1), /pending_transaction/);
  assert.throws(() => checkTestnetBudget({ ...transaction, nonce: -1 }, balance, -1), /pending_transaction/);
});

test("testnet budget covers worst-case gas and rejects invalid or excess fees", () => {
  const required = transaction.value + transaction.gas * transaction.maxFeePerGas;
  checkTestnetBudget(transaction, required, 0);
  assert.throws(() => checkTestnetBudget(transaction, required - 1n, 0), /insufficient_testnet_balance/);
  assert.throws(() => checkTestnetBudget({ ...transaction, gas: 0n }, required, 0), /testnet_gas_budget_exceeded/);
  assert.throws(() => checkTestnetBudget({ ...transaction, maxFeePerGas: 0n }, required, 0), /testnet_gas_budget_exceeded/);
  assert.throws(() => checkTestnetBudget({ ...transaction, maxPriorityFeePerGas: transaction.maxFeePerGas + 1n }, required, 0), /testnet_gas_budget_exceeded/);
  assert.throws(() => checkTestnetBudget({ ...transaction, gas: TESTNET_MAX_GAS_WEI / transaction.maxFeePerGas + 1n }, parseEther("1"), 0), /testnet_gas_budget_exceeded/);
});

test("decoded testnet signatures must match chain, recipient, amount, calldata, nonce and gas limits", async () => {
  const raw = await account.signTransaction({ ...transaction, type: "eip1559" });
  checkSignedTestnetTransaction(raw, transaction);
  for (const patch of [
    { chainId: 1 }, { to: account.address }, { value: 1n }, { data: "0x" as Hex },
    { nonce: 1 }, { gas: transaction.gas + 1n },
    { maxFeePerGas: transaction.maxFeePerGas + 1n },
    { maxPriorityFeePerGas: transaction.maxPriorityFeePerGas + 1n },
  ]) {
    const changed = await account.signTransaction({ ...transaction, ...patch, type: "eip1559" });
    assert.throws(() => checkSignedTestnetTransaction(changed, transaction), /signed_testnet_transaction_mismatch/);
  }
});
