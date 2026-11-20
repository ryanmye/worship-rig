#!/usr/bin/env node
// Chromium-decoded sampler PCM for decoder-independent native tests (SETUP_REVIEW HIGH 13, T17 task 2).
//
// The sampler goldens are rendered from MP3s that Chromium decoded (FFmpeg). A native engine decoding the same MP3
// with dr_mp3 differs in priming / float rounding, so an exact-tier sampler fixture cannot tell "decoder differs"
// from "sampler differs". This tool dumps what Chromium decoded, once, and the native runner feeds that PCM to its
// sampler (test hook `samples.pcmOverride`), leaving decoder parity as its own test with its own tolerance.
//
// Format (the convention the native side codes against; README "Sampler PCM"):
//   native/golden/pcm/<set>/<note>.wav    32-bit IEEE float WAV, interleaved, the FILE's native rate (no resampling),
// every channel the decoder returned (these MP3s are all 2-channel), full length
//   native/golden/pcm/<set>/<note>.json  {source, sourceSha256, sourceBytes, rate, channels, frames, sha256, ...}
//     source     path of the MP3 relative to the repo root (app/samples/<set>/<note>.mp3 or <layer dir>/<note>.mp3)
//     sha256     of the .wav file bytes; sourceSha256 of the MP3 (so a regenerated dump can be verified)
//     engineRate 44100: what the reference engine's context ran at. rate != engineRate means Chromium RESAMPLED the
//                file to 44.1 kHz inside decodeAudioData for the golden (159 of 1999 bundled files are 48 kHz); the
//                native side must then resample the PCM itself (that step is not covered by this dump)
// What the native sampler still does itself (processSample: onset trim, 2 ms fade-in, cap, dual-mono, mono-fix) is
// NOT in the dump: it is part of what the exact-tier fixtures test.
//
// node tools/golden/pcm.mjs                 dump every sample the manifest's sampler fixtures play
// (resolved.samplesUsed)
//   node tools/golden/pcm.mjs --only <ids>    only the samples of fixtures whose id contains a substring
//   node tools/golden/pcm.mjs --check         verify the dumps on disk against their sidecars (sha256) and the manifest
//   options: --golden-dir <dir> (default native/golden)
//
// Size policy: ALL dumps are regenerable (this command, ~10 s) and git-ignored through native/golden/pcm/.gitignore,
// which un-ignores only the files chosen below under COMMIT_CAP_BYTES. The cap exists because the committed golden
// audio (stimuli + smoke + these) must stay under 14 MB: stimuli + smoke are 10.2 MiB, so 2.5 MB of PCM leaves ~1.3
// MiB.
// Selection: the files used by most fixtures first (ep-rhodes), then smallest first. Sidecars are always committed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { encodeWavF32, readWav } from './wav.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
export const COMMIT_CAP_BYTES = 2.5e6;
export const ENGINE_RATE = 44100;

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Sample rate and channel count of the first MPEG audio frame (ID3v2 skipped). null when unparseable. */
export function mp3Info(buf) {
  let i = 0;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    i = 10 + ((buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9]);
  }
  const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  for (; i + 4 < buf.length; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const ver = (buf[i + 1] >> 3) & 3;
    const layer = (buf[i + 1] >> 1) & 3;
    const sr = (buf[i + 2] >> 2) & 3;
    if (ver === 1 || layer === 0 || sr === 3 || buf[i + 2] >> 4 === 15) continue;
    return { rate: RATES[ver][sr], channels: (buf[i + 3] >> 6) === 3 ? 1 : 2 };
  }
  return null;
}

/** Repo-relative MP3 path of a cache url as the page fetched it ('./samples/x/C4.mp3' is served from app/). */
export function sourceOfUrl(url) {
  return path.posix.join('app', url.replace(/^\.?\/?/, ''));
}

/**
 * Dump the PCM of `urls` through an open golden page (openPage in render.mjs: `page.decode(url, rate)`).
 * @returns {Map<string, object>} url -> file record {source, wav, sidecar, sha256, frames, rate, channels, bytes, ...}
 */
export async function dumpUrls(page, urls, goldDir) {
  const out = new Map();
  for (const url of [...new Set(urls)].sort()) {
    const source = sourceOfUrl(url);
    const mp3 = fs.readFileSync(path.join(ROOT, source));
    const info = mp3Info(mp3) || { rate: ENGINE_RATE, channels: 2 };
    const d = await page.decode(`/${url.replace(/^\.?\/?/, '')}`, info.rate);
    const rel = source.replace(/^app\/samples\//, '').replace(/\.mp3$/, '');
    const wavRel = `pcm/${rel}.wav`;
    const jsonRel = `pcm/${rel}.json`;
    const wav = encodeWavF32(d.chs, d.rate);
    fs.mkdirSync(path.dirname(path.join(goldDir, wavRel)), { recursive: true });
    fs.writeFileSync(path.join(goldDir, wavRel), wav);
    const rec = {
      source, sourceSha256: sha256(mp3), sourceBytes: mp3.length, rate: d.rate, channels: d.chs.length,
      frames: d.frames, sha256: sha256(wav), bytes: wav.length, engineRate: ENGINE_RATE,
      resampledByEngine: d.rate !== ENGINE_RATE,
      decoder: 'Chromium decodeAudioData (OfflineAudioContext at the file rate, no resampling)',
    };
    fs.writeFileSync(path.join(goldDir, jsonRel), `${JSON.stringify(rec, null, 1)}\n`);
    out.set(url, { ...rec, wav: wavRel, sidecar: jsonRel });
  }
  return out;
}

/**
 * Choose the committed subset and write pcm/.gitignore. `usage`: url -> how many fixtures play it.
 * @returns {{committed:Set<string>, committedBytes:number, totalBytes:number}}
 */
export function writeGitignore(goldDir, records, usage) {
  const list = [...records.entries()].sort((a, b) => (usage.get(b[0]) || 0) - (usage.get(a[0]) || 0)
    || a[1].bytes - b[1].bytes);
  const committed = new Set();
  let committedBytes = 0;
  for (const [url, r] of list) {
    if (committedBytes + r.bytes > COMMIT_CAP_BYTES) continue;
    committed.add(url);
    committedBytes += r.bytes;
  }
  const lines = [
    '# generated by tools/golden/pcm.mjs. Every .wav here is regenerable (node tools/golden/pcm.mjs);',
    `# only the files un-ignored below are committed (cap ${COMMIT_CAP_BYTES / 1e6} MB, most-used then smallest ` +
      `first).`,
    '*.wav', ...[...committed].sort().map((u) => `!${records.get(u).wav.replace(/^pcm\//, '')}`), '',
  ];
  fs.writeFileSync(path.join(goldDir, 'pcm/.gitignore'), lines.join('\n'));
  const totalBytes = [...records.values()].reduce((s, r) => s + r.bytes, 0);
  return { committed, committedBytes, totalBytes };
}

/** Verify files on disk against their sidecars; returns problems. */
export function checkPcm(goldDir, manifest) {
  const problems = [];
  const seen = new Set();
  for (const e of manifest.fixtures) {
    for (const f of e.pcm?.files || []) {
      if (seen.has(f.wav)) continue;
      seen.add(f.wav);
      const p = path.join(goldDir, f.wav);
      if (!fs.existsSync(p)) {
        problems.push(`${f.wav}: ` +
          `missing${f.committed ? ' (COMMITTED file absent)' : ' (not committed; run tools/golden/pcm.mjs)'}`);
        continue;
      }
      const buf = fs.readFileSync(p);
      if (sha256(buf) !== f.sha256) problems.push(`${f.wav}: sha256 differs from the manifest (decoder or Chromium ` +
        `changed?)`);
      const w = readWav(p);
      if (w.chs[0].length !== f.frames
        || w.sr !== f.rate) problems.push(`${f.wav}: frames/rate differ from the manifest`);
    }
  }
  return { files: seen.size, problems };
}

// ---- CLI --------------------------------------------------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2);
  const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
  const goldDir = path.resolve(opt('--golden-dir', path.join(ROOT, 'native/golden')));
  const manifestPath = path.join(goldDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (argv.includes('--check')) {
    const r = checkPcm(goldDir, manifest);
    console.log(`${r.files} PCM files checked, ${r.problems.length} problems`);
    for (const p of r.problems) console.log(`  ${p}`);
    process.exit(r.problems.length ? 1 : 0);
  }
  const only = opt('--only', null)?.split(',').filter(Boolean);
  const entries = manifest.fixtures.filter((e) => e.pcm && (!only || only.some((o) => e.id.includes(o))));
  if (!entries.length) throw new Error('no fixture with sampler PCM selected (run render.mjs first)');
  const urls = entries.flatMap((e) => e.pcm.files.map((f) => f.url));
  const { startBrowserPage } = await import('./render.mjs');
  const { page, close } = await startBrowserPage();
  const t0 = Date.now();
  const recs = await dumpUrls(page, urls, goldDir);
  await close();
  // refresh the manifest's records (frames/sha256 of an unchanged dump are identical: dumps are deterministic)
  const usage = new Map();
  for (const e of manifest.fixtures) for (const f of e.pcm?.files || []) usage.set(f.url, (usage.get(f.url) || 0) + 1);
  const all = new Map([...recs]);
  for (const e of manifest.fixtures) {
    for (const f of e.pcm?.files || []) if (!all.has(f.url) && fs.existsSync(path.join(goldDir,
      f.wav))) all.set(f.url, f);
  }
  const sel = writeGitignore(goldDir, all, usage);
  for (const e of manifest.fixtures) {
    for (const f of e.pcm?.files || []) {
      const r = recs.get(f.url);
      if (r) Object.assign(f, r);
      f.committed = sel.committed.has(f.url);
    }
  }
  manifest.pcm = { ...(manifest.pcm || {}), committedBytes: sel.committedBytes, totalBytes: sel.totalBytes,
    files: all.size, commitCapBytes: COMMIT_CAP_BYTES };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(`${recs.size} PCM files dumped in ${((Date.now() - t0) / 1000).toFixed(1)} s: ` +
    `${(sel.totalBytes / 1e6).toFixed(2)} MB total, ${(sel.committedBytes / 1e6).toFixed(2)} MB committed`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
