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
import { lanAddress, lanAddresses } from "./net.js";
import { APP_VERSION } from "./version.js";

export interface RunResult {
  httpPort: number;
  wsPort: number;
  httpUrl: string;
  wsUrl: string;
  engine: SyncEngine;
  /** 上传服务（测试/维护可调用 sweep 做磁盘清理） */
  uploads: UploadService;
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

/** 原生模块 ABI 不匹配（NODE_MODULE_VERSION）——开发时最常见的失败，提示语要给出可执行的修复办法 */
function isAbiMismatch(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  return err?.code === "ERR_DLOPEN_FAILED" || /NODE_MODULE_VERSION|compiled against a different Node\.js version/i.test(String(err?.message ?? ""));
}

async function createStore(cfg: ServerConfig): Promise<{ store: Store; backupDb?: (dest: string) => Promise<void> }> {
  if (cfg.store === "memory") {
    const s = new MemoryStore();
    await s.init();
    return { store: s };
  }
  try {
    const db = new Database(cfg.dbFile);
    const s = new SqliteStore(db);
    await s.init();
    // 数据导出用：WAL 模式下生成一致快照（better-sqlite3 backup 是异步 API，必须 await）
    const backupDb = async (dest: string): Promise<void> => { await db.backup(dest); };
    return { store: s, backupDb };
  } catch (e) {
    const msg = String((e as Error).message);
    // 原生模块与当前 Node ABI 不匹配：**不再静默降级内存存储**。
    // 静默降级会让「数据重启即丢」被当成正常现象（且日志只一行 warn，很容易漏看），
    // 这里直接报错退出，并给出修复办法；确实想用内存模式请显式设置 store:"memory"
    // 或 FSEX_ALLOW_MEMORY_STORE=1。
    if (isAbiMismatch(e) && process.env.FSEX_ALLOW_MEMORY_STORE !== "1") {
      throw new Error(
        [
          "better-sqlite3 原生模块与当前 Node 版本 ABI 不匹配，无法使用本地数据库。",
          `当前 Node：${process.version}（ABI ${process.versions.modules}）`,
          `原因：${msg.split("\n")[0]}`,
          "",
          "修复办法（任选其一）：",
          "  1) 用 Node 18/20 运行（仓库根有 .nvmrc：nvm use 18）；",
          "  2) 重新编译原生模块：pnpm rebuild better-sqlite3；",
          "  3) 想改用内存存储（数据不持久化）：设置环境变量 FSEX_ALLOW_MEMORY_STORE=1 或在 serverConfig.json 里写 {\"store\":\"memory\"}。",
        ].join("\n")
      );
    }
    console.warn("[store] better-sqlite3 初始化失败，降级为内存存储（数据不会持久化）:", msg);
    const s = new MemoryStore();
    await s.init();
    return { store: s };
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
        // port=0 时内核分配随机空闲端口，必须回读实际端口（测试用 0 表示「随便给一个」）
        const addr = srv.address();
        const actual = typeof addr === "object" && addr ? addr.port : port;
        srv.close();
        resolve(actual);
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

  const { store, backupDb } = await createStore(cfg);
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
  uploads.startSweeper(); // 启动时 + 每 6h 回收废弃分片会话目录 / 孤儿封面 / 组装临时文件
  // 系统操作（关闭/重置）：close 在下方定义，用占位引用，运行时端点调用时已就绪
  let shutdownImpl: (() => Promise<void>) | undefined;
  const systemOps = {
    /** 优雅关闭服务器并退出进程 */
    shutdown: async (): Promise<void> => {
      await shutdownImpl?.();
      process.exit(0);
    },
    /** 重置服务器：清空全部消息/文件/上传会话，服务器保持运行（不关闭/不重启）；广播空 welcome 让所有前端立即同步为空列表 */
    reset: async (): Promise<void> => {
      try {
        await store.clearAll();
        // 清空物理上传目录
        if (cfg.uploadDir) {
          fs.rmSync(cfg.uploadDir, { recursive: true, force: true });
          fs.mkdirSync(cfg.uploadDir, { recursive: true });
        }
        console.log("[sys] 已清空全部数据（服务器保持运行）");
      } catch (e) {
        console.warn("[sys] 重置数据失败:", (e as Error).message);
      }
      wsServer.broadcastReset(); // 让所有在线客户端立即清空消息列表（不断开连接）
    },
  };
  const app = createHttpApp(cfg, engine, uploads, backupDb, systemOps);

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
  if (httpPort !== requestedPort && requestedPort !== 0) {
    console.log(`  ⚠ 端口 ${requestedPort} 已被占用，已自动切换到端口 ${httpPort}`);
  }
  await new Promise<void>((resolve, reject) => {
    const onErr = (err: NodeJS.ErrnoException) => reject(err);
    httpServer.once("error", onErr);
    httpServer.listen(httpPort, () => resolve());
  });

  const lan = lanAddress();
  const lanAll = lanAddresses();
  const httpUrl = `http://${lan}:${httpPort}`;
  const wsUrl = `ws://${lan}:${httpPort}/ws`; // WS 复用 HTTP 端口

  if (opts.verbose !== false && !cfg.quiet) {
    console.log("");
    console.log(`  filesyncEX ${APP_VERSION}`);
    console.log("  ------------------------------");
    console.log(`  网页端   ${httpUrl}`);
    // 多网卡机器（虚拟网卡/VPN）上首个地址未必可达，全部列出便于手动选择
    if (lanAll.length > 1) {
      for (const ip of lanAll.slice(1)) console.log(`           http://${ip}:${httpPort}`);
    }
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
    uploads.stopSweeper();
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
  shutdownImpl = close; // 系统操作（关闭/重置）在服务器运行后引用优雅关闭

  return { httpPort, wsPort: httpPort, httpUrl, wsUrl, engine, uploads, close, broadcastNotice: (level, message) => wsServer.broadcastNotice(level, message) };
}

