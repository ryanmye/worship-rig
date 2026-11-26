// UI v6 (D22, UI6-build-plan U1; hidden): settings.uiV6 is a device-local boolean that is absent when off, exactly
// like settings.chartView. The builder covered it only in the browser suite (test/phase2/ui-v6), so the store rules
// are pinned here (skeptic, native/docs/reviews/UI6-U1.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, DEVICE_LOCAL_SETTINGS } from '../../../app/js/store.js';
import { makeStore } from './helpers.mjs';

test('settings.uiV6: true or absent, device-local, not an edit, kept across a replace-import', () => {
  const store = makeStore();
  assert.equal('uiV6' in store.get().settings, false, 'absent = off');
  assert.ok(DEVICE_LOCAL_SETTINGS.includes('uiV6'));
  const edited = store.get().meta.edited;
  assert.equal(store.set('settings.uiV6', true), true);
  assert.equal(store.get().settings.uiV6, true);
  assert.equal(store.get().meta.edited, edited, 'a machine switch does not mark the library edited');
  for (const v of ['yes', 1, {}, 'true']) assert.equal(store.set('settings.uiV6', v), false, String(v));
  assert.equal(store.set('settings.uiV6.x', true), false);
  const lib = store.exportJSON();
  assert.equal('uiV6' in JSON.parse(lib).settings, false, 'not exported');
  // a library from another machine with the switch on does not turn it on here, and a replace keeps this one's
  const other = makeStore();
  const foreign = JSON.parse(other.exportJSON());
  foreign.settings.uiV6 = true;
  const off = makeStore();
  assert.equal(off.importJSON(JSON.stringify(foreign), { replace: true }).ok, true);
  assert.equal('uiV6' in off.get().settings, false, 'an import never turns it on');
  assert.equal(store.importJSON(JSON.stringify(foreign), { replace: true }).ok, true);
  assert.equal(store.get().settings.uiV6, true, 'a replace-import keeps this machine’s switch');
  assert.equal(store.set('settings.uiV6', false), true);
  assert.equal('uiV6' in store.get().settings, false, 'false is stored as absent');
  store.set('settings.uiV6', true);
  assert.equal(store.set('settings.uiV6', null), true);
  assert.equal('uiV6' in store.get().settings, false);
  assert.equal(store.set('settings.uiV6', null), false, 'already off: no change, no notification');
  for (const v of [false, 1, 'true', {}, null]) {
    assert.equal('uiV6' in migrate({ schema: 2, settings: { uiV6: v } }).settings, false, String(v));
  }
  assert.equal(migrate({ schema: 2, settings: { uiV6: true } }).settings.uiV6, true);
});
