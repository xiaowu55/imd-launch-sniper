import type { Address, Hex, PublicClient } from "viem";
import type { Config, Deployment } from "./config.js";
export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}
export interface Candidate {
  id: string;
  token: Address;
  poolId: Hex;
  pool: PoolKey;
  launchNumber: number;
  kind: string;
  launchTxHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  transactionIndex: number;
  logIndex: number;
}
export interface AdapterContext {
  client: PublicClient;
  config: Config;
  deployment: Deployment;
}
export interface PendingCandidate {
  candidate: Candidate;
  rawLaunchTx: Hex;
  expectedAmountOut: bigint;
}
export interface LaunchAdapter {
  // Complete ordered canonical-block discovery; reject unrecognized launch ABI.
  discover(
    fromBlock: bigint,
    toBlock: bigint,
    context: AdapterContext,
  ): Promise<Candidate[]>;
  // Optional verified protocol-specific mempool decoder + CREATE2 prediction.
  pending?(
    hash: Hex,
    context: AdapterContext,
  ): Promise<PendingCandidate | null>;
}
