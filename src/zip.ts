import * as zlib from 'zlib';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800;

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c >>> 0;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n >>> 0, 0);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Build a zip (deflate, fallback to store). */
export function createZip(entries: ZipEntry[], comment = 'OEG-backup'): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const raw = entry.data;
    const crc = crc32(raw);
    let method = 8;
    let compressed: Buffer;
    try {
      compressed = zlib.deflateRawSync(raw);
      if (compressed.length >= raw.length) {
        method = 0;
        compressed = raw;
      }
    } catch {
      method = 0;
      compressed = raw;
    }

    const local = Buffer.concat([
      u32(LOCAL_SIG),
      u16(20),
      u16(UTF8_FLAG),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(compressed.length),
      u32(raw.length),
      u16(name.length),
      u16(0),
      name,
      compressed
    ]);
    locals.push(local);

    const central = Buffer.concat([
      u32(CENTRAL_SIG),
      u16(20),
      u16(20),
      u16(UTF8_FLAG),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(compressed.length),
      u32(raw.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name
    ]);
    centrals.push(central);
    offset += local.length;
  }

  const centralDir = Buffer.concat(centrals);
  const commentBuf = Buffer.from(comment, 'utf8');
  const eocd = Buffer.concat([
    u32(EOCD_SIG),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDir.length),
    u32(offset),
    u16(commentBuf.length),
    commentBuf
  ]);
  return Buffer.concat([...locals, centralDir, eocd]);
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      return i;
    }
  }
  throw new Error('Not a zip file (missing central directory)');
}

/** Read file entries from a zip (store or deflate). */
export function readZip(buf: Buffer): { entries: ZipEntry[]; comment: string } {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const commentLen = buf.readUInt16LE(eocd + 20);
  const comment = buf.subarray(eocd + 22, eocd + 22 + commentLen).toString('utf8');
  const out: ZipEntry[] = [];

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new Error('Invalid zip central directory');
    }
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const uncompSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOff = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    offset += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) {
      continue;
    }

    if (buf.readUInt32LE(localOff) !== LOCAL_SIG) {
      throw new Error(`Invalid zip local header for ${name}`);
    }
    const localNameLen = buf.readUInt16LE(localOff + 26);
    const localExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + localNameLen + localExtraLen;
    const compressed = buf.subarray(dataOff, dataOff + compSize);
    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(compressed);
    } else if (method === 8) {
      data = zlib.inflateRawSync(compressed);
    } else {
      throw new Error(`Unsupported zip compression (${method}) in ${name}`);
    }
    if (uncompSize && data.length !== uncompSize) {
      throw new Error(`Zip size mismatch for ${name}`);
    }
    out.push({ name: name.replace(/\\/g, '/'), data });
  }
  return { entries: out, comment };
}

/** Reject zip-slip and absolute paths. Returns a normalized relative path or undefined. */
export function safeZipPath(name: string): string | undefined {
  const trimmed = name.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!trimmed || trimmed.endsWith('/')) {
    return undefined;
  }
  const parts: string[] = [];
  for (const part of trimmed.split('/')) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      return undefined;
    }
    if (/^[a-zA-Z]:$/.test(part)) {
      return undefined;
    }
    parts.push(part);
  }
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join('/');
}
