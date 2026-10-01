import { setTimeout as sleep } from "node:timers/promises";
export class NetworkReadError extends Error {
  constructor(readonly code: "rpc_head_unavailable" | "rpc_anchor_unavailable" | "rpc_identity_unavailable" |
    "rpc_peer_head_lag" | "rpc_peer_unavailable" | "rpc_peer_hash_mismatch") { super(code); }
}
function blockMissing(error: unknown) {
  for (let i = 0; i < 6 && error && typeof error === "object"; i++) {
    if ("name" in error && ["BlockNotFoundError", "HeaderNotFoundError"].includes(String(error.name))) return true;
    error = "cause" in error ? error.cause : undefined;
  }
  return false;
}
/** A just-published head can reach the primary before the independent peer indexes it. */
export async function readPeerHead<T extends { number: bigint | null; hash: string | null }>(
  head: { number: bigint; hash: string }, read: () => Promise<T>, signal: AbortSignal,
  pause: (ms: number) => Promise<void> = ms => sleep(ms, undefined, { signal }),
): Promise<T> {
  const waits = [150, 300, 600];
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    let block: T;
    try { block = await read(); }
    catch (error) {
      if (!blockMissing(error)) throw new NetworkReadError("rpc_peer_unavailable");
      if (attempt >= waits.length) throw new NetworkReadError("rpc_peer_head_lag");
      await pause(waits[attempt]!); continue;
    }
    signal.throwIfAborted();
    if (block.number !== head.number || block.hash !== head.hash) throw new NetworkReadError("rpc_peer_hash_mismatch");
    return block;
  }
}
