import type { UploadInitResT, UploadCompleteResT } from "@filesyncex/protocol";
import { getDevice } from "./device.js";

/** HTTP API 客户端（相对路径，走 Vite 代理或同源静态服务） */

interface InitUploadInput {
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

/** 小文件直接上传：一次 POST 整个文件，跳过 SHA-256 哈希与分片（消除「上传前等待」） */
export async function apiUploadDirect(file: File, device: import("@filesyncex/protocol").DeviceInfoT): Promise<UploadCompleteResT> {
  const q = new URLSearchParams({ name: file.name, mime: file.type || "", device: JSON.stringify(device) });
  const r = await fetch(`/api/upload/direct?${q.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  if (!r.ok) throw new Error((await r.json()).error ?? "上传失败");
  return (await r.json()) as UploadCompleteResT;
}

/** 纯 JS 增量 SHA-256（不依赖 crypto.subtle，兼容局域网 HTTP 非安全上下文） */
class IncrementalSha256 {
  private static readonly K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  private h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private w = new Uint32Array(64);
  private buf = new Uint8Array(64);
  private bufLen = 0;
  private len = 0;

  update(data: Uint8Array): this {
    this.len += data.length;
    let off = 0;
    if (this.bufLen > 0) {
      const need = 64 - this.bufLen;
      const take = Math.min(need, data.length);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take;
      off += take;
      if (this.bufLen === 64) {
        this.compress(this.buf, 0);
        this.bufLen = 0;
      }
    }
    while (off + 64 <= data.length) {
      this.compress(data, off);
      off += 64;
    }
    if (off < data.length) {
      this.buf.set(data.subarray(off), 0);
      this.bufLen = data.length - off;
    }
    return this;
  }

  private compress(block: Uint8Array, start: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const o = start + i * 4;
      w[i] = ((block[o]! << 24) | (block[o + 1]! << 16) | (block[o + 2]! << 8) | block[o + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(w[i - 15]!, 7) ^ rotr32(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr32(w[i - 2]!, 17) ^ rotr32(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = this.h[0]!, b = this.h[1]!, c = this.h[2]!, d = this.h[3]!, e = this.h[4]!, f = this.h[5]!, g = this.h[6]!, h = this.h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + IncrementalSha256.K[i]! + w[i]!) >>> 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    this.h[0] = (this.h[0]! + a) >>> 0; this.h[1] = (this.h[1]! + b) >>> 0; this.h[2] = (this.h[2]! + c) >>> 0; this.h[3] = (this.h[3]! + d) >>> 0;
    this.h[4] = (this.h[4]! + e) >>> 0; this.h[5] = (this.h[5]! + f) >>> 0; this.h[6] = (this.h[6]! + g) >>> 0; this.h[7] = (this.h[7]! + h) >>> 0;
  }

  digestHex(): string {
    const bitHi = Math.floor(this.len / 0x20000000) >>> 0;
    const bitLo = (this.len * 8) >>> 0;
    this.update(new Uint8Array([0x80]));
    while (this.bufLen !== 56) this.update(new Uint8Array([0]));
    const lenBytes = new Uint8Array(8);
    lenBytes[0] = (bitHi >>> 24) & 0xff; lenBytes[1] = (bitHi >>> 16) & 0xff; lenBytes[2] = (bitHi >>> 8) & 0xff; lenBytes[3] = bitHi & 0xff;
    lenBytes[4] = (bitLo >>> 24) & 0xff; lenBytes[5] = (bitLo >>> 16) & 0xff; lenBytes[6] = (bitLo >>> 8) & 0xff; lenBytes[7] = bitLo & 0xff;
    this.update(lenBytes);
    let hex = "";
    for (let i = 0; i < 8; i++) hex += this.h[i]!.toString(16).padStart(8, "0");
    return hex;
  }
}

function rotr32(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

const SHA_CHUNK = 4 * 1024 * 1024; // 4MB，避免大文件整块读入内存
const CHUNK_TIMEOUT_MS = 30_000; // 单个分片请求超时（WiFi 抖动时避免永久挂起）
const CHUNK_MAX_RETRIES = 4; // 单个分片最大重试次数（网络瞬时断连自动恢复）
export const DIRECT_UPLOAD_LIMIT = 8 * 1024 * 1024; // ≤ 该大小直接上传（跳过哈希/分片，消除上传前等待）

/** 计算文件 SHA-256（分块增量，用于秒传/断点续传；兼容局域网 HTTP 非安全上下文） */
export async function fileSha256(file: Blob): Promise<string> {
  const hasher = new IncrementalSha256();
  for (let start = 0; start < file.size; start += SHA_CHUNK) {
    const buf = await file.slice(start, Math.min(start + SHA_CHUNK, file.size)).arrayBuffer();
    hasher.update(new Uint8Array(buf));
  }
  return hasher.digestHex();
}

/** 上传文件：≤ DIRECT_UPLOAD_LIMIT 直接整块上传（跳过哈希/分片）；更大走分片（断点续传 + 秒传） */
export async function uploadFile(file: File, onProgress?: (sent: number, total: number) => void): Promise<UploadCompleteResT> {
  // 小文件直接上传：跳过整文件 SHA-256 与分片，消除「上传前等待」
  if (file.size <= DIRECT_UPLOAD_LIMIT) {
    onProgress?.(file.size, file.size);
    return await apiUploadDirect(file, getDevice());
  }
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
