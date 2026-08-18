/** 最小 STORE（无压缩）ZIP 生成器：零依赖、pkg 打包友好。用于数据导出备份。 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** zip 内路径（正斜杠，如 uploads/xxx.jpg） */
  path: string;
  data: Buffer;
}

export function makeZip(files: ZipEntry[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.path, "utf8");
    const crc = crc32(f.data);
    const len = f.data.length;
    // 本地文件头
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); // signature
    l.writeUInt16LE(20, 4); // version needed
    l.writeUInt16LE(0x0800, 6); // flags：bit 11 = 文件名 UTF-8（否则 Windows 按本地编码解压，中文乱码）
    l.writeUInt16LE(0, 8); // method 0 = store（无压缩）
    l.writeUInt16LE(0, 10); // mod time
    l.writeUInt16LE(0, 12); // mod date
    l.writeUInt32LE(crc, 14);
    l.writeUInt32LE(len, 18);
    l.writeUInt32LE(len, 22);
    l.writeUInt16LE(name.length, 26);
    l.writeUInt16LE(0, 28); // extra len
    local.push(l, name, f.data);
    // 中央目录条目
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); // signature
    c.writeUInt16LE(20, 4); // version made by
    c.writeUInt16LE(20, 6); // version needed
    c.writeUInt16LE(0x0800, 8); // flags：bit 11 = 文件名 UTF-8
    c.writeUInt16LE(0, 10); // method
    c.writeUInt16LE(0, 12); // time
    c.writeUInt16LE(0, 14); // date
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(len, 20);
    c.writeUInt32LE(len, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(0, 30); // extra len
    c.writeUInt16LE(0, 32); // comment len
    c.writeUInt16LE(0, 34); // disk number
    c.writeUInt16LE(0, 36); // internal attrs
    c.writeUInt32LE(0, 38); // external attrs
    c.writeUInt32LE(offset, 42); // local header offset
    central.push(c, name);
    offset += 30 + name.length + len;
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); // end of central dir signature
  e.writeUInt16LE(0, 4); // disk number
  e.writeUInt16LE(0, 6); // cd start disk
  e.writeUInt16LE(files.length, 8);
  e.writeUInt16LE(files.length, 10);
  e.writeUInt32LE(cd.length, 12);
  e.writeUInt32LE(offset, 16);
  e.writeUInt16LE(0, 20); // comment len
  return Buffer.concat([...local, cd, e]);
}
