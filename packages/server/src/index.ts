import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import Database from "better-sqlite3";
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
  /** 广播通知（异常/维护/关闭），前端弹不可关闭大窗 */
  broadcastNotice: (level: "info" | "warn" | "error" | "maintenance" | "shutdown", message: string) => void;
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
    const db = new Database(cfg.dbFile);
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

/**
 * 探测空闲端口：从 startPort 起逐个测试（临时 TCP server），返回第一个可监听的端口。
 * EADDRINUSE 继续向后试；全部占用或其它错误则抛错。
 */
function findFreePort(startPort: number, maxTries: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let i = 0;
    const probe = () => {
      const port = startPort + i;
      const srv = net.createServer();
      srv.unref();
      srv.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && i + 1 < maxTries) {
          i++;
          probe();
        } else if (err.code === "EADDRINUSE") {
          reject(new Error(`端口 ${startPort}~${startPort + maxTries - 1} 均被占用，无法启动。可修改 serverConfig.json 的 httpPort 或用环境变量 FSEX_HTTP_PORT 指定其他端口。`));
        } else {
          reject(err);
        }
      });
      srv.once("listening", () => {
        srv.close();
        resolve(port);
      });
      srv.listen(port);
    };
    probe();
  });
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

  // 首次启动（无任何历史消息）插入欢迎消息——沿用旧版 filesync 的假消息
  try {
    const exist = await engine.listMessages(1);
    if (exist.length === 0) {
      await engine.addMessage({
        id: randomUUID(),
        kind: "text",
        sender: { deviceId: "__system__", deviceName: "Rose Die", color: "#047878", platform: "other" },
        ts: Date.now(),
        text: "是信息，好耶！<copyright by NoRain>",
      });
    }
  } catch (e) {
    console.warn("[welcome] 插入欢迎消息失败:", (e as Error).message);
  }

  const uploads = new UploadService({ store, engine, uploadDir: cfg.uploadDir });
  const app = createHttpApp(cfg, engine, uploads);

  const httpServer = http.createServer(app);
  // 局域网大文件分片上传：调大 keep-alive 空闲超时，避免服务器在 chunk 间隙关闭连接池，
  // 导致浏览器复用已关闭连接而触发 request aborted / ECONNRESET。
  httpServer.keepAliveTimeout = 30_000;
  httpServer.headersTimeout = 35_000;
  httpServer.requestTimeout = 120_000;
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  wss.on("error", () => {
    /* server error 已由下方 httpServer error 处理，此处吞掉避免 unhandled 崩溃 */
  });
  const wsServer = new SocketServer(engine, wss);

  // 端口监听：默认端口被占用时自动向后探测空闲端口（最多 20 个），并打印切换提示
  const MAX_PORT_TRIES = 20;
  const requestedPort = cfg.httpPort;
  const httpPort = await findFreePort(requestedPort, MAX_PORT_TRIES);
  if (httpPort !== requestedPort) {
    console.log(`  ⚠ 端口 ${requestedPort} 已被占用，已自动切换到端口 ${httpPort}`);
  }
  await new Promise<void>((resolve, reject) => {
    const onErr = (err: NodeJS.ErrnoException) => reject(err);
    httpServer.once("error", onErr);
    httpServer.listen(httpPort, () => resolve());
  });

  const lan = lanAddress();
  const httpUrl = `http://${lan}:${httpPort}`;
  const wsUrl = `ws://${lan}:${httpPort}/ws`; // WS 复用 HTTP 端口

  if (opts.verbose !== false && !cfg.quiet) {
    console.log("");
    console.log("  filesyncEX 6.0.0-beta2");
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
    // 关闭前广播通知（异常/维护/关闭），让前端弹不可关闭大窗提示
    wsServer.broadcastNotice("shutdown", "服务器即将关闭，请稍后重新连接");
    await new Promise((r) => setTimeout(r, 500)); // 留时间让通知送达客户端
    wsServer.close();
    // httpServer.close() 会等待所有连接结束（含空闲 keep-alive，其 keepAliveTimeout 为 30s），
    // 若不强制关闭，关闭流程会挂起 ~20s 才退出，前端 WS 也迟迟不断开 → 连接状态不更新。closeAllConnections 立即释放。
    await new Promise<void>((r) => {
      httpServer.close(() => r());
      httpServer.closeAllConnections();
    });
    await engine.close();
    if (lockFile) {
      try {
        fs.rmSync(lockFile, { force: true });
      } catch {
        /* noop */
      }
    }
  };

  return { httpPort, wsPort: httpPort, httpUrl, wsUrl, engine, close, broadcastNotice: (level, message) => wsServer.broadcastNotice(level, message) };
}

