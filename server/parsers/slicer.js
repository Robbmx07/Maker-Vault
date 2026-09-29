// Normalises the many spellings slicers use into one flat "recipe" vocabulary.
const first = (v) => (Array.isArray(v) ? v[0] : v);
const clean = (v) => {
  v = first(v);
  if (v === undefined || v === null) return undefined;
  v = String(v).trim().replace(/^"(.*)"$/, '$1');
  return v === '' ? undefined : v;
};

export const keyify = (k) => k.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

export function normalizeSlicerSettings(bag) {
  const pick = (...keys) => {
    for (const k of keys) {
      const v = clean(bag[k]);
      if (v !== undefined) return v;
    }
  };
  const out = {};
  const set = (k, v) => { if (v !== undefined) out[k] = v; };
  set('slicer', pick('slicer'));
  set('printer', pick('printer_model', 'printer_settings_id', 'machine_name'));
  set('profile', pick('print_settings_id'));
  set('filament_type', pick('filament_type', 'material'));
  set('filament_profile', pick('filament_settings_id'));
  set('layer_height', pick('layer_height'));
  set('nozzle_diameter', pick('nozzle_diameter'));
  set('nozzle_temp', pick('nozzle_temperature', 'temperature', 'material_print_temperature', 'print_temperature'));
  set('bed_temp', pick('bed_temperature', 'hot_plate_temp', 'material_bed_temperature'));
  set('infill', pick('fill_density', 'sparse_infill_density', 'infill_sparse_density'));
  set('walls', pick('perimeters', 'wall_loops', 'wall_line_count'));
  set('supports', pick('support_material', 'enable_support', 'support_enable'));
  set('print_time', pick('estimated_printing_time_normal_mode', 'print_time'));
  set('filament_used_g', pick('total_filament_weight_g', 'filament_used_g'));
  return out;
}
