// shared/velocity-cal.js (TOUCH, D43): Pianoteq-style calibration curves (check, text format both ways, evaluation,
// presets, the five-step assistant) and the dB dynamics of shared/touch-curve.js. Pure node:test, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../../../app/js/shared/velocity-cal.js';
import * as T from '../../../app/js/shared/touch-curve.js';

const FP10 = 'Velocity = [0, 1, 18, 32, 50, 108, 127; 0, 0, 30, 57, 84, 127, 127]';
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b} (±${eps})`);

test('parse: a pasted Pianoteq string gives its points, and copying it back out returns the same string', () => {
  const r = C.parseVelocity(FP10);
  assert.equal(r.ok, true);
  assert.deepEqual(r.curve, { in: [0, 1, 18, 32, 50, 108, 127], out: [0, 0, 30, 57, 84, 127, 127] });
  assert.equal(C.formatVelocity(r.curve), FP10);
  // other spellings of the same curve: no prefix, no brackets, spaces only, upper case, a colon, new lines
  for (const t of ['[0, 1, 18, 32, 50, 108, 127; 0, 0, 30, 57, 84, 127, 127]',
    '0 1 18 32 50 108 127 ; 0 0 30 57 84 127 127', 'VELOCITY=[0,1,18,32,50,108,127;0,0,30,57,84,127,127]',
    'velocity: [0, 1, 18, 32, 50, 108, 127;\n 0, 0, 30, 57, 84, 127, 127]  ']) {
    const p = C.parseVelocity(t);
    assert.equal(p.ok, true, t);
    assert.equal(C.formatVelocity(p.curve), FP10, t);
  }
  // decimals survive (2 places), and the text form round-trips
  const d = C.parseVelocity('Velocity = [0, 23.5, 127; 0, 40.25, 127]');
  assert.deepEqual(d.curve, { in: [0, 23.5, 127], out: [0, 40.25, 127] });
  assert.equal(C.formatVelocity(d.curve), 'Velocity = [0, 23.5, 127; 0, 40.25, 127]');
  assert.deepEqual(C.parseVelocity(C.formatVelocity({ in: [0, 10.004, 127], out: [0, 3.333, 127] })).curve,
    { in: [0, 10, 127], out: [0, 3.33, 127] });
  // every preset round-trips through the text form
  for (const p of Object.values(C.CAL_PRESETS)) assert.deepEqual(C.parseVelocity(C.formatVelocity(p)).curve, p);
});

test('bad input is refused with a reason: shape of the text, counts, ranges, monotone', () => {
  const bad = {
    '': /Paste a curve/,
    'Velocity = [0, 127, 0, 127]': /Two rows/,
    'Velocity = [0, 127; 0, 127; 1]': /Two rows/,
    'Velocity = [0, 127; 0, 127': /closing/,
    'Velocity = [0, 64; 0]': /same count/,
    'Velocity = [64; 64]': /2 to 12 points/,
    [`Velocity = [${Array.from({ length: 13 }, (_, i) => i * 10).join(', ')}; ${Array(13).fill(5).join(', ')}]`]:
      /2 to 12 points/,
    'Velocity = [0, 128; 0, 127]': /0 to 127/,
    'Velocity = [0, -1; 0, 127]': /not a velocity/,
    'Velocity = [0, 1e2; 0, 127]': /not a velocity/,
    'Velocity = [0, abc; 0, 127]': /not a velocity/,
    'Velocity = [0, 64, 64, 127; 0, 10, 20, 127]': /must rise/,
    'Velocity = [0, 80, 40; 0, 64, 127]': /must rise/,
    'Velocity = [0, 64, 127; 0, 90, 80]': /can't play quieter/,
    'Velocity = [[0, 127]; [0, 127]]': /one curve/,
  };
  for (const [t, re] of Object.entries(bad)) {
    const r = C.parseVelocity(t);
    assert.equal(r.ok, false, t);
    assert.match(r.error, re, t);
  }
  assert.equal(C.parseVelocity(null).ok, false);
  for (const raw of [null, 5, {}, { in: [0, 127] }, { in: [0, 127], out: [0, NaN] }, { in: ['0', 127], out: [0, 127] },
    { in: [0, Infinity], out: [0, 127] }]) assert.equal(C.validCurve(raw), null, JSON.stringify(raw));
  // flat stretches are fine (the FP-10 curve has two), and a check is idempotent
  const ok = C.validCurve({ in: [0, 1, 127], out: [0, 0, 127] });
  assert.deepEqual(C.validCurve(ok), ok);
});

test('evaluation: linear between points, flat outside, rounded to a whole velocity, 0 = silent', () => {
  const c = C.compileCurve(C.parseVelocity(FP10).curve);
  assert.ok(Object.isFrozen(c));
  assert.equal(C.calAt(c, 0), 0);
  assert.equal(C.calAt(c, 1), 0);
  assert.equal(C.calAt(c, 18), 30);
  near(C.calAt(c, 25), 30 + (27 * 7) / 14, 1e-12, 'between 18 and 32');
  assert.equal(C.calAt(c, 108), 127);
  assert.equal(C.calAt(c, 127), 127);
  assert.equal(C.calVelocity(c, 1), 0, 'silent');
  assert.equal(C.calVelocity(c, 2), 2); // 30 · 1 / 17 = 1.76
  assert.equal(C.calVelocity(c, 64), 94); // 84 + (127 − 84) · (64 − 50) / (108 − 50) = 94.38
  // monotone everywhere: harder never plays quieter
  let last = -1;
  for (let v = 0; v <= 127; v += 0.25) {
    const y = C.calAt(c, v);
    assert.ok(y >= last, `monotone at ${v}`);
    last = y;
  }
  // a curve that does not start at 0 / end at 127 is flat outside its points
  const mid = C.compileCurve({ in: [20, 100], out: [10, 110] });
  assert.equal(C.calAt(mid, 5), 10);
  assert.equal(C.calAt(mid, 120), 110);
  assert.equal(C.calAt(mid, 60), 60);
  // the linear preset is the identity
  const lin = C.compileCurve(C.CAL_PRESETS.linear);
  for (let v = 1; v <= 127; v++) assert.equal(C.calVelocity(lin, v), v);
  assert.equal(C.compileCurve({ in: [0], out: [0] }), null);
});

test('presets: Linear plus the old named curves as points (light = soft v^0.6, heavy = hard v^1.6, fixed 100)', () => {
  assert.deepEqual(Object.keys(C.CAL_PRESETS), ['linear', 'light', 'heavy', 'fixed']);
  for (const [k, p] of Object.entries(C.CAL_PRESETS)) {
    assert.ok(C.validCurve(p), k);
    assert.ok(p.in.length <= C.CAL_MAX_POINTS, k);
    assert.equal(C.presetOfCurve(p), k);
  }
  const named = { light: T.COMPILED_PRESETS.soft, heavy: T.COMPILED_PRESETS.hard };
  for (const [k, touch] of Object.entries(named)) {
    const c = C.compileCurve(C.CAL_PRESETS[k]);
    // within 0.8 velocity of the old curve everywhere (piecewise-linear through 10 samples of it)
    for (let v = 1; v <= 127; v++) near(C.calAt(c, v), T.touchAt(touch, v) * 127, 0.8, `${k} @ ${v}`);
  }
  const fixed = C.compileCurve(C.CAL_PRESETS.fixed);
  for (const v of [1, 64, 127]) assert.equal(C.calVelocity(fixed, v), 100);
  assert.equal(C.presetOfCurve({ in: [0, 127], out: [0, 126] }), null);
  // an old {shape,min,max,top} curve converts to points that play it (the editor's starting point)
  const old = { shape: 2, min: 0.1, max: 0.9, top: 100 };
  const pts = C.curveFromTouch(old);
  assert.ok(C.validCurve(pts));
  assert.ok(pts.in.includes(100), 'top is a point');
  const oc = T.compileTouch(old);
  for (const x of pts.in) near(C.calAt(C.compileCurve(pts), x), T.touchAt(oc, x) * 127, 0.005, `point ${x}`);
});

const rep = (v, n = 6) => Array.from({ length: n }, (_, i) => v + ((i % 3) - 1)); // v−1, v, v+1, …

test('assistant: medians map to silence 0 / p 32 / mp 48 / f 96 / fff 120, and harder than fff still gets louder', () => {
  const r = C.fitCalibration({ silence: rep(6), p: rep(30), mp: rep(48), f: rep(80), fff: rep(104) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.medians, { silence: 6, p: 30, mp: 48, f: 80, fff: 104 });
  // full level at fff + 7 · (fff − f) / 24 = 104 + 7 = 111, not at the fff median (the old fit's clamp)
  assert.deepEqual(r.curve, { in: [0, 6, 30, 48, 80, 104, 111], out: [0, 0, 32, 48, 96, 120, 127] });
  const c = C.compileCurve(r.curve);
  assert.equal(C.calVelocity(c, 6), 0, 'the silence median plays nothing');
  assert.ok(C.calVelocity(c, 7) >= 1, 'just above it sounds');
  assert.equal(C.calVelocity(c, 30), 32);
  assert.equal(C.calVelocity(c, 104), 120);
  assert.ok(C.calAt(c, 107) > C.calAt(c, 104), 'a note harder than the fff median is louder');
  assert.equal(C.calVelocity(c, 111), 127);
  assert.equal(C.parseVelocity(C.formatVelocity(r.curve)).ok, true);
});

test('assistant: a light board that never sends 127 reaches full level at its hardest notes', () => {
  // a light board: everything comes in low, fff around 92, the hardest note it ever sent 98
  const fff = [88, 90, 92, 92, 95, 98];
  const r = C.fitCalibration({ silence: [3, 4, 4, 5, 4, 3], p: rep(16), mp: rep(28), f: rep(70), fff });
  assert.equal(r.ok, true);
  const c = C.compileCurve(r.curve);
  assert.equal(r.medians.fff, 92);
  assert.equal(C.calVelocity(c, 92), 120);
  assert.equal(C.calVelocity(c, Math.max(...fff)), 127, 'its hardest note plays full');
  assert.ok(r.curve.in.at(-1) < 127, `full level reached at ${r.curve.in.at(-1)}, below 127`);
  // the old two-step fit, for comparison: full level at the hard median, everything harder clamped
  const old = T.fitTouch(rep(16), fff);
  assert.equal(old.touch.top, 92);
});

test('assistant: a hard board whose fff tops out at 127 plays full there, with an f → fff step still louder', () => {
  const r = C.fitCalibration({ silence: rep(10), p: rep(45), mp: rep(62), f: rep(100), fff: [127, 127, 127, 126, 127] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.curve, { in: [0, 10, 45, 62, 100, 127], out: [0, 0, 32, 48, 96, 127] });
  // fff median 124: the extrapolated full point (124 + 7) lands past 127, so full is at 127
  const r2 = C.fitCalibration({ silence: rep(10), p: rep(45), mp: rep(62), f: rep(100), fff: rep(124) });
  assert.deepEqual(r2.curve.in.slice(-2), [124, 127]);
  assert.deepEqual(r2.curve.out.slice(-2), [120, 127]);
});

test('assistant: refusals: too few notes, no difference (the computer keys), steps out of order', () => {
  const good = { silence: rep(6), p: rep(30), mp: rep(48), f: rep(80), fff: rep(104) };
  const few = C.fitCalibration({ ...good, mp: [40, 41] });
  assert.deepEqual([few.ok, few.reason, few.step], [false, 'few', 'mp']);
  assert.equal(C.fitCalibration({ ...good, f: [0, 128, 200] }).reason, 'few', 'out-of-range velocities do not count');
  const same = C.fitCalibration(Object.fromEntries(C.CAL_STEPS.map((k) => [k, rep(100)])));
  assert.deepEqual([same.ok, same.reason], [false, 'same']);
  const order = C.fitCalibration({ ...good, f: rep(47) });
  assert.deepEqual([order.ok, order.reason, order.step], [false, 'order', 'f']);
  assert.equal(C.fitCalibration({ ...good, mp: rep(31) }).reason, 'order', 'closer than CAL_MIN_GAP');
  assert.equal(C.fitCalibration(null).reason, 'few');
});

test('dynamics in dB: range 1..6, 60 dB for multi-layer at 6, single layer capped at 72 dB, ≤ 3 bit-identical', () => {
  assert.equal(T.DYN_RANGE.max, 6);
  assert.equal(T.validDynRange(9), 6);
  assert.equal(T.validDynRange(4.567), 4.57);
  near(T.dynamicsDb(1), 10, 1e-12);
  near(T.dynamicsDb(6), 60, 1e-12);
  near(T.dynamicsDb(1, T.DYN_SPAN_SINGLE_DB), 24, 1e-12);
  near(T.dynamicsDb(3, T.DYN_SPAN_SINGLE_DB), 72, 1e-12);
  near(T.dynamicsDb(6, T.DYN_SPAN_SINGLE_DB), 72, 1e-12, 'capped, not 144');
  assert.equal(T.rangeOfDynamicsDb(60), 6);
  assert.equal(T.rangeOfDynamicsDb(35.5), 3.55);
  assert.equal(T.rangeOfDynamicsDb(5), 1);
  assert.equal(T.rangeOfDynamicsDb('x'), null);
  // the pre-D43 formula, for every range ≤ 3 (step 0.01) and level: the same bits
  const before = (v, span, range) => {
    const base = -span * (1 - v);
    return range === 1 ? base : base + span * (range - 1) * (v - T.DYN_PIVOT);
  };
  for (let ri = 100; ri <= 300; ri++) {
    const range = ri / 100;
    for (let vi = 0; vi <= 127; vi++) {
      const v = vi / 127;
      for (const span of [10, 24]) assert.equal(T.velocityDb(v, span, range), before(v, span, range));
    }
  }
  // past 3: multi-layer keeps the formula, single layer stays at the range-3 numbers
  for (const range of [3.5, 4, 6]) {
    for (const v of [0, 0.3, 0.75, 1]) {
      assert.equal(T.velocityDb(v, 10, range), before(v, 10, range));
      assert.equal(T.velocityDb(v, 24, range), before(v, 24, 3));
    }
  }
  // the pivot (velocity ≈ 96) never moves
  for (const range of [1, 3, 6]) near(T.velocityDb(T.DYN_PIVOT, 10, range), -2.5, 1e-12);
  // loud end at 6: +12.5 dB above full for multi-layer, +12 dB (as at 3) for single layer
  near(T.velocityDb(1, 10, 6), 12.5, 1e-12);
  near(T.velocityDb(1, 24, 6), 12, 1e-12);
});
