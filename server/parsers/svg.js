import fs from 'node:fs';

const UNIT_MM = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, '': 25.4 / 96 };

function toMm(v) {
  const m = String(v || '').trim().match(/^([\d.]+)\s*([a-z%]*)$/i);
  if (!m || m[2] === '%') return undefined;
  const f = UNIT_MM[m[2].toLowerCase()];
  return f === undefined ? undefined : Math.round(parseFloat(m[1]) * f * 100) / 100;
}

export function parseSvgText(str) {
  const tag = str.match(/<svg\b[^>]*>/i)?.[0] || '';
  const attr = (n) => tag.match(new RegExp(`\\s${n}\\s*=\\s*"([^"]*)"`, 'i'))?.[1];
  let w = toMm(attr('width')), h = toMm(attr('height'));
  const vb = attr('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if ((w === undefined || h === undefined) && vb?.length === 4) {
    w ??= Math.round(vb[2] * UNIT_MM.px * 100) / 100;
    h ??= Math.round(vb[3] * UNIT_MM.px * 100) / 100;
  }
  const strokes = new Set();
  for (const m of str.matchAll(/stroke\s*[:=]\s*"?(#[0-9a-f]{3,8})\b/gi)) strokes.add(m[1].toLowerCase());
  const meta = {
    paths: (str.match(/<path\b/gi) || []).length,
    stroke_colors: [...strokes].slice(0, 12),
    title: str.match(/<title[^>]*>([^<]*)</i)?.[1]?.trim() || undefined,
  };
  if (w !== undefined && h !== undefined) { meta.width_mm = w; meta.height_mm = h; }
  const generator = /inkscape:version="([^"]+)"/.exec(str)?.[1];
  if (generator) meta.generator = `Inkscape ${generator}`;
  const recipe = {};
  if (w !== undefined && h !== undefined) recipe.design_size_mm = `${w} x ${h}`;
  return { meta, recipe };
}

export function parseSvg(file) {
  const size = fs.statSync(file).size;
  if (size > 20e6) return { meta: { skipped: 'too large to inspect' }, recipe: {} };
  return parseSvgText(fs.readFileSync(file, 'utf8'));
}
