import { keccak256, type Address, type Hex, type PublicClient } from "viem";
import { TESTNET_CHAIN_ID } from "./testnet-policy.js";
import { validateContinuousLaunchAge } from "./testnet-fresh-policy.js";

export type LaunchAgeSnapshot = { launchTimestamp: bigint; headTimestamp: bigint };
export function validateActionAge(age: LaunchAgeSnapshot | undefined, nowMs = Date.now()) {
  if (age) validateContinuousLaunchAge(age.launchTimestamp, age.headTimestamp, nowMs);
}

/** A failed sibling cannot leave unfinished checks running into signing or another stage. */
export async function settleChecks<T extends readonly unknown[]>(
  checks: { [K in keyof T]: Promise<T[K]> },
): Promise<T> {
  const results = await Promise.allSettled(checks);
  for (const result of results) if (result.status === "rejected") throw result.reason;
  return results.map((result) => (result as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

/** Share identical block reads only within one validation stage; never cache across stages. */
export class StageBlockReads {
  private readonly reads = new WeakMap<PublicClient, Map<string, Promise<Awaited<ReturnType<PublicClient["getBlock"]>> & { number: bigint; hash: Hex }>>>();
  block(client: PublicClient, blockNumber?: bigint) {
    let cache = this.reads.get(client);
    if (!cache) { cache = new Map(); this.reads.set(client, cache); }
    const key = blockNumber === undefined ? "latest" : blockNumber.toString();
    let pending = cache.get(key);
    if (!pending) {
      pending = (async () => {
        const block = await (blockNumber === undefined ? client.getBlock() : client.getBlock({ blockNumber }));
        if (block.number === null || block.hash === null) throw new Error("testnet_block_mismatch");
        return block as typeof block & { number: bigint; hash: Hex };
      })();
      cache.set(key, pending);
    }
    return pending;
  }
}

type Contract = { address: Address; codeHash: Hex };

/** Code is reusable only for the identical canonical hash on the same verified RPC client. */
export class TestnetProtocolVerifier {
  private readonly verified = new WeakMap<PublicClient, Set<string>>();
  constructor(private readonly contracts: readonly Contract[]) {}
  async verify(clients: PublicClient[], blockNumber: bigint, blockHash: Hex, reads: StageBlockReads) {
    const cacheKey = `${blockNumber}:${blockHash.toLowerCase()}`;
    await settleChecks(clients.map(async (client) => {
      const [chainId, block] = await settleChecks([client.getChainId(), reads.block(client, blockNumber)] as const);
      if (chainId !== TESTNET_CHAIN_ID) throw new Error("testnet_rpc_chain_mismatch");
      if (block.hash !== blockHash) throw new Error("testnet_block_mismatch");
      if (this.verified.get(client)?.has(cacheKey)) return;
      await settleChecks(this.contracts.map(async (contract) => {
        const code = await client.getCode({ address: contract.address, blockNumber });
        if (!code || code === "0x" || keccak256(code) !== contract.codeHash)
          throw new Error("testnet_protocol_changed");
      }));
    }));
    // Cache only a fully successful joint verification; a failed peer cannot warm it.
    for (const client of clients) {
      let cache = this.verified.get(client);
      if (!cache) { cache = new Set(); this.verified.set(client, cache); }
      cache.add(cacheKey);
    }
  }
}
