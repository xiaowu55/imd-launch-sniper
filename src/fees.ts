export type FeeStrategy = "fixed" | "competitive";
export type FeeSelection = {
  maxPriorityFeePerGas: bigint;
  source: "fixed" | "fee_history" | "cap_fallback";
  capped: boolean;
};

/** Recent per-block p75 rewards, weighted by each block's gas utilization.
 * This is an inclusion heuristic, never a promise about the next block.
 * Every result stays below both user limits; no gas budget is raised here.
 */
export function selectPriorityFee(input: {
  strategy: FeeStrategy;
  priorityCapWei: bigint;
  maxFeePerGas: bigint;
  baseFeePerGas: bigint;
  reward?: readonly (readonly bigint[])[];
  gasUsedRatio?: readonly number[];
}): FeeSelection {
  const { strategy, priorityCapWei, maxFeePerGas, baseFeePerGas } = input;
  if (priorityCapWei < 0n || maxFeePerGas <= 0n || baseFeePerGas < 0n || priorityCapWei > maxFeePerGas)
    throw Error("Invalid fee limits");
  const headroom = maxFeePerGas - baseFeePerGas;
  if (headroom < 0n) throw Error("Gas 单价上限低于当前基础费");
  if (strategy === "fixed") {
    if (priorityCapWei > headroom) throw Error("Gas 单价上限低于当前基础费加优先费");
    return { maxPriorityFeePerGas: priorityCapWei, source: "fixed", capped: false };
  }
  if (strategy !== "competitive") throw Error("Invalid fee strategy");
  let desired = priorityCapWei;
  let source: FeeSelection["source"] = "cap_fallback";
  const rewards = input.reward;
  const ratios = input.gasUsedRatio;
  if (rewards?.length && rewards.length <= 100 && ratios?.length === rewards.length) {
    const rows = rewards.map((row, index) => ({ value: row[0], weight: ratios[index]! }));
    if (rows.every(({ value, weight }) => typeof value === "bigint" && value >= 0n && Number.isFinite(weight) && weight >= 0 && weight <= 1)) {
      const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
      if (totalWeight > 0) {
        rows.sort((a, b) => a.value! < b.value! ? -1 : a.value! > b.value! ? 1 : 0);
        let cumulative = 0;
        for (const row of rows) {
          cumulative += row.weight;
          if (cumulative >= totalWeight / 2) { desired = row.value!; break; }
        }
        source = "fee_history";
      }
    }
  }
  const cap = priorityCapWei < headroom ? priorityCapWei : headroom;
  return { maxPriorityFeePerGas: desired < cap ? desired : cap, source, capped: desired > cap };
}
