import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { ApiLaunchError, resolveApiLaunch, type ResolvedApiLaunch } from "../src/api-launch.js";
import { fetchApiBaseline } from "../src/api-session.js";
import { eligibleHints, orderFreshCandidates } from "./testnet-watch-policy.js";
import { attemptConsumed, CONTINUOUS_FRESH_MS, journalConsumesAttempt, recentLaunch, retryDelay } from "./testnet-continuous-policy.js";
import { ContinuousHistory } from "./testnet-continuous-history.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIRECTORY = resolve(ROOT, "runtime/testnet/continuous");
const FILE = resolve(DIRECTORY, "monitor.json");
const STOP = resolve(DIRECTORY, "STOP");
const LOCK = resolve(DIRECTORY, "process.lock");
const client = createPublicClient({ chain: sepolia,
  transport: http("https://sepolia.rpc.sentio.xyz", { retryCount: 0, timeout: 10000 }) });
const peer = createPublicClient({ chain: sepolia,
  transport: http("https://ethereum-sepolia-rpc.publicnode.com", { retryCount: 0, timeout: 10000 }) });
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
});
type State = z.infer<typeof stateSchema>;
const controller = new AbortController();
let child: ChildProcess | undefined;
let stopped = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  stopped = true; controller.abort(); child?.kill("SIGTERM");
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
  if ((await Promise.all([client.getChainId(), peer.getChainId()])).some((id) => id !== 11155111)) throw Error("fatal_wrong_chain");
  const head = await client.getBlock();
  if ((await peer.getBlock({ blockNumber: head.number })).hash !== head.hash) throw Error("head_mismatch");
  if (!recentLaunch(head.timestamp, head.timestamp, Date.now())) throw Error("stale_rpc_head");
  if (anchor && (await client.getBlock({ blockNumber: BigInt(anchor.number) })).hash !== anchor.hash) throw Error("fatal_anchor_reorg");
  return head;
}
async function runBuy(id: string) {
  const fd = openSync(resolve(DIRECTORY, "execution.log"), "ax", 0o600);
  try {
    child = spawn(process.execPath, ["--import", "tsx", resolve(ROOT, "scripts/testnet-buy.ts"), "buy-continuous", id],
      { cwd: ROOT, stdio: ["ignore", fd, fd], env: { ...process.env, TRADING_PRIVATE_KEY: "" } });
    return await new Promise<number | null>((resolveExit, reject) => {
      child!.once("error", reject); child!.once("exit", resolveExit);
    });
  } finally { closeSync(fd); child = undefined; }
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
          await checkNetwork();
          const baseline = await fetchApiBaseline(controller.signal);
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
          failures++; log("connection_retry", { failures, retryInMs: retryDelay(failures) });
          await delay(retryDelay(failures), undefined, { signal: controller.signal }).catch(() => {});
        }
      }
    }
    if (!state) return;
    const excluded = new Set(state.baselineLiveIds);
    const currentCandidates = (rows: Parameters<typeof eligibleHints>[0]) =>
      eligibleHints(rows, excluded, new Set(Object.keys(state!.skipped)))
        .filter((hint) => !history.historyExists(hint.id));
    while (!stopping()) {
      let pause = Math.max(1000, (state.cacheMaxAgeSeconds ?? 5) * 1000);
      try {
        state = history.compact(state, Date.now());
        const head = await checkNetwork(state.anchor);
        const snapshot = await fetchApiBaseline(controller.signal);
        state.polls++; state.lastCheckedAt = snapshot.checkedAt; state.lastSuccessfulPollAt = snapshot.checkedAt;
        state.cacheMaxAgeSeconds = snapshot.cacheMaxAgeSeconds;
        pause = Math.max(1000, (snapshot.cacheMaxAgeSeconds ?? 5) * 1000);
        const candidates = currentCandidates(snapshot.launches);
        if (candidates.length) {
          const seenHead = await checkNetwork(state.anchor);
          for (const hint of candidates) if (!state.discoveries[hint.id]) {
            state.discoveries[hint.id] = { launchId: hint.id, firstSeenAt: snapshot.checkedAt,
              firstSeenHead: { number: String(seenHead.number), hash: seenHead.hash }, listCacheMaxAgeSeconds: snapshot.cacheMaxAgeSeconds };
            log("new_api_live", state.discoveries[hint.id]);
          }
          save("monitor.json", state);
          const resolved: Array<{ id: string; launch: ResolvedApiLaunch<11155111> }> = [];
          let unresolved = false;
          if (!state.attempted) for (const hint of candidates) {
            if (stopping()) break;
            const discovery = state.discoveries[hint.id]!;
            if (Date.now() >= Date.parse(discovery.firstSeenAt) + CONTINUOUS_FRESH_MS) { state.skipped[hint.id] = "discovery_expired"; continue; }
            try {
              const launch = await resolveApiLaunch(hint.id, client, { chainId: 11155111, signal: controller.signal });
              const launchBlock = await client.getBlock({ blockNumber: launch.candidate.blockNumber });
              if (launch.candidate.blockNumber <= BigInt(state.anchor.number)) state.skipped[hint.id] = "deployed_before_observation";
              else if (!recentLaunch(launchBlock.timestamp, seenHead.timestamp, Date.now())) state.skipped[hint.id] = "launch_older_than_120_seconds";
              else resolved.push({ id: hint.id, launch });
            } catch (error) {
              if (error instanceof ApiLaunchError && !error.retryable) state.skipped[hint.id] = error.code;
              else unresolved = true;
            }
          }
          if (!state.attempted && !unresolved && resolved.length && !stopping()) {
            const refreshed = await fetchApiBaseline(controller.signal);
            const fingerprint = (rows: typeof snapshot.launches) => JSON.stringify(currentCandidates(rows).map((row) => JSON.stringify(row)).sort());
            if (fingerprint(refreshed.launches) === fingerprint(snapshot.launches)) {
              const first = orderFreshCandidates(resolved.map((row) => row.launch.candidate), BigInt(state.anchor.number))[0]!;
              const selected = resolved.find((row) => row.launch.candidate.id === first.id)!;
              const discovery = state.discoveries[selected.id]!;
              const deadlineAt = new Date(Date.parse(discovery.firstSeenAt) + CONTINUOUS_FRESH_MS).toISOString();
              if (Date.now() < Date.parse(deadlineAt)) {
                // Persist budget consumption BEFORE the child can start; never reopen it on restart.
                state.attempted = true; state.phase = "buying"; state.selectedLaunchId = selected.id;
                state.purchasePhase = "selected"; save("monitor.json", state);
                save("observation.json", { version: 2, mode: "continuous", chainId: 11155111,
                  startedAt: state.startedAt, deadlineAt, anchor: state.anchor, baselineLiveIds: state.baselineLiveIds,
                  selectionLiveIds: refreshed.launches.filter((row) => row.chainId === 11155111 && row.status === "live").map((row) => row.id), discovery });
                log("purchase_selected", { id: selected.id, launchBlock: String(first.blockNumber), deadlineAt });
                let exitCode: number | null = null;
                try { exitCode = await runBuy(selected.id); } catch { state.reason = "execution_process_failed"; }
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
        log("poll", { polls: state.polls, head: String(head.number), apiRows: snapshot.launches.length,
          newLiveCandidates: candidates.length, purchaseAttempted: state.attempted });
      } catch (error) {
        if (state.phase === "buying") { state.attempted = true; state.phase = "observing"; state.purchasePhase = "uncertain"; state.reason = "execution_outcome_requires_review"; }
        if (stopping()) break;
        state.errors++; state.consecutiveErrors++; state.lastCheckedAt = new Date().toISOString();
        if (error instanceof Error && error.message.startsWith("fatal_")) { state.phase = "blocked"; state.reason = error.message; save("monitor.json", state); log("blocked", { reason: state.reason }); return; }
        pause = retryDelay(state.consecutiveErrors); state.nextRetryAt = new Date(Date.now() + pause).toISOString();
        log("retry", { consecutiveErrors: state.consecutiveErrors, nextRetryAt: state.nextRetryAt });
      }
      save("monitor.json", state);
      if (!stopping()) await delay(pause, undefined, { signal: controller.signal }).catch(() => {});
    }
    state.phase = "stopped"; state.lastCheckedAt = new Date().toISOString(); save("monitor.json", state); log("stopped", { attempted: state.attempted });
  } finally { closeLock(); }
}
main().catch(() => { console.error(JSON.stringify({ event: "continuous_error", at: new Date().toISOString(), message: "Inspect persisted state and private directory permissions; never reset an attempted transaction." })); process.exitCode = 1; });
