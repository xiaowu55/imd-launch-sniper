import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { CONTINUOUS_FRESH_MS } from "./testnet-continuous-policy.js";

export const RETAINED_CONTINUOUS_HISTORY = 256;
const uuid = z.uuid();
const discoverySchema = z.object({
  launchId: uuid, firstSeenAt: z.iso.datetime(),
  firstSeenHead: z.object({ number: z.string().regex(/^[1-9]\d{0,19}$/),
    hash: z.string().regex(/^0x[\da-f]{64}$/i) }).strict(),
  listCacheMaxAgeSeconds: z.number().int().nonnegative().max(86400).nullable(),
}).strict();
const archiveSchema = z.object({
  version: z.literal(1), discovery: discoverySchema,
  skipped: z.string().min(1).max(256), archivedAt: z.iso.datetime(),
}).strict();
export type ContinuousDiscovery = z.infer<typeof discoverySchema>;
type HistoryState = {
  discoveries: Record<string, ContinuousDiscovery>; skipped: Record<string, string>;
  selectedLaunchId?: string;
};
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function privateDirectory(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) ||
      (process.getuid && stat.uid !== process.getuid())) throw Error("fatal_history_directory");
}
function missing(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** Exact per-ID tombstones. Callers must hold the monitor's exclusive process lock. */
export class ContinuousHistory {
  constructor(readonly directory: string) {
    try {
      privateDirectory(dirname(directory));
      try { mkdirSync(directory, { mode: 0o700 }); syncDirectory(dirname(directory)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      privateDirectory(directory);
    } catch { throw Error("fatal_history_directory"); }
  }
  private path(id: string) {
    if (!uuid.safeParse(id).success) throw Error("fatal_history_id");
    return resolve(this.directory, `${id.toLowerCase()}.json`);
  }
  private read(id: string): z.infer<typeof archiveSchema> | null {
    const path = this.path(id);
    let fd: number | undefined;
    try {
      // Recheck the directory too: a missing/replaced archive must not revive IDs.
      privateDirectory(this.directory);
      try {
        const entry = lstatSync(path);
        if (!entry.isFile() || entry.isSymbolicLink()) throw Error("unsafe_history_file");
      } catch (error) { if (missing(error)) return null; throw error; }
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8192 || (stat.mode & 0o077) ||
          (process.getuid && stat.uid !== process.getuid())) throw Error("unsafe_history_file");
      const value = archiveSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
      if (value.discovery.launchId.toLowerCase() !== id.toLowerCase()) throw Error("history_id_mismatch");
      return value;
    } catch { throw Error("fatal_history_read"); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  historyExists(id: string): boolean { return this.read(id) !== null; }

  private archive(discovery: ContinuousDiscovery, skipped: string, nowMs: number) {
    const value = archiveSchema.parse({ version: 1, discovery, skipped,
      archivedAt: new Date(nowMs).toISOString() });
    const prior = this.read(discovery.launchId);
    if (prior) {
      // A crash after archive fsync but before monitor save is an idempotent retry.
      if (JSON.stringify(prior.discovery) !== JSON.stringify(value.discovery) || prior.skipped !== skipped)
        throw Error("fatal_history_mismatch");
      syncDirectory(this.directory);
      return;
    }
    const path = this.path(discovery.launchId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    let temporaryExists = false;
    try {
      fd = openSync(temporary, "wx", 0o600); temporaryExists = true;
      writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd);
      closeSync(fd); fd = undefined;
      renameSync(temporary, path); temporaryExists = false;
      syncDirectory(this.directory);
    } catch { throw Error("fatal_history_write"); }
    finally {
      if (fd !== undefined) closeSync(fd);
      if (temporaryExists) unlinkSync(temporary);
    }
  }

  /** Archive first; return replacement maps only after every archive is durable. */
  compact<T extends HistoryState>(state: T, nowMs: number): T {
    if (!Number.isFinite(nowMs) || nowMs < 0) throw Error("fatal_history_time");
    const discoveries = { ...state.discoveries };
    const skipped = { ...state.skipped };
    const expired: Array<{ id: string; discovery: ContinuousDiscovery; seen: number }> = [];
    for (const [id, discovery] of Object.entries(discoveries)) {
      if (!uuid.safeParse(id).success || id.toLowerCase() !== discovery.launchId.toLowerCase() ||
          !discoverySchema.safeParse(discovery).success) throw Error("fatal_history_discovery");
      const seen = Date.parse(discovery.firstSeenAt);
      if (id.toLowerCase() === state.selectedLaunchId?.toLowerCase() || nowMs - seen <= CONTINUOUS_FRESH_MS) continue;
      skipped[id] ??= "discovery_expired";
      expired.push({ id, discovery, seen });
    }
    expired.sort((a, b) => b.seen - a.seen || a.id.localeCompare(b.id));
    for (const { id, discovery } of expired.slice(RETAINED_CONTINUOUS_HISTORY)) {
      this.archive(discovery, skipped[id]!, nowMs);
      delete discoveries[id]; delete skipped[id];
    }
    // Anchor, baseline, selection and consumed budget are preserved verbatim.
    return { ...state, discoveries, skipped };
  }
}
