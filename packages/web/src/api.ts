import type { MsgDataT, UploadInitResT, UploadCompleteResT } from "@filesyncex/protocol";
import { getDevice } from "./device.js";

/** HTTP API 客户端（相对路径，走 Vite 代理或同源静态服务） */

export async function apiHealth(): Promise<boolean> {
  try {
    const r = await fetch("/api/health");
    return r.ok;
  } catch {
    return false;
  }
}

export async function apiMsgs(): Promise<MsgDataT[]> {
  const r = await fetch("/api/msgs");
  return (await r.json()) as MsgDataT[];
}

export interface InitUploadInput {
  name: string;
  size: number;
  mime?: string;
  sha256?: string;
  device: import("@filesyncex/protocol").DeviceInfoT;
  uploadId?: string;
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
  const r = await fetch(`/api/upload/chunk/${uploadId}/${index}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: data,
  });
  if (!r.ok) throw new Error((await r.json()).error ?? `分片 ${index} 上传失败`);
}

export async function apiUploadComplete(uploadId: string): Promise<UploadCompleteResT> {
  const r = await fetch(`/api/upload/complete/${uploadId}`, { method: "POST" });
  if (!r.ok) throw new Error((await r.json()).error ?? "上传完成失败");
  return (await r.json()) as UploadCompleteResT;
}

/** 计算文件 SHA-256（用于秒传） */
export async function fileSha256(file: Blob): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 分片上传整个文件（断点续传 + 秒传）。中断时保存 uploadId，下次按同 sha 自动续传 */
export async function uploadFile(file: File, onProgress?: (sent: number, total: number) => void): Promise<UploadCompleteResT> {
  const sha = await fileSha256(file);
  const cacheKey = "fsex_upload_" + sha;
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
    sha256: sha,
    device: getDevice(),
    uploadId: savedUploadId,
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
