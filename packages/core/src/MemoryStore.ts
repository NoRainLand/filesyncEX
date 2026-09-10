import type { FileMetaT, MsgDataT } from "@filesyncex/protocol";
import { nameSizeKey, type Store, type UploadSession } from "./Store.js";

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
  /** name + size → 文件（秒传快速判定，见 Store.getFileByNameSize） */
  private byNameSize = new Map<string, FileMetaT>();
  private fileRefs = new Map<string, number>();
  /** 文件 key → 引用它的消息 id 集合（decrFileRef 幂等依据） */
  private fileRefMsgs = new Map<string, Set<string>>();

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
  async clearAll(): Promise<void> {
    this.msgs.clear();
    this.uploads.clear();
    this.chunks.clear();
    this.files.clear();
    this.bySha.clear();
    this.fileRefs.clear();
    this.fileRefMsgs.clear();
  }

  async createUpload(s: UploadSession): Promise<void> {
    this.uploads.set(s.uploadId, s);
    this.chunks.set(s.uploadId, new Set());
  }
  async getUpload(uploadId: string): Promise<UploadSession | undefined> {
    return this.uploads.get(uploadId);
  }
  async listUploads(): Promise<UploadSession[]> {
    return [...this.uploads.values()];
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

  /** 登记物理文件元数据（不涉及引用计数）；已存在返回 false */
  async createFile(key: string, meta: FileMetaT): Promise<boolean> {
    if (this.files.has(key)) return false;
    this.files.set(key, meta);
    this.fileRefs.set(key, 0);
    if (meta.sha256) this.bySha.set(meta.sha256, meta);
    this.byNameSize.set(nameSizeKey(meta.name, meta.size ?? 0, meta.fp), meta);
    return true;
  }
  async getFileBySha(sha: string): Promise<FileMetaT | undefined> {
    return this.bySha.get(sha);
  }
  /** 按「文件名 + 大小 + 特征值」找已有文件（与 SqliteStore.getFileByNameSize 语义一致） */
  async getFileByNameSize(name: string, size: number, fp?: string): Promise<FileMetaT | undefined> {
    return this.byNameSize.get(nameSizeKey(name, size, fp));
  }
  async getFile(key: string): Promise<FileMetaT | undefined> {
    return this.files.get(key);
  }
  /** 登记「消息 msgId 引用了文件 key」；同一消息重复登记幂等（语义与 SqliteStore 一致） */
  async addFileRef(key: string, msgId: string): Promise<void> {
    const refsForFile = this.fileRefMsgs.get(key) ?? new Set<string>();
    if (refsForFile.has(msgId)) return;
    refsForFile.add(msgId);
    this.fileRefMsgs.set(key, refsForFile);
    this.fileRefs.set(key, (this.fileRefs.get(key) ?? 0) + 1);
  }
  async decrFileRef(key: string, msgId?: string): Promise<number> {
    const refsForFile = this.fileRefMsgs.get(key);
    const target = msgId ?? [...(refsForFile ?? [])][0];
    if (refsForFile && target && refsForFile.delete(target)) {
      this.fileRefs.set(key, Math.max(0, (this.fileRefs.get(key) ?? 0) - 1));
    }
    return this.fileRefs.get(key) ?? 0;
  }
  async removeFile(key: string): Promise<void> {
    const meta = this.files.get(key);
    if (meta?.sha256) this.bySha.delete(meta.sha256);
    if (meta) this.byNameSize.delete(nameSizeKey(meta.name, meta.size ?? 0, meta.fp));
    this.files.delete(key);
    this.fileRefs.delete(key);
    this.fileRefMsgs.delete(key);
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
