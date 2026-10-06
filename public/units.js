// Weight units. Amounts are always stored in grams; the unit only changes what
// you see and type, so switching never alters your data and old backups stay valid.

export const G_PER_OZ = 28.349523125;
export const G_PER_LB = 453.59237;

const KEY = 'jigbook-unit';
let unit = 'g';
try { if ((localStorage.getItem(KEY) ?? localStorage.getItem('maker-vault-unit')) === 'oz') unit = 'oz'; } catch { /* storage blocked: default to grams */ }

export const getUnit = () => unit;
export function setUnit(u) {
  unit = u === 'oz' ? 'oz' : 'g';
  try { localStorage.setItem(KEY, unit); } catch { /* not saved, still applies this session */ }
}

const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;
const blank = (v) => v === '' || v === null || v === undefined || Number.isNaN(Number(v));

// weight: grams <-> the chosen unit
export function showWeight(g, u = unit) { return blank(g) ? '' : u === 'oz' ? round(Number(g) / G_PER_OZ, 2) : round(Number(g), 2); }
export function weightToGrams(v, u = unit) { return blank(v) ? '' : u === 'oz' ? round(Number(v) * G_PER_OZ, 2) : Number(v); }

// price: dollars per gram <-> dollars per chosen unit
export function showPrice(perG, u = unit) { return blank(perG) ? '' : u === 'oz' ? round(Number(perG) * G_PER_OZ, 4) : round(Number(perG), 5); }
export function priceToPerGram(v, u = unit) { return blank(v) ? '' : u === 'oz' ? round(Number(v) / G_PER_OZ, 6) : Number(v); }

export const weightLabel = (g, u = unit) => (blank(g) ? '' : `${showWeight(g, u)} ${u}`);
export const priceLabel = (perG, u = unit) => (blank(perG) ? '' : `$${showPrice(perG, u)}/${u}`);

// converter: any weight to all common units
export function convertWeight(value, from) {
  if (blank(value)) return null;
  const grams = from === 'oz' ? Number(value) * G_PER_OZ : from === 'lb' ? Number(value) * G_PER_LB : from === 'kg' ? Number(value) * 1000 : Number(value);
  return { g: round(grams, 2), oz: round(grams / G_PER_OZ, 2), lb: round(grams / G_PER_LB, 3), kg: round(grams / 1000, 3) };
}
