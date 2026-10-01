import { setTimeout as delay } from "node:timers/promises";

export const TESTNET_POLL_INTERVAL_MS = 2000;

/** Start-to-start scheduling, with no overlapping requests or catch-up burst. */
export function nextPollDelay(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw Error("invalid_poll_duration");
  return Math.max(100, TESTNET_POLL_INTERVAL_MS - elapsedMs);
}

/** Drain every request before another cycle; a fatal identity failure takes precedence. */
export async function settleRequired<T extends readonly unknown[]>(
  requests: { [K in keyof T]: Promise<T[K]> },
): Promise<T> {
  const results = await Promise.allSettled(requests);
  const rejected = results.filter((item): item is PromiseRejectedResult => item.status === "rejected");
  if (rejected.length) {
    const fatal = rejected.find(({ reason }) => reason instanceof Error && reason.message.startsWith("fatal_"));
    throw (fatal ?? rejected[0])!.reason;
  }
  return results.map((item) => (item as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

/** Poll already-selected coins only as history; do not re-resolve them each cycle. */
export function actionableHints<T extends { id: string }>(
  candidates: T[], state: { attempted: boolean; discoveries: Record<string, unknown> },
): T[] {
  return state.attempted ? candidates.filter((hint) => !Object.hasOwn(state.discoveries, hint.id)) : candidates;
}

/** Preserve long Retry-After values without Node's >2^31ms timeout overflow. */
export async function waitForNextPoll(durationMs: number, signal: AbortSignal): Promise<void> {
  if (!Number.isFinite(durationMs) || durationMs < 0) throw Error("invalid_poll_delay");
  const start = performance.now();
  while (true) {
    signal.throwIfAborted();
    const remaining = durationMs - (performance.now() - start);
    if (remaining <= 0) return;
    await delay(Math.min(60000, remaining), undefined, { signal });
  }
}
