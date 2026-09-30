import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { renderLaunchAgent, runTestnetService, servicePaths, type ServiceOptions } from "../scripts/testnet-service.js";

function fixture(t: TestContext) {
  const base = mkdtempSync(resolve(tmpdir(), "imd-service-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = resolve(base, "project with spaces & <quotes>");
  const home = resolve(base, "home");
  mkdirSync(root, { mode: 0o700 }); mkdirSync(home, { mode: 0o700 });
  const options: ServiceOptions = { root, home, node: "/test node/bin/node", uid: process.getuid?.() ?? 0,
    platform: "darwin", launchctl: () => { throw Object.assign(Error("not loaded"), { status: 113 }); } };
  return { options, paths: servicePaths(options) };
}

test("LaunchAgent preserves absolute arguments and escapes XML without embedding environment secrets", () => {
  const paths = servicePaths({ root: "/tmp/imd & <project> 'test'", home: "/tmp/home", node: "/node path/node", uid: 501 });
  const plist = renderLaunchAgent(paths);
  assert.match(plist, /<string>\/node path\/node<\/string>/);
  assert.match(plist, /imd &amp; &lt;project&gt; &apos;test&apos;/);
  assert.match(plist, /<string>--import<\/string>\s*<string>tsx<\/string>/);
  assert.match(plist, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>30<\/integer>/);
  assert.doesNotMatch(plist, /EnvironmentVariables|TRADING_PRIVATE_KEY|\/bin\/sh|\/bin\/zsh/);
});

test("install is inert and private; start uses structured bootstrap arguments without restarting a loaded job", (t) => {
  const { options, paths } = fixture(t);
  const calls: readonly string[][] = [];
  let loaded = false;
  options.launchctl = (args) => {
    (calls as string[][]).push([...args]);
    if (args[0] === "bootstrap") { loaded = true; return ""; }
    if (loaded) return "state = running\npid = 123\nTRADING_PRIVATE_KEY = secret\n";
    throw Object.assign(Error("not loaded"), { status: 113 });
  };
  runTestnetService("install", options);
  assert.equal(calls.length, 0);
  assert.equal(statSync(paths.plist).mode & 0o777, 0o600);
  assert.equal(statSync(paths.directory).mode & 0o777, 0o700);
  assert.equal(statSync(paths.stdout).mode & 0o777, 0o600);
  const started = runTestnetService("start", options);
  assert.equal(started.pid, 123);
  assert.deepEqual(calls[1], ["bootstrap", `gui/${options.uid}`, paths.plist]);
  assert.doesNotMatch(JSON.stringify(started), /secret|TRADING_PRIVATE_KEY/);
  assert.equal(runTestnetService("start", options).action, "already_loaded");
  assert.equal(calls.filter((args) => args[0] === "bootstrap").length, 1);
});

test("stop marker reaches disk before bootout and install/start never clear an intentional stop", (t) => {
  const { options, paths } = fixture(t);
  runTestnetService("install", options);
  options.launchctl = (args) => {
    assert.deepEqual(args, ["bootout", paths.target]);
    assert.equal(existsSync(paths.stop), true);
    assert.equal(statSync(paths.stop).mode & 0o777, 0o600);
    return "";
  };
  runTestnetService("stop", options);
  const marker = readFileSync(paths.stop, "utf8");
  runTestnetService("install", options);
  assert.throws(() => runTestnetService("start", options), /stop_marker_present/);
  assert.equal(readFileSync(paths.stop, "utf8"), marker);
  rmSync(paths.stop); symlinkSync(resolve(paths.directory, "absent"), paths.stop);
  assert.throws(() => runTestnetService("start", options), /stop_marker_present/);
});

test("install refuses symlinked or public log files and another checkout's plist", (t) => {
  const { options, paths } = fixture(t);
  runTestnetService("install", options);
  writeFileSync(paths.plist, "another checkout", { mode: 0o600 });
  assert.throws(() => runTestnetService("install", options), /different_service_already_installed/);
  writeFileSync(paths.plist, renderLaunchAgent(paths));
  chmodSync(paths.stdout, 0o644);
  assert.throws(() => runTestnetService("install", options), /unsafe_service_file/);
  rmSync(paths.stdout); symlinkSync(paths.stderr, paths.stdout);
  assert.throws(() => runTestnetService("install", options));
});

test("status is read-only, distinguishes unknown launchctl failure, and rejects non-macOS execution", (t) => {
  const { options, paths } = fixture(t);
  assert.equal(runTestnetService("status", options).loaded, false);
  assert.equal(existsSync(paths.directory), false);
  options.launchctl = () => { throw Object.assign(Error("bad domain"), { status: 5 }); };
  assert.throws(() => runTestnetService("status", options), /launchctl_status_failed/);
  options.platform = "linux";
  assert.throws(() => runTestnetService("install", options), /requires_macos/);
});

test("status retains launchd configuration exit codes with their symbolic suffix", (t) => {
  const { options } = fixture(t);
  options.launchctl = () => "state = spawn scheduled\nlast exit code = 78: EX_CONFIG\n";
  assert.deepEqual(runTestnetService("status", options).lastExitCode, 78);
});
