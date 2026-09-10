import type { FileMetaT, MsgDataT } from "@filesyncex/protocol";

/** 上传会话（分片/断点续传元数据） */
export interface UploadSession {
  uploadId: string;
  name: string;
  size: number;
  mime?: string;
  sha256?: string;
  chunkSize: number;
  chunkCount: number;
  createdAt: number;
  /** 上传者设备身份（文件消息 sender） */
  device?: import("@filesyncex/protocol").DeviceInfoT;
}

/**
 * 存储抽象（Store 接口）。
 * 具体实现：SqliteStore（better-sqlite3，默认）/ MemoryStore（内存，测试/降级）。
 * server/core 只依赖此接口，不感知底层数据库，从而隔离原生模块在 pkg 打包时的差异。
 */
export interface Store {
  init(): Promise<void>;

  /* ----- 消息 ----- */
  saveMessage(msg: MsgDataT): Promise<void>;
  listMessages(limit?: number): Promise<MsgDataT[]>;
  getMessage(id: string): Promise<MsgDataT | undefined>;
  /** 更新已存在的消息（如补充视频封面） */
  updateMessage(id: string, msg: MsgDataT): Promise<void>;
  removeMessage(id: string): Promise<void>;
  /** 清空全部数据（消息/文件索引/上传会话；用于服务器重置） */
  clearAll(): Promise<void>;

  /* ----- 上传会话（断点续传） ----- */
  createUpload(s: UploadSession): Promise<void>;
  getUpload(uploadId: string): Promise<UploadSession | undefined>;
  /** 列出全部上传会话（磁盘卫生清理用：判断会话目录是否已废弃） */
  listUploads(): Promise<UploadSession[]>;
  addUploadChunk(uploadId: string, index: number): Promise<void>;
  listUploadChunks(uploadId: string): Promise<number[]>;
  removeUpload(uploadId: string): Promise<void>;

  /* ----- 文件索引（下载 / 秒传 / 引用计数） ----- */
  /**
   * 登记物理文件元数据（上传落盘后调用）。**不涉及引用计数**。
   * @returns true = 索引里原先没有这个 key（调用方刚写盘的是新文件）；false = 已存在（同内容同名的物理文件已就绪）
   */
  createFile(key: string, meta: FileMetaT): Promise<boolean>;
  getFileBySha(sha: string): Promise<FileMetaT | undefined>;
  getFile(key: string): Promise<FileMetaT | undefined>;
  /** 登记「消息 msgId 引用了文件 key」（refs+1）；同一 msgId 重复登记不重复计数 */
  addFileRef(key: string, msgId: string): Promise<void>;
  /** 文件引用 -1（并清掉该消息的引用记录），返回剩余引用数（0 = 可删除物理文件） */
  decrFileRef(key: string, msgId?: string): Promise<number>;
  /** 从文件索引删除（refs 归零后调用） */
  removeFile(key: string): Promise<void>;

  close(): Promise<void>;
}
