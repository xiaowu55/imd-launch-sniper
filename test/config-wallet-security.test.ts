import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { configSchema, loadConfig, saveConfig } from "../src/config.js";
import {
  normalizePrivateKey,
  reloadWalletEnv,
  saveWalletEnv,
} from "../src/wallet.js";

// Public, never-funded fixture. These tests never open the application's real .env.
const fixtureKey = `0x${"1".repeat(64)}`;

function workspace(t: TestContext) {
  const directory = fs.mkdtempSync(join(tmpdir(), "imd-config-security-"));
  const original = process.cwd();
  process.chdir(directory);
  t.after(() => {
    process.chdir(original);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test("malformed URLs and numeric strings are validation failures, never uncaught parsing errors", () => {
  for (const input of [
    { rpcHttpUrls: ["not a URL"] },
    { rpcWsUrls: ["%"] },
    { rpcHttpUrls: ["file:///tmp/local"] },
    { rpcWsUrls: ["https://example.invalid"] },
    { buyAmountEth: "garbage" },
    { maxFeeGwei: "NaN" },
    { priorityFeeGwei: "1e6" },
    { buyAmountEth: "9".repeat(100000) },
    { startBlock: "9".repeat(100000) },
  ])
    assert.equal(configSchema.safeParse(input).success, false);
});

test("fee precision cannot silently round a configured gas price to another wei value", () => {
  assert.equal(
    configSchema.safeParse({ maxFeeGwei: "0.000000001", priorityFeeGwei: "0" })
      .success,
    true,
  );
  assert.equal(
    configSchema.safeParse({ maxFeeGwei: "0.0000000001", priorityFeeGwei: "0" })
      .success,
    false,
  );
  assert.equal(
    configSchema.safeParse({ priorityFeeGwei: "1.0000000001" }).success,
    false,
  );
  assert.equal(
    configSchema.safeParse({ maxFeeGwei: "0", priorityFeeGwei: "0" }).success,
    false,
  );
  assert.equal(
    configSchema.safeParse({ maxGasEth: "9".repeat(78) }).success,
    false,
  );
});

test("configuration bounds arrays, URLs, block numbers and prototype-shaped extra fields", () => {
  for (const input of [
    { rpcHttpUrls: [`https://example.invalid/${"a".repeat(2048)}`] },
    { allowedKinds: Array(500).fill("evm_project") },
    { allowedHooks: Array(129).fill(`0x${"0".repeat(40)}`) },
    { startBlock: "18446744073709551616" },
    { minLaunchNumber: Number.MAX_SAFE_INTEGER + 1 },
    JSON.parse('{"__proto__":{"polluted":true}}'),
    JSON.parse('{"constructor":{"prototype":{"polluted":true}}}'),
  ])
    assert.equal(configSchema.safeParse(input).success, false);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(
    configSchema.safeParse({ startBlock: "18446744073709551615" }).success,
    true,
  );
});

test("settings writes ignore planted fixed-temp symlinks and keep RPC credentials owner-only", (t) => {
  workspace(t);
  fs.mkdirSync("runtime", { mode: 0o700 });
  fs.writeFileSync("canary", "do not change");
  fs.symlinkSync(join(process.cwd(), "canary"), "runtime/settings.json.tmp");
  const saved = saveConfig({
    rpcHttpUrls: ["https://example.invalid/fixture-api-key"],
  });
  assert.equal(fs.readFileSync("canary", "utf8"), "do not change");
  assert.deepEqual(loadConfig(), saved);
  assert.equal(fs.statSync("runtime/settings.json").mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync("runtime").sort(), [
    "settings.json",
    "settings.json.tmp",
  ]);
});

test("settings load rejects symlinks and oversized files; save rejects symlinked runtime directories", (t) => {
  workspace(t);
  fs.mkdirSync("runtime", { mode: 0o700 });
  fs.writeFileSync("fixture-settings", "{}");
  fs.symlinkSync(
    join(process.cwd(), "fixture-settings"),
    "runtime/settings.json",
  );
  assert.throws(() => loadConfig());
  fs.unlinkSync("runtime/settings.json");
  fs.writeFileSync("runtime/settings.json", " ".repeat(32769));
  assert.throws(() => loadConfig(), /受限|过大/);
  fs.rmSync("runtime", { recursive: true });
  fs.mkdirSync("elsewhere");
  fs.symlinkSync(join(process.cwd(), "elsewhere"), "runtime");
  assert.throws(() => saveConfig({}), /本机目录/);
  assert.deepEqual(fs.readdirSync("elsewhere"), []);
});

test("both load and save retire the old simulation option without changing trade budgets", (t) => {
  workspace(t);
  fs.mkdirSync("runtime", { mode: 0o700 });
  fs.writeFileSync(
    "runtime/settings.json",
    JSON.stringify({ taxCheck: "simulate", buyAmountEth: "0.02" }),
  );
  assert.equal(loadConfig().taxCheck, "off");
  assert.equal(loadConfig().buyAmountEth, "0.02");
  assert.equal(configSchema.parse({}).taxCheck, "off");
  assert.equal(saveConfig({ taxCheck: "simulate" }).taxCheck, "off");
  assert.equal(
    JSON.parse(fs.readFileSync("runtime/settings.json", "utf8")).taxCheck,
    "off",
  );
});

test("wallet replacement handles colon/backtick/BOM forms without retaining previous secret definitions", (t) => {
  const directory = workspace(t);
  const file = join(directory, ".env");
  fs.writeFileSync(
    file,
    "\uFEFFTRADING_PRIVATE_KEY: previous-colon-fixture\nexport TRADING_PRIVATE_KEY=`previous-backtick-fixture`\nPORT=8787\n",
  );
  saveWalletEnv(fixtureKey, file);
  const result = fs.readFileSync(file, "utf8");
  assert(!result.includes("previous-colon-fixture"));
  assert(!result.includes("previous-backtick-fixture"));
  assert.equal((result.match(/TRADING_PRIVATE_KEY/g) ?? []).length, 1);
  assert(result.includes("PORT=8787"));
});

test("wallet replacement preserves unrelated multiline values and rejects multiline private-key definitions", (t) => {
  const directory = workspace(t);
  const file = join(directory, ".env");
  const other = 'OTHER="first\nTRADING_PRIVATE_KEY=literal-example\nlast"\n';
  fs.writeFileSync(file, other);
  saveWalletEnv(fixtureKey, file);
  assert(fs.readFileSync(file, "utf8").includes(other));
  for (const quote of ["'", '"', "`"]) {
    const malformed = `TRADING_PRIVATE_KEY=${quote}\nold-fixture\n${quote}\n`;
    fs.writeFileSync(file, malformed);
    assert.throws(() => saveWalletEnv(fixtureKey, file), /单行格式/);
    assert.equal(fs.readFileSync(file, "utf8"), malformed);
  }
});

test("wallet reads refuse oversized, shared-readable and symbolic-link files without changing active key", (t) => {
  const directory = workspace(t);
  const file = join(directory, ".env");
  const old = process.env.TRADING_PRIVATE_KEY;
  process.env.TRADING_PRIVATE_KEY = "unchanged-fixture";
  t.after(() => {
    if (old === undefined) delete process.env.TRADING_PRIVATE_KEY;
    else process.env.TRADING_PRIVATE_KEY = old;
  });
  fs.writeFileSync(file, `TRADING_PRIVATE_KEY=${fixtureKey}\n`, {
    mode: 0o644,
  });
  fs.chmodSync(file, 0o644);
  assert.throws(() => reloadWalletEnv(file), /仅限当前用户/);
  fs.writeFileSync(file, "x".repeat(65537));
  assert.throws(() => saveWalletEnv(fixtureKey, file), /64 KiB/);
  fs.unlinkSync(file);
  fs.symlinkSync(join(directory, "missing-target"), file);
  assert.throws(() => saveWalletEnv(fixtureKey, file));
  assert.equal(process.env.TRADING_PRIVATE_KEY, "unchanged-fixture");
  assert.throws(() => normalizePrivateKey("f".repeat(100000)), /过长/);
});

test("failed fsync removes secret-bearing temporary files and preserves previous wallet/settings", (t) => {
  const directory = workspace(t);
  saveConfig({ buyAmountEth: "0.01" });
  const file = join(directory, ".env");
  fs.writeFileSync(file, "PORT=8787\n", { mode: 0o600 });
  const mock = t.mock.method(fs, "fsyncSync", () => {
    throw new Error("fixture disk failure");
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => saveWalletEnv(fixtureKey, file),
      /fixture disk failure/,
    );
    assert.throws(
      () => saveConfig({ buyAmountEth: "0.02" }),
      /fixture disk failure/,
    );
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(fs.readFileSync(file, "utf8"), "PORT=8787\n");
  assert.equal(loadConfig().buyAmountEth, "0.01");
  assert.deepEqual(fs.readdirSync("runtime"), ["settings.json"]);
  assert.equal(
    fs.readdirSync(directory).some((name) => name.endsWith(".tmp")),
    false,
  );
});
