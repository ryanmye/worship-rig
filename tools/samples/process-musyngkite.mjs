#!/usr/bin/env node
// Turns the raw MusyngKite downloads (tools/samples/.scratch-musyngkite/<id>/,
// see download-musyngkite.mjs) into the bundled app/samples/<id>/ sets.
// Fixes for reviews/audition-findings.md S1–S3:
//   - S3: notes whose peak is below -80 dBFS (silent placeholder files) are
//         dropped; the sampler's nearest-note repitch covers those keys.
//   - S2: DC offset removed with a 10 Hz high-pass (ffmpeg highpass, 2-pole). 20 Hz was tried first: its
//         phase shift/attenuation at the A0..C1 fundamentals (27-33 Hz) cost ~1 dB there and raised low-note
//         peaks by up to 2 dB; 10 Hz removes the DC just as well (-0.1 dB at 27.5 Hz).
//   - S1: the whole set gets ONE gain so its loudest note peaks at -1 dBFS
//         (note-to-note balance is untouched). For instruments already in the
//         manifest, gainTrim is lowered by exactly the gain applied (relative
//         to the previous run's gain, 0 for the original as-is files), so the
//         calibrated loudness is unchanged and the trims fall inside ±12 dB.
//   - LEVEL_MATCH sets only: per-note gain to a smooth key-level contour (see LEVEL_MATCH below).
//   - The source files are hard-cut at ~3.13 s (often at -18..-20 dB below
//     peak, which clicks when a note is held past it); a 0.4 s fade-out is
//     applied at the end of every file.
// Encoding: libmp3lame VBR -q:a 2 at the source rate (44.1 kHz); a second
// lossy generation at the source's own ~40-60 kbps VBR rate would add audible
// artifacts, V2 keeps files ~1.3x the source size.
//
// Usage: node tools/samples/process-musyngkite.mjs [--only id,id]
// Writes tools/samples/musyngkite-processing.json (per-id gain, drops, stats).
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, readFile, writeFile, mkdir, unlink, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { analyze, earlyLoudnessDb, polyfit2 } from './audio-stats.mjs';
import { noteToMidi } from './build-manifest.mjs';
import { runPool } from './fetch-utils.mjs';
import { INSTRUMENTS, RAW_ROOT } from './download-musyngkite.mjs';
import { SILENT_DB } from './audit.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES_ROOT = join(__dirname, '..', '..', 'app', 'samples');
const MANIFEST_PATH = join(SAMPLES_ROOT, 'manifest.json');
const RECORD_PATH = join(__dirname, 'musyngkite-processing.json');

export const TARGET_PEAK_DB = -1;
export const HPF_HZ = 10;
export const FADE_OUT_SEC = 0.4;
export const VBR_QUALITY = 2;
// Sets whose note-to-note attack loudness (60 Hz-16 kHz, first 0.5 s) jumps by >= 8.9 dB between neighbouring keys
// (soundfont zone steps; measured 2026-09 on the raw sets): kalimba +13.2 dB at Db4, marimba +8.9 at C4 / -9.2 at G6,
// harp up to 9.7, steel-guitar up to 10.3. The calibration chord (C3-E3-G3) sits right at those steps, so without
// this e.g. the kalimba calibrated at C3 plays ~15 dB hot from Db4 up. nylon-guitar (8.2) is left as shipped.
export const LEVEL_MATCH = new Set(['kalimba', 'marimba', 'harp', 'steel-guitar']);

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}: ${err}`))));
  });
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function processInstrument(id) {
  const rawDir = join(RAW_ROOT, id);
  const tmpDir = join(RAW_ROOT, '.tmp', id);
  await mkdir(tmpDir, { recursive: true });
  const files = (await readdir(rawDir)).filter((f) => f.endsWith('.mp3')).sort();
  const stats = await runPool(files.map((f) => () => analyze(join(rawDir, f))), 4);
  const keep = [];
  const dropped = [];
  stats.forEach((s, i) => (s.peakDb < SILENT_DB ? dropped.push(files[i].replace('.mp3', '')) : keep.push({ f: files[i], s })));
  const rawSetPeakDb = Math.max(...keep.map((k) => k.s.peakDb));

  // Pass 1: DC high-pass + tail fade into float WAV (the high-pass shifts phase near the lowest fundamentals,
  // which moves peaks, so the normalization gain is measured after it).
  const wav = (f) => join(tmpDir, f.replace(/\.mp3$/, '.wav'));
  await runPool(
    keep.map(({ f, s }) => () =>
      ffmpeg([
        '-i', join(rawDir, f),
        '-af', `highpass=f=${HPF_HZ},afade=t=out:st=${Math.max(0, s.duration - FADE_OUT_SEC).toFixed(4)}:d=${FADE_OUT_SEC}`,
        '-c:a', 'pcm_f32le', wav(f),
      ]),
    ),
    2,
  );
  const filtered = await runPool(keep.map(({ f }) => () => analyze(wav(f))), 4);
  // Optional key-level matching (LEVEL_MATCH): per-note correction to a quadratic fit of the set's attack loudness
  // across the keyboard, removing soundfont zone steps while keeping the overall contour.
  const rel = keep.map(() => 0);
  if (LEVEL_MATCH.has(id)) {
    const el = await runPool(keep.map(({ f }) => () => earlyLoudnessDb(wav(f), { lo: 60, hi: 16000 })), 2);
    const midis = keep.map(({ f }) => noteToMidi(f.replace(/\.mp3$/, '')));
    const fit = polyfit2(midis, el);
    keep.forEach((_, i) => (rel[i] = Math.round((fit(midis[i]) - el[i]) * 10) / 10));
  }
  const filteredPeakDb = Math.max(...filtered.map((s, i) => s.peakDb + rel[i]));
  let gainDb = Math.round((TARGET_PEAK_DB - filteredPeakDb) * 10) / 10;

  const outDir = join(SAMPLES_ROOT, id);
  await mkdir(outDir, { recursive: true });
  const encodeAll = async (g) => {
    for (const f of await readdir(outDir)) if (f.endsWith('.mp3')) await unlink(join(outDir, f));
    await runPool(
      keep.map(({ f }, i) => () =>
        ffmpeg(['-i', wav(f), '-af', `volume=${(g + rel[i]).toFixed(1)}dB`, '-c:a', 'libmp3lame', '-q:a', String(VBR_QUALITY), '-map_metadata', '-1', join(outDir, f)]),
      ),
      2,
    );
    const enc = await runPool(keep.map(({ f }) => () => analyze(join(outDir, f))), 4);
    return Math.max(...enc.map((s) => s.peakDb));
  };
  // Pass 2: gain + encode; MP3 coding can overshoot the PCM peak slightly, so back off once if it lands above -0.5.
  let outPeakDb = await encodeAll(gainDb);
  if (outPeakDb > -0.5) {
    gainDb = Math.round((gainDb - (outPeakDb - TARGET_PEAK_DB)) * 10) / 10;
    outPeakDb = await encodeAll(gainDb);
  }
  let bytes = 0;
  for (const { f } of keep) {
    bytes += (await stat(join(outDir, f))).size;
    await unlink(wav(f)).catch(() => {});
  }
  return {
    folder: INSTRUMENTS[id],
    files: keep.length,
    dropped,
    rawSetPeakDb: Math.round(rawSetPeakDb * 100) / 100,
    gainDb,
    outSetPeakDb: Math.round(outPeakDb * 100) / 100,
    levelMatchDb: LEVEL_MATCH.has(id) ? [Math.min(...rel), Math.max(...rel)] : null,
    worstRawDcRatio: Math.max(...keep.map((k) => k.s.dcRatio)),
    hpfHz: HPF_HZ,
    fadeOutSec: FADE_OUT_SEC,
    encoder: `libmp3lame VBR -q:a ${VBR_QUALITY}`,
    mb: Math.round(bytes / 1e4) / 100,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
  const record = await readJson(RECORD_PATH, {});
  const trimAdjust = {};
  for (const id of Object.keys(INSTRUMENTS)) {
    if (only && !only.has(id)) continue;
    const prevGain = record[id]?.gainDb ?? 0;
    const r = await processInstrument(id);
    record[id] = r;
    trimAdjust[id] = r.gainDb - prevGain;
    console.log(
      `${id.padEnd(15)} files=${r.files} dropped=[${r.dropped.join(',')}] rawPeak=${r.rawSetPeakDb} gain=+${r.gainDb} dB outPeak=${r.outSetPeakDb} ` +
        `worstDC/peak=${r.worstRawDcRatio.toExponential(1)} ${r.mb} MB`,
    );
  }
  await writeFile(RECORD_PATH, JSON.stringify(record, null, 2) + '\n');

  // Keep calibrated loudness of instruments already in the manifest: trim -= gain applied since last run.
  const text = await readFile(MANIFEST_PATH, 'utf8').catch(() => null);
  if (text) {
    const m = JSON.parse(text);
    let changed = false;
    for (const inst of m.instruments) {
      const d = trimAdjust[inst.id];
      if (d && Number.isFinite(inst.gainTrim) && inst.gainTrim !== 0) {
        const nt = Math.round((inst.gainTrim - d) * 10) / 10;
        console.log(`  manifest ${inst.id}: gainTrim ${inst.gainTrim} -> ${nt} (compensates +${d.toFixed(1)} dB file gain)`);
        inst.gainTrim = nt;
        changed = true;
      }
    }
    if (changed) await writeFile(MANIFEST_PATH, JSON.stringify(m, null, 2) + '\n');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
