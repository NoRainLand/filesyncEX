/**
 * 把 DSH（DeepSeek Harness）会话事件流导出为 Markdown，并追加到 docs/CHAT_HISTORY.md。
 *
 * 为什么需要它：`docs/CHAT_HISTORY.md` 之前由 Copilot transcript 导出（324 轮）；
 * 本仓库后续的开发对话在 DSH 会话里（`<DSH_HOME>/sessions/<workspace>/<sessionId>/session.v3.jsonl.zstd`，
 * 是**多帧 zstd + JSONL 事件流**，Node 的 zstdDecompressSync 只解第一帧，故这里逐帧解压后拼接）。
 *
 * 特性：
 *  - 保留原文档内容，只替换结尾的「记录结束（第 N 轮）」页脚，接着往下追加（轮次连续编号）；
 *  - 同名会话**重复执行会先移除上次导出的该会话段落**（按 `<!-- fsex-session: <id> -->` 标记），避免重复堆积；
 *  - 用户消息 / 助手回复**全文保留**，工具调用列名称 + 参数摘要，工具结果只记成功标记（完整事件流仍在 DSH 会话文件里）。
 *
 * 用法（仓库根执行）：
 *   node _dev/export-dsh-chat.mjs                     # 取当前 DSH 会话（环境变量 DSH_SESSION_ID）
 *   node _dev/export-dsh-chat.mjs <sessionId> [out]   # 指定会话 / 输出文件
 *   node _dev/export-dsh-chat.mjs --stdout            # 只打印不写文件（预览）
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";

const root = process.cwd();
const args = process.argv.slice(2);
const stdoutOnly = args.includes("--stdout");
const positional = args.filter((a) => !a.startsWith("--"));
const sessionId = positional[0] ?? process.env.DSH_SESSION_ID;
const outFile = path.resolve(root, positional[1] ?? "docs/CHAT_HISTORY.md");
if (!sessionId) {
  console.error("未指定会话：用法 node _dev/export-dsh-chat.mjs <sessionId> [out.md]（或设置 DSH_SESSION_ID）");
  process.exit(1);
}

const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
const sessionsRoot = path.join(dshHome, "sessions");

/** 在 sessions/<workspace>/<sessionId>/ 里找到会话文件（工作区目录名随 cwd 变化） */
function findSessionFile(id) {
  for (const ws of fs.readdirSync(sessionsRoot)) {
    const dir = path.join(sessionsRoot, ws, id);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".jsonl.zstd") || f.endsWith(".jsonl")) return path.join(dir, f);
    }
  }
  return null;
}

const sessionFile = findSessionFile(sessionId);
if (!sessionFile) {
  console.error(`未找到会话文件：${sessionId}（在 ${sessionsRoot} 下查找）`);
  process.exit(1);
}

/** 多帧 zstd：按魔数找每帧起点，逐帧解压后拼接 */
function readEvents(file) {
  const buf = fs.readFileSync(file);
  if (!file.endsWith(".zstd")) return buf.toString("utf8").split("\n").filter(Boolean).map(parseLine).filter(Boolean);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts = [];
  let i = -1;
  while ((i = buf.indexOf(magic, i + 1)) !== -1) starts.push(i);
  const parts = [];
  for (const s of starts) {
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(s)));
    } catch {
      /* 非帧起点或截断帧，跳过 */
    }
  }
  return Buffer.concat(parts).toString("utf8").split("\n").filter(Boolean).map(parseLine).filter(Boolean);
}
function parseLine(l) {
  try {
    return JSON.parse(l);
  } catch {
    return null;
  }
}

const events = readEvents(sessionFile);
const fmtTime = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** 事件流 → 轮次结构 */
function buildTurns(events) {
  const turns = new Map(); // turn → { user, steps: Map<step, {texts, tools, results}>, start, end }
  const ensure = (n) => {
    if (!turns.has(n)) turns.set(n, { user: null, steps: new Map(), start: 0, end: 0 });
    return turns.get(n);
  };
  const ensureStep = (t, s) => {
    if (!t.steps.has(s)) t.steps.set(s, { texts: [], reasoning: [], tools: [], results: [] });
    return t.steps.get(s);
  };
  // 轮次顺序（turn/start 先后）—— 用户消息 / 上下文注入可能先于 turn/start 到达
  const started = [];
  for (const e of events) {
    if (e.type === "turn/start") {
      ensure(e.data.turn).start = e.time;
      if (!started.includes(e.data.turn)) started.push(e.data.turn);
    }
  }
  let currentTurn = started[0] ?? 1;
  /** 归位到「当前轮」：已有用户消息则顺延到下一个已开始的轮次 */
  const targetTurn = () => {
    if (!ensure(currentTurn).user) return currentTurn;
    const idx = started.indexOf(currentTurn);
    const next = idx >= 0 ? started[idx + 1] : undefined;
    if (next !== undefined) currentTurn = next;
    return currentTurn;
  };
  /** 运行时注入的上下文（runtime-context / 策略变更通知）与用户手写消息区分展示 */
  const isInjected = (text) =>
    /^<runtime-context>/.test(text) || /^Current runtime context\./.test(text) || /^The approval policy changed/.test(text);

  for (const e of events) {
    const d = e.data ?? {};
    switch (e.type) {
      case "turn/end":
        ensure(d.turn).end = e.time;
        break;
      case "user/message": {
        const all = (d.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "");
        const human = all.filter((t) => t.trim() && !isInjected(t.trim())).join("\n\n").trim();
        const injected = all.filter((t) => isInjected(t.trim())).join("\n\n").trim();
        const t = ensure(targetTurn());
        if (human && !t.user) t.user = { text: human, time: e.time };
        if (injected) t.context = t.context ? t.context + "\n\n" + injected : injected;
        break;
      }
      case "assistant/message": {
        const t = ensure(d.turn);
        const step = ensureStep(t, d.step ?? 1);
        for (const c of d.message?.content ?? []) {
          if (c.type === "text" && c.text?.trim()) step.texts.push(c.text.trim());
          else if (c.type === "reasoning" && c.text?.trim()) step.reasoning.push(c.text.trim());
          else if (c.type === "tool-call") step.tools.push({ name: c.name, args: c.arguments });
        }
        break;
      }
      case "tool/result": {
        const t = ensure(d.turn);
        const step = ensureStep(t, d.step ?? 1);
        const text = (d.message?.content ?? []).flatMap((c) => c.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
        step.results.push({ name: d.message?.source?.callId ?? "", chars: text.length, ok: !/^\s*(\[exit code: [1-9]|Error|失败)/.test(text) });
        break;
      }
      default:
        break;
    }
  }
  function lastTurn() {
    return turns.size ? Math.max(...turns.keys()) : null;
  }
  return [...turns.entries()].sort((a, b) => a[0] - b[0]);
}

const turns = buildTurns(events);
const userCount = turns.filter(([, t]) => t.user).length;
const assistantCount = events.filter((e) => e.type === "assistant/message").length;
const toolCount = events.filter((e) => e.type === "tool/call").length;
const first = events.find((e) => e.type === "turn/start")?.time ?? Date.now();
const last = [...events].reverse().find((e) => e.time)?.time ?? Date.now();

/** 已存在的最大轮次（用于连续编号）与上次本会话段落（用于去重） */
function existingState(file) {
  if (!fs.existsSync(file)) return { content: "", maxRound: 0 };
  const content = fs.readFileSync(file, "utf8");
  let maxRound = 0;
  for (const m of content.matchAll(/^## 第 (\d+) 轮/gm)) maxRound = Math.max(maxRound, Number(m[1]));
  const marker = `<!-- fsex-session: ${sessionId} -->`;
  const idx = content.indexOf(marker);
  if (idx !== -1) {
    // 段落从 marker 前的分隔线开始，到文件末尾（footer 稍后统一重建）
    const cut = content.lastIndexOf("\n---\n", idx);
    return { content: (cut === -1 ? content.slice(0, idx) : content.slice(0, cut)).replace(/\s+$/, "") + "\n", maxRound: maxRoundOf(content.slice(0, cut === -1 ? idx : cut)) };
  }
  // 去掉旧 footer（记录结束），保留其余内容
  return { content: content.replace(/\n*---\n+> 记录结束（第 \d+ 轮）\s*$/m, "").replace(/\s+$/, "") + "\n", maxRound };
}
function maxRoundOf(text) {
  let n = 0;
  for (const m of text.matchAll(/^## 第 (\d+) 轮/gm)) n = Math.max(n, Number(m[1]));
  return n;
}

const { content: base, maxRound } = existingState(outFile);
let round = maxRound;
const lines = [];
lines.push("");
lines.push("---");
lines.push("");
lines.push(`<!-- fsex-session: ${sessionId} -->`);
lines.push("");
lines.push(`# 🆕 DSH 会话 \`${sessionId.slice(0, 18)}…\``);
lines.push("");
lines.push("| 项目 | 值 |");
lines.push("|---|---|");
lines.push(`| 会话 ID | \`${sessionId}\` |`);
lines.push(`| 工作目录 | \`${events.find((e) => e.type === "session")?.cwd ?? root}\` |`);
lines.push(`| 开始时间 | ${fmtTime(first)} |`);
lines.push(`| 导出时间 | ${fmtTime(Date.now())} |`);
lines.push(`| 用户消息 | ${userCount} 条 |`);
lines.push(`| 助手消息 | ${assistantCount} 条 |`);
lines.push(`| 工具调用 | ${toolCount} 次 |`);
lines.push(`| 轮次 | 第 ${round + 1} – ${round + turns.length} 轮（承接上文编号） |`);
lines.push("");

for (const [, t] of turns) {
  round++;
  lines.push("");
  lines.push(`## 第 ${round} 轮 · ${fmtTime(t.start || t.user?.time || Date.now())}`);
  lines.push("");
  lines.push("### 👤 用户");
  lines.push("");
  lines.push(t.user?.text ? t.user.text : "（本轮无用户手写消息）");
  if (t.context) {
    lines.push("");
    lines.push("<details><summary>ℹ️ 运行时注入的上下文（非用户手写）</summary>");
    lines.push("");
    for (const line of t.context.split("\n")) lines.push(`> ${line}`);
    lines.push("");
    lines.push("</details>");
  }
  lines.push("");
  lines.push("### 🤖 助手");
  lines.push("");
  for (const [stepNo, s] of [...t.steps.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`<!-- step ${stepNo} -->`);
    for (const txt of s.texts) {
      lines.push("");
      lines.push(txt);
    }
    if (s.tools.length) {
      lines.push("");
      lines.push("**🔧 工具调用**");
      lines.push("");
      for (const tool of s.tools) {
        let argSummary = "";
        try {
          const a = JSON.parse(tool.args ?? "{}");
          argSummary = a.command ?? a.description ?? a.file_path ?? a.path ?? a.pattern ?? a.objective ?? "";
          if (typeof argSummary === "string" && argSummary.length > 200) argSummary = argSummary.slice(0, 200) + "…";
          argSummary = argSummary.replace(/\s+/g, " ");
        } catch {
          argSummary = String(tool.args ?? "").slice(0, 200);
        }
        lines.push(`- \`${tool.name}\`${argSummary ? " — " + argSummary : ""}`);
      }
    }
    if (s.reasoning.length) {
      lines.push("");
      lines.push("<details><summary>🧠 思考过程</summary>");
      lines.push("");
      for (const r of s.reasoning) lines.push(`> ${r.replace(/\n/g, "\n> ")}`);
      lines.push("");
      lines.push("</details>");
    }
  }
  lines.push("");
}

const body = lines.join("\n");
const footer = `\n---\n\n> 记录结束（第 ${round} 轮）\n`;
const out = base + body + footer;

if (stdoutOnly) {
  process.stdout.write(out.slice(base.length));
} else {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, out, "utf8");
  console.log(
    `✔ 已写入 ${path.relative(root, outFile)}：本次追加第 ${maxRound + 1}–${round} 轮` +
      `（会话 ${sessionId.slice(0, 8)}，用户 ${userCount} / 助手 ${assistantCount} / 工具 ${toolCount}），文件 ${(out.length / 1024 / 1024).toFixed(2)} MB`
  );
}
