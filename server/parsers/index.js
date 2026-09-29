import { parseGcode } from './gcode.js';
import { parseThreeMF } from './threemf.js';
import { parseSvg } from './svg.js';
import { parseLightBurn } from './lightburn.js';
import { parseStl } from './stl.js';

export const extOf = (name) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; };
const baseOf = (name) => { const b = name.split(/[\\/]/).pop(); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(0, i) : b; };

const EXT = {
  model: ['stl', 'obj', 'step', 'stp', 'scad', 'f3d', 'fcstd', 'blend', 'amf'],
  slice: ['3mf', 'gcode', 'gco', 'bgcode', 'ufp'],
  design: ['svg', 'dxf', 'lbrn', 'lbrn2', 'ai', 'eps', 'pdf', 'cdr', 'xcs', 'studio3', 'fcm'],
  photo: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic'],
  video: ['mp4', 'mov', 'webm'],
};

export function detectKind(name) {
  const ext = extOf(name);
  for (const [kind, list] of Object.entries(EXT)) if (list.includes(ext)) return kind;
  return 'other';
}

// Machine guess for a single file; null when the file alone is not conclusive.
export function guessMachine(name) {
  const ext = extOf(name);
  if (['stl', '3mf', 'gcode', 'gco', 'bgcode', 'ufp', 'obj', 'amf'].includes(ext)) return '3d';
  if (['lbrn', 'lbrn2', 'xcs'].includes(ext)) return 'laser';
  if (['studio3'].includes(ext)) return 'cutter';
  return null;
}

// Returns { kind, ext, meta, recipe, thumbnail? }; never throws on bad files.
export function parseFile(file, name) {
  const ext = extOf(name);
  const base = { kind: detectKind(name), ext, meta: {}, recipe: {} };
  try {
    let r;
    if (ext === 'gcode' || ext === 'gco') r = parseGcode(file);
    else if (ext === '3mf') r = parseThreeMF(file);
    else if (ext === 'svg') r = parseSvg(file);
    else if (ext === 'lbrn' || ext === 'lbrn2') r = parseLightBurn(file);
    else if (ext === 'stl') r = parseStl(file);
    if (r) Object.assign(base, { meta: r.meta || {}, recipe: r.recipe || {}, thumbnail: r.thumbnail });
  } catch (err) {
    base.meta = { parse_error: String(err.message || err) };
  }
  return base;
}

// "bracket_v3_0.2mm_PLA_MK4_1h2m.gcode" and "Bracket.stl" share the stem "bracket".
export function projectStem(name) {
  const raw = baseOf(name);
  let s = raw;
  // Slicer output appends layer height, material, printer, time: cut at the first "_0.2mm".
  s = s.replace(/[_\-\s]+\d+(\.\d+)?mm(?![a-z0-9]).*$/i, '');
  // Version-ish words only count when they trail the name.
  for (let prev; prev !== s; ) {
    prev = s;
    s = s.replace(/[_\-\s]+(v\d+|final|copy|rev[a-z0-9]*|\(\d+\))$/i, '');
  }
  return s.replace(/[_\-\s]+$/, '') || raw;
}
