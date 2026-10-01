import assert from "node:assert/strict";
import test from "node:test";
import { selectPriorityFee } from "../src/fees.js";
const limits = { strategy: "competitive" as const, priorityCapWei: 100n, maxFeePerGas: 200n, baseFeePerGas: 50n };
test("competitive fees use gas-utilization weighted recent rewards, never unweighted empty blocks", () => {
  const selected = selectPriorityFee({ ...limits, reward: [[1n], [1n], [80n]], gasUsedRatio: [0.01, 0.01, 1] });
  assert.deepEqual(selected, { maxPriorityFeePerGas: 80n, source: "fee_history", capped: false });
});
test("competitive tip remains inside both configured caps", () => {
  assert.deepEqual(selectPriorityFee({ ...limits, reward: [[900n]], gasUsedRatio: [1] }), { maxPriorityFeePerGas: 100n, source: "fee_history", capped: true });
  assert.equal(selectPriorityFee({ ...limits, baseFeePerGas: 190n, reward: [[80n]], gasUsedRatio: [1] }).maxPriorityFeePerGas, 10n);
  assert.equal(selectPriorityFee({ ...limits, priorityCapWei: 0n }).maxPriorityFeePerGas, 0n);
  assert.throws(() => selectPriorityFee({ ...limits, baseFeePerGas: 201n }));
});
test("missing, empty, malformed history falls back to bounded configured cap", () => {
  for (const history of [{}, { reward: [], gasUsedRatio: [] }, { reward: [[1n]], gasUsedRatio: [0] }, { reward: [[-1n]], gasUsedRatio: [1] }, { reward: [[1n]], gasUsedRatio: [NaN] }, { reward: [[1n]], gasUsedRatio: [] }]) {
    assert.deepEqual(selectPriorityFee({ ...limits, ...history }), { maxPriorityFeePerGas: 100n, source: "cap_fallback", capped: false });
  }
});
test("fixed fee mode retains exact prior behavior and rejects insufficient max-fee headroom", () => {
  assert.deepEqual(selectPriorityFee({ ...limits, strategy: "fixed", reward: [[1n]], gasUsedRatio: [1] }), { maxPriorityFeePerGas: 100n, source: "fixed", capped: false });
  assert.throws(() => selectPriorityFee({ ...limits, strategy: "fixed", baseFeePerGas: 150n }));
});
