import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { Hex } from "viem";
import { readBoundedJson } from "./bounded-json.js";
import {
  parseLaunchSnapshot,
  type LaunchHint,
  type LaunchSnapshot,
} from "./launch-feed.js";

const hintSchema = z.object({
  id: z.string().min(1).max(128),
  launchNumber: z.number().int().positive(),
  chainId: z.number().int().positive(),
  status: z.string().min(1),
  kind: z.string().optional(),
  token: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
});
const stateSchema = z.object({
  version: z.literal(1),
  baselineAt: z.string().datetime(),
  anchor: z.object({
    number: z.string().regex(/^\d+$/),
    hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  }),
  excluded: z.array(z.string()),
  pending: z.array(hintSchema),
  decisions: z.record(z.string(), z.string()),
});
export type ApiSessionState = z.infer<typeof stateSchema>;

/** A server cooldown is independent of the response's cache freshness lifetime. */
export function parseApiRetryAfter(value: string | null, now = Date.now()): number | null {
  if (value === null || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const text = value.trim();
  let milliseconds: number;
  if (/^\d+(?:\.\d+)?$/.test(text)) milliseconds = Number(text) * 1000;
  else if (/^[A-Za-z]{3,9},?\s/.test(text)) milliseconds = Date.parse(text) - now;
  else return null;
  // Preserve long server advice instead of shortening it to a retry cap. The
  // scheduler must split waits above Node's 2^31-1 ms timer limit into chunks.
  const result = Math.max(0, Math.ceil(milliseconds));
  return Number.isSafeInteger(result) ? result : null;
}

export class ApiHttpError extends Error {
  readonly retryable: boolean;
  constructor(readonly status: number, readonly retryAfterMs: number | null) {
    super(`官方 API 当前不可用（HTTP ${status}）`);
    this.name = "ApiHttpError";
    this.retryable = status === 429 || status === 503;
  }
}

export type ApiFetchTiming = Readonly<{
  page: number;
  startedAt: string;
  finishedAt: string;
  startedMonotonicMs: number;
  finishedMonotonicMs: number;
  durationMs: number;
  headersMs: number | null;
  /** Includes bounded body streaming, UTF-8 decoding and JSON parsing. */
  bodyAndParseMs: number | null;
  validationMs: number | null;
  status: number | null;
  rowCount: number | null;
  outcome: "success" | "http_error" | "invalid_response" | "request_failed" | "aborted";
  retryAfterMs: number | null;
  headers: Readonly<{
    cacheControl: string | null;
    ageSeconds: number | null;
    etag: string | null;
    date: string | null;
    declaredBytes: number | null;
  }>;
}>;
export type ApiFetchOptions = {
  onTiming?: (timing: ApiFetchTiming) => void | Promise<void>;
};

function safeHeader(value: string | null, maximumLength = 512): string | null {
  return value !== null && value.length <= maximumLength && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}
function integerHeader(value: string | null): number | null {
  if (value === null || !/^\d{1,16}$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

/** The official list provides identity and newness. It never authorizes arbitrary calldata. */
export class ApiSession {
  state: ApiSessionState | null;
  private filename: string;
  constructor(
    mode: "live" | "dry-run",
    private directory = "runtime/api",
  ) {
    this.filename = join(directory, `${mode}.json`);
    this.state = existsSync(this.filename)
      ? stateSchema.parse(JSON.parse(readFileSync(this.filename, "utf8")))
      : null;
  }
  private write(state: ApiSessionState) {
    const validated = stateSchema.parse(state);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(validated, null, 2));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.filename);
      const dirFd = openSync(this.directory, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
      this.state = validated;
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  initialize(snapshot: LaunchSnapshot, anchor: { number: bigint; hash: Hex }) {
    if (this.state) return;
    this.write({
      version: 1,
      baselineAt: new Date().toISOString(),
      anchor: { number: anchor.number.toString(), hash: anchor.hash },
      excluded: snapshot.launches
        .filter((x) => x.chainId === 1 && x.status === "live")
        .map((x) => x.id),
      pending: [],
      decisions: {},
    });
  }
  enqueue(snapshot: LaunchSnapshot) {
    if (!this.state) throw Error("API baseline missing");
    const pending = new Map(this.state.pending.map((hint) => [hint.id, hint]));
    for (const hint of snapshot.launches) {
      // An absent row may have rotated out of the list, but an explicit
      // withdrawal or network correction invalidates our prior live evidence.
      if (hint.chainId !== 1 || hint.status !== "live") {
        pending.delete(hint.id);
        continue;
      }
      if (
        this.state.excluded.includes(hint.id) ||
        Object.hasOwn(this.state.decisions, hint.id)
      )
        continue;
      pending.set(hint.id, hint);
    }
    const next = [...pending.values()];
    if (JSON.stringify(next) !== JSON.stringify(this.state.pending))
      this.write({ ...this.state, pending: next });
  }
  finish(id: string, reason: string) {
    if (!this.state) throw Error("API baseline missing");
    this.write({
      ...this.state,
      pending: this.state.pending.filter((x) => x.id !== id),
      decisions: { ...this.state.decisions, [id]: reason },
    });
  }
  pending(): LaunchHint[] {
    return (this.state?.pending ?? []) as LaunchHint[];
  }
}

/** A complete baseline prevents list pagination from turning older rows into new launches. */
export async function fetchApiBaseline(
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  options: ApiFetchOptions = {},
): Promise<LaunchSnapshot> {
  const all: LaunchHint[] = [];
  const ids = new Set<string>();
  let before: number | undefined;
  let last: LaunchSnapshot | undefined;
  for (let page = 0; page < 100; page++) {
    const url = `https://api.imd.fun/launches?limit=500${before === undefined ? "" : `&before=${before}`}`;
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
      : AbortSignal.timeout(8000);
    const startedAt = new Date().toISOString();
    const startedMonotonicMs = performance.now();
    let headersMs: number | null = null;
    let bodyAndParseMs: number | null = null;
    let validationMs: number | null = null;
    let status: number | null = null;
    let rowCount: number | null = null;
    let retryAfterMs: number | null = null;
    let outcome: ApiFetchTiming["outcome"] = "request_failed";
    let headers: ApiFetchTiming["headers"] = {
      cacheControl: null, ageSeconds: null, etag: null, date: null, declaredBytes: null,
    };
    try {
      const response = await fetchImpl(url, {
        redirect: "error",
        signal: requestSignal,
      });
      headersMs = performance.now() - startedMonotonicMs;
      status = response.status;
      retryAfterMs = parseApiRetryAfter(response.headers.get("retry-after"));
      headers = {
        cacheControl: safeHeader(response.headers.get("cache-control")),
        ageSeconds: integerHeader(response.headers.get("age")),
        etag: safeHeader(response.headers.get("etag")),
        date: safeHeader(response.headers.get("date"), 128),
        declaredBytes: integerHeader(response.headers.get("content-length")),
      };
      if (!response.ok) {
        outcome = "http_error";
        // Never download or expose an error body/statusText, which may contain
        // credentials. Cancel the stream instead of leaving it unconsumed.
        void response.body?.cancel().catch(() => {});
        throw new ApiHttpError(status, retryAfterMs);
      }
      outcome = "invalid_response";
      const bodyStarted = performance.now();
      let value: unknown;
      try { value = await readBoundedJson(response, 4 * 1024 * 1024, requestSignal); }
      finally { bodyAndParseMs = performance.now() - bodyStarted; }
      const validationStarted = performance.now();
      try {
        last = parseLaunchSnapshot(value, response.headers.get("cache-control"));
        rowCount = last.launches.length;
        for (const hint of last.launches) {
          if (ids.has(hint.id)) throw Error("官方 API 分页重复，无法建立可靠起点");
          ids.add(hint.id);
          all.push(hint);
        }
        if (last.launches.length < 500) {
          outcome = "success";
          return {
            ...last,
            source: "https://api.imd.fun/launches?limit=500",
            launches: all,
          };
        }
        const oldest = Math.min(...last.launches.map((x) => x.launchNumber));
        if (before !== undefined && oldest >= before)
          throw Error("官方 API 分页起点未推进");
        before = oldest;
        outcome = "success";
      } finally { validationMs = performance.now() - validationStarted; }
    } finally {
      const finishedMonotonicMs = performance.now();
      const timing: ApiFetchTiming = Object.freeze({
        page: page + 1, startedAt, finishedAt: new Date().toISOString(),
        startedMonotonicMs, finishedMonotonicMs,
        durationMs: finishedMonotonicMs - startedMonotonicMs,
        headersMs, bodyAndParseMs, validationMs, status, rowCount, retryAfterMs,
        outcome: requestSignal.aborted ? "aborted" : outcome,
        headers: Object.freeze(headers),
      });
      // Do not await telemetry. Observer failures cannot seed partial history
      // or mask the real read/validation error.
      try { void Promise.resolve(options.onTiming?.(timing)).catch(() => {}); }
      catch { /* Preserve the fetch result if a telemetry consumer fails. */ }
    }
  }
  throw Error("官方 API 历史过大，无法确认观察起点");
}
