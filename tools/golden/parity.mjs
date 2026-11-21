#!/usr/bin/env node
// Per-fixture parity table for native/docs/PARITY.md (wave-2 integrator; re-run after every wave).
//
//   node tools/golden/parity.mjs <render dir> [--log <rig_render stdout>] [--twin <second render dir>]
//                                [--manifest <path>] [--json <out.json>] [--md <out.md>]
//
// For every manifest fixture: module (task), manifest tier, PASS/FAIL at the manifest tier, PASS/fail at the EXACT
// tier (manifest.tolerances.exact), max|diff|, golden peak (from the WAV, checked against the manifest), native peak,
// silent-golden flag, the UNIMPLEMENTED note rig_render printed, the tasks a failing fixture still waits for, and
// (with --twin, e.g. the clang renders) whether the two renders are byte-identical. Prints the markdown to stdout
// unless --md is given. Read-only: never touches the manifest or the goldens.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav } from './wav.mjs';
import { compareSignals, levelStats } from './analysis.mjs';

const GOLD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../native/golden');
const argv = process.argv.slice(2);
const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const flags = new Set(['--log', '--twin', '--manifest', '--json', '--md']);
const dir = argv.find((a, i) => !a.startsWith('--') && !flags.has(argv[i - 1]));
if (!dir) {
  console.error('usage: parity.mjs <render dir> [--log file] [--twin dir] [--manifest path] [--json f] [--md f]');
  process.exit(2);
}
const mpath = opt('--manifest') || path.join(GOLD, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(mpath, 'utf8'));
const twin = opt('--twin');
const notes = new Map();
if (opt('--log')) {
  for (const line of fs.readFileSync(opt('--log'), 'utf8').split('\n')) {
    const m = /^(\S+)\s+wrote .*?\)\s+(UNIMPLEMENTED: .*)$/.exec(line);
    if (m) notes.set(m[1], m[2].trim());
  }
}

// Module (owning task) per fixture, by id. Order matters: first match wins.
const T11_IDS = ['synth-warm-pad', 'synth-glass-pad', 'synth-strings', 'synth-sub-bass', 'synth-soft-keys',
  'synth-bell'];
const T13_IDS = ['auto-slot-level', 'auto-reverb-send', 'auto-delay-send', 'auto-master-volume',
  'switch-retire-retain', 'fx-row-sweep'];
const MODULES = [
  ['T02 filters & strip', (id) => /^(eq-|width-)/.test(id) || id === 'pan-stereo-src'],
  ['T03 dynamics & master', (id) => /^(master-eq|glue-|limiter-)/.test(id)],
  ['T04 reverb', (id) => id.startsWith('reverb-')],
  ['T05 delay / chorus / lofi', (id) => /^(echo-|chorus-|lofi-)/.test(id)],
  ['T07 click', (id) => id.startsWith('click-')],
  ['T11 synth.js', (id) => T11_IDS.includes(id)],
  ['T12 sampler', (id) => id.startsWith('sampler-')],
  ['T13 Model: song & graph', (id) => T13_IDS.includes(id) || /^auto-.*-synth$/.test(id)],
  ['T15a synth-extra', (id) => id.startsWith('synth-')],
  ['T15b organ', (id) => id.startsWith('organ-') || id === 'pan-mono-src'],
  ['T16 drone', (id) => id.startsWith('drone-')],
  ['touch (T14 + T15 808-sub)', (id) => id.startsWith('touch-')],
  ['T14 Model: perform', () => true],
];
const moduleOf = (id) => MODULES.find(([, f]) => f(id))[0];

// What a fixture that does not pass yet still waits for (tasks after wave 2). From the wave-1 PARITY classification
// with T11, T12 and T13 removed (all done); a failing fixture not listed here is reported as UNEXPECTED.
const WAITS = {
  'auto-slot-level': 'T15 (organ)', 'auto-reverb-send': 'T15 (organ)', 'auto-master-volume': 'T15 (organ)',
  'auto-delay-send': 'T15 (synth:pluck)', 'fx-row-sweep': 'T16 (synth drone)',
  'drone-synth-2keys': 'T16', 'drone-synth-stage': 'T16', 'drone-freeze-dry': 'T16 + Ryan Q7',
  'drone-freeze-wet': 'T16 + Ryan Q7',
  'auto-modwheel-cc': 'T14, T15', 'scene-glide': 'T14, T15, T16', 'song-sunday-pad-piano': 'T14, T16',
  'song-gospel-stab-b3': 'T14, T15', 'bend-pitch-sampler': 'T14', 'bend-tape': 'T14', 'bend-modes': 'T14, T16',
  'swell-pedal-drone': 'T14, T15, T16', 'mono-legato': 'T14', 'panic-fadeout': 'T14',
};
const waitsFor = (id) => WAITS[id] ?? (id.startsWith('touch-') ? 'T14, T15 (808-sub)'
  : /^(synth-|organ-)/.test(id) || id === 'pan-mono-src' ? 'T15' : null);

const rows = [];
for (const e of manifest.fixtures) {
  const ref = path.join(path.dirname(mpath), e.file);
  const f = path.join(dir, `${e.id}.wav`);
  const row = { id: e.id, module: moduleOf(e.id), tier: e.classification, eipp: !!e.exactIfPrngPorted,
    note: notes.get(e.id) ?? '' };
  if (!fs.existsSync(f) || !fs.existsSync(ref)) {
    rows.push({ ...row, missing: true });
    continue;
  }
  const g = readWav(ref);
  const n = readWav(f);
  const man = compareSignals(g, n, e.tolerance);
  const ex = e.classification === 'exact' ? man : compareSignals(g, n, manifest.tolerances.exact);
  const gp = levelStats(g.chs).peak;
  row.pass = man.pass;
  row.fails = man.fails;
  row.exact = ex.pass;
  row.maxAbs = man.maxAbs;
  row.goldenPeak = gp;
  row.manifestPeak = e.peak;
  row.nativePeak = levelStats(n.chs).peak;
  row.silentGolden = gp === 0;
  if (twin) {
    const t = path.join(twin, `${e.id}.wav`);
    row.twinIdentical = fs.existsSync(t) && Buffer.compare(fs.readFileSync(t), fs.readFileSync(f)) === 0;
  }
  row.waits = row.pass ? null : (waitsFor(e.id) ?? 'UNEXPECTED');
  rows.push(row);
}

const order = MODULES.map(([m]) => m);
const byMod = new Map(order.map((m) => [m, rows.filter((r) => r.module === m)]));
const fmt = (x) => (x === undefined ? '—' : x === 0 ? '0' : x.toExponential(2));
const peak = (x) => (x === undefined ? '—' : Number(x.toPrecision(6)).toString());
const tierCell = (r) => `${r.tier}${r.tier === 'statistical' && r.eipp ? ' (exactIfPrngPorted)' : ''}`;
const result = (r) => {
  if (r.missing) return 'missing render/golden';
  if (r.pass) return r.silentGolden ? 'PASS (silent golden)' : 'PASS';
  const n = r.nativePeak < 1e-6 ? 'native silent' : `${r.fails[0]}`;
  return `FAIL (${n}); waits for ${r.waits}`;
};
const out = [];
const pass = rows.filter((r) => r.pass).length;
out.push('| module (task) | pass | of | exact-tier pass | byte-identical g++/clang |');
out.push('|---|---|---|---|---|');
for (const m of order) {
  const rs = byMod.get(m);
  if (!rs.length) continue;
  const p = rs.filter((r) => r.pass).length;
  const ex = rs.filter((r) => r.exact).length;
  const tw = twin ? `${rs.filter((r) => r.twinIdentical).length}/${rs.length}` : '—';
  out.push(`| ${m} | ${p} | ${rs.length} | ${ex} | ${tw} |`);
}
const exAll = rows.filter((r) => r.exact).length;
const twAll = twin ? `${rows.filter((r) => r.twinIdentical).length}/${rows.length}` : '—';
out.push(`| **total** | **${pass}** | **${rows.length}** | ${exAll} | ${twAll} |`);
out.push('');
for (const m of order) {
  const rs = byMod.get(m);
  if (!rs.length) continue;
  out.push(`### ${m}: ${rs.filter((r) => r.pass).length}/${rs.length}`, '');
  out.push('| fixture | tier (manifest) | result | exact tier | max\\|diff\\| | golden peak | native peak |');
  out.push('|---|---|---|---|---|---|---|');
  for (const r of rs) {
    out.push(`| \`${r.id}\` | ${tierCell(r)} | ${result(r)} | ${r.missing ? '—' : r.exact ? 'pass' : 'fail'} | `
      + `${fmt(r.maxAbs)} | ${peak(r.goldenPeak)} | ${peak(r.nativePeak)} |`);
  }
  out.push('');
}
const md = out.join('\n');
if (opt('--md')) fs.writeFileSync(opt('--md'), `${md}\n`);
else console.log(md);
if (opt('--json')) fs.writeFileSync(opt('--json'), `${JSON.stringify(rows, null, 1)}\n`);
const unexpected = rows.filter((r) => r.waits === 'UNEXPECTED').map((r) => r.id);
console.error(`${pass}/${rows.length} pass at the manifest tier, ${exAll} at the exact tier; `
  + `silent goldens: ${rows.filter((r) => r.silentGolden).map((r) => r.id).join(', ') || 'none'}; `
  + `unexpected failures: ${unexpected.join(', ') || 'none'}`);
process.exit(unexpected.length ? 1 : 0);
