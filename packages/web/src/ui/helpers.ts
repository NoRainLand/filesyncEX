import { html } from "lit";

/**
 * 展示层工具函数（从 app.ts 抽出）：时间/大小格式化、文件名省略、文件类型判定、频谱条骨架。
 * 全部为纯函数（不依赖组件状态），便于单独维护与复用。
 */
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
/** 文件名省略总长：移动端 24（前 10 字符，效果经用户确认），桌面端 36（前面保留更多，屏幕宽） */
const fileNameMax = () => (window.innerWidth <= 640 ? 24 : 36);
/** 文件名中间省略：超长时保留开头 + 结尾（含扩展名），如「这是一个很长…文档.pdf」；返回即最终显示（CSS 尾部省略仅作小屏宽度兑底） */
function ellipsizeFileName(name: string, max = fileNameMax()): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";        // ".pdf" 或 ""
  const body = dot > 0 ? name.slice(0, dot) : name;   // 主文件名（无点则整体）
  const head = Math.min(Math.max(6, Math.floor(max * 0.45)), body.length); // 头部保留：至少 6、留足尾巴
  const tailMax = Math.max(0, max - head - 1 - ext.length);
  const tailBody = Math.min(4, tailMax, body.length); // 尾部主体保留：最多 4 字符
  const keepBody = tailBody > 0 ? body.slice(body.length - tailBody) : "";
  return body.slice(0, head) + "…" + keepBody + ext;
}
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

export { fmtTime, fmtSize, ellipsizeFileName, fileNameMax, fileKind, waveBars };

