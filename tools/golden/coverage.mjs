#!/usr/bin/env node
// Coverage matrix of the golden fixtures against the engine contract (T17 task 1, SETUP_REVIEW HIGH 7).
//
//   node tools/golden/coverage.mjs            writes native/golden/COVERAGE.md from manifest.json + engine-api.json
//   node tools/golden/coverage.mjs --print    numbers only (before / after), no file
//
// A PARAMS row (102 in the contract) counts as covered when some fixture sets it to a value different from the row's
// default (patch, setup.drone, a param event) or automates it (any `param` event on it). "Before" = the fixtures that
// existed before the T17 wave (no `addedBy`), "after" = all. Operations are detected from fixture structure by the
// predicates in OPS below; what no fixture can reach is listed with the reason in UNCOVERED.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const GOLD = path.join(ROOT, 'native/golden');

const flat = (o, pre = '', out = {}) => {
  for (const [k, v] of Object.entries(o || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, `${pre}${k}.`, out);
    else out[`${pre}${k}`] = v;
  }
  return out;
};
const same = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : a === b
  || String(a) === String(b));
const rowKey = (p) => p.replace(/^slots\.\d+\./, 'slots.<i>.');

/** Concrete paths a fixture sets away from the default (or automates) -> Set of row keys. */
export function rowsTouched(fx, rows) {
  const def = new Map(rows.map((r) => [r.path, r.default]));
  const hit = new Set();
  const test = (concrete, v, automated) => {
    const k = rowKey(concrete);
    if (!def.has(k)) return;
    const d = def.get(k);
    if (automated || d === null || d === undefined || !same(v, d)) hit.add(k);
  };
  const patch = fx.setup?.patch || {};
  (patch.slots || []).forEach((sl, i) => {
    if (!sl) return;
    const { instrument, params, ...rest } = sl;
    for (const [k, v] of Object.entries(flat(rest))) test(`slots.${i}.${k}`, v, false);
  });
  for (const [unit, vals] of Object.entries(patch.fx || {})) {
    for (const [k, v] of Object.entries(vals)) test(unit === 'master' ? `master.${k}` : `fx.${unit}.${k}`, v, false);
  }
  for (const [k, v] of Object.entries(fx.setup?.drone || {})) if (k !== 'key' && k !== 'mode') test(`drone.${k}`, v,
    false);
  for (const e of fx.events || []) if (e.type === 'param') test(e.path, e.value, true);
  const stimulusFx = fx.kind === 'drone-freeze';
  if (stimulusFx) for (const k of Object.keys(fx.setup.params || {})) test(`drone.${k}`, (fx.setup.params || {})[k],
    false);
  return hit;
}

const has = (fx, type, pred = () => true) => (fx.events || []).some((e) => e.type === type && pred(e));
const slotsOf = (fx) => (fx.setup?.patch?.slots || []).filter(Boolean);
const bendModes = (fx) => {
  const m = new Set();
  const p = fx.setup?.patch?.bend?.mode;
  if (has(fx, 'bend')) m.add(p || 'pitch');
  for (const e of fx.events || []) if (e.type === 'routing' && e.routing?.bend?.mode && has(fx,
    'bend')) m.add(e.routing.bend.mode);
  return m;
};
const anySlot = (fx, f) => slotsOf(fx).some(f);

/** Operations (contract bridge ops / engine calls) and how a fixture shows it exercises them. */
export const OPS = [
  ['noteOn / noteOff', (f) => has(f, 'noteOn')],
  ['pedal (sustain)', (f) => has(f, 'pedal') || has(f, 'cc', (e) => e.cc === 64)],
  ['cc 1 / 7 / 11', (f) => has(f, 'cc', (e) => e.cc !== 64)],
  ['wheel mod / expr (setWheel)', (f) => has(f, 'wheel') || has(f, 'cc') || !!f.setup?.wheel],
  ['pitchBend, mode pitch', (f) => bendModes(f).has('pitch')],
  ['pitchBend, mode tape', (f) => bendModes(f).has('tape')],
  ['pitchBend, mode morph', (f) => bendModes(f).has('morph')],
  ['pitchBend, mode drone-swell', (f) => bendModes(f).has('drone-swell')],
  ['pitchBend, mode none', (f) => bendModes(f).has('none')],
  ['swell (button and swell.pedal)', (f) => has(f, 'swell') || f.setup?.patch?.swell?.pedal === true],
  ['panic (allNotesOff)', (f) => has(f, 'panic')],
  ['fadeOutAll', (f) => has(f, 'fadeOut')],
  ['setParam (automation)', (f) => has(f, 'param')],
  ['setParam glide', (f) => has(f, 'param', (e) => e.glide > 0)],
  ['setTranspose', (f) => !!f.setup?.transpose || has(f, 'transpose')],
  ['setKeyContext', (f) => !!f.setup?.keyContext || has(f, 'keyContext')],
  ['setRouting (mid-render)', (f) => has(f, 'routing')],
  ['patch routing: modWheel / expression / volume targets', (f) => !!(f.setup?.patch?.modWheel
    || f.setup?.patch?.expression)],
  ['setMono (mono output)', (f) => has(f, 'monoOut')],
  ['eqAudition', (f) => has(f, 'eqAudition')],
  ['prepare + commit at t 0', (f) => f.kind !== 'drone-freeze'],
  ['commit mid-render (song switch, retire)', (f) => has(f, 'commit')],
  ['retainReverb', (f) => has(f, 'retainReverb') || has(f, 'commit', (e) => e.retain)],
  ['drone synth: setKey / configure', (f) => !!f.setup?.drone],
  ['drone key change mid-render', (f) => has(f, 'droneKey')],
  ['drone frozen loop (renderDroneLoop)', (f) => f.kind === 'drone-freeze'],
  ['click start / stop / count-in', (f) => has(f, 'clickStart')],
  ['setTempo / sync delay', (f) => !!f.setup?.tempo],
  ['setTimeSig', (f) => !!f.setup?.timeSig],
  ['slot mono lowest / highest', (f) => anySlot(f, (s) => s.mono && s.mono !== 'off') || has(f, 'param',
    (e) => /\.mono$/.test(e.path))],
  ['slot octave / transpose', (f) => anySlot(f, (s) => s.octave || s.transpose)],
  ['slot lowNote / highNote range', (f) => anySlot(f, (s) => s.lowNote > 0 || s.highNote < 127)],
  ['slot sustain off', (f) => anySlot(f, (s) => s.sustain === false) || has(f, 'param',
    (e) => /\.sustain$/.test(e.path))],
  ['slot release / pedalHold', (f) => anySlot(f, (s) => s.release != null || s.pedalHold != null)],
  ['slot pan', (f) => anySlot(f, (s) => s.pan) || has(f, 'param', (e) => /\.pan$/.test(e.path))],
  ['slot width', (f) => anySlot(f, (s) => s.width != null) || has(f, 'param', (e) => /\.width$/.test(e.path))],
  ['slot EQ b-rows', (f) => anySlot(f, (s) => s.eq && Object.keys(s.eq).some((k) => /^b\d$/.test(k)))],
  ['slot EQ type change / band toggle mid-render', (f) => has(f, 'param', (e) => /eq\.b\d\.(type|on)$/.test(e.path))],
  ['slot EQ legacy rows (low/high/lowHz/mid*/highHz/cutHz/hiCutHz)', (f) => anySlot(f, (s) => s.eq &&
    Object.keys(s.eq).some((k) => !/^b\d$/.test(k)))],
  ['velocityCurve soft / hard / fixed / custom', (f) => anySlot(f,
    (s) => s.velocityCurve && s.velocityCurve !== 'normal')],
  ['per-note touch override', (f) => has(f, 'noteOn', (e) => e.touch)],
  ['instrument: synth', (f) => anySlot(f, (s) => s.instrument.type === 'synth')],
  ['instrument: organ', (f) => anySlot(f, (s) => s.instrument.type === 'organ')],
  ['instrument: sampler', (f) => anySlot(f, (s) => s.instrument.type === 'sampler')],
  ['sampler velocity layers (3-layer sets)', (f) => anySlot(f, (s) => ['salamander-piano',
    'upright-piano'].includes(s.instrument.id))
    && has(f, 'noteOn')],
  ['multi-slot patch (2+ slots)', (f) => slotsOf(f).length > 1],
  ['inject test point', (f) => !!f.setup?.inject],
  ['tap other than out', (f) => (f.setup?.tap || 'out') !== 'out'],
];

/** What no offline fixture can reach, and where it is covered instead. */
export const UNCOVERED = [
  ['audio sleep / wake (sleep(), wake(), queued notes during sleep)',
    'AudioEngine.sleep() returns false for an OfflineAudioContext ' +
    '(audio.js:1510): there is nothing to render. Behaviour is specified by contract quirks; test in T08 conformance ' +
    '(core state machine, silence while asleep, queued calls replayed on wake, ramp lengths 0.15 / 0.06 / 0.005 s).'],
  ['setLowResource, drone freeze / thaw swap',
    'the frozen loop is realtime only (drone.js:646 `!this.offline`): an offline ' +
    'engine plays the live drone, so a fixture could not show the swap. The loop itself (renderDroneLoop) is ' +
      'rendered by ' +
    'drone-freeze-*; the swap crossfade, cache trim and pin changes belong to T16 / T08 tests.'],
  ['drone files mode, chordFollow',
    'HTMLMediaElement playback is unavailable offline (drone.js:978); chordFollow needs the files mode.'],
  ['click aux outputs 3-4, click record, MIDI clock out, MIDI direct route, recorder tap', 'not on the main output; ' +
    'conformance tests from engine-api.json (T07 / T08 / T13).'],
  ['meters, RTA, slotLevel, analysers', 'not audio: tick payloads, tested against the contract schema.'],
  ['cache / preload / estimate / pins / eviction', 'memory behaviour, not audio.'],
  ['audio restart, sink change, device rate change (48 kHz)',
    'the oracle renders 44.1 kHz offline only; T08 rate-change test (finding 16).'],
  ['reverb build deferral (reverb.stage defer while playing), idle slot polling',
    'realtime scheduling (audio.js:605, 790).'],
  ['instrument params (`slots.<i>.params.*`, dynamic rows)',
    'only cutoff / resonance (auto-filter-cutoff) are driven; the per-instrument ' +
    'param tables belong to the instrument tasks (T11, T12) with fixtures of their own.'],
];

export function analyse(manifest, contract) {
  const rows = contract.params.find ? contract.params.find(([k]) => k === 'rows')[1] : contract.params.rows;
  const fx = manifest.fixtures.map((e) => e.fixture);
  const byRow = new Map(rows.map((r) => [r.path, { before: [], after: [] }]));
  for (const f of fx) {
    for (const k of rowsTouched(f, rows)) {
      const r = byRow.get(k);
      r.after.push(f.id);
      if (!f.addedBy) r.before.push(f.id);
    }
  }
  const ops = OPS.map(([name, pred]) => {
    const ids = fx.filter((f) => pred(f)).map((f) => f.id);
    return { name, ids, before: ids.filter((id) => !fx.find((f) => f.id === id).addedBy) };
  });
  return { rows, byRow, ops, fx };
}

const short = (ids, n = 4) => (ids.length <= n ? ids.join(', ') : `${ids.slice(0, n).join(', ')}, +${ids.length - n}`);

function sampleSets(manifest) {
  const sets = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/samples/manifest.json'),
    'utf8')).instruments.map((i) => i.id);
  const used = new Map(sets.map((s) => [s, { before: [], after: [] }]));
  for (const f of manifest.fixtures.map((e) => e.fixture)) {
    if (!has(f, 'noteOn')) continue;
    for (const s of slotsOf(f)) {
      if (s.instrument.type !== 'sampler') continue;
      const u = used.get(s.instrument.id);
      if (u && !u.after.includes(f.id)) {
        u.after.push(f.id);
        if (!f.addedBy) u.before.push(f.id);
      }
    }
  }
  return used;
}

export function render(manifest, contract) {
  const { rows, byRow, ops } = analyse(manifest, contract);
  const nb = rows.filter((r) => byRow.get(r.path).before.length).length;
  const na = rows.filter((r) => byRow.get(r.path).after.length).length;
  const sets = sampleSets(manifest);
  const sb = [...sets.values()].filter((u) => u.before.length).length;
  const sa = [...sets.values()].filter((u) => u.after.length).length;
  const ob = ops.filter((o) => o.before.length).length;
  const oa = ops.filter((o) => o.ids.length).length;
  const L = [];
  L.push('# Golden coverage matrix', '',
    '<!-- generated by `node tools/golden/coverage.mjs`; do not edit by hand -->', '',
    `${manifest.fixtures.length} fixtures (${manifest.fixtures.filter((e) => e.addedBy).length} added by the T17 ` +
      `wave). ` +
    '"Before" = the fixtures that existed before T17.', '',
    '| measure | before | after |', '|---|---|---|',
    `| contract PARAMS rows set to a non-default value or automated | ${nb} / ${rows.length} | **${na} / ` +
      `${rows.length}** |`,
    `| rows never touched | ${rows.length - nb} | ${rows.length - na} |`,
    `| bundled sample sets rendered | ${sb} / ${sets.size} | **${sa} / ${sets.size}** |`,
    `| operations / behaviours exercised (of ${ops.length} listed below) | ${ob} | ${oa} |`,
    `| fixtures | ${manifest.fixtures.filter((e) => !e.addedBy).length} | ${manifest.fixtures.length} |`, '');
  L.push('## Operations and behaviours', '', '| operation | fixtures | count (before) | ids |', '|---|---|---|---|');
  for (const o of ops) L.push(`| ${o.name} | ${o.ids.length} | ${o.before.length} | ` +
    `${o.ids.length ? short(o.ids) : '**none**'} |`);
  L.push('', '## Sample sets', '', '| set | before | ids |', '|---|---|---|');
  for (const [s, u] of sets) L.push(`| ${s} | ${u.before.length} | ${u.after.length ? short(u.after) : '**none**'} |`);
  L.push('', '## PARAMS rows (contract `params.rows`)', '',
    'Count = fixtures that set the row away from its default or automate it; "new" = how many of them are T17 ' +
      'fixtures.', '',
    '| row | count | new | fixtures |', '|---|---|---|---|');
  for (const r of rows) {
    const b = byRow.get(r.path);
    L.push(`| \`${r.path}\` | ${b.after.length} | ${b.after.length - b.before.length} | ` +
      `${b.after.length ? short(b.after, 5) : '**none**'} |`);
  }
  const never = rows.filter((r) => !byRow.get(r.path).after.length);
  L.push('', '## What remains uncovered, and why', '');
  L.push(`**${never.length} PARAMS rows** are never moved by any fixture${never.length ? ':' : '.'}`, '');
  if (never.length) {
    const groups = {};
    for (const r of never) (groups[r.path.replace(/\.(b\d)\..*/, '.$1.*')] ||= []).push(r.path);
    for (const [g,
      ps] of Object.entries(groups)) L.push(`- ` +
        `\`${g}\`${ps.length > 1 && g === ps[0] ? '' : ps.length > 1 ? ` (${ps.length})` : ''}`);
    L.push('',
      'Rows listed here share their code path with a covered sibling (another band index, same type / Hz / dB / Q ' +
      'handling) or belong to an instrument; they are candidates for unit tests generated from `engine-api.json` ' +
        '(T13).', '');
  }
  L.push('### Not renderable offline / not audio', '', '| area | reason and where it is tested instead |', '|---|---|');
  for (const [a, why] of UNCOVERED) L.push(`| ${a} | ${why} |`);
  L.push('', '### Open points in the oracle itself', '',
    '- Fixtures with `setup.live` call those event types at their time through the engine timer (first 128-frame ' +
    'boundary >= t); everything else is issued up front. See README, "Order of operations".',
    '- Chromium sums node inputs in hash-set order; fixtures that run audio-rate FM are statistical for that reason ' +
      'alone.', '');
  return { text: `${L.join('\n')}\n`, nb, na, sb, sa, ob, oa, total: rows.length, ops: ops.length,
    never: never.length, sets: sets.size };
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(GOLD, 'manifest.json'), 'utf8'));
  const contract = JSON.parse(fs.readFileSync(path.join(ROOT, 'native/contract/engine-api.json'), 'utf8'));
  const r = render(manifest, contract);
  console.log(`PARAMS rows touched: ${r.nb}/${r.total} -> ${r.na}/${r.total}; sample sets ${r.sb}/${r.sets} -> ` +
    `${r.sa}/${r.sets}; ` +
    `ops ${r.ob}/${r.ops} -> ${r.oa}/${r.ops}; never-touched rows ${r.never}`);
  if (!process.argv.includes('--print')) {
    fs.writeFileSync(path.join(GOLD, 'COVERAGE.md'), r.text);
    console.log('wrote native/golden/COVERAGE.md');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
