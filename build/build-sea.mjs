// Builds a single-file executable for the platform this script runs on.
//   npm run build:sea   ->  dist/maker-vault-<platform>-<arch>[.exe]
// Cross-compiling is not possible (the executable embeds this machine's Node binary),
// so the release workflow runs this once per operating system.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { inject } from 'postject';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

// 1. One CommonJS file (SEA cannot load ES modules or node_modules).
const bundle = path.join(dist, 'vault.cjs');
await build({
  entryPoints: [path.join(root, 'server/index.js')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': '__importMetaUrl' },
  logLevel: 'warning',
});

// 2. Embed the UI (and the optional branding config) as assets.
const assets = {};
for (const f of fs.readdirSync(path.join(root, 'public'))) assets[f] = path.join('public', f);
const brand = path.join(root, 'maker-vault.config.json');
if (fs.existsSync(brand)) { assets['maker-vault.config.json'] = 'maker-vault.config.json'; console.log('Embedding branding from maker-vault.config.json'); }
const blob = path.join(dist, 'sea-prep.blob');
const seaConfig = path.join(dist, 'sea-config.json');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: path.relative(root, bundle), output: path.relative(root, blob), disableExperimentalSEAWarning: true, assets,
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', path.relative(root, seaConfig)], { cwd: root, stdio: 'inherit' });

// 3. Copy this platform's node binary and inject the blob into it.
const win = process.platform === 'win32';
const out = path.join(dist, `maker-vault-${process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'}-${process.arch}${win ? '.exe' : ''}`);
fs.copyFileSync(process.execPath, out);
fs.chmodSync(out, 0o755);
if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', out], { stdio: 'inherit' });
await inject(out, 'NODE_SEA_BLOB', fs.readFileSync(blob), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}),
});
// macOS refuses to run modified binaries unless they carry at least an ad-hoc signature.
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', out], { stdio: 'inherit' });

for (const f of ['vault.cjs', 'sea-prep.blob', 'sea-config.json']) fs.rmSync(path.join(dist, f));
console.log(`\nBuilt ${path.relative(root, out)}  (${(fs.statSync(out).size / 1048576).toFixed(0)} MB)`);
