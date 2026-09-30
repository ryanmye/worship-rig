// Audio conversion for the EXS importer.
//
// Preferred: ffmpeg (brew install ffmpeg). It cuts by exact sample counts — `atrim=start_sample=…:end_sample=…` counts
// frames of the decoded input at the input's own rate, before any resampling — so it handles zones that play part of
// a file, including consolidated CAFs where every zone is an offset/length inside one 184 MB file and two-segment
// zones (see layout.mjs ZONE.SEGMENT2_*), which are joined with the `concat` filter.
//   mp3: -c:a libmp3lame -b:a 160k -ar 48000       (default; the bundled library is mp3, every Chromium decodes it)
//   m4a: -c:a aac -b:a 192k                          wav: -c:a pcm_s16le
//
// Fallback: macOS `afconvert` (always installed) is only ever asked to convert WHOLE files — it has no sample-accurate
// cut and no MP3 encoder. Slices are cut in JS from a whole-file 16-bit WAV that is converted once per source file
// and cached for the run, then encoded to m4a (AAC 192 kb/s) or kept as WAV.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { sliceWavSegments } from './wav.mjs';

const AFCONVERT = () => process.env.AFCONVERT || 'afconvert';
const FFMPEG = () => process.env.FFMPEG || 'ffmpeg';

function found(bin, args) {
  const r = spawnSync(bin, args, { stdio: 'ignore' });
  return !(r.error && r.error.code === 'ENOENT');
}
export const hasAfconvert = () => found(AFCONVERT(), ['-h']);
export const hasFfmpeg = () => found(FFMPEG(), ['-version']);

/** Encoder → formats it can produce. */
export const FORMATS = { ffmpeg: ['mp3', 'm4a', 'wav'], afconvert: ['m4a', 'wav'] };

/**
 * ffmpeg arguments for one output file (pure; unit-tested).
 * @param {string} src
 * @param {string} dst
 * @param {{ format:'mp3'|'m4a'|'wav', segments?:{start:number,end:number|null}[], bitrate?:number, rate?:number,
 *           fadeOutSec?:number, totalSec?:number, highpassHz?:number }} o
 *   segments: file-frame ranges [start, end) to join in order (omit / [{start:0,end:null}] = whole file).
 *   gainDb: level change baked into the file (group + zone volume relative to the loudest zone kept).
 *   fadeOutSec + totalSec: fade the last fadeOutSec of the output (used when a sample is truncated).
 *   highpassHz: when truthy, a high-pass (`highpass=f=<hz>`) right after each segment's trim (or, when there's no
 *     trim at all, at the front of the chain) and before volume/afade — removes a DC bias ahead of the rest of the
 *     chain without touching the audible band. Default 0/omitted = off.
 */
export function ffmpegArgs(src, dst, o) {
  const segs = (o.segments || []).filter((s) => !(s.start === 0 && s.end == null));
  const hpf = o.highpassHz ? `highpass=f=${o.highpassHz}` : '';
  const trim = (s) => `atrim=start_sample=${s.start}${s.end != null ? `:end_sample=${s.end}` : ''},asetpts=PTS-STARTPTS${hpf ? `,${hpf}` : ''}`;
  const post = [];
  if (o.gainDb && Math.abs(o.gainDb) >= 0.05) post.push(`volume=${o.gainDb.toFixed(2)}dB`);
  if (o.fadeOutSec > 0 && o.totalSec > o.fadeOutSec) post.push(`afade=t=out:st=${(o.totalSec - o.fadeOutSec).toFixed(6)}:d=${o.fadeOutSec}`);
  const fade = post.join(',');
  const filter = [];
  if (segs.length <= 1) {
    const chain = [segs.length ? trim(segs[0]) : hpf, fade].filter(Boolean).join(',');
    if (chain) filter.push('-af', chain);
  } else {
    const n = segs.length;
    const parts = [`[0:a]asplit=${n}${segs.map((_, i) => `[i${i}]`).join('')}`];
    segs.forEach((s, i) => parts.push(`[i${i}]${trim(s)}[s${i}]`));
    parts.push(`${segs.map((_, i) => `[s${i}]`).join('')}concat=n=${n}:v=0:a=1${fade ? `,${fade}` : ''}[out]`);
    filter.push('-filter_complex', parts.join(';'), '-map', '[out]');
  }
  const codec =
    o.format === 'mp3'
      ? ['-c:a', 'libmp3lame', '-b:a', `${Math.round((o.bitrate || 160000) / 1000)}k`]
      : o.format === 'm4a'
        ? ['-c:a', 'aac', '-b:a', `${Math.round((o.bitrate || 192000) / 1000)}k`]
        : ['-c:a', 'pcm_s16le'];
  const rate = o.rate ? ['-ar', String(o.rate)] : [];
  return ['-hide_banner', '-v', 'error', '-nostdin', '-y', '-i', src, ...filter, '-map_metadata', '-1', ...codec, ...rate, dst];
}

function runAsync(bin, args, timeoutMs = 170000) {
  return new Promise((resolve) => {
    let err = '';
    let done = false;
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const t = setTimeout(() => {
      if (!done) p.kill('SIGKILL');
    }, timeoutMs);
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      done = true;
      clearTimeout(t);
      resolve({ ok: false, msg: e.message });
    });
    p.on('close', (code) => {
      done = true;
      clearTimeout(t);
      resolve(code === 0 ? { ok: true } : { ok: false, msg: err.trim().split('\n').find((l) => l.trim()) || `exit ${code}` });
    });
  });
}

const nonEmpty = (f) => {
  try {
    return fs.statSync(f).size > 0;
  } catch {
    return false;
  }
};

/** ffmpeg conversion into dst (written via dst.part + rename, so a killed run never leaves a truncated file). */
export async function convertWithFfmpeg(src, dst, o) {
  const part = `${dst}.part${path.extname(dst)}`;
  fs.rmSync(part, { force: true });
  const r = await runAsync(FFMPEG(), ffmpegArgs(src, part, o));
  if (!r.ok || !nonEmpty(part)) {
    fs.rmSync(part, { force: true });
    return r.ok ? { ok: false, msg: 'ffmpeg wrote an empty file' } : r;
  }
  fs.renameSync(part, dst);
  return { ok: true };
}

// ---------------------------------------------------------------- afconvert fallback (whole files only)

function runAf(args) {
  const r = spawnSync(AFCONVERT(), args, { encoding: 'utf8', timeout: 170000 });
  if (r.error) return { ok: false, msg: r.error.message };
  const out = args[args.length - 1];
  if (r.status !== 0 || !nonEmpty(out)) return { ok: false, msg: (r.stderr || r.stdout || `exit ${r.status}`).trim().split('\n').find((l) => l.trim()) || `exit ${r.status}` };
  return { ok: true };
}

const M4A_ATTEMPTS = [
  ['-f', 'm4af', '-d', 'aac', '-b', '192000'],
  ['-f', 'm4af', '-d', 'aac@44100', '-b', '192000'],
  ['-f', 'm4af', '-d', 'aac'],
];
const WAV_ARGS = ['-f', 'WAVE', '-d', 'LEI16'];

/** afconvert src → dst as a whole file ('m4a' | 'wav'). */
export function afEncode(src, dst, format) {
  if (format === 'wav') return runAf([...WAV_ARGS, src, dst]);
  let last = null;
  for (const a of M4A_ATTEMPTS) {
    fs.rmSync(dst, { force: true });
    last = runAf([...a, src, dst]);
    if (last.ok) return last;
  }
  return last;
}

/**
 * afconvert path: whole-file conversion, JS slicing. `cache` (Map src → whole-file WAV bytes) lets every zone of a
 * consolidated file reuse one conversion; jobs are ordered by source file, so one entry is enough.
 */
export function convertWithAfconvert(src, dst, { format, segments, gainDb = 0 }, tmpDir, cache = new Map()) {
  let segs = (segments || []).filter((s) => !(s.start === 0 && s.end == null));
  const gain = Math.abs(gainDb) >= 0.05 ? gainDb : 0;
  if (!segs.length && !gain) return afEncode(src, dst, format);
  if (!segs.length) segs = [{ start: 0, end: null }];
  try {
    // One whole-file WAV per source, kept in memory for the run (a consolidated CAF is sliced ~100 times).
    let whole = cache.get(src);
    if (!whole) {
      const full = path.join(tmpDir, `whole-${crypto.createHash('sha1').update(src).digest('hex').slice(0, 12)}.wav`);
      const r = runAf([...WAV_ARGS, src, full]);
      if (!r.ok) return r;
      whole = fs.readFileSync(full);
      fs.rmSync(full, { force: true });
      cache.clear(); // keep at most one source in memory
      cache.set(src, whole);
    }
    const cut = path.join(tmpDir, `cut-${process.pid}-${Math.random().toString(36).slice(2)}.wav`);
    fs.writeFileSync(cut, sliceWavSegments(whole, segs, gain));
    if (format === 'wav') {
      fs.renameSync(cut, dst);
      return { ok: true };
    }
    const r = afEncode(cut, dst, format);
    fs.rmSync(cut, { force: true });
    return r;
  } catch (e) {
    return { ok: false, msg: e.message };
  }
}

/**
 * Convert one file with whichever encoder was chosen for the run.
 * @param {'ffmpeg'|'afconvert'} encoder
 */
export async function convertFile(encoder, src, dst, o, tmpDir, cache) {
  if (encoder === 'ffmpeg') return convertWithFfmpeg(src, dst, o);
  return convertWithAfconvert(src, dst, o, tmpDir, cache);
}

/** Run async jobs with at most `n` in flight. */
export async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (i < items.length) {
      const k = i++;
      await fn(items[k], k);
    }
  });
  await Promise.all(workers);
}
