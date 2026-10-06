// Browser backend: the whole vault lives in this browser (IndexedDB). It answers the same
// "API" the UI uses with the server, so the UI code is identical in both editions.
import { detectKind, guessMachine, projectStem, extOf } from '../server/parsers/index.js';
import { parseGcodeText } from '../server/parsers/gcode.js';
import { parseSvgText } from '../server/parsers/svg.js';
import { parseLightBurnText } from '../server/parsers/lightburn.js';
import { parseStlBuffer } from '../server/parsers/stl.js';
import { planThreeMF, parseThreeMFParts, THREEMF_MODEL_HEAD } from '../server/parsers/threemf.js';
import { diffSettings } from '../server/diff.js';
import { crc32Update, zipEntryHeaders, zipEndRecord } from '../server/zip-write.js';
import { listZipBlob, readZipEntryBlob } from './zip-read.js';

export const local = true;
export const compression = typeof CompressionStream !== 'undefined';

const MACHINES = ['3d', 'laser', 'cutter', 'other', 'unknown'];
const OUTCOMES = ['pass', 'partial', 'fail'];
const FIELD_TYPES = ['text', 'number', 'select', 'checkbox'];
const STORES = ['projects', 'files', 'materials', 'runs', 'fields'];
const now = () => Date.now();
const bad = (m) => new Error(m);
const safeName = (n) => String(n || 'file').split(/[\\/]/).pop().replace(/[^\w.\- ()+]/g, '_').slice(0, 180) || 'file';

// ------------------------------------------------------------------ IndexedDB
let dbPromise;
function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(bad('This browser does not allow local storage for this page. Try Chrome, Edge or Firefox.'));
    // The database keeps its original name on purpose: renaming it would hide libraries saved before the product was renamed.
    const req = indexedDB.open('maker-vault', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        const os = db.createObjectStore(s, { keyPath: 'id', autoIncrement: true });
        if (s === 'files' || s === 'runs') os.createIndex('project_id', 'project_id');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(bad(`Could not open browser storage: ${req.error?.message || 'unknown error'}. Private windows and some locked-down browsers block it.`));
  });
  return dbPromise;
}
const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
async function os(name, mode = 'readonly') { return (await openDb()).transaction(name, mode).objectStore(name); }
const getAll = async (name) => wrap((await os(name)).getAll());
const getOne = async (name, id) => wrap((await os(name)).get(Number(id)));
const putRec = async (name, rec) => wrap((await os(name, 'readwrite')).put(rec));
const delRec = async (name, id) => wrap((await os(name, 'readwrite')).delete(Number(id)));
const byProject = async (name, id) => wrap((await os(name)).index('project_id').getAll(Number(id)));
const clearStore = async (name) => wrap((await os(name, 'readwrite')).clear());

// ------------------------------------------------------------------ helpers
const urls = new Map(); // file id -> blob: URL, for images the UI shows
function urlFor(f) {
  if (f.kind !== 'photo' || !f.blob || f.encoding) return null;
  if (!urls.has(f.id)) urls.set(f.id, URL.createObjectURL(f.blob));
  return urls.get(f.id);
}
function forgetUrl(id) { const u = urls.get(id); if (u) { URL.revokeObjectURL(u); urls.delete(id); } }
const shapeFile = (f) => { const { blob, ...rest } = f; return { ...rest, url: urlFor(f) }; };
const orderFiles = (a, b) => a.auto - b.auto || a.created_at - b.created_at || a.id - b.id;

function flatStrings(obj, label) {
  if (obj === undefined) return undefined;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw bad(`${label} must be an object`);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'object') throw bad(`${label}.${k} must be a string or number`);
    out[String(k).slice(0, 80)] = String(v).slice(0, 2000);
  }
  return out;
}
const cleanTags = (tags) => [...new Set((tags || []).map((t) => String(t).trim().toLowerCase().slice(0, 40)).filter(Boolean))].sort();

async function sha256(blob, name) {
  // Hashing reads the whole file; skip it for enormous files and use a cheap identity instead.
  if (blob.size > 256 * 1024 * 1024 || !crypto?.subtle) return `fast:${blob.size}:${name}`;
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------------ compression
// Files are stored deflate-compressed when that actually helps (G-code, STL, SVG, LightBurn...).
// Already-compressed formats are stored as they are. `size` is always the original size and
// `stored_size` what is kept; `encoding` says how to get the original bytes back.
const ENCODING = 'deflate-raw';
const NO_COMPRESS = new Set(['3mf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'mp4', 'mov', 'webm', 'zip', 'gz', '7z', 'rar', 'pdf', 'bgcode', 'ufp']);
const MIN_SAVING = 0.10; // keep the compressed copy only if it is at least 10% smaller
const canCompress = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

const pipe = (blob, stream) => new Response(blob.stream().pipeThrough(stream)).blob();
const deflate = (blob) => pipe(blob, new CompressionStream(ENCODING));
const inflate = (blob) => pipe(blob, new DecompressionStream(ENCODING));

async function crcOfBlob(blob) {
  let crc = 0;
  const reader = blob.stream().getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; crc = crc32Update(crc, value); }
  return crc;
}

// Returns what to store. Never returns something that does not decompress back to the exact original.
async function packForStorage(blob, name, kind) {
  const raw = { blob, encoding: null, stored_size: blob.size };
  if (!canCompress || kind === 'photo' || kind === 'video' || NO_COMPRESS.has(extOf(name)) || blob.size < 512) return raw;
  try {
    const packed = await deflate(blob);
    if (packed.size > blob.size * (1 - MIN_SAVING)) return raw;
    const back = await inflate(packed); // verify before trusting it
    if (back.size !== blob.size || (await crcOfBlob(back)) !== (await crcOfBlob(blob))) return raw;
    return { blob: packed, encoding: ENCODING, stored_size: packed.size };
  } catch { return raw; }
}

// The original bytes of a stored file.
async function originalBlob(rec) {
  if (!rec.encoding) return rec.blob;
  if (rec.encoding === ENCODING) return inflate(rec.blob);
  throw bad(`Unknown storage format "${rec.encoding}"`);
}

// ------------------------------------------------------------------ parsing
const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder();
const CHUNK = 256 * 1024;

async function headTail(blob) {
  const head = await blob.slice(0, CHUNK).arrayBuffer();
  let text = latin1.decode(head);
  if (blob.size > CHUNK * 2) text += '\n' + latin1.decode(await blob.slice(blob.size - CHUNK).arrayBuffer());
  else if (blob.size > CHUNK) text += latin1.decode(await blob.slice(CHUNK).arrayBuffer());
  return text;
}

async function parseThreeMFBlob(blob) {
  const entries = await listZipBlob(blob);
  const plan = planThreeMF(entries);
  const read = async (name, opts) => {
    if (!name) return null;
    try { return await readZipEntryBlob(blob, entries.find((e) => e.name === name), opts); } catch { return null; }
  };
  const str = async (name, opts) => { const b = await read(name, opts); return b ? utf8.decode(b) : null; };
  return parseThreeMFParts({
    model: await str(plan.model, { head: THREEMF_MODEL_HEAD }), prusa: await str(plan.prusa), bambu: await str(plan.bambu),
    slice: await str(plan.slice), thumbnail: await read(plan.thumb),
  });
}

async function parseBlob(blob, name) {
  const ext = extOf(name);
  const out = { kind: detectKind(name), ext, meta: {}, recipe: {} };
  try {
    let r;
    if (ext === 'gcode' || ext === 'gco') r = parseGcodeText(await headTail(blob));
    else if (ext === '3mf') r = await parseThreeMFBlob(blob);
    else if (ext === 'svg') r = blob.size > 20e6 ? { meta: { skipped: 'too large to inspect' } } : parseSvgText(await blob.text());
    else if (ext === 'lbrn' || ext === 'lbrn2') r = blob.size > 50e6 ? { meta: { skipped: 'too large to inspect' } } : parseLightBurnText(await blob.text());
    else if (ext === 'stl') r = blob.size > 150e6 ? { meta: { skipped: 'too large to inspect' } } : parseStlBuffer(new Uint8Array(await blob.arrayBuffer()));
    if (r) Object.assign(out, { meta: r.meta || {}, recipe: r.recipe || {}, thumbnail: r.thumbnail });
  } catch (err) {
    out.meta = { parse_error: String(err.message || err) };
  }
  return out;
}

// ------------------------------------------------------------------ projects & files
let askedPersist = false;
async function addFile(projectId, blob, rawName, { auto = false } = {}) {
  const project = await getOne('projects', projectId);
  if (!project) throw bad('Project not found');
  const name = safeName(rawName);
  const hash = await sha256(blob, name);
  const files = await byProject('files', projectId);
  const dupe = files.find((f) => f.sha256 === hash && !!f.auto === auto);
  if (dupe) return { file: dupe, duplicate: true };

  const parsed = await parseBlob(blob, name);
  const packed = await packForStorage(blob, name, parsed.kind);
  const rec = { project_id: projectId, name, kind: parsed.kind, size: blob.size, stored_size: packed.stored_size, encoding: packed.encoding, sha256: hash, meta: parsed.meta, auto: auto ? 1 : 0, created_at: now(), blob: packed.blob };
  rec.id = await putRec('files', rec);

  const recipe = { ...project.recipe };
  for (const [k, v] of Object.entries(parsed.recipe)) if (!(k in recipe)) recipe[k] = v;
  const guess = guessMachine(name);
  await putRec('projects', { ...project, recipe, machine_type: project.machine_type === 'unknown' && guess ? guess : project.machine_type, updated_at: now() });

  if (parsed.thumbnail) {
    const img = new Blob([parsed.thumbnail], { type: 'image/png' });
    await putRec('files', { project_id: projectId, name: `${projectStem(name)}-preview.png`, kind: 'photo', size: img.size, stored_size: img.size, encoding: null, sha256: await sha256(img, 'preview'), meta: {}, auto: 1, created_at: now(), blob: img });
  }
  if (!askedPersist) { askedPersist = true; navigator.storage?.persist?.().catch(() => {}); }
  return { file: rec, duplicate: false };
}

async function createProject(b) {
  const name = String(b.name || '').trim();
  if (!name) throw bad('name is required');
  const machine_type = b.machine_type || 'unknown';
  if (!MACHINES.includes(machine_type)) throw bad(`machine_type must be one of ${MACHINES.join(', ')}`);
  const t = now();
  return putRec('projects', {
    name: name.slice(0, 200), machine_type, notes: String(b.notes || ''), source_url: String(b.source_url || ''), license: String(b.license || ''),
    recipe: {}, custom: {}, tags: cleanTags(b.tags), import_key: b.import_key || null, created_at: t, updated_at: t,
  });
}

async function removeProject(id) {
  for (const f of await byProject('files', id)) { forgetUrl(f.id); await delRec('files', f.id); }
  for (const r of await byProject('runs', id)) await delRec('runs', r.id);
  await delRec('projects', id);
}

async function listProjects(query) {
  const [projects, files, runs] = await Promise.all([getAll('projects'), getAll('files'), getAll('runs')]);
  const needle = query.q?.trim().toLowerCase();
  const out = [];
  for (const p of projects) {
    if (query.machine && p.machine_type !== query.machine) continue;
    if (query.tag && !p.tags.includes(query.tag)) continue;
    const pf = files.filter((f) => f.project_id === p.id).sort(orderFiles);
    if (needle) {
      const hay = [p.name, p.notes, p.source_url, JSON.stringify(p.recipe), JSON.stringify(p.custom), ...p.tags, ...pf.map((f) => f.name)].join('\n').toLowerCase();
      if (!hay.includes(needle)) continue;
    }
    const cover = pf.find((f) => f.kind === 'photo');
    out.push({
      ...p, cover_file_id: cover?.id ?? null, cover_url: cover ? urlFor(cover) : null,
      file_count: pf.filter((f) => !f.auto).length, run_count: runs.filter((r) => r.project_id === p.id).length,
    });
  }
  return out.sort((a, b) => b.updated_at - a.updated_at || b.id - a.id);
}

// ------------------------------------------------------------------ zip / download
async function crcOf(data) {
  if (data instanceof Uint8Array) return crc32Update(0, data);
  let crc = 0;
  const reader = data.stream().getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; crc = crc32Update(crc, value); }
  return crc;
}

// Streams each file through the CRC and references (never copies) the stored blobs.
async function buildZipBlob(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const size = data instanceof Uint8Array ? data.length : data.size;
    const h = zipEntryHeaders(name, await crcOf(data), size, offset);
    parts.push(h.local, data);
    central.push(h.central);
    offset += h.local.length + size;
    if (offset > 0xffffffff) throw bad('This is too large for a single zip (4 GB limit). Export projects one at a time.');
  }
  parts.push(...central, zipEndRecord(entries.length, central.reduce((n, c) => n + c.length, 0), offset));
  return new Blob(parts, { type: 'application/zip' });
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const text = (s) => new TextEncoder().encode(s);
const iso = (t) => new Date(t).toISOString();

export async function downloadFile(file) {
  const rec = await getOne('files', file.id);
  if (!rec) throw bad('File not found');
  saveBlob(await originalBlob(rec), rec.name);
}

export async function exportProject(id) {
  const p = await getOne('projects', id);
  if (!p) throw bad('Project not found');
  const files = (await byProject('files', id)).sort(orderFiles);
  const runs = (await byProject('runs', id)).sort((a, b) => b.created_at - a.created_at);
  const used = new Set();
  const entries = [];
  for (const f of files) {
    let n = f.name, i = 1;
    while (used.has(n)) n = `${i++}-${f.name}`;
    used.add(n);
    entries.push({ name: `files/${n}`, data: await originalBlob(f) });
  }
  const manifest = {
    exported_by: 'Jigbook', exported_at: new Date().toISOString(),
    project: { name: p.name, machine_type: p.machine_type, notes: p.notes, source_url: p.source_url, license: p.license, tags: p.tags },
    recipe: p.recipe, custom: p.custom,
    files: files.map((f) => ({ name: f.name, kind: f.kind, sha256: f.sha256, meta: f.meta })),
    runs: runs.map((r) => ({ date: iso(r.created_at), machine: r.machine, outcome: r.outcome, settings: r.settings, notes: r.notes })),
  };
  const readme = [
    `# ${p.name}`, '', p.notes || '', '',
    p.source_url ? `Source: ${p.source_url}` : '', p.license ? `License: ${p.license}` : '', '',
    '## Recipe', '', ...Object.entries(p.recipe).map(([k, v]) => `- **${k}**: ${v}`), '',
    '## Run history', '', ...runs.map((r) => `- ${iso(r.created_at).slice(0, 10)} — ${r.outcome}${r.notes ? ': ' + r.notes : ''}`),
    '', '_Exported from Jigbook._', '',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
  entries.push({ name: 'recipe.json', data: text(JSON.stringify(manifest, null, 2)) }, { name: 'README.md', data: text(readme) });
  saveBlob(await buildZipBlob(entries), `${safeName(p.name)}.vault.zip`);
}

// ------------------------------------------------------------------ backup / restore
export async function backup() {
  const [projects, files, materials, runs, fields] = await Promise.all(STORES.map(getAll));
  const entries = [];
  const meta = files.map((f) => {
    const { blob, ...rest } = f;
    const zipPath = `files/${f.id}-${f.name}${f.encoding ? '.deflate' : ''}`;
    entries.push({ name: zipPath, data: blob });
    return { ...rest, zipPath };
  });
  const vault = { app: 'jigbook', version: 1, exported_at: new Date().toISOString(), projects, files: meta, materials, runs, fields };
  entries.unshift({ name: 'vault.json', data: text(JSON.stringify(vault)) });
  saveBlob(await buildZipBlob(entries), `jigbook-backup-${new Date().toISOString().slice(0, 10)}.zip`);
}

export async function restore(zipBlob) {
  let entries;
  try { entries = await listZipBlob(zipBlob); } catch { throw bad('That file is not a Jigbook backup (not a zip file).'); }
  const jsonEntry = entries.find((e) => e.name === 'vault.json');
  if (!jsonEntry) throw bad('That zip is not a Jigbook backup (vault.json is missing).');
  let vault;
  try { vault = JSON.parse(utf8.decode(await readZipEntryBlob(zipBlob, jsonEntry))); } catch { throw bad('The backup’s vault.json is damaged.'); }
  if (!['jigbook', 'maker-vault'].includes(vault.app) || vault.version !== 1) throw bad('This backup was made by an incompatible version.');
  const byName = new Map(entries.map((e) => [e.name, e]));
  // Verify everything is present before touching current data.
  const missing = vault.files.filter((f) => !byName.has(f.zipPath));
  if (missing.length) throw bad(`The backup is incomplete: ${missing.length} file${missing.length === 1 ? ' is' : 's are'} missing from the zip. Nothing was changed.`);

  for (const f of (await getAll('files'))) forgetUrl(f.id);
  for (const s of STORES) await clearStore(s);
  for (const r of vault.projects) await putRec('projects', r);
  for (const s of ['materials', 'runs', 'fields']) for (const r of vault[s] || []) await putRec(s, s === 'materials' ? priceInGrams(r) : r);
  for (const { zipPath, ...rec } of vault.files) {
    const bytes = await readZipEntryBlob(zipBlob, byName.get(zipPath));
    await putRec('files', { ...rec, blob: new Blob([bytes], { type: rec.kind === 'photo' ? 'image/png' : 'application/octet-stream' }) });
  }
  return { projects: vault.projects.length, files: vault.files.length };
}

export async function storageInfo() {
  const est = (await navigator.storage?.estimate?.()) || {};
  return { used: est.usage || 0, quota: est.quota || 0, persistent: (await navigator.storage?.persisted?.()) || false };
}

// ------------------------------------------------------------------ the API the UI calls
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn });

route('GET', '/api/config', async () => ({ brand: window.JIGBOOK_CONFIG?.brand || null, machines: MACHINES, version: '0.1.0', local: true }));
route('GET', '/api/projects', ({ query }) => listProjects(query));
route('POST', '/api/projects', async ({ body }) => ({ id: await createProject(body || {}) }));
route('GET', '/api/projects/:id', async ({ params }) => {
  const p = await getOne('projects', params.id);
  if (!p) throw bad('Project not found');
  const files = (await byProject('files', p.id)).sort(orderFiles).map(shapeFile);
  const runs = (await byProject('runs', p.id)).sort((a, b) => b.created_at - a.created_at || b.id - a.id);
  return { ...p, files, runs };
});
route('PATCH', '/api/projects/:id', async ({ params, body: b }) => {
  const p = await getOne('projects', params.id);
  if (!p) throw bad('Project not found');
  const next = {
    ...p,
    name: b.name !== undefined ? String(b.name).trim() : p.name,
    machine_type: b.machine_type ?? p.machine_type,
    notes: b.notes !== undefined ? String(b.notes) : p.notes,
    source_url: b.source_url !== undefined ? String(b.source_url) : p.source_url,
    license: b.license !== undefined ? String(b.license) : p.license,
    recipe: b.recipe !== undefined ? flatStrings(b.recipe, 'recipe') : p.recipe,
    custom: b.custom !== undefined ? flatStrings(b.custom, 'custom') : p.custom,
    updated_at: now(),
  };
  if (!next.name) throw bad('name is required');
  if (!MACHINES.includes(next.machine_type)) throw bad('invalid machine_type');
  if (b.tags !== undefined) { if (!Array.isArray(b.tags)) throw bad('tags must be an array'); next.tags = cleanTags(b.tags); }
  next.name = next.name.slice(0, 200);
  await putRec('projects', next);
  return next;
});
route('DELETE', '/api/projects/:id', async ({ params }) => { await removeProject(params.id); return { ok: true }; });

route('POST', '/api/projects/:id/files', async ({ params, query, body }) => {
  if (!(body instanceof Blob)) throw bad('Empty upload');
  const r = await addFile(Number(params.id), body, query.name);
  return { file: shapeFile(r.file), duplicate: r.duplicate };
});
route('POST', '/api/upload', async ({ query, body }) => {
  if (!(body instanceof Blob) || !body.size) throw bad('Empty upload');
  const stem = projectStem(safeName(query.name));
  const key = `upload:${stem.toLowerCase()}`;
  const existing = (await getAll('projects')).find((p) => p.import_key === key);
  const id = existing ? existing.id : await createProject({ name: stem, import_key: key });
  const r = await addFile(id, body, query.name);
  return { project_id: id, file: shapeFile(r.file), duplicate: r.duplicate };
});
route('DELETE', '/api/files/:id', async ({ params }) => {
  const f = await getOne('files', params.id);
  if (!f) throw bad('File not found');
  forgetUrl(f.id);
  await delRec('files', f.id);
  const p = await getOne('projects', f.project_id);
  if (p) await putRec('projects', { ...p, updated_at: now() });
  return { ok: true };
});

// Materials
// Everything about a material is measured in grams: what is left (g) and what it costs (price per gram).
// Empty clears the value; anything else must be a number of zero or more.
const amount = (v, label) => {
  if (v === '' || v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw bad(`${label} must be a number of zero or more`);
  return n;
};
const materialFields = (b, cur = {}) => ({
  name: String(b.name ?? cur.name ?? '').trim(), type: String(b.type ?? cur.type ?? ''), brand: String(b.brand ?? cur.brand ?? ''),
  color: String(b.color ?? cur.color ?? ''), notes: String(b.notes ?? cur.notes ?? ''),
  remaining_g: b.remaining_g === undefined ? (cur.remaining_g ?? null) : amount(b.remaining_g, 'remaining_g'),
  cost_per_g: b.cost_per_g === undefined ? (cur.cost_per_g ?? null) : amount(b.cost_per_g, 'cost_per_g'),
});

// Older versions priced materials per kilogram. Convert (price per kg / 1000 = price per gram) so nothing is
// lost or misread: applied to the saved library on first use, and to materials inside an old backup on restore.
const round6 = (n) => Math.round(n * 1e6) / 1e6;
function priceInGrams(rec) {
  if (!('cost_per_kg' in rec)) return rec;
  const { cost_per_kg: perKg, ...rest } = rec;
  if (rest.cost_per_g === undefined || rest.cost_per_g === null) rest.cost_per_g = perKg == null || perKg === '' ? null : round6(Number(perKg) / 1000);
  return rest;
}
let materialsMigrated;
function migrateMaterialPricing() {
  materialsMigrated ??= (async () => {
    for (const m of await getAll('materials')) if ('cost_per_kg' in m) await putRec('materials', priceInGrams(m));
  })();
  return materialsMigrated;
}
route('GET', '/api/materials', async () => (await getAll('materials')).sort((a, b) => a.name.localeCompare(b.name)));
route('POST', '/api/materials', async ({ body }) => {
  const m = materialFields(body || {});
  if (!m.name) throw bad('name is required');
  return { id: await putRec('materials', { ...m, created_at: now() }) };
});
route('PATCH', '/api/materials/:id', async ({ params, body }) => {
  const cur = await getOne('materials', params.id);
  if (!cur) throw bad('Material not found');
  const m = materialFields(body || {}, cur);
  if (!m.name) throw bad('name is required');
  const next = { ...cur, ...m };
  await putRec('materials', next);
  return next;
});
route('DELETE', '/api/materials/:id', async ({ params }) => {
  await delRec('materials', params.id);
  for (const r of await getAll('runs')) if (r.material_id === Number(params.id)) await putRec('runs', { ...r, material_id: null });
  return { ok: true };
});

// Runs
route('POST', '/api/projects/:id/runs', async ({ params, body: b }) => {
  const p = await getOne('projects', params.id);
  if (!p) throw bad('Project not found');
  const outcome = b.outcome || 'pass';
  if (!OUTCOMES.includes(outcome)) throw bad(`outcome must be one of ${OUTCOMES.join(', ')}`);
  const grams = b.grams_used === '' || b.grams_used == null ? null : Number(b.grams_used);
  if (grams !== null && (!Number.isFinite(grams) || grams < 0)) throw bad('grams_used must be a positive number');
  const materialId = b.material_id ? Number(b.material_id) : null;
  const material = materialId ? await getOne('materials', materialId) : null;
  if (materialId && !material) throw bad('unknown material');
  const id = await putRec('runs', {
    project_id: p.id, machine: String(b.machine || ''), material_id: materialId, outcome,
    settings: flatStrings(b.settings ?? p.recipe, 'settings'), grams_used: grams, notes: String(b.notes || ''), created_at: now(),
  });
  if (material && grams && material.remaining_g != null) await putRec('materials', { ...material, remaining_g: Math.max(0, material.remaining_g - grams) });
  await putRec('projects', { ...p, updated_at: now() });
  return { id };
});
route('DELETE', '/api/runs/:id', async ({ params }) => {
  const r = await getOne('runs', params.id);
  if (!r) throw bad('Run not found');
  await delRec('runs', r.id);
  const m = r.material_id ? await getOne('materials', r.material_id) : null;
  if (m && r.grams_used && m.remaining_g != null) await putRec('materials', { ...m, remaining_g: m.remaining_g + r.grams_used });
  return { ok: true };
});
route('GET', '/api/runs/diff', async ({ query }) => {
  const [a, b] = await Promise.all([getOne('runs', query.a), getOne('runs', query.b)]);
  if (!a || !b) throw bad('Run not found');
  return diffSettings(a.settings, b.settings);
});

// Custom fields
route('GET', '/api/fields', async () => getAll('fields'));
route('POST', '/api/fields', async ({ body: b }) => {
  const label = String(b.label || '').trim();
  if (!label) throw bad('label is required');
  const type = b.type || 'text';
  if (!FIELD_TYPES.includes(type)) throw bad(`type must be one of ${FIELD_TYPES.join(', ')}`);
  const key = String(b.key || label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (!key) throw bad('invalid key');
  const machine = b.machine_type || null;
  if (machine && !MACHINES.includes(machine)) throw bad('invalid machine_type');
  const options = Array.isArray(b.options) ? b.options.map(String).filter(Boolean) : [];
  if (type === 'select' && !options.length) throw bad('select fields need options');
  if ((await getAll('fields')).some((f) => f.key === key)) throw bad(`A field with key "${key}" already exists`);
  return { id: await putRec('fields', { key, label, type, options, machine_type: machine }), key };
});
route('DELETE', '/api/fields/:id', async ({ params }) => { await delRec('fields', params.id); return { ok: true }; });
// How much smaller the vault is than the original files. Preview images we generate are counted
// against the vault (as stored bytes) but not as "original" data, so the figure is not flattered.
route('GET', '/api/stats', async () => {
  let original = 0, stored = 0, files = 0;
  for (const f of await getAll('files')) {
    stored += f.stored_size ?? f.size;
    if (!f.auto) { original += f.size; files++; }
  }
  return { files, original_bytes: original, stored_bytes: stored, saved_bytes: Math.max(0, original - stored) };
});
route('GET', '/api/tags', async () => {
  const counts = new Map();
  for (const p of await getAll('projects')) for (const t of p.tags) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts].map(([tag, n]) => ({ tag, n })).sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag));
});

export async function api(method, url, body) {
  await migrateMaterialPricing();
  const u = new URL(url, 'http://vault.local');
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(u.pathname);
    if (m) return r.fn({ params: m.groups || {}, query: Object.fromEntries(u.searchParams), body });
  }
  throw bad('Not available in the browser edition');
}
