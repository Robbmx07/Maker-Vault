import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listZip } from '../server/zip.js';
import { startApp, PRUSA_GCODE, SVG, LBRN, stlBinary, threeMf } from './helpers.js';

let t;
before(async () => { t = await startApp(); });
after(() => t.close());

const upload = (name, data, path = '/api/upload') => t.api('POST', `${path}?name=${encodeURIComponent(name)}`, Buffer.from(data), { 'Content-Type': 'application/octet-stream' });

test('uploads with the same stem land in one project and fill the recipe', async () => {
  const a = await upload('Bracket.stl', stlBinary());
  const b = await upload('Bracket_0.2mm_PETG_MK4_1h.gcode', PRUSA_GCODE);
  assert.equal(a.status, 200);
  assert.equal(a.data.project_id, b.data.project_id);
  const { data: p } = await t.api('GET', `/api/projects/${a.data.project_id}`);
  assert.equal(p.machine_type, '3d');
  assert.equal(p.files.length, 2);
  assert.equal(p.recipe.filament_type, 'PETG');
  assert.equal(p.recipe.layer_height, '0.2');
  assert.equal(p.files.find((f) => f.kind === 'model').meta.triangles, 1);
});

test('re-uploading identical content is a duplicate', async () => {
  const r = await upload('Bracket.stl', stlBinary());
  assert.equal(r.data.duplicate, true);
  const { data: p } = await t.api('GET', `/api/projects/${r.data.project_id}`);
  assert.equal(p.files.length, 2);
});

test('user-edited recipe values are not overwritten by later files', async () => {
  const { data: { id } } = await t.api('POST', '/api/projects', { name: 'Keep mine' });
  await t.api('PATCH', `/api/projects/${id}`, { recipe: { layer_height: '0.12' } });
  await upload('x.gcode', PRUSA_GCODE, `/api/projects/${id}/files`);
  const { data: p } = await t.api('GET', `/api/projects/${id}`);
  assert.equal(p.recipe.layer_height, '0.12');
  assert.equal(p.recipe.nozzle_temp, '215');
});

test('3mf thumbnail becomes the project cover', async () => {
  const r = await upload('Hook.3mf', threeMf());
  const { data: list } = await t.api('GET', '/api/projects?q=hook');
  assert.equal(list.length, 1);
  assert.ok(list[0].cover_file_id);
  assert.equal(list[0].file_count, 1, 'auto previews are not counted as user files');
  const raw = await t.api('GET', `/api/files/${list[0].cover_file_id}/raw`);
  assert.equal(raw.res.headers.get('content-type'), 'image/png');
  assert.equal(r.data.file.kind, 'slice');
});

test('laser + svg projects', async () => {
  const r = await upload('Coaster.lbrn2', LBRN);
  await upload('Coaster.svg', SVG);
  const { data: p } = await t.api('GET', `/api/projects/${r.data.project_id}`);
  assert.equal(p.machine_type, 'laser');
  assert.equal(p.recipe.layer_0_power_pct, '65');
  assert.equal(p.recipe.design_size_mm, '100 x 50');
});

test('search, machine filter, tags', async () => {
  const { data: list } = await t.api('GET', '/api/projects');
  const bracket = list.find((p) => p.name === 'Bracket');
  await t.api('PATCH', `/api/projects/${bracket.id}`, { tags: ['Gift', ' garage ', 'gift'] });
  assert.deepEqual((await t.api('GET', '/api/projects?tag=gift')).data.map((p) => p.name), ['Bracket']);
  assert.ok((await t.api('GET', '/api/projects?q=petg')).data.some((p) => p.name === 'Bracket'), 'search reaches recipe values');
  assert.ok((await t.api('GET', '/api/projects?machine=laser')).data.every((p) => p.machine_type === 'laser'));
  assert.equal((await t.api('GET', '/api/projects?q=100%25')).data.length, 0, '% is escaped, not a wildcard');
  assert.deepEqual((await t.api('GET', '/api/tags')).data.map((x) => x.tag), ['garage', 'gift']);
});

test('runs: default to recipe, deduct material, diff, refund on delete', async () => {
  const { data: list } = await t.api('GET', '/api/projects?q=bracket');
  const pid = list[0].id;
  const { data: { id: mid } } = await t.api('POST', '/api/materials', { name: 'Blue PETG', type: 'PETG', remaining_g: 1000 });
  const r1 = await t.api('POST', `/api/projects/${pid}/runs`, { machine: 'MK4', material_id: mid, grams_used: 40, outcome: 'fail', notes: 'stringing' });
  const r2 = await t.api('POST', `/api/projects/${pid}/runs`, { machine: 'MK4', material_id: mid, grams_used: 35, settings: { ...list[0].recipe, nozzle_temp: '225' } });
  assert.equal((await t.api('GET', '/api/materials')).data[0].remaining_g, 925);
  const { data: proj } = await t.api('GET', `/api/projects/${pid}`);
  assert.equal(proj.runs.length, 2);
  assert.equal(proj.runs.find((r) => r.id === r1.data.id).settings.nozzle_temp, '215');
  const { data: d } = await t.api('GET', `/api/runs/diff?a=${r1.data.id}&b=${r2.data.id}`);
  assert.deepEqual(d.changed, [{ key: 'nozzle_temp', a: '215', b: '225' }]);
  await t.api('DELETE', `/api/runs/${r1.data.id}`);
  assert.equal((await t.api('GET', '/api/materials')).data[0].remaining_g, 965);
  assert.equal((await t.api('POST', `/api/projects/${pid}/runs`, { outcome: 'meh' })).status, 400);
});

test('materials are measured in grams: weight in g, price per gram, bad amounts rejected', async () => {
  const { data: { id } } = await t.api('POST', '/api/materials', { name: 'Silk Gold PETG', type: 'PETG', remaining_g: 1000, cost_per_g: 0.025 });
  const find = async () => (await t.api('GET', '/api/materials')).data.find((m) => m.id === id);
  let m = await find();
  assert.equal(m.remaining_g, 1000);
  assert.equal(m.cost_per_g, 0.025);
  assert.ok(!('cost_per_kg' in m), 'the per-kilogram field no longer exists');
  // editing one amount keeps the other; an empty value clears it
  await t.api('PATCH', `/api/materials/${id}`, { remaining_g: '640' });
  m = await find();
  assert.equal(m.remaining_g, 640);
  assert.equal(m.cost_per_g, 0.025);
  await t.api('PATCH', `/api/materials/${id}`, { cost_per_g: '' });
  assert.equal((await find()).cost_per_g, null);
  // invalid amounts are refused, not stored
  for (const bad of [{ cost_per_g: -1 }, { cost_per_g: 'abc' }, { remaining_g: -5 }]) {
    const r = await t.api('POST', '/api/materials', { name: 'Bad', ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await t.api('PATCH', `/api/materials/${id}`, { remaining_g: 'lots' })).status, 400);
});

test('custom fields: create, reject duplicates, store values', async () => {
  const f = await t.api('POST', '/api/fields', { label: 'Bed surface', type: 'select', options: ['Textured PEI', 'Smooth PEI'] });
  assert.equal(f.data.key, 'bed_surface');
  assert.equal((await t.api('POST', '/api/fields', { label: 'Bed surface' })).status, 409);
  assert.equal((await t.api('POST', '/api/fields', { label: 'X', type: 'select' })).status, 400);
  const { data: list } = await t.api('GET', '/api/projects?q=bracket');
  await t.api('PATCH', `/api/projects/${list[0].id}`, { custom: { bed_surface: 'Textured PEI' } });
  assert.equal((await t.api('GET', `/api/projects/${list[0].id}`)).data.custom.bed_surface, 'Textured PEI');
});

test('folder import is idempotent and groups by stem', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'Vase.stl'), stlBinary());
  fs.writeFileSync(path.join(dir, 'Vase_0.2mm_PLA_1h.gcode'), PRUSA_GCODE);
  fs.writeFileSync(path.join(dir, 'sub', 'Sign.svg'), SVG);
  fs.writeFileSync(path.join(dir, '.hidden'), 'x');
  const first = await t.api('POST', '/api/import', { dir });
  assert.deepEqual(first.data, { projects_created: 2, projects_updated: 0, files_added: 3, duplicates: 0, skipped: 0 });
  const second = await t.api('POST', '/api/import', { dir });
  assert.equal(second.data.files_added, 0);
  assert.equal(second.data.projects_created, 0);
  fs.writeFileSync(path.join(dir, 'Vase_photo.jpg'), 'jpegdata');
  fs.writeFileSync(path.join(dir, 'Vase_v2.stl'), stlBinary().subarray(0, 84));
  const third = await t.api('POST', '/api/import', { dir });
  assert.equal(third.data.projects_updated, 1);
  assert.equal((await t.api('POST', '/api/import', { dir: '/nope/nope' })).status, 400);
});

test('export zip contains files, recipe.json and README', async () => {
  const { data: list } = await t.api('GET', '/api/projects?q=bracket');
  const r = await t.api('GET', `/api/projects/${list[0].id}/export`);
  assert.equal(r.res.headers.get('content-type'), 'application/zip');
  const f = path.join(t.dir, 'out.zip');
  fs.writeFileSync(f, r.data);
  const names = listZip(f).map((e) => e.name).sort();
  assert.deepEqual(names, ['README.md', 'files/Bracket.stl', 'files/Bracket_0.2mm_PETG_MK4_1h.gcode', 'recipe.json']);
});

test('deleting a project removes its files from disk', async () => {
  const r = await upload('Temp.stl', stlBinary());
  const dir = path.join(t.dir, 'files', String(r.data.project_id));
  assert.ok(fs.existsSync(dir));
  await t.api('DELETE', `/api/projects/${r.data.project_id}`);
  assert.ok(!fs.existsSync(dir));
  assert.equal((await t.api('GET', `/api/projects/${r.data.project_id}`)).status, 404);
});

test('hostile file names cannot escape the vault', async () => {
  const r = await upload('../../evil.stl', stlBinary());
  assert.equal(r.status, 200);
  const { data: p } = await t.api('GET', `/api/projects/${r.data.project_id}`);
  assert.equal(p.files[0].name, 'evil.stl');
  assert.ok(!fs.existsSync(path.join(t.dir, '..', 'evil.stl')));
});

test('static path traversal is blocked; bad host and cross-origin writes are refused', async () => {
  const raw = await fetch(`${t.base}/..%2f..%2fpackage.json`);
  assert.equal(raw.status, 404);
  const url = new URL(t.base);
  const http = await import('node:http');
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: url.port, path: '/api/projects', headers: { Host: 'evil.example.com' } }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(status, 403);
  const cross = await t.api('POST', '/api/projects', { name: 'x' }, { Origin: 'https://evil.example.com' });
  assert.equal(cross.status, 403);
});

test('config exposes branding', async () => {
  assert.equal((await t.api('GET', '/api/config')).data.brand.name, 'Test');
});
