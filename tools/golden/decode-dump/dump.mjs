#!/usr/bin/env node
// T06 decode dumper (SETUP_REVIEW 13): decodeAudioData in the golden Chromium on 20 bundled MP3s (6 sets, soft and
// loud layers), written as float32 WAV + manifest.json {frames, sampleRate, channels, sha256}; the same files after
// the engine's processSample (6 files x 2 option variants) as vectors. Usage:
//   node tools/golden/decode-dump/dump.mjs [--out <dir>]      (default tools/golden/decode-dump/data/)
// Layout: <out>/raw44100/<key>.wav, <out>/raw48000/<key>.wav (decodeAudioData at each context rate),
// <out>/proc/<key>.<variant>.wav (processSample output at 44.1 kHz), <out>/manifest.json.
import fs from 'node:fs';
import path from 'node:path';
import { openPage, PAGE_FN, SELECTION, unb64, sha256, writeWavF32, DEFAULT_OUT } from './lib.mjs';

const argv = process.argv.slice(2);
const oi = argv.indexOf('--out');
const OUT = path.resolve(oi >= 0 ? argv[oi + 1] : DEFAULT_OUT);
const RATES = [44100, 48000];

const { page, version, close } = await openPage();
const recs = await page.evaluate(PAGE_FN, [SELECTION, RATES]);
await close();

for (const d of ['raw44100', 'raw48000', 'proc']) fs.mkdirSync(path.join(OUT, d), { recursive: true });
const entries = [];
for (const r of recs) {
  const key = r.url.replace(/^\/samples\//, '').replace(/\.mp3$/, '').replace(/\//g, '__');
  const e = { key, url: r.url, set: r.set, midi: r.midi, mp3Bytes: r.mp3Bytes, opts: r.opts, raw: {}, proc: [] };
  for (const sr of RATES) {
    const d = r.raw[sr];
    const chs = d.chs.map(unb64);
    writeWavF32(path.join(OUT, `raw${sr}`, `${key}.wav`), chs, d.sr);
    e.raw[sr] = { file: `raw${sr}/${key}.wav`, frames: d.frames, sampleRate: d.sr, channels: chs.length,
      sha256: sha256(chs) };
  }
  for (const p of r.proc) {
    const chs = p.chs.map(unb64);
    writeWavF32(path.join(OUT, 'proc', `${key}.${p.variant}.wav`), chs, p.sr);
    e.proc.push({ variant: p.variant, file: `proc/${key}.${p.variant}.wav`, opts: p.opts, frames: p.frames,
      sampleRate: p.sr, channels: p.channels, dualMono: p.dualMono, lrDiff: p.lrDiff, onsetTrim: p.onsetTrim,
      natural: p.natural, capped: p.capped, monoFix: p.monoFix, sha256: sha256(chs) });
  }
  entries.push(e);
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ chromium: version, rates: RATES, files: entries }, null, 1));
console.log(`decode-dump: ${entries.length} files, ${entries.filter((e) => e.proc.length).length} with processSample vectors -> ${OUT}`);
