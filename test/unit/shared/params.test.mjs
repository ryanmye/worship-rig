import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PARAMS, SLOT_COUNT, INSTRUMENT_PARAM_ENTRY, parsePath, describe, isValidPath, expandPaths, clamp, faderTaper,
  inverseTaper, gainToDb, dbToGain, formatValue, LEARNABLE, isLearnable, isLearnButton, ROLE_DEFAULTS, defaultSlot,
  EQ_BAND_COUNT, EQ_BAND_TYPES,
} from '../../../app/js/shared/params.js';

const UNITS = ['lin', 'dB-display', 'dB', 'Hz', 's', 'semis', 'midi', 'bool', 'enum'];

test('table entries are well-formed', () => {
  const seen = new Set();
  for (const e of PARAMS) {
    assert.ok(!seen.has(e.path), `duplicate ${e.path}`);
    seen.add(e.path);
    assert.ok(UNITS.includes(e.unit), e.path);
    assert.ok(['lin', 'log'].includes(e.curve), e.path);
    assert.equal(typeof e.label, 'string');
    assert.ok(Object.isFrozen(e));
    if (e.unit === 'enum') {
      assert.ok(Array.isArray(e.enum) && e.enum.includes(e.default), e.path);
    } else if (e.unit === 'bool') {
      assert.equal(typeof e.default, 'boolean', e.path);
    } else {
      assert.ok(e.min < e.max, e.path);
      // sustain: an optional row may default to null (the instrument's own), a row with words to one of them
      if (e.default === null) assert.equal(e.optional, true, `${e.path}: null default only on an optional row`);
      else if (typeof e.default === 'string') assert.ok(e.words && e.words.includes(e.default), e.path);
      else assert.ok(e.default >= e.min && e.default <= e.max, e.path);
      if (e.curve === 'log') assert.ok(e.min > 0, `log param ${e.path} needs min > 0`);
    }
  }
  assert.ok(Object.isFrozen(PARAMS));
});

test('table covers the SPEC §4 grammar', () => {
  const need = [
    ...['gain', 'pan', 'octave', 'transpose', 'lowNote', 'highNote', 'sustain', 'mono', 'velocityCurve', 'bendEnabled']
      .map((k) => `slots.<i>.${k}`),
    'slots.<i>.sends.reverb', 'slots.<i>.sends.delay', 'slots.<i>.sends.chorus',
    // engine-3 additions (slot width/EQ, master EQ, glue compressor)
    'slots.<i>.width', 'slots.<i>.eq.low', 'slots.<i>.eq.high', 'fx.eq.low', 'fx.eq.mid', 'fx.eq.high', 'fx.comp.amount',
    // slot EQ (design/eq/DECISION.md §2 flat rows, then AMENDMENT.md §4 WING-style bands b1..b8 + both cuts)
    ...['lowHz', 'mid1', 'mid1Hz', 'mid1Q', 'mid2', 'mid2Hz', 'mid2Q', 'highHz', 'cutHz', 'hiCutHz'].map((k) => `slots.<i>.eq.${k}`),
    ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap((k) => ['on', 'type', 'hz', 'db', 'q'].map((f) => `slots.<i>.eq.b${k}.${f}`)),
    // sustain: release (s to −60 dB, optional) and pedalHold ('natural' | 2–30 s)
    'slots.<i>.release', 'slots.<i>.pedalHold',
    'fx.reverb.size', 'fx.reverb.damp', 'fx.reverb.predelay', 'fx.reverb.returnGain',
    'fx.delay.time', 'fx.delay.feedback', 'fx.delay.pingpong', 'fx.delay.tone', 'fx.delay.sync', 'fx.delay.returnGain',
    'fx.chorus.rate', 'fx.chorus.depth', 'fx.chorus.returnGain',
    ...['amount', 'wow', 'flutter', 'crackle', 'bits', 'tone', 'saturation'].map((k) => `fx.lofi.${k}`),
    'master.volume', ...['gain', 'brightness', 'movement', 'width', 'fade'].map((k) => `drone.${k}`),
  ];
  assert.deepEqual(PARAMS.map((e) => e.path).sort(), need.sort());
});

test('specific ranges from the contract', () => {
  const d = (p) => describe(p);
  assert.deepEqual([d('slots.0.gain').min, d('slots.0.gain').max, d('slots.0.gain').unit], [0, 2, 'dB-display']);
  assert.deepEqual([d('slots.0.pan').min, d('slots.0.pan').max], [-1, 1]);
  assert.deepEqual([d('slots.0.octave').min, d('slots.0.octave').max], [-2, 2]);
  assert.deepEqual([d('slots.0.transpose').min, d('slots.0.transpose').max, d('slots.0.transpose').unit], [-12, 12, 'semis']);
  assert.deepEqual([d('slots.0.lowNote').default, d('slots.0.highNote').default], [0, 127]);
  assert.deepEqual([...d('slots.0.mono').enum], ['off', 'lowest', 'highest']);
  assert.deepEqual([...d('slots.0.velocityCurve').enum], ['soft', 'normal', 'hard', 'fixed']);
  assert.deepEqual([d('fx.delay.time').min, d('fx.delay.time').max, d('fx.delay.time').curve, d('fx.delay.time').unit], [0.05, 1.5, 'log', 's']);
  assert.equal(d('fx.delay.feedback').max, 0.9);
  assert.deepEqual([...d('fx.delay.sync').enum], ['off', '1/4', '1/8d', '1/8']);
  assert.deepEqual([d('fx.chorus.rate').min, d('fx.chorus.rate').max, d('fx.chorus.rate').curve, d('fx.chorus.rate').unit], [0.05, 3, 'log', 'Hz']);
  assert.deepEqual([d('master.volume').min, d('master.volume').max], [0, 2]);
  assert.ok(Math.abs(gainToDb(d('master.volume').default) + 6) < 1e-9); // −6 dB default
  assert.deepEqual([d('drone.fade').min, d('drone.fade').max, d('drone.fade').unit], [1, 20, 's']);
  assert.equal(d('fx.lofi.amount').default, 0); // bypassed by default
});

test('engine-3 entries: slot width/EQ, master EQ, glue', () => {
  const d = (p) => describe(p);
  assert.deepEqual([d('slots.2.width').min, d('slots.2.width').max, d('slots.2.width').default], [0, 1.5, 1]);
  for (const p of ['slots.0.eq.low', 'slots.3.eq.high', 'fx.eq.low', 'fx.eq.mid', 'fx.eq.high'])
    assert.deepEqual([d(p).min, d(p).max, d(p).default, d(p).unit], [-12, 12, 0, 'dB'], p);
  assert.deepEqual([d('fx.comp.amount').min, d('fx.comp.amount').max, d('fx.comp.amount').default], [0, 1, 0]);
  assert.equal(clamp('slots.1.eq.low', 20), 12);
  assert.equal(clamp('slots.1.width', 2), 1.5);
  assert.equal(formatValue('fx.eq.high', 3), '+3.0 dB');
  assert.equal(formatValue('fx.eq.high', -2.25), '−2.3 dB');
  assert.equal(formatValue('slots.0.eq.low', 0), '0.0 dB');
  assert.equal(formatValue('slots.0.width', 0.8), '80%');
  assert.equal(formatValue('fx.comp.amount', 0.5), '50%');
  for (const bad of ['slots.0.eq', 'slots.0.eq.mid', 'fx.eq', 'fx.comp.threshold', 'fx.comp']) assert.equal(describe(bad), null, bad);
});

test('slot EQ bands (AMENDMENT §4): b1..b8 {on,type,hz,db,q}, cuts, defaults = the legacy 2-shelf strip', () => {
  const d = (p) => describe(p);
  assert.equal(EQ_BAND_COUNT, 8);
  assert.deepEqual([...EQ_BAND_TYPES], ['off', 'lowshelf', 'peak', 'highshelf', 'notch', 'lowcut', 'highcut']);
  for (let k = 1; k <= 8; k++) {
    const b = `slots.2.eq.b${k}`;
    assert.equal(d(`${b}.on`).default, k === 1 || k === 8, `${b}.on`);
    assert.equal(d(`${b}.type`).default, k === 1 ? 'lowshelf' : k === 8 ? 'highshelf' : 'peak');
    assert.deepEqual([...d(`${b}.type`).enum], [...EQ_BAND_TYPES]);
    assert.deepEqual([d(`${b}.hz`).min, d(`${b}.hz`).max, d(`${b}.hz`).unit, d(`${b}.hz`).curve], [20, 20000, 'Hz', 'log']);
    assert.deepEqual([d(`${b}.db`).min, d(`${b}.db`).max, d(`${b}.db`).default, d(`${b}.db`).unit], [-15, 15, 0, 'dB']);
    assert.deepEqual([d(`${b}.q`).min, d(`${b}.q`).max, d(`${b}.q`).default, d(`${b}.q`).curve], [0.1, 10, 1, 'log']);
  }
  assert.deepEqual([d('slots.0.eq.b1.hz').default, d('slots.0.eq.b8.hz').default], [120, 6000]);
  assert.deepEqual([d('slots.0.eq.cutHz').default, d('slots.0.eq.hiCutHz').default, d('slots.0.eq.hiCutHz').max], [20, 20000, 20000]);
  assert.equal(clamp('slots.1.eq.b3.db', 40), 15);
  assert.equal(clamp('slots.1.eq.b3.type', 'notch'), 'notch');
  assert.equal(clamp('slots.1.eq.b3.type', 'bogus'), 'peak');
  assert.equal(clamp('slots.1.eq.b3.on', 1), true);
  assert.equal(formatValue('slots.1.eq.b3.hz', 2500), '2.5 kHz');
  assert.deepEqual(parsePath('slots.3.eq.b8.q'), { pattern: 'slots.<i>.eq.b8.q', slot: 3, key: null });
  for (const bad of ['slots.0.eq.b0.hz', 'slots.0.eq.b9.hz', 'slots.0.eq.b1', 'slots.0.eq.b1.gain', 'slots.0.eq.b1.hz.x'])
    assert.equal(describe(bad), null, bad);
});

test('describe: concrete paths map to patterns', () => {
  assert.equal(describe('slots.1.gain').path, 'slots.<i>.gain');
  assert.equal(describe('slots.3.sends.chorus').path, 'slots.<i>.sends.chorus');
  assert.equal(describe('fx.reverb.size').path, 'fx.reverb.size');
  assert.equal(describe('master.volume').path, 'master.volume');
  const dyn = describe('slots.2.params.tone');
  assert.equal(dyn, INSTRUMENT_PARAM_ENTRY);
  assert.equal(dyn.path, 'slots.<i>.params.<key>');
  assert.equal(dyn.dynamic, true);
});

test('describe: invalid paths → null', () => {
  for (const bad of [
    'slots.4.gain', 'slots.-1.gain', 'slots.01.gain', 'slots.x.gain', 'slots.<i>.gain', 'slots.0.nope',
    'slots.0.params.', 'slots.0.params.a.b', 'slots.0.params.1x', 'slots.0.sends', 'slots.0', 'fx.reverb',
    'fx.reverb.nope', 'nextSong', 'panic', '', 'master', 'drone.mode', 'slots..gain',
  ]) {
    assert.equal(describe(bad), null, bad);
    assert.equal(isValidPath(bad), false, bad);
  }
  assert.equal(describe(null), null);
  assert.equal(describe(42), null);
  assert.equal(parsePath({}), null);
});

test('parsePath details', () => {
  assert.deepEqual(parsePath('slots.2.params.tone'), { pattern: 'slots.<i>.params.<key>', slot: 2, key: 'tone' });
  assert.deepEqual(parsePath('slots.0.gain'), { pattern: 'slots.<i>.gain', slot: 0, key: null });
  assert.deepEqual(parsePath('fx.delay.time'), { pattern: 'fx.delay.time', slot: null, key: null });
  assert.equal(parsePath('slots.1.params._x9').key, '_x9');
});

test('isValidPath / expandPaths', () => {
  const all = expandPaths();
  const slotPatterns = PARAMS.filter((e) => e.path.includes('<i>')).length;
  assert.equal(all.length, slotPatterns * SLOT_COUNT + (PARAMS.length - slotPatterns));
  for (const p of all) assert.ok(isValidPath(p), p);
  assert.ok(all.includes('slots.3.highNote'));
  assert.ok(all.includes('drone.fade'));
  assert.ok(!all.some((p) => p.includes('<')));
  assert.ok(isValidPath('slots.0.params.drawbars'));
});

test('clamp: numbers', () => {
  assert.equal(clamp('slots.0.gain', 3), 2);
  assert.equal(clamp('slots.0.gain', -1), 0);
  assert.equal(clamp('slots.0.gain', 0.5), 0.5);
  assert.equal(clamp('slots.0.gain', '0.25'), 0.25);
  assert.equal(clamp('slots.0.gain', NaN), 0.8);
  assert.equal(clamp('slots.0.gain', 'abc'), 0.8);
  assert.equal(clamp('slots.0.gain', null), 0.8);
  assert.equal(clamp('slots.0.gain', undefined), 0.8);
  assert.equal(clamp('slots.0.gain', ''), 0.8);
  assert.equal(clamp('slots.0.gain', Infinity), 2);
  assert.equal(clamp('fx.delay.time', 0.01), 0.05);
  assert.equal(clamp('fx.delay.feedback', 1), 0.9);
  assert.equal(clamp('drone.fade', 0), 1);
});

test('clamp: integer params round', () => {
  assert.equal(clamp('slots.0.octave', 1.6), 2);
  assert.equal(clamp('slots.0.octave', 7), 2);
  assert.equal(clamp('slots.0.transpose', -3.4), -3);
  assert.equal(clamp('slots.0.transpose', -30), -12);
  assert.equal(clamp('slots.0.highNote', 200), 127);
  assert.equal(clamp('slots.0.lowNote', 59.5), 60);
});

test('clamp: bool', () => {
  const p = 'slots.0.sustain';
  assert.equal(clamp(p, true), true);
  assert.equal(clamp(p, false), false);
  assert.equal(clamp(p, 1), true);
  assert.equal(clamp(p, 0.5), true);
  assert.equal(clamp(p, 0.49), false);
  assert.equal(clamp(p, 'true'), true);
  assert.equal(clamp(p, 'ON'), true);
  assert.equal(clamp(p, '1'), true);
  assert.equal(clamp(p, 'false'), false);
  assert.equal(clamp(p, 'no'), false);
  assert.equal(clamp(p, null), false);
  assert.equal(clamp('fx.delay.pingpong', {}), false);
});

test('clamp: enum', () => {
  const p = 'slots.1.mono';
  assert.equal(clamp(p, 'lowest'), 'lowest');
  assert.equal(clamp(p, 'bogus'), 'off');
  assert.equal(clamp(p, 2), 'highest');
  assert.equal(clamp(p, 9), 'highest');
  assert.equal(clamp(p, -3), 'off');
  assert.equal(clamp(p, 0.6), 'lowest');
  assert.equal(clamp(p, NaN), 'off');
  assert.equal(clamp('fx.delay.sync', '1/8d'), '1/8d');
  assert.equal(clamp('slots.0.velocityCurve', null), 'normal');
});

test('clamp: dynamic instrument params pass through', () => {
  assert.equal(clamp('slots.0.params.tone', 0.3), 0.3);
  assert.equal(clamp('slots.0.params.cutoff', 1800), 1800);
  assert.equal(clamp('slots.0.params.cutoff', -5), -5);
  assert.equal(clamp('slots.0.params.cutoff', '12'), 12);
  assert.equal(clamp('slots.0.params.flag', true), true);
  assert.equal(clamp('slots.0.params.cutoff', 'nope'), null);
});

test('clamp: unknown path throws', () => {
  assert.throws(() => clamp('nope', 1), TypeError);
  assert.throws(() => clamp('panic', 1), TypeError);
});

test('faderTaper / inverseTaper', () => {
  assert.equal(faderTaper(0), 0);
  assert.equal(faderTaper(1), 2);
  assert.equal(faderTaper(0.5), 0.25);
  assert.equal(faderTaper(2), 2);
  assert.equal(faderTaper(-1), 0);
  assert.equal(faderTaper(NaN), 0);
  assert.equal(faderTaper('0.5'), 0.25);
  assert.ok(Math.abs(gainToDb(faderTaper(1)) - 6.0206) < 1e-3); // top ≈ +6 dB
  assert.equal(inverseTaper(0), 0);
  assert.equal(inverseTaper(-1), 0);
  assert.equal(inverseTaper(NaN), 0);
  assert.equal(inverseTaper(2), 1);
  assert.equal(inverseTaper(5), 1);
  for (let i = 0; i <= 100; i++) {
    const pos = i / 100;
    assert.ok(Math.abs(inverseTaper(faderTaper(pos)) - pos) < 1e-12);
  }
  // unity gain sits at ~79% travel
  assert.ok(Math.abs(inverseTaper(1) - Math.cbrt(0.5)) < 1e-12);
});

test('gainToDb / dbToGain', () => {
  assert.equal(gainToDb(1), 0);
  assert.equal(gainToDb(0), -Infinity);
  assert.equal(gainToDb(-1), -Infinity);
  assert.ok(Math.abs(gainToDb(0.5) + 6.0206) < 1e-4);
  assert.equal(dbToGain(0), 1);
  assert.equal(dbToGain(-Infinity), 0);
  assert.ok(Math.abs(dbToGain(-20) - 0.1) < 1e-12);
  for (const g of [0.001, 0.1, 0.7, 1, 1.9]) assert.ok(Math.abs(dbToGain(gainToDb(g)) - g) < 1e-12);
});

test('formatValue: gain', () => {
  assert.equal(formatValue('slots.0.gain', dbToGain(-6)), '−6.0 dB');
  assert.equal(formatValue('slots.0.gain', 1), '0.0 dB');
  assert.equal(formatValue('slots.0.gain', 1.0001), '0.0 dB');
  assert.equal(formatValue('slots.0.gain', 0.9995), '0.0 dB');
  assert.equal(formatValue('slots.0.gain', 2), '+6.0 dB');
  assert.equal(formatValue('slots.0.gain', 0), '−∞ dB');
  assert.equal(formatValue('master.volume', dbToGain(-12.34)), '−12.3 dB');
  assert.equal(formatValue('fx.reverb.returnGain', dbToGain(-0.06)), '−0.1 dB');
});

test('formatValue: Hz / s', () => {
  assert.equal(formatValue('fx.chorus.rate', 0.4), '0.40 Hz');
  assert.equal(formatValue('fx.chorus.rate', 1.8), '1.80 Hz');
  assert.equal(formatValue('fx.chorus.rate', 180), '180 Hz');
  assert.equal(formatValue('fx.chorus.rate', 1800), '1.8 kHz');
  assert.equal(formatValue('fx.chorus.rate', 12000), '12 kHz');
  assert.equal(formatValue('fx.delay.time', 0.35), '350 ms');
  assert.equal(formatValue('fx.delay.time', 1.2), '1.20 s');
  assert.equal(formatValue('fx.delay.time', 1), '1.00 s');
  assert.equal(formatValue('fx.reverb.predelay', 0.02), '20 ms');
  assert.equal(formatValue('drone.fade', 4), '4.00 s');
});

test('formatValue: bool / enum / semis / midi / pan / octave / percent / dynamic / unknown', () => {
  assert.equal(formatValue('slots.0.sustain', true), 'On');
  assert.equal(formatValue('slots.0.sustain', false), 'Off');
  assert.equal(formatValue('fx.delay.pingpong', 1), 'On');
  assert.equal(formatValue('fx.delay.sync', '1/8d'), '1/8d');
  assert.equal(formatValue('slots.0.mono', 'bad'), 'off');
  assert.equal(formatValue('slots.0.transpose', 2), '+2 st');
  assert.equal(formatValue('slots.0.transpose', -3), '−3 st');
  assert.equal(formatValue('slots.0.transpose', 0), '0 st');
  assert.equal(formatValue('slots.0.highNote', 59), 'B3');
  assert.equal(formatValue('slots.0.lowNote', 60), 'C4');
  assert.equal(formatValue('slots.0.pan', 0), 'C');
  assert.equal(formatValue('slots.0.pan', -0.5), 'L 50');
  assert.equal(formatValue('slots.0.pan', 1), 'R 100');
  assert.equal(formatValue('slots.0.pan', 0.004), 'C');
  assert.equal(formatValue('slots.0.octave', 1), '+1');
  assert.equal(formatValue('slots.0.octave', -2), '−2');
  assert.equal(formatValue('slots.0.octave', 0), '0');
  assert.equal(formatValue('fx.reverb.size', 0.5), '50%');
  assert.equal(formatValue('slots.2.sends.delay', 0.2), '20%');
  assert.equal(formatValue('fx.delay.feedback', 0.35), '0.35');
  assert.equal(formatValue('slots.0.params.cutoff', 1234.5678), '1234.57');
  assert.equal(formatValue('slots.0.params.flag', true), 'On');
  assert.equal(formatValue('slots.0.params.mode', 'x'), 'x');
  assert.equal(formatValue('nope', 3), '3');
});

test('LEARNABLE', () => {
  assert.deepEqual([...LEARNABLE], [
    'slots.0.gain', 'slots.1.gain', 'slots.2.gain', 'slots.3.gain', 'drone.gain', 'fx.reverb.returnGain',
    'master.volume', 'nextSong', 'prevSong', 'panic', 'fadeOutAll', 'swell',
  ]);
  assert.ok(Object.isFrozen(LEARNABLE));
  assert.ok(isLearnable('panic'));
  assert.ok(!isLearnable('fx.reverb.size'));
  assert.ok(isLearnButton('nextSong'));
  assert.ok(isLearnable('swell'), 'swell is learnable (SPEC §4)');
  assert.ok(isLearnButton('swell'), 'swell is a button control');
  assert.ok(!isLearnButton('slots.0.gain'));
  assert.ok(!isLearnButton('bogus'));
  for (const id of LEARNABLE) assert.equal(isValidPath(id), !isLearnButton(id), id);
});

test('ROLE_DEFAULTS', () => {
  assert.deepEqual(ROLE_DEFAULTS.map((r) => [r.name, r.color]), [
    ['Keys', 'orange'], ['Pad', 'green'], ['Extra', 'blue'], ['Bass', 'purple'],
  ]);
  assert.deepEqual({ ...ROLE_DEFAULTS[0].sends }, { reverb: 0.25, delay: 0.1, chorus: 0 });
  assert.deepEqual({ ...ROLE_DEFAULTS[1].sends }, { reverb: 0.5, delay: 0.15, chorus: 0.4 });
  assert.deepEqual({ ...ROLE_DEFAULTS[2].sends }, { reverb: 0.35, delay: 0.2, chorus: 0.2 });
  assert.deepEqual({ ...ROLE_DEFAULTS[3].sends }, { reverb: 0, delay: 0, chorus: 0 });
  assert.equal(ROLE_DEFAULTS[3].mono, 'lowest');
  assert.equal(ROLE_DEFAULTS[3].highNote, 59);
  assert.ok(Object.isFrozen(ROLE_DEFAULTS[0].sends));
});

test('defaultSlot: full object per role', () => {
  const s = defaultSlot(0, { type: 'sampler', id: 'salamander-piano' });
  assert.deepEqual(s, {
    instrument: { type: 'sampler', id: 'salamander-piano' },
    gain: 0.8, pan: 0, octave: 0, transpose: 0, lowNote: 0, highNote: 127, sustain: true, bendEnabled: false,
    mono: 'off', velocityCurve: 'normal', sends: { reverb: 0.25, delay: 0.1, chorus: 0 }, params: {},
  });
  const bass = defaultSlot(3, { type: 'synth', id: 'sub-bass' });
  assert.equal(bass.mono, 'lowest');
  assert.equal(bass.highNote, 59);
  assert.equal(bass.sustain, true);
  assert.equal(bass.bendEnabled, true);
  assert.deepEqual(bass.sends, { reverb: 0, delay: 0, chorus: 0 });
  assert.equal(defaultSlot(1, { type: 'organ', id: 'gospel' }).bendEnabled, true);
  assert.deepEqual(defaultSlot(2, { type: 'sampler', id: 'vibes' }).sends, { reverb: 0.35, delay: 0.2, chorus: 0.2 });
  assert.equal(defaultSlot(2, { type: 'sampler', id: 'vibes' }).sustain, true);
});

test('defaultSlot: fresh, mutable, not aliased to defaults or input', () => {
  const ref = { type: 'synth', id: 'warm-pad' };
  const a = defaultSlot(1, ref);
  const b = defaultSlot(1, ref);
  assert.notEqual(a.sends, b.sends);
  assert.notEqual(a.sends, ROLE_DEFAULTS[1].sends);
  assert.notEqual(a.instrument, ref);
  a.sends.reverb = 1;
  a.params.x = 1;
  assert.equal(ROLE_DEFAULTS[1].sends.reverb, 0.5);
  assert.deepEqual(b.params, {});
  // every field validates against the table
  for (const [k, v] of Object.entries(a)) {
    if (k === 'instrument' || k === 'params' || k === 'sends') continue;
    assert.deepEqual(clamp(`slots.1.${k}`, v), v, k);
  }
});

test('defaultSlot: errors', () => {
  assert.throws(() => defaultSlot(4, { type: 'synth', id: 'x' }), RangeError);
  assert.throws(() => defaultSlot(-1, { type: 'synth', id: 'x' }), RangeError);
  assert.throws(() => defaultSlot(1.5, { type: 'synth', id: 'x' }), RangeError);
  assert.throws(() => defaultSlot(0, null), TypeError);
  assert.throws(() => defaultSlot(0, { type: 'synth' }), TypeError);
});

test('sustain: slots.<i>.release / pedalHold rows (optional, words, clamp, format)', () => {
  const r = describe('slots.2.release');
  const p = describe('slots.2.pedalHold');
  assert.deepEqual([r.min, r.max, r.default, r.unit, r.curve, r.optional], [0.05, 8, null, 's', 'log', true]);
  assert.deepEqual([p.min, p.max, p.default, p.curve, [...p.words]], [2, 30, 'natural', 'log', ['natural']]);
  assert.equal(clamp('slots.0.release', null), null);
  assert.equal(clamp('slots.0.release', 0.01), 0.05);
  assert.equal(clamp('slots.0.release', 99), 8);
  assert.equal(clamp('slots.0.pedalHold', 'natural'), 'natural');
  assert.equal(clamp('slots.0.pedalHold', 'forever'), 'natural');
  assert.equal(clamp('slots.0.pedalHold', 1), 2);
  assert.equal(clamp('slots.0.pedalHold', 45), 30);
  assert.equal(formatValue('slots.0.pedalHold', 'natural'), 'Natural');
  assert.equal(formatValue('slots.0.pedalHold', 6), '6.00 s');
  assert.equal(formatValue('slots.0.release', null), 'Default');
  assert.equal(isLearnable('slots.0.release'), false);
});
