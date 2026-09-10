import fs from "node:fs";
import type { Writable } from "node:stream";

/** 最小 STORE（无压缩）ZIP 流式生成器：零依赖、pkg 打包友好。用于数据导出备份。
 *  流式写出（本地头 → 数据 → 中央目录 → EOCD），数据目录多大都不整块进内存。 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** 增量 CRC-32（跨多次 update 保持状态，供流式写入使用） */
class Crc32 {
  private c = 0xffffffff;
  update(buf: Buffer): void {
    let c = this.c;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
    this.c = c;
  }
  digest(): number {
    return (this.c ^ 0xffffffff) >>> 0;
  }
}

interface Entry {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
}

/** STORE 方式：数据长度=压缩长度。flags bit 11 = 文件名 UTF-8（否则 Windows 按本地编码解压，中文乱码） */
const FLAGS = 0x0800;

/** 把 Buffer 写进流，等待该块真正写出（回调），保证顺序与背压 */
function writeChunk(out: Writable, buf: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    out.write(buf, (e) => (e ? reject(e) : resolve()));
  });
}

/**
 * 流式 zip 写入器。
 * 用法：`const z = new ZipWriter(res); await z.addBuffer(...); await z.addFile(...); await z.finish();`
 */
export class ZipWriter {
  private out: Writable;
  private entries: Entry[] = [];
  private offset = 0;
  private started = false;

  constructor(out: Writable) {
    this.out = out;
  }

  /** 写入一个 Buffer（如数据库快照） */
  async addBuffer(path: string, data: Buffer): Promise<void> {
    const name = Buffer.from(path, "utf8");
    const offset = this.offset;
    const crc = new Crc32();
    crc.update(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(FLAGS, 6);
    header.writeUInt16LE(0, 8); // method 0 = store
    header.writeUInt32LE(crc.digest(), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    await writeChunk(this.out, header);
    await writeChunk(this.out, name);
    await writeChunk(this.out, data);
    this.offset += 30 + name.length + data.length;
    this.entries.push({ name, crc: crc.digest(), size: data.length, offset });
    this.started = true;
  }

  /** 流式写入磁盘文件（边读边算 CRC 边写，不整块入内存） */
  async addFile(path: string, filePath: string): Promise<void> {
    const name = Buffer.from(path, "utf8");
    const offset = this.offset;
    const size = fs.statSync(filePath).size;
    // 数据长度需先写入本地头，故先算 CRC（一次读盘），再流式写第二遍
    const crc = new Crc32();
    await new Promise<void>((resolve, reject) => {
      const rs = fs.createReadStream(filePath, { highWaterMark: 1 << 20 });
      rs.on("data", (chunk) => crc.update(chunk as Buffer));
      rs.on("error", reject);
      rs.on("end", () => resolve());
    });
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(FLAGS, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt32LE(crc.digest(), 14);
    header.writeUInt32LE(size, 18);
    header.writeUInt32LE(size, 22);
    header.writeUInt16LE(name.length, 26);
    await writeChunk(this.out, header);
    await writeChunk(this.out, name);
    await new Promise<void>((resolve, reject) => {
      const rs = fs.createReadStream(filePath, { highWaterMark: 1 << 20 });
      rs.on("error", reject);
      rs.on("data", (chunk) => {
        const buf = chunk as Buffer;
        if (!this.out.write(buf)) {
          rs.pause();
          this.out.once("drain", () => rs.resume());
        }
      });
      rs.on("end", () => resolve());
    });
    this.offset += 30 + name.length + size;
    this.entries.push({ name, crc: crc.digest(), size, offset });
    this.started = true;
  }

  /** 写中央目录 + EOCD 并结束流 */
  async finish(): Promise<void> {
    if (this.started) {
      for (const e of this.entries) {
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0);
        c.writeUInt16LE(20, 4); // version made by
        c.writeUInt16LE(20, 6); // version needed
        c.writeUInt16LE(FLAGS, 8);
        c.writeUInt16LE(0, 10); // method
        c.writeUInt32LE(e.crc, 16);
        c.writeUInt32LE(e.size, 20);
        c.writeUInt32LE(e.size, 24);
        c.writeUInt16LE(e.name.length, 28);
        c.writeUInt32LE(e.offset, 42);
        await writeChunk(this.out, c);
        await writeChunk(this.out, e.name);
        this.offset += 46 + e.name.length;
      }
    }
    const e = Buffer.alloc(22);
    e.writeUInt32LE(0x06054b50, 0);
    e.writeUInt16LE(this.entries.length, 8);
    e.writeUInt16LE(this.entries.length, 10);
    e.writeUInt32LE(this.offset - this.centralStart(), 12);
    e.writeUInt32LE(this.centralStart(), 16);
    await writeChunk(this.out, e);
    await new Promise<void>((resolve) => this.out.end(resolve));
  }

  /** 中央目录起始偏移 = 最后一条数据的结束位置（无条目时为 0） */
  private centralStart(): number {
    const last = this.entries[this.entries.length - 1];
    return last ? last.offset + 30 + last.name.length + last.size : 0;
  }
}
