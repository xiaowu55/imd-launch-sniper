import test from "node:test";
import assert from "node:assert/strict";
import { attemptConsumed, journalConsumesAttempt, recentLaunch, retryDelay } from "../scripts/testnet-continuous-policy.js";
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
