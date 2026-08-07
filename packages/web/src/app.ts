import { html, unsafeCSS, LitElement, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import QRCode from "qrcode";
import type { DeviceInfoT, MsgDataT } from "@filesyncex/protocol";
import { getDevice, saveDevice } from "./device.js";
import { WsClient } from "./ws.js";
import { uploadFile } from "./api.js";
import appCss from "./app.css?inline";

/* ================= helpers ================= */

const p2 = (n: number) => String(n).padStart(2, "0");
/** 消息时间：统一 YYYY/MM/DD HH:MM（年月日时分） */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
/** 日期分组标签（对齐原型）：
 *  今天 → 今天 · YYYY/MM/DD；昨天 → 昨天 · YYYY/MM/DD
 *  更早：桌面 → 「更早」；移动 → 7 天内「MM/DD · 周X」、更久「MM/DD」 */
function dayLabel(ts: number, mobile: boolean): string {
  const d = new Date(ts);
  const now = new Date();
  const ymd = (x: Date) => `${x.getFullYear()}/${p2(x.getMonth() + 1)}/${p2(x.getDate())}`;
  const full = ymd(d);
  if (full === ymd(now)) return `今天 · ${full}`;
  const y = new Date(now.getTime() - 86400000);
  if (full === ymd(y)) return `昨天 · ${full}`;
  if (mobile) {
    const md = `${p2(d.getMonth() + 1)}/${p2(d.getDate())}`;
    if (now.getTime() - ts < 7 * 86400000) return `${md} · ${WEEK[d.getDay()]}`;
    return md;
  }
  return "更早";
}
const fmtSize = (n: number): string => {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
};
/** 文件类型中文描述 */
function fmtType(name: string, mime?: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = { sh: "脚本", py: "脚本", js: "脚本", ts: "脚本", txt: "文本", md: "文档", pdf: "PDF", doc: "文档", docx: "文档", xlsx: "表格", xls: "表格", zip: "压缩包", rar: "压缩包", "7z": "压缩包", exe: "程序", ico: "图标", mp3: "音频", wav: "音频", m4a: "音频", mp4: "视频", avi: "视频", mov: "视频", mk4: "视频", webm: "视频", png: "图片", jpg: "图片", jpeg: "图片", gif: "图片", webp: "图片", svg: "图片", bmp: "图片" };
  if (mime?.startsWith("image/")) return "图片";
  if (mime?.startsWith("audio/")) return "音频";
  if (mime?.startsWith("video/")) return "视频";
  return map[ext ?? ""] ?? "文件";
}
/** 文件类型 → 消息 kind（与服务器 kindOf 一致）：用于上传占位卡匹配真实消息尺寸 */
function fileKind(name: string, mime?: string): "image" | "audio" | "video" | "file" {
  if (mime) {
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("audio/")) return "audio";
    if (mime.startsWith("video/")) return "video";
  }
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext && ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].includes(ext)) return "image";
  if (ext && ["mp3", "wav", "ogg", "m4a", "flac", "aac"].includes(ext)) return "audio";
  if (ext && ["mp4", "webm", "mov", "mkv", "avi"].includes(ext)) return "video";
  return "file";
}

/** 波形条：优先用服务器生成的真实峰值；无数据时默认全部平线（同高度） */
const waveBars = (peaks?: number[] | null) => {
  const arr = peaks && peaks.length ? peaks : Array.from({ length: 96 }, () => 0.4);
  return arr.map((v) => html`<i style="height:${Math.max(6, Math.round(v * 100))}%"></i>`);
};

/* ================= One Dark 语法高亮 ================= */
const HIGHLIGHT_LANGS: Record<string, RegExp> = {
  ts: /(\/\*[\s\S]*?\*\/|\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(\d+(?:\.\d+)?)\b|\b(interface|type|enum|class|function|const|let|var|return|if|else|for|while|switch|case|break|continue|new|extends|implements|import|export|from|async|await|public|private|protected|readonly|static|this|super|typeof|instanceof|in|of|void|never|unknown|any|string|number|boolean|null|undefined)\b|\b([A-Za-z_$][\w$]*)(?=\s*\()/gm,
  js: /(\/\*[\s\S]*?\*\/|\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(\d+(?:\.\d+)?)\b|\b(const|let|var|function|return|if|else|for|while|switch|case|break|continue|new|class|extends|import|export|from|async|await|typeof|instanceof|in|of|null|undefined|this|super|try|catch|finally|throw)\b|\b([A-Za-z_$][\w$]*)(?=\s*\()/gm,
  python: /(#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|"""(?:[^"\\]|\\.)*"""|'''[^'\\]*''')|\b(\d+(?:\.\d+)?)\b|\b(def|class|return|if|elif|else|for|while|in|not|and|or|import|from|as|with|try|except|finally|raise|pass|break|continue|lambda|yield|global|nonlocal|None|True|False|async|await|print|len|range|type|is)\b|\b([A-Za-z_]\w*)(?=\s*\()/gm,
  ini: /(^[#;].*$)|(\[[^\]]*\])|(^[ \t]*[A-Za-z0-9_.-]+(?=[ \t]*=))/gm,
  bat: /(^::.*$|^[ \t]*@?echo[ \t].*$)|(%[^%]+%|"[^"]*")|(^[ \t]*@?[A-Za-z][A-Za-z0-9]*\b)/gm,
  json: /("[^"\\]*(?:\\.[^"\\]*)*")(?=\s*:)|("[^"\\]*(?:\\.[^"\\]*)*")|\b(true|false|null)\b|\b(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/gm,
  sql: /(--.*$|\/\*[\s\S]*?\*\/)|('(?:[^'\\]|\\.)*')|\b(\d+(?:\.\d+)?)\b|\b(SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|DROP|ALTER|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AND|OR|NOT|NULL|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|AS|DISTINCT|PRIMARY|KEY|FOREIGN|REFERENCES|UNIQUE|INDEX|IF|EXISTS|CASE|WHEN|THEN|ELSE|END|BEGIN|COMMIT|ROLLBACK|TRANSACTION|INT|VARCHAR|TEXT|BOOL|DATE|DATETIME|INTEGER)\b/gmi,
  html: /(&lt;!--[\s\S]*?--&gt;)|(&lt;\/?[a-zA-Z][\w-]*)|(&lt;[a-zA-Z][\w-]*(?=[\s\/&gt;]))|(&gt;|&lt;\/|&lt;)|("[^"]*"|'[^']*')|(\b[a-zA-Z-]+(?==))/gm,
  css: /(\/\*[\s\S]*?\*\/)|(#[0-9a-fA-F]{3,8}\b|\b[a-zA-Z-]+(?=\s*:))|(\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms)?\b)|(\.[a-zA-Z-][\w-]*|#[a-zA-Z-][\w-]*|:[a-zA-Z-]+|\*|\b[a-zA-Z-]+(?=\s*\{))/gm,
};
const HIGHLIGHT_GROUPS: Record<string, string[]> = {
  ts: ["com", "str", "num", "kw", "fn"],
  js: ["com", "str", "num", "kw", "fn"],
  python: ["com", "str", "num", "kw", "fn"],
  ini: ["com", "sec", "key"],
  bat: ["com", "str", "kw"],
  json: ["key", "str", "kw", "num"],
  sql: ["com", "str", "num", "kw"],
  html: ["com", "tag", "tag", "op", "str", "attr"],
  css: ["com", "prop", "num", "sel"],
};
const TOKEN_CLASS: Record<string, string> = { com: "tok-com", str: "tok-str", num: "tok-num", kw: "tok-kw", fn: "tok-fn", sec: "tok-typ", key: "tok-prop", tag: "tok-var", op: "tok-op", attr: "tok-attr", sel: "tok-typ", prop: "tok-prop" };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function highlightCode(code: string, lang: string): string {
  const re = HIGHLIGHT_LANGS[lang] || HIGHLIGHT_LANGS.ts!;
  const groups = HIGHLIGHT_GROUPS[lang] || HIGHLIGHT_GROUPS.ts!;
  let html = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (re.lastIndex <= last) { re.lastIndex = last + 1; last = re.lastIndex; continue; }
    if (m.index > last) html += esc(code.slice(last, m.index));
    let cls: string | null = null;
    for (let g = 1; g < m.length; g++) {
      if (m[g] !== undefined) { cls = TOKEN_CLASS[groups[g - 1]!] || null; break; }
    }
    html += cls ? `<span class="${cls}">${esc(m[0])}</span>` : esc(m[0]);
    last = re.lastIndex;
  }
  if (last < code.length) html += esc(code.slice(last));
  return html;
}

/* ================= 图标（Heroicons） ================= */
const I_QR = html`<svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" width="20" height="20"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0 1 3.75 9.375v-4.5ZM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 0 1-1.125-1.125v-4.5ZM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0 1 13.5 9.375v-4.5Z"/><path stroke-linecap="round" stroke-linejoin="round" d="M6.75 6.75h.75v.75h-.75v-.75ZM6.75 16.5h.75v.75h-.75v-.75ZM16.5 6.75h.75v.75h-.75v-.75ZM13.5 13.5h.75v.75h-.75v-.75ZM13.5 19.5h.75v.75h-.75v-.75ZM19.5 13.5h.75v.75h-.75v-.75ZM19.5 19.5h.75v.75h-.75v-.75ZM16.5 16.5h.75v.75h-.75v-.75Z"/></svg>`;
const I_SUN = html`<svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" width="20" height="20"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z"/></svg>`;
const I_MOON = html`<svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" width="20" height="20"><path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z"/></svg>`;
const I_PLUS = html`<svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" width="22" height="22"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>`;
const I_SEND = html`<svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" width="20" height="20"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5"/></svg>`;
const I_CLIP = html`<svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" width="20" height="20"><path stroke-linecap="round" stroke-linejoin="round" d="m18.375 12.739-7.693 7.693a4.5 4.5 0 0 1-6.364-6.364l10.94-10.94A3 3 0 1 1 19.5 7.372L8.552 18.32m.009-.01-.01.01m5.699-9.941-7.81 7.81a1.5 1.5 0 0 0 2.112 2.13"/></svg>`;
const I_BRACE = html`<svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" width="20" height="20"><path stroke-linecap="round" stroke-linejoin="round" d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5"/></svg>`;
const I_FILE = html`<svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" width="20" height="20"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"/></svg>`;
const I_IMG = html`<svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" width="20" height="20"><path stroke-linecap="round" stroke-linejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>`;
const I_AUDIO = html`<svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" width="20" height="20"><path stroke-linecap="round" stroke-linejoin="round" d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z"/></svg>`;
const I_VIDEO = html`<svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" width="20" height="20"><path stroke-linecap="round" stroke-linejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"/></svg>`;
const I_COPY = html`<svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" width="14" height="14"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75"/></svg>`;
const I_DOWN = html`<svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" width="14" height="14"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3"/></svg>`;
const I_LINK = html`<svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" width="14" height="14"><path stroke-linecap="round" stroke-linejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244"/></svg>`;
const I_UP = html`<svg fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24" width="15" height="15"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"/></svg>`;
const I_PLAY = html`<svg fill="currentColor" viewBox="0 0 24 24" width="16" height="16"><path d="M8 5.5v13l11-6.5z"/></svg>`;
const I_PAUSE = html`<svg fill="currentColor" viewBox="0 0 24 24" width="16" height="16"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>`;
const I_TRASH = html`<svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" width="14" height="14"><path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"/></svg>`;

/* ================= 主组件 ================= */

export class FilesyncApp extends LitElement {
  static styles = unsafeCSS(appCss);

  static properties = {
    msgs: { state: true }, peers: { state: true }, self: { state: true }, connected: { state: true },
    connState: { state: true }, notice: { state: true },
    text: { state: true }, codeMode: { state: true }, codeLang: { state: true }, codeText: { state: true },
    uploads: { state: true }, sheet: { state: true }, preview: { state: true }, nick: { state: true },
    httpUrl: { state: true }, theme: { state: true }, toastText: { state: true }, toastShow: { state: true }, toastLeaving: { state: true }, playingId: { state: true }, qrDataUrl: { state: true }, wavePeaks: { state: true },
  };

  msgs: MsgDataT[] = [];
  peers: DeviceInfoT[] = [];
  self: DeviceInfoT | null = null;
  connected = false;
  /** WS 连接状态：connecting 连接中 / connected 正常 / disconnected 断开 */
  connState: "connecting" | "connected" | "disconnected" = "connecting";
  /** 服务器通知（异常/维护/关闭）：非空时弹不可关闭大窗 */
  notice: { level: string; message: string } | null = null;
  text = "";
  codeMode = false;
  codeLang = "ts";
  codeText = "";
  uploads: { key: string; name: string; pct: number; size: number; kind: string; fail?: boolean }[] = [];
  playingId: string | null = null;
  sheet: "attach" | "progress" | "settings" | "qr" | null = null;
  preview: { kind: string; msg: MsgDataT } | null = null;
  nick = "";
  httpUrl = "";
  qrDataUrl = "";
  theme: "light" | "dark" = "light";
  toastText = "";
  toastShow = false;
  toastLeaving = false;

  private ws: WsClient | null = null;
  private tipTimer: number | undefined;
  private tipClearTimer: number | undefined;
  private audioEl: HTMLAudioElement | null = null;
  private audioMsgId: string | null = null;
  /** 音频波形缓存：msg.id → 峰值数组（null = 加载失败/不支持） */
  wavePeaks: Record<string, number[] | null> = {};

  constructor() {
    super();
    this.self = getDevice();
    this.nick = this.self.deviceName;
    this.theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.httpUrl = `${location.protocol}//${location.host}`;
    // 向服务器要真实局域网 IP（二维码/地址用真实地址，避免 127.0.0.1）
    void fetch("/api/health")
      .then((r) => r.json())
      .then((d) => {
        if (d && d.lanIp && d.lanIp !== "127.0.0.1") {
          this.httpUrl = `${location.protocol}//${d.lanIp}${d.port ? `:${d.port}` : ""}`;
        }
      })
      .catch(() => { /* 保持 location.host */ });
    this.ws = new WsClient(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`, {
      onConnecting: () => { this.connState = "connecting"; },
      onOpen: () => { this.connected = true; this.connState = "connected"; if (this.self) this.ws?.send({ type: "hello", device: this.self }); },
      onClose: () => { this.connected = false; this.connState = "disconnected"; },
      onNotice: (level, message) => { this.showNotice(level, message); },
      onWelcome: (_s, msgs, peers) => { this.msgs = msgs; this.peers = peers; this.scrollToLatest(); },
      onAdd: (msg) => { if (!this.msgs.some((m) => m.id === msg.id)) { this.msgs = [...this.msgs, msg]; this.scrollToLatest(); } },
      onDel: (id) => { this.msgs = this.msgs.filter((m) => m.id !== id); },
      onPeers: (peers) => { this.peers = peers; },
      onRenamed: (device) => {
        if (this.self && device.deviceId === this.self.deviceId) { this.self = { ...device }; this.nick = device.deviceName; }
        this.peers = this.peers.map((p) => (p.deviceId === device.deviceId ? device : p));
      },
    });
    this.ws.connect();
    window.addEventListener("resize", this.onResize);
    // 主界面任何位置滚轮都转发到滚动容器（桌面 .container / 移动 .list）
    this.addEventListener("wheel", this.onHostWheel);
  }
  disconnectedCallback(): void { window.removeEventListener("resize", this.onResize); this.removeEventListener("wheel", this.onHostWheel); this.ws?.close(); super.disconnectedCallback(); }
  private onResize = (): void => { this.requestUpdate(); this.scrollToLatest(); };
  /** 全局滚轮：弹层/预览打开时不劫持；否则把滚轮统一转发到当前滚动容器 */
  private onHostWheel = (e: WheelEvent): void => {
    if (this.sheet || this.preview) return; // 弹层/预览内部自己滚
    const scroller = this.shadowRoot?.querySelector<HTMLElement>(window.innerWidth <= 640 ? ".list" : ".container");
    if (!scroller) return;
    const inScroller = scroller.contains(e.target as Node);
    if (!inScroller && scroller.scrollHeight > scroller.clientHeight) {
      scroller.scrollTop += e.deltaY;
      e.preventDefault();
    }
  };

  /* 滚动到最新消息：桌面端最新在顶部（scrollTop=0），移动端最新在底部（scrollHeight） */
  private scrollToLatest(): void {
    requestAnimationFrame(() => {
      const r = this.shadowRoot;
      const mobile = window.innerWidth <= 640;
      const el = mobile ? r?.querySelector<HTMLElement>(".list") : r?.querySelector<HTMLElement>(".container");
      if (el) el.scrollTop = mobile ? el.scrollHeight : 0;
    });
  }

  /* ---------- 发送 ---------- */
  private sendText(): void {
    const t = this.text.trim();
    if (!t || !this.self) return;
    this.ws?.send({ type: "send", msg: { kind: "text", text: t } });
    this.text = "";
    this.clearComposer();
  }
  private sendCode(): void {
    const c = this.codeText.trim();
    if (!c || !this.self) return;
    this.ws?.send({ type: "send", msg: { kind: "code", code: { lang: this.codeLang, content: c } } });
    this.codeText = "";
    this.clearComposer();
    this.codeMode = false; // 发送后自动退出代码模式，变回普通输入
  }
  private clearComposer(): void {
    const r = this.shadowRoot;
    r?.querySelectorAll<HTMLInputElement>(".input").forEach((el) => (el.value = ""));
    const ta = r?.querySelector<HTMLTextAreaElement>(".code-editor textarea");
    if (ta && ta.value) ta.value = "";
  }
  private deleteMsg(id: string): void { this.ws?.send({ type: "del", id }); this.flash("消息已删除"); }
  private copyImage(m: MsgDataT): void {
    const url = m.file?.url;
    if (!url) return this.flash("图片地址无效");
    // 剪贴板图片写入仅在 HTTPS/localhost 安全上下文可用
    if (!window.ClipboardItem || !navigator.clipboard) {
      this.flash("当前浏览器不支持复制图片（需 HTTPS 安全上下文）");
      return;
    }
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d")?.drawImage(img, 0, 0);
      c.toBlob((b) => {
        if (!b) return this.flash("图片复制失败");
        navigator.clipboard
          .write([new ClipboardItem({ "image/png": b })])
          .then(() => this.flash("图片已复制"))
          .catch(() => this.flash("复制失败，请手动保存图片"));
      }, "image/png");
    };
    img.onerror = () => this.flash("图片加载失败");
    img.src = url;
  }
  /** 向服务器加载音频真实波形（只请求一次） */
  private loadWave(m: MsgDataT): void {
    if (this.wavePeaks[m.id] !== undefined) return;
    const key = m.file?.key;
    if (!key) { this.wavePeaks = { ...this.wavePeaks, [m.id]: null }; return; }
    this.wavePeaks = { ...this.wavePeaks, [m.id]: null }; // 占位防重复请求
    fetch(`/api/wave/${encodeURIComponent(key)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => { this.wavePeaks = { ...this.wavePeaks, [m.id]: d.peaks ?? null }; })
      .catch(() => { this.wavePeaks = { ...this.wavePeaks, [m.id]: null }; });
  }
  /** 音频统一走服务器转码流（/api/stream/<key> → WAV，任意格式浏览器都能播） */
  private audioSrc(m: MsgDataT): string | null {
    const key = m.file?.key;
    return key ? `/api/stream/${encodeURIComponent(key)}` : (m.file?.url ?? null);
  }
  /** 确保当前音频元素对应消息 m，返回它 */
  private ensureAudio(m: MsgDataT): HTMLAudioElement | null {
    const url = this.audioSrc(m);
    if (!url) return null;
    if (this.audioEl && this.audioMsgId === m.id) return this.audioEl;
    if (this.audioEl) this.audioEl.pause();
    const a = new Audio(url);
    a.addEventListener("ended", () => { this.playingId = null; this.audioEl = null; this.audioMsgId = null; });
    a.addEventListener("error", () => { this.playingId = null; this.audioEl = null; this.audioMsgId = null; });
    a.addEventListener("timeupdate", () => this.updateWaveInd(m.id));
    this.audioEl = a;
    this.audioMsgId = m.id;
    return a;
  }
  private toggleAudio(m: MsgDataT): void {
    if (this.playingId === m.id) { this.audioEl?.pause(); this.playingId = null; return; }
    const a = this.ensureAudio(m);
    if (!a) return;
    this.playingId = m.id;
    void a.play().catch(() => { this.playingId = null; this.audioEl = null; this.audioMsgId = null; });
  }
  /** 点击/拖动波形条跳转播放进度 */
  private seekAudio(m: MsgDataT, e: MouseEvent): void {
    const a = this.ensureAudio(m);
    if (!a) return;
    const wave = e.currentTarget as HTMLElement;
    const r = wave.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    if (a.duration && isFinite(a.duration)) a.currentTime = ratio * a.duration;
    this.updateWaveInd(m.id, ratio);
    if (a.paused) { this.playingId = m.id; void a.play().catch(() => { this.playingId = null; this.audioEl = null; this.audioMsgId = null; }); }
  }
  /** 更新波形进度：已播 bar 变薄荷、未播灰；进度线穿过的 bar 用横向渐变平滑过渡（线性前进，非整格跳变）+ 竖线 .ind 定位 */
  /** 更新波形播放进度：已播 bar 整根变薄荷（.played 类），未播灰；竖线 .ind 定位（直接改 DOM，不经 lit 重渲染） */
  private updateWaveInd(msgId: string, forced?: number): void {
    const wave = this.shadowRoot?.querySelector<HTMLElement>(`.card.audio[data-id="${msgId}"] .wave`);
    if (!wave) return;
    const a = this.audioEl && this.audioMsgId === msgId ? this.audioEl : null;
    const ratio = forced ?? (a && a.duration ? a.currentTime / a.duration : 0);
    const ind = wave.querySelector(".ind") as HTMLElement | null;
    if (ind) ind.style.left = `${Math.round(ratio * 100)}%`;
    // 整格跳变：已播 bar 全加 .played（薄荷），未播移除（灰）
    const bars = Array.from(wave.querySelectorAll("i:not(.ind):not(.prog)"));
    const n = bars.length;
    const played = Math.round(ratio * n);
    bars.forEach((bar, i) => bar.classList.toggle("played", i < played));
    // 暂停/播放中（进度 0<x<1）指示器保持显示；未播放/播完隐藏
    wave.classList.toggle("show-ind", ratio > 0 && ratio < 1);
  }
  /** 昵称规则：仅大小写字母/下划线/数字，最长 10 位 */
  private static readonly NICK_RE = /^[A-Za-z0-9_]{1,10}$/;
  private rename(): void {
    const n = this.nick.trim();
    if (!n) return;
    if (!FilesyncApp.NICK_RE.test(n)) {
      this.flash("昵称仅允许大小写字母、下划线和数字，最长 10 位");
      return;
    }
    this.ws?.send({ type: "rename", name: n });
    if (this.self) { const d = { ...this.self, deviceName: n }; this.self = d; saveDevice(d); }
    this.sheet = null;
  }
  private toggleTheme(): void { this.theme = this.theme === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = this.theme; }
  /** 打开二维码弹层并生成真实二维码 */
  private openQr(): void {
    this.sheet = "qr";
    if (!this.qrDataUrl) {
      QRCode.toDataURL(this.httpUrl, { width: 180, margin: 1, color: { dark: "#1a1a1a", light: "#ffffff" } })
        .then((url) => { this.qrDataUrl = url; })
        .catch(() => { this.flash("二维码生成失败"); });
    }
  }

  /* ---------- 上传 ---------- */
  private async handleFiles(files: FileList | File[] | null): Promise<void> {
    if (!files) return;
    for (const file of Array.from(files as File[])) {
      const key = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const kind = fileKind(file.name, file.type);
      const rec: { key: string; name: string; pct: number; size: number; kind: string; fail?: boolean } = { key, name: file.name, pct: 0, size: file.size, kind };
      this.uploads = [...this.uploads, rec];
      // 在消息列表插入「按类型尺寸的占位卡」（16:9 图片视频 / 播放条音频 / 图标行文件）；真实消息经 WS 广播后替换
      const placeholder: MsgDataT = {
        id: key, kind, sender: this.self ?? { deviceId: "", deviceName: "上传中", color: "#047878", platform: "other" },
        ts: Date.now(), file: { name: file.name, size: file.size },
      };
      this.msgs = [...this.msgs, placeholder];
      this.scrollToLatest();
      try {
        await uploadFile(file, (sent, total) => { rec.pct = Math.round((sent / total) * 100); this.uploads = [...this.uploads]; });
        // 上传成功：移除占位卡（真实消息由 WS onAdd 广播，同 id 去重不冲突）
        this.msgs = this.msgs.filter((m) => m.id !== key);
        this.uploads = this.uploads.filter((x) => x !== rec);
      } catch (e) {
        rec.fail = true; rec.pct = -1; console.error("上传失败:", e); this.uploads = [...this.uploads];
        // 失败：占位卡保持显示（renderMsg 用 rec.fail 显示「上传失败」+ 红色圆环）
        this.msgs = [...this.msgs];
      }
    }
    this.scrollToLatest();
  }
  private onDrop(e: DragEvent): void { e.preventDefault(); void this.handleFiles(e.dataTransfer?.files ?? null); }

  /* ---------- 预览 ---------- */
  private pvZoom = { s: 1, tx: 0, ty: 0, bx: 0, by: 0, init: false };
  private pvDrag = { active: false, sx: 0, sy: 0, stx: 0, sty: 0 };
  private openPreview(kind: string, msg: MsgDataT): void {
    this.pvZoom = { s: 1, tx: 0, ty: 0, bx: 0, by: 0, init: false };
    this.pvDrag.active = false;
    this.preview = { kind, msg };
    // 视频：在用户点击手势内立即播放（autoplay 属性会被浏览器自动播放策略拦截，导致无声音）
    if (kind === "video") {
      void this.updateComplete.then(() => {
        const v = this.shadowRoot?.querySelector<HTMLVideoElement>(".viewer video.ph");
        if (v) {
          // 有声音播放：若被策略拦截则退化静音播放，用户可手动取消静音
          void v.play().catch(() => {
            v.muted = true;
            void v.play().catch(() => { /* 忽略 */ });
          });
        }
      });
    }
  }
  private closePreview(): void { this.preview = null; }
  /** 图片预览滚轮缩放：以鼠标位置为锚点（translate + scale，无 transform-origin 累积漂移） */
  private zoomPreview(e: WheelEvent): void {
    e.preventDefault();
    const img = e.currentTarget as HTMLElement;
    const z = this.pvZoom;
    if (!z.init) {
      const r = img.getBoundingClientRect();
      z.bx = r.left; z.by = r.top; z.init = true;
    }
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const s2 = Math.min(8, Math.max(1, z.s * factor));
    // 鼠标点的图像坐标（未变换坐标系）
    const px = (e.clientX - z.bx - z.tx) / z.s;
    const py = (e.clientY - z.by - z.ty) / z.s;
    z.s = s2;
    z.tx = e.clientX - z.bx - px * z.s;
    z.ty = e.clientY - z.by - py * z.s;
    // 回到原始尺寸：直接清空 transform（避免 translate 残留）
    if (z.s <= 1.001) {
      z.tx = 0; z.ty = 0; z.s = 1; z.init = false;
      img.style.transform = "";
      return;
    }
    img.style.transform = `translate(${z.tx}px, ${z.ty}px) scale(${z.s})`;
  }
  /** 图片按住拖动查看（仅图片放大或大于窗体时） */
  private startDrag(e: MouseEvent): void {
    e.preventDefault();
    const img = e.currentTarget as HTMLElement;
    const z = this.pvZoom;
    if (!z.init) {
      const r = img.getBoundingClientRect();
      z.bx = r.left; z.by = r.top; z.init = true;
    }
    // 仅当放大 或 图片大于窗体时可拖动
    const vr = img.parentElement?.getBoundingClientRect();
    const ir = img.getBoundingClientRect();
    const big = z.s > 1.001 || (!!vr && (ir.width > vr.width + 1 || ir.height > vr.height + 1));
    if (!big) return;
    this.pvDrag = { active: true, sx: e.clientX, sy: e.clientY, stx: z.tx, sty: z.ty };
    window.addEventListener("mousemove", this.onDragMove);
    window.addEventListener("mouseup", this.onDragEnd);
  }
  private onDragMove = (e: MouseEvent): void => {
    const d = this.pvDrag;
    if (!d.active) return;
    const z = this.pvZoom;
    z.tx = d.stx + (e.clientX - d.sx);
    z.ty = d.sty + (e.clientY - d.sy);
    const img = this.shadowRoot?.querySelector(".viewer.open .vbody .ph");
    if (img instanceof HTMLElement) img.style.transform = `translate(${z.tx}px, ${z.ty}px) scale(${z.s})`;
  };
  private onDragEnd = (): void => {
    this.pvDrag.active = false;
    window.removeEventListener("mousemove", this.onDragMove);
    window.removeEventListener("mouseup", this.onDragEnd);
  };
  private previewAction(): void {
    const p = this.preview;
    if (!p) return;
    if (p.kind === "code") {
      const t = p.msg.code?.content ?? "";
      if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => this.flash("代码已复制")).catch(() => this.flash("复制失败，请手动复制"));
    } else {
      this.flash("（原型）已开始下载");
    }
  }
  private flash(t: string): void {
    this.toastText = t;
    this.toastShow = true;
    this.toastLeaving = false;
    clearTimeout(this.tipTimer);
    clearTimeout(this.tipClearTimer);
    this.tipTimer = window.setTimeout(() => {
      // 先移除 show（触发淡出动画，文字保留、窗口不收缩），并加上移标记
      this.toastShow = false;
      this.toastLeaving = true;
      this.tipClearTimer = window.setTimeout(() => { this.toastText = ""; this.toastLeaving = false; }, 700);
    }, 2200);
  }

  /* ---------- 服务器通知（异常/维护/关闭） ---------- */
  private noticeLevelLabel(level: string): string {
    switch (level) {
      case "shutdown": return "服务器关闭";
      case "maintenance": return "服务器维护中";
      case "error": return "服务器异常";
      case "warn": return "服务器警告";
      default: return "服务器通知";
    }
  }
  private showNotice(level: string, message: string): void {
    // 更新内容；若已弹出不可关闭大窗则复用，否则新弹
    this.notice = { level, message };
  }
  private confirmReconnectAt = 0;
  private confirmNotice(): void {
    // 防抖：确认按钮快速连点只触发一次重连
    const now = Date.now();
    if (now - this.confirmReconnectAt < 3000) return;
    this.confirmReconnectAt = now;
    const n = this.notice;
    this.notice = null;
    this.connState = "connecting";
    this.ws?.forceReconnect();
    this.flash(n?.level === "shutdown" ? "正在尝试重新连接…" : "正在重新连接…");
  }

  private renderNotice() {
    if (!this.notice) return nothing;
    const n = this.notice;
    return html`<div class="notice-mask"><div class="notice-panel ${n.level}">
      <div class="ntitle">${this.noticeLevelLabel(n.level)}</div>
      <div class="nbody">${n.message}</div>
      <button class="btn" @click=${this.confirmNotice}>确认并重连</button>
    </div></div>`;
  }
  private copyText(t: string): void { if (navigator.clipboard) navigator.clipboard.writeText(t).catch(() => this.flash("复制失败，请手动复制")); }
  private copyCode(m: MsgDataT): void { if (navigator.clipboard) navigator.clipboard.writeText(m.code?.content ?? "").then(() => this.flash("代码已复制")).catch(() => this.flash("复制失败，请手动复制")); }

  /* ---------- 消息渲染（按天分组；桌面端从新到旧，最新在上） ---------- */
  private renderMessages() {
    if (this.msgs.length === 0) return html`<div class="empty">暂无消息 · 拖拽文件或输入文字开始同步</div>`;
    const mobile = window.innerWidth <= 640;
    const ordered = mobile ? this.msgs : [...this.msgs].reverse();
    const out: unknown[] = [];
    let lastDay = "";
    for (const m of ordered) {
      const day = dayLabel(m.ts, mobile);
      if (day !== lastDay) { out.push(html`<div class="day">${day}</div>`); lastDay = day; }
      out.push(this.renderMsg(m));
    }
    return out;
  }

  /** 文字消息渲染：将 http/https URL 转为可点击链接（点击新窗口打开）；非 URL 原样显示 */
  private renderText(text: string): unknown {
    const urlRe = /(https?:\/\/[^\s<]+)/g;
    const parts: unknown[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = urlRe.exec(text)) !== null) {
      if (m.index > last) parts.push(text.slice(last, m.index));
      const url = m[0];
      parts.push(html`<a class="bubble-link" href="${url}" target="_blank" rel="noopener" @click=${(e: MouseEvent) => this.openTextLink(e, url)}>${url}</a>`);
      last = m.index + url.length;
      i++;
      if (i > 50) break; // 极端情况防死循环
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts.length ? parts : text;
  }

  private openTextLink(e: MouseEvent, url: string): void {
    e.preventDefault();
    e.stopPropagation();
    window.open(url, "_blank", "noopener");
  }

  private renderMsg(m: MsgDataT) {
    const f = m.file;
    // 上传占位卡：结构与真实消息完全一致（对应类型主体 + mm 信息行 + ops 操作行），主体叠磨砂层 + 中心圆形进度环
    if (m.id.startsWith("upload-")) {
      const rec = this.uploads.find((u) => u.key === m.id);
      const pct = rec ? Math.max(0, Math.min(100, rec.pct)) : 0;
      const failed = !!rec?.fail;
      // 按文件类型决定占位卡结构与尺寸（匹配真实消息）：image/video=16:9，audio=播放条，file=图标行
      const uk = (rec?.kind ?? m.kind) as string;
      const media = uk === "image" || uk === "video";
      const R = media ? 30 : uk === "audio" ? 20 : 16;
      const C = 2 * Math.PI * R;
      const ringSize = media ? 68 : uk === "audio" ? 48 : 40;
      const ring = html`<div class="ph-ring ${failed ? "fail" : ""}">
        <svg viewBox="0 0 ${ringSize} ${ringSize}" width="${ringSize}" height="${ringSize}">
          <circle cx="${ringSize / 2}" cy="${ringSize / 2}" r="${R}" fill="none" stroke="var(--line)" stroke-width="5"/>
          <circle cx="${ringSize / 2}" cy="${ringSize / 2}" r="${R}" fill="none" stroke="${failed ? "var(--pink)" : "var(--primary)"}" stroke-width="5" stroke-linecap="round"
            stroke-dasharray="${C}" stroke-dashoffset="${failed ? 0 : C * (1 - pct / 100)}" transform="rotate(-90 ${ringSize / 2} ${ringSize / 2})"/>
        </svg>
        <span class="ph-pct">${failed ? "!" : pct + "%"}</span>
      </div>`;
      // 磨砂层（盖主体区）——由 CSS .ph-blur 提供
      const blur = html`<div class="ph-blur"></div>`;
      // 主体内容（对应真实消息的缩略图 / 播放条 / 图标行骨架）
      let phBody: unknown;
      if (media) {
        phBody = html`<div class="ph-body">${blur}<span class="ph-icon-bg">${uk === "video" ? html`<span class="ph-vplay">▶</span>` : I_IMG}</span>${ring}</div>`;
      } else if (uk === "audio") {
        phBody = html`<div class="ph-body audio">${blur}<div class="ph-ap"><span class="ph-play">${I_PLAY}</span><div class="ph-wave">${waveBars()}</div></div>${ring}</div>`;
      } else {
        phBody = html`<div class="ph-body file">${blur}<span class="ph-ic">${I_FILE}</span>${ring}</div>`;
      }
      // 信息行（同真实消息 .mm：文件名 + 大小）
      const mm = html`<div class="ph-mm"><span class="name">${failed ? "上传失败" : f?.name ?? "上传中…"}</span><span class="size">${f ? fmtSize(f.size) : ""}</span></div>`;
      // 操作行（同真实消息 .ops：下载占位按钮）
      const ops = html`<div class="ph-ops"><span class="btn secondary ph-down">${I_DOWN}下载</span></div>`;
      return html`<div class="msg">
        <div class="avatar">${(m.sender.deviceName[0] ?? "?").toUpperCase()}</div>
        <div class="body">
          <div class="head"><span class="who">${m.sender.deviceName}</span><time>${fmtTime(m.ts)}</time></div>
          <div class="card upload-ph ${uk}">
            ${phBody}
            ${mm}
            ${ops}
          </div>
        </div>
      </div>`;
    }
    const delBtn = html`<button class="del-corner" title="删除" @click=${() => this.deleteMsg(m.id)}>${I_TRASH}</button>`;
    const copyBtn = html`<button class="btn" @click=${() => this.copyText(m.text ?? "")}>${I_COPY}复制</button>`;
    const copyCodeBtn = html`<button class="btn" @click=${() => this.copyCode(m)}>${I_COPY}复制</button>`;
    const copyImgBtn = html`<button class="btn" @click=${() => this.copyImage(m)}>${I_COPY}复制</button>`;
    const downBtn = html`<a class="btn" href="${f?.url ?? "#"}" download>${I_DOWN}下载</a>`;
    const head = html`<span class="who">${m.sender.deviceName}</span>${this.self && m.sender.deviceId === this.self.deviceId ? html`<span class="me">本机</span>` : ""}<time>${fmtTime(m.ts)}</time>`;

    let content: unknown;
    switch (m.kind) {
      case "text":
        content = html`<div class="card text"><div class="bubble">${this.renderText(m.text ?? "")}</div><div class="ops">${copyBtn}</div>${delBtn}</div>`;
        break;
      case "code":
        content = html`<div class="card code"><div class="code-head"><span class="lang">${m.code?.lang ?? "code"}</span></div><pre @click=${() => this.openPreview("code", m)}>${unsafeHTML(highlightCode(m.code?.content ?? "", m.code?.lang ?? "ts"))}</pre><div class="ops">${copyCodeBtn}</div>${delBtn}</div>`;
        break;
      case "image":
        content = html`<div class="card img">
            <div class="thumb" @click=${() => this.openPreview("image", m)}><img src="${f?.url ?? ""}" alt="" /></div>
            <div class="ovl" @click=${(e: Event) => e.stopPropagation()}><span class="mm"><span class="name">${f?.name ?? ""}</span><span class="size">${f ? fmtSize(f.size) : ""}</span></span><span class="ops">${copyImgBtn}</span></div>${delBtn}
          </div>`;
        break;
      case "video":
        content = html`<div class="card video">
            <div class="vthumb" @click=${() => this.openPreview("video", m)}><video src="${f?.url ?? ""}" muted preload="metadata"></video></div>
            <div class="ovl" @click=${(e: Event) => e.stopPropagation()}><span class="mm"><span class="name">${f?.name ?? ""}</span><span class="size">${f ? fmtSize(f.size) : ""}</span></span><span class="ops">${downBtn}</span></div>${delBtn}
          </div>`;
        break;
      case "audio":
        content = html`<div class="card audio ${this.playingId === m.id ? "playing" : ""}" data-id="${m.id}">
            <div class="ap">
              <button class="play" @click=${() => this.toggleAudio(m)}>${this.playingId === m.id ? I_PAUSE : I_PLAY}</button>
              <div class="wave" @click=${(e: MouseEvent) => this.seekAudio(m, e)}>${waveBars(this.wavePeaks[m.id])}<i class="ind"></i></div>
              <audio src="${this.audioSrc(m) ?? ""}" preload="none"></audio>
            </div>
            <div class="mm"><span class="name">${f?.name ?? "音频"}</span><span class="size">${f ? fmtSize(f.size) : ""}</span></div>
            <div class="ops">${downBtn}</div>${delBtn}
          </div>`;
        this.loadWave(m);
        break;
      case "file":
      default:
        content = html`<div class="card file">
            <div class="file">
              <span class="ic">${I_FILE}</span>
              <div class="meta"><span class="name">${f?.name ?? "文件"}</span><span class="sub">${f ? `${fmtSize(f.size)} · ${fmtType(f.name, f.mime)}` : ""}</span></div>
            </div>
            <div class="ops">${downBtn}</div>${delBtn}
          </div>`;
        break;
    }

    return html`<div class="msg">
      <div class="avatar">${(m.sender.deviceName[0] ?? "?").toUpperCase()}</div>
      <div class="body">
        <div class="head">${head}</div>
        ${content}
      </div>
    </div>`;
  }

  /* ---------- render ---------- */
  render() {
    const pv = this.preview;
    return html`
      <div class="container">
      <header class="app">
        <div class="logo ${this.connState}" @click=${() => (this.sheet = "settings")}>filesyncEX<small>v6.0.0-alpha1 · 网页端</small></div>
        <div class="spacer"></div>
        <button class="iconbtn" title="二维码" @click=${this.openQr}>${I_QR}</button>
        <button class="iconbtn" title="切换主题" @click=${this.toggleTheme}>${this.theme === "dark" ? I_MOON : I_SUN}</button>
      </header>

      <!-- 桌面端：顶部上传区 -->
      <section class="upload" @drop=${this.onDrop} @dragover=${(e: DragEvent) => e.preventDefault()}>
        <div class="upload-row ${this.codeMode ? "code-mode" : ""}">
          <button class="btn btn-file" @click=${() => this.shadowRoot?.querySelector<HTMLInputElement>(".file-input")?.click()}>${I_UP}文件</button>
          <input class="input" .value=${this.text} placeholder="输入文本，或拖拽 / 粘贴文件到此处…" @input=${(e: Event) => (this.text = (e.target as HTMLInputElement).value)} @keydown=${(e: KeyboardEvent) => e.key === "Enter" && this.sendText()} />
          <div class="code-editor ${this.codeMode ? "open" : ""}">
            <div class="ce-top"><label>语言</label>
              <select .value=${this.codeLang} @change=${(e: Event) => (this.codeLang = (e.target as HTMLSelectElement).value)}>
                <option value="ts">TypeScript</option><option value="js">JavaScript</option><option value="python">Python</option><option value="ini">INI / Config</option><option value="bat">Batch (.bat)</option><option value="json">JSON</option><option value="sql">SQL</option><option value="html">HTML</option><option value="css">CSS</option>
              </select>
            </div>
            <textarea .value=${this.codeText} placeholder="在这里输入代码…（保持格式）" @input=${(e: Event) => (this.codeText = (e.target as HTMLTextAreaElement).value)} @keydown=${(e: KeyboardEvent) => e.ctrlKey && e.key === "Enter" && this.sendCode()}></textarea>
          </div>
          <button class="bracebtn ${this.codeMode ? "on" : ""}" title="代码模式" @click=${() => (this.codeMode = !this.codeMode)}>&#123;&#125;</button>
          <button class="btn send" @click=${this.codeMode ? this.sendCode : this.sendText}>发送</button>
        </div>
        <input type="file" class="file-input" multiple hidden @change=${(e: Event) => void this.handleFiles((e.target as HTMLInputElement).files)} />
      </section>

      <main class="list">${this.renderMessages()}</main>

      <!-- 移动端：底部输入条 -->
      <footer class="composer">
        <div class="composer-inner">
          <button class="addbtn" @click=${() => (this.sheet = "attach")}>${I_PLUS}</button>
          <button class="bracebtn ${this.codeMode ? "on" : ""}" @click=${() => (this.codeMode = !this.codeMode)}>&#123;&#125;</button>
          ${this.codeMode
            ? html`<input class="input" .value=${this.codeText} placeholder="// 输入代码，Ctrl+Enter 发送" @input=${(e: Event) => (this.codeText = (e.target as HTMLInputElement).value)} @keydown=${(e: KeyboardEvent) => e.ctrlKey && e.key === "Enter" && this.sendCode()} />`
            : html`<input class="input" .value=${this.text} placeholder="输入消息" @input=${(e: Event) => (this.text = (e.target as HTMLInputElement).value)} @keydown=${(e: KeyboardEvent) => e.key === "Enter" && this.sendText()} />`}
          <button class="sendbtn" @click=${this.codeMode ? this.sendCode : this.sendText}>${I_SEND}</button>
        </div>
        ${this.codeMode ? html`<div class="code-editor open"><div class="ce-top"><label>语言</label><select .value=${this.codeLang} @change=${(e: Event) => (this.codeLang = (e.target as HTMLSelectElement).value)}>${LANG_OPTS}</select></div><textarea .value=${this.codeText} placeholder="// 粘贴代码，Ctrl+Enter 发送" @input=${(e: Event) => (this.codeText = (e.target as HTMLTextAreaElement).value)} @keydown=${(e: KeyboardEvent) => e.ctrlKey && e.key === "Enter" && this.sendCode()}></textarea></div>` : nothing}
      </footer>
      </div>

      ${this.sheet ? this.renderSheet() : nothing}
      ${pv ? this.renderPreview(pv) : nothing}
      ${this.renderNotice()}
      <div class="toast ${this.toastShow ? "show" : ""} ${this.toastLeaving ? "leaving" : ""}">${this.toastText}</div>
    `;
  }

  private renderSheet() {
    const s = this.sheet;
    const close = () => (this.sheet = null);
    let content: unknown;
    if (s === "attach") {
      content = html`<div class="attach-grid">
        <button class="att" @click=${() => this.flash("（原型）打开相册")}><span class="ai">${I_IMG}</span>相册</button>
        <button class="att" @click=${() => this.flash("（原型）打开相机")}><span class="ai pink">📷</span>拍照</button>
        <button class="att" @click=${() => { this.shadowRoot?.querySelector<HTMLInputElement>(".file-input")?.click(); close(); }}><span class="ai">${I_FILE}</span>文件</button>
      </div>`;
    } else if (s === "progress") {
      content = html`<div class="qlist">${this.uploads.length === 0 ? html`<div class="qitem-row"><div class="qname" style="color:var(--muted)">暂无上传任务</div></div>` : this.uploads.map((u) => html`<div class="qitem-row"><div class="qname">${u.name} <small>${u.pct < 0 ? "失败" : fmtSize(u.size)}</small></div><div class="qbar"><i style="width:${u.pct < 0 ? 100 : u.pct}%"></i></div><div class="qmeta"><span>${u.pct < 0 ? "上传失败" : u.pct + "%"}</span></div></div>`)}</div>`;
    } else if (s === "settings") {
      // WS 地址与 httpUrl 同源（真实局域网 IP + 端口），仅协议不同
      const wsUrl = this.httpUrl.replace(/^https?:/, location.protocol === "https:" ? "wss:" : "ws:") + "/ws";
      content = html`<div class="settings">
        <!-- 连接 -->
        <p class="st-sec">连接</p>
        <div class="st-conn"><span class="dot ${this.connState}"></span><b style="color:var(${this.connState === "connected" ? "--primary" : this.connState === "connecting" ? "--warn" : "--danger"})">${this.connState === "connected" ? "已连接" : this.connState === "connecting" ? "连接中…" : "已断开"}</b><span class="muted">（局域网）</span></div>
        <p class="muted">HTTP：<code>${this.httpUrl}</code></p>
        <p class="muted">WebSocket：<code>${wsUrl}</code></p>
        <hr />
        <!-- 设备身份 / 昵称 -->
        <p class="st-note">默认昵称 <strong>user_XXXX</strong>（四位数字），按<strong>设备指纹</strong>自动生成，可在此修改（仅本机保存）。</p>
        <label>我的昵称
          <input class="field" .value=${this.nick} maxlength="10" placeholder="仅字母/数字/下划线，最长 10 位" @input=${(e: Event) => (this.nick = (e.target as HTMLInputElement).value.replace(/[^A-Za-z0-9_]/g, ""))} @keydown=${(e: KeyboardEvent) => e.key === "Enter" && this.rename()} />
        </label>
        <p class="muted">设备指纹（仅用于本地生成稳定 ID，不上传原始信息）：</p>
        <code class="fp">${this.self?.deviceId ?? ""}</code>
        <!-- 工具 -->
        <hr />
        <p class="st-sec">工具</p>
        <a class="btn tool" href="/tool/QuickSendTool.exe" download>${I_DOWN}下载 QuickSendTool（Windows 右键发送）</a>
        <p class="muted">安装后在文件管理器右键选中文件，即可一键发送到本服务器。</p>
        <!-- 关于 -->
        <hr />
        <p class="st-sec">关于</p>
        <a class="btn secondary tool" href="https://github.com/NoRainLand/filesyncEX" target="_blank" rel="noopener">${I_LINK}前往项目主页 GitHub</a>
      </div>`;
    } else if (s === "qr") {
      content = html`<div class="qrbox">${this.qrDataUrl ? html`<img src="${this.qrDataUrl}" alt="二维码" />` : html`<div class="qr-loading">生成中…</div>`}</div><p>${this.httpUrl} · 用手机扫码即可加入同步</p>`;
    }
    return html`<div class="mask" @click=${close}><div class="panel ${s === "qr" ? "qr" : ""} ${s === "settings" ? "settings-panel" : ""}" @click=${(e: Event) => e.stopPropagation()}><div class="handle"></div><div class="ptitle" @click=${close}>${s === "attach" ? "发送内容" : s === "progress" ? "上传进度" : s === "settings" ? "设置" : "扫码连接"}</div>${content}</div></div>`;
  }

  private renderPreview(pv: { kind: string; msg: MsgDataT }) {
    const f = pv.msg.file;
    let body: unknown;
    if (pv.kind === "image") body = html`<img class="ph" src="${f?.url ?? ""}" alt="" @wheel=${(e: WheelEvent) => this.zoomPreview(e)} @mousedown=${(e: MouseEvent) => this.startDrag(e)} />`;
    else if (pv.kind === "video") body = html`<video class="ph" src="${f?.url ?? ""}" controls></video>`;
    else if (pv.kind === "audio") body = html`<audio class="ph" src="${f?.url ?? ""}" controls style="width:80%"></audio>`;
    else if (pv.kind === "code") body = html`<div class="codeview">${unsafeHTML(highlightCode(pv.msg.code?.content ?? "", pv.msg.code?.lang ?? "ts"))}</div>`;
    const title = pv.kind === "image" ? "图片预览" : pv.kind === "video" ? "视频预览" : pv.kind === "audio" ? "音频播放" : "代码预览";
    const footBtn = pv.kind === "code" ? html`<button class="btn" @click=${this.previewAction}>复制</button>` : html`<button class="btn" @click=${this.previewAction}>下载</button>`;
    return html`<div class="viewer open"><div class="vtop"><span class="vt">${title}</span><button class="close" @click=${this.closePreview}>✕</button></div><div class="vbody ${pv.kind === "image" ? "pv-img" : ""}" @click=${(e: Event) => e.target === e.currentTarget && this.closePreview()}>${body}</div><div class="vfoot">${footBtn}<button class="btn pink" @click=${() => { this.deleteMsg(pv.msg.id); this.closePreview(); }}>删除</button></div></div>`;
  }
}

const LANG_OPTS = html`<option value="ts">TypeScript</option><option value="js">JavaScript</option><option value="python">Python</option><option value="ini">INI / Config</option><option value="bat">Batch (.bat)</option><option value="json">JSON</option><option value="sql">SQL</option><option value="html">HTML</option><option value="css">CSS</option>`;

customElements.define("filesync-app", FilesyncApp);
