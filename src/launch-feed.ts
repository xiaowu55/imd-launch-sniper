import { readBoundedJson } from "./bounded-json.js";
export type LaunchHint = {
  id: string;
  launchNumber: number;
  chainId: number;
  status: string;
  kind?: string;
  token?: `0x${string}`;
};
export type LaunchSnapshot = {
  checkedAt: string;
  source: string;
  cacheMaxAgeSeconds: number | null;
  launches: LaunchHint[];
};
const source = "https://api.imd.fun/launches?limit=50";
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const positiveInteger = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const shortString = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 128 && !/[\u0000-\u001f]/.test(v);

/** Public metadata is only an observation hint, never an authorization to buy. */
export function parseLaunchSnapshot(
  value: unknown,
  cacheControl: string | null = null,
  checkedAt = new Date().toISOString(),
): LaunchSnapshot {
  if (!object(value) || !Array.isArray(value.launches) || value.launches.length > 500)
    throw Error("官方发射列表格式不正确");
  const ids = new Set<string>();
  const launches = value.launches.map((row): LaunchHint => {
    if (
      !object(row) ||
      !shortString(row.id) ||
      !positiveInteger(row.launchNumber) ||
      !positiveInteger(row.chainId) ||
      !shortString(row.status) ||
      (row.kind !== undefined && !shortString(row.kind)) ||
      (row.artifacts !== undefined && !Array.isArray(row.artifacts)) ||
      ids.has(row.id)
    )
      throw Error("官方发射记录格式不正确");
    ids.add(row.id);
    const artifacts = (row.artifacts ?? []) as unknown[];
    const tokens = artifacts.filter((a) => object(a) && a.role === "token");
    if (
      tokens.length > 1 ||
      tokens.some((a) => !object(a) || typeof a.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a.address))
    )
      throw Error("官方发射代币字段不正确");
    const token = tokens[0] as { address: string } | undefined;
    return {
      id: row.id,
      launchNumber: row.launchNumber,
      chainId: row.chainId,
      status: row.status,
      ...(row.kind === undefined ? {} : { kind: row.kind }),
      ...(token ? { token: token.address.toLowerCase() as `0x${string}` } : {}),
    };
  });
  const age = cacheControl?.match(/(?:^|,)\s*max-age\s*=\s*"?(\d+)"?(?:\s*,|\s*$)/i)?.[1];
  const maxAge = age === undefined ? null : Number(age);
  return {
    checkedAt,
    source,
    cacheMaxAgeSeconds: maxAge !== null && Number.isSafeInteger(maxAge) && maxAge <= 2_147_483
      ? maxAge
      : null,
    launches,
  };
}

/** Keep a baseline across list rotation; response order and volatile times do not
 * make a launch new. Global launch numbers are not Ethereum launch ordinals. */
export class LaunchFeedTracker {
  private initialized = false;
  private readonly seen = new Map<string, string>();
  update(snapshot: LaunchSnapshot): LaunchHint[] {
    const changed: LaunchHint[] = [];
    for (const launch of snapshot.launches) {
      const fingerprint = JSON.stringify(launch);
      if (this.initialized && launch.chainId === 1 && this.seen.get(launch.id) !== fingerprint)
        changed.push(launch);
      this.seen.set(launch.id, fingerprint);
    }
    this.initialized = true;
    return changed;
  }
}

type LaunchFeedOptions = {
  intervalMs: number;
  onUpdate: (snapshot: LaunchSnapshot) => void;
  onSignal: (hints: LaunchHint[]) => void | Promise<void>;
  onError: () => void;
  fetchImpl?: typeof fetch;
};
function retryAfterMs(value: string | null): number | null {
  if (value === null) return null;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim())
    ? Number(value) * 1000
    : Date.parse(value) - Date.now();
  return Number.isFinite(seconds) ? Math.max(1000, Math.min(60000, seconds)) : null;
}

/** Extra wakeup channel only: a signal must still go through canonical RPC
 * discovery, reviewed contracts, history audit, filters, and transaction checks. */
export function startLaunchFeed(options: LaunchFeedOptions): () => void {
  const fetchImpl = options.fetchImpl ?? fetch;
  const intervalMs = Number.isFinite(options.intervalMs)
    ? Math.max(1000, Math.min(60000, options.intervalMs))
    : 5000;
  const tracker = new LaunchFeedTracker();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let failures = 0;
  const reportError = () => {
    if (!stopped) {
      try { options.onError(); } catch { /* User callbacks cannot break retries. */ }
    }
  };
  const poll = async () => {
    if (stopped) return;
    controller = new AbortController();
    const requestController = controller;
    const timeout = setTimeout(() => requestController.abort(), 8000);
    let nextDelay = intervalMs;
    try {
      const response = await fetchImpl(source, { signal: requestController.signal, redirect: "error" });
      if (stopped) return;
      if (!response.ok) {
        failures++;
        nextDelay = response.status === 429
          ? retryAfterMs(response.headers.get("retry-after")) ?? Math.min(60000, intervalMs * 2 ** Math.min(failures - 1, 10))
          : Math.min(60000, intervalMs * 2 ** Math.min(failures - 1, 10));
        reportError();
        return;
      }
      const snapshot = parseLaunchSnapshot(await readBoundedJson(response, 2 * 1024 * 1024, requestController.signal), response.headers.get("cache-control"));
      if (stopped) return;
      failures = 0;
      nextDelay = Math.max(intervalMs, (snapshot.cacheMaxAgeSeconds ?? 0) * 1000);
      const changed = tracker.update(snapshot);
      options.onUpdate(snapshot);
      if (!stopped && changed.length) {
        // Do not wait for a scan or user callback before scheduling the next read.
        Promise.resolve(options.onSignal(changed)).catch(reportError);
      }
    } catch {
      if (!stopped) {
        failures++;
        nextDelay = Math.min(60000, intervalMs * 2 ** Math.min(failures - 1, 10));
        reportError();
      }
    } finally {
      clearTimeout(timeout);
      if (controller === requestController) controller = undefined;
      if (!stopped) timer = setTimeout(() => { void poll(); }, nextDelay);
    }
  };
  void poll();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    controller?.abort();
  };
}
