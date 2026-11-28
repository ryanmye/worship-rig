// Golden-render fixtures (tools/golden/render.mjs; contract in native/golden/README.md). Pure data, built once at
// import: every fixture is a plain JSON object, written verbatim into native/golden/manifest.json, so the native test
// runner replays it without any JS.
//
// Fixture = {
//   id, kind, seconds, seed, smoke?,
//   setup: {
//     patch      engine patch (SPEC §2; normalized by the engine, the result is stored as resolved.patch)
//     tap        recorded node (default 'out' = the whole master chain): see page.js TAP
//     inject     {stimulus, at, gain?, start?}: a stimuli.mjs buffer started at `start` s into node `at`
//                (page.js INJECT)
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
const CHORUS_CASES = [['default-sine', {}, 'sine'], ['fast-deep-noise', { rate: 2, depth: 1 }, 'noise']];
for (const [name, chorus, stim] of CHORUS_CASES) {
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
    add({ id: `eq-${type}-${'abc'[i]}`, kind: 'effect', seconds: 1,
      smoke: (type === 'peak' || type === 'lowcut') && i === 0,
      setup: { patch: soloPatch('synth', 'warm-pad', { eq }),
        inject: { stimulus: 'impulse', at: 'slot0.strip', start: START },
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
    setup: { patch: soloPatch('synth', 'warm-pad', { width }),
      inject: { stimulus: 'stereo-noise', at: 'slot0.strip', start: START },
      tap: 'slot0.pan' }, events: [] });
}

// ---- drone: synth mode, 2 keys; and the frozen loop (lowres2) ---------------------------------------------------
const DRONE = { mode: 'synth', gain: 1, brightness: 0.4, movement: 0.3, width: 0.75, fade: 2 };
add({ id: 'drone-synth-2keys', kind: 'drone', seconds: 10,
  setup: { patch: noSlots({ reverb: { returnGain: 0 } }), drone: { ...DRONE, key: { pc: 0, minor: false } },
    tap: 'fx.sum' },
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
  setup: { patch: { slots: [{ instrument: { type: 'organ', id: 'soft-pad' }, gain: 1, sends: { reverb: 0 } },
    null, null, null],
    fx: fxFromPaths(SPACE_PRESETS.find((p) => p.id === 'room').params) }, tap: 'out' },
  events: [...held(60, 0.1, 4), { t: 1.5, type: 'param', path: 'slots.0.sends.reverb', value: 0.8 },
    { t: 3, type: 'param', path: 'fx.reverb.returnGain', value: 0.2 }] });
add({ id: 'auto-delay-send', kind: 'automation', seconds: 5,
  setup: { patch: { slots: [{ instrument: { type: 'synth', id: 'pluck' }, gain: 1, sends: { delay: 0 } },
    null, null, null],
    fx: fxFromPaths(ECHO_PRESETS.find((p) => p.id === 'slapback').params) }, tap: 'out' },
  events: [...held(64, 0.1, 0.3), { t: 1, type: 'param', path: 'slots.0.sends.delay', value: 1 }, ...held(67, 1.2, 1.4),
    { t: 2.2, type: 'param', path: 'fx.delay.feedback', value: 0.7 }, ...held(71, 2.4, 2.6)] });
add({ id: 'auto-master-volume', kind: 'automation', seconds: 4,
  setup: { patch: soloPatch('organ', 'soft-pad'), tap: 'out' },
  events: [...held(60, 0.1, 3.5), { t: 1.2, type: 'param', path: 'master.volume', value: 0.2 },
    { t: 2.2, type: 'param', path: 'master.volume', value: 1.2 }] });
// T13: synth.js twins of the four automation fixtures above (organ / synth:pluck are T15's), so the Model's slot,
// send and master rows are tested in wave 2: identical setups and events, instrument synth:warm-pad (T11, exact).
add({ id: 'auto-slot-level-synth', kind: 'automation', addedBy: 'T13', seconds: 6.5,
  setup: { patch: soloPatch('synth', 'warm-pad'), tap: 'slot0.pan' },
  events: [...held(57, 0.1, 5.5), { t: 1.5, type: 'param', path: 'slots.0.gain', value: 0.3 },
    { t: 2.5, type: 'param', path: 'slots.0.gain', value: 1.4, glide: 1.5 },
    { t: 4.5, type: 'param', path: 'slots.0.gain', value: 0.5, glide: SCENE_GLIDE_SEC }] });
add({ id: 'auto-reverb-send-synth', kind: 'automation', addedBy: 'T13', seconds: 6,
  setup: { patch: { slots: [{ instrument: { type: 'synth', id: 'warm-pad' }, gain: 1, sends: { reverb: 0 } },
    null, null, null],
    fx: fxFromPaths(SPACE_PRESETS.find((p) => p.id === 'room').params) }, tap: 'out' },
  events: [...held(60, 0.1, 4), { t: 1.5, type: 'param', path: 'slots.0.sends.reverb', value: 0.8 },
    { t: 3, type: 'param', path: 'fx.reverb.returnGain', value: 0.2 }] });
add({ id: 'auto-delay-send-synth', kind: 'automation', addedBy: 'T13', seconds: 5,
  setup: { patch: { slots: [{ instrument: { type: 'synth', id: 'warm-pad' }, gain: 1, sends: { delay: 0 } },
    null, null, null],
    fx: fxFromPaths(ECHO_PRESETS.find((p) => p.id === 'slapback').params) }, tap: 'out' },
  events: [...held(64, 0.1, 0.3), { t: 1, type: 'param', path: 'slots.0.sends.delay', value: 1 }, ...held(67, 1.2, 1.4),
    { t: 2.2, type: 'param', path: 'fx.delay.feedback', value: 0.7 }, ...held(71, 2.4, 2.6)] });
add({ id: 'auto-master-volume-synth', kind: 'automation', addedBy: 'T13', seconds: 4,
  setup: { patch: soloPatch('synth', 'warm-pad'), tap: 'out' },
  events: [...held(60, 0.1, 3.5), { t: 1.2, type: 'param', path: 'master.volume', value: 0.2 },
    { t: 2.2, type: 'param', path: 'master.volume', value: 1.2 }] });
add({ id: 'auto-modwheel-cc', kind: 'automation', seconds: 5,
  setup: { patch: { slots: [null, { instrument: { type: 'organ', id: 'soft-pad' }, gain: 1 }, null, null] },
    wheel: { mod: 1 }, tap: 'slot1.pan' },
  events: [...held(60, 0.1, 4.5), { t: 1, type: 'cc', cc: 1, value: 20 }, { t: 2, type: 'cc', cc: 1, value: 127 },
    { t: 3, type: 'wheel', source: 'mod', value: 0.1, glide: 0.8 }] });

// ---- 1.1: touch curves (808 Sub: no PRNG, no audio-rate FM, so exact), scene glides, metronome click ---------
const VELS = [20, 50, 80, 110, 127];
const touchEvents = (touch) => VELS.flatMap((v, i) => [
  { t: r6(0.1 + i * 0.5), type: 'noteOn', note: 60, vel: v, ...(touch ? { touch } : {}) },
  { t: r6(0.5 + i * 0.5), type: 'noteOff', note: 60 },
]);
for (const curve of ['soft', 'hard', 'fixed']) {
  add({ id: `touch-${curve}`, kind: 'touch', seconds: 3.5,
    setup: { patch: soloPatch('synth', '808-sub', { velocityCurve: curve }),
    tap: 'slot0.pan' }, events: touchEvents(null) });
}
add({ id: 'touch-custom', kind: 'touch', seconds: 3.5,
  setup: { patch: soloPatch('synth', '808-sub',
    { velocityCurve: 'custom', touch: { shape: 2, min: 0.2, max: 0.9, top: 100 } }),
    tap: 'slot0.pan' }, events: touchEvents(null) });
add({ id: 'touch-keyboard', kind: 'touch', seconds: 3.5,
  setup: { patch: soloPatch('synth', '808-sub'), tap: 'slot0.pan' },
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

// ---- full songs: 3 factory presets with a scripted I–V–vi–IV progression -------------------------------------
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
    if (bass) {
      ev.push({ t, type: 'noteOn', note: root - 12, vel: 100 }, { t: r6(t + 1.8), type: 'noteOff', note: root - 12 });
    }
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

//
// ===================================================================================================================
// T17 coverage fixtures (SETUP_REVIEW HIGH 7). Samplers (no PRNG, exact tier once the native side loads the same
// PCM) carry the structural behaviour (pan, bend, mono, transpose, release, panic, switch); synths only where the
// instrument path itself is the point. Every id below is listed in native/golden/COVERAGE.md with the contract rows
// it touches. `needsPcm` = the fixture plays sampler sets, so the native run needs the Chromium-decoded PCM
// (native/golden/pcm, tools/golden/pcm.mjs).
//
// ===================================================================================================================
/** Fixtures added by the T17 coverage wave (render.mjs / coverage.mjs report before / after). */
const addT = (f) => add({ addedBy: 'T17', ...f });
const DRY = { reverb: 0, delay: 0, chorus: 0 };
/** A sampler slot with no sends (taps after the strip, or `out` with no reverb IR in the path). */
const sampSlot = (id, extra = {}) => ({ instrument: { type: 'sampler', id }, gain: 1, sends: { ...DRY }, ...extra });
/** Everything after the slots silenced: the summed dry signal (no IR / echo / chorus return in `fx.sum`). */
const NO_RETURNS = { reverb: { returnGain: 0 }, delay: { returnGain: 0 }, chorus: { returnGain: 0 } };
const chordOn = (t, notes, vel = 80, dt = 0.01) => notes.map((n, j) => ({ t: r6(t + j * dt), type: 'noteOn', note: n,
  vel }));
const chordOff = (t, notes) => notes.map((n) => ({ t, type: 'noteOff', note: n }));

// ---- pan: both StereoPanner laws (mono source keeps the mono law, stereo source the stereo law) ------------------
// stereo: a stereo-noise stimulus injected at the strip input, pan -0.5 from the patch, then -1, +0.5, +1
addT({ id: 'pan-stereo-src', kind: 'pan', seconds: 2,
  setup: { patch: soloPatch('sampler', 'ep-rhodes', { pan: -0.5 }),
    inject: { stimulus: 'stereo-noise', at: 'slot0.strip', start: START }, tap: 'slot0.pan' },
  events: [{ t: 0.7, type: 'param', path: 'slots.0.pan', value: -1 }, { t: 1.0, type: 'param', path: 'slots.0.pan',
    value: 0.5 },
    { t: 1.3, type: 'param', path: 'slots.0.pan', value: 1 }] });
// mono: one sustained synth note (a synth voice is a single channel into the strip), pan swept through 5 positions
addT({ id: 'pan-mono-src', kind: 'pan', seconds: 4.5,
  setup: { patch: soloPatch('organ', 'church'), tap: 'slot0.pan' },
  events: [...held(57, 0.1, 3.6), ...[[0.6, -1], [1.2, -0.5], [1.8, 0.5], [2.4, 1], [3.0, 0]]
    .map(([t, value]) => ({ t, type: 'param', path: 'slots.0.pan', value }))] });

// ---- pitch bend: pitch (sampler: playbackRate; synth/organ: detune), tape, morph, drone-swell, none ----------------
addT({ id: 'bend-pitch-sampler', kind: 'bend', seconds: 5.5, needsPcm: true,
  setup: { patch: { slots: [sampSlot('ep-rhodes', { bendEnabled: true }), null, null, null], bend: { mode: 'pitch',
    range: 4 } },
    tap: 'slot0.pan' },
  events: [...chordOn(0.1, [55, 60, 64]), { t: 0.5, type: 'bend', value: 1 }, { t: 1.0, type: 'bend', value: -0.5 },
    { t: 1.5, type: 'bend', value: 0 },
    // a second chord struck while bent down; bendEnabled off freezes the slot at 0 semitones, back on re-applies the
    // bend
    ...chordOn(2.0, [67, 71, 76]), { t: 2.3, type: 'bend', value: -1 }, { t: 2.9, type: 'param',
      path: 'slots.0.bendEnabled', value: false },
    { t: 3.2, type: 'bend', value: 1 }, { t: 3.6, type: 'param', path: 'slots.0.bendEnabled', value: true },
    { t: 4.1, type: 'bend', value: 0 }, ...chordOff(4.4, [55, 60, 64, 67, 71, 76])] });
addT({ id: 'bend-tape', kind: 'bend', seconds: 6.5, needsPcm: true,
  setup: { patch: { slots: [sampSlot('ep-rhodes'), null, null, null],
    fx: { lofi: { amount: 0.5, wow: 0, flutter: 0, crackle: 0, bits: 0.5, tone: 0.6, saturation: 0.4 } },
    bend: { mode: 'tape', range: 2 } }, tap: 'out' },
  events: [...chordOn(0.1, [52, 59, 64]), { t: 0.8, type: 'bend', value: -1 }, { t: 2.2, type: 'bend', value: -0.4 },
    ...chordOn(3.0, [60, 67, 72]), { t: 3.6, type: 'bend', value: 0.7 }, { t: 4.4, type: 'bend', value: 0 },
    ...chordOff(5.0, [52, 59, 64, 60, 67, 72])] });
addT({ id: 'bend-modes', kind: 'bend', seconds: 8,
  setup: { patch: { slots: [{ instrument: { type: 'synth', id: 'warm-pad' }, gain: 1, sends: { ...DRY } }, null,
    null, null],
    fx: NO_RETURNS, bend: { mode: 'pitch', range: 2 } },
    drone: { ...DRONE, gain: 0.8, key: { pc: 7, minor: false } }, live: ['routing', 'bend'], tap: 'fx.sum' },
  events: [...chordOn(0.2, [55, 62, 67]), { t: 0.6, type: 'bend', value: 1 }, { t: 1.2, type: 'bend', value: 0 },
    { t: 1.6, type: 'routing', routing: { bend: { mode: 'morph', range: 2 } } }, { t: 2.0, type: 'bend', value: 1 },
    { t: 2.8, type: 'bend', value: 0 }, { t: 3.2, type: 'routing', routing: { bend: { mode: 'drone-swell',
      range: 2 } } },
    { t: 3.6, type: 'bend', value: 1 }, { t: 5.0, type: 'bend', value: 0 },
    { t: 5.4, type: 'routing', routing: { bend: { mode: 'none', range: 2 } } }, { t: 5.8, type: 'bend', value: 1 },
    ...chordOff(6.5, [55, 62, 67])] });

// ---- swell: the pedal swells the drone (routing swell.pedal), the swell button, and the way back -----------------
addT({ id: 'swell-pedal-drone', kind: 'swell', seconds: 17,
  setup: { patch: { slots: [{ instrument: { type: 'organ', id: 'soft-pad' }, gain: 0.7, sends: { ...DRY } }, null,
    null, null],
    fx: NO_RETURNS, modWheel: { target: 'drone.gain', min: 0, max: 1 }, swell: { seconds: 3, pedal: true } },
  drone: { ...DRONE, gain: 1, key: { pc: 2, minor: false } }, wheel: { mod: 0 }, live: ['swell'], tap: 'fx.sum' },
  events: [{ t: 0.5, type: 'swell', start: true }, { t: 5.0, type: 'swell', start: false },
    { t: 9.5, type: 'pedal', down: true }, ...chordOn(9.6, [50, 57, 62]), ...chordOff(10.2, [50, 57, 62]),
    { t: 13, type: 'pedal', down: false }] });

// ---- mono / legato lines ------------------------------------------------------------------------------------------
addT({ id: 'mono-legato', kind: 'mono', seconds: 9, needsPcm: true,
  setup: { patch: { slots: [sampSlot('ep-rhodes', { mono: 'lowest' }), null, null, null] }, tap: 'slot0.pan' },
  events: [
    // lowest-note priority: 64 is ignored while 60 sounds; 55 takes over (legato); releasing 55 falls back to 60 then
    // 64
    { t: 0.1, type: 'noteOn', note: 60, vel: 80 }, { t: 0.4, type: 'noteOn', note: 64, vel: 90 },
    { t: 0.8, type: 'noteOn', note: 55, vel: 70 }, { t: 1.2, type: 'noteOff', note: 55 }, { t: 1.6, type: 'noteOff',
      note: 60 },
    { t: 2.2, type: 'noteOff', note: 64 },
    // pedal: the last key-up is held
    { t: 2.6, type: 'pedal', down: true }, ...held(67, 2.8, 3.1), { t: 3.6, type: 'noteOn', note: 71, vel: 80 },
    { t: 3.9, type: 'noteOff', note: 71 }, { t: 4.6, type: 'pedal', down: false },
    // switch to highest-note priority and sustain off (the pedal is ignored by the slot)
    { t: 5.0, type: 'param', path: 'slots.0.mono', value: 'highest' }, { t: 5.0, type: 'param',
      path: 'slots.0.sustain', value: false },
    { t: 5.1, type: 'noteOn', note: 60, vel: 80 }, { t: 5.4, type: 'noteOn', note: 67, vel: 80 },
    { t: 5.8, type: 'noteOn', note: 72, vel: 80 }, { t: 6.2, type: 'noteOff', note: 72 }, { t: 6.6, type: 'noteOff',
      note: 67 },
    { t: 7.0, type: 'pedal', down: true }, { t: 7.1, type: 'noteOff', note: 60 }, { t: 7.8, type: 'pedal',
      down: false }] });

// ---- transpose, octave, per-slot transpose, key change, play range -----------------------------------------------
addT({ id: 'transpose-octave-range', kind: 'transpose', seconds: 9, needsPcm: true,
  setup: { patch: { slots: [sampSlot('ep-rhodes', { octave: 1, transpose: 3, lowNote: 48, highNote: 84 }), null,
    null, null] },
    transpose: -2, keyContext: { pc: 0, minor: false }, tap: 'slot0.pan' },
  events: [
    ...[36, 41, 48, 55, 60, 67, 72, 79].flatMap((n, i) => held(n, r6(0.1 + i * 0.5), r6(0.4 + i * 0.5))),
    { t: 4.2, type: 'transpose', semis: 5 }, { t: 4.2, type: 'keyContext', pc: 7, minor: true },
    ...[36, 41, 48, 55, 60, 67, 72, 79].flatMap((n, i) => held(n, r6(4.3 + i * 0.5), r6(4.6 + i * 0.5)))] });

// ---- slot EQ: 8 bands with every type; a type / band change mid-sweep + audition bypass; the legacy rows --------
addT({ id: 'eq-chain-8band', kind: 'effect', seconds: 3,
  setup: { patch: soloPatch('synth', 'warm-pad', { eq: {
    // lowcut / highcut ignore db (a Web Audio highpass / lowpass has no gain): b1 and b8 carry one to prove it
    b1: { on: true, type: 'lowcut', hz: 60, db: 3, q: 0.707 }, b2: { on: true, type: 'lowshelf', hz: 150, db: 5,
      q: 0.8 },
    b3: { on: true, type: 'peak', hz: 300, db: -6, q: 2 }, b4: { on: true, type: 'peak', hz: 900, db: 3, q: 4 },
    b5: { on: true, type: 'notch', hz: 2000, db: 0, q: 3 }, b6: { on: true, type: 'lowshelf', hz: 4500, db: -5,
      q: 0.9 },
    b7: { on: true, type: 'highshelf', hz: 9000, db: 4, q: 1.5 }, b8: { on: true, type: 'highcut', hz: 14000, db: -4,
      q: 0.9 } } }),
    inject: { stimulus: 'sweep', at: 'slot0.strip', start: START }, tap: 'slot0.pan' }, events: [] });
addT({ id: 'eq-type-change', kind: 'effect', seconds: 3.4,
  setup: { patch: soloPatch('synth', 'warm-pad', { eq: { b1: { on: false }, b8: { on: false },
    b2: { on: true, type: 'lowshelf', hz: 100, db: 6, q: 1 }, b3: { on: true, type: 'peak', hz: 600, db: 9, q: 2 },
    b5: { on: true, type: 'peak', hz: 3000, db: -7, q: 1.5 } } }),
    inject: { stimulus: 'sweep', at: 'slot0.strip', start: START }, tap: 'slot0.pan' },
  events: [{ t: 0.7, type: 'param', path: 'slots.0.eq.b3.type', value: 'notch' },
    { t: 1.0, type: 'param', path: 'slots.0.eq.b3.hz', value: 1500 }, { t: 1.2, type: 'param',
      path: 'slots.0.eq.b3.type', value: 'highshelf' },
    { t: 1.5, type: 'param', path: 'slots.0.eq.b5.on', value: false }, { t: 1.7, type: 'param',
      path: 'slots.0.eq.b4.on', value: true },
    { t: 1.7, type: 'param', path: 'slots.0.eq.b4.type', value: 'highcut' }, { t: 1.7, type: 'param',
      path: 'slots.0.eq.b4.hz', value: 6000 },
    { t: 2.0, type: 'param', path: 'slots.0.eq.b3.type', value: 'off' }, { t: 2.0, type: 'param',
      path: 'slots.0.eq.b2.db', value: -9 },
    { t: 2.4, type: 'eqAudition', slot: 0, mode: 'bypass' }, { t: 2.8, type: 'eqAudition', slot: 0, mode: 'on' }] });
addT({ id: 'eq-legacy-rows', kind: 'effect', seconds: 3,
  setup: { patch: soloPatch('synth', 'warm-pad', { eq: { low: 5, high: -4, lowHz: 200, mid1: 6, mid1Hz: 800, mid1Q: 2,
    mid2: -5, mid2Hz: 3000, mid2Q: 0.7, highHz: 4000, cutHz: 80, hiCutHz: 12000 } }),
    inject: { stimulus: 'sweep', at: 'slot0.strip', start: START }, tap: 'slot0.pan' }, events: [] });

// ---- panic (all notes off) and fadeOutAll mid-chord, then the master comes back on the next note --------------------
addT({ id: 'panic-fadeout', kind: 'panic', seconds: 8, needsPcm: true,
  setup: { patch: { slots: [sampSlot('ep-rhodes'), null, null, null] }, tap: 'out' },
  events: [{ t: 0.2, type: 'pedal', down: true }, ...chordOn(0.3, [60, 64, 67]), { t: 1.5, type: 'panic' },
    ...chordOn(2.0, [62, 65, 69]), { t: 3.0, type: 'fadeOut', seconds: 1.5 },
    // a new note after the fade restores the master instantly
    { t: 5.5, type: 'noteOn', note: 72, vel: 90 }, { t: 6.2, type: 'noteOff', note: 72 }] });

// ---- sustain: release param (every instrument type), pedalHold (numeric: ring, then fade over 25 %) -----------------
addT({ id: 'release-pedalhold', kind: 'sustain', seconds: 11, needsPcm: true,
  setup: { patch: { slots: [sampSlot('ep-rhodes', { release: 1.2, pedalHold: 2.5 }), null, null, null] },
    tap: 'slot0.pan' },
  events: [...held(60, 0.1, 0.6), { t: 2.5, type: 'pedal', down: true }, ...held(64, 2.6, 2.9),
    { t: 7.0, type: 'pedal', down: false }, ...held(67, 7.2, 7.5),
    { t: 8.0, type: 'param', path: 'slots.0.release', value: 0.05 }, ...held(71, 8.1, 8.3)] });

// ---- song switch under held notes + reverb retain + scene jump (glide 0)
// ---------------------------------------------
{
  const A = { slots: [sampSlot('ep-rhodes', { gain: 0.9, sends: { reverb: 0.3, delay: 0, chorus: 0 } }), null, null,
    null],
    fx: { reverb: { size: 0.25, damp: 0.5, predelay: 0.01, returnGain: 1 } } };
  const B = { slots: [sampSlot('ep-wurli', { gain: 0.9, sends: { reverb: 0.4, delay: 0, chorus: 0 } }), null, null,
    null],
    fx: { reverb: { size: 0.8, damp: 0.6, predelay: 0.03, returnGain: 0.9 } } };
  addT({ id: 'switch-retire-retain', kind: 'switch', seconds: 10, needsPcm: true,
    setup: { patch: A, next: [B], tap: 'out' },
    events: [{ t: 0.4, type: 'pedal', down: true }, ...chordOn(0.5, [60, 64, 67]), { t: 1.5, type: 'retainReverb',
      next: 0 },
      // held notes ring on the retiring channel while the new song's strip takes the next notes
      { t: 3.0, type: 'commit', next: 0, retain: true }, ...chordOn(3.6, [72, 76], 85), ...chordOff(4.4, [72, 76]),
      ...chordOff(4.8, [60, 64, 67]), { t: 5.0, type: 'pedal', down: false },
      // scene jump: instant (glide 0) level and send changes
      { t: 6.0, type: 'param', path: 'slots.0.gain', value: 0.3 }, { t: 6.0, type: 'param',
        path: 'slots.0.sends.reverb', value: 1 },
      ...held(65, 6.1, 6.6), { t: 7.2, type: 'param', path: 'slots.0.gain', value: 1.1 }, ...held(69, 7.3, 7.8)] });
}

// ---- one render that touches many FX / master / drone / slot rows (automation, setTarget and debounced IR swaps)
// -----
addT({ id: 'fx-row-sweep', kind: 'automation', seconds: 14, needsPcm: true,
  setup: { patch: { slots: [sampSlot('ep-rhodes', { sends: { reverb: 0.5, delay: 0.5, chorus: 0.5 } }), null, null,
    null],
    fx: { lofi: { amount: 0.3, wow: 0.2, flutter: 0.2, crackle: 0.2, bits: 0.3, tone: 0.5, saturation: 0.3 } } },
  tempo: 100, drone: { ...DRONE, gain: 0.3, key: { pc: 5, minor: false } }, tap: 'out' },
  events: [...held(60, 0.1, 13), ...held(67, 0.1, 13), ...held(76, 0.1, 13),
    ...[
      [1, 'fx.reverb.size', 0.15], [1.5, 'fx.reverb.damp', 0.9], [2, 'fx.reverb.predelay', 0.12], [2.5,
        'fx.reverb.returnGain', 1.4],
      [3, 'fx.delay.time', 0.3], [3.2, 'fx.delay.pingpong', true], [3.4, 'fx.delay.tone', 0.9], [3.6,
        'fx.delay.returnGain', 1.3],
      [4, 'fx.delay.sync', '1/8d'], [4.5, 'fx.delay.feedback', 0.6],
      [5, 'fx.chorus.rate', 1.2], [5.2, 'fx.chorus.depth', 0.9], [5.4, 'fx.chorus.returnGain', 1.5],
      [6, 'fx.lofi.wow', 0.8], [6.2, 'fx.lofi.flutter', 0.7], [6.4, 'fx.lofi.crackle', 0.6], [6.6, 'fx.lofi.bits', 0.8],
      [6.8, 'fx.lofi.tone', 0.2], [7, 'fx.lofi.saturation', 0.9], [7.2, 'fx.lofi.amount', 0.7],
      [8, 'fx.eq.low', 5], [8.1, 'fx.eq.mid', -4], [8.2, 'fx.eq.high', 6], [8.5, 'fx.comp.amount', 0.8], [9,
        'master.volume', 0.9],
      [9.5, 'slots.0.width', 1.5], [9.7, 'slots.0.sends.chorus', 0.1], [9.9, 'slots.0.eq.low', -8], [10.1,
        'slots.0.eq.high', 7],
      [10.5, 'drone.brightness', 0.9], [10.7, 'drone.movement', 0.9], [10.9, 'drone.width', 0.2], [11.1,
        'drone.fade', 8],
      [11.5, 'fx.reverb.size', 0.85],
    ].map(([t, path, value]) => ({ t, type: 'param', path, value })),
    { t: 12, type: 'monoOut', on: true }, { t: 12.8, type: 'monoOut', on: false }] });

// ---- the other 21 sample sets: one note each (played 0, +1 or -1 semitone off a sample, so playbackRate ≠ 1)
// ----------
// [id, sample note (MIDI), vel]: the smallest in-range file of the set (upright-piano: dyn1 C8, 48 kHz, resampled)
const SWEEP_SETS = [
  ['upright-piano', 108, 40], ['bright-piano', 81, 60], ['honky-tonk', 83, 60], ['harpsichord', 63, 60],
  ['ep-wurli', 81, 60], ['electric-grand', 59, 60], ['clavinet', 56, 60], ['vibes', 51, 60],
  ['celesta', 51, 60], ['music-box', 81, 60], ['marimba', 77, 60], ['xylophone', 58, 60],
  ['glockenspiel', 84, 60], ['tubular-bells', 78, 60], ['steel-drums', 49, 60],
  ['nylon-guitar', 54, 60], ['steel-guitar', 82, 60], ['clean-guitar', 81, 60],
  ['harp', 84, 60], ['dulcimer', 54, 60], ['kalimba', 75, 60],
];
[[0, 4], [4, 8], [8, 12], [12, 15], [15, 18], [18, 21]].forEach(([a, b], k) => {
  const sets = SWEEP_SETS.slice(a, b);
  const ev = [];
  const slots = sets.map(([id, midi, vel], i) => {
    const note = Math.min(108, midi + [0, 1, -1][(a + i) % 3]);
    ev.push({ t: r6(0.1 + i * 0.9), type: 'noteOn', note, vel }, { t: r6(0.5 + i * 0.9), type: 'noteOff', note });
    // every slot hears every key: each plays only its own note (slot play range, also a lowNote/highNote exercise)
    return sampSlot(id, { gain: 0.8, lowNote: note, highNote: note });
  });
  addT({ id: `sampler-sweep-${k + 1}`, kind: 'sampler', seconds: r6(0.1 + sets.length * 0.9 + 1.4), needsPcm: true,
    setup: { patch: { slots: slots.concat([null, null, null, null]).slice(0, 4) }, tap: 'out' }, events: ev });
});

// ---- TOUCH (DECISIONS D43): settings.dynamicRange past the old cap of 3 ----------------------------------------
// setup.dynamicRange = engine.setDynamicRange before the song (page.js; native fixture_runner: config {dynamicRange}).
// dyn-range-<set>: the sampler-<set> events at range 6, tapped before the master, so web / native agree on the
// velocityDb law at 6 sample by sample (salamander: 60 dB; ep-rhodes: single layer, capped at range 3 = 72 dB).
// dyn-peak-r<n>: loud dry piano chords through the master chain (tap 'out'): the ceiling at ranges 1, 3 and 6.
const addD = (f) => add({ addedBy: 'TOUCH', ...f });
// Slot gain 0.3 (−10.5 dB) keeps the peaks well under the range-1 fixture's: the salamander set's own web / native
// residue (≈ 7e-5 of the peak, sampler-salamander-piano 1.5e-4 at a 2.1 peak) against the exact tier's absolute 2e-4.
for (const id of ['salamander-piano', 'ep-rhodes']) {
  const base = fixtures.find((f) => f.id === `sampler-${id}`);
  addD({ id: `dyn-range-${id}`, kind: 'dynamics', seconds: base.seconds,
    setup: { ...base.setup, patch: soloPatch('sampler', id, { gain: 0.3 }), dynamicRange: 6 }, events: base.events });
}
for (const range of [1, 3, 6]) {
  const ev = [];
  [[0.1, 127], [1.6, 110], [3.1, 127]].forEach(([t, vel], i) => {
    const notes = i === 1 ? [60] : [36, 48, 55, 60, 64, 67, 72];
    ev.push(...chordOn(t, notes, vel), ...chordOff(r6(t + 1.2), notes));
  });
  addD({ id: `dyn-peak-r${range}`, kind: 'dynamics', seconds: 5, needsPcm: true,
    setup: { patch: { slots: [sampSlot('salamander-piano'), null, null, null] }, dynamicRange: range, tap: 'out' },
    events: ev });
}

/** All fixtures, in render order. */
export const FIXTURES = Object.freeze(JSON.parse(JSON.stringify(fixtures)));
