// Zip writing primitives shared by the server and the browser build (no Node APIs).
// Entries are "stored" (uncompressed); no zip64, so archives are limited to 4 GB.

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

// Incremental CRC-32: feed chunks, passing the previous result back in (start with 0).
export function crc32Update(prev, bytes) {
  let c = ~prev >>> 0;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function dosNow() {
  const d = new Date();
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// Local + central headers for one stored entry.
export function zipEntryHeaders(name, crc, size, offset, dos = dosNow()) {
  const nameBuf = new TextEncoder().encode(name);
  const local = new Uint8Array(30 + nameBuf.length);
  const l = new DataView(local.buffer);
  l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x0800, true);
  l.setUint16(10, dos.time, true); l.setUint16(12, dos.date, true);
  l.setUint32(14, crc, true); l.setUint32(18, size, true); l.setUint32(22, size, true);
  l.setUint16(26, nameBuf.length, true);
  local.set(nameBuf, 30);
  const central = new Uint8Array(46 + nameBuf.length);
  const c = new DataView(central.buffer);
  c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
  c.setUint16(12, dos.time, true); c.setUint16(14, dos.date, true);
  c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true);
  c.setUint16(28, nameBuf.length, true); c.setUint32(42, offset, true);
  central.set(nameBuf, 46);
  return { local, central };
}

export function zipEndRecord(count, cdSize, cdOffset) {
  const e = new Uint8Array(22);
  const v = new DataView(e.buffer);
  v.setUint32(0, 0x06054b50, true); v.setUint16(8, count, true); v.setUint16(10, count, true);
  v.setUint32(12, cdSize, true); v.setUint32(16, cdOffset, true);
  return e;
}

// In-memory build from Uint8Array/Buffer data (server side).
export function buildZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const dos = dosNow();
  for (const { name, data } of files) {
    const h = zipEntryHeaders(name, crc32Update(0, data), data.length, offset, dos);
    parts.push(h.local, data);
    central.push(h.central);
    offset += h.local.length + data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  parts.push(...central, zipEndRecord(files.length, cdSize, offset));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
