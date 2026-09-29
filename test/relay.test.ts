import assert from "node:assert/strict";
import test from "node:test";
import { keccak256, recoverMessageAddress, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  FlashbotsRelay,
  RelayError,
  type SuccessfulBundleSimulation,
} from "../src/relay.js";

// Public test key; never funded or used outside these mocked requests.
const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const txs = ["0x0201", "0x0202"] as const;
const bundleHash = `0x${"ab".repeat(32)}` as Hex;
const request = { txs, blockNumber: 101n, stateBlockNumber: 100n } as const;

function successfulResult() {
  return {
    bundleHash,
    stateBlockNumber: 100,
    totalGasUsed: 42_000,
    results: txs.map((tx) => ({ txHash: keccak256(tx), gasUsed: 21_000 })),
  };
}

interface CapturedRequest {
  body: string;
  parsed: { id: number; method: string; params: Record<string, unknown>[] };
  headers: Headers;
}

function mockRelay(result: unknown | ((request: CapturedRequest) => unknown)) {
  const requests: CapturedRequest[] = [];
  const fetch: typeof globalThis.fetch = async (_url, options) => {
    assert.ok(options);
    assert.equal(typeof options.body, "string");
    const body = options.body as string;
    const capture: CapturedRequest = {
      body,
      parsed: JSON.parse(body) as CapturedRequest["parsed"],
      headers: new Headers(options.headers),
    };
    requests.push(capture);
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: capture.parsed.id,
        result: typeof result === "function" ? result(capture) : result,
      }),
      { status: 200 },
    );
  };
  return {
    relay: new FlashbotsRelay({
      url: "https://relay.example",
      authSigner: account,
      fetch,
    }),
    requests,
  };
}

function errorCode(code: string) {
  return (error: unknown) => error instanceof RelayError && error.code === code;
}

test("authentication signs the UTF-8 digest of the exact JSON request body", async () => {
  const { relay, requests } = mockRelay(successfulResult());
  await relay.simulateBundle(request);
  const sent = requests[0]!;
  const signature = sent.headers
    .get("X-Flashbots-Signature")!
    .split(":")[1] as Hex;
  const message = keccak256(stringToHex(sent.body));
  assert.equal(
    await recoverMessageAddress({ message, signature }),
    account.address,
  );
  assert.notEqual(
    await recoverMessageAddress({ message: { raw: message }, signature }),
    account.address,
  );
  assert.equal(
    sent.headers.get("X-Flashbots-Signature"),
    `${account.address}:${await account.signMessage({ message })}`,
  );
  assert.equal(sent.parsed.method, "eth_callBundle");
  assert.deepEqual(sent.parsed.params[0], {
    txs,
    blockNumber: "0x65",
    stateBlockNumber: "0x64",
  });
});

test("only the exact successful simulation can be submitted, with no allowed reverts", async () => {
  const { relay, requests } = mockRelay(({ parsed }: CapturedRequest) =>
    parsed.method === "eth_callBundle"
      ? successfulResult()
      : { bundleHash, smart: "true" },
  );
  const mutable = { txs: [...txs], blockNumber: 101n, stateBlockNumber: 100n };
  const simulation = await relay.simulateBundle(mutable);
  mutable.txs.reverse();
  mutable.blockNumber = 102n;
  assert.deepEqual(
    await relay.sendBundle(simulation, { builders: ["flashbots"] }),
    { bundleHash, smart: true },
  );
  assert.deepEqual(requests[1]!.parsed.params[0], {
    txs,
    blockNumber: "0x65",
    builders: ["flashbots"],
  });
  assert.equal(
    Object.hasOwn(requests[1]!.parsed.params[0]!, "revertingTxHashes"),
    false,
  );
  await assert.rejects(
    relay.sendBundle({ ...simulation }),
    errorCode("SIMULATION_REQUIRED"),
  );
  const other = mockRelay(successfulResult()).relay;
  await assert.rejects(
    other.sendBundle(simulation),
    errorCode("SIMULATION_REQUIRED"),
  );
});

for (const field of ["error", "revert"]) {
  test(`per-transaction ${field} rejects simulation without exposing relay data`, async () => {
    const result = successfulResult();
    Object.assign(result.results[1]!, {
      [field]: "sensitive raw transaction and credential text",
    });
    const { relay, requests } = mockRelay(result);
    await assert.rejects(relay.simulateBundle(request), (error: unknown) => {
      assert.ok(error instanceof RelayError);
      assert.equal(error.code, "SIMULATION_FAILED");
      assert.equal(error.message.includes("sensitive"), false);
      return true;
    });
    assert.equal(requests.length, 1);
  });
}

const invalidResults: [string, () => unknown][] = [
  ["empty results", () => ({ ...successfulResult(), results: [] })],
  [
    "missing result",
    () => ({
      ...successfulResult(),
      results: successfulResult().results.slice(0, 1),
    }),
  ],
  [
    "missing result fields",
    () => ({ ...successfulResult(), results: [{}, {}] }),
  ],
  [
    "reordered transaction hashes",
    () => ({
      ...successfulResult(),
      results: successfulResult().results.reverse(),
    }),
  ],
  [
    "unrelated transaction hash",
    () => ({
      ...successfulResult(),
      results: [
        { txHash: bundleHash, gasUsed: 21_000 },
        successfulResult().results[1],
      ],
    }),
  ],
  [
    "missing gas total",
    () => ({ ...successfulResult(), totalGasUsed: undefined }),
  ],
  [
    "inconsistent gas total",
    () => ({ ...successfulResult(), totalGasUsed: 21_000 }),
  ],
  [
    "incorrect pinned state",
    () => ({ ...successfulResult(), stateBlockNumber: 99 }),
  ],
  [
    "target block already reached",
    () => ({ ...successfulResult(), stateBlockNumber: 101 }),
  ],
  [
    "invalid bundle hash",
    () => ({ ...successfulResult(), bundleHash: "0x1234" }),
  ],
  ["null result", () => null],
];

for (const [label, value] of invalidResults) {
  test(`rejects ${label}`, async () => {
    const { relay } = mockRelay(value());
    await assert.rejects(
      relay.simulateBundle(request),
      errorCode("INVALID_RESPONSE"),
    );
  });
}

test("rejects submission without simulation before making HTTP request", async () => {
  const { relay, requests } = mockRelay(successfulResult());
  await assert.rejects(
    relay.sendBundle({} as SuccessfulBundleSimulation),
    errorCode("SIMULATION_REQUIRED"),
  );
  assert.equal(requests.length, 0);
});

test("preserves a pinned simulation timestamp as send time constraints", async () => {
  const { relay, requests } = mockRelay(({ parsed }: CapturedRequest) =>
    parsed.method === "eth_callBundle" ? successfulResult() : { bundleHash },
  );
  await relay.sendBundle(
    await relay.simulateBundle({ ...request, timestamp: 1_800_000_000 }),
  );
  assert.deepEqual(requests[1]!.parsed.params[0], {
    txs,
    blockNumber: "0x65",
    minTimestamp: 1_800_000_000,
    maxTimestamp: 1_800_000_000,
  });
});

test("transport and JSON-RPC errors are sanitized", async () => {
  for (const fetch of [
    async () => {
      throw new Error("https://rpc.example?apiKey=SECRET");
    },
    async () =>
      new Response(
        JSON.stringify({ error: { message: "SECRET raw transaction" } }),
      ),
  ]) {
    const relay = new FlashbotsRelay({
      url: "https://relay.example?key=SECRET",
      authSigner: account,
      fetch,
    });
    await assert.rejects(relay.simulateBundle(request), (error: unknown) => {
      assert.ok(error instanceof RelayError);
      assert.equal(String(error).includes("SECRET"), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test("aborts an unresponsive relay request", async () => {
  const fetch: typeof globalThis.fetch = async (_url, options) =>
    new Promise((_resolve, reject) => {
      options!.signal!.addEventListener(
        "abort",
        () => reject(new Error("mock transport abort")),
        { once: true },
      );
    });
  const relay = new FlashbotsRelay({
    url: "https://relay.example",
    authSigner: account,
    timeoutMs: 5,
    fetch,
  });
  await assert.rejects(relay.simulateBundle(request), errorCode("TIMEOUT"));
});

test("requires HTTPS and nonempty bounded bundles before transport", async () => {
  assert.throws(
    () =>
      new FlashbotsRelay({ url: "http://relay.example", authSigner: account }),
    errorCode("INVALID_CONFIG"),
  );
  const { relay, requests } = mockRelay(successfulResult());
  await assert.rejects(
    relay.simulateBundle({ ...request, txs: [] }),
    errorCode("INVALID_BUNDLE"),
  );
  await assert.rejects(
    relay.simulateBundle({ ...request, txs: ["0x1"] }),
    errorCode("INVALID_BUNDLE"),
  );
  await assert.rejects(
    relay.simulateBundle({ ...request, stateBlockNumber: 101n }),
    errorCode("INVALID_BUNDLE"),
  );
  assert.equal(requests.length, 0);
});

test("relay rejects and cancels an oversized streaming response before buffering it", async () => {
  let cancelled = false;
  const relay = new FlashbotsRelay({
    url: "https://relay.example", authSigner: account,
    fetch: async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(600_000)); },
      cancel() { cancelled = true; },
    })),
  });
  await assert.rejects(relay.simulateBundle(request), errorCode("INVALID_RESPONSE"));
  assert.equal(cancelled, true);
});
