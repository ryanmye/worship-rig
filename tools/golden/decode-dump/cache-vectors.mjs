#!/usr/bin/env node
// T06 cache accounting vectors: what the JS engine's BufferCache reports for the FACTORY songs, so the native cache
// can be checked byte for byte (contract 1.2 estimatePreloadMB, SETUP_REVIEW 20). Written to
// <out>/cache-vectors.json (default tools/golden/decode-dump/data/):
//   songs[]   {id, patch, samplers[], fresh:{mb,exact,samples,capMB}, after:{...}}  fresh = nothing decoded yet
//             (every sample at the 1.75 MB default); after = once `preloaded` songs were decoded (exact sizes for
//             those, the folder-mean estimate for siblings, the default for the rest)
//   all       the same two estimates for every song at once (shared samples counted once)
//   preloaded song ids decoded between the two (pin 'none'); sizes {path: float32 bytes} of what the cache holds
// Usage: node tools/golden/decode-dump/cache-vectors.mjs [--out <dir>] [--n 3]
import fs from 'node:fs';
import path from 'node:path';
import { openPage, DEFAULT_OUT } from './lib.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const OUT = path.resolve(arg('--out', DEFAULT_OUT));
const N = Number(arg('--n', 3));

const { page, version, close } = await openPage();
const res = await page.evaluate(async (n) => {
  const { AudioEngine } = await import('/js/engine/audio.js');
  const { FACTORY_SONGS } = await import('/js/presets.js');
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 44100, sampleRate: 44100 });
  const e = new AudioEngine({ context: ctx, seed: 7, manifestUrl: '/samples/manifest.json', instrumentModules: false });
  await e.start();
  const songs = FACTORY_SONGS.map((s) => ({ id: s.id, patch: JSON.parse(JSON.stringify(s.patch)) }));
  for (const s of songs) {
    s.samplers = [...new Set((s.patch.slots || []).filter((x) => x && x.instrument.type === 'sampler').map((x) => x.instrument.id))];
    s.fresh = await e.estimatePreloadMB([s.patch]);
  }
  const all = { fresh: await e.estimatePreloadMB(songs.map((s) => s.patch)) };
  const withSamples = songs.filter((s) => s.fresh.samples > 0).sort((a, b) => a.fresh.samples - b.fresh.samples);
  // the cheapest songs with distinct instrument sets
  const picked = [];
  const seen = new Set();
  for (const s of withSamples) {
    const k = s.samplers.join('+');
    if (seen.has(k)) continue;
    seen.add(k);
    picked.push(s);
    if (picked.length >= n) break;
  }
  await e.preload(picked.map((s) => s.patch), { pin: 'none' });
  for (const s of songs) s.after = await e.estimatePreloadMB([s.patch]);
  all.after = await e.estimatePreloadMB(songs.map((s) => s.patch));
  const sizes = {};
  for (const [k, v] of e.cache.sizes) sizes[new URL(k, location.href).pathname + (k.includes('#') ? k.slice(k.indexOf('#')) : '')] = v;
  return { songs, all, preloaded: picked.map((s) => s.id), sizes, decodedMB: e.cache.decodedMB };
}, N);
await close();
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'cache-vectors.json'), JSON.stringify({ chromium: version, sampleRate: 44100, ...res }, null, 1));
console.log(`cache-vectors: ${res.songs.length} songs, preloaded ${res.preloaded.join(', ')}, decoded ${res.decodedMB.toFixed(1)} MB`);
