// Read-only availability snapshot; never creates a signer or sends transactions.
// Official endpoints: https://ethereum.publicnode.com/
// and https://drpc.org/docs/ethereum-api
// Run: npx tsx scripts/check-public-rpc.ts
const poolManager = "0x000000000004444c5dc75cB358380D2e3dE08A90";
const httpUrls = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.drpc.org",
];
const wsUrl = "wss://ethereum-rpc.publicnode.com";

async function rpc(url: string, method: string, params: unknown[] = []) {
  const started = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const data = (await response.json()) as {
    result?: unknown;
    error?: { code: number; message: string };
  };
  if (data.error)
    throw new Error(`${method}: ${data.error.code} ${data.error.message}`);
  if (!("result" in data)) throw new Error(`${method}: Missing result`);
  return {
    result: data.result,
    milliseconds: Math.round(performance.now() - started),
  };
}

async function checkHttp(url: string) {
  try {
    const chain = await rpc(url, "eth_chainId");
    if (chain.result !== "0x1")
      throw new Error("Endpoint is not Ethereum mainnet");
    const block = await rpc(url, "eth_blockNumber");
    if (
      typeof block.result !== "string" ||
      !/^0x[0-9a-f]+$/i.test(block.result)
    )
      throw new Error("Invalid block number");
    const logs = await rpc(url, "eth_getLogs", [
      {
        fromBlock: block.result,
        toBlock: block.result,
        address: poolManager,
      },
    ]);
    if (!Array.isArray(logs.result)) throw new Error("Invalid getLogs result");
    return {
      url,
      ok: true,
      chainId: 1,
      blockNumber: Number(BigInt(block.result)),
      rpcMilliseconds: {
        chainId: chain.milliseconds,
        blockNumber: block.milliseconds,
        getLogs: logs.milliseconds,
      },
      singleBlockLogCount: logs.result.length,
    };
  } catch (error) {
    return { url, ok: false, error: String(error) };
  }
}

async function checkWebSocket(url: string) {
  return new Promise<Record<string, unknown>>((resolve) => {
    const started = performance.now();
    const socket = new WebSocket(url);
    const record: Record<string, unknown> = { url, ok: false };
    let chainVerified = false;
    let subscribed = false;
    let headReceived = false;
    let finished = false;
    const finish = (error?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      record.ok = chainVerified && subscribed && headReceived;
      if (error) record.error = error;
      socket.close();
      resolve(record);
    };
    const timer = setTimeout(
      () =>
        finish("No fully verified mainnet newHeads event within 20 seconds"),
      20_000,
    );
    socket.addEventListener("open", () => {
      record.connectMilliseconds = Math.round(performance.now() - started);
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_chainId",
          params: [],
        }),
      );
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "eth_subscribe",
          params: ["newHeads"],
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(String(event.data));
        if (data.error) return finish(JSON.stringify(data.error));
        if (data.id === 1) {
          if (data.result !== "0x1")
            return finish("Endpoint is not Ethereum mainnet");
          chainVerified = true;
          record.chainId = 1;
        }
        if (data.id === 2 && typeof data.result === "string") {
          subscribed = true;
          record.subscribeMilliseconds = Math.round(
            performance.now() - started,
          );
        }
        if (data.method === "eth_subscription" && data.params?.result?.number) {
          headReceived = true;
          record.newHeadBlockNumber = Number(BigInt(data.params.result.number));
          record.waitForNewHeadMilliseconds = Math.round(
            performance.now() - started,
          );
        }
        if (chainVerified && subscribed && headReceived) finish();
      } catch (error) {
        finish(String(error));
      }
    });
    socket.addEventListener("error", () =>
      finish("WebSocket connection failed"),
    );
    socket.addEventListener("close", () => {
      if (!finished)
        finish("WebSocket closed before a verified newHeads event");
    });
  });
}

const results = await Promise.all([
  ...httpUrls.map(checkHttp),
  checkWebSocket(wsUrl),
]);
console.log(
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      mode: "READ_ONLY_PUBLIC_RPC_CHECK",
      note: "Single availability snapshot, not a speed guarantee. New-head wait includes waiting for the next block. No pending feed or transaction broadcast was tested.",
      results,
    },
    null,
    2,
  ),
);
if (results.some((result) => !result.ok)) process.exitCode = 1;

export {};
