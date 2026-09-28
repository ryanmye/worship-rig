import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  FACTORY_SONGS, FACTORY_VERSION, FACTORY_SINCE, factoryById, factoryByCategory, WHEEL_TARGETS, BEND_MODES, CATEGORIES, CATEGORY_LABELS,
} from '../../../app/js/presets.js';
import { isValidPath, clamp, ROLE_DEFAULTS, PARAMS } from '../../../app/js/shared/params.js';
import { SPACE_PRESETS, ECHO_PRESETS, VIBE_PRESETS, matchPreset } from '../../../app/js/shared/fx-presets.js';
import { normalizeSong } from '../../../app/js/store.js';
import { PATCHES as SYNTH } from '../../../app/js/engine/synth.js';
import { PATCHES as SYNTH_EXTRA } from '../../../app/js/engine/synth-extra.js';
import { PRESETS as ORGAN } from '../../../app/js/engine/organ.js';

const ids = (P) => (Array.isArray(P) ? P : Object.values(P)).filter((p) => !p.hidden).map((p) => p.id);
const manifest = JSON.parse(fs.readFileSync(new URL('../../../app/samples/manifest.json', import.meta.url), 'utf8'));
/** Every instrument the engine can build (manifest samplers, synth.js + synth-extra.js patches, organ presets). */
const INSTRUMENTS = {
  sampler: manifest.instruments.map((i) => i.id),
  synth: [...ids(SYNTH), ...ids(SYNTH_EXTRA)],
  organ: ids(ORGAN),
};
const V1 = [
  'factory:sunday-pad-piano', 'factory:building-swell', 'factory:prayer-wash', 'factory:organ-swell',
  'factory:grand-piano', 'factory:rhodes', 'factory:felt-piano', 'factory:lofi-rhodes', 'factory:dusty-piano',
  'factory:glass-ocean', 'factory:sub-shimmer',
];
const V2 = [
  'factory:anthem', 'factory:gospel-stab-b3', 'factory:upright-pad', 'factory:clav-funk', 'factory:music-box-lullaby',
  'factory:dream-juno', 'factory:80s-ballad', 'factory:synthwave',
];
const getIn = (o, segs) => segs.reduce((v, k) => (v === null || v === undefined ? undefined : v[k]), o);
const SLOT_RELS = PARAMS.filter((e) => e.path.startsWith('slots.<i>.') && !e.dynamic).map((e) => e.path.slice(10));

/** Every concrete param path of a song with its value (slot paths from the PARAMS table; absent optional ones skipped). */
function paramPaths(song) {
  const out = [];
  song.patch.slots.forEach((s, i) => {
    if (!s) return;
    for (const rel of SLOT_RELS) {
      const v = getIn(s, rel.split('.'));
      if (v !== undefined) out.push([`slots.${i}.${rel}`, v]);
    }
    for (const [k, v] of Object.entries(s.sends)) out.push([`slots.${i}.sends.${k}`, v]);
    for (const [k, v] of Object.entries(s.params)) out.push([`slots.${i}.params.${k}`, v]);
  });
  for (const [unit, vals] of Object.entries(song.patch.fx)) for (const [k, v] of Object.entries(vals)) out.push([unit === 'master' ? `master.${k}` : `fx.${unit}.${k}`, v]);
  for (const k of ['gain', 'brightness', 'movement', 'width', 'fade']) out.push([`drone.${k}`, song.drone[k]]);
  return out;
}

test('19 factory songs with stable unique ids, names, categories and notes', () => {
  assert.equal(FACTORY_SONGS.length, 19);
  const all = FACTORY_SONGS.map((s) => s.id);
  assert.equal(new Set(all).size, 19);
  assert.deepEqual(all, [...V1, ...V2], 'v1 ids unchanged and first; v2 appended');
  for (const s of FACTORY_SONGS) {
    assert.equal(s.factoryId, s.id);
    assert.ok(CATEGORIES.includes(s.category), s.id);
    assert.ok(CATEGORY_LABELS[s.category], s.category);
    const sentences = s.notes.split(/(?<=[.!?])\s+/).filter(Boolean);
    assert.ok(sentences.length >= 2 && sentences.length <= 3, `${s.id} notes: ${sentences.length} sentences`);
    assert.ok(Object.isFrozen(s) && Object.isFrozen(s.patch.slots));
    assert.equal(factoryById(s.id), s);
    assert.equal('since' in s, false, 'no helper fields leak into the Song');
  }
  const byCat = factoryByCategory();
  assert.deepEqual(Object.fromEntries(Object.entries(byCat).map(([k, v]) => [k, v.length])), { worship: 7, keys: 4, lofi: 2, ambient: 4, synth: 2 });
  assert.equal(factoryById('nope'), null);
  assert.equal(FACTORY_VERSION, 2);
  for (const id of V1) assert.equal(FACTORY_SINCE[id], 1, id);
  for (const id of V2) assert.equal(FACTORY_SINCE[id], 2, id);
});

test('every param path is valid and already clamped; instruments use the exact ids', () => {
  for (const s of FACTORY_SONGS) {
    assert.equal(s.patch.slots.length, 4);
    assert.ok(s.patch.slots.some(Boolean), `${s.id} has at least one slot`);
    s.patch.slots.forEach((slot, i) => {
      if (!slot) return;
      assert.ok(INSTRUMENTS[slot.instrument.type]?.includes(slot.instrument.id), `${s.id} slot ${i}: ${slot.instrument.type}/${slot.instrument.id}`);
    });
    for (const [p, v] of paramPaths(s)) {
      assert.ok(isValidPath(p), `${s.id}: invalid path ${p}`);
      assert.deepEqual(clamp(p, v), v, `${s.id}: ${p}=${v} not in range`);
    }
    for (const k of ['modWheel', 'expression', 'volume']) assert.ok(WHEEL_TARGETS.includes(s.patch[k].target), `${s.id} ${k}`);
    assert.ok(BEND_MODES.includes(s.patch.bend.mode));
    assert.ok(s.patch.swell.seconds >= 1);
    const wheelSlot = /^slots\.(\d)\.gain$/.exec(s.patch.modWheel.target);
    if (wheelSlot) assert.ok(s.patch.slots[Number(wheelSlot[1])], `${s.id}: mod wheel targets an existing slot`);
    // modWheel must not start silent/extreme: wheel is 1.0 until the first CC, so max should be the neutral 1
    assert.equal(s.patch.modWheel.max, 1, `${s.id}: wheel top is neutral`);
    assert.deepEqual(normalizeSong(JSON.parse(JSON.stringify(s)), s.id), JSON.parse(JSON.stringify(s)), `${s.id} is already normalised`);
  }
});

test('spec details: drone on where required, lofi amounts, delay sync, splits, bend modes', () => {
  const f = (id) => factoryById(`factory:${id}`);
  for (const id of ['sunday-pad-piano', 'prayer-wash', 'sub-shimmer']) assert.equal(f(id).drone.mode, 'synth', id);
  assert.equal(f('lofi-rhodes').patch.fx.lofi.amount, 0.6);
  assert.equal(f('dusty-piano').patch.fx.lofi.amount, 0.5);
  assert.equal(f('dusty-piano').patch.fx.lofi.crackle, 0.6);
  assert.equal(f('glass-ocean').patch.fx.delay.sync, '1/8d');
  // audition P1: 'soft' pushed v96 into the brightest layer (−14 dBFS) → 'normal' + a darker tone (SPEC §8 deviation)
  assert.ok(f('felt-piano').patch.slots[0].params.tone < 0.3);
  assert.equal(f('felt-piano').patch.slots[0].velocityCurve, 'normal');
  assert.equal(f('organ-swell').patch.bend.mode, 'morph');
  assert.equal(f('organ-swell').patch.slots[0].instrument.id, 'gospel');
  const sub = f('sub-shimmer').patch.slots[3];
  assert.equal(sub.mono, 'lowest');
  assert.equal(sub.highNote, 59);
  assert.deepEqual(sub.sends, { reverb: 0, delay: 0, chorus: 0 });
  assert.equal(f('prayer-wash').patch.slots.filter(Boolean).length, 1);
  assert.deepEqual(ROLE_DEFAULTS[3].sends, { reverb: 0, delay: 0, chorus: 0 });
  // audition P2: Dusty Piano's 'soft' curve hit the brightest layer too
  assert.equal(f('dusty-piano').patch.slots[0].velocityCurve, 'normal');
});

test('v2 songs: new instruments, fx-presets spaces/echoes by name, wheel/bend routing, tempo for synced echoes', () => {
  const f = (id) => factoryById(`factory:${id}`);
  const inst = (id) => f(id).patch.slots.map((x) => (x ? `${x.instrument.type}:${x.instrument.id}` : null));
  const named = (id) => {
    const song = f(id);
    const get = (p) => { const [r, u, k] = p.split('.'); return r === 'master' ? song.patch.fx.master[u] : song.patch.fx[u]?.[k]; };
    return { space: matchPreset(SPACE_PRESETS, get)?.id ?? null, echo: matchPreset(ECHO_PRESETS, get)?.id ?? null, vibe: matchPreset(VIBE_PRESETS, get)?.id ?? null };
  };
  assert.deepEqual(inst('anthem'), ['sampler:salamander-piano', 'synth:supersaw-pad', null, null]);
  assert.deepEqual(named('anthem'), { space: 'stage', echo: 'dotted', vibe: 'set' });
  assert.equal(f('anthem').patch.modWheel.target, 'macro.intensity');
  assert.deepEqual(inst('80s-ballad'), ['synth:dx-epiano', 'synth:juno-pad', null, null]);
  assert.equal(named('80s-ballad').space, 'hall');
  assert.ok(f('80s-ballad').patch.fx.chorus.returnGain > 1 && f('80s-ballad').patch.fx.chorus.depth > 0.5, 'chorus up');
  assert.deepEqual(inst('gospel-stab-b3'), ['organ:gospel', 'synth:poly-stab', null, 'synth:synth-bass']);
  assert.deepEqual([named('gospel-stab-b3').space, named('gospel-stab-b3').echo], ['room', 'slapback']);
  assert.equal(f('gospel-stab-b3').patch.slots[3].mono, 'lowest');
  assert.equal(f('gospel-stab-b3').patch.bend.mode, 'morph');
  assert.deepEqual(inst('synthwave'), ['synth:analog-brass', null, 'synth:square-lead', 'synth:808-sub']);
  assert.equal(named('synthwave').echo, 'quarter');
  assert.equal(f('synthwave').patch.slots[2].lowNote, 72, 'lead from C5 up');
  assert.equal(f('synthwave').patch.slots[0].highNote, 71, 'brass below C5');
  assert.deepEqual(inst('dream-juno'), [null, 'synth:juno-pad', 'synth:shimmer-pad', null]);
  assert.equal(named('dream-juno').vibe, 'ambient');
  assert.deepEqual(inst('upright-pad'), ['sampler:upright-piano', 'synth:warm-pad', null, null]);
  assert.equal(named('upright-pad').space, 'stage');
  assert.equal(f('upright-pad').drone.mode, 'synth');
  assert.ok(f('upright-pad').drone.gain >= 0.85 && f('upright-pad').drone.gain <= 1.25, 'calibrated drone level (audition P3)');
  assert.deepEqual(inst('clav-funk'), ['sampler:clavinet', 'sampler:ep-wurli', null, null]);
  assert.equal(named('clav-funk').echo, 'slapback');
  assert.ok(f('clav-funk').patch.fx.reverb.returnGain <= 0.6 && f('clav-funk').patch.slots[0].sends.reverb <= 0.15, 'dry-ish');
  assert.deepEqual(inst('music-box-lullaby'), ['sampler:music-box', 'synth:glass-pad', 'sampler:celesta', null]);
  assert.equal(named('music-box-lullaby').space, 'cathedral');
  assert.equal(f('music-box-lullaby').patch.slots[2].lowNote, f('music-box-lullaby').patch.slots[0].highNote + 1, 'celesta takes over above the music box');
  for (const id of V2) {
    const song = factoryById(id);
    if (song.patch.fx.delay.sync !== 'off') assert.ok(song.tempo >= 60 && song.tempo <= 140, `${id}: synced echo needs a tempo`);
    for (const k of ['modWheel', 'expression']) {
      const m = /^slots\.(\d)\.gain$/.exec(song.patch[k].target);
      if (m) assert.ok(song.patch.slots[Number(m[1])], `${id}: ${k} targets an existing slot`);
    }
  }
});

test('audition fixes: drone ≈ 1.0 in drone songs, Organ Swell pad +8 dB, Sub + Shimmer pad starts at C3', () => {
  const f = (id) => factoryById(`factory:${id}`);
  for (const id of ['sunday-pad-piano', 'prayer-wash', 'sub-shimmer']) {
    const g = f(id).drone.gain;
    assert.ok(g >= 0.85 && g <= 1.25, `${id} drone.gain ${g}`);
  }
  const pad = f('organ-swell').patch.slots[1].gain;
  assert.ok(Math.abs(20 * Math.log10(pad / 0.45) - 8) < 0.1, `organ pad ${pad}`);
  const glass = f('sub-shimmer').patch.slots[1];
  assert.equal(glass.lowNote, 48);
  assert.ok(glass.lowNote > f('sub-shimmer').patch.slots[3].lowNote);
});

test('morning-prep (round2-shell #8): stab and lead layers sit 4–6 dB under the loudest slot, not 12–13', () => {
  // audition (tools/audition.mjs --only gospel-stab-b3,synthwave; solo RMS 0.5–8 s): poly-stab 0.5 → 0.85 moved the
  // stab from −34.8 to −30.2 dBFS (organ −24.7: −10.1 → −5.5 dB; wheel 0.7 as in the audition, full wheel +3.1 dB);
  // square-lead 0.6 → 1.2 moved the lead from −36.8 to −30.8 dBFS (808 sub −25.6: −11.2 → −5.2 dB)
  const f = (id) => factoryById(`factory:${id}`);
  const stab = f('gospel-stab-b3').patch.slots[1];
  const lead = f('synthwave').patch.slots[2];
  assert.equal(stab.instrument.id, 'poly-stab');
  assert.equal(lead.instrument.id, 'square-lead');
  const riseDb = (g, was) => 20 * Math.log10(g / was);
  assert.ok(Math.abs(riseDb(stab.gain, 0.5) - 4.6) < 0.1, `stab gain ${stab.gain}`);
  assert.ok(Math.abs(riseDb(lead.gain, 0.6) - 6.0) < 0.1, `lead gain ${lead.gain}`);
  // measured solo levels scaled from the pre-fix audition: 4–6 dB under the loudest slot
  assert.ok(-10.1 + riseDb(stab.gain, 0.5) >= -6 && -10.1 + riseDb(stab.gain, 0.5) <= -4);
  assert.ok(-11.2 + riseDb(lead.gain, 0.6) >= -6 && -11.2 + riseDb(lead.gain, 0.6) <= -4);
  const row = PARAMS.find((p) => p.path === 'slots.<i>.gain');
  for (const g of [stab.gain, lead.gain]) assert.ok(g >= row.min && g <= row.max, `gain ${g} within ${row.min}..${row.max}`);
  // the store keeps them unclamped
  const norm = (id) => normalizeSong(JSON.parse(JSON.stringify(f(id))), `x-${id}`).patch;
  assert.equal(norm('gospel-stab-b3').slots[1].gain, stab.gain);
  assert.equal(norm('synthwave').slots[2].gain, lead.gain);
});
