/**
 * 打包脚本（纯 JS）：依次构建 protocol→core→server→web→shell，再运行 pkg 生成 exe。
 * 产物：release/filesyncex.exe（Windows x64, Node 18）
 */
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const shellDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(shellDir, "../..");
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: "inherit" });

/** 增量构建：src/public 中存在比 dist 更新的文件才需要构建（没改的包跳过，加速重复打包） */
function needBuild(pkg) {
  if (process.env.FSEX_FORCE_BUILD) return true;
  const base = path.join(root, "packages", pkg);
  const dist = path.join(base, "dist");
  if (!fs.existsSync(dist)) return true;
  const newest = (dir) => {
    let t = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else t = Math.max(t, fs.statSync(f).mtimeMs);
      }
    };
    if (fs.existsSync(dir)) walk(dir);
    return t;
  };
  const srcT = Math.max(newest(path.join(base, "src")), newest(path.join(base, "public")));
  return srcT > newest(dist);
}
const buildPkg = (pkg) => {
  if (needBuild(pkg)) {
    console.log(`▶ 构建 ${pkg}`);
    run(`pnpm --filter @filesyncex/${pkg} build`, root);
  } else {
    console.log(`⏭ 跳过构建 ${pkg}（源无变更）`);
  }
};

console.log("▶ 构建 protocol");
run("pnpm --filter @filesyncex/protocol build", root);
console.log("▶ 构建 core");
run("pnpm --filter @filesyncex/core build", root);

// 同步根目录 tool/ 到 web/public/tool（Vite 会复制进 dist，随 web 打包进 exe）
console.log("▶ 同步 tool/ → web/public/tool");
{
  const srcTool = path.join(root, "tool");
  const dstTool = path.join(root, "packages", "web", "public", "tool");
  fs.mkdirSync(dstTool, { recursive: true });
  if (fs.existsSync(srcTool)) {
    for (const f of fs.readdirSync(srcTool)) {
      const s = path.join(srcTool, f);
      if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(dstTool, f));
    }
    console.log("   已同步:", fs.readdirSync(srcTool).filter((f) => fs.statSync(path.join(srcTool, f)).isFile()).join(", "));
  } else {
    console.log("   (tool/ 目录不存在，跳过)");
  }
}

// 同步根目录 fonts/ 到 web/public/fonts（@font-face 引用的字体，Vite 复制进 dist 打包进 exe）
console.log("▶ 同步 fonts/ → web/public/fonts");
{
  const srcFonts = path.join(root, "fonts");
  const dstFonts = path.join(root, "packages", "web", "public", "fonts");
  fs.mkdirSync(dstFonts, { recursive: true });
  if (fs.existsSync(srcFonts)) {
    for (const f of fs.readdirSync(srcFonts)) {
      const s = path.join(srcFonts, f);
      if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(dstFonts, f));
    }
    console.log("   已同步:", fs.readdirSync(srcFonts).filter((f) => fs.statSync(path.join(srcFonts, f)).isFile()).join(", "));
  } else {
    console.log("   (fonts/ 目录不存在，跳过)");
  }
}

buildPkg("server");
buildPkg("web");
buildPkg("shell");

const outDir = path.join(root, "release");
fs.mkdirSync(outDir, { recursive: true });

// 复制 better-sqlite3（含原生 .node 二进制）及其依赖 bindings/file-uri-to-path 到 shell/node_modules，
// 供 pkg 打包进 exe（否则 exe 内 sqlite 初始化失败降级内存存储）。
// 注意：cpSync 带 filter 时 Windows 会给路径加 \\?\ 前缀，p.relative 匹配失败导致整目录被 SKIP（复制后 dst 不存在），
// 因此先整个复制（dereference 解引用 pnpm 符号链接），再删除编译期源码目录 deps/src/node_modules（运行时只需 .node + lib + package.json），
// 可把 better-sqlite3 从 ~13MB 精简到 ~1.7MB，并复制后校验 .node 存在。
console.log("▶ 复制 better-sqlite3 + bindings + file-uri-to-path → shell/node_modules");
{
  const copyDir = (src, dst) => {
    fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true, dereference: true });
  };
  const src = path.join(root, "packages", "server", "node_modules", "better-sqlite3");
  const dst = path.join(shellDir, "node_modules", "better-sqlite3");
  if (fs.existsSync(src)) {
    copyDir(src, dst);
    for (const sub of ["deps", "src", "node_modules"]) {
      const p = path.join(dst, sub);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    }
    const nodeBin = path.join(dst, "build", "Release", "better_sqlite3.node");
    if (!fs.existsSync(nodeBin)) throw new Error("复制 better-sqlite3 后缺少 build/Release/better_sqlite3.node");
    console.log("   ✔ 已复制 better-sqlite3（已精简：删 deps/src/node_modules，保留 .node+lib）");
    // bindings：better-sqlite3 运行时查找 .node 的依赖（位于 .pnpm/better-sqlite3*/node_modules/bindings）
    const bindingsSrc = path.join(path.dirname(fs.realpathSync(src)), "bindings");
    if (fs.existsSync(bindingsSrc)) {
      copyDir(bindingsSrc, path.join(shellDir, "node_modules", "bindings"));
      console.log("   ✔ 已复制 bindings");
      // file-uri-to-path：bindings 的依赖（位于 .pnpm/bindings@*/node_modules/file-uri-to-path）
      const futpSrc = path.join(path.dirname(fs.realpathSync(bindingsSrc)), "file-uri-to-path");
      if (fs.existsSync(futpSrc)) {
        copyDir(futpSrc, path.join(shellDir, "node_modules", "file-uri-to-path"));
        console.log("   ✔ 已复制 file-uri-to-path");
      } else {
        console.warn("   ⚠ 未找到 file-uri-to-path（bindings 依赖）");
      }
    } else {
      console.warn("   ⚠ 未找到 bindings（.pnpm/better-sqlite3*/node_modules/bindings）");
    }
  } else {
    console.warn("   ⚠ 未找到 better-sqlite3（server/node_modules），请先 pnpm install");
  }
}

// ESM → 单文件 CJS bundle（pkg 无法对 import.meta/ESM 生成 bytecode，需先 bundle）
console.log("▶ esbuild bundle（ESM → 单文件 CJS）");
run(
  "pnpm exec esbuild src/index.ts --bundle --platform=node --format=cjs --target=node18 --outfile=dist/bundle.cjs --external:better-sqlite3 --log-level=warning",
  shellDir
);

// rcedit 修改应用 icon / 版本信息：在 pkg 打包之后执行（fix-icon.mjs 会 rcedit 改资源，
// 然后把从原 exe 提取的 pkg payload+prelude 重新拼回并更新 PAYLOAD_POSITION/PRELUDE_POSITION，
// 避免破坏 pkg 快照。直接修补 fetched 会被 pkg 完整性校验覆盖，无效。）

console.log("▶ pkg 打包（node18-win-x64，--compress GZip 压缩包体约 -28%）");
run(`pnpm exec pkg ${JSON.stringify(path.join(shellDir, "dist/bundle.cjs"))} --compress GZip --targets node18-win-x64 --output ${JSON.stringify(path.join(outDir, "filesyncex.exe"))} --config ${JSON.stringify(path.join(shellDir, "package.json"))}`, shellDir);

// 打包后修补 icon / 版本信息（保留 pkg payload）
console.log("▶ rcedit 修改 icon / 版本信息（并恢复 pkg payload）");
{
  const exe = path.join(outDir, "filesyncex.exe");
  const fs = await import("node:fs");
  if (fs.existsSync(exe) && fs.existsSync(path.join(root, "FS.ico"))) {
    run(`node scripts/fix-icon.mjs ${JSON.stringify(exe)} ${JSON.stringify(path.join(root, "FS.ico"))}`, shellDir);
  } else {
    console.warn("   ⚠ 未找到 exe 或 FS.ico，跳过 icon 修补");
  }
}

console.log("✔ 打包完成：", path.join(outDir, "filesyncex.exe"));
