import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { SyncEngine, type Store } from "@filesyncex/core";
import { parse, UploadInitReq, UploadInitRes, UploadChunkRes, UploadCompleteRes } from "@filesyncex/protocol";

/** 小于该大小（字节）的文件走「直接上传」，跳过整文件 SHA-256 与分片（小文件哈希/分片开销大于收益） */
export const DIRECT_LIMIT = 8 * 1024 * 1024; // 8 MiB
/** 分片会话超过该时长未被 complete 视为废弃（客户端可续传窗口的上限，超过即回收磁盘） */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
/** 未被任何消息引用的封面图超过该时长视为孤儿，清理物理文件 */
const COVER_TTL_MS = 24 * 60 * 60 * 1000;

export interface UploadServiceOptions {
  store: Store;
  engine: SyncEngine;
  uploadDir: string;
  chunkSize?: number;
}

/** 比较两个 sha256 十六进制串（恒定时间，长度不等直接 false） */
function shaEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a.toLowerCase(), "utf8");
  const bb = Buffer.from(b.toLowerCase(), "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * 分片/断点续传上传服务。
 * 分片二进制落盘 data/uploads/<uploadId>/<index>.part；
 * complete 时按序组装为最终文件 → Store.createFile 建索引 + addFileRef 登记引用 → 引擎广播一条文件消息。
 * 磁盘卫生：启动时 + 每 6h 回收废弃分片会话目录与无人引用的孤儿封面图。
 */
export class UploadService {
  private store: Store;
  private engine: SyncEngine;
  private uploadDir: string;
  chunkSize: number;
  /** 物理文件 key → 最后一次被引用/保护的时刻（孤儿清理依据：未进索引又超时的封面才会删） */
  private touched = new Map<string, number>();
  /** uploadId → 关联的封面 key（内存表；服务器重启后客户端断点续传会重新携带 coverKey） */
  private sessionCovers = new Map<string, string>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

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
    // 引用计数在 addMessage 之后登记（addFileRef）：已存在的 key 只 +1，不覆盖首份元数据、不重写物理文件
    if (req.sha256) {
      const existing = await this.store.getFileBySha(req.sha256);
      if (existing && existing.key) {
        // 同内容不同名：消息名用用户本次上传的名字，key/url/sha256/size 沿用旧文件
        const meta = { ...existing, name: req.name, mime: req.mime || existing.mime };
        const msg = this.fileMessage(req.device, meta, randomUUID());
        await this.engine.addMessage(msg);
        await this.store.addFileRef(existing.key, msg.id);
        return { ok: true, res: { uploadId, chunkSize: this.chunkSize, chunkCount, done: [], existed: true, file: existing, msg } as import("@filesyncex/protocol").UploadInitResT };
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
    if (req.coverKey) this.setSessionCover(uploadId, req.coverKey);
    fs.mkdirSync(this.sessionDir(uploadId), { recursive: true });
    const done = await this.store.listUploadChunks(uploadId);
    const res = UploadInitRes.parse({ uploadId, chunkSize: this.chunkSize, chunkCount, done, existed: false });
    return { ok: true, res };
  }

  /** 保存一个分片（异步写盘，单片 ≤ 1MiB 不阻塞事件循环） */
  async chunk(uploadId: string, index: number, buf: Buffer): Promise<{ ok: true; res: UploadChunkRes } | { ok: false; error: string }> {
    const s = await this.store.getUpload(uploadId);
    if (!s) return { ok: false, error: "上传会话不存在" };
    if (index < 0 || index >= s.chunkCount) return { ok: false, error: "分片下标越界" };
    fs.mkdirSync(this.sessionDir(uploadId), { recursive: true });
    await fs.promises.writeFile(path.join(this.sessionDir(uploadId), index + ".part"), buf);
    await this.store.addUploadChunk(uploadId, index);
    return { ok: true, res: { ok: true, index } };
  }

  /** 组装分片为最终文件并广播文件消息（流式：边读分片边写盘 + 流式 SHA-256，大文件不整块入内存） */
  async complete(uploadId: string): Promise<{ ok: true; res: UploadCompleteRes } | { ok: false; error: string }> {
    const s = await this.store.getUpload(uploadId);
    if (!s) return { ok: false, error: "上传会话不存在" };
    const dir = this.sessionDir(uploadId);
    const safeName = (s.name || "unnamed").replace(/[\\\/:*?"<>|]/g, "_");
    const tmpPath = path.join(this.uploadDir, ".tmp-" + uploadId);
    const sha = createHash("sha256");
    try {
      // 组装阶段先算摘要（final key 需要），故先写临时文件、算完摘要再改名
      const out = fs.createWriteStream(tmpPath);
      try {
        for (let i = 0; i < s.chunkCount; i++) {
          const p = path.join(dir, i + ".part");
          if (!fs.existsSync(p)) {
            throw new Error("缺少分片 " + i);
          }
          const data = await fs.promises.readFile(p);
          sha.update(data);
          // 背压：await 写回调（drain 后才会回调），磁盘慢于读时不会把整文件堆在内存
          await new Promise<void>((res, rej) => {
            out.write(data, (e) => (e ? rej(e) : res()));
          });
        }
      } finally {
        await new Promise<void>((res) => {
          out.end(() => res());
        });
      }
      const digest = sha.digest("hex");
      // 客户端声明的 sha256 与实际内容比对：不一致说明客户端哈希算法/数据有问题，
      // 若不拒绝，其 localStorage 断点续传 key（fsex_upload_<sha>）会永久对不上，同一文件每次都要重传全文
      if (s.sha256 && !shaEquals(s.sha256, digest)) {
        fs.rmSync(tmpPath, { force: true });
        return { ok: false, error: `文件校验失败：实际 sha256 与 init 声明不一致（声明 ${s.sha256.slice(0, 12)}… 实际 ${digest.slice(0, 12)}…），请重新上传` };
      }
      const key = digest.slice(0, 12) + "_" + safeName;
      const finalPath = path.join(this.uploadDir, key);
      const alreadyOnDisk = fs.existsSync(finalPath);
      if (alreadyOnDisk) fs.rmSync(tmpPath, { force: true }); // 同内容同名的物理文件已存在，保留原文件
      else fs.renameSync(tmpPath, finalPath);
      // 清理分片临时目录与会话
      fs.rmSync(dir, { recursive: true, force: true });
      await this.store.removeUpload(uploadId);

      const meta = {
        name: s.name,
        size: s.size,
        mime: s.mime,
        sha256: digest,
        key,
        url: "/api/file/" + encodeURIComponent(key),
        cover: undefined as string | undefined,
      };
      const coverKey = this.coverKeyOf(uploadId);
      if (coverKey) {
        meta.cover = "/api/file/" + encodeURIComponent(coverKey);
        this.touched.set(coverKey, Date.now());
      }
      const sender = s.device ?? this.engine.self;
      if (!sender) return { ok: true, res: { ok: true, msg: undefined } };
      await this.store.createFile(key, meta); // 建文件索引（已存在则保留首份元数据）
      const msg = this.fileMessage(sender, meta, randomUUID());
      await this.engine.addMessage(msg);
      await this.store.addFileRef(key, msg.id); // 登记「该消息引用此文件」
      if (coverKey) await this.registerCover(coverKey, msg.id);
      return { ok: true, res: { ok: true, msg } };
    } catch (e) {
      fs.rmSync(tmpPath, { force: true });
      return { ok: false, error: "组装失败: " + String((e as Error).message) };
    }
  }

  /**
   * 把封面图登记进文件索引（标记「被 msgId 这条消息引用」）。
   * 登记后：①磁盘卫生清理能识别它非孤儿；②删除消息时走统一引用计数回收物理文件。
   */
  async registerCover(coverKey: string, msgId: string): Promise<void> {
    const p = this.filePath(coverKey);
    const size = p ? (await fs.promises.stat(p)).size : 0;
    this.touched.set(coverKey, Date.now());
    await this.store.createFile(coverKey, { name: coverKey, size, mime: "image/jpeg", key: coverKey, url: "/api/file/" + encodeURIComponent(coverKey) });
    await this.store.addFileRef(coverKey, msgId);
  }

  /** 保存视频封面图（jpeg），返回 coverKey（文件存 uploadDir/<key>_cover.jpg，/api/file/<key> 可下载） */
  async saveCover(buf: Buffer): Promise<{ ok: true; coverKey: string } | { ok: false; error: string }> {
    if (!buf || buf.length === 0) return { ok: false, error: "空封面数据" };
    const coverKey = randomUUID().slice(0, 8) + "_cover.jpg";
    await fs.promises.writeFile(path.join(this.uploadDir, coverKey), buf);
    this.touched.set(coverKey, Date.now());
    return { ok: true, coverKey };
  }

  /** 小文件直接上传：整块落盘并广播（前端保证 ≤ DIRECT_LIMIT，跳过哈希/分片） */
  async direct(name: string, size: number, mime: string | undefined, device: import("@filesyncex/protocol").DeviceInfoT | undefined, data: Buffer, coverKey?: string): Promise<{ ok: true; res: UploadCompleteRes } | { ok: false; error: string }> {
    if (size > DIRECT_LIMIT) return { ok: false, error: "文件过大，请用分片上传" };
    if (data.length !== size) return { ok: false, error: `文件大小不符：声明 ${size} 字节，实际 ${data.length} 字节` };
    return this.finalize(name, size, mime, device, data, coverKey);
  }

  /** 落盘最终文件 + 建索引 + 广播文件消息（小文件 direct 路径；分片路径由 complete 自行组装） */
  private async finalize(name: string, size: number, mime: string | undefined, device: import("@filesyncex/protocol").DeviceInfoT | undefined, data: Buffer, coverKey?: string): Promise<{ ok: true; res: UploadCompleteRes }> {
    const sha = createHash("sha256").update(data).digest("hex");
    // 落盘到 uploads/<sha>_<name>（key 即文件名）
    const safeName = (name || "unnamed").replace(/[\\/:*?"<>|]/g, "_");
    const key = sha.slice(0, 12) + "_" + safeName;
    const finalPath = path.join(this.uploadDir, key);
    // 同内容同名文件可能已存在（重复上传）：保留原文件，引用计数由 addFileRef 登记
    if (!fs.existsSync(finalPath)) await fs.promises.writeFile(finalPath, data);

    const meta = {
      name,
      size,
      mime,
      sha256: sha,
      key,
      url: "/api/file/" + encodeURIComponent(key),
      cover: undefined as string | undefined,
    };
    if (coverKey) {
      meta.cover = "/api/file/" + encodeURIComponent(coverKey);
      this.touched.set(coverKey, Date.now());
    }

    // 广播文件消息（发送者 = 上传者设备，或引擎默认设备）
    const sender = device ?? this.engine.self;
    if (!sender) return { ok: true, res: { ok: true, msg: undefined } };
    await this.store.createFile(key, meta); // 建文件索引（已存在则保留首份元数据）
    const msg = this.fileMessage(sender, meta, randomUUID());
    await this.engine.addMessage(msg);
    await this.store.addFileRef(key, msg.id); // 登记「该消息引用此文件」——与消息一一对应，删消息不会误删共享文件
    if (coverKey) await this.registerCover(coverKey, msg.id);
    return { ok: true, res: { ok: true, msg } };
  }

  /** 构造文件类消息（发送者 = 上传者设备；id 由调用方给定并用于引用计数登记） */
  private fileMessage(device: import("@filesyncex/protocol").DeviceInfoT, meta: import("@filesyncex/protocol").FileMetaT, id: string): import("@filesyncex/protocol").MsgDataT {
    return {
      id,
      kind: this.kindOf(meta.mime, meta.name),
      sender: device,
      ts: Date.now(),
      file: meta,
    };
  }

  private setSessionCover(uploadId: string, coverKey: string): void {
    this.touched.set(coverKey, Date.now()); // 正在上传的封面受保护，不会被 sweep 当孤儿删除
    this.touched.set("pending:" + coverKey, Date.now());
    this.sessionCovers.set(uploadId, coverKey);
  }

  /** 取（并忘记）某上传会话关联的封面 key */
  private coverKeyOf(uploadId: string): string | undefined {
    const key = this.sessionCovers.get(uploadId);
    if (key) this.sessionCovers.delete(uploadId);
    return key;
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

  /** 下载显示名：优先 Store 索引里的原始文件名（meta.name，未清洗原名）；封面等未索引文件回退 key 本身 */
  async displayName(key: string): Promise<string> {
    const meta = await this.store.getFile(key);
    return meta?.name || key;
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
    this.touched.delete(key);
  }

  /* ---------------- 磁盘卫生 ---------------- */

  /** 启动时清理一次 + 每 6h 定时清理（引擎关闭时由 close 停止） */
  startSweeper(): void {
    void this.sweep();
    this.sweepTimer = setInterval(() => void this.sweep(), 6 * 60 * 60 * 1000);
    this.sweepTimer.unref?.();
  }

  stopSweeper(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * 回收磁盘垃圾：
   *  1. 超过 TTL 未完成的分片会话目录（客户端中断后再也不续传的）→ 删目录 + 删会话记录；
   *  2. 无对应会话的孤儿分片目录；
   *  3. 组装中断留下的 .tmp-* 临时文件；
   *  4. 未被任何消息引用的孤儿封面图（超过 TTL）。
   */
  async sweep(now = Date.now()): Promise<void> {
    try {
      const sessions = await this.store.listUploads();
      const known = new Set(sessions.map((s) => s.uploadId));
      const referenced = new Set<string>();
      const msgs = await this.store.listMessages(1_000_000);
      for (const m of msgs) {
        const cover = m.file?.cover;
        const mk = cover ? /\/api\/file\/([^/]+)$/.exec(cover) : null;
        if (mk?.[1]) {
          try {
            referenced.add(decodeURIComponent(mk[1]));
          } catch {
            /* 解码失败忽略 */
          }
        }
        if (m.file?.key) referenced.add(m.file.key);
      }
      for (const dir of await fs.promises.readdir(this.uploadDir, { withFileTypes: true })) {
        const full = path.join(this.uploadDir, dir.name);
        if (dir.isDirectory()) {
          const s = sessions.find((x) => x.uploadId === dir.name);
          const stale = s ? now - s.createdAt > SESSION_TTL_MS : !known.has(dir.name);
          if (stale) {
            await fs.promises.rm(full, { recursive: true, force: true });
            if (s) await this.store.removeUpload(s.uploadId);
            console.log(`[upload] 清理废弃上传会话 ${dir.name}（${s ? "超过 TTL" : "无会话记录"}）`);
          }
          continue;
        }
        if (!dir.isFile()) continue;
        // 组装中断的临时文件
        if (dir.name.startsWith(".tmp-")) {
          const st = await fs.promises.stat(full).catch(() => null);
          if (st && now - st.mtimeMs > SESSION_TTL_MS) await fs.promises.rm(full, { force: true });
          continue;
        }
        // 孤儿封面：未被任何消息引用且超过 TTL（上传中但未完成的由 touched 保护）
        if (dir.name.endsWith("_cover.jpg") && !referenced.has(dir.name)) {
          const touched = this.touched.get(dir.name) ?? 0;
          const st = await fs.promises.stat(full).catch(() => null);
          const since = Math.max(touched, st?.mtimeMs ?? 0);
          if (now - since > COVER_TTL_MS) {
            await fs.promises.rm(full, { force: true });
            this.touched.delete(dir.name);
            console.log(`[upload] 清理孤儿封面 ${dir.name}`);
          }
          continue;
        }
        // 历史裁剪后遗留的孤儿附件：文件索引里已无该 key，且早于 TTL
        if (!referenced.has(dir.name) && !(await this.store.getFile(dir.name))) {
          const st = await fs.promises.stat(full).catch(() => null);
          if (st && now - st.mtimeMs > COVER_TTL_MS) {
            await fs.promises.rm(full, { force: true });
            console.log(`[upload] 清理孤儿附件 ${dir.name}`);
          }
        }
      }
    } catch (e) {
      console.warn("[upload] 磁盘清理失败:", (e as Error).message);
    }
  }
}
