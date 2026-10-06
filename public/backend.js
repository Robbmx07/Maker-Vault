// Server backend: the UI talks to the local CubbyBench server over HTTP.
// (The single-file HTML build swaps this module for one that stores everything in the browser.)
export const local = false;

export async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof Blob || body instanceof ArrayBuffer) {
    opts.body = body;
    opts.headers['Content-Type'] = 'application/octet-stream';
  } else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function saveFrom(href, filename) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
}

// The original bytes of a stored file, for previews.
export async function fileBytes(file) {
  const res = await fetch(`/api/files/${file.id}/raw`);
  if (!res.ok) throw new Error(`Could not load ${file.name} (${res.status})`);
  return res.arrayBuffer();
}
export async function downloadFile(file) { saveFrom(`/api/files/${file.id}/raw?download=1`, file.name); }
export async function exportProject(id) { saveFrom(`/api/projects/${id}/export`, ''); }
