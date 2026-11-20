#!/usr/bin/env node
// T06 decode dumper (SETUP_REVIEW 13): decodeAudioData in the golden Chromium on bundled MP3s, written as float32 WAV
// + manifest.json {frames, sampleRate, channels, sha256}; the same files after the engine's processSample as vectors.
//   node tools/golden/decode-dump/dump.mjs [--out <dir>]
//        the default 20-file set (6 sets, soft and loud layers; 6 of them also get processSample vectors)
//   node tools/golden/decode-dump/dump.mjs --set salamander-piano,ep-rhodes [--midi 36-96] [--rates 44100]
//        EVERY sample of these instruments (optionally only notes in a MIDI range), decode dumps only: what the
//        exact-tier sampler fixtures need (T17 feeds these through the engine's samples.pcmOverride hook)
// Layout: <out>/raw44100/<key>.wav, <out>/raw48000/<key>.wav (decodeAudioData at each context rate; key = path below
// app/samples/ without extension, "/" -> "__"), <out>/proc/<key>.<variant>.wav (processSample output at 44.1 kHz),
// <out>/manifest.json (entries of several runs are merged by key). Default <out>: tools/golden/decode-dump/data/.
import fs from 'node:fs';
import path from 'node:path';
import { openPage, PAGE_FN, LIST_FN, SELECTION, unb64, sha256, writeWavF32, DEFAULT_OUT } from './lib.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const OUT = path.resolve(arg('--out', DEFAULT_OUT));
const RATES = arg('--rates', '44100,48000').split(',').map(Number);
const SETS = arg('--set', null)?.split(',').filter(Boolean) || null;
const [MIDI_LO, MIDI_HI] = arg('--midi', '0-127').split('-').map(Number);

const { page, version, close } = await openPage();
let selection = SELECTION;
if (SETS) {
  const all = await page.evaluate(LIST_FN, SETS);
  selection = all.filter((s) => s.midi >= MIDI_LO && s.midi <= MIDI_HI);
  if (!selection.length) throw new Error(`no samples for ${SETS.join(',')} in MIDI ${MIDI_LO}-${MIDI_HI}`);
}
const recs = [];
for (let i = 0; i < selection.length; i += 6) { // batches: a base64 payload per call stays small
  recs.push(...await page.evaluate(PAGE_FN, [selection.slice(i, i + 6), RATES]));
}
await close();

for (const sr of RATES) fs.mkdirSync(path.join(OUT, `raw${sr}`), { recursive: true });
fs.mkdirSync(path.join(OUT, 'proc'), { recursive: true });
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
const mf = path.join(OUT, 'manifest.json');
let files = entries;
if (SETS && fs.existsSync(mf)) { // merge by key: the default 20 stay, the set dump adds to them
  const old = JSON.parse(fs.readFileSync(mf, 'utf8')).files || [];
  const byKey = new Map(old.map((e) => [e.key, e]));
  for (const e of entries) {
    const prev = byKey.get(e.key);
    byKey.set(e.key, { ...prev, ...e, proc: e.proc.length ? e.proc : prev?.proc || [] });
  }
  files = [...byKey.values()];
}
fs.writeFileSync(mf, JSON.stringify({ chromium: version, rates: RATES, files }, null, 1));
const withProc = entries.filter((e) => e.proc.length).length;
console.log(`decode-dump: ${entries.length} files (${withProc} with processSample vectors) -> ${OUT}`);
