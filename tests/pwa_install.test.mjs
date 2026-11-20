import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const read = (name) => readFileSync(new URL(name, root), 'utf8');
const root_ = (name) => new URL(name, root);

const manifestPath = 'openteamily/static/manifest.webmanifest';
const manifest = () => JSON.parse(read(manifestPath));

test('the install manifest makes /space installable as a standalone app', () => {
  const data = manifest();
  assert.equal(data.name, 'OpenTeamily', 'the installed app is named OpenTeamily');
  assert.equal(data.short_name, 'Teamily', 'the launcher label stays short');
  assert.equal(data.start_url, '/space',
    'installing from the site opens the works library, not the marketing home page');
  assert.equal(data.scope, '/', 'the installed app may navigate every same-origin page');
  assert.equal(data.display, 'standalone',
    'the installed app opens in its own window instead of a browser tab');
  assert.ok(Array.isArray(data.icons) && data.icons.length > 0, 'the manifest lists at least one icon');
});

test('the manifest colours are the colours this shell actually paints', () => {
  const shell = read('openteamily/static/shell/app.css');
  const value = (name) => {
    const found = shell.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
    assert.ok(found, `the shell palette still defines --${name}`);
    return found[1].toLowerCase();
  };
  const data = manifest();
  assert.equal(data.theme_color.toLowerCase(), value('ot-rail-bg'),
    'the manifest theme colour matches the rail colour the shell paints');
  assert.equal(data.background_color.toLowerCase(), value('ot-bg'),
    'the manifest background colour matches the page background the shell paints');
});

test('every icon the manifest names exists in this repository', () => {
  for (const icon of manifest().icons) {
    assert.match(icon.src, /^\//, `icon paths are served from the site root: ${icon.src}`);
    const file = root_(`openteamily/static${icon.src}`);
    assert.ok(existsSync(file), `the manifest names an icon this repository does not ship: ${icon.src}`);
    assert.ok(statSync(file).size > 0, `the shipped icon is empty: ${icon.src}`);
    if (icon.type === 'image/png') {
      const bytes = readFileSync(file);
      assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47],
        `a PNG icon must really be a PNG: ${icon.src}`);
      assert.equal(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`, icon.sizes,
        `the PNG must really measure ${icon.sizes}: ${icon.src}`);
    }
  }
  const sizes = manifest().icons.map((icon) => icon.sizes);
  assert.ok(sizes.includes('192x192'), 'the manifest carries a 192px icon');
  assert.ok(sizes.includes('512x512'), 'the manifest carries a 512px icon');
});

test('the host serves the manifest, the worker and the icons from its exact allowlist', () => {
  const host = read('openteamily/settings_page.py');
  const entries = {
    '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
    '/sw.js': ['sw.js', 'text/javascript'],
    '/icon.svg': ['icon.svg', 'image/svg+xml'],
    '/icon-192.png': ['icon-192.png', 'image/png'],
    '/icon-512.png': ['icon-512.png', 'image/png'],
  };
  for (const [route, [file, mime]] of Object.entries(entries)) {
    const line = host.split('\n').find((row) => row.includes(`'${route}'`));
    assert.ok(line, `the host allowlist does not serve ${route}`);
    assert.match(line, new RegExp(`'${file.replace(/\./g, '\\.')}'`),
      `${route} must map to the file ${file}`);
    assert.match(line, new RegExp(mime.replace(/\+/g, '\\+')),
      `${route} must be served as ${mime}`);
    assert.ok(existsSync(root_(`openteamily/static/${file}`)),
      `the allowlist serves ${file}, but this repository does not ship it`);
  }
});

test('the page policy lets the browser load a manifest and run a worker', () => {
  const host = read('openteamily/settings_page.py');
  const csp = host.match(/CSP = \(([^)]*)\)/);
  assert.ok(csp, 'the host still declares one page CSP');
  const text = csp[1];
  assert.match(text, /manifest-src 'self'/, 'CSP must allow the manifest from this origin');
  assert.match(text, /worker-src 'self'/, 'CSP must allow the service worker from this origin');
});

test('the install target page links its manifest, theme colour and worker', () => {
  const page = read('openteamily/static/artifacts/index.html');
  assert.match(page, /<link rel="manifest" href="\/manifest\.webmanifest">/,
    'the /space page must declare the install manifest');
  assert.match(page, /<meta name="theme-color" content="#[0-9a-fA-F]{6}">/,
    'the /space page must paint its own browser chrome colour');
  const script = read('openteamily/static/artifacts/app.mjs');
  assert.match(script, /serviceWorker\.register\('\/sw\.js'\)/,
    'the /space page must register the service worker');
});

test('the worker claims its clients and answers an offline navigation with a page', () => {
  const worker = read('openteamily/static/sw.js');
  assert.match(worker, /addEventListener\('install'/, 'the worker handles install');
  assert.match(worker, /addEventListener\('activate'/, 'the worker handles activate');
  assert.match(worker, /clients\.claim\(\)/, 'the worker claims open pages on activate');
  assert.match(worker, /addEventListener\('fetch'/, 'the worker handles fetch');
  assert.match(worker, /request\.mode === 'navigate'/, 'the worker recognises page navigations');
  assert.match(worker, /text\/html/, 'the offline answer is a real page, not a blank response');
  assert.doesNotMatch(worker, /caches\.open/,
    'the worker must not precache HTML: a stale shell would outlive a deployment');
});
