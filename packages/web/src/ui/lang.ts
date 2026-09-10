/** 代码语言下拉：可选语言与显示名（app.ts 与 ui/messages.ts 共用） */
export const LANG_LIST = ["ts", "js", "python", "ini", "bat", "json", "sql", "html", "css"];

const LANG_LABEL: Record<string, string> = {
  ts: "TypeScript",
  js: "JavaScript",
  python: "Python",
  ini: "INI / Config",
  bat: "Batch (.bat)",
  json: "JSON",
  sql: "SQL",
  html: "HTML",
  css: "CSS",
};

export const langLabel = (l: string): string => LANG_LABEL[l] ?? l;
