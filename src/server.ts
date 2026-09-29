import { resolve } from "node:path";
import { Engine } from "./engine.js";
import { createControlServer } from "./control-server.js";
import { observeLaunches } from "./observer.js";
import { loadServerEnvironment } from "./wallet.js";
loadServerEnvironment(resolve(".env"));
const engine = new Engine();
const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("PORT 必须是有效端口号");
export const server = createControlServer(engine);
server.listen(port, "127.0.0.1", () =>
  console.log(`IMD 控制台 http://127.0.0.1:${port}（仅本机访问，实盘需手动启动）`),
);
void observeLaunches()
  .then((result) => { engine.research = result; })
  .catch(() => {});
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    engine.stop();
    server.close();
    process.exit(0);
  });
