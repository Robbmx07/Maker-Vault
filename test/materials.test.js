import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.js';

// A library created before pricing moved from kilograms to grams.
function legacyLibrary() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-')), 'vault.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE materials (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT '', brand TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '', remaining_g REAL, cost_per_kg REAL, notes TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);`);
  const ins = db.prepare('INSERT INTO materials (name, remaining_g, cost_per_kg, created_at) VALUES (?, ?, ?, 1)');
  ins.run('Blue PETG', 720, 22);
  ins.run('Silk Gold', 410, 25.99);
  ins.run('Birch ply sheet', null, null);
  db.close();
  return file;
}

test('an older library priced per kilogram is converted to price per gram when opened', () => {
  const db = openDb(legacyLibrary());
  const rows = db.prepare('SELECT name, remaining_g, cost_per_g FROM materials ORDER BY id').all();
  assert.deepEqual(rows.map((r) => [r.name, r.remaining_g, r.cost_per_g]), [
    ['Blue PETG', 720, 0.022], // $22/kg -> $0.022/g, weight untouched
    ['Silk Gold', 410, 0.02599],
    ['Birch ply sheet', null, null], // blanks stay blank
  ]);
  const cols = db.prepare('PRAGMA table_info(materials)').all().map((c) => c.name);
  assert.ok(cols.includes('cost_per_g') && !cols.includes('cost_per_kg'), 'old column removed');
  db.close();
});

test('opening a converted library again changes nothing (safe to repeat)', () => {
  const file = legacyLibrary();
  openDb(file).close();
  const db = openDb(file);
  assert.equal(db.prepare("SELECT cost_per_g FROM materials WHERE name = 'Blue PETG'").get().cost_per_g, 0.022);
  db.close();
});

test('a brand-new library starts with price per gram', () => {
  const db = openDb(':memory:');
  const cols = db.prepare('PRAGMA table_info(materials)').all().map((c) => c.name);
  assert.ok(cols.includes('cost_per_g') && !cols.includes('cost_per_kg'));
  db.close();
});
