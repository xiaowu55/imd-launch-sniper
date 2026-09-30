import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TESTNET_SERVICE_LABEL = "com.imd.sniper.sepolia-continuous";
type Command = "install" | "start" | "status" | "stop";
type Launchctl = (args: readonly string[]) => string;
export type ServiceOptions = {
  root: string; home: string; node: string; uid: number; platform: string;
  launchctl: Launchctl;
};

export function servicePaths(options: Pick<ServiceOptions, "root" | "home" | "node" | "uid">) {
  if (![options.root, options.home, options.node].every(isAbsolute) ||
      !Number.isSafeInteger(options.uid) || options.uid < 0) throw Error("invalid_service_paths");
  const directory = resolve(options.root, "runtime/testnet/continuous");
  const launchAgents = resolve(options.home, "Library/LaunchAgents");
  return {
    root: options.root, node: options.node, directory, launchAgents,
    script: resolve(options.root, "scripts/testnet-continuous.ts"),
    plist: resolve(launchAgents, `${TESTNET_SERVICE_LABEL}.plist`),
    stdout: resolve(directory, "service.stdout.log"),
    stderr: resolve(directory, "service.stderr.log"),
    stop: resolve(directory, "STOP"),
    monitor: resolve(directory, "monitor.json"),
    domain: `gui/${options.uid}`, target: `gui/${options.uid}/${TESTNET_SERVICE_LABEL}`,
  };
}
type Paths = ReturnType<typeof servicePaths>;

function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function xml(value: string) {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value)) throw Error("invalid_xml_path");
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function renderLaunchAgent(paths: Paths): string {
  const args = [paths.node, "--import", "tsx", paths.script, "start"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${TESTNET_SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${xml(paths.root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(paths.stdout)}</string>
  <key>StandardErrorPath</key><string>${xml(paths.stderr)}</string>
</dict>
</plist>
`;
}

function ensureDirectory(path: string, uid: number, privateDirectory: boolean) {
  // Call this one component at a time, so existing symlinked parents are rejected.
  if (!exists(path)) mkdirSync(path, { mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid ||
      (stat.mode & (privateDirectory ? 0o077 : 0o022))) throw Error("unsafe_service_directory");
}

function privateFile(path: string, uid: number, create = false): string {
  const fd = openSync(path, (create ? constants.O_RDWR | constants.O_CREAT : constants.O_RDONLY) |
    constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) || stat.nlink !== 1)
      throw Error("unsafe_service_file");
    if (create) return "";
    if (stat.size > 128 * 1024) throw Error("service_file_too_large");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

function atomicSave(path: string, value: string, uid: number) {
  if (exists(path)) privateFile(path, uid);
  const temp = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, value); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, path);
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (exists(temp)) unlinkSync(temp);
  }
}

function prepareRuntime(paths: Paths, uid: number) {
  ensureDirectory(paths.root, uid, false);
  for (const path of [resolve(paths.root, "runtime"), resolve(paths.root, "runtime/testnet"), paths.directory])
    ensureDirectory(path, uid, true);
}

function launchState(paths: Paths, launchctl: Launchctl) {
  let output: string;
  try { output = launchctl(["print", paths.target]); }
  catch (error) {
    // launchctl uses ESRCH (113) when this service is absent. Other failures are
    // not mistaken for "stopped" (for example, a missing GUI login session).
    if (error && typeof error === "object" && "status" in error && error.status === 113)
      return { loaded: false };
    throw Error("launchctl_status_failed");
  }
  const pid = output.match(/^\s*pid = (\d+)\s*$/m)?.[1];
  const state = output.match(/^\s*state = ([a-zA-Z -]+)\s*$/m)?.[1]?.trim();
  const lastExitCode = output.match(/^\s*last exit code = (-?\d+)(?:: [A-Z_]+)?\s*$/m)?.[1];
  // Never print launchctl's raw response: it can include inherited environment.
  return { loaded: true, ...(pid ? { pid: Number(pid) } : {}),
    ...(state ? { state } : {}), ...(lastExitCode ? { lastExitCode: Number(lastExitCode) } : {}) };
}

export function runTestnetService(command: Command, options: ServiceOptions): Record<string, unknown> {
  if (options.platform !== "darwin") throw Error("testnet_service_requires_macos");
  const paths = servicePaths(options);
  const expectedPlist = renderLaunchAgent(paths);
  if (command === "install") {
    prepareRuntime(paths, options.uid);
    ensureDirectory(options.home, options.uid, false);
    ensureDirectory(resolve(options.home, "Library"), options.uid, false);
    ensureDirectory(paths.launchAgents, options.uid, false);
    // A fixed label must never silently take over another checkout's service.
    if (exists(paths.plist) && privateFile(paths.plist, options.uid) !== expectedPlist)
      throw Error("different_service_already_installed_review_plist");
    for (const log of [paths.stdout, paths.stderr]) privateFile(log, options.uid, true);
    if (!exists(paths.plist)) atomicSave(paths.plist, expectedPlist, options.uid);
    return { action: "installed", plist: paths.plist, started: false, stopRequested: exists(paths.stop) };
  }
  if (command === "status") {
    return { label: TESTNET_SERVICE_LABEL, installed: exists(paths.plist),
      ...launchState(paths, options.launchctl), stopRequested: exists(paths.stop),
      monitor: paths.monitor, stdout: paths.stdout, stderr: paths.stderr };
  }
  if (command === "stop") {
    prepareRuntime(paths, options.uid);
    // Persist the stop request before SIGTERM from bootout. A future login or
    // accidental start therefore cannot resume spending after an intentional stop.
    if (exists(paths.stop)) privateFile(paths.stop, options.uid);
    else atomicSave(paths.stop, JSON.stringify({ stoppedAt: new Date().toISOString(), source: "testnet-service" }) + "\n", options.uid);
    try { options.launchctl(["bootout", paths.target]); }
    catch {
      if (launchState(paths, options.launchctl).loaded) throw Error("stop_requested_but_launchctl_bootout_failed");
    }
    return { action: "stopped", stopRequested: true, stopFile: paths.stop };
  }
  if (command !== "start") throw Error("invalid_service_command");
  prepareRuntime(paths, options.uid);
  if (exists(paths.stop)) throw Error("stop_marker_present_explicit_watcher_resume_required");
  if (!exists(paths.plist)) throw Error("service_not_installed_run_install_first");
  ensureDirectory(options.home, options.uid, false);
  ensureDirectory(resolve(options.home, "Library"), options.uid, false);
  ensureDirectory(paths.launchAgents, options.uid, false);
  if (privateFile(paths.plist, options.uid) !== expectedPlist) throw Error("installed_service_settings_mismatch");
  for (const log of [paths.stdout, paths.stderr]) privateFile(log, options.uid, true);
  const existing = launchState(paths, options.launchctl);
  if (existing.loaded) return { action: "already_loaded", ...existing };
  try { options.launchctl(["bootstrap", paths.domain, paths.plist]); }
  catch { throw Error("launchctl_bootstrap_failed"); }
  return { action: "started", ...launchState(paths, options.launchctl), plist: paths.plist };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || ![undefined, "install", "start", "status", "stop"].includes(args[0]))
    throw Error("usage: testnet-service.ts install|start|status|stop");
  const uid = process.getuid?.();
  if (uid === undefined) throw Error("testnet_service_requires_macos");
  const result = runTestnetService((args[0] ?? "status") as Command, {
    root: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    home: homedir(), node: process.execPath, uid, platform: process.platform,
    launchctl: (arguments_) => execFileSync("/bin/launchctl", [...arguments_], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000, maxBuffer: 256 * 1024,
    }),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    // The helper has no keys or RPC calls. Still emit only our own error codes.
    const code = error instanceof Error && /^(?:[a-z_]+|usage: testnet-service\.ts install\|start\|status\|stop)$/.test(error.message)
      ? error.message : "testnet_service_failed";
    console.error(JSON.stringify({ error: code })); process.exitCode = 1;
  }
}
