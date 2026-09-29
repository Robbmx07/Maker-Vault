import fs from 'node:fs';

const r = (n) => Math.round(n * 100) / 100;

export function parseStlBuffer(buf) {
  let tri = 0;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const bump = (x, y, z) => {
    const v = [x, y, z];
    for (let i = 0; i < 3; i++) { if (v[i] < min[i]) min[i] = v[i]; if (v[i] > max[i]) max[i] = v[i]; }
  };
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const binaryCount = buf.length >= 84 ? dv.getUint32(80, true) : -1;
  if (binaryCount >= 0 && buf.length === 84 + binaryCount * 50) {
    tri = binaryCount;
    for (let i = 0; i < tri; i++) {
      const o = 84 + i * 50 + 12;
      for (let v = 0; v < 3; v++) bump(dv.getFloat32(o + v * 12, true), dv.getFloat32(o + v * 12 + 4, true), dv.getFloat32(o + v * 12 + 8, true));
    }
  } else {
    const s = new TextDecoder('latin1').decode(buf);
    for (const m of s.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) {
      bump(+m[1], +m[2], +m[3]);
      tri += 1 / 3;
    }
    tri = Math.round(tri);
  }
  if (!tri || !Number.isFinite(min[0])) return { meta: {}, recipe: {} };
  return { meta: { triangles: tri, size_mm: [r(max[0] - min[0]), r(max[1] - min[1]), r(max[2] - min[2])] }, recipe: {} };
}

export function parseStl(file) {
  if (fs.statSync(file).size > 150e6) return { meta: { skipped: 'too large to inspect' }, recipe: {} };
  return parseStlBuffer(fs.readFileSync(file));
}
