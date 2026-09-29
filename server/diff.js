// Compare two flat settings objects (run vs run, or recipe vs recipe).
export function diffSettings(a = {}, b = {}) {
  const changed = [], added = [], removed = [];
  let same = 0;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const inA = key in a, inB = key in b;
    if (inA && inB) {
      if (String(a[key]) === String(b[key])) same++;
      else changed.push({ key, a: a[key], b: b[key] });
    } else if (inB) added.push({ key, b: b[key] });
    else removed.push({ key, a: a[key] });
  }
  const byKey = (x, y) => x.key.localeCompare(y.key);
  return { changed: changed.sort(byKey), added: added.sort(byKey), removed: removed.sort(byKey), same };
}
