// U-CVD (native DECISIONS D32): settings.cvd ("Colour-blind colours") is a device-local 'rg' | 'by' that is absent
// when Off, like settings.escPanics, so with it absent the app is today's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, DEVICE_LOCAL_SETTINGS, CVD_TYPES } from '../../../app/js/store.js';
import { makeStore } from './helpers.mjs';

test('settings.cvd: rg | by or absent, device-local, not an edit, kept across a replace-import', () => {
  const store = makeStore();
  assert.deepEqual([...CVD_TYPES], ['rg', 'by']);
  assert.equal('cvd' in store.get().settings, false, 'absent = Off');
  assert.ok(DEVICE_LOCAL_SETTINGS.includes('cvd'));
  const edited = store.get().meta.edited;
  assert.equal(store.set('settings.cvd', 'rg'), true);
  assert.equal(store.get().settings.cvd, 'rg');
  assert.equal(store.get().meta.edited, edited, 'a machine setting does not mark the library edited');
  assert.equal(store.set('settings.cvd', 'by'), true);
  assert.equal(store.get().settings.cvd, 'by');
  for (const v of ['RG', 'deutan', 'tritan', 1, true, {}, ['rg'], '']) {
    assert.equal(store.set('settings.cvd', v), false, JSON.stringify(v));
  }
  assert.equal(store.get().settings.cvd, 'by', 'a refused value leaves the choice');
  assert.equal(store.set('settings.cvd.x', 'rg'), false);
  assert.equal('cvd' in JSON.parse(store.exportJSON()).settings, false, 'not exported');
  // an incoming library never brings another player's choice, and a replace-import keeps this one's
  const foreign = JSON.parse(makeStore().exportJSON());
  foreign.settings.cvd = 'rg';
  const off = makeStore();
  assert.equal(off.importJSON(JSON.stringify(foreign), { replace: true }).ok, true);
  assert.equal('cvd' in off.get().settings, false, 'an import never turns it on');
  assert.equal(store.importJSON(JSON.stringify(foreign), { replace: true }).ok, true);
  assert.equal(store.get().settings.cvd, 'by', 'a replace-import keeps this machine’s choice');
  // Off: Settings writes null ('off', false and undefined mean the same); stored as absent
  for (const v of [null, 'off', false, undefined]) {
    store.set('settings.cvd', 'rg');
    assert.equal(store.set('settings.cvd', v), true, String(v));
    assert.equal('cvd' in store.get().settings, false, String(v));
  }
  assert.equal(store.set('settings.cvd', null), false, 'already Off: no change, no notification');
  // migrate: bad values are dropped, good ones kept, idempotent
  for (const v of [false, true, 1, 'RG', 'off', {}, null]) {
    assert.equal('cvd' in migrate({ schema: 2, settings: { cvd: v } }).settings, false, JSON.stringify(v));
  }
  for (const v of CVD_TYPES) {
    const once = migrate({ schema: 2, settings: { cvd: v } });
    assert.equal(once.settings.cvd, v);
    assert.deepEqual(migrate(JSON.parse(JSON.stringify(once))), once, 'migrate is idempotent');
  }
});

test('settings.cvd: an imported library with a bad value loads, without it', () => {
  const lib = JSON.parse(makeStore().exportJSON());
  lib.settings.cvd = 'purple';
  const store = makeStore();
  assert.equal(store.importJSON(JSON.stringify(lib), { replace: true }).ok, true);
  assert.equal('cvd' in store.get().settings, false);
});
