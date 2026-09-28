// Shared helpers for the integration suites (test/integration/*.mjs). Not a test file.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '../..');
export const logsDir = path.join(repoRoot, 'test', 'logs');

/** A TCP port that is free on 127.0.0.1 right now. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** true when nothing listens on 127.0.0.1:port. */
export function portIsFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

/** GET http://127.0.0.1:port/path → {status, headers, body} or null on connection error. */
export function httpGet(port, p = '/', { timeout = 2000, headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(null));
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 10000, interval = 100, what = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out after ${timeout} ms waiting for ${what}`);
    await sleep(interval);
  }
}

export const hasXvfb = () => process.platform === 'linux' && spawnSync('which', ['xvfb-run']).status === 0;

/**
 * Environment for launching Electron from a test: the caller's env plus `extra`, minus ELECTRON_RUN_AS_NODE.
 * L-1: a shell started from an Electron host (VS Code's terminal, the Claude desktop app) inherits
 * ELECTRON_RUN_AS_NODE=1, and then `npx electron .` runs main.js as plain Node: require('electron').app is
 * undefined and main.js dies at its first app.setPath() before any self-test report.
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string>}
 */
export function electronEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/**
 * Real app/ exposed through a throw-away directory: every entry of app/ is a symlink to the real one, only
 * index.html is a copy with one extra `<script type="module" src="./__it/probe.js">` after the app's own
 * bootstrap. The CSP (script-src 'self') allows it because the probe is served from the same origin.
 */
export function buildAppWrapper(probeSource, { prefix = 'rig-it-' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const app = path.join(tmp, 'app');
  fs.mkdirSync(app);
  const src = path.join(repoRoot, 'app');
  for (const f of fs.readdirSync(src)) {
    if (f === 'index.html') continue;
    fs.symlinkSync(path.join(src, f), path.join(app, f));
  }
  const html = fs.readFileSync(path.join(src, 'index.html'), 'utf8');
  const tag = '<script type="module" src="./__it/probe.js"></script>\n';
  if (!html.includes('</body>')) throw new Error('app/index.html has no </body>; cannot inject the probe');
  fs.writeFileSync(path.join(app, 'index.html'), html.replace('</body>', `${tag}</body>`));
  fs.mkdirSync(path.join(app, '__it'));
  fs.writeFileSync(path.join(app, '__it', 'probe.js'), probeSource);
  const dirs = { userData: path.join(tmp, 'userData'), recordings: path.join(tmp, 'recordings'), pads: path.join(tmp, 'pads') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  return { tmp, app, ...dirs, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

/** Parse + sanity-check a 16-bit PCM WAV buffer. Returns {channels, sampleRate, bits, dataBytes, seconds, peak, rmsDb, ok, problems[]}. */
export function inspectWav(buf) {
  const problems = [];
  const str = (o, n) => buf.toString('ascii', o, o + n);
  if (buf.length < 44) return { ok: false, problems: [`only ${buf.length} bytes`] };
  if (str(0, 4) !== 'RIFF') problems.push('no RIFF');
  if (str(8, 4) !== 'WAVE') problems.push('no WAVE');
  if (buf.readUInt32LE(4) !== buf.length - 8) problems.push(`RIFF size ${buf.readUInt32LE(4)} ≠ file−8 ${buf.length - 8}`);
  // walk chunks
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = str(off, 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), sampleRate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === 'data') {
      data = { off: off + 8, size };
      break;
    }
    off += 8 + size + (size & 1);
  }
  if (!fmt) return { ok: false, problems: [...problems, 'no fmt chunk'] };
  if (!data) return { ok: false, problems: [...problems, 'no data chunk'] };
  if (fmt.format !== 1) problems.push(`format ${fmt.format} ≠ PCM`);
  if (fmt.bits !== 16) problems.push(`${fmt.bits}-bit`);
  if (data.off + data.size !== buf.length) problems.push(`data size ${data.size} ≠ remaining ${buf.length - data.off}`);
  const n = Math.floor(Math.min(data.size, buf.length - data.off) / 2);
  const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset + data.off, buf.byteOffset + data.off + n * 2));
  let peak = 0;
  let ss = 0;
  for (const v of pcm) {
    const a = Math.abs(v);
    if (a > peak) peak = a;
    ss += v * v;
  }
  const rmsDb = 20 * Math.log10(Math.sqrt(ss / Math.max(1, n)) / 32768 + 1e-12);
  const seconds = data.size / (fmt.channels * 2) / fmt.sampleRate;
  return { ...fmt, dataBytes: data.size, seconds, peak, rmsDb, ok: problems.length === 0, problems };
}

/** node:test-free mini harness: check(name, ok, info) + summary + exit code. */
export function checker(label) {
  const results = [];
  const check = (name, ok, info = '') => {
    results.push({ name, ok: !!ok, info });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  — ${typeof info === 'string' ? info : JSON.stringify(info)}` : ''}`);
    return !!ok;
  };
  const skip = (name, why) => {
    results.push({ name, ok: true, skipped: true, info: why });
    console.log(`SKIP  ${name}  — ${why}`);
  };
  const finish = () => {
    const failed = results.filter((r) => !r.ok);
    const skipped = results.filter((r) => r.skipped).length;
    console.log(`\n${label}: ${results.length - failed.length - skipped}/${results.length - skipped} passed${skipped ? `, ${skipped} skipped` : ''}, ${failed.length} failed`);
    for (const f of failed) console.log(`  FAILED: ${f.name}`);
    return failed.length ? 1 : 0;
  };
  return { check, skip, finish, results };
}

/** In-page helpers (stringified into page.evaluate / the Electron probe): peak-of-channels RMS from the engine analysers + NaN flag. */
export const PAGE_METER_SRC = `
  function __itMeter(engine) {
    let worst = -Infinity, nan = false;
    for (const an of [engine.analyserL, engine.analyserR]) {
      if (!an) continue;
      const buf = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (let i = 0; i < buf.length; i++) { const v = buf[i]; if (!Number.isFinite(v)) nan = true; else s += v * v; }
      const db = 10 * Math.log10(s / buf.length + 1e-20);
      if (db > worst) worst = db;
    }
    return { db: worst, nan };
  }`;
