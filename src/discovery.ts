import { decodeEventLog, parseAbi, zeroAddress, hexToString, type Log } from "viem";
import { poolAbi, poolId } from "./v4.js";
import type { LaunchAdapter, Candidate } from "./types.js";
// Observed Sepolia factory ABI, see docs/RESEARCH.md. Mainnet manifest must confirm it.
export const projectAbi = parseAbi([
  "event ProjectLaunched(uint64 indexed launchNumber,address indexed token,address distributor,address[] contracts)",
]);
export const registryAbi = parseAbi([
  "event LaunchRecorded(uint64 indexed launchNumber,bytes32 indexed kind,bytes32 sourceCommit,bytes32 attestationHash,address[] artifacts,uint256[] lpTokenIds)",
]);
export const projectAdapter: LaunchAdapter = {
  async discover(fromBlock, toBlock, { client, deployment }) {
    const logs = await client.getLogs({
      address: deployment.poolManager.address as `0x${string}`,
      event: poolAbi[0],
      fromBlock,
      toBlock,
      strict: true,
    });
    const candidates: Candidate[] = [];
    const receipts = new Map<
      string,
      Awaited<ReturnType<typeof client.getTransactionReceipt>>
    >();
    for (const log of logs) {
      if (
        log.removed ||
        log.args.currency0 !== zeroAddress ||
        !log.transactionHash
      )
        continue;
      if (log.address.toLowerCase() !== deployment.poolManager.address.toLowerCase() ||
          log.blockNumber === null || log.blockNumber < fromBlock || log.blockNumber > toBlock ||
          !log.blockHash || !Number.isSafeInteger(log.transactionIndex) || log.transactionIndex! < 0 ||
          !Number.isSafeInteger(log.logIndex) || log.logIndex! < 0)
        throw Error("Inconsistent pool log identity");
      const tx = await client.getTransaction({ hash: log.transactionHash });
      if (
        !tx.to ||
        !deployment.factories.some(
          (x) => x.address.toLowerCase() === tx.to!.toLowerCase(),
        ) ||
        !deployment.deployers.some(
          (x) => x.toLowerCase() === tx.from.toLowerCase(),
        )
      )
        continue;
      let receipt = receipts.get(tx.hash);
      if (!receipt) {
        receipt = await client.getTransactionReceipt({ hash: tx.hash });
        receipts.set(tx.hash, receipt);
      }
      // A provider can return mixed cache entries across a reorg. Never consume
      // the chunk cursor unless transaction, receipt and Initialize agree.
      if (tx.chainId !== deployment.chainId || tx.hash !== log.transactionHash ||
          tx.blockNumber !== log.blockNumber || tx.blockHash !== log.blockHash ||
          tx.transactionIndex !== log.transactionIndex || receipt.status !== "success" ||
          receipt.transactionHash !== tx.hash || receipt.blockNumber !== log.blockNumber ||
          receipt.blockHash !== log.blockHash || receipt.transactionIndex !== log.transactionIndex ||
          receipt.from.toLowerCase() !== tx.from.toLowerCase() || receipt.to?.toLowerCase() !== tx.to.toLowerCase())
        throw Error("Inconsistent launch transaction receipt");
      const belongs = (event: Log) => !event.removed &&
        event.transactionHash === receipt.transactionHash && event.blockHash === receipt.blockHash &&
        event.blockNumber === receipt.blockNumber && event.transactionIndex === receipt.transactionIndex &&
        Number.isSafeInteger(event.logIndex) && event.logIndex! >= 0;
      const initialized = receipt.logs.filter((event) => {
        if (!belongs(event) || event.address.toLowerCase() !== deployment.poolManager.address.toLowerCase() || event.logIndex !== log.logIndex)
          return false;
        try {
          const decoded = decodeEventLog({ abi: poolAbi, data: event.data, topics: event.topics, strict: true });
          return decoded.args.id === log.args.id &&
            decoded.args.currency0.toLowerCase() === log.args.currency0!.toLowerCase() &&
            decoded.args.currency1.toLowerCase() === log.args.currency1!.toLowerCase() &&
            decoded.args.hooks.toLowerCase() === log.args.hooks!.toLowerCase() &&
            decoded.args.fee === log.args.fee && decoded.args.tickSpacing === log.args.tickSpacing;
        } catch { return false; }
      });
      if (initialized.length !== 1) throw Error("Pool initialization missing from launch receipt");
      const pool = {
        currency0: log.args.currency0!, currency1: log.args.currency1!,
        fee: log.args.fee!, tickSpacing: log.args.tickSpacing!, hooks: log.args.hooks!,
      };
      if (poolId(pool) !== log.args.id) throw Error("Pool ID mismatch");
      const attested: Candidate[] = [];
      for (const event of receipt.logs) {
        if (
          !deployment.registries.some(
            (r) => r.address.toLowerCase() === event.address.toLowerCase(),
          )
        )
          continue;
        if (!belongs(event)) throw Error("Inconsistent registry log identity");
        const decoded = (() => {
          try { return decodeEventLog({
            abi: registryAbi,
            data: event.data,
            topics: event.topics,
            strict: true,
          }); } catch { return null; }
        })();
        if (!decoded) continue;
        if (
          !decoded.args.artifacts.some(
            (a) => a.toLowerCase() === log.args.currency1!.toLowerCase(),
          ) || (log.args.hooks !== zeroAddress && !decoded.args.artifacts.some(
            (a) => a.toLowerCase() === log.args.hooks!.toLowerCase(),
          ))
        )
          continue;
        const kind = hexToString(decoded.args.kind, { size: 32 }).replace(
          /\0/g,
          "",
        );
        if (!["evm_project", "univ4_hook", "custom_token"].includes(kind))
          continue;
        const n = Number(decoded.args.launchNumber);
        if (!Number.isSafeInteger(n) || n < 1) throw Error("Launch number overflow");
        attested.push({
          id: `1:${n}:${pool.currency1.toLowerCase()}`,
          token: pool.currency1,
          poolId: log.args.id!,
          pool,
          launchNumber: n,
          kind,
          launchTxHash: tx.hash,
          blockNumber: log.blockNumber!,
          blockHash: log.blockHash!,
          transactionIndex: log.transactionIndex!,
          logIndex: log.logIndex!,
        });
      }
      if (attested.length > 1) throw Error("Ambiguous launch registry evidence");
      candidates.push(...attested);
    }
    return candidates.sort((a, b) =>
      a.blockNumber < b.blockNumber
        ? -1
        : a.blockNumber > b.blockNumber
          ? 1
          : a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex,
    );
  },
};
