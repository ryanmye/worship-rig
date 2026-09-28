#!/usr/bin/env node
// Loudness calibration (SPEC §12).
//   node tools/calibrate.mjs [--dry] [--only id,id|type:id] [--drone] [--write-report] [--spec-literal] [options]
//
// For every instrument in engine.listInstruments(): seeded offline render (48 kHz, stereo) of C3-E3-G3 at velocity 96
// held 3 s, slot gain 1.0, all sends 0, lofi 0, master 1.0, drone off, limiter/clip as shipped. Band-limited RMS
// (100 Hz–5 kHz) → gainTrim in dB, written to
//   sampler     → app/samples/manifest.json `gainTrim` (only that field is touched)
//   synth/organ → app/js/engine/gain-trims.json {synth:{id:dB}, organ:{id:dB}}
// Synth drone (drone-osc; key C → C3-G3-C4; default brightness/movement/width; drone.gain 1.0; master 1.0; its reverb
// send as shipped) → band RMS over 4–7.5 s → gain-trims.json `droneTrim` (dB; applied on the drone's synth bus, on
// top of drone-osc's own trim).
//
// Defaults are the values the audition iteration settled on (see CONTRACT_CHANGES.md "## audition"):
//   --window 0,3      measure 0–3 s. The spec's 0.5–3.0 s skips the attack, which trims decaying instruments (piano,
//                     EP, mallets) ~3.5 dB hotter than sustaining pads for the same perceived level; in the audition the
//                     piano then sat 5–6 dB over the pad at equal settings.
//   --target -18      at master 1.0 = −24 dBFS at the default −6 dB master. The spec's −20 @ master 1.0 puts every
//                     single-instrument clip at ≈ −26…−27 dBFS with the default master, i.e. at/below the audition
//                     range floor (−26..−16).
//   --drone-target    target − 6 (spec: drone 6 dB under the instrument reference; −26 vs −20).
//   --drone-clamp 18  the drone at drone.gain 1.0 is a 4-voice layer with its own reverb send, ≈ 12 dB hotter than one
//                     instrument at its trim, and droneTrim sits on top of drone-osc's own (instrument) trim.
//   --clamp 12        synth/organ. --sampler-clamp 30: the MusyngKite sample files peak at −19…−26 dBFS, so
//                     they need +14…+28 dB; with ±12 they stay 10–16 dB too quiet (fix at the source: normalize the
//                     files, then re-run this and the trims fall back inside ±12).
//   Bass-group instruments (sub-bass) are measured on a single C2 in 40 Hz–5 kHz: a bass never plays C-E-G at C3,
//   and the band edge at 100 Hz removes its fundamental.
//   --spec-literal    = --window 0.5,3 --target -20 --drone-target -26 --sampler-clamp 12 --drone-clamp 12 --bass-chord
// Trims are relative: new = current + (target − measured); passes repeat until every unclamped instrument is within
// ±0.25 dB, then a verification pass measures the written trims.
//
// engine-3 changes:
//   * pre-roll: the notes start PRE_ROLL (0.5 s) after commit() and the window moves with them. Notes played at the
//     commit instant read decaying instruments 0.5–2 dB low (synth-extra measured 808 −19.2 vs −18.2), which trimmed
//     every piano/EP/mallet hot.
//   * a patch's `calibWindow` [a, b] (listInstruments passes it through; synth-extra `pluck` = [0, 1]) replaces the
//     window for that instrument.
//   * synth-extra.js patches carry their calibration inside the instrument: they are measured (reported) but never
//     trimmed, and any gain-trims.json entry for them is reset to 0.
//   * droneTrim is measured and rewritten only with --drone.
//   * audition/calibration.json is written only with --write-report.
import fs from 'node:fs';
import { openRenderer } from './lib/offline.mjs';
import { bandRmsDb, peak, round } from './lib/analysis.mjs';
import {
  ROOT, readManifest, writeManifestTrims, readGainTrims, writeGainTrims, trimsForJob, singlePatch, table, TRIMS_PATH, MANIFEST_PATH,
} from './lib/rig.mjs';

const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const LIT = has('--spec-literal');
const opt = (name, def) => (has(name) ? args[args.indexOf(name) + 1] : def);
const DRY = has('--dry');
const MAX_PASSES = Number(opt('--passes', 4));
const ONLY = has('--only') ? new Set(opt('--only').split(',')) : null;
const DRONE = has('--drone');
const WRITE_REPORT = has('--write-report');
const PRE_ROLL = Number(opt('--pre-roll', 0.5));

const SR = 48000;
const TARGET = Number(opt('--target', LIT ? -20 : -18));
const DRONE_TARGET = Number(opt('--drone-target', TARGET - 6));
const CLAMP = Number(opt('--clamp', 12));
const SAMPLER_CLAMP = Number(opt('--sampler-clamp', LIT ? CLAMP : 30));
const DRONE_CLAMP = Number(opt('--drone-clamp', LIT ? CLAMP : 18));
const MASTER = Number(opt('--master', 1));
const WINDOW = opt('--window', LIT ? '0.5,3' : '0,3').split(',').map(Number);
const BASS_CHORD = LIT || has('--bass-chord');
const TOL = 0.25;
const BAND = [100, 5000];
const BASS_BAND = BASS_CHORD ? BAND : [40, 5000];
const CHORD = [48, 52, 55]; // C3 E3 G3
const BASS_NOTE = [36]; // C2
const DRONE_WIN = [4, 7.5];

const isBass = (x) => x.group === 'Bass' && !BASS_CHORD;
const selfTrimmed = (x) => x.module === 'synth-extra.js';
const windowFor = (x) => (Array.isArray(x.calibWindow) && x.calibWindow.length === 2 ? x.calibWindow : WINDOW);
const limitFor = (x) => (x.ref.type === 'sampler' ? SAMPLER_CLAMP : CLAMP);
const clampTo = (v, lim) => Math.max(-lim, Math.min(lim, v));

function instJob(x, trims) {
  const patch = singlePatch(x.ref, {
    role: 0,
    slot: { gain: 1, pan: 0, mono: 'off', lowNote: 0, highNote: 127, sends: { reverb: 0, delay: 0, chorus: 0 } },
    fx: { lofi: { amount: 0 }, master: { volume: MASTER } },
  });
  const notes = isBass(x) ? BASS_NOTE : CHORD;
  const events = [...notes.map((n) => ({ t: PRE_ROLL, on: n, vel: 96 })), ...notes.map((n) => ({ t: PRE_ROLL + 3, off: n }))];
  return { sr: SR, seconds: PRE_ROLL + 3.2, seed: `calibrate|${x.ref.type}|${x.ref.id}`, patch, events, trims };
}

function droneJob(trims) {
  const patch = { slots: [null, null, null, null], fx: { lofi: { amount: 0 }, master: { volume: MASTER } } };
  // brightness/movement/width stay at the drone's defaults; fade shortened so the level is steady by 4 s
  return { sr: SR, seconds: DRONE_WIN[1] + 0.1, seed: 'calibrate|drone', patch, drone: { mode: 'synth', gain: 1, fade: 1, key: { pc: 0, minor: false } }, trims };
}

const r = await openRenderer();
try {
  const { list, nativeTrims } = await r.listInstruments();
  const insts = list.filter((x) => !ONLY || ONLY.has(x.ref.id) || ONLY.has(`${x.ref.type}:${x.ref.id}`));
  console.log(
    `calibrate: ${insts.length} instruments${DRONE ? ' + drone' : ''} @ ${SR} Hz, master ${MASTER}; target ${TARGET} dBFS (drone ${DRONE_TARGET}) band RMS ` +
      `${BAND.join('–')} Hz over ${WINDOW.join('–')} s after a ${PRE_ROLL} s pre-roll; drone ${DRONE ? 'ON' : 'skipped (--drone)'}; clamp ±${CLAMP} dB (sampler ±${SAMPLER_CLAMP}, drone ±${DRONE_CLAMP}); ` +
      `trims via ${nativeTrims ? 'engine registry' : 'render shim'}${DRY ? '; DRY RUN' : ''}`,
  );

  const manifest = readManifest();
  const gt = readGainTrims();
  gt.synth = gt.synth || {};
  gt.organ = gt.organ || {};
  const key = (ref) => `${ref.type}:${ref.id}`;
  const cur = new Map();
  for (const x of insts) {
    const ref = x.ref;
    cur.set(key(ref), ref.type === 'sampler' ? Number(manifest.instruments.find((m) => m.id === ref.id)?.gainTrim) || 0 : Number(gt[ref.type]?.[ref.id]) || 0);
  }
  let droneTrim = Number(gt.droneTrim) || 0;
  const rows = new Map();
  let droneRow = null;

  const measureAll = async (label) => {
    const trims = trimsForJob({ synth: gt.synth, organ: gt.organ, droneTrim });
    const out = [];
    for (const x of insts) {
      const res = await r.render(instJob(x, trims));
      if (res.slots[0]?.fallback) console.warn(`  ! ${key(x.ref)} rendered with the FALLBACK synth`);
      for (const w of new Set([...res.warnings, ...res.console])) console.warn(`  ! ${key(x.ref)}: ${w}`);
      const band = isBass(x) ? BASS_BAND : BAND;
      const [w0, w1] = windowFor(x);
      out.push({ x, band: bandRmsDb(res.chs, SR, band[0], band[1], PRE_ROLL + w0, PRE_ROLL + w1), pk: peak(res.chs, SR).db });
    }
    let drone = null;
    if (DRONE) {
      const dres = await r.render(droneJob(trims));
      for (const w of new Set([...dres.warnings, ...dres.console])) console.warn(`  ! drone: ${w}`);
      drone = { band: bandRmsDb(dres.chs, SR, BAND[0], BAND[1], DRONE_WIN[0], DRONE_WIN[1]), pk: peak(dres.chs, SR).db };
    }
    console.log(`  ${label}: measured ${out.length} instruments${DRONE ? ' + drone' : ''}`);
    return { out, drone };
  };

  const writeAll = () => {
    for (const x of insts) if (x.ref.type !== 'sampler') gt[x.ref.type][x.ref.id] = cur.get(key(x.ref));
    for (const x of list) if (selfTrimmed(x) && gt.synth[x.ref.id]) gt.synth[x.ref.id] = 0; // stays 0 (applied inside)
    if (DRY) return;
    writeManifestTrims(Object.fromEntries(insts.filter((x) => x.ref.type === 'sampler').map((x) => [x.ref.id, cur.get(key(x.ref))])));
    writeGainTrims({
      _doc:
        'Output trims in dB written by tools/calibrate.mjs (SPEC §12; method in CONTRACT_CHANGES.md "## audition"). ' +
        'synth/organ: a GainNode of 10^(dB/20) right after instrument.output. droneTrim: 10^(dB/20) on the drone synth bus ' +
        '(synth drone only, on top of drone-osc\'s own trim). Sampler trims live in app/samples/manifest.json gainTrim.',
      reference: {
        sampleRate: SR, velocity: 96, chord: 'C3-E3-G3 (Bass group: C2)', slotGain: 1, sends: 0, master: MASTER,
        window: WINDOW, preRoll: PRE_ROLL, band: BAND, bassBand: BASS_BAND, target: TARGET, droneTarget: DRONE_TARGET, clampDb: CLAMP, samplerClampDb: SAMPLER_CLAMP, droneClampDb: DRONE_CLAMP,
      },
      synth: gt.synth,
      organ: gt.organ,
      droneTrim,
    });
  };

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    const { out, drone } = await measureAll(`pass ${pass}`);
    let worst = 0;
    for (const { x, band, pk } of out) {
      const k = key(x.ref);
      const trim = cur.get(k);
      const want = trim + (TARGET - band);
      const fixed = selfTrimmed(x);
      const next = fixed ? 0 : round(clampTo(want, limitFor(x)), 1);
      const row = rows.get(k) || { instrument: k, group: x.group, 'before dB': round(band, 1), 'trim before': trim };
      Object.assign(row, {
        'trim after': next,
        clamped: fixed ? 'self-trimmed (synth-extra): not trimmed' : Math.abs(want) > limitFor(x) ? `CLAMPED (wants ${round(want, 1)})` : '',
        window: windowFor(x).join('–'),
      });
      rows.set(k, row);
      if (!row.clamped) worst = Math.max(worst, Math.abs(band - TARGET));
      cur.set(k, next);
    }
    if (drone) {
      const dWant = droneTrim + (DRONE_TARGET - drone.band);
      droneRow = droneRow || { instrument: 'drone (synth, key C)', group: '-', 'before dB': round(drone.band, 1), 'trim before': droneTrim };
      Object.assign(droneRow, { 'trim after': round(clampTo(dWant, DRONE_CLAMP), 1), clamped: Math.abs(dWant) > DRONE_CLAMP ? `CLAMPED (wants ${round(dWant, 1)})` : '' });
      if (!droneRow.clamped) worst = Math.max(worst, Math.abs(drone.band - DRONE_TARGET));
      droneTrim = droneRow['trim after'];
    }
    writeAll();
    if (worst <= TOL || DRY) break;
  }

  if (!DRY) {
    const { out, drone } = await measureAll('verify');
    for (const { x, band, pk } of out) Object.assign(rows.get(key(x.ref)), { 'after dB': round(band, 1), 'peak dBFS': round(pk, 1) });
    if (drone) Object.assign(droneRow, { 'after dB': round(drone.band, 1), 'peak dBFS': round(drone.pk, 1) });
  }

  const cols = ['instrument', 'group', 'window', 'before dB', 'trim before', 'trim after', 'after dB', 'peak dBFS', 'clamped'];
  const all = [...rows.values(), ...(droneRow ? [droneRow] : [])];
  console.log(`\n${table(all, cols)}`);
  console.log(`\nbefore/after = band RMS (dBFS) at the trims found / written. ${DRY ? 'DRY RUN: nothing written.' : `Wrote ${MANIFEST_PATH} (gainTrim only) and ${TRIMS_PATH}.`}`);
  if (!DRY && WRITE_REPORT) {
    fs.mkdirSync(`${ROOT}/audition`, { recursive: true });
    fs.writeFileSync(
      `${ROOT}/audition/calibration.json`,
      JSON.stringify({ generated: new Date().toISOString(), sr: SR, master: MASTER, window: WINDOW, preRoll: PRE_ROLL, band: BAND, bassBand: BASS_BAND, target: TARGET, droneTarget: DRONE_TARGET, clamp: CLAMP, samplerClamp: SAMPLER_CLAMP, droneClamp: DRONE_CLAMP, rows: all }, null, 2) + '\n',
    );
  }
} finally {
  await r.close();
}
