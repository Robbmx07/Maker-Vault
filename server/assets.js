// Serves the UI from disk in development and from the embedded bundle in the standalone executable.
import fs from 'node:fs';
import path from 'node:path';
import sea from 'node:sea';
import { fileURLToPath } from 'node:url';

export const isStandalone = sea.isSea();
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// `rel` is a URL-style path such as "index.html" or "app.js". Returns a Buffer or null.
export function readAsset(rel) {
  rel = String(rel).replace(/^\/+/, '');
  if (!rel || rel.split(/[\\/]/).includes('..')) return null;
  if (isStandalone) {
    try { return Buffer.from(sea.getAsset(rel)); } catch { return null; }
  }
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return null;
  try { return fs.statSync(file).isFile() ? fs.readFileSync(file) : null; } catch { return null; }
}
