import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildHtml } from '../build/build-html.mjs';

const html = await buildHtml();

test('committed jigbook.html matches the sources (run `npm run build:html`)', () => {
  assert.equal(fs.readFileSync(new URL('../jigbook.html', import.meta.url), 'utf8'), html);
});

test('the copy the website serves (docs/jigbook.html) is identical', () => {
  assert.equal(fs.readFileSync(new URL('../docs/jigbook.html', import.meta.url), 'utf8'), html);
});

test('the landing page download button points at files that exist', () => {
  const page = fs.readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
  const visible = page.replace(/<!--[\s\S]*?-->/g, '');
  const targets = [...visible.matchAll(/href="([^"#]+)"/g)].map((m) => m[1]).filter((h) => !/^(https?:|data:|mailto:)/.test(h));
  assert.ok(targets.includes('jigbook.html') && targets.includes('tutorial.pdf'));
  for (const t of new Set(targets)) assert.ok(fs.existsSync(new URL(`../docs/${t}`, import.meta.url)), `docs/${t} is missing`);
  assert.doesNotMatch(visible, /<mark/, 'no unfilled placeholders are visible on the public page');
});

test('the visit counter is on the landing page only, and the app stays tracker-free', () => {
  const page = fs.readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
  assert.match(page, /data-goatcounter="https:\/\/maker-vault\.goatcounter\.com\/count"/, 'landing page has the counter');
  assert.match(page, /sets no cookies/, 'and says so on the page');
  // the promise to users: the app itself collects nothing and calls out to nothing
  assert.doesNotMatch(html, /goatcounter|gc\.zgo\.at|analytics/i, 'no counter or analytics inside the app');
  for (const f of ['public/app.js', 'public/backend.js', 'browser/backend-local.js']) {
    assert.doesNotMatch(fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), /goatcounter|gc\.zgo\.at/i, `${f} must not reference a counter`);
  }
});

test('the HTML edition is one self-contained file', () => {
  assert.doesNotMatch(html, /<script[^>]+\bsrc=/i, 'no external scripts');
  assert.doesNotMatch(html, /<link[^>]+stylesheet/i, 'no external stylesheets');
  assert.doesNotMatch(html, /node:(fs|path|zlib|http|sqlite)/, 'no Node built-ins leaked into the bundle');
  assert.doesNotMatch(html, /fetch\(/, 'the browser edition never calls a server');
  assert.match(html, /indexedDB/);
});
