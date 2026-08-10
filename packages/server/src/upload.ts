import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { SyncEngine, type Store } from "@filesyncex/core";
import { parse, UploadInitReq, UploadInitRes, UploadChunkRes, UploadCompleteRes } from "@filesyncex/protocol";

/** 小于该大小（字节）的文件走「直接上传」，跳过整文件 SHA-256 与分片（小文件哈希/分片开销大于收益） */
export const DIRECT_LIMIT = 8 * 1024 * 1024; // 8 MiB

export interface UploadServiceOptions {
  store: Store;
  engine: SyncEngine;
  uploadDir: string;
  chunkSize?: number;
}

/**
 * 分片/断点续传上传服务。
 * 分片二进制落盘 data/uploads/<uploadId>/<index>.part；
 * complete 时按序组装为最终文件 → Store.saveFile 建索引 → 引擎广播一条文件消息。
 */
export class UploadService {
  private store: Store;
  private engine: SyncEngine;
  private uploadDir: string;
  chunkSize: number;

  constructor(opts: UploadServiceOptions) {
    this.store = opts.store;
    this.engine = opts.engine;
    this.uploadDir = opts.uploadDir;
    this.chunkSize = opts.chunkSize ?? 1024 * 1024; // 1 MiB
    fs.mkdirSync(this.uploadDir, { recursive: true });
  }

  private sessionDir(uploadId: string): string {
    return path.join(this.uploadDir, uploadId);
  }

  /** 初始化上传：返回分片大小/数量/已完成分片；sha256 命中则秒传 */
  async init(body: unknown): Promise<{ ok: true; res: import("@filesyncex/protocol").UploadInitResT } | { ok: false; error: string }> {
    let req;
    try {
      req = parse(UploadInitReq, body);
    } catch (e) {
      return { ok: false, error: "参数不合法: " + String((e as Error).message) };
    }
    // 断点续传：客户端携带上次 uploadId 且 name/size 匹配 → 复用会话，返回已传分片
    if (req.uploadId) {
      const prev = await this.store.getUpload(req.uploadId);
      if (prev && prev.name === req.name && prev.size === req.size) {
        const done = await this.store.listUploadChunks(prev.uploadId);
        return {
          ok: true,
          res: { uploadId: prev.uploadId, chunkSize: this.chunkSize, chunkCount: prev.chunkCount, done, existed: false } as import("@filesyncex/protocol").UploadInitResT,
        };
      }
    }

    const chunkCount = Math.max(1, Math.ceil(req.size / this.chunkSize));
    const uploadId = randomUUID();

    // 秒传：按 sha256 命中已有文件 → 用「新上传的名字」构造一条新消息（文件内容指向旧文件），广播后返回
    if (req.sha256) {
      const existing = await this.store.getFileBySha(req.sha256);
      if (existing && existing.key) {
        // 同内容不同名：消息名用用户本次上传的名字，key/url/sha256/size 沿用旧文件
        const meta = { ...existing, name: req.name, mime: req.mime || existing.mime };
        const msg = await this.fileMessage(req.device, meta);
        if (msg) {
          await this.store.incrFileRef(existing.key); // 新增一条消息引用该文件
          await this.engine.addMessage(msg);
        }
        return { ok: true, res: { uploadId, chunkSize: this.chunkSize, chunkCount, done: [], existed: true, file: existing, ...(msg ? { msg } : {}) } as import("@filesyncex/protocol").UploadInitResT };
      }
    }

    await this.store.createUpload({
      uploadId,
      name: req.name,
      size: req.size,
      mime: req.mime,
      sha256: req.sha256,
      chunkSize: this.chunkSize,
      chunkCount,
      createdAt: Date.now(),
      device: req.device,
    });
    fs.mkdirSync(this.sessionDir(uploadId), { recursive: true });
    const done = await this.store.listUploadChunks(uploadId);
    const res = UploadInitRes.parse({ uploadId, chunkSize: this.chunkSize, chunkCount, done, existed: false });
    return { ok: true, res };
  }

  /** 保存一个分片 */
  async chunk(uploadId: string, index: number, buf: Buffer): Promise<{ ok: true; res: UploadChunkRes } | { ok: false; error: string }> {
    const s = await this.store.getUpload(uploadId);
    if (!s) return { ok: false, error: "上传会话不存在" };
    if (index < 0 || index >= s.chunkCount) return { ok: false, error: "分片下标越界" };
    fs.mkdirSync(this.sessionDir(uploadId), { recursive: true });
    fs.writeFileSync(path.join(this.sessionDir(uploadId), index + ".part"), buf);
    await this.store.addUploadChunk(uploadId, index);
    return { ok: true, res: { ok: true, index } };
  }

  /** 组装分片为最终文件并广播文件消息 */
  async complete(uploadId: string): Promise<{ ok: true; res: UploadCompleteRes } | { ok: false; error: string }> {
    const s = await this.store.getUpload(uploadId);
    if (!s) return { ok: false, error: "上传会话不存在" };
    const dir = this.sessionDir(uploadId);
    const parts: Buffer[] = [];
    for (let i = 0; i < s.chunkCount; i++) {
      const p = path.join(dir, i + ".part");
      if (!fs.existsSync(p)) return { ok: false, error: "缺少分片 " + i };
      parts.push(fs.readFileSync(p));
    }
    const data = Buffer.concat(parts);
    // 清理分片临时目录与会话
    fs.rmSync(dir, { recursive: true, force: true });
    await this.store.removeUpload(uploadId);
    return this.finalize(s.name, s.size, s.mime, s.device, data);
  }

  /** 小文件直接上传：整块落盘并广播（前端保证 ≤ DIRECT_LIMIT，跳过哈希/分片） */
  async direct(name: string, size: number, mime: string | undefined, device: import("@filesyncex/protocol").DeviceInfoT | undefined, data: Buffer): Promise<{ ok: true; res: UploadCompleteRes } | { ok: false; error: string }> {
    if (size > DIRECT_LIMIT) return { ok: false, error: "文件过大，请用分片上传" };
    return this.finalize(name, size, mime, device, data);
  }

  /** 落盘最终文件 + 建索引 + 广播文件消息（分片 complete 与小文件 direct 共用） */
  private async finalize(name: string, size: number, mime: string | undefined, device: import("@filesyncex/protocol").DeviceInfoT | undefined, data: Buffer): Promise<{ ok: true; res: UploadCompleteRes }> {
    const sha = createHash("sha256").update(data).digest("hex");
    // 落盘到 uploads/<sha>_<name>（key 即文件名）
    const safeName = (name || "unnamed").replace(/[\\/:*?"<>|]/g, "_");
    const key = sha.slice(0, 12) + "_" + safeName;
    fs.writeFileSync(path.join(this.uploadDir, key), data);

    const meta = {
      name,
      size,
      mime,
      sha256: sha,
      key,
      url: "/api/file/" + encodeURIComponent(key),
    };
    await this.store.saveFile(key, meta);

    // 广播文件消息（发送者 = 上传者设备，或引擎默认设备）
    const sender = device ?? this.engine.self;
    const msg = sender ? await this.fileMessage(sender, meta) : undefined;
    if (msg) await this.engine.addMessage(msg);
    return { ok: true, res: { ok: true, msg } };
  }

  /** 构造文件类消息（发送者 = 上传者设备） */
  private async fileMessage(device: import("@filesyncex/protocol").DeviceInfoT, meta: import("@filesyncex/protocol").FileMetaT): Promise<import("@filesyncex/protocol").MsgDataT> {
    return {
      id: randomUUID(),
      kind: this.kindOf(meta.mime, meta.name),
      sender: device,
      ts: Date.now(),
      file: meta,
    };
  }

  private kindOf(mime: string | undefined, name: string): "image" | "audio" | "video" | "file" {
    if (mime) {
      if (mime.startsWith("image/")) return "image";
      if (mime.startsWith("audio/")) return "audio";
      if (mime.startsWith("video/")) return "video";
    }
    const ext = name.split(".").pop()?.toLowerCase();
    if (ext && ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].includes(ext)) return "image";
    if (ext && ["mp3", "wav", "ogg", "m4a", "flac", "aac"].includes(ext)) return "audio";
    if (ext && ["mp4", "webm", "mov", "mkv", "avi"].includes(ext)) return "video";
    return "file";
  }

  /** 供下载：返回最终文件绝对路径（key 白名单校验，防路径穿越） */
  filePath(key: string): string | null {
    const decoded = decodeURIComponent(key);
    const target = path.resolve(this.uploadDir, path.basename(decoded));
    const base = path.resolve(this.uploadDir);
    if (!target.startsWith(base + path.sep)) return null;
    return fs.existsSync(target) ? target : null;
  }

  /** 物理删除文件（引用计数归零时调用）；key 白名单校验 */
  deleteFile(key: string): void {
    const p = this.filePath(key);
    if (p) {
      try {
        fs.unlinkSync(p);
      } catch (e) {
        console.warn("[upload] 删除文件失败:", (e as Error).message);
      }
    }
  }
}
