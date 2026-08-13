/** 前端国际化：中 / 英 词典 + 语言持久化 + 日期/文件类型翻译 */
export type Lang = "zh" | "en";

const STORAGE_KEY = "fsex_lang";

export function loadLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "zh" || saved === "en") return saved;
    // 首次打开：按浏览器语言判断（中文系统 → zh，否则 en）
    return /^zh/i.test(navigator.language || "") ? "zh" : "en";
  } catch {
    return "zh";
  }
}

export function saveLang(l: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {
    /* noop */
  }
}

type T = (vars?: Record<string, string>) => string;
type Dict = Record<string, T>;

const p2 = (n: number) => String(n).padStart(2, "0");

const zh: Dict = {
  /* 星期 / 日期 */
  week: (v) => ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][Number(v?.d ?? 0)] ?? "",
  today: () => "今天",
  yesterday: () => "昨天",
  earlier: () => "更早",
  /* 文件类型 */
  ft_script: () => "脚本",
  ft_text: () => "文本",
  ft_doc: () => "文档",
  ft_pdf: () => "PDF",
  ft_sheet: () => "表格",
  ft_archive: () => "压缩包",
  ft_app: () => "程序",
  ft_icon: () => "图标",
  ft_audio: () => "音频",
  ft_video: () => "视频",
  ft_image: () => "图片",
  ft_file: () => "文件",
  /* 提示（toast / flash） */
  msg_deleted: () => "消息已删除",
  nick_invalid: () => "昵称仅允许大小写字母、下划线和数字，最长 10 位",
  qr_failed: () => "二维码生成失败",
  upload_fail: (v) => `「${v?.name}」上传失败`,
  upload_interrupted: (v) => `「${v?.name}」上传中断，点击消息可断点续传`,
  resume_ok: (v) => `「${v?.name}」续传成功`,
  resume_fail: (v) => `「${v?.name}」续传失败，已取消`,
  code_copied: () => "代码已复制",
  copied: () => "已复制",
  copy_failed: () => "复制失败，请手动复制",
  download_started: () => "已开始下载",
  no_download: () => "暂无可下载内容",
  reconnecting: () => "正在重新连接…",
  reconnecting_shutdown: () => "正在尝试重新连接…",
  proto_album: () => "（原型）打开相册",
  proto_camera: () => "（原型）打开相机",
  close: () => "关闭",
  reconnect_confirm: () => "确认并重连",
  /* 服务器通知标题 */
  notice_shutdown: () => "服务器关闭",
  notice_maintenance: () => "服务器维护中",
  notice_disconnected: () => "服务器断开连接",
  notice_retry: () => "点击「确认并重连」尝试重新连接服务器",
  notice_reconnecting: () => "断线重连中",
  notice_reconnect_left: (v) => `正在自动尝试重新连接，剩余次数${v?.n ?? 0}`,
  reconnect_success: () => "服务器重连成功",
  notice_error: () => "服务器异常",
  notice_warn: () => "服务器警告",
  notice_info: () => "服务器通知",
  /* 消息列表 / 占位 */
  empty_list: () => "暂无消息 · 拖拽文件或输入文字开始同步",
  upload_ph: () => "上传中…",
  upload_failed_ph: () => "上传失败",
  resume_click: () => "上传中断 · 点击续传",
  download: () => "下载",
  copy: () => "复制",
  delete: () => "删除",
  me: () => "本机",
  audio_name: () => "音频",
  file_name: () => "文件",
  /* 头部 / 输入区 */
  lang: () => "语言",
  qr: () => "二维码",
  theme: () => "切换主题",
  file: () => "文件",
  send: () => "发送",
  code_mode: () => "代码模式",
  choose_file: () => "选择文件",
  input_placeholder: () => "输入文本，或拖拽 / 粘贴文件到此处…",
  input_placeholder_mobile: () => "输入消息",
  code_placeholder: () => "在这里输入代码…（保持格式）",
  /* 删除气泡 */
  del_text: () => "删除这条消息？",
  cancel: () => "取消",
  /* 附件面板 */
  attach_album: () => "相册",
  attach_camera: () => "拍照",
  attach_file: () => "文件",
  /* 上传进度面板 */
  no_upload_task: () => "暂无上传任务",
  failed: () => "失败",
  upload_failed: () => "上传失败",
  /* 设置面板 */
  st_conn: () => "连接",
  connected: () => "已连接",
  connecting: () => "连接中…",
  disconnected: () => "已断开",
  lan: () => "（局域网）",
  http_label: () => "HTTP：",
  ws_label: () => "WebSocket：",
  st_nick: () => "昵称",
  st_nicknote: () => "默认昵称 user_XXXX（四位数字），按设备指纹自动生成，可在此修改（仅本机保存）。",
  my_nick: () => "我的昵称",
  nick_placeholder: () => "仅字母/数字/下划线，最长 10 位",
  device_fp: () => "设备指纹（仅用于本地生成稳定 ID，不上传原始信息）：",
  st_tool: () => "工具",
  download_qst: () => "下载 QuickSendTool（Windows 右键发送）",
  tool_note: () => "安装后在文件管理器右键选中文件，即可一键发送到本服务器。",
  st_about: () => "关于",
  version: () => "版本",
  app_desc: () => "一个简单的局域网文件/文字同步服务",
  copyright: () => "版权所有",
  goto_github: () => "前往项目主页 GitHub",
  st_lang: () => "语言",
  lang_zh: () => "中文",
  lang_en: () => "English",
  /* 二维码面板 */
  qr_loading: () => "生成中…",
  qr_hint: (v) => `${v?.url ?? ""} · 用手机扫码即可加入同步`,
  /* 弹层标题 */
  sheet_attach: () => "发送内容",
  sheet_progress: () => "上传进度",
  sheet_settings: () => "设置",
  sheet_qr: () => "扫码连接",
  /* 预览 */
  pv_image: () => "图片预览",
  pv_video: () => "视频预览",
  pv_audio: () => "音频播放",
  pv_code: () => "代码预览",
};

const en: Dict = {
  week: (v) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][Number(v?.d ?? 0)] ?? "",
  today: () => "Today",
  yesterday: () => "Yesterday",
  earlier: () => "Earlier",
  ft_script: () => "Script",
  ft_text: () => "Text",
  ft_doc: () => "Document",
  ft_pdf: () => "PDF",
  ft_sheet: () => "Spreadsheet",
  ft_archive: () => "Archive",
  ft_app: () => "App",
  ft_icon: () => "Icon",
  ft_audio: () => "Audio",
  ft_video: () => "Video",
  ft_image: () => "Image",
  ft_file: () => "File",
  msg_deleted: () => "Message deleted",
  nick_invalid: () => "Nickname: only letters, digits and underscore, max 10 chars",
  qr_failed: () => "Failed to generate QR code",
  upload_fail: (v) => `Upload failed: ${v?.name}`,
  upload_interrupted: (v) => `Upload interrupted: ${v?.name} (tap the message to resume)`,
  resume_ok: (v) => `Resumed: ${v?.name}`,
  resume_fail: (v) => `Resume failed: ${v?.name}, cancelled`,
  code_copied: () => "Code copied",
  copied: () => "Copied",
  copy_failed: () => "Copy failed, please copy manually",
  download_started: () => "Download started",
  no_download: () => "Nothing to download",
  reconnecting: () => "Reconnecting…",
  reconnecting_shutdown: () => "Trying to reconnect…",
  proto_album: () => "(prototype) Open album",
  proto_camera: () => "(prototype) Open camera",
  close: () => "Close",
  reconnect_confirm: () => "Reconnect",
  notice_shutdown: () => "Server is shutting down",
  notice_maintenance: () => "Server is under maintenance",
  notice_disconnected: () => "Server disconnected",
  notice_retry: () => "Click Reconnect to try reconnecting to the server",
  notice_reconnecting: () => "Reconnecting…",
  notice_reconnect_left: (v) => `Auto reconnecting, attempts left: ${v?.n ?? 0}`,
  reconnect_success: () => "Server reconnected",
  notice_error: () => "Server error",
  notice_warn: () => "Server warning",
  notice_info: () => "Server notice",
  empty_list: () => "No messages · Drag files or type text to start syncing",
  upload_ph: () => "Uploading…",
  upload_failed_ph: () => "Upload failed",
  resume_click: () => "Interrupted · Tap to resume",
  download: () => "Download",
  copy: () => "Copy",
  delete: () => "Delete",
  me: () => "Me",
  audio_name: () => "Audio",
  file_name: () => "File",
  lang: () => "Language",
  qr: () => "QR Code",
  theme: () => "Toggle theme",
  file: () => "File",
  send: () => "Send",
  code_mode: () => "Code mode",
  choose_file: () => "Choose file",
  input_placeholder: () => "Type text, or drag / paste files here…",
  input_placeholder_mobile: () => "Type a message",
  code_placeholder: () => "Type code here… (format preserved)",
  del_text: () => "Delete this message?",
  cancel: () => "Cancel",
  attach_album: () => "Album",
  attach_camera: () => "Camera",
  attach_file: () => "File",
  no_upload_task: () => "No upload tasks",
  failed: () => "Failed",
  upload_failed: () => "Upload failed",
  st_conn: () => "Connection",
  connected: () => "Connected",
  connecting: () => "Connecting…",
  disconnected: () => "Disconnected",
  lan: () => "(LAN)",
  http_label: () => "HTTP:",
  ws_label: () => "WebSocket:",
  st_nick: () => "Nickname",
  st_nicknote: () => "Default nickname user_XXXX (4 digits), auto-generated from the device fingerprint. Editable here (saved locally only).",
  my_nick: () => "My nickname",
  nick_placeholder: () => "Letters/digits/underscore, max 10 chars",
  device_fp: () => "Device fingerprint (used only for a stable local ID; raw info is never uploaded):",
  st_tool: () => "Tools",
  download_qst: () => "Download QuickSendTool (Windows right-click send)",
  tool_note: () => "After install, right-click a file in File Explorer to send it to this server.",
  st_about: () => "About",
  version: () => "Version",
  app_desc: () => "A simple LAN file & text sync service",
  copyright: () => "Copyright",
  goto_github: () => "Visit project on GitHub",
  st_lang: () => "Language",
  lang_zh: () => "中文",
  lang_en: () => "English",
  qr_loading: () => "Generating…",
  qr_hint: (v) => `${v?.url ?? ""} · Scan with your phone to join`,
  sheet_attach: () => "Send content",
  sheet_progress: () => "Upload progress",
  sheet_settings: () => "Settings",
  sheet_qr: () => "Scan to connect",
  pv_image: () => "Image preview",
  pv_video: () => "Video preview",
  pv_audio: () => "Audio player",
  pv_code: () => "Code preview",
};

export const dict: Record<Lang, Dict> = { zh, en };

/** 取翻译文本（Record 索引 undefined 安全，兼容 noUncheckedIndexedAccess） */
function tr(lang: Lang, key: string, vars?: Record<string, string>): string {
  return dict[lang]?.[key]?.(vars) ?? dict.zh[key]?.(vars) ?? key;
}

/** 日期分组标签（今天/昨天/更早 · 日期；移动端 7 天内带星期） */
export function dayLabel(lang: Lang, ts: number, mobile: boolean): string {
  const d = new Date(ts);
  const now = new Date();
  const ymd = (x: Date) => `${x.getFullYear()}/${p2(x.getMonth() + 1)}/${p2(x.getDate())}`;
  const full = ymd(d);
  const sep = " · ";
  if (full === ymd(now)) return tr(lang, "today") + sep + full;
  const y = new Date(now.getTime() - 86400000);
  if (full === ymd(y)) return tr(lang, "yesterday") + sep + full;
  if (mobile) {
    const md = `${p2(d.getMonth() + 1)}/${p2(d.getDate())}`;
    if (now.getTime() - ts < 7 * 86400000) return `${md} · ${tr(lang, "week", { d: String(d.getDay()) })}`;
    return md;
  }
  return tr(lang, "earlier");
}

/** 文件类型描述（扩展名/mime → 中英文字段） */
export function fmtType(lang: Lang, name: string, mime?: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    sh: "ft_script", py: "ft_script", js: "ft_script", ts: "ft_script", txt: "ft_text",
    md: "ft_doc", pdf: "ft_pdf", doc: "ft_doc", docx: "ft_doc", xlsx: "ft_sheet", xls: "ft_sheet",
    zip: "ft_archive", rar: "ft_archive", "7z": "ft_archive", exe: "ft_app", ico: "ft_icon",
    mp3: "ft_audio", wav: "ft_audio", m4a: "ft_audio", mp4: "ft_video", avi: "ft_video",
    mov: "ft_video", mkv: "ft_video", webm: "ft_video", png: "ft_image", jpg: "ft_image",
    jpeg: "ft_image", gif: "ft_image", webp: "ft_image", svg: "ft_image", bmp: "ft_image",
  };
  if (mime?.startsWith("image/")) return tr(lang, "ft_image");
  if (mime?.startsWith("audio/")) return tr(lang, "ft_audio");
  if (mime?.startsWith("video/")) return tr(lang, "ft_video");
  const k = map[ext ?? ""];
  return k ? tr(lang, k) : tr(lang, "ft_file");
}
