import path from "node:path";
import { run } from "@filesyncex/server";

/**
 * filesyncEX 可执行入口（最终被 pkg 打包为单个 exe）。
 * - 普通运行：node dist/index.js
 * - pkg 打包：静态资源从打包虚拟文件系统（/snapshot）读取
 */
/** 启动时打印的伪 3D 字符 logo（FS，沿用旧工程 filesync） */
const ASCII_ART = [
  "",
  "          _____                    _____",
  "         /\\    \\                  /\\    \\",
  "        /::\\    \\                /::\\    \\",
  "       /::::\\    \\              /::::\\    \\",
  "      /::::::\\    \\            /::::::\\    \\",
  "     /:::/\\:::\\    \\          /:::/\\:::\\    \\",
  "    /:::/__\\:::\\    \\        /:::/__\\:::\\    \\",
  "   /::::\\   \\:::\\    \\       \\:::\\   \\:::\\    \\",
  "  /::::::\\   \\:::\\    \\    ___\\:::\\   \\:::\\    \\",
  " /:::/\\:::\\   \\:::\\    \\  /\\   \\:::\\   \\:::\\    \\",
  "/:::/  \\:::\\   \\:::\\____\\/::\\   \\:::\\   \\:::\\____\\",
  "\\::/    \\:::\\   \\::/    /\\:::\\   \\:::\\   \\::/    /",
  " \\/____/ \\:::\\   \\/____/  \\:::\\   \\:::\\   \\/____/",
  "          \\:::\\    \\       \\:::\\   \\:::\\    \\",
  "           \\:::\\____\\       \\:::\\   \\:::\\____\\",
  "            \\::/    /        \\:::\\  /:::/    /",
  "             \\/____/          \\:::\\/:::/    /",
  "                               \\::::::/    /",
  "                                \\::::/    /",
  "                                 \\::/    /",
  "                                  \\/____/",
].join("\n");

async function main(): Promise<void> {
  console.log(ASCII_ART);
  const isPkg = !!(process as unknown as { pkg?: unknown }).pkg;
  const config: { webDir?: string; quiet?: boolean } = {};

  if (isPkg) {
    // pkg 内资源：<exe>/web/dist（assets 打包进去）
    config.webDir = path.join(__dirname, "../../web/dist");
    config.quiet = false;
  }

  const srv = await run({ config });

  const shutdown = (): void => {
    void srv.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.resume();
}

main().catch((e: Error) => {
  console.error("[filesyncEX] 启动失败:", e.message);
  process.exit(1);
});
