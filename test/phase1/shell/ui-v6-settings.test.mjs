// UI v6 U6: the v6 Settings' category summaries (app/js/views/v6/settings-summary.js, pure).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ago, soundSummary, keyboardsSummary, learnSummary, samplesSummary, layoutSummary, lookSummary, librarySummary,
  macSummary, aboutSummary,
} from '../../../app/js/views/v6/settings-summary.js';

test('ago: just now, minutes, hours, days', () => {
  const t = 1_000_000_000;
  assert.equal(ago(t, t + 20e3), 'just now');
  assert.equal(ago(t, t + 120e3), '2 min ago');
  assert.equal(ago(t, t + 3 * 3600e3 + 5), '3 h ago');
  assert.equal(ago(t, t + 24 * 3600e3), '1 day ago');
  assert.equal(ago(t, t + 72 * 3600e3), '3 days ago');
  assert.equal(ago(t + 5000, t), 'just now', 'a clock step back reads as now');
});

test('sound: output and the delay, else the latency choice', () => {
  assert.equal(soundSummary({ output: 'Built-in output', latencyMs: 41.6 }), 'Built-in output · 42 ms');
  assert.equal(soundSummary({ latencyLabel: 'Balanced' }), 'System default · Balanced');
  assert.equal(soundSummary(), 'System default');
});

test('keyboards: the device playing (or why none) and the touch', () => {
  assert.equal(keyboardsSummary({ midi: { available: true, connected: true, name: 'Keystation 49' }, touch: 'Normal' }),
    'Keystation 49 · Normal touch');
  assert.equal(keyboardsSummary({ midi: { available: false }, touch: 'Heavy' }), 'MIDI off · Heavy touch');
  assert.equal(keyboardsSummary({ midi: { available: true }, computerKeys: true, touch: 'Light' }),
    'Computer keys · Light touch');
  assert.equal(keyboardsSummary({ midi: { available: true }, computerKeys: false }), 'No keyboard · Normal touch');
});

test('learn: n controls learned (null entries do not count)', () => {
  assert.equal(learnSummary({}), 'nothing learned yet');
  assert.equal(learnSummary(undefined), 'nothing learned yet');
  assert.equal(learnSummary({ a: { cc: 1 } }), '1 control learned');
  assert.equal(learnSummary({ a: { cc: 1 }, b: { note: 60 }, c: null }), '2 controls learned');
});

test('samples: packs and bank songs first, else sample instruments and My Pads', () => {
  assert.equal(samplesSummary({ packs: { enabled: true, songs: 9, packs: 2, bankSongs: 7 } }),
    '2 packs · 7 bank songs');
  assert.equal(samplesSummary({ packs: { enabled: true, songs: 1, packs: 1, bankSongs: 1 } }), '1 pack · 1 bank song');
  assert.equal(samplesSummary({ packs: { enabled: true, songs: 0 }, samples: 3, padFolder: true }),
    '3 sample instruments · My Pads folder set');
  assert.equal(samplesSummary({}), 'built-in sounds');
});

test('layout, look, library, mac, about', () => {
  assert.equal(layoutSummary({ sidebarOpen: true, snapsFolded: false }), 'sidebar open · snapshots shown');
  assert.equal(layoutSummary({ sidebarOpen: false, snapsFolded: true }), 'sidebar folded · snapshots folded');
  assert.equal(lookSummary({ name: 'Sanctuary', mode: 'dark' }), 'Sanctuary · dark');
  assert.equal(lookSummary({ name: 'Sanctuary Day', mode: 'light' }), 'Sanctuary Day · light');
  assert.equal(lookSummary({ name: 'Daylight Day', mode: 'light', light: 'auto' }), 'Daylight Day · Auto');
  const now = 5_000_000;
  assert.equal(librarySummary({ electron: true, lastBackupAt: now - 120e3, now }), 'backed up 2 min ago');
  assert.equal(librarySummary({ electron: true, lastBackupAt: null, songs: 42 }), '42 songs · automatic backups');
  assert.equal(librarySummary({ songs: 1 }), '1 song · Export to back up');
  assert.equal(macSummary({ menuBarMode: true }), 'menu bar on · updates on');
  assert.equal(macSummary({ menuBarMode: false, updateCheck: false }), 'menu bar off · updates off');
  assert.equal(aboutSummary({ version: '2.0.0' }), 'Version 2.0.0');
  assert.equal(aboutSummary({ electron: true }), 'Mac app');
  assert.equal(aboutSummary({}), 'Chrome');
});
