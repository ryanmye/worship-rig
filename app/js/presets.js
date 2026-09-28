// Factory Songs (SPEC §8). 19 complete Song objects with stable ids (`factory:<slug>`): the 11 of SPEC §8 plus 8 that
// use the newer instruments (shell-3; FACTORY_SINCE marks them as factory version 2, so store.seedFactory() adds them
// to libraries seeded before they existed).
// Pure data + helpers: no DOM, no Web Audio. Loudness is normalised by the engine's per-instrument
// `gainTrim` (calibration, SPEC §12), so slot gains here only express the *balance* inside a song.
// Audition fixes (reviews/audition-findings.md P1/P3/P4/P5): Felt Piano uses the 'normal' curve (the 'soft' curve
// pushed velocity 96 into the brightest Salamander layer, −14 dBFS); drone.gain ≈ 1 in the three drone songs so the
// calibrated (droneTrim) drone sits ~8–10 dB under the mix; Organ Swell's pad is +8 dB; Sub + Shimmer's glass pad
// starts at C3 so the left-hand bass note isn't doubled by the pad. Dusty Piano also uses 'normal' (P2).
// Space/echo values of the version-2 songs are the named presets from shared/fx-presets.js, spread in unchanged, so
// the FX panel shows their names ("Stage", "Dotted Eighth", …) instead of "Custom".
import { PARAMS, defaultSlot } from './shared/params.js';
import { SPACE_PRESETS, ECHO_PRESETS, VIBE_PRESETS } from './shared/fx-presets.js';

/** Categories in display order. */
export const CATEGORIES = Object.freeze(['worship', 'keys', 'lofi', 'ambient', 'synth']);
/** Display labels for CATEGORIES (+ 'user' for songs you made). */
export const CATEGORY_LABELS = Object.freeze({ worship: 'Worship', keys: 'Keys', lofi: 'Lofi', ambient: 'Ambient', synth: 'Synth', user: 'My songs' });

/** Valid wheel/expression/volume targets (SPEC §2 WheelTarget). */
export const WHEEL_TARGETS = Object.freeze([
  'slots.0.gain', 'slots.1.gain', 'slots.2.gain', 'slots.3.gain',
  'drone.gain', 'fx.reverb.returnGain', 'master.volume', 'macro.intensity', 'macro.wash', 'none',
]);
export const BEND_MODES = Object.freeze(['pitch', 'morph', 'drone-swell', 'tape', 'none']);
export const DRONE_MODES = Object.freeze(['off', 'synth', 'files']);

const DEF = Object.fromEntries(PARAMS.map((e) => [e.path, e.default]));

/** Default fx block from the PARAMS table. */
export function defaultFx() {
  return {
    reverb: { size: DEF['fx.reverb.size'], damp: DEF['fx.reverb.damp'], predelay: DEF['fx.reverb.predelay'], returnGain: DEF['fx.reverb.returnGain'] },
    delay: {
      time: DEF['fx.delay.time'], feedback: DEF['fx.delay.feedback'], pingpong: DEF['fx.delay.pingpong'],
      tone: DEF['fx.delay.tone'], sync: DEF['fx.delay.sync'], returnGain: DEF['fx.delay.returnGain'],
    },
    chorus: { rate: DEF['fx.chorus.rate'], depth: DEF['fx.chorus.depth'], returnGain: DEF['fx.chorus.returnGain'] },
    lofi: {
      amount: DEF['fx.lofi.amount'], wow: DEF['fx.lofi.wow'], flutter: DEF['fx.lofi.flutter'], crackle: DEF['fx.lofi.crackle'],
      bits: DEF['fx.lofi.bits'], tone: DEF['fx.lofi.tone'], saturation: DEF['fx.lofi.saturation'],
    },
    master: { volume: DEF['master.volume'] },
  };
}

/** Default drone block (SPEC §2). */
export function defaultDrone(mode = 'off') {
  return {
    mode,
    gain: DEF['drone.gain'],
    brightness: DEF['drone.brightness'],
    movement: DEF['drone.movement'],
    width: DEF['drone.width'],
    fade: DEF['drone.fade'],
    chordFollow: false,
    continueAcrossSongs: true,
    minorUsesRelativeMajorFile: true,
  };
}

/** Default patch routing/wheel block. */
export function defaultRouting() {
  return {
    modWheel: { target: 'slots.1.gain', min: 0, max: 1 },
    expression: { target: 'slots.1.gain', min: 0, max: 1 },
    volume: { target: 'master.volume' },
    bend: { mode: 'pitch', range: 2 },
    swell: { seconds: 8 },
  };
}

/** Empty 4-slot patch with default FX and routing. */
export function defaultPatch() {
  return { slots: [null, null, null, null], fx: defaultFx(), ...defaultRouting() };
}

/**
 * A complete blank Song (used by store.addSong() with no source).
 * @param {object} [over]
 */
export function blankSong(over = {}) {
  const patch = defaultPatch();
  patch.slots[0] = slot(0, 'sampler', 'salamander-piano');
  patch.slots[1] = slot(1, 'synth', 'warm-pad', { gain: 0.5 });
  return {
    id: null,
    name: 'New Song',
    notes: '',
    category: 'user',
    playIn: 0,
    hearIn: 0,
    transposeOctave: 0,
    minor: false,
    patch,
    drone: defaultDrone('off'),
    tempo: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------
function slot(role, type, id, over = {}) {
  const s = defaultSlot(role, { type, id });
  const { sends, params, ...rest } = over;
  Object.assign(s, rest);
  if (sends) Object.assign(s.sends, sends);
  if (params) Object.assign(s.params, params);
  return s;
}

function fx(over = {}) {
  const f = defaultFx();
  for (const [unit, vals] of Object.entries(over)) Object.assign(f[unit], vals);
  return f;
}

/** Path-keyed fx-presets params ({'fx.reverb.size': .4, …}) → the patch fx shape ({reverb: {size: .4}}), merged. */
function fxParams(...sets) {
  const out = {};
  for (const set of sets) {
    for (const [p, v] of Object.entries(set)) {
      const [root, unit, key] = p.split('.');
      const u = root === 'master' ? 'master' : unit;
      const k = root === 'master' ? unit : key;
      if (root !== 'fx' && root !== 'master') continue;
      out[u] = { ...(out[u] || {}), [k]: v };
    }
  }
  return out;
}
const space = (id) => SPACE_PRESETS.find((p) => p.id === id).params;
const echo = (id) => ECHO_PRESETS.find((p) => p.id === id).params;
const vibe = (id) => VIBE_PRESETS.find((p) => p.id === id).params;
/** Deep-merge fx blocks ({reverb:{…}} …); later wins. */
function fxMerge(...blocks) {
  const out = {};
  for (const b of blocks) for (const [u, vals] of Object.entries(b)) out[u] = { ...(out[u] || {}), ...vals };
  return out;
}

function song(def) {
  const { slots = [], fx: fxOver, routing = {}, drone } = def;
  const patch = { slots: [0, 1, 2, 3].map((i) => slots[i] || null), fx: fx(fxOver), ...defaultRouting() };
  for (const [k, v] of Object.entries(routing)) patch[k] = { ...patch[k], ...v };
  const id = `factory:${def.slug}`;
  const out = {
    id,
    factoryId: id,
    name: def.name,
    notes: def.notes,
    category: def.category,
    playIn: def.playIn ?? 0,
    hearIn: def.hearIn ?? def.playIn ?? 0,
    transposeOctave: 0,
    minor: def.minor ?? false,
    patch,
    drone: { ...defaultDrone(drone?.mode ?? 'off'), ...(drone || {}) },
    tempo: def.tempo ?? null,
  };
  return out;
}

const PAD = 'slots.1.gain';

const DEFS = [
  // ---------------------------------------------------------------- worship
  {
    slug: 'sunday-pad-piano',
    name: 'Sunday Pad + Piano',
    category: 'worship',
    notes:
      'The everyday worship sound: grand piano on top of a warm pad, with a soft key drone underneath. ' +
      'Mod wheel (and an expression pedal) brings the pad in and out, so you can start with piano alone and swell the pad for the chorus. ' +
      'Push the pitch-bend wheel up to lift the drone; pull it down to tuck it away.',
    slots: [
      slot(0, 'sampler', 'salamander-piano', { gain: 0.8 }),
      slot(1, 'synth', 'warm-pad', { gain: 0.55, sends: { reverb: 0.5, delay: 0.1, chorus: 0.35 } }),
    ],
    fx: { reverb: { size: 0.62, damp: 0.5, predelay: 0.025, returnGain: 1 }, delay: { time: 0.42, feedback: 0.3, tone: 0.4, returnGain: 0.8 } },
    routing: { modWheel: { target: PAD, min: 0, max: 1 }, expression: { target: PAD, min: 0, max: 1 }, bend: { mode: 'drone-swell', range: 2 }, swell: { seconds: 8 } },
    drone: { mode: 'synth', gain: 1.2, brightness: 0.4, movement: 0.3, width: 0.75, fade: 5 }, // ≈ −9 dB under the mix
  },
  {
    slug: 'building-swell',
    name: 'Building Swell',
    category: 'worship',
    notes:
      'Strings with a shimmering glass pad for builds and bridges. ' +
      'Start with the mod wheel low for just strings, then roll it up (or tap Swell) over a few bars to bloom the glass pad in. ' +
      'Pitch bend bends the synths a whole step for tension-and-release moments.',
    slots: [
      slot(0, 'synth', 'strings', { gain: 0.7, sends: { reverb: 0.45, delay: 0.1, chorus: 0 } }),
      slot(1, 'synth', 'glass-pad', { gain: 0.75, sends: { reverb: 0.55, delay: 0.2, chorus: 0.45 } }),
    ],
    fx: { reverb: { size: 0.72, damp: 0.45, predelay: 0.03, returnGain: 1.05 }, delay: { time: 0.5, feedback: 0.35, tone: 0.45, returnGain: 0.8 }, chorus: { rate: 0.3, depth: 0.5 } },
    routing: { modWheel: { target: PAD, min: 0, max: 1 }, expression: { target: PAD, min: 0, max: 1 }, bend: { mode: 'pitch', range: 2 }, swell: { seconds: 12 } },
    drone: { mode: 'off' },
  },
  {
    slug: 'prayer-wash',
    name: 'Prayer Wash',
    category: 'worship',
    notes:
      'A single warm pad in a huge room, with the key drone on: for prayer, ministry time and transitions. ' +
      'The mod wheel is the pad volume (wheel down fades the pad, the drone keeps going), so you can hold one chord for minutes and just ride the wheel. ' +
      'Push pitch bend up to swell the drone; use Fade Out All at the end.',
    slots: [null, slot(1, 'synth', 'warm-pad', { gain: 0.8, sends: { reverb: 0.7, delay: 0.25, chorus: 0.4 } })],
    fx: { reverb: { size: 0.92, damp: 0.55, predelay: 0.04, returnGain: 1.25 }, delay: { time: 0.6, feedback: 0.45, tone: 0.35, returnGain: 0.7 }, chorus: { rate: 0.2, depth: 0.55 } },
    routing: { modWheel: { target: PAD, min: 0, max: 1 }, expression: { target: PAD, min: 0, max: 1 }, bend: { mode: 'drone-swell', range: 2 }, swell: { seconds: 10 } },
    drone: { mode: 'synth', gain: 0.9, brightness: 0.35, movement: 0.45, width: 0.85, fade: 6 }, // ≈ −9 dB under the pad
  },
  {
    slug: 'organ-swell',
    name: 'Organ Swell',
    category: 'worship',
    notes:
      'Gospel drawbar organ with a warm pad behind it. ' +
      'The mod wheel brings the pad in; the pitch-bend wheel switches the rotary speaker between slow and fast (push it for the classic "Leslie ramp"). ' +
      'The sustain pedal holds the pad but not the organ, like a real Hammond.',
    slots: [
      slot(0, 'organ', 'gospel', { gain: 0.75, sustain: false, bendEnabled: false, sends: { reverb: 0.2, delay: 0, chorus: 0 } }),
      slot(1, 'synth', 'warm-pad', { gain: 1.13, sends: { reverb: 0.5, delay: 0.1, chorus: 0.3 } }), // +8 dB (was .45: 10.7 dB under the organ)
    ],
    fx: { reverb: { size: 0.5, damp: 0.55, predelay: 0.02, returnGain: 0.9 }, delay: { returnGain: 0.6 } },
    routing: { modWheel: { target: PAD, min: 0, max: 1 }, expression: { target: PAD, min: 0, max: 1 }, bend: { mode: 'morph', range: 2 }, swell: { seconds: 8 } },
    drone: { mode: 'off' },
  },
  // ---------------------------------------------------------------- keys
  {
    slug: 'grand-piano',
    name: 'Grand Piano',
    category: 'keys',
    notes:
      'A clean concert grand in a medium hall, for piano-led songs and solo playing. ' +
      'The mod wheel sets how much reverb you hear (wheel down = drier, for fast or rhythmic parts); an expression pedal works as a volume pedal. ' +
      'Pitch bend is off.',
    slots: [slot(0, 'sampler', 'salamander-piano', { gain: 0.85, sends: { reverb: 0.3, delay: 0.05, chorus: 0 } })],
    fx: { reverb: { size: 0.5, damp: 0.45, predelay: 0.02, returnGain: 1 } },
    routing: {
      modWheel: { target: 'fx.reverb.returnGain', min: 0.3, max: 1 },
      expression: { target: 'master.volume', min: 0, max: 1 },
      bend: { mode: 'none', range: 2 },
    },
    drone: { mode: 'off' },
  },
  {
    slug: 'rhodes',
    name: 'Rhodes',
    category: 'keys',
    notes:
      'A sampled Rhodes electric piano with a soft chorus: warm and round for ballads, neo-soul and gentle verses. ' +
      'The mod wheel controls the reverb amount; an expression pedal is a volume pedal. ' +
      'Pitch bend is off, as on a real Rhodes.',
    slots: [slot(0, 'sampler', 'ep-rhodes', { gain: 0.85, sends: { reverb: 0.25, delay: 0.1, chorus: 0.4 } })],
    fx: { reverb: { size: 0.4, damp: 0.5, predelay: 0.015, returnGain: 0.9 }, chorus: { rate: 0.5, depth: 0.45, returnGain: 1 }, delay: { time: 0.375, feedback: 0.25, tone: 0.35, returnGain: 0.7 } },
    routing: {
      modWheel: { target: 'fx.reverb.returnGain', min: 0.3, max: 1 },
      expression: { target: 'master.volume', min: 0, max: 1 },
      bend: { mode: 'none', range: 2 },
    },
    drone: { mode: 'off' },
  },
  {
    slug: 'felt-piano',
    name: 'Felt Piano',
    category: 'keys',
    notes:
      'A dark, soft "felt" piano (the tone is rolled off and the touch is gentle) in a big room: intimate intros, reflective moments, film-style ambience. ' +
      'The mod wheel controls the reverb amount; an expression pedal is a volume pedal. ' +
      'Play softly and let the room carry it.',
    slots: [slot(0, 'sampler', 'salamander-piano', { gain: 0.9, velocityCurve: 'normal', params: { tone: 0.25 }, sends: { reverb: 0.5, delay: 0.1, chorus: 0 } })],
    fx: { reverb: { size: 0.68, damp: 0.7, predelay: 0.03, returnGain: 1.1 }, delay: { time: 0.5, feedback: 0.3, tone: 0.25, returnGain: 0.6 } },
    routing: {
      modWheel: { target: 'fx.reverb.returnGain', min: 0.3, max: 1 },
      expression: { target: 'master.volume', min: 0, max: 1 },
      bend: { mode: 'none', range: 2 },
    },
    drone: { mode: 'off' },
  },
  // ---------------------------------------------------------------- lofi
  {
    slug: 'lofi-rhodes',
    name: 'Lofi Rhodes',
    category: 'lofi',
    notes:
      'Soft electric piano through a worn tape machine: wobble, crackle and a dusty top end for lofi beats and chill sets. ' +
      'The mod wheel controls the reverb amount. ' +
      'Pull the pitch-bend wheel down for a tape-stop slowdown; push it up for a filter sweep.',
    tempo: 80,
    slots: [slot(0, 'synth', 'soft-keys', { gain: 0.85, bendEnabled: false, sends: { reverb: 0.3, delay: 0.15, chorus: 0.25 } })],
    fx: {
      reverb: { size: 0.45, damp: 0.65, predelay: 0.02, returnGain: 0.9 },
      delay: { time: 0.5625, feedback: 0.3, tone: 0.3, sync: '1/8d', returnGain: 0.6 },
      chorus: { rate: 0.4, depth: 0.4 },
      lofi: { amount: 0.6, wow: 0.55, flutter: 0.4, crackle: 0.35, bits: 0.45, tone: 0.55, saturation: 0.5 },
    },
    routing: {
      modWheel: { target: 'fx.reverb.returnGain', min: 0.3, max: 1 },
      expression: { target: 'master.volume', min: 0, max: 1 },
      bend: { mode: 'tape', range: 2 },
    },
    drone: { mode: 'off' },
  },
  {
    slug: 'dusty-piano',
    name: 'Dusty Piano',
    category: 'lofi',
    notes:
      'Grand piano as if sampled from an old record: vinyl crackle, a little tape wobble and a warm, narrow tone. ' +
      'The mod wheel controls the reverb amount. ' +
      'Pull the pitch-bend wheel down for a tape-stop; push it up for a filter sweep.',
    tempo: 75,
    slots: [slot(0, 'sampler', 'salamander-piano', { gain: 0.85, velocityCurve: 'normal', sends: { reverb: 0.3, delay: 0.1, chorus: 0 } })], // P2: 'soft' hit the brightest layer
    fx: {
      reverb: { size: 0.4, damp: 0.7, predelay: 0.015, returnGain: 0.85 },
      delay: { time: 0.4, feedback: 0.25, tone: 0.3, sync: '1/4', returnGain: 0.5 },
      lofi: { amount: 0.5, wow: 0.45, flutter: 0.35, crackle: 0.6, bits: 0.4, tone: 0.6, saturation: 0.45 },
    },
    routing: {
      modWheel: { target: 'fx.reverb.returnGain', min: 0.3, max: 1 },
      expression: { target: 'master.volume', min: 0, max: 1 },
      bend: { mode: 'tape', range: 2 },
    },
    drone: { mode: 'off' },
  },
  // ---------------------------------------------------------------- ambient
  {
    slug: 'glass-ocean',
    name: 'Glass Ocean',
    category: 'ambient',
    notes:
      'A glassy pad with soft FM bells echoing in a dotted-eighth delay: ambient intros and spacious instrumental sections. ' +
      'Set the song tempo so the echoes lock to the band. ' +
      'The mod wheel is the pad level; pitch bend morphs the sounds (octave bloom on the pad, brighter bells).',
    tempo: 72,
    slots: [
      null,
      slot(1, 'synth', 'glass-pad', { gain: 0.7, sends: { reverb: 0.6, delay: 0.25, chorus: 0.45 } }),
      slot(2, 'synth', 'bell', { gain: 0.5, bendEnabled: false, sends: { reverb: 0.5, delay: 0.55, chorus: 0.1 } }),
    ],
    fx: {
      reverb: { size: 0.82, damp: 0.4, predelay: 0.035, returnGain: 1.1 },
      delay: { time: 0.625, feedback: 0.5, pingpong: true, tone: 0.45, sync: '1/8d', returnGain: 0.9 },
      chorus: { rate: 0.25, depth: 0.55 },
    },
    routing: { modWheel: { target: PAD, min: 0, max: 1 }, expression: { target: PAD, min: 0, max: 1 }, bend: { mode: 'morph', range: 2 }, swell: { seconds: 10 } },
    drone: { mode: 'off' },
  },
  {
    slug: 'sub-shimmer',
    name: 'Sub + Shimmer',
    category: 'ambient',
    notes:
      'A split: deep mono sub-bass on the left hand (below middle C), glass pad from C3 up, and a key drone underneath. ' +
      'Great for big, spacious moments when there is no bass player. ' +
      'The mod wheel is the pad level; push pitch bend up to swell the drone.',
    slots: [
      null,
      slot(1, 'synth', 'glass-pad', { gain: 0.65, lowNote: 48, sends: { reverb: 0.6, delay: 0.2, chorus: 0.45 } }),
      null,
      slot(3, 'synth', 'sub-bass', { gain: 0.75, bendEnabled: false, highNote: 59, mono: 'lowest', sends: { reverb: 0, delay: 0, chorus: 0 } }),
    ],
    fx: { reverb: { size: 0.78, damp: 0.45, predelay: 0.03, returnGain: 1.05 }, delay: { time: 0.5, feedback: 0.4, tone: 0.4, returnGain: 0.7 }, chorus: { rate: 0.25, depth: 0.5 } },
    routing: { modWheel: { target: PAD, min: 0, max: 1 }, expression: { target: PAD, min: 0, max: 1 }, bend: { mode: 'drone-swell', range: 2 }, swell: { seconds: 10 } },
    drone: { mode: 'synth', gain: 0.9, brightness: 0.55, movement: 0.35, width: 0.8, fade: 5 }, // ≈ −9 dB under the mix
  },
  // ================================================================ factory version 2 (shell-3): newer instruments
  // ---------------------------------------------------------------- worship
  {
    slug: 'anthem',
    name: 'Anthem',
    category: 'worship',
    since: 2,
    notes:
      'The big modern-worship chorus: grand piano over a wide supersaw pad, with dotted-eighth echoes. ' +
      'The mod wheel is an intensity macro: roll it down for a verse (piano with a soft, dark pad) and up for the chorus (the pad gets louder and brighter). ' +
      'Set the song tempo so the echoes lock to the band.',
    tempo: 72,
    slots: [
      slot(0, 'sampler', 'salamander-piano', { gain: 0.8, sends: { reverb: 0.3, delay: 0.15, chorus: 0 } }),
      slot(1, 'synth', 'supersaw-pad', { gain: 0.6, bendEnabled: false, sends: { reverb: 0.5, delay: 0.3, chorus: 0.15 } }),
    ],
    fx: fxParams(space('stage'), echo('dotted')),
    routing: { modWheel: { target: 'macro.intensity', min: 0, max: 1 }, expression: { target: PAD, min: 0, max: 1 }, bend: { mode: 'none', range: 2 }, swell: { seconds: 12 } },
    drone: { mode: 'off' },
  },
  {
    slug: 'gospel-stab-b3',
    name: 'Gospel Stab + B3',
    category: 'worship',
    since: 2,
    notes:
      'Drawbar organ with a punchy synth stab layered on the right hand and a mono synth bass on the left (below middle C, lowest note only). ' +
      'The mod wheel is the stab level, so you can play pure organ and bring the stabs in for hits. ' +
      'Push the pitch-bend wheel to switch the rotary speaker between slow and fast (it also opens up the stab and bass).',
    tempo: 96,
    slots: [
      slot(0, 'organ', 'gospel', { gain: 0.75, sustain: false, bendEnabled: false, sends: { reverb: 0.2, delay: 0.1, chorus: 0 } }),
      // morning-prep (round2-shell #8): 0.5 → 0.85; the stab solo sat 10.1 dB under the organ (audition, wheel 0.7)
      slot(1, 'synth', 'poly-stab', { gain: 0.85, lowNote: 60, sustain: false, bendEnabled: false, sends: { reverb: 0.25, delay: 0.25, chorus: 0 } }),
      null,
      slot(3, 'synth', 'synth-bass', { gain: 0.7, bendEnabled: false, highNote: 59, mono: 'lowest', sends: { reverb: 0, delay: 0, chorus: 0 } }),
    ],
    fx: fxParams(space('room'), echo('slapback')),
    routing: { modWheel: { target: PAD, min: 0, max: 1 }, expression: { target: 'master.volume', min: 0, max: 1 }, bend: { mode: 'morph', range: 2 }, swell: { seconds: 8 } },
    drone: { mode: 'off' },
  },
  {
    slug: 'upright-pad',
    name: 'Upright + Pad',
    category: 'worship',
    since: 2,
    notes:
      'A warm, close upright piano with a soft pad and the key drone underneath: acoustic sets, communion and quiet songs. ' +
      'The mod wheel (and an expression pedal) brings the pad in and out. ' +
      'Push the pitch-bend wheel up to lift the drone.',
    slots: [
      slot(0, 'sampler', 'upright-piano', { gain: 0.85, sends: { reverb: 0.3, delay: 0.05, chorus: 0 } }),
      slot(1, 'synth', 'warm-pad', { gain: 0.5, sends: { reverb: 0.5, delay: 0.1, chorus: 0.35 } }),
    ],
    fx: fxParams(space('stage'), echo('none')),
    routing: { modWheel: { target: PAD, min: 0, max: 1 }, expression: { target: PAD, min: 0, max: 1 }, bend: { mode: 'drone-swell', range: 2 }, swell: { seconds: 8 } },
    drone: { mode: 'synth', gain: 1.0, brightness: 0.4, movement: 0.3, width: 0.75, fade: 5 },
  },
  // ---------------------------------------------------------------- keys
  {
    slug: 'clav-funk',
    name: 'Clav Funk',
    category: 'keys',
    since: 2,
    notes:
      'Clavinet with a Wurlitzer layered underneath, a quick slapback and very little room: funk, gospel grooves and tight band playing. ' +
      'The mod wheel is the Wurlitzer level (wheel down = clav alone); an expression pedal is a volume pedal. ' +
      'Pitch bend is off.',
    tempo: 96,
    slots: [
      slot(0, 'sampler', 'clavinet', { gain: 0.8, sustain: false, sends: { reverb: 0.12, delay: 0.2, chorus: 0 } }),
      slot(1, 'sampler', 'ep-wurli', { gain: 0.5, sends: { reverb: 0.15, delay: 0.1, chorus: 0.25 } }),
    ],
    fx: fxMerge(fxParams(space('room'), echo('slapback')), { reverb: { returnGain: 0.5 } }),
    routing: { modWheel: { target: PAD, min: 0, max: 1 }, expression: { target: 'master.volume', min: 0, max: 1 }, bend: { mode: 'none', range: 2 } },
    drone: { mode: 'off' },
  },
  // ---------------------------------------------------------------- ambient
  {
    slug: 'music-box-lullaby',
    name: 'Music Box Lullaby',
    category: 'ambient',
    since: 2,
    notes:
      'Music box over a glassy pad in a cathedral, with celesta taking over from C5 up: lullabies, Christmas and gentle intros. ' +
      'The mod wheel is the pad level. ' +
      'Push the pitch-bend wheel to bloom the pad an octave up.',
    slots: [
      slot(0, 'sampler', 'music-box', { gain: 0.7, highNote: 71, sends: { reverb: 0.45, delay: 0.15, chorus: 0 } }),
      slot(1, 'synth', 'glass-pad', { gain: 0.5, bendEnabled: false, sends: { reverb: 0.55, delay: 0.15, chorus: 0.4 } }),
      slot(2, 'sampler', 'celesta', { gain: 0.65, lowNote: 72, sends: { reverb: 0.45, delay: 0.2, chorus: 0 } }),
    ],
    fx: fxParams(space('cathedral'), echo('none')),
    routing: { modWheel: { target: PAD, min: 0, max: 1 }, expression: { target: PAD, min: 0, max: 1 }, bend: { mode: 'morph', range: 2 }, swell: { seconds: 10 } },
    drone: { mode: 'off' },
  },
  {
    slug: 'dream-juno',
    name: 'Dream Juno',
    category: 'ambient',
    since: 2,
    notes:
      'A chorused Juno-style pad with a shimmer pad an octave-bloom above it, in a huge wash with long echo trails: ambient sets and prayer. ' +
      'The mod wheel is an intensity macro: rolling it up brings the Juno pad up and opens both pads. ' +
      'Set the song tempo so the echo trails follow the band.',
    tempo: 70,
    slots: [
      null,
      slot(1, 'synth', 'juno-pad', { gain: 0.7, bendEnabled: false, sends: { reverb: 0.6, delay: 0.25, chorus: 0.3 } }),
      slot(2, 'synth', 'shimmer-pad', { gain: 0.55, bendEnabled: false, sends: { reverb: 0.65, delay: 0.3, chorus: 0.2 } }),
    ],
    fx: fxParams(vibe('ambient')),
    routing: { modWheel: { target: 'macro.intensity', min: 0, max: 1 }, expression: { target: PAD, min: 0, max: 1 }, bend: { mode: 'none', range: 2 }, swell: { seconds: 12 } },
    drone: { mode: 'off' },
  },
  // ---------------------------------------------------------------- synth
  {
    slug: '80s-ballad',
    name: '80s Ballad',
    category: 'synth',
    since: 2,
    notes:
      'The classic FM electric piano over a Juno-style pad in a big hall, with the chorus turned up. ' +
      'The mod wheel is the pad level (wheel down = electric piano alone); an expression pedal also rides the pad. ' +
      'Pitch bend bends the pad only.',
    slots: [
      slot(0, 'synth', 'dx-epiano', { gain: 0.8, bendEnabled: false, sends: { reverb: 0.35, delay: 0.1, chorus: 0.45 } }),
      slot(1, 'synth', 'juno-pad', { gain: 0.5, sends: { reverb: 0.5, delay: 0.1, chorus: 0.5 } }),
    ],
    fx: fxMerge(fxParams(space('hall'), echo('none')), { chorus: { rate: 0.6, depth: 0.65, returnGain: 1.25 } }),
    routing: { modWheel: { target: PAD, min: 0, max: 1 }, expression: { target: PAD, min: 0, max: 1 }, bend: { mode: 'pitch', range: 2 }, swell: { seconds: 8 } },
    drone: { mode: 'off' },
  },
  {
    slug: 'synthwave',
    name: 'Synthwave',
    category: 'synth',
    since: 2,
    notes:
      'A three-way split: 808 sub on the lowest left-hand note (below middle C), analog brass in the middle and a square lead from C5 up, with quarter-note echoes. ' +
      'The mod wheel is a wash macro (more reverb and echo); the pitch-bend wheel bends the lead. ' +
      'Set the song tempo so the echoes lock to the track.',
    tempo: 100,
    slots: [
      slot(0, 'synth', 'analog-brass', { gain: 0.7, lowNote: 48, highNote: 71, bendEnabled: false, sends: { reverb: 0.3, delay: 0.2, chorus: 0.2 } }),
      null,
      // morning-prep (round2-shell #8): 0.6 → 1.2; the lead solo sat 11.2 dB under the 808 (audition)
      slot(2, 'synth', 'square-lead', { gain: 1.2, lowNote: 72, mono: 'highest', sends: { reverb: 0.3, delay: 0.35, chorus: 0 } }),
      slot(3, 'synth', '808-sub', { gain: 0.75, bendEnabled: false, highNote: 59, mono: 'lowest', sends: { reverb: 0, delay: 0, chorus: 0 } }),
    ],
    fx: fxParams(space('stage'), echo('quarter')),
    routing: { modWheel: { target: 'macro.wash', min: 0, max: 1 }, expression: { target: 'master.volume', min: 0, max: 1 }, bend: { mode: 'pitch', range: 2 }, swell: { seconds: 8 } },
    drone: { mode: 'off' },
  },
];

const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
};

/** Factory library version: 1 = the 11 SPEC §8 songs, 2 = + 8 songs using the newer instruments (shell-3). */
export const FACTORY_VERSION = 2;

/** The 19 factory Songs (frozen; copy before editing — store.seedFactory does). */
export const FACTORY_SONGS = deepFreeze(DEFS.map(song));

/** factory id → the factory version that introduced it (store.seedFactory tops up older libraries). */
export const FACTORY_SINCE = Object.freeze(Object.fromEntries(DEFS.map((d) => [`factory:${d.slug}`, d.since ?? 1])));

const BY_ID = new Map(FACTORY_SONGS.map((s) => [s.id, s]));

/**
 * @param {string} id e.g. 'factory:grand-piano'
 * @returns {object|null} frozen factory Song
 */
export function factoryById(id) {
  return BY_ID.get(id) || null;
}

/** @returns {Record<string, object[]>} factory songs grouped by category (display order). */
export function factoryByCategory() {
  const out = {};
  for (const c of CATEGORIES) out[c] = FACTORY_SONGS.filter((s) => s.category === c);
  return out;
}
