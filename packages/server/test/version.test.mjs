import { describe, it, expect } from "./helpers/testkit.mjs";
import path from "node:path";
import fs from "node:fs";
import { startServer, rootDir } from "./helpers/server.mjs";
import { APP_VERSION } from "../dist/version.js";
import { lanAddress, lanAddresses } from "../dist/net.js";

const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));

describe("版本号唯一来源", () => {
  it("server APP_VERSION 与根 package.json 一致（不再各处硬编码）", () => {
    expect(APP_VERSION).toBe(pkg.version);
  });

  it("源码里不再残留写死的版本号字面量", () => {
    const sources = ["packages/server/src/HttpServer.ts", "packages/server/src/index.ts", "packages/web/src/main.ts", "packages/web/src/app.ts"];
    for (const rel of sources) {
      const text = fs.readFileSync(path.join(rootDir, rel), "utf8");
      expect(text.includes(pkg.version)).toBe(false);
    }
  });

  it("/api/health 返回 health.version = 根 package.json 版本", async () => {
    const s = await startServer({ store: "memory", label: "version" });
    try {
      const health = await (await fetch(s.base + "/api/health")).json();
      expect(health.version).toBe(pkg.version);
      expect(Array.isArray(health.lanIps)).toBe(true);
    } finally {
      await s.stop();
    }
  });
});

describe("局域网地址探测（多网卡）", () => {
  it("lanAddresses 返回全部候选且主地址取第一个", () => {
    const all = lanAddresses();
    expect(Array.isArray(all)).toBe(true);
    expect(all.length).toBeGreaterThan(0);
    expect(all[0]).toBe(lanAddress());
    for (const ip of all) expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });
});
