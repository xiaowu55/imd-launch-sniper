import { keccak256, zeroAddress, parseEther } from "viem";
import type { Candidate, AdapterContext } from "./types.js";
export async function eligibility(candidate: Candidate, ctx: AdapterContext) {
  const { config: c, client, deployment } = ctx;
  if (
    candidate.blockNumber < BigInt(c.startBlock) ||
    candidate.launchNumber < c.minLaunchNumber
  )
    return "上线区块或发射编号早于起点";
  if (!c.allowedKinds.includes(candidate.kind as never))
    return "发币类型不在范围内";
  if (
    !c.allowedHooks.some(
      (h) => h.toLowerCase() === candidate.pool.hooks.toLowerCase(),
    )
  )
    return "Hook 不在白名单";
  if (
    candidate.pool.currency0 !== zeroAddress ||
    candidate.pool.currency1.toLowerCase() !== candidate.token.toLowerCase()
  )
    return "不是原生 ETH 池";
  const token = await client.getCode({
    address: candidate.token,
    blockNumber: candidate.blockNumber,
  });
  if (!token || token === "0x") return "没有代币字节码";
  const hook =
    candidate.pool.hooks === zeroAddress
      ? null
      : await client.getCode({
          address: candidate.pool.hooks,
          blockNumber: candidate.blockNumber,
        });
  if (hook === "0x" || hook === undefined) return "Hook 字节码不可验证";
  const evidence = deployment.taxPolicies.find(
    (p) =>
      p.tokenCodeHash.toLowerCase() === keccak256(token).toLowerCase() &&
      p.hookCodeHash?.toLowerCase() ===
        (hook ? keccak256(hook).toLowerCase() : undefined),
  );
  if (!evidence) return "税率未知：没有该代币与 Hook 组合的审核证据";
  if (evidence.immutable !== true)
    return "税率可能变化：没有不可变税率的审核证据";
  if (
    evidence.buyTaxBps > c.maxBuyTaxBps ||
    evidence.sellTaxBps > c.maxSellTaxBps
  )
    return "税率超过设置";
  // v4 balances are pooled across pools. getBalance(PoolManager) is NOT pool liquidity.
  if (parseEther(c.minLiquidityEth) > 0n)
    return "原生 ETH 实际池储备尚无可验证数据，无法通过最低流动性筛选";
  return null;
}
