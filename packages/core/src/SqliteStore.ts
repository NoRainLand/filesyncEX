import type { FileMetaT, MsgDataT } from "@filesyncex/protocol";
import { nameSizeKey, type Store, type UploadSession } from "./Store.js";

type DB = import("better-sqlite3").Database;

/**
 * 最小 SQLite 句柄接口（**鸭子类型**，便于把 SqliteStore 也接到别的 SQLite 驱动上做可行性验证，
 * 例如 bun:sqlite —— 它没有 N-API，Bun compile 场景下不需要任何原生模块）。
 * 只描述 SqliteStore 真正用到的东西：exec / prepare().{run,get,all} / pragma 或 run("PRAGMA …")。
 * 注意：bun:sqlite 没有 better-sqlite3 的 `transaction()`，因此事务相关调用会显式判断（见 withTransaction）。
 */
export interface SqliteLike {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): { changes?: number } | unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  pragma?(stmt: string): unknown;
  run?(sql: string): unknown;
  transaction?<T>(fn: () => T): () => T;
  close?(): void;
}

/** 设置 pragma：better-sqlite3 有 pragma()，bun:sqlite 需要 `db.run("PRAGMA …")` */
function pragma(db: SqliteLike, stmt: string): void {
  if (typeof db.pragma === "function") db.pragma(stmt);
  else if (typeof db.run === "function") db.run(`PRAGMA ${stmt}`);
}

/** 事务：优先用驱动的 transaction()；没有（如 bun:sqlite）就退化为直接执行（单连接同步场景语义等价） */
function withTransaction<T>(db: SqliteLike, fn: () => T): T {
  if (typeof db.transaction === "function") return db.transaction(fn)();
  return fn();
}

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
  /** 实际数据库句柄（better-sqlite3 或 bun:sqlite，见 SqliteLike） */
  private db: SqliteLike;

  constructor(db: DB | SqliteLike) {
    this.db = db;
    // 兼容两种运行时：better-sqlite3 的 `db.pragma("journal_mode = WAL")` 与 bun:sqlite 的 `db.run("PRAGMA …")`
    pragma(db, "journal_mode = WAL");
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
        name_size TEXT,
        size INTEGER,
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
    // 旧库迁移：补列（早期版本没有 refs / name_size / size —— 后两者用于「文件名+大小」秒传判定）
    for (const ddl of [
      "ALTER TABLE files ADD COLUMN refs INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE files ADD COLUMN name_size TEXT",
      "ALTER TABLE files ADD COLUMN size INTEGER",
      "CREATE INDEX IF NOT EXISTS idx_files_name_size ON files(name_size)",
    ]) {
      try {
        this.db.exec(ddl);
      } catch {
        /* 已存在，忽略 */
      }
    }
    // 秒传索引回填：老库的 files 行没有 name_size（当时用 fingerprint），按 data 里的 name/size 补上，
    // 否则升级后已存在的文件全都无法秒传，用户会把相同文件再传一遍。
    // 分隔符必须是 char(1)（不是 char(0)）：node:sqlite 绑定含 NUL 的字符串会截断，索引列会丢大小。
    this.db.exec(`
      UPDATE files
        SET name_size = json_extract(data, '$.name') || char(1) || COALESCE(json_extract(data, '$.size'), 0) || char(1) || COALESCE(json_extract(data, '$.fp'), ''),
            size = COALESCE(size, json_extract(data, '$.size'))
        WHERE name_size IS NULL;
    `);
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
    withTransaction(this.db, () => {
      this.db.exec("DELETE FROM messages; DELETE FROM files; DELETE FROM file_refs; DELETE FROM uploads; DELETE FROM chunks;");
    });
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
    return withTransaction(this.db, (): boolean => {
      const exists = this.db.prepare("SELECT 1 FROM files WHERE key = ?").get(key);
      if (exists) return false;
      this.db
        .prepare("INSERT INTO files(key, data, sha256, name_size, size, refs) VALUES (?, ?, ?, ?, ?, 0)")
        .run(key, JSON.stringify(meta), meta.sha256 ?? null, nameSizeKey(meta.name, meta.size ?? 0, meta.fp), meta.size ?? null);
      return true;
    });
  }

  /** 登记「消息 msgId 引用了文件 key」：refs+1，同一消息重复登记幂等 */
  async addFileRef(key: string, msgId: string): Promise<void> {
    withTransaction(this.db, (): void => {
      if (this.db.prepare("SELECT 1 FROM file_refs WHERE key = ? AND msg_id = ?").get(key, msgId)) return;
      this.db.prepare("INSERT INTO file_refs(key, msg_id) VALUES (?, ?)").run(key, msgId);
      this.db.prepare("UPDATE files SET refs = refs + 1 WHERE key = ?").run(key);
    });
  }
  /** 按「文件名 + 大小 + 特征值」找已有文件（秒传快速判定；无需客户端算完整文件哈希） */
  async getFileByNameSize(name: string, size: number, fp?: string): Promise<FileMetaT | undefined> {
    const r = this.db.prepare("SELECT data FROM files WHERE name_size = ? AND size = ? LIMIT 1").get(nameSizeKey(name, size, fp), size) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as FileMetaT) : undefined;
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
    return withTransaction(this.db, (): number => {
      const target = msgId ?? (this.db.prepare("SELECT msg_id FROM file_refs WHERE key = ? LIMIT 1").get(key) as { msg_id: string } | undefined)?.msg_id;
      if (!target) return (this.db.prepare("SELECT refs FROM files WHERE key = ?").get(key) as { refs: number } | undefined)?.refs ?? 0;
      const removed = (this.db.prepare("DELETE FROM file_refs WHERE key = ? AND msg_id = ?").run(key, target) as { changes?: number }).changes ?? 0;
      if (removed > 0) this.db.prepare("UPDATE files SET refs = MAX(0, refs - 1) WHERE key = ?").run(key);
      return (this.db.prepare("SELECT refs FROM files WHERE key = ?").get(key) as { refs: number } | undefined)?.refs ?? 0;
    });
  }
  async removeFile(key: string): Promise<void> {
    this.db.prepare("DELETE FROM files WHERE key = ?").run(key);
  }

  async close(): Promise<void> {
    this.db.close?.();
  }
}
