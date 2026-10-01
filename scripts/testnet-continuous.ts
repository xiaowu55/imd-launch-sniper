import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { ApiLaunchError, type ResolvedApiLaunch } from "../src/api-launch.js";
import { ApiHttpError, fetchApiBaseline } from "../src/api-session.js";
import { eligibleHints, orderFreshCandidates } from "./testnet-watch-policy.js";
import { attemptConsumed, CONTINUOUS_FRESH_MS, journalConsumesAttempt, recentLaunch, retryDelay, safeRetryDeadline } from "./testnet-continuous-policy.js";
import { ContinuousHistory } from "./testnet-continuous-history.js";
import { runTestnetBuy } from "./testnet-buy.js";
import { actionableHints, nextPollDelay, settleRequired, TESTNET_POLL_INTERVAL_MS, waitForNextPoll } from "./testnet-poll.js";
import { reviewedProjectDeployments } from "../src/protocol-version.js";
import { startChainSignals, type ChainLaunchSignal } from "../src/chain-signals.js";
import { LaunchPreparation } from "../src/launch-preparation.js";
import { mapBounded } from "../src/execution-speed.js";
import type { LaunchHint } from "../src/launch-feed.js";
import { NetworkReadError, readPeerHead } from "./testnet-network.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIRECTORY = resolve(ROOT, "runtime/testnet/continuous");
const FILE = resolve(DIRECTORY, "monitor.json");
const STOP = resolve(DIRECTORY, "STOP");
const LOCK = resolve(DIRECTORY, "process.lock");
const client = createPublicClient({ chain: sepolia,
  transport: http("https://sepolia.rpc.sentio.xyz", { retryCount: 0, timeout: 10000 }) });
const peer = createPublicClient({ chain: sepolia,
  transport: http("https://ethereum-sepolia-rpc.publicnode.com", { retryCount: 0, timeout: 10000 }) });
// Keep the archive-capable resolver above. The log observer uses the pair
// whose current-block logs agreed in the 2026-10-01 read-only check.
const signalClient = createPublicClient({ chain: sepolia,
  transport: http("https://sepolia.gateway.tenderly.co", { retryCount: 0, timeout: 10000 }) });
const blockSchema = z.object({ number: z.string().regex(/^[1-9]\d*$/), hash: z.string().regex(/^0x[\da-f]{64}$/i) });
const discoverySchema = z.object({ launchId: z.uuid(), firstSeenAt: z.iso.datetime(),
  firstSeenHead: blockSchema, listCacheMaxAgeSeconds: z.number().nullable() });
const stateSchema = z.object({
  version: z.literal(2), mode: z.literal("continuous"), chainId: z.literal(11155111),
  pid: z.number().int(), phase: z.enum(["watching", "buying", "observing", "stopped", "blocked"]),
  startedAt: z.iso.datetime(), deadlineAt: z.null(), anchor: blockSchema,
  baselineLiveIds: z.array(z.uuid()), baselineCount: z.number().int(),
  polls: z.number().int().nonnegative(), errors: z.number().int().nonnegative(), consecutiveErrors: z.number().int().nonnegative(),
  lastCheckedAt: z.iso.datetime(), lastSuccessfulPollAt: z.iso.datetime(),
  nextRetryAt: z.iso.datetime().nullable(), cacheMaxAgeSeconds: z.number().nullable(),
  discoveries: z.record(z.string(), discoverySchema), skipped: z.record(z.string(), z.string()),
  attempted: z.boolean(), selectedLaunchId: z.uuid().optional(), purchasePhase: z.string().optional(),
  outcome: z.unknown().optional(), reason: z.string().optional(),
  pollIntervalMs: z.number().int().positive().optional(),
  lastPollTiming: z.object({ startedAt: z.iso.datetime(), cycleMs: z.number().nonnegative(),
    networkMs: z.number().nonnegative().optional(), apiMs: z.number().nonnegative().optional(),
    discoveryHeadMs: z.number().nonnegative().optional(), selectionMs: z.number().nonnegative().optional() }).optional(),
});
type State = z.infer<typeof stateSchema>;
const controller = new AbortController();
let stopped = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  stopped = true; controller.abort();
});
const stopping = () => stopped || existsSync(STOP);
function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) ||
    (process.getuid && stat.uid !== process.getuid())) throw Error("unsafe_directory");
}
function safeRead(path: string, maxBytes = 16000000): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes || (stat.mode & 0o077) ||
      (process.getuid && stat.uid !== process.getuid())) throw Error("unsafe_state");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}
function alive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function syncDirectory() {
  const fd = openSync(DIRECTORY, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function save(name: string, value: unknown) {
  const temp = resolve(DIRECTORY, `${name}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600); writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd);
    closeSync(fd); fd = undefined; renameSync(temp, resolve(DIRECTORY, name)); syncDirectory();
  } finally { if (fd !== undefined) closeSync(fd); if (existsSync(temp)) unlinkSync(temp); }
}
function log(event: string, details: unknown) {
  const at = new Date().toISOString();
  const line = JSON.stringify({ at, event, details }) + "\n";
  const fd = openSync(resolve(DIRECTORY, "logs", `${at.slice(0, 10)}.jsonl`),
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, line); fsyncSync(fd); } finally { closeSync(fd); }
  if (event !== "poll") process.stdout.write(line);
}
function acquireLock() {
  // Serialize stale-lock recovery. Never reclaim this short-lived gate blindly:
  // a crash inside recovery requires inspection rather than racing another start.
  const gate = resolve(DIRECTORY, "startup.lock");
  const gateFd = openSync(gate, "wx", 0o600);
  try {
    writeFileSync(gateFd, JSON.stringify({ pid: process.pid })); fsyncSync(gateFd);
    if (existsSync(LOCK)) {
      const saved = safeRead(LOCK, 1024) as { pid?: number };
      if (typeof saved.pid !== "number" || alive(saved.pid)) throw Error("monitor_already_running");
      unlinkSync(LOCK);
    }
    const fd = openSync(LOCK, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory();
  } finally { closeSync(gateFd); unlinkSync(gate); syncDirectory(); }
}
function closeLock() {
  if (existsSync(LOCK) && (safeRead(LOCK, 1024) as { pid: number }).pid === process.pid) { unlinkSync(LOCK); syncDirectory(); }
}
function hasExecutionEvidence(directory: string) {
  const entryExists = (path: string) => {
    try { lstatSync(path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  };
  if (["observation.json", "attempt.json", "result.json", "execution.log"]
    .some((name) => entryExists(resolve(directory, name)))) return true;
  const journal = resolve(directory, "live/state.json");
  return entryExists(journal) && journalConsumesAttempt(safeRead(journal));
}
async function checkNetwork(anchor?: State["anchor"]) {
  const checkChain = async (endpoint: typeof client) => {
    const id = await endpoint.getChainId().catch(() => { throw new NetworkReadError("rpc_identity_unavailable"); });
    if (id !== 11155111) throw Error("fatal_wrong_chain");
  };
  const checkAnchor = async () => {
    if (anchor && (await client.getBlock({ blockNumber: BigInt(anchor.number) })
      .catch(() => { throw new NetworkReadError("rpc_anchor_unavailable"); })).hash !== anchor.hash)
      throw Error("fatal_anchor_reorg");
  };
  const [head] = await settleRequired([client.getBlock().catch(() => { throw new NetworkReadError("rpc_head_unavailable"); }),
    checkChain(client), checkChain(peer), checkAnchor()] as const);
  await readPeerHead(head, () => peer.getBlock({ blockNumber: head.number }), controller.signal);
  if (!recentLaunch(head.timestamp, head.timestamp, Date.now())) throw Error("stale_rpc_head");
  return head;
}
async function runBuy(id: string, resolvedLaunch: ResolvedApiLaunch<11155111>) {
  const fd = openSync(resolve(DIRECTORY, "execution.log"), "ax", 0o600);
  try {
    const result = await runTestnetBuy(["buy-continuous", id], {
      resolvedLaunch, signal: controller.signal,
      output: (value: unknown) => {
        writeFileSync(fd, JSON.stringify(value, (_, item) => typeof item === "bigint" ? String(item) : item) + "\n");
      },
    });
    return result.exitCode;
  } finally { fsyncSync(fd); closeSync(fd); }
}
async function main() {
  const [command = "start", ...rest] = process.argv.slice(2);
  if (rest.length || !["start", "status", "stop"].includes(command)) throw Error("invalid_command");
  if (command === "status") {
    if (!existsSync(FILE)) { console.log(JSON.stringify({ phase: "not_started", stopRequested: existsSync(STOP) })); return; }
    const state = stateSchema.parse(safeRead(FILE));
    console.log(JSON.stringify({ ...state, baselineLiveIds: undefined, excludedExistingLive: state.baselineLiveIds.length,
      alive: alive(state.pid), stopRequested: existsSync(STOP) }, null, 2)); return;
  }
  for (const path of [resolve(ROOT, "runtime"), resolve(ROOT, "runtime/testnet"), DIRECTORY, resolve(DIRECTORY, "logs")]) privateDirectory(path);
  if (command === "stop") {
    if (!existsSync(STOP)) { const fd = openSync(STOP, "wx", 0o600); try { writeFileSync(fd, new Date().toISOString()); fsyncSync(fd); } finally { closeSync(fd); } syncDirectory(); }
    console.log(JSON.stringify({ stopRequested: true, message: "STOP persisted. No new signatures/broadcasts are permitted; submitted transactions remain on chain." })); return;
  }
  if (existsSync(STOP)) { console.log(JSON.stringify({ phase: "stopped", message: "Explicit STOP remains in place." })); return; }
  acquireLock();
  let state: State | undefined;
  let chainSignals: ReturnType<typeof startChainSignals> | undefined;
  let drainPreparations = async () => {};
  try {
    const history = new ContinuousHistory(resolve(DIRECTORY, "history"));
    if (existsSync(FILE)) {
      state = stateSchema.parse(safeRead(FILE));
      if (state.phase === "blocked") { log("blocked", { reason: state.reason }); return; }
      state.attempted = attemptConsumed(state, hasExecutionEvidence(DIRECTORY)) || hasExecutionEvidence(resolve(ROOT, "runtime/testnet/fresh"));
      state.pid = process.pid;
      state.phase = state.attempted ? "observing" : "watching";
      if (state.attempted && !state.purchasePhase) state.purchasePhase = "recovery_required";
      state = history.compact(state, Date.now());
      save("monitor.json", state); log("resumed", { anchor: state.anchor, attempted: state.attempted });
    } else {
      let failures = 0;
      while (!stopping() && !state) {
        try {
          const [baseline] = await settleRequired([fetchApiBaseline(controller.signal), checkNetwork()] as const);
          const head = await checkNetwork();
          const at = new Date().toISOString();
          const attempted = hasExecutionEvidence(DIRECTORY) || hasExecutionEvidence(resolve(ROOT, "runtime/testnet/fresh"));
          state = { version: 2, mode: "continuous", chainId: 11155111, pid: process.pid,
            phase: attempted ? "observing" : "watching", startedAt: at, deadlineAt: null,
            anchor: { number: String(head.number), hash: head.hash },
            baselineLiveIds: baseline.launches.filter((hint) => hint.chainId === 11155111 && hint.status === "live").map((hint) => hint.id),
            baselineCount: baseline.launches.length, polls: 0, errors: failures, consecutiveErrors: 0,
            lastCheckedAt: at, lastSuccessfulPollAt: at, nextRetryAt: null, cacheMaxAgeSeconds: baseline.cacheMaxAgeSeconds,
            discoveries: {}, skipped: {}, attempted,
            ...(attempted ? { purchasePhase: "prior_attempt_review_required" } : {}) };
          save("monitor.json", state); log("started", { anchor: state.anchor, excludedExistingLive: state.baselineLiveIds.length, attempted, deadlineAt: null });
        } catch (error) {
          if (stopping()) break;
          if (error instanceof Error && error.message.startsWith("fatal_")) throw error;
          failures++;
          const pause = error instanceof ApiHttpError && error.retryAfterMs !== null
            ? Math.max(retryDelay(failures), error.retryAfterMs) : retryDelay(failures);
          log("connection_retry", { failures, retryInMs: pause });
          await waitForNextPoll(pause, controller.signal).catch(() => {});
        }
      }
    }
    if (!state) return;
    state.pollIntervalMs = TESTNET_POLL_INTERVAL_MS;
    save("monitor.json", state);
    if (state.nextRetryAt && Date.parse(state.nextRetryAt) > Date.now())
      await waitForNextPoll(Date.parse(state.nextRetryAt) - Date.now(), controller.signal).catch(() => {});
    const excluded = new Set(state.baselineLiveIds);
    const currentCandidates = (rows: Parameters<typeof eligibleHints>[0]) =>
      eligibleHints(rows, excluded, new Set(Object.keys(state!.skipped)))
        .filter((hint) => !history.historyExists(hint.id));
    const preparations = new LaunchPreparation(client, 11155111, controller.signal);
    drainPreparations = () => preparations.settle();
    const identities = new Map<number, LaunchHint>();
    const recentSignals = new Map<number, ChainLaunchSignal>();
    const primed = new Set<string>();
    let previousLive = new Map<string, string>();
    let wakeVersion = 0;
    let wakeSleep: AbortController | undefined;
    let apiCooldownUntil = 0;
    const persistApiCooldown = (delayMs: number) => {
      try {
        const deadline = safeRetryDeadline(delayMs, Date.now());
        apiCooldownUntil = Math.max(apiCooldownUntil, Date.parse(deadline));
        preparations.defer(delayMs);
        state!.nextRetryAt = new Date(apiCooldownUntil).toISOString();
        save("monitor.json", state);
      } catch {
        // An unrepresentable server deadline must not become an immediate
        // request after a timer overflow or a supervisor restart.
        state!.phase = "blocked"; state!.reason = "fatal_api_cooldown_unrepresentable";
        save("monitor.json", state); log("blocked", { reason: state!.reason });
        stopped = true; controller.abort();
      }
    };
    const prime = (event: ChainLaunchSignal) => {
      if (stopping() || state!.attempted || apiCooldownUntil > Date.now() || event.removed || event.blockNumber <= BigInt(state!.anchor.number)) return;
      const hint = identities.get(event.launchNumber);
      if (!hint || hint.chainId !== 11155111 || excluded.has(hint.id) || state!.skipped[hint.id] || history.historyExists(hint.id)) return;
      const key = `${hint.id}:${event.transactionHash}:${event.blockHash}`;
      if (primed.has(key)) return;
      primed.add(key); while (primed.size > 256) primed.delete(primed.values().next().value!);
      void preparations.prepare(hint.id).then(launch => {
        log("chain_preparation_ready", { launchId: hint.id, launchNumber: launch.candidate.launchNumber,
          launchBlock: String(launch.candidate.blockNumber), signalMatches: launch.candidate.launchTxHash === event.transactionHash });
      }).catch(error => {
        if (error instanceof ApiLaunchError && error.retryAfterMs !== null)
          persistApiCooldown(error.retryAfterMs);
        if (!stopping()) log("chain_preparation_waiting", { launchId: hint.id,
          code: error instanceof ApiLaunchError ? error.code : "preparation_unavailable" });
      });
    };
    const updateIdentities = (rows: LaunchHint[]) => {
      const live = new Map(currentCandidates(rows).map(h => [h.id, JSON.stringify(h)]));
      if ([...previousLive].some(([id, value]) => live.get(id) !== value)) preparations.clear();
      previousLive = live; identities.clear();
      for (const row of rows) if (row.chainId === 11155111) identities.set(row.launchNumber, row);
      for (const hint of recentSignals.values()) prime(hint);
    };
    const registries = reviewedProjectDeployments(11155111).map(d => d.registry);
    if (registries.length) {
      const fingerprint = createHash("sha256").update(JSON.stringify(registries)).digest("hex");
      const chainFile = resolve(DIRECTORY, "chain-watch.json");
      const schema = z.object({ version: z.literal(1), chainId: z.literal(11155111), fingerprint: z.string(),
        startedAt: z.iso.datetime(), anchor: blockSchema, cursor: blockSchema });
      let saved = existsSync(chainFile) ? schema.parse(safeRead(chainFile)) : undefined;
      if (!saved || saved.fingerprint !== fingerprint) {
        // This already-spent session starts new latency observations now; an
        // unspent session replays its complete original observation interval.
        const head = state.attempted ? await checkNetwork(state.anchor) : null;
        const anchor = head ? { number: String(head.number), hash: head.hash } : state.anchor;
        saved = { version: 1, chainId: 11155111, fingerprint, startedAt: new Date().toISOString(), anchor, cursor: anchor };
        save("chain-watch.json", saved);
      }
      const chainState = saved;
      chainSignals = startChainSignals({ chainId: 11155111, client: signalClient, peer, registries,
        startAfter: { number: BigInt(chainState.anchor.number), hash: chainState.anchor.hash as `0x${string}` },
        cursor: { number: BigInt(chainState.cursor.number), hash: chainState.cursor.hash as `0x${string}` },
        // dRPC's public Sepolia WS now requires a paid plan (live check 2026-10-01).
        // PublicNode WS is backed by the independent two-provider HTTP replay.
        wsUrls: ["wss://ethereum-sepolia-rpc.publicnode.com"], signal: controller.signal,
        onSignal: event => {
          log("chain_launch_signal", { ...event, blockNumber: String(event.blockNumber), tradingAuthorization: false });
          if (event.removed) { recentSignals.delete(event.launchNumber); preparations.clear(); }
          else {
            if (!recentSignals.has(event.launchNumber)) recentSignals.set(event.launchNumber, event);
            while (recentSignals.size > 512) recentSignals.delete(recentSignals.keys().next().value!);
            prime(event);
          }
          wakeVersion++; wakeSleep?.abort();
        },
        onCursor: cursor => { chainState.cursor = { number: String(cursor.number), hash: cursor.hash }; save("chain-watch.json", chainState); },
        onEvent: (event, details) => {
          if (event === "chain_signal_reorg") { preparations.clear(); recentSignals.clear(); }
          log(event, details);
        },
      });
      void chainSignals.ready.catch(() => {});
    }
    while (!stopping()) {
      const cycleStart = performance.now();
      const cycleWakeVersion = wakeVersion;
      const timings: NonNullable<State["lastPollTiming"]> = { startedAt: new Date().toISOString(), cycleMs: 0 };
      const apiRequests: unknown[] = [];
      const measure = async <T>(key: "networkMs" | "apiMs" | "discoveryHeadMs" | "selectionMs", work: () => Promise<T>) => {
        const started = performance.now();
        try { return await work(); }
        finally { timings[key] = Math.round((performance.now() - started) * 100) / 100; }
      };
      const readSnapshot = () => {
        if (apiCooldownUntil > Date.now()) throw new ApiHttpError(429, Math.ceil(apiCooldownUntil - Date.now()));
        return fetchApiBaseline(controller.signal, fetch, { onTiming: (timing) => { apiRequests.push(timing); } })
          .catch(error => {
            // Record server backoff at response time, before a slow sibling
            // RPC finishes; WS preparation shares this same cooldown.
            if (error instanceof ApiHttpError && error.retryAfterMs !== null) persistApiCooldown(error.retryAfterMs);
            throw error;
          });
      };
      let pause: number | undefined;
      try {
        state = history.compact(state, Date.now());
        const [snapshot, head] = await settleRequired([
          measure("apiMs", readSnapshot), measure("networkMs", () => checkNetwork(state!.anchor)),
        ] as const);
        state.polls++; state.lastCheckedAt = snapshot.checkedAt; state.lastSuccessfulPollAt = snapshot.checkedAt;
        state.cacheMaxAgeSeconds = snapshot.cacheMaxAgeSeconds;
        updateIdentities(snapshot.launches);
        const candidates = actionableHints(currentCandidates(snapshot.launches), state);
        if (candidates.length) {
          const seenHead = await measure("discoveryHeadMs", () => checkNetwork(state!.anchor));
          for (const hint of candidates) if (!state.discoveries[hint.id]) {
            state.discoveries[hint.id] = { launchId: hint.id, firstSeenAt: snapshot.checkedAt,
              firstSeenHead: { number: String(seenHead.number), hash: seenHead.hash }, listCacheMaxAgeSeconds: snapshot.cacheMaxAgeSeconds };
            log("new_api_live", state.discoveries[hint.id]);
            const chainSeen = recentSignals.get(hint.launchNumber);
            if (chainSeen && !chainSeen.removed) log("chain_api_comparison", {
              launchId: hint.id, launchNumber: hint.launchNumber, chainObservedAt: chainSeen.observedAt,
              apiObservedAt: snapshot.checkedAt, apiMinusChainMs: Date.parse(snapshot.checkedAt) - Date.parse(chainSeen.observedAt),
              chainSource: chainSeen.source, chainBlock: String(chainSeen.blockNumber),
            });
          }
          save("monitor.json", state);
          const selectionStart = performance.now();
          const resolved: Array<{ id: string; launch: ResolvedApiLaunch<11155111> }> = [];
          let unresolved = false;
          const prepared = !state.attempted ? await mapBounded(candidates, 2, async hint => {
            if (stopping()) return;
            const discovery = state!.discoveries[hint.id]!;
            if (Date.now() >= Date.parse(discovery.firstSeenAt) + CONTINUOUS_FRESH_MS) { state!.skipped[hint.id] = "discovery_expired"; return; }
            try {
              const launch = await preparations.prepare(hint.id);
              if (launch.detail.id !== hint.id || launch.candidate.launchNumber !== hint.launchNumber ||
                  (hint.token && launch.candidate.token.toLowerCase() !== hint.token.toLowerCase()))
                throw new ApiLaunchError("candidate_identity_changed", "Launch identity changed during preparation", false);
              const launchBlock = await client.getBlock({ blockNumber: launch.candidate.blockNumber });
              if (launch.candidate.blockNumber <= BigInt(state!.anchor.number)) state!.skipped[hint.id] = "deployed_before_observation";
              else if (!recentLaunch(launchBlock.timestamp, seenHead.timestamp, Date.now())) state!.skipped[hint.id] = "launch_older_than_120_seconds";
              else resolved.push({ id: hint.id, launch });
            } catch (error) {
              if (error instanceof ApiLaunchError && error.retryAfterMs !== undefined && error.retryAfterMs !== null) throw error;
              if (error instanceof ApiLaunchError && !error.retryable) state!.skipped[hint.id] = error.code;
              else unresolved = true;
            }
          }) : [];
          const failures = prepared.filter((r): r is PromiseRejectedResult => r.status === "rejected");
          if (failures.length) {
            const cooldown = failures.map(r => r.reason).filter((e): e is ApiLaunchError => e instanceof ApiLaunchError && e.retryAfterMs !== null)
              .sort((a, b) => b.retryAfterMs! - a.retryAfterMs!)[0];
            throw cooldown ?? failures[0]!.reason;
          }
          if (!state.attempted && !unresolved && resolved.length && !stopping()) {
            const refreshed = await readSnapshot();
            const fingerprint = (rows: typeof snapshot.launches) => JSON.stringify(currentCandidates(rows).map((row) => JSON.stringify(row)).sort());
            if (fingerprint(refreshed.launches) === fingerprint(snapshot.launches)) {
              const first = orderFreshCandidates(resolved.map((row) => row.launch.candidate), BigInt(state.anchor.number))[0]!;
              const selected = resolved.find((row) => row.launch.candidate.id === first.id)!;
              const discovery = state.discoveries[selected.id]!;
              const deadlineAt = new Date(Date.parse(discovery.firstSeenAt) + CONTINUOUS_FRESH_MS).toISOString();
              if (Date.now() < Date.parse(deadlineAt)) {
                // Persist budget consumption BEFORE execution; never reopen it on restart.
                state.attempted = true; state.phase = "buying"; state.selectedLaunchId = selected.id;
                state.purchasePhase = "selected"; save("monitor.json", state);
                save("observation.json", { version: 2, mode: "continuous", chainId: 11155111,
                  startedAt: state.startedAt, deadlineAt, anchor: state.anchor, baselineLiveIds: state.baselineLiveIds,
                  selectionLiveIds: refreshed.launches.filter((row) => row.chainId === 11155111 && row.status === "live").map((row) => row.id), discovery });
                timings.selectionMs = Math.round((performance.now() - selectionStart) * 100) / 100;
                log("purchase_selected", { id: selected.id, launchBlock: String(first.blockNumber), deadlineAt,
                  timing: { ...timings }, execution: "in_process_verified_launch" });
                let exitCode: number | null = null;
                try { exitCode = await runBuy(selected.id, selected.launch); } catch { state.reason = "execution_process_failed"; }
                const journalPath = resolve(DIRECTORY, "live/state.json");
                const journal = existsSync(journalPath) ? safeRead(journalPath) as { phase: string; txHash?: string } : null;
                state.purchasePhase = journal?.phase ?? "failed_before_journal";
                state.outcome = existsSync(resolve(DIRECTORY, "result.json")) ? safeRead(resolve(DIRECTORY, "result.json")) : { exitCode, journal };
                state.phase = "observing"; save("monitor.json", state);
                log("purchase_finished", { purchasePhase: state.purchasePhase, outcome: state.outcome });
              }
            }
          }
        }
        state.consecutiveErrors = 0; state.nextRetryAt = null;
        timings.cycleMs = Math.round((performance.now() - cycleStart) * 100) / 100;
        state.lastPollTiming = timings;
        log("poll", { polls: state.polls, head: String(head.number), apiRows: snapshot.launches.length,
          newLiveCandidates: candidates.length, purchaseAttempted: state.attempted,
          pollIntervalMs: TESTNET_POLL_INTERVAL_MS, timing: timings, apiRequests });
      } catch (error) {
        if (state.phase === "buying") { state.attempted = true; state.phase = "observing"; state.purchasePhase = "uncertain"; state.reason = "execution_outcome_requires_review"; }
        if (stopping()) break;
        state.errors++; state.consecutiveErrors++; state.lastCheckedAt = new Date().toISOString();
        if (error instanceof Error && error.message.startsWith("fatal_")) { state.phase = "blocked"; state.reason = error.message; save("monitor.json", state); log("blocked", { reason: state.reason }); return; }
        pause = error instanceof NetworkReadError && error.code === "rpc_peer_head_lag" && state.consecutiveErrors <= 2
          ? 1000 : retryDelay(state.consecutiveErrors);
        if ((error instanceof ApiHttpError || error instanceof ApiLaunchError) && error.retryAfterMs != null)
          { pause = Math.max(pause, error.retryAfterMs); persistApiCooldown(error.retryAfterMs); }
        if (stopping()) break;
        state.nextRetryAt = safeRetryDeadline(pause, Date.now());
        timings.cycleMs = Math.round((performance.now() - cycleStart) * 100) / 100;
        state.lastPollTiming = timings;
        log("retry", { consecutiveErrors: state.consecutiveErrors, nextRetryAt: state.nextRetryAt,
          reason: error instanceof NetworkReadError ? error.code : error instanceof ApiHttpError ? "api_http_error" :
            error instanceof ApiLaunchError ? error.code : error instanceof Error && error.message === "stale_rpc_head" ? "stale_rpc_head" : "read_or_validation_error",
          ...(error instanceof ApiHttpError ? { httpStatus: error.status, retryAfterMs: error.retryAfterMs } : {}),
          ...(error instanceof ApiLaunchError ? { code: error.code, retryAfterMs: error.retryAfterMs } : {}),
          timing: timings, apiRequests });
      }
      // Cache freshness is metadata, not a mandatory extra sleep. Never overlap
      // cycles; slow responses extend this cadence and 429/503 backoff wins.
      if (apiCooldownUntil > Date.now()) {
        pause = Math.max(pause ?? 0, apiCooldownUntil - Date.now());
        state.nextRetryAt = new Date(Date.now() + pause).toISOString();
      }
      save("monitor.json", state);
      if (!stopping()) {
        if (pause !== undefined) await waitForNextPoll(pause, controller.signal).catch(() => {});
        else {
          wakeSleep = new AbortController();
          await waitForNextPoll(wakeVersion !== cycleWakeVersion ? Math.max(100, 500 - (performance.now() - cycleStart)) :
            nextPollDelay(performance.now() - cycleStart), AbortSignal.any([controller.signal, wakeSleep.signal])).catch(() => {});
          wakeSleep = undefined;
        }
      }
    }
    if (state.phase !== "blocked") {
      state.phase = "stopped"; state.lastCheckedAt = new Date().toISOString(); save("monitor.json", state); log("stopped", { attempted: state.attempted });
    }
  } finally { stopped = true; controller.abort(); await chainSignals?.stop(); await drainPreparations(); closeLock(); }
}
main().catch(() => { console.error(JSON.stringify({ event: "continuous_error", at: new Date().toISOString(), message: "Inspect persisted state and private directory permissions; never reset an attempted transaction." })); process.exitCode = 1; });
