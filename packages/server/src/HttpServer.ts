import express from "express";
import fs from "node:fs";
import path from "node:path";
import type { ServerConfig } from "./config.js";
import type { UploadService } from "./upload.js";
import { SyncEngine } from "@filesyncex/core";
import { lanAddress } from "./net.js";
import { wavePeaksFromFile, decodeToChannels, toWavBuffer } from "./wave.js";

/* 波形缓存：key → 峰值数组（只生成一次） */
const waveCache = new Map<string, number[]>();
/* 转码流缓存：key → WAV Buffer（只解码一次） */
const streamCache = new Map<string, Buffer>();

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

  /* 健康检查（返回本机局域网 IP + HTTP 端口，供前端二维码/地址使用真实地址） */
  app.get("/api/health", (_req, res) => res.json({ ok: true, name: "filesyncEX", version: "6.0.0-alpha1", lanIp: lanAddress(), port: cfg.httpPort }));

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
      const r = await uploads.direct(String(req.query.name ?? ""), buf.length, String(req.query.mime || "") || undefined, device, buf);
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

  /* 音频波形：解析文件生成峰值数组（WAV/MP3/FLAC/OGG/M4A） */
  app.get("/api/wave/:key", async (req, res) => {
    const key = String(req.params.key);
    if (waveCache.has(key)) return res.json({ peaks: waveCache.get(key) });
    const p = uploads.filePath(key);
    if (!p) return res.status(404).json({ error: "文件不存在" });
    const peaks = await wavePeaksFromFile(p);
    if (!peaks) return res.status(415).json({ error: "不支持的音频格式" });
    waveCache.set(key, peaks);
    res.json({ peaks });
  });

  /* 音频转码流：任意受支持格式 → 16-bit PCM WAV 流（浏览器原生可播，统一播放源）。
     支持 Range 请求（audio 拖动 seek 需要）；解码结果缓存，只解码一次。 */
  app.get("/api/stream/:key", async (req, res) => {
    const key = String(req.params.key);
    let wav = streamCache.get(key);
    if (!wav) {
      const p = uploads.filePath(key);
      if (!p) return res.status(404).json({ error: "文件不存在" });
      const decoded = await decodeToChannels(p);
      if (!decoded?.channelData?.length) return res.status(415).json({ error: "不支持的音频格式" });
      wav = toWavBuffer(decoded);
      streamCache.set(key, wav);
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
    app.use(express.static(webDir));
    app.get("*", (_req, res) => res.sendFile(path.join(webDir, "index.html")));
  } else {
    app.get("/", (_req, res) => res.type("text/plain; charset=utf-8").send("filesyncEX 服务运行中（前端未构建，请先构建 packages/web）"));
  }

  return app;
}
