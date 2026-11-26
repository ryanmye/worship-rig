// D24.7 "Esc always panics" (lane-small): settings.escPanics is a device-local boolean that is absent when off, like
// settings.uiV6 / chartView, so with it absent the app (main.js's Esc rule) is today's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, DEVICE_LOCAL_SETTINGS } from '../../../app/js/store.js';
import { makeStore } from './helpers.mjs';

test('settings.escPanics: true or absent, device-local, not an edit, kept across a replace-import', () => {
  const store = makeStore();
  assert.equal('escPanics' in store.get().settings, false, 'absent = off');
  assert.ok(DEVICE_LOCAL_SETTINGS.includes('escPanics'));
  const edited = store.get().meta.edited;
  assert.equal(store.set('settings.escPanics', true), true);
  assert.equal(store.get().settings.escPanics, true);
  assert.equal(store.get().meta.edited, edited, 'a machine setting does not mark the library edited');
  for (const v of ['yes', 1, {}, 'true']) assert.equal(store.set('settings.escPanics', v), false, String(v));
  assert.equal(store.set('settings.escPanics.x', true), false);
  assert.equal('escPanics' in JSON.parse(store.exportJSON()).settings, false, 'not exported');
  const foreign = JSON.parse(makeStore().exportJSON());
  foreign.settings.escPanics = true;
  const off = makeStore();
  assert.equal(off.importJSON(JSON.stringify(foreign), { replace: true }).ok, true);
  assert.equal('escPanics' in off.get().settings, false, 'an import never turns it on');
  assert.equal(store.importJSON(JSON.stringify(foreign), { replace: true }).ok, true);
  assert.equal(store.get().settings.escPanics, true, 'a replace-import keeps this machine’s choice');
  assert.equal(store.set('settings.escPanics', false), true);
  assert.equal('escPanics' in store.get().settings, false, 'false (the Settings toggle off) is stored as absent');
  store.set('settings.escPanics', true);
  assert.equal(store.set('settings.escPanics', null), true);
  assert.equal('escPanics' in store.get().settings, false);
  assert.equal(store.set('settings.escPanics', null), false, 'already off: no change, no notification');
  for (const v of [false, 1, 'true', {}, null]) {
    assert.equal('escPanics' in migrate({ schema: 2, settings: { escPanics: v } }).settings, false, String(v));
  }
  assert.equal(migrate({ schema: 2, settings: { escPanics: true } }).settings.escPanics, true);
});
