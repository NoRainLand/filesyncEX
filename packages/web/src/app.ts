import { html, unsafeCSS, LitElement, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import QRCode from "qrcode";
import ClipboardJS from "clipboard";
import type { DeviceInfoT, MsgDataT } from "@filesyncex/protocol";
import { getDevice, saveDevice } from "./device.js";
import { WsClient } from "./ws.js";
import { uploadFile, FALLBACK_LIMITS, apiUploadCover, apiUploadMsgCover, fetchHealth, fmtLimitBytes, type UploadLimitsT } from "./api.js";
import type { Lang } from "./i18n.js";
import { loadLang, saveLang, dict, dayLabel, fmtType } from "./i18n.js";
import prismTheme from "./prism-theme.css?inline";
import appCss from "./app.css?inline";

import { fmtTime, fmtSize, ellipsizeFileName, fileKind, waveBars } from "./ui/helpers.js";
import { highlightCode } from "./ui/prism.js";
import { I_QR, I_SUN, I_MOON, I_PLUS, I_SEND, I_FILE, I_IMG, I_COPY, I_DOWN, I_LINK, I_UP, I_PLAY, I_PAUSE, I_TRASH } from "./ui/icons.js";
import { renderMessages, renderNotice, renderLangBar, ctx, type UploadRec } from "./ui/messages.js";
import { LANG_LIST, langLabel } from "./ui/lang.js";

/* ================= 主组件 ================= */


export class FilesyncApp extends LitElement {
  static styles = [unsafeCSS(appCss), unsafeCSS(prismTheme)];

  static properties = {
    msgs: { state: true }, peers: { state: true }, self: { state: true },
    connState: { state: true }, notices: { state: true },
    text: { state: true }, codeMode: { state: true }, codeLang: { state: true }, codeText: { state: true },
    uploads: { state: true }, sheet: { state: true }, preview: { state: true }, nick: { state: true },
    httpUrl: { state: true }, lanIps: { state: true }, limits: { state: true }, appVer: { state: true }, theme: { state: true }, toasts: { state: true }, delBubble: { state: true }, langOpen: { state: true }, playingId: { state: true }, qrDataUrl: { state: true }, lang: { state: true },
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
  /** 视频首帧封面（canvas 取帧 dataURL，key=消息 id）；ui/messages.ts 渲染时读取 */
  videoCovers = new Map<string, string>();
  nick = "";
  httpUrl = "";
  /** 备选局域网地址（多网卡机器上首个地址未必可达，二维码面板列出备用） */
  lanIps: string[] = [];
  /** 服务器下发的上传限制（设置界面显示 + 上传前预检 + 失败分支判定；来自 /api/health） */
  limits: UploadLimitsT | null = null;
  /**
   * 已解码完成的缩略图 URL（图片 / 视频封面）。
   * 「占位卡 → 真实消息」切换时，真实缩略图往往还要解码一帧；用这个集合决定何时揭掉占位层，避免闪白。
   */
  readyThumbs = new Set<string>();

  /** 直传阈值（服务器下发优先，未取到时用与服务端一致的兜底值）：全前端只此一处判定，避免硬编码漂移 */
  private directUploadLimit(): number {
    return this.limits?.directUpload ?? FALLBACK_LIMITS.directUpload;
  }
  /** 应用版本（来自 /api/health，默认与当前版本一致） */
  appVer = "unknown";
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
        // 备选地址：排除当前使用的主地址（多网卡/虚拟网卡时提示用户可改用哪个）
        this.lanIps = (d.lanIps ?? []).filter((ip) => ip !== d.lanIp).map((ip) => `${location.protocol}//${ip}${d.port ? `:${d.port}` : ""}`);
      }
      if (d?.version) this.appVer = d.version;
      if (d?.limits) this.limits = d.limits;
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
      onAdd: (msg) => {
        if (this.msgs.some((m) => m.id === msg.id)) return;
        // 本机刚上传完的文件：把「占位卡」原地换成真实消息（而不是删掉再插入），避免闪一下
        const rec = this.uploads.find((u) => u.realId === msg.id);
        if (rec) {
          this.msgs = this.msgs.map((m) => (m.id === rec.key ? { ...msg, ts: m.ts, id: rec.key, sender: m.sender } : m));
          this.settleUpload(rec, msg);
        } else {
          this.msgs = [...this.msgs, msg];
          this.scrollToLatest();
        }
      },
      onUpdate: (msg) => { this.msgs = this.msgs.map((m) => (m.id === msg.id ? msg : m)); },
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
    this.flash(this.t("nick_saved"));
    // 注意：这里**不再关闭设置面板** —— 用户回车改名后应留在设置界面（此前 sheet=null 导致回车即关闭）
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
        const res = await uploadFile(
          file,
          (sent, total) => {
            // 哈希阶段与上传阶段的字节数都会回调（哈希进度先跑到 100%），这里统一折算成百分比
            rec.pct = Math.max(0, Math.min(100, Math.round((sent / total) * 100)));
            // 首个非 0 百分比出现时清掉阶段标记 —— 进度环动起来就不需要文字提示了
            if (rec.phase && rec.pct > 0) rec.phase = undefined;
            this.uploads = [...this.uploads];
          },
          rec.coverKey,
          // 阶段提示：0% 时告知「正在准备/上传」，分片传完后告知「正在完成上传」，避免看起来卡死
          (phase) => { rec.phase = phase; if (phase === "finishing") rec.pct = 100; this.uploads = [...this.uploads]; }
        );
        // 上传成功：**不删**占位卡 —— 记下真实消息 id，等 WS 广播到达时原地替换（避免「删掉再插入」闪一下）。
        // 直传路径服务端不广播（res.msg 直接返回），这里立即就地落成真实消息。
        this.finishUpload(rec, res.msg?.id, res.msg);
      } catch (e) {
        // 预期内的拒绝（如超过单文件上限）用 warn，真正的异常才用 error —— 避免污染控制台错误面板
        const reason = e instanceof Error ? e.message : String(e);
        const expected = /文件过大|超过单文件上限|校验失败/.test(reason);
        (expected ? console.warn : console.error)("上传失败:", e);
        // 提示优先展示服务端/预检给出的**具体原因**（如「超过单文件上限 2.0 MB」），否则回退到通用文案
        const tip = expected && reason ? reason : null;
        if (file.size <= this.directUploadLimit()) {
          // 直传文件（≤ 服务器下发的直传阈值）：失败直接移除占位卡并提示（无断点续传价值）
          this.msgs = this.msgs.filter((x) => x.id !== key);
          this.uploads = this.uploads.filter((x) => x !== rec);
          this.flash(tip ?? this.t("upload_fail", { name: file.name }));
        } else {
          // 大文件（分片上传）：保留占位卡，标记失败 → 点击可断点续传（File 引用仍在内存）
          rec.fail = true; rec.pct = -1; rec.phase = undefined;
          this.uploads = [...this.uploads];
          this.msgs = [...this.msgs];
          this.flash(tip ?? this.t("upload_interrupted", { name: file.name }));
        }
      }
    }
    this.scrollToLatest();
  }
  private onDrop(e: DragEvent): void { e.preventDefault(); void this.handleFiles(e.dataTransfer?.files ?? null); }

  /**
   * 上传收尾：把占位卡原地换成真实消息。
   *
   * 关键点是**不要**「先删占位卡、等广播再插入」—— 那是两次独立渲染，中间会有一帧空档（表现为闪一下）。
   * 这里保留占位元素（id 仍是 upload-<key>），只把内容换成真实消息，id 留到动画结束后再改，
   * 于是整个切换只有一次重绘、没有空档。
   *
   * @param realId 真实消息 id；WS 广播尚未到达（或已到达）时都能正确收敛
   * @param msg    直传路径服务端不广播，直接把响应里的消息就地落成真实消息
   */
  private finishUpload(rec: UploadRec, realId: string | undefined, msg?: MsgDataT): void {
    const key = rec.key; // 占位卡 id（先存下来，下面要把 rec.key 换成真实 id）
    // 响应里带回真实消息（直传路径服务端不广播）→ 原地落成真实消息，不留第二次重绘
    if (msg) {
      this.msgs = this.msgs.map((m) => (m.id === key ? { ...msg, ts: m.ts, sender: m.sender } : m));
      rec.key = msg.id;
      this.settleUpload(rec, msg);
      return;
    }
    if (!realId) return; // 服务端没给出 id（极端情况）：留在「正在完成上传」，等广播接管
    // WS 广播可能比 HTTP 响应先到：先把 id 记到记录上，广播到达时 onAdd 即可原地替换
    rec.realId = realId;
    window.setTimeout(() => {
      // 广播已先到并完成了替换（该 id 已在消息列表里）→ 这里什么都不做
      if (this.msgs.some((m) => m.id === realId)) return;
      this.msgs = this.msgs.map((m) => (m.id === key ? { ...m, id: realId, sender: this.self ?? m.sender } : m));
      rec.key = realId;
      const real = this.msgs.find((m) => m.id === realId);
      if (real) this.settleUpload(rec, real);
      // WS 一直没把消息推回来：占位卡先停在「正在完成上传」，再给一句兜底文案，避免误以为失败
      window.setTimeout(() => {
        if (!this.uploads.includes(rec)) return;
        rec.phase = "saved";
        rec.settling = false;
        this.uploads = [...this.uploads];
      }, 12000);
    }, 340);
  }

  /** 记账：标记「不再展示占位外观」，然后等缩略图解码（或兜底超时）后从上传队列移除 */
  private settleUpload(rec: UploadRec, msg: MsgDataT): void {
    rec.settling = true;
    rec.phase = undefined;
    rec.realId = msg.id;
    this.uploads = [...this.uploads];
    const url = msg.kind === "image" ? (msg.file?.url ?? "") : msg.kind === "video" ? (msg.file?.cover ?? "") : "";
    if (!url) {
      // 音频/普通文件没有缩略图要等，直接揭层（渲染结构本来就与真实卡片一致）
      setTimeout(() => this.markThumbReady(""), 340);
      return;
    }
    // 兜底：图片解码失败 / 网速极慢时不能一直挂着占位卡
    window.setTimeout(() => this.markThumbReady(url), 3000);
  }

  /** 缩略图解码完成（img onload/onerror，兜底定时器也会调用）→ 揭掉占位层并收掉已完成的上传记录 */
  private markThumbReady(url: string): void {
    if (url && this.readyThumbs.has(url)) return;
    if (url) this.readyThumbs = new Set(this.readyThumbs).add(url);
    if (this.uploads.some((u) => u.settling)) this.uploads = this.uploads.filter((u) => !u.settling);
  }

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

  /** 断点续传：点击失败的大文件占位卡，用内存里的 File 重新上传（同特征值 → 服务端自动续传） */
  private async retryUpload(rec: UploadRec): Promise<void> {
    if (!rec.file) return;
    if (!this.debounceKey("retry-" + rec.key, 800)) return;
    rec.fail = false; rec.pct = 0; rec.phase = undefined;
    this.uploads = [...this.uploads];
    this.msgs = [...this.msgs];
    try {
      const res = await uploadFile(
        rec.file,
        (sent, total) => {
          rec.pct = Math.max(0, Math.min(100, Math.round((sent / total) * 100)));
          if (rec.phase && rec.pct > 0) rec.phase = undefined;
          this.uploads = [...this.uploads];
        },
        rec.coverKey,
        // 阶段提示：0% 告知「正在准备/上传」，分片传完后告知「正在完成上传」
        (phase) => { rec.phase = phase; if (phase === "finishing") rec.pct = 100; this.uploads = [...this.uploads]; }
      );
      // 续传成功：同样走「原地替换」，避免占位卡消失与真实消息插入之间的空档
      this.finishUpload(rec, res.msg?.id);
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
      // 反向上传服务器封面（本地取帧结果持久化，跨设备共享）；服务器已有封面则不覆盖（409 忽略）
      if (!m.file?.cover) {
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.7));
        if (blob) void apiUploadMsgCover(m.id, blob);
      }
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
        <div class="logo ${this.connState}" role="button" tabindex="0" title=${this.t("sheet_settings")} @click=${() => { if (this.debounceKey("settings", 300)) this.sheet = "settings"; }} @keydown=${(e: KeyboardEvent) => { if ((e.key === "Enter" || e.key === " ") && this.debounceKey("settings", 300)) { e.preventDefault(); this.sheet = "settings"; } }}>filesyncEX</div>
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
            <div class="ce-top">${renderLangBar(ctx(this), false)}</div>
            <textarea .value=${this.codeText} placeholder=${this.t("code_placeholder")} @input=${(e: Event) => (this.codeText = (e.target as HTMLTextAreaElement).value)} @keydown=${(e: KeyboardEvent) => { if (e.ctrlKey && e.key === "Enter" && this.debounceKey("send", 600)) this.sendCode(); }}></textarea>
          </div>
          <button class="bracebtn ${this.codeMode ? "on" : ""}" title=${this.t("code_mode")} @click=${() => { if (this.debounceKey("codemode", 300)) { this.codeMode = !this.codeMode; this.focusCodeEditor(); } }}>&#123;&#125;</button>
          <button class="btn send" @click=${() => { if (this.debounceKey("send", 600)) this.codeMode ? this.sendCode() : this.sendText(); }}>${this.t("send")}</button>
        </div>
        <input type="file" class="file-input" multiple hidden @change=${(e: Event) => void this.handleFiles((e.target as HTMLInputElement).files)} />
      </section>

      <main class="list">${renderMessages(ctx(this))}</main>

      <!-- 移动端：底部输入条 -->
      <footer class="composer ${this.codeMode ? "code-mode" : ""}">
        <div class="composer-inner">
          <button class="addbtn" title=${this.t("choose_file")} @click=${() => { if (this.debounceKey("file", 400)) this.shadowRoot?.querySelector<HTMLInputElement>(".file-input")?.click(); }}>${I_PLUS}</button>
          <button class="bracebtn ${this.codeMode ? "on" : ""}" @click=${() => { if (this.debounceKey("codemode", 300)) { this.codeMode = !this.codeMode; this.focusCodeEditor(); } }}>&#123;&#125;</button>
          ${this.codeMode
            ? renderLangBar(ctx(this), true)
            : html`<input class="input" .value=${this.text} placeholder=${this.t("input_placeholder_mobile")} @input=${(e: Event) => (this.text = (e.target as HTMLInputElement).value)} @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" && this.debounceKey("send", 600)) this.sendText(); }} />`}
          <button class="sendbtn" @click=${() => { if (this.debounceKey("send", 600)) this.codeMode ? this.sendCode() : this.sendText(); }}>${I_SEND}</button>
        </div>
        ${this.codeMode ? html`<div class="code-editor open"><textarea .value=${this.codeText} placeholder=${this.t("code_placeholder")} @input=${(e: Event) => (this.codeText = (e.target as HTMLTextAreaElement).value)} @keydown=${(e: KeyboardEvent) => { if (e.ctrlKey && e.key === "Enter" && this.debounceKey("send", 600)) this.sendCode(); }}></textarea></div>` : nothing}
      </footer>
      </div>

      ${this.sheet ? this.renderSheet() : nothing}
      ${pv ? this.renderPreview(pv) : nothing}
      ${renderNotice(ctx(this))}
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
      content = html`<div class="qlist">${this.uploads.length === 0 ? html`<div class="qitem-row"><div class="qname" style="color:var(--muted)">${this.t("no_upload_task")}</div></div>` : this.uploads.map((u) => html`<div class="qitem-row"><div class="qname">${ellipsizeFileName(u.name)} <small>${u.pct < 0 ? this.t("failed") : fmtSize(u.size)}</small></div><div class="qbar"><i style="width:${u.pct < 0 ? 100 : u.pct}%"></i></div><div class="qmeta"><span>${u.pct < 0 ? this.t("upload_failed") : u.pct + "%"}</span></div></div>`)}</div>`;
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
        <!-- 昵称 -->
        <p class="st-sec">${this.t("st_nick")}</p>
        <p class="st-note">${this.t("st_nicknote")}</p>
        <label>${this.t("my_nick")}
          <input class="field" .value=${this.nick} maxlength="10" placeholder=${this.t("nick_placeholder")} @input=${(e: Event) => (this.nick = (e.target as HTMLInputElement).value.replace(/[^A-Za-z0-9_]/g, ""))} @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" && this.debounceKey("rename", 600)) this.rename(); }} />
        </label>
        <div class="fp-row"><span class="fp-label">${this.t("device_fp")}</span><code class="fp">${this.self?.deviceId ?? ""}</code></div>
        ${this.limits ? html`<p class="muted">${this.t("upload_limit", { size: fmtLimitBytes(this.limits.maxFileSize), chunkMin: fmtLimitBytes(this.limits.chunkSizeMin), chunkMax: fmtLimitBytes(this.limits.chunkSizeMax) })}</p>` : nothing}
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
          <a class="btn tool" href="https://github.com/NoRainLand/QuickSendTool/releases" target="_blank" rel="noopener">${I_LINK}${this.t("download_qst")}</a>
          <p class="muted">${this.t("tool_note")}</p>
        </div>
        <!-- 关于 -->
        <hr />
        <p class="st-sec">${this.t("st_about")}</p>
        <div class="st-about">
          <p class="app-name">filesyncEX <span class="app-ver">${this.t("version")} ${this.appVer}</span></p>
          <p class="muted">${this.t("app_desc")}</p>
          <p class="muted">${this.t("copyright")} (C) 2026 NoRainLand</p>
        </div>
        <a class="btn secondary tool" href="https://github.com/NoRainLand/filesyncEX" target="_blank" rel="noopener">${I_LINK}${this.t("goto_github")}</a>
      </div>`;
    } else if (s === "qr") {
      content = html`<div class="qrbox">${this.qrDataUrl ? html`<img src="${this.qrDataUrl}" alt=${this.t("qr")} />` : html`<div class="qr-loading">${this.t("qr_loading")}</div>`}</div><p>${this.t("qr_hint", { url: this.httpUrl })}</p>${this.lanIps.length ? html`<p class="muted">${this.t("qr_alt", { ips: this.lanIps.join(" / ") })}</p>` : nothing}`;
    }
    return html`<div class="mask" @mousedown=${(e: MouseEvent) => { if (e.target === e.currentTarget) close(); }}><div class="panel-shell ${s === "qr" ? "qr" : ""} ${s === "settings" ? "settings-panel" : ""}"><div class="panel" @click=${(e: Event) => e.stopPropagation()}><div class="handle"></div><div class="ptitle" @click=${close}>${s === "attach" ? this.t("sheet_attach") : s === "progress" ? this.t("sheet_progress") : s === "settings" ? this.t("sheet_settings") : this.t("sheet_qr")}</div>${content}</div></div></div>`;
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

customElements.define("filesync-app", FilesyncApp);
