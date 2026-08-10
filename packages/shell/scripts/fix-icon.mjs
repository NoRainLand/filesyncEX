/**
 * 修复 pkg 打包 exe 的 icon：rcedit 改资源会丢弃 pkg 追加在文件末尾的 payload+prelude。
 * exe 布局：[fetched][payload(PRELUDE_POSITION-PAYLOAD_POSITION)][prelude(末尾)]。
 * 做法：①解析 readPrelude 的 4 个占位符，取出 payload+prelude；
 *       ②rcedit 修改 icon（丢 payload+prelude）；③更新 PAYLOAD_POSITION/PRELUDE_POSITION；
 *       ④把 payload+prelude 拼回。
 * 用法：node scripts/fix-icon.mjs <exe路径> <icon路径>
 */
import rcedit from "rcedit";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [, , exePath, iconPath] = process.argv;
if (!exePath || !iconPath) { console.error("用法: node fix-icon.mjs <exe> <icon>"); process.exit(1); }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
const version = pkgJson.version || "0.0.0";

const rceditOptions = {
  "version-string": {
    ProductName: "filesyncEX",
    FileDescription: "基于 Node 开发的局域网文件/文字同步工具",
    FileVersion: version,
    ProductVersion: version,
    OriginalFilename: "filesyncex.exe",
    InternalName: "filesyncex.exe",
    CompanyName: "unknownmothergoose",
    LegalCopyright: "Copyright © 2023-2025 NoRain",
  },
  "file-version": version,
  "product-version": version,
  icon: iconPath,
};

const VAR = (name) => `var ${name} = '`;
const readVar = (buf, name) => {
  const marker = VAR(name);
  const mi = buf.indexOf(marker);
  if (mi < 0) throw new Error(`未找到 ${name} 占位符`);
  const ns = mi + marker.length;
  const ne = buf.indexOf("'", ns);
  if (ne < 0) throw new Error(`${name} 占位符缺少闭合引号`);
  return { mi, ns, ne, value: parseInt(buf.slice(ns, ne).toString("latin1").trim(), 10) };
};
const writeVar = (buf, name, value) => {
  const marker = VAR(name);
  const mi = buf.indexOf(marker);
  if (mi < 0) throw new Error(`rcedit 后未找到 ${name} 占位符`);
  const ns = mi + marker.length;
  const ne = buf.indexOf("'", ns);
  const w = ne - ns;
  const str = String(value);
  if (str.length > w) throw new Error(`${name} 新值超宽: ${str.length} > ${w}`);
  buf.write(str + " ".repeat(w - str.length), ns, "latin1");
};

const orig = fs.readFileSync(exePath);
const pp = readVar(orig, "PAYLOAD_POSITION");
const ps = readVar(orig, "PAYLOAD_SIZE");
const lp = readVar(orig, "PRELUDE_POSITION");
const ls = readVar(orig, "PRELUDE_SIZE");
console.log("[fix-icon] 原布局:", JSON.stringify({ PAYLOAD_POSITION: pp.value, PAYLOAD_SIZE: ps.value, PRELUDE_POSITION: lp.value, PRELUDE_SIZE: ls.value }));

if (pp.value + ps.value !== lp.value) throw new Error("布局校验失败: PAYLOAD_POSITION+PAYLOAD_SIZE != PRELUDE_POSITION");
const payload = orig.slice(pp.value, lp.value);
const prelude = orig.slice(lp.value, lp.value + ls.value);
console.log("[fix-icon] 提取 payload:", payload.length, "prelude:", prelude.length);

// 备份 + rcedit（原地修改，丢 payload+prelude）
fs.writeFileSync(exePath + ".bak", orig);
await rcedit(exePath, rceditOptions);
const fixed = fs.readFileSync(exePath);
console.log("[fix-icon] rcedit 后大小:", fixed.length);

// 更新占位符并拼回
const newPayloadPos = fixed.length;
const newPreludePos = newPayloadPos + ps.value;
const out = Buffer.from(fixed);
writeVar(out, "PAYLOAD_POSITION", newPayloadPos);
writeVar(out, "PRELUDE_POSITION", newPreludePos);
const final = Buffer.concat([out, payload, prelude]);
fs.writeFileSync(exePath, final);
console.log("[fix-icon] ✔ 完成：新 PAYLOAD_POSITION =", newPayloadPos, "新 PRELUDE_POSITION =", newPreludePos, "最终大小:", final.length);
