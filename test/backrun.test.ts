import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeAbiParameters,
  decodeFunctionData,
  keccak256,
  parseAbiParameters,
  parseEther,
  parseGwei,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  zeroAddress,
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
  type TransactionSerialized,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildBackrun,
  BackrunError,
  type BackrunInput,
} from "../src/backrun.js";
import { configSchema, deploymentSchema } from "../src/config.js";
import { poolTuple, routerAbi } from "../src/v4.js";

// Public local-only test keys: no RPC, relay, wallet balance changes or broadcast in this file.
const launcher = privateKeyToAccount(`0x${"11".repeat(32)}`);
const buyer = privateKeyToAccount(`0x${"22".repeat(32)}`);
const stranger = privateKeyToAccount(`0x${"33".repeat(32)}`);
const address = (octet: string) => `0x${octet.repeat(20)}` as Address;
const hash = (octet: string) => `0x${octet.repeat(32)}` as Hex;
const factory = address("aa");
const router = address("bb");
const token = address("cc");
const hook = address("dd");
const tokenCodeHash = hash("ab");
const hookCodeHash = hash("cd");

async function signedLaunch(
  overrides: Partial<TransactionSerializableEIP1559> = {},
): Promise<Hex> {
  return launcher.signTransaction({
    type: "eip1559",
    chainId: 1,
    to: factory,
    nonce: 10,
    value: 0n,
    gas: 3_000_000n,
    maxFeePerGas: parseGwei("20"),
    maxPriorityFeePerGas: parseGwei("1"),
    // Placeholder calldata is deliberate: protocol decoding is an external adapter responsibility.
    data: "0x12345678",
    ...overrides,
  });
}

async function fixture(serializedLaunch?: Hex): Promise<BackrunInput> {
  const rawLaunchTx = serializedLaunch ?? (await signedLaunch());
  return {
    signer: buyer,
    chainId: 1,
    rawLaunchTx,
    config: configSchema.parse({
      buyAmountEth: "0.01",
      startBlock: "101",
      minLaunchNumber: 400,
    }),
    deployment: deploymentSchema.parse({
      chainId: 1,
      verified: true,
      verifiedSource: "https://imd.fun/docs/",
      poolManager: { address: address("ee"), codeHash: hash("01") },
      router: { address: router, codeHash: hash("02") },
      quoter: { address: address("ff"), codeHash: hash("03") },
      stateView: { address: address("99"), codeHash: hash("04") },
      factories: [{ address: factory, codeHash: hash("05") }],
      registries: [{ address: address("88"), codeHash: hash("06") }],
      deployers: [launcher.address],
      taxPolicies: [
        {
          tokenCodeHash,
          hookCodeHash: null,
          buyTaxBps: 0,
          sellTaxBps: 0,
          immutable: true,
          source: "Reviewed test bytecode fixture only.",
        },
      ],
    }),
    pool: {
      currency0: zeroAddress,
      currency1: token,
      fee: 3000,
      tickSpacing: 60,
      hooks: zeroAddress,
    },
    expectedAmountOut: 100_000n,
    pendingValidation: {
      launchTxHash: keccak256(rawLaunchTx),
      kind: "evm_project",
      launchNumber: 426,
      tokenCodeHash,
      hookCodeHash: null,
    },
    head: {
      number: 100n,
      timestamp: 1_800_000_000n,
      baseFeePerGas: parseGwei("10"),
    },
    nonce: 7,
    pendingNonce: 7,
    walletBalance: parseEther("1"),
    gasLimit: 250_000n,
  };
}

const errorCode = (code: BackrunError["code"]) => (error: unknown) =>
  error instanceof BackrunError && error.code === code;

test("prepares launch-before-buy and signs exactly the bounded native-ETH swap", async () => {
  const input = await fixture();
  const result = await buildBackrun(input);
  assert.equal(result.txs[0], input.rawLaunchTx);
  assert.equal(result.txs.length, 2);
  assert.equal(result.targetBlock, 101n);
  assert.equal(result.nonce, 7);
  assert.equal(result.buyHash, keccak256(result.txs[1]));
  assert.equal(
    await recoverTransactionAddress({
      serializedTransaction: result.txs[1] as TransactionSerialized,
    }),
    buyer.address,
  );
  const buy = parseTransaction(result.txs[1]);
  assert.equal(buy.type, "eip1559");
  assert.equal(buy.chainId, 1);
  assert.equal(buy.to?.toLowerCase(), router);
  assert.equal(buy.nonce, 7);
  assert.equal(buy.value, parseEther("0.01"));
  assert.equal(buy.gas, 250_000n);
  assert.equal(buy.maxFeePerGas, parseGwei("13.25"));
  assert.equal(buy.maxPriorityFeePerGas, parseGwei("2"));
  const call = decodeFunctionData({ abi: routerAbi, data: buy.data! });
  assert.equal(call.functionName, "execute");
  assert.equal(call.args[0], "0x10");
  assert.equal(call.args[2], input.head.timestamp + 60n);
  const [actions, params] = decodeAbiParameters(
    parseAbiParameters("bytes,bytes[]"),
    call.args[1][0]!,
  );
  assert.equal(actions, "0x060c0f");
  const [swap] = decodeAbiParameters(
    parseAbiParameters(
      `(${poolTuple} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`,
    ),
    params[0]!,
  );
  assert.equal(swap.poolKey.currency1.toLowerCase(), token);
  assert.equal(swap.poolKey.currency0, zeroAddress);
  assert.equal(swap.zeroForOne, true);
  assert.equal(swap.amountIn, parseEther("0.01"));
  assert.equal(swap.amountOutMinimum, 97_000n);
  assert.equal(swap.hookData, "0x");
  assert.deepEqual(
    decodeAbiParameters(parseAbiParameters("address,uint256"), params[1]!),
    [zeroAddress, parseEther("0.01")],
  );
  const take = decodeAbiParameters(
    parseAbiParameters("address,uint256"),
    params[2]!,
  );
  assert.equal(take[0].toLowerCase(), token);
  assert.equal(take[1], 97_000n);
});

test("accepts an EIP-155 protected legacy launch but rejects an unprotected one", async () => {
  const legacy = {
    type: "legacy" as const,
    to: factory,
    nonce: 10,
    gas: 3_000_000n,
    gasPrice: parseGwei("20"),
    data: "0x12345678" as Hex,
  };
  const protectedTx = await launcher.signTransaction({ ...legacy, chainId: 1 });
  assert.equal(
    (await buildBackrun(await fixture(protectedTx))).txs[0],
    protectedTx,
  );
  const unprotectedTx = await launcher.signTransaction(legacy);
  await assert.rejects(
    buildBackrun(await fixture(unprotectedTx)),
    errorCode("INVALID_LAUNCH"),
  );
});

test("rejects wrong-chain, unsigned and malformed launch transactions", async () => {
  await assert.rejects(
    buildBackrun(await fixture(await signedLaunch({ chainId: 11155111 }))),
    errorCode("INVALID_LAUNCH"),
  );
  const input = await fixture();
  await assert.rejects(
    buildBackrun({ ...input, chainId: 11155111 }),
    errorCode("INVALID_INPUT"),
  );
  const unsigned = serializeTransaction({
    type: "eip1559",
    chainId: 1,
    to: factory,
    gas: 1n,
    nonce: 0,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
  });
  await assert.rejects(
    buildBackrun(await fixture(unsigned)),
    errorCode("INVALID_LAUNCH"),
  );
  await assert.rejects(
    buildBackrun({ ...input, rawLaunchTx: "0x1" }),
    errorCode("INVALID_LAUNCH"),
  );
});

test("rejects access-list, blob and authorization transaction types", async () => {
  const base = {
    chainId: 1,
    to: factory,
    nonce: 10,
    gas: 3_000_000n,
    data: "0x12345678" as Hex,
  };
  const raws = [
    await launcher.signTransaction({
      ...base,
      type: "eip2930",
      gasPrice: 20n,
      accessList: [],
    }),
    await launcher.signTransaction({
      ...base,
      type: "eip4844",
      maxFeePerGas: 20n,
      maxPriorityFeePerGas: 1n,
      maxFeePerBlobGas: 1n,
      blobVersionedHashes: [hash("01")],
    }),
    await launcher.signTransaction({
      ...base,
      type: "eip7702",
      maxFeePerGas: 20n,
      maxPriorityFeePerGas: 1n,
      authorizationList: [
        await launcher.signAuthorization({
          chainId: 1,
          contractAddress: factory,
          nonce: 11,
        }),
      ],
    }),
  ];
  for (const raw of raws)
    await assert.rejects(
      buildBackrun(await fixture(raw)),
      errorCode("INVALID_LAUNCH"),
    );
});

test("authenticates the launch sender and factory and separates the buy account", async () => {
  const input = await fixture();
  await assert.rejects(
    buildBackrun({
      ...input,
      deployment: { ...input.deployment, deployers: [stranger.address] },
    }),
    errorCode("INVALID_LAUNCH"),
  );
  await assert.rejects(
    buildBackrun(await fixture(await signedLaunch({ to: router }))),
    errorCode("INVALID_LAUNCH"),
  );
  await assert.rejects(
    buildBackrun(await fixture(await signedLaunch({ to: undefined }))),
    errorCode("INVALID_LAUNCH"),
  );
  await assert.rejects(
    buildBackrun({ ...input, signer: launcher }),
    errorCode("INVALID_LAUNCH"),
  );
});

test("rejects pending data for a different transaction and launch outside configured scope", async () => {
  const input = await fixture();
  input.config.allowedKinds = ["evm_project"];
  for (const pendingValidation of [
    { ...input.pendingValidation, launchTxHash: hash("00") },
    { ...input.pendingValidation, launchNumber: 399 },
    { ...input.pendingValidation, kind: "univ4_hook" },
  ])
    await assert.rejects(
      buildBackrun({ ...input, pendingValidation }),
      errorCode("POLICY_REJECTED"),
    );
  await assert.rejects(
    buildBackrun({ ...input, config: { ...input.config, startBlock: "102" } }),
    errorCode("POLICY_REJECTED"),
  );
});

test("requires a matching reviewed token and hook code combination within both tax limits", async () => {
  const input = await fixture();
  await assert.rejects(
    buildBackrun({
      ...input,
      pendingValidation: {
        ...input.pendingValidation,
        tokenCodeHash: hash("ff"),
      },
    }),
    errorCode("POLICY_REJECTED"),
  );
  await assert.rejects(
    buildBackrun({
      ...input,
      deployment: { ...input.deployment, taxPolicies: [] },
    }),
    errorCode("POLICY_REJECTED"),
  );
  for (const field of ["buyTaxBps", "sellTaxBps"]) {
    await assert.rejects(
      buildBackrun({
        ...input,
        deployment: {
          ...input.deployment,
          taxPolicies: [{ ...input.deployment.taxPolicies[0]!, [field]: 100 }],
        },
      }),
      errorCode("POLICY_REJECTED"),
    );
  }
  const hooked = {
    ...input,
    pool: { ...input.pool, hooks: hook },
    config: { ...input.config, allowedHooks: [hook] },
    pendingValidation: { ...input.pendingValidation, hookCodeHash },
  };
  await assert.rejects(buildBackrun(hooked), errorCode("POLICY_REJECTED"));
  const reviewed = {
    ...hooked,
    deployment: {
      ...input.deployment,
      taxPolicies: [{ ...input.deployment.taxPolicies[0]!, hookCodeHash }],
    },
  };
  assert.equal((await buildBackrun(reviewed)).targetBlock, 101n);
  await assert.rejects(
    buildBackrun({ ...reviewed, config: input.config }),
    errorCode("POLICY_REJECTED"),
  );
});

test("rejects empty predicted code, unexpected hook evidence and unverified ETH reserves", async () => {
  const input = await fixture();
  await assert.rejects(
    buildBackrun({
      ...input,
      pendingValidation: {
        ...input.pendingValidation,
        tokenCodeHash: keccak256("0x"),
      },
    }),
    errorCode("POLICY_REJECTED"),
  );
  await assert.rejects(
    buildBackrun({
      ...input,
      pendingValidation: { ...input.pendingValidation, hookCodeHash },
    }),
    errorCode("POLICY_REJECTED"),
  );
  await assert.rejects(
    buildBackrun({
      ...input,
      config: { ...input.config, minLiquidityEth: "0.1" },
    }),
    errorCode("POLICY_REJECTED"),
  );
});

test("rejects non-native pools and invalid output bounds", async () => {
  const input = await fixture();
  for (const pool of [
    { ...input.pool, currency0: address("77") },
    { ...input.pool, currency1: zeroAddress },
    { ...input.pool, tickSpacing: 0 },
    { ...input.pool, fee: 2 ** 24 },
  ])
    await assert.rejects(
      buildBackrun({ ...input, pool }),
      errorCode("POLICY_REJECTED"),
    );
  for (const expectedAmountOut of [0n, -1n, 2n ** 128n]) {
    await assert.rejects(
      buildBackrun({ ...input, expectedAmountOut }),
      errorCode("INVALID_INPUT"),
    );
  }
  await assert.rejects(
    buildBackrun({ ...input, expectedAmountOut: 1n }),
    errorCode("INVALID_INPUT"),
  );
});

test("requires a free nonce and funds for the purchase plus worst-case gas", async () => {
  const input = await fixture();
  await assert.rejects(
    buildBackrun({ ...input, pendingNonce: 8 }),
    errorCode("NONCE_CONFLICT"),
  );
  await assert.rejects(
    buildBackrun({ ...input, nonce: -1, pendingNonce: -1 }),
    errorCode("NONCE_CONFLICT"),
  );
  const needed = parseEther("0.01") + 250_000n * parseGwei("13.25");
  await assert.rejects(
    buildBackrun({ ...input, walletBalance: needed - 1n }),
    errorCode("INSUFFICIENT_BALANCE"),
  );
  assert.equal(
    (await buildBackrun({ ...input, walletBalance: needed })).nonce,
    7,
  );
});

test("enforces next-block fee growth and total gas caps before signing", async () => {
  const input = await fixture();
  await assert.rejects(
    buildBackrun({ ...input, config: { ...input.config, maxFeeGwei: "13" } }),
    errorCode("FEE_LIMIT"),
  );
  await assert.rejects(
    buildBackrun({ ...input, config: { ...input.config, maxGasEth: "0.003" } }),
    errorCode("FEE_LIMIT"),
  );
  await assert.rejects(
    buildBackrun({ ...input, gasLimit: 20_999n }),
    errorCode("INVALID_INPUT"),
  );
  const lowBase = await buildBackrun({
    ...input,
    head: { ...input.head, baseFeePerGas: 7n },
  });
  assert.equal(
    parseTransaction(lowBase.txs[1]).maxFeePerGas,
    parseGwei("2") + 8n,
  );
});

test("sanitizes signer failures and rejects substituted buy transaction contents", async () => {
  const input = await fixture();
  const failingSigner = {
    ...buyer,
    signTransaction: async () => {
      throw Error("SECRET signing data and key");
    },
  };
  await assert.rejects(
    buildBackrun({ ...input, signer: failingSigner }),
    (error: unknown) => {
      assert.ok(error instanceof BackrunError);
      assert.equal(error.code, "SIGNING_FAILED");
      assert.equal(error.message.includes("SECRET"), false);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  const wrongBuy = await buyer.signTransaction({
    type: "eip1559",
    chainId: 1,
    to: stranger.address,
    nonce: 7,
    gas: 21_000n,
    value: parseEther("1"),
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
  });
  await assert.rejects(
    buildBackrun({
      ...input,
      signer: { ...buyer, signTransaction: async () => wrongBuy },
    }),
    errorCode("SIGNING_FAILED"),
  );
});
