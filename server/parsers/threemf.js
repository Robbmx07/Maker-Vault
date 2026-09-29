import { listZip, readZipEntry } from '../zip.js';
import { keyify, normalizeSlicerSettings } from './slicer.js';

const utf8 = new TextDecoder();

function parseSemicolonConfig(str) {
  const bag = {};
  for (const line of str.split(/\r?\n/)) {
    const m = line.match(/^;\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) bag[m[1]] = m[2];
  }
  return bag;
}

// Which zip entries are worth reading? entries: [{ name, usize }]. Shared by Node and browser readers.
export function planThreeMF(entries) {
  const by = (n, max) => { const e = entries.find((x) => x.name === n); return e && (!max || e.usize < max) ? n : null; };
  const thumb = ['Metadata/plate_1.png', 'Metadata/thumbnail.png', 'Metadata/top_1.png'].map((n) => by(n, 5e6)).find(Boolean)
    || entries.find((e) => /^Metadata\/.*\.png$/i.test(e.name) && e.usize < 5e6)?.name || null;
  return {
    model: by('3D/3dmodel.model'), // only the head is read: metadata sits at the top
    prusa: by('Metadata/Slic3r_PE.config', 4e6),
    bambu: by('Metadata/project_settings.config', 4e6),
    slice: by('Metadata/slice_info.config', 1e6),
    thumb,
  };
}

export const THREEMF_MODEL_HEAD = 64 * 1024;

// parts: { model, prusa, bambu, slice } as strings (or null) and { thumbnail } as bytes (or null).
export function parseThreeMFParts(parts) {
  const bag = {};
  const meta = {};
  if (parts.model) {
    for (const m of parts.model.matchAll(/<metadata name="([^"]+)"[^>]*>([^<]*)</g)) meta[keyify(m[1])] = m[2].trim();
    if (meta.application) bag.slicer = meta.application;
  }
  if (parts.prusa) Object.assign(bag, parseSemicolonConfig(parts.prusa)); // PrusaSlicer / SuperSlicer
  if (parts.bambu) { try { Object.assign(bag, JSON.parse(parts.bambu)); } catch { /* ignore */ } } // Bambu Studio / Orca
  if (parts.slice) {
    const pred = parts.slice.match(/key="prediction"\s+value="(\d+)"/);
    const weight = parts.slice.match(/key="weight"\s+value="([\d.]+)"/);
    if (pred) bag.print_time = `${Math.floor(pred[1] / 3600)}h ${Math.floor((pred[1] % 3600) / 60)}m`;
    if (weight) bag.total_filament_weight_g = weight[1];
  }
  return {
    recipe: normalizeSlicerSettings(bag),
    meta: { title: meta.title, designer: meta.designer, license: meta.licensetterms || meta.license, application: meta.application },
    thumbnail: parts.thumbnail || undefined,
  };
}

export function parseThreeMF(file) {
  const entries = listZip(file);
  const plan = planThreeMF(entries);
  const read = (name, opts) => {
    if (!name) return null;
    try { return readZipEntry(file, entries.find((e) => e.name === name), opts); } catch { return null; }
  };
  const str = (name, opts) => { const b = read(name, opts); return b ? utf8.decode(b) : null; };
  return parseThreeMFParts({
    model: str(plan.model, { head: THREEMF_MODEL_HEAD }), prusa: str(plan.prusa), bambu: str(plan.bambu),
    slice: str(plan.slice), thumbnail: read(plan.thumb),
  });
}
