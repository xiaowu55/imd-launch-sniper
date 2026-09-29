import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Engine } from "./engine.js";
import { isDeepStrictEqual } from "node:util";
import { saveConfig } from "./config.js";
import { walletStatus, reloadWalletEnv } from "./wallet.js";
import { Journal } from "./journal.js";
type ControlEngine = Pick<Engine,
  "mode" | "running" | "config" | "readiness" | "state" | "monitor" |
  "logs" | "research" | "launchFeed" | "canConfigure" | "resetMonitor" |
  "check" | "start" | "stop"
>;
type Services = {
  saveConfig?: typeof saveConfig;
  walletStatus?: typeof walletStatus;
  reloadWallet?: () => ReturnType<typeof reloadWalletEnv>;
  walletChangeAllowed?: () => boolean;
};
class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function json(res: ServerResponse, status: number, data: unknown) {
  const serialized = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(serialized);
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.length;
    if (size > 32768) throw new RequestError(413, "请求过大");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const value: unknown = raw ? JSON.parse(raw) : {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RequestError(400, "请求必须是 JSON 对象");
  return value as Record<string, unknown>;
}

/** Loopback control surface. Importing this module never starts trading or a listener. */
export function createControlServer(engine: ControlEngine, services: Services = {}) {
  const persistConfig = services.saveConfig ?? saveConfig;
  const getWallet = services.walletStatus ?? walletStatus;
  const reloadWallet = services.reloadWallet ?? (() => reloadWalletEnv(resolve(".env")));
  const walletChangeAllowed = services.walletChangeAllowed ?? (() => new Journal().state.phase === "idle");
  let stopRevision = 0;
  const server = createServer({ requestTimeout: 15000, headersTimeout: 10000, connectionsCheckingInterval: 1000 }, async (req, res) => {
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  const expected = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!expected.has(req.headers.host ?? ""))
    return json(res, 403, { error: "仅允许本机访问" });
  if (
    req.headers.origin &&
    !new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]).has(
      req.headers.origin,
    )
  )
    return json(res, 403, { error: "拒绝跨站请求" });
  if (req.headers["sec-fetch-site"] === "cross-site")
    return json(res, 403, { error: "拒绝跨站请求" });
  try {
    // Reject proxy-style absolute request targets and malformed URLs inside the error boundary.
    if (!req.url?.startsWith("/") || req.url.startsWith("//"))
      throw new RequestError(400, "请求路径不正确");
    const pathname = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
    if (
      ["POST", "PUT"].includes(req.method ?? "") &&
      req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
    )
      return json(res, 415, { error: "需要 application/json" });
    if (req.method === "GET" && pathname === "/api/status")
      return json(res, 200, {
        mode: engine.mode,
        running: engine.running,
        canConfigure: engine.canConfigure,
        config: engine.config,
        readiness: engine.readiness,
        state: engine.state,
        monitor: engine.monitor,
        logs: engine.logs,
        research: engine.research,
        launchFeed: engine.launchFeed,
        wallet: getWallet(),
      });
    if (req.method === "GET" && pathname === "/api/config")
      return json(res, 200, engine.config);
    if (req.method === "PUT" && pathname === "/api/config") {
      const input = await body(req);
      // No await between this check and the mutation: a slow body must not change an active run.
      if (!engine.canConfigure)
        return json(res, 409, { error: "请先停止任务再保存设置" });
      try {
        engine.config = persistConfig(input);
        engine.readiness = { ok: false, checks: [] };
        engine.resetMonitor();
        return json(res, 200, engine.config);
      } catch {
        return json(res, 400, {
          error: "设置格式不正确，请检查数值范围、地址和节点 URL",
        });
      }
    }
    if (req.method === "POST" && pathname === "/api/wallet/reload") {
      if (!engine.canConfigure || !walletChangeAllowed())
        return json(res, 409, {
          error: "请先停止任务；已有交易记录时，需先核对交易，不能直接更换钱包",
        });
      try {
        const wallet = reloadWallet();
        engine.readiness = { ok: false, checks: [] };
        return json(res, 200, wallet);
      } catch {
        return json(res, 400, {
          error:
            "尚未读取到有效钱包，请在项目终端运行 npm run wallet:import 后重试",
        });
      }
    }
    if (req.method === "POST" && pathname === "/api/check")
      return json(res, 200, await engine.check());
    if (req.method === "POST" && pathname === "/api/start") {
      const requestedRevision = stopRevision;
      const input = await body(req);
      if (requestedRevision !== stopRevision)
        return json(res, 409, { error: "该启动请求已被停止操作取消" });
      if (input.mode !== "live")
        return json(res, 400, { error: "控制台仅支持实盘，必须明确确认真实交易" });
      if (input.mode === "live") {
        const wallet = getWallet();
        if (!isDeepStrictEqual(input.expectedConfig, engine.config) ||
            !wallet.configured || typeof input.expectedWalletAddress !== "string" ||
            input.expectedWalletAddress.toLowerCase() !== wallet.address?.toLowerCase())
          return json(res, 409, { error: "设置或钱包与确认时不一致，请刷新并重新核对后启动实盘" });
      }
      await engine.start(input.mode);
      return json(res, 200, {
        ok: true,
        mode: engine.mode,
        running: engine.running,
      });
    }
    if (req.method === "POST" && pathname === "/api/stop") {
      stopRevision++;
      engine.stop();
      return json(res, 200, { ok: true, running: false });
    }
    const files: Record<string, string> = {
      "/": "index.html",
      "/app.js": "app.js",
      "/styles.css": "styles.css",
    };
    if (req.method === "GET" && files[pathname]) {
      const name = files[pathname]!;
      const content = await readFile(resolve("public", name));
      res.writeHead(200, {
        "Content-Type": name.endsWith(".html")
          ? "text/html; charset=utf-8"
          : name.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : "text/css; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(content);
      return;
    }
    json(res, 404, { error: "不存在的路径" });
  } catch (error) {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    json(res, error instanceof RequestError ? error.status : 400, {
      error:
        "操作未完成，请检查连接检测结果和任务日志；已有交易记录不会自动重试",
    });
  }
});
  return server;
}
