import fs from 'node:fs';

// LightBurn .lbrn/.lbrn2 are XML; each <CutSetting> is one layer.
export function parseLightBurnText(xml) {
  const recipe = {};
  const layers = [];
  const blocks = xml.split(/<CutSetting\b/).slice(1);
  for (const b of blocks) {
    const body = b.split('</CutSetting>')[0];
    const v = (name) => body.match(new RegExp(`<${name}\\s+Value="([^"]*)"`))?.[1];
    const type = body.match(/^\s+type="([^"]*)"/)?.[1] || b.match(/^[^>]*type="([^"]*)"/)?.[1];
    const layer = {
      index: v('index'), name: v('name'), mode: type,
      speed: v('speed'), power: v('maxPower'), min_power: v('minPower'), passes: v('numPasses'),
      interval: v('interval'),
    };
    layers.push(layer);
    const p = `layer_${layer.index ?? layers.length - 1}`;
    if (layer.mode) recipe[`${p}_mode`] = layer.mode;
    if (layer.speed) recipe[`${p}_speed_mm_s`] = layer.speed;
    if (layer.power) recipe[`${p}_power_pct`] = layer.power;
    if (layer.passes && layer.passes !== '1') recipe[`${p}_passes`] = layer.passes;
    if (layer.interval && layer.mode !== 'Cut') recipe[`${p}_interval_mm`] = layer.interval;
  }
  const device = xml.match(/<LightBurnProject[^>]*\bDevice(?:Name)?="([^"]*)"/)?.[1];
  if (device) recipe.device = device;
  return { meta: { layers: layers.length }, recipe };
}

export function parseLightBurn(file) {
  if (fs.statSync(file).size > 50e6) return { meta: { skipped: 'too large to inspect' }, recipe: {} };
  return parseLightBurnText(fs.readFileSync(file, 'utf8'));
}
