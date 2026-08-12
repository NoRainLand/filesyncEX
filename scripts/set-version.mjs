#!/usr/bin/env node
/**
 * 一键统一版本号：把项目所有位置的版本号改为同一个新版本。
 * 用法：node scripts/set-version.mjs <新版本号>     例：node scripts/set-version.mjs 6.0.0-beta3
 *
 * 覆盖位置：
 *   - 根 + 5 个子包 package.json 的 "version"
 *   - server /api/health 返回的 version（HttpServer.ts）
 *   - server 启动 banner（index.ts）
 *   - web main.ts printMsg 默认版本
 *   - README 版本行、LICENSE 示例版本
 * 当前版本以根 package.json 为准，脚本自动检测并全文替换。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

if (args.length !== 1) {
  console.error("用法：node scripts/set-version.mjs <新版本号>");
  console.error("例：node scripts/set-version.mjs 6.0.0-beta3");
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
  "packages/server/src/HttpServer.ts",
  "packages/server/src/index.ts",
  "packages/web/src/main.ts",
  "README.md",
  "LICENSE.md",
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
