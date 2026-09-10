#!/usr/bin/env node
/**
 * 一键统一版本号：把项目所有位置的版本号改为同一个新版本。
 * 用法：pnpm run set-version <新版本号>     例：pnpm run set-version 6.3.0
 *      （等价于 node scripts/set-version.mjs 6.3.0）
 *
 * 覆盖位置（**只有这 7 个文件需要改**）：
 *   - 根 + 5 个子包 package.json 的 "version"
 *   - README 顶部「版本」行
 *
 * 不需要额外步骤：
 *   - 服务端版本号已改为**单一来源**（`packages/server/src/version.ts`）：打包时由 esbuild
 *     `--define:__APP_VERSION__` 把根 package.json 的版本内联进 bundle，开发模式运行时向上查找
 *     仓库根 package.json 读取 —— 所以 `/api/health`、启动 banner、网页控制台版本号都自动跟随；
 *   - `pnpm-lock.yaml` 记录的是 `workspace:*` 链接而非版本号，改版本号**无需重新 install**；
 *   - 产物名（release/filesyncex-<版本>.exe）与 exe 版本信息由打包脚本运行时读根 package.json 生成。
 *
 * 校验：`pnpm test`（其中「版本号唯一来源」用例会断言 APP_VERSION 与根 package.json 一致）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

if (args.length !== 1) {
  console.error("用法：pnpm run set-version <新版本号>（等价 node scripts/set-version.mjs <新版本号>）");
  console.error("例：pnpm run set-version 6.3.0");
  process.exit(1);
}
const next = args[0].trim();
if (!/^\d+\.\d+\.\d+/.test(next)) {
  console.error("版本号格式应为 x.y.z（可带后缀，如 6.0.0-beta3）");
  process.exit(1);
}

// 以根 package.json 为当前版本唯一来源，自动检测旧版本
const rootPkgPath = path.join(root, "package.json");
let current;
try {
  current = JSON.parse(fs.readFileSync(rootPkgPath, "utf8")).version;
} catch {
  current = "";
}
if (!current) {
  console.error("无法读取根 package.json 的当前版本");
  process.exit(1);
}
if (current === next) {
  console.log(`当前版本已是 ${next}，无需修改`);
  process.exit(0);
}

const files = [
  "package.json",
  "packages/core/package.json",
  "packages/protocol/package.json",
  "packages/server/package.json",
  "packages/shell/package.json",
  "packages/web/package.json",
  "README.md",
];

let changed = 0;
for (const rel of files) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) continue;
  const text = fs.readFileSync(p, "utf8");
  const nextText = text.split(current).join(next);
  if (nextText !== text) {
    fs.writeFileSync(p, nextText, "utf8");
    console.log(`  ✓ ${rel}`);
    changed++;
  }
}
console.log(`版本已统一：${current} → ${next}（更新 ${changed} 个文件）`);
