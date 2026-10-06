// Builds jigbook.html: the whole app in ONE file. Open it in a browser and it works —
// no server, no install. Data is kept in the browser's IndexedDB.
//   npm run build:html
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p) => path.join(root, ...p);

// The UI imports "./backend.js" (talks to the server). In the HTML edition that resolves to the
// browser backend instead, and Node built-ins that the shared parsers merely import are stubbed out.
const browserEdition = {
  name: 'browser-edition',
  setup(b) {
    b.onResolve({ filter: /^\.\/backend\.js$/ }, (a) => (a.importer === at('public', 'app.js') ? { path: at('browser', 'backend-local.js') } : null));
    b.onResolve({ filter: /^node:/ }, (a) => ({ path: a.path, namespace: 'node-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'node-stub' }, () => ({ contents: 'export default {};', loader: 'js' }));
  },
};

export async function buildHtml() {
  const result = await build({
    entryPoints: [at('public', 'app.js')],
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', minify: true, legalComments: 'none',
    plugins: [browserEdition], logLevel: 'warning',
  });
  const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const css = fs.readFileSync(at('public', 'style.css'), 'utf8');
  let config = {};
  try { config = JSON.parse(fs.readFileSync(at('jigbook.config.json'), 'utf8')); } catch { /* optional */ }

  let html = fs.readFileSync(at('public', 'index.html'), 'utf8');
  const swap = (from, to) => { if (!html.includes(from)) throw new Error(`index.html changed: could not find ${from}`); html = html.replace(from, () => to); };
  swap('<link rel="stylesheet" href="style.css">', `<style>\n${css}</style>`);
  swap('<script type="module" src="app.js"></script>',
    `<script>window.JIGBOOK_CONFIG = ${JSON.stringify(config).replace(/</g, '\\u003c')};</script>\n<script>${js}</script>`);
  return html;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const html = await buildHtml();
  fs.writeFileSync(at('jigbook.html'), html);
  // docs/ is what GitHub Pages serves: the landing page's Download button points at this copy.
  fs.mkdirSync(at('docs'), { recursive: true });
  fs.writeFileSync(at('docs', 'jigbook.html'), html);
  console.log(`Built jigbook.html and docs/jigbook.html (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`);
}
