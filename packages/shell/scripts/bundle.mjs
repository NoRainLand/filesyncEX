/**
 * 服务端 bundle 步骤：ESM → 单文件 CJS（pkg 无法对 ESM/import.meta 生成 bytecode，必须先 bundle）。
 *
 * 为什么单独一个脚本（而不是在 package.mjs 里拼命令行字符串）：
 *  `--define:__APP_VERSION__=<版本>` 的值必须是**合法 JSON 字符串字面量**（要带引号），
 *  而命令行里的引号会被 shell 吃掉（Windows cmd / POSIX sh 都会剥外层引号）→
 *  esbuild 报 `Invalid define value (must be an entity name or valid JSON syntax): 6.2.0`，打包直接失败。
 *  这里用 child_process 的**参数数组**方式调用 esbuild，完全不经过 shell，引号问题不存在。
 *
 * 用法：node scripts/bundle.mjs        （在 packages/shell 下运行；package.mjs 会调用）
 *   - 版本号取自仓库根 package.json 的 version（与产物名/health/banner 同一来源）
 *   - 产物 packages/shell/dist/bundle.cjs，并校验版本号确实内联进产物
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const shellDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(shellDir, "../..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version ?? "0.0.0";
const outFile = path.join(shellDir, "dist", "bundle.cjs");

/** 解析 esbuild 可执行文件：优先仓库内 pnpm 安装的版本（可复现），避免误用全局安装 */
function resolveEsbuild() {
  const candidates = [
    path.join(shellDir, "node_modules", "esbuild", "bin", "esbuild"),
    path.join(root, "node_modules", "esbuild", "bin", "esbuild"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return { cmd: process.execPath, args: [c] };
  // 回退：交给 PATH 上的 esbuild（少数环境用全局安装）
  return { cmd: "esbuild", args: [] };
}
const esbuild = resolveEsbuild();

fs.mkdirSync(path.dirname(outFile), { recursive: true });
const args = [
  ...esbuild.args,
  "src/index.ts",
  "--bundle",
  "--platform=node",
  "--format=cjs",
  "--target=node18",
  `--outfile=${path.relative(shellDir, outFile)}`,
  "--external:better-sqlite3",
  // 参数数组直传，引号原样保留 → esbuild 拿到的是合法 JSON 字符串字面量
  `--define:__APP_VERSION__=${JSON.stringify(version)}`,
  "--log-level=warning",
];
console.log(`▶ esbuild bundle（${path.basename(esbuild.cmd)}${esbuild.args.length ? " + 仓库内 esbuild" : "（PATH）"}）`);
const r = spawnSync(esbuild.cmd, args, { cwd: shellDir, stdio: "inherit" });
if (r.status !== 0) {
  console.error("✘ esbuild bundle 失败");
  process.exit(r.status ?? 1);
}

// 兜底校验：产物里必须真的内联了版本号（防止 define 因引号/参数问题静默失效）
const bundled = fs.readFileSync(outFile, "utf8");
if (!bundled.includes(`"${version}"`)) {
  console.error(`✘ bundle 内未找到内联版本号 "${version}"：--define 未生效`);
  process.exit(1);
}
console.log(`   ✔ 已内联版本号 ${version}（bundle.cjs ${(bundled.length / 1024).toFixed(0)}KB）`);
