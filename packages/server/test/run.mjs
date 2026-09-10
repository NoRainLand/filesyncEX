/**
 * 测试入口：进程内顺序跑 packages/server/test/*.test.mjs（见 helpers/testkit.mjs 说明）。
 * 用法：node test/run.mjs [过滤关键字]
 *
 * 需要 better-sqlite3 原生模块的用例（引用计数 / 上传链路）在当前 Node ABI 不匹配时**自动跳过**并提示，
 * 其余用例照常运行 —— 这样在任意 Node 版本下 `pnpm test` 都有意义（完整的 sqlite 用例请在 Node 18 下跑，见 .nvmrc）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { runAll } from "./helpers/testkit.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2];

/** 是否存在可用的 SQLite 驱动（node:sqlite 或 better-sqlite3）——与服务端 createStore 的优先级一致 */
function sqliteAvailable() {
  const require = createRequire(import.meta.url);
  try {
    const { DatabaseSync } = require("node:sqlite");
    new DatabaseSync(":memory:").close();
    return true;
  } catch {
    /* 继续试 better-sqlite3 */
  }
  try {
    const D = require("better-sqlite3");
    new (D.default ?? D)(":memory:").close();
    return true;
  } catch {
    return false;
  }
}

const NEEDS_SQLITE = ["core-store.test.mjs", "upload.test.mjs"];
const hasSqlite = sqliteAvailable();
const skipped = [];
const files = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith(".test.mjs"))
  .filter((f) => (filter ? f.includes(filter) : true))
  .filter((f) => {
    if (!hasSqlite && NEEDS_SQLITE.includes(f)) {
      skipped.push(f);
      return false;
    }
    return true;
  })
  .sort();

if (skipped.length > 0) {
  console.warn(
    `⚠ 跳过需 better-sqlite3 的用例：${skipped.join(", ")}\n` +
      `  原因：原生模块与当前 Node ${process.version}（ABI ${process.versions.modules}）不匹配。\n` +
      `  在 Node 18 下运行可执行全部用例（仓库根 .nvmrc）：nvm use && pnpm rebuild better-sqlite3\n`
  );
}
if (files.length === 0) {
  console.error(`没有可运行的测试文件：${filter ?? "(全部)"}`);
  process.exit(skipped.length > 0 ? 0 : 1);
}

for (const f of files) {
  await import(pathToFileURL(path.join(testDir, f)).href);
}

const stats = await runAll();
if (stats.fail > 0) process.exit(1);
process.exit(0);
