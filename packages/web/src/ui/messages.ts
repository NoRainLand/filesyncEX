import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { MsgDataT } from "@filesyncex/protocol";
import type { Lang } from "../i18n.js";
import { dayLabel, fmtType } from "../i18n.js";
import { DIRECT_UPLOAD_LIMIT } from "../api.js";
import { fmtTime, fmtSize, ellipsizeFileName, fileKind, waveBars } from "./helpers.js";
import { highlightCode } from "./prism.js";
import { I_FILE, I_IMG, I_COPY, I_DOWN, I_PLAY, I_PAUSE, I_TRASH } from "./icons.js";
import { LANG_LIST, langLabel } from "./lang.js";

/** 上传任务记录（占位卡）：file 保留 File 引用以便断点续传 */
export interface UploadRec {
  key: string;
  name: string;
  pct: number;
  size: number;
  kind: string;
  fail?: boolean;
  file?: File;
  coverKey?: string;
}

/**
 * 渲染器要访问的组件状态/方法（结构化类型，避免 ui 模块反向 import app.ts 造成循环依赖）。
 * 只列出这些渲染函数真正用到的东西，便于阅读与收敛。
 */
export interface AppCtx {
  msgs: MsgDataT[];
  peers: unknown[];
  self: { deviceId: string } | null;
  lang: Lang;
  uploads: UploadRec[];
  delBubble: { id: string } | null;
  playingId: string | null;
  theme: "light" | "dark";
  connState: "connecting" | "connected" | "disconnected";
  appVer: string;
  httpUrl: string;
  nick: string;
  codeLang: string;
  langOpen: boolean;
  notices: { id: number; level: string; message: string }[];
  toasts: { id: number; text: string; leaving: boolean; show: boolean }[];
  sheet: "attach" | "progress" | "settings" | "qr" | null;
  videoCovers: Map<string, string>;
  t: (key: string, vars?: Record<string, string>) => string;
  debounceKey: (key: string, wait: number) => boolean;
  deleteMsg: (id: string) => void;
  retryUpload: (rec: UploadRec) => void | Promise<void>;
  openPreview: (kind: string, msg: MsgDataT) => void;
  captureVideoCover: (m: MsgDataT) => void | Promise<void>;
  toggleAudio: (m: MsgDataT) => void;
  seekAudio: (m: MsgDataT, e: MouseEvent) => void;
  audioSrc: (m: MsgDataT) => string | undefined;
  copyBubble: (e: MouseEvent, m: MsgDataT) => void;
  copyText: (text: string) => void;
  copyCode: (m: MsgDataT) => void;
  msgPressStart: (m: MsgDataT) => void;
  msgPressEnd: () => void;
  msgClickGuard: (e: Event) => void;
  noticeLevelLabel: (level: string) => string;
  dismissNotice: (id: number) => void;
  confirmNotice: (id: number) => void;
}

/** 消息区渲染（消息卡片 / 上传占位卡 / 文本链接 / 语言下拉 / 通知弹窗） */

/**
 * 组件实例 → 渲染上下文。
 * FilesyncApp 的 t()/openPreview() 等被声明为 private（只在本组件内使用），而结构化类型要求
 * 上下文成员必须公开可见，故在**这一处**做一次受控断言，其余渲染代码保持强类型。
 */
export function ctx(app: unknown): AppCtx {
  return app as AppCtx;
}

export function renderNotice(app: AppCtx) {
    if (app.notices.length === 0) return nothing;
    return html`<div class="notice-mask">${app.notices.map((n) => {
      const isReconnecting = n.level === "reconnecting";
      const locked = isReconnecting || n.level === "shutdown" || n.level === "maintenance" || n.level === "disconnected";
      return html`<div class="notice-panel ${n.level}">
        ${locked ? nothing : html`<button class="nclose" title=${app.t("close")} @click=${() => { if (app.debounceKey("notice-close-" + n.id, 300)) app.dismissNotice(n.id); }}>✕</button>`}
        <div class="ntitle">${app.noticeLevelLabel(n.level)}</div>
        <div class="nbody">${n.message}${isReconnecting ? html`<span class="dots"></span>` : ""}</div>
        ${isReconnecting ? nothing : html`<button class="btn" @click=${() => app.confirmNotice(n.id)}>${app.t("reconnect_confirm")}</button>`}
      </div>`;
    })}</div>`;
  }
  /* ---------- 消息渲染（按天分组；桌面端从新到旧，最新在上） ---------- */
export function renderMessages(app: AppCtx): unknown {
    if (app.msgs.length === 0) return html`<div class="empty">${app.t("empty_list")}</div>`;
    const mobile = window.innerWidth <= 640;
    const ordered = mobile ? app.msgs : [...app.msgs].reverse();
    const out: unknown[] = [];
    let lastDay = "";
    for (const m of ordered) {
      const day = dayLabel(app.lang, m.ts, mobile);
      if (day !== lastDay) { out.push(html`<div class="day">${day}</div>`); lastDay = day; }
      out.push(renderMsg(app, m));
    }
    return out;
  }

  /** 文字消息渲染：将 http/https URL 转为可点击链接（点击新窗口打开）；非 URL 原样显示 */
function renderText(app: AppCtx, text: string): unknown {
    const urlRe = /(https?:\/\/[^\s<]+)/g;
    const parts: unknown[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = urlRe.exec(text)) !== null) {
      if (m.index > last) parts.push(text.slice(last, m.index));
      const url = m[0];
      parts.push(html`<a class="bubble-link" href="${url}" target="_blank" rel="noopener" @click=${(e: MouseEvent) => openTextLink(app, e, url)}>${url}</a>`);
      last = m.index + url.length;
      i++;
      if (i > 50) break; // 极端情况防死循环
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts.length ? parts : text;
  }

export function openTextLink(app: AppCtx, e: MouseEvent, url: string): void {
    e.preventDefault();
    e.stopPropagation();
    if (!app.debounceKey("link-" + url, 500)) return;
    window.open(url, "_blank", "noopener");
  }

export function renderMsg(app: AppCtx, m: MsgDataT): unknown {
    const f = m.file;
    const mobile = window.innerWidth <= 640;
    // 上传占位卡：结构与真实消息完全一致（对应类型主体 + mm 信息行 + ops 操作行），主体叠磨砂层 + 中心圆形进度环
    if (m.id.startsWith("upload-")) {
      const rec = app.uploads.find((u) => u.key === m.id);
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
      const mm = html`<div class="ph-mm"><span class="name ${retryable ? "retry" : ""}">${failed ? (retryable ? app.t("resume_click") : app.t("upload_failed_ph")) : f?.name ? ellipsizeFileName(f.name) : app.t("upload_ph")}</span><span class="size">${f ? fmtSize(f.size) : ""}</span></div>`;
      // 操作行（同真实消息 .ops：下载占位按钮）
      const ops = html`<div class="ph-ops"><span class="btn secondary ph-down">${I_DOWN}${app.t("download")}</span></div>`;
      return html`<div class="msg">
        <div class="avatar">${(m.sender.deviceName[0] ?? "?").toUpperCase()}</div>
        <div class="body">
          <div class="head"><span class="who">${m.sender.deviceName}</span><time>${fmtTime(m.ts)}</time></div>
          <div class="card upload-ph ${uk} ${retryable ? "retry" : ""}" @click=${retryable ? () => { void app.retryUpload(rec!); } : undefined}>
            ${phBody}
            ${mm}
            ${ops}
          </div>
        </div>
      </div>`;
    }
    const delBtn = html`<button class="del-corner" title=${app.t("delete")} @click=${() => { if (app.debounceKey("del-" + m.id, 500)) app.deleteMsg(m.id); }}>${I_TRASH}</button>`;
    const copyBtn = html`<button class="btn" @click=${() => { if (app.debounceKey("copy-" + m.id, 800)) app.copyText(m.text ?? ""); }}>${I_COPY}${app.t("copy")}</button>`;
    const copyCodeBtn = html`<button class="btn" @click=${() => { if (app.debounceKey("copy-" + m.id, 800)) app.copyCode(m); }}>${I_COPY}${app.t("copy")}</button>`;
    const downBtn = html`<a class="btn" href="${f?.url ?? "#"}" download @click=${(e: Event) => { if (!app.debounceKey("down-" + m.id, 800)) e.preventDefault(); }}>${I_DOWN}${app.t("download")}</a>`;
    const head = html`<span class="who">${m.sender.deviceName}</span>${app.self && m.sender.deviceId === app.self.deviceId ? html`<span class="me">${app.t("me")}</span>` : ""}<time>${fmtTime(m.ts)}</time>`;

    let content: unknown;
    switch (m.kind) {
      case "text":
        content = mobile
          ? html`<div class="card text"><div class="bubble" @click=${(e: MouseEvent) => app.copyBubble(e, m)}>${renderText(app, m.text ?? "")}</div>${delBtn}</div>`
          : html`<div class="card text"><div class="bubble">${renderText(app, m.text ?? "")}</div><div class="ops">${copyBtn}</div>${delBtn}</div>`;
        break;
      case "code":
        content = html`<div class="card code"><div class="code-head"><span class="lang">${m.code?.lang ?? "code"}</span></div><pre @click=${() => { if (app.debounceKey("pv-" + m.id, 400)) app.openPreview("code", m); }}>${unsafeHTML(highlightCode(m.code?.content ?? "", m.code?.lang ?? "ts"))}</pre><div class="ops">${copyCodeBtn}</div>${delBtn}</div>`;
        break;
      case "image":
        content = html`<div class="card img">
            <div class="thumb" @click=${() => { if (app.debounceKey("pv-" + m.id, 400)) app.openPreview("image", m); }}><img src="${f?.url ?? ""}" alt="" /></div>
            <div class="ovl" @click=${(e: Event) => e.stopPropagation()}><span class="mm"><span class="name">${f?.name ? ellipsizeFileName(f.name) : ""}</span><span class="size">${f ? fmtSize(f.size) : ""}</span></span><span class="ops">${downBtn}</span></div>${delBtn}
          </div>`;
        break;
      case "video": {
        const cover = m.file?.cover ?? app.videoCovers.get(m.id);
        content = html`<div class="card video">
            <div class="vthumb" @click=${() => { if (app.debounceKey("pv-" + m.id, 400)) app.openPreview("video", m); }}>
              ${cover
                ? html`<img class="vcover" src="${cover}" alt="" />`
                : html`<video src="${f?.url ?? ""}" muted playsinline webkit-playsinline preload="metadata" @loadeddata=${() => app.captureVideoCover(m)}></video>`}
            </div>
            <div class="ovl" @click=${(e: Event) => e.stopPropagation()}><span class="mm"><span class="name">${f?.name ? ellipsizeFileName(f.name) : ""}</span><span class="size">${f ? fmtSize(f.size) : ""}</span></span><span class="ops">${downBtn}</span></div>${delBtn}
          </div>`;
        break;
      }
      case "audio":
        content = html`<div class="card audio ${app.playingId === m.id ? "playing" : ""}" data-id="${m.id}">
            <div class="ap">
              <button class="play" @click=${() => { if (app.debounceKey("play-" + m.id, 400)) app.toggleAudio(m); }}>${app.playingId === m.id ? I_PAUSE : I_PLAY}</button>
              <div class="wave" @click=${(e: MouseEvent) => app.seekAudio(m, e)}>${waveBars()}<i class="fill"></i><i class="ind"></i></div>
              <audio src="${app.audioSrc(m) ?? ""}" preload="none"></audio>
            </div>
            <div class="mm"><span class="name">${f?.name ? ellipsizeFileName(f.name) : app.t("audio_name")}</span><span class="size">${f ? fmtSize(f.size) : ""}</span></div>
            <div class="ops">${downBtn}</div>${delBtn}
          </div>`;
        break;
      case "file":
      default:
        content = html`<div class="card file">
            <div class="file">
              <span class="ic">${I_FILE}</span>
              <div class="meta"><span class="name">${f?.name ? ellipsizeFileName(f.name) : app.t("file_name")}</span><span class="sub">${f ? `${fmtSize(f.size)} · ${fmtType(app.lang, f.name, f.mime)}` : ""}</span></div>
            </div>
            <div class="ops">${downBtn}</div>${delBtn}
          </div>`;
        break;
    }

    return html`<div class="msg ${app.delBubble?.id === m.id ? "del-selected" : ""}" data-id="${m.id}" @touchend=${app.msgPressEnd} @mousedown=${() => app.msgPressStart(m)} @mouseup=${app.msgPressEnd} @mouseleave=${app.msgPressEnd} @contextmenu=${(e: Event) => { if (window.innerWidth <= 640) e.preventDefault(); }} @click=${(e: Event) => app.msgClickGuard(e)}>
      <div class="avatar">${(m.sender.deviceName[0] ?? "?").toUpperCase()}</div>
      <div class="body">
        <div class="head">${head}</div>
        ${content}
      </div>
    </div>`;
  }

  /** 自定义语言下拉栏：upward=true 列表向上弹出（移动端输入条），否则向下（桌面端代码框顶） */
export function renderLangBar(app: AppCtx, upward: boolean): unknown {
    return html`<div class="lang-bar ${upward ? "up" : ""}">
      <label>${app.t("lang")}</label>
      <div class="lang-pick" @click=${(e: Event) => { e.stopPropagation(); if (app.debounceKey("lang-toggle", 250)) app.langOpen = !app.langOpen; }}>
        <span class="lang-cur">${langLabel(app.codeLang)}</span><span class="lang-arr">${upward ? "▴" : "▾"}</span>
        ${app.langOpen ? html`<div class="lang-list">${LANG_LIST.map((l) => html`<div class="lang-opt ${l === app.codeLang ? "on" : ""}" @click=${(e: Event) => { e.stopPropagation(); if (app.debounceKey("lang-" + l, 300)) { app.codeLang = l; app.langOpen = false; } }}>${langLabel(l)}</div>`)}</div>` : nothing}
      </div>
    </div>`;
}

