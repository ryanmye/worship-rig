import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXP_FLOOR, DEFAULT_TC, RAMP_SETTLE_TC, cancelAndHold, rampTo, glideTo, linearTo, setNow, releaseTau, stopAfterRelease,
  equalPowerCurve, fadeCurveEqualPower, holdAndFade,
} from '../../../app/js/shared/automation.js';

/**
 * Fake AudioParam: records every call and models the Web Audio automation timeline closely enough to
 * evaluate values over time (set / linear / exponential / setTarget events, cancelScheduledValues,
 * cancelAndHoldAtTime). `now` stands in for context.currentTime.
 *
 * cancelAndHoldAtTime follows what Chromium 1194 actually does (probed with OfflineAudioContext renders):
 *  - a ramp in progress at t (or ending at t) is truncated at t with the held value — correct hold;
 *  - a setValueAtTime exactly at t survives — correct hold;
 *  - otherwise (fresh param, completed ramp, earlier setValueAtTime) NO hold is inserted, so a following
 *    linear/exponential ramp starts at the previous event (or at time 0 from the default value);
 *  - after a setTargetAtTime, a following linear/exponential ramp starts at t from **0** (the value itself
 *    keeps following the target until t; a following setTargetAtTime is unaffected). Modelled as a
 *    'hold0' marker event.
 */
class FakeParam {
  constructor(defaultValue = 0, { withCancelAndHold = true } = {}) {
    this.defaultValue = defaultValue;
    this.events = []; // {type:'set'|'linear'|'exp'|'target', time, value, tc?}
    this.calls = [];
    this.now = 0;
    if (!withCancelAndHold) this.cancelAndHoldAtTime = undefined;
  }
  get value() {
    return this.valueAt(this.now);
  }
  _insert(ev) {
    // Stable: after all events with time <= ev.time (same-time events keep insertion order).
    let i = this.events.length;
    while (i > 0 && this.events[i - 1].time > ev.time) i--;
    this.events.splice(i, 0, ev);
  }
  setValueAtTime(value, time) {
    this.calls.push(['setValueAtTime', value, time]);
    this._insert({ type: 'set', time: Math.max(time, this.now), value });
  }
  linearRampToValueAtTime(value, time) {
    this.calls.push(['linearRampToValueAtTime', value, time]);
    this._insert({ type: 'linear', time, value });
  }
  exponentialRampToValueAtTime(value, time) {
    this.calls.push(['exponentialRampToValueAtTime', value, time]);
    if (value <= 0) throw new RangeError('exponentialRampToValueAtTime: value must be > 0');
    this._insert({ type: 'exp', time, value });
  }
  setTargetAtTime(value, time, tc) {
    this.calls.push(['setTargetAtTime', value, time, tc]);
    if (tc < 0) throw new RangeError('timeConstant must be >= 0');
    this._insert({ type: 'target', time: Math.max(time, this.now), value, tc });
  }
  cancelScheduledValues(time) {
    this.calls.push(['cancelScheduledValues', time]);
    const t = Math.max(time, this.now);
    this.events = this.events.filter((e) => e.time < t);
  }
  cancelAndHoldAtTime(time) {
    this.calls.push(['cancelAndHoldAtTime', time]);
    const t = Math.max(time, this.now);
    const held = this.valueAt(t);
    const removed = this.events.filter((e) => e.time >= t);
    this.events = this.events.filter((e) => e.time < t);
    const inProgressRamp = removed.find((e) => (e.type === 'linear' || e.type === 'exp') && this._segmentStart(e) < t);
    const last = this.events.at(-1);
    if (inProgressRamp) this._insert({ type: inProgressRamp.type, time: t, value: held });
    else if (removed.some((e) => e.type === 'set' && e.time === t)) this._insert({ type: 'set', time: t, value: held });
    else if (last && last.type === 'target') this._insert({ type: 'hold0', time: t, value: 0 });
    // else: Chromium inserts nothing
  }
  _segmentStart(ev) {
    const idx = this.events.indexOf(ev);
    const prev = idx > 0 ? this.events[idx - 1] : null;
    if (idx === -1) {
      const before = this.events.filter((e) => e.time < ev.time);
      return before.length ? before[before.length - 1].time : 0;
    }
    return prev ? prev.time : 0;
  }
  /** Value at time t per the Web Audio automation rules (subset). */
  valueAt(t) {
    let v = this.defaultValue;
    let tPrev = 0;
    let target = null; // {value, tc, start, v0}
    let hold0 = null; // {time}: a following ramp starts here from 0 (Chromium after setTarget + cancelAndHold)
    const targetVal = (tt) => target.value + (target.v0 - target.value) * Math.exp(-(tt - target.start) / target.tc);
    for (const ev of this.events) {
      if (ev.type === 'hold0') {
        if (t < ev.time) break;
        hold0 = { time: ev.time };
        continue;
      }
      if (ev.type === 'linear' || ev.type === 'exp') {
        const startT = hold0 ? hold0.time : target ? target.start : tPrev;
        const startV = hold0 ? 0 : target ? target.v0 : v;
        if (t < ev.time) {
          if (t < startT) break;
          const x = (t - startT) / (ev.time - startT);
          if (ev.type === 'linear') return startV + (ev.value - startV) * x;
          if (startV <= 0 || ev.value <= 0 || startV * ev.value < 0) return startV; // spec: hold
          return startV * Math.pow(ev.value / startV, x);
        }
        v = ev.value;
        tPrev = ev.time;
        target = null;
        hold0 = null;
        continue;
      }
      if (t < ev.time) break;
      hold0 = null;
      if (ev.type === 'set') {
        v = ev.value;
        target = null;
      } else {
        const v0 = target ? targetVal(ev.time) : v;
        target = { value: ev.value, tc: ev.tc, start: ev.time, v0 };
        v = v0;
      }
      tPrev = ev.time;
    }
    if (target) return target.tc === 0 ? target.value : targetVal(t);
    return v;
  }
}

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('fake param sanity: linear, exp, target', () => {
  const p = new FakeParam(0);
  p.setValueAtTime(0, 0);
  p.linearRampToValueAtTime(1, 1);
  assert.ok(near(p.valueAt(0.5), 0.5));
  assert.equal(p.valueAt(2), 1);
  const q = new FakeParam(1);
  q.setValueAtTime(100, 0);
  q.exponentialRampToValueAtTime(400, 2);
  assert.ok(near(q.valueAt(1), 200));
  const r = new FakeParam(1);
  r.setTargetAtTime(0, 0, 0.1);
  assert.ok(near(r.valueAt(0.1), Math.exp(-1)));
});

test('REVIEW 1.1 bug reproduction: naive setTarget during attack ramp does not release', () => {
  const p = new FakeParam(0);
  p.setValueAtTime(0, 0);
  p.linearRampToValueAtTime(1, 1.2); // 1.2 s attack
  p.setTargetAtTime(0, 0.3, 0.1); // naive release at 0.3 s
  assert.ok(p.valueAt(1.2) > 0.9, 'naive release is swallowed by the ramp end (the bug)');
});

test('rampTo releases correctly during an attack ramp (cancel-and-hold)', () => {
  const p = new FakeParam(0);
  p.setValueAtTime(0, 0);
  p.linearRampToValueAtTime(1, 1.2);
  const tau = releaseTau(1);
  assert.equal(rampTo(p, 0, 0.3, tau), true);
  const atRelease = p.valueAt(0.3);
  assert.ok(near(atRelease, 0.25), `held at ${atRelease}`);
  assert.ok(p.valueAt(0.35) < atRelease, 'decays immediately');
  assert.ok(p.valueAt(1.2) < atRelease * 0.01, 'no swell back up');
  // release = 1 s from 0.3 → ≈ −60 dB at 1.3 s (τ = release/6.9 ≈ ln(1000))
  assert.ok(p.valueAt(1.3) <= atRelease * 0.00101, '−60 dB at release time');
  // no discontinuity at the release point
  assert.ok(Math.abs(p.valueAt(0.2999) - p.valueAt(0.3)) < 1e-3);
  assert.deepEqual(p.calls.slice(-3), [['cancelAndHoldAtTime', 0.3], ['setTargetAtTime', 0, 0.3, tau], ['setValueAtTime', 0, 0.3 + RAMP_SETTLE_TC * tau]]);
});

test('rampTo: default tc, instant for tc <= 0, rejects non-finite', () => {
  const p = new FakeParam(0.5);
  rampTo(p, 1, 2);
  assert.deepEqual(p.calls, [['cancelAndHoldAtTime', 2], ['setTargetAtTime', 1, 2, DEFAULT_TC], ['setValueAtTime', 1, 2 + RAMP_SETTLE_TC * DEFAULT_TC]]);
  assert.equal(DEFAULT_TC, 0.015);
  const q = new FakeParam(0.5);
  rampTo(q, 0.2, 1, 0);
  assert.deepEqual(q.calls[1], ['setValueAtTime', 0.2, 1]);
  const r = new FakeParam(0.5);
  rampTo(r, 0.2, 1, NaN);
  assert.deepEqual(r.calls[1], ['setValueAtTime', 0.2, 1]);
  const s = new FakeParam(0.5);
  assert.equal(rampTo(s, NaN, 1), false);
  assert.equal(rampTo(s, Infinity, 1), false);
  assert.equal(s.calls.length, 0);
});

test('when: undefined / NaN / negative are treated as 0 ("now")', () => {
  for (const w of [undefined, NaN, -1, null]) {
    const p = new FakeParam(0);
    rampTo(p, 1, w);
    assert.deepEqual(p.calls[0], ['cancelAndHoldAtTime', 0]);
  }
});

test('fallback without cancelAndHoldAtTime: cancelScheduledValues + setValueAtTime(current)', () => {
  const p = new FakeParam(0, { withCancelAndHold: false });
  p.setValueAtTime(0.7, 0);
  p.now = 1;
  p.calls.length = 0;
  rampTo(p, 0, 1, 0.1);
  assert.deepEqual(p.calls, [
    ['cancelScheduledValues', 1],
    ['setValueAtTime', 0.7, 1],
    ['setTargetAtTime', 0, 1, 0.1],
    ['setValueAtTime', 0, 1 + RAMP_SETTLE_TC * 0.1],
  ]);
  assert.ok(near(p.valueAt(1.1), 0.7 * Math.exp(-1)));
  const q = new FakeParam(0.3, { withCancelAndHold: false });
  cancelAndHold(q, 2);
  assert.deepEqual(q.calls, [['cancelScheduledValues', 2], ['setValueAtTime', 0.3, 2]]);
});

test('glideTo: exponential from held value, no jump', () => {
  const p = new FakeParam(220);
  p.setValueAtTime(220, 0);
  assert.equal(glideTo(p, 440, 1, 2), true);
  assert.deepEqual(p.calls.slice(1), [
    ['cancelAndHoldAtTime', 1],
    ['setValueAtTime', 220, 1],
    ['exponentialRampToValueAtTime', 440, 3],
  ]);
  assert.ok(near(p.valueAt(1), 220));
  assert.ok(near(p.valueAt(2), 220 * Math.SQRT2, 1e-6));
  assert.ok(near(p.valueAt(3), 440));
});

test('glideTo interrupting a glide continues from where it was (now = when, or future with {from})', () => {
  const p = new FakeParam(100);
  p.setValueAtTime(100, 0);
  glideTo(p, 400, 0, 2);
  const mid = p.valueAt(1); // 200
  p.now = 1; // real time: param.value is the value at `when`
  glideTo(p, 100, 1, 1);
  assert.ok(near(p.valueAt(1), mid, 1e-6));
  assert.ok(near(p.valueAt(1.5), mid * Math.SQRT1_2, 1e-6));
  assert.ok(near(p.valueAt(2), 100));
  // scheduled ahead (offline): the caller passes the value it tracks
  const q = new FakeParam(100);
  q.setValueAtTime(100, 0);
  glideTo(q, 400, 0, 2);
  glideTo(q, 100, 1, 1, { from: 200 });
  assert.ok(near(q.valueAt(1), 200, 1e-6));
  assert.ok(near(q.valueAt(0.5), 100 * Math.SQRT2, 1e-6), 'first glide untouched before the interrupt');
  assert.ok(near(q.valueAt(2), 100));
});

test('glideTo from 0 lifts the anchor to the floor (no stuck-at-zero ramp)', () => {
  const p = new FakeParam(0);
  glideTo(p, 1, 0, 1);
  assert.deepEqual(p.calls, [
    ['cancelAndHoldAtTime', 0],
    ['setValueAtTime', EXP_FLOOR, 0],
    ['exponentialRampToValueAtTime', 1, 1],
  ]);
  assert.ok(p.valueAt(0.5) > EXP_FLOOR);
  assert.ok(near(p.valueAt(1), 1));
});

test('glideTo to 0 ramps to the floor then sets exact 0', () => {
  const p = new FakeParam(1);
  glideTo(p, 0, 0, 1);
  assert.deepEqual(p.calls.slice(-2), [['exponentialRampToValueAtTime', EXP_FLOOR, 1], ['setValueAtTime', 0, 1]]);
  assert.ok(near(p.valueAt(0.5), Math.sqrt(EXP_FLOOR), 1e-9));
  assert.equal(p.valueAt(1.5), 0);
});

test('glideTo: negative target/current falls back to linear; bad duration → setNow; NaN rejected', () => {
  const p = new FakeParam(-100); // e.g. detune in cents
  glideTo(p, 100, 0, 1);
  assert.equal(p.calls.at(-1)[0], 'linearRampToValueAtTime');
  assert.ok(near(p.valueAt(0.5), 0));
  const q = new FakeParam(5);
  glideTo(q, -5, 0, 1);
  assert.equal(q.calls.at(-1)[0], 'linearRampToValueAtTime');
  const r = new FakeParam(5);
  glideTo(r, 7, 1, 0);
  assert.deepEqual(r.calls, [['cancelAndHoldAtTime', 1], ['setValueAtTime', 7, 1]]);
  const s = new FakeParam(5);
  assert.equal(glideTo(s, NaN, 1, 1), false);
  assert.equal(s.calls.length, 0);
});

test('linearTo', () => {
  const p = new FakeParam(0);
  p.setValueAtTime(0, 0);
  p.linearRampToValueAtTime(1, 2);
  p.now = 1;
  linearTo(p, 0, 1, 1); // interrupt the rising ramp at 0.5
  assert.deepEqual(p.calls.slice(-3), [['cancelAndHoldAtTime', 1], ['setValueAtTime', 0.5, 1], ['linearRampToValueAtTime', 0, 2]]);
  assert.ok(near(p.valueAt(1), 0.5));
  assert.ok(near(p.valueAt(1.5), 0.25));
  assert.equal(p.valueAt(3), 0);
  const q = new FakeParam(0);
  linearTo(q, 1, 1, -1);
  assert.deepEqual(q.calls.at(-1), ['setValueAtTime', 1, 1]);
  assert.equal(linearTo(q, NaN, 1, 1), false);
});

// --- Chromium cancelAndHoldAtTime gaps (CONTRACT_CHANGES engine-instruments / engine-core #2) -----------------
// Each scenario first drives the raw primitives the way the pre-fix helpers did (cancelAndHold + ramp, no anchor)
// to show the fake reproduces the Chromium bug, then runs the fixed helper on a fresh param.
const rawRamp = (p, kind, value, t, dur) => {
  p.cancelAndHoldAtTime(t);
  if (kind === 'linear') p.linearRampToValueAtTime(value, t + dur);
  else p.exponentialRampToValueAtTime(value, t + dur);
};

test('un-anchored ramp on a fresh param starts at time 0 (bug) — glideTo/linearTo anchor at `when`', () => {
  const bug = new FakeParam(1);
  rawRamp(bug, 'exp', 2, 1.5, 0.5);
  assert.ok(bug.valueAt(0.5) > 1.1, `bug: already gliding at 0.5 s (${bug.valueAt(0.5)})`);
  const g = new FakeParam(1);
  glideTo(g, 2, 1.5, 0.5);
  assert.equal(g.valueAt(0.5), 1);
  assert.equal(g.valueAt(1.5), 1);
  assert.ok(near(g.valueAt(1.75), Math.SQRT2));
  assert.ok(near(g.valueAt(2), 2));
  const l = new FakeParam(1);
  linearTo(l, 0.5, 1.5, 0.5);
  assert.equal(l.valueAt(1.4), 1);
  assert.ok(near(l.valueAt(1.75), 0.75));
});

test('un-anchored ramp after an earlier setValueAtTime / completed ramp starts there (bug) — fixed', () => {
  const bug = new FakeParam(0);
  bug.setValueAtTime(1, 0.2);
  rawRamp(bug, 'exp', 2, 1.5, 0.5);
  assert.ok(bug.valueAt(1) > 1.2, 'bug: glide runs from 0.2 s');
  const g = new FakeParam(0);
  setNow(g, 1, 0.2);
  glideTo(g, 2, 1.5, 0.5, { from: 1 });
  assert.equal(g.valueAt(1), 1);
  assert.equal(g.valueAt(1.5), 1);
  assert.ok(near(g.valueAt(1.75), Math.SQRT2));

  const bug2 = new FakeParam(0);
  bug2.setValueAtTime(0, 0);
  bug2.linearRampToValueAtTime(1, 0.5);
  rawRamp(bug2, 'linear', 0, 1.5, 0.5);
  assert.ok(bug2.valueAt(1) < 0.9, 'bug: fall starts at the previous ramp end (0.5 s)');
  const l = new FakeParam(0);
  setNow(l, 0, 0);
  linearTo(l, 1, 0, 0.5, { from: 0 });
  linearTo(l, 0, 1.5, 0.5, { from: 1 });
  assert.ok(near(l.valueAt(0.25), 0.5));
  assert.equal(l.valueAt(1), 1);
  assert.equal(l.valueAt(1.5), 1);
  assert.ok(near(l.valueAt(1.75), 0.5));
  assert.equal(l.valueAt(2.2), 0);
});

test('un-anchored ramp after setTarget drops to 0 at `when` (bug, a click) — fixed', () => {
  const bug = new FakeParam(1);
  bug.cancelAndHoldAtTime(0.2);
  bug.setTargetAtTime(0.5, 0.2, 0.05); // a raw SetTarget (rampTo now pins it, idle-cpu #3: see below)
  rawRamp(bug, 'linear', 1, 1.5, 0.5);
  assert.ok(near(bug.valueAt(1.49), 0.5, 1e-3), 'follows the target until t');
  assert.ok(bug.valueAt(1.51) < 0.05, `bug: drops to 0 at t (${bug.valueAt(1.51)})`);
  const l = new FakeParam(1);
  rampTo(l, 0.5, 0.2, 0.05);
  linearTo(l, 1, 1.5, 0.5, { from: 0.5 });
  assert.ok(near(l.valueAt(1.49), 0.5, 1e-3));
  assert.ok(near(l.valueAt(1.51), 0.51, 1e-3));
  assert.ok(near(l.valueAt(1.75), 0.75, 1e-3));
  // no discontinuity at the anchor
  assert.ok(Math.abs(l.valueAt(1.5 - 1e-6) - l.valueAt(1.5)) < 1e-3);
  // same for glideTo, and in real time (now = when) with no `from` at all
  const g = new FakeParam(1);
  rampTo(g, 0.5, 0.2, 0.05);
  g.now = 1.5;
  glideTo(g, 1, 1.5, 0.5);
  assert.ok(near(g.valueAt(1.5), 0.5, 1e-3));
  assert.ok(near(g.valueAt(1.75), 0.5 * Math.SQRT2, 1e-3));
  // rampTo after rampTo is unaffected by the Chromium gap
  const r = new FakeParam(1);
  rampTo(r, 0.5, 0.2, 0.05);
  rampTo(r, 1, 1.5, 0.1);
  assert.ok(near(r.valueAt(1.5), 0.5, 1e-3));
  assert.ok(r.valueAt(1.51) > 0.5);
});

test('setNow(x, t) then glideTo/linearTo(…, t, {from: x}) does not double-anchor', () => {
  const p = new FakeParam(1); // param.value (1) differs from the anchor on purpose
  setNow(p, 0, 1);
  linearTo(p, 1, 1, 1, { from: 0 });
  assert.equal(p.valueAt(1), 0);
  assert.ok(near(p.valueAt(1.5), 0.5));
  // without {from} the anchor would be param.value read at `now` (1), overriding setNow — documented contract
  const q = new FakeParam(1);
  setNow(q, 0, 1);
  linearTo(q, 1, 1, 1);
  assert.equal(q.valueAt(1), 1);
  // chained segments (equalPowerFade shape) with {from} are continuous
  const c = new FakeParam(0);
  setNow(c, 0, 1);
  linearTo(c, 0.5, 1, 0.5, { from: 0 });
  linearTo(c, 1, 1.5, 0.5, { from: 0.5 });
  assert.ok(near(c.valueAt(1.25), 0.25));
  assert.ok(near(c.valueAt(1.5), 0.5));
  assert.ok(near(c.valueAt(1.75), 0.75));
});

test('{from}: ignored when not finite; negative from → linear fallback; from 0 → exp floor', () => {
  const p = new FakeParam(3);
  linearTo(p, 1, 1, 1, { from: NaN });
  assert.deepEqual(p.calls.at(-2), ['setValueAtTime', 3, 1]);
  const q = new FakeParam(1);
  glideTo(q, 2, 1, 1, { from: -1 });
  assert.deepEqual(q.calls.slice(-2), [['setValueAtTime', -1, 1], ['linearRampToValueAtTime', 2, 2]]);
  const r = new FakeParam(5);
  glideTo(r, 1, 1, 1, { from: 0 });
  assert.deepEqual(r.calls.slice(-2), [['setValueAtTime', EXP_FLOOR, 1], ['exponentialRampToValueAtTime', 1, 2]]);
});

test('setNow clears later events', () => {
  const p = new FakeParam(0);
  p.setValueAtTime(0, 0);
  p.linearRampToValueAtTime(1, 5);
  setNow(p, 0.3, 1);
  assert.equal(p.valueAt(1), 0.3);
  assert.equal(p.valueAt(4), 0.3);
  assert.equal(setNow(p, NaN, 1), false);
});

test('releaseTau / stopAfterRelease', () => {
  assert.equal(releaseTau(6.9), 1);
  assert.equal(releaseTau(3), 3 / 6.9);
  assert.equal(releaseTau(0), 0);
  assert.equal(releaseTau(-1), 0);
  // −60 dB at the release time (within the 6.9 vs ln(1000) approximation)
  assert.ok(Math.abs(20 * Math.log10(Math.exp(-3 / releaseTau(3))) + 60) < 0.1);
  assert.equal(stopAfterRelease(10, 2), 12.6);
  assert.equal(stopAfterRelease(10, -2), 10);
});

test('equalPowerCurve', () => {
  const inC = equalPowerCurve();
  const outC = equalPowerCurve(64, 'out');
  assert.ok(inC instanceof Float32Array);
  assert.equal(inC.length, 64);
  assert.equal(inC[0], 0);
  assert.equal(inC[63], 1);
  assert.equal(outC[0], 1);
  assert.equal(outC[63], 0);
  for (let i = 0; i < 64; i++) {
    assert.ok(Math.abs(inC[i] ** 2 + outC[i] ** 2 - 1) < 1e-6, 'constant power');
    assert.ok(Math.abs(inC[i] - outC[63 - i]) < 1e-6, 'mirror');
    if (i) assert.ok(inC[i] > inC[i - 1], 'monotonic');
  }
  assert.equal(equalPowerCurve(1).length, 2);
  assert.equal(equalPowerCurve(10.7).length, 10);
  assert.equal(equalPowerCurve(NaN).length, 64);
  assert.equal(fadeCurveEqualPower, equalPowerCurve);
  const three = equalPowerCurve(3, 'in');
  assert.ok(Math.abs(three[1] - Math.SQRT1_2) < 1e-6);
});

test('holdAndFade: target 0 with τ = fade/4 from the held value', () => {
  const p = new FakeParam(0.8);
  p.setValueAtTime(0.8, 0);
  holdAndFade(p, 1, 2);
  assert.deepEqual(p.calls.slice(1), [['cancelAndHoldAtTime', 1], ['setTargetAtTime', 0, 1, 0.5], ['setValueAtTime', 0, 1 + RAMP_SETTLE_TC * 0.5]]);
  assert.ok(near(p.valueAt(3), 0.8 * Math.exp(-4)));
  const q = new FakeParam(0.8);
  holdAndFade(q, 1, 0);
  assert.deepEqual(q.calls.at(-1), ['setValueAtTime', 0, 1]);
  const r = new FakeParam(0.8);
  holdAndFade(r, 1, -3);
  assert.deepEqual(r.calls.at(-1), ['setValueAtTime', 0, 1]);
});

test('works on a param-like object with only the required methods', () => {
  const log = [];
  const param = {
    value: 1,
    cancelAndHoldAtTime: (t) => log.push(['hold', t]),
    setTargetAtTime: (v, t, tc) => log.push(['target', v, t, tc]),
    setValueAtTime: (v, t) => log.push(['set', v, t]),
  };
  rampTo(param, 0, 5, 0.2);
  assert.deepEqual(log, [['hold', 5], ['target', 0, 5, 0.2], ['set', 0, 5 + RAMP_SETTLE_TC * 0.2]]);
});

test('rampTo pins its target after RAMP_SETTLE_TC time constants (idle-cpu #3: SetTarget never ends in Chromium)', () => {
  assert.equal(RAMP_SETTLE_TC, 12);
  const p = new FakeParam(1);
  rampTo(p, 0, 1, 0.1);
  const pin = 1 + RAMP_SETTLE_TC * 0.1;
  // the step at the pin is e^-12 of the move (inaudible), and the value is exact afterwards
  assert.ok(Math.abs(p.valueAt(pin - 1e-9) - p.valueAt(pin)) < 1e-5);
  assert.equal(p.valueAt(pin + 0.5), 0);
  // a later rampTo before the pin cancels it (cancel-and-hold) and pins its own target
  const q = new FakeParam(1);
  rampTo(q, 0, 1, 0.1);
  rampTo(q, 0.5, 1.5, 0.05);
  assert.ok(q.valueAt(1.5 + 0.3) > 0.49 && q.valueAt(2.2) === 0.5, `${q.valueAt(2.2)}`);
  assert.ok(!q.events.some((e) => e.type === 'set' && e.value === 0), 'the first pin was cancelled');
  // after the pin, a raw un-anchored ramp starts from the pinned value (no Chromium drop to 0 after a SetTarget)
  const r = new FakeParam(1);
  rampTo(r, 0.5, 0.2, 0.05);
  rawRamp(r, 'linear', 1, 1.5, 0.5);
  assert.ok(r.valueAt(1.51) > 0.5);
});
