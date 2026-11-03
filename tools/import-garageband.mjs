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
import { fileURLToPath } from 'node:url';
import { parseExs } from './exs/parser.mjs';
import { planInstrument, estimateBytes, flatName, slugify } from './exs/mapping.mjs';
import { DEFAULT_INSTRUMENT_ROOTS, DEFAULT_SAMPLE_ROOTS, DEFAULT_CACHE, loadOrBuildIndex } from './exs/sample-index.mjs';
import { HEADER_SIZE } from './exs/layout.mjs';
import {
  DEFAULT_OUT, EXIT_INCOMPLETE, checkOutDir, chooseEncoder, discover, resolvePlan, counts, select, dedupe, estOpts,
  fitToBudget, importOne, mb,
} from './exs/importer.mjs';

// v11-importer: the work itself lives in tools/exs/importer.mjs (shared with the Mac app's in-app importer); this file
// is the command line: flags, --list / --dump output and the run loop. Re-exported for the tests and older callers.
export { DEFAULT_OUT, EXIT_INCOMPLETE, LOSSY_HEADROOM_DB, checkOutDir, chooseEncoder, sourceLabel, discover, select } from './exs/importer.mjs';

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

const pad = (s, n) => (String(s).length >= n ? String(s).slice(0, n - 1) + '…' : String(s).padEnd(n));
const lpad = (s, n) => String(s).padStart(n);

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

// ---------------------------------------------------------------- main

/** The `\r  n/total` counter on a terminal (the app reports the same callbacks as a progress bar instead). */
const ttyProgress = {
  onFile: (n, total) => process.stdout.isTTY && process.stdout.write(`\r  ${n}/${total}`),
  onEnd: () => process.stdout.isTTY && process.stdout.write('\r'),
};

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
      const r = await importOne(e, { ...o, ...ttyProgress }, st, log);
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
