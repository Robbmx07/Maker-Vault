// CubbyBench UI. Vanilla JS, no build step. All text goes through textContent
// (never innerHTML) so file names and notes can never inject markup.

import * as backend from './backend.js';
import { canView, loadMesh } from './mesh.js';
import { createViewer } from './viewer.js';
import { getUnit, setUnit, showWeight, weightToGrams, showPrice, priceToPerGram, weightLabel, priceLabel, convertWeight, G_PER_OZ } from './units.js';

const { api } = backend;
const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// replaceChildren stringifies null/false into text, so filter like h() does.
function put(el, ...kids) {
  el.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false)
    .map((k) => (k.nodeType ? k : document.createTextNode(String(k)))));
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `show${isErr ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, isErr ? 5000 : 2600);
}
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message, true); } };

const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const MACHINE_LABEL = { '3d': '3D printer', laser: 'Laser', cutter: 'Cutter', other: 'Other', unknown: 'Unsorted' };
const KIND_LABEL = { model: 'Model', slice: 'Sliced', design: 'Design', photo: 'Photo', video: 'Video', other: 'File' };
const KIND_ICON = { '3d': '🧊', laser: '🔥', cutter: '✂️', other: '🛠️', unknown: '📁' };
const OUTCOME_LABEL = { pass: 'Worked', partial: 'Partial', fail: 'Failed' };
const safeHttp = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };

const state = { config: {}, fields: [], materials: [], filters: { q: '', machine: '', tag: '' } };

// ---------------------------------------------------------------- uploads
async function uploadFiles(files, projectId) {
  let ok = 0, dupes = 0, lastProject = null;
  for (const f of files) {
    try {
      const url = projectId
        ? `/api/projects/${projectId}/files?name=${encodeURIComponent(f.name)}`
        : `/api/upload?name=${encodeURIComponent(f.name)}`;
      const r = await api('POST', url, f);
      if (r.duplicate) dupes++; else ok++;
      lastProject = r.project_id ?? projectId;
    } catch (e) { toast(`${f.name}: ${e.message}`, true); }
  }
  if (ok || dupes) toast(`Added ${ok} file${ok === 1 ? '' : 's'}${dupes ? `, ${dupes} already in the vault` : ''}`);
  return lastProject;
}

function dropZone(el, onFiles) {
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); el.classList.remove('over'); onFiles([...e.dataTransfer.files]); });
}

// Page-wide drop: files dropped anywhere are grouped into projects automatically.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; $('#dropveil').hidden = false; } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropveil').hidden = true; });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', guard(async (e) => {
  e.preventDefault(); dragDepth = 0; $('#dropveil').hidden = true;
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  const m = location.hash.match(/^#\/project\/(\d+)/);
  await uploadFiles(files, m ? Number(m[1]) : null);
  route();
}));

// ---------------------------------------------------------------- projects list
async function projectsView(app) {
  const { q, machine, tag } = state.filters;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (machine) params.set('machine', machine);
  if (tag) params.set('tag', tag);
  const [projects, tags, stats] = await Promise.all([api('GET', `/api/projects?${params}`), api('GET', '/api/tags'),
    backend.compression ? api('GET', '/api/stats').catch(() => null) : null]);
  const saved = savingsText(stats);

  const search = h('input', {
    type: 'search', placeholder: 'Search names, settings, notes, tags, files…', value: q, 'aria-label': 'Search projects',
    oninput: (e) => { clearTimeout(search._t); search._t = setTimeout(() => { state.filters.q = e.target.value; route(true); }, 250); },
  });
  const chip = (label, val) => h('button', { class: `chip${machine === val ? ' on' : ''}`, onclick: () => { state.filters.machine = val; route(); } }, label);
  const tagSel = h('select', { 'aria-label': 'Filter by tag', style: { width: 'auto' }, onchange: (e) => { state.filters.tag = e.target.value; route(); } },
    h('option', { value: '' }, 'All tags'), tags.map((t) => h('option', { value: t.tag, selected: t.tag === tag }, `${t.tag} (${t.n})`)));
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: guard(async (e) => { await uploadFiles([...e.target.files]); route(); }) });

  put(app, 
    h('div', { class: 'row', style: { marginBottom: '16px' } },
      h('div', {}, h('h1', {}, 'Projects'), h('p', { class: 'sub', style: { margin: 0 } }, 'Every file, setting and result for each thing you make.'),
        saved ? h('p', { class: 'saved', title: 'Files are stored compressed and come back byte-for-byte identical.' }, saved) : null),
      h('div', { class: 'spacer' }),
      h('button', { onclick: () => fileInput.click() }, 'Add files'),
      h('button', { onclick: importFolder }, 'Import folder…'),
      h('button', { class: 'primary', onclick: guard(newProject) }, 'New project'), fileInput),
    h('div', { class: 'row', style: { marginBottom: '16px' } },
      h('div', { style: { flex: '1 1 260px' } }, search),
      chip('All', ''), chip('3D printer', '3d'), chip('Laser', 'laser'), chip('Cutter', 'cutter'), chip('Other', 'other'), chip('Unsorted', 'unknown'),
      tags.length ? tagSel : null),
    projects.length ? h('div', { class: 'grid' }, projects.map(projectCard)) : emptyState(q || machine || tag));
  if (q) { search.focus(); search.setSelectionRange(q.length, q.length); }
}

// "Your vault is 2.1 GB smaller than the files you put in it" — only shown when it is true and meaningful.
function savingsText(stats) {
  if (!stats || stats.saved_bytes < 10 * 1024 || !stats.original_bytes) return null;
  const pct = Math.round((100 * stats.saved_bytes) / stats.original_bytes);
  if (pct < 1) return null;
  return `Stored compressed: your vault is ${fmtBytes(stats.saved_bytes)} smaller than the original files (${pct}% saved).`;
}

function emptyState(filtered) {
  if (filtered) return h('div', { class: 'empty' }, h('h2', {}, 'No matches'), h('p', {}, 'Try a different search or clear the filters.'),
    h('button', { onclick: () => { state.filters = { q: '', machine: '', tag: '' }; route(); } }, 'Clear filters'));
  return h('div', { class: 'empty' },
    h('h2', {}, 'Your vault is empty'),
    h('p', {}, 'Drag files anywhere on this page — STL, 3MF, G-code, SVG, LightBurn, photos.'),
    h('p', {}, 'Files that belong together (Bracket.stl, Bracket_0.2mm_PLA.gcode) are grouped into one project, and print or laser settings are read from the files for you.'),
    h('p', {}, h('button', { class: 'primary', onclick: importFolder }, 'Import an existing folder')));
}

const RECIPE_HIGHLIGHTS = ['filament_type', 'layer_height', 'nozzle_temp', 'design_size_mm', 'layer_0_power_pct', 'print_time'];
function projectCard(p) {
  const chips = RECIPE_HIGHLIGHTS.filter((k) => p.recipe[k]).slice(0, 3).map((k) => h('span', { class: 'chip', title: k.replace(/_/g, ' ') }, p.recipe[k]));
  return h('a', { class: 'card', href: `#/project/${p.id}` },
    h('div', { class: 'cover', style: p.cover_url ? { backgroundImage: `url(${p.cover_url})` } : {} }, p.cover_url ? '' : KIND_ICON[p.machine_type]),
    h('div', { class: 'body' },
      h('div', { class: 'title' }, p.name),
      h('div', { class: 'chips' }, h('span', { class: 'badge machine' }, MACHINE_LABEL[p.machine_type]), ...chips),
      h('div', { class: 'kv' }, `${p.file_count} file${p.file_count === 1 ? '' : 's'}${p.run_count ? ` · ${p.run_count} run${p.run_count === 1 ? '' : 's'}` : ''}`),
      p.tags.length ? h('div', { class: 'chips' }, p.tags.map((t) => h('span', { class: 'chip' }, `#${t}`))) : null));
}

async function newProject() {
  const name = prompt('Project name');
  if (!name?.trim()) return;
  const { id } = await api('POST', '/api/projects', { name });
  location.hash = `#/project/${id}`;
}

// A browser cannot hand us a folder path, so use the native picker and upload what it returns.
// Files are grouped into projects by name exactly like drag & drop.
function importFolder() {
  const input = h('input', { type: 'file', webkitdirectory: true, multiple: true, hidden: true });
  input.addEventListener('change', guard(async () => {
    input.remove();
    const files = [...input.files].filter((f) => !f.name.startsWith('.') && !/^thumbs\.db$/i.test(f.name));
    if (!files.length) { toast('That folder has no files to import'); return; }
    toast(`Importing ${files.length} files…`);
    await uploadFiles(files);
    route();
  }));
  document.body.append(input); // Safari ignores clicks on detached inputs
  input.click();
}

// ---------------------------------------------------------------- project detail
function fileSummary(f) {
  const m = f.meta || {};
  const bits = [];
  if (m.slicer) bits.push(m.slicer);
  if (m.size_mm) bits.push(`${m.size_mm.join(' × ')} mm`);
  if (m.triangles) bits.push(`${m.triangles.toLocaleString()} triangle${m.triangles === 1 ? '' : 's'}`);
  if (m.width_mm) bits.push(`${m.width_mm} × ${m.height_mm} mm`);
  if (m.paths) bits.push(`${m.paths} paths`);
  if (m.layers) bits.push(`${m.layers} layers`);
  if (m.designer) bits.push(`by ${m.designer}`);
  if (m.parse_error) bits.push('could not read settings');
  return bits.join(' · ');
}

async function projectView(app, id) {
  const [p, fields, materials] = await Promise.all([api('GET', `/api/projects/${id}`), api('GET', '/api/fields'), api('GET', '/api/materials')]);
  state.fields = fields; state.materials = materials;
  const saved = h('span', { class: 'savedmark' }, 'Saved ✓');
  let recipe = { ...p.recipe };
  let flash;
  const patch = guard(async (body) => {
    await api('PATCH', `/api/projects/${p.id}`, body);
    saved.classList.add('show'); clearTimeout(flash); flash = setTimeout(() => saved.classList.remove('show'), 1400);
  });

  const nameBox = h('input', { class: 'namebox', type: 'text', value: p.name, 'aria-label': 'Project name', onchange: (e) => e.target.value.trim() ? patch({ name: e.target.value }) : (e.target.value = p.name) });
  const machineSel = h('select', { 'aria-label': 'Machine type', style: { width: 'auto' }, onchange: (e) => { patch({ machine_type: e.target.value }).then(() => route(true)); } },
    Object.entries(MACHINE_LABEL).map(([v, l]) => h('option', { value: v, selected: v === p.machine_type }, l)));

  // files
  const userFiles = p.files.filter((f) => !f.auto);
  const photos = p.files.filter((f) => f.kind === 'photo');
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, onchange: guard(async (e) => { await uploadFiles([...e.target.files], p.id); route(); }) });
  const zone = h('div', { class: 'drop' }, 'Drop files here or ', h('button', { class: 'link', onclick: () => fileInput.click() }, 'browse'), fileInput);
  dropZone(zone, guard(async (files) => { await uploadFiles(files, p.id); route(); }));
  const filesPanel = h('section', { class: 'panel' },
    h('h2', {}, `Files (${userFiles.length})`),
    userFiles.length ? userFiles.map((f) => h('div', { class: 'file' },
      h('span', { class: 'chip kind' }, KIND_LABEL[f.kind]),
      h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { class: 'name' }, f.name), h('div', { class: 'info' }, [f.stored_size != null && f.stored_size < f.size ? `${fmtBytes(f.size)} (stored as ${fmtBytes(f.stored_size)})` : fmtBytes(f.size), fileSummary(f)].filter(Boolean).join(' · '))),
      canView(f.name) ? h('button', { class: 'small', onclick: () => viewModel(f) }, 'View 3D') : null,
      h('button', { class: 'small', onclick: guard(() => backend.downloadFile(f)) }, 'Download'),
      h('button', { class: 'small danger', onclick: guard(async () => { if (confirm(`Remove ${f.name} from the vault?`)) { await api('DELETE', `/api/files/${f.id}`); route(true); } }) }, 'Remove'))) : h('p', { class: 'kv' }, 'No files yet.'),
    h('div', { style: { marginTop: '12px' } }, zone),
    photos.length ? h('div', { class: 'gallery' }, photos.map((f) => h('img', { src: f.url, alt: f.name, loading: 'lazy', onclick: () => lightbox(f.url) }))) : null);

  // notes
  const notesPanel = h('section', { class: 'panel' }, h('h2', {}, 'Notes'),
    h('textarea', { placeholder: 'What worked, what to change next time, where the design came from…', value: p.notes, 'aria-label': 'Notes', onchange: (e) => patch({ notes: e.target.value }) }));

  // recipe
  const recipeBox = h('div', {});
  const saveRecipe = () => patch({ recipe });
  const drawRecipe = () => {
    put(recipeBox, 
      ...Object.entries(recipe).map(([k, v]) => h('div', { class: 'recipe-row' },
        h('input', { type: 'text', value: k, 'aria-label': 'Setting name', onchange: (e) => { const nk = e.target.value.trim(); if (!nk) return; const out = {}; for (const [a, b] of Object.entries(recipe)) out[a === k ? nk : a] = b; recipe = out; saveRecipe(); drawRecipe(); } }),
        h('input', { type: 'text', value: v, 'aria-label': `Value for ${k}`, onchange: (e) => { recipe[k] = e.target.value; saveRecipe(); } }),
        h('button', { title: 'Remove setting', 'aria-label': `Remove ${k}`, onclick: () => { delete recipe[k]; saveRecipe(); drawRecipe(); } }, '×'))),
      Object.keys(recipe).length ? null : h('p', { class: 'kv' }, 'Settings are read from your G-code, 3MF, SVG and LightBurn files. You can also add your own.'),
      h('button', { class: 'small', onclick: () => { let n = 'setting', i = 1; while (n in recipe) n = `setting_${++i}`; recipe[n] = ''; drawRecipe(); recipeBox.querySelector('.recipe-row:last-of-type input')?.select(); } }, '+ Add setting'));
  };
  drawRecipe();
  const recipePanel = h('section', { class: 'panel' }, h('h2', {}, 'Recipe'),
    h('p', { class: 'kv', style: { marginTop: '-6px' } }, 'The settings that make this project reproducible.'), recipeBox);

  // custom fields
  const custom = { ...p.custom };
  const relevant = fields.filter((f) => !f.machine_type || f.machine_type === p.machine_type);
  const customPanel = relevant.length ? h('section', { class: 'panel' }, h('h2', {}, 'Details'),
    relevant.map((f) => {
      const set = (v) => { if (v === '' || v === false) delete custom[f.key]; else custom[f.key] = String(v); patch({ custom }); };
      let input;
      if (f.type === 'select') input = h('select', { onchange: (e) => set(e.target.value) }, h('option', { value: '' }, '—'), f.options.map((o) => h('option', { value: o, selected: custom[f.key] === o }, o)));
      else if (f.type === 'checkbox') input = h('input', { type: 'checkbox', checked: custom[f.key] === 'true', onchange: (e) => set(e.target.checked ? 'true' : false) });
      else input = h('input', { type: f.type === 'number' ? 'number' : 'text', step: 'any', value: custom[f.key] || '', onchange: (e) => set(e.target.value) });
      return h('div', { class: 'field' }, h('label', {}, f.label), input);
    })) : null;

  // source + tags
  const tagInput = h('input', { type: 'text', value: p.tags.join(', '), placeholder: 'gift, garage, prototype', 'aria-label': 'Tags', onchange: (e) => patch({ tags: e.target.value.split(',') }) });
  const src = safeHttp(p.source_url);
  const metaPanel = h('section', { class: 'panel' }, h('h2', {}, 'Origin'),
    h('div', { class: 'field' }, h('label', {}, 'Source URL'), h('input', { type: 'url', value: p.source_url, placeholder: 'https://www.printables.com/model/…', onchange: (e) => patch({ source_url: e.target.value }) }), src ? h('a', { href: src, target: '_blank', rel: 'noopener noreferrer', class: 'kv' }, 'Open source ↗') : null),
    h('div', { class: 'field' }, h('label', {}, 'License'), h('input', { type: 'text', value: p.license, placeholder: 'CC BY-NC, own design, …', onchange: (e) => patch({ license: e.target.value }) })),
    h('div', { class: 'field' }, h('label', {}, 'Tags (comma separated)'), tagInput));

  // runs
  const runsPanel = runsSection(p, materials, () => recipe);

  put(app, 
    h('p', { class: 'kv' }, h('a', { href: '#/' }, '← All projects')),
    h('div', { class: 'row', style: { marginBottom: '16px' } }, nameBox, machineSel, saved, h('div', { class: 'spacer' }),
      h('button', { title: 'Zip with files, recipe.json and a README', onclick: guard(() => backend.exportProject(p.id)) }, 'Export package'),
      h('button', { class: 'danger', onclick: guard(async () => { if (confirm(`Delete "${p.name}" and all its files?`)) { await api('DELETE', `/api/projects/${p.id}`); location.hash = '#/'; } }) }, 'Delete')),
    h('div', { class: 'two' }, h('div', {}, filesPanel, runsPanel, notesPanel), h('div', {}, recipePanel, customPanel, metaPanel)));
}

function runsSection(p, materials, getRecipe) {
  const picked = new Set();
  const diffBox = h('div', {});
  const machine = h('input', { type: 'text', placeholder: 'e.g. Prusa MK4, Ortur LM3', 'aria-label': 'Machine', value: p.recipe.printer || p.recipe.device || '' });
  const material = h('select', { 'aria-label': 'Material' }, h('option', { value: '' }, 'Material (optional)'), materials.map((m) => h('option', { value: m.id }, `${m.name}${m.remaining_g != null ? ` — ${weightLabel(m.remaining_g)} left` : ''}`)));
  const outcome = h('select', { 'aria-label': 'Outcome', style: { width: 'auto' } }, Object.entries(OUTCOME_LABEL).map(([v, l]) => h('option', { value: v }, l)));
  const grams = h('input', { type: 'number', min: 0, step: 'any', placeholder: `${getUnit() === 'oz' ? 'ounces' : 'grams'} used`, 'aria-label': 'Amount used', style: { width: '140px' } });
  const notes = h('input', { type: 'text', placeholder: 'What happened? What would you change?', 'aria-label': 'Run notes' });
  const form = h('div', { class: 'row', style: { marginBottom: '12px' } },
    h('div', { style: { flex: '1 1 160px' } }, machine), h('div', { style: { flex: '1 1 180px' } }, material), outcome, grams,
    h('div', { style: { flex: '2 1 240px' } }, notes),
    h('button', { class: 'primary', onclick: guard(async () => {
      await api('POST', `/api/projects/${p.id}/runs`, { machine: machine.value, material_id: material.value || null, outcome: outcome.value, grams_used: weightToGrams(grams.value), notes: notes.value, settings: getRecipe() });
      toast('Run logged with the current recipe'); route(true);
    }) }, 'Log run'));

  const compare = h('button', { class: 'small', disabled: true, onclick: guard(async () => {
    const when = Object.fromEntries(p.runs.map((r) => [r.id, [r.created_at, r.id]]));
    const [a, b] = [...picked].sort((x, y) => when[x][0] - when[y][0] || when[x][1] - when[y][1]); // older first, whatever the click order
    const d = await api('GET', `/api/runs/diff?a=${a}&b=${b}`);
    const rows = [...d.changed.map((c) => [c.key, c.a, c.b]), ...d.added.map((c) => [c.key, '—', c.b]), ...d.removed.map((c) => [c.key, c.a, '—'])];
    put(diffBox, h('div', { class: 'panel', style: { background: 'var(--bg)' } },
      rows.length ? h('table', { class: 'diff' }, h('tr', {}, h('th', {}, 'Setting'), h('th', {}, 'Older'), h('th', {}, 'Newer')), rows.map(([k, x, y]) => h('tr', {}, h('td', {}, k), h('td', { class: 'a' }, x), h('td', { class: 'b' }, y)))) : h('p', { class: 'kv' }, 'These two runs used identical settings.'),
      h('p', { class: 'kv' }, `${d.same} setting${d.same === 1 ? '' : 's'} unchanged.`)));
  }) }, 'Compare selected');

  const byId = Object.fromEntries(materials.map((m) => [m.id, m]));
  const list = p.runs.length ? p.runs.map((r) => h('div', { class: 'run' },
    h('div', { class: 'row' },
      h('input', { type: 'checkbox', 'aria-label': 'Select run to compare', style: { width: 'auto' }, onchange: (e) => { e.target.checked ? picked.add(r.id) : picked.delete(r.id); if (picked.size > 2) { picked.delete([...picked][0]); } compare.disabled = picked.size !== 2; compare.textContent = picked.size === 2 ? 'Compare selected' : `Compare (pick ${2 - picked.size} more)`; } }),
      h('span', { class: `badge ${r.outcome}` }, OUTCOME_LABEL[r.outcome]), h('span', { class: 'kv' }, fmtDate(r.created_at)),
      r.machine ? h('span', { class: 'chip' }, r.machine) : null, r.material_id && byId[r.material_id] ? h('span', { class: 'chip' }, byId[r.material_id].name) : null,
      r.grams_used ? h('span', { class: 'kv' }, weightLabel(r.grams_used)) : null, h('div', { class: 'spacer' }),
      h('button', { class: 'small', onclick: (e) => { const pre = e.target.closest('.run').querySelector('pre'); pre.hidden = !pre.hidden; } }, 'Settings'),
      h('button', { class: 'small danger', onclick: guard(async () => { if (confirm('Delete this run?')) { await api('DELETE', `/api/runs/${r.id}`); route(true); } }) }, '×')),
    r.notes ? h('div', {}, r.notes) : null,
    h('pre', { hidden: true }, Object.entries(r.settings).map(([k, v]) => `${k}: ${v}`).join('\n') || '(no settings recorded)'))) : h('p', { class: 'kv' }, 'No runs yet. Log one after each print or burn — the recipe is saved with it, so you can see what changed when results differ.');
  compare.textContent = 'Compare (pick 2)';
  return h('section', { class: 'panel' }, h('div', { class: 'row' }, h('h2', { style: { margin: 0 } }, `Runs (${p.runs.length})`), h('div', { class: 'spacer' }), p.runs.length > 1 ? compare : null),
    h('div', { style: { height: '10px' } }), form, list, diffBox);
}

function lightbox(src) {
  const box = h('div', { class: 'lightbox', onclick: () => box.remove() }, h('img', { src, alt: '' }));
  document.body.append(box);
}

// 3D preview of a model file (STL, OBJ, 3MF) in a pop-up.
function viewModel(f) {
  let viewer;
  const info = h('span', { class: 'kv' }, 'Loading…');
  const canvas = h('canvas', { class: 'viewer-canvas', 'aria-label': `3D view of ${f.name}` });
  const msg = h('div', { class: 'viewer-msg' });
  const close = () => { viewer?.destroy(); document.removeEventListener('keydown', onKey); box.remove(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const views = ['Reset', 'Top', 'Front', 'Side'].map((v) => h('button', { class: 'small', disabled: true, onclick: () => viewer?.setView(v.toLowerCase()) }, v));
  const box = h('div', { class: 'viewer-backdrop', onclick: (e) => { if (e.target === box) close(); } },
    h('div', { class: 'viewer', role: 'dialog', 'aria-label': `3D preview of ${f.name}` },
      h('div', { class: 'viewer-bar' }, h('strong', { class: 'viewer-title' }, f.name), info, h('div', { class: 'spacer' }), views, h('button', { class: 'small', onclick: close }, 'Close')),
      h('div', { class: 'viewer-stage' }, canvas, msg),
      h('p', { class: 'kv viewer-hint' }, 'Drag to turn · scroll or pinch to zoom · right-drag or two fingers to move · Esc to close')));
  document.body.append(box);
  document.addEventListener('keydown', onKey);
  (async () => {
    try {
      const mesh = await loadMesh(f.name, await backend.fileBytes(f));
      viewer = createViewer(canvas, mesh.positions);
      const [x, y, z] = viewer.size.map((n) => Math.round(n * 100) / 100);
      info.textContent = `${x} × ${y} × ${z} (model units, usually mm) · ${viewer.triangles.toLocaleString()} triangles`;
      views.forEach((b) => (b.disabled = false));
    } catch (err) {
      info.textContent = '';
      msg.textContent = err.message || String(err);
      msg.classList.add('show');
    }
  })();
}

// ---------------------------------------------------------------- materials
async function materialsView(app) {
  const materials = await api('GET', '/api/materials');
  const u = getUnit();
  const f = {};
  const inp = (key, ph, type = 'text', w) => (f[key] = h('input', { type, placeholder: ph, 'aria-label': ph, step: 'any', min: type === 'number' ? 0 : undefined, style: w ? { width: w } : {} }));
  const add = guard(async () => {
    const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
    body.remaining_g = weightToGrams(body.remaining_g); // typed in your unit, stored in grams
    body.cost_per_g = priceToPerGram(body.cost_per_g);
    await api('POST', '/api/materials', body);
    route();
  });
  const unitPick = h('select', { 'aria-label': 'Weight unit', style: { width: 'auto' }, onchange: (e) => { setUnit(e.target.value); route(); } },
    h('option', { value: 'g', selected: u === 'g' }, 'Grams (g)'), h('option', { value: 'oz', selected: u === 'oz' }, 'Ounces (oz)'));
  put(app,
    h('h1', {}, 'Materials'),
    h('p', { class: 'sub' }, `Spools, sheets and vinyl. Log ${u === 'oz' ? 'ounces' : 'grams'} on a run and the remaining amount updates itself.`),
    h('section', { class: 'panel' }, h('div', { class: 'row' }, h('label', { class: 'kv' }, 'Show weights in'), unitPick),
      h('p', { class: 'kv', style: { margin: '8px 0 0' } }, 'Switching only changes what you see and type. Your amounts are always kept in grams, so nothing is lost or rounded away when you switch back.')),
    h('section', { class: 'panel' }, h('div', { class: 'row' }, inp('name', 'Name (e.g. Blue PETG)'), inp('type', 'Type (PLA, birch ply…)'), inp('brand', 'Brand'), inp('color', 'Color'), inp('remaining_g', `Remaining (${u})`, 'number', '150px'), inp('cost_per_g', `Cost per ${u === 'oz' ? 'ounce' : 'gram'} ($/${u})`, 'number', '150px'), h('button', { class: 'primary', onclick: add }, 'Add')),
      h('p', { class: 'kv', style: { margin: '8px 0 0' } }, u === 'oz'
        ? 'For example, a 1 kg spool that cost $22 is 35.27 oz at $0.6237 per ounce.'
        : 'For example, a 1 kg spool that cost $22 is 1000 g at $0.022 per gram.')),
    converterPanel(),
    materials.length ? h('section', { class: 'panel' }, h('table', {}, h('tr', {}, ['Name', 'Type', 'Brand', 'Color', `Remaining (${u})`, `Cost per ${u === 'oz' ? 'ounce' : 'gram'}`, ''].map((t) => h('th', {}, t))),
      materials.map((m) => h('tr', {}, h('td', {}, m.name), h('td', {}, m.type), h('td', {}, m.brand), h('td', {}, m.color),
        h('td', {}, h('input', { type: 'number', min: 0, step: 'any', value: showWeight(m.remaining_g), style: { width: '110px' }, 'aria-label': `Remaining ${u === 'oz' ? 'ounces' : 'grams'} for ${m.name}`, onchange: guard(async (e) => { await api('PATCH', `/api/materials/${m.id}`, { remaining_g: weightToGrams(e.target.value) }); toast('Updated'); }) })),
        h('td', {}, priceLabel(m.cost_per_g)),
        h('td', {}, h('button', { class: 'small danger', onclick: guard(async () => { if (confirm(`Delete ${m.name}?`)) { await api('DELETE', `/api/materials/${m.id}`); route(); } }) }, '×')))))) : null);
}

// Spools are sold in grams, many machines report ounces (or the reverse): type a weight in any unit, see the rest.
function converterPanel() {
  const value = h('input', { type: 'number', min: 0, step: 'any', placeholder: 'Weight', 'aria-label': 'Weight to convert', style: { width: '140px' } });
  const from = h('select', { 'aria-label': 'Convert from', style: { width: 'auto' } }, ['g', 'oz', 'kg', 'lb'].map((x) => h('option', { value: x }, x)));
  const out = h('p', { class: 'kv', style: { margin: '8px 0 0' } });
  const update = () => {
    const c = convertWeight(value.value, from.value);
    out.textContent = c ? `${c.g} g  =  ${c.oz} oz  =  ${c.kg} kg  =  ${c.lb} lb` : 'Enter a weight to see it in grams, ounces, kilograms and pounds.';
  };
  const price = h('input', { type: 'number', min: 0, step: 'any', placeholder: 'Price per gram', 'aria-label': 'Price per gram to convert', style: { width: '150px' } });
  const priceOut = h('span', { class: 'kv' });
  price.oninput = () => { priceOut.textContent = price.value === '' ? '' : `= $${showPrice(price.value, 'oz')} per ounce`; };
  value.oninput = update; from.onchange = update; update();
  return h('section', { class: 'panel' }, h('h2', {}, 'Unit converter'),
    h('div', { class: 'row' }, value, from),
    out,
    h('div', { class: 'row', style: { marginTop: '10px' } }, price, priceOut),
    h('p', { class: 'kv', style: { margin: '8px 0 0' } }, `1 oz = ${G_PER_OZ.toFixed(2)} g. Example: a 1 kg spool is 35.27 oz.`));
}

// ---------------------------------------------------------------- settings / custom fields
async function settingsView(app) {
  const fields = await api('GET', '/api/fields');
  const label = h('input', { type: 'text', placeholder: 'Field name (e.g. Bed surface)', 'aria-label': 'Field name' });
  const type = h('select', { 'aria-label': 'Field type', style: { width: 'auto' } }, ['text', 'number', 'select', 'checkbox'].map((t) => h('option', { value: t }, t)));
  const options = h('input', { type: 'text', placeholder: 'Options, comma separated (for select)', 'aria-label': 'Options' });
  const machine = h('select', { 'aria-label': 'Applies to', style: { width: 'auto' } }, h('option', { value: '' }, 'All machines'), ['3d', 'laser', 'cutter', 'other'].map((m) => h('option', { value: m }, MACHINE_LABEL[m])));
  put(app, 
    h('h1', {}, 'Settings'), h('p', { class: 'sub' }, 'Shape the vault around how you work.'),
    h('section', { class: 'panel' }, h('h2', {}, 'Custom fields'),
      h('p', { class: 'kv', style: { marginTop: '-6px' } }, 'Add anything you want to track — bed surface, wood species, vinyl brand, customer, finish. Fields appear on every matching project.'),
      h('div', { class: 'row', style: { marginBottom: '12px' } }, h('div', { style: { flex: '1 1 200px' } }, label), type, machine, h('div', { style: { flex: '1 1 220px' } }, options),
        h('button', { class: 'primary', onclick: guard(async () => {
          await api('POST', '/api/fields', { label: label.value, type: type.value, machine_type: machine.value || null, options: options.value.split(',').map((s) => s.trim()).filter(Boolean) });
          route();
        }) }, 'Add field')),
      fields.length ? h('table', {}, h('tr', {}, ['Field', 'Type', 'Applies to', ''].map((t) => h('th', {}, t))), fields.map((f) => h('tr', {},
        h('td', {}, f.label), h('td', {}, f.type + (f.options.length ? ` (${f.options.join(', ')})` : '')), h('td', {}, f.machine_type ? MACHINE_LABEL[f.machine_type] : 'All'),
        h('td', {}, h('button', { class: 'small danger', onclick: guard(async () => { if (confirm(`Delete field "${f.label}"? Values already entered stay on the projects but are hidden.`)) { await api('DELETE', `/api/fields/${f.id}`); route(); } }) }, '×'))))) : h('p', { class: 'kv' }, 'No custom fields yet.')),
    backend.local ? backupPanel() : h('section', { class: 'panel' }, h('h2', {}, 'Your data'),
      h('p', {}, 'Everything is stored on this computer in the ', h('code', {}, 'data/'), ' folder: a SQLite database plus your files. Nothing is uploaded anywhere. Back up that folder and you have backed up your vault. Use “Export package” on any project for a portable zip.')));
}

// Browser edition only: data lives inside the browser, so make backing it up obvious and easy.
function backupPanel() {
  const usage = h('p', { class: 'kv' }, 'Checking storage…');
  const savings = h('p', { class: 'saved' });
  api('GET', '/api/stats').then((s) => { savings.textContent = savingsText(s) || ''; }).catch(() => {});
  backend.storageInfo().then((i) => {
    usage.textContent = `Using ${fmtBytes(i.used)}${i.quota ? ` of about ${fmtBytes(i.quota)} available` : ''}. ${i.persistent ? 'Your browser has agreed to keep this data.' : 'Your browser may delete this data if the disk runs low — keep a backup.'}`;
  }).catch(() => { usage.textContent = ''; });
  const restoreInput = h('input', { type: 'file', accept: '.zip', hidden: true, onchange: guard(async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (!confirm('Restoring replaces everything currently in this vault with the contents of the backup. Continue?')) return;
    toast('Restoring…');
    const r = await backend.restore(f);
    toast(`Restored ${r.projects} project${r.projects === 1 ? '' : 's'} and ${r.files} file${r.files === 1 ? '' : 's'}`);
    location.hash = '#/';
    route();
  }) });
  return h('section', { class: 'panel' }, h('h2', {}, 'Backup & storage'),
    h('p', {}, 'This page keeps your vault inside your web browser, on this computer. Nothing is uploaded anywhere. Clearing your browser’s site data, or using a private window, will erase it — so download a backup now and then.'),
    usage, savings,
    h('p', { class: 'kv' }, 'Files are stored compressed to save space (formats that are already compressed, like 3MF and photos, are kept as they are). Downloads and “Export package” always give you the original files, byte for byte. A backup keeps the compressed form so it stays small — it is meant to be restored here; use “Export package” when you want ordinary files.'),
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: guard(async () => { toast('Preparing backup…'); await backend.backup(); toast('Backup downloaded'); }) }, 'Download backup'),
      h('button', { onclick: () => restoreInput.click() }, 'Restore from backup…'), restoreInput));
}

// ---------------------------------------------------------------- router
async function route(keepFocus) {
  const app = $('#app');
  const hash = location.hash || '#/';
  const name = hash.startsWith('#/project/') ? 'projects' : hash.slice(2).split('/')[0] || 'projects';
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  const scroll = keepFocus ? window.scrollY : 0;
  try {
    const m = hash.match(/^#\/project\/(\d+)$/);
    if (m) await projectView(app, Number(m[1]));
    else if (hash === '#/materials') await materialsView(app);
    else if (hash === '#/settings') await settingsView(app);
    else await projectsView(app);
    window.scrollTo(0, scroll);
  } catch (e) {
    put(app, h('div', { class: 'empty' }, h('h2', {}, 'Something went wrong'), h('p', {}, e.message), h('p', {}, h('a', { href: '#/' }, 'Back to projects'))));
  }
}

function brandFooter() {
  const b = state.config.brand;
  const foot = $('#footer');
  if (!b?.name) { foot.textContent = 'CubbyBench — free and open source. Your files never leave your computer.'; return; }
  const url = b.url && safeHttp(b.url);
  put(foot, 
    'CubbyBench is free, forever, from ', url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, b.name) : b.name,
    b.tagline ? ` — ${b.tagline}` : '', b.cta && url ? [' · ', h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, b.cta)] : null);
}

window.addEventListener('hashchange', () => route());
api('GET', '/api/config').then((c) => { state.config = c; brandFooter(); }).catch(() => brandFooter());
route();
