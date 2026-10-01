import { selectPriorityFee } from "../src/fees.js";
import { TESTNET_MAX_GAS_WEI } from "./testnet-policy.js";

export const TESTNET_PRIORITY_CEILING_WEI = 2_000_000_000n;
const UINT256_MAX = 2n ** 256n - 1n;

type History = { reward?: readonly (readonly bigint[])[]; gasUsedRatio: readonly number[] };
export type TestnetFeeSelection = {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  source: "fee_history" | "node_estimate";
  capped: boolean;
};
function uint256(value: unknown, positive = false): value is bigint {
  return typeof value === "bigint" && value >= (positive ? 1n : 0n) && value <= UINT256_MAX;
}
function validHistory(value: History | undefined): value is History {
  if (!value || !Array.isArray(value.reward) || value.reward.length < 1 || value.reward.length > 5 ||
      !Array.isArray(value.gasUsedRatio) || value.gasUsedRatio.length !== value.reward.length) return false;
  return value.reward.every(row => Array.isArray(row) && row.length === 1 && uint256(row[0])) &&
    value.gasUsedRatio.every(ratio => typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1);
}
const min = (left: bigint, right: bigint) => left < right ? left : right;

/** Choose fees inside the fixed test budget, without authorizing a transaction.
 * Ask eth_feeHistory for five blocks and rewardPercentiles:[75]. Its rewards
 * may improve a very low node tip; no history means the original node tip,
 * never an automatic jump to the ceiling. A quote/final-head check is still
 * required by the caller immediately before signing and broadcasting.
 */
export function chooseTestnetFees(input: {
  gasLimit: bigint;
  baseFeePerGas: bigint;
  nodeFees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  history?: History;
}): TestnetFeeSelection {
  if (!input || !uint256(input.gasLimit, true) || !uint256(input.baseFeePerGas) ||
      !input.nodeFees || !uint256(input.nodeFees.maxFeePerGas, true) ||
      !uint256(input.nodeFees.maxPriorityFeePerGas) || input.nodeFees.maxPriorityFeePerGas > input.nodeFees.maxFeePerGas)
    throw Error("testnet_invalid_fee_input");
  const budgetPerGas = TESTNET_MAX_GAS_WEI / input.gasLimit;
  if (budgetPerGas < 1n || input.baseFeePerGas > budgetPerGas) throw Error("testnet_gas_budget_exceeded");
  const priorityCapWei = min(TESTNET_PRIORITY_CEILING_WEI, budgetPerGas);
  const selection = selectPriorityFee({
    strategy: "competitive", priorityCapWei, maxFeePerGas: budgetPerGas,
    baseFeePerGas: input.baseFeePerGas,
    ...(validHistory(input.history) ? input.history : {}),
  });
  const useHistory = selection.source === "fee_history";
  const fallback = useHistory ? undefined : selectPriorityFee({
    strategy: "competitive", priorityCapWei: min(input.nodeFees.maxPriorityFeePerGas, priorityCapWei),
    maxFeePerGas: budgetPerGas, baseFeePerGas: input.baseFeePerGas,
  });
  const maxPriorityFeePerGas = fallback?.maxPriorityFeePerGas ?? selection.maxPriorityFeePerGas;
  // Use bounded base-fee headroom, not the whole available gas budget or an
  // arbitrarily inflated node maxFee suggestion. All calculations use bigint.
  const desiredMaxFee = 2n * input.baseFeePerGas + maxPriorityFeePerGas;
  const maxFeePerGas = min(desiredMaxFee > 0n ? desiredMaxFee : 1n, budgetPerGas);
  return {
    maxFeePerGas, maxPriorityFeePerGas,
    source: useHistory ? "fee_history" : "node_estimate",
    capped: desiredMaxFee > budgetPerGas || (useHistory ? selection.capped : input.nodeFees.maxPriorityFeePerGas > maxPriorityFeePerGas),
  };
}
