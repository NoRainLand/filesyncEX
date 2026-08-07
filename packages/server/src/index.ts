import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import { MemoryStore, SqliteStore, SyncEngine, type Store } from "@filesyncex/core";
import { loadConfig, type ServerConfig } from "./config.js";
import { createHttpApp } from "./HttpServer.js";
import { SocketServer } from "./SocketServer.js";
import { UploadService } from "./upload.js";
import { lanAddress } from "./net.js";

export interface RunResult {
  httpPort: number;
  wsPort: number;
  httpUrl: string;
  wsUrl: string;
  engine: SyncEngine;
  close: () => Promise<void>;
}

export interface RunOptions {
  config?: Partial<ServerConfig>;
  /** 打印本地/局域网地址 */
  verbose?: boolean;
}

/** 进程是否存活（pid 检测，Windows 兼容） */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH：进程不存在；EPERM：进程存在但无权限发信号
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 唯一实例锁：在数据目录创建独占锁文件。
 * 已存在且持有进程存活 → 另一实例在运行，返回 null；
 * 持有进程已退出（崩溃残留）→ 删除锁并接管。
 */
function acquireLock(dataDir: string): string | null {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const lockFile = path.join(dataDir, ".instance.lock");
    if (fs.existsSync(lockFile)) {
      const oldPid = Number(fs.readFileSync(lockFile, "utf8").trim());
      if (Number.isInteger(oldPid) && oldPid > 0 && isProcessAlive(oldPid)) {
        return null; // 另一实例在运行
      }
      fs.rmSync(lockFile, { force: true }); // 崩溃残留，清理接管
    }
    const fd = fs.openSync(lockFile, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return lockFile;
  } catch {
    return null;
  }
}

async function createStore(cfg: ServerConfig): Promise<Store> {
  if (cfg.store === "memory") {
    const s = new MemoryStore();
    await s.init();
    return s;
  }
  try {
    const Database = (await import("better-sqlite3")).default;
    const db: import("better-sqlite3").Database = new Database(cfg.dbFile);
    const s = new SqliteStore(db);
    await s.init();
    return s;
  } catch (e) {
    console.warn("[store] better-sqlite3 初始化失败，降级为内存存储:", (e as Error).message);
    const s = new MemoryStore();
    await s.init();
    return s;
  }
}

/** 组装并启动 HTTP + WS 服务 */
export async function run(opts: RunOptions = {}): Promise<RunResult> {
  const cfg = loadConfig(opts.config);

  // 单实例锁
  const lockFile = acquireLock(cfg.dataDir);
  if (!lockFile) {
    throw new Error(`另一 filesyncEX 实例正在运行（数据目录 ${cfg.dataDir} 已被锁定）。请关闭后重试。`);
  }

  const store = await createStore(cfg);
  const engine = new SyncEngine(store, { historyLimit: cfg.historyLimit });
  const uploads = new UploadService({ store, engine, uploadDir: cfg.uploadDir });
  const app = createHttpApp(cfg, engine, uploads);

  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  wss.on("error", () => {
    /* server error 已由下方 httpServer error 处理，此处吞掉避免 unhandled 崩溃 */
  });
  const wsServer = new SocketServer(engine, wss);

  await new Promise<void>((resolve, reject) => {
    const onErr = (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`端口 ${cfg.httpPort} 已被占用（可能已有 filesyncEX 或其他服务在运行）。可修改 serverConfig.json 中的 httpPort/wsPort，或用环境变量 FSEX_HTTP_PORT/FSEX_WS_PORT 指定。`));
      } else {
        reject(err);
      }
    };
    httpServer.once("error", onErr);
    httpServer.listen(cfg.httpPort, () => resolve());
  });

  const lan = lanAddress();
  const httpUrl = `http://${lan}:${cfg.httpPort}`;
  const wsUrl = `ws://${lan}:${cfg.httpPort}/ws`; // WS 复用 HTTP 端口

  if (opts.verbose !== false && !cfg.quiet) {
    console.log("");
    console.log("  filesyncEX 6.0.0-alpha1");
    console.log("  ------------------------------");
    console.log(`  网页端   ${httpUrl}`);
    console.log(`  WebSocket ${wsUrl}`);
    console.log(`  数据目录 ${cfg.dataDir}`);
    console.log("");
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    wsServer.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
    await engine.close();
    if (lockFile) {
      try {
        fs.rmSync(lockFile, { force: true });
      } catch {
        /* noop */
      }
    }
  };

  return { httpPort: cfg.httpPort, wsPort: cfg.httpPort, httpUrl, wsUrl, engine, close };
}

