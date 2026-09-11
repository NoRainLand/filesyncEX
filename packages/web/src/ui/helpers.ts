import { html } from "lit";

/**
 * 展示层工具函数（从 app.ts 抽出）：时间/大小格式化、文件名省略、文件类型判定、频谱条骨架。
 * 全部为纯函数（不依赖组件状态），便于单独维护与复用。
 */
/* ================= helpers ================= */

const p2 = (n: number) => String(n).padStart(2, "0");
/** 音频时长：mm:ss（超过 1 小时用 h:mm:ss） */
function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0 ? `${h}:${p2(m)}:${p2(ss)}` : `${m}:${p2(ss)}`;
}
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

/**
 * 音频频谱条。
 *
 * - 有真实峰值（服务端上传时解码算出的 `file.peaks`，0~100）→ 按真实波形画条；
 *   这是**唯一**能让不同音频看起来不同的来源（振幅包络，不是 FFT）。
 * - 没有峰值（老消息 / 解码失败 / 还没算出来）→ 回退到「按文件名派生」的占位波形：
 *   虽然是假的，但**每条消息各不相同且稳定**，不会出现「所有音频频谱一模一样」的观感。
 *
 * 移动端由 CSS 每 3 根只显示 1 根（指示器方式），因此条形数量在两种端上一致。
 */
const waveBars = (peaks?: readonly number[], seed = "") => {
  const N = 96;
  const heights = peaks?.length ? resamplePeaks(peaks, N) : placeholderPeaks(N, seed);
  return heights.map((h) => html`<i class="bar" style="height:${h.toFixed(1)}%"></i>`);
};

/** 把任意长度的峰值数组重采样成 n 根（取每段最大，保留波峰特征） */
function resamplePeaks(peaks: readonly number[], n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = Math.floor((i * peaks.length) / n);
    const end = Math.max(start + 1, Math.floor(((i + 1) * peaks.length) / n));
    let m = 0;
    for (let k = start; k < end && k < peaks.length; k++) m = Math.max(m, peaks[k] ?? 0);
    // 与服务端一致：留一条细线，静音段也不至于完全空白
    out.push(Math.max(4, Math.min(100, m)));
  }
  return out;
}

/** 占位波形：用文件名做种子的确定性伪随机（同一条消息稳定，不同文件不同形状） */
function placeholderPeaks(n: number, seed: string): number[] {
  let s = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    s ^= seed.charCodeAt(i);
    s = Math.imul(s, 16777619) >>> 0;
  }
  const rand = (): number => {
    s = (Math.imul(s ^ (s >>> 15), 2246822507) + 1013904223) >>> 0;
    return (s >>> 8) / 0x1000000;
  };
  const out: number[] = [];
  let prev = 0.4;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    // 中间略高的包络（像真实音乐的响度分布）+ 有种子的一阶平滑噪声
    const env = 0.25 + 0.75 * Math.exp(-Math.pow((t - 0.5) / 0.3, 2));
    const smooth = 0.35 * rand() + 0.65 * prev;
    prev = smooth;
    out.push(Math.max(8, Math.min(100, env * (35 + smooth * 65))));
  }
  return out;
}

export { fmtTime, fmtSize, fmtDur, ellipsizeFileName, fileNameMax, fileKind, waveBars };

