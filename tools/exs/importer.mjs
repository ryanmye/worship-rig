// GarageBand / Logic (.exs) import as a module (v11-importer): everything tools/import-garageband.mjs used to do
// inline, so the CLI and the Mac app's in-app importer (tools/exs/import-worker.mjs, run off the main and renderer
// threads by importer-host.js) share one implementation. The CLI is a thin wrapper over this file and keeps its flags
// and output; the app calls scanLibrary() and importInstruments(), which add progress callbacks, an AbortSignal,
// path checks and size limits on top of the same discover → resolve → fitToBudget → importOne steps.
// PERSONAL USE ONLY: converted Apple content stays on this Mac and is never bundled (docs/garageband-import.md).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseExs, ExsFormatError } from './parser.mjs';
import { planInstrument, manifestEntry, estimateBytes, sourceKey, zoneSlice, planSegments, autoMaxSeconds, PIANO_RE } from './mapping.mjs';
import { DEFAULT_INSTRUMENT_ROOTS, DEFAULT_SAMPLE_ROOTS, DEFAULT_CACHE, walkFiles, loadOrBuildIndex, resolveSample, underRoots } from './sample-index.mjs';
import { hasAfconvert, hasFfmpeg, convertFile, pool, FORMATS } from './convert.mjs';

export const DEFAULT_OUT = path.join(os.homedir(), 'Music', 'Worship Rig', 'Samples');
export const EXIT_INCOMPLETE = 3;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** realpath of the longest existing prefix of `p`, plus the rest (so a not-yet-created --out still compares right). */
function realish(p) {
  let head = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...tail);
    } catch {
      const up = path.dirname(head);
      if (up === head) return path.resolve(p);
      tail.unshift(path.basename(head));
      head = up;
    }
  }
}

/**
 * security S7: --out must not be inside <repo>/app (electron-builder would package personal Apple content).
 * @returns {{ error?: string, warn?: string }}
 */
export function checkOutDir(out, repoRoot = REPO_ROOT) {
  const o = realish(out);
  const repo = realish(repoRoot);
  const inside = (dir) => o === dir || o.startsWith(dir + path.sep);
  if (inside(path.join(repo, 'app'))) {
    return { error: `--out ${out} is inside the app folder (${path.join(repo, 'app')}), which is packaged into Worship Rig.app. Imported Apple sounds are personal-use only: use the default (${DEFAULT_OUT}) or <repo>/user-samples.` };
  }
  if (inside(repo) && !inside(path.join(repo, 'user-samples'))) {
    return { warn: `warning: --out ${out} is inside the repo but not under user-samples/ (the only git-ignored place for imports); do not commit it.` };
  }
  return {};
}

/**
 * v11-importer: `dir` resolves (realpath of its existing prefix) to `root` or inside it. Used for the in-app output
 * folder, which must be one of the My Samples scan roots (or below one), so the automatic Rescan finds the packs.
 */
export function insideDir(dir, root) {
  const d = realish(dir);
  const r = realish(root);
  return d === r || d.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** Pick the encoder and output format for a run. Returns { encoder, format, bitrate, rate, note? } or { error }. */
export function chooseEncoder(o, { ffmpeg = hasFfmpeg(), afconvert = hasAfconvert() } = {}) {
  let encoder = o.encoder;
  if (encoder === 'auto') encoder = ffmpeg ? 'ffmpeg' : afconvert ? 'afconvert' : null;
  if (!encoder) return { error: 'Neither ffmpeg nor afconvert was found. Install ffmpeg (brew install ffmpeg), or run on a Mac (afconvert ships with macOS). --list, --dry and --dump work anywhere.' };
  if (encoder === 'ffmpeg' && !ffmpeg) return { error: 'ffmpeg not found (brew install ffmpeg), or use --encoder afconvert.' };
  if (encoder === 'afconvert' && !afconvert) return { error: 'afconvert not found. It ships with macOS; elsewhere install ffmpeg and use --encoder ffmpeg.' };
  let format = o.format || (encoder === 'ffmpeg' ? 'mp3' : 'm4a');
  let note;
  if (!FORMATS[encoder].includes(format)) {
    note = `afconvert cannot write ${format}; using m4a (install ffmpeg for mp3)`;
    format = 'm4a';
  }
  const bitrate = o.bitrate || (format === 'm4a' ? 192000 : 160000);
  const rate = o.rate || (format === 'mp3' && encoder === 'ffmpeg' ? 48000 : 0);
  return { encoder, format, bitrate, rate: encoder === 'ffmpeg' ? rate : 0, note };
}

/**
 * Where ffmpeg is installed when it isn't on PATH (v11-importer). A Mac app started from Finder gets launchd's PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), which never has Homebrew's /opt/homebrew/bin (Apple silicon) or /usr/local/bin
 * (Intel), so `brew install ffmpeg` would look "missing" in the app although the CLI finds it in Terminal.
 */
export const FFMPEG_DIRS = Object.freeze(['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin']);

/**
 * The ffmpeg binary to use: $FFMPEG when set (tests, or a custom build), else `ffmpeg` on PATH, else the first of
 * FFMPEG_DIRS that has an executable ffmpeg. null when there is none.
 * @param {{ env?: object, dirs?: readonly string[], onPath?: () => boolean }} [o]
 * @returns {string|null}
 */
export function findFfmpeg({ env = process.env, dirs = FFMPEG_DIRS, onPath = hasFfmpeg } = {}) {
  if (env.FFMPEG) return onPath() ? env.FFMPEG : null;
  if (onPath()) return 'ffmpeg';
  for (const d of dirs) {
    const p = path.join(d, 'ffmpeg');
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* not here */
    }
  }
  return null;
}

export const mb = (b) => `${(b / 1048576).toFixed(b < 10 * 1048576 ? 1 : 0)} MB`;

function originOf(p) {
  if (p.includes('/GarageBand/') || p.includes('/Instrument Library/')) return 'GarageBand';
  if (p.includes('/Logic/') || p.includes('Audio Music Apps')) return 'Logic';
  return 'EXS';
}

/** Short, machine-independent description of where an .exs came from, for the manifest's `source`. */
export function sourceLabel(exsPath, origin) {
  const m = /(?:^|\/)((?:Sampler Instruments|Instrument Library)\/.*)$/.exec(exsPath.split(path.sep).join('/'));
  return `${origin} ${m ? m[1] : path.basename(exsPath)}`;
}

/** Parse one .exs into a discover() entry (throws on unreadable / unparseable files). */
export function entryFor(exsPath, { maxNotes } = {}) {
  const parsed = parseExs(fs.readFileSync(exsPath));
  const name = path.basename(exsPath).replace(/\.exs$/i, '');
  const plan = planInstrument(parsed, { name, maxNotesPerLayer: maxNotes });
  return { exsPath, name, origin: originOf(exsPath), parsed, plan };
}

/** Find and parse every .exs under the instrument roots. */
export function discover(roots, { maxNotes } = {}) {
  const found = [];
  const errors = [];
  for (const r of roots) {
    for (const p of walkFiles(r, (n) => n.toLowerCase().endsWith('.exs'))) {
      try {
        found.push(entryFor(p, { maxNotes }));
      } catch (e) {
        errors.push({ exsPath: p, error: e instanceof ExsFormatError ? e.message : `${e.name}: ${e.message}` });
      }
    }
  }
  found.sort((a, b) => a.name.localeCompare(b.name) || a.origin.localeCompare(b.origin));
  return { found, errors };
}

/** Resolve every sample the plan needs. Returns Map(sampleIndex → {path,how}|null). */
export function resolvePlan(entry, index, roots) {
  const res = new Map();
  for (const L of entry.plan.layers) {
    for (const p of L.picks) {
      const si = p.zone.sampleIndex;
      if (!res.has(si)) res.set(si, resolveSample(entry.parsed.samples[si], entry.exsPath, index, { roots }));
    }
  }
  return res;
}

export function counts(res) {
  let ok = 0;
  for (const v of res.values()) if (v) ok++;
  return { ok, total: res.size };
}

/** --import texts are case-insensitive substrings, except that an exact name match wins over substring matches. */
export function select(found, o) {
  const pick = new Set();
  for (const text of o.imports.map((s) => s.toLowerCase())) {
    const exact = found.filter((f) => f.name.toLowerCase() === text);
    for (const f of exact.length ? exact : found.filter((f) => f.name.toLowerCase().includes(text))) pick.add(f);
  }
  if (o.pianos) for (const f of found) if (PIANO_RE.test(f.name)) pick.add(f);
  return found.filter((f) => pick.has(f));
}

/** Same instrument name in several places (GarageBand + Logic copies) → keep the one with most resolved samples. */
export function dedupe(entries) {
  const by = new Map();
  for (const e of entries) {
    const k = e.plan.id;
    const prev = by.get(k);
    if (!prev || e.resolvedCount > prev.resolvedCount) by.set(k, e);
  }
  return [...by.values()];
}

export const estOpts = (st) => ({ bitrate: st.bitrate, rate: st.rate, maxSeconds: st.maxSeconds });

/** Re-plan with thinner layers until the estimate fits in maxMb (minor-third grid first, then evenly). */
export function fitToBudget(entry, st, log) {
  if (!st.maxMb) return;
  const budget = st.maxMb * 1048576;
  const est = () => estimateBytes(entry.plan.layers, entry.parsed.samples, st.format, estOpts(st));
  const before = est();
  if (before <= budget) return;
  const most = Math.max(...entry.plan.layers.map((L) => L.picks.length));
  for (let n = Math.min(most - 1, 30); n >= 4; n = n > 30 ? 30 : n - 2) {
    entry.plan = planInstrument(entry.parsed, { name: entry.name, maxNotesPerLayer: n });
    if (est() <= budget) break;
  }
  log(`  ~${mb(before)} > --max-mb ${st.maxMb}: thinned to ≤ ${Math.max(...entry.plan.layers.map((L) => L.picks.length))} notes per layer (~${mb(est())})`);
}

// ---------------------------------------------------------------- import

function linkOrCopy(src, dst) {
  try {
    fs.linkSync(src, dst);
  } catch {
    fs.copyFileSync(src, dst);
  }
}

const FALLBACKS = { ffmpeg: ['mp3', 'm4a', 'wav'], afconvert: ['m4a', 'wav'] };

// DC_PACKS: four packs (claverotor, learner-s-piano, record-collection-grand, rise-above-piano) tripped the
// importer's own --validate DC-offset check (|dc|/peak > 5e-4). Mirrors tools/samples/process-musyngkite.mjs's S2
// fix: a 10 Hz high-pass ahead of the rest of the chain removes the bias without touching the audible band (2-pole,
// -0.1 dB at 27.5 Hz). Every ffmpeg conversion in this file passes `highpassHz: HPF_HZ` to convert.mjs's
// ffmpegArgs, which inserts the filter right after each segment's trim and before loudness/fade — same ordering as
// process-musyngkite.mjs (high-pass before volume/afade) — so this stays one ffmpeg pass. afconvert is untouched:
// every DC-offset pack in the first real run was an ffmpeg import.
const HPF_HZ = 10;

/**
 * Once per run: convert the first resolvable file in the chosen format. If the encoder can't write it (no libmp3lame
 * in this ffmpeg build, no AAC encoder in afconvert…), fall back along FALLBACKS for the whole run.
 */
async function probeFormat(entry, o, st, log) {
  if (st.probed) return;
  const p = entry.plan.layers.flatMap((L) => L.picks).find((x) => entry.resolved.get(x.zone.sampleIndex));
  if (!p) return;
  st.probed = true;
  const smp = entry.parsed.samples[p.zone.sampleIndex];
  const seg = planSegments(zoneSlice(p.zone, smp), smp.length || 0, Math.round(2 * (smp.sampleRate || 44100)));
  const src = entry.resolved.get(p.zone.sampleIndex).path;
  const chain = FALLBACKS[st.encoder] || [st.format];
  fs.mkdirSync(o.out, { recursive: true });
  let first = null;
  for (const fmt of chain.slice(Math.max(0, chain.indexOf(st.format)))) {
    const tmp = path.join(o.out, `.probe-${process.pid}.${fmt}`);
    const r = await convertFile(st.encoder, src, tmp, { format: fmt, bitrate: fmt === st.format ? st.bitrate : undefined, rate: st.rate, segments: seg.segments, highpassHz: HPF_HZ, signal: o.signal }, o.out, new Map());
    for (const f of fs.readdirSync(o.out)) if (f.startsWith(`.probe-${process.pid}`) || /^(whole|cut)-/.test(f)) fs.rmSync(path.join(o.out, f), { force: true });
    if (o.signal?.aborted) {
      st.probed = false; // a cancelled probe proves nothing about the encoder
      return;
    }
    if (r.ok) {
      if (fmt !== st.format) {
        log(`  ${st.format.toUpperCase()} encoding failed (${first}); falling back to ${fmt === 'wav' ? '16-bit WAV' : fmt} for this run`);
        st.format = fmt;
        if (fmt !== 'mp3') st.bitrate = fmt === 'm4a' ? 192000 : st.bitrate;
      }
      return;
    }
    first ??= r.msg;
  }
}

// Lossy encoders overshoot the source peak: libmp3lame at 160 kb/s turned Yamaha's 0.00 dBFS 107_B6KM56_H.wav into a
// +0.22 dBFS mp3 (clipped). mp3/m4a output is therefore lowered by this much, uniformly across the instrument, so the
// layers keep their relative levels; the overall level is gainTrim's job (tools/calibrate.mjs). WAV output is untouched.
export const LOSSY_HEADROOM_DB = 1;
const headroomDb = (st) => (st.format === 'wav' ? 0 : LOSSY_HEADROOM_DB);

const settingsKey = (st) => JSON.stringify({ v: 4, headroomDb: headroomDb(st), keepLevels: st.keepLevels !== false, encoder: st.encoder, format: st.format, bitrate: st.bitrate, rate: st.rate, maxSeconds: st.maxSeconds });

/**
 * Convert (resumably) and install one instrument. Converted files live in <out>/.<id>.importing/_src/<hash>.<ext>
 * until the instrument is complete, so a run that stops (--batch, a timeout, Ctrl-C) continues where it left off.
 * v11-importer: `o.signal` (AbortSignal) stops the run — no new conversions start, running ffmpegs are killed, the
 * work folder is removed and the result is {ok:false, cancelled:true}; `o.onFile(done, total)` reports each
 * conversion (the CLI's TTY counter; the app's progress bar), `o.onStart(total)` the number about to be converted and
 * `o.onEnd()` the end of the conversions.
 * @returns {Promise<{ ok:boolean, incomplete?:boolean, cancelled?:boolean, reason?:string, dir?:string,
 *   manifest?:object, missing?:number, failures?:string[] }>}
 */
export async function importOne(entry, o, st, log) {
  const { plan, parsed, exsPath } = entry;
  const res = entry.resolved;
  const missing = [...res.values()].filter((v) => !v).length;
  const id = o.id || plan.id;
  const finalDir = path.join(o.out, id);
  const displayPlan = { ...plan, id, name: o.name || plan.name };
  if (!o.dry) await probeFormat(entry, o, st, log);
  // Files to produce: one per distinct zone slice + level. Levels (group + zone volume) are baked in relative to the
  // loudest zone kept, so nothing is boosted, minus LOSSY_HEADROOM_DB for mp3/m4a.
  const jobs = [];
  const byKey = new Map();
  const ref = Math.max(...plan.layers.flatMap((L) => L.picks.map((p) => p.zone.gainDb || 0)));
  const gainOf = (z) => Math.round(((st.keepLevels === false ? 0 : (z.gainDb || 0) - ref) - headroomDb(st)) * 10) / 10;
  const keyOf = (p) => `${sourceKey(p.zone, parsed.samples[p.zone.sampleIndex])}|${gainOf(p.zone)}`;
  for (const L of plan.layers) {
    for (const p of L.picks) {
      const smp = parsed.samples[p.zone.sampleIndex];
      const k = keyOf(p);
      if (byKey.has(k)) continue;
      const maxSec = st.maxSeconds === 'auto' ? autoMaxSeconds(p.midi) : st.maxSeconds || 0;
      const rate = smp.sampleRate || 44100;
      const seg = planSegments(zoneSlice(p.zone, smp), smp.length || 0, maxSec ? Math.round(maxSec * rate) : 0);
      const hash = crypto.createHash('sha1').update(`${settingsKey(st)}|${k}|${maxSec}`).digest('hex').slice(0, 16);
      const job = { k, p, smp, seg, rate, hash, gainDb: gainOf(p.zone), src: res.get(p.zone.sampleIndex)?.path || null };
      byKey.set(k, job);
      jobs.push(job);
    }
  }
  if (o.dry) {
    log(`\n[dry] ${entry.name} (${entry.origin}) → ${finalDir}`);
    for (const L of plan.layers) {
      const have = L.picks.filter((p) => res.get(p.zone.sampleIndex));
      log(`  layer vel ${L.vel[0]}-${L.vel[1]}: ${have.length}/${L.picks.length} notes  ${have.map((p) => p.note).join(' ')}`);
    }
    log(`  ${jobs.length} file(s), release τ ${plan.release}s, category ${plan.category}, ~${mb(estimateBytes(plan.layers, parsed.samples, st.format, estOpts(st)))} as ${st.format}${missing ? `, ${missing} sample file(s) not found` : ''}`);
    for (const w of new Set(plan.warnings)) log(`  note: ${w}`);
    return { ok: true, dry: true };
  }
  const work = path.join(o.out, `.${id}.importing`);
  const cancelled = () => {
    fs.rmSync(work, { recursive: true, force: true });
    log(`  stopped: ${entry.name} was not imported`);
    return { ok: false, cancelled: true, reason: 'cancelled' };
  };
  if (o.signal?.aborted) return cancelled();
  fs.mkdirSync(o.out, { recursive: true });
  const srcDir = path.join(work, '_src');
  const stamp = path.join(work, 'settings.json');
  let prevSettings = null;
  try {
    prevSettings = fs.readFileSync(stamp, 'utf8');
  } catch {
    /* fresh */
  }
  if (prevSettings !== settingsKey(st)) fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(stamp, settingsKey(st));
  const outOf = (j) => path.join(srcDir, `${j.hash}.${st.format}`);
  const todo = jobs.filter((j) => j.src && !fs.existsSync(outOf(j)));
  const resumed = jobs.filter((j) => j.src).length - todo.length;
  if (st.encoder === 'afconvert') todo.sort((a, b) => (a.src < b.src ? -1 : a.src > b.src ? 1 : 0)); // one cached source at a time
  const now = st.batch ? todo.slice(0, st.batch) : todo;
  log(`\n${entry.name} (${entry.origin}) → ${finalDir}: ${jobs.length} file(s)${resumed ? `, ${resumed} already converted` : ''}, converting ${now.length} with ${st.encoder}${st.encoder === 'ffmpeg' ? ` ×${st.jobs}` : ''}`);
  if (o.onStart) o.onStart(now.length);
  const failures = [];
  const cache = new Map();
  let n = 0;
  const t0 = Date.now();
  await pool(now, st.encoder === 'ffmpeg' ? st.jobs : 1, async (j) => {
    const truncated = j.seg.truncated;
    const totalSec = j.seg.frames != null ? j.seg.frames / j.rate : 0;
    const r = await convertFile(st.encoder, j.src, outOf(j), { format: st.format, bitrate: st.bitrate, rate: st.rate, segments: j.seg.segments, gainDb: j.gainDb, fadeOutSec: truncated ? 0.25 : 0, totalSec, highpassHz: HPF_HZ, signal: o.signal }, work, cache);
    if (o.signal?.aborted) return;
    if (!r.ok) failures.push(`${path.basename(j.src)} [${j.k}]: ${r.msg}`);
    n++;
    if (o.onFile) o.onFile(n, now.length);
  }, { signal: o.signal });
  if (o.onEnd) o.onEnd();
  if (o.signal?.aborted) return cancelled();
  for (const f of fs.readdirSync(work)) if (/^(whole|cut)-/.test(f)) fs.rmSync(path.join(work, f), { force: true });
  const left = jobs.filter((j) => j.src && !fs.existsSync(outOf(j))).length;
  if (left && st.batch && todo.length > now.length) {
    log(`  converted ${now.length - failures.length} in ${((Date.now() - t0) / 1000).toFixed(1)} s; ${left} file(s) left — run the same command again to continue`);
    for (const f of failures.slice(0, 5)) log(`    failed: ${f}`);
    return { ok: true, incomplete: true, left };
  }
  // Install: hard-link each converted file to <layer.dir>/<note>.<ext>.
  const stage = path.join(work, 'stage');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const writtenLayers = [];
  const converted = jobs.filter((j) => j.src && fs.existsSync(outOf(j))).length;
  for (const L of plan.layers) {
    const dir = path.join(stage, L.dir);
    const notes = [];
    for (const p of L.picks) {
      const j = byKey.get(keyOf(p));
      if (!j?.src || !fs.existsSync(outOf(j))) continue;
      fs.mkdirSync(dir, { recursive: true });
      linkOrCopy(outOf(j), path.join(dir, `${p.note}.${st.format}`));
      notes.push(p.note);
    }
    writtenLayers.push({ vel: L.vel, dir: L.dir, notes });
  }
  const inst = manifestEntry(displayPlan, { ext: st.format, origin: entry.origin, source: sourceLabel(exsPath, entry.origin), writtenLayers });
  if (!inst.layers.length) {
    fs.rmSync(work, { recursive: true, force: true });
    log(`  FAILED: no sample could be ${missing === res.size ? 'found' : 'converted'} (${missing} missing, ${failures.length} failed)`);
    for (const f of failures.slice(0, 5)) log(`    ${f}`);
    return { ok: false, reason: missing === res.size ? 'no-samples' : 'convert-failed', missing, failures };
  }
  // Same top-level shape as app/samples/manifest.json: { instruments: [...] }.
  const manifest = { instruments: [inst] };
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const old = path.join(o.out, `.${id}.old-${process.pid}`);
  if (fs.existsSync(finalDir)) fs.renameSync(finalDir, old);
  fs.renameSync(stage, finalDir);
  fs.rmSync(old, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
  const made = inst.layers.reduce((s, L) => s + L.notes.length, 0);
  log(`  ok: ${inst.layers.length} layer(s) × ${inst.layers.map((L) => L.notes.length).join('/')} notes = ${made} note file(s) from ${converted} converted audio file(s), ${st.format}${missing ? `; ${missing} sample(s) not found` : ''}${failures.length ? `; ${failures.length} conversion(s) failed` : ''}`);
  for (const f of failures.slice(0, 5)) log(`    failed: ${f}`);
  for (const w of new Set(plan.warnings)) log(`  note: ${w}`);
  return { ok: true, dir: finalDir, manifest, missing, failures };
}

// ---------------------------------------------------------------- in-app API (v11-importer)

/** Size / count limits of the in-app importer (the CLI has none: it is run by hand). */
export const APP_LIMITS = Object.freeze({
  /** instruments listed by one scan (a full GarageBand + Logic library has a few hundred) */
  maxListed: 3000,
  /** instruments per import run */
  maxPerImport: 40,
  /** estimated converted size of one run, MB */
  maxTotalMb: 2048,
  /** per-instrument --max-mb (thinning, as the CLI's default) */
  maxMbPerInstrument: 120,
  /** free disk space kept after the estimate, MB */
  spareMb: 256,
});

/** Instrument + sample roots: `roots` (like the CLI's --root, used for both) or the Apple default locations. */
export function libraryRoots(roots) {
  const r = Array.isArray(roots) && roots.length ? roots.map((p) => path.resolve(p)) : null;
  return { instRoots: r || DEFAULT_INSTRUMENT_ROOTS.slice(), sampleRoots: r || DEFAULT_SAMPLE_ROOTS.slice() };
}

/** In-app encoder choice: ffmpeg (also from Homebrew's folder, see findFfmpeg) → mp3; else afconvert → m4a. */
export function appEncoder() {
  const ff = findFfmpeg();
  if (ff && ff !== 'ffmpeg' && !process.env.FFMPEG) process.env.FFMPEG = ff; // convert.mjs reads $FFMPEG on every call
  const ffmpeg = !!ff;
  const afconvert = hasAfconvert();
  const enc = chooseEncoder({ encoder: 'auto' }, { ffmpeg, afconvert });
  return { ...enc, ffmpeg, afconvert, ffmpegPath: ff };
}

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** Free bytes on the volume that holds `dir` (or its nearest existing parent); null when unknown. */
export function freeBytes(dir) {
  let d = path.resolve(dir);
  for (;;) {
    try {
      const s = fs.statfsSync(d);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      const up = path.dirname(d);
      if (up === d) return null;
      d = up;
    }
  }
}

/**
 * Scan the library for the Settings › My Samples importer: every .exs under the instrument roots, deduped by id (the
 * copy with the most samples found wins, as the CLI's import does), with sample counts, the audio's size on disk, the
 * estimated converted size (after the same 120 MB thinning the import applies) and whether it is already installed.
 * @param {{ roots?: string[]|null, out: string, cache?: string, reindex?: boolean, maxMb?: number,
 *   log?: (s:string)=>void }} o
 * @returns {{ roots:{path:string, exists:boolean}[], encoder:object, out:string, instruments:object[],
 *   parseErrors:number, truncated:boolean }}
 */
export function scanLibrary(o) {
  const log = o.log || (() => {});
  const { instRoots, sampleRoots } = libraryRoots(o.roots);
  const enc = appEncoder();
  const sizes = enc.error ? { encoder: null, format: 'mp3', bitrate: 160000, rate: 48000 } : enc; // estimates only
  const st = { ...sizes, maxSeconds: 'auto', maxMb: o.maxMb ?? APP_LIMITS.maxMbPerInstrument };
  const roots = [...new Set([...instRoots, ...sampleRoots])].map((p) => ({ path: p, exists: fs.existsSync(p) }));
  const present = instRoots.filter((r) => fs.existsSync(r));
  const base = { roots, encoder: publicEncoder(enc), out: o.out, instruments: [], parseErrors: 0, truncated: false };
  if (!present.length) return base;
  const { found, errors } = discover(present);
  const indexRoots = sampleRoots.filter((r) => fs.existsSync(r));
  const cache = o.cache || DEFAULT_CACHE;
  let { index, rebuilt } = loadOrBuildIndex(indexRoots, cache, { rebuild: !!o.reindex, log });
  const allowed = [...new Set([...sampleRoots, ...instRoots])];
  const withRes = () => {
    for (const e of found) {
      e.resolved = resolvePlan(e, index, allowed);
      const c = counts(e.resolved);
      e.resolvedCount = c.ok;
      e.neededCount = c.total;
    }
  };
  withRes();
  if (!rebuilt && found.some((e) => e.resolvedCount < e.neededCount)) {
    ({ index, rebuilt } = loadOrBuildIndex(indexRoots, cache, { rebuild: true, log }));
    withRes();
  }
  const entries = dedupe(found);
  const list = [];
  for (const e of entries.slice(0, APP_LIMITS.maxListed)) {
    fitToBudget(e, st, () => {});
    e.resolved = resolvePlan(e, index, allowed);
    const srcFiles = new Set([...e.resolved.values()].filter(Boolean).map((v) => v.path));
    let sourceBytes = 0;
    for (const f of srcFiles) sourceBytes += fileSize(f);
    const notes = e.plan.layers.reduce((n, L) => n + L.picks.length, 0);
    list.push({
      exsPath: e.exsPath,
      name: e.name,
      id: e.plan.id,
      origin: e.origin,
      category: e.plan.category,
      source: sourceLabel(e.exsPath, e.origin),
      zones: e.parsed.zones.length,
      layers: e.plan.layers.length,
      notes,
      found: e.resolvedCount,
      needed: e.neededCount,
      sourceBytes,
      estBytes: notes ? estimateBytes(e.plan.layers, e.parsed.samples, st.format, estOpts(st)) : 0,
      consolidated: e.parsed.samples.length === 1 && e.parsed.zones.length > 1,
      installed: fs.existsSync(path.join(o.out, e.plan.id, 'manifest.json')),
    });
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  return { ...base, instruments: list, parseErrors: errors.length, truncated: entries.length > APP_LIMITS.maxListed };
}

/** The encoder facts the dialog needs (plain data). */
function publicEncoder(enc) {
  return {
    encoder: enc.encoder || null, format: enc.format || null, ffmpeg: !!enc.ffmpeg, afconvert: !!enc.afconvert,
    error: enc.error ? 'no-encoder' : null,
  };
}

/**
 * Import instruments chosen in the app (v11-importer). Every `exsPaths` entry must resolve inside the instrument
 * roots and end in .exs; `out` must pass checkOutDir and, when `allowedOut` is given, lie inside one of those folders
 * (the My Samples scan roots). Limits: APP_LIMITS.maxPerImport instruments, maxTotalMb estimated, and the free space
 * on `out`'s volume. Instruments run one after another; `onProgress(ev)` hears
 *   {event:'start', items:[{exsPath,name,id}]}, {event:'instrument', index, files},
 *   {event:'file', index, done, files}, {event:'instrumentDone', index, ok, cancelled?, reason?, message?, notes?,
 *   layers?, missing?}
 * and `signal` stops the run (the current instrument is discarded, finished ones stay installed).
 * @returns {Promise<{ ok:boolean, error?:string, cancelled?:boolean, results:object[] }>}
 */
export async function importInstruments(o) {
  const log = o.log || (() => {});
  const emit = o.onProgress || (() => {});
  const { instRoots, sampleRoots } = libraryRoots(o.roots);
  const refuse = (error, extra) => ({ ok: false, error, results: [], ...extra });
  const paths = Array.isArray(o.exsPaths) ? [...new Set(o.exsPaths.map(String))] : [];
  if (!paths.length) return refuse('nothing-selected');
  if (paths.length > APP_LIMITS.maxPerImport) return refuse('too-many');
  const present = instRoots.filter((r) => fs.existsSync(r));
  // S7-style: realpath inside a library root, so neither '..' nor a symlink can reach another file
  if (paths.some((p) => !/\.exs$/i.test(p) || !path.isAbsolute(p) || !underRoots(p, present))) return refuse('bad-path');
  if (!o.out || !path.isAbsolute(o.out) || checkOutDir(o.out).error) return refuse('bad-out');
  if (Array.isArray(o.allowedOut) && !o.allowedOut.some((r) => insideDir(o.out, r))) return refuse('bad-out');
  const enc = appEncoder();
  if (enc.error) return refuse('no-encoder');
  const st = {
    ...enc, maxSeconds: 'auto', maxMb: o.maxMb ?? APP_LIMITS.maxMbPerInstrument, jobs: o.jobs || defaultJobs(),
    batch: 0, keepLevels: true,
  };
  const entries = [];
  for (const p of paths) {
    try {
      entries.push(entryFor(p));
    } catch (e) {
      log(`  ${p}: ${e.message}`);
      return refuse('unreadable');
    }
  }
  const { index } = loadOrBuildIndex(sampleRoots.filter((r) => fs.existsSync(r)), o.cache || DEFAULT_CACHE, { log });
  const allowed = [...new Set([...sampleRoots, ...instRoots])];
  for (const e of entries) {
    fitToBudget(e, st, log);
    e.resolved = resolvePlan(e, index, allowed);
    const c = counts(e.resolved);
    e.resolvedCount = c.ok;
    e.neededCount = c.total;
  }
  const chosen = dedupe(entries);
  const total = chosen.reduce((s, e) => s + estimateBytes(e.plan.layers, e.parsed.samples, st.format, estOpts(st)), 0);
  if (total > APP_LIMITS.maxTotalMb * 1048576) return refuse('too-big', { estBytes: total });
  const free = o.freeBytes !== undefined ? o.freeBytes : freeBytes(o.out);
  if (free != null && total + APP_LIMITS.spareMb * 1048576 > free) {
    return refuse('no-space', { estBytes: total, freeBytes: free });
  }
  emit({ event: 'start', items: chosen.map((e) => ({ exsPath: e.exsPath, name: e.name, id: e.plan.id })) });
  const results = [];
  for (let i = 0; i < chosen.length; i++) {
    const e = chosen[i];
    if (o.signal?.aborted) {
      results.push({ exsPath: e.exsPath, name: e.name, id: e.plan.id, ok: false, cancelled: true });
      emit({ event: 'instrumentDone', index: i, ok: false, cancelled: true });
      continue;
    }
    emit({ event: 'instrument', index: i, files: 0 });
    let r;
    try {
      r = await importOne(e, {
        out: o.out,
        signal: o.signal,
        onStart: (files) => emit({ event: 'instrument', index: i, files }),
        onFile: (done, files) => emit({ event: 'file', index: i, done, files }),
      }, st, log);
    } catch (x) {
      log(`  ${e.name}: ${x.stack || x.message}`);
      r = { ok: false, reason: 'error', message: x.message };
    }
    const inst = r.manifest?.instruments?.[0];
    const out = {
      exsPath: e.exsPath, name: e.name, id: e.plan.id, ok: !!r.ok, cancelled: !!r.cancelled, reason: r.reason,
      missing: r.missing || 0, failed: r.failures ? r.failures.length : 0,
      notes: inst ? inst.layers.reduce((s, L) => s + L.notes.length, 0) : 0, layers: inst ? inst.layers.length : 0,
      message: r.message || (r.failures && r.failures[0]) || undefined,
    };
    results.push(out);
    emit({ event: 'instrumentDone', index: i, ...out });
  }
  return { ok: true, cancelled: !!o.signal?.aborted, results, format: st.format, encoder: st.encoder };
}

/** Parallel conversions in the app: leave two cores for the audio and the UI (the CLI uses all of them, max 8). */
export function defaultJobs(cpus = os.cpus()?.length || 2) {
  return Math.max(1, Math.min(4, cpus - 2));
}
