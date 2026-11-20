// Shared helpers of the T06 decode dumpers: the SAME Chromium as the golden renders (Playwright's build, else a
// preinstalled one), a static server for app/, and the fixed sample selection. Kept apart from vectors/lib.mjs (T01's).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { writeWavF32 } from '../wav.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../../..');
export const DEFAULT_OUT = path.join(HERE, 'data');

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

function startServer() {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    const base = path.join(ROOT, 'app');
    const file = path.normalize(path.join(base, p));
    if (p === '/' || p === '/__blank.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
      return res.end('<!doctype html><meta charset="utf-8"><title>decode-dump</title>');
    }
    if (!file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { connection: 'close' });
      return res.end();
    }
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.json') ? 'application/json' :
      file.endsWith('.mp3') ? 'audio/mpeg' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, connection: 'close', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

export async function openPage() {
  const server = await startServer();
  const browser = await launch();
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[page]', e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const close = async () => {
    await browser.close();
    server.close();
  };
  return { browser, page, server, version: browser.version(), close };
}

/**
 * The 20 decode samples: 6 sets, 3-4 files each, soft and loud layers where a set has them. Picked deterministically
 * from the factory manifest in the page: {set, layer: 'first'|'last', at: fraction of that layer's note list}.
 * `vec` marks the 6 files that also get processSample vectors (two option variants each).
 */
export const SELECTION = [
  { set: 'salamander-piano', layer: 'first', at: 0.3 }, { set: 'salamander-piano', layer: 'first', at: 0.55, vec: 1 },
  { set: 'salamander-piano', layer: 'last', at: 0.3 }, { set: 'salamander-piano', layer: 'last', at: 0.55, vec: 1 },
  { set: 'upright-piano', layer: 'first', at: 0.3 }, { set: 'upright-piano', layer: 'first', at: 0.7, vec: 1 },
  { set: 'upright-piano', layer: 'last', at: 0.3 }, { set: 'upright-piano', layer: 'last', at: 0.7 },
  { set: 'ep-rhodes', layer: 'first', at: 0.2 }, { set: 'ep-rhodes', layer: 'first', at: 0.5, vec: 1 },
  { set: 'ep-rhodes', layer: 'first', at: 0.8 },
  { set: 'vibes', layer: 'first', at: 0.2 }, { set: 'vibes', layer: 'first', at: 0.5, vec: 1 },
  { set: 'vibes', layer: 'first', at: 0.8 },
  { set: 'harp', layer: 'first', at: 0.2 }, { set: 'harp', layer: 'first', at: 0.5 },
  { set: 'harp', layer: 'first', at: 0.8 },
  { set: 'music-box', layer: 'first', at: 0.2 }, { set: 'music-box', layer: 'first', at: 0.5, vec: 1 },
  { set: 'music-box', layer: 'first', at: 0.8 },
];

/** In-page resolver + decoder (serialised into the page). */
export const PAGE_FN = async ([selection, rates]) => {
  const { normalizeManifest } = await import('/js/engine/sampler.js');
  const { processSample } = await import('/js/engine/sampler.js');
  const json = await (await fetch('/samples/manifest.json')).json();
  const defs = normalizeManifest(json, '/samples/manifest.json');
  const b64 = (f32) => {
    const u8 = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const dump = (buf) => ({ sr: buf.sampleRate, frames: buf.length,
    chs: Array.from({ length: buf.numberOfChannels }, (_, c) => b64(buf.getChannelData(c))) });
  const out = [];
  for (const sel of selection) {
    const def = defs.find((d) => d.id === sel.set);
    const L = sel.layerIdx != null ? def.layers[sel.layerIdx]
      : sel.layer === 'first' ? def.layers[0] : def.layers[def.layers.length - 1];
    const smp = sel.sampleIdx != null ? L.samples[sel.sampleIdx]
      : L.samples[Math.min(L.samples.length - 1, Math.floor(sel.at * L.samples.length))];
    const ab = await (await fetch(smp.url)).arrayBuffer();
    const rec = { ...sel, url: new URL(smp.url, location.href).pathname, midi: smp.midi, opts: def.decodeOpts || null,
      mp3Bytes: ab.byteLength, raw: {}, proc: [] };
    let at44 = null;
    for (const sr of rates) {
      const ctx = new OfflineAudioContext(2, 1, sr);
      const buf = await ctx.decodeAudioData(ab.slice(0));
      rec.raw[sr] = dump(buf);
      if (sr === 44100) at44 = buf;
    }
    if (sel.vec && at44) {
      const loss = def.decodeOpts?.maxMonoLossDb ?? 3;
      const variants = [['def', def.decodeOpts || {}], ['cap', { maxSec: 1.5, maxMonoLossDb: loss }]];
      for (const [name, opts] of variants) {
        const o = processSample(at44, smp.midi, opts);
        const lrDiff = Number.isFinite(o._lrDiff) ? o._lrDiff : null;
        rec.proc.push({ variant: name, opts, ...dump(o), dualMono: o._dualMono, lrDiff,
          onsetTrim: o._onsetTrim, natural: o._natural, capped: o._capped, monoFix: o._monoFix || null,
          channels: o.numberOfChannels });
      }
    }
    out.push(rec);
  }
  return out;
};

/** In-page: every sample of these instrument ids as {set, layerIdx, sampleIdx, midi, url} (dump.mjs --set). */
export const LIST_FN = async (sets) => {
  const { normalizeManifest } = await import('/js/engine/sampler.js');
  const json = await (await fetch('/samples/manifest.json')).json();
  const out = [];
  for (const d of normalizeManifest(json, '/samples/manifest.json')) {
    if (!sets.includes(d.id)) continue;
    d.layers.forEach((L, layerIdx) => L.samples.forEach((smp, sampleIdx) =>
      out.push({ set: d.id, layerIdx, sampleIdx, midi: smp.midi, url: smp.url })));
  }
  return out;
};

export const unb64 = (s) => {
  const b = Buffer.from(s, 'base64');
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
export const sha256 = (chs) => {
  const h = crypto.createHash('sha256');
  for (const c of chs) h.update(Buffer.from(c.buffer, c.byteOffset, c.byteLength));
  return h.digest('hex');
};
export { writeWavF32 };
