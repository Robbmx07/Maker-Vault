import fs from 'node:fs';
import { keyify, normalizeSlicerSettings } from './slicer.js';

const CHUNK = 256 * 1024;

function readHeadTail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const n = Math.min(size, CHUNK);
    const head = Buffer.alloc(n);
    fs.readSync(fd, head, 0, n, 0);
    let text = head.toString('latin1');
    if (size > CHUNK * 2) {
      const tail = Buffer.alloc(CHUNK);
      fs.readSync(fd, tail, 0, CHUNK, size - CHUNK);
      text += '\n' + tail.toString('latin1');
    } else if (size > n) {
      const rest = Buffer.alloc(size - n);
      fs.readSync(fd, rest, 0, size - n, n);
      text += rest.toString('latin1');
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

function secondsToHuman(s) {
  s = Math.round(Number(s));
  if (!Number.isFinite(s)) return undefined;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

export function parseGcodeText(text) {
  const bag = {};
  for (const line of text.split(/\r?\n/)) {
    if (line[0] !== ';') continue;
    const gen = line.match(/^;\s*generated (?:by|with)\s+(.+?)(?:\s+on\s+.*)?$/i);
    if (gen && !bag.slicer) { bag.slicer = gen[1].trim(); continue; }
    const kv = line.match(/^;\s*([A-Za-z][A-Za-z0-9_ .\[\]()/-]*?)\s*[=:]\s*(.+?)\s*$/);
    if (!kv) continue;
    const key = keyify(kv[1]);
    if (key && !(key in bag)) bag[key] = kv[2];
  }
  const recipe = normalizeSlicerSettings(bag);
  if (!recipe.print_time && bag.time) recipe.print_time = secondsToHuman(bag.time);
  if (bag.flavor) recipe.gcode_flavor = bag.flavor;
  return { recipe, meta: { slicer: recipe.slicer } };
}

export function parseGcode(file) {
  return parseGcodeText(readHeadTail(file));
}
