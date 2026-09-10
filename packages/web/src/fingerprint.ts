/**
 * 文件特征值（指纹）：**文件前 1 MiB 的标准 SHA-256**。
 *
 * 为什么不用「整文件 SHA-256」：浏览器里没有可用的原生流式 SHA-256
 * （局域网 `http://192.168.x.x` 不是安全上下文，`crypto.subtle` 为 undefined，已实测），
 * 纯 JS 实现单核只有 ~100 MB/s（实测 500 MB：读盘 1.4 GB/s，哈希仅 100 MB/s，磁盘不是瓶颈）。
 * 500 MB 文件整文件哈希要 5~7 秒，而多 Worker 并行也只有 1.4 倍收益（Web Crypto 单核上限所致），
 * 这段等待正好显示为「上传进度 0%」，是体感卡顿的主因。
 *
 * 因此客户端只读文件开头 1 MiB 算指纹（500 MB 文件耗时 ~20 ms，快 300 倍），
 * 真正的整文件 SHA-256 交给服务端在组装分片时流式计算 —— 它本来就要读一遍全部数据，
 * 且结果仍作为文件 key 与 `sha256` 元数据，秒传/去重所需的安全性不变。
 */

/** 参与指纹的固定前缀长度（不随分片大小变化，保证直传与分片两条路径算法一致） */
export const FINGERPRINT_BYTES = 1024 * 1024;

/** 计算文件特征值；空文件返回全零文件的摘要（与服务端一致） */
export async function fileFingerprint(file: Blob): Promise<string> {
  const hasher = createSha256();
  const take = Math.min(FINGERPRINT_BYTES, file.size);
  if (take > 0) hasher.update(new Uint8Array(await file.slice(0, take).arrayBuffer()));
  return hasher.hex();
}

/* ---------- 以下为纯 JS 标准 SHA-256（仅在「前 1 MiB」这个量级上运行） ---------- */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0;

interface Hasher {
  update(data: Uint8Array): void;
  hex(): string;
}

/** 增量 SHA-256：把 1 MiB 前缀分几次喂进来也能得到正确结果 */
function createSha256(): Hasher {
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  // 未凑满 64 字节的尾巴 + 已处理字节数
  let tail = new Uint8Array(0);
  let total = 0;

  const compress = (block: Uint8Array, off: number): void => {
    for (let i = 0; i < 16; i++) {
      const o = off + i * 4;
      w[i] = ((block[o]! << 24) | (block[o + 1]! << 16) | (block[o + 2]! << 8) | block[o + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = H[0]!, b = H[1]!, c = H[2]!, d = H[3]!, e = H[4]!, f = H[5]!, g = H[6]!, h = H[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0]! + a) >>> 0; H[1] = (H[1]! + b) >>> 0; H[2] = (H[2]! + c) >>> 0; H[3] = (H[3]! + d) >>> 0;
    H[4] = (H[4]! + e) >>> 0; H[5] = (H[5]! + f) >>> 0; H[6] = (H[6]! + g) >>> 0; H[7] = (H[7]! + h) >>> 0;
  };

  return {
    update(data: Uint8Array): void {
      total += data.length;
      let buf: Uint8Array;
      if (tail.length) {
        buf = new Uint8Array(tail.length + data.length);
        buf.set(tail);
        buf.set(data, tail.length);
      } else {
        buf = data;
      }
      let off = 0;
      for (; off + 64 <= buf.length; off += 64) compress(buf, off);
      tail = buf.slice(off);
    },
    hex(): string {
      const bitLen = total * 8;
      // padding：0x80 + 若干 0 + 8 字节大端比特长度
      const padLen = tail.length < 56 ? 64 - tail.length : 128 - tail.length;
      const last = new Uint8Array(tail.length + padLen);
      last.set(tail);
      last[tail.length] = 0x80;
      const dv = new DataView(last.buffer);
      dv.setUint32(last.length - 8, Math.floor(bitLen / 4294967296));
      dv.setUint32(last.length - 4, bitLen >>> 0);
      for (let off = 0; off < last.length; off += 64) compress(last, off);
      let hex = "";
      for (let i = 0; i < 8; i++) hex += H[i]!.toString(16).padStart(8, "0");
      return hex;
    },
  };
}
