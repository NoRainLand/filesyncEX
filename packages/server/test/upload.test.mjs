import { describe, it, before, after, expect } from "./helpers/testkit.mjs";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { startServer, uploadDirect, uploadChunked, openWs, device, sleep, sqliteGet } from "./helpers/server.mjs";

describe("上传链路与磁盘卫生", () => {
  let s;

  before(async () => {
    s = await startServer({ store: "sqlite", label: "upload" });
  });

  after(async () => {
    await s.stop();
  });

  // 用统一的只读查询（内部按 Node 版本选 node:sqlite / better-sqlite3），避免测试受 ABI 影响
  const refsOf = (key) => sqliteGet(path.join(s.dataDir, "filesync.db"), "SELECT refs FROM files WHERE key = ?", key)?.refs;

  it("同一文件直传两次：两条消息共享一个物理文件，refs=2", async () => {
    const body = Buffer.from("same content uploaded twice");
    const a = await uploadDirect(s, "dup.txt", body, "text/plain");
    const b = await uploadDirect(s, "dup.txt", body, "text/plain");
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.json.msg.file.key).toBe(b.json.msg.file.key);
    expect(refsOf(a.json.msg.file.key)).toBe(2);
    // 直传也写特征值（前 1 MiB 的 sha256；文件不足 1 MiB → 等于整文件摘要），且两条路径算法一致
    expect(a.json.msg.file.fp).toBe(createHash("sha256").update(body).digest("hex"));
  });

  it("特征值 = 前 1 MiB：仅尾部不同的两个文件（>1 MiB）特征值相同，但 sha256/物理文件不同", async () => {
    const head = Buffer.alloc(1024 * 1024, 3); // 恰好 1 MiB 相同前缀
    const f1 = Buffer.concat([head, Buffer.from("tail-A")]);
    const f2 = Buffer.concat([head, Buffer.from("tail-B")]);
    const r1 = await uploadChunked(s, "head-a.bin", f1);
    const r2 = await uploadChunked(s, "head-b.bin", f2);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.json.msg.file.fp).toBe(r2.json.msg.file.fp); // 前 1 MiB 相同
    expect(r1.json.msg.file.sha256 === r2.json.msg.file.sha256).toBe(false); // 内容不同 → 各自独立（testkit 无 .not）
    expect(r1.json.msg.file.key === r2.json.msg.file.key).toBe(false);
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

  it("客户端不算整文件摘要（不传 sha256）→ 服务端组装时自算并作为 key/元数据", async () => {
    const data = Buffer.from("no client side full file hash at all");
    const expectSha = createHash("sha256").update(data).digest("hex");
    const res = await uploadChunked(s, "nohash.bin", data); // 不传 sha256
    expect(res.status).toBe(200);
    expect(res.json.msg.file.sha256).toBe(expectSha);
    expect(res.json.msg.file.key.startsWith(expectSha.slice(0, 12))).toBe(true);
    // 特征值 = 前 1 MiB 的标准 sha256（此处文件不足 1 MiB → 等于整文件摘要）
    expect(res.json.msg.file.fp).toBe(expectSha);
  });

  it("秒传：同文件名+大小+特征值（客户端零整文件哈希）→ existed=true 复用物理文件，refs 递增", async () => {
    const data = Buffer.from("dedupe by name and size without any hash");
    const fp = createHash("sha256").update(data.subarray(0, 1024 * 1024)).digest("hex");
    const init1 = await (
      await fetch(s.base + "/api/upload/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "byname.bin", size: data.length, mime: "application/octet-stream", firstChunkSha256: fp, device: device() }),
      })
    ).json();
    for (let i = 0; i < init1.chunkCount; i++) {
      const start = i * init1.chunkSize;
      await fetch(`${s.base}/api/upload/chunk/${init1.uploadId}/${i}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: data.subarray(start, Math.min(start + init1.chunkSize, data.length)),
      });
    }
    const first = await (await fetch(`${s.base}/api/upload/complete/${init1.uploadId}`, { method: "POST" })).json();
    const key = first.msg.file.key;
    const before = refsOf(key);
    expect(first.msg.file.fp).toBe(fp); // 服务端独立算出的特征值与客户端一致

    const dup = await (
      await fetch(s.base + "/api/upload/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "byname.bin", size: data.length, mime: "application/octet-stream", firstChunkSha256: fp, device: device("dev-d", "user_d") }),
      })
    ).json();
    expect(dup.existed).toBe(true);
    expect(dup.msg.file.key).toBe(key);
    expect(refsOf(key)).toBe(before + 1);
  });

  it("秒传不误命中：同名同大小但特征值不同 → existed=false（内容不同不能复用物理文件）", async () => {
    const head = Buffer.alloc(1024 * 1024, 9);
    const f1 = Buffer.concat([head, Buffer.from("AAAA")]);
    const f2 = Buffer.concat([Buffer.alloc(1024 * 1024, 8), Buffer.from("BBBB")]); // 同大小、不同内容
    const fp1 = createHash("sha256").update(f1.subarray(0, 1024 * 1024)).digest("hex");
    const fp2 = createHash("sha256").update(f2.subarray(0, 1024 * 1024)).digest("hex");
    const r1 = await uploadChunked(s, "same-size-diff-content.bin", f1);
    expect(r1.status).toBe(200);
    const dup = await (
      await fetch(s.base + "/api/upload/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "same-size-diff-content.bin", size: f2.length, firstChunkSha256: fp2, device: device() }),
      })
    ).json();
    expect(dup.existed).toBe(false);
    expect(fp1 === fp2).toBe(false);
  });

  it("同名但大小不同 → 不命中秒传（避免张冠李戴）", async () => {
    const data = Buffer.from("size matters for dedupe");
    const fp = createHash("sha256").update(data.subarray(0, 1024 * 1024)).digest("hex");
    await uploadChunked(s, "samesize.bin", data);
    const dup = await (
      await fetch(s.base + "/api/upload/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "samesize.bin", size: data.length + 1, firstChunkSha256: fp, device: device() }),
      })
    ).json();
    expect(dup.existed).toBe(false);
  });

  it("直传路径也建秒传索引：同名同大小同特征值 → 复用物理文件；索引列格式与 nameSizeKey 一致", async () => {
    const data = Buffer.from("direct dedupe payload");
    const fp = createHash("sha256").update(data.subarray(0, 1024 * 1024)).digest("hex");
    const a = await uploadDirect(s, "direct-dup.bin", data, "application/octet-stream", undefined, fp);
    expect(a.status).toBe(200);
    // 索引列格式必须与 nameSizeKey() 完全一致（\u0001 分隔），否则秒传查不到
    const row = sqliteGet(path.join(s.dataDir, "filesync.db"), "SELECT name_size FROM files WHERE key = ?", a.json.msg.file.key);
    const expectKey = `direct-dup.bin\u0001${data.length}\u0001${fp}`;
    expect(row.name_size).toBe(expectKey);
    expect(row.name_size.charCodeAt("direct-dup.bin".length)).toBe(1);

    const dup = await uploadDirect(s, "direct-dup.bin", data, "application/octet-stream", undefined, fp);
    expect(dup.json.msg.file.key).toBe(a.json.msg.file.key);
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

  it("/api/health 下发上传限制（客户端据此预检）", async () => {
    const health = await (await fetch(s.base + "/api/health")).json();
    expect(health.limits.directUpload).toBe(8 * 1024 * 1024);
    // 切片改为「按文件大小动态取」：health 只下发上下限，具体切片由 init 返回
    expect(health.limits.chunkSizeMin).toBe(1024 * 1024);
    expect(health.limits.chunkSizeMax).toBe(8 * 1024 * 1024);
    expect(health.limits.chunkSize).toBeUndefined();
    expect(health.limits.maxFileSize).toBe(16 * 1024 * 1024 * 1024); // 默认 16 GiB
  });
});

/** 单文件上限（maxFileSize）：配置调小以便测试；默认 16 GiB */
describe("单文件上限（maxFileSize）", () => {
  let s;

  before(async () => {
    s = await startServer({ store: "sqlite", label: "limit", config: { maxFileSize: 2 * 1024 * 1024 } }); // 2 MiB
  });

  after(async () => {
    await s.stop();
  });

  const init = (name, size) =>
    fetch(s.base + "/api/upload/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, size, mime: "application/octet-stream", device: device() }),
    });

  it("health.limits.maxFileSize 反映配置值", async () => {
    const health = await (await fetch(s.base + "/api/health")).json();
    expect(health.limits.maxFileSize).toBe(2 * 1024 * 1024);
  });

  it("超过上限 → init 400 且不创建上传会话（客户端不会被白传分片）", async () => {
    const r = await init("too-big.bin", 8 * 1024 * 1024);
    expect(r.status).toBe(400);
    const err = (await r.json()).error;
    expect(err).toContain("超过单文件上限");
    expect(err).toContain("maxFileSize"); // 提示如何调整
    expect(fs.existsSync(path.join(s.uploadDir, "too-big"))).toBe(false);
  });

  it("等于上限 → 允许", async () => {
    expect((await init("exact.bin", 2 * 1024 * 1024)).status).toBe(200);
  });

  it("直传超过上限 → 400（direct 路径同样受控）", async () => {
    const big = Buffer.alloc(3 * 1024 * 1024, 1); // 3 MiB > 2 MiB 上限
    const r = await uploadDirect(s, "direct-big.bin", big, "application/octet-stream");
    expect(r.status).toBe(400);
    // 直传阈值已被收敛到 maxFileSize（2 MiB），故先撞到「直传上限」提示；两种情况都是被拒且文案可读
    expect(/直传上限|超过单文件上限/.test(r.json.error), r.json.error).toBe(true);
  });

  it("分片超过约定大小 → 可读错误（而不是笼统的「请求体过大」）", async () => {
    const initRes = await (
      await fetch(s.base + "/api/upload/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "chunk-big.bin", size: 2 * 1024 * 1024, device: device() }),
      })
    ).json();
    const r = await fetch(`${s.base}/api/upload/chunk/${initRes.uploadId}/0`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.alloc(initRes.chunkSize + 8192, 2),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("分片过大");
  });
});

/** 直传阈值（directUpload）可配置 + 与 maxFileSize 的一致性收敛 */
describe("直传阈值（directUpload）", () => {
  it("默认下发 8 MiB", async () => {
    const s = await startServer({ store: "sqlite", label: "direct-default" });
    try {
      const health = await (await fetch(s.base + "/api/health")).json();
      expect(health.limits.directUpload).toBe(8 * 1024 * 1024);
    } finally {
      await s.stop();
    }
  });

  it("可配置：directUpload=64KiB 时 health 与直传拒绝阈值同步变化", async () => {
    const s = await startServer({ store: "sqlite", label: "direct-64k", config: { directUpload: 64 * 1024 } });
    try {
      const health = await (await fetch(s.base + "/api/health")).json();
      expect(health.limits.directUpload).toBe(64 * 1024);
      // ≤ 64 KiB 直传成功
      const ok = await uploadDirect(s, "tiny.bin", Buffer.alloc(32 * 1024, 1), "application/octet-stream");
      expect(ok.status).toBe(200);
      // > 64 KiB 但 ≤ 直传阈值×? —— 直传被拒（须走分片）
      const tooBig = await uploadDirect(s, "mid.bin", Buffer.alloc(128 * 1024, 1), "application/octet-stream");
      expect(tooBig.status).toBe(400);
      expect(tooBig.json.error).toContain("直传上限");
    } finally {
      await s.stop();
    }
  });

  it("directUpload > maxFileSize 时收敛到 maxFileSize（避免错误信息自相矛盾）", async () => {
    const s = await startServer({ store: "sqlite", label: "direct-clamp", config: { maxFileSize: 1024 * 1024, directUpload: 10 * 1024 * 1024 } });
    try {
      const health = await (await fetch(s.base + "/api/health")).json();
      expect(health.limits.maxFileSize).toBe(1024 * 1024);
      expect(health.limits.directUpload).toBe(1024 * 1024);
    } finally {
      await s.stop();
    }
  });
});
