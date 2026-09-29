import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  statSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveWalletEnv,
  walletStatus,
  normalizePrivateKey,
  reloadWalletEnv,
} from "../src/wallet.js";
// Public test fixture only. Never funded and never used by the application.
const key = `0x${"1".repeat(64)}`;
test("wallet import preserves unrelated config, replaces duplicate key lines and sets 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "imd-wallet-"));
  try {
    const file = join(dir, ".env");
    writeFileSync(
      file,
      `PORT=8787\n# keep\nTRADING_PRIVATE_KEY=\nexport TRADING_PRIVATE_KEY='${key}'\nOTHER_SETTING=yes\n`,
      { mode: 0o644 },
    );
    const address = saveWalletEnv(key.slice(2), file);
    const contents = readFileSync(file, "utf8");
    assert.equal(address, walletStatus(key).address);
    assert.equal((contents.match(/TRADING_PRIVATE_KEY=/g) || []).length, 1);
    assert.ok(contents.includes("OTHER_SETTING=yes"));
    assert.ok(contents.includes("# keep"));
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("wallet status exposes only public metadata and rejects invalid or zero keys", () => {
  assert.deepEqual(Object.keys(walletStatus(key)).sort(), [
    "address",
    "configured",
    "source",
  ]);
  assert.equal(walletStatus("secret-invalid").configured, false);
  assert.equal(walletStatus(`0x${"0".repeat(64)}`).configured, false);
  assert.throws(
    () => normalizePrivateKey("secret-invalid"),
    (error) => !String(error).includes("secret-invalid"),
  );
});
test("wallet import refuses symlinks and multiline keys without changing files", () => {
  const dir = mkdtempSync(join(tmpdir(), "imd-wallet-"));
  try {
    const target = join(dir, "target");
    writeFileSync(target, "PORT=8787\n");
    symlinkSync(target, join(dir, ".env"));
    assert.throws(() => saveWalletEnv(key, join(dir, ".env")));
    assert.equal(readFileSync(target, "utf8"), "PORT=8787\n");
    const file = join(dir, "other");
    const content = 'TRADING_PRIVATE_KEY="\nold\n"\n';
    writeFileSync(file, content);
    assert.throws(() => saveWalletEnv(key, file));
    assert.equal(readFileSync(file, "utf8"), content);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("wallet reload validates before replacing the active process key", () => {
  const old = process.env.TRADING_PRIVATE_KEY;
  const dir = mkdtempSync(join(tmpdir(), "imd-wallet-"));
  try {
    const file = join(dir, ".env");
    process.env.TRADING_PRIVATE_KEY = key;
    writeFileSync(file, "TRADING_PRIVATE_KEY=bad\n");
    assert.throws(() => reloadWalletEnv(file));
    assert.equal(process.env.TRADING_PRIVATE_KEY, key);
    saveWalletEnv(key, file);
    assert.deepEqual(reloadWalletEnv(file), walletStatus(key));
  } finally {
    if (old === undefined) delete process.env.TRADING_PRIVATE_KEY;
    else process.env.TRADING_PRIVATE_KEY = old;
    rmSync(dir, { recursive: true, force: true });
  }
});
