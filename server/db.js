import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  machine_type TEXT NOT NULL DEFAULT 'unknown',
  notes TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  license TEXT NOT NULL DEFAULT '',
  recipe TEXT NOT NULL DEFAULT '{}',
  custom TEXT NOT NULL DEFAULT '{}',
  import_key TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_tags (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (project_id, tag)
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  path TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  auto INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS files_project ON files(project_id);
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT '',
  brand TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  remaining_g REAL,
  cost_per_g REAL,
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  machine TEXT NOT NULL DEFAULT '',
  material_id INTEGER REFERENCES materials(id) ON DELETE SET NULL,
  outcome TEXT NOT NULL DEFAULT 'pass',
  settings TEXT NOT NULL DEFAULT '{}',
  grams_used REAL,
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_project ON runs(project_id);
CREATE TABLE IF NOT EXISTS field_defs (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  options TEXT NOT NULL DEFAULT '[]',
  machine_type TEXT
);
`;

// Materials used to be priced per kilogram. Everything is in grams now, so convert existing data
// (price per kg / 1000 = price per gram) the first time an older library is opened.
function migrateMaterialPricing(db) {
  const cols = db.prepare('PRAGMA table_info(materials)').all().map((c) => c.name);
  if (!cols.includes('cost_per_kg')) return;
  db.exec('BEGIN');
  try {
    if (!cols.includes('cost_per_g')) db.exec('ALTER TABLE materials ADD COLUMN cost_per_g REAL');
    db.exec('UPDATE materials SET cost_per_g = ROUND(cost_per_kg / 1000.0, 6) WHERE cost_per_kg IS NOT NULL AND cost_per_g IS NULL');
    db.exec('ALTER TABLE materials DROP COLUMN cost_per_kg');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrateMaterialPricing(db);
  return db;
}
