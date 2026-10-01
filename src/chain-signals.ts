import { decodeEventLog, hexToString, keccak256, type Address, type Hex, type PublicClient } from "viem";
import { registryAbi } from "./discovery.js";

export type ChainCursor = { number: bigint; hash: Hex };
export type RegistryIdentity = { address: Address; codeHash: Hex };
export type ChainLaunchSignal = Readonly<{
  chainId: number; launchNumber: number; kind: string; sourceCommit: Hex; attestationHash: Hex;
  transactionHash: Hex; blockNumber: bigint; blockHash: Hex; transactionIndex: number; logIndex: number;
  registry: Address; observedAt: string; observedMonotonicMs: number;
  source: "ws" | "http"; removed: boolean; canonical: boolean;
}>;
type Rpc = Pick<PublicClient, "getBlock" | "getLogs" | "getCode" | "getChainId">;
export type ChainSignalOptions = {
  chainId: number; client: Rpc; peer: Rpc; registries: readonly RegistryIdentity[];
  startAfter: ChainCursor; cursor?: ChainCursor; wsUrls?: readonly string[]; signal?: AbortSignal;
  pollIntervalMs?: number;
  onSignal: (event: ChainLaunchSignal) => void | Promise<void>;
  onCursor?: (cursor: ChainCursor) => void | Promise<void>;
  onEvent?: (event: string, details: Record<string, unknown>) => void;
  socketFactory?: (url: string) => WebSocket;
};
const HASH = /^0x[\da-f]{64}$/i;
const ADDRESS = /^0x[\da-f]{40}$/i;
function quantity(value: unknown): bigint {
  if (typeof value === "bigint" && value >= 0n && value < 2n ** 64n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^0x[\da-f]{1,16}$/i.test(value)) return BigInt(value);
  throw Error("chain_signal_invalid_quantity");
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// Some providers publish the block before their log index catches up. Match
// only this observed InvalidInputRpcError, never a generic RPC/network error.
function indexingLag(error: unknown, requestedBlock: bigint): boolean {
  const visited = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth++) {
    if (visited.has(current)) return false;
    visited.add(current);
    const value = current as { name?: unknown; details?: unknown; cause?: unknown };
    if (value.name === "InvalidInputRpcError" && typeof value.details === "string" && value.details.length <= 256) {
      const match = /^block (\d{1,20}) is beyond the latest block (\d{1,20}) of this node, retry later$/.exec(value.details);
      if (match && BigInt(match[1]!) === requestedBlock && BigInt(match[2]!) < requestedBlock) return true;
    }
    current = value.cause;
  }
  return false;
}


/** Signals are observations only. They never replace the complete launch resolver or authorize a buy. */
export function decodeChainSignal(raw: unknown, options: {
  chainId: number; registries: readonly RegistryIdentity[]; source: "ws" | "http";
}): ChainLaunchSignal {
  if (!raw || typeof raw !== "object") throw Error("chain_signal_invalid_log");
  const log = raw as Record<string, unknown>;
  if (typeof log.address !== "string" || !options.registries.some(r => same(r.address, log.address as string)) ||
      typeof log.blockHash !== "string" || !HASH.test(log.blockHash) ||
      typeof log.transactionHash !== "string" || !HASH.test(log.transactionHash) ||
      typeof log.data !== "string" || !/^0x(?:[\da-f]{2})*$/i.test(log.data) || log.data.length > 131074 ||
      !Array.isArray(log.topics) || log.topics.length !== 3 || !log.topics.every(t => typeof t === "string" && HASH.test(t)) ||
      (log.removed !== undefined && typeof log.removed !== "boolean")) throw Error("chain_signal_invalid_log");
  const decoded = decodeEventLog({ abi: registryAbi, data: log.data as Hex,
    topics: log.topics as [Hex, ...Hex[]], strict: true });
  const launchNumber = Number(decoded.args.launchNumber);
  const kind = hexToString(decoded.args.kind, { size: 32 }).replace(/\0/g, "");
  const transactionIndex = Number(quantity(log.transactionIndex)), logIndex = Number(quantity(log.logIndex));
  if (!Number.isSafeInteger(launchNumber) || launchNumber < 1 || !Number.isSafeInteger(transactionIndex) ||
      !Number.isSafeInteger(logIndex) || !["evm_project", "univ4_hook", "custom_token"].includes(kind))
    throw Error("chain_signal_invalid_identity");
  return Object.freeze({ chainId: options.chainId, launchNumber, kind,
    sourceCommit: decoded.args.sourceCommit, attestationHash: decoded.args.attestationHash,
    registry: log.address.toLowerCase() as Address, blockNumber: quantity(log.blockNumber), blockHash: log.blockHash as Hex,
    transactionHash: log.transactionHash as Hex, transactionIndex, logIndex,
    source: options.source, removed: log.removed === true, canonical: false,
    observedAt: new Date().toISOString(), observedMonotonicMs: performance.now() });
}
export function chainSignalKey(event: ChainLaunchSignal): string {
  return `${event.chainId}:${event.blockHash.toLowerCase()}:${event.transactionHash.toLowerCase()}:${event.logIndex}`;
}
/** Preserve a later HTTP confirmation and every reorg removal, while suppressing duplicate WS delivery. */
export class ChainSignalDeduper {
  private seen = new Map<string, "observed" | "canonical" | "removed">();
  constructor(private readonly capacity = 4096) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw Error("invalid_signal_capacity");
  }
  accept(event: ChainLaunchSignal): boolean {
    const key = chainSignalKey(event), phase = event.removed ? "removed" : event.canonical ? "canonical" : "observed";
    const previous = this.seen.get(key);
    if (previous === phase || (previous === "canonical" && phase === "observed") ||
        (previous === "removed" && phase === "observed")) return false;
    this.seen.delete(key); this.seen.set(key, phase);
    while (this.seen.size > this.capacity) this.seen.delete(this.seen.keys().next().value!);
    return true;
  }
  clear() { this.seen.clear(); }
}

/** Owns one HTTP cursor and a bounded set of WS wakeups; all trading still uses the canonical resolver. */
export function startChainSignals(options: ChainSignalOptions): {
  ready: Promise<void>; stop: () => Promise<void>;
} {
  const registries = options.registries.map(r => Object.freeze({ ...r }));
  if (![1, 11155111].includes(options.chainId) || !registries.length || registries.length > 32 ||
      registries.some(r => !ADDRESS.test(r.address) || !HASH.test(r.codeHash)) ||
      new Set(registries.map(r => r.address.toLowerCase())).size !== registries.length ||
      options.startAfter.number < 0n || !HASH.test(options.startAfter.hash) ||
      (options.cursor && (options.cursor.number < options.startAfter.number || !HASH.test(options.cursor.hash))))
    throw Error("invalid_chain_signal_config");
  const interval = options.pollIntervalMs ?? 3000;
  if (!Number.isSafeInteger(interval) || interval < 100 || interval > 60000 || (options.wsUrls?.length ?? 0) > 3)
    throw Error("invalid_chain_signal_interval");
  for (const url of options.wsUrls ?? []) if (!["ws:", "wss:"].includes(new URL(url).protocol))
    throw Error("invalid_chain_signal_url");
  let stopped = options.signal?.aborted ?? false;
  let cursor: ChainCursor = { ...(options.cursor ?? options.startAfter) };
  const deduper = new ChainSignalDeduper();
  const sockets = new Set<WebSocket>();
  const socketCleanups = new Map<WebSocket, () => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const waiters = new Set<() => void>();
  let deliveries: Promise<void> = Promise.resolve();
  let queued = 0;
  const event = (name: string, detail: Record<string, unknown> = {}) => {
    try { options.onEvent?.(name, detail); } catch { /* Telemetry cannot change discovery. */ }
  };
  const wait = (ms: number) => new Promise<void>(resolve => {
    if (stopped) { resolve(); return; }
    const finish = () => { timers.delete(timer); waiters.delete(finish); resolve(); };
    const timer = setTimeout(finish, ms);
    timers.add(timer); waiters.add(finish);
  });
  const emit = async (hint: ChainLaunchSignal) => {
    if (stopped || hint.blockNumber <= options.startAfter.number) return;
    // Mark after successful durable delivery. A callback failure must not drop an HTTP replay.
    if (!deduper.accept(hint)) return;
    try { await options.onSignal(hint); }
    catch (error) { deduper.clear(); throw error; }
  };
  const enqueue = (hint: ChainLaunchSignal) => {
    if (queued >= 256 || stopped) { event("chain_signal_queue_full"); return; }
    queued++;
    deliveries = deliveries.then(() => emit(hint)).catch(() => event("chain_signal_delivery_error"))
      .finally(() => { queued--; });
  };
  const identity = async () => {
    const results = await Promise.allSettled([options.client, options.peer].map(async rpc => {
      if (await rpc.getChainId() !== options.chainId) throw Error("fatal_chain_signal_wrong_chain");
      const head = await rpc.getBlock();
      if (head.number === null || !head.hash) throw Error("chain_signal_head_unavailable");
      const results = await Promise.allSettled(registries.map(async contract => {
        const code = await rpc.getCode({ address: contract.address, blockNumber: head.number! });
        if (!code || keccak256(code).toLowerCase() !== contract.codeHash.toLowerCase())
          throw Error("fatal_chain_signal_registry_changed");
      }));
      for (const result of results) if (result.status === "rejected") throw result.reason;
    }));
    for (const result of results) if (result.status === "rejected") throw result.reason;
  };
  const checkedBlock = async (number: bigint) => {
    const results = await Promise.allSettled([options.client.getBlock({ blockNumber: number }), options.peer.getBlock({ blockNumber: number })]);
    for (const result of results) if (result.status === "rejected") throw Error("chain_signal_block_unavailable");
    const blocks = results.map(r => (r as PromiseFulfilledResult<Awaited<ReturnType<Rpc["getBlock"]>>>).value);
    if (blocks.some(b => b.number !== number || !b.hash) || blocks[0]!.hash !== blocks[1]!.hash)
      throw Error("chain_signal_peer_lag");
    return { number, hash: blocks[0]!.hash! };
  };
  const connect = (url: string, index: number, failures = 0) => {
    if (stopped) return;
    let socket: WebSocket;
    try { socket = (options.socketFactory ?? (address => new WebSocket(address)))(url); }
    catch { schedule(); return; }
    sockets.add(socket);
    let closed = false;
    let subscription: string | undefined;
    let chainVerified = false;
    let subscriptionRequested = false;
    let lastResponse = performance.now();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    function schedule() {
      if (stopped) return;
      const timer = setTimeout(() => { timers.delete(timer); connect(url, index, failures + 1); }, Math.min(30000, 1000 * 2 ** Math.min(failures, 5)));
      timers.add(timer);
    }
    function cleanup() {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (closeTimer) { clearTimeout(closeTimer); timers.delete(closeTimer); }
      sockets.delete(socket); socketCleanups.delete(socket);
      try { socket.close(); } catch { /* A failed handshake may already be closed. */ }
      schedule();
    }
    const send = (message: unknown) => {
      if (stopped || closed) return;
      try { socket.send(JSON.stringify(message)); } catch { cleanup(); }
    };
    socketCleanups.set(socket, cleanup);
    // A stalled CONNECTING socket may never emit open/error/close.
    closeTimer = setTimeout(() => { if (!subscription) cleanup(); }, 10000);
    timers.add(closeTimer);
    socket.addEventListener("open", () => {
      if (stopped || closed) { cleanup(); return; }
      send({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
      if (closed) return;
      heartbeat = setInterval(() => {
        if (performance.now() - lastResponse > 25000) { cleanup(); return; }
        if (socket.readyState === WebSocket.OPEN) send({ jsonrpc: "2.0", id: 3, method: "eth_blockNumber", params: [] });
      }, 15000);
    });
    socket.addEventListener("message", ({ data }) => {
      if (stopped || closed) return;
      try {
        if (typeof data !== "string" || data.length > 262144) throw Error("invalid_ws_message");
        const message = JSON.parse(data); lastResponse = performance.now();
        if ((message?.id === 1 || message?.id === 2) && Object.hasOwn(message, "error")) {
          const code = message.error?.code;
          event("chain_signal_ws_rpc_error", {
            provider: index, requestId: message.id,
            ...(Number.isSafeInteger(code) ? { code } : {}),
          });
          cleanup(); return;
        }
        if (message.id === 1) {
          if (quantity(message.result) !== BigInt(options.chainId)) { event("chain_signal_ws_wrong_chain", { provider: index }); cleanup(); return; }
          if (subscriptionRequested) return;
          chainVerified = true; subscriptionRequested = true;
          send({ jsonrpc: "2.0", id: 2, method: "eth_subscribe", params: ["logs", {
            address: registries.map(r => r.address), topics: ["0x" + keccak256(new TextEncoder().encode("LaunchRecorded(uint64,bytes32,bytes32,bytes32,address[],uint256[])" )).slice(2)],
          }] });
        } else if (message.id === 2) {
          if (!chainVerified || !subscriptionRequested) return;
          if (typeof message.result !== "string" || !message.result.length || message.result.length > 256) { cleanup(); return; }
          subscription = message.result; failures = 0;
          event("chain_signal_ws_subscribed", { provider: index });
        } else if (message.method === "eth_subscription" && subscription && message.params?.subscription === subscription) {
          enqueue(decodeChainSignal(message.params.result, { chainId: options.chainId, registries, source: "ws" }));
        }
      } catch { event("chain_signal_ws_invalid", { provider: index }); }
    });
    socket.addEventListener("error", () => { event("chain_signal_ws_error", { provider: index }); cleanup(); });
    socket.addEventListener("close", cleanup);
  };
  let readyResolve!: () => void, readyReject!: (reason: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // Keep a caller that attaches a handler after initialization from creating an unhandled rejection.
  void ready.catch(() => {});
  const halt = () => {
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const finish of waiters) finish();
    for (const cleanup of socketCleanups.values()) cleanup();
  };
  options.signal?.addEventListener("abort", halt, { once: true });
  const run = (async () => {
    try {
      if (stopped) { readyResolve(); return; }
      let setupFailures = 0;
      while (!stopped) {
        try {
          await identity();
          const anchor = await checkedBlock(options.startAfter.number);
          if (!same(anchor.hash, options.startAfter.hash)) throw Error("fatal_chain_signal_anchor_reorg");
          break;
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("fatal_")) throw error;
          event("chain_signal_setup_retry", { failures: ++setupFailures });
          await wait(Math.min(15000, 1000 * 2 ** Math.min(setupFailures - 1, 4)));
        }
      }
      if (stopped) { readyResolve(); return; }
      (options.wsUrls ?? []).forEach((url, index) => connect(url, index));
      readyResolve(); event("chain_signal_ready", { chainId: options.chainId, afterBlock: String(cursor.number), registries: registries.length });
      let failures = 0;
      while (!stopped) {
        let pause = interval;
        try {
          const current = await checkedBlock(cursor.number);
          if (!same(current.hash, cursor.hash)) {
            // Without a saved common-ancestor proof, an arbitrary 12-block rewind
            // could miss a deeper fork. Replay from the verified session anchor.
            const rewind = await checkedBlock(options.startAfter.number);
            if (!same(rewind.hash, options.startAfter.hash)) throw Error("fatal_chain_signal_anchor_reorg");
            if (stopped) break;
            await options.onCursor?.(rewind); cursor = rewind; deduper.clear();
            event("chain_signal_reorg", { rescanFrom: String(rewind.number + 1n) });
          }
          const head = await options.client.getBlock();
          if (head.number === null || head.number < cursor.number) throw Error("chain_signal_head_unavailable");
          if (head.number > cursor.number) {
            const to = head.number < cursor.number + 64n ? head.number : cursor.number + 64n;
            const end = await checkedBlock(to);
            const reads = await Promise.allSettled([options.client, options.peer].map(async (rpc, provider) => {
              const retryDelays = [150, 300, 600] as const;
              for (let attempt = 0; ; attempt++) {
                if (stopped) throw Error("chain_signal_stopped");
                try {
                  return await rpc.getLogs({ address: registries.map(r => r.address), event: registryAbi[0],
                    fromBlock: cursor.number + 1n, toBlock: to, strict: true });
                } catch (error) {
                  if (stopped || !indexingLag(error, to) || attempt >= retryDelays.length) throw error;
                  event("chain_signal_indexing_lag", { provider, attempt: attempt + 1 });
                  await wait(retryDelays[attempt]!);
                }
              }
            }));
            if (stopped) break;
            for (const read of reads) if (read.status === "rejected") throw Error("chain_signal_logs_unavailable");
            const [logs, peerLogs] = reads.map(r => (r as PromiseFulfilledResult<Awaited<ReturnType<Rpc["getLogs"]>>>).value);
            if (logs!.length > 2048 || peerLogs!.length > 2048) throw Error("chain_signal_log_limit");
            const fingerprint = (rows: typeof logs) => JSON.stringify(rows!.map(raw => {
              const hint = decodeChainSignal(raw, { chainId: options.chainId, registries, source: "http" });
              return JSON.stringify([String(hint.blockNumber), hint.blockHash.toLowerCase(), hint.transactionHash.toLowerCase(),
                hint.transactionIndex, hint.logIndex, hint.registry, hint.removed, raw.topics.map(t => t.toLowerCase()), raw.data.toLowerCase()]);
            }).sort());
            if (fingerprint(logs) !== fingerprint(peerLogs)) throw Error("chain_signal_log_mismatch");
            const hints = logs!.map(raw => decodeChainSignal(raw, { chainId: options.chainId, registries, source: "http" }));
            const blocks = new Map<bigint, ChainCursor>();
            for (const hint of hints) {
              if (hint.removed || hint.blockNumber <= cursor.number || hint.blockNumber > to) throw Error("chain_signal_log_range");
              if (!blocks.has(hint.blockNumber)) blocks.set(hint.blockNumber, await checkedBlock(hint.blockNumber));
              if (!same(blocks.get(hint.blockNumber)!.hash, hint.blockHash)) throw Error("chain_signal_log_reorg");
            }
            if (!same((await checkedBlock(to)).hash, end.hash)) throw Error("chain_signal_log_reorg");
            hints.sort((a, b) => a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 :
              a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex);
            for (const hint of hints) { if (stopped) break; await emit(Object.freeze({ ...hint, canonical: true })); }
            if (stopped) break;
            await options.onCursor?.(end); cursor = end;
            if (cursor.number < head.number) pause = 100;
          }
          failures = 0;
        } catch (error) {
          if (stopped) break;
          const code = error instanceof Error && /^(fatal_)?chain_signal_[a-z_]+$/.test(error.message) ? error.message : "chain_signal_rpc_error";
          event(code, { failures: ++failures, afterBlock: String(cursor.number) });
          if (code.startsWith("fatal_")) throw error;
          pause = Math.min(15000, 1000 * 2 ** Math.min(failures - 1, 4));
        }
        await wait(pause);
      }
    } catch (error) {
      readyReject(error); event("chain_signal_stopped_error", { detail: error instanceof Error && /^(fatal_)?chain_signal_[a-z_]+$/.test(error.message) ? error.message : "chain_signal_setup_failed" });
    } finally { halt(); options.signal?.removeEventListener("abort", halt); }
  })();
  return { ready, async stop() { halt(); await run; await deliveries; } };
}
