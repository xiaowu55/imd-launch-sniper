import assert from "node:assert/strict";
import test from "node:test";
import { chooseTestnetFees, TESTNET_PRIORITY_CEILING_WEI } from "../scripts/testnet-fees.js";
import { TESTNET_MAX_GAS_WEI } from "../scripts/testnet-policy.js";

const gwei = 1_000_000_000n;
const input = { gasLimit: 100_000n, baseFeePerGas: gwei, nodeFees: { maxFeePerGas: gwei + 1_000_000n, maxPriorityFeePerGas: 1_000_000n } };

test("recent history can improve a 0.001 gwei node tip within the original total budget", () => {
  const result = chooseTestnetFees({ ...input, history: { reward: [[gwei]], gasUsedRatio: [1] } });
  assert.deepEqual(result, { maxFeePerGas: 3n * gwei, maxPriorityFeePerGas: gwei, source: "fee_history", capped: false });
  assert.ok(result.maxFeePerGas * input.gasLimit < TESTNET_MAX_GAS_WEI);
});

test("testnet history cannot increase the strict 2 gwei priority ceiling", () => {
  const result = chooseTestnetFees({ ...input, history: { reward: [[50n * gwei]], gasUsedRatio: [1] } });
  assert.equal(result.maxPriorityFeePerGas, TESTNET_PRIORITY_CEILING_WEI);
  assert.equal(result.maxFeePerGas, 4n * gwei);
  assert.equal(result.capped, true);
});

test("unavailable history preserves the low node tip and does not spend the whole gas budget", () => {
  const result = chooseTestnetFees({ ...input, nodeFees: { ...input.nodeFees, maxFeePerGas: 1000n * gwei } });
  assert.deepEqual(result, { maxFeePerGas: 2n * gwei + 1_000_000n, maxPriorityFeePerGas: 1_000_000n, source: "node_estimate", capped: false });
  assert.ok(result.maxFeePerGas * input.gasLimit < TESTNET_MAX_GAS_WEI);
});

test("malformed, zero-utilization or oversized history falls back only to the node tip", () => {
  for (const history of [
    {reward: [], gasUsedRatio: []},
    {reward: [[gwei]], gasUsedRatio: [NaN]},
    {reward: [[gwei]], gasUsedRatio: [Infinity]},
    {reward: [[gwei]], gasUsedRatio: [0]},
    {reward: [[-1n]], gasUsedRatio: [1]},
    {reward: [[2n ** 256n]], gasUsedRatio: [1]},
    {reward: [[gwei, gwei]], gasUsedRatio: [1]},
    {reward: Array.from({length: 6}, () => [gwei]), gasUsedRatio: [1,1,1,1,1,1]},
  ]) {
    const result = chooseTestnetFees({...input, history});
    assert.equal(result.source, "node_estimate");
    assert.equal(result.maxPriorityFeePerGas, input.nodeFees.maxPriorityFeePerGas);
  }
});

test("a narrow budget caps both the tip and base-fee headroom without exceeding a single wei", () => {
  const gasLimit = 2_000_003n;
  const budgetPerGas = TESTNET_MAX_GAS_WEI / gasLimit;
  const baseFeePerGas = budgetPerGas - 99n;
  const result = chooseTestnetFees({ ...input, gasLimit, baseFeePerGas, history: {reward: [[gwei]], gasUsedRatio: [1]} });
  assert.equal(result.maxPriorityFeePerGas, 99n);
  assert.equal(result.maxFeePerGas, budgetPerGas);
  assert.equal(result.capped, true);
  assert.ok(result.maxFeePerGas * gasLimit <= TESTNET_MAX_GAS_WEI);
  assert.ok(result.maxFeePerGas >= baseFeePerGas + result.maxPriorityFeePerGas);
});

test("base fee above the remaining fixed per-gas budget is rejected", () => {
  assert.throws(() => chooseTestnetFees({...input, baseFeePerGas: TESTNET_MAX_GAS_WEI / input.gasLimit + 1n}), /gas_budget/);
  assert.throws(() => chooseTestnetFees({...input, gasLimit: TESTNET_MAX_GAS_WEI + 1n}), /gas_budget/);
});

test("zero base fee and zero node tip still produce a positive bounded max fee", () => {
  const result = chooseTestnetFees({...input, baseFeePerGas: 0n, nodeFees: {maxFeePerGas: 1n, maxPriorityFeePerGas: 0n}});
  assert.equal(result.maxFeePerGas, 1n);
  assert.equal(result.maxPriorityFeePerGas, 0n);
});

test("fee fields must be bounded unsigned bigint values and a valid node fee pair", () => {
  for (const gasLimit of [0n, -1n, 2n ** 256n, 100_000 as unknown as bigint])
    assert.throws(() => chooseTestnetFees({...input, gasLimit}), /invalid_fee/);
  for (const baseFeePerGas of [-1n, 2n ** 256n, Infinity as unknown as bigint])
    assert.throws(() => chooseTestnetFees({...input, baseFeePerGas}), /invalid_fee/);
  for (const nodeFees of [
    {maxFeePerGas: 0n, maxPriorityFeePerGas: 0n},
    {maxFeePerGas: 1n, maxPriorityFeePerGas: 2n},
    {maxFeePerGas: 2n ** 256n, maxPriorityFeePerGas: 0n},
    {maxFeePerGas: gwei, maxPriorityFeePerGas: -1n},
  ]) assert.throws(() => chooseTestnetFees({...input, nodeFees}), /invalid_fee/);
});

test("the node fallback obeys the same strict tip ceiling and budget", () => {
  const result = chooseTestnetFees({...input, nodeFees: {maxFeePerGas: 100n * gwei, maxPriorityFeePerGas: 50n * gwei}});
  assert.equal(result.maxPriorityFeePerGas, TESTNET_PRIORITY_CEILING_WEI);
  assert.equal(result.capped, true);
  assert.equal(result.source, "node_estimate");
  assert.ok(result.maxFeePerGas * input.gasLimit <= TESTNET_MAX_GAS_WEI);
});
