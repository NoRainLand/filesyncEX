import fs from "node:fs";
import decodeAAC from "@audio/decode-aac";       // M4A/AAC/ALAC
import decodeMP3 from "@audio/decode-mp3";       // MP3
import decodeFLAC from "@audio/decode-flac";     // FLAC
import decodeVorbis from "@audio/decode-vorbis"; // OGG/Vorbis
import decodeOpus from "@audio/decode-opus";     // OGG/Opus

/* ---------- 音频解码：按格式选解码器（WASM 内嵌、零外置二进制），WAV 用内置解析。
   波形（/api/wave）与转码流（/api/stream）共用 decodeToChannels。 ---------- */

export interface Decoded {
  channelData: Float32Array[];
  sampleRate: number;
}

/** 从解码后多声道采样计算峰值（0~1，共 count 点） */
function peaksFromChannels(data: Float32Array[], count: number): number[] {
  const n = data[0]?.length ?? 0;
  if (n < 2) return [];
  const block = Math.max(1, Math.floor(n / count));
  const step = Math.max(1, Math.floor(block / 512));
  const peaks: number[] = [];
  for (let b = 0; b < count; b++) {
    const start = b * block;
    const end = Math.min(start + block, n);
    let max = 0;
    for (let i = start; i < end; i += step) {
      let m = 0;
      for (const ch of data) {
        const v = Math.abs(ch[i] ?? 0);
        if (v > m) m = v;
      }
      if (m > max) max = m;
    }
    peaks.push(Math.min(1, max));
  }
  return peaks;
}

/** 识别音频格式（读魔数） */
type AudioKind = "wav" | "mp3" | "flac" | "ogg" | "opus" | "m4a" | "aac" | null;
function detectKind(buf: Buffer): AudioKind {
  if (buf.length < 12) return null;
  // WAV: RIFF....WAVE
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE") return "wav";
  // FLAC: fLaC
  if (buf.toString("ascii", 0, 4) === "fLaC") return "flac";
  // OGG: OggS —— 容器内区分 Vorbis（\x01vorbis）与 Opus（OpusHead）
  if (buf.toString("ascii", 0, 4) === "OggS") {
    const head = buf.toString("latin1", 0, Math.min(buf.length, 65536));
    return head.includes("OpusHead") ? "opus" : "ogg";
  }
  // MP4/M4A: 第 4~8 字节 box type = ftyp
  if (buf.toString("ascii", 4, 8) === "ftyp") return "m4a";
  // MP3: ID3 标签 或 MPEG 帧同步字 0xFFEx
  if (buf.toString("ascii", 0, 3) === "ID3") return "mp3";
  if ((buf[0] === 0xff) && ((buf[1] ?? 0) & 0xe0) === 0xe0) {
    // 区分 ADTS AAC（0xFFF）与 MP3 帧（0xFFEx，frame sync 11bit = 0x7FF）
    const sync = ((buf[0]! & 0xff) << 4) | ((buf[1]! >> 4) & 0x0f);
    return sync === 0xfff ? "aac" : "mp3";
  }
  return null;
}

/** 通用解码：读文件 → 识别格式 → 解码为多声道 PCM；失败返回 null */
export async function decodeToChannels(p: string): Promise<Decoded | null> {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(p);
  } catch {
    return null;
  }
  const kind = detectKind(buf);
  if (!kind) return null;
  // WAV：内置解析（同步，零依赖）→ 转 channelData
  if (kind === "wav") return decodeWav(buf);
  // 其他格式：WASM 解码器（wasm 内嵌在 JS 里，无外置二进制）
  try {
    if (kind === "mp3") return await decodeMP3(buf);
    if (kind === "flac") return await decodeFLAC(buf);
    if (kind === "ogg") return await decodeVorbis(buf);
    if (kind === "opus") return await decodeOpus(buf);
    return await decodeAAC(buf); // m4a 与 ADTS AAC 裸流
  } catch {
    return null;
  }
}

/** 解析音频文件生成波形峰值数组（0~1，共 count 点）；失败返回 null */
export async function wavePeaksFromFile(p: string, count = 96): Promise<number[] | null> {
  const decoded = await decodeToChannels(p);
  if (!decoded?.channelData?.length) return null;
  const peaks = peaksFromChannels(decoded.channelData, count);
  return peaks.length === count ? peaks : null;
}

/** 内置 WAV 解析：解码为多声道 Float32（format code 1=PCM、3=IEEE float、0xFFFE=extensible 读 subformat） */
function decodeWav(buf: Buffer): Decoded | null {
  if (buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;

  let fmt: { channels: number; bits: number; float: boolean; sampleRate: number } | null = null;
  let dataStart = -1;
  let dataLen = 0;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") {
      if (off + 26 > buf.length) break;
      const formatCode = buf.readUInt16LE(off + 8);
      const channels = buf.readUInt16LE(off + 10);
      const sampleRate = buf.readUInt32LE(off + 12);
      const bits = buf.readUInt16LE(off + 22);
      let float = false;
      if (formatCode === 1) float = false;
      else if (formatCode === 3) float = true;
      else if (formatCode === 0xfffe && off + 40 <= buf.length) {
        // WAVE_FORMAT_EXTENSIBLE：前 2 字节 subformat = GUID 前 16bit
        const sub = buf.readUInt16LE(off + 24);
        if (sub === 1) float = false;
        else if (sub === 3) float = true;
        else return null;
      } else return null; // ADPCM 等不支持的压缩格式
      fmt = { channels, bits, float, sampleRate };
    } else if (id === "data") {
      dataStart = off + 8;
      dataLen = size;
    }
    off += 8 + size + (size % 2);
    if (fmt && dataStart >= 0) break;
  }
  if (!fmt || dataStart < 0 || dataLen <= 0) return null;

  const bytes = fmt.bits / 8;
  const frameSize = bytes * fmt.channels;
  const sampleCount = Math.floor(dataLen / frameSize);
  if (sampleCount < 2) return null;

  const readSample = (index: number): number => {
    const at = dataStart + index * frameSize;
    if (fmt!.float) return fmt!.bits === 32 ? buf.readFloatLE(at) : buf.readDoubleLE(at);
    if (fmt!.bits === 8) return (buf[at]! - 128) / 128;
    if (fmt!.bits === 16) return buf.readInt16LE(at) / 32768;
    if (fmt!.bits === 24) {
      const v = buf[at]! | (buf[at + 1]! << 8) | (buf[at + 2]! << 16);
      return (v << 8 >> 8) / 8388608;
    }
    return buf.readInt32LE(at) / 2147483648;
  };

  // 逐通道构建 Float32Array
  const channelData: Float32Array[] = [];
  for (let c = 0; c < fmt.channels; c++) channelData.push(new Float32Array(sampleCount));
  for (let i = 0; i < sampleCount; i++) {
    for (let c = 0; c < fmt.channels; c++) channelData[c]![i] = readSample(i);
  }
  return { channelData, sampleRate: fmt.sampleRate };
}

/** 转码流：把解码后的多声道 PCM 编码为 16-bit PCM WAV Buffer（浏览器原生可播） */
export function toWavBuffer(decoded: Decoded): Buffer {
  const { channelData, sampleRate } = decoded;
  const ch = channelData.length;
  const n = channelData[0]?.length ?? 0;
  const dataSize = n * ch * 2; // 16bit
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * ch * 2, 28); // byte rate
  buf.writeUInt16LE(ch * 2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  // 16-bit PCM 写入（多声道交织）
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, channelData[c]![i] ?? 0));
      buf.writeInt16LE(Math.round(v * 32767), o);
      o += 2;
    }
  }
  return buf;
}
