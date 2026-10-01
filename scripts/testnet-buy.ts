import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createPublicClient, erc20Abi, formatEther, formatUnits, http, keccak256,
  type Address, type Hex, type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { isVerifiedApiLaunch, resolveApiLaunch, trustedUniswap, type ResolvedApiLaunch } from "../src/api-launch.js";
import { Journal, type JournalState } from "../src/journal.js";
import { fetchApiBaseline } from "../src/api-session.js";
import { reloadWalletEnv, saveWalletEnv } from "../src/wallet.js";
import { encodeBuy, minimumOut, quoterAbi } from "../src/v4.js";
import {
  checkSignedTestnetTransaction, checkTestnetBudget, TESTNET_BUY_WEI,
  TESTNET_CHAIN_ID, TESTNET_MAX_GAS_WEI, TESTNET_SLIPPAGE_BPS,
  type TestnetTransaction,
} from "./testnet-policy.js";
import { validateContinuousLaunchAge, validateContinuousMonitor, validateFreshLiveSet, validateFreshObservation, type FreshObservation } from "./testnet-fresh-policy.js";
import { settleChecks, StageBlockReads, TestnetProtocolVerifier, validateActionAge } from "./testnet-execution-cache.js";

export type TestnetBuyContext = {
  resolvedLaunch?: ResolvedApiLaunch<11155111>;
  output?: (value: unknown) => void;
  signal?: AbortSignal;
};
export type TestnetBuyResult = { exitCode: number; journal?: JournalState };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIRECTORY = resolve(ROOT, "runtime/testnet");
const WALLET = resolve(DIRECTORY, "wallet.env");
let evidenceDirectory = DIRECTORY;
let fresh = false;
let continuous = false;
let freshMonotonicDeadline: number | undefined;
let clockOrigin = { id: "", at: "", mono: 0 };
const RPC_URLS = [
  "https://sepolia.rpc.sentio.xyz",
  "https://ethereum-sepolia-rpc.publicnode.com",
] as const;
const protocol = trustedUniswap(TESTNET_CHAIN_ID);
let stage = "arguments";
let stageStarted = 0;
let stageDurations: Array<{ stage: string; startElapsedMs: number; durationMs: number }> = [];
let persistTimings = false;
let runContext: TestnetBuyContext = {};
let runActive = false;
let exitCode = 0;
let lastJournalState: JournalState | undefined;
let protocolVerifier = new TestnetProtocolVerifier(Object.values(protocol));

function output(value: unknown) {
  if (runContext.output) runContext.output(value);
  else process.stdout.write(JSON.stringify(value, (_, item) =>
      typeof item === "bigint" ? item.toString() : item, 2) + "\n");
}

function checkActive() {
  if (runContext.signal?.aborted) throw new Error("testnet_execution_cancelled");
}

function setStage(next: string) {
  const now = performance.now();
  if (stageStarted) stageDurations.push({ stage, startElapsedMs: stageStarted - clockOrigin.mono, durationMs: now - stageStarted });
  stage = next;
  stageStarted = now;
  if (persistTimings) saveEvidence("stage-timing.json", {
    runId: clockOrigin.id, startedAt: clockOrigin.at, currentStage: stage,
    elapsedMs: now - clockOrigin.mono, completedStages: stageDurations,
  });
}

function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
    throw new Error("unsafe_testnet_directory");
}

function saveEvidence(name: string, value: unknown) {
  const path = resolve(evidenceDirectory, name);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value, (_, item) =>
      typeof item === "bigint" ? item.toString() : item, 2) + "\n");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    const directory = openSync(evidenceDirectory, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function readLocalJson(path: string, maxBytes = 1_000_000): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes ||
        (process.getuid && stat.uid !== process.getuid())) throw new Error("fresh_observation_invalid");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}

function checkContinuousConsent(observation: FreshObservation) {
  checkActive();
  if (!continuous) return;
  // Treat any STOP directory entry, including a dangling symlink, as an explicit stop.
  try {
    lstatSync(resolve(DIRECTORY, "continuous/STOP"));
    throw new Error("continuous_stop_requested");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  validateContinuousMonitor(readLocalJson(resolve(DIRECTORY, "continuous/monitor.json"), 16_000_000), observation);
}

function readFreshObservation(id: string, launchBlock?: bigint): FreshObservation {
  const observation = validateFreshObservation(
    readLocalJson(resolve(evidenceDirectory, "observation.json")), id, Date.now(), launchBlock);
  if (observation.version !== (continuous ? 2 : 1)) throw new Error("fresh_observation_invalid");
  freshMonotonicDeadline ??= performance.now() + Math.max(0, Date.parse(observation.deadlineAt) - Date.now());
  checkFreshDeadline(observation);
  checkContinuousConsent(observation);
  return observation;
}

function checkFreshDeadline(observation: FreshObservation) {
  checkActive();
  if (freshMonotonicDeadline === undefined || performance.now() >= freshMonotonicDeadline ||
      Date.now() >= Date.parse(observation.deadlineAt)) throw new Error("fresh_observation_expired");
}

async function checkFreshObservation(
  expected: FreshObservation, id: string, clients: PublicClient[], launchBlock?: bigint,
  reads = new StageBlockReads(),
) {
  const current = readFreshObservation(id, launchBlock);
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("fresh_observation_changed");
  await settleChecks(clients.map(async (client) => {
    const [anchor, discovery] = await settleChecks([
      reads.block(client, BigInt(current.anchor.number)),
      reads.block(client, BigInt(current.discovery.firstSeenHead.number)),
    ]);
    if (anchor.hash !== current.anchor.hash || discovery.hash !== current.discovery.firstSeenHead.hash)
      throw new Error("fresh_observation_reorg");
  }));
  // A network call cannot extend the explicitly authorized observation window.
  validateFreshObservation(current, id, Date.now(), launchBlock);
  checkFreshDeadline(current);
  checkContinuousConsent(current);
}

function accountFromIsolatedFile(create: boolean) {
  if (!existsSync(WALLET)) {
    if (!create) throw new Error("run_prepare_first");
    saveWalletEnv(generatePrivateKey(), WALLET);
  }
  // reloadWalletEnv enforces O_NOFOLLOW, bounded size, ownership and mode 0600.
  // Explicitly replace an inherited environment key, then restore it immediately.
  const previous = process.env.TRADING_PRIVATE_KEY;
  try {
    reloadWalletEnv(WALLET);
    return privateKeyToAccount(process.env.TRADING_PRIVATE_KEY as Hex);
  } finally {
    if (previous === undefined) delete process.env.TRADING_PRIVATE_KEY;
    else process.env.TRADING_PRIVATE_KEY = previous;
  }
}

function makeClients(): PublicClient[] {
  return RPC_URLS.map((url) => createPublicClient({
    chain: sepolia,
    transport: http(url, { retryCount: 0, timeout: 12000, fetchOptions: { signal: runContext.signal } }),
  }) as PublicClient);
}

async function checkChains(clients: PublicClient[]) {
  const chains = await settleChecks(clients.map((client) => client.getChainId()));
  if (chains.some((chainId) => chainId !== TESTNET_CHAIN_ID))
    throw new Error("testnet_rpc_chain_mismatch");
}

async function checkProtocol(clients: PublicClient[], blockNumber: bigint, blockHash: Hex, reads = new StageBlockReads()) {
  await protocolVerifier.verify(clients, blockNumber, blockHash, reads);
  checkActive();
}

type Attempt = {
  chainId: 11155111;
  address: Address;
  launchId: string;
  token: Address;
  tokenBalanceBefore: string;
  minimumOutput: string;
  expectedOutput: string;
  amountInWei: string;
  decimals: number;
  quoteBlockNumber: string;
  quoteBlockHash: Hex;
  quoteBlockTimestamp?: string;
  resolutionSource?: "in_process_verified" | "resolved_in_runner";
  launchBlock?: { number: string; hash: Hex; timestamp: string; transactionIndex: number };
  discoveryBlock?: { number: string; hash: string; timestamp: string };
  observation?: FreshObservation;
  apiChecks?: Array<{ stage: string; checkedAt: string; listCacheMaxAgeSeconds: number | null; liveCount: number }>;
  timing?: {
    clockId: string;
    processStartedAt: string;
    milestones: Partial<Record<"signedAt" | "broadcastStartedAt" | "firstRpcAcceptedAt" | "confirmedObservedAt", {
      at: string; elapsedMs: number | null;
    }>>;
  };
  preparedAt: string;
};

async function checkFreshApi(observation: FreshObservation, attempt: Attempt, checkStage: string) {
  const snapshot = await fetchApiBaseline(runContext.signal);
  validateFreshLiveSet(observation, snapshot.launches);
  checkFreshDeadline(observation);
  (attempt.apiChecks ??= []).push({ stage: checkStage, checkedAt: snapshot.checkedAt,
    listCacheMaxAgeSeconds: snapshot.cacheMaxAgeSeconds ?? null,
    liveCount: snapshot.launches.filter((row) => row.chainId === TESTNET_CHAIN_ID && row.status === "live").length });
}

function clockReading() { return { at: new Date().toISOString(), mono: performance.now() }; }

function stamp(attempt: Attempt, key: "signedAt" | "broadcastStartedAt" | "firstRpcAcceptedAt" | "confirmedObservedAt", observed = clockReading()) {
  attempt.timing ??= { clockId: clockOrigin.id, processStartedAt: clockOrigin.at, milestones: {} };
  // Status runs in a new process: do not subtract unrelated monotonic clocks.
  attempt.timing.milestones[key] ??= {
    at: observed.at,
    elapsedMs: attempt.timing.clockId === clockOrigin.id ? observed.mono - clockOrigin.mono : null,
  };
  saveEvidence("attempt.json", attempt);
}

function readAttempt(address: Address, token: string | undefined): Attempt {
  const raw = JSON.parse(readFileSync(resolve(evidenceDirectory, "attempt.json"), "utf8")) as Attempt;
  if (raw.chainId !== TESTNET_CHAIN_ID || raw.address.toLowerCase() !== address.toLowerCase() ||
      raw.token?.toLowerCase() !== token?.toLowerCase() ||
      raw.amountInWei !== TESTNET_BUY_WEI.toString() ||
      !/^\d+$/.test(raw.tokenBalanceBefore) || !/^[1-9]\d*$/.test(raw.minimumOutput) ||
      !Number.isInteger(raw.decimals) || raw.decimals < 0 || raw.decimals > 255)
    throw new Error("testnet_attempt_mismatch");
  if (fresh) {
    if (!raw.observation || !raw.launchBlock || !raw.discoveryBlock)
      throw new Error("fresh_observation_invalid");
    validateFreshObservation(raw.observation, raw.launchId,
      Date.parse(raw.observation.discovery.firstSeenAt), BigInt(raw.launchBlock.number));
    if (raw.observation.version !== (continuous ? 2 : 1)) throw new Error("fresh_observation_invalid");
  }
  return raw;
}

async function completeReceipt(journal: Journal, client: PublicClient, address: Address, wait: boolean) {
  if (!journal.state.txHash) return;
  const attempt = readAttempt(address, journal.state.token);
  const hash = journal.state.txHash as Hex;
  setStage("receipt");
  const receipt = wait
    ? await client.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 60000, pollingInterval: 1500 })
    : await client.getTransactionReceipt({ hash });
  const receiptObserved = clockReading();
  const [block, head, transaction] = await settleChecks([
    client.getBlock({ blockNumber: receipt.blockNumber }),
    client.getBlockNumber({ cacheTime: 0 }),
    client.getTransaction({ hash }),
  ]);
  if (receipt.transactionHash !== hash || receipt.from.toLowerCase() !== address.toLowerCase() ||
      receipt.to?.toLowerCase() !== protocol.router.address.toLowerCase() ||
      transaction.hash !== hash || transaction.chainId !== TESTNET_CHAIN_ID || transaction.value !== TESTNET_BUY_WEI ||
      transaction.nonce !== journal.state.nonce || block.hash !== receipt.blockHash ||
      transaction.blockHash !== receipt.blockHash || head < receipt.blockNumber + 1n)
    throw new Error("testnet_receipt_unconfirmed");
  stamp(attempt, "confirmedObservedAt", receiptObserved);
  const tokenBalanceAfter = await client.readContract({
    address: attempt.token, abi: erc20Abi, functionName: "balanceOf",
    args: [address], blockNumber: receipt.blockNumber,
  });
  const received = tokenBalanceAfter - BigInt(attempt.tokenBalanceBefore);
  const result = {
    network: "Ethereum Sepolia", chainId: TESTNET_CHAIN_ID,
    executed: true, receiptStatus: receipt.status,
    txHash: hash, explorer: `https://sepolia.etherscan.io/tx/${hash}`,
    wallet: address, token: attempt.token, launchId: attempt.launchId,
    amountInEth: formatEther(TESTNET_BUY_WEI),
    minimumOutput: attempt.minimumOutput,
    tokenReceivedRaw: received.toString(), tokenReceived: formatUnits(received, attempt.decimals),
    tokenBalanceAfter: tokenBalanceAfter.toString(),
    outputVerified: receipt.status === "success" && received >= BigInt(attempt.minimumOutput),
    gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: receipt.effectiveGasPrice.toString(),
    gasPaidEth: formatEther(receipt.gasUsed * receipt.effectiveGasPrice),
    blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash,
    confirmations: (head - receipt.blockNumber + 1n).toString(), checkedAt: new Date().toISOString(),
    scope: fresh ? "New official Sepolia launch after the recorded observation anchor: actual one-time purchase and block latency." :
      "Existing official testnet token: actual purchase execution; not a newly launched token latency measurement.",
    ...(fresh ? {
      observation: attempt.observation,
      chainBlocks: {
        launch: attempt.launchBlock, discovery: attempt.discoveryBlock,
        quote: { number: attempt.quoteBlockNumber, hash: attempt.quoteBlockHash, timestamp: attempt.quoteBlockTimestamp },
        buy: { number: receipt.blockNumber.toString(), hash: receipt.blockHash, timestamp: block.timestamp.toString(), transactionIndex: receipt.transactionIndex },
      },
      launchToBuyBlocks: attempt.launchBlock ? (receipt.blockNumber - BigInt(attempt.launchBlock.number)).toString() : null,
      launchToBuyBlockTimestampSeconds: attempt.launchBlock ? (block.timestamp - BigInt(attempt.launchBlock.timestamp)).toString() : null,
      timing: attempt.timing,
      apiChecks: attempt.apiChecks,
      monotonicLatencyMs: Object.fromEntries([
        ["signatureToFirstRpcAccepted", "signedAt", "firstRpcAcceptedAt"],
        ["broadcastToFirstRpcAccepted", "broadcastStartedAt", "firstRpcAcceptedAt"],
        ["broadcastToConfirmationObserved", "broadcastStartedAt", "confirmedObservedAt"],
      ].map(([name, from, to]) => {
        const milestones = attempt.timing?.milestones;
        const start = milestones?.[from as keyof typeof milestones]?.elapsedMs;
        const end = milestones?.[to as keyof typeof milestones]?.elapsedMs;
        return [name, typeof start === "number" && typeof end === "number" ? end - start : null];
      })),
    } : {}),
  };
  saveEvidence("result.json", result);
  journal.update({
    phase: result.outputVerified ? "confirmed" : "failed",
    blockNumber: receipt.blockNumber.toString(),
    reason: receipt.status !== "success" ? "testnet_transaction_reverted" :
      result.outputVerified ? undefined : "testnet_output_balance_mismatch",
  });
  output(result);
  if (!result.outputVerified) exitCode = 1;
}

async function quoteLaunch(id: string, client: PublicClient, clients: PublicClient[], address: Address,
  reads: StageBlockReads, observation?: FreshObservation) {
  setStage(runContext.resolvedLaunch ? "reuse_verified_launch" : "official_launch_verification");
  const resolved = runContext.resolvedLaunch ?? await resolveApiLaunch(id, client, {
    chainId: TESTNET_CHAIN_ID, signal: runContext.signal,
  });
  checkActive();
  setStage("quote_block");
  const block = await reads.block(client);
  setStage("quote_and_evidence_checks");
  const [quote, tokenBalanceBefore, decimals] = await settleChecks([
    client.simulateContract({
      address: protocol.quoter.address, account: address,
      abi: quoterAbi, functionName: "quoteExactInputSingle",
      args: [{ poolKey: resolved.candidate.pool, zeroForOne: true, exactAmount: TESTNET_BUY_WEI, hookData: "0x" }],
      blockNumber: block.number,
    }),
    client.readContract({ address: resolved.candidate.token, abi: erc20Abi, functionName: "balanceOf", args: [address], blockNumber: block.number }),
    client.readContract({ address: resolved.candidate.token, abi: erc20Abi, functionName: "decimals", blockNumber: block.number }),
    checkProtocol(clients, block.number, block.hash, reads),
    observation ? checkFreshObservation(observation, id, clients, resolved.candidate.blockNumber, reads) : Promise.resolve(),
  ] as const);
  checkActive();
  const minimumOutput = minimumOut(quote.result[0], TESTNET_SLIPPAGE_BPS);
  const attempt: Attempt = {
    chainId: TESTNET_CHAIN_ID, address, launchId: id,
    token: resolved.candidate.token, tokenBalanceBefore: tokenBalanceBefore.toString(),
    minimumOutput: minimumOutput.toString(), expectedOutput: quote.result[0].toString(),
    amountInWei: TESTNET_BUY_WEI.toString(), decimals,
    quoteBlockNumber: block.number.toString(), quoteBlockHash: block.hash,
    quoteBlockTimestamp: block.timestamp.toString(),
    resolutionSource: runContext.resolvedLaunch ? "in_process_verified" : "resolved_in_runner",
    preparedAt: new Date().toISOString(),
  };
  return { resolved, block, attempt, minimumOutput };
}

async function recheckLaunch(resolved: ResolvedApiLaunch<11155111>, client: PublicClient, reads = new StageBlockReads()) {
  const candidate = resolved.candidate;
  const [block, receipt] = await settleChecks([
    reads.block(client, candidate.blockNumber),
    client.getTransactionReceipt({ hash: candidate.launchTxHash }),
  ] as const);
  if (block.hash !== candidate.blockHash) throw new Error("testnet_launch_reorg");
  if (receipt.status !== "success" || receipt.blockHash !== candidate.blockHash)
    throw new Error("testnet_launch_receipt_changed");
}

async function checkContinuousLaunchAge(resolved: ResolvedApiLaunch<11155111>, client: PublicClient, reads = new StageBlockReads()) {
  if (!continuous) return;
  const [launch, head] = await settleChecks([
    reads.block(client, resolved.candidate.blockNumber), reads.block(client),
  ]);
  if (launch.hash !== resolved.candidate.blockHash || head.number < launch.number)
    throw new Error("testnet_launch_reorg");
  validateContinuousLaunchAge(launch.timestamp, head.timestamp, Date.now());
  return { launchTimestamp: launch.timestamp, headTimestamp: head.timestamp };
}

async function main(args: string[]) {
  const [command, id, ...rest] = args;
  if (!['prepare', 'status', 'buy', 'buy-fresh', 'status-fresh', 'buy-continuous', 'status-continuous'].includes(command ?? '') || rest.length ||
      ((command === 'status' || command === 'status-fresh' || command === 'status-continuous') && id !== undefined) ||
      (id !== undefined && !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) ||
      ((command === 'buy' || command === 'buy-fresh' || command === 'buy-continuous') && !id)) {
    output({ usage: "tsx scripts/testnet-buy.ts prepare [officialLaunchId] | status | buy <officialLaunchId> | buy-fresh <officialLaunchId> | status-fresh | buy-continuous <officialLaunchId> | status-continuous" });
    exitCode = 1;
    return;
  }
  setStage("testnet_wallet");
  continuous = command === "buy-continuous" || command === "status-continuous";
  fresh = continuous || command === "buy-fresh" || command === "status-fresh";
  evidenceDirectory = continuous ? resolve(DIRECTORY, "continuous") : fresh ? resolve(DIRECTORY, "fresh") : DIRECTORY;
  privateDirectory(resolve(ROOT, "runtime"));
  privateDirectory(DIRECTORY);
  privateDirectory(evidenceDirectory);
  privateDirectory(resolve(evidenceDirectory, "live"));
  privateDirectory(resolve(DIRECTORY, "wallet-operation"));
  const walletOperation = new Journal(resolve(DIRECTORY, "wallet-operation"));
  const journal = new Journal(resolve(evidenceDirectory, "live"));
  walletOperation.lock();
  try {
    journal.lock();
    persistTimings = command.startsWith("buy") && journal.state.phase === "idle";
    checkActive();
    const account = accountFromIsolatedFile(command === "prepare");
    const clients = makeClients();
    const client = clients[0]!;
    setStage("rpc_chain_verification");
    await checkChains(clients);
    const balance = await client.getBalance({ address: account.address });
    output({
      network: "Ethereum Sepolia", chainId: TESTNET_CHAIN_ID, wallet: account.address,
      balanceEth: formatEther(balance), journal: journal.state,
      buyAmountEth: formatEther(TESTNET_BUY_WEI), maxGasEth: formatEther(TESTNET_MAX_GAS_WEI), slippageBps: TESTNET_SLIPPAGE_BPS,
      walletFile: "runtime/testnet/wallet.env", funded: balance > TESTNET_BUY_WEI,
      rpcUrls: RPC_URLS,
    });
    if (command === "status" || command === "status-fresh" || command === "status-continuous") {
      if (journal.state.txHash) await completeReceipt(journal, client, account.address, false);
      return;
    }
    for (const otherDirectory of [resolve(DIRECTORY, "live"), resolve(DIRECTORY, "fresh/live"), resolve(DIRECTORY, "continuous/live")]) {
      if (otherDirectory === resolve(evidenceDirectory, "live")) continue;
      if (existsSync(otherDirectory)) {
        const phase = new Journal(otherDirectory).state.phase;
        if (fresh && otherDirectory !== resolve(DIRECTORY, "live") && phase !== "idle")
          throw new Error("testnet_fresh_budget_already_attempted");
        if (!["idle", "confirmed", "failed"].includes(phase)) throw new Error("testnet_other_attempt_unsettled");
      }
    }
    if (journal.state.phase !== "idle") throw new Error("testnet_already_attempted_use_status");
    if (!id) return;
    let observation: FreshObservation | undefined;
    if (fresh) {
      setStage("fresh_observation_validation");
      observation = readFreshObservation(id);
    }
    const quoteReads = new StageBlockReads();
    const quoted = await quoteLaunch(id, client, clients, account.address, quoteReads, observation);
    const { resolved, block, attempt, minimumOutput } = quoted;
    if (observation) {
      setStage("fresh_launch_validation");
      const [launchBlock, discoveryBlock] = await settleChecks([
        quoteReads.block(client, resolved.candidate.blockNumber),
        quoteReads.block(client, BigInt(observation.discovery.firstSeenHead.number)),
      ]);
      if (launchBlock.hash !== resolved.candidate.blockHash || discoveryBlock.hash !== observation.discovery.firstSeenHead.hash)
        throw new Error("fresh_observation_reorg");
      attempt.observation = observation;
      attempt.launchBlock = { number: launchBlock.number.toString(), hash: launchBlock.hash,
        timestamp: launchBlock.timestamp.toString(), transactionIndex: resolved.candidate.transactionIndex };
      attempt.discoveryBlock = { number: discoveryBlock.number.toString(), hash: discoveryBlock.hash, timestamp: discoveryBlock.timestamp.toString() };
    }
    const quoteSummary = {
      ...attempt, tokenExpected: formatUnits(BigInt(attempt.expectedOutput), attempt.decimals),
      launchNumber: resolved.candidate.launchNumber,
      kind: resolved.candidate.kind, hook: resolved.candidate.pool.hooks,
      poolId: resolved.candidate.poolId,
      protocolCodeVerifiedOnBothRpc: true,
      executed: false,
    };
    saveEvidence("prepare.json", quoteSummary);
    output(quoteSummary);
    if (command === "prepare") return;
    if (balance <= TESTNET_BUY_WEI) throw new Error("insufficient_testnet_balance");
    setStage("gas_and_balance_checks");
    const data = encodeBuy(resolved.candidate.pool, TESTNET_BUY_WEI, minimumOutput, block.timestamp + 180n);
    const [gasEstimate, fees, nonce, pendingNonce, currentBalance] = await settleChecks([
      client.estimateGas({ account: account.address, to: protocol.router.address, data, value: TESTNET_BUY_WEI }),
      client.estimateFeesPerGas(),
      client.getTransactionCount({ address: account.address, blockTag: "latest" }),
      client.getTransactionCount({ address: account.address, blockTag: "pending" }),
      client.getBalance({ address: account.address }),
      observation ? checkFreshApi(observation, attempt, "before_claim") : Promise.resolve(),
    ]);
    const transaction: TestnetTransaction = {
      chainId: TESTNET_CHAIN_ID, to: protocol.router.address, data, value: TESTNET_BUY_WEI,
      nonce, gas: (gasEstimate * 120n + 99n) / 100n,
      maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    };
    checkTestnetBudget(transaction, currentBalance, pendingNonce);
    setStage("pre_claim_checks");
    const claimReads = new StageBlockReads();
    // The slow API read above must finish before this last canonical-state snapshot.
    const [currentBlock, finalBalance, finalNonce, finalPending, , , , claimAge] = await settleChecks([
      claimReads.block(client),
      client.getBalance({ address: account.address }),
      client.getTransactionCount({ address: account.address, blockTag: "latest" }),
      client.getTransactionCount({ address: account.address, blockTag: "pending" }),
      recheckLaunch(resolved, client, claimReads),
      checkProtocol(clients, block.number, block.hash, claimReads),
      observation ? checkFreshObservation(observation, id, clients, resolved.candidate.blockNumber, claimReads) : Promise.resolve(),
      checkContinuousLaunchAge(resolved, client, claimReads),
    ] as const);
    checkActive();
    validateActionAge(claimAge);
    if (currentBlock.timestamp > block.timestamp + 60n ||
        (currentBlock.baseFeePerGas ?? 0n) + transaction.maxPriorityFeePerGas > transaction.maxFeePerGas)
      throw new Error("testnet_quote_or_fee_stale");
    if (finalNonce !== nonce) throw new Error("testnet_nonce_changed");
    checkTestnetBudget(transaction, finalBalance, finalPending);
    if (observation) {
      checkFreshDeadline(observation);
      checkContinuousConsent(observation);
    }
    saveEvidence("attempt.json", attempt);
    checkActive();
    validateActionAge(claimAge);
    if (observation) checkContinuousConsent(observation);
    if (!journal.claim(`sepolia:${id}`, resolved.candidate.token))
      throw new Error("testnet_already_attempted_use_status");
    setStage("testnet_signature");
    checkActive();
    if (observation && JSON.stringify(readFreshObservation(id, resolved.candidate.blockNumber)) !== JSON.stringify(observation))
      throw new Error("fresh_observation_changed");
    const raw = await account.signTransaction({ ...transaction, type: "eip1559" });
    const signedObserved = clockReading();
    checkSignedTestnetTransaction(raw, transaction);
    const txHash = keccak256(raw);
    journal.update({ phase: "signed", txHash, nonce });
    stamp(attempt, "signedAt", signedObserved);
    if (observation) {
      setStage("pre_broadcast_api_check");
      await checkFreshApi(observation, attempt, "before_broadcast");
    }
    setStage("pre_broadcast_checks");
    const broadcastReads = new StageBlockReads();
    const [, , , broadcastAge] = await settleChecks([
      checkProtocol(clients, block.number, block.hash, broadcastReads),
      recheckLaunch(resolved, client, broadcastReads),
      observation ? checkFreshObservation(observation, id, clients, resolved.candidate.blockNumber, broadcastReads) : Promise.resolve(),
      checkContinuousLaunchAge(resolved, client, broadcastReads),
    ] as const);
    checkActive();
    validateActionAge(broadcastAge);
    if (observation) {
      validateFreshObservation(observation, id, Date.now(), resolved.candidate.blockNumber);
      checkFreshDeadline(observation);
      checkContinuousConsent(observation);
    }
    setStage("broadcast");
    stamp(attempt, "broadcastStartedAt");
    // One identical signed payload on both transports: never a second nonce or buy.
    const results = await Promise.allSettled(clients.map(async (endpoint) => {
      checkActive();
      validateActionAge(broadcastAge);
      if (observation) {
        checkFreshDeadline(observation);
        checkContinuousConsent(observation);
      }
      const hash = await endpoint.sendRawTransaction({ serializedTransaction: raw });
      if (hash !== txHash) throw new Error("testnet_broadcast_hash_mismatch");
      stamp(attempt, "firstRpcAcceptedAt");
      return hash;
    }));
    if (!results.some((result) => result.status === "fulfilled"))
      throw new Error("testnet_broadcast_uncertain");
    journal.update({ phase: "broadcast" });
    output({ broadcast: true, chainId: TESTNET_CHAIN_ID, txHash, explorer: `https://sepolia.etherscan.io/tx/${txHash}` });
    await completeReceipt(journal, client, account.address, true);
  } catch (error) {
    if (journal.state.phase === "claimed") journal.update({ phase: "failed", reason: `stopped_at_${stage}` });
    else if (["signed", "broadcast"].includes(journal.state.phase))
      journal.update({ phase: "uncertain", reason: `stopped_at_${stage}_use_status_do_not_repeat` });
    const safeCodes = new Set([
      "testnet_already_attempted_use_status", "insufficient_testnet_balance",
      "testnet_gas_budget_exceeded", "pending_transaction", "testnet_nonce_changed",
      "testnet_quote_or_fee_stale", "testnet_rpc_chain_mismatch", "testnet_block_mismatch",
      "testnet_protocol_changed", "testnet_broadcast_uncertain", "testnet_receipt_unconfirmed",
      "testnet_launch_reorg", "testnet_launch_receipt_changed", "testnet_attempt_mismatch",
      "testnet_other_attempt_unsettled", "fresh_observation_invalid", "fresh_observation_expired",
      "fresh_launch_not_new", "fresh_launch_before_anchor", "fresh_observation_changed", "fresh_observation_reorg",
      "fresh_discovery_head_before_launch", "fresh_candidate_withdrawn", "fresh_api_candidates_changed",
      "continuous_stop_requested", "continuous_monitor_not_authorized",
      "continuous_launch_stale", "testnet_fresh_budget_already_attempted",
      "testnet_execution_cancelled",
    ]);
    output({ error: `Testnet command stopped at ${stage}.`,
      code: error instanceof Error && safeCodes.has(error.message) ? error.message : "testnet_check_failed",
      journal: journal.state,
      next: journal.state.txHash ? `Run ${continuous ? "status-continuous" : fresh ? "status-fresh" : "status"} to check the existing transaction; do not reset the journal or repeat the buy.` :
        "Check Sepolia RPC availability, the official launch, and testnet wallet funding. No transaction was broadcast.",
    });
    exitCode = 1;
  } finally {
    lastJournalState = { ...journal.state };
    try { journal.close(); } finally { walletOperation.close(); }
  }
}

/** Library entry: importing this module does not load a wallet, contact RPCs, or execute a command. */
export async function runTestnetBuy(args: string[], context: TestnetBuyContext = {}): Promise<TestnetBuyResult> {
  if (runActive) return { exitCode: 1 };
  runActive = true;
  runContext = {};
  evidenceDirectory = DIRECTORY;
  fresh = false;
  continuous = false;
  freshMonotonicDeadline = undefined;
  clockOrigin = { id: randomUUID(), at: new Date().toISOString(), mono: performance.now() };
  stage = "arguments";
  stageStarted = clockOrigin.mono;
  stageDurations = [];
  persistTimings = false;
  exitCode = 0;
  lastJournalState = undefined;
  protocolVerifier = new TestnetProtocolVerifier(Object.values(protocol));
  try {
    const runArgs = [...args];
    // Snapshot context fields once; callers cannot switch the evidence after identity validation.
    runContext = { resolvedLaunch: context.resolvedLaunch, output: context.output, signal: context.signal };
    checkActive();
    if (runContext.resolvedLaunch && !isVerifiedApiLaunch(runContext.resolvedLaunch, runArgs[1] ?? "", TESTNET_CHAIN_ID))
      throw new Error("testnet_untrusted_resolved_launch");
    await main(runArgs);
  } catch {
    exitCode = 1;
    // A log sink failure also fails closed; never dump errors or signed payloads.
    try { output({ error: `Testnet command stopped at ${stage}. Check verified context, cancellation, file permissions or active locks.` }); }
    catch { /* The caller owns its logging failure. */ }
  } finally {
    try { setStage(exitCode ? "stopped" : "finished"); } catch { exitCode = 1; }
    persistTimings = false;
    runContext = {};
    runActive = false;
  }
  return { exitCode, journal: lastJournalState };
}

// Preserve the CLI while allowing the continuous monitor to reuse verified evidence in-process.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runTestnetBuy(process.argv.slice(2));
  process.exitCode = result.exitCode;
}
