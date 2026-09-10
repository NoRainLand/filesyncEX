import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { run } from "../../dist/index.js";
import { SqliteStore } from "@filesyncex/core";

/** 仓库根（packages/server/test/helpers/ → ../../../..） */
export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const require = createRequire(import.meta.url);

/**
 * 按运行时选择 SQLite 驱动，**顺序与服务端 createStore 保持一致**：
 *  - Node 22.5+/24+ 有内置 `node:sqlite` → 用它（无原生模块、无 ABI 约束）
 *  - 老 Node（18/20）→ 回退 better-sqlite3 预编译包
 * 返回未初始化（未跑 init()）的 Store，交给 run() 去 init。
 */
export function makeSqliteStore(dbFile) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    return new SqliteStore(new DatabaseSync(dbFile));
  } catch {
    const BetterSqlite3 = require("better-sqlite3");
    return new SqliteStore(new (BetterSqlite3.default ?? BetterSqlite3)(dbFile));
  }
}

/**
 * 打开原始 SQLite 句柄（测试用，直接断言表内容）：驱动优先级与 makeSqliteStore 一致。
 * 返回的对象可用 `prepare().run/get/all`、`exec()`、`close()`。
 */
export function openRawDb(dbFile, opts = {}) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    return new DatabaseSync(dbFile, opts.readOnly ? { readOnly: true } : {});
  } catch {
    const BetterSqlite3 = require("better-sqlite3");
    return new (BetterSqlite3.default ?? BetterSqlite3)(dbFile, opts.readOnly ? { readonly: true } : {});
  }
}

/**
 * 只读查询一行（测试用）：与 makeSqliteStore 同一驱动优先级，避免测试受 Node 版本/ABI 影响。
 * 例：`sqliteGet(dbFile, "SELECT refs FROM files WHERE key = ?", key)`
 */
export function sqliteGet(dbFile, sql, ...params) {
  const db = openRawDb(dbFile, { readOnly: true });
  try {
    return db.prepare(sql).get(...params);
  } finally {
    db.close();
  }
}

/**
 * 启动一个测试用服务器（随机端口 + 独立临时数据目录）。
 * 默认 sqlite（与打包环境一致，能验证引用计数/物理文件回收）；内存模式用于不关心持久化的用例。
 */
export async function startServer(opts = {}) {
  const label = opts.label ?? `run-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const dataDir = path.join(rootDir, "_dev", "test-tmp", label);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const wantSqlite = (opts.store ?? "sqlite") === "sqlite";
  const srv = await run({
    config: {
      httpPort: 0, // 系统分配空闲端口
      webDir: path.join(rootDir, "_dev", "empty-web"),
      dataDir,
      store: opts.store ?? "sqlite",
      quiet: true,
      // 允许用例覆盖限制项（如把 maxFileSize 调小以验证超限拒绝）
      ...(opts.config ?? {}),
    },
    // 注入 Store：避免服务端在测试里再做一次驱动探测，也保证测试与打包产物用同一套 SQLite 语义
    ...(wantSqlite ? { store: makeSqliteStore(path.join(dataDir, "filesync.db")) } : {}),
    verbose: false,
  });
  const port = srv.httpPort;
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    await srv.close();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* Windows 下 sqlite 句柄释放略有延迟，删不掉不影响测试结论 */
    }
  };
  let auth;
  for (let attempt = 0; ; attempt++) {
    try {
      auth = await (await fetch(base + "/api/auth")).json();
      break;
    } catch (e) {
      if (attempt >= 20) {
        throw new Error(`测试服务器未就绪（${base}）：${e?.cause?.message ?? e?.message ?? e}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const token = auth.token;
  const adminFetch = (p, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("X-FSEX-Token", token);
    return fetch(base + p, { ...init, headers });
  };
  return { base, wsUrl: `ws://127.0.0.1:${port}/ws`, srv, dataDir, uploadDir: path.join(dataDir, "uploads"), token, adminFetch, stop };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 测试用设备身份 */
export const device = (id = "dev-a", name = "user_test") => ({
  deviceId: id,
  deviceName: name,
  color: "#047878",
  platform: "other",
});

/** 直传一个小文件（≤ 8MiB 走 direct 路径） */
export async function uploadDirect(s, name, data, mime = "application/octet-stream", coverKey) {
  const q = new URLSearchParams({ name, mime, device: JSON.stringify(device()) });
  if (coverKey) q.set("coverKey", coverKey);
  const r = await fetch(`${s.base}/api/upload/direct?${q.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: data,
  });
  return { status: r.status, json: await r.json() };
}

/** 分片上传（init → chunk × N → complete 全链路） */
export async function uploadChunked(s, name, data, mime = "application/octet-stream", sha256) {
  const init = await (
    await fetch(`${s.base}/api/upload/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, size: data.length, mime, sha256, device: device() }),
    })
  ).json();
  for (let i = 0; i < init.chunkCount; i++) {
    const start = i * init.chunkSize;
    await fetch(`${s.base}/api/upload/chunk/${init.uploadId}/${i}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: data.subarray(start, Math.min(start + init.chunkSize, data.length)),
    });
  }
  const r = await fetch(`${s.base}/api/upload/complete/${init.uploadId}`, { method: "POST" });
  return { status: r.status, json: await r.json() };
}

/** 打开 WS 客户端并记录收到的帧（供断言 peers/del/add 广播） */
export async function openWs(s) {
  const { WebSocket } = await import("ws");
  const ws = new WebSocket(s.wsUrl);
  const frames = [];
  ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
  await new Promise((res, rej) => {
    ws.on("open", () => res());
    ws.on("error", (e) => rej(e));
  });
  const waitFor = async (type, ms = 1500) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = [...frames].reverse().find((f) => f.type === type);
      if (hit) return hit;
      await sleep(25);
    }
    return undefined;
  };
  return {
    frames,
    send: (f) => ws.send(JSON.stringify(f)),
    waitFor,
    close: () => ws.close(),
  };
}
