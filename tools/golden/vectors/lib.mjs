// Shared helpers of the vector dumpers (tools/golden/vectors/*.mjs, T01): launch the SAME Chromium the golden renders
// use (tools/golden/render.mjs `launch()`: Playwright's own build, else a preinstalled one under
// PLAYWRIGHT_BROWSERS_PATH / /opt/pw-browsers), serve app/ so pages can import the real engine modules, and encode
// doubles / floats as exact hex bit patterns.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../../..');
export const DATA = path.join(HERE, 'data');

/** Same search order as tools/golden/render.mjs launch(). */
export async function launch() {
  const args = ['--autoplay-policy=no-user-gesture-required'];
  try {
    return await chromium.launch({ headless: true, args });
  } catch (e) {
    const roots = [process.env.GOLDEN_CHROMIUM, process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers',
      path.join(os.homedir(), '.cache/ms-playwright')].filter(Boolean);
    for (const r of roots) {
      if (fs.existsSync(r) && fs.statSync(r).isFile()) {
        return chromium.launch({ headless: true, args, executablePath: r });
      }
      if (!fs.existsSync(r)) continue;
      for (const d of fs.readdirSync(r).sort().reverse()) {
        for (const sub of ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/headless_shell',
          'chrome-linux64/chrome', 'chrome-linux/chrome']) {
          const exe = path.join(r, d, sub);
          if (fs.existsSync(exe)) return chromium.launch({ headless: true, args, executablePath: exe });
        }
      }
    }
    throw e;
  }
}

/** Static server: app/ at /, tools/golden/vectors/ at /__vectors/. */
export function startServer() {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.json': 'application/json' };
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    let base = path.join(ROOT, 'app');
    let rel = p;
    if (p.startsWith('/__vectors/')) {
      base = HERE;
      rel = p.slice('/__vectors'.length);
    }
    const file = path.normalize(path.join(base, rel === '/' ? '/__blank.html' : rel));
    if (rel === '/' || rel === '/__blank.html') {
      res.writeHead(200, { 'content-type': MIME['.html'], connection: 'close' });
      return res.end('<!doctype html><meta charset="utf-8"><title>vectors</title>');
    }
    if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { connection: 'close' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', connection: 'close',
      'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

/** Open a page on the local server; returns {browser, page, server, version}. */
export async function openPage() {
  const server = await startServer();
  const browser = await launch();
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[page]', e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  return { browser, page, server, version: browser.version() };
}

const f64 = new Float64Array(1);
const u64 = new BigUint64Array(f64.buffer);
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
/** Exact bit pattern of a double, 16 lowercase hex digits. */
export function hex64(x) {
  f64[0] = x;
  return u64[0].toString(16).padStart(16, '0');
}
export function fromHex64(h) {
  u64[0] = BigInt('0x' + h);
  return f64[0];
}
/** Exact bit pattern of a float32, 8 hex digits. */
export function hex32(x) {
  f32[0] = x;
  return u32[0].toString(16).padStart(8, '0');
}

/** mulberry32 (shared/prng.js) for input generation; independent of the app import so the inputs never drift. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function arg(argv, k, d) {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
}
