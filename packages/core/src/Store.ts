import type { FileMetaT, MsgDataT } from "@filesyncex/protocol";

/** 上传会话（分片/断点续传元数据） */
export interface UploadSession {
  uploadId: string;
  name: string;
  size: number;
  mime?: string;
  sha256?: string;
  /** 客户端预生成的消息 id：组装完成后沿用，便于客户端认领上传占位卡 */
  msgId?: string;
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
/**
 * 秒传索引键：文件名 + 大小 + 内容特征值（分隔符是 `\u0001`）。
 *
 * 为什么不用 `\u0000`：Node 内置 `node:sqlite` 绑定字符串时会在第一个 NUL 处**截断**
 * （实测写入 `name\0 123` 读回只有 `name`），索引列与查找键就对不上了，秒传会静默失效。
 * `\u0001`（SOH）同样不可能出现在文件名里，且 SQLite 读写无损。
 *
 * 为什么带上特征值：只用「文件名 + 大小」时，**同名同大小的不同内容**会被判成同一文件、
 * 直接复用已有物理文件（用户拿到错文件）。带上「前 1 MiB 的 SHA-256」后这类误判消失，
 * 而客户端本来就要读这 1 MiB 算特征值（~20 ms），**不增加任何成本**。
 * 见 Store.getFileByNameSize —— 秒传判定不用整文件摘要，客户端无需先算完整文件哈希。
 */
export function nameSizeKey(name: string, size: number, fp?: string): string {
  return `${name}\u0001${size}\u0001${fp ?? ""}`;
}

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
  /**
   * 按「文件名 + 大小 + 内容特征值（前 1 MiB 的 SHA-256）」找已有文件 —— 秒传快速判定专用。
   *
   * 为什么不用整文件摘要：客户端算整文件 SHA-256 太慢
   * （浏览器无原生流式 SHA-256，纯 JS 单核 ~100 MB/s，500 MB 要 5~7 秒，多 Worker 并行也只有 1.1 倍收益），
   * 而这段等待正好显示为「上传进度 0%」。只读前 1 MiB（~20 ms）即可判定，
   * 内容特征值保证「同名同大小但内容不同」不会误命中；整文件摘要仍由服务端组装时流式计算并作为文件 key。
   */
  getFileByNameSize(name: string, size: number, fp?: string): Promise<FileMetaT | undefined>;
  getFile(key: string): Promise<FileMetaT | undefined>;
  /** 登记「消息 msgId 引用了文件 key」（refs+1）；同一 msgId 重复登记不重复计数 */
  addFileRef(key: string, msgId: string): Promise<void>;
  /** 文件引用 -1（并清掉该消息的引用记录），返回剩余引用数（0 = 可删除物理文件） */
  decrFileRef(key: string, msgId?: string): Promise<number>;
  /** 从文件索引删除（refs 归零后调用） */
  removeFile(key: string): Promise<void>;

  close(): Promise<void>;
}
