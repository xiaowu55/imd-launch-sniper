import test from "node:test";
import assert from "node:assert/strict";
import { attemptConsumed, journalConsumesAttempt, recentLaunch, retryDelay, safeRetryDeadline } from "../scripts/testnet-continuous-policy.js";
test("continuous monitoring never makes an overnight launch fresh after reconnect", () => {
  const now = 1000000;
  assert.equal(recentLaunch(950n, 990n, now), true);
  assert.equal(recentLaunch(100n, 990n, now), false);
  assert.equal(recentLaunch(100n, 110n, now), false);
  assert.equal(recentLaunch(995n, 990n, now), false);
  assert.equal(recentLaunch(1020n, 1020n, now), false);
});
test("continuous network failures retain capped backoff without a terminal retry count", () => {
  assert.equal(retryDelay(1), 5000); assert.equal(retryDelay(2), 10000);
  assert.equal(retryDelay(10), 60000); assert.equal(retryDelay(1000), 60000);
});
test("continuous restart retains consumed budget after selection or any execution evidence", () => {
  assert.equal(attemptConsumed({ attempted: false }, false), false);
  assert.equal(attemptConsumed({ attempted: true }, false), true);
  assert.equal(attemptConsumed({ attempted: false, selectedLaunchId: "saved-selection" }, false), true);
  assert.equal(attemptConsumed({ attempted: false }, true), true);
});
test("an idle status journal preserves the budget; all transaction phases and invalid state fail closed", () => {
  assert.equal(journalConsumesAttempt({ phase: "idle" }), false);
  for (const phase of ["claimed", "signed", "broadcast", "confirmed", "failed", "uncertain"])
    assert.equal(journalConsumesAttempt({ phase }), true);
  for (const value of [null, {}, { phase: "unknown" }, "idle"])
    assert.throws(() => journalConsumesAttempt(value), /fatal_execution_journal_invalid/);
});

test("durable API retry deadlines preserve milliseconds and legal long cooldowns", () => {
  const now = Date.parse("2026-10-01T12:34:56.789Z");
  assert.equal(safeRetryDeadline(0, now), "2026-10-01T12:34:56.789Z");
  assert.equal(safeRetryDeadline(5000, now), "2026-10-01T12:35:01.789Z");
  const fortyDays = 40 * 24 * 60 * 60 * 1000;
  const result = safeRetryDeadline(fortyDays, now);
  assert.equal(result, "2026-11-10T12:34:56.789Z");
  assert.equal(Date.parse(result) - now, fortyDays);
  assert.equal(result.length, 24);
});

test("durable API retry deadlines accept the exact four-digit ISO ceiling and reject one millisecond more", () => {
  const latest = Date.parse("9999-12-31T23:59:59.999Z");
  assert.equal(safeRetryDeadline(1, latest - 1), "9999-12-31T23:59:59.999Z");
  assert.equal(safeRetryDeadline(0, latest), "9999-12-31T23:59:59.999Z");
  assert.throws(() => safeRetryDeadline(1, latest), /^Error: fatal_api_cooldown_unrepresentable$/);
  assert.throws(() => safeRetryDeadline(0, latest + 1), /^Error: fatal_api_cooldown_unrepresentable$/);
  assert.equal(safeRetryDeadline(0, Date.parse("0000-01-01T00:00:00.000Z")), "0000-01-01T00:00:00.000Z");
  assert.throws(() => safeRetryDeadline(0, Date.parse("0000-01-01T00:00:00.000Z") - 1), /fatal_api_cooldown_unrepresentable/);
});

test("unsafe, fractional, negative and unrepresentable retry deadlines fail with a durable fatal code", () => {
  const now = Date.parse("2026-10-01T00:00:00.000Z");
  for (const delay of [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, -1, 0.5, "5000" as unknown as number])
    assert.throws(() => safeRetryDeadline(delay, now), /^Error: fatal_api_cooldown_unrepresentable$/);
  for (const invalidNow of [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER, Infinity, -Infinity, NaN, now + 0.5, null as unknown as number])
    assert.throws(() => safeRetryDeadline(5000, invalidNow), /^Error: fatal_api_cooldown_unrepresentable$/);
});
