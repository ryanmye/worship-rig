// shared/eq-math.js: axis, RBJ filters (Web Audio conventions), the variable-band model (AMENDMENT.md §4), writes,
// A/B writes, parsers, paste import, Copy as text, presets. Pure node:test, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../../app/js/shared/eq-math.js';
import { describe as describeParam } from '../../../app/js/shared/params.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b} (±${eps})`);
const toMap = (w) => Object.fromEntries(w);

test('axis: A0 and C8 sit on the key-zone grid, uOfF/fOfU round-trip, sub/air compressed', () => {
  near(M.uOfF(27.5), M.SUB_U + 0.5, 1e-9, 'A0');
  near(M.uOfF(M.midiF(108)), M.SUB_U + 87.5, 1e-9, 'C8');
  for (const f of [20, 23, 27.5, 100, 440, 4186, 8000, 19999]) near(M.fOfU(M.uOfF(f)), f, f * 1e-9, `rt ${f}`);
  near(M.uOfF(20), 0, 1e-9, '20 Hz = 0');
  near(M.uOfF(20000), M.TOTAL_U, 1e-9, '20 kHz = total');
  assert.ok(M.SUB_U < 3 && M.AIR_U < 25, 'sub/air are compressed');
  const keys = M.keyRects();
  assert.equal(keys.length, 88);
  assert.equal(keys.filter((k) => k.black).length, 36);
  assert.equal(M.noteName(60), 'C4');
  assert.equal(M.noteName(66), 'F#4');
});

test('RBJ: peaking/notch/shelves/cuts behave as Web Audio documents', () => {
  const fs = 48000;
  const pk = M.rbjCoeffs({ type: 'peaking', f: 1000, g: 6, q: 1.4 }, fs);
  near(M.magDb(pk, 1000, fs), 6, 1e-9, 'peak centre');
  near(M.magDb(pk, 20, fs), 0, 0.05, 'peak far away');
  const no = M.rbjCoeffs({ type: 'notch', f: 60, q: 10 }, fs);
  assert.ok(M.magDb(no, 60, fs) < -100, 'notch centre is deep');
  near(M.magDb(no, 1000, fs), 0, 0.01, 'notch leaves 1 kHz');
  const hp = M.rbjCoeffs({ type: 'highpass', f: 100, q: M.BUTTER2_Q_DB }, fs);
  near(M.magDb(hp, 100, fs), -3.01, 0.01, 'Butterworth HP −3 dB at fc');
  assert.ok(M.magDb(hp, 25, fs) < -23, 'HP 12 dB/oct');
  const lp = M.rbjCoeffs({ type: 'lowpass', f: 8000, q: M.BUTTER2_Q_DB }, fs);
  near(M.magDb(lp, 8000, fs), -3.01, 0.01, 'LP −3 dB at fc');
  const ls = M.rbjCoeffs({ type: 'lowshelf', f: 120, g: 6 }, fs);
  near(M.magDb(ls, 20, fs), 6, 0.3, 'low shelf plateau');
  near(M.magDb(ls, 120, fs), 3, 0.01, 'low shelf half gain at f');
  near(M.magDb(ls, 10000, fs), 0, 0.01, 'low shelf top');
  const hs = M.rbjCoeffs({ type: 'highshelf', f: 6000, g: -4 }, fs);
  near(M.magDb(hs, 6000, fs), -2, 0.01, 'high shelf half gain');
  near(M.magDb(hs, 50, fs), 0, 0.01, 'high shelf bottom');
  // 20 Hz Butterworth is −1.07 dB at A0 (DECISION §3: why cutHz 20 must be a bypass, not a filter)
  near(M.magDb(M.rbjCoeffs({ type: 'highpass', f: 20, q: M.BUTTER2_Q_DB }, fs), 27.5, fs), -1.07, 0.02, '20 Hz HP @A0');
});

test('Q ↔ bandwidth: analog inverse, digital relation matches DECISION §5 numbers', () => {
  for (const q of [0.3, 0.71, 1, 1.4, 4, 10]) near(M.qOfBw(M.bwOfQ(q)), q, 1e-9, 'analog');
  near(M.bwOfQ(1.41), 1, 0.01, '1 oct ≈ Q 1.41');
  near(M.bwOfQ(1.4, 880, 48000), 1.01, 0.01, 'digital @880');
  near(M.bwOfQ(1.4, 10000, 48000), 0.74, 0.02, 'digital @10k');
  near(M.qOfBw(M.bwOfQ(2, 5000, 48000), 5000, 48000), 2, 1e-9, 'digital inverse');
});

test('bandFilter: identity for off / 0 dB; cuts take the linear Q in dB; notch ignores gain', () => {
  assert.equal(M.bandFilter({ on: false, type: 'peak', hz: 1000, db: 6, q: 1 }), null);
  assert.equal(M.bandFilter({ on: true, type: 'peak', hz: 1000, db: 0, q: 1 }), null);
  assert.equal(M.bandFilter({ on: true, type: 'off', hz: 1000, db: 6, q: 1 }), null);
  const lc = M.bandFilter({ on: true, type: 'lowcut', hz: 80, db: 0, q: Math.SQRT1_2 });
  assert.equal(lc.type, 'highpass');
  near(lc.q, M.BUTTER2_Q_DB, 1e-9, 'Q 0.71 → Butterworth dB');
  const n = M.bandFilter({ on: true, type: 'notch', hz: 60, db: 5, q: 8 });
  assert.equal(n.type, 'notch');
  assert.equal(n.g, 0);
});

test('readEq: legacy low/high show as b1/b8; b-rows (nested or flat) win; type off = removed', () => {
  const a = M.readEq(undefined);
  assert.deepEqual(a.bands.map((b) => [b.k, b.type, b.hz, b.db, b.legacy]),
    [[1, 'lowshelf', 120, 0, true], [8, 'highshelf', 6000, 0, true]]);
  assert.equal(a.cutHz, 20);
  assert.equal(a.hiCutHz, 20000);
  assert.equal(M.readEq({ low: 3, high: -2 }).bands[0].db, 3);
  assert.equal(M.readEq({ low: 3, high: -2 }).bands[1].db, -2);
  const nested = M.readEq({ low: 5, b1: { on: true, type: 'peak', hz: 300, db: -2, q: 2 }, b3: { on: false, type: 'notch', hz: 60 } });
  assert.deepEqual(nested.bands.map((b) => [b.k, b.type, b.on, b.legacy]),
    [[1, 'peak', true, false], [3, 'notch', false, false], [8, 'highshelf', true, true]]);
  const flat = M.readEq({ 'b2.on': true, 'b2.type': 'peak', 'b2.hz': 500, 'b2.db': 4, 'b2.q': 1 });
  assert.deepEqual(flat.bands.find((b) => b.k === 2), { k: 2, on: true, type: 'peak', hz: 500, db: 4, q: 1, legacy: false });
  const removed = M.readEq({ b1: { on: false, type: 'off' }, b8: { on: false, type: 'off' } });
  assert.equal(removed.bands.length, 0);
  assert.equal(M.freeBand(removed), 1);
  assert.equal(M.freeBand(M.readEq({})), 2);
  // clamped to the AMENDMENT ranges (or the PARAMS rows)
  const c = M.readEq({ b2: { on: true, type: 'peak', hz: 5, db: 40, q: 100 } }).bands.find((b) => b.k === 2);
  assert.equal(c.hz, M.eqRow('b2.hz').min);
  assert.equal(c.db, M.eqRow('b2.db').max);
  assert.equal(c.q, M.eqRow('b2.q').max);
});

test('readEq: DECISION rows (lowHz, mid1*, mid2*, highHz) read as b1/b2/b3/b8 like the engine', () => {
  const m = M.readEq({ lowHz: 90, low: 2, mid1: -3, mid1Hz: 300, mid1Q: 2, highHz: 8000 });
  assert.deepEqual(m.bands.map((b) => [b.k, b.type, Math.round(b.hz), b.db, b.legacy]),
    [[1, 'lowshelf', 90, 2, true], [2, 'peak', 300, -3, true], [8, 'highshelf', 8000, 0, true]]);
  assert.equal(m.bands[1].q, 2);
  const w = toMap(M.writesFor({ mid1: -3, mid1Hz: 300 }, { bands: M.readEq({ mid1: -3, mid1Hz: 300 }).bands.map((b) =>
    (b.k === 2 ? { ...b, db: -4 } : b)) }));
  assert.deepEqual([w['b2.type'], w['b2.hz'], w['b2.db']], ['peak', 300, -4]);
  assert.equal(w.mid1, 0, 'legacy bell gain zeroed');
  assert.equal(w['b1.type'], 'lowshelf', 'b1 migrated alongside');
  assert.deepEqual(toMap(M.bypassWrites({ mid2: 3 }).off), { mid2: 0 });
});

test('writesFor: first edit migrates both legacy shelves and zeroes eq.low/high; later edits are minimal', () => {
  const eq = { low: 3 };
  const m = M.readEq(eq);
  const add = { k: 2, on: true, type: 'peak', hz: 440, db: 0, q: 1 };
  const w = toMap(M.writesFor(eq, { bands: [...m.bands, add] }));
  assert.deepEqual([w['b2.on'], w['b2.type'], w['b2.hz'], w['b2.db'], w['b2.q']], [true, 'peak', 440, 0, 1]);
  assert.deepEqual([w['b1.type'], w['b1.hz'], w['b1.db']], ['lowshelf', 120, 3], 'b1 migrated with eq.low');
  assert.deepEqual([w['b8.type'], w['b8.hz'], w['b8.db']], ['highshelf', 6000, 0], 'b8 migrated');
  assert.equal(w.low, 0, 'eq.low zeroed');
  assert.equal(w.high, undefined, 'eq.high absent → untouched');
  // after migration: moving b2 writes only b2.hz
  const stored = { low: 0, b1: { on: true, type: 'lowshelf', hz: 120, db: 3, q: Math.SQRT1_2 },
    b2: { on: true, type: 'peak', hz: 440, db: 0, q: 1 }, b8: { on: true, type: 'highshelf', hz: 6000, db: 0, q: Math.SQRT1_2 } };
  const m2 = M.readEq(stored);
  const moved = m2.bands.map((b) => (b.k === 2 ? { ...b, hz: 880 } : b));
  assert.deepEqual(M.writesFor(stored, { bands: moved }), [['b2.hz', 880]]);
  // removing b2 → on:false + type:'off'
  assert.deepEqual(M.writesFor(stored, { bands: m2.bands.filter((b) => b.k !== 2) }), [['b2.on', false], ['b2.type', 'off']]);
  // no change → no writes; cuts
  assert.deepEqual(M.writesFor(stored, { bands: m2.bands }), []);
  assert.deepEqual(M.writesFor(stored, { bands: m2.bands, cutHz: 80, hiCutHz: 20000 }), [['cutHz', 80]]);
  // removing a legacy band migrates the other and writes the removal
  const r = toMap(M.writesFor({}, { bands: M.readEq({}).bands.filter((b) => b.k !== 1) }));
  assert.equal(r['b1.type'], 'off');
  assert.equal(r['b8.type'], 'highshelf');
});

test('shelfWrites: Brightness/Warmth move the shelves before and after migration, re-add a removed one', () => {
  assert.deepEqual(toMap(M.shelfWrites({}, 'high', 3))['b8.db'], 3, 'legacy: migrates and sets b8');
  const stored = { b1: { on: true, type: 'lowshelf', hz: 120, db: 0, q: 0.71 }, b8: { on: false, type: 'highshelf', hz: 7000, db: 0, q: 0.71 } };
  assert.deepEqual(M.shelfWrites(stored, 'high', -2), [['b8.on', true], ['b8.db', -2]]);
  assert.deepEqual(M.shelfWrites(stored, 'low', 4), [['b1.db', 4]]);
  const noHigh = { b1: stored.b1, b8: { on: false, type: 'off' } };
  const w = toMap(M.shelfWrites(noHigh, 'high', 2));
  assert.deepEqual([w['b8.type'], w['b8.hz'], w['b8.db'], w['b8.on']], ['highshelf', 6000, 2, true]);
});

test('bypassWrites: switches audible bands off and opens cuts; restore puts them back', () => {
  const stored = { high: 2, b1: { on: true, type: 'peak', hz: 300, db: -3, q: 1 }, b2: { on: false, type: 'peak', hz: 900, db: 2, q: 1 },
    cutHz: 80, hiCutHz: 12000 };
  const { off, restore } = M.bypassWrites(stored);
  assert.deepEqual(toMap(off), { 'b1.on': false, high: 0, cutHz: 20, hiCutHz: 20000 });
  assert.deepEqual(toMap(restore), { 'b1.on': true, high: 2, cutHz: 80, hiCutHz: 12000 });
  assert.deepEqual(M.bypassWrites({}), { off: [], restore: [] });
});

test('eqResponseDb sums bands and cuts; summary counts active bands', () => {
  const m = M.readEq({ b1: { on: true, type: 'peak', hz: 1000, db: 6, q: 1 }, b2: { on: true, type: 'peak', hz: 1000, db: -2, q: 1 },
    b8: { on: false, type: 'off' }, cutHz: 100 });
  const r = M.eqResponseDb(m, [1000, 100]);
  near(r[0], 4, 0.01, 'sum at 1 kHz');
  assert.ok(r[1] < -2.9 && r[1] > -3.2, `HP −3 dB at cut, got ${r[1]}`);
  assert.equal(M.eqSummary({}), 'Flat');
  assert.equal(M.eqSummary({ low: 2 }), 'Custom · 1 band');
  assert.equal(M.eqSummary({ low: 2, cutHz: 60, hiCutHz: 12000 }), 'Custom · 3 bands');
});

test('zones: Keys split C3–C8, band reach and Acts on text', () => {
  const z = M.soundingRange({ lowNote: 48, highNote: 127, octave: 0, transpose: 0 });
  assert.deepEqual([z.lo, z.hi, z.why.lo, z.why.hi], [48, 108, 'split', 'keyboard']);
  near(z.fLo, M.midiF(47.5), 1e-9);
  const bass = M.soundingRange({ lowNote: 0, highNote: 59, octave: -1 }, { songTranspose: 2 });
  assert.deepEqual([bass.lo, bass.hi, bass.shift], [21 - 12 + 2, 59 - 12 + 2, -10]);
  const b = { on: true, type: 'peak', hz: M.midiF(69), db: 6, q: 2 };
  const a = M.actsOn(b, z);
  assert.equal(a.kind, 'ok');
  assert.equal(a.pill, 'Boost');
  assert.match(a.text, /^notes [A-G]/);
  assert.equal(M.actsOn({ ...b, hz: 60 }, z).kind, 'none');
  assert.equal(M.actsOn({ ...b, hz: 12000 }, z).kind, 'over');
  assert.equal(M.actsOn({ ...b, on: false }, z).pill, 'Off');
  assert.equal(M.actsOn({ ...b, db: 0 }, z).kind, 'flat');
  assert.equal(M.actsOn({ on: true, type: 'notch', hz: 440, db: 0, q: 10 }, z).pill, 'Notch');
});

test('parsers: Hz, notes, dB, Q/oct; snapping', () => {
  near(M.parseFreq('250'), 250, 0);
  near(M.parseFreq('1.2k'), 1200, 1e-9);
  near(M.parseFreq('1k2'), 1200, 1e-9);
  near(M.parseFreq('3.5 kHz'), 3500, 1e-9);
  near(M.parseFreq('A3'), 220, 1e-9);
  near(M.parseFreq('F#2'), M.midiF(42), 1e-9);
  near(M.parseFreq('≈B3 +21¢ · 250 Hz'), M.midiF(59), 1e-9);
  assert.equal(M.parseFreq('abc'), null);
  assert.equal(M.parseDb('−2.5 dB'), -2.5);
  assert.equal(M.parseDb('+3'), 3);
  assert.equal(M.parseDb('x'), null);
  near(M.parseQ('1 oct'), M.qOfBw(1), 1e-12);
  assert.equal(M.parseQ('1.4'), 1.4);
  near(M.snapF(250), M.midiF(59), 1e-9, 'snap to B3');
  assert.equal(M.snapF(11000), 10000, 'air snaps to ISO thirds');
  assert.equal(M.snapF(250, true), 250);
});

test('paste: the EqualizerAPO line from the brief sets one band exactly', () => {
  const r = M.parseForeign('Filter 1: ON PK Fc 1000 Hz Gain -3 dB Q 1.4');
  assert.deepEqual(r.bands, [{ k: 1, on: true, type: 'peak', hz: 1000, db: -3, q: 1.4 }]);
  assert.equal(r.lines[0].status, 'applied');
  assert.equal(r.cutHz, 20);
});

test('paste: REW/EAPO block → shelves at b1/b8, bells ascending, cuts, notch, skips', () => {
  const txt = [
    'Preamp: -4 dB',
    'Filter 1: ON HSC Fc 8000 Hz Gain 2 dB Q 0.71',
    'Filter 2: ON PK Fc 250 Hz Gain -3 dB Q 1.4',
    'Filter 3: ON LSC Fc 100 Hz Gain 1.5 dB',
    'Filter 4: ON HP Fc 60 Hz',
    'Filter 5: ON NO Fc 60 Hz Q 12',
    'Filter 6: OFF PK Fc 3000 Hz Gain 2 dB Q 1',
    'Filter 7: ON LP Fc 14000 Hz',
    'Filter 8: ON BP Fc 1000 Hz',
    'Filter 9: ON PK 2 kHz +1 dB 1 oct',
    'Filter 10: ON LS 6dB Fc 100 Hz Gain 3 dB',
  ].join('\n');
  const r = M.parseForeign(txt);
  const byK = Object.fromEntries(r.bands.map((b) => [b.k, b]));
  assert.equal(byK[1].type, 'lowshelf');
  assert.equal(byK[8].type, 'highshelf');
  assert.deepEqual([byK[2].type, byK[2].hz], ['notch', 60]);
  assert.deepEqual([byK[3].type, byK[3].hz, byK[3].db], ['peak', 250, -3]);
  assert.deepEqual([byK[4].type, byK[4].hz], ['peak', 2000]);
  near(byK[4].q, M.qOfBw(1, 2000, 48000), 1e-9, '1 oct → digital Q');
  assert.deepEqual([byK[5].hz, byK[5].on], [3000, false]);
  assert.equal(r.cutHz, 60);
  assert.equal(r.hiCutHz, 14000);
  const skipped = r.lines.filter((l) => l.status === 'skipped').map((l) => l.raw.split(':')[0]);
  assert.deepEqual(skipped, ['Preamp', 'Filter 8', 'Filter 10']);
  assert.equal(r.lines[0].raw, 'Preamp: -4 dB', 'report keeps input order');
});

test('paste: more than 8 bands → the 9th is skipped, not approximated', () => {
  const txt = Array.from({ length: 9 }, (_, i) => `PK ${100 * (i + 1)} Hz -1 dB Q 1`).join('\n');
  const r = M.parseForeign(txt);
  assert.equal(r.bands.length, 8);
  assert.equal(r.lines.filter((l) => l.status === 'skipped').length, 1);
});

test('Copy as text ↔ paste round-trips every band type and both cuts', () => {
  const stored = { b1: { on: true, type: 'lowshelf', hz: 110, db: 2, q: Math.SQRT1_2 }, b2: { on: true, type: 'peak', hz: 250, db: -3, q: 1.4 },
    b3: { on: false, type: 'peak', hz: 900, db: 2, q: 0.8 }, b4: { on: true, type: 'notch', hz: 60, db: 0, q: 10 },
    b5: { on: true, type: 'lowcut', hz: 40, db: 0, q: 0.71 }, b6: { on: true, type: 'highcut', hz: 15000, db: 0, q: 0.71 },
    b8: { on: true, type: 'highshelf', hz: 6000, db: -1, q: Math.SQRT1_2 }, cutHz: 70, hiCutHz: 16000 };
  const txt = M.formatEqText(M.readEq(stored), 'Keys · Grand Piano');
  assert.match(txt, /^# Worship Rig EQ · Keys/);
  assert.match(txt, /Filter 2: ON PK Fc 250\.0 Hz Gain -3\.0 dB Q 1\.40/);
  const back = M.parseForeign(txt);
  const want = M.readEq(stored);
  assert.equal(back.cutHz, 70);
  assert.equal(back.hiCutHz, 16000);
  const key = (b) => `${b.type}@${Math.round(b.hz)}`;
  assert.deepEqual(back.bands.map(key).sort(), want.bands.map(key).sort());
  for (const b of back.bands) {
    const w = want.bands.find((x) => key(x) === key(b));
    assert.equal(b.on, w.on);
    near(b.db, w.db, 0.05, `${key(b)} db`);
    if (M.hasQ(b.type)) near(b.q, w.q, 0.01, `${key(b)} q`);
  }
});

test('presets: Warm values; Wing channel = L shelf, 4 PEQs, H shelf at 0 dB; all replace + cuts off', () => {
  const w = M.EQ_PRESETS.Warm;
  assert.deepEqual(w.bands.map((b) => [b.k, b.type, Math.round(b.hz), b.db]),
    [[1, 'lowshelf', 147, 3], [2, 'peak', 3000, -3], [8, 'highshelf', 8000, -2]]);
  const wing = M.EQ_PRESETS['Wing channel'];
  assert.deepEqual(wing.bands.map((b) => b.type), ['lowshelf', 'peak', 'peak', 'peak', 'peak', 'highshelf']);
  // nodes stay apart on the axis (the air zone is compressed): ≥ 5 axis units between neighbours
  const us = wing.bands.map((b) => M.uOfF(b.hz));
  for (let i = 1; i < us.length; i++) assert.ok(us[i] - us[i - 1] >= 5, `Wing nodes ${i - 1}/${i} too close`);
  assert.ok(wing.bands.every((b) => b.db === 0));
  for (const name of ['Flat', 'Warm', 'Air', 'Cut mud', 'Wing channel']) {
    const p = M.EQ_PRESETS[name];
    assert.equal(p.cutHz, 20);
    assert.equal(p.hiCutHz, 20000);
  }
  // applying Warm to a legacy slot: b1/b2/b8 written, others untouched, low/high zeroed when set
  const wr = toMap(M.writesFor({ low: 4 }, M.EQ_PRESETS.Warm));
  assert.equal(wr['b1.db'], 3);
  assert.equal(wr['b2.hz'], 3000);
  assert.equal(wr['b8.hz'], 8000);
  assert.equal(wr.low, 0);
  assert.equal(wr['b3.on'], undefined);
});

test('PARAMS agreement: when the b-rows exist they carry AMENDMENT §4 ranges', (t) => {
  if (!describeParam('slots.0.eq.b1.hz')) {
    t.skip('PARAMS has no slots.<i>.eq.b<k>.* rows yet (eq-engine adds them); eq-math uses AMENDMENT fallbacks');
    return;
  }
  const hz = M.eqRow('b3.hz');
  const db = M.eqRow('b3.db');
  const q = M.eqRow('b3.q');
  assert.ok(hz.fromParams);
  assert.deepEqual([hz.min, hz.max], [20, 20000]);
  assert.deepEqual([db.min, db.max], [-15, 15]);
  assert.deepEqual([q.min, q.max], [0.1, 10]);
  const type = describeParam('slots.0.eq.b3.type');
  for (const t of M.BAND_TYPES) assert.ok(type.enum.includes(t), `type enum has ${t}`);
});
