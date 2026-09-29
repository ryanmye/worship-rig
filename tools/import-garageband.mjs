#!/usr/bin/env node
// Import Apple GarageBand / Logic sampler instruments (.exs) into Worship Rig's "My Samples" folder.
// PERSONAL USE ONLY: the converted files stay on this Mac, are never bundled with the app and must not be shared.
// Docs: docs/garageband-import.md. Node 18+, no npm dependencies. Audio: ffmpeg if installed (exact sample cuts,
// needed for consolidated .caf instruments; mp3 output), else macOS afconvert (whole-file conversions, m4a/wav).
//
//   node tools/import-garageband.mjs --list                    instruments found, sample counts, estimated size
//   node tools/import-garageband.mjs --import "Steinway"       import every instrument whose name contains this
//   node tools/import-garageband.mjs --pianos                  import everything matching piano|grand|upright|keys
//   node tools/import-garageband.mjs --dump <file.exs> [--hex] [--json]   print what the parser finds in one file
//   node tools/import-garageband.mjs --validate <pack dir>     check an imported pack (files decode, not silent, no DC)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseExs, ExsFormatError } from './exs/parser.mjs';
import { planInstrument, manifestEntry, estimateBytes, sourceKey, zoneSlice, planSegments, autoMaxSeconds, flatName, PIANO_RE, slugify } from './exs/mapping.mjs';
import { DEFAULT_INSTRUMENT_ROOTS, DEFAULT_SAMPLE_ROOTS, DEFAULT_CACHE, walkFiles, loadOrBuildIndex, resolveSample } from './exs/sample-index.mjs';
import { hasAfconvert, hasFfmpeg, convertFile, ffmpegArgs, pool, FORMATS } from './exs/convert.mjs';
import { HEADER_SIZE } from './exs/layout.mjs';

export const DEFAULT_OUT = path.join(os.homedir(), 'Music', 'Worship Rig', 'Samples');
export const EXIT_INCOMPLETE = 3;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const USAGE = `Import GarageBand / Logic sampler instruments into Worship Rig (personal use only).

  node tools/import-garageband.mjs --list
  node tools/import-garageband.mjs --import "Steinway" [--import "Strings" …]
  node tools/import-garageband.mjs --pianos
  node tools/import-garageband.mjs --dump "/path/to/Instrument.exs" [--hex] [--json]
  node tools/import-garageband.mjs --validate "<out>/<instrument-id>"

Options
  --dry                     show what would be imported, write nothing
  --out <dir>               output folder (default: ${DEFAULT_OUT}; never inside <repo>/app)
  --format mp3|m4a|wav      mp3 (default with ffmpeg) = 160 kb/s 48 kHz; m4a = AAC 192 kb/s (default without ffmpeg);
                            wav = 16-bit PCM
  --bitrate <n>k            mp3/m4a bitrate (default 160k for mp3, 192k for m4a)
  --rate <hz>               output sample rate (default 48000 for mp3; source rate otherwise)
  --encoder auto|ffmpeg|afconvert   (default auto: ffmpeg when installed)
  --max-mb N                if the estimate exceeds N MB, thin every layer to a minor-third grid (default 120; 0 = off)
  --max-notes-per-layer N   keep at most N notes per velocity layer (thinned to a minor-third grid first)
  --max-seconds auto|N|0    cut each file after N s (auto = the app's own cap + 1 s: 17 s up to C4, 11 s above)
  --id <slug> / --name <s>  override the output folder/id and display name (one instrument only)
  --no-levels               don't bake Logic's group/zone volume (dB) into the files (default: baked, relative to
                            the loudest zone, so soft velocity layers stay softer)
  --jobs N                  parallel conversions (default: CPU count, max 8; ffmpeg only)
  --batch N                 convert at most N files, keep the work folder and exit ${EXIT_INCOMPLETE}; rerun to continue
  --root <dir>              search this folder instead of the default Apple locations (repeatable)
  --cache <file>            sample index cache (default: ${DEFAULT_CACHE})
  --reindex                 rebuild the sample index even if the cache looks fresh
`;

function parseBitrate(v) {
  const m = /^(\d+(?:\.\d+)?)(k?)$/i.exec(String(v).trim());
  if (!m) throw new Error(`--bitrate must look like 160k (got ${v})`);
  return Math.round(parseFloat(m[1]) * (m[2] ? 1000 : 1));
}

export function parseArgs(argv) {
  const o = { imports: [], roots: [], format: null, out: DEFAULT_OUT, cache: DEFAULT_CACHE, maxNotes: 0, maxMb: 120, maxSeconds: 'auto', encoder: 'auto', jobs: Math.min(8, os.cpus()?.length || 2), batch: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    const num = (v, what) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${what} must be a non-negative number (got ${v})`);
      return n;
    };
    switch (a) {
      case '--list': o.list = true; break;
      case '--import': o.imports.push(val()); break;
      case '--pianos': o.pianos = true; break;
      case '--dry': case '--dry-run': o.dry = true; break;
      case '--out': o.out = path.resolve(val().replace(/^~(?=$|\/)/, os.homedir())); break;
      case '--format': o.format = val().toLowerCase(); break;
      case '--bitrate': o.bitrate = parseBitrate(val()); break;
      case '--rate': o.rate = Math.round(num(val(), '--rate')); break;
      case '--encoder': o.encoder = val().toLowerCase(); break;
      case '--max-mb': o.maxMb = num(val(), '--max-mb'); break;
      case '--max-notes-per-layer': o.maxNotes = parseInt(val(), 10); break;
      case '--max-seconds': { const v = val(); o.maxSeconds = v === 'auto' ? 'auto' : num(v, '--max-seconds'); break; }
      case '--id': o.id = slugify(val()); break;
      case '--name': o.name = val(); break;
      case '--no-levels': o.keepLevels = false; break;
      case '--jobs': o.jobs = Math.max(1, Math.round(num(val(), '--jobs'))); break;
      case '--batch': o.batch = Math.round(num(val(), '--batch')); break;
      case '--dump': o.dump = val(); break;
      case '--validate': o.validate = path.resolve(val().replace(/^~(?=$|\/)/, os.homedir())); break;
      case '--hex': o.hex = true; break;
      case '--json': o.json = true; break;
      case '--root': o.roots.push(path.resolve(val().replace(/^~(?=$|\/)/, os.homedir()))); break;
      case '--cache': o.cache = path.resolve(val()); break;
      case '--reindex': o.reindex = true; break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  if (o.format && !['mp3', 'm4a', 'wav'].includes(o.format)) throw new Error(`--format must be mp3, m4a or wav (got ${o.format})`);
  if (!['auto', 'ffmpeg', 'afconvert'].includes(o.encoder)) throw new Error(`--encoder must be auto, ffmpeg or afconvert (got ${o.encoder})`);
  if (o.maxNotes && !(o.maxNotes > 0)) throw new Error('--max-notes-per-layer must be a positive integer');
  return o;
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

const mb = (b) => `${(b / 1048576).toFixed(b < 10 * 1048576 ? 1 : 0)} MB`;
const pad = (s, n) => (String(s).length >= n ? String(s).slice(0, n - 1) + '…' : String(s).padEnd(n));
const lpad = (s, n) => String(s).padStart(n);

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

/** Find and parse every .exs under the instrument roots. */
export function discover(roots, { maxNotes } = {}) {
  const found = [];
  const errors = [];
  for (const r of roots) {
    for (const p of walkFiles(r, (n) => n.toLowerCase().endsWith('.exs'))) {
      try {
        const parsed = parseExs(fs.readFileSync(p));
        const name = path.basename(p).replace(/\.exs$/i, '');
        found.push({ exsPath: p, name, origin: originOf(p), parsed, plan: planInstrument(parsed, { name, maxNotesPerLayer: maxNotes }) });
      } catch (e) {
        errors.push({ exsPath: p, error: e instanceof ExsFormatError ? e.message : `${e.name}: ${e.message}` });
      }
    }
  }
  found.sort((a, b) => a.name.localeCompare(b.name) || a.origin.localeCompare(b.origin));
  return { found, errors };
}

/** Resolve every sample the plan needs. Returns Map(sampleIndex → {path,how}|null). */
function resolvePlan(entry, index, roots) {
  const res = new Map();
  for (const L of entry.plan.layers) {
    for (const p of L.picks) {
      const si = p.zone.sampleIndex;
      if (!res.has(si)) res.set(si, resolveSample(entry.parsed.samples[si], entry.exsPath, index, { roots }));
    }
  }
  return res;
}

function counts(res) {
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
function dedupe(entries) {
  const by = new Map();
  for (const e of entries) {
    const k = e.plan.id;
    const prev = by.get(k);
    if (!prev || e.resolvedCount > prev.resolvedCount) by.set(k, e);
  }
  return [...by.values()];
}

const estOpts = (st) => ({ bitrate: st.bitrate, rate: st.rate, maxSeconds: st.maxSeconds });

/** Re-plan with thinner layers until the estimate fits in maxMb (minor-third grid first, then evenly). */
function fitToBudget(entry, st, log) {
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

// ---------------------------------------------------------------- --dump

function hexdump(buf, off, len) {
  const lines = [];
  for (let i = 0; i < len; i += 16) {
    const row = buf.subarray(off + i, Math.min(off + len, off + i + 16));
    const hex = [...row].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const asc = [...row].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`    ${lpad(i, 4)}  ${hex.padEnd(47)}  ${asc}`);
  }
  return lines.join('\n');
}

export function dump(file, o, log = console.log) {
  const buf = fs.readFileSync(file);
  const parsed = parseExs(buf);
  const name = path.basename(file).replace(/\.exs$/i, '');
  const plan = planInstrument(parsed, { name, maxNotesPerLayer: o.maxNotes });
  const format = o.format || 'mp3';
  if (o.json) {
    log(JSON.stringify({ file, parsed, plan: { ...plan, layers: plan.layers.map((L) => ({ vel: L.vel, dir: L.dir, notes: L.picks.map((p) => p.note), zones: L.picks.map((p) => p.zone.index) })) } }, null, 2));
    return { parsed, plan };
  }
  log(`${file}`);
  log(`  ${buf.length} bytes, ${parsed.bigEndian ? 'big' : 'little'}-endian (${parsed.magic}), header name "${parsed.name}"${parsed.counts ? `, header counts ${parsed.counts.zones} zones / ${parsed.counts.groups} groups / ${parsed.counts.samples} samples` : ''}`);
  const byType = {};
  for (const c of parsed.chunks) byType[c.typeName] = (byType[c.typeName] || 0) + 1;
  log(`  chunks: ${Object.entries(byType).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  log(`\n  groups (${parsed.groups.length})`);
  parsed.groups.forEach((g, i) => {
    const sel = g.select ? (g.select.type === 'cc' ? `  CC${g.select.number} ${g.select.low}-${g.select.high}` : `  select ${g.select.type}`) : '';
    log(`    ${lpad(i, 3)}  ${pad(g.name, 30)} vol ${lpad(g.volume, 4)}  vel ${lpad(`${g.minVel}-${g.maxVel}`, 7)}  keys ${pad(`${flatName(g.keyLow)}-${flatName(g.keyHigh)}`, 10)}${sel}${g.trigger === 1 ? '  RELEASE' : ''}${g.mute ? '  MUTE' : ''}`);
  });
  log(`\n  zones (${parsed.zones.length})`);
  log(`    ${'#'.padStart(3)}  ${pad('name', 24)} root  keys        vel      grp  smp   start..end (+segment 2)        loop`);
  parsed.zones.forEach((z, i) => {
    const flags = [z.oneShot && 'oneshot', !z.pitch && 'nopitch', z.reverse && 'rev', !z.velRangeOn && 'vel-off', z.coarseTune && `coarse${z.coarseTune}`, z.fineTune && `fine${z.fineTune}`, z.invalid && 'BAD-SAMPLE'].filter(Boolean).join(',');
    const range = `${z.sampleStart}..${z.sampleEnd}${z.segment2 ? ` +${z.segment2.start}..${z.segment2.end}` : ''}`;
    log(`    ${lpad(i, 3)}  ${pad(z.name, 24)} ${pad(flatName(z.rootNote), 5)} ${pad(`${flatName(z.keyLow)}-${flatName(z.keyHigh)}`, 11)} ${pad(`${z.velLow}-${z.velHigh}`, 8)} ${lpad(z.groupIndex, 3)}  ${lpad(z.sampleIndex, 4)}  ${pad(range, 30)} ${z.loopOn ? `${z.loopStart}..${z.loopEnd}` : '-'}  ${flags}`);
  });
  log(`\n  samples (${parsed.samples.length})`);
  parsed.samples.forEach((s, i) => log(`    ${lpad(i, 3)}  ${pad(s.fileName, 36)} ${lpad(s.length, 9)} fr  ${lpad(s.sampleRate, 6)} Hz  ${lpad(s.bitDepth, 2)}-bit  ${s.channels || '?'}ch  ${s.type || ''}  ${s.path}`));
  log(`\n  plan → id "${plan.id}", category ${plan.category}${plan.group ? ` (group ${plan.group})` : ''}, release τ ${plan.release}s`);
  for (const L of plan.layers) log(`    layer vel ${L.vel[0]}-${L.vel[1]} → ${L.dir}/  ${L.picks.length} notes: ${L.picks.map((p) => p.note).join(' ')}`);
  if (plan.skipped.length) log(`    skipped ${plan.skipped.length} zone(s): ${[...new Set(plan.skipped.map((s) => s.reason))].join('; ')}`);
  log(`    estimated size: ${mb(estimateBytes(plan.layers, parsed.samples, format, { maxSeconds: o.maxSeconds ?? 'auto', bitrate: o.bitrate }))} as ${format}`);
  if (parsed.warnings.length || plan.warnings.length) {
    log('\n  warnings');
    for (const w of new Set(plan.warnings)) log(`    - ${w}`);
  }
  if (o.hex) {
    log('\n  raw bytes of the first chunk of each type (offsets from chunk start; paste these when reporting a parse problem)');
    const seen = new Set();
    for (const c of parsed.chunks) {
      if (seen.has(c.type)) continue;
      seen.add(c.type);
      log(`  ${c.typeName} "${c.name}" @${c.offset}, ${c.length} bytes (${HEADER_SIZE} header + ${c.length - HEADER_SIZE})`);
      log(hexdump(buf, c.offset, Math.min(c.length, 256)));
    }
  }
  return { parsed, plan };
}

// ---------------------------------------------------------------- --list

function list(entries, st, log) {
  log(`${pad('instrument', 40)} ${pad('from', 11)} ${lpad('zones', 5)} ${lpad('samples', 9)} ${lpad('layers', 6)} ${lpad('notes', 5)} ${lpad(`~${st.format}`, 8)}`);
  let total = 0;
  for (const e of entries) {
    const notes = e.plan.layers.reduce((n, L) => n + L.picks.length, 0);
    const est = estimateBytes(e.plan.layers, e.parsed.samples, st.format, estOpts(st));
    total += est;
    const smp = `${e.resolvedCount}/${e.neededCount}`;
    const consolidated = e.parsed.samples.length === 1 && e.parsed.zones.length > 1 ? '  (consolidated)' : '';
    log(`${pad(e.name, 40)} ${pad(e.origin, 11)} ${lpad(e.parsed.zones.length, 5)} ${lpad(smp, 9)} ${lpad(e.plan.layers.length, 6)} ${lpad(notes, 5)} ${lpad(mb(est), 8)}${e.resolvedCount < e.neededCount ? '  (missing samples)' : ''}${consolidated}`);
  }
  log(`\n${entries.length} instrument(s). "samples" = audio files found / files the import needs; size is an estimate of the converted output (${mb(total)} for all).`);
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
// -0.1 dB at 27.5 Hz). Reuses convert.mjs's ffmpegArgs (segments/gain/trim math untouched) and only inserts the
// filter into the -af / -filter_complex string it returns, right after each segment's trim and before loudness/fade
// — same ordering as process-musyngkite.mjs (high-pass before volume/afade) — so this stays one ffmpeg pass.
const HPF_HZ = 10;

function withHighpass(args) {
  const inject = (chain) =>
    /asetpts=PTS-STARTPTS/.test(chain)
      ? chain.replace(/asetpts=PTS-STARTPTS/g, `asetpts=PTS-STARTPTS,highpass=f=${HPF_HZ}`)
      : `highpass=f=${HPF_HZ}${chain ? `,${chain}` : ''}`;
  const af = args.indexOf('-af');
  if (af !== -1) {
    args[af + 1] = inject(args[af + 1]);
    return args;
  }
  const fc = args.indexOf('-filter_complex');
  if (fc !== -1) {
    args[fc + 1] = inject(args[fc + 1]);
    return args;
  }
  // No trim/gain/fade at all (an unmodified whole-file zone): add a plain -af before the codec args.
  const out = [...args];
  const at = out.indexOf('-map_metadata');
  out.splice(at === -1 ? out.length - 1 : at, 0, '-af', `highpass=f=${HPF_HZ}`);
  return out;
}

function runFfmpeg(args, timeoutMs = 170000) {
  return new Promise((resolve) => {
    let err = '';
    let done = false;
    const p = spawn(process.env.FFMPEG || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
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

/**
 * Like convert.mjs's convertFile, but for the ffmpeg encoder adds the DC_PACKS high-pass to the same command
 * (see withHighpass above). afconvert is untouched: every DC-offset pack in the first real run was an ffmpeg import.
 */
async function convertWithDcFix(encoder, src, dst, o, tmpDir, cache) {
  if (encoder !== 'ffmpeg') return convertFile(encoder, src, dst, o, tmpDir, cache);
  const part = `${dst}.part${path.extname(dst)}`;
  fs.rmSync(part, { force: true });
  const r = await runFfmpeg(withHighpass(ffmpegArgs(src, part, o)));
  const wrote = (() => {
    try {
      return fs.statSync(part).size > 0;
    } catch {
      return false;
    }
  })();
  if (!r.ok || !wrote) {
    fs.rmSync(part, { force: true });
    return r.ok ? { ok: false, msg: 'ffmpeg wrote an empty file' } : r;
  }
  fs.renameSync(part, dst);
  return { ok: true };
}

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
    const r = await convertWithDcFix(st.encoder, src, tmp, { format: fmt, bitrate: fmt === st.format ? st.bitrate : undefined, rate: st.rate, segments: seg.segments }, o.out, new Map());
    for (const f of fs.readdirSync(o.out)) if (f.startsWith(`.probe-${process.pid}`) || /^(whole|cut)-/.test(f)) fs.rmSync(path.join(o.out, f), { force: true });
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
 * @returns {Promise<{ ok:boolean, incomplete?:boolean, dir?:string, manifest?:object, stats?:object }>}
 */
async function importOne(entry, o, st, log) {
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
  fs.mkdirSync(o.out, { recursive: true });
  const work = path.join(o.out, `.${id}.importing`);
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
  const failures = [];
  const cache = new Map();
  let n = 0;
  const t0 = Date.now();
  await pool(now, st.encoder === 'ffmpeg' ? st.jobs : 1, async (j) => {
    const truncated = j.seg.truncated;
    const totalSec = j.seg.frames != null ? j.seg.frames / j.rate : 0;
    const r = await convertWithDcFix(st.encoder, j.src, outOf(j), { format: st.format, bitrate: st.bitrate, rate: st.rate, segments: j.seg.segments, gainDb: j.gainDb, fadeOutSec: truncated ? 0.25 : 0, totalSec }, work, cache);
    if (!r.ok) failures.push(`${path.basename(j.src)} [${j.k}]: ${r.msg}`);
    n++;
    if (process.stdout.isTTY) process.stdout.write(`\r  ${n}/${now.length}`);
  });
  if (process.stdout.isTTY) process.stdout.write('\r');
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
    return { ok: false };
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
  return { ok: true, dir: finalDir, manifest };
}

// ---------------------------------------------------------------- main

export async function main(argv, log = console.log, err = console.error) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    err(`${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (o.help || (!o.list && !o.dump && !o.validate && !o.imports.length && !o.pianos)) {
    log(USAGE);
    return o.help ? 0 : 2;
  }
  if (o.dump) {
    try {
      dump(o.dump, o, log);
      return 0;
    } catch (e) {
      err(`cannot read ${o.dump}: ${e.message}`);
      return 1;
    }
  }
  if (o.validate) {
    const { validatePack, printReport } = await import('./exs/validate-pack.mjs');
    const rep = await validatePack(o.validate, { maxMb: o.maxMb, jobs: o.jobs });
    printReport(rep, log, err);
    return rep.errors.length ? 1 : 0;
  }
  const instRoots = o.roots.length ? o.roots : DEFAULT_INSTRUMENT_ROOTS;
  const sampleRoots = o.roots.length ? o.roots : DEFAULT_SAMPLE_ROOTS;
  const allowedRoots = [...new Set([...sampleRoots, ...instRoots])]; // S7: stored absolute sample paths must be in here
  const outCheck = checkOutDir(o.out);
  if (outCheck.error) {
    err(outCheck.error);
    return 2;
  }
  if (outCheck.warn) err(outCheck.warn);
  const present = instRoots.filter((r) => fs.existsSync(r));
  if (!present.length) {
    err(`No instrument folders found. Looked in:\n${instRoots.map((r) => `  ${r}`).join('\n')}\nOpen GarageBand once (and let it download its sound library), or pass --root <folder>.`);
    return 1;
  }
  // Encoder/format: --list/--dry only need the format for size estimates, so they never fail on a missing encoder.
  const enc = chooseEncoder(o);
  const needEncoder = !o.list && !o.dry;
  if (enc.error && needEncoder) {
    err(enc.error);
    return 1;
  }
  const st = { ...(enc.error ? { encoder: null, format: o.format || 'mp3', bitrate: o.bitrate || 160000, rate: o.rate || 48000 } : enc), maxSeconds: o.maxSeconds, maxMb: o.maxMb, jobs: o.jobs, batch: o.batch, keepLevels: o.keepLevels !== false };
  if (enc.note && needEncoder) log(`note: ${enc.note}`);
  const { found, errors } = discover(present, { maxNotes: o.maxNotes });
  let { index, rebuilt } = loadOrBuildIndex(sampleRoots.filter((r) => fs.existsSync(r)), o.cache, { rebuild: o.reindex, log });
  const withRes = (entries) => {
    for (const e of entries) {
      e.resolved = resolvePlan(e, index, allowedRoots);
      const c = counts(e.resolved);
      e.resolvedCount = c.ok;
      e.neededCount = c.total;
    }
  };
  let entries = o.imports.length || o.pianos ? select(found, o) : found;
  withRes(entries);
  if (!rebuilt && entries.some((e) => e.resolvedCount < e.neededCount)) {
    ({ index, rebuilt } = loadOrBuildIndex(sampleRoots.filter((r) => fs.existsSync(r)), o.cache, { rebuild: true, log }));
    withRes(entries);
  }
  if (o.list) {
    list(entries, st, log);
    if (errors.length) {
      log(`\n${errors.length} file(s) could not be parsed:`);
      for (const e of errors.slice(0, 20)) log(`  ${e.exsPath}: ${e.error}`);
    }
    return 0;
  }
  entries = dedupe(entries);
  if (!entries.length) {
    err(`No instrument matched ${[...o.imports.map((s) => JSON.stringify(s)), o.pianos ? '--pianos' : ''].filter(Boolean).join(', ')}. Run --list to see names.`);
    return 1;
  }
  if ((o.id || o.name) && entries.length > 1) {
    err(`--id/--name apply to one instrument, but ${entries.length} matched: ${entries.map((e) => e.name).join(', ')}`);
    return 2;
  }
  let okCount = 0;
  let incomplete = 0;
  for (const e of entries) {
    try {
      if (!o.maxNotes) {
        fitToBudget(e, st, log);
        e.resolved = resolvePlan(e, index, allowedRoots);
      }
      const r = await importOne(e, o, st, log);
      if (r.incomplete) incomplete++;
      else if (r.ok) okCount++;
    } catch (x) {
      err(`  ${e.name}: ${x.stack || x.message}`);
    }
  }
  if (!o.dry) {
    if (incomplete) log(`\n${incomplete} instrument(s) not finished yet (--batch): run the same command again.`);
    log(`\nImported ${okCount}/${entries.length} instrument(s) into ${o.out}`);
    log('Personal use only: these files are converted from Apple content on this Mac and must never be bundled or shared.');
    if (okCount) log('In Worship Rig: restart the app, or Settings → Rescan samples. They appear under "My Samples".');
  }
  if (incomplete) return EXIT_INCOMPLETE;
  return okCount === entries.length ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
