import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { acquireSupervisorLock, commandMatchesSupervisor, persistSupervisorStop, shouldRestartWatcher } from "../scripts/testnet-supervisor.js";

test("supervisor restarts failed or interrupted children, but never restarts after stop or clean exit", () => {
  assert.equal(shouldRestartWatcher(1, false), true);
  assert.equal(shouldRestartWatcher(null, false), true);
  assert.equal(shouldRestartWatcher(0, false), false);
  assert.equal(shouldRestartWatcher(1, true), false);
  assert.equal(shouldRestartWatcher(null, true), false);
});
test("supervisor PID identity requires the exact Node/script/command before signaling", () => {
  assert.equal(commandMatchesSupervisor(" /node --import tsx /project path/supervisor.ts run\n", "/node", "/project path/supervisor.ts"), true);
  assert.equal(commandMatchesSupervisor("/node --import tsx /another/supervisor.ts run", "/node", "/project path/supervisor.ts"), false);
  assert.equal(commandMatchesSupervisor("/node --import tsx /project path/supervisor.ts status", "/node", "/project path/supervisor.ts"), false);
  assert.equal(commandMatchesSupervisor("/node --import tsx /项目 狙击/supervisor.ts run\n", "/node", "/项目 狙击/supervisor.ts"), true);
});
test("supervisor lock rejects duplicates and leaves the first lock intact", (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), "imd-supervisor-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const release = acquireSupervisorLock(directory);
  const path = resolve(directory, "supervisor.lock");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.throws(() => acquireSupervisorLock(directory), /supervisor_already_running/);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, process.pid);
  release(); assert.equal(existsSync(path), false);
});
test("durable supervisor STOP is private, preserved across requests, and refuses symlinks", (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), "imd-supervisor-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = resolve(directory, "STOP");
  persistSupervisorStop(directory);
  const contents = readFileSync(path, "utf8");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  persistSupervisorStop(directory); assert.equal(readFileSync(path, "utf8"), contents);
  rmSync(path); symlinkSync(resolve(directory, "absent"), path);
  assert.throws(() => persistSupervisorStop(directory));
});
