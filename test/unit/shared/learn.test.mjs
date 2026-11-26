// 2.x step 5 (O-AW-ML): shared/learn.js — which paths a CC can drive, the CC → value curve, invert / range, pickup
// inverse, field validation and labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isLearnablePath, isCustomLearn, learnCurve, ccToValue, valueToCc, learnFields, learnLabel,
} from '../../../app/js/shared/learn.js';
import { faderTaper, PARAMS, MAX_SLOTS } from '../../../app/js/shared/params.js';

const near = (a, b, eps = 1e-9, msg) => assert.ok(Math.abs(a - b) < eps, msg || `${a} ≈ ${b}`);

test('isLearnablePath: continuous rows only, any slot below MAX_SLOTS', () => {
  for (const p of ['slots.0.sends.reverb', 'slots.15.sends.delay', 'slots.3.pan', 'slots.2.eq.b3.hz',
    'slots.1.eq.mid1Q', 'slots.0.release', 'slots.0.pedalHold', 'slots.0.width', 'fx.delay.feedback',
    'fx.reverb.size', 'fx.chorus.rate',
    'fx.lofi.amount', 'fx.eq.mid', 'fx.comp.amount', 'drone.brightness', 'drone.fade', 'master.volume',
    'slots.0.gain']) {
    assert.equal(isLearnablePath(p), true, p);
  }
  for (const p of ['slots.0.mono', 'slots.0.sustain', 'slots.0.bendEnabled', 'slots.0.velocityCurve', 'slots.0.octave',
    'slots.0.transpose', 'slots.0.lowNote', 'slots.0.touch.top', 'slots.0.eq.b2.on', 'slots.0.eq.b2.type',
    'fx.delay.pingpong', 'fx.delay.sync', 'slots.0.params.cutoff', `slots.${MAX_SLOTS}.sends.reverb`, 'slots.01.pan',
    'fx.nope.x', 'fx.reverb', 'nextSong', 'panic', '', null, undefined, 42, 'slots.0.muted', 'song.tempo']) {
    assert.equal(isLearnablePath(p), false, String(p));
  }
});

test('isCustomLearn: the fixed 1.x / UIA rows are not custom', () => {
  for (const p of ['slots.0.gain', 'slots.9.gain', 'drone.gain', 'fx.reverb.returnGain', 'master.volume', 'nextSong']) {
    assert.equal(isCustomLearn(p), false, p);
  }
  for (const p of ['slots.0.sends.reverb', 'slots.9.pan', 'fx.delay.returnGain', 'fx.delay.feedback']) {
    assert.equal(isCustomLearn(p), true, p);
  }
});

test('learnCurve: taper for dB-display gains, log for log rows (min > 0), else linear', () => {
  assert.equal(learnCurve('master.volume'), 'taper');
  assert.equal(learnCurve('fx.delay.returnGain'), 'taper');
  assert.equal(learnCurve('fx.delay.time'), 'log');
  assert.equal(learnCurve('slots.0.eq.b2.hz'), 'log');
  assert.equal(learnCurve('slots.0.eq.b2.q'), 'log');
  assert.equal(learnCurve('fx.delay.feedback'), 'lin');
  assert.equal(learnCurve('slots.0.eq.b2.db'), 'lin');
  // every log row the table has can use the log curve (no row with min <= 0 is marked log)
  for (const e of PARAMS) if (e.curve === 'log') assert.ok(e.min > 0, e.path);
});

test('ccToValue: linear, log and taper rows; ends are the row min / max', () => {
  near(ccToValue('fx.delay.feedback', 0), 0);
  near(ccToValue('fx.delay.feedback', 1), 0.9);
  near(ccToValue('fx.delay.feedback', 0.5), 0.45);
  near(ccToValue('slots.0.pan', 0.5), 0);
  near(ccToValue('slots.0.eq.b2.hz', 0), 20, 1e-9);
  near(ccToValue('slots.0.eq.b2.hz', 1), 20000, 1e-6);
  near(ccToValue('slots.0.eq.b2.hz', 0.5), Math.sqrt(20 * 20000), 1e-6, 'log midpoint = geometric mean');
  for (const x of [0, 0.1, 0.5, 64 / 127, 1]) near(ccToValue('master.volume', x), faderTaper(x), 1e-12, `taper ${x}`);
  near(ccToValue('fx.delay.feedback', -3), 0, 1e-12, 'cc clamped');
  near(ccToValue('fx.delay.feedback', 7), 0.9, 1e-12);
});

test('ccToValue: per-mapping min / max along the curve, invert, min > max', () => {
  const m = { min: 0.2, max: 0.6 };
  near(ccToValue('fx.delay.feedback', 0, m), 0.2);
  near(ccToValue('fx.delay.feedback', 1, m), 0.6);
  near(ccToValue('fx.delay.feedback', 0.5, m), 0.4);
  near(ccToValue('fx.delay.feedback', 0, { invert: true }), 0.9);
  near(ccToValue('fx.delay.feedback', 1, { invert: true }), 0);
  near(ccToValue('fx.delay.feedback', 0.25, { ...m, invert: true }), 0.5);
  near(ccToValue('fx.delay.feedback', 0, { min: 0.6, max: 0.2 }), 0.6, 1e-12, 'min > max runs down');
  // log range 200 Hz .. 5 kHz: the midpoint is the geometric mean
  near(ccToValue('slots.0.eq.b2.hz', 0.5, { min: 200, max: 5000 }), 1000, 1e-6);
  // a range outside the row is clamped by the row
  near(ccToValue('fx.delay.feedback', 1, { max: 5 }), 0.9);
  // invert must be exactly true
  near(ccToValue('fx.delay.feedback', 0, { invert: 'yes' }), 0);
});

test('valueToCc: the inverse (pickup target); null where no CC position stands for the value', () => {
  for (const [path, m] of [['fx.delay.feedback', undefined], ['slots.0.eq.b2.hz', { min: 200, max: 5000 }],
    ['master.volume', undefined], ['fx.delay.time', { invert: true }], ['slots.0.pan', { min: -0.5, max: 1 }]]) {
    for (const x of [0, 0.13, 0.5, 0.77, 1]) near(valueToCc(path, ccToValue(path, x, m), m), x, 1e-9, `${path} ${x}`);
  }
  assert.equal(valueToCc('slots.0.release', null), null);
  assert.equal(valueToCc('slots.0.pedalHold', 'natural'), 1, 'skeptic L1: natural = the top of the track');
  assert.equal(valueToCc('fx.delay.feedback', 0.3, { min: 0.4, max: 0.4 }), null);
  assert.equal(valueToCc('fx.delay.feedback', 0.8, { min: 0, max: 0.4 }), 1, 'outside the range: the nearer end');
  assert.equal(valueToCc('fx.delay.feedback', 0.8, { min: 0, max: 0.4, invert: true }), 0);
});

test('learnFields: validates min / max / invert for paths, idempotent, leaves other keys alone', () => {
  const base = { cc: 21, channel: 0 };
  assert.deepEqual(learnFields('fx.delay.feedback', { ...base, min: 0.1, max: 5, invert: true }),
    { ...base, min: 0.1, max: 0.9, invert: true });
  assert.deepEqual(learnFields('fx.delay.feedback', { ...base, min: 'x', max: NaN, invert: 'yes' }), base);
  assert.deepEqual(learnFields('fx.delay.feedback', { ...base, max: null, invert: false }), base);
  const once = learnFields('slots.2.eq.b2.hz', { ...base, min: 1, max: 99999, future: { a: 1 } });
  assert.deepEqual(once, { ...base, min: 20, max: 20000, future: { a: 1 } }, 'unknown fields kept');
  assert.deepEqual(learnFields('slots.2.eq.b2.hz', once), once, 'idempotent');
  const button = { note: 36, channel: 9, min: 'odd', invert: 7 };
  assert.deepEqual(learnFields('nextSong', button), button, 'a button / unknown id passes unchanged');
  assert.deepEqual(learnFields('some.future.id', button), button);
});

test('learnLabel: slot or unit in front when the label lacks it', () => {
  assert.equal(learnLabel('slots.1.sends.reverb'), 'Pad reverb send');
  assert.equal(learnLabel('slots.5.pan'), 'Sound 6 pan');
  assert.equal(learnLabel('fx.delay.feedback'), 'Delay feedback');
  assert.equal(learnLabel('fx.delay.time'), 'Delay time');
  assert.equal(learnLabel('fx.reverb.size'), 'Reverb size');
  assert.equal(learnLabel('fx.reverb.predelay'), 'Reverb pre-delay');
  assert.equal(learnLabel('fx.lofi.wow'), 'Lofi wow');
  assert.equal(learnLabel('fx.eq.low'), 'Master low');
  assert.equal(learnLabel('drone.brightness'), 'Drone brightness');
  assert.equal(learnLabel('master.volume'), 'Master');
  assert.equal(learnLabel('nope'), 'nope');
});

// skeptic midi-learn-any L1: Pedal hold's knob runs along the slider's own track (log 2..40 s, ≥ 31 = 'natural'),
// so it sits where the thumb is and can get back to 'natural' (null: the store removes the field)
test('pedalHold: the knob shares the slider track, top = natural (null), pickup from natural at the top', async () => {
  const { PEDAL_HOLD_TRACK } = await import('../../../app/js/shared/learn.js');
  const { sliderScaleOf } = await (async () => {
    // views/edit/lib.js sliderScale is DOM-free math, but lib.js imports DOM helpers; mirror its log scale here
    const a = Math.log(PEDAL_HOLD_TRACK.min);
    const b = Math.log(PEDAL_HOLD_TRACK.top);
    return { sliderScaleOf: (v) => (Math.log(Math.max(PEDAL_HOLD_TRACK.min, Math.min(PEDAL_HOLD_TRACK.top, v))) - a)
      / (b - a) };
  })();
  const P = 'slots.2.pedalHold';
  for (const v of [2, 3.5, 10, 20, 30]) near(valueToCc(P, v), sliderScaleOf(v), 1e-12, `pos of ${v} s`);
  for (const nat of [null, undefined, 'natural']) assert.equal(valueToCc(P, nat), 1, String(nat));
  assert.equal(ccToValue(P, 1), null, 'top = natural');
  assert.equal(ccToValue(P, sliderScaleOf(31) + 1e-6), null, 'from 31 s up = natural');
  near(ccToValue(P, 0), 2);
  near(ccToValue(P, sliderScaleOf(12)), 12, 1e-9);
  near(ccToValue(P, sliderScaleOf(30.5)), 30, 1e-12, 'between 30 and 31: the row max');
  assert.equal(ccToValue(P, 0, { invert: true }), null, 'inverted: knob down = natural');
  // a mapping max inside the row: no natural on that knob
  near(ccToValue(P, 1, { max: 20 }), 20, 1e-9);
  // the other optional row keeps its rule: release's null has no CC position (taken over at once)
  assert.equal(valueToCc('slots.0.release', null), null);
});
