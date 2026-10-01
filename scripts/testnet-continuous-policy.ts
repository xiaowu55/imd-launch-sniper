export const CONTINUOUS_FRESH_MS = 120000;
export function recentLaunch(launchTimestamp: bigint, headTimestamp: bigint, nowMs: number) {
  const now = BigInt(Math.floor(nowMs / 1000));
  return launchTimestamp <= headTimestamp && headTimestamp - launchTimestamp <= 120n &&
    now - launchTimestamp <= 120n && launchTimestamp - now <= 15n &&
    now - headTimestamp <= 60n && headTimestamp - now <= 15n;
}
export function retryDelay(failures: number) {
  return Math.min(60000, 5000 * 2 ** Math.min(Math.max(0, failures - 1), 4));
}
/** A durable selection, even before signing, consumes the one attempt across restarts. */
export function attemptConsumed(state: { attempted: boolean; selectedLaunchId?: string }, evidenceExists: boolean) {
  return state.attempted || !!state.selectedLaunchId || evidenceExists;
}
/** A status-created idle journal does not spend the one attempt. Malformed state blocks startup. */
export function journalConsumesAttempt(input: unknown): boolean {
  const phase = input && typeof input === "object" && "phase" in input ? input.phase : undefined;
  if (typeof phase !== "string" || !["idle", "claimed", "signed", "broadcast", "confirmed", "failed", "uncertain"].includes(phase))
    throw Error("fatal_execution_journal_invalid");
  return phase !== "idle";
}

/** Persist the entire server cooldown, or fail closed before any deadline write.
 * Four-digit ISO years are required by the durable monitor-state schema.
 */
export function safeRetryDeadline(delayMs: number, nowMs: number): string {
  const fail = () => { throw Error("fatal_api_cooldown_unrepresentable"); };
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || !Number.isSafeInteger(nowMs)) return fail();
  const earliest = -62_167_219_200_000n; // 0000-01-01T00:00:00.000Z
  const latest = 253_402_300_799_999n; // 9999-12-31T23:59:59.999Z
  const now = BigInt(nowMs);
  const deadline = now + BigInt(delayMs);
  if (now < earliest || now > latest || deadline > latest) return fail();
  return new Date(Number(deadline)).toISOString();
}
