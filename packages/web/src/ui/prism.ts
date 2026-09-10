import Prism from "prismjs";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-python";
import "prismjs/components/prism-ini";
import "prismjs/components/prism-batch";
import "prismjs/components/prism-json";
import "prismjs/components/prism-sql";

/**
 * Prism 语法高亮（从 app.ts 抽到独立模块）。
 * 关键：语法组件必须在 Prism 之后被 import，且这些副作用 import 要与使用它的 highlightCode 在同一模块，
 * 否则打包后可能出现「Prism is not defined」（模块初始化顺序被打散）。
 */
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 代码语言 → Prism 语法名（html 用 markup，bat 用 batch） */
const PRISM_LANG: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  python: "python",
  ini: "ini",
  bat: "batch",
  json: "json",
  sql: "sql",
  html: "markup",
  css: "css",
};

/** Prism 高亮：无对应语法时原样转义返回 */
export function highlightCode(code: string, lang: string): string {
  const pl = PRISM_LANG[lang] || "typescript";
  const grammar = Prism.languages[pl];
  if (!grammar) return esc(code);
  return Prism.highlight(code, grammar, pl);
}
