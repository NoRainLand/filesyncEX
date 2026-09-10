import type { FileMetaT, MsgDataT } from "@filesyncex/protocol";
import type { Store, UploadSession } from "./Store.js";

type DB = import("better-sqlite3").Database;

/** uploads 表行（snake_case） */
interface UploadRow {
  upload_id: string;
  name: string;
  size: number;
  mime: string | null;
  sha256: string | null;
  chunk_size: number;
  chunk_count: number;
  created_at: number;
  device: string | null;
}

/** uploads 行 → UploadSession（SqliteStore 内共用） */
function rowToSession(r: UploadRow): UploadSession {
  return {
    uploadId: r.upload_id,
    name: r.name,
    size: r.size,
    mime: r.mime ?? undefined,
    sha256: r.sha256 ?? undefined,
    chunkSize: r.chunk_size,
    chunkCount: r.chunk_count,
    createdAt: r.created_at,
    device: r.device ? (JSON.parse(r.device) as import("@filesyncex/protocol").DeviceInfoT) : undefined,
  };
}

/**
 * SQLite 版 Store（better-sqlite3）。
 * 表：
 *  - messages(id PK, data TEXT json, ts INTEGER)  消息
 *  - uploads(upload_id PK, name, size, mime, sha256, chunk_size, chunk_count, created_at)
 *  - chunks(upload_id, idx, PRIMARY KEY(upload_id, idx))
 *  - files(key PK, data TEXT json, sha256, refs INTEGER)  文件索引（秒传用 sha256；refs=文件被消息引用的次数）
 */
export class SqliteStore implements Store {
  private db: DB;

  constructor(db: DB) {
    this.db = db;
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages(
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS uploads(
        upload_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        size INTEGER NOT NULL,
        mime TEXT,
        sha256 TEXT,
        chunk_size INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        device TEXT
      );
      CREATE TABLE IF NOT EXISTS chunks(
        upload_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        PRIMARY KEY(upload_id, idx)
      );
      CREATE TABLE IF NOT EXISTS files(
        key TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        sha256 TEXT,
        refs INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS file_refs(
        key TEXT NOT NULL,
        msg_id TEXT NOT NULL,
        PRIMARY KEY(key, msg_id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
      CREATE INDEX IF NOT EXISTS idx_files_sha ON files(sha256);
    `);
    // 旧库迁移：files 表可能没有 refs 列（早期版本），补列
    try {
      this.db.exec("ALTER TABLE files ADD COLUMN refs INTEGER NOT NULL DEFAULT 0");
    } catch {
      /* 列已存在，忽略 */
    }
    // 引用计数修复 + 一致性重建：
    // 早期版本在 insert ... ON CONFLICT 时不增加 refs（同一文件重复上传 → refs 卡在 1），
    // 删掉一条引用它的消息就会把其他消息仍在引用的文件物理删除。启动时按 messages 表全量重算
    // file_refs（文件被哪些消息引用）与 refs（引用条数），把历史库一次性修正。
    this.db.exec(`
      INSERT OR IGNORE INTO file_refs(key, msg_id)
        SELECT json_extract(data, '$.file.key'), id FROM messages
          WHERE json_extract(data, '$.file.key') IS NOT NULL;
      UPDATE files SET refs = (SELECT COUNT(*) FROM file_refs WHERE file_refs.key = files.key);
    `);
  }

  async init(): Promise<void> {}

  /* ----- 消息 ----- */
  async saveMessage(msg: MsgDataT): Promise<void> {
    this.db
      .prepare("INSERT OR REPLACE INTO messages(id, data, ts) VALUES (?, ?, ?)")
      .run(msg.id, JSON.stringify(msg), msg.ts);
  }
  async listMessages(limit = 500): Promise<MsgDataT[]> {
    const rows = this.db
      .prepare("SELECT data FROM messages ORDER BY ts ASC LIMIT ?")
      .all(limit) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as MsgDataT);
  }
  async getMessage(id: string): Promise<MsgDataT | undefined> {
    const row = this.db.prepare("SELECT data FROM messages WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as MsgDataT) : undefined;
  }
  async updateMessage(id: string, msg: MsgDataT): Promise<void> {
    this.db.prepare("UPDATE messages SET data = ?, ts = ? WHERE id = ?").run(JSON.stringify(msg), msg.ts, id);
  }
  async removeMessage(id: string): Promise<void> {
    this.db.prepare("DELETE FROM messages WHERE id = ?").run(id);
  }
  async clearAll(): Promise<void> {
    this.db.transaction(() => {
      this.db.exec("DELETE FROM messages; DELETE FROM files; DELETE FROM file_refs; DELETE FROM uploads; DELETE FROM chunks;");
    })();
  }

  /* ----- 上传会话 ----- */
  async createUpload(s: UploadSession): Promise<void> {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO uploads(upload_id,name,size,mime,sha256,chunk_size,chunk_count,created_at,device) VALUES (?,?,?,?,?,?,?,?,?)"
      )
      .run(s.uploadId, s.name, s.size, s.mime ?? null, s.sha256 ?? null, s.chunkSize, s.chunkCount, s.createdAt, s.device ? JSON.stringify(s.device) : null);
  }
  async getUpload(uploadId: string): Promise<UploadSession | undefined> {
    const r = this.db.prepare("SELECT * FROM uploads WHERE upload_id = ?").get(uploadId) as UploadRow | undefined;
    return r ? rowToSession(r) : undefined;
  }
  async listUploads(): Promise<UploadSession[]> {
    const rows = this.db.prepare("SELECT * FROM uploads").all() as UploadRow[];
    return rows.map(rowToSession);
  }
  async addUploadChunk(uploadId: string, index: number): Promise<void> {
    this.db.prepare("INSERT OR IGNORE INTO chunks(upload_id, idx) VALUES (?, ?)").run(uploadId, index);
  }
  async listUploadChunks(uploadId: string): Promise<number[]> {
    const rows = this.db.prepare("SELECT idx FROM chunks WHERE upload_id = ?").all(uploadId) as { idx: number }[];
    return rows.map((r) => r.idx).sort((a, b) => a - b);
  }
  async removeUpload(uploadId: string): Promise<void> {
    this.db.prepare("DELETE FROM chunks WHERE upload_id = ?").run(uploadId);
    this.db.prepare("DELETE FROM uploads WHERE upload_id = ?").run(uploadId);
  }

  /* ----- 文件索引 ----- */

  /** 登记物理文件元数据（不涉及引用计数）；已存在返回 false 且不覆盖首份元数据 */
  async createFile(key: string, meta: FileMetaT): Promise<boolean> {
    return this.db.transaction((): boolean => {
      const exists = this.db.prepare("SELECT 1 FROM files WHERE key = ?").get(key);
      if (exists) return false;
      this.db
        .prepare("INSERT INTO files(key, data, sha256, refs) VALUES (?, ?, ?, 0)")
        .run(key, JSON.stringify(meta), meta.sha256 ?? null);
      return true;
    })();
  }

  /** 登记「消息 msgId 引用了文件 key」：refs+1，同一消息重复登记幂等 */
  async addFileRef(key: string, msgId: string): Promise<void> {
    this.db.transaction((): void => {
      if (this.db.prepare("SELECT 1 FROM file_refs WHERE key = ? AND msg_id = ?").get(key, msgId)) return;
      this.db.prepare("INSERT INTO file_refs(key, msg_id) VALUES (?, ?)").run(key, msgId);
      this.db.prepare("UPDATE files SET refs = refs + 1 WHERE key = ?").run(key);
    })();
  }
  async getFileBySha(sha: string): Promise<FileMetaT | undefined> {
    const r = this.db.prepare("SELECT data FROM files WHERE sha256 = ?").get(sha) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as FileMetaT) : undefined;
  }
  async getFile(key: string): Promise<FileMetaT | undefined> {
    const r = this.db.prepare("SELECT data FROM files WHERE key = ?").get(key) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as FileMetaT) : undefined;
  }
  /** 文件引用 -1（并清掉该消息的引用记录）；未登记过该消息时只返回当前值，不会把 refs 减成负数 */
  async decrFileRef(key: string, msgId?: string): Promise<number> {
    return this.db.transaction((): number => {
      const target = msgId ?? (this.db.prepare("SELECT msg_id FROM file_refs WHERE key = ? LIMIT 1").get(key) as { msg_id: string } | undefined)?.msg_id;
      if (!target) return (this.db.prepare("SELECT refs FROM files WHERE key = ?").get(key) as { refs: number } | undefined)?.refs ?? 0;
      const removed = this.db.prepare("DELETE FROM file_refs WHERE key = ? AND msg_id = ?").run(key, target).changes;
      if (removed > 0) this.db.prepare("UPDATE files SET refs = MAX(0, refs - 1) WHERE key = ?").run(key);
      return (this.db.prepare("SELECT refs FROM files WHERE key = ?").get(key) as { refs: number } | undefined)?.refs ?? 0;
    })();
  }
  async removeFile(key: string): Promise<void> {
    this.db.prepare("DELETE FROM files WHERE key = ?").run(key);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
