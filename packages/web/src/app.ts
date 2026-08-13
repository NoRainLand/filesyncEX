import { html, unsafeCSS, LitElement, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import QRCode from "qrcode";
import ClipboardJS from "clipboard";
import type { DeviceInfoT, MsgDataT } from "@filesyncex/protocol";
import { getDevice, saveDevice } from "./device.js";
import { WsClient } from "./ws.js";
import { uploadFile, DIRECT_UPLOAD_LIMIT, apiUploadCover, fetchHealth } from "./api.js";
import type { Lang } from "./i18n.js";
import { loadLang, saveLang, dict, dayLabel, fmtType } from "./i18n.js";
import Prism from "prismjs";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-python";
import "prismjs/components/prism-ini";
import "prismjs/components/prism-batch";
import "prismjs/components/prism-json";
import "prismjs/components/prism-sql";
import prismTheme from "./prism-theme.css?inline";
import appCss from "./app.css?inline";

/* ================= helpers ================= */

const p2 = (n: number) => String(n).padStart(2, "0");
/** 消息时间：统一 YYYY/MM/DD HH:MM（年月日时分） */
function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
/* 日期分组（dayLabel）/ 文件类型（fmtType）已迁移到 i18n.ts，按当前语言返回中/英文 */
const fmtSize = (n: number): string => {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
};
/* fmtType 已迁移到 i18n.ts */
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

/* ================= Prism 语法高亮 ================= */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** 代码语言 → Prism 语法名（html 用 markup，bat 用 batch） */
const PRISM_LANG: Record<string, string> = { ts: "typescript", js: "javascript", python: "python", ini: "ini", bat: "batch", json: "json", sql: "sql", html: "markup", css: "css" };
/** Prism 高亮：无对应语法时原样转义返回 */
function highlightCode(code: string, lang: string): string {
  const pl = PRISM_LANG[lang] || "typescript";
  const grammar = Prism.languages[pl];
  if (!grammar) return esc(code);
  return Prism.highlight(code, grammar, pl);
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
  /** 视频封面 key（上传前本地取帧生成并上传到服务器，随视频关联） */
  coverKey?: string;
}

export class FilesyncApp extends LitElement {
  static styles = [unsafeCSS(appCss), unsafeCSS(prismTheme)];

  static properties = {
    msgs: { state: true }, peers: { state: true }, self: { state: true },
    connState: { state: true }, notices: { state: true },
    text: { state: true }, codeMode: { state: true }, codeLang: { state: true }, codeText: { state: true },
    uploads: { state: true }, sheet: { state: true }, preview: { state: true }, nick: { state: true },
    httpUrl: { state: true }, theme: { state: true }, toasts: { state: true }, delBubble: { state: true }, langOpen: { state: true }, playingId: { state: true }, qrDataUrl: { state: true }, lang: { state: true },
  };

  msgs: MsgDataT[] = [];
  peers: DeviceInfoT[] = [];
  self: DeviceInfoT | null = null;
  /** WS 连接状态：connecting 连接中 / connected 正常 / disconnected 断开 */
  connState: "connecting" | "connected" | "disconnected" = "connecting";
  /** 服务器通知弹窗池：可同时存在多个通知（异常/维护/关闭/警告…），各自可关闭/重连 */
  notices: { id: number; level: string; message: string }[] = [];
  private noticeSeq = 0;
  /** 断线自动重连：剩余次数（默认 3）与流程标志 */
  private reconnectLeft = 0;
  private reconnectTimer: number | null = null;
  private autoReconnecting = false;
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
  /** 提示弹窗池：可同时存在多个 toast，各自独立淡入/停留/上移淡出/移除（垂直堆叠） */
  toasts: { id: number; text: string; leaving: boolean; show: boolean }[] = [];
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
  /** 界面语言：zh 中文 / en 英文（localStorage 持久化） */
  lang: Lang = loadLang();

  private ws: WsClient | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private audioMsgId: string | null = null;

  /** 翻译：按当前语言取词典（缺 key 回退中文） */
  private t(key: string, vars?: Record<string, string>): string {
    return dict[this.lang][key]?.(vars) ?? dict.zh[key]?.(vars) ?? key;
  }

  /** 切换界面语言（持久化 + 触发重渲染） */
  private setLang(l: Lang): void {
    if (this.lang === l) return;
    this.lang = l;
    saveLang(l);
  }

  constructor() {
    super();
    this.self = getDevice();
    this.nick = this.self.deviceName;
    this.theme = this.loadTheme();
    document.documentElement.dataset.theme = this.theme;
    this.classList.toggle("dark", this.theme === "dark");
  }

  /** 主题：localStorage 记录优先，首次跟随系统 prefers-color-scheme */
  private loadTheme(): "light" | "dark" {
    try {
      const saved = localStorage.getItem("fsex_theme");
      if (saved === "dark" || saved === "light") return saved;
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch {
      return "light";
    }
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.httpUrl = `${location.protocol}//${location.host}`;
    // 向服务器要真实局域网 IP（二维码/地址用真实地址，避免 127.0.0.1）
    void fetchHealth().then((d) => {
      if (d && d.lanIp && d.lanIp !== "127.0.0.1") {
        this.httpUrl = `${location.protocol}//${d.lanIp}${d.port ? `:${d.port}` : ""}`;
      }
    });
    this.ws = new WsClient(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`, {
      onConnecting: () => { this.connState = "connecting"; },
      onOpen: () => {
        // 重连成功：停止自动重连流程，移除掉线类/断线重连中通知（onWelcome 负责同步数据）
        const wasReconnecting = this.autoReconnecting;
        this.autoReconnecting = false;
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        this.connState = "connected";
        this.notices = this.notices.filter((n) => n.level !== "shutdown" && n.level !== "maintenance" && n.level !== "disconnected" && n.level !== "reconnecting");
        if (wasReconnecting) this.flash(this.t("reconnect_success"));
        if (this.self) this.ws?.send({ type: "hello", device: this.self });
      },
      onClose: () => {
        this.connState = "disconnected";
        // 正在自动重连流程中（重连失败）→ 继续尝试或次数用尽转「服务器断开连接」
        if (this.autoReconnecting) { this.tryReconnect(); return; }
        // 服务器主动关闭/维护通知已存在 → 不自动重连，等用户点「确定」
        if (this.notices.some((n) => n.level === "shutdown" || n.level === "maintenance")) return;
        // 客户端断开 → 自动重连（最多 3 次，弹「断线重连中」）
        this.startAutoReconnect();
      },
      onNotice: (level, message) => {
        this.showNotice(level, message);
        // 服务器维护：直接弹通知并主动断开连接（等用户点确定重连）
        if (level === "maintenance") this.ws?.close();
      },
      onWelcome: (_s, msgs, peers) => { this.msgs = msgs; this.peers = peers; this.scrollToLatest(); },
      onAdd: (msg) => { if (!this.msgs.some((m) => m.id === msg.id)) { this.msgs = [...this.msgs, msg]; this.scrollToLatest(); } },
      onDel: (id) => { this.msgs = this.msgs.filter((m) => m.id !== id); },
      onPeers: (peers) => { this.peers = peers; },
      onRenamed: (device) => {
        if (this.self && device.deviceId === this.self.deviceId) { this.self = { ...device }; this.nick = device.deviceName; }
        this.peers = this.peers.map((p) => (p.deviceId === device.deviceId ? device : p));
      },
    }, false);
    this.ws.connect();
    window.addEventListener("resize", this.onResize);
    window.addEventListener("click", this.onDocClick);
    // 主界面任何位置滚轮都转发到滚动容器（桌面 .container / 移动 .list）
    this.addEventListener("wheel", this.onHostWheel, { passive: false });
    // 消息长按（移动端）：组件级 passive touchstart 委托（lit 模板 @touchstart 无法设 passive，会触发 scroll-blocking 警告）
    this.addEventListener("touchstart", this.onMsgTouchStart, { passive: true });
    // ESC：关闭预览 / 设置·二维码弹层 / 代码模式
    window.addEventListener("keydown", this.onKeyDown);
    // 代码模式失焦关闭：点击或焦点跑到代码编辑器外时退出代码模式
    document.addEventListener("pointerdown", this.onPointerDown, true);
    document.addEventListener("focusin", this.onFocusIn, true);
  }
  disconnectedCallback(): void { window.removeEventListener("resize", this.onResize); window.removeEventListener("click", this.onDocClick); this.removeEventListener("wheel", this.onHostWheel); this.removeEventListener("touchstart", this.onMsgTouchStart); window.removeEventListener("keydown", this.onKeyDown); document.removeEventListener("pointerdown", this.onPointerDown, true); document.removeEventListener("focusin", this.onFocusIn, true); this.ws?.close(); super.disconnectedCallback(); }
  private onResize = (): void => { this.requestUpdate(); this.scrollToLatest(); };
  /** ESC：依次关闭预览 → 设置/二维码弹层 → 代码模式 */
  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    if (this.preview) { this.closePreview(); return; }
    if (this.sheet) { this.sheet = null; return; }
    if (this.codeMode) { this.codeMode = false; return; }
  };
  /** 代码模式失焦关闭：点击代码编辑器外任意区域则退出代码模式 */
  private onPointerDown = (e: PointerEvent): void => {
    if (!this.codeMode) return;
    const target = (e.composedPath()[0] ?? e.target) as Node;
    // 代码编辑器 / 语言栏 / 发送按钮 / 代码模式开关（.bracebtn）都视为代码模式内部，不关闭
    const el = target instanceof Element ? target : null;
    if (el?.closest(".code-editor, .lang-bar, .send, .sendbtn, .bracebtn")) return;
    this.codeMode = false;
  };
  /** 代码模式失焦关闭：焦点（Tab/点击可聚焦元素）跑到代码编辑器外则退出 */
  private onFocusIn = (e: FocusEvent): void => {
    if (!this.codeMode) return;
    const target = (e.composedPath()[0] ?? e.target) as Node;
    const el = target instanceof Element ? target : null;
    if (el?.closest(".code-editor, .lang-bar, .send, .sendbtn, .bracebtn")) return;
    this.codeMode = false;
  };
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
  private deleteMsg(id: string): void { this.ws?.send({ type: "del", id }); this.flash(this.t("msg_deleted")); }

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
      this.flash(this.t("nick_invalid"));
      return;
    }
    this.ws?.send({ type: "rename", name: n });
    if (this.self) { const d = { ...this.self, deviceName: n }; this.self = d; saveDevice(d); }
    this.sheet = null;
  }
  private toggleTheme(): void {
    this.theme = this.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = this.theme;
    this.classList.toggle("dark", this.theme === "dark");
    try { localStorage.setItem("fsex_theme", this.theme); } catch { /* noop */ }
  }
  /** 打开二维码弹层并生成真实二维码 */
  private openQr(): void {
    this.sheet = "qr";
    if (!this.qrDataUrl) {
      QRCode.toDataURL(this.httpUrl, { width: 180, margin: 1, color: { dark: "#1a1a1a", light: "#ffffff" } })
        .then((url) => { this.qrDataUrl = url; })
        .catch(() => { this.flash(this.t("qr_failed")); });
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
        id: key, kind, sender: this.self ?? { deviceId: "", deviceName: this.t("upload_ph"), color: "#047878", platform: "other" },
        ts: Date.now(), file: { name: file.name, size: file.size },
      };
      this.msgs = [...this.msgs, placeholder];
      this.scrollToLatest();
      try {
        // 视频：上传前本地取首帧生成封面并上传到服务器（消息带 cover，网页直接加载图片；失败则无封面回退 canvas）
        if (kind === "video" && !rec.coverKey) {
          rec.coverKey = await this.extractVideoCover(file);
        }
        await uploadFile(file, (sent, total) => { rec.pct = Math.round((sent / total) * 100); this.uploads = [...this.uploads]; }, rec.coverKey);
        // 上传成功：移除占位卡（真实消息由 WS onAdd 广播，同 id 去重不冲突）
        this.msgs = this.msgs.filter((m) => m.id !== key);
        this.uploads = this.uploads.filter((x) => x !== rec);
      } catch (e) {
        console.error("上传失败:", e);
        if (file.size <= DIRECT_UPLOAD_LIMIT) {
          // 小文件（≤8MB 直接上传）：失败直接移除占位卡并提示（无断点续传价值）
          this.msgs = this.msgs.filter((x) => x.id !== key);
          this.uploads = this.uploads.filter((x) => x !== rec);
          this.flash(this.t("upload_fail", { name: file.name }));
        } else {
          // 大文件（分片上传）：保留占位卡，标记失败 → 点击可断点续传（File 引用仍在内存）
          rec.fail = true; rec.pct = -1;
          this.uploads = [...this.uploads];
          this.msgs = [...this.msgs];
          this.flash(this.t("upload_interrupted", { name: file.name }));
        }
      }
    }
    this.scrollToLatest();
  }
  private onDrop(e: DragEvent): void { e.preventDefault(); void this.handleFiles(e.dataTransfer?.files ?? null); }

  /** 视频首帧封面：本地取帧（ObjectURL + video + canvas）→ 上传到服务器 → 返回 coverKey；失败返回 undefined */
  private async extractVideoCover(file: File): Promise<string | undefined> {
    let url: string | undefined;
    try {
      url = URL.createObjectURL(file);
      const v = document.createElement("video");
      v.muted = true;
      v.preload = "metadata";
      v.src = url;
      await new Promise<void>((res, rej) => {
        v.onloadeddata = () => res();
        v.onerror = () => rej(new Error("video load fail"));
      });
      // seek 强制解码一帧再取（loadeddata 直接 drawImage 可能拿到黑帧）；纯黑自动换时间点重试
      const canvas = await this.grabVideoFrame(v);
      if (!canvas) return undefined;
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.7));
      if (!blob) return undefined;
      return await apiUploadCover(blob);
    } catch {
      return undefined;
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }

  /** 取视频一帧做封面：从前往后梯度采样 + 「亮度区间 + 对比度」评分，首个合格即停；全不合格取最高分；全部失败返回 null */
  private async grabVideoFrame(v: HTMLVideoElement): Promise<HTMLCanvasElement | null> {
    const dur = v.duration && isFinite(v.duration) ? v.duration : 0;
    const candidates = [0.3, 1, 2, 3, 5, 8];
    if (dur > 0) {
      // 追加按比例的中后段采样（短视频自动 clamp），长视频封面更居中
      candidates.push(dur * 0.15, dur * 0.3);
    }
    let best: { c: HTMLCanvasElement; score: number } | null = null;
    for (const base of candidates) {
      const t = dur > 0 ? Math.min(base, dur * 0.9) : base;
      await new Promise<void>((res) => {
        let done = false;
        const finish = (): void => { if (!done) { done = true; res(); } };
        v.onseeked = finish;
        try {
          v.currentTime = t;
        } catch {
          /* noop */
        }
        setTimeout(finish, 800); // 兜底：解码慢/不支持 seek 时超时继续
      });
      const got = this.drawVideoFrame(v);
      if (!got) continue;
      if (got.score >= 1) return got.c; // 合格：亮度在区间且对比度足够
      if (!best || got.score > best.score) best = got;
    }
    return best ? best.c : null;
  }

  /** 把 video 当前帧绘制到 canvas，并计算「亮度 + 对比度」画面分；黑场/白闪/未解码帧分低 */
  private drawVideoFrame(v: HTMLVideoElement): { c: HTMLCanvasElement; score: number } | null {
    const c = document.createElement("canvas");
    c.width = v.videoWidth || 640;
    c.height = v.videoHeight || 360;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, c.width, c.height);
    try {
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const samples: number[] = [];
      let sum = 0;
      for (let i = 0; i < d.length; i += 4 * 101) {
        const luma = ((d[i] ?? 0) + (d[i + 1] ?? 0) + (d[i + 2] ?? 0)) / 3;
        samples.push(luma);
        sum += luma;
      }
      const n = samples.length;
      if (n === 0) return null;
      const avg = sum / n;
      let varSum = 0;
      for (const s of samples) varSum += (s - avg) * (s - avg);
      const variance = varSum / n;
      // 亮度分：平均亮度落在 [30,225] 给满分（过暗=黑场、过亮=白闪，线性衰减）
      const L_MIN = 30, L_MAX = 225;
      const lumaScore = avg < L_MIN ? Math.max(0, avg / L_MIN)
        : avg > L_MAX ? Math.max(0, (255 - avg) / (255 - L_MAX)) : 1;
      // 对比度分：方差越高越可能有内容，≥150 满分
      const varScore = Math.min(1, variance / 150);
      const score = lumaScore * 0.5 + varScore * 0.5;
      return { c, score };
    } catch {
      return null; // 读取受限忽略
    }
  }

  /** 断点续传：点击失败的大文件占位卡，用内存里的 File 重新上传（同 sha → 服务端自动续传） */
  private async retryUpload(rec: UploadRec): Promise<void> {
    if (!rec.file) return;
    if (!this.debounceKey("retry-" + rec.key, 800)) return;
    rec.fail = false; rec.pct = 0;
    this.uploads = [...this.uploads];
    this.msgs = [...this.msgs];
    try {
      await uploadFile(rec.file, (sent, total) => { rec.pct = Math.round((sent / total) * 100); this.uploads = [...this.uploads]; }, rec.coverKey);
      // 续传成功：移除占位卡（真实消息由 WS onAdd 广播，同 id 去重）
      this.msgs = this.msgs.filter((m) => m.id !== rec.key);
      this.uploads = this.uploads.filter((x) => x !== rec);
      this.flash(this.t("resume_ok", { name: rec.name }));
    } catch (e) {
      console.error("续传失败:", e);
      // 彻底失败且无法续传：删除占位卡 + 提示
      this.msgs = this.msgs.filter((m) => m.id !== rec.key);
      this.uploads = this.uploads.filter((x) => x !== rec);
      this.flash(this.t("resume_fail", { name: rec.name }));
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
  private async captureVideoCover(m: MsgDataT): Promise<void> {
    if (this.videoCovers.has(m.id)) return;
    const v = this.shadowRoot?.querySelector<HTMLVideoElement>(`.msg[data-id="${m.id}"] .card.video video`);
    if (!v || !v.videoWidth || !v.videoHeight) return;
    try {
      // seek 强制解码一帧再取（loadeddata 直接 drawImage 可能黑帧）
      const canvas = await this.grabVideoFrame(v);
      if (!canvas) return;
      this.videoCovers.set(m.id, canvas.toDataURL("image/jpeg", 0.72));
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
      void this.copyToClipboard(t).then((ok) => this.flash(ok ? this.t("code_copied") : this.t("copy_failed")));
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
        this.flash(this.t("download_started"));
      } else {
        this.flash(this.t("no_download"));
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
  /** 提示弹窗池：每次追加一个独立 toast；淡入 → 停留 → 上移固定距离同时淡出 → 移除；多个垂直堆叠 */
  private flash(t: string): void {
    const id = ++this.toastSeq;
    this.toasts = [...this.toasts, { id, text: t, leaving: false, show: false }];
    // 下一帧加 show → CSS transition 淡入（若首次渲染即 show 会没有淡入效果）
    requestAnimationFrame(() => {
      this.toasts = this.toasts.map((x) => (x.id === id ? { ...x, show: true } : x));
    });
    // 停留 2000ms 后开始上移淡出
    window.setTimeout(() => {
      this.toasts = this.toasts.map((x) => (x.id === id ? { ...x, leaving: true } : x));
    }, 2000);
    // 上移淡出动画（0.4s）完成后移除
    window.setTimeout(() => {
      this.toasts = this.toasts.filter((x) => x.id !== id);
    }, 2500);
  }

  /* ---------- 服务器通知（异常/维护/关闭） ---------- */
  private noticeLevelLabel(level: string): string {
    switch (level) {
      case "shutdown":
      case "maintenance": return this.t("notice_maintenance"); // 服务器主动关闭/维护 → 统一「服务器维护中」
      case "disconnected": return this.t("notice_disconnected");
      case "reconnecting": return this.t("notice_reconnecting");
      case "error": return this.t("notice_error");
      case "warn": return this.t("notice_warn");
      default: return this.t("notice_info");
    }
  }
  private showNotice(level: string, message: string): void {
    // 掉线类通知（服务器主动关闭/维护/客户端断开）内容统一为操作提示，标题由 level 决定
    const dropped = level === "shutdown" || level === "maintenance" || level === "disconnected";
    if (dropped) message = this.t("notice_retry");
    // 通知弹窗池：每次追加一个独立弹窗（可多个并存），各自可关闭/重连；
    // 去重：同 level 且同 message 的通知已存在时不重复弹（避免掉线通知刷屏）
    if (this.notices.some((n) => n.level === level && n.message === message)) return;
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
    if (!n) return;
    if (n.level === "shutdown" || n.level === "maintenance" || n.level === "disconnected") {
      // 掉线类确定：关闭当前通知 → 弹「断线重连中」并自动重连
      this.dismissNotice(id);
      this.startAutoReconnect();
      return;
    }
    // 其他通知：立即关闭并强制重连
    this.dismissNotice(id);
    this.connState = "connecting";
    this.ws?.forceReconnect();
  }

  /* ---------- 断线自动重连（最多 3 次） ---------- */
  /** 按 level 移除通知 */
  private dismissNoticeLevel(level: string): void {
    this.notices = this.notices.filter((n) => n.level !== level);
  }
  /** 更新「断线重连中」通知的剩余次数文案 */
  private updateReconnectNotice(): void {
    const left = String(Math.max(this.reconnectLeft, 0));
    this.notices = this.notices.map((n) => (n.level === "reconnecting" ? { ...n, message: this.t("notice_reconnect_left", { n: left }) } : n));
  }
  /** 开始断线自动重连：弹「断线重连中」通知并尝试连接（最多 3 次） */
  private startAutoReconnect(): void {
    this.autoReconnecting = true;
    this.reconnectLeft = 3;
    this.dismissNoticeLevel("reconnecting");
    this.showNotice("reconnecting", this.t("notice_reconnect_left", { n: String(this.reconnectLeft) }));
    this.tryReconnect();
  }
  /** 尝试一次重连；次数用尽则关闭「断线重连中」并弹「服务器断开连接」 */
  private tryReconnect(): void {
    if (this.reconnectLeft <= 0) {
      this.autoReconnecting = false;
      this.dismissNoticeLevel("reconnecting");
      this.showNotice("disconnected", this.t("notice_retry"));
      return;
    }
    this.updateReconnectNotice();
    this.connState = "connecting";
    this.reconnectLeft--;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => { this.ws?.connect(); }, 1000);
  }

  private renderNotice() {
    if (this.notices.length === 0) return nothing;
    return html`<div class="notice-mask">${this.notices.map((n) => {
      const isReconnecting = n.level === "reconnecting";
      const locked = isReconnecting || n.level === "shutdown" || n.level === "maintenance" || n.level === "disconnected";
      return html`<div class="notice-panel ${n.level}">
        ${locked ? nothing : html`<button class="nclose" title=${this.t("close")} @click=${() => { if (this.debounceKey("notice-close-" + n.id, 300)) this.dismissNotice(n.id); }}>✕</button>`}
        <div class="ntitle">${this.noticeLevelLabel(n.level)}</div>
        <div class="nbody">${n.message}${isReconnecting ? html`<span class="dots"></span>` : ""}</div>
        ${isReconnecting ? nothing : html`<button class="btn" @click=${() => this.confirmNotice(n.id)}>${this.t("reconnect_confirm")}</button>`}
      </div>`;
    })}</div>`;
  }
  private copyText(t: string): void {
    void this.copyToClipboard(t).then((ok) => this.flash(ok ? this.t("copied") : this.t("copy_failed")));
  }
  private copyCode(m: MsgDataT): void {
    void this.copyToClipboard(m.code?.content ?? "").then((ok) => this.flash(ok ? this.t("code_copied") : this.t("copy_failed")));
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
    if (this.msgs.length === 0) return html`<div class="empty">${this.t("empty_list")}</div>`;
    const mobile = window.innerWidth <= 640;
    const ordered = mobile ? this.msgs : [...this.msgs].reverse();
    const out: unknown[] = [];
    let lastDay = "";
    for (const m of ordered) {
      const day = dayLabel(this.lang, m.ts, mobile);
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
      const mm = html`<div class="ph-mm"><span class="name ${retryable ? "retry" : ""}">${failed ? (retryable ? this.t("resume_click") : this.t("upload_failed_ph")) : f?.name ?? this.t("upload_ph")}</span><span class="size">${f ? fmtSize(f.size) : ""}</span></div>`;
      // 操作行（同真实消息 .ops：下载占位按钮）
      const ops = html`<div class="ph-ops"><span class="btn secondary ph-down">${I_DOWN}${this.t("download")}</span></div>`;
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
    const delBtn = html`<button class="del-corner" title=${this.t("delete")} @click=${() => { if (this.debounceKey("del-" + m.id, 500)) this.deleteMsg(m.id); }}>${I_TRASH}</button>`;
    const copyBtn = html`<button class="btn" @click=${() => { if (this.debounceKey("copy-" + m.id, 800)) this.copyText(m.text ?? ""); }}>${I_COPY}${this.t("copy")}</button>`;
    const copyCodeBtn = html`<button class="btn" @click=${() => { if (this.debounceKey("copy-" + m.id, 800)) this.copyCode(m); }}>${I_COPY}${this.t("copy")}</button>`;
    const downBtn = html`<a class="btn" href="${f?.url ?? "#"}" download @click=${(e: Event) => { if (!this.debounceKey("down-" + m.id, 800)) e.preventDefault(); }}>${I_DOWN}${this.t("download")}</a>`;
    const head = html`<span class="who">${m.sender.deviceName}</span>${this.self && m.sender.deviceId === this.self.deviceId ? html`<span class="me">${this.t("me")}</span>` : ""}<time>${fmtTime(m.ts)}</time>`;

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
        const cover = m.file?.cover ?? this.videoCovers.get(m.id);
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
            <div class="mm"><span class="name">${f?.name ?? this.t("audio_name")}</span><span class="size">${f ? fmtSize(f.size) : ""}</span></div>
            <div class="ops">${downBtn}</div>${delBtn}
          </div>`;
        break;
      case "file":
      default:
        content = html`<div class="card file">
            <div class="file">
              <span class="ic">${I_FILE}</span>
              <div class="meta"><span class="name">${f?.name ?? this.t("file_name")}</span><span class="sub">${f ? `${fmtSize(f.size)} · ${fmtType(this.lang, f.name, f.mime)}` : ""}</span></div>
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
      <label>${this.t("lang")}</label>
      <div class="lang-pick" @click=${(e: Event) => { e.stopPropagation(); if (this.debounceKey("lang-toggle", 250)) this.langOpen = !this.langOpen; }}>
        <span class="lang-cur">${langLabel(this.codeLang)}</span><span class="lang-arr">${upward ? "▴" : "▾"}</span>
        ${this.langOpen ? html`<div class="lang-list">${LANG_LIST.map((l) => html`<div class="lang-opt ${l === this.codeLang ? "on" : ""}" @click=${(e: Event) => { e.stopPropagation(); if (this.debounceKey("lang-" + l, 300)) { this.codeLang = l; this.langOpen = false; } }}>${langLabel(l)}</div>`)}</div>` : nothing}
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
        <button class="iconbtn" title=${this.t("qr")} @click=${() => { if (this.debounceKey("qr", 300)) this.openQr(); }}>${I_QR}</button>
        <button class="iconbtn" title=${this.t("theme")} @click=${() => { if (this.debounceKey("theme", 300)) this.toggleTheme(); }}>${this.theme === "dark" ? I_MOON : I_SUN}</button>
      </header>

      <!-- 桌面端：顶部上传区 -->
      <section class="upload" @drop=${this.onDrop} @dragover=${(e: DragEvent) => e.preventDefault()}>
        <div class="upload-row ${this.codeMode ? "code-mode" : ""}">
          <button class="btn btn-file" @click=${() => { if (this.debounceKey("file", 400)) this.shadowRoot?.querySelector<HTMLInputElement>(".file-input")?.click(); }}>${I_UP}${this.t("file")}</button>
          <input class="input" .value=${this.text} placeholder=${this.t("input_placeholder")} @input=${(e: Event) => (this.text = (e.target as HTMLInputElement).value)} @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" && this.debounceKey("send", 600)) this.sendText(); }} />
          <div class="code-editor ${this.codeMode ? "open" : ""}">
            <div class="ce-top">${this.renderLangBar(false)}</div>
            <textarea .value=${this.codeText} placeholder=${this.t("code_placeholder")} @input=${(e: Event) => (this.codeText = (e.target as HTMLTextAreaElement).value)} @keydown=${(e: KeyboardEvent) => { if (e.ctrlKey && e.key === "Enter" && this.debounceKey("send", 600)) this.sendCode(); }}></textarea>
          </div>
          <button class="bracebtn ${this.codeMode ? "on" : ""}" title=${this.t("code_mode")} @click=${() => { if (this.debounceKey("codemode", 300)) { this.codeMode = !this.codeMode; this.focusCodeEditor(); } }}>&#123;&#125;</button>
          <button class="btn send" @click=${() => { if (this.debounceKey("send", 600)) this.codeMode ? this.sendCode() : this.sendText(); }}>${this.t("send")}</button>
        </div>
        <input type="file" class="file-input" multiple hidden @change=${(e: Event) => void this.handleFiles((e.target as HTMLInputElement).files)} />
      </section>

      <main class="list">${this.renderMessages()}</main>

      <!-- 移动端：底部输入条 -->
      <footer class="composer ${this.codeMode ? "code-mode" : ""}">
        <div class="composer-inner">
          <button class="addbtn" title=${this.t("choose_file")} @click=${() => { if (this.debounceKey("file", 400)) this.shadowRoot?.querySelector<HTMLInputElement>(".file-input")?.click(); }}>${I_PLUS}</button>
          <button class="bracebtn ${this.codeMode ? "on" : ""}" @click=${() => { if (this.debounceKey("codemode", 300)) { this.codeMode = !this.codeMode; this.focusCodeEditor(); } }}>&#123;&#125;</button>
          ${this.codeMode
            ? this.renderLangBar(true)
            : html`<input class="input" .value=${this.text} placeholder=${this.t("input_placeholder_mobile")} @input=${(e: Event) => (this.text = (e.target as HTMLInputElement).value)} @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" && this.debounceKey("send", 600)) this.sendText(); }} />`}
          <button class="sendbtn" @click=${() => { if (this.debounceKey("send", 600)) this.codeMode ? this.sendCode() : this.sendText(); }}>${I_SEND}</button>
        </div>
        ${this.codeMode ? html`<div class="code-editor open"><textarea .value=${this.codeText} placeholder=${this.t("code_placeholder")} @input=${(e: Event) => (this.codeText = (e.target as HTMLTextAreaElement).value)} @keydown=${(e: KeyboardEvent) => { if (e.ctrlKey && e.key === "Enter" && this.debounceKey("send", 600)) this.sendCode(); }}></textarea></div>` : nothing}
      </footer>
      </div>

      ${this.sheet ? this.renderSheet() : nothing}
      ${pv ? this.renderPreview(pv) : nothing}
      ${this.renderNotice()}
      ${this.codeMode && window.innerWidth <= 640 ? html`<div class="code-mask" @wheel=${(e: WheelEvent) => { e.preventDefault(); e.stopPropagation(); }} @click=${() => { if (this.debounceKey("code-mask", 300)) this.codeMode = false; }}></div>` : nothing}
      ${this.delBubble ? html`
        <div class="del-mask" @click=${() => { if (this.debounceKey("del-mask", 300)) this.closeDelBubble(); }}></div>
        <div class="del-bubble ${this.delBubble.above ? "above" : ""}" style="left:${this.delBubble.x}px;top:${this.delBubble.y}px">
          <div class="db-text">${this.t("del_text")}</div>
          <div class="db-ops">
            <button class="btn cancel" @click=${() => { if (this.debounceKey("del-cancel", 300)) this.closeDelBubble(); }}>${this.t("cancel")}</button>
            <button class="btn del" @click=${() => { if (this.debounceKey("del-ok", 600)) this.confirmDelBubble(); }}>${this.t("delete")}</button>
          </div>
        </div>` : nothing}
      ${this.toasts.length ? html`<div class="toasts">${this.toasts.map((to) => html`<div class="toast ${to.leaving ? "leaving" : to.show ? "show" : ""}">${to.text}</div>`)}</div>` : nothing}
    `;
  }

  private renderSheet() {
    const s = this.sheet;
    const close = () => (this.sheet = null);
    let content: unknown;
    if (s === "attach") {
      content = html`<div class="attach-grid">
        <button class="att" @click=${() => { if (this.debounceKey("attach-album", 300)) this.flash(this.t("proto_album")); }}><span class="ai">${I_IMG}</span>${this.t("attach_album")}</button>
        <button class="att" @click=${() => { if (this.debounceKey("attach-camera", 300)) this.flash(this.t("proto_camera")); }}><span class="ai pink">📷</span>${this.t("attach_camera")}</button>
        <button class="att" @click=${() => { if (this.debounceKey("attach-file", 400)) { this.shadowRoot?.querySelector<HTMLInputElement>(".file-input")?.click(); close(); } }}><span class="ai">${I_FILE}</span>${this.t("attach_file")}</button>
      </div>`;
    } else if (s === "progress") {
      content = html`<div class="qlist">${this.uploads.length === 0 ? html`<div class="qitem-row"><div class="qname" style="color:var(--muted)">${this.t("no_upload_task")}</div></div>` : this.uploads.map((u) => html`<div class="qitem-row"><div class="qname">${u.name} <small>${u.pct < 0 ? this.t("failed") : fmtSize(u.size)}</small></div><div class="qbar"><i style="width:${u.pct < 0 ? 100 : u.pct}%"></i></div><div class="qmeta"><span>${u.pct < 0 ? this.t("upload_failed") : u.pct + "%"}</span></div></div>`)}</div>`;
    } else if (s === "settings") {
      // WS 地址与 httpUrl 同源（真实局域网 IP + 端口），仅协议不同
      const wsUrl = this.httpUrl.replace(/^https?:/, location.protocol === "https:" ? "wss:" : "ws:") + "/ws";
      content = html`<div class="settings">
        <!-- 连接 -->
        <p class="st-sec">${this.t("st_conn")}</p>
        <div class="st-conn"><span class="dot ${this.connState}"></span><b style="color:var(${this.connState === "connected" ? "--primary" : this.connState === "connecting" ? "--warn" : "--danger"})">${this.connState === "connected" ? this.t("connected") : this.connState === "connecting" ? this.t("connecting") : this.t("disconnected")}</b><span class="muted">${this.t("lan")}</span></div>
        <p class="muted">${this.t("http_label")}<code>${this.httpUrl}</code></p>
        <p class="muted">${this.t("ws_label")}<code>${wsUrl}</code></p>
        <hr />
        <!-- 设备身份 / 昵称 -->
        <p class="st-note">${this.t("st_nicknote")}</p>
        <label>${this.t("my_nick")}
          <input class="field" .value=${this.nick} maxlength="10" placeholder=${this.t("nick_placeholder")} @input=${(e: Event) => (this.nick = (e.target as HTMLInputElement).value.replace(/[^A-Za-z0-9_]/g, ""))} @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" && this.debounceKey("rename", 600)) this.rename(); }} />
        </label>
        <p class="muted">${this.t("device_fp")}</p>
        <code class="fp">${this.self?.deviceId ?? ""}</code>
        <hr />
        <!-- 语言切换 -->
        <p class="st-sec">${this.t("st_lang")}</p>
        <div class="st-lang">
          <label class="lang-opt"><input type="radio" name="fsex-lang" .checked=${this.lang === "zh"} @change=${() => this.setLang("zh")} />${this.t("lang_zh")}</label>
          <label class="lang-opt"><input type="radio" name="fsex-lang" .checked=${this.lang === "en"} @change=${() => this.setLang("en")} />${this.t("lang_en")}</label>
        </div>
        <!-- 工具（移动端隐藏） -->
        <div class="tool-sec">
          <hr />
          <p class="st-sec">${this.t("st_tool")}</p>
          <a class="btn tool" href="/tool/QuickSendTool.exe" download>${I_DOWN}${this.t("download_qst")}</a>
          <p class="muted">${this.t("tool_note")}</p>
        </div>
        <!-- 关于 -->
        <hr />
        <p class="st-sec">${this.t("st_about")}</p>
        <a class="btn secondary tool" href="https://github.com/NoRainLand/filesyncEX" target="_blank" rel="noopener">${I_LINK}${this.t("goto_github")}</a>
      </div>`;
    } else if (s === "qr") {
      content = html`<div class="qrbox">${this.qrDataUrl ? html`<img src="${this.qrDataUrl}" alt=${this.t("qr")} />` : html`<div class="qr-loading">${this.t("qr_loading")}</div>`}</div><p>${this.t("qr_hint", { url: this.httpUrl })}</p>`;
    }
    return html`<div class="mask" @click=${close}><div class="panel-shell ${s === "qr" ? "qr" : ""} ${s === "settings" ? "settings-panel" : ""}"><div class="panel" @click=${(e: Event) => e.stopPropagation()}><div class="handle"></div><div class="ptitle" @click=${close}>${s === "attach" ? this.t("sheet_attach") : s === "progress" ? this.t("sheet_progress") : s === "settings" ? this.t("sheet_settings") : this.t("sheet_qr")}</div>${content}</div></div></div>`;
  }

  private renderPreview(pv: { kind: string; msg: MsgDataT }) {
    const f = pv.msg.file;
    let body: unknown;
    if (pv.kind === "image") body = html`<img class="ph" src="${f?.url ?? ""}" alt="" @mousedown=${(e: MouseEvent) => this.startDrag(e)} />`;
    else if (pv.kind === "video") body = html`<video class="ph" src="${f?.url ?? ""}" controls playsinline webkit-playsinline></video>`;
    else if (pv.kind === "audio") body = html`<audio class="ph" src="${f?.url ?? ""}" controls style="width:80%"></audio>`;
    else if (pv.kind === "code") body = html`<div class="codeview">${unsafeHTML(highlightCode(pv.msg.code?.content ?? "", pv.msg.code?.lang ?? "ts"))}</div>`;
    const title = pv.kind === "image" ? this.t("pv_image") : pv.kind === "video" ? this.t("pv_video") : pv.kind === "audio" ? this.t("pv_audio") : this.t("pv_code");
    const footBtn = pv.kind === "code" ? html`<button class="btn" @click=${() => { if (this.debounceKey("pv-action", 600)) this.previewAction(); }}>${this.t("copy")}</button>` : html`<button class="btn" @click=${() => { if (this.debounceKey("pv-action", 600)) this.previewAction(); }}>${this.t("download")}</button>`;
    return html`<div class="viewer open"><div class="vtop"><span class="vt">${title}</span><button class="close" @click=${() => { if (this.debounceKey("pv-close", 300)) this.closePreview(); }}>✕</button></div><div class="vbody ${pv.kind === "image" ? "pv-img" : ""}" @click=${(e: Event) => { if (e.target === e.currentTarget && this.debounceKey("pv-close", 300)) this.closePreview(); }}>${body}</div><div class="vfoot">${footBtn}<button class="btn pink" @click=${() => { if (this.debounceKey("pv-del", 600)) { this.deleteMsg(pv.msg.id); this.closePreview(); } }}>${this.t("delete")}</button></div></div>`;
  }
}

const LANG_LIST = ["ts", "js", "python", "ini", "bat", "json", "sql", "html", "css"];
const LANG_LABEL: Record<string, string> = { ts: "TypeScript", js: "JavaScript", python: "Python", ini: "INI / Config", bat: "Batch (.bat)", json: "JSON", sql: "SQL", html: "HTML", css: "CSS" };
const langLabel = (l: string): string => LANG_LABEL[l] ?? l;

customElements.define("filesync-app", FilesyncApp);
