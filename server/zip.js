// Minimal zip reader (no dependencies). Reads by file offset so large 3MF files are
// never fully loaded. Writing lives in zip-write.js so the browser build can share it.
import fs from 'node:fs';
import zlib from 'node:zlib';

export function listZip(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip file');
    const total = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOff = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);
    const entries = [];
    let p = 0;
    for (let i = 0; i < total; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) break;
      const nlen = cd.readUInt16LE(p + 28);
      const elen = cd.readUInt16LE(p + 30);
      const clen = cd.readUInt16LE(p + 32);
      entries.push({
        name: cd.toString('utf8', p + 46, p + 46 + nlen),
        method: cd.readUInt16LE(p + 10),
        csize: cd.readUInt32LE(p + 20),
        usize: cd.readUInt32LE(p + 24),
        offset: cd.readUInt32LE(p + 42),
      });
      p += 46 + nlen + elen + clen;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

// Read one entry. `head` limits how many compressed bytes are read, so a
// truncated-but-valid prefix of huge model files can be inspected cheaply.
export function readZipEntry(file, entry, { head = Infinity } = {}) {
  const fd = fs.openSync(file, 'r');
  try {
    const lh = Buffer.alloc(30);
    fs.readSync(fd, lh, 0, 30, entry.offset);
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('bad local header');
    const start = entry.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    const want = Math.min(entry.csize, head);
    const data = Buffer.alloc(want);
    fs.readSync(fd, data, 0, want, start);
    if (entry.method === 0) return data;
    if (entry.method === 8) {
      return zlib.inflateRawSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    }
    throw new Error(`unsupported compression method ${entry.method}`);
  } finally {
    fs.closeSync(fd);
  }
}

export { buildZip } from './zip-write.js';
