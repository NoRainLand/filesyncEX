import { describe, it, before, after } from "./helpers/testkit.mjs";
import { expect } from "./helpers/testkit.mjs";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { rootDir } from "./helpers/server.mjs";

/**
 * 配置读取的兼容与一致性收敛（在临时目录里跑子进程，避免污染仓库根的 serverConfig.json）。
 * 覆盖：旧 chunkSize → chunkSizeMin/Max 迁移、min>max 收敛、directUpload>maxFileSize 收敛、默认值。
 */
describe("配置加载：迁移与收敛", () => {
  const scriptPath = path.join(rootDir, "packages", "server", "dist", "config.js");
  const tmpDirs = [];

  /** 在临时 cwd 下写 serverConfig.json，然后跑子进程读回解析结果 */
  const resolveWith = (configContent) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fsex-cfg-"));
    tmpDirs.push(dir);
    if (configContent !== null) fs.writeFileSync(path.join(dir, "serverConfig.json"), JSON.stringify(configContent), "utf8");
    // 用 ESM 动态 import（dist 是 ESM）；--input-type=module 让 -e 的内容按 ESM 解析
    const modUrl = pathToFileURL(scriptPath).href;
    const js =
      `const { loadConfig } = await import(${JSON.stringify(modUrl)});` +
      `const c = loadConfig({ dataDir: ${JSON.stringify(path.join(dir, "data"))} });` +
      `console.log("FSEX_CFG=" + JSON.stringify({ maxFileSize: c.maxFileSize, chunkSizeMin: c.chunkSizeMin, chunkSizeMax: c.chunkSizeMax, directUpload: c.directUpload }));`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", js], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const line = out.split("\n").find((l) => l.startsWith("FSEX_CFG="));
    return JSON.parse(line.slice("FSEX_CFG=".length));
  };

  after(() => {
    for (const d of tmpDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("无配置文件 → 默认值（16 GiB / 切片 1–8 MiB / 直传 8 MiB）", () => {
    const c = resolveWith(null);
    expect(c.maxFileSize).toBe(16 * 1024 * 1024 * 1024);
    expect(c.chunkSizeMin).toBe(1024 * 1024);
    expect(c.chunkSizeMax).toBe(8 * 1024 * 1024);
    expect(c.directUpload).toBe(8 * 1024 * 1024);
  });

  it("旧配置 chunkSize 迁移为 chunkSizeMin/Max（固定切片，行为与旧版一致）", () => {
    const c = resolveWith({ chunkSize: 4 * 1024 * 1024 });
    expect(c.chunkSizeMin).toBe(4 * 1024 * 1024);
    expect(c.chunkSizeMax).toBe(4 * 1024 * 1024);
  });

  it("新配置 chunkSizeMin/Max 生效；动态切片区间被保留", () => {
    const c = resolveWith({ chunkSizeMin: 2 * 1024 * 1024, chunkSizeMax: 16 * 1024 * 1024 });
    expect(c.chunkSizeMin).toBe(2 * 1024 * 1024);
    expect(c.chunkSizeMax).toBe(16 * 1024 * 1024);
  });

  it("chunkSizeMin > chunkSizeMax → 上限抬到下限（等价固定切片）", () => {
    const c = resolveWith({ chunkSizeMin: 4 * 1024 * 1024, chunkSizeMax: 1 * 1024 * 1024 });
    expect(c.chunkSizeMin).toBe(4 * 1024 * 1024);
    expect(c.chunkSizeMax).toBe(4 * 1024 * 1024);
  });

  it("directUpload > maxFileSize → 直传阈值收敛到单文件上限", () => {
    const c = resolveWith({ maxFileSize: 1024 * 1024, directUpload: 64 * 1024 * 1024 });
    expect(c.maxFileSize).toBe(1024 * 1024);
    expect(c.directUpload).toBe(1024 * 1024);
  });

  it("旧 chunkSize 与 maxFileSize 同时出现：迁移后仍保持一致性", () => {
    const c = resolveWith({ chunkSize: 512 * 1024, maxFileSize: 2 * 1024 * 1024 * 1024, directUpload: 4 * 1024 * 1024 });
    expect(c.chunkSizeMin).toBe(512 * 1024);
    expect(c.chunkSizeMax).toBe(512 * 1024);
    expect(c.directUpload).toBe(4 * 1024 * 1024);
  });
});
