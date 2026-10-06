import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { buildZip } from '../server/zip.js';
import { parseStl, parseObj, parse3mf, loadMesh, bounds, canView } from '../public/mesh.js';
import { stlBinary } from './helpers.js';

const tri = (n) => `<vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="20" z="5"/>`.repeat(n);
const meshXml = (id) => `<object id="${id}" type="model"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/><vertex x="0" y="20" z="5"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>`;
const model = (inner, build) => `<?xml version="1.0"?><model unit="millimeter"><resources>${inner}</resources><build>${build}</build></model>`;

test('binary and ASCII STL give the same triangle', () => {
  const bin = parseStl(stlBinary());
  assert.deepEqual([...bin.positions], [0, 0, 0, 10, 0, 0, 0, 20, 5]);
  const ascii = parseStl(Buffer.from('solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 20 5\nendloop\nendfacet\nendsolid'));
  assert.deepEqual([...ascii.positions], [...bin.positions]);
  assert.deepEqual(bounds(bin.positions).size, [10, 20, 5]);
});

test('empty or broken STL is refused with a readable message', () => {
  assert.throws(() => parseStl(Buffer.from('not a model')), /No triangles/);
});

test('OBJ quads are split into triangles and negative indexes work', () => {
  const { positions } = parseObj(Buffer.from('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\nf -4 -3 -2\n'));
  assert.equal(positions.length / 9, 3);
  assert.throws(() => parseObj(Buffer.from('v 0 0 0\nf 1 2 3\n')), /missing point/);
});

test('3MF: build item transform is applied', async () => {
  const xml = model(meshXml(1), '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 100 0 0"/>');
  const { positions } = await parse3mf(buildZip([{ name: '3D/3dmodel.model', data: Buffer.from(xml) }]));
  assert.deepEqual([...positions].slice(0, 3), [100, 0, 0]);
  assert.equal(bounds(positions).size[0], 10);
});

test('3MF: components and an object in another model file are followed, compressed zip is read', async () => {
  const root = model('<object id="2" type="model"><components><component objectid="1" p:path="/3D/Objects/part.model" transform="1 0 0 0 1 0 0 0 1 0 5 0"/></components></object>', '<item objectid="2"/>');
  const part = model(meshXml(1), '');
  const files = [['3D/3dmodel.model', root], ['3D/Objects/part.model', part]];
  // hand-built zip with deflate (method 8)
  const locals = [], centrals = []; let off = 0;
  for (const [name, text] of files) {
    const raw = Buffer.from(text), data = zlib.deflateRawSync(raw), nm = Buffer.from(name);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(8, 8); l.writeUInt32LE(data.length, 18); l.writeUInt32LE(raw.length, 22); l.writeUInt16LE(nm.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    locals.push(l, nm, data); centrals.push(c, nm); off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(2, 8); end.writeUInt16LE(2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  const { positions } = await parse3mf(Buffer.concat([...locals, cd, end]));
  assert.deepEqual([...positions].slice(0, 3), [0, 5, 0]);
});

test('3MF without a mesh is refused; loadMesh routes by extension', async () => {
  await assert.rejects(parse3mf(buildZip([{ name: '3D/3dmodel.model', data: Buffer.from('<model><resources/></model>') }])), /No 3D shape/);
  assert.equal((await loadMesh('A.STL', stlBinary())).positions.length, 9);
  await assert.rejects(loadMesh('a.gcode', Buffer.from('')), /cannot be previewed/);
  assert.ok(canView('x.3MF') && canView('y.stl') && !canView('z.gcode'));
});
