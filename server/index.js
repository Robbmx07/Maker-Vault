import './quiet.js'; // must stay first: silences the node:sqlite experimental warning
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { isStandalone, readAsset } from './assets.js';

const devRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const exeDir = path.dirname(process.execPath);
const host = process.env.HOST || '127.0.0.1';
const basePort = Number(process.env.PORT || 4747);
const localOnly = host === '127.0.0.1' || host === 'localhost';

// Where the library lives:
//   VAULT_DATA env var > a "data" folder next to the program (portable mode) > per-user folder > ./data (dev)
function resolveDataDir() {
  if (process.env.VAULT_DATA) return path.resolve(process.env.VAULT_DATA);
  if (!isStandalone) return path.join(devRoot, 'data');
  const portable = path.join(exeDir, 'data');
  if (fs.existsSync(portable)) return portable;
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'MakerVault');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'MakerVault');
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'maker-vault');
}

// Branding: a config file next to the program wins; otherwise the one baked in at build time.
function loadConfig() {
  const name = 'maker-vault.config.json';
  for (const file of [path.join(isStandalone ? exeDir : devRoot, name), path.join(process.cwd(), name)]) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* try next */ }
  }
  try { const b = readAsset(name); if (b) return JSON.parse(b.toString('utf8')); } catch { /* ignore */ }
  return {};
}

function openBrowser(url) {
  if (process.env.VAULT_NO_OPEN) return;
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {}); // no desktop / no opener: the URL is printed anyway
    child.unref();
  } catch { /* ignore */ }
}

// Is whatever answers on this port another Maker Vault?
function isVault(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/config', timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(Array.isArray(JSON.parse(body).machines)); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function tryListen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (e) => reject(e);
    server.once('error', onError);
    server.listen(port, host, () => { server.off('error', onError); resolve(); });
  });
}

async function main() {
  const dataDir = resolveDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  const db = openDb(path.join(dataDir, 'vault.db'));
  const server = createApp(db, { dataDir, config: loadConfig(), allowRemote: !localOnly });

  let port = basePort;
  for (let attempt = 0; attempt < 10; attempt++, port++) {
    try {
      await tryListen(server, port);
      const url = `http://${localOnly ? '127.0.0.1' : 'localhost'}:${port}`;
      console.log(`\n  Maker Vault is running at ${url}`);
      console.log(`  Your library is stored in: ${dataDir}`);
      console.log('  Keep this window open while you use it. Close it (or press Ctrl+C) to quit.\n');
      openBrowser(url);
      return;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      // Same library, so never run a second copy: just open the one that is already up.
      if (await isVault(port)) {
        console.log(`\n  Maker Vault is already running at http://127.0.0.1:${port} — opening it.\n`);
        openBrowser(`http://127.0.0.1:${port}`);
        db.close();
        return;
      }
    }
  }
  throw new Error(`No free port found between ${basePort} and ${basePort + 9}. Set PORT to use another.`);
}

main().catch((e) => {
  console.error(`\n  Maker Vault could not start: ${e.message}\n`);
  if (process.platform === 'win32' && isStandalone) setTimeout(() => process.exit(1), 15000); // keep the message readable
  else process.exit(1);
});
