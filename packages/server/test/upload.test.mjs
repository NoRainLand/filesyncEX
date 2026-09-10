import { describe, it, before, after, expect } from "./helpers/testkit.mjs";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { startServer, uploadDirect, uploadChunked, openWs, device, sleep } from "./helpers/server.mjs";

describe("上传链路与磁盘卫生", () => {
  let s;

  before(async () => {
    s = await startServer({ store: "sqlite", label: "upload" });
  });

  after(async () => {
    await s.stop();
  });

  const refsOf = (key) => {
    const db = new Database(path.join(s.dataDir, "filesync.db"), { readonly: true });
    const row = db.prepare("SELECT refs FROM files WHERE key = ?").get(key);
    db.close();
    return row?.refs;
  };

  it("同一文件直传两次：两条消息共享一个物理文件，refs=2", async () => {
    const body = Buffer.from("same content uploaded twice");
    const a = await uploadDirect(s, "dup.txt", body, "text/plain");
    const b = await uploadDirect(s, "dup.txt", body, "text/plain");
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.json.msg.file.key).toBe(b.json.msg.file.key);
    expect(refsOf(a.json.msg.file.key)).toBe(2);
  });

  it("删掉其中一条消息后，另一条消息的文件仍可下载（修复前会被误删 404）", async () => {
    const body = Buffer.from("shared file content");
    const a = await uploadDirect(s, "shared.txt", body, "text/plain");
    const b = await uploadDirect(s, "shared.txt", body, "text/plain");
    const key = a.json.msg.file.key;

    const ws = await openWs(s);
    ws.send({ type: "hello", device: device() });
    await sleep(150);
    ws.send({ type: "del", id: b.json.msg.id });
    await sleep(300);

    expect(refsOf(key)).toBe(1);
    const dl = await fetch(s.base + a.json.msg.file.url);
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe(body.toString());

    ws.send({ type: "del", id: a.json.msg.id });
    await sleep(300);
    expect((await fetch(s.base + a.json.msg.file.url)).status).toBe(404); // 引用归零才回收
    ws.close();
  });

  it("complete 校验客户端声明的 sha256：不一致 → 400 且不落盘", async () => {
    const data = Buffer.from("real content");
    const wrong = createHash("sha256").update("other content").digest("hex");
    const bad = await uploadChunked(s, "mismatch.bin", data, "application/octet-stream", wrong);
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain("校验失败");
    expect(fs.readdirSync(s.uploadDir).some((f) => f.includes("mismatch.bin"))).toBe(false);
  });

  it("sha256 一致 → 上传成功", async () => {
    const data = Buffer.from("real content ok");
    const good = createHash("sha256").update(data).digest("hex");
    const res = await uploadChunked(s, "match.bin", data, "application/octet-stream", good);
    expect(res.status).toBe(200);
    expect(res.json.msg.file.sha256).toBe(good);
  });

  it("断点续传：同名同大小复用 uploadId 并返回已完成分片", async () => {
    const data = Buffer.alloc(2.5 * 1024 * 1024, 7); // 3 片
    const init1 = await (
      await fetch(s.base + "/api/upload/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "resume.bin", size: data.length, device: device() }),
      })
    ).json();
    expect(init1.chunkCount).toBe(3);
    await fetch(`${s.base}/api/upload/chunk/${init1.uploadId}/0`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: data.subarray(0, init1.chunkSize),
    });
    const init2 = await (
      await fetch(s.base + "/api/upload/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "resume.bin", size: data.length, device: device(), uploadId: init1.uploadId }),
      })
    ).json();
    expect(init2.uploadId).toBe(init1.uploadId);
    expect(init2.done).toEqual([0]);
  });

  it("秒传：同 sha 不同设备 → existed=true，新增消息引用同一物理文件（refs 递增）", async () => {
    const data = Buffer.from("dedupe content");
    const sha = createHash("sha256").update(data).digest("hex");
    const first = await uploadChunked(s, "dedupe.bin", data, "application/octet-stream", sha);
    expect(first.status).toBe(200);
    const key = first.json.msg.file.key;
    const before = refsOf(key);

    const dup = await (
      await fetch(s.base + "/api/upload/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "dedupe-2.bin", size: data.length, mime: "application/octet-stream", sha256: sha, device: device("dev-c", "user_c") }),
      })
    ).json();
    expect(dup.existed).toBe(true);
    expect(dup.msg.file.name).toBe("dedupe-2.bin"); // 消息名用本次上传名
    expect(dup.msg.file.key).toBe(key); // 复用同一物理文件
    expect(refsOf(key)).toBe(before + 1);
  });

  it("封面图登记进文件索引，随消息删除回收", async () => {
    const cover = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const cov = await fetch(s.base + "/api/upload/cover", { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: cover });
    const { coverKey } = await cov.json();
    const up = await uploadDirect(s, "clip.mp4", Buffer.from("fake mp4"), "video/mp4", coverKey);
    expect(up.json.msg.file.cover).toContain(coverKey);
    const coverPath = path.join(s.uploadDir, coverKey);
    expect(fs.existsSync(coverPath)).toBe(true);

    const ws = await openWs(s);
    ws.send({ type: "hello", device: device() });
    await sleep(150);
    ws.send({ type: "del", id: up.json.msg.id });
    await sleep(300);
    expect(fs.existsSync(coverPath)).toBe(false);
    ws.close();
  });

  it("磁盘清理：废弃会话目录 / 孤儿封面 / 组装临时文件", async () => {
    const old = (Date.now() - 48 * 60 * 60 * 1000) / 1000;
    const staleDir = path.join(s.uploadDir, "stale-session-id");
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, "0.part"), "x");
    const orphanCover = path.join(s.uploadDir, "orphan_cover.jpg");
    const tmpFile = path.join(s.uploadDir, ".tmp-abandoned");
    fs.writeFileSync(orphanCover, "jpeg");
    fs.writeFileSync(tmpFile, "partial");
    for (const p of [staleDir, orphanCover, tmpFile]) fs.utimesSync(p, old, old);

    await s.srv.uploads.sweep(Date.now());

    expect(fs.existsSync(staleDir)).toBe(false);
    expect(fs.existsSync(orphanCover)).toBe(false);
    expect(fs.existsSync(tmpFile)).toBe(false);
  });

  it("仍被消息引用的物理文件不会被清理", async () => {
    const up = await uploadDirect(s, "keep.txt", Buffer.from("keep me"), "text/plain");
    await s.srv.uploads.sweep(Date.now());
    expect((await fetch(s.base + up.json.msg.file.url)).status).toBe(200);
  });

  it("损坏的 JSON 上传初始化 → 400（错误中间件生效）", async () => {
    const r = await fetch(s.base + "/api/upload/init", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"name":' });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("JSON");
  });
});
