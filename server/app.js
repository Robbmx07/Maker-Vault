import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { parseFile, projectStem, guessMachine } from './parsers/index.js';
import { diffSettings } from './diff.js';
import { buildZip } from './zip.js';
import { readAsset } from './assets.js';

const MACHINES = ['3d', 'laser', 'cutter', 'other', 'unknown'];
const OUTCOMES = ['pass', 'partial', 'fail'];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.pdf': 'application/pdf',
};
const INLINE_OK = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.pdf']);
const MAX_UPLOAD = 2 * 1024 ** 3;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);
const notFound = (what = 'Not found') => new HttpError(404, what);

const safeName = (n) => path.basename(String(n || 'file')).replace(/[^\w.\- ()+]/g, '_').slice(0, 180) || 'file';
const json = (s) => { try { return JSON.parse(s); } catch { return {}; } };
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);
const now = () => Date.now();

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

export function createApp(db, { dataDir, config = {}, allowRemote = false }) {
  const filesDir = path.join(dataDir, 'files');
  const tmpDir = path.join(dataDir, 'tmp');
  fs.mkdirSync(filesDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const q = {
    project: db.prepare('SELECT * FROM projects WHERE id = ?'),
    projectByKey: db.prepare('SELECT * FROM projects WHERE import_key = ?'),
    tags: db.prepare('SELECT tag FROM project_tags WHERE project_id = ? ORDER BY tag'),
    files: db.prepare('SELECT * FROM files WHERE project_id = ? ORDER BY auto, created_at, id'),
    file: db.prepare('SELECT * FROM files WHERE id = ?'),
    runs: db.prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC, id DESC'),
    run: db.prepare('SELECT * FROM runs WHERE id = ?'),
    material: db.prepare('SELECT * FROM materials WHERE id = ?'),
    cover: db.prepare("SELECT id FROM files WHERE project_id = ? AND kind = 'photo' ORDER BY auto, created_at LIMIT 1"),
    fileCount: db.prepare('SELECT COUNT(*) AS n FROM files WHERE project_id = ? AND auto = 0'),
    touch: db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?'),
  };

  const tx = (fn) => {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  const shapeProject = (p) => ({
    ...p, recipe: json(p.recipe), custom: json(p.custom), tags: q.tags.all(p.id).map((t) => t.tag),
  });
  const shapeFile = (f) => ({ ...f, meta: json(f.meta), path: undefined, url: `/api/files/${f.id}/raw` });
  const shapeRun = (r) => ({ ...r, settings: json(r.settings) });

  const getProject = (id) => {
    const p = q.project.get(Number(id));
    if (!p) throw notFound('Project not found');
    return p;
  };

  function setTags(projectId, tags) {
    const clean = [...new Set((tags || []).map((t) => String(t).trim().toLowerCase().slice(0, 40)).filter(Boolean))];
    db.prepare('DELETE FROM project_tags WHERE project_id = ?').run(projectId);
    const ins = db.prepare('INSERT INTO project_tags (project_id, tag) VALUES (?, ?)');
    for (const t of clean) ins.run(projectId, t);
  }

  function createProject({ name, machine_type = 'unknown', notes = '', source_url = '', license = '', tags = [], import_key = null }) {
    name = String(name || '').trim();
    if (!name) throw bad('name is required');
    if (!MACHINES.includes(machine_type)) throw bad(`machine_type must be one of ${MACHINES.join(', ')}`);
    const t = now();
    const r = db.prepare(`INSERT INTO projects (name, machine_type, notes, source_url, license, import_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(name.slice(0, 200), machine_type, String(notes), String(source_url), String(license), import_key, t, t);
    const id = Number(r.lastInsertRowid);
    setTags(id, tags);
    return id;
  }

  // Copy/move a file into the vault, parse it, and merge what it teaches us into the project.
  function addFile(projectId, srcPath, name, { move = false, auto = false } = {}) {
    const project = getProject(projectId);
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(srcPath, 'r');
    try {
      const chunk = Buffer.alloc(1 << 20);
      for (let n; (n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0; ) hash.update(chunk.subarray(0, n));
    } finally { fs.closeSync(fd); }
    const sha256 = hash.digest('hex');
    const dupe = db.prepare('SELECT * FROM files WHERE project_id = ? AND sha256 = ? AND auto = ?').get(projectId, sha256, auto ? 1 : 0);
    if (dupe) {
      if (move) fs.rmSync(srcPath, { force: true });
      return { file: dupe, duplicate: true };
    }
    const dir = path.join(filesDir, String(projectId));
    fs.mkdirSync(dir, { recursive: true });
    const stored = path.join(dir, `${crypto.randomUUID().slice(0, 8)}-${safeName(name)}`);
    if (move) fs.renameSync(srcPath, stored); else fs.copyFileSync(srcPath, stored);

    const parsed = parseFile(stored, name);
    const size = fs.statSync(stored).size;
    const info = db.prepare(`INSERT INTO files (project_id, name, kind, size, sha256, path, meta, auto, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(projectId, safeName(name), parsed.kind, size, sha256, stored, JSON.stringify(parsed.meta), auto ? 1 : 0, now());
    const fileId = Number(info.lastInsertRowid);

    // Recipe: fill only what the user has not already set.
    const recipe = json(project.recipe);
    let changed = false;
    for (const [k, v] of Object.entries(parsed.recipe)) {
      if (!(k in recipe)) { recipe[k] = v; changed = true; }
    }
    const guess = guessMachine(name);
    const machine = project.machine_type === 'unknown' && guess ? guess : project.machine_type;
    db.prepare('UPDATE projects SET recipe = ?, machine_type = ?, updated_at = ? WHERE id = ?')
      .run(changed ? JSON.stringify(recipe) : project.recipe, machine, now(), projectId);

    if (parsed.thumbnail) {
      const tPath = path.join(dir, `${crypto.randomUUID().slice(0, 8)}-preview.png`);
      fs.writeFileSync(tPath, parsed.thumbnail);
      db.prepare(`INSERT INTO files (project_id, name, kind, size, sha256, path, meta, auto, created_at)
        VALUES (?, ?, 'photo', ?, ?, ?, '{}', 1, ?)`)
        .run(projectId, `${projectStem(name)}-preview.png`, parsed.thumbnail.length, crypto.createHash('sha256').update(parsed.thumbnail).digest('hex'), tPath, now());
    }
    return { file: q.file.get(fileId), duplicate: false };
  }

  function findOrCreateByStem(stem, key) {
    const existing = q.projectByKey.get(key);
    if (existing) return existing.id;
    return createProject({ name: stem, import_key: key });
  }

  // Import a local folder: one project per (folder, stem) group. Re-running is idempotent.
  function importDir(dir) {
    if (!dir || typeof dir !== 'string') throw bad('dir is required');
    const root = path.resolve(dir);
    let st;
    try { st = fs.statSync(root); } catch { throw bad(`Folder not found: ${root}`); }
    if (!st.isDirectory()) throw bad(`Not a folder: ${root}`);
    const groups = new Map();
    let seen = 0;
    const walk = (d, depth) => {
      if (depth > 6 || seen > 20000) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (e.isFile()) {
          seen++;
          const key = `dir:${d}::${projectStem(e.name).toLowerCase()}`;
          if (!groups.has(key)) groups.set(key, { stem: projectStem(e.name), files: [] });
          groups.get(key).files.push({ full, name: e.name });
        }
      }
    };
    walk(root, 0);
    const result = { projects_created: 0, projects_updated: 0, files_added: 0, duplicates: 0, skipped: 0 };
    for (const [key, g] of groups) {
      const real = g.files.filter((f) => f.name !== '.DS_Store' && !/^thumbs\.db$/i.test(f.name));
      if (!real.length) { result.skipped++; continue; }
      const wasNew = !q.projectByKey.get(key);
      tx(() => {
        const id = findOrCreateByStem(g.stem, key);
        let added = 0;
        for (const f of real) {
          const r = addFile(id, f.full, f.name);
          if (r.duplicate) result.duplicates++; else { result.files_added++; added++; }
        }
        if (wasNew) result.projects_created++; else if (added) result.projects_updated++;
      });
    }
    return result;
  }

  async function receiveUpload(req, name) {
    const tmp = path.join(tmpDir, crypto.randomUUID());
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_UPLOAD) req.destroy(new HttpError(413, 'File too large')); });
    try {
      await pipeline(req, fs.createWriteStream(tmp));
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e instanceof HttpError ? e : bad('Upload failed');
    }
    if (size === 0) { fs.rmSync(tmp, { force: true }); throw bad('Empty upload'); }
    return tmp;
  }

  const listProjects = (query) => {
    const like = query.q ? `%${likeEscape(query.q.trim())}%` : null;
    const rows = db.prepare(`
      SELECT p.* FROM projects p WHERE 1 = 1
        AND (:machine IS NULL OR p.machine_type = :machine)
        AND (:like IS NULL OR p.name LIKE :like ESCAPE '\\' OR p.notes LIKE :like ESCAPE '\\'
             OR p.recipe LIKE :like ESCAPE '\\' OR p.custom LIKE :like ESCAPE '\\' OR p.source_url LIKE :like ESCAPE '\\'
             OR EXISTS (SELECT 1 FROM files f WHERE f.project_id = p.id AND f.name LIKE :like ESCAPE '\\')
             OR EXISTS (SELECT 1 FROM project_tags t WHERE t.project_id = p.id AND t.tag LIKE :like ESCAPE '\\'))
        AND (:tag IS NULL OR EXISTS (SELECT 1 FROM project_tags t WHERE t.project_id = p.id AND t.tag = :tag))
      ORDER BY p.updated_at DESC, p.id DESC`).all({ machine: query.machine || null, like, tag: query.tag || null });
    return rows.map((p) => {
      const cover = q.cover.get(p.id);
      return {
        ...shapeProject(p),
        cover_file_id: cover?.id ?? null,
        cover_url: cover ? `/api/files/${cover.id}/raw` : null,
        file_count: q.fileCount.get(p.id).n,
        run_count: db.prepare('SELECT COUNT(*) AS n FROM runs WHERE project_id = ?').get(p.id).n,
      };
    });
  };

  function exportProject(id) {
    const p = shapeProject(getProject(id));
    const files = q.files.all(p.id);
    const runs = q.runs.all(p.id).map(shapeRun);
    const entries = [];
    const used = new Set();
    for (const f of files) {
      let n = f.name, i = 1;
      while (used.has(n)) n = `${i++}-${f.name}`;
      used.add(n);
      entries.push({ name: `files/${n}`, data: fs.readFileSync(f.path) });
    }
    const manifest = {
      exported_by: 'Jigbook', exported_at: new Date().toISOString(),
      project: { name: p.name, machine_type: p.machine_type, notes: p.notes, source_url: p.source_url, license: p.license, tags: p.tags },
      recipe: p.recipe, custom: p.custom,
      files: files.map((f) => ({ name: f.name, kind: f.kind, sha256: f.sha256, meta: json(f.meta) })),
      runs: runs.map((r) => ({ date: new Date(r.created_at).toISOString(), machine: r.machine, outcome: r.outcome, settings: r.settings, notes: r.notes })),
    };
    const readme = [
      `# ${p.name}`, '', p.notes || '', '',
      p.source_url ? `Source: ${p.source_url}` : '', p.license ? `License: ${p.license}` : '', '',
      '## Recipe', '', ...Object.entries(p.recipe).map(([k, v]) => `- **${k}**: ${v}`), '',
      '## Run history', '', ...runs.map((r) => `- ${new Date(r.created_at).toISOString().slice(0, 10)} — ${r.outcome}${r.notes ? ': ' + r.notes : ''}`),
      '', '_Exported from Jigbook._', '',
    ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
    entries.push({ name: 'recipe.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) });
    entries.push({ name: 'README.md', data: Buffer.from(readme) });
    return { name: safeName(p.name), zip: buildZip(entries) };
  }

  // --- routes -------------------------------------------------------------
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });

  route('GET', '/api/config', () => ({ brand: config.brand || null, machines: MACHINES, version: '0.1.0' }));

  route('GET', '/api/projects', ({ query }) => listProjects(query));
  route('POST', '/api/projects', async ({ body }) => {
    const b = await body();
    const id = createProject(b);
    return { id };
  });
  route('GET', '/api/projects/:id', ({ params }) => {
    const p = shapeProject(getProject(params.id));
    return { ...p, files: q.files.all(p.id).map(shapeFile), runs: q.runs.all(p.id).map(shapeRun) };
  });
  route('PATCH', '/api/projects/:id', async ({ params, body }) => {
    const p = getProject(params.id);
    const b = await body();
    const next = {
      name: b.name !== undefined ? String(b.name).trim() : p.name,
      machine_type: b.machine_type ?? p.machine_type,
      notes: b.notes !== undefined ? String(b.notes) : p.notes,
      source_url: b.source_url !== undefined ? String(b.source_url) : p.source_url,
      license: b.license !== undefined ? String(b.license) : p.license,
      recipe: b.recipe !== undefined ? JSON.stringify(flatStrings(b.recipe, 'recipe')) : p.recipe,
      custom: b.custom !== undefined ? JSON.stringify(flatStrings(b.custom, 'custom')) : p.custom,
    };
    if (!next.name) throw bad('name is required');
    if (!MACHINES.includes(next.machine_type)) throw bad('invalid machine_type');
    tx(() => {
      db.prepare('UPDATE projects SET name=?, machine_type=?, notes=?, source_url=?, license=?, recipe=?, custom=?, updated_at=? WHERE id=?')
        .run(next.name.slice(0, 200), next.machine_type, next.notes, next.source_url, next.license, next.recipe, next.custom, now(), p.id);
      if (b.tags !== undefined) {
        if (!Array.isArray(b.tags)) throw bad('tags must be an array');
        setTags(p.id, b.tags);
      }
    });
    return shapeProject(q.project.get(p.id));
  });
  route('DELETE', '/api/projects/:id', ({ params }) => {
    const p = getProject(params.id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
    fs.rmSync(path.join(filesDir, String(p.id)), { recursive: true, force: true });
    return { ok: true };
  });
  route('GET', '/api/projects/:id/export', ({ params }) => {
    const { name, zip } = exportProject(params.id);
    return { raw: zip, type: 'application/zip', filename: `${name}.vault.zip` };
  });

  route('POST', '/api/projects/:id/files', async ({ params, query, req }) => {
    getProject(params.id);
    const name = safeName(query.name);
    const tmp = await receiveUpload(req, name);
    const r = tx(() => addFile(Number(params.id), tmp, name, { move: true }));
    return { file: shapeFile(r.file), duplicate: r.duplicate };
  });
  route('POST', '/api/upload', async ({ query, req }) => {
    const name = safeName(query.name);
    const stem = projectStem(name);
    const tmp = await receiveUpload(req, name);
    const r = tx(() => {
      const id = findOrCreateByStem(stem, `upload:${stem.toLowerCase()}`);
      return { id, ...addFile(id, tmp, name, { move: true }) };
    });
    return { project_id: r.id, file: shapeFile(r.file), duplicate: r.duplicate };
  });
  route('POST', '/api/import', async ({ body }) => importDir((await body()).dir));

  route('GET', '/api/files/:id/raw', ({ params, query }) => {
    const f = q.file.get(Number(params.id));
    if (!f) throw notFound('File not found');
    const ext = path.extname(f.name).toLowerCase();
    const inline = INLINE_OK.has(ext) && query.download !== '1';
    return { stream: f.path, type: MIME[ext] || 'application/octet-stream', filename: inline ? null : f.name, size: f.size };
  });
  route('DELETE', '/api/files/:id', ({ params }) => {
    const f = q.file.get(Number(params.id));
    if (!f) throw notFound('File not found');
    db.prepare('DELETE FROM files WHERE id = ?').run(f.id);
    fs.rmSync(f.path, { force: true });
    q.touch.run(now(), f.project_id);
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
    name: String(b.name ?? cur.name ?? '').trim(),
    type: String(b.type ?? cur.type ?? ''),
    brand: String(b.brand ?? cur.brand ?? ''),
    color: String(b.color ?? cur.color ?? ''),
    remaining_g: b.remaining_g === undefined ? (cur.remaining_g ?? null) : amount(b.remaining_g, 'remaining_g'),
    cost_per_g: b.cost_per_g === undefined ? (cur.cost_per_g ?? null) : amount(b.cost_per_g, 'cost_per_g'),
    notes: String(b.notes ?? cur.notes ?? ''),
  });
  route('GET', '/api/materials', () => db.prepare('SELECT * FROM materials ORDER BY name').all());
  route('POST', '/api/materials', async ({ body }) => {
    const m = materialFields(await body());
    if (!m.name) throw bad('name is required');
    const r = db.prepare('INSERT INTO materials (name, type, brand, color, remaining_g, cost_per_g, notes, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(m.name, m.type, m.brand, m.color, m.remaining_g, m.cost_per_g, m.notes, now());
    return { id: Number(r.lastInsertRowid) };
  });
  route('PATCH', '/api/materials/:id', async ({ params, body }) => {
    const cur = q.material.get(Number(params.id));
    if (!cur) throw notFound('Material not found');
    const m = materialFields(await body(), cur);
    if (!m.name) throw bad('name is required');
    db.prepare('UPDATE materials SET name=?, type=?, brand=?, color=?, remaining_g=?, cost_per_g=?, notes=? WHERE id=?')
      .run(m.name, m.type, m.brand, m.color, m.remaining_g, m.cost_per_g, m.notes, cur.id);
    return q.material.get(cur.id);
  });
  route('DELETE', '/api/materials/:id', ({ params }) => {
    db.prepare('DELETE FROM materials WHERE id = ?').run(Number(params.id));
    return { ok: true };
  });

  // Runs (the results log)
  route('POST', '/api/projects/:id/runs', async ({ params, body }) => {
    const p = getProject(params.id);
    const b = await body();
    const outcome = b.outcome || 'pass';
    if (!OUTCOMES.includes(outcome)) throw bad(`outcome must be one of ${OUTCOMES.join(', ')}`);
    const grams = b.grams_used === '' || b.grams_used == null ? null : Number(b.grams_used);
    if (grams !== null && (!Number.isFinite(grams) || grams < 0)) throw bad('grams_used must be a positive number');
    const materialId = b.material_id ? Number(b.material_id) : null;
    if (materialId && !q.material.get(materialId)) throw bad('unknown material');
    const settings = flatStrings(b.settings ?? json(p.recipe), 'settings');
    const id = tx(() => {
      const r = db.prepare('INSERT INTO runs (project_id, machine, material_id, outcome, settings, grams_used, notes, created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(p.id, String(b.machine || ''), materialId, outcome, JSON.stringify(settings), grams, String(b.notes || ''), now());
      if (materialId && grams) db.prepare('UPDATE materials SET remaining_g = MAX(0, remaining_g - ?) WHERE id = ? AND remaining_g IS NOT NULL').run(grams, materialId);
      q.touch.run(now(), p.id);
      return Number(r.lastInsertRowid);
    });
    return { id };
  });
  route('DELETE', '/api/runs/:id', ({ params }) => {
    const r = q.run.get(Number(params.id));
    if (!r) throw notFound('Run not found');
    tx(() => {
      db.prepare('DELETE FROM runs WHERE id = ?').run(r.id);
      if (r.material_id && r.grams_used) db.prepare('UPDATE materials SET remaining_g = remaining_g + ? WHERE id = ? AND remaining_g IS NOT NULL').run(r.grams_used, r.material_id);
    });
    return { ok: true };
  });
  route('GET', '/api/runs/diff', ({ query }) => {
    const a = q.run.get(Number(query.a)), b = q.run.get(Number(query.b));
    if (!a || !b) throw notFound('Run not found');
    return diffSettings(json(a.settings), json(b.settings));
  });

  // Custom fields
  const FIELD_TYPES = ['text', 'number', 'select', 'checkbox'];
  const shapeField = (f) => ({ ...f, options: JSON.parse(f.options) });
  route('GET', '/api/fields', () => db.prepare('SELECT * FROM field_defs ORDER BY id').all().map(shapeField));
  route('POST', '/api/fields', async ({ body }) => {
    const b = await body();
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
    try {
      const r = db.prepare('INSERT INTO field_defs (key, label, type, options, machine_type) VALUES (?,?,?,?,?)').run(key, label, type, JSON.stringify(options), machine);
      return { id: Number(r.lastInsertRowid), key };
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new HttpError(409, `A field with key "${key}" already exists`);
      throw e;
    }
  });
  route('DELETE', '/api/fields/:id', ({ params }) => {
    db.prepare('DELETE FROM field_defs WHERE id = ?').run(Number(params.id));
    return { ok: true };
  });
  route('GET', '/api/tags', () => db.prepare('SELECT tag, COUNT(*) AS n FROM project_tags GROUP BY tag ORDER BY n DESC, tag').all());

  // --- http plumbing ------------------------------------------------------
  const hostOk = (h) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(h || '');

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      // The vault is a local app: refuse DNS-rebinding and cross-site writes.
      if (!allowRemote) {
        if (!hostOk(req.headers.host)) throw new HttpError(403, 'Forbidden host');
        const origin = req.headers.origin;
        if (origin && req.method !== 'GET' && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin request blocked');
      }
      if (url.pathname.startsWith('/api/')) {
        const query = Object.fromEntries(url.searchParams);
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.re.exec(url.pathname);
          if (!m) continue;
          const body = async () => {
            const chunks = [];
            let n = 0;
            for await (const c of req) { n += c.length; if (n > 5e6) throw new HttpError(413, 'Body too large'); chunks.push(c); }
            if (!n) return {};
            try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw bad('Invalid JSON'); }
          };
          const out = await r.handler({ req, res, params: m.groups || {}, query, body });
          if (out && out.raw) {
            res.writeHead(200, { 'Content-Type': out.type, 'Content-Length': out.raw.length, 'Content-Disposition': `attachment; filename="${out.filename}"` });
            return res.end(out.raw);
          }
          if (out && out.stream) {
            const headers = { 'Content-Type': out.type, 'Content-Length': out.size, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:" };
            if (out.filename) headers['Content-Disposition'] = `attachment; filename="${out.filename.replace(/"/g, '')}"`;
            res.writeHead(200, headers);
            return fs.createReadStream(out.stream).pipe(res);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify(out ?? { ok: true }));
        }
        throw notFound('No such endpoint');
      }
      // static files (from disk in development, embedded in the standalone build)
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/') rel = '/index.html';
      const data = readAsset(rel);
      if (!data) throw notFound();
      res.writeHead(200, { 'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
      return res.end(data);
    } catch (e) {
      if (res.headersSent) return res.destroy();
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: status === 500 ? 'Internal error' : e.message }));
    }
  }

  return http.createServer(handle);
}
