import {
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  readFileSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
export type JournalState = {
  phase:
    | "idle"
    | "claimed"
    | "signed"
    | "broadcast"
    | "confirmed"
    | "failed"
    | "uncertain";
  candidateId?: string;
  token?: string;
  txHash?: string;
  nonce?: number;
  blockNumber?: string;
  reason?: string;
};
export class Journal {
  state: JournalState;
  private lockFd: number | undefined;
  constructor(readonly directory = "runtime/live") {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.state = this.readState();
  }
  private readState(): JournalState {
    const state = existsSync(`${this.directory}/state.json`)
      ? JSON.parse(readFileSync(`${this.directory}/state.json`, "utf8"))
      : { phase: "idle" };
    if (
      !state ||
      typeof state !== "object" ||
      ![
        "idle",
        "claimed",
        "signed",
        "broadcast",
        "confirmed",
        "failed",
        "uncertain",
      ].includes(state.phase)
    )
      throw Error("Invalid journal");
    return state;
  }
  private syncDirectory() {
    const fd = openSync(this.directory, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  lock() {
    if (this.lockFd !== undefined) throw Error("Journal already locked");
    this.lockFd = openSync(`${this.directory}/process.lock`, "wx", 0o600);
    try {
      writeFileSync(this.lockFd, String(process.pid));
      fsyncSync(this.lockFd);
      this.syncDirectory();
      // A different process may have completed a purchase since this instance was constructed.
      this.state = this.readState();
    } catch (error) {
      this.close();
      throw error;
    }
  }
  close() {
    if (this.lockFd !== undefined) {
      const fd = this.lockFd;
      this.lockFd = undefined;
      closeSync(fd);
      unlinkSync(`${this.directory}/process.lock`);
      this.syncDirectory();
    }
  }
  update(patch: Partial<JournalState>) {
    if (this.lockFd === undefined)
      throw Error("Journal must be locked before updating");
    const next = { ...this.state, ...patch };
    const path = `${this.directory}/state.json.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(next, null, 2));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(path, `${this.directory}/state.json`);
      this.syncDirectory();
      this.state = next;
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(path)) unlinkSync(path);
    }
  }
  claim(candidateId: string, token: string) {
    if (this.state.phase !== "idle") return false;
    this.update({ phase: "claimed", candidateId, token });
    return true;
  }
}
