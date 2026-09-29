import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../src/journal.js";
import { ApiSession } from "../src/api-session.js";

const token = `0x${"1".repeat(40)}` as const;

test("journal persistence cannot follow a preexisting predictable temporary symlink", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "imd-journal-audit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = join(directory, "unrelated-file");
  writeFileSync(target, "must stay unchanged");
  symlinkSync(target, join(directory, "state.json.tmp"));
  const journal = new Journal(directory);
  journal.lock();
  try {
    assert.equal(journal.claim("first", token), true);
    assert.equal(readFileSync(target, "utf8"), "must stay unchanged");
    assert.equal(new Journal(directory).state.phase, "claimed");
  } finally { journal.close(); }
});

test("journal failed rename cleans the temporary file and cannot claim in memory", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "imd-journal-audit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const journal = new Journal(directory);
  journal.lock();
  try {
    mkdirSync(join(directory, "state.json"));
    assert.throws(() => journal.claim("first", token));
    assert.equal(journal.state.phase, "idle");
    assert.equal(readdirSync(directory).filter((name) => name.endsWith(".tmp")).length, 0);
  } finally { journal.close(); }
});

test("API state failed rename removes temporary data and keeps its prior pending queue", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "imd-api-audit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const session = new ApiSession("live", directory);
  const baseline = {
    source: "https://api.imd.fun/launches?limit=500",
    checkedAt: new Date().toISOString(), cacheMaxAgeSeconds: null, launches: [],
  };
  session.initialize(baseline, { number: 100n, hash: `0x${"2".repeat(64)}` });
  rmSync(join(directory, "live.json"));
  mkdirSync(join(directory, "live.json"));
  assert.throws(() => session.enqueue({
    ...baseline, launches: [{ id: "new-launch", launchNumber: 1, chainId: 1, status: "live", token }],
  }));
  assert.deepEqual(session.pending(), []);
  assert.equal(readdirSync(directory).filter((name) => name.endsWith(".tmp")).length, 0);
});
