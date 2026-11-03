// shared/click-math.js (v11-metronome): meters, the click grid across tempo / meter changes, count-in bar math, MIDI
// clock pulse math, settings.click normalisation and the audio→performance clock map. Pure node:test, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../../app/js/shared/click-math.js';
import { clockJitter } from '../../../app/js/midi-clock.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b} (±${eps})`);

test('meterOf: simple and compound meters; unknown = 4/4', () => {
  assert.deepEqual(M.meterOf('4/4'), { sig: '4/4', beats: 4, sub: 1, ppb: 24 });
  assert.deepEqual(M.meterOf('3/4'), { sig: '3/4', beats: 3, sub: 1, ppb: 24 });
  assert.deepEqual(M.meterOf('6/8'), { sig: '6/8', beats: 2, sub: 3, ppb: 36 }); // BPM = the dotted quarter
  assert.deepEqual(M.meterOf('12/8'), { sig: '12/8', beats: 4, sub: 3, ppb: 36 });
  for (const bad of [undefined, null, '7/4', 44, '']) assert.equal(M.meterOf(bad).sig, '4/4');
  assert.equal(M.validTimeSig('5/4'), '5/4');
  assert.equal(M.validTimeSig('9/8'), undefined);
});

test('ClickGrid: ticks land on t0 + k·60/bpm, accent on beat 1 of every bar', () => {
  const g = new M.ClickGrid({ t0: 1, bpm: 120, sig: '4/4' });
  const ticks = g.ticks(0, 5); // [1, 5): beats 0..7
  assert.equal(ticks.length, 8);
  ticks.forEach((k, i) => near(k.t, 1 + i * 0.5, 1e-12, `tick ${i}`));
  assert.deepEqual(ticks.map((k) => k.kind), ['accent', 'beat', 'beat', 'beat', 'accent', 'beat', 'beat', 'beat']);
  assert.ok(ticks.every((k) => !k.countIn));
  // contiguous windows give every tick exactly once (the engine pumps [horizon, now + lookahead))
  const parts = [];
  for (let t = 0; t < 5; t += 0.05) parts.push(...g.ticks(t, Math.min(5, t + 0.05)));
  assert.deepEqual(parts.map((k) => k.t), ticks.map((k) => k.t));
});

test('ClickGrid: 6/8 = two dotted-quarter beats of three eighths (accent, sub, sub, beat, sub, sub)', () => {
  const g = new M.ClickGrid({ t0: 0, bpm: 60, sig: '6/8' });
  const ticks = g.ticks(0, 2); // one bar = 2 s
  assert.equal(ticks.length, 6);
  assert.deepEqual(ticks.map((k) => k.kind), ['accent', 'sub', 'sub', 'beat', 'sub', 'sub']);
  ticks.forEach((k, i) => near(k.t, i / 3, 1e-12));
});

test('ClickGrid.retime: a tempo change starts on the first beat at/after the horizon; bar phase kept', () => {
  const g = new M.ClickGrid({ t0: 0, bpm: 120, sig: '4/4' });
  // horizon 1.2 s (beat 2.4) → the change lands on beat 3 at 1.5 s
  const r = g.retime(1.2, { bpm: 60 });
  assert.deepEqual(r, { beat: 3, t: 1.5 });
  const ticks = g.ticks(0, 6);
  near(ticks[2].t, 1.0, 1e-12);
  near(ticks[3].t, 1.5, 1e-12); // beat 3 still at the old grid time
  near(ticks[4].t, 2.5, 1e-12); // then 1 s per beat
  near(ticks[5].t, 3.5, 1e-12);
  assert.equal(ticks[4].kind, 'accent'); // beat 4 = bar 2, beat 1 (phase kept)
  assert.equal(ticks[3].kind, 'beat');
  // nothing scheduled before the horizon moved
  assert.deepEqual(g.ticks(0, 1.2).map((k) => k.t), [0, 0.5, 1]);
  near(g.beatTime(5), 3.5, 1e-12);
  near(g.beatAt(3), 4.5, 1e-12);
  assert.equal(g.bpm, 60);
});

test('ClickGrid.retime: exactly on a beat, it lands there; a new song starts a new bar (accent)', () => {
  const g = new M.ClickGrid({ t0: 0, bpm: 120, sig: '4/4' });
  assert.deepEqual(g.retime(1.0, { bpm: 90, newBar: true }), { beat: 2, t: 1 }); // beat 2 is at the horizon itself
  const ticks = g.ticks(0, 4);
  assert.equal(ticks[2].kind, 'accent');
  near(ticks[3].t, 1 + 60 / 90, 1e-12);
  assert.deepEqual(ticks.slice(2, 7).map((k) => k.kind), ['accent', 'beat', 'beat', 'beat', 'accent']);
});

test('ClickGrid.retime: a song switch (tempo, then time signature) merges into one change on the same beat', () => {
  const g = new M.ClickGrid({ t0: 0, bpm: 120, sig: '4/4' });
  g.retime(0.7, { bpm: 80 });
  g.retime(0.7, { sig: '3/4', newBar: true });
  assert.equal(g.segs.length, 2);
  assert.equal(g.segs[1].beat0, 2);
  assert.equal(g.segs[1].spb, 60 / 80);
  assert.equal(g.segs[1].meter.sig, '3/4');
  // and in the other order the new bar survives the tempo-only change
  const h = new M.ClickGrid({ t0: 0, bpm: 120, sig: '4/4' });
  h.retime(0.7, { sig: '3/4', newBar: true });
  h.retime(0.7, { bpm: 80 });
  assert.equal(h.segs.length, 2);
  assert.equal(h.segs[1].bar0, 2);
  assert.equal(h.segs[1].meter.sig, '3/4');
  const kinds = h.ticks(0, 5).map((k) => k.kind);
  assert.deepEqual(kinds.slice(0, 8), ['accent', 'beat', 'accent', 'beat', 'beat', 'accent', 'beat', 'beat']);
});

test('ClickGrid: count-in bar math (1 and 2 bars, 4/4, 3/4, 6/8), downbeat time and the countIn flag', () => {
  const cases = [['4/4', 1, 120, 4], ['4/4', 2, 100, 8], ['3/4', 2, 90, 6], ['6/8', 1, 60, 2]];
  for (const [sig, bars, bpm, beats] of cases) {
    const g = new M.ClickGrid({ t0: 0.5, bpm, sig, countIn: bars });
    assert.equal(g.downbeat, beats, `${sig} × ${bars}`);
    near(g.downbeatTime, 0.5 + (beats * 60) / bpm, 1e-12, `${sig} downbeat`);
    const ticks = g.ticks(0, g.downbeatTime + 0.01);
    const sub = M.meterOf(sig).sub;
    assert.equal(ticks.filter((k) => k.countIn).length, beats * sub);
    assert.equal(ticks.at(-1).countIn, false);
    assert.equal(ticks.at(-1).kind, 'accent'); // the song starts on a bar line
  }
  // count-in 0 / invalid = none
  assert.equal(new M.ClickGrid({ t0: 0, bpm: 120, countIn: 0 }).downbeat, 0);
  assert.equal(new M.ClickGrid({ t0: 0, bpm: 120, countIn: 5 }).downbeat, 0);
});

test('ClickGrid: a new song during the count-in counts in afresh at the new tempo; after it, it does not', () => {
  const g = new M.ClickGrid({ t0: 0, bpm: 120, sig: '4/4', countIn: 1 });
  const r = g.retime(0.6, { bpm: 60, sig: '3/4', newBar: true }); // beat 2 (1.0 s)
  assert.equal(r.beat, 2);
  assert.equal(g.downbeat, 2 + 3);
  near(g.downbeatTime, 1 + 3, 1e-12);
  const h = new M.ClickGrid({ t0: 0, bpm: 120, sig: '4/4', countIn: 1 });
  h.retime(2.6, { bpm: 60, newBar: true }); // past the downbeat (2.0 s)
  assert.equal(h.downbeat, 4);
});

test('ClickGrid.pulses: 24 per quarter (36 per dotted quarter), continuous across a tempo change', () => {
  const g = new M.ClickGrid({ t0: 0, bpm: 120, sig: '4/4' });
  const p = g.pulses(0, 1); // two beats
  assert.equal(p.length, 48);
  p.forEach((t, i) => near(t, (i * 0.5) / 24, 1e-12));
  g.retime(1.0, { bpm: 60 });
  const q = g.pulses(1, 2); // one beat at 60
  assert.equal(q.length, 24);
  near(q[0], 1, 1e-12);
  near(q[1] - q[0], 1 / 24, 1e-12);
  const c = new M.ClickGrid({ t0: 0, bpm: 60, sig: '6/8' });
  assert.equal(c.pulses(0, 1).length, 36);
  // contiguous windows: every pulse once
  const g2 = new M.ClickGrid({ t0: 0.013, bpm: 97, sig: '4/4' });
  const all = g2.pulses(0, 3);
  const parts = [];
  for (let t = 0; t < 3; t += 0.05) parts.push(...g2.pulses(t, Math.min(3, t + 0.05)));
  assert.equal(parts.length, all.length);
  parts.forEach((t, i) => assert.equal(t, all[i]));
});

test('normalizeClick / clickSettingsOf: clamps, drops bad fields, keeps unknown ones, defaults fill in', () => {
  assert.equal(M.normalizeClick(null), null);
  assert.equal(M.normalizeClick([1]), null);
  assert.deepEqual(M.normalizeClick({ level: 3, countIn: 2, after: 'quiet', record: true, output: 'aux', x: 1 }),
    { level: 1, countIn: 2, after: 'quiet', record: true, output: 'aux', x: 1 });
  assert.deepEqual(M.normalizeClick({ level: 'loud', countIn: 3, after: 'x', record: 'yes', output: 'ch5' }), {});
  assert.deepEqual(M.normalizeClick({ record: false }), {}); // default off = absent
  assert.deepEqual(M.clickSettingsOf({}), { level: 0.6, countIn: 0, after: 'click', record: false, output: 'main' });
  assert.deepEqual(M.clickSettingsOf({ click: { countIn: 1, level: -1 } }),
    { level: 0, countIn: 1, after: 'click', record: false, output: 'main' });
});

test('ClockMap: maps audio time to performance.now(); smooths quantum noise, re-anchors on a jump', () => {
  const m = new M.ClockMap({ alpha: 0.05, resetMs: 15 });
  m.observe(10, 5000); // offset −5000 → 10 s heard at 5000 ms
  near(m.toPerf(10.5), 5500, 1e-9);
  // ±1.45 ms (≈ a 128-frame quantum at 44.1 kHz) of anchor noise moves the map by ≤ alpha × noise
  let maxMove = 0;
  for (let i = 0; i < 200; i++) {
    const noise = (i % 2 ? 1 : -1) * 1.45;
    m.observe(10 + i * 0.05, 5000 + i * 50 + noise);
    maxMove = Math.max(maxMove, Math.abs(m.toPerf(20) - 15000));
  }
  assert.ok(maxMove < 0.2, `smoothed move ${maxMove}`);
  assert.equal(m.resets, 1);
  m.observe(30, 25000 + 40); // a 40 ms jump (device change): re-anchor at once
  near(m.toPerf(30), 25040, 1e-9);
  assert.equal(m.resets, 2);
});

test('clockJitter: deviation of pulse gaps from the median gap', () => {
  assert.equal(clockJitter([1, 2]), null);
  const even = Array.from({ length: 50 }, (_, i) => 1000 + i * 20.833);
  const j = clockJitter(even);
  assert.ok(j.maxDevMs < 1e-6);
  near(j.meanMs, 20.833, 1e-6);
  const bumped = even.slice();
  bumped[10] += 0.5;
  assert.ok(Math.abs(clockJitter(bumped).maxDevMs - 0.5) < 1e-6);
});
