import express from "express";
import fs from "node:fs";
import path from "node:path";
import type { ServerConfig } from "./config.js";
import type { UploadService } from "./upload.js";
import { SyncEngine } from "@filesyncex/core";
import { lanAddress } from "./net.js";
import { decodeToChannels, toWavBuffer } from "./wave.js";

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
export function createHttpApp(cfg: ServerConfig, engine: SyncEngine, uploads: UploadService): express.Express {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  // 文件引用计数归零 → 删除物理文件（订阅引擎事件）
  engine.events.on("file-gc", ({ key }) => uploads.deleteFile(key));

  /* 健康检查（返回本机局域网 IP + 实际 HTTP 端口，供前端二维码/地址使用真实地址；端口自动切换时取实际监听端口） */
  app.get("/api/health", (req, res) => res.json({ ok: true, name: "filesyncEX", version: "6.0.0-beta2", lanIp: lanAddress(), port: req.socket.localPort ?? cfg.httpPort }));

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
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? []);
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
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? []);
      const r = await uploads.saveCover(buf);
      if (!r.ok) return res.status(400).json({ error: r.error });
      res.json({ coverKey: r.coverKey });
    }
  );

  /* 上传：小文件直接上传（body 为整个文件，query 携带 name/mime/device；≤ DIRECT_LIMIT 跳过哈希/分片） */
  app.post(
    "/api/upload/direct",
    express.raw({ type: ["application/octet-stream", "*/*"], limit: "64mb" }),
    async (req, res) => {
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? []);
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

  /* 下载 */
  app.get("/api/file/:key", (req, res) => {
    const p = uploads.filePath(String(req.params.key));
    if (!p) return res.status(404).json({ error: "文件不存在" });
    res.download(p);
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
