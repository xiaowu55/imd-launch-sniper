import {
  createPublicClient,
  http,
  webSocket,
  fallback,
  keccak256,
  stringToHex,
  parseEther,
  parseGwei,
  type PublicClient,
  type Hex,
} from "viem";
import { mainnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import {
  loadConfig,
  configSchema,
  loadDeployment,
  asAddress,
  type Config,
  type Deployment,
} from "./config.js";
import { Journal } from "./journal.js";
import { projectAdapter } from "./discovery.js";
import { eligibility } from "./policy.js";
import { encodeBuy, minimumOut, quoterAbi, poolId } from "./v4.js";
import { startLaunchFeed, type LaunchSnapshot } from "./launch-feed.js";
import { ApiSession, fetchApiBaseline } from "./api-session.js";
import {
  resolveApiLaunch,
  trustedUniswap,
  ApiLaunchError,
} from "./api-launch.js";
import { resolveBoundary, CursorStore, type Boundary } from "./monitor.js";
import type { Candidate, LaunchAdapter } from "./types.js";
export type Check = { name: string; ok: boolean; detail: string };
export type MonitorStatus = {
  status:
    | "waiting-deployment"
    | "pending"
    | "baselining"
    | "resolved"
    | "auditing"
    | "watching"
    | "missed"
    | "error";
  startBlock?: string;
  nextBlock?: string;
  source?: Boundary["source"] | "api-baseline";
  baselineAt?: string;
  auditThroughBlock?: string;
  detail: string;
};
export type ApiDependencies = {
  snapshot: typeof fetchApiBaseline;
  resolve: (
    id: string,
    client: PublicClient,
    options?: { signal?: AbortSignal },
  ) => Promise<{ candidate: Candidate; deployment: Deployment }>;
};
export class Engine {
  config: Config = loadConfig();
  running = false;
  starting = false;
  mode: "dry-run" | "live" = "live";
  logs: Record<string, unknown>[] = [];
  research: unknown = { mainnetVerified: false };
  launchFeed: Omit<LaunchSnapshot, "launches"> | null = null;
  readiness = { ok: false, checks: [] as Check[] };
  state: Record<string, unknown> = { ...new Journal().state };
  monitor: MonitorStatus = {
    status: "pending",
    detail: "自动起点已启用；连接检查将核实官方工厂部署区块",
  };
  private stops: (() => void)[] = [];
  private timer?: NodeJS.Timeout;
  private journal?: Journal;
  private busy = false;
  private nextBlock = 0n;
  private generation = 0;
  private stopping = false;
  private lastScanned?: { number: bigint; hash: Hex };
  private activationHead = 0n;
  private effectiveConfig?: Config;
  private runConfig?: Config;
  private runAccount?: ReturnType<typeof privateKeyToAccount>;
  private get settings(): Config {
    return (this.starting || this.running || this.busy) && this.runConfig
      ? this.runConfig
      : this.config;
  }
  private walletAccount() {
    if (this.starting || this.running || this.busy) return this.runAccount;
    try {
      return privateKeyToAccount(process.env.TRADING_PRIVATE_KEY as Hex);
    } catch {
      return undefined;
    }
  }
  private api: ApiDependencies;
  constructor(
    private readonly startFeed: typeof startLaunchFeed = startLaunchFeed,
    api: Partial<ApiDependencies> = {},
  ) {
    this.api = {
      snapshot: fetchApiBaseline,
      resolve: resolveApiLaunch,
      ...api,
    };
    this.resetMonitor();
  }
  resetMonitor() {
    if (this.settings.discoverySource === "api") {
      this.monitor = {
        status: "pending",
        source: "api-baseline",
        detail:
          "官方 API 自动发现模式；启动时记住现有项目，只处理之后新出现的 Ethereum 主网发行，无需填写合约和区块",
      };
      return;
    }
    let deployed = false;
    try {
      deployed = !!loadDeployment();
    } catch {}
    this.monitor = {
      status: deployed ? "pending" : "waiting-deployment",
      detail: !deployed
        ? "等待核实官方主网发射合约；就绪后自动查找部署区块，无需填写数字"
        : BigInt(this.settings.startBlock) === 0n
          ? "自动查找官方工厂部署区块；连接检查后显示结果"
          : "使用手动起点；连接检查将验证区块是否存在",
    };
  }
  get canConfigure() {
    return !this.running && !this.starting && !this.busy;
  }
  log(event: string, data: Record<string, unknown> = {}) {
    this.logs.push({ time: new Date().toISOString(), event, ...data });
    if (this.logs.length > 200) this.logs.shift();
  }
  private watchApi(onSignal: () => void = () => {}) {
    const generation = this.generation;
    return this.startFeed({
      intervalMs: this.settings.pollIntervalMs,
      onUpdate: ({ launches, ...snapshot }) => {
        if (!this.running || generation !== this.generation) return;
        this.launchFeed = snapshot;
        this.research = {
          ...(this.research && typeof this.research === "object"
            ? this.research
            : {}),
          ...snapshot,
          launches,
          mainnetVerified: false,
        };
      },
      onSignal: (hints) => {
        if (!this.running || generation !== this.generation) return;
        this.log("api_signal", {
          launchNumbers: hints.map((hint) => hint.launchNumber),
          detail:
            "官方 API 主网记录发生变化，触发链上补扫；仍须通过官方合约与历史、税率和交易校验",
        });
        onSignal();
      },
      onError: () => {
        if (this.running && generation === this.generation)
          this.log("api_error", {
            detail: "官方 API 暂时不可用，自动退避重试；链上监听独立运行",
          });
      },
    });
  }
  client(url?: string): PublicClient {
    return createPublicClient({
      chain: mainnet,
      transport: url
        ? http(url, { timeout: 4000, retryCount: 0 })
        : fallback(
            this.settings.rpcHttpUrls.map((endpoint) =>
              http(endpoint, { timeout: 4000, retryCount: 0 }),
            ),
            { retryCount: 0 },
          ),
      cacheTime: 0,
    });
  }
  async check() {
    if (this.settings.discoverySource === "api") return this.checkApi();
    const checks: Check[] = [];
    let d: Deployment | null = null;
    try {
      d = loadDeployment();
      checks.push({
        name: "主网部署",
        ok: !!d,
        detail: d
          ? "已载入待链上校验的部署清单"
          : "尚未配置已核实的 Ethereum 主网发射合约",
      });
    } catch {
      checks.push({
        name: "主网部署",
        ok: false,
        detail: "config/mainnet.json 格式不正确",
      });
    }
    const validKey = !!this.walletAccount();
    checks.push({
      name: "钱包",
      ok: validKey,
      detail: "实盘私钥仅从服务器环境变量读取",
    });
    checks.push({
      name: "HTTP 节点",
      ok: this.settings.rpcHttpUrls.length > 0,
      detail: "提供至少一个 Ethereum 主网 RPC",
    });
    checks.push({
      name: "储备筛选",
      ok: parseEther(this.settings.minLiquidityEth) === 0n,
      detail: "独立池储备证据暂未接入；此门槛需保持 0",
    });
    checks.push({
      name: "单次交易状态",
      ok: new Journal().state.phase === "idle",
      detail: "已选择或发送过交易时不会自动重新下单",
    });
    for (let i = 0; i < this.settings.rpcHttpUrls.length; i++) {
      try {
        const c = this.client(this.settings.rpcHttpUrls[i]);
        const chainId = await c.getChainId();
        checks.push({
          name: `RPC ${i + 1}`,
          ok: chainId === 1,
          detail:
            chainId === 1
              ? "Ethereum 主网连接正常"
              : `网络不符，链 ID ${chainId}`,
        });
      } catch {
        checks.push({
          name: `RPC ${i + 1}`,
          ok: false,
          detail: "连接失败或超时，请检查 URL 和服务额度",
        });
      }
    }
    if (d && this.settings.rpcHttpUrls.length) {
      const client = this.client();
      for (const [name, contract] of Object.entries({
        poolManager: d.poolManager,
        router: d.router,
        quoter: d.quoter,
        stateView: d.stateView,
        ...Object.fromEntries(d.factories.map((x, i) => [`factory${i}`, x])),
        ...Object.fromEntries(d.registries.map((x, i) => [`registry${i}`, x])),
      })) {
        try {
          const code = await client.getCode({
            address: asAddress(contract.address),
          });
          checks.push({
            name,
            ok:
              !!code &&
              code !== "0x" &&
              keccak256(code).toLowerCase() === contract.codeHash.toLowerCase(),
            detail: "校验链上运行字节码指纹",
          });
        } catch {
          checks.push({ name, ok: false, detail: "无法读取合约字节码" });
        }
      }
      checks.push({
        name: "税率证据",
        ok: d.taxPolicies.length > 0,
        detail: "必须有按代币和 Hook 字节码绑定的审核记录；未知税率拒买",
      });
    }
    if (!d || !this.settings.rpcHttpUrls.length) {
      const detail = !d
        ? "等待核实官方主网发射合约；就绪后自动查找部署区块，无需填写数字"
        : "等待主网节点连接后核实监控起点";
      checks.push({ name: "监控起点", ok: false, detail });
      if (!this.running)
        this.monitor = {
          status: !d ? "waiting-deployment" : "pending",
          detail,
        };
    } else {
      try {
        const boundary = await resolveBoundary(
          this.client(),
          d,
          this.settings.startBlock,
        );
        const detail = `${boundary.source === "manual" ? "手动" : "自动"}起点 ${boundary.startBlock} 已核实；启动时补查历史，已有符合条件的发行则停止`;
        checks.push({ name: "监控起点", ok: true, detail });
        if (!this.running)
          this.monitor = {
            status: "resolved",
            startBlock: boundary.startBlock,
            source: boundary.source,
            detail,
          };
      } catch {
        const detail =
          "起点无法核实；检查工厂审核标记、部署区块提示、历史状态节点与区块重组记录";
        checks.push({ name: "监控起点", ok: false, detail });
        if (!this.running) this.monitor = { status: "error", detail };
      }
    }
    this.readiness = { ok: checks.every((x) => x.ok), checks };
    return this.readiness;
  }
  private async checkApi() {
    const checks: Check[] = [];
    const validKey = !!this.walletAccount();
    checks.push({
      name: "钱包",
      ok: validKey,
      detail: "只需在本机导入交易钱包；API 模式无需填写发射合约",
    });
    checks.push({
      name: "单次交易状态",
      ok: new Journal().state.phase === "idle",
      detail: "只买一次；已有交易记录不会自动再次下单",
    });
    checks.push({
      name: "HTTP 节点",
      ok: this.settings.rpcHttpUrls.length > 0,
      detail: "主网节点已预填，用于确认部署、报价与提交交易",
    });
    checks.push({
      name: "储备筛选",
      ok: parseEther(this.settings.minLiquidityEth) === 0n,
      detail: "独立池储备证据暂未接入；此门槛需保持 0",
    });
    checks.push({
      name: "税率状态",
      ok: true,
      detail: "未检测税率；按实盘专用设置不运行本地买卖模拟，税率阈值不生效",
    });
    const rpcChecks = await Promise.all(
      this.settings.rpcHttpUrls.map(async (url, index): Promise<Check> => {
        try {
          const chainId = await this.client(url).getChainId();
          return {
            name: `RPC ${index + 1}`,
            ok: chainId === 1,
            detail:
              chainId === 1
                ? "Ethereum 主网连接正常"
                : "节点不是 Ethereum 主网",
          };
        } catch {
          return {
            name: `RPC ${index + 1}`,
            ok: false,
            detail: "连接失败或超时",
          };
        }
      }),
    );
    checks.push(...rpcChecks);
    if (this.settings.rpcHttpUrls.length) {
      const protocol = trustedUniswap();
      const client = this.client();
      checks.push(
        ...(await Promise.all(
          Object.entries(protocol).map(
            async ([name, contract]): Promise<Check> => {
              try {
                const code = await client.getCode({
                  address: contract.address,
                });
                return {
                  name,
                  ok:
                    !!code &&
                    code !== "0x" &&
                    keccak256(code).toLowerCase() === contract.codeHash,
                  detail: "已内置 Ethereum 主网 Uniswap v4 地址与运行代码指纹",
                };
              } catch {
                return { name, ok: false, detail: "无法验证主网交易合约" };
              }
            },
          ),
        )),
      );
    }
    try {
      const snapshot = await this.api.snapshot();
      this.applyApiSnapshot(snapshot);
      checks.push({
        name: "官方 API",
        ok: true,
        detail: "接口可读；将自动提取新主网币的地址、交易、池子与 Hook",
      });
      // Parse a prior session now so corrupt progress cannot be silently discarded at startup.
      new ApiSession("live");
      checks.push({
        name: "监控起点",
        ok: true,
        detail: "API 模式自动记录现有项目并排除旧币，无需官方起始区块",
      });
    } catch {
      checks.push({
        name: "官方 API / 本地记录",
        ok: false,
        detail: "API 读取失败或本地观察记录损坏，修复后再启动",
      });
    }
    this.readiness = { ok: checks.every((check) => check.ok), checks };
    return this.readiness;
  }
  private applyApiSnapshot({ launches, ...snapshot }: LaunchSnapshot) {
    this.launchFeed = snapshot;
    this.research = { ...snapshot, launches, mainnetVerified: false };
  }
  private async startApi(generation: number) {
    const controller = new AbortController();
    this.stops.push(() => controller.abort());
    const active = () =>
      this.running &&
      generation === this.generation &&
      !controller.signal.aborted;
    const client = this.client();
    this.monitor = {
      status: "baselining",
      source: "api-baseline",
      detail: "读取官方记录，自动排除已有代币，建立观察起点",
    };
    if ((await client.getChainId()) !== 1)
      throw Error("交易网络必须为 Ethereum 主网");
    if (!active()) throw Error("启动已取消");
    const snapshot = await this.api.snapshot(controller.signal);
    const head = await client.getBlock();
    if (!active()) throw Error("启动已取消");
    const session = new ApiSession(this.mode);
    if (
      session.state &&
      (
        await client.getBlock({
          blockNumber: BigInt(session.state.anchor.number),
        })
      ).hash !== session.state.anchor.hash
    )
      throw Error("API 观察起点发生链重组，不能自动丢弃记录");
    if (!active()) throw Error("启动已取消");
    session.initialize(snapshot, { number: head.number, hash: head.hash });
    session.enqueue(snapshot);
    this.activationHead = head.number;
    this.applyApiSnapshot(snapshot);
    this.monitor = {
      status: "watching",
      source: "api-baseline",
      baselineAt: session.state!.baselineAt,
      startBlock: (head.number + 1n).toString(),
      detail:
        "等待 API 新出现的主网币；自动取得池子和 Hook，通过条件后买入一次",
    };
    this.state = { phase: "watching", detail: this.monitor.detail };
    this.log("api_baseline", {
      baselineAt: session.state!.baselineAt,
      excluded: session.state!.excluded.length,
      pending: session.pending().length,
    });
    const waitingSince = new Map<string, number>();
    const tick = async () => {
      if (!active() || this.busy || !session.pending().length) return;
      this.busy = true;
      try {
        if (
          (await client.getBlock({ blockNumber: head.number })).hash !==
          head.hash
        ) {
          this.monitor = {
            ...this.monitor,
            status: "error",
            detail: "观察起点发生重组，已停止执行",
          };
          this.state = { phase: "failed", reason: this.monitor.detail };
          this.cleanup();
          return;
        }
        const observedBatch = new Map(
          session.pending().map((hint) => [hint.id, JSON.stringify(hint)]),
        );
        const batchCurrent = () =>
          session.pending().length === observedBatch.size &&
          !session
            .pending()
            .some(
              (hint) => observedBatch.get(hint.id) !== JSON.stringify(hint),
            );
        const resolved: {
          id: string;
          candidate: Candidate;
          deployment: Deployment;
        }[] = [];
        let incomplete = false;
        // Resolve this whole observed batch before ordering it by actual transaction position.
        for (const hint of session.pending()) {
          if (!active()) return;
          this.state = {
            phase: "validating",
            launchNumber: hint.launchNumber,
            detail: "自动读取官方部署资料并核对真实主网池子",
          };
          try {
            const result = await this.api.resolve(hint.id, client, {
              signal: controller.signal,
            });
            if (!active()) return;
            if (
              result.deployment.chainId !== 1 ||
              result.candidate.launchNumber !== hint.launchNumber ||
              (hint.token &&
                hint.token.toLowerCase() !==
                  result.candidate.token.toLowerCase())
            )
              throw new ApiLaunchError(
                "metadata_mismatch",
                "API 列表和详情的代币或发射编号不一致",
                false,
              );
            resolved.push({ id: hint.id, ...result });
            waitingSince.delete(hint.id);
          } catch (error) {
            if (!active()) return;
            if (error instanceof ApiLaunchError && !error.retryable) {
              session.finish(hint.id, error.message);
              observedBatch.delete(hint.id);
              this.log("rejected", {
                launchNumber: hint.launchNumber,
                reason: error.message,
              });
            } else {
              if (!waitingSince.has(hint.id))
                waitingSince.set(hint.id, Date.now());
              if (Date.now() - waitingSince.get(hint.id)! >= 120_000)
                throw Error("首个 API 候选的资料等待超时");
              incomplete = true;
              this.log("api_waiting", {
                launchNumber: hint.launchNumber,
                detail: "部署详情或链上回执尚未同步，保留候选重试",
              });
            }
          }
        }
        if (incomplete || !active()) return;
        resolved.sort((a, b) =>
          a.candidate.blockNumber < b.candidate.blockNumber
            ? -1
            : a.candidate.blockNumber > b.candidate.blockNumber
              ? 1
              : a.candidate.transactionIndex - b.candidate.transactionIndex ||
                a.candidate.logIndex - b.candidate.logIndex,
        );
        for (const item of resolved) {
          if (!active()) return;
          const { candidate, deployment } = item;
          let rejected: string | null = null;
          if (candidate.blockNumber <= this.activationHead)
            rejected =
              "该币在本次启动前已部署（含缓存旧记录或停机期间发行），不追买";
          else if (candidate.launchNumber < this.settings.minLaunchNumber)
            rejected = "早于最小发射编号";
          else if (!this.settings.allowedKinds.includes(candidate.kind as never))
            rejected = "发币类型不在范围内";
          else if (parseEther(this.settings.minLiquidityEth) > 0n)
            rejected = "尚无独立池储备证据，未通过最低储备筛选";
          if (rejected) {
            session.finish(item.id, rejected);
            observedBatch.delete(item.id);
            this.log("rejected", {
              token: candidate.token,
              launchNumber: candidate.launchNumber,
              reason: rejected,
            });
            continue;
          }
          if (!batchCurrent()) {
            this.log("api_waiting", {
              detail: "校验期间收到新的发行资料，重新核对已知候选顺序",
            });
            return;
          }
          await this.handle(candidate, client, deployment, {
            isCurrent: batchCurrent,
          });
          // If a process exits before handle claims its journal, the pending candidate remains.
          // Once claimed, the durable journal prevents a second buy even before this write.
          if (!active()) {
            session.finish(item.id, String(this.state.phase));
            return;
          }
        }
        if (active())
          this.state = {
            phase: "watching",
            detail: "等待下一个符合设置的新主网项目",
          };
      } catch {
        if (active()) {
          this.state = {
            phase: "failed",
            reason:
              "首个候选的读取或链上证据检查未完成，已停止；不会改买后面的币",
          };
          this.monitor = {
            ...this.monitor,
            status: "error",
            detail: String(this.state.reason),
          };
          this.log("execution_stopped", { detail: this.state.reason });
          this.cleanup();
        }
      } finally {
        this.busy = false;
        if (!this.running) this.journal?.close();
      }
    };
    let pollTimer: NodeJS.Timeout | undefined;
    let failures = 0;
    const poll = async () => {
      if (!active()) return;
      let delay = this.settings.pollIntervalMs;
      try {
        const next = await this.api.snapshot(controller.signal);
        if (!active()) return;
        try {
          session.enqueue(next);
        } catch {
          // We have seen new information but cannot durably retain it. Treating
          // this as a network retry would let an older in-flight batch buy.
          this.state = {
            phase: "failed",
            reason: "新发行记录无法保存，已停止交易；先修复本地记录再启动",
          };
          this.monitor = {
            ...this.monitor,
            status: "error",
            detail: String(this.state.reason),
          };
          this.log("execution_stopped", { detail: this.state.reason });
          this.cleanup(!this.busy);
          return;
        }
        this.applyApiSnapshot(next);
        failures = 0;
        delay = Math.max(delay, (next.cacheMaxAgeSeconds ?? 0) * 1000);
        void tick();
      } catch {
        if (active()) {
          failures++;
          delay = Math.min(60000, delay * 2 ** Math.min(failures, 5));
          this.log("api_error", {
            detail: "官方 API 读取失败，保留已有候选并退避重试",
          });
        }
      } finally {
        if (active()) pollTimer = setTimeout(() => void poll(), delay);
      }
    };
    this.stops.push(() => {
      if (pollTimer) clearTimeout(pollTimer);
    });
    pollTimer = setTimeout(
      () => void poll(),
      Math.max(
        this.settings.pollIntervalMs,
        (snapshot.cacheMaxAgeSeconds ?? 0) * 1000,
      ),
    );
    this.timer = setInterval(() => void tick(), 3000);
    void tick();
  }
  async start(mode: "dry-run" | "live") {
    if (this.running || this.starting || this.stopping || this.busy)
      throw Error("已有任务运行或正在结束");
    // Keep every read, quote and signature bound to the exact settings
    // and wallet selected when this run started, even if callers mutate config.
    const snapshot = configSchema.parse({ ...this.config, taxCheck: "off" });
    for (const value of Object.values(snapshot))
      if (Array.isArray(value)) Object.freeze(value);
    this.runConfig = Object.freeze(snapshot);
    this.runAccount = this.walletAccount();
    this.starting = true;
    try {
      const generation = ++this.generation;
      this.mode = mode;
      this.lastScanned = undefined;
      this.effectiveConfig = undefined;
      if (mode === "live") {
        if (!(await this.check()).ok)
          throw Error("实盘检查未通过，请查看检查清单");
        if (generation !== this.generation) throw Error("启动已取消");
        this.journal = new Journal();
        this.journal.lock();
        if (this.journal.state.phase !== "idle")
          throw Error("已有交易记录，需核对链上回执后人工处理，禁止重复买入");
        this.state = { ...this.journal.state };
      }
      this.running = true;
      this.log("started", { mode });
      if (this.settings.discoverySource === "api") {
        this.log("tax_check_disabled", { detail: "未检测税率；实盘直接使用链上报价与限额，不运行本地买卖模拟" });
        await this.startApi(generation);
        return;
      }
      let deployment: Deployment | null = null;
      try {
        deployment = loadDeployment();
      } catch {}
      if (!deployment || !this.settings.rpcHttpUrls.length) {
        if (mode === "live") throw Error("缺少部署配置");
        this.state = {
          phase: "observing",
          detail: "公开 API 观察模式；未连接交易网络，不签名、不发送交易",
        };
        this.stops.push(this.watchApi());
        return;
      }
      const client = this.client();
      if ((await client.getChainId()) !== 1)
        throw Error("交易网络必须为 Ethereum 主网");
      if (generation !== this.generation) throw Error("启动已取消");
      let adapter: LaunchAdapter = projectAdapter;
      let adapterCodeHash: Hex | undefined;
      if (process.env.IMD_ADAPTER_PATH) {
        adapterCodeHash = keccak256(readFileSync(process.env.IMD_ADAPTER_PATH));
        const adapterUrl = pathToFileURL(process.env.IMD_ADAPTER_PATH);
        adapterUrl.searchParams.set("code", adapterCodeHash);
        adapter = (await import(adapterUrl.href)).default;
        if (typeof adapter?.discover !== "function")
          throw Error("无效的发射适配器");
      }
      const boundary = await resolveBoundary(
        client,
        deployment,
        this.settings.startBlock,
      );
      this.effectiveConfig = {
        ...this.settings,
        startBlock: boundary.startBlock,
      };
      // A cursor proves only the history checked under this exact discovery scope and policy.
      const strategyFingerprint = keccak256(
        stringToHex(
          JSON.stringify({
            discoveryVersion: "canonical-registry-v1",
            adapter: process.env.IMD_ADAPTER_PATH
              ? { path: process.env.IMD_ADAPTER_PATH, code: adapterCodeHash }
              : "default",
            deployment,
            allowedKinds: [...this.settings.allowedKinds].sort(),
            allowedHooks: this.settings.allowedHooks
              .map((h) => h.toLowerCase())
              .sort(),
            minLaunchNumber: this.settings.minLaunchNumber,
            maxBuyTaxBps: this.settings.maxBuyTaxBps,
            maxSellTaxBps: this.settings.maxSellTaxBps,
            minLiquidityEth: this.settings.minLiquidityEth,
          }),
        ),
      );
      const cursorStore = new CursorStore(boundary, strategyFingerprint, mode);
      const cursor = cursorStore.load();
      this.nextBlock = BigInt(cursor.nextBlock);
      this.lastScanned = cursor.lastScanned && {
        number: BigInt(cursor.lastScanned.number),
        hash: cursor.lastScanned.hash,
      };
      this.activationHead = await client.getBlockNumber();
      if (generation !== this.generation) throw Error("启动已取消");
      this.monitor = {
        status: this.nextBlock <= this.activationHead ? "auditing" : "watching",
        startBlock: boundary.startBlock,
        nextBlock: this.nextBlock.toString(),
        source: boundary.source,
        auditThroughBlock: this.activationHead.toString(),
        detail:
          "先补查启动前历史；若已有符合条件的发行则报告已错过，不追买旧币",
      };
      this.state = {
        phase: this.monitor.status,
        fromBlock: this.nextBlock.toString(),
      };
      this.log("boundary_resolved", { ...this.monitor });
      const reorg = () => {
        this.log("chain_reorg", {
          detail: "已扫描区块被重组，停止以避免跳过首发",
        });
        this.state = {
          phase: "failed",
          reason: "链重组，需要重新核对监控起点与扫描进度",
        };
        this.monitor = {
          ...this.monitor,
          status: "error",
          detail: String(this.state.reason),
        };
        this.cleanup();
      };
      const checkpointCanonical = async () => {
        const checkpoint = this.lastScanned ?? {
          number: BigInt(boundary.startBlock),
          hash: boundary.blockHash,
        };
        return (
          (await client.getBlock({ blockNumber: checkpoint.number })).hash ===
          checkpoint.hash
        );
      };
      const tick = async () => {
        if (!this.running || this.busy || generation !== this.generation)
          return;
        this.busy = true;
        try {
          if (!(await checkpointCanonical())) {
            reorg();
            return;
          }
          const head = await client.getBlockNumber();
          // Bound work per tick without dropping any older range.
          let chunks = 0;
          while (this.running && this.nextBlock <= head && chunks++ < 5) {
            const end =
              this.nextBlock + 99n < head ? this.nextBlock + 99n : head;
            const before = await client.getBlock({ blockNumber: end });
            const candidates = await adapter.discover(this.nextBlock, end, {
              client,
              config: this.effectiveConfig!,
              deployment: deployment!,
            });
            const after = await client.getBlock({ blockNumber: end });
            if (before.hash !== after.hash || !(await checkpointCanonical())) {
              reorg();
              return;
            }
            // A buggy adapter or inconsistent RPC must not move a cursor past unexamined data.
            if (
              candidates.some(
                (c) => c.blockNumber < this.nextBlock || c.blockNumber > end,
              )
            )
              throw Error("Candidate outside scan range");
            candidates.sort((a, b) =>
              a.blockNumber < b.blockNumber
                ? -1
                : a.blockNumber > b.blockNumber
                  ? 1
                  : a.transactionIndex - b.transactionIndex ||
                    a.logIndex - b.logIndex,
            );
            for (const candidate of candidates) {
              if (!this.running) break;
              await this.handle(candidate, client, deployment!);
            }
            if (!this.running) break;
            const scanned = await client.getBlock({ blockNumber: end });
            if (scanned.hash !== after.hash || !(await checkpointCanonical())) {
              reorg();
              return;
            }
            cursorStore.save({
              nextBlock: (end + 1n).toString(),
              lastScanned: { number: end.toString(), hash: scanned.hash },
            });
            this.lastScanned = { number: end, hash: scanned.hash };
            this.nextBlock = end + 1n;
            this.monitor = {
              ...this.monitor,
              nextBlock: this.nextBlock.toString(),
              status:
                this.nextBlock <= this.activationHead ? "auditing" : "watching",
              detail:
                this.nextBlock <= this.activationHead
                  ? `已核查至区块 ${end}，继续补查历史`
                  : `历史核查完成，等待第一个符合条件的新发行；下一扫描区块 ${this.nextBlock}`,
            };
            this.state = {
              phase: this.monitor.status,
              fromBlock: this.nextBlock.toString(),
            };
          }
        } catch {
          this.monitor = {
            ...this.monitor,
            status: "error",
            detail: "历史读取或进度保存失败，保留原区间重试；不会跳过缺失数据",
          };
          this.log("scan_error", { detail: "链上读取失败，下次从原区间重试" });
        } finally {
          this.busy = false;
          if (!this.running) this.journal?.close();
        }
      };
      for (const rpc of this.settings.rpcWsUrls) {
        const ws = createPublicClient({
          chain: mainnet,
          transport: webSocket(rpc, {
            reconnect: true,
            retryCount: 0,
            timeout: 5000,
          }),
        });
        this.stops.push(
          ws.watchBlocks({
            onBlock: () => void tick(),
            onError: () =>
              this.log("ws_error", { detail: "WebSocket 断线，HTTP 持续补扫" }),
          }),
        );
      }
      this.timer = setInterval(() => void tick(), 1000);
      this.stops.push(this.watchApi(() => void tick()));
      void tick();
    } catch (e) {
      if (this.running)
        this.monitor = {
          ...this.monitor,
          status: "error",
          detail: "启动未完成；请检查节点历史读取、官方部署和本地进度记录",
        };
      this.cleanup();
      throw e;
    } finally {
      this.starting = false;
    }
  }
  private async handle(
    candidate: Candidate,
    client: PublicClient,
    deployment: Deployment,
    apiEvidence?: { isCurrent?: () => boolean },
  ) {
    if (poolId(candidate.pool) !== candidate.poolId)
      throw Error("Pool ID invalid");
    const rejected = apiEvidence
      ? null
      : await eligibility(candidate, {
          client,
          config: this.effectiveConfig ?? this.settings,
          deployment,
        });
    if (rejected) {
      this.log("rejected", {
        token: candidate.token,
        launchNumber: candidate.launchNumber,
        reason: rejected,
      });
      return;
    }
    if (!this.running) return;
    const launchBlock = await client.getBlock({
      blockNumber: candidate.blockNumber,
    });
    if (launchBlock.hash !== candidate.blockHash) throw Error("Launch reorged");
    if (apiEvidence)
      await this.verifyApiEvidence(
        candidate,
        client,
        deployment,
      );
    if (!this.running) return;
    if (candidate.blockNumber <= this.activationHead) {
      const reason = `启动前区块 ${candidate.blockNumber} 已有首个符合条件的发行；已错过，停止且不追买`;
      if (this.mode === "live") {
        if (!this.journal!.claim(candidate.id, candidate.token)) return;
        this.journal!.update({
          phase: "failed",
          blockNumber: candidate.blockNumber.toString(),
          reason,
        });
      }
      this.state = {
        phase: "missed",
        token: candidate.token,
        launchNumber: candidate.launchNumber,
        blockNumber: candidate.blockNumber.toString(),
        reason,
      };
      this.monitor = { ...this.monitor, status: "missed", detail: reason };
      this.log("history_missed", { ...this.state });
      this.cleanup();
      return;
    }
    if (!this.running || (apiEvidence?.isCurrent && !apiEvidence.isCurrent()))
      return;
    if (
      this.mode === "live" &&
      !this.journal!.claim(candidate.id, candidate.token)
    )
      return;
    this.state = {
      phase: "selected",
      token: candidate.token,
      launchNumber: candidate.launchNumber,
    };
    try {
      const c = this.settings;
      const value = parseEther(c.buyAmountEth);
      const account =
        this.mode === "live" ? this.runAccount : undefined;
      // Pin quote to canonical state; no zero-minimum-output shortcuts.
      const block = await client.getBlock();
      const launchBlock = await client.getBlock({
        blockNumber: candidate.blockNumber,
      });
      if (launchBlock.hash !== candidate.blockHash)
        throw Error("Launch reorged");
      // Initial IMD liquidity can be out of range at the opening tick. A zero active
      // liquidity read is not proof that the swap fails: the swap can cross a tick.
      const quote = await client.simulateContract({
        address: asAddress(deployment.quoter.address),
        account: account?.address,
        abi: quoterAbi,
        functionName: "quoteExactInputSingle",
        args: [
          {
            poolKey: candidate.pool,
            zeroForOne: true,
            exactAmount: value,
            hookData: "0x",
          },
        ],
        blockNumber: block.number,
      });
      const minOut = minimumOut(quote.result[0], c.slippageBps);
      const data = encodeBuy(
        candidate.pool,
        value,
        minOut,
        block.timestamp + BigInt(c.deadlineSeconds),
      );
      this.log("quote", {
        token: candidate.token,
        launchNumber: candidate.launchNumber,
        amountInWei: value.toString(),
        expectedOut: quote.result[0].toString(),
        minOut: minOut.toString(),
      });
      if (!this.running) return;
      if (!account) {
        this.state = {
          phase: "simulated",
          token: candidate.token,
          minimumOutput: minOut.toString(),
        };
        this.cleanup();
        return;
      }
      const [nonce, pending, balance, gas] = await Promise.all([
        client.getTransactionCount({
          address: account.address,
          blockTag: "latest",
        }),
        client.getTransactionCount({
          address: account.address,
          blockTag: "pending",
        }),
        client.getBalance({ address: account.address }),
        client.estimateGas({
          account: account.address,
          to: asAddress(deployment.router.address),
          data,
          value,
        }),
      ]);
      if (nonce !== pending) throw Error("钱包有未完成交易，请使用独立钱包");
      const gasLimit = (gas * 120n) / 100n;
      const maxFeePerGas = parseGwei(c.maxFeeGwei),
        maxPriorityFeePerGas = parseGwei(c.priorityFeeGwei);
      if ((block.baseFeePerGas ?? 0n) + maxPriorityFeePerGas > maxFeePerGas)
        throw Error("Gas 单价上限低于当前基础费加优先费");
      const worstGas = gasLimit * maxFeePerGas;
      if (worstGas > parseEther(c.maxGasEth))
        throw Error("最坏 Gas 费用超过设置上限");
      if (balance < value + worstGas)
        throw Error("余额不足以覆盖买入和最高 Gas");
      if (
        (await client.getBlock({ blockNumber: candidate.blockNumber })).hash !==
        candidate.blockHash
      )
        throw Error("发币区块发生重组");
      if (apiEvidence)
        await this.verifyApiEvidence(
          candidate,
          client,
          deployment,
        );
      if (!this.running) throw Error("监听已停止");
      if (apiEvidence?.isCurrent && !apiEvidence.isCurrent())
        throw Error("候选记录在交易准备期间改变，已停止");
      const raw = await account.signTransaction({
        chainId: 1,
        type: "eip1559",
        to: asAddress(deployment.router.address),
        data,
        value,
        nonce,
        gas: gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
      const txHash = keccak256(raw);
      this.journal!.update({ phase: "signed", txHash, nonce });
      this.state = { ...this.journal!.state };
      if (!this.running) throw Error("停止发生在签名之后，需核对日志");
      if (apiEvidence?.isCurrent && !apiEvidence.isCurrent())
        throw Error("候选记录在签名期间改变，禁止广播");
      // Identical signed payload / nonce to every checked RPC, never multiple buys.
      try {
        await Promise.any(
          c.rpcHttpUrls.map(async (url) => {
            const hash = await this.client(url).sendRawTransaction({
              serializedTransaction: raw,
            });
            if (hash !== txHash) throw Error("Hash mismatch");
            return hash;
          }),
        );
      } catch {
        this.journal!.update({
          phase: "uncertain",
          reason: "节点未返回成功；可能已广播，禁止自动重试",
        });
        throw Error("广播结果不确定");
      }
      this.journal!.update({ phase: "broadcast" });
      this.state = { ...this.journal!.state };
      this.log("broadcast", { txHash });
      this.cleanup(false);
      const receipt = await client.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 2,
        timeout: 180000,
        pollingInterval: 1000,
      });
      this.journal!.update({
        phase: receipt.status === "success" ? "confirmed" : "failed",
        blockNumber: receipt.blockNumber.toString(),
        reason:
          receipt.status === "success" ? undefined : "交易回滚，Gas 已消耗",
      });
      this.state = { ...this.journal!.state };
      this.log(receipt.status === "success" ? "confirmed" : "reverted", {
        txHash,
      });
    } catch (e) {
      if (this.mode === "dry-run") {
        this.state = {
          phase: "failed",
          token: candidate.token,
          reason: "首个候选报价失败，停止演练，未发送交易",
        };
        this.log("simulation_failed");
        return;
      }
      const phase = this.journal!.state.phase;
      if (phase === "claimed")
        this.journal!.update({
          phase: "failed",
          reason: "首个候选预检或模拟失败，停止交易；检查余额、Gas 和池状态",
        });
      else if (phase === "signed" || phase === "broadcast")
        this.journal!.update({
          phase: "uncertain",
          reason: "发送或回执未确定，禁止自动重试",
        });
      this.state = { ...this.journal!.state };
      this.log("execution_stopped", {
        phase: this.journal!.state.phase,
        detail: "请核对交易状态后再操作",
      });
    } finally {
      this.cleanup();
    }
  }
  private async verifyApiEvidence(
    candidate: Candidate,
    client: PublicClient,
    deployment: Deployment,
  ) {
    if (this.settings.discoverySource !== "api" || deployment.chainId !== 1)
      throw Error("API evidence outside mode");
    const protocol = trustedUniswap();
    await Promise.all(
      Object.entries(protocol).map(async ([role, contract]) => {
        const supplied = deployment[role as keyof typeof protocol];
        if (
          supplied.address.toLowerCase() !== contract.address ||
          supplied.codeHash.toLowerCase() !== contract.codeHash
        )
          throw Error("Untrusted router protocol");
        const code = await client.getCode({ address: contract.address });
        if (!code || code === "0x" || keccak256(code) !== contract.codeHash)
          throw Error("Protocol code changed");
      }),
    );
  }

  stop() {
    ++this.generation;
    this.log("stopped", {
      detail: "停止发现新币；已经广播的交易不能靠此按钮撤回",
    });
    this.cleanup(!this.busy);
  }
  private cleanup(closeJournal = true) {
    this.running = false;
    this.stops.splice(0).forEach((stop) => stop());
    if (this.timer) clearInterval(this.timer);
    if (closeJournal) this.journal?.close();
  }
}
