import { html, unsafeCSS, LitElement, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import QRCode from "qrcode";
import ClipboardJS from "clipboard";
import type { DeviceInfoT, MsgDataT } from "@filesyncex/protocol";
import { getDevice, saveDevice } from "./device.js";
import { WsClient } from "./ws.js";
import { uploadFile, DIRECT_UPLOAD_LIMIT } from "./api.js";
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
  const map: Record<string, string> = { sh: "脚本", py: "脚本", js: "脚本", ts: "脚本", txt: "文本", md: "文档", pdf: "PDF", doc: "文档", docx: "文档", xlsx: "表格", xls: "表格", zip: "压缩包", rar: "压缩包", "7z": "压缩包", exe: "程序", ico: "图标", mp3: "音频", wav: "音频", m4a: "音频", mp4: "视频", avi: "视频", mov: "视频", mkv: "视频", webm: "视频", png: "图片", jpg: "图片", jpeg: "图片", gif: "图片", webp: "图片", svg: "图片", bmp: "图片" };
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

/** 音频频谱条：模拟波形柱（中间密集高振幅、两侧渐低、相邻平滑）；移动端由 CSS 每 3 根显示 1 根（指示器方式）保证可见 */
const waveBars = () => {
  const N = 96;
  const bars: unknown[] = [];
  let prev = 0.4;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const env = 0.12 + 0.88 * Math.exp(-Math.pow((t - 0.55) / 0.22, 2));
    const noise = Math.abs(((Math.sin(i * 12.9898) * 43758.5453) % 1) - 0.5) * 0.9;
    const smooth = 0.3 * noise + 0.7 * prev;
    prev = smooth;
    const h = Math.max(10, Math.min(100, env * (40 + smooth * 60)));
    bars.push(html`<i class="bar" style="height:${h.toFixed(1)}%"></i>`);
  }
  return bars;
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
const I_FILE = html`<svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" width="20" height="20"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"/></svg>`;
const I_IMG = html`<svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" width="20" height="20"><path stroke-linecap="round" stroke-linejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>`;
const I_COPY = html`<svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" width="14" height="14"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75"/></svg>`;
const I_DOWN = html`<svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" width="14" height="14"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3"/></svg>`;
const I_LINK = html`<svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" width="14" height="14"><path stroke-linecap="round" stroke-linejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244"/></svg>`;
const I_UP = html`<svg fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24" width="15" height="15"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"/></svg>`;
const I_PLAY = html`<svg fill="currentColor" viewBox="0 0 24 24" width="16" height="16"><path d="M8 5.5v13l11-6.5z"/></svg>`;
const I_PAUSE = html`<svg fill="currentColor" viewBox="0 0 24 24" width="16" height="16"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>`;
const I_TRASH = html`<svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" width="14" height="14"><path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"/></svg>`;

/* ================= 主组件 ================= */

/** 上传任务（占位卡）记录；file 保留 File 引用，用于断点续传（点击失败的大文件占位卡） */
interface UploadRec {
  key: string;
  name: string;
  pct: number;
  size: number;
  kind: string;
  fail?: boolean;
  file?: File;
}

export class FilesyncApp extends LitElement {
  static styles = unsafeCSS(appCss);

  static properties = {
    msgs: { state: true }, peers: { state: true }, self: { state: true },
    connState: { state: true }, notices: { state: true },
    text: { state: true }, codeMode: { state: true }, codeLang: { state: true }, codeText: { state: true },
    uploads: { state: true }, sheet: { state: true }, preview: { state: true }, nick: { state: true },
    httpUrl: { state: true }, theme: { state: true }, toasts: { state: true }, delBubble: { state: true }, langOpen: { state: true }, playingId: { state: true }, qrDataUrl: { state: true },
  };

  msgs: MsgDataT[] = [];
  peers: DeviceInfoT[] = [];
  self: DeviceInfoT | null = null;
  /** WS 连接状态：connecting 连接中 / connected 正常 / disconnected 断开 */
  connState: "connecting" | "connected" | "disconnected" = "connecting";
  /** 服务器通知弹窗池：可同时存在多个通知（异常/维护/关闭/警告…），各自可关闭/重连 */
  notices: { id: number; level: string; message: string }[] = [];
  private noticeSeq = 0;
  text = "";
  codeMode = false;
  codeLang = "ts";
  codeText = "";
  uploads: UploadRec[] = [];
  playingId: string | null = null;
  sheet: "attach" | "progress" | "settings" | "qr" | null = null;
  preview: { kind: string; msg: MsgDataT } | null = null;
  /** 视频首帧封面（canvas 取帧 dataURL，key=消息 id；iOS/移动端不依赖 video 自动显示首帧） */
  private videoCovers = new Map<string, string>();
  nick = "";
  httpUrl = "";
  qrDataUrl = "";
  theme: "light" | "dark" = "light";
  /** 提示弹窗池：可同时存在多个 toast，各自独立淡入/淡出/移除 */
  toasts: { id: number; text: string; leaving: boolean }[] = [];
  private toastSeq = 0;
  /** 移动端长按删除确认气泡：非空时在 (x,y) 显示（above 时箭头朝下） */
  delBubble: { id: string; x: number; y: number; above: boolean } | null = null;
  private longPressTimer: number | undefined;
  /** 长按抬起后的 click 屏蔽窗口（避免误触预览/复制） */
  private blockClickUntil = 0;
  /** 删除气泡打开时：禁止滚动，一旦滑动立即关闭气泡 */
  private delMoveHandler = (e: TouchEvent) => {
    if (!this.delBubble) return;
    e.preventDefault();
    this.closeDelBubble();
  };
  /** 自定义语言下拉是否展开 */
  langOpen = false;

  private ws: WsClient | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private audioMsgId: string | null = null;

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
      onOpen: () => { this.connState = "connected"; if (this.self) this.ws?.send({ type: "hello", device: this.self }); },
      onClose: () => { this.connState = "disconnected"; },
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
    window.addEventListener("click", this.onDocClick);
    // 主界面任何位置滚轮都转发到滚动容器（桌面 .container / 移动 .list）
    this.addEventListener("wheel", this.onHostWheel, { passive: false });
    // 消息长按（移动端）：组件级 passive touchstart 委托（lit 模板 @touchstart 无法设 passive，会触发 scroll-blocking 警告）
    this.addEventListener("touchstart", this.onMsgTouchStart, { passive: true });
  }
  disconnectedCallback(): void { window.removeEventListener("resize", this.onResize); window.removeEventListener("click", this.onDocClick); this.removeEventListener("wheel", this.onHostWheel); this.removeEventListener("touchstart", this.onMsgTouchStart); this.ws?.close(); super.disconnectedCallback(); }
  private onResize = (): void => { this.requestUpdate(); this.scrollToLatest(); };
  /** 全局滚轮：弹层/预览打开时不劫持；否则把滚轮统一转发到当前滚动容器 */
  private onHostWheel = (e: WheelEvent): void => {
    if (this.sheet || this.preview) return; // 弹层/预览内部自己滚
    if (this.codeMode && window.innerWidth <= 640) return; // 移动端代码模式屏蔽主界面滚轮
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

  /* ---------- 移动端：长按删除确认气泡 ---------- */
  /** 移动端：点击文本气泡直接复制（链接点击交给 openTextLink；气泡打开/长按屏蔽窗口内不复制） */
  private copyBubble(e: MouseEvent, m: MsgDataT): void {
    if ((e.target as HTMLElement).closest(".bubble-link")) return;
    if (this.delBubble || Date.now() < this.blockClickUntil) return;
    if (!this.debounceKey("copy-" + m.id, 800)) return;
    this.copyText(m.text ?? "");
  }
  /** 长按删除：仅移动端，长按消息 500ms 弹出删除确认气泡 */
  private msgPressStart(m: MsgDataT): void {
    if (window.innerWidth > 640 || this.sheet || this.preview) return;
    clearTimeout(this.longPressTimer);
    // 滑动取消长按：window passive touchmove（不 preventDefault，消除 scroll-blocking 警告）；每次 touchstart 重复 add 同引用是幂等的
    window.addEventListener("touchmove", this.cancelLongPress, { passive: true });
    this.longPressTimer = window.setTimeout(() => {
      window.removeEventListener("touchmove", this.cancelLongPress);
      this.blockClickUntil = Date.now() + 600; // 屏蔽长按抬起后产生的 click
      this.openDelBubble(m);
    }, 500);
  }
  /** 滑动取消长按（passive 监听回调，组件 this 绑定） */
  private cancelLongPress = (): void => {
    clearTimeout(this.longPressTimer);
    window.removeEventListener("touchmove", this.cancelLongPress);
  }
  /** 消息长按开始（移动端）：组件级 touchstart 委托，passive 注册消除 scroll-blocking 警告 */
  private onMsgTouchStart = (e: TouchEvent): void => {
    // shadow DOM 事件重定向会把 e.target 置为 host，须用 composedPath() 取原始目标
    const origin = e.composedPath()[0] as HTMLElement | null;
    const el = origin?.closest<HTMLElement>(".msg");
    if (!el) return;
    const id = el.dataset.id;
    if (!id) return;
    const m = this.msgs.find((x) => x.id === id);
    if (m) this.msgPressStart(m);
  };

  private msgPressEnd(): void { clearTimeout(this.longPressTimer); }
  private msgClickGuard(e: Event): void {
    if (this.delBubble) { this.closeDelBubble(); return; }
    if (Date.now() < this.blockClickUntil) {
      this.blockClickUntil = 0;
      e.stopPropagation();
      e.preventDefault();
    }
  }
  private openDelBubble(m: MsgDataT): void {
    const el = this.shadowRoot?.querySelector<HTMLElement>(`.msg[data-id="${m.id}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const bw = 200, bh = 90;
    let left = r.left + r.width / 2 - bw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
    let top = r.bottom + 8;
    let above = false;
    if (top + bh > window.innerHeight - 8) { top = r.top - bh - 8; above = true; if (top < 8) top = 8; }
    this.delBubble = { id: m.id, x: left, y: top, above };
    // 删除气泡期间禁止滚动，滑动即退出删除模式
    window.addEventListener("touchmove", this.delMoveHandler, { passive: false });
  }
  private closeDelBubble(): void {
    if (!this.delBubble) return;
    this.delBubble = null;
    window.removeEventListener("touchmove", this.delMoveHandler);
  }
  private confirmDelBubble(): void {
    const b = this.delBubble;
    if (!b) return;
    this.delBubble = null;
    window.removeEventListener("touchmove", this.delMoveHandler);
    this.deleteMsg(b.id);
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
  /** 点击/拖动波形条跳转播放进度：元数据未就绪时先加载，就绪后跳转目标位置再播放（避免从 0 开始） */
  private seekAudio(m: MsgDataT, e: MouseEvent): void {
    const a = this.ensureAudio(m);
    if (!a) return;
    const wave = e.currentTarget as HTMLElement;
    const r = wave.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const setTime = (): void => {
      if (a.duration && isFinite(a.duration) && a.duration > 0) a.currentTime = ratio * a.duration;
    };
    const playFrom = (): void => {
      if (a.paused) { this.playingId = m.id; void a.play().catch(() => { this.playingId = null; this.audioEl = null; this.audioMsgId = null; }); }
    };
    if (a.readyState >= 1 && a.duration && isFinite(a.duration) && a.duration > 0) {
      setTime();
      this.updateWaveInd(m.id, ratio);
      playFrom();
    } else {
      // 新 Audio 元数据未就绪（duration 未知 → 直接设 currentTime 无效 → 会从 0 播）：先加载，就绪后跳转并播放
      const onMeta = (): void => { a.removeEventListener("loadedmetadata", onMeta); setTime(); this.updateWaveInd(m.id, ratio); playFrom(); };
      a.addEventListener("loadedmetadata", onMeta);
      a.load();
    }
  }
  /** 更新音频进度：桌面频谱整格高亮 .played（已播薄荷/未播灰）；移动进度条设 fill 宽度；竖线 .ind 定位 */
  private updateWaveInd(msgId: string, forced?: number): void {
    const wave = this.shadowRoot?.querySelector<HTMLElement>(`.card.audio[data-id="${msgId}"] .wave`);
    if (!wave) return;
    const a = this.audioEl && this.audioMsgId === msgId ? this.audioEl : null;
    const ratio = forced ?? (a && a.duration ? a.currentTime / a.duration : 0);
    const pct = Math.round(ratio * 100);
    // 桌面频谱：整格跳变 .played 高亮；移动进度条：fill 填充
    const bars = Array.from(wave.querySelectorAll("i.bar"));
    const n = bars.length;
    const played = Math.round(ratio * n);
    bars.forEach((bar, i) => bar.classList.toggle("played", i < played));
    const fill = wave.querySelector(".fill") as HTMLElement | null;
    if (fill) fill.style.width = `${pct}%`;
    const ind = wave.querySelector(".ind") as HTMLElement | null;
    if (ind) ind.style.left = `${pct}%`;
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
      const rec: UploadRec = { key, name: file.name, pct: 0, size: file.size, kind, file };
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
        console.error("上传失败:", e);
        if (file.size <= DIRECT_UPLOAD_LIMIT) {
          // 小文件（≤8MB 直接上传）：失败直接移除占位卡并提示（无断点续传价值）
          this.msgs = this.msgs.filter((x) => x.id !== key);
          this.uploads = this.uploads.filter((x) => x !== rec);
          this.flash(`「${file.name}」上传失败`);
        } else {
          // 大文件（分片上传）：保留占位卡，标记失败 → 点击可断点续传（File 引用仍在内存）
          rec.fail = true; rec.pct = -1;
          this.uploads = [...this.uploads];
          this.msgs = [...this.msgs];
          this.flash(`「${file.name}」上传中断，点击消息可断点续传`);
        }
      }
    }
    this.scrollToLatest();
  }
  private onDrop(e: DragEvent): void { e.preventDefault(); void this.handleFiles(e.dataTransfer?.files ?? null); }

  /** 断点续传：点击失败的大文件占位卡，用内存里的 File 重新上传（同 sha → 服务端自动续传） */
  private async retryUpload(rec: UploadRec): Promise<void> {
    if (!rec.file) return;
    if (!this.debounceKey("retry-" + rec.key, 800)) return;
    rec.fail = false; rec.pct = 0;
    this.uploads = [...this.uploads];
    this.msgs = [...this.msgs];
    try {
      await uploadFile(rec.file, (sent, total) => { rec.pct = Math.round((sent / total) * 100); this.uploads = [...this.uploads]; });
      // 续传成功：移除占位卡（真实消息由 WS onAdd 广播，同 id 去重）
      this.msgs = this.msgs.filter((m) => m.id !== rec.key);
      this.uploads = this.uploads.filter((x) => x !== rec);
      this.flash(`「${rec.name}」续传成功`);
    } catch (e) {
      console.error("续传失败:", e);
      // 彻底失败且无法续传：删除占位卡 + 提示
      this.msgs = this.msgs.filter((m) => m.id !== rec.key);
      this.uploads = this.uploads.filter((x) => x !== rec);
      this.flash(`「${rec.name}」续传失败，已取消`);
    }
  }

  /* ---------- 预览 ---------- */
  private pvZoom = { s: 1, tx: 0, ty: 0, bx: 0, by: 0, init: false };
  private pvDrag = { active: false, sx: 0, sy: 0, stx: 0, sty: 0 };
  private openPreview(kind: string, msg: MsgDataT): void {
    if (this.delBubble) { this.closeDelBubble(); return; }
    if (Date.now() < this.blockClickUntil) return;
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
  /** 视频首帧封面：loadeddata 后 canvas 取帧转 dataURL，替换 video 为 img（移动端/iOS 不依赖 video 自动显示首帧） */
  private captureVideoCover(m: MsgDataT): void {
    if (this.videoCovers.has(m.id)) return;
    const v = this.shadowRoot?.querySelector<HTMLVideoElement>(`.msg[data-id="${m.id}"] .card.video video`);
    if (!v || !v.videoWidth || !v.videoHeight) return;
    try {
      const c = document.createElement("canvas");
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(v, 0, 0, c.width, c.height);
      this.videoCovers.set(m.id, c.toDataURL("image/jpeg", 0.72));
      this.requestUpdate();
    } catch {
      /* 取帧受限（编码/跨域）时保持 video 原样 */
    }
  }
  /** 图片预览手势：手动绑定（lit 模板 @wheel/@touchstart/@touchmove 无法设 passive，会触发 scroll-blocking 警告）。
   *  显式 {passive:false} 保持 preventDefault 缩放/拖动；每次渲染后对新 img 绑定（re-render 重建 img 后自动重绑） */
  protected updated(changedProperties: Map<PropertyKey, unknown>): void {
    super.updated(changedProperties);
    const img = this.shadowRoot?.querySelector<HTMLImageElement>(".viewer .vbody.pv-img img.ph");
    if (img && !img.dataset.pvBound) {
      img.dataset.pvBound = "1";
      img.addEventListener("wheel", (e) => this.zoomPreview(e), { passive: false });
      img.addEventListener("touchstart", (e) => this.touchStart(e), { passive: false });
      img.addEventListener("touchmove", (e) => this.touchMove(e), { passive: false });
      img.addEventListener("touchend", () => this.touchEnd());
      img.addEventListener("touchcancel", () => this.touchEnd());
    }
  }
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
  /** 移动端图片双指缩放 / 单指平移（围绕图片当前中心缩放，双指收拢/张开 + 单指拖动） */
  private pvTouch: { type: "pinch" | "pan"; d0: number; s0: number; x: number; y: number } | null = null;
  private touchDist(e: TouchEvent): number {
    return Math.hypot(e.touches[0]!.clientX - e.touches[1]!.clientX, e.touches[0]!.clientY - e.touches[1]!.clientY);
  }
  private touchStart(e: TouchEvent): void {
    e.preventDefault();
    const z = this.pvZoom;
    const img = e.currentTarget as HTMLElement;
    if (!z.init) { const r = img.getBoundingClientRect(); z.bx = r.left; z.by = r.top; z.init = true; }
    if (e.touches.length >= 2) {
      this.pvTouch = { type: "pinch", d0: this.touchDist(e), s0: z.s, x: 0, y: 0 };
    } else if (e.touches.length === 1) {
      this.pvTouch = { type: "pan", d0: 0, s0: 0, x: e.touches[0]!.clientX, y: e.touches[0]!.clientY };
    }
  }
  private touchMove(e: TouchEvent): void {
    e.preventDefault();
    const z = this.pvZoom;
    const g = this.pvTouch;
    const img = e.currentTarget as HTMLElement;
    if (!g || !img) return;
    if (g.type === "pinch" && e.touches.length >= 2) {
      const s2 = Math.min(8, Math.max(1, (g.s0 * this.touchDist(e)) / g.d0));
      const r = img.getBoundingClientRect();
      const k = s2 / z.s;
      z.tx += (r.width / 2) * (1 - k);
      z.ty += (r.height / 2) * (1 - k);
      z.s = s2;
      if (z.s <= 1.001) { z.tx = 0; z.ty = 0; z.s = 1; img.style.transform = ""; }
      else img.style.transform = `translate(${z.tx}px, ${z.ty}px) scale(${z.s})`;
    } else if (g.type === "pan" && e.touches.length === 1 && z.s > 1.001) {
      z.tx += e.touches[0]!.clientX - g.x;
      z.ty += e.touches[0]!.clientY - g.y;
      g.x = e.touches[0]!.clientX;
      g.y = e.touches[0]!.clientY;
      img.style.transform = `translate(${z.tx}px, ${z.ty}px) scale(${z.s})`;
    }
  }
  private touchEnd(): void { this.pvTouch = null; }
  private previewAction(): void {
    const p = this.preview;
    if (!p) return;
    if (p.kind === "code") {
      const t = p.msg.code?.content ?? "";
      void this.copyToClipboard(t).then((ok) => this.flash(ok ? "代码已复制" : "复制失败，请手动复制"));
    } else {
      // 真正下载：临时 <a download> 触发浏览器下载（与消息列表下载按钮一致）
      const f = p.msg.file;
      if (f?.url) {
        const a = document.createElement("a");
        a.href = f.url;
        a.download = f.name ?? "";
        document.body.appendChild(a);
        a.click();
        a.remove();
        this.flash("已开始下载");
      } else {
        this.flash("暂无可下载内容");
      }
    }
  }
  /** 按钮防抖（leading）：首次点击立即执行，wait 毫秒内重复点击直接忽略（防连点重复触发） */
  private clickGuard = new Map<string, number>();
  private debounceKey(key: string, wait: number): boolean {
    const now = Date.now();
    const last = this.clickGuard.get(key) ?? 0;
    if (now - last < wait) return false;
    if (this.clickGuard.size > 1000) {
      for (const [k, t] of this.clickGuard) if (now - t > 30000) this.clickGuard.delete(k);
    }
    this.clickGuard.set(key, now);
    return true;
  }
  /** 点击文档其它区域时关闭语言下拉 */
  private onDocClick = (): void => { if (this.langOpen) this.langOpen = false; };
  /** 提示弹窗池：每次追加一个独立 toast，2200ms 后淡出上移，再 700ms 移除 */
  private flash(t: string): void {
    const id = ++this.toastSeq;
    this.toasts = [...this.toasts, { id, text: t, leaving: false }];
    window.setTimeout(() => {
      this.toasts = this.toasts.map((x) => (x.id === id ? { ...x, leaving: true } : x));
    }, 2200);
    window.setTimeout(() => {
      this.toasts = this.toasts.filter((x) => x.id !== id);
    }, 2900);
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
    // 通知弹窗池：每次追加一个独立弹窗（可多个并存），各自可关闭/重连
    this.notices = [...this.notices, { id: ++this.noticeSeq, level, message }];
  }
  private dismissNotice(id: number): void {
    this.notices = this.notices.filter((n) => n.id !== id);
  }
  private confirmReconnectAt = 0;
  private confirmNotice(id: number): void {
    // 防抖：确认按钮快速连点只触发一次重连
    const now = Date.now();
    if (now - this.confirmReconnectAt < 3000) return;
    this.confirmReconnectAt = now;
    const n = this.notices.find((x) => x.id === id);
    this.dismissNotice(id);
    this.connState = "connecting";
    this.ws?.forceReconnect();
    this.flash(n?.level === "shutdown" ? "正在尝试重新连接…" : "正在重新连接…");
  }

  private renderNotice() {
    if (this.notices.length === 0) return nothing;
    return html`<div class="notice-mask">${this.notices.map((n) => html`<div class="notice-panel ${n.level}">
      <button class="nclose" title="关闭" @click=${() => { if (this.debounceKey("notice-close-" + n.id, 300)) this.dismissNotice(n.id); }}>✕</button>
      <div class="ntitle">${this.noticeLevelLabel(n.level)}</div>
      <div class="nbody">${n.message}</div>
      <button class="btn" @click=${() => this.confirmNotice(n.id)}>确认并重连</button>
    </div>`)}</div>`;
  }
  private copyText(t: string): void {
    void this.copyToClipboard(t).then((ok) => this.flash(ok ? "已复制" : "复制失败，请手动复制"));
  }
  private copyCode(m: MsgDataT): void {
    void this.copyToClipboard(m.code?.content ?? "").then((ok) => this.flash(ok ? "代码已复制" : "复制失败，请手动复制"));
  }
  /** 复制到剪贴板：使用经典 clipboard.js 库（内部 execCommand+选区回退，兼容局域网 HTTP 非安全上下文） */
  private copyToClipboard(text: string): Promise<boolean> {
    return new Promise((resolve) => {
      const el = document.createElement("button");
      el.type = "button";
      el.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;";
      document.body.appendChild(el);
      const cp = new ClipboardJS(el, { text: () => text });
      let done = false;
      const finish = (ok: boolean): void => {
        if (done) return;
        done = true;
        cp.destroy();
        el.remove();
        resolve(ok);
      };
      cp.on("success", () => finish(true));
      cp.on("error", () => finish(false));
      el.click();
      window.setTimeout(() => finish(false), 2000); // 兜底：异常时判定失败
    });
  }

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
    if (!this.debounceKey("link-" + url, 500)) return;
    window.open(url, "_blank", "noopener");
  }

  private renderMsg(m: MsgDataT) {
    const f = m.file;
    const mobile = window.innerWidth <= 640;
    // 上传占位卡：结构与真实消息完全一致（对应类型主体 + mm 信息行 + ops 操作行），主体叠磨砂层 + 中心圆形进度环
    if (m.id.startsWith("upload-")) {
      const rec = this.uploads.find((u) => u.key === m.id);
      const pct = rec ? Math.max(0, Math.min(100, rec.pct)) : 0;
      const failed = !!rec?.fail;
      // 大文件（分片）上传失败 → 可点击断点续传（File 引用仍在内存）
      const retryable = failed && !!rec?.file && rec.file.size > DIRECT_UPLOAD_LIMIT;
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
        phBody = html`<div class="ph-body audio">${blur}<div class="ph-ap"><span class="ph-play">${I_PLAY}</span><div class="ph-wave">${waveBars()}<i class="fill"></i><i class="ind"></i></div></div>${ring}</div>`;
      } else {
        phBody = html`<div class="ph-body file">${blur}<span class="ph-ic">${I_FILE}</span>${ring}</div>`;
      }
      // 信息行（同真实消息 .mm：文件名 + 大小；失败的大文件提示可点击续传）
      const mm = html`<div class="ph-mm"><span class="name ${retryable ? "retry" : ""}">${failed ? (retryable ? "上传中断 · 点击续传" : "上传失败") : f?.name ?? "上传中…"}</span><span class="size">${f ? fmtSize(f.size) : ""}</span></div>`;
      // 操作行（同真实消息 .ops：下载占位按钮）
      const ops = html`<div class="ph-ops"><span class="btn secondary ph-down">${I_DOWN}下载</span></div>`;
      return html`<div class="msg">
        <div class="avatar">${(m.sender.deviceName[0] ?? "?").toUpperCase()}</div>
        <div class="body">
          <div class="head"><span class="who">${m.sender.deviceName}</span><time>${fmtTime(m.ts)}</time></div>
          <div class="card upload-ph ${uk} ${retryable ? "retry" : ""}" @click=${retryable ? () => { void this.retryUpload(rec!); } : undefined}>
            ${phBody}
            ${mm}
            ${ops}
          </div>
        </div>
      </div>`;
    }
    const delBtn = html`<button class="del-corner" title="删除" @click=${() => { if (this.debounceKey("del-" + m.id, 500)) this.deleteMsg(m.id); }}>${I_TRASH}</button>`;
    const copyBtn = html`<button class="btn" @click=${() => { if (this.debounceKey("copy-" + m.id, 800)) this.copyText(m.text ?? ""); }}>${I_COPY}复制</button>`;
    const copyCodeBtn = html`<button class="btn" @click=${() => { if (this.debounceKey("copy-" + m.id, 800)) this.copyCode(m); }}>${I_COPY}复制</button>`;
    const downBtn = html`<a class="btn" href="${f?.url ?? "#"}" download @click=${(e: Event) => { if (!this.debounceKey("down-" + m.id, 800)) e.preventDefault(); }}>${I_DOWN}下载</a>`;
    const head = html`<span class="who">${m.sender.deviceName}</span>${this.self && m.sender.deviceId === this.self.deviceId ? html`<span class="me">本机</span>` : ""}<time>${fmtTime(m.ts)}</time>`;

    let content: unknown;
    switch (m.kind) {
      case "text":
        content = mobile
          ? html`<div class="card text"><div class="bubble" @click=${(e: MouseEvent) => this.copyBubble(e, m)}>${this.renderText(m.text ?? "")}</div>${delBtn}</div>`
          : html`<div class="card text"><div class="bubble">${this.renderText(m.text ?? "")}</div><div class="ops">${copyBtn}</div>${delBtn}</div>`;
        break;
      case "code":
        content = html`<div class="card code"><div class="code-head"><span class="lang">${m.code?.lang ?? "code"}</span></div><pre @click=${() => { if (this.debounceKey("pv-" + m.id, 400)) this.openPreview("code", m); }}>${unsafeHTML(highlightCode(m.code?.content ?? "", m.code?.lang ?? "ts"))}</pre><div class="ops">${copyCodeBtn}</div>${delBtn}</div>`;
        break;
      case "image":
        content = html`<div class="card img">
            <div class="thumb" @click=${() => { if (this.debounceKey("pv-" + m.id, 400)) this.openPreview("image", m); }}><img src="${f?.url ?? ""}" alt="" /></div>
            <div class="ovl" @click=${(e: Event) => e.stopPropagation()}><span class="mm"><span class="name">${f?.name ?? ""}</span><span class="size">${f ? fmtSize(f.size) : ""}</span></span><span class="ops">${downBtn}</span></div>${delBtn}
          </div>`;
        break;
      case "video": {
        const cover = this.videoCovers.get(m.id);
        content = html`<div class="card video">
            <div class="vthumb" @click=${() => { if (this.debounceKey("pv-" + m.id, 400)) this.openPreview("video", m); }}>
              ${cover
                ? html`<img class="vcover" src="${cover}" alt="" />`
                : html`<video src="${f?.url ?? ""}" muted playsinline webkit-playsinline preload="metadata" @loadeddata=${() => this.captureVideoCover(m)}></video>`}
            </div>
            <div class="ovl" @click=${(e: Event) => e.stopPropagation()}><span class="mm"><span class="name">${f?.name ?? ""}</span><span class="size">${f ? fmtSize(f.size) : ""}</span></span><span class="ops">${downBtn}</span></div>${delBtn}
          </div>`;
        break;
      }
      case "audio":
        content = html`<div class="card audio ${this.playingId === m.id ? "playing" : ""}" data-id="${m.id}">
            <div class="ap">
              <button class="play" @click=${() => { if (this.debounceKey("play-" + m.id, 400)) this.toggleAudio(m); }}>${this.playingId === m.id ? I_PAUSE : I_PLAY}</button>
              <div class="wave" @click=${(e: MouseEvent) => this.seekAudio(m, e)}>${waveBars()}<i class="fill"></i><i class="ind"></i></div>
              <audio src="${this.audioSrc(m) ?? ""}" preload="none"></audio>
            </div>
            <div class="mm"><span class="name">${f?.name ?? "音频"}</span><span class="size">${f ? fmtSize(f.size) : ""}</span></div>
            <div class="ops">${downBtn}</div>${delBtn}
          </div>`;
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

    return html`<div class="msg ${this.delBubble?.id === m.id ? "del-selected" : ""}" data-id="${m.id}" @touchend=${this.msgPressEnd} @mousedown=${() => this.msgPressStart(m)} @mouseup=${this.msgPressEnd} @mouseleave=${this.msgPressEnd} @contextmenu=${(e: Event) => { if (window.innerWidth <= 640) e.preventDefault(); }} @click=${(e: Event) => this.msgClickGuard(e)}>
      <div class="avatar">${(m.sender.deviceName[0] ?? "?").toUpperCase()}</div>
      <div class="body">
        <div class="head">${head}</div>
        ${content}
      </div>
    </div>`;
  }

  /** 自定义语言下拉栏：upward=true 列表向上弹出（移动端输入条），否则向下（桌面端代码框顶） */
  private renderLangBar(upward: boolean): unknown {
    return html`<div class="lang-bar ${upward ? "up" : ""}">
      <label>语言</label>
      <div class="lang-pick" @click=${(e: Event) => { e.stopPropagation(); if (this.debounceKey("lang-toggle", 250)) this.langOpen = !this.langOpen; }}>
        <span class="lang-cur">${langLabel(this.codeLang)}</span><span class="lang-arr">${upward ? "▴" : "▾"}</span>
        ${this.langOpen ? html`<div class="lang-list">${LANG_LIST.map((l) => html`<div class="lang-opt ${l === this.codeLang ? "on" : ""}" @click=${() => { if (this.debounceKey("lang-" + l, 300)) { this.codeLang = l; this.langOpen = false; } }}>${langLabel(l)}</div>`)}</div>` : nothing}
      </div>
    </div>`;
  }

  /** 进入代码模式后自动聚焦代码输入框（按视口选可见的：移动端 footer / 桌面端 upload） */
  private focusCodeEditor(): void {
    if (!this.codeMode) return;
    void this.updateComplete.then(() => {
      const sel = window.innerWidth <= 640
        ? "footer.composer .code-editor.open textarea"
        : ".upload .code-editor.open textarea";
      this.shadowRoot?.querySelector<HTMLTextAreaElement>(sel)?.focus();
    });
  }

  /* ---------- render ---------- */
  render() {
    const pv = this.preview;
    return html`
      <div class="container">
      <header class="app">
        <div class="logo ${this.connState}" @click=${() => { if (this.debounceKey("settings", 300)) this.sheet = "settings"; }}>filesyncEX</div>
        <div class="spacer"></div>
        <button class="iconbtn" title="二维码" @click=${() => { if (this.debounceKey("qr", 300)) this.openQr(); }}>${I_QR}</button>
        <button class="iconbtn" title="切换主题" @click=${() => { if (this.debounceKey("theme", 300)) this.toggleTheme(); }}>${this.theme === "dark" ? I_MOON : I_SUN}</button>
      </header>

      <!-- 桌面端：顶部上传区 -->
      <section class="upload" @drop=${this.onDrop} @dragover=${(e: DragEvent) => e.preventDefault()}>
        <div class="upload-row ${this.codeMode ? "code-mode" : ""}">
          <button class="btn btn-file" @click=${() => { if (this.debounceKey("file", 400)) this.shadowRoot?.querySelector<HTMLInputElement>(".file-input")?.click(); }}>${I_UP}文件</button>
          <input class="input" .value=${this.text} placeholder="输入文本，或拖拽 / 粘贴文件到此处…" @input=${(e: Event) => (this.text = (e.target as HTMLInputElement).value)} @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" && this.debounceKey("send", 600)) this.sendText(); }} />
          <div class="code-editor ${this.codeMode ? "open" : ""}">
            <div class="ce-top">${this.renderLangBar(false)}</div>
            <textarea .value=${this.codeText} placeholder="在这里输入代码…（保持格式）" @input=${(e: Event) => (this.codeText = (e.target as HTMLTextAreaElement).value)} @keydown=${(e: KeyboardEvent) => { if (e.ctrlKey && e.key === "Enter" && this.debounceKey("send", 600)) this.sendCode(); }}></textarea>
          </div>
          <button class="bracebtn ${this.codeMode ? "on" : ""}" title="代码模式" @click=${() => { if (this.debounceKey("codemode", 300)) { this.codeMode = !this.codeMode; this.focusCodeEditor(); } }}>&#123;&#125;</button>
          <button class="btn send" @click=${() => { if (this.debounceKey("send", 600)) this.codeMode ? this.sendCode() : this.sendText(); }}>发送</button>
        </div>
        <input type="file" class="file-input" multiple hidden @change=${(e: Event) => void this.handleFiles((e.target as HTMLInputElement).files)} />
      </section>

      <main class="list">${this.renderMessages()}</main>

      <!-- 移动端：底部输入条 -->
      <footer class="composer ${this.codeMode ? "code-mode" : ""}">
        <div class="composer-inner">
          <button class="addbtn" title="选择文件" @click=${() => { if (this.debounceKey("file", 400)) this.shadowRoot?.querySelector<HTMLInputElement>(".file-input")?.click(); }}>${I_PLUS}</button>
          <button class="bracebtn ${this.codeMode ? "on" : ""}" @click=${() => { if (this.debounceKey("codemode", 300)) { this.codeMode = !this.codeMode; this.focusCodeEditor(); } }}>&#123;&#125;</button>
          ${this.codeMode
            ? this.renderLangBar(true)
            : html`<input class="input" .value=${this.text} placeholder="输入消息" @input=${(e: Event) => (this.text = (e.target as HTMLInputElement).value)} @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" && this.debounceKey("send", 600)) this.sendText(); }} />`}
          <button class="sendbtn" @click=${() => { if (this.debounceKey("send", 600)) this.codeMode ? this.sendCode() : this.sendText(); }}>${I_SEND}</button>
        </div>
        ${this.codeMode ? html`<div class="code-editor open"><textarea .value=${this.codeText} placeholder="在这里输入代码…（保持格式）" @input=${(e: Event) => (this.codeText = (e.target as HTMLTextAreaElement).value)} @keydown=${(e: KeyboardEvent) => { if (e.ctrlKey && e.key === "Enter" && this.debounceKey("send", 600)) this.sendCode(); }}></textarea></div>` : nothing}
      </footer>
      </div>

      ${this.sheet ? this.renderSheet() : nothing}
      ${pv ? this.renderPreview(pv) : nothing}
      ${this.renderNotice()}
      ${this.codeMode && window.innerWidth <= 640 ? html`<div class="code-mask" @wheel=${(e: WheelEvent) => { e.preventDefault(); e.stopPropagation(); }} @click=${() => { if (this.debounceKey("code-mask", 300)) this.codeMode = false; }}></div>` : nothing}
      ${this.delBubble ? html`
        <div class="del-mask" @click=${() => { if (this.debounceKey("del-mask", 300)) this.closeDelBubble(); }}></div>
        <div class="del-bubble ${this.delBubble.above ? "above" : ""}" style="left:${this.delBubble.x}px;top:${this.delBubble.y}px">
          <div class="db-text">删除这条消息？</div>
          <div class="db-ops">
            <button class="btn cancel" @click=${() => { if (this.debounceKey("del-cancel", 300)) this.closeDelBubble(); }}>取消</button>
            <button class="btn del" @click=${() => { if (this.debounceKey("del-ok", 600)) this.confirmDelBubble(); }}>删除</button>
          </div>
        </div>` : nothing}
      ${this.toasts.length ? html`<div class="toasts">${this.toasts.map((to) => html`<div class="toast ${to.leaving ? "leaving" : "show"}">${to.text}</div>`)}</div>` : nothing}
    `;
  }

  private renderSheet() {
    const s = this.sheet;
    const close = () => (this.sheet = null);
    let content: unknown;
    if (s === "attach") {
      content = html`<div class="attach-grid">
        <button class="att" @click=${() => { if (this.debounceKey("attach-album", 300)) this.flash("（原型）打开相册"); }}><span class="ai">${I_IMG}</span>相册</button>
        <button class="att" @click=${() => { if (this.debounceKey("attach-camera", 300)) this.flash("（原型）打开相机"); }}><span class="ai pink">📷</span>拍照</button>
        <button class="att" @click=${() => { if (this.debounceKey("attach-file", 400)) { this.shadowRoot?.querySelector<HTMLInputElement>(".file-input")?.click(); close(); } }}><span class="ai">${I_FILE}</span>文件</button>
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
          <input class="field" .value=${this.nick} maxlength="10" placeholder="仅字母/数字/下划线，最长 10 位" @input=${(e: Event) => (this.nick = (e.target as HTMLInputElement).value.replace(/[^A-Za-z0-9_]/g, ""))} @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" && this.debounceKey("rename", 600)) this.rename(); }} />
        </label>
        <p class="muted">设备指纹（仅用于本地生成稳定 ID，不上传原始信息）：</p>
        <code class="fp">${this.self?.deviceId ?? ""}</code>
        <!-- 工具（移动端隐藏） -->
        <div class="tool-sec">
          <hr />
          <p class="st-sec">工具</p>
          <a class="btn tool" href="/tool/QuickSendTool.exe" download>${I_DOWN}下载 QuickSendTool（Windows 右键发送）</a>
          <p class="muted">安装后在文件管理器右键选中文件，即可一键发送到本服务器。</p>
        </div>
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
    if (pv.kind === "image") body = html`<img class="ph" src="${f?.url ?? ""}" alt="" @mousedown=${(e: MouseEvent) => this.startDrag(e)} />`;
    else if (pv.kind === "video") body = html`<video class="ph" src="${f?.url ?? ""}" controls playsinline webkit-playsinline></video>`;
    else if (pv.kind === "audio") body = html`<audio class="ph" src="${f?.url ?? ""}" controls style="width:80%"></audio>`;
    else if (pv.kind === "code") body = html`<div class="codeview">${unsafeHTML(highlightCode(pv.msg.code?.content ?? "", pv.msg.code?.lang ?? "ts"))}</div>`;
    const title = pv.kind === "image" ? "图片预览" : pv.kind === "video" ? "视频预览" : pv.kind === "audio" ? "音频播放" : "代码预览";
    const footBtn = pv.kind === "code" ? html`<button class="btn" @click=${() => { if (this.debounceKey("pv-action", 600)) this.previewAction(); }}>复制</button>` : html`<button class="btn" @click=${() => { if (this.debounceKey("pv-action", 600)) this.previewAction(); }}>下载</button>`;
    return html`<div class="viewer open"><div class="vtop"><span class="vt">${title}</span><button class="close" @click=${() => { if (this.debounceKey("pv-close", 300)) this.closePreview(); }}>✕</button></div><div class="vbody ${pv.kind === "image" ? "pv-img" : ""}" @click=${(e: Event) => { if (e.target === e.currentTarget && this.debounceKey("pv-close", 300)) this.closePreview(); }}>${body}</div><div class="vfoot">${footBtn}<button class="btn pink" @click=${() => { if (this.debounceKey("pv-del", 600)) { this.deleteMsg(pv.msg.id); this.closePreview(); } }}>删除</button></div></div>`;
  }
}

const LANG_LIST = ["ts", "js", "python", "ini", "bat", "json", "sql", "html", "css"];
const LANG_LABEL: Record<string, string> = { ts: "TypeScript", js: "JavaScript", python: "Python", ini: "INI / Config", bat: "Batch (.bat)", json: "JSON", sql: "SQL", html: "HTML", css: "CSS" };
const langLabel = (l: string): string => LANG_LABEL[l] ?? l;

customElements.define("filesync-app", FilesyncApp);
