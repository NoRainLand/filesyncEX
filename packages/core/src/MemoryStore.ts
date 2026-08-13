import type { FileMetaT, MsgDataT } from "@filesyncex/protocol";
import type { Store, UploadSession } from "./Store.js";

/**
 * 内存版 Store：跑通业务与测试用。
 * 生产默认用 SqliteStore（better-sqlite3）；两者都实现同一 Store 接口。
 */
export class MemoryStore implements Store {
  private msgs = new Map<string, MsgDataT>();
  private uploads = new Map<string, UploadSession>();
  private chunks = new Map<string, Set<number>>();
  private files = new Map<string, FileMetaT>();
  private bySha = new Map<string, FileMetaT>();
  private fileRefs = new Map<string, number>();

  async init(): Promise<void> {}

  async saveMessage(msg: MsgDataT): Promise<void> {
    this.msgs.set(msg.id, msg);
  }
  async listMessages(limit = 500): Promise<MsgDataT[]> {
    const arr = [...this.msgs.values()].sort((a, b) => a.ts - b.ts);
    return arr.slice(-limit);
  }
  async getMessage(id: string): Promise<MsgDataT | undefined> {
    return this.msgs.get(id);
  }
  async updateMessage(id: string, msg: MsgDataT): Promise<void> {
    this.msgs.set(id, msg);
  }
  async removeMessage(id: string): Promise<void> {
    this.msgs.delete(id);
  }

  async createUpload(s: UploadSession): Promise<void> {
    this.uploads.set(s.uploadId, s);
    this.chunks.set(s.uploadId, new Set());
  }
  async getUpload(uploadId: string): Promise<UploadSession | undefined> {
    return this.uploads.get(uploadId);
  }
  async addUploadChunk(uploadId: string, index: number): Promise<void> {
    this.chunks.get(uploadId)?.add(index);
  }
  async listUploadChunks(uploadId: string): Promise<number[]> {
    return [...(this.chunks.get(uploadId) ?? [])].sort((a, b) => a - b);
  }
  async removeUpload(uploadId: string): Promise<void> {
    this.uploads.delete(uploadId);
    this.chunks.delete(uploadId);
  }

  async saveFile(key: string, meta: FileMetaT): Promise<void> {
    this.files.set(key, meta);
    this.fileRefs.set(key, 1); // 新文件首次引用 = 1
    if (meta.sha256) this.bySha.set(meta.sha256, meta);
  }
  async getFileBySha(sha: string): Promise<FileMetaT | undefined> {
    return this.bySha.get(sha);
  }
  async getFile(key: string): Promise<FileMetaT | undefined> {
    return this.files.get(key);
  }
  async incrFileRef(key: string): Promise<void> {
    this.fileRefs.set(key, (this.fileRefs.get(key) ?? 0) + 1);
  }
  async decrFileRef(key: string): Promise<number> {
    const n = (this.fileRefs.get(key) ?? 0) - 1;
    this.fileRefs.set(key, Math.max(0, n));
    return Math.max(0, n);
  }
  async removeFile(key: string): Promise<void> {
    const meta = this.files.get(key);
    if (meta?.sha256) this.bySha.delete(meta.sha256);
    this.files.delete(key);
    this.fileRefs.delete(key);
  }

  async close(): Promise<void> {
    this.msgs.clear();
    this.uploads.clear();
    this.chunks.clear();
    this.files.clear();
    this.bySha.clear();
    this.fileRefs.clear();
  }
}
