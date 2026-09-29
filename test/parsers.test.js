import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseGcodeText } from '../server/parsers/gcode.js';
import { parseSvgText } from '../server/parsers/svg.js';
import { parseLightBurnText } from '../server/parsers/lightburn.js';
import { parseStlBuffer } from '../server/parsers/stl.js';
import { parseFile, projectStem, detectKind } from '../server/parsers/index.js';
import { listZip, readZipEntry, buildZip } from '../server/zip.js';
import { diffSettings } from '../server/diff.js';
import { PRUSA_GCODE, CURA_GCODE, LBRN, SVG, stlBinary, threeMf } from './helpers.js';

const tmp = (name, data) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p-')), name);
  fs.writeFileSync(f, data);
  return f;
};

test('PrusaSlicer gcode header becomes a recipe', () => {
  const { recipe } = parseGcodeText(PRUSA_GCODE);
  assert.deepEqual(recipe, {
    slicer: 'PrusaSlicer 2.7.1', printer: 'MK4', filament_type: 'PETG', layer_height: '0.2', nozzle_diameter: '0.4',
    nozzle_temp: '215', bed_temp: '60', infill: '15%', walls: '3', supports: '0',
    print_time: '1h 2m 3s', filament_used_g: '3.42',
  });
});

test('Cura gcode header is understood', () => {
  const { recipe } = parseGcodeText(CURA_GCODE);
  assert.equal(recipe.layer_height, '0.16');
  assert.equal(recipe.print_time, '1h 2m');
  assert.match(recipe.slicer, /Cura/);
});

test('svg size, paths and laser stroke colours', () => {
  const { meta, recipe } = parseSvgText(SVG);
  assert.equal(meta.paths, 2);
  assert.deepEqual(meta.stroke_colors, ['#ff0000', '#0000ff']);
  assert.equal(recipe.design_size_mm, '100 x 50');
  assert.equal(meta.title, 'Coaster');
});

test('svg without units falls back to viewBox in mm', () => {
  const { recipe } = parseSvgText('<svg viewBox="0 0 96 96"></svg>');
  assert.equal(recipe.design_size_mm, '25.4 x 25.4');
});

test('lightburn layers become per-layer settings', () => {
  const { recipe, meta } = parseLightBurnText(LBRN);
  assert.equal(meta.layers, 2);
  assert.equal(recipe.layer_0_mode, 'Cut');
  assert.equal(recipe.layer_0_speed_mm_s, '8');
  assert.equal(recipe.layer_0_power_pct, '65');
  assert.equal(recipe.layer_0_passes, '2');
  assert.equal(recipe.layer_1_interval_mm, '0.1');
  assert.equal(recipe.device, 'Ortur LM3');
});

test('binary stl bounding box', () => {
  const { meta } = parseStlBuffer(stlBinary());
  assert.equal(meta.triangles, 1);
  assert.deepEqual(meta.size_mm, [10, 20, 5]);
});

test('ascii stl bounding box', () => {
  const s = 'solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 4 0 0\nvertex 0 6 2\nendloop\nendfacet\nendsolid';
  assert.deepEqual(parseStlBuffer(Buffer.from(s)).meta.size_mm, [4, 6, 2]);
});

test('3mf: settings, metadata and thumbnail', () => {
  const r = parseFile(tmp('b.3mf', threeMf()), 'b.3mf');
  assert.equal(r.kind, 'slice');
  assert.equal(r.recipe.layer_height, '0.15');
  assert.equal(r.recipe.filament_type, 'ABS');
  assert.equal(r.meta.title, 'Bracket');
  assert.ok(r.thumbnail.length > 0);
});

test('a corrupt 3mf does not throw', () => {
  const r = parseFile(tmp('bad.3mf', 'not a zip'), 'bad.3mf');
  assert.ok(r.meta.parse_error);
  assert.deepEqual(r.recipe, {});
});

test('zip round trip', () => {
  const f = tmp('a.zip', buildZip([{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'dir/ü.txt', data: Buffer.from('x'.repeat(1000)) }]));
  const entries = listZip(f);
  assert.deepEqual(entries.map((e) => e.name), ['a.txt', 'dir/ü.txt']);
  assert.equal(readZipEntry(f, entries[0]).toString(), 'hello');
});

test('project stem grouping', () => {
  assert.equal(projectStem('Bracket_0.2mm_PLA_MK4_1h2m.gcode'), 'Bracket');
  assert.equal(projectStem('bracket_v3_final.3mf'), 'bracket');
  assert.equal(projectStem('my-final-box.stl'), 'my-final-box');
  assert.equal(detectKind('x.LBRN2'), 'design');
});

test('diffSettings', () => {
  const d = diffSettings({ a: '1', b: '2', c: '3' }, { a: '1', b: '9', d: '4' });
  assert.deepEqual(d, { changed: [{ key: 'b', a: '2', b: '9' }], added: [{ key: 'd', b: '4' }], removed: [{ key: 'c', a: '3' }], same: 1 });
});
