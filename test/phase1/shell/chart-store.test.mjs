// Chart view (D7, hidden): song.chart storage. Optional (absent until set), written whole, normalised, size-capped,
// migrate stays idempotent, it travels with library / song export and import, and settings.chartView is a device-local
// boolean that is absent when off. CONTRACT_CHANGES "Chart view (D7, hidden)".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  migrate, normalizeChart, chartError, CHART_MAX_CHARS, LIBRARY_MAX_CHARS, SCHEMA, DEVICE_LOCAL_SETTINGS,
  memoryStorage, STORAGE_KEY,
} from '../../../app/js/store.js';
import { makeStore } from './helpers.mjs';

// written for this test (not a real song)
const CHART = '{title: Test Tune}\n{key: G}\n[G]Lines for the [C]test, [D]nothing more\n';
const sid = (store) => store.currentSong().id;

test('chart: absent by default; setChart stores it whole, normalised, unknown fields kept', () => {
  const store = makeStore();
  const id = sid(store);
  assert.equal('chart' in store.currentSong(), false);
  const r = store.setChart(id, { text: CHART, format: 'chordpro', name: '  tune.cho ', key: 'nope', extra: { a: 1 } });
  assert.deepEqual(r, { ok: true, changed: true });
  assert.deepEqual(store.currentSong().chart, { text: CHART, format: 'chordpro', name: 'tune.cho', extra: { a: 1 } });
  assert.ok(Object.isFrozen(store.currentSong().chart), 'store state is frozen');
  // a format the store doesn't know is dropped (absent = detect at view time); a valid key is kept
  store.setChart(id, { text: CHART, format: 'pdf', key: 'Bb' });
  assert.deepEqual(store.currentSong().chart, { text: CHART, key: 'Bb' });
  assert.deepEqual(store.setChart(id, { text: CHART, key: 'Bb' }), { ok: true, changed: false });
});

test('chart: null removes it; nested writes and bad values are refused', () => {
  const store = makeStore();
  const id = sid(store);
  store.setChart(id, { text: CHART, format: 'plain' });
  assert.equal(store.set(`songs.${id}.chart.text`, 'x'), false, 'written whole only');
  assert.equal(store.set(`songs.${id}.chart`, 'just text'), false);
  assert.equal(store.set(`songs.${id}.chart`, { text: '   ' }), false);
  assert.equal(store.currentSong().chart.text, CHART);
  assert.deepEqual(store.setChart(id, null), { ok: true, changed: true });
  assert.equal('chart' in store.currentSong(), false);
  assert.deepEqual(store.setChart('nope', { text: CHART }).ok, false);
});

test('chart: the size cap (CHART_MAX_CHARS) refuses with a message; exactly the cap is fine', () => {
  const store = makeStore();
  const id = sid(store);
  assert.equal(CHART_MAX_CHARS, 65536);
  const big = { text: 'a'.repeat(CHART_MAX_CHARS + 1) };
  const r = store.setChart(id, big);
  assert.equal(r.ok, false);
  assert.match(r.error, /too large \(65 KB\).*at most 64 KB/);
  assert.equal(chartError(big), r.error);
  assert.equal(store.set(`songs.${id}.chart`, big), false, 'store.set refuses it too');
  assert.equal('chart' in store.currentSong(), false);
  assert.equal(store.setChart(id, { text: 'a'.repeat(CHART_MAX_CHARS) }).ok, true);
  assert.equal(chartError({ text: '' }), 'The chart is empty.');
  assert.equal(chartError({ text: 'x' }), null);
});

test('chart: a library that would pass LIBRARY_MAX_CHARS refuses the chart', () => {
  const store = makeStore();
  const ids = store.songsInOrder().map((s) => s.id);
  const n = Math.ceil(LIBRARY_MAX_CHARS / CHART_MAX_CHARS) + 1;
  while (ids.length < n) ids.push(store.addSong(null, { name: `S${ids.length}` }));
  let refused = null;
  for (const [i, id] of ids.entries()) {
    const r = store.setChart(id, { text: String(i % 10).repeat(CHART_MAX_CHARS - 10) });
    if (!r.ok) {
      refused = r;
      break;
    }
  }
  assert.ok(refused, 'one of them is refused');
  assert.match(refused.error, /library is full/);
  assert.ok(JSON.stringify(store.get()).length <= LIBRARY_MAX_CHARS);
});

test('chart: migrate keeps it, drops unusable ones, and is idempotent; no SCHEMA bump', () => {
  assert.equal(SCHEMA, 2);
  const raw = {
    schema: 2,
    songs: {
      a: { name: 'A', chart: { text: CHART, format: 'chordpro', key: 'G', name: 'a.cho', x: 1 } },
      b: { name: 'B', chart: { text: '' } },
      c: { name: 'C', chart: { text: 'z'.repeat(CHART_MAX_CHARS + 5) } },
      d: { name: 'D', chart: 'text' },
      e: { name: 'E', chart: { text: CHART, format: 7, key: 3, name: '' } },
    },
  };
  const once = migrate(JSON.parse(JSON.stringify(raw)));
  assert.deepEqual(once.songs.a.chart, { text: CHART, format: 'chordpro', key: 'G', name: 'a.cho', x: 1 });
  for (const k of ['b', 'c', 'd']) assert.equal('chart' in once.songs[k], false, k);
  assert.deepEqual(once.songs.e.chart, { text: CHART });
  const twice = migrate(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once);
  assert.deepEqual(normalizeChart(normalizeChart({ text: CHART, format: 'plain' })), { text: CHART, format: 'plain' });
  // a schema-1 library with a chart (hand-made) keeps it too
  const v1 = migrate({ schema: 1, songs: { a: { name: 'A', chart: { text: CHART } } } });
  assert.deepEqual(v1.songs.a.chart, { text: CHART });
});

test('chart: travels with library export → import (merge and replace) and with a song export', () => {
  const a = makeStore();
  const id = sid(a);
  a.setChart(id, { text: CHART, format: 'chordpro', name: 'tune.cho' });
  const lib = a.exportJSON();
  const b = makeStore();
  const r = b.importJSON(lib);
  assert.equal(r.ok, true);
  const got = r.songIds.map((s) => b.getSong(s)).find((s) => s.chart);
  assert.deepEqual(got.chart, { text: CHART, format: 'chordpro', name: 'tune.cho' });
  const c = makeStore();
  assert.equal(c.importJSON(lib, { replace: true }).ok, true);
  assert.equal(c.songsInOrder().filter((s) => s.chart).length, 1);
  const d = makeStore();
  const rs = d.importJSON(a.exportSong(id));
  assert.deepEqual(d.getSong(rs.songIds[0]).chart.text, CHART);
  // duplicateSong copies it
  const copy = a.duplicateSong(id);
  assert.equal(a.getSong(copy).chart.text, CHART);
});

test('chart: persisted and read back', () => {
  const storage = memoryStorage();
  const a = makeStore({ storage, debounceMs: 0 });
  a.setChart(sid(a), { text: CHART, format: 'chordpro' });
  a.persistNow();
  assert.match(storage.getItem(STORAGE_KEY), /Lines for the/);
  const b = makeStore({ storage });
  assert.equal(b.currentSong().chart.text, CHART);
});

test('settings.chartView: true or absent, device-local, not an edit', () => {
  const store = makeStore();
  assert.equal('chartView' in store.get().settings, false, 'absent = off');
  assert.ok(DEVICE_LOCAL_SETTINGS.includes('chartView'));
  const edited = store.get().meta.edited;
  assert.equal(store.set('settings.chartView', true), true);
  assert.equal(store.get().settings.chartView, true);
  assert.equal(store.get().meta.edited, edited, 'a machine switch does not mark the library edited');
  assert.equal(store.set('settings.chartView', 'yes'), false);
  assert.equal(store.set('settings.chartView.x', true), false);
  const lib = JSON.parse(store.exportJSON());
  assert.equal('chartView' in lib.settings, false, 'not exported');
  assert.equal(store.set('settings.chartView', false), true);
  assert.equal('chartView' in store.get().settings, false, 'false is stored as absent');
  store.set('settings.chartView', true);
  assert.equal(store.set('settings.chartView', null), true);
  assert.equal('chartView' in store.get().settings, false);
  for (const v of [false, 1, 'true', {}]) {
    assert.equal('chartView' in migrate({ schema: 2, settings: { chartView: v } }).settings, false, String(v));
  }
  assert.equal(migrate({ schema: 2, settings: { chartView: true } }).settings.chartView, true);
});

// skeptic (native/docs/reviews/chart-view.md): the cap counts UTF-16 units, as localStorage does
test('chart: multi-byte text at the cap; the library check counts the stored JSON', () => {
  const store = makeStore();
  const id = sid(store);
  assert.equal(store.setChart(id, { text: '😀'.repeat(CHART_MAX_CHARS / 2) }).ok, true, 'emoji: 2 units each');
  assert.equal(store.setChart(id, { text: '😀'.repeat(CHART_MAX_CHARS / 2) + 'a' }).ok, false);
  assert.equal(store.setChart(id, { text: 'é'.repeat(CHART_MAX_CHARS / 2) }).ok, true, 'combining marks count');
  assert.equal(store.setChart(id, { text: 'é'.repeat(CHART_MAX_CHARS) }).ok, true);
  // newlines and lone surrogates grow in JSON (\n, \ud800): the library check uses the JSON size
  assert.equal(store.setChart(id, { text: '\ud800'.repeat(CHART_MAX_CHARS) }).ok, true);
  assert.ok(JSON.stringify(store.get()).length > 6 * CHART_MAX_CHARS);
  assert.deepEqual(normalizeChart(JSON.parse('{"text":"x","__proto__":{"p":1},"constructor":1}')), { text: 'x' });
  assert.equal(normalizeChart({ text: 5 }), null);
});
