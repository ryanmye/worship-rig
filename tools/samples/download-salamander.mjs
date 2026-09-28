#!/usr/bin/env node
// Downloads Salamander Grand Piano FLAC samples (CC-BY 3.0, Alexander Holm,
// sfzinstruments/SalamanderGrandPiano) and transcodes them to mp3 per
// SPEC.md §3.5/§9. Source filenames use sharp note names (VERIFY.md Q3);
// output filenames use flat names.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, unlink, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fetchToFile } from './fetch-utils.mjs';
import { minorThirdRange, flatName, sharpName } from './notenames.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const SAMPLES_DIR = join(REPO_ROOT, 'app', 'samples', 'salamander-piano');
const SCRATCH_DIR = join(__dirname, '.scratch-salamander');

const BASE = 'https://raw.githubusercontent.com/sfzinstruments/SalamanderGrandPiano/master/Samples';
const LAYERS = [4, 9, 14]; // velocity layers used

let BITRATE = '160k';

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr}`));
    });
  });
}

async function transcode(srcFlac, destMp3, bitrate) {
  // Trim trailing audio below -60dBFS after 8s (tail only, never the onset),
  // 0.5s fade-out at the trimmed end, cap total length at 20s.
  //
  // Approach: split at t=8s. The first 8s ("head") passes through completely
  // untouched (so onset transients are never at risk). `silenceremove` runs
  // only on the "tail" (t>=8s), so it can only ever cut material after 8s.
  // head+trimmed-tail are concatenated, then hard-capped at 20s with -t.
  const trimmed = destMp3 + '.trim.wav';
  await mkdir(dirname(destMp3), { recursive: true });
  const filter =
    '[0:a]atrim=start=0:end=8,asetpts=PTS-STARTPTS[head];' +
    '[0:a]atrim=start=8,asetpts=PTS-STARTPTS,' +
    'silenceremove=stop_periods=1:stop_duration=0.5:stop_threshold=-60dB:detection=rms:window=0.05[tail];' +
    '[head][tail]concat=n=2:v=0:a=1[out]';
  await runFfmpeg([
    '-i', srcFlac,
    '-filter_complex', filter,
    '-map', '[out]',
    '-t', '20',
    trimmed,
  ]);

  const dur = await probeDuration(trimmed);
  const fadeStart = Math.max(0, dur - 0.5);

  await runFfmpeg([
    '-i', trimmed,
    '-af', `afade=t=out:st=${fadeStart.toFixed(3)}:d=0.5`,
    '-c:a', 'libmp3lame',
    '-b:a', bitrate,
    '-ar', '48000',
    destMp3,
  ]);
  await unlink(trimmed).catch(() => {});
}

function probeDuration(file) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file,
    ]);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) => {
      if (code === 0) resolve(parseFloat(out.trim()));
      else reject(new Error(`ffprobe failed: ${err}`));
    });
  });
}

async function fileSizeMB(path) {
  const s = await stat(path);
  return s.size / 1e6;
}

async function downloadAndTranscodeAll(bitrate) {
  await mkdir(SCRATCH_DIR, { recursive: true });
  const notes = minorThirdRange(); // 30 MIDI notes
  const sources = [];
  const perLayer = {};
  let totalBytes = 0;

  for (const vel of LAYERS) {
    const dirName = `v${vel}`;
    perLayer[dirName] = { present: [], missing: [] };
    for (const midi of notes) {
      const srcNote = sharpName(midi);
      const outNote = flatName(midi);
      // '#' must be percent-encoded or it is parsed as a URL fragment
      // delimiter (fetch() then requests only the part before it).
      const url = `${BASE}/${encodeURIComponent(srcNote)}v${vel}.flac`;
      const scratchFlac = join(SCRATCH_DIR, `${srcNote}v${vel}.flac`);
      const destMp3 = join(SAMPLES_DIR, dirName, `${outNote}.mp3`);

      const dl = await fetchToFile(url, scratchFlac, { retries: 3 });
      if (!dl.ok) {
        perLayer[dirName].missing.push(outNote);
        process.stderr.write(`[salamander] MISSING ${srcNote}v${vel} (404) -> skipping ${outNote} in ${dirName}\n`);
        continue;
      }
      await transcode(scratchFlac, destMp3, bitrate);
      await unlink(scratchFlac).catch(() => {});
      const mb = await fileSizeMB(destMp3);
      totalBytes += mb * 1e6;
      perLayer[dirName].present.push(outNote);
      sources.push({
        file: `salamander-piano/${dirName}/${outNote}.mp3`,
        sourceUrl: url,
        velocityLayer: vel,
      });
      process.stderr.write(`[salamander] ${dirName}/${outNote}.mp3 (${mb.toFixed(2)} MB)\n`);
    }
  }

  return { perLayer, sources, totalMB: totalBytes / 1e6 };
}

async function main() {
  let { perLayer, sources, totalMB } = await downloadAndTranscodeAll(BITRATE);
  process.stderr.write(`[salamander] total at ${BITRATE}: ${totalMB.toFixed(2)} MB (target <= 45 MB)\n`);

  if (totalMB > 45) {
    process.stderr.write('[salamander] over budget, retranscoding at 128k...\n');
    BITRATE = '128k';
    ({ perLayer, sources, totalMB } = await downloadAndTranscodeAll(BITRATE));
    process.stderr.write(`[salamander] total at ${BITRATE}: ${totalMB.toFixed(2)} MB\n`);
  }

  await writeFile(
    join(__dirname, 'salamander-sources.json'),
    JSON.stringify({ bitrate: BITRATE, totalMB, files: sources }, null, 2)
  );

  return { perLayer, totalMB, bitrate: BITRATE };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

export { main };
