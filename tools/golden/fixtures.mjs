// Golden-render fixtures (tools/golden/render.mjs; contract in native/golden/README.md). Pure data, built once at
// import: every fixture is a plain JSON object, written verbatim into native/golden/manifest.json, so the native test
// runner replays it without any JS.
//
// Fixture = {
//   id, kind, seconds, seed, smoke?,
//   setup: {
//     patch      engine patch (SPEC §2; normalized by the engine, the result is stored as resolved.patch)
//     tap        recorded node (default 'out' = the whole master chain): see page.js TAP
//     inject     {stimulus, at, gain?, start?}: a stimuli.mjs buffer started at `start` s into node `at` (page.js INJECT)
//     drone      {mode, gain, brightness, movement, width, fade, key:{pc, minor}}
//     tempo, timeSig, click {level}, transpose, keyContext {pc, minor}, wheel {mod, expr}
//     (drone-freeze only) key, params, loopSec, prerollSec, seamSec, reverb {size, damp, predelay, wet}
//   },
//   events: [{t, type, ...}] in seconds, issued in time order with {when: t}:
//     noteOn {note, vel, touch?} · noteOff {note} · pedal {down} · cc {cc: 1|7|11|64, value 0..127} ·
//     wheel {source: mod|expr, value 0..1, glide?} · bend {value −1..1} · param {path, value, glide?} ·
//     droneKey {pc, minor, fade?} · clickStart {countIn?, quietAfter?} · clickStop · swell {start}
// }
import { SPACE_PRESETS, ECHO_PRESETS } from '../../app/js/shared/fx-presets.js';
import { FACTORY_SONGS } from '../../app/js/presets.js';
import { SCENE_GLIDE_SEC } from '../../app/js/shared/scenes.js';

const SEED = 1;

/** Every synth / organ instrument id (render.mjs checks this list against the live registry). */
export const SYNTH_IDS = [
  'warm-pad', 'glass-pad', 'strings', 'sub-bass', 'soft-keys', 'bell', 'supersaw-pad', 'juno-pad', 'shimmer-pad',
  'dx-epiano', 'pluck', 'poly-stab', 'analog-brass', 'square-lead', '808-sub', 'synth-bass',
];
export const ORGAN_IDS = ['gospel', 'soft-pad', 'full', 'church'];
/** Default `release` (s) per synth / organ, from listInstruments (sets each render's tail). */
const RELEASE = {
  'warm-pad': 3, 'glass-pad': 3.5, strings: 1.8, 'sub-bass': 0.25, 'soft-keys': 0.3, bell: 2.5, 'supersaw-pad': 2.5,
  'juno-pad': 2, 'shimmer-pad': 4, 'dx-epiano': 0.35, pluck: 0.3, 'poly-stab': 0.25, 'analog-brass': 0.35,
  'square-lead': 0.2, '808-sub': 0.25, 'synth-bass': 0.12, gospel: 0.08, 'soft-pad': 0.15, full: 0.08, church: 1.5,
};
const BASS = new Set(['sub-bass', '808-sub', 'synth-bass']);

const r6 = (x) => Math.round(x * 1e6) / 1e6;

/** A patch with one instrument in slot 0 (dry: no sends), gain 1 so the strip is unity. */
function soloPatch(type, id, extra = {}) {
  return { slots: [{ instrument: { type, id }, gain: 1, ...extra }, null, null, null] };
}

/** 3 notes × 2 velocities (0.4 s each, 0.5 s apart), then a 3-note chord held 1 s, then the release tail. */
function notesAndChord(notes, chord, vels = [40, 110]) {
  const ev = [];
  let t = 0.1;
  for (const v of vels) {
    for (const n of notes) {
      ev.push({ t: r6(t), type: 'noteOn', note: n, vel: v }, { t: r6(t + 0.4), type: 'noteOff', note: n });
      t += 0.5;
    }
  }
  for (const n of chord) ev.push({ t: r6(t), type: 'noteOn', note: n, vel: 90 });
  for (const n of chord) ev.push({ t: r6(t + 1), type: 'noteOff', note: n });
  return { events: ev, end: t + 1 };
}

const fixtures = [];
const add = (f) => fixtures.push({ seed: SEED, ...f });

// ---- synths and organs: every patch, dry, tapped after the slot strip ------------------------------------------
for (const [type, ids] of [['synth', SYNTH_IDS], ['organ', ORGAN_IDS]]) {
  for (const id of ids) {
    const bass = BASS.has(id);
    const { events, end } = notesAndChord(bass ? [28, 36, 43] : [48, 60, 79], bass ? [36, 43, 48] : [60, 64, 67]);
    add({
      id: `${type}-${id}`, kind: type, seconds: r6(Math.ceil((end + Math.min(RELEASE[id], 4) + 0.5) * 10) / 10),
      smoke: id === 'gospel',
      setup: { patch: soloPatch(type, id), tap: 'slot0.pan' },
      events,
    });
  }
}

// ---- sampler: 2 bundled sets: soft / loud layers, a pedal-held note, release -------------------------------------
for (const id of ['salamander-piano', 'ep-rhodes']) {
  const ev = [];
  // soft (vel 30 → salamander layer v4) and loud (vel 120 → v14) at C4 and G2
  [[60, 30], [60, 120], [43, 30], [43, 120]].forEach(([n, v], i) => {
    const t = 0.1 + i * 0.8;
    ev.push({ t: r6(t), type: 'noteOn', note: n, vel: v }, { t: r6(t + 0.6), type: 'noteOff', note: n });
  });
  // pedal-held: pedal down, E4 on, key up at +0.3 while the pedal holds it, pedal up at +2.0
  ev.push({ t: 3.4, type: 'pedal', down: true }, { t: 3.5, type: 'noteOn', note: 64, vel: 80 },
    { t: 3.8, type: 'noteOff', note: 64 }, { t: 5.5, type: 'pedal', down: false });
  // mid-velocity chord with a plain release
  for (const n of [55, 59, 62]) ev.push({ t: 6, type: 'noteOn', note: n, vel: 75 }, { t: 7, type: 'noteOff', note: n });
  add({ id: `sampler-${id}`, kind: 'sampler', seconds: 8.5,
    setup: { patch: soloPatch('sampler', id), tap: 'slot0.pan' }, events: ev });
}

// ---- effects in isolation: a dry stimulus into the unit, its output tapped ---------------------------------------
const noSlots = (fx) => ({ slots: [null, null, null, null], fx });
const fxFromPaths = (params) => {
  const fx = {};
  for (const [p, v] of Object.entries(params)) {
    const [, unit, key] = p.split('.');
    (fx[unit] = fx[unit] || {})[key] = v;
  }
  return fx;
};
const START = 0.25; // stimulus start (s); with its own 0.25 s lead the signal begins at 0.5 s

for (const sp of SPACE_PRESETS) {
  const fx = fxFromPaths(sp.params);
  const size = fx.reverb.size ?? 0.5;
  add({
    id: `reverb-${sp.id}`, kind: 'effect', seconds: r6(Math.min(10, Math.ceil((0.6 + size * 9 + 0.3) * 4) / 4)),
    smoke: sp.id === 'room',
    setup: { patch: noSlots(fx), inject: { stimulus: 'impulse', at: 'fx.reverb.input', start: START },
      tap: 'fx.reverb.output' },
    events: [],
  });
}
for (const ep of ECHO_PRESETS) {
  add({
    id: `echo-${ep.id}`, kind: 'effect', seconds: 3, smoke: ep.id === 'slapback',
    setup: { patch: noSlots(fxFromPaths(ep.params)), tempo: 120,
      inject: { stimulus: 'impulse', at: 'fx.delay.input', start: START }, tap: 'fx.delay.output' },
    events: [],
  });
}
add({ id: 'echo-dotted-noise', kind: 'effect', seconds: 3.5,
  setup: { patch: noSlots(fxFromPaths(ECHO_PRESETS.find((p) => p.id === 'dotted').params)), tempo: 120,
    inject: { stimulus: 'noise', at: 'fx.delay.input', start: START }, tap: 'fx.delay.output' }, events: [] });
for (const [name, chorus, stim] of [['default-sine', {}, 'sine'], ['fast-deep-noise', { rate: 2, depth: 1 }, 'noise']]) {
  add({ id: `chorus-${name}`, kind: 'effect', seconds: 2, smoke: name === 'default-sine',
    setup: { patch: noSlots({ chorus }), inject: { stimulus: stim, at: 'fx.chorus.input', start: START },
      tap: 'fx.chorus.output' }, events: [] });
}
const LOFI_TAPE = { amount: 0.55, wow: 0.5, flutter: 0.3, crackle: 0.5, tone: 0.6, saturation: 0.4 };
for (const [name, lofi, stim] of [
  ['tape-sine', LOFI_TAPE, 'sine'],
  ['crush-sweep', { amount: 1, wow: 0, flutter: 0, crackle: 0, bits: 1, tone: 0.3, saturation: 1 }, 'sweep'],
]) {
  add({ id: `lofi-${name}`, kind: 'effect', seconds: stim === 'sweep' ? 3 : 2,
    setup: { patch: noSlots({ lofi }), inject: { stimulus: stim, at: 'fx.sum', start: START }, tap: 'fx.lofi.output' },
    events: [] });
}
// slot EQ: each band type at 3 settings, alone in band b4 (b1 / b8 off), impulse through the slot strip
const EQ_CASES = {
  lowshelf: [[120, 6, 1], [300, -9, 0.7], [80, 12, 2]],
  peak: [[1000, 9, 1], [250, -12, 4], [5000, 4, 0.3]],
  highshelf: [[6000, 6, 1], [3000, -9, 0.7], [10000, 12, 2]],
  notch: [[1000, 0, 4], [60, 0, 10], [8000, 0, 1]],
  lowcut: [[80, 0, 0.707], [250, 0, 1], [30, 0, 2]],
  highcut: [[8000, 0, 0.707], [2000, 0, 1], [15000, 0, 2]],
};
for (const [type, cases] of Object.entries(EQ_CASES)) {
  cases.forEach(([hz, db, q], i) => {
    const eq = { b1: { on: false }, b8: { on: false }, b4: { on: true, type, hz, db, q } };
    add({ id: `eq-${type}-${'abc'[i]}`, kind: 'effect', seconds: 1, smoke: (type === 'peak' || type === 'lowcut') && i === 0,
      setup: { patch: soloPatch('synth', 'warm-pad', { eq }), inject: { stimulus: 'impulse', at: 'slot0.strip', start: START },
        tap: 'slot0.pan' }, events: [] });
  });
}
add({ id: 'master-eq', kind: 'effect', seconds: 1, smoke: true,
  setup: { patch: noSlots({ eq: { low: 6, mid: -4, high: 3 } }),
    inject: { stimulus: 'impulse', at: 'fx.eqIn', start: START }, tap: 'fx.eqOut' }, events: [] });
for (const amount of [0.5, 1]) {
  add({ id: `glue-${amount * 100}`, kind: 'effect', seconds: 2.75, smoke: amount === 1,
    setup: { patch: noSlots({ comp: { amount }, master: { volume: 1 } }),
      inject: { stimulus: 'steps', at: 'fx.eqIn', start: START }, tap: 'fx.master' }, events: [] });
}
add({ id: 'glue-100-bursts', kind: 'effect', seconds: 3,
  setup: { patch: noSlots({ comp: { amount: 1 }, master: { volume: 1 } }),
    inject: { stimulus: 'tone-burst', at: 'fx.eqIn', start: START }, tap: 'fx.master' }, events: [] });
for (const [name, stim, gain] of [['steps', 'steps', 1], ['steps-hot', 'steps', 4], ['bursts-hot', 'tone-burst', 4]]) {
  add({ id: `limiter-${name}`, kind: 'effect', seconds: stim === 'steps' ? 2.75 : 3, smoke: name === 'steps-hot',
    setup: { patch: noSlots({}), inject: { stimulus: stim, at: 'fx.preComp', gain, start: START }, tap: 'out' },
    events: [] });
}
for (const width of [0, 0.5, 1.5]) {
  add({ id: `width-${width * 100}`, kind: 'effect', seconds: 2, smoke: width === 0,
    setup: { patch: soloPatch('synth', 'warm-pad', { width }), inject: { stimulus: 'stereo-noise', at: 'slot0.strip', start: START },
      tap: 'slot0.pan' }, events: [] });
}

// ---- drone: synth mode, 2 keys; and the frozen loop (lowres2) ---------------------------------------------------
const DRONE = { mode: 'synth', gain: 1, brightness: 0.4, movement: 0.3, width: 0.75, fade: 2 };
add({ id: 'drone-synth-2keys', kind: 'drone', seconds: 10,
  setup: { patch: noSlots({ reverb: { returnGain: 0 } }), drone: { ...DRONE, key: { pc: 0, minor: false } }, tap: 'fx.sum' },
  events: [{ t: 5, type: 'droneKey', pc: 9, minor: true }] });
add({ id: 'drone-synth-stage', kind: 'drone', seconds: 8,
  setup: { patch: noSlots(fxFromPaths(SPACE_PRESETS.find((p) => p.id === 'stage').params)),
    drone: { ...DRONE, brightness: 0.8, movement: 0.7, key: { pc: 7, minor: false } }, tap: 'out' },
  events: [{ t: 4, type: 'param', path: 'drone.gain', value: 0.3, glide: 1 }] });
for (const [name, reverb] of [['dry', null], ['wet', { size: 0.42, damp: 0.5, predelay: 0.025, wet: 1 }]]) {
  add({ id: `drone-freeze-${name}`, kind: 'drone-freeze', seconds: 4,
    setup: { key: { pc: 2, minor: false }, params: { brightness: 0.4, movement: 0.3, width: 0.75 }, loopSec: 4,
      prerollSec: 4, seamSec: 1.5, reverb }, events: [] });
}

// ---- automation: rampTo / glideTo through setParam (level, filter, sends, returns, master, wheel) --------------
const held = (note, t0, t1, vel = 90) => [{ t: t0, type: 'noteOn', note, vel }, { t: t1, type: 'noteOff', note }];
add({ id: 'auto-slot-level', kind: 'automation', seconds: 6.5,
  setup: { patch: soloPatch('organ', 'church'), tap: 'slot0.pan' },
  events: [...held(57, 0.1, 5.5), { t: 1.5, type: 'param', path: 'slots.0.gain', value: 0.3 },
    { t: 2.5, type: 'param', path: 'slots.0.gain', value: 1.4, glide: 1.5 },
    { t: 4.5, type: 'param', path: 'slots.0.gain', value: 0.5, glide: SCENE_GLIDE_SEC }] });
add({ id: 'auto-filter-cutoff', kind: 'automation', seconds: 7,
  setup: { patch: soloPatch('synth', 'warm-pad'), tap: 'slot0.pan' },
  events: [...held(48, 0.1, 5), ...held(55, 0.1, 5), { t: 2, type: 'param', path: 'slots.0.params.cutoff', value: 400 },
    { t: 3.5, type: 'param', path: 'slots.0.params.cutoff', value: 8000 },
    { t: 4.2, type: 'param', path: 'slots.0.params.resonance', value: 0.8 }] });
add({ id: 'auto-reverb-send', kind: 'automation', seconds: 6,
  setup: { patch: { slots: [{ instrument: { type: 'organ', id: 'soft-pad' }, gain: 1, sends: { reverb: 0 } }, null, null, null],
    fx: fxFromPaths(SPACE_PRESETS.find((p) => p.id === 'room').params) }, tap: 'out' },
  events: [...held(60, 0.1, 4), { t: 1.5, type: 'param', path: 'slots.0.sends.reverb', value: 0.8 },
    { t: 3, type: 'param', path: 'fx.reverb.returnGain', value: 0.2 }] });
add({ id: 'auto-delay-send', kind: 'automation', seconds: 5,
  setup: { patch: { slots: [{ instrument: { type: 'synth', id: 'pluck' }, gain: 1, sends: { delay: 0 } }, null, null, null],
    fx: fxFromPaths(ECHO_PRESETS.find((p) => p.id === 'slapback').params) }, tap: 'out' },
  events: [...held(64, 0.1, 0.3), { t: 1, type: 'param', path: 'slots.0.sends.delay', value: 1 }, ...held(67, 1.2, 1.4),
    { t: 2.2, type: 'param', path: 'fx.delay.feedback', value: 0.7 }, ...held(71, 2.4, 2.6)] });
add({ id: 'auto-master-volume', kind: 'automation', seconds: 4,
  setup: { patch: soloPatch('organ', 'soft-pad'), tap: 'out' },
  events: [...held(60, 0.1, 3.5), { t: 1.2, type: 'param', path: 'master.volume', value: 0.2 },
    { t: 2.2, type: 'param', path: 'master.volume', value: 1.2 }] });
add({ id: 'auto-modwheel-cc', kind: 'automation', seconds: 5,
  setup: { patch: { slots: [null, { instrument: { type: 'organ', id: 'soft-pad' }, gain: 1 }, null, null] },
    wheel: { mod: 1 }, tap: 'slot1.pan' },
  events: [...held(60, 0.1, 4.5), { t: 1, type: 'cc', cc: 1, value: 20 }, { t: 2, type: 'cc', cc: 1, value: 127 },
    { t: 3, type: 'wheel', source: 'mod', value: 0.1, glide: 0.8 }] });

// ---- 1.1: touch curves, scene glides, metronome click -----------------------------------------------------------
const VELS = [20, 50, 80, 110, 127];
const touchEvents = (touch) => VELS.flatMap((v, i) => [
  { t: r6(0.1 + i * 0.5), type: 'noteOn', note: 60, vel: v, ...(touch ? { touch } : {}) },
  { t: r6(0.5 + i * 0.5), type: 'noteOff', note: 60 },
]);
for (const curve of ['soft', 'hard', 'fixed']) {
  add({ id: `touch-${curve}`, kind: 'touch', seconds: 3.5, setup: { patch: soloPatch('synth', 'soft-keys', { velocityCurve: curve }),
    tap: 'slot0.pan' }, events: touchEvents(null) });
}
add({ id: 'touch-custom', kind: 'touch', seconds: 3.5,
  setup: { patch: soloPatch('synth', 'soft-keys', { velocityCurve: 'custom', touch: { shape: 2, min: 0.2, max: 0.9, top: 100 } }),
    tap: 'slot0.pan' }, events: touchEvents(null) });
add({ id: 'touch-keyboard', kind: 'touch', seconds: 3.5,
  setup: { patch: soloPatch('synth', 'soft-keys'), tap: 'slot0.pan' },
  events: touchEvents({ shape: 0.5, min: 0.1, max: 1, top: 90 }) });
// scene change = what controller.scenes does: every level glides SCENE_GLIDE_SEC from where it is
add({ id: 'scene-glide', kind: 'scene', seconds: 6.5,
  setup: { patch: { slots: [{ instrument: { type: 'organ', id: 'soft-pad' }, gain: 0.8 },
    { instrument: { type: 'synth', id: 'strings' }, gain: 0.2 }, null, null] },
  drone: { ...DRONE, gain: 0.5, key: { pc: 0, minor: false } }, wheel: { mod: 1, expr: 1 }, tap: 'out' },
  events: [...held(60, 0.1, 6), ...held(64, 0.1, 6),
    ...[['slots.0.gain', 0.2], ['slots.1.gain', 1.2], ['drone.gain', 1]].map(([path, value]) =>
      ({ t: 2, type: 'param', path, value, glide: SCENE_GLIDE_SEC })),
    ...[['slots.0.gain', 0.8], ['slots.1.gain', 0.2], ['drone.gain', 0.5]].map(([path, value]) =>
      ({ t: 4, type: 'param', path, value, glide: SCENE_GLIDE_SEC }))] });
add({ id: 'click-120-44', kind: 'click', seconds: 2.5, smoke: true,
  setup: { patch: noSlots({}), tempo: 120, timeSig: '4/4', click: { level: 1 }, tap: 'out' },
  events: [{ t: 0.1, type: 'clickStart' }, { t: 2.1, type: 'clickStop' }] });
add({ id: 'click-90-68-countin', kind: 'click', seconds: 6,
  setup: { patch: noSlots({}), tempo: 90, timeSig: '6/8', click: { level: 0.6 }, tap: 'out' },
  events: [{ t: 0.1, type: 'clickStart', countIn: 1, quietAfter: true }] });

// ---- full songs: 3 factory presets with a scripted I–V–vi–IV progression ----------------------------------------
function progression(pc, { bass = false, pedal = true } = {}) {
  const ev = [];
  const roots = [0, 7, 9, 5];
  const quality = [[0, 4, 7], [0, 4, 7], [0, 3, 7], [0, 4, 7]];
  roots.forEach((r, i) => {
    const t = r6(0.2 + i * 2);
    const root = 48 + ((pc + r) % 12);
    const notes = [root, ...quality[i].map((q) => root + 12 + q)];
    if (pedal) ev.push({ t, type: 'pedal', down: true });
    for (const [j, n] of notes.entries()) ev.push({ t: r6(t + j * 0.01), type: 'noteOn', note: n, vel: 70 + j * 8 });
    for (const n of notes) ev.push({ t: r6(t + 1.6), type: 'noteOff', note: n });
    if (pedal) ev.push({ t: r6(t + 1.95), type: 'pedal', down: false });
    // a melody note on beat 3 of each bar
    ev.push({ t: r6(t + 1), type: 'noteOn', note: root + 24 + quality[i][2], vel: 96 },
      { t: r6(t + 1.5), type: 'noteOff', note: root + 24 + quality[i][2] });
    if (bass) ev.push({ t, type: 'noteOn', note: root - 12, vel: 100 }, { t: r6(t + 1.8), type: 'noteOff', note: root - 12 });
  });
  return ev;
}
for (const slug of ['sunday-pad-piano', 'lofi-rhodes', 'gospel-stab-b3']) {
  const song = FACTORY_SONGS.find((s) => s.id === `factory:${slug}`);
  const key = { pc: song.playIn, minor: !!song.minor };
  add({
    id: `song-${slug}`, kind: 'song', seconds: 11,
    setup: {
      patch: JSON.parse(JSON.stringify(song.patch)),
      tempo: song.tempo ?? undefined,
      keyContext: key,
      drone: song.drone.mode === 'synth' ? { ...song.drone, key } : undefined,
      wheel: { mod: 0.7, expr: 1 },
      tap: 'out',
    },
    events: progression(key.pc, { bass: false, pedal: slug !== 'gospel-stab-b3' }),
  });
}

/** All fixtures, in render order. */
export const FIXTURES = Object.freeze(JSON.parse(JSON.stringify(fixtures)));
