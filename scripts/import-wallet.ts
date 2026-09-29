import { fileURLToPath } from "node:url";
import { saveWalletEnv } from "../src/wallet.js";

async function hiddenInput(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("请在本机交互终端执行；不接受管道输入或命令行私钥");
  if (process.argv.length > 2)
    throw new Error(
      "请勿将私钥写在命令后面；运行 npm run wallet:import 后按提示输入",
    );
  return new Promise((resolveInput, reject) => {
    let value = "";
    const wasRaw = process.stdin.isRaw;
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(!!wasRaw);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (data: Buffer) => {
      const text = data.toString("utf8").replace(/\x1b\[(?:200|201)~/g, "");
      for (const char of text) {
        if (char === "\x03" || char === "\x04") {
          value = "";
          cleanup();
          reject(new Error("导入已取消，未保存"));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolveInput(value);
          value = "";
          return;
        }
        if (char === "\x7f" || char === "\b") value = value.slice(0, -1);
        else if (char === "\x15") value = "";
        else value += char;
        if (value.length > 256) {
          value = "";
          cleanup();
          reject(new Error("输入过长，未保存"));
          return;
        }
      }
    };
    process.stdout.write(
      "粘贴专用交易钱包私钥，然后回车（不显示输入，Ctrl+C 取消）：",
    );
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

try {
  console.log(
    "本地钱包导入。私钥保存在当前项目 .env，权限 0600（仅当前用户可读写），文件没有加密。",
  );
  let key = await hiddenInput();
  let address: string;
  try {
    address = saveWalletEnv(
      key,
      fileURLToPath(new URL("../.env", import.meta.url)),
    );
  } finally {
    key = "";
  }
  console.log(`已保存钱包地址：${address}`);
  console.log("回到控制台，点击“重新加载钱包”。导入本身不会发起交易。");
} catch (error) {
  // Only our own short errors are safe; never dump a stack or external signer error.
  const message = error instanceof Error ? error.message : "钱包导入失败";
  if (/^[\u4e00-\u9fff]/.test(message)) console.error(message);
  else console.error("钱包文件写入失败，请检查项目目录权限");
  process.exitCode = 1;
}
