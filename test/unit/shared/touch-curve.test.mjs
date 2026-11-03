// shared/touch-curve.js (v11-touch): the named curves stay bit-exact, compile/eval, the "play soft, then hard" fit,
// and the expression-pedal taper. Pure node:test, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../../../app/js/shared/touch-curve.js';
import { describe as describeParam } from '../../../app/js/shared/params.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b} (±${eps})`);

/** SPEC §2 Slot.velocityCurve, exactly as engine/audio.js computed it before v11-touch. */
function oldCurve(vel127, curve) {
  const v = Math.min(1, Math.max(0, (Number(vel127) || 0) / 127));
  if (curve === 'soft') return Math.pow(v, 0.6);
  if (curve === 'hard') return Math.pow(v, 1.6);
  if (curve === 'fixed') return 100 / 127;
  return v;
}

test('named curves: touchAt on COMPILED_PRESETS is bit-identical to the SPEC formulas (old libraries unchanged)', () => {
  for (const name of ['soft', 'normal', 'hard', 'fixed']) {
    const c = T.COMPILED_PRESETS[name];
    for (let v = -3; v <= 130; v++) assert.equal(T.touchAt(c, v), oldCurve(v, name), `${name} @ ${v}`);
    for (const v of [0.5, 63.7, 126.9, NaN, undefined, '90']) assert.equal(T.touchAt(c, v), oldCurve(v, name), `${name} @ ${v}`);
  }
  assert.equal(T.LINEAR_TOUCH, T.COMPILED_PRESETS.normal);
  assert.ok(Object.isFrozen(T.COMPILED_PRESETS.soft));
});

test('compileTouch / touchAt: shape, min / max output and the full-volume velocity', () => {
  const c = T.compileTouch({ shape: 2, min: 0.2, max: 0.9, top: 100 });
  near(T.touchAt(c, 0), 0.2, 1e-12, 'floor');
  near(T.touchAt(c, 50), 0.2 + 0.7 * 0.25, 1e-12, 'half way to top, squared');
  near(T.touchAt(c, 100), 0.9, 1e-12, 'top reaches max');
  near(T.touchAt(c, 127), 0.9, 1e-12, 'past top stays at max');
  // monotone for every shape in range
  for (const shape of [0.25, 0.6, 1, 1.6, 4]) {
    const k = T.compileTouch({ shape });
    let prev = -1;
    for (let v = 1; v <= 127; v++) {
      const y = T.touchAt(k, v);
      assert.ok(y >= prev && y <= 1, `shape ${shape} monotone at ${v}`);
      prev = y;
    }
  }
  // min above max is ordered, never reversed
  const r = T.compileTouch({ min: 0.8, max: 0.3 });
  near(T.touchAt(r, 1), 0.3 + 0.5 / 127, 1e-12);
  near(T.touchAt(r, 127), 0.8, 1e-12);
});

test('normalizeTouch: defaults, clamping, whole top; ranges match the PARAMS rows', () => {
  assert.deepEqual(T.normalizeTouch(), { shape: 1, min: 0, max: 1, top: 127 });
  assert.deepEqual(T.normalizeTouch({ shape: 99, min: -1, max: 'x', top: 3.6 }), { shape: 4, min: 0, max: 1, top: 20 });
  assert.deepEqual(T.normalizeTouch({ top: 99.6 }).top, 100);
  for (const k of T.TOUCH_KEYS) {
    const row = describeParam(`slots.2.touch.${k}`);
    assert.ok(row, `PARAMS row slots.<i>.touch.${k}`);
    assert.equal(row.min, T.TOUCH_RANGE[k].min);
    assert.equal(row.max, T.TOUCH_RANGE[k].max);
    assert.equal(row.default, T.TOUCH_RANGE[k].default);
  }
  assert.deepEqual([...describeParam('slots.0.velocityCurve').enum], ['soft', 'normal', 'hard', 'fixed', 'custom']);
});

test('presetOf / touchWord', () => {
  assert.equal(T.presetOf(T.TOUCH_PRESETS.soft), 'soft');
  assert.equal(T.presetOf({}), 'normal');
  assert.equal(T.presetOf({ shape: 1.6 }), 'hard');
  assert.equal(T.presetOf({ min: 100 / 127, max: 100 / 127, shape: 3 }), 'fixed');
  assert.equal(T.presetOf({ shape: 1.6, top: 110 }), null);
  assert.equal(T.touchWord({ shape: 0.5 }), 'Light');
  assert.equal(T.touchWord({ shape: 1.1 }), 'Even');
  assert.equal(T.touchWord({ shape: 2 }), 'Heavy');
  assert.equal(T.touchWord({ min: 0.5, max: 0.5 }), 'Fixed');
});

test('fitTouch: an average player fits ≈ linear; light and heavy hands fit lighter / heavier curves', () => {
  const avg = T.fitTouch([38, 40, 42, 39, 41, 40], [124, 127, 126, 127, 125, 127]);
  assert.equal(avg.ok, true);
  assert.equal(avg.soft, 40);
  assert.ok(Math.abs(avg.touch.shape - 1) < 0.1 && avg.touch.top >= 125, JSON.stringify(avg));
  // light-touch board: soft ≈ 20, hard never past ≈ 90 → reaches full at 90, lighter curve
  const light = T.fitTouch([18, 20, 22, 21, 19, 20], [88, 90, 92, 91, 89, 90]);
  assert.equal(light.touch.top, 90);
  assert.ok(light.touch.shape < 1, JSON.stringify(light));
  near(T.touchAt(T.compileTouch(light.touch), light.soft), T.FIT_SOFT_TARGET, 1e-3, 'soft notes land on the target');
  near(T.touchAt(T.compileTouch(light.touch), light.hard), 1, 1e-12, 'hard notes reach full');
  // heavy hand: soft ≈ 60 → needs the exponent up (≈ the 'hard' preset)
  const heavy = T.fitTouch([58, 60, 62, 61, 59, 60], [127, 127, 126, 127, 127, 127]);
  assert.ok(heavy.touch.shape > 1.4 && heavy.touch.shape < 1.8, JSON.stringify(heavy));
  // min / max of the curve being replaced are kept, and the soft notes still land on the target
  const floor = T.fitTouch([30, 30, 30], [110, 110, 110], { min: 0.1, max: 0.9 });
  assert.equal(floor.touch.min, 0.1);
  assert.equal(floor.touch.max, 0.9);
  near(T.touchAt(T.compileTouch(floor.touch), 30), T.FIT_SOFT_TARGET, 1e-3);
  // outliers do not move the medians far
  const odd = T.fitTouch([40, 41, 39, 127, 40], [120, 121, 5, 122, 120]);
  assert.equal(odd.soft, 40);
  assert.equal(odd.hard, 120);
});

test('fitTouch: too few notes or soft = hard is refused with a reason', () => {
  assert.deepEqual(T.fitTouch([40, 41], [100, 101, 102]).reason, 'few');
  assert.deepEqual(T.fitTouch([], []).reason, 'few');
  const same = T.fitTouch([100, 100, 100], [100, 104, 102]); // the computer keyboard always sends 100
  assert.equal(same.ok, false);
  assert.equal(same.reason, 'same');
  assert.equal(same.soft, 100);
  // junk velocities are ignored
  assert.equal(T.fitTouch([0, -4, 'x', 300], [100, 110, 120]).reason, 'few');
});

test('pedalCurve: linear is the identity (bit-exact); log is an audio taper with fixed ends', () => {
  for (const x of [0, 0.1, 0.5, 0.77, 1]) {
    assert.equal(T.pedalCurve(x, 'linear'), x);
    assert.equal(T.pedalCurve(x, undefined), x);
  }
  assert.equal(T.pedalCurve(0, 'log'), 0);
  near(T.pedalCurve(1, 'log'), 1, 1e-12);
  near(T.pedalCurve(0.5, 'log'), 9 / 99, 1e-12, 'half travel ≈ −20.8 dB');
  assert.equal(T.pedalCurve(-1, 'log'), 0);
  near(T.pedalCurve(2, 'log'), 1, 1e-12);
  let prev = -1;
  for (let i = 0; i <= 100; i++) {
    const y = T.pedalCurve(i / 100, 'log');
    assert.ok(y > prev || i === 0);
    prev = y;
  }
  assert.deepEqual([...T.PEDAL_CURVES], ['linear', 'log']);
});
