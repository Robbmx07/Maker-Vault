// Browser zip reader: works on Blob slices so big archives are never loaded whole.

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  const reader = ds.readable.getReader();
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch { /* a deliberately truncated stream errors at the end; keep what decoded */ }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export async function listZipBlob(blob) {
  const tailLen = Math.min(blob.size, 65557);
  const tail = new Uint8Array(await blob.slice(blob.size - tailLen).arrayBuffer());
  const tv = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip file');
  const total = tv.getUint16(eocd + 10, true);
  const cdSize = tv.getUint32(eocd + 12, true);
  const cdOff = tv.getUint32(eocd + 16, true);
  const cd = new Uint8Array(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const cv = new DataView(cd.buffer);
  const dec = new TextDecoder();
  const entries = [];
  let p = 0;
  for (let i = 0; i < total; i++) {
    if (p + 46 > cd.length || cv.getUint32(p, true) !== 0x02014b50) break;
    const nlen = cv.getUint16(p + 28, true), elen = cv.getUint16(p + 30, true), clen = cv.getUint16(p + 32, true);
    entries.push({
      name: dec.decode(cd.subarray(p + 46, p + 46 + nlen)),
      method: cv.getUint16(p + 10, true), csize: cv.getUint32(p + 20, true),
      usize: cv.getUint32(p + 24, true), offset: cv.getUint32(p + 42, true),
    });
    p += 46 + nlen + elen + clen;
  }
  return entries;
}

// `head` limits the compressed bytes read (metadata at the top of huge files).
export async function readZipEntryBlob(blob, entry, { head = Infinity } = {}) {
  const lh = new DataView(await blob.slice(entry.offset, entry.offset + 30).arrayBuffer());
  if (lh.getUint32(0, true) !== 0x04034b50) throw new Error('bad zip entry');
  const start = entry.offset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
  const data = new Uint8Array(await blob.slice(start, start + Math.min(entry.csize, head)).arrayBuffer());
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRaw(data);
  throw new Error(`unsupported zip compression (${entry.method})`);
}
