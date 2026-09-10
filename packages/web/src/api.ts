import type { UploadInitResT, UploadCompleteResT } from "@filesyncex/protocol";
import { getDevice } from "./device.js";
import { fileFingerprint } from "./fingerprint.js";

/** HTTP API 客户端（相对路径，走 Vite 代理或同源静态服务） */

export interface HealthT {
  ok?: boolean;
  name?: string;
  version?: string;
  lanIp?: string;
  /** 全部可用局域网地址（多网卡机器上首个未必可达） */
  lanIps?: string[];
  port?: number;
  /** 服务器下发的上传限制（用于上传前预检） */
  limits?: UploadLimitsT;
}

/** 服务器上传限制（/api/health 的 limits 字段） */
export interface UploadLimitsT {
  /** 直传阈值：≤ 此值走 /api/upload/direct */
  directUpload: number;
  /** 单文件上限（字节；0 = 不限制） */
  maxFileSize: number;
  /** 切片大小下限（字节）：小文件用这个粒度 */
  chunkSizeMin: number;
  /** 切片大小上限（字节）：超大文件最多放大到这里；等于 min 即固定切片 */
  chunkSizeMax: number;
}

/**
 * 服务器不可达时的兜底限制（与服务端默认值一致；权威值来自 /api/health）。
 * 注意：**具体切片大小不在这里** —— 它按文件大小动态取，权威值由 `init` 返回的 `chunkSize` 决定。
 */
export const FALLBACK_LIMITS: UploadLimitsT = {
  directUpload: 8 * 1024 * 1024,
  maxFileSize: 16 * 1024 * 1024 * 1024,
  chunkSizeMin: 1024 * 1024,
  chunkSizeMax: 8 * 1024 * 1024,
};

let healthPromise: Promise<HealthT> | null = null;
/** 获取服务器健康信息（真实局域网 IP/端口/版本）。共享 Promise：多次调用只发一次请求，失败回退空对象 */
export function fetchHealth(): Promise<HealthT> {
  if (!healthPromise) {
    healthPromise = fetch("/api/health")
      .then((r) => r.json() as Promise<HealthT>)
      .catch(() => ({} as HealthT));
  }
  return healthPromise;
}

/** 取服务器上传限制（失败回退默认值；界面显示上限与上传前预检都用它） */
export async function fetchLimits(): Promise<UploadLimitsT> {
  const h = await fetchHealth();
  return { ...FALLBACK_LIMITS, ...(h.limits ?? {}) };
}

/** 人类可读体积（与消息卡片的大小格式一致，供设置界面显示上限用） */
export function fmtLimitBytes(n: number): string {
  if (n <= 0) return "∞";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

interface InitUploadInput {
  name: string;
  size: number;
  mime?: string;
  /** 文件特征值（前 1 MiB 的 SHA-256）：服务端据此 + 文件名 + 大小做秒传判定 */
  firstChunkSha256?: string;
  device: import("@filesyncex/protocol").DeviceInfoT;
  uploadId?: string;
  coverKey?: string;
}

export async function apiUploadInit(input: InitUploadInput): Promise<UploadInitResT> {
  const r = await fetch("/api/upload/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error((await r.json()).error ?? "上传初始化失败");
  return (await r.json()) as UploadInitResT;
}

export async function apiUploadChunk(uploadId: string, index: number, data: ArrayBuffer | Blob): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= CHUNK_MAX_RETRIES; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), CHUNK_TIMEOUT_MS);
      let r: Response;
      try {
        r = await fetch(`/api/upload/chunk/${uploadId}/${index}`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: data,
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!r.ok) throw new Error((await r.json()).error ?? `分片 ${index} 上传失败`);
      return;
    } catch (e) {
      lastErr = e;
      // 网络抖动/瞬时断连：退避后重试该分片（断点续传兜底，失败再整体中断）
      if (attempt < CHUNK_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt - 1)));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`分片 ${index} 上传失败`);
}

export async function apiUploadComplete(uploadId: string): Promise<UploadCompleteResT> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 60_000);
      let r: Response;
      try {
        r = await fetch(`/api/upload/complete/${uploadId}`, { method: "POST", signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!r.ok) throw new Error((await r.json()).error ?? "上传完成失败");
      return (await r.json()) as UploadCompleteResT;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("上传完成失败");
}

/** 小文件直接上传：一次 POST 整个文件，跳过分片（消除「上传前等待」） */
export async function apiUploadDirect(file: File, device: import("@filesyncex/protocol").DeviceInfoT, coverKey?: string, fingerprint?: string): Promise<UploadCompleteResT> {
  const q = new URLSearchParams({ name: file.name, mime: file.type || "", device: JSON.stringify(device) });
  if (coverKey) q.set("coverKey", coverKey);
  // 特征值由客户端算好传入（服务端也会从数据里独立算一遍并比对），用于秒传判定
  if (fingerprint) q.set("fp", fingerprint);
  const r = await fetch(`/api/upload/direct?${q.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  if (!r.ok) throw new Error((await r.json()).error ?? "上传失败");
  return (await r.json()) as UploadCompleteResT;
}

/** 上传视频封面（jpeg blob）→ 返回 coverKey（随视频上传关联，服务器存为消息封面） */
export async function apiUploadCover(blob: Blob): Promise<string> {
  const r = await fetch("/api/upload/cover", {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: blob,
  });
  if (!r.ok) throw new Error((await r.json()).error ?? "封面上传失败");
  const d = (await r.json()) as { coverKey: string };
  return d.coverKey;
}

/** 为已存在的消息反向上传视频封面（服务器已有封面时 409 拒绝；失败静默，本地封面已显示） */
export async function apiUploadMsgCover(id: string, blob: Blob): Promise<void> {
  try {
    await fetch(`/api/msg/${encodeURIComponent(id)}/cover`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: blob,
    });
  } catch {
    /* noop */
  }
}

const CHUNK_TIMEOUT_MS = 30_000; // 单个分片请求超时（WiFi 抖动时避免永久挂起）
const CHUNK_MAX_RETRIES = 4; // 单个分片最大重试次数（网络瞬时断连自动恢复）
// 直传阈值不再硬编码：统一由服务器下发（/api/health 的 limits.directUpload），未取到时用 FALLBACK_LIMITS。

/**
 * 上传文件：≤ 直传阈值直接整块上传；更大走分片（断点续传 + 秒传）。
 *
 * **不再在客户端算整文件 SHA-256**（这是「0% 停顿 3 秒」的根因）：
 * 浏览器里没有原生流式 SHA-256（局域网 HTTP 非安全上下文，`crypto.subtle` 为 undefined），
 * 纯 JS 单核 ~100 MB/s，500 MB 要 5~7 秒；多 Worker 并行也只有 1.4 倍收益（实测）。
 * 现在客户端只读前 1 MiB 算特征值（~20 ms）用于秒传/续传判定，
 * 整文件摘要由服务端组装分片时流式算出（它本来就要读一遍全部数据），作为文件 key 与 `sha256` 元数据。
 */
export async function uploadFile(
  file: File,
  onProgress?: (sent: number, total: number) => void,
  coverKey?: string,
  onPhase?: (phase: "preparing" | "uploading" | "finishing") => void
): Promise<UploadCompleteResT> {
  const limits = await fetchLimits();
  if (limits.maxFileSize > 0 && file.size > limits.maxFileSize) {
    throw new Error(`文件过大：${fmtLimitBytes(file.size)} 超过单文件上限 ${fmtLimitBytes(limits.maxFileSize)}（可在 serverConfig.json 调整 maxFileSize）`);
  }

  // 只读前 1 MiB（~20 ms）：用于秒传判定与断点续传 key
  onPhase?.("preparing");
  const fp = await fileFingerprint(file);

  // 小文件直接上传：跳过整文件哈希与分片，消除「上传前等待」
  if (file.size <= limits.directUpload) {
    onProgress?.(file.size, file.size);
    return await apiUploadDirect(file, getDevice(), coverKey, fp);
  }

  // 大文件：分片上传（服务端组装时流式算整文件 sha256 作为最终 key 与校验）
  onPhase?.("uploading");
  // 续传 key：文件名 + 大小 + 前 1 MiB 特征值 —— 不需要整文件摘要即可稳定复现
  const cacheKey = `fsex_upload_v2_${file.name}_${file.size}_${fp.slice(0, 16)}`;
  let savedUploadId: string | undefined;
  try {
    savedUploadId = localStorage.getItem(cacheKey) ?? undefined;
  } catch {
    /* noop */
  }
  const init = await apiUploadInit({
    name: file.name,
    size: file.size,
    mime: file.type || undefined,
    firstChunkSha256: fp,
    device: getDevice(),
    uploadId: savedUploadId,
    coverKey,
  });
  if (init.existed) {
    try {
      localStorage.removeItem(cacheKey);
    } catch {
      /* noop */
    }
    return { ok: true, msg: undefined };
  }
  try {
    const done = new Set(init.done);
    const chunkSize = init.chunkSize;
    let sent = done.size * chunkSize;
    for (let i = 0; i < init.chunkCount; i++) {
      if (done.has(i)) continue;
      const start = i * chunkSize;
      const chunk = file.slice(start, Math.min(start + chunkSize, file.size));
      await apiUploadChunk(init.uploadId, i, chunk);
      sent += chunk.size;
      onProgress?.(Math.min(sent, file.size), file.size);
    }
    // 分片全部传完 ≠ 上传结束：服务端还要**组装 + 校验**（流式 SHA-256、改名落盘）。
    // 大文件这一步在机械盘上要 1~5 秒，客户端却停在 100% 不动 —— 会让人以为卡死，故单独上报一个阶段。
    onPhase?.("finishing");
    const res = await apiUploadComplete(init.uploadId);
    try {
      localStorage.removeItem(cacheKey);
    } catch {
      /* noop */
    }
    return res;
  } catch (e) {
    // 中断：记住 uploadId 供续传
    try {
      localStorage.setItem(cacheKey, init.uploadId);
    } catch {
      /* noop */
    }
    throw e;
  }
}
