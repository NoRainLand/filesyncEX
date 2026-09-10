import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 版本号唯一来源 = 根 package.json。
 *  - 打包（shell/scripts/package.mjs）时 esbuild `--define:__APP_VERSION__` 直接内联成字符串常量；
 *  - 开发模式（tsx/tsc 运行）没有该常量，向上查找仓库根的 package.json 运行时读取。
 * 其余位置（/api/health、启动 banner）一律引用本常量，不再硬编码版本号。
 */
function readVersionFromPackageJson(): string {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      const pkgPath = path.join(dir, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
        if (pkg.name === "filesyncex" && pkg.version) return pkg.version;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* 读取失败回退 unknown */
  }
  return "unknown";
}

export const APP_VERSION: string = typeof __APP_VERSION__ === "string" && __APP_VERSION__ ? __APP_VERSION__ : readVersionFromPackageJson();
