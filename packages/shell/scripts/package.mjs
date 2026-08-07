/**
 * 打包脚本（纯 JS）：依次构建 protocol→core→server→web→shell，再运行 pkg 生成 exe。
 * 产物：release/filesyncex.exe（Windows x64, Node 18）
 */
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const shellDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(shellDir, "../..");
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: "inherit" });

console.log("▶ 构建 protocol");
run("pnpm --filter @filesyncex/protocol build", root);
console.log("▶ 构建 core");
run("pnpm --filter @filesyncex/core build", root);

// 同步根目录 tool/ 到 web/public/tool（Vite 会复制进 dist，随 web 打包进 exe）
console.log("▶ 同步 tool/ → web/public/tool");
{
  const srcTool = path.join(root, "tool");
  const dstTool = path.join(root, "packages", "web", "public", "tool");
  fs.mkdirSync(dstTool, { recursive: true });
  if (fs.existsSync(srcTool)) {
    for (const f of fs.readdirSync(srcTool)) {
      const s = path.join(srcTool, f);
      if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(dstTool, f));
    }
    console.log("   已同步:", fs.readdirSync(srcTool).filter((f) => fs.statSync(path.join(srcTool, f)).isFile()).join(", "));
  } else {
    console.log("   (tool/ 目录不存在，跳过)");
  }
}

console.log("▶ 构建 server");
run("pnpm --filter @filesyncex/server build", root);
console.log("▶ 构建 web");
run("pnpm --filter @filesyncex/web build", root);
console.log("▶ 构建 shell");
run("pnpm --filter @filesyncex/shell build", root);

const outDir = path.join(root, "release");
fs.mkdirSync(outDir, { recursive: true });

// ESM → 单文件 CJS bundle（pkg 无法对 import.meta/ESM 生成 bytecode，需先 bundle）
console.log("▶ esbuild bundle（ESM → 单文件 CJS）");
run(
  "pnpm exec esbuild src/index.ts --bundle --platform=node --format=cjs --target=node18 --outfile=dist/bundle.cjs --external:better-sqlite3 --log-level=warning",
  shellDir
);

console.log("▶ pkg 打包（node18-win-x64）");
run(`pnpm exec pkg ${JSON.stringify(path.join(shellDir, "dist/bundle.cjs"))} --targets node18-win-x64 --output ${JSON.stringify(path.join(outDir, "filesyncex.exe"))} --config ${JSON.stringify(path.join(shellDir, "package.json"))}`, shellDir);

console.log("✔ 打包完成：", path.join(outDir, "filesyncex.exe"));
