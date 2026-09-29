import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createPublicClient, http, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { ApiLaunchError, resolveApiLaunch, type ResolvedApiLaunch } from "../src/api-launch.js";
import { fetchApiBaseline } from "../src/api-session.js";
import { Journal } from "../src/journal.js";
import { eligibleHints, orderFreshCandidates, WATCH_WINDOW_MS } from "./testnet-watch-policy.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIRECTORY = resolve(ROOT, "runtime/testnet/fresh");
const FILE = resolve(DIRECTORY, "monitor.json");
const client = createPublicClient({ chain: sepolia,
  transport: http("https://sepolia.rpc.sentio.xyz", { retryCount: 0, timeout: 10000 }) });
const crosscheck = createPublicClient({ chain: sepolia,
  transport: http("https://ethereum-sepolia-rpc.publicnode.com", { retryCount: 0, timeout: 10000 }) });
const controller = new AbortController();
let child: ChildProcess | undefined;
let stopRequested = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  stopRequested = true;
  controller.abort();
  child?.kill("SIGTERM");
});

type Discovery = { launchId: string; firstSeenAt: string;
  firstSeenHead: { number: string; hash: Hex }; listCacheMaxAgeSeconds: number | null };
type State = {
  version: 1; chainId: 11155111; pid: number;
  phase: "watching" | "buying" | "confirmed" | "failed" | "uncertain" | "expired" | "stopped";
  startedAt: string; deadlineAt: string; anchor: { number: string; hash: Hex };
  baselineLiveIds: string[]; baselineCount: number; polls: number; errors: number;
  lastCheckedAt: string; lastHead?: string; cacheMaxAgeSeconds: number | null;
  discoveries: Record<string, Discovery>; skipped: Record<string, string>;
  selectedLaunchId?: string; childPid?: number; outcome?: unknown; reason?: string;
};
function output(value: unknown) { console.log(JSON.stringify(value)); }
function ensurePrivate(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) ||
      (process.getuid && stat.uid !== process.getuid())) throw Error("unsafe_directory");
}
function save(name: string, value: unknown) {
  const path = resolve(DIRECTORY, name);
  const temp = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temp, path);
    const dir = openSync(DIRECTORY, "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { if (fd !== undefined) closeSync(fd); if (existsSync(temp)) unlinkSync(temp); }
}
async function runBuy(id: string): Promise<number | null> {
  const fd = openSync(resolve(DIRECTORY, "execution.log"), "ax", 0o600);
  try {
    child = spawn(process.execPath, ["--import", "tsx", resolve(ROOT, "scripts/testnet-buy.ts"), "buy-fresh", id],
      { cwd: ROOT, stdio: ["ignore", fd, fd], env: { ...process.env, TRADING_PRIVATE_KEY: "" } });
    return await new Promise((resolveExit, reject) => {
      child!.once("error", reject);
      child!.once("exit", (code) => resolveExit(code));
    });
  } finally { closeSync(fd); child = undefined; }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || ![undefined, "start", "status"].includes(args[0])) throw Error("invalid_command");
  if (args[0] === "status") {
    output(existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : { phase: "not_started" });
    return;
  }
  for (const path of [resolve(ROOT, "runtime"), resolve(ROOT, "runtime/testnet"), DIRECTORY]) ensurePrivate(path);
  const lock = new Journal(resolve(DIRECTORY, "monitor-lock")); lock.lock();
  let state: State | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A second invocation never moves the anchor/deadline or spends a second budget.
    if (existsSync(FILE) || existsSync(resolve(DIRECTORY, "observation.json")) ||
        existsSync(resolve(DIRECTORY, "live/state.json"))) throw Error("watch_already_started");
    const chainIds = await Promise.all([client.getChainId(), crosscheck.getChainId()]);
    if (chainIds.some((id) => id !== 11155111)) throw Error("wrong_chain");
    const baseline = await fetchApiBaseline(controller.signal);
    const head = await client.getBlock();
    if ((await crosscheck.getBlock({ blockNumber: head.number })).hash !== head.hash) throw Error("anchor_mismatch");
    if (stopRequested) return;
    const started = Date.now();
    const deadlineMonotonic = performance.now() + WATCH_WINDOW_MS;
    const inWindow = () => Date.now() < started + WATCH_WINDOW_MS && performance.now() < deadlineMonotonic;
    deadlineTimer = setTimeout(() => controller.abort(), WATCH_WINDOW_MS);
    state = { version: 1, chainId: 11155111, pid: process.pid, phase: "watching",
      startedAt: new Date(started).toISOString(), deadlineAt: new Date(started + WATCH_WINDOW_MS).toISOString(),
      anchor: { number: String(head.number), hash: head.hash },
      baselineLiveIds: baseline.launches.filter((row) => row.chainId === 11155111 && row.status === "live").map((row) => row.id),
      baselineCount: baseline.launches.length, polls: 0, errors: 0,
      lastCheckedAt: baseline.checkedAt, cacheMaxAgeSeconds: baseline.cacheMaxAgeSeconds,
      discoveries: {}, skipped: {} };
    save("monitor.json", state);
    output({ event: "watch_started", startedAt: state.startedAt, deadlineAt: state.deadlineAt,
      anchor: state.anchor, excludedExistingLive: state.baselineLiveIds.length,
      chainId: 11155111, singleBuyAmountTestEth: "0.0001", maxGasTestEth: "0.002" });
    const excluded = new Set(state.baselineLiveIds);
    let lastNotice = Date.now();
    let consecutiveErrors = 0;
    while (!stopRequested && inWindow()) {
      let pause = Math.max(1000, (state.cacheMaxAgeSeconds ?? 5) * 1000);
      try {
        const snapshot = await fetchApiBaseline(controller.signal);
        state.polls++; state.lastCheckedAt = snapshot.checkedAt;
        state.cacheMaxAgeSeconds = snapshot.cacheMaxAgeSeconds;
        pause = Math.max(1000, (snapshot.cacheMaxAgeSeconds ?? 5) * 1000);
        const candidates = eligibleHints(snapshot.launches, excluded, new Set(Object.keys(state.skipped)));
        if (candidates.length) {
          const seenHead = await client.getBlock();
          state.lastHead = String(seenHead.number);
          if ((await client.getBlock({ blockNumber: BigInt(state.anchor.number) })).hash !== state.anchor.hash)
            throw Error("anchor_reorg");
          for (const hint of candidates) state.discoveries[hint.id] ??= {
            launchId: hint.id, firstSeenAt: snapshot.checkedAt,
            firstSeenHead: { number: String(seenHead.number), hash: seenHead.hash },
            listCacheMaxAgeSeconds: snapshot.cacheMaxAgeSeconds,
          };
          save("monitor.json", state);
          const resolved: Array<{ id: string; launch: ResolvedApiLaunch<11155111> }> = [];
          let unresolved = false;
          // Bound RPC concurrency. A temporarily unresolved candidate blocks later buys.
          for (let offset = 0; offset < candidates.length; offset += 4) {
            if (stopRequested || !inWindow()) { unresolved = true; break; }
            const batch = candidates.slice(offset, offset + 4);
            const results = await Promise.allSettled(batch.map((hint) =>
              resolveApiLaunch(hint.id, client, { chainId: 11155111, signal: controller.signal })));
            results.forEach((result, index) => {
              const hint = batch[index]!;
              if (result.status === "fulfilled") {
                if (result.value.candidate.blockNumber <= BigInt(state!.anchor.number))
                  state!.skipped[hint.id] = "deployed_at_or_before_observation_anchor";
                else resolved.push({ id: hint.id, launch: result.value });
              } else if (result.reason instanceof ApiLaunchError && !result.reason.retryable)
                state!.skipped[hint.id] = result.reason.code;
              else unresolved = true;
            });
          }
          if (!unresolved && resolved.length && !stopRequested && inWindow()) {
            const refreshed = await fetchApiBaseline(controller.signal);
            const signature = (rows: typeof snapshot.launches) => JSON.stringify(
              eligibleHints(rows, excluded, new Set(Object.keys(state!.skipped)))
                .map((hint) => JSON.stringify(hint)).sort());
            // Never select from a stale batch after a withdrawal or another new arrival.
            if (signature(refreshed.launches) !== signature(snapshot.launches)) unresolved = true;
            else snapshot.launches = refreshed.launches;
          }
          if (!unresolved && resolved.length && !stopRequested && inWindow()) {
            const ordered = orderFreshCandidates(resolved.map((row) => row.launch.candidate), BigInt(state.anchor.number));
            const selected = resolved.find((row) => row.launch.candidate.id === ordered[0]!.id)!;
            // The child repeats official evidence and all financial checks before signing.
            save("observation.json", { version: 1, chainId: 11155111, startedAt: state.startedAt,
              deadlineAt: state.deadlineAt, anchor: state.anchor, baselineLiveIds: state.baselineLiveIds,
              selectionLiveIds: snapshot.launches.filter((hint) => hint.chainId === 11155111 && hint.status === "live").map((hint) => hint.id),
              discovery: state.discoveries[selected.id] });
            state.phase = "buying"; state.selectedLaunchId = selected.id;
            save("monitor.json", state);
            output({ event: "fresh_launch_selected", id: selected.id,
              launchBlock: String(selected.launch.candidate.blockNumber), discovery: state.discoveries[selected.id] });
            // Exactly one child attempt. A spawn/I/O failure does not reopen selection.
            let code: number | null = null;
            try { code = await runBuy(selected.id); }
            catch { state.reason = "execution_process_failed_review_journal"; }
            const journalPath = resolve(DIRECTORY, "live/state.json");
            const journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, "utf8")) : null;
            const resultPath = resolve(DIRECTORY, "result.json");
            state.outcome = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : { exitCode: code, journal };
            state.phase = code === 0 && journal?.phase === "confirmed" ? "confirmed" :
              journal?.phase === "failed" ? "failed" : journal?.txHash ? "uncertain" : "failed";
            state.lastCheckedAt = new Date().toISOString();
            save("monitor.json", state);
            output({ event: "watch_finished", phase: state.phase, outcome: state.outcome });
            return;
          }
        }
        consecutiveErrors = 0;
      } catch {
        if (state.phase === "buying") {
          state.phase = "uncertain"; state.reason = "execution_outcome_unreadable_review_journal";
          state.lastCheckedAt = new Date().toISOString(); save("monitor.json", state);
          output({ event: "watch_finished", phase: state.phase, reason: state.reason });
          return;
        }
        if (stopRequested) break;
        state.errors++; consecutiveErrors++;
        pause = Math.min(60000, Math.max(pause, 5000 * 2 ** Math.min(consecutiveErrors, 4)));
        if (consecutiveErrors >= 10) { state.reason = "repeated_api_or_rpc_failure"; state.phase = "failed"; break; }
      }
      save("monitor.json", state);
      if (Date.now() - lastNotice >= 60000) {
        output({ event: "watch_progress", phase: state.phase, polls: state.polls,
          errors: state.errors, newCandidates: Object.keys(state.discoveries).length, deadlineAt: state.deadlineAt });
        lastNotice = Date.now();
      }
      const remaining = Math.min(Date.parse(state.deadlineAt) - Date.now(), deadlineMonotonic - performance.now());
      if (remaining > 0) await delay(Math.min(pause, remaining), undefined, { signal: controller.signal }).catch(() => {});
    }
    if (state.phase === "watching") state.phase = stopRequested ? "stopped" : "expired";
    state.lastCheckedAt = new Date().toISOString(); save("monitor.json", state);
    output({ event: "watch_finished", phase: state.phase, polls: state.polls,
      newCandidates: Object.keys(state.discoveries).length, outcome: "No purchase was submitted by the monitor." });
  } catch {
    if (state) { state.phase = "failed"; state.reason = "monitor_failed_review_existing_journal"; save("monitor.json", state); }
    output({ event: "watch_error", message: "Watch did not start or stopped. Inspect the existing monitor and journal; do not reset them." });
    process.exitCode = 1;
  } finally { if (deadlineTimer !== undefined) clearTimeout(deadlineTimer); lock.close(); }
}
main().catch(() => { output({ event: "watch_error", message: "Check private runtime directories and active monitor lock." }); process.exitCode = 1; });
