// Worship Rig specifics shared by calibrate.mjs and audition.mjs: trim files, patch builders, chord plans.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './server.mjs';
import { defaultSlot } from '../../app/js/shared/params.js';
import { defaultFx, defaultRouting } from '../../app/js/presets.js';
import { transposeSemis, mod12, keyName } from '../../app/js/shared/music.js';

export { ROOT };
export const MANIFEST_PATH = path.join(ROOT, 'app/samples/manifest.json');
export const TRIMS_PATH = path.join(ROOT, 'app/js/engine/gain-trims.json');

// ---- trims --------------------------------------------------------------------------------------------------------
export function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

/** Rewrite ONLY `gainTrim` (dB) of the given sampler ids; everything else in the manifest is preserved byte-for-byte. */
export function writeManifestTrims(trimsById) {
  const text = fs.readFileSync(MANIFEST_PATH, 'utf8');
  const m = JSON.parse(text);
  if (JSON.stringify(m, null, 2) + '\n' !== text) throw new Error('manifest.json is not in JSON.stringify(…, null, 2) form; refusing to rewrite it');
  for (const inst of m.instruments) if (inst.id in trimsById) inst.gainTrim = trimsById[inst.id];
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2) + '\n');
}

export function readGainTrims() {
  try {
    return JSON.parse(fs.readFileSync(TRIMS_PATH, 'utf8'));
  } catch {
    return { synth: {}, organ: {}, droneTrim: 0 };
  }
}

export function writeGainTrims(obj) {
  fs.writeFileSync(TRIMS_PATH, JSON.stringify(obj, null, 2) + '\n');
}

/** The part of gain-trims.json the renderer shim needs. */
export function trimsForJob(t = readGainTrims()) {
  return { synth: { ...(t.synth || {}) }, organ: { ...(t.organ || {}) }, droneTrim: Number(t.droneTrim) || 0 };
}

// ---- patches ------------------------------------------------------------------------------------------------------
/** Patch with one instrument in `role` (0 Keys, 1 Pad, 2 Extra, 3 Bass) and default FX/routing, with overrides. */
export function singlePatch(ref, { role = 0, slot = {}, fx = {} } = {}) {
  const s = defaultSlot(role, ref);
  const { sends, params, ...rest } = slot;
  Object.assign(s, rest);
  if (sends) Object.assign(s.sends, sends);
  if (params) Object.assign(s.params, params);
  const f = defaultFx();
  for (const [unit, vals] of Object.entries(fx)) Object.assign(f[unit], vals);
  const slots = [null, null, null, null];
  slots[role] = s;
  return { slots, fx: f, ...defaultRouting() };
}

// ---- chords -------------------------------------------------------------------------------------------------------
/**
 * I–V–vi–IV voicings (sounding pitches, key of C, before key shift): left-hand root in C3–B3, right-hand close
 * triad in C4–C5 with common-tone voice leading. `bassOct` moves the left-hand root down an octave (C2–B2) for songs
 * with a Bass slot so it sits where a bass player would.
 */
const PROG_C = [
  { roman: 'I', lh: 48, rh: [64, 67, 72] },
  { roman: 'V', lh: 55, rh: [62, 67, 71] },
  { roman: 'vi', lh: 57, rh: [64, 69, 72] },
  { roman: 'IV', lh: 53, rh: [65, 69, 72] },
];

/** Shift for a key so voicings stay inside ≈ C3–C5 (−6..+5 semitones). */
export const keyShift = (pc) => ((mod12(pc) + 6) % 12) - 6;

/**
 * Sounding voicings for I–V–vi–IV in key `hearPc` (major) or its relative-minor reading when `minor`
 * (i–v… is not idiomatic; minor songs play the relative major's I–V–vi–IV, i.e. III–VII–i–VI).
 */
export function progression(hearPc, { minor = false, bassOct = false } = {}) {
  const tonic = minor ? mod12(hearPc + 3) : hearPc;
  const k = keyShift(tonic);
  return PROG_C.map((c) => ({ roman: c.roman, lh: c.lh + k - (bassOct ? 12 : 0), rh: c.rh.map((n) => n + k) }));
}

/**
 * Timed events for the audition progression: chord k at k·dur, pedal lifted at each change and re-pressed 50 ms
 * after the new chord (legato pedalling), keys released at k·dur + dur − 0.1 (the pedal carries them), final pedal
 * up at 4·dur. `play` = semitones from sounding to physical (Easy Transpose inverse).
 * @returns {{events:object[], onsets:number[], chords:object[]}}
 */
export function progressionEvents(chords, { dur = 2, vel = 96, play = 0, rhOnly = false, lhOnly = false } = {}) {
  const ev = [];
  const onsets = [];
  chords.forEach((c, k) => {
    const t = k * dur;
    const notes = [...(rhOnly ? [] : [c.lh]), ...(lhOnly ? [] : c.rh)].map((n) => n - play);
    if (k > 0) ev.push({ t, sustain: false });
    for (const n of notes) ev.push({ t: t + 0.002, on: n, vel });
    ev.push({ t: t + 0.05, sustain: true });
    for (const n of notes) ev.push({ t: t + dur - 0.1, off: n });
    onsets.push(t + 0.002);
  });
  ev.push({ t: chords.length * dur, sustain: false });
  return { events: ev, onsets };
}

export { transposeSemis, mod12, keyName };

// ---- formatting ---------------------------------------------------------------------------------------------------
export function table(rows, cols) {
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (cells) => cells.map((x, i) => String(x ?? '').padEnd(w[i])).join('  ');
  return [line(cols), line(w.map((n) => '-'.repeat(n))), ...rows.map((r) => line(cols.map((c) => r[c])))].join('\n');
}
