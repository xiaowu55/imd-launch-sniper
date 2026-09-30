import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
const DIRECTORY = resolve(ROOT, "runtime/testnet/continuous");
const LOCK = resolve(DIRECTORY, "supervisor.lock");
const STATE = resolve(DIRECTORY, "supervisor.json");
const STOP = resolve(DIRECTORY, "STOP");
const RETRY_MS = 30000;
type Lock = { pid: number; startedAt: string };
type State = Lock & { phase: "starting" | "running" | "retrying" | "stopped" | "completed";
  restarts: number; childPid?: number; lastExitCode?: number | null; nextRetryAt?: string };

function exists(path: string) {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function secureDirectory(path: string) {
  if (!exists(path)) mkdirSync(path, { mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) ||
    (process.getuid && stat.uid !== process.getuid())) throw Error("unsafe_supervisor_directory");
}
function prepare() {
  for (const path of [resolve(ROOT, "runtime"), resolve(ROOT, "runtime/testnet"), DIRECTORY]) secureDirectory(path);
}
function privateFd(path: string, flags: number) {
  const fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) ||
    (process.getuid && stat.uid !== process.getuid())) { closeSync(fd); throw Error("unsafe_supervisor_file"); }
  return fd;
}
function read(path: string): unknown {
  const fd = privateFd(path, constants.O_RDONLY);
  try {
    if (fstatSync(fd).size > 16384) throw Error("supervisor_state_too_large");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}
function syncDirectory(directory: string) {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function save(path: string, value: unknown) {
  if (exists(path)) { const fd = privateFd(path, constants.O_RDONLY); closeSync(fd); }
  const temp = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600); writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd);
    closeSync(fd); fd = undefined; renameSync(temp, path); syncDirectory(dirname(path));
  } finally { if (fd !== undefined) closeSync(fd); if (exists(temp)) unlinkSync(temp); }
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function lockData(path: string): Lock | undefined {
  if (!exists(path)) return undefined;
  const saved = read(path) as Partial<Lock> | null;
  if (!saved || !Number.isSafeInteger(saved.pid) || saved.pid! <= 1) throw Error("invalid_supervisor_lock");
  return saved as Lock;
}
export function commandMatchesSupervisor(command: string, node: string, script: string): boolean {
  return command.trim() === `${node} --import tsx ${script} run`;
}
function verifiedRunning(saved: Lock | undefined) {
  if (!saved || !alive(saved.pid)) return false;
  let command: string;
  try { command = execFileSync("/bin/ps", ["-ww", "-p", String(saved.pid), "-o", "command="],
    { encoding: "utf8", timeout: 3000, maxBuffer: 16384,
      env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" } }); }
  catch { throw Error("supervisor_process_identity_unavailable"); }
  if (!commandMatchesSupervisor(command, process.execPath, SELF)) throw Error("supervisor_pid_reused_review_lock");
  return true;
}

/** Serialize stale-lock recovery. A crash while holding the gate requires review. */
export function acquireSupervisorLock(directory: string): () => void {
  secureDirectory(directory);
  const lock = resolve(directory, "supervisor.lock");
  const gate = resolve(directory, "supervisor-startup.lock");
  const gateFd = privateFd(gate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
  try {
    writeFileSync(gateFd, JSON.stringify({ pid: process.pid }) + "\n"); fsyncSync(gateFd);
    const previous = lockData(lock);
    if (previous && alive(previous.pid)) throw Error("supervisor_already_running");
    if (previous) unlinkSync(lock);
    const fd = privateFd(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n"); fsyncSync(fd); }
    finally { closeSync(fd); }
    syncDirectory(directory);
  } finally { closeSync(gateFd); unlinkSync(gate); syncDirectory(directory); }
  return () => {
    if (lockData(lock)?.pid === process.pid) { unlinkSync(lock); syncDirectory(directory); }
  };
}

export function shouldRestartWatcher(code: number | null, stopped: boolean): boolean {
  return !stopped && code !== 0;
}
export function persistSupervisorStop(directory: string) {
  secureDirectory(directory);
  const path = resolve(directory, "STOP");
  if (exists(path)) { const fd = privateFd(path, constants.O_RDONLY); closeSync(fd); }
  else save(path, { stoppedAt: new Date().toISOString(), source: "testnet-supervisor" });
}
function log(event: string, details: unknown) {
  const at = new Date().toISOString();
  const fd = privateFd(resolve(DIRECTORY, `supervisor-${at.slice(0, 10)}.jsonl`),
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT);
  try { writeFileSync(fd, JSON.stringify({ at, event, details }) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
}
function status() {
  const saved = lockData(LOCK);
  return { mode: "detached_current_login", running: verifiedRunning(saved),
    stopRequested: exists(STOP), ...(saved ? { pid: saved.pid } : {}),
    state: exists(STATE) ? read(STATE) : null, autoStartAtLogin: false };
}
function watcherAlreadyRunning() {
  const saved = lockData(resolve(DIRECTORY, "process.lock"));
  return saved && alive(saved.pid);
}
async function run() {
  prepare();
  if (exists(STOP)) throw Error("stop_marker_present_explicit_resume_required");
  const release = acquireSupervisorLock(DIRECTORY);
  const controller = new AbortController();
  let stopped = false;
  let child: ChildProcess | undefined;
  const stop = () => { stopped = true; controller.abort(); child?.kill("SIGTERM"); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  const state: State = { pid: process.pid, startedAt: new Date().toISOString(), phase: "starting", restarts: 0 };
  try {
    save(STATE, state); log("supervisor_started", { pid: process.pid, autoStartAtLogin: false });
    while (!stopped && !exists(STOP)) {
      // Do not race or adopt an orphan watcher after an abrupt supervisor kill.
      if (watcherAlreadyRunning()) throw Error("watcher_running_review_existing_process");
      const at = new Date().toISOString().slice(0, 10);
      const fd = privateFd(resolve(DIRECTORY, `supervisor-child-${at}.log`),
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT);
      let code: number | null = null;
      try {
        child = spawn(process.execPath, ["--import", "tsx", resolve(ROOT, "scripts/testnet-continuous.ts"), "start"],
          { cwd: ROOT, stdio: ["ignore", fd, fd], env: { ...process.env, TRADING_PRIVATE_KEY: "" } });
        state.phase = "running"; state.childPid = child.pid; delete state.nextRetryAt;
        save(STATE, state); log("watcher_spawned", { childPid: child.pid, restarts: state.restarts });
        code = await new Promise<number | null>((resolveExit) => {
          child!.once("error", () => resolveExit(null)); child!.once("exit", resolveExit);
        });
      } finally { closeSync(fd); child = undefined; }
      delete state.childPid; state.lastExitCode = code;
      if (!shouldRestartWatcher(code, stopped || exists(STOP))) {
        state.phase = stopped || exists(STOP) ? "stopped" : "completed";
        save(STATE, state); log("supervisor_finished", { phase: state.phase, code }); return;
      }
      state.restarts++; state.phase = "retrying"; state.nextRetryAt = new Date(Date.now() + RETRY_MS).toISOString();
      save(STATE, state); log("watcher_restart_scheduled", { code, nextRetryAt: state.nextRetryAt });
      await delay(RETRY_MS, undefined, { signal: controller.signal }).catch(() => {});
    }
    state.phase = "stopped"; save(STATE, state); log("supervisor_finished", { phase: state.phase });
  } finally { child?.kill("SIGTERM"); process.off("SIGTERM", stop); process.off("SIGINT", stop); release(); }
}
async function start() {
  prepare();
  if (exists(STOP)) throw Error("stop_marker_present_explicit_resume_required");
  if (verifiedRunning(lockData(LOCK))) return { action: "already_running", ...status() };
  if (watcherAlreadyRunning()) throw Error("watcher_running_review_existing_process");
  const fd = privateFd(resolve(DIRECTORY, "supervisor-launch.log"), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT);
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, ["--import", "tsx", SELF, "run"], {
      cwd: ROOT, detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, TRADING_PRIVATE_KEY: "" },
    });
    await new Promise<void>((resolveSpawn, reject) => { child.once("spawn", resolveSpawn); child.once("error", reject); });
    child.unref();
  } finally { closeSync(fd); }
  for (let attempt = 0; attempt < 50; attempt++) {
    await delay(100);
    const saved = lockData(LOCK);
    if (saved?.pid === child.pid && verifiedRunning(saved)) return { action: "started", ...status() };
    if (child.pid && !alive(child.pid)) break;
  }
  throw Error("supervisor_start_not_confirmed_inspect_launch_log");
}
async function main() {
  const [command = "status", ...rest] = process.argv.slice(2);
  if (rest.length || !["start", "run", "status", "stop"].includes(command)) throw Error("invalid_supervisor_command");
  if (process.platform !== "darwin") throw Error("supervisor_requires_macos");
  if (command === "run") { await run(); return; }
  let result: unknown;
  if (command === "start") result = await start();
  else if (command === "stop") {
    prepare(); persistSupervisorStop(DIRECTORY);
    const saved = lockData(LOCK);
    if (verifiedRunning(saved)) process.kill(saved!.pid, "SIGTERM");
    result = { action: "stop_requested", ...status() };
  } else result = status();
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  main().catch((error) => {
    const message = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "supervisor_failed_inspect_private_logs";
    console.error(JSON.stringify({ error: message })); process.exitCode = 1;
  });
}
