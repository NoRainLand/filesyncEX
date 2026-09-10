import { describe, it, before, after, expect } from "./helpers/testkit.mjs";
import { startServer, uploadDirect } from "./helpers/server.mjs";

/** 管理端点鉴权：令牌 + 来源校验（P0）。这些端点能在桌面端关机 / 清空全部数据 / 导出全部聊天记录。 */
describe("管理端点鉴权", () => {
  let s;

  before(async () => {
    s = await startServer({ store: "memory", label: "security" });
  });

  after(async () => {
    await s.stop();
  });

  it("GET /api/auth 下发 48 位十六进制令牌", async () => {
    const r = await fetch(s.base + "/api/auth");
    expect(r.status).toBe(200);
    expect((await r.json()).token).toMatch(/^[0-9a-f]{48}$/);
  });

  const forbidden = [
    ["无令牌 POST /api/sys/reset", () => fetch(s.base + "/api/sys/reset", { method: "POST" })],
    ["错误令牌 POST /api/sys/reset", () => fetch(s.base + "/api/sys/reset", { method: "POST", headers: { "X-FSEX-Token": "deadbeef" } })],
    ["无令牌 GET /api/data/export", () => fetch(s.base + "/api/data/export")],
    ["无令牌 POST /api/sys/shutdown", () => fetch(s.base + "/api/sys/shutdown", { method: "POST" })],
    ["无令牌 GET /api/app/download", () => fetch(s.base + "/api/app/download")],
  ];
  for (const [label, run] of forbidden) {
    it(`${label} → 403`, async () => {
      const r = await run();
      expect(r.status).toBe(403);
      expect((await r.json()).error).toContain("令牌");
    });
  }

  it("带正确令牌 → 通过守卫（开发模式 autostart 返回 400 而非 403）", async () => {
    expect((await s.adminFetch("/api/sys/autostart")).status).toBe(400);
  });

  it("跨站来源（外部 Origin）+ 有效令牌 → 403", async () => {
    const r = await fetch(s.base + "/api/sys/autostart", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-FSEX-Token": s.token, Origin: "https://evil.example.com" },
      body: JSON.stringify({ action: 1 }),
    });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toContain("跨站");
  });

  it("Sec-Fetch-Site: cross-site + 有效令牌 → 403", async () => {
    const r = await fetch(s.base + "/api/sys/autostart", {
      method: "POST",
      headers: { "X-FSEX-Token": s.token, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors" },
    });
    expect(r.status).toBe(403);
  });

  it("同源 Origin + 有效令牌 → 放行", async () => {
    const r = await fetch(s.base + "/api/sys/autostart", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-FSEX-Token": s.token, Origin: s.base },
      body: JSON.stringify({ action: 1 }),
    });
    expect(r.status).toBe(400); // 开发模式不支持，但已通过守卫
  });

  it("无 Origin 的令牌客户端（curl / 工具）→ 放行", async () => {
    expect((await s.adminFetch("/api/sys/autostart", { method: "POST" })).status).toBe(400);
  });

  it("导出数据：流式 zip，条目名带 UTF-8 标志且可解析", async () => {
    const up = await uploadDirect(s, "中文测试.txt", Buffer.from("hello filesyncEX"), "text/plain");
    expect(up.status).toBe(200);
    const r = await s.adminFetch("/api/data/export");
    expect(r.status).toBe(200);
    const buf = Buffer.from(await r.arrayBuffer());
    expect(buf.subarray(0, 4).toString("hex")).toBe("504b0304");
    const eocd = buf.lastIndexOf(Buffer.from("504b0506", "hex"));
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    const names = [];
    for (let i = 0; i < count; i++) {
      const flags = buf.readUInt16LE(off + 8);
      const nameLen = buf.readUInt16LE(off + 28);
      names.push(buf.subarray(off + 46, off + 46 + nameLen).toString("utf8"));
      expect(flags & 0x0800).toBe(0x0800); // bit 11：文件名 UTF-8，否则 Windows 解压中文乱码
      off += 46 + nameLen + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
    }
    expect(names.some((n) => n.startsWith("uploads/") && n.includes("中文测试.txt"))).toBe(true);
  });

  it("非管理端点不受鉴权影响（旧客户端兼容）", async () => {
    await expect((await fetch(s.base + "/api/health")).json()).resolves.toMatchObject({ ok: true });
    expect((await fetch(s.base + "/api/msgs")).status).toBe(200);
    const init = await fetch(s.base + "/api/upload/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "t.txt", size: 5, device: { deviceId: "d", deviceName: "u", color: "#000", platform: "other" } }),
    });
    expect(init.status).toBe(200);
  });

  it("畸形 JSON 返回 JSON 错误体（不是 Express HTML 错误页）", async () => {
    const r = await fetch(s.base + "/api/upload/init", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad json" });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect((await r.text()).trim().startsWith("{")).toBe(true);
  });
});
