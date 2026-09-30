import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContinuousHistory, type ContinuousDiscovery } from "../scripts/testnet-continuous-history.js";

const now = Date.parse("2026-09-30T00:00:00.000Z");
const id = (n: number) => `12345678-1234-4234-8234-${String(n).padStart(12, "0")}`;
function discovery(n: number, seen = now - 300000 + n * 10): ContinuousDiscovery {
  return { launchId: id(n), firstSeenAt: new Date(seen).toISOString(),
    firstSeenHead: { number: String(10000 + n), hash: `0x${"a".repeat(64)}` }, listCacheMaxAgeSeconds: 10 };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "imd-continuous-history-"));
  const directory = join(root, "history");
  return { root, directory, history: new ContinuousHistory(directory) };
}
function state() {
  return { discoveries: Object.fromEntries(Array.from({ length: 260 }, (_, n) => [id(n), discovery(n)])),
    skipped: { [id(1)]: "unsupported_protocol" } as Record<string, string>,
    selectedLaunchId: id(0), attempted: true, purchasePhase: "confirmed",
    anchor: { number: "9000", hash: `0x${"b".repeat(64)}` }, baselineLiveIds: [id(999)] };
}

test("continuous history retains active and selected IDs, archives only older terminal rows after durable write", () => {
  const { root, directory, history } = fixture();
  try {
    const original = state();
    original.discoveries[id(260)] = discovery(260, now - 10000);
    original.discoveries[id(261)] = discovery(261, now - 120000);
    const before = JSON.stringify(original);
    const next = history.compact(original, now);
    assert.equal(Object.keys(next.discoveries).length, 259); // 256 terminal + selected + two active.
    assert.equal(JSON.stringify(original), before, "input cannot change before caller persists the result");
    assert.deepEqual(next.discoveries[id(260)], original.discoveries[id(260)]);
    assert.deepEqual(next.discoveries[id(261)], original.discoveries[id(261)]);
    assert.deepEqual(next.discoveries[id(0)], original.discoveries[id(0)]);
    assert.equal(next.skipped[id(260)], undefined);
    assert.equal(next.skipped[id(261)], undefined);
    assert.equal(next.skipped[id(259)], "discovery_expired");
    assert.equal(next.attempted, true); assert.equal(next.purchasePhase, "confirmed");
    assert.deepEqual(next.anchor, original.anchor); assert.deepEqual(next.baselineLiveIds, original.baselineLiveIds);
    const archive = JSON.parse(readFileSync(join(directory, `${id(1)}.json`), "utf8"));
    assert.deepEqual(archive.discovery, original.discoveries[id(1)]);
    assert.equal(archive.skipped, "unsupported_protocol");
    assert.equal(statSync(join(directory, `${id(1)}.json`)).mode & 0o777, 0o600);
    assert.equal(next.discoveries[id(1)], undefined); assert.equal(next.skipped[id(1)], undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("continuous history survives crash before monitor save and rejects archived IDs without scanning the directory", () => {
  const { root, directory, history } = fixture();
  try {
    const original = state();
    const next = history.compact(original, now);
    const firstArchive = readFileSync(join(directory, `${id(1)}.json`), "utf8");
    // An unrelated file is never read: only candidate UUID paths are consulted.
    writeFileSync(join(directory, "unrelated.json"), "invalid", { mode: 0o644 });
    const restarted = new ContinuousHistory(directory);
    assert.deepEqual(restarted.compact(original, now), next);
    assert.equal(readFileSync(join(directory, `${id(1)}.json`), "utf8"), firstArchive);
    assert.equal(restarted.historyExists(id(1)), true);
    assert.equal(restarted.historyExists(id(1).toUpperCase()), true);
    assert.equal(restarted.historyExists(id(9999)), false);
    assert.deepEqual([id(1), id(9999)].filter((candidate) => !restarted.historyExists(candidate)), [id(9999)]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("continuous history fails closed on corrupt, public or linked archives and leaves monitor maps intact", () => {
  const { root, directory, history } = fixture();
  try {
    const original = state();
    const before = JSON.stringify(original);
    const file = join(directory, `${id(1)}.json`);
    writeFileSync(file, "{broken", { mode: 0o600 });
    assert.throws(() => history.compact(original, now), /fatal_history_read/);
    assert.equal(JSON.stringify(original), before);
    assert.throws(() => history.historyExists(id(1)), /fatal_history_read/);
    rmSync(file);
    history.compact(original, now);
    chmodSync(file, 0o644);
    assert.throws(() => history.historyExists(id(1)), /fatal_history_read/);
    rmSync(file); symlinkSync(join(root, "missing"), file);
    assert.throws(() => history.historyExists(id(1)), /fatal_history_read/);
    assert.throws(() => history.historyExists("../outside"), /fatal_history_id/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("archived original discovery cannot be replaced with a new first-seen time", () => {
  const { root, history } = fixture();
  try {
    const original = state();
    history.compact(original, now);
    original.discoveries[id(1)] = discovery(1, now - 400000);
    assert.throws(() => history.compact(original, now), /fatal_history_mismatch/);
    // Backward time never ages out an active discovery.
    const fresh = { discoveries: { [id(900)]: discovery(900, now) }, skipped: {}, attempted: false };
    assert.deepEqual(history.compact(fresh, now - 10000), fresh);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
