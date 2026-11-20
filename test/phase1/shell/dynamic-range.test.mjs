// settings.dynamicRange (Ryan 2026-11-20, hardware batch): shared velocityDb, the store field (device-local, 1 =
// absent, clamped) and the controller → engine.setDynamicRange path (at start and on change).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { velocityDb, validDynRange, DYN_PIVOT, DYN_RANGE, FIT_SOFT_TARGET } from '../../../app/js/shared/touch-curve.js';
import { DEVICE_LOCAL_SETTINGS } from '../../../app/js/store.js';
import { createController } from '../../../app/js/controller.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc, tick } from './helpers.mjs';

test('velocityDb: range 1 is the old formula; wider = quieter below the pivot, louder above, same at the pivot', () => {
  for (const span of [10, 24]) {
    for (const v of [0, 0.15, 0.5, DYN_PIVOT, 1]) assert.equal(velocityDb(v, span, 1), -span * (1 - v));
    for (const r of [1.5, 2, 3]) {
      assert.ok(Math.abs(velocityDb(DYN_PIVOT, span, r) - velocityDb(DYN_PIVOT, span, 1)) < 1e-12, 'pivot fixed');
      assert.ok(velocityDb(FIT_SOFT_TARGET, span, r) < velocityDb(FIT_SOFT_TARGET, span, 1), 'soft quieter');
      assert.ok(velocityDb(1, span, r) > 0, 'hardest above the old full');
    }
  }
  assert.equal(velocityDb(1, 10, 3), 5); // pianos at 3×: +5 dB at the top
  assert.equal(validDynRange(0.5), DYN_RANGE.min);
  assert.equal(validDynRange(9), DYN_RANGE.max);
  assert.equal(validDynRange(1.234), 1.23);
  assert.equal(validDynRange('2'), null);
});

test('store: settings.dynamicRange is optional, device-local, clamped; 1 and null clear it; junk is refused', () => {
  assert.ok(DEVICE_LOCAL_SETTINGS.includes('dynamicRange'));
  const s = makeStore();
  assert.equal('dynamicRange' in s.get().settings, false);
  s.set('settings.dynamicRange', 1.8);
  assert.equal(s.get().settings.dynamicRange, 1.8);
  s.set('settings.dynamicRange', 7);
  assert.equal(s.get().settings.dynamicRange, 3);
  s.set('settings.dynamicRange', 'loud');
  assert.equal(s.get().settings.dynamicRange, 3, 'refused');
  s.set('settings.dynamicRange', 1);
  assert.equal('dynamicRange' in s.get().settings, false, '1 = absent');
  s.set('settings.dynamicRange', 2);
  s.set('settings.dynamicRange', null);
  assert.equal('dynamicRange' in s.get().settings, false);
});

test('controller: dynamicRange reaches engine.setDynamicRange at start and on every change', async () => {
  const store = makeStore();
  store.set('settings.dynamicRange', 2);
  const engine = fakeEngine();
  engine.setDynamicRange = (r) => engine.calls.push(['setDynamicRange', r]);
  const ctl = createController({ store, engine, midi: null, recorder: null, doc: fakeDoc(), nav: null,
    win: new EventTarget(), rig: null, timers: fakeTimers(), autoRestart: false });
  await ctl.start();
  await tick();
  const seen = () => engine.calls.filter((c) => c[0] === 'setDynamicRange').map((c) => c[1]);
  assert.deepEqual(seen(), [2], 'applied at start');
  store.set('settings.dynamicRange', 2.5);
  await tick();
  store.set('settings.dynamicRange', 1);
  await tick();
  assert.deepEqual(seen(), [2, 2.5, 1], 'changes, and back to 1 when cleared');
  ctl.dispose();
});
