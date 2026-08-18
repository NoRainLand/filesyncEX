import express from "express";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import type { ServerConfig } from "./config.js";
import type { UploadService } from "./upload.js";
import { SyncEngine } from "@filesyncex/core";
import { lanAddress } from "./net.js";
import { decodeToChannels, toWavBuffer } from "./wave.js";
import { makeZip, type ZipEntry } from "./zip.js";

/* 转码流缓存：key → WAV Buffer（只解码一次）；LRU 上限，防止大音频常驻内存 */
const STREAM_CACHE_MAX = 8; // 最多同时缓存 8 个转码流
const streamCache = new Map<string, Buffer>();
/** 读缓存并刷新到末尾（LRU 命中） */
function streamCacheGet(key: string): Buffer | undefined {
  const v = streamCache.get(key);
  if (v !== undefined) {
    streamCache.delete(key);
    streamCache.set(key, v);
  }
  return v;
}

/** 把请求体规范化为 Buffer；非二进制（如被 express.json 提前解析成对象）返回 null */
function toBuffer(body: unknown): Buffer | null {
  if (Buffer.isBuffer(body)) return body;
  if (body == null) return Buffer.alloc(0);
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return null;
}
/** 写缓存，超出上限淘汰最久未用 */
function streamCacheSet(key: string, buf: Buffer): void {
  streamCache.delete(key);
  streamCache.set(key, buf);
  if (streamCache.size > STREAM_CACHE_MAX) {
    const oldest = streamCache.keys().next().value;
    if (oldest !== undefined) streamCache.delete(oldest);
  }
}

/**
 * HTTP 传输层：
 *  - 静态资源（web/dist，构建后）
 *  - /api/upload/init|chunk|complete（分片/断点续传）
 *  - /api/file/<key>（下载）
 *  - /api/msgs（历史 REST 兜底）、/api/health
 */
export interface SystemOps {
  /** 优雅关闭服务器并退出进程 */
  shutdown: () => Promise<void>;
  /** 重置服务器：清空全部数据并软重启 */
  reset: () => Promise<void>;
}

export function createHttpApp(cfg: ServerConfig, engine: SyncEngine, uploads: UploadService, backupDb?: (dest: string) => Promise<void>, systemOps?: SystemOps): express.Express {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  // 文件引用计数归零 → 删除物理文件（订阅引擎事件）
  engine.events.on("file-gc", ({ key }) => uploads.deleteFile(key));

  /* 健康检查（返回本机局域网 IP + 实际 HTTP 端口，供前端二维码/地址使用真实地址；端口自动切换时取实际监听端口） */
  app.get("/api/health", (req, res) => res.json({ ok: true, name: "filesyncEX", version: "6.1.0", lanIp: lanAddress(), port: req.socket.localPort ?? cfg.httpPort }));

  /* 消息历史（REST 兜底；首屏主要走 WS welcome） */
  app.get("/api/msgs", async (_req, res) => {
    try {
      res.json(await engine.listMessages());
    } catch (e) {
      res.status(500).json({ error: String((e as Error).message) });
    }
  });

  /* 上传：初始化 */
  app.post("/api/upload/init", async (req, res) => {
    const r = await uploads.init(req.body);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r.res);
  });

  /* 上传：分片（binary body） */
  app.post(
    "/api/upload/chunk/:uploadId/:index",
    express.raw({ type: ["application/octet-stream", "application/x-www-form-urlencoded", "*/*"], limit: "64mb" }),
    async (req, res) => {
      const uploadId = String(req.params.uploadId);
      const index = Number(req.params.index);
      const buf = toBuffer(req.body);
      if (!buf) return res.status(400).json({ error: "请求体必须是二进制" });
      const r = await uploads.chunk(uploadId, index, buf);
      if (!r.ok) return res.status(400).json({ error: r.error });
      res.json(r.res);
    }
  );

  /* 上传：完成（组装+广播） */
  app.post("/api/upload/complete/:uploadId", async (req, res) => {
    const r = await uploads.complete(String(req.params.uploadId));
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r.res);
  });

  /* 上传：视频封面（body 为 jpeg；返回 coverKey，随视频上传 init/direct 关联到消息） */
  app.post(
    "/api/upload/cover",
    express.raw({ type: ["image/jpeg", "application/octet-stream", "*/*"], limit: "4mb" }),
    async (req, res) => {
      const buf = toBuffer(req.body);
      if (!buf) return res.status(400).json({ error: "请求体必须是二进制" });
      const r = await uploads.saveCover(buf);
      if (!r.ok) return res.status(400).json({ error: r.error });
      res.json({ coverKey: r.coverKey });
    }
  );

  /* 为已存在的视频消息补充封面（前端 canvas 取帧反向上传；已有封面则 409 拒绝，不覆盖） */
  app.post(
    "/api/msg/:id/cover",
    express.raw({ type: ["image/jpeg", "application/octet-stream", "*/*"], limit: "4mb" }),
    async (req, res) => {
      const id = String(req.params.id);
      const buf = toBuffer(req.body);
      if (!buf) return res.status(400).json({ error: "请求体必须是二进制" });
      const msg = await engine.getMessage(id);
      if (!msg) return res.status(404).json({ error: "消息不存在" });
      // 防覆盖：已有封面不允许覆盖
      if (msg.file?.cover) return res.status(409).json({ error: "封面已存在，不覆盖" });
      const r = await uploads.saveCover(buf);
      if (!r.ok) return res.status(400).json({ error: r.error });
      const cover = "/api/file/" + encodeURIComponent(r.coverKey);
      const updated: import("@filesyncex/protocol").MsgDataT = { ...msg, file: { ...msg.file!, cover } };
      await engine.updateMessage(id, updated);
      res.json({ cover, msg: updated });
    }
  );

  /* 上传：小文件直接上传（body 为整个文件，query 携带 name/mime/device；≤ DIRECT_LIMIT 跳过哈希/分片） */
  app.post(
    "/api/upload/direct",
    express.raw({ type: ["application/octet-stream", "*/*"], limit: "64mb" }),
    async (req, res) => {
      const buf = toBuffer(req.body);
      if (!buf) return res.status(400).json({ error: "请求体必须是二进制" });
      let device: import("@filesyncex/protocol").DeviceInfoT | undefined;
      try {
        device = JSON.parse(String(req.query.device ?? "null"));
      } catch {
        device = undefined;
      }
      const coverKey = String(req.query.coverKey || "") || undefined;
      const r = await uploads.direct(String(req.query.name ?? ""), buf.length, String(req.query.mime || "") || undefined, device, buf, coverKey);
      if (!r.ok) return res.status(400).json({ error: r.error });
      res.json(r.res);
    }
  );

  /* 下载（文件名用原始名，避免 Windows/Mac/iOS 下载到 xxx-原名 的存储 key） */
  app.get("/api/file/:key", async (req, res) => {
    const key = String(req.params.key);
    const p = uploads.filePath(key);
    if (!p) return res.status(404).json({ error: "文件不存在" });
    const name = await uploads.displayName(key);
    res.download(p, name);
  });

  /* ---------- 系统能力（NiarApp 接口的后端） ---------- */

  /** 是否 pkg 打包运行（pkg 注入全局 process.pkg）；开发模式为 false */
  const isPackaged = (): boolean => !!((process as unknown as { pkg?: unknown }).pkg);

  /** 解析 reg 命令错误：Windows 中文系统 stderr 为 GBK 编码，需转 UTF-8 否则日志乱码（TextDecoder gbk 由 Node ICU 内置，零依赖） */
  const regErrorText = (e: unknown): string => {
    const err = e as { stderr?: Buffer | string; message?: string };
    const raw = err.stderr ?? err.message ?? "";
    try {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
      return new TextDecoder("gbk").decode(buf).trim() || "未知错误";
    } catch {
      return String(raw);
    }
  };

  /** 注册表操作当前 exe 开机自启（HKCU Run 键，无需管理员）：body.action 1=开启 0=取消；仅打包模式可用 */
  app.post("/api/sys/autostart", (req, res) => {
    if (!isPackaged()) return res.status(400).json({ error: "开发模式无法操作开机自启（需先打包为 exe）" });
    const action = Number((req.body as { action?: number } | undefined)?.action ?? 1);
    const exe = process.execPath;
    const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    try {
      if (action === 1) {
        execFileSync("reg", ["add", RUN_KEY, "/v", "filesyncEX", "/t", "REG_SZ", "/d", exe, "/f"], { stdio: "pipe" });
        console.log(`[sys] 开启开机自启：${exe}（来自 ${req.ip}）`);
        res.json({ ok: true, enabled: true, exe });
      } else {
        execFileSync("reg", ["delete", RUN_KEY, "/v", "filesyncEX", "/f"], { stdio: "pipe" });
        console.log(`[sys] 取消开机自启：${exe}（来自 ${req.ip}）`);
        res.json({ ok: true, enabled: false, exe });
      }
    } catch (e) {
      const msg = regErrorText(e);
      console.warn(`[sys] 开机自启操作失败（${action === 1 ? "开启" : "取消"}）: ${msg}`);
      res.status(500).json({ error: "操作开机自启失败: " + msg });
    }
  });

  /** 查询当前 exe 开机自启状态（读取 HKCU Run 键）。用 spawnSync：reg 失败（非 0 退出）不抛异常，避免 GBK stderr 进入任何日志 */
  app.get("/api/sys/autostart", (_req, res) => {
    if (!isPackaged()) return res.status(400).json({ error: "开发模式无开机自启状态（需先打包为 exe）" });
    const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    let enabled = false;
    try {
      const r = spawnSync("reg", ["query", RUN_KEY, "/v", "filesyncEX"], { encoding: "buffer" });
      if (r.status === 0 && r.stdout) {
        const out = r.stdout.toString("utf8");
        const m = /filesyncEX\s+REG_SZ\s+(.+)/.exec(out);
        const value = m?.[1]?.trim().replace(/^"|"$/g, "");
        enabled = !!value && value === process.execPath; // 值必须是当前 exe 才视为已开启
      }
    } catch {
      enabled = false; // 读取异常 → 未开启
    }
    res.json({ ok: true, enabled, exe: process.execPath });
  });

  /** 关闭服务器（优雅关闭并退出进程） */
  app.post("/api/sys/shutdown", (req, res) => {
    console.log(`[sys] 关闭服务器（来自 ${req.ip}）`);
    res.json({ ok: true });
    setTimeout(() => { void systemOps?.shutdown(); }, 300); // 先回响应再关闭
  });

  /** 重置服务器：清空全部聊天记录/文件并软重启 */
  app.post("/api/sys/reset", (req, res) => {
    console.log(`[sys] 重置服务器（清空全部数据并重启，来自 ${req.ip}）`);
    res.json({ ok: true });
    setTimeout(() => { void systemOps?.reset(); }, 300); // 先回响应再执行
  });

  /** 打包当前所有数据（消息数据库一致快照 + uploads 全部文件）为 zip，以日期命名下载 */
  app.get("/api/data/export", (req, res) => {
    void (async () => {
    try {
      const files: ZipEntry[] = [];
      // 数据库一致快照（WAL → backup；memory 存储无 db）
      if (backupDb) {
        const tmp = path.join(cfg.dataDir, `.export-${Date.now()}.db`);
        try {
          await backupDb(tmp);
          if (fs.existsSync(tmp)) {
            files.push({ path: "filesync.db", data: fs.readFileSync(tmp) });
            fs.rmSync(tmp, { force: true });
          }
        } catch (e) {
          fs.rmSync(tmp, { force: true });
          console.warn("[export] 数据库备份失败:", (e as Error).message);
        }
      }
      // uploads 全部文件（递归）
      const uploadDir = cfg.uploadDir;
      if (uploadDir && fs.existsSync(uploadDir)) {
        const walk = (dir: string, prefix: string): void => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full, prefix + e.name + "/");
            else if (e.isFile()) files.push({ path: prefix + e.name, data: fs.readFileSync(full) });
          }
        };
        walk(uploadDir, "uploads/");
      }
      const d = new Date();
      const p2 = (n: number): string => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
      const name = `filesyncEX-backup-${stamp}.zip`;
      const buf = makeZip(files);
      console.log(`[export] 数据导出：${files.length} 个文件，${buf.length} 字节 → ${name}（来自 ${req.ip}）`);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
      res.send(buf);
    } catch (e) {
      console.warn("[export] 导出失败:", (e as Error).message);
      res.status(500).json({ error: "导出失败: " + String((e as Error).message) });
    }
    })();
  });

  /** 下载服务器本体（当前运行的 exe）；开发模式返回失败 */
  app.get("/api/app/download", (req, res) => {
    if (!isPackaged()) return res.status(400).json({ error: "开发模式没有打包产物（当前由 node 运行）" });
    const exe = process.execPath;
    if (!fs.existsSync(exe)) return res.status(404).json({ error: "打包产物不存在" });
    console.log(`[sys] 下载服务器本体：${path.basename(exe)}（来自 ${req.ip}）`);
    res.download(exe, path.basename(exe));
  });

  /* 音频转码流：任意受支持格式 → 16-bit PCM WAV 流（浏览器原生可播，统一播放源）。
     支持 Range 请求（audio 拖动 seek 需要）；解码结果缓存，只解码一次。 */
  app.get("/api/stream/:key", async (req, res) => {
    const key = String(req.params.key);
    let wav = streamCacheGet(key);
    if (!wav) {
      const p = uploads.filePath(key);
      if (!p) return res.status(404).json({ error: "文件不存在" });
      const decoded = await decodeToChannels(p);
      if (!decoded?.channelData?.length) return res.status(415).json({ error: "不支持的音频格式" });
      wav = toWavBuffer(decoded);
      streamCacheSet(key, wav);
    }
    const total = wav.length;
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Accept-Ranges", "bytes");
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? parseInt(m[2], 10) : total - 1;
        if (start < total && end >= start) {
          const chunk = wav.subarray(start, Math.min(end + 1, total));
          res.status(206);
          res.setHeader("Content-Range", `bytes ${start}-${start + chunk.length - 1}/${total}`);
          res.setHeader("Content-Length", chunk.length);
          return res.send(chunk);
        }
      }
      res.status(416);
      res.setHeader("Content-Range", `bytes */${total}`);
      return res.end();
    }
    res.setHeader("Content-Length", total);
    res.send(wav);
  });

  /* 静态资源：构建后的前端（pkg 打包时目录由 shell 注入） */
  const webDir = cfg.webDir;
  if (fs.existsSync(path.join(webDir, "index.html"))) {
    // 缓存策略：Vite 带 hash 的构建资产（/assets/*）内容寻址 → 永久缓存（immutable）；
    // 入口 index.html 与 favicon/字体等不带 hash → no-cache 每次重新校验，避免陈旧入口引用旧 hash 资源
    app.use(express.static(webDir, {
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    }));
    app.get("*", (_req, res) => res.setHeader("Cache-Control", "no-cache").sendFile(path.join(webDir, "index.html")));
  } else {
    app.get("/", (_req, res) => res.type("text/plain; charset=utf-8").send("filesyncEX 服务运行中（前端未构建，请先构建 packages/web）"));
  }

  return app;
}
