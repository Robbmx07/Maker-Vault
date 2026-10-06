// Mesh readers for the 3D viewer. Pure functions, no DOM, so they run in tests too.
// Every reader returns { positions: Float32Array } holding 9 numbers (3 corners x xyz) per triangle.

export const MAX_TRIANGLES = 2_000_000;

export function parseStl(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const count = u8.length >= 84 ? dv.getUint32(80, true) : -1;
  if (count >= 0 && u8.length === 84 + count * 50) {
    if (count > MAX_TRIANGLES) throw new Error(`This model has ${count.toLocaleString()} triangles, too many to preview.`);
    const positions = new Float32Array(count * 9);
    for (let i = 0; i < count; i++) {
      const o = 84 + i * 50 + 12;
      for (let k = 0; k < 9; k++) positions[i * 9 + k] = dv.getFloat32(o + k * 4, true);
    }
    return { positions };
  }
  // ASCII STL
  const text = new TextDecoder('latin1').decode(u8);
  const nums = [];
  for (const m of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) nums.push(+m[1], +m[2], +m[3]);
  if (nums.length < 9) throw new Error('No triangles found in this STL file.');
  if (nums.length / 9 > MAX_TRIANGLES) throw new Error('This model has too many triangles to preview.');
  return { positions: Float32Array.from(nums.slice(0, nums.length - (nums.length % 9))) };
}

export function parseObj(buf) {
  const text = new TextDecoder().decode(buf);
  const v = [];
  const out = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('v ')) { const p = line.trim().split(/\s+/); v.push([+p[1], +p[2], +p[3]]); }
    else if (line.startsWith('f ')) {
      const idx = line.trim().split(/\s+/).slice(1).map((s) => { const n = parseInt(s, 10); return n < 0 ? v.length + n : n - 1; });
      for (let i = 1; i + 1 < idx.length; i++) { // fan-triangulate polygons
        for (const j of [idx[0], idx[i], idx[i + 1]]) { const p = v[j]; if (!p) throw new Error('This OBJ file refers to a missing point.'); out.push(p[0], p[1], p[2]); }
      }
    }
  }
  if (!out.length) throw new Error('No faces found in this OBJ file.');
  if (out.length / 9 > MAX_TRIANGLES) throw new Error('This model has too many triangles to preview.');
  return { positions: Float32Array.from(out) };
}

// ---- 3MF: a zip of XML model files ---------------------------------------------------------
async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter();
  w.write(bytes).catch(() => {});
  w.close().catch(() => {});
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

async function unzipModels(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let e = u8.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('This 3MF file is not a valid zip archive.');
  const total = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  const models = {};
  for (let i = 0; i < total; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (!/\.model$/i.test(name)) continue;
    const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
    const data = u8.subarray(start, start + csize);
    models['/' + name.replace(/^\/+/, '')] = new TextDecoder().decode(method === 0 ? data : method === 8 ? await inflateRaw(data) : (() => { throw new Error('Unsupported 3MF compression.'); })());
  }
  return models;
}

const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]; // 3MF matrices: 12 numbers, row-vector convention
const parseMatrix = (s) => { const m = (s || '').trim().split(/\s+/).map(Number); return m.length === 12 && m.every(Number.isFinite) ? m : IDENT; };
const apply = (m, x, y, z) => [x * m[0] + y * m[3] + z * m[6] + m[9], x * m[1] + y * m[4] + z * m[7] + m[10], x * m[2] + y * m[5] + z * m[8] + m[11]];
const multiply = (a, b) => { // apply a first, then b
  const out = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) {
    const ar = r < 3 ? [a[r * 3], a[r * 3 + 1], a[r * 3 + 2]] : [a[9], a[10], a[11]];
    out.push(ar[0] * b[c] + ar[1] * b[3 + c] + ar[2] * b[6 + c] + (r === 3 ? b[9 + c] : 0));
  }
  return out;
};
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`)); return m ? m[1] : null; };

export async function parse3mf(buf) {
  const files = await unzipModels(buf);
  const names = Object.keys(files);
  if (!names.length) throw new Error('No 3D model found inside this 3MF file.');
  const rootName = names.find((n) => /^\/3D\/3dmodel\.model$/i.test(n)) || names[0];
  const objects = {}; // `${file}#${id}` -> { tris: number[] } | { comps: [{ref, m}] }
  for (const [file, xml] of Object.entries(files)) {
    for (const o of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
      const id = attr(o[1], 'id'), body = o[2];
      const mesh = body.match(/<mesh>([\s\S]*?)<\/mesh>/);
      if (mesh) {
        const verts = [...mesh[1].matchAll(/<vertex\b([^>]*)\/?>/g)].map((m) => [+attr(m[1], 'x'), +attr(m[1], 'y'), +attr(m[1], 'z')]);
        const tris = [];
        for (const t of mesh[1].matchAll(/<triangle\b([^>]*)\/?>/g)) {
          for (const k of ['v1', 'v2', 'v3']) { const p = verts[+attr(t[1], k)]; if (!p) throw new Error('Damaged 3MF mesh.'); tris.push(p[0], p[1], p[2]); }
          if (tris.length / 9 > MAX_TRIANGLES) throw new Error('This model has too many triangles to preview.');
        }
        objects[`${file}#${id}`] = { tris };
      } else {
        const comps = [...body.matchAll(/<component\b([^>]*)\/?>/g)].map((c) => ({
          ref: `${(attr(c[1], 'p:path') || attr(c[1], 'path')) ? '/' + (attr(c[1], 'p:path') || attr(c[1], 'path')).replace(/^\/+/, '') : file}#${attr(c[1], 'objectid')}`,
          m: parseMatrix(attr(c[1], 'transform')),
        }));
        objects[`${file}#${id}`] = { comps };
      }
    }
  }
  const out = [];
  const emit = (key, m, depth) => {
    const o = objects[key];
    if (!o || depth > 8) return;
    if (o.tris) { for (let i = 0; i < o.tris.length; i += 3) out.push(...apply(m, o.tris[i], o.tris[i + 1], o.tris[i + 2])); }
    else for (const c of o.comps) emit(c.ref, multiply(c.m, m), depth + 1);
  };
  const build = files[rootName].match(/<build\b[^>]*>([\s\S]*?)<\/build>/);
  const items = build ? [...build[1].matchAll(/<item\b([^>]*)\/?>/g)] : [];
  if (items.length) for (const it of items) emit(`${rootName}#${attr(it[1], 'objectid')}`, parseMatrix(attr(it[1], 'transform')), 0);
  else for (const k of Object.keys(objects)) if (objects[k].tris) emit(k, IDENT, 0); // no build section: show every mesh
  if (!out.length) throw new Error('No 3D shape found inside this 3MF file.');
  return { positions: Float32Array.from(out) };
}

export const VIEWABLE = new Set(['stl', 'obj', '3mf']);
export const canView = (name) => VIEWABLE.has(String(name).split('.').pop().toLowerCase());

export async function loadMesh(name, buf) {
  const ext = String(name).split('.').pop().toLowerCase();
  if (ext === 'stl') return parseStl(buf);
  if (ext === 'obj') return parseObj(buf);
  if (ext === '3mf') return parse3mf(buf);
  throw new Error('This file type cannot be previewed in 3D.');
}

export function bounds(positions) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) { const v = positions[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
  return { min, max, size: max.map((m, k) => m - min[k]) };
}
