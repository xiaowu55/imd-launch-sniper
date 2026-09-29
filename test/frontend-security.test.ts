import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { configSchema } from "../src/config.js";

const html = readFileSync(
  new URL("../public/index.html", import.meta.url),
  "utf8",
);
const script = readFileSync(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);
const addressA = `0x${"a".repeat(40)}`;
const addressB = `0x${"b".repeat(40)}`;

class Element {
  [key: string]: unknown;
  children: Element[] = [];
  handlers = new Map<string, (event?: unknown) => unknown>();
  classList = { add() {}, remove() {}, toggle() {} };
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  checked = false;
  disabled = false;
  required = false;
  hidden = false;
  private content = "";
  private inputValue = "";
  constructor(
    readonly tagName: string,
    readonly id = "",
  ) {}
  get value() {
    return this.inputValue;
  }
  set value(value: unknown) {
    this.inputValue = String(value);
  }
  get textContent(): string {
    return (
      this.content + this.children.map((child) => child.textContent).join("")
    );
  }
  set textContent(value: unknown) {
    this.content = String(value);
    this.children = [];
  }
  set innerHTML(_value: unknown) {
    throw new Error("unsafe HTML sink used");
  }
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]) {
    this.content = "";
    this.children = children;
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  addEventListener(name: string, listener: (event?: unknown) => unknown) {
    this.handlers.set(name, listener);
  }
}

function fixtureStatus(
  config = configSchema.parse({}),
  overrides: Record<string, unknown> = {},
) {
  return {
    mode: "live",
    running: false,
    canConfigure: true,
    config,
    state: { phase: "idle" },
    readiness: { ok: false, checks: [] },
    wallet: { configured: true, address: addressA, source: "server-env" },
    monitor: { status: "pending", source: "api-baseline" },
    logs: [],
    ...overrides,
  };
}

function frontend(initial = fixtureStatus()) {
  const nodes = new Map<string, Element>();
  const created: Element[] = [];
  for (const match of html.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    assert(!nodes.has(match[2]!), `duplicate DOM id ${match[2]}`);
    const node = new Element(match[1]!.toUpperCase(), match[2]);
    node.required = /\brequired\b/.test(match[0]);
    if (node.id === "startBlockMode") node.value = "auto";
    nodes.set(node.id, node);
  }
  for (const match of script.matchAll(/\$\("([^"]+)"\)/g))
    assert(nodes.has(match[1]!), `missing DOM id ${match[1]}`);
  const kinds = ["evm_project", "custom_token", "univ4_hook"].map((value) => {
    const node = new Element("INPUT");
    node.value = value;
    return node;
  });
  const fields = () =>
    [...nodes.values(), ...kinds].filter((node) =>
      ["INPUT", "SELECT", "TEXTAREA"].includes(node.tagName),
    );
  const form = nodes.get("config-form")!;
  form.querySelectorAll = (selector: string) => {
    if (selector.includes("allowedKinds"))
      return selector.endsWith(":checked")
        ? kinds.filter((node) => node.checked)
        : kinds;
    if (selector === "input")
      return fields().filter((node) => node.tagName === "INPUT");
    return fields().filter(
      (node) =>
        !selector.includes("not(#live-consent)") || node.id !== "live-consent",
    );
  };
  form.reportValidity = () =>
    fields().every(
      (node) => node.disabled || !node.required || node.value !== "",
    );
  const banner = new Element("SECTION");
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  let status = initial;
  let transport: (
    path: string,
    init?: RequestInit,
  ) => Promise<Response> = async (path) => {
    assert.equal(path, "/api/status");
    return Response.json(status);
  };
  const exports: Record<string, (...args: any[]) => any> = {};
  const context = {
    exports,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return transport(path, init);
    },
    window: { addEventListener() {} },
    document: {
      getElementById: (id: string) => nodes.get(id),
      querySelector: () => banner,
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: (tag: string) => {
        const node = new Element(tag.toUpperCase());
        created.push(node);
        return node;
      },
      createTextNode: (text: string) => {
        const node = new Element("#TEXT");
        node.textContent = text;
        return node;
      },
    },
  };
  vm.runInNewContext(
    script.replace(
      "  initialize();",
      "  Object.assign(exports, { renderStatus, renderLogs, renderResearch, collect, approveLive, setConnection });",
    ),
    context,
  );
  exports.renderStatus!(status);
  return {
    nodes,
    created,
    calls,
    exports,
    setStatus(next: ReturnType<typeof fixtureStatus>) {
      status = next;
      exports.renderStatus!(next);
    },
    setTransport(next: typeof transport) {
      transport = next;
    },
    input(id: string, value: string) {
      const node = nodes.get(id)!;
      node.value = value;
      form.handlers.get("input")!({ target: node });
    },
    approve() {
      const checkbox = nodes.get("live-consent")!;
      checkbox.checked = true;
      form.handlers.get("input")!({ target: checkbox });
    },
    async start() {
      await nodes.get("live-button")!.handlers.get("click")!();
    },
    async stop() {
      await nodes.get("stop-button")!.handlers.get("click")!();
    },
  };
}

test("untrusted log, project, wallet and readiness text cannot create executable DOM", () => {
  const ui = frontend();
  const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  ui.setStatus(
    fixtureStatus(undefined, {
      wallet: { configured: true, address: payload },
      readiness: {
        ok: false,
        checks: [{ name: payload, detail: payload, ok: false }],
      },
      logs: [
        { event: payload, message: payload, time: "2026-09-28T00:00:00Z" },
      ],
      research: {
        checkedAt: "2026-09-28T00:00:00Z",
        launches: [
          {
            launchNumber: 1,
            chainId: 1,
            status: payload,
            token: payload,
            kind: payload,
          },
        ],
      },
    }),
  );
  assert(ui.nodes.get("activity-list")!.textContent.includes(payload));
  assert(ui.nodes.get("readiness-list")!.textContent.includes(payload));
  assert(ui.nodes.get("research-list")!.textContent.includes(payload));
  assert.equal(
    ui.created.some((node) =>
      ["SCRIPT", "IMG", "IFRAME"].includes(node.tagName),
    ),
    false,
  );
  ui.approve();
  assert.equal(ui.nodes.get("live-consent")!.checked, false);
  assert.match(ui.nodes.get("feedback")!.textContent, /核对执行钱包/);
});

test("an active server configuration replaces stale or unsaved form budgets and revokes approval", () => {
  const ui = frontend();
  ui.input("buyAmountEth", "0.02");
  ui.approve();
  assert.equal(ui.nodes.get("live-consent")!.checked, true);
  const actual = configSchema.parse({
    buyAmountEth: "0.09",
    maxGasEth: "0.02",
  });
  ui.setStatus(fixtureStatus(actual, { running: true, canConfigure: false }));
  assert.equal(ui.nodes.get("buyAmountEth")!.value, "0.09");
  assert.equal(ui.nodes.get("summary-buy")!.textContent, "0.09");
  assert.equal(ui.nodes.get("summary-total")!.textContent, "0.11");
  assert.equal(ui.nodes.get("live-consent")!.checked, false);
  assert.equal(ui.nodes.get("buyAmountEth")!.disabled, true);
  assert.equal(ui.nodes.get("stop-button")!.disabled, false);
});

test("server startup and wallet changes lock controls and invalidate a previous confirmation", () => {
  const ui = frontend();
  ui.approve();
  ui.setStatus(
    fixtureStatus(undefined, {
      wallet: { configured: true, address: addressB },
    }),
  );
  assert.equal(ui.nodes.get("live-consent")!.checked, false);
  ui.setStatus(fixtureStatus(undefined, { canConfigure: false }));
  assert.equal(ui.nodes.get("save-button")!.disabled, true);
  assert.equal(ui.nodes.get("wallet-reload-button")!.disabled, true);
  assert.equal(ui.nodes.get("buyAmountEth")!.disabled, true);
});

test("live submission binds the exact displayed budget and public wallet that were confirmed", async () => {
  const ui = frontend();
  ui.input("buyAmountEth", "0.02");
  ui.approve();
  let accepted = configSchema.parse({});
  ui.setTransport(async (path, init) => {
    if (path === "/api/config") {
      accepted = JSON.parse(String(init?.body));
      return Response.json(accepted);
    }
    if (path === "/api/start") {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.mode, "live");
      assert.deepEqual(body.expectedConfig, accepted);
      assert.equal(body.expectedConfig.buyAmountEth, "0.02");
      assert.equal(body.expectedConfig.taxCheck, "off");
      assert.equal(body.expectedWalletAddress, addressA);
      return Response.json({ ok: true });
    }
    return Response.json(fixtureStatus(accepted));
  });
  await ui.start();
  assert.equal(ui.calls.filter((call) => call.path === "/api/start").length, 1);
  assert.equal(ui.nodes.get("live-consent")!.checked, false);
});

test("configuration changes after approval cannot silently alter the amount being submitted", async () => {
  const ui = frontend();
  ui.approve();
  // Even a change that bypasses the normal input event must be caught at submission.
  ui.nodes.get("buyAmountEth")!.value = "0.50";
  await ui.start();
  assert.equal(
    ui.calls.some(
      (call) => call.path === "/api/start" || call.path === "/api/config",
    ),
    false,
  );
  assert.match(ui.nodes.get("feedback")!.textContent, /配置已变化/);
});

test("wallet changes during saving retain the originally confirmed address and surface a conflict", async () => {
  const ui = frontend();
  ui.approve();
  const config = configSchema.parse({});
  ui.setTransport(async (path, init) => {
    if (path === "/api/config")
      return Response.json(JSON.parse(String(init?.body)));
    if (path === "/api/start") {
      assert.equal(
        JSON.parse(String(init?.body)).expectedWalletAddress,
        addressA,
      );
      return Response.json(
        { error: "执行钱包已变化，请重新核对" },
        { status: 409 },
      );
    }
    return Response.json(
      fixtureStatus(config, {
        wallet: { configured: true, address: addressB },
      }),
    );
  });
  await ui.start();
  assert.match(ui.nodes.get("feedback")!.textContent, /钱包已变化/);
  assert.equal(ui.nodes.get("live-consent")!.checked, false);
  assert.equal(ui.calls.filter((call) => call.path === "/api/start").length, 1);
});

test("the product exposes only explicit live execution and API tax limits cannot imply active checking", () => {
  const ui = frontend();
  assert(!ui.nodes.has("dry-run-button"));
  assert(!ui.nodes.has("taxCheck"));
  assert.equal(ui.exports.collect!().taxCheck, "off");
  assert.equal(ui.nodes.get("maxBuyTaxBps")!.disabled, true);
  assert.match(ui.nodes.get("tax-check-detail")!.textContent, /未检测/);
  ui.input("discoverySource", "chain");
  assert.equal(ui.nodes.get("maxBuyTaxBps")!.disabled, false);
  assert.match(
    ui.nodes.get("tax-check-detail")!.textContent,
    /已审核的固定税率/,
  );
  assert(!html.includes("/Users/"));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("stop remains available during a delayed save and cancels the remaining local start chain", async () => {
  const ui = frontend();
  ui.approve();
  const saved = deferred<Response>();
  const stopped = deferred<Response>();
  ui.setTransport(async (path) => {
    if (path === "/api/config") return saved.promise;
    if (path === "/api/stop") return stopped.promise;
    assert.equal(path, "/api/status");
    return Response.json(fixtureStatus());
  });
  const starting = ui.start();
  assert.equal(ui.nodes.get("stop-button")!.disabled, false);
  const stopping = ui.stop();
  const repeatedStop = ui.stop();
  assert.equal(ui.nodes.get("stop-button")!.disabled, true);
  assert.equal(ui.calls.filter((call) => call.path === "/api/stop").length, 1);
  assert.equal(ui.nodes.get("live-consent")!.checked, false);
  stopped.resolve(Response.json({ message: "已停止" }));
  await Promise.all([stopping, repeatedStop]);
  saved.resolve(Response.json(configSchema.parse({})));
  await starting;
  assert.equal(ui.calls.filter((call) => call.path === "/api/start").length, 0);
  assert.equal(ui.nodes.get("stop-button")!.disabled, true);
  assert.equal(ui.nodes.get("feedback")!.textContent, "已停止");
});

test("stop runs concurrently with a delayed start and its result cannot be overwritten by late start completion", async () => {
  const ui = frontend();
  ui.approve();
  const started = deferred<Response>();
  const startEntered = deferred<void>();
  ui.setTransport(async (path, init) => {
    if (path === "/api/config")
      return Response.json(JSON.parse(String(init?.body)));
    if (path === "/api/start") {
      startEntered.resolve();
      return started.promise;
    }
    if (path === "/api/stop")
      return Response.json({ message: "已停止，启动已取消" });
    assert.equal(path, "/api/status");
    return Response.json(fixtureStatus());
  });
  const starting = ui.start();
  await startEntered.promise;
  assert.equal(ui.nodes.get("stop-button")!.disabled, false);
  await ui.stop();
  assert.equal(ui.calls.filter((call) => call.path === "/api/stop").length, 1);
  started.resolve(Response.json({ message: "迟到的启动响应" }));
  await starting;
  assert.equal(ui.nodes.get("feedback")!.textContent, "已停止，启动已取消");
  assert.equal(ui.nodes.get("live-consent")!.checked, false);
});
