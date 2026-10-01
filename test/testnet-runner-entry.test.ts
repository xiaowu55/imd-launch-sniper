import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { runTestnetBuy } from "../scripts/testnet-buy.js";
import type { ResolvedApiLaunch } from "../src/api-launch.js";

const id = "cd74e008-6a11-47be-b242-012cc4529697";

test("runner import does not execute CLI, set exitCode, contact RPC or load the wallet", () => {
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    "globalThis.fetch=()=>{throw Error('network_on_import')}; await import('./scripts/testnet-buy.ts'); if(process.exitCode!==undefined)throw Error('exit_changed'); console.log('import_ok');"],
    { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(output.trim(), "import_ok");
});

test("runner rejects forged prevalidated evidence before wallet and network access", async () => {
  const previous = process.exitCode;
  const originalFetch = globalThis.fetch;
  const logs: unknown[] = [];
  globalThis.fetch = async () => { throw Error("unexpected_network"); };
  try {
    const result = await runTestnetBuy(["buy-continuous", id], {
      resolvedLaunch: { detail: { id }, deployment: { chainId: 11155111 } } as ResolvedApiLaunch<11155111>,
      output: (value) => logs.push(value),
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.journal, undefined);
    assert.equal(process.exitCode, previous);
    assert.equal(logs.length, 1);
    assert.match(JSON.stringify(logs), /stopped at arguments/);
  } finally { globalThis.fetch = originalFetch; }
});

test("aborted in-process execution stops before any wallet operation and keeps host exitCode unchanged", async () => {
  const previous = process.exitCode;
  const result = await runTestnetBuy(["buy-continuous", id], { signal: AbortSignal.abort(), output: () => {} });
  assert.equal(result.exitCode, 1);
  assert.equal(result.journal, undefined);
  assert.equal(process.exitCode, previous);
});

test("the in-process entry refuses concurrent calls without disturbing the active call's context", async () => {
  const previous = process.exitCode;
  let concurrent: ReturnType<typeof runTestnetBuy> | undefined;
  const result = await runTestnetBuy(["invalid-command"], {
    output: () => { concurrent = runTestnetBuy(["buy-continuous", id], { output: () => assert.fail("concurrent output") }); },
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(await concurrent, { exitCode: 1 });
  assert.equal(process.exitCode, previous);
});

test("context evidence is read once before trust verification", async () => {
  let reads = 0;
  const result = await runTestnetBuy(["buy-continuous", id], {
    get resolvedLaunch() { reads++; return {} as ResolvedApiLaunch<11155111>; },
    output: () => {},
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.journal, undefined);
  assert.equal(reads, 1);
});
