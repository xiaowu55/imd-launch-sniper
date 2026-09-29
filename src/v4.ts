import {
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  parseAbiParameters,
  keccak256,
  zeroAddress,
  type Address,
} from "viem";
import type { PoolKey } from "./types.js";
export const poolTuple =
  "(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
export const poolAbi = parseAbi([
  "event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)",
]);
export const routerAbi = parseAbi([
  "function execute(bytes commands,bytes[] inputs,uint256 deadline) payable",
]);
export const quoterAbi = parseAbi([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)",
]);
export const stateAbi = parseAbi([
  "function getLiquidity(bytes32 poolId) view returns(uint128 liquidity)",
]);
export function poolId(pool: PoolKey) {
  return keccak256(encodeAbiParameters(parseAbiParameters(poolTuple), [pool]));
}
export function minimumOut(quote: bigint, slippageBps: number) {
  if (
    quote <= 0n ||
    !Number.isInteger(slippageBps) ||
    slippageBps < 0 ||
    slippageBps >= 10000
  )
    throw Error("Invalid quote/slippage");
  const min = (quote * BigInt(10000 - slippageBps)) / 10000n;
  if (min === 0n) throw Error("Zero minimum output");
  return min;
}
export function encodeBuy(
  pool: PoolKey,
  amountIn: bigint,
  minOut: bigint,
  deadline: bigint,
) {
  if (
    pool.currency0.toLowerCase() !== zeroAddress ||
    pool.currency1 === zeroAddress
  )
    throw Error("Only native ETH → token supported");
  if (
    amountIn <= 0n ||
    minOut <= 0n ||
    amountIn >= 2n ** 128n ||
    minOut >= 2n ** 128n
  )
    throw Error("Invalid uint128 swap amount");
  const params = [
    encodeAbiParameters(
      parseAbiParameters(
        `(${poolTuple} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`,
      ),
      [
        {
          poolKey: pool,
          zeroForOne: true,
          amountIn,
          amountOutMinimum: minOut,
          hookData: "0x",
        },
      ],
    ),
    encodeAbiParameters(parseAbiParameters("address,uint256"), [
      zeroAddress,
      amountIn,
    ]),
    encodeAbiParameters(parseAbiParameters("address,uint256"), [
      pool.currency1 as Address,
      minOut,
    ]),
  ];
  return encodeFunctionData({
    abi: routerAbi,
    functionName: "execute",
    args: [
      "0x10",
      [
        encodeAbiParameters(parseAbiParameters("bytes,bytes[]"), [
          "0x060c0f",
          params,
        ]),
      ],
      deadline,
    ],
  });
}
