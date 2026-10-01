import type { Hex, PublicClient } from "viem";

/** Drain every sibling before allowing another stage or signing to begin. */
export async function settleChecks<T extends readonly unknown[]>(checks: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  const results = await Promise.allSettled(checks);
  for (const result of results) if (result.status === "rejected") throw result.reason;
  return results.map(result => (result as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

/** Complete the entire candidate set with bounded parallelism; never race to buy. */
export async function mapBounded<T, R>(items: readonly T[], concurrency: number, run: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw Error("Invalid concurrency");
  let cursor = 0;
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try { results[index] = { status: "fulfilled", value: await run(items[index]!) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  }));
  return results;
}

/** Identical block reads share work only inside one stage, never across actions. */
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
        if (block.number === null || block.hash === null) throw Error("Canonical block missing");
        return block as typeof block & { number: bigint; hash: Hex };
      })();
      cache.set(key, pending);
    }
    return pending;
  }
}

export function pollDelay(intervalMs: number, elapsedMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || !Number.isFinite(elapsedMs) || elapsedMs < 0) throw Error("Invalid polling interval");
  return Math.max(100, intervalMs - elapsedMs);
}

/** Chunk long Retry-After values rather than overflowing Node's timers. */
export function scheduleAfter(milliseconds: number, callback: () => void): () => void {
  if (!Number.isSafeInteger(Math.ceil(milliseconds)) || milliseconds < 0) throw Error("Invalid wait");
  let remaining = Math.ceil(milliseconds);
  let cancelled = false;
  let timer: NodeJS.Timeout;
  const next = () => {
    const chunk = Math.min(60_000, remaining);
    timer = setTimeout(() => {
      if (cancelled) return;
      remaining -= chunk;
      if (remaining > 0) next(); else callback();
    }, chunk);
  };
  next();
  return () => { cancelled = true; clearTimeout(timer); };
}
