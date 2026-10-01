import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadServerEnvironment } from "../src/wallet.js";

test("server startup never follows a dotenv symlink or reads a public wallet file", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "imd-env-audit-"));
  t.after(() => { delete process.env.IMD_ENV_AUDIT; rmSync(directory, { recursive: true, force: true }); });
  const file = join(directory, ".env");
  writeFileSync(file, "IMD_ENV_AUDIT=fixture-only\n", { mode: 0o644 });
  chmodSync(file, 0o644); // Exercise a public file even when the caller uses a private umask.
  assert.throws(() => loadServerEnvironment(file), /仅限当前用户/);
  assert.equal(process.env.IMD_ENV_AUDIT, undefined);
  chmodSync(file, 0o600);
  symlinkSync(file, join(directory, "linked.env"));
  assert.throws(() => loadServerEnvironment(join(directory, "linked.env")), /普通文件/);
  assert.equal(process.env.IMD_ENV_AUDIT, undefined);
  loadServerEnvironment(file);
  assert.equal(process.env.IMD_ENV_AUDIT, "fixture-only");
  process.env.IMD_ENV_AUDIT = "already-set";
  loadServerEnvironment(file);
  assert.equal(process.env.IMD_ENV_AUDIT, "already-set");
  assert.doesNotThrow(() => loadServerEnvironment(join(directory, "absent.env")));
});
