import { describe, it, before, after, expect } from "./helpers/testkit.mjs";
import path from "node:path";
import fs from "node:fs";
import { SqliteStore, MemoryStore, SyncEngine } from "@filesyncex/core";
import { rootDir, openRawDb } from "./helpers/server.mjs";

const tmp = path.join(rootDir, "_dev", "test-tmp", "core-store");

function msg(id, key) {
  return {
    id,
    kind: "file",
    sender: { deviceId: "d", deviceName: "u", color: "#000", platform: "other" },
    ts: Date.now(),
    file: { name: "a.png", size: 10, mime: "image/png", sha256: "deadbeef", key, url: "/api/file/" + key },
  };
}

describe("SqliteStore 文件引用计数", () => {
  let db;
  let store;
  const key = "abc123_item.png";

  before(async () => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    db = openRawDb(path.join(tmp, "t.db"));
    store = new SqliteStore(db);
    await store.init();
  });

  after(() => {
    db.close();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  const refs = () => db.prepare("SELECT refs FROM files WHERE key = ?").get(key).refs;

  it("createFile 首次返回 true、refs=0；重复返回 false 且不覆盖元数据", async () => {
    const meta = { name: "a.png", size: 10, mime: "image/png", sha256: "deadbeef", key, url: "/api/file/" + key };
    expect(await store.createFile(key, meta)).toBe(true);
    expect(refs()).toBe(0);
    expect(await store.createFile(key, { ...meta, name: "b.png" })).toBe(false);
    expect((await store.getFile(key))?.name).toBe("a.png"); // 保留首份元数据
  });

  it("addFileRef：一条消息引用 refs=1，同一消息重复登记幂等", async () => {
    await store.saveMessage(msg("m1", key));
    await store.addFileRef(key, "m1");
    await store.addFileRef(key, "m1");
    expect(refs()).toBe(1);
  });

  it("同一文件被两条消息引用 → refs=2（修复前卡在 1，删一条就误删物理文件）", async () => {
    await store.saveMessage(msg("m2", key));
    await store.addFileRef(key, "m2");
    expect(refs()).toBe(2);
  });

  it("decrFileRef 返回剩余引用数：删一条 → 1，删最后一条 → 0", async () => {
    expect(await store.decrFileRef(key, "m2")).toBe(1);
    expect(await store.decrFileRef(key, "m1")).toBe(0);
  });

  it("decrFileRef 对未登记过的消息不会把 refs 减成负数", async () => {
    expect(await store.decrFileRef(key, "not-registered")).toBe(0);
  });

  it("启动时按 messages 表重算 refs（旧库自动修复）", async () => {
    const db2 = openRawDb(path.join(tmp, "legacy.db"));
    const store2 = new SqliteStore(db2);
    await store2.init();
    const meta = { name: "a.png", size: 10, mime: "image/png", sha256: "cafe", key: "legacy_key", url: "/api/file/legacy_key" };
    await store2.createFile("legacy_key", meta);
    await store2.saveMessage(msg("L1", "legacy_key"));
    await store2.saveMessage(msg("L2", "legacy_key"));
    db2.prepare("UPDATE files SET refs = 1 WHERE key = ?").run("legacy_key"); // 模拟旧版的错误状态
    db2.close();

    const db3 = openRawDb(path.join(tmp, "legacy.db"));
    const store3 = new SqliteStore(db3); // 构造函数内重算 file_refs / refs
    await store3.init();
    expect(db3.prepare("SELECT refs FROM files WHERE key = ?").get("legacy_key").refs).toBe(2);
    db3.close();
  });
});

describe("MemoryStore 与 SqliteStore 语义一致", () => {
  it("createFile / addFileRef / decrFileRef 行为一致", async () => {
    const store = new MemoryStore();
    await store.init();
    const key = "mem_key";
    const meta = { name: "m.bin", size: 3, mime: "application/octet-stream", key, url: "/api/file/" + key };
    expect(await store.createFile(key, meta)).toBe(true);
    expect(await store.createFile(key, meta)).toBe(false);
    await store.addFileRef(key, "x1");
    await store.addFileRef(key, "x1");
    expect(await store.getFile(key)).toBeTruthy();
    expect(await store.decrFileRef(key, "x1")).toBe(0);
    await store.removeFile(key);
    expect(await store.getFile(key)).toBeUndefined();
  });
});

describe("SyncEngine 消息与附件引用", () => {
  it("trim 裁剪历史不删附件；主动删除消息才释放引用并回收", async () => {
    const store = new MemoryStore();
    await store.init();
    const engine = new SyncEngine(store, { historyLimit: 2 });
    const gcKeys = [];
    engine.events.on("file-gc", ({ key }) => gcKeys.push(key));

    const mk = (id, key, ts) => ({
      id,
      kind: "file",
      sender: { deviceId: "d", deviceName: "u", color: "#000", platform: "other" },
      ts,
      file: { name: "f.bin", size: 1, key, url: "/api/file/" + key },
    });

    for (const [id, key, ts] of [["t1", "k1", 1], ["t2", "k2", 2], ["t3", "k3", 3]]) {
      await store.createFile(key, { name: "f.bin", size: 1, key, url: "/api/file/" + key });
      await engine.addMessage(mk(id, key, ts));
      await store.addFileRef(key, id);
    }
    expect((await engine.listMessages()).map((m) => m.id)).toEqual(["t2", "t3"]); // t1 被裁掉
    expect(gcKeys).toEqual([]); // 裁剪不删附件物理文件
    expect(await store.getFile("k1")).toBeTruthy(); // 文件索引仍在，交由 sweeper 按 TTL 回收

    await engine.removeMessage("t3"); // 主动删除 → 释放引用
    expect(gcKeys).toContain("k3");
  });
});
