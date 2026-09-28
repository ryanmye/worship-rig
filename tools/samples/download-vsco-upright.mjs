#!/usr/bin/env node
// Downloads the Upright Piano from VS Chamber Orchestra 2: Community Edition
// (sgossner/VSCO-2-CE, CC0 1.0; recorded by Sam Gossner & Simon Dalzell) and
// transcodes it to app/samples/upright-piano/<layer>/<FlatNote>.mp3.
//
// Source layout (probed; api.github.com tree listing is blocked for this repo):
//   region map  https://raw.githubusercontent.com/sgossner/VSCO-2-CE/SFZ/UprightPiano.sfz
//   samples     https://raw.githubusercontent.com/sgossner/VSCO-2-CE/master/Keys/Upright%20Piano/Player_dynN_rr1_XXX.wav
// 3 dynamics (dyn1 vel 0-60, dyn2 61-110, dyn3 111-127) x 23 notes (every major third, A0..C8), 24-bit/44.1 kHz WAV,
// one round robin (rr1) only in the sfz. Levels: see "Level-match" below.
// Per file: 10 Hz DC high-pass (the quiet dyn1 files carry DC that the level-matching gain would expose) -> gain ->
// tail trim like Salamander (trailing audio < -60 dBFS removed only after 8 s, 0.5 s fade,
// capped at 20 s) -> libmp3lame 160 kbps, 48 kHz.
//
// Usage: node tools/samples/download-vsco-upright.mjs
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, readdir, unlink, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fetchToFile, fetchText, runPool } from './fetch-utils.mjs';
import { flatName } from './notenames.mjs';
import { analyze, earlyLoudnessDb, polyfit2 } from './audio-stats.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', '..', 'app', 'samples', 'upright-piano');
const SCRATCH = join(__dirname, '.scratch-vsco');
const REPO = 'https://raw.githubusercontent.com/sgossner/VSCO-2-CE';
const SFZ_URL = `${REPO}/SFZ/UprightPiano.sfz`;
const LICENSE_URL = `${REPO}/master/LICENSE`;
const TARGET_PEAK_DB = -1;
const BITRATE = '160k';
const LAYER_STEP_DB = 4.5;

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}: ${err}`))));
  });
}

export function parseSfz(text) {
  let defaultPath = '';
  const regions = [];
  let cur = null;
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (line.startsWith('<region>')) {
      cur = {};
      regions.push(cur);
      continue;
    }
    if (line.startsWith('<')) {
      cur = null;
      continue;
    }
    const m = /^(\w+)=(.*)$/.exec(line);
    if (!m) continue;
    if (m[1] === 'default_path') defaultPath = m[2].replace(/\\/g, '/');
    else if (cur) cur[m[1]] = m[2];
  }
  return { defaultPath, regions };
}

// Salamander-style tail handling (see download-salamander.mjs): the first 8 s are never touched.
async function transcode(src, dest, gainDb) {
  const trimmed = dest + '.trim.wav';
  await mkdir(dirname(dest), { recursive: true });
  const filter =
    `[0:a]highpass=f=10,volume=${gainDb.toFixed(2)}dB,asplit=2[a][b];` +
    '[a]atrim=start=0:end=8,asetpts=PTS-STARTPTS[head];' +
    '[b]atrim=start=8,asetpts=PTS-STARTPTS,' +
    'silenceremove=stop_periods=1:stop_duration=0.5:stop_threshold=-60dB:detection=rms:window=0.05[tail];' +
    '[head][tail]concat=n=2:v=0:a=1[out]';
  await ffmpeg(['-i', src, '-filter_complex', filter, '-map', '[out]', '-t', '20', '-c:a', 'pcm_f32le', trimmed]);
  const { duration } = await analyze(trimmed);
  await ffmpeg([
    '-i', trimmed,
    '-af', `afade=t=out:st=${Math.max(0, duration - 0.5).toFixed(3)}:d=0.5`,
    '-c:a', 'libmp3lame', '-b:a', BITRATE, '-ar', '48000', '-map_metadata', '-1',
    dest,
  ]);
  await unlink(trimmed).catch(() => {});
}

async function main() {
  const license = await fetchText(LICENSE_URL);
  if (!/^CC0 1\.0 Universal/.test(license.trim())) throw new Error('VSCO-2-CE LICENSE is no longer CC0 1.0; aborting');
  const { defaultPath, regions } = parseSfz(await fetchText(SFZ_URL));
  const layers = new Map(); // dyn -> {vel, volume, notes:[]}
  for (const r of regions) {
    const dyn = /_(dyn\d)_/.exec(r.sample)?.[1];
    if (!dyn || !/_rr1_/.test(r.sample)) continue;
    if (!layers.has(dyn)) layers.set(dyn, { dyn, vel: [Number(r.lovel), Number(r.hivel)], volume: Number(r.volume || 0), regions: [] });
    layers.get(dyn).regions.push({ sample: r.sample, midi: Number(r.pitch_keycenter) });
  }

  // download
  await mkdir(SCRATCH, { recursive: true });
  const jobs = [];
  for (const L of layers.values())
    for (const r of L.regions) {
      r.local = join(SCRATCH, r.sample);
      r.url = `${REPO}/master/${defaultPath.split('/').map(encodeURIComponent).join('/')}${encodeURIComponent(r.sample)}`;
      jobs.push(async () => {
        if (existsSync(r.local)) return;
        const res = await fetchToFile(r.url, r.local);
        if (!res.ok) throw new Error(`missing ${r.url}`);
      });
    }
  process.stderr.write(`[vsco] downloading ${jobs.length} wavs ...\n`);
  await runPool(jobs, 4);

  // Level-match. Measured on the raw files, the sfz's flat per-layer volumes leave dyn1 LOUDER than dyn3 in the bass
  // and notes within a layer jump by up to ±6 dB (attack loudness), so instead every file is set to a smooth target:
  //   target(layer, midi) = q(midi) + LAYER_OFFSET_DB[layer]
  // q = quadratic least-squares fit of the loudest layer's attack loudness across the keyboard (keeps the
  // instrument's own bass-to-treble balance, removes note-to-note recording jumps); layer offsets follow the
  // Salamander set's measured mid-range spacing (v4->v9->v14 ≈ +4…+5 dB each), so both pianos respond alike
  // under the sampler's velocity mapping. Then ONE gain puts the loudest file at -1 dBFS.
  for (const L of layers.values()) {
    const st = await runPool(L.regions.map((r) => () => analyze(r.local)), 2);
    const el = await runPool(L.regions.map((r) => () => earlyLoudnessDb(r.local)), 2);
    L.regions.forEach((r, i) => ((r.stats = st[i]), (r.early = el[i])));
  }
  const ordered = [...layers.values()].sort((a, b) => a.vel[0] - b.vel[0]);
  const top = ordered[ordered.length - 1];
  const q = polyfit2(top.regions.map((r) => r.midi), top.regions.map((r) => r.early));
  let maxPeak = -Infinity;
  ordered.forEach((L, i) => {
    L.offsetDb = LAYER_STEP_DB * (i - (ordered.length - 1));
    for (const r of L.regions) {
      r.relGainDb = q(r.midi) + L.offsetDb - r.early;
      maxPeak = Math.max(maxPeak, r.stats.peakDb + r.relGainDb);
    }
  });
  const instGainDb = Math.round((TARGET_PEAK_DB - maxPeak) * 10) / 10;

  if (existsSync(OUT)) await rm(OUT, { recursive: true });
  const sources = [];
  for (const L of layers.values()) {
    await runPool(
      L.regions.map((r) => async () => {
        const g = r.relGainDb + instGainDb;
        const dest = join(OUT, L.dyn, `${flatName(r.midi)}.mp3`);
        await transcode(r.local, dest, g);
        sources.push({ file: `upright-piano/${L.dyn}/${flatName(r.midi)}.mp3`, sourceUrl: r.url, gainDb: Math.round(g * 10) / 10 });
      }),
      2,
    );
  }
  sources.sort((a, b) => a.file.localeCompare(b.file));
  let bytes = 0;
  for (const s of sources) bytes += (await stat(join(OUT, '..', s.file))).size;
  const summary = {
    source: 'https://github.com/sgossner/VSCO-2-CE (SFZ/UprightPiano.sfz, master/Keys/Upright Piano/)',
    license: 'CC0-1.0',
    bitrate: BITRATE,
    sampleRate: 48000,
    layers: [...layers.values()].map((L) => ({ dir: L.dyn, vel: L.vel, sfzVolumeDb: L.volume, targetOffsetDb: L.offsetDb, notes: L.regions.length })),
    instrumentGainDb: instGainDb,
    totalMB: Math.round(bytes / 1e4) / 100,
    files: sources,
  };
  await writeFile(join(__dirname, 'vsco-upright-sources.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((s) => console.log(JSON.stringify({ ...s, files: s.files.length }, null, 2)))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

export { main };
