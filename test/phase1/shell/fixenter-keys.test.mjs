// fixenter skeptic: keyEl(e) (event target first, activeElement only for a body / document target) against the other
// key paths. Each case dispatches with a real target that differs from activeElement (the field blurred itself).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../../../app/js/controller.js';
import { MidiInput } from '../../../app/js/midi.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc, tick } from './helpers.mjs';

async function setup() {
  const store = makeStore();
  const engine = fakeEngine();
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {};
  const doc = fakeDoc();
  const ctl = createController({ store, engine, midi, doc, nav: null, win: new EventTarget(), rig: null,
    timers: fakeTimers(), now: () => 0, locks: null });
  await ctl.start();
  await tick();
  return { store, engine, doc, ctl, ids: store.navIds() };
}
function press(doc, target, props) {
  const ev = new Event('keydown', { cancelable: true });
  Object.assign(ev, { code: '', key: '', repeat: false, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false,
    ...props });
  if (target) Object.defineProperty(ev, 'target', { value: target });
  doc.dispatchEvent(ev);
  return ev;
}
const TEXT = { tagName: 'INPUT', type: 'text' };
const BTN = { tagName: 'BUTTON' };

test('target field, activeElement body: Space is not sustain, arrows do not change song, Shift+arrows do not cue', async () => {
  const { store, engine, doc, ctl, ids } = await setup();
  doc.activeElement = doc.body;
  engine.clear();
  for (const props of [{ code: 'Space' }, { code: 'ArrowRight' }, { code: 'ArrowLeft', shiftKey: true },
    { code: 'ArrowUp' }, { code: 'KeyA' }]) {
    const ev = press(doc, TEXT, props);
    assert.equal(ev.defaultPrevented, false, props.code);
  }
  await tick();
  assert.deepEqual(engine.calls, []);
  assert.equal(store.get().settings.currentSongId, ids[0]);
  ctl.dispose();
});

test('target button, activeElement body: Enter / Space / arrows stay the button\'s', async () => {
  const { store, doc, ctl, ids } = await setup();
  doc.activeElement = doc.body;
  for (const props of [{ code: 'Enter' }, { code: 'NumpadEnter' }, { code: 'Space' }, { code: 'ArrowRight' }]) {
    assert.equal(press(doc, BTN, props).defaultPrevented, false, props.code);
  }
  await tick();
  await tick();
  assert.equal(store.get().settings.currentSongId, ids[0]);
  ctl.dispose();
});

test('target body / documentElement with a focused field: field still wins (fallback to activeElement)', async () => {
  const { store, doc, ctl, ids } = await setup();
  doc.activeElement = TEXT;
  assert.equal(press(doc, doc.body, { code: 'Enter' }).defaultPrevented, false);
  assert.equal(press(doc, doc.documentElement, { code: 'Space' }).defaultPrevented, false);
  await tick();
  assert.equal(store.get().settings.currentSongId, ids[0]);
  ctl.dispose();
});

test('nothing focused (target body): Space sustains, arrows step, Esc panics, Enter GOes', async () => {
  const { store, engine, doc, ctl, ids } = await setup();
  doc.activeElement = doc.body;
  assert.equal(press(doc, doc.body, { code: 'Space' }).defaultPrevented, true);
  doc.dispatchEvent(Object.assign(new Event('keyup'), { code: 'Space' }));
  engine.clear();
  press(doc, doc.body, { code: 'Escape' });
  assert.deepEqual(engine.calls, [['allNotesOff']]);
  assert.equal(press(doc, doc.body, { code: 'ArrowRight' }).defaultPrevented, true);
  await tick();
  await tick();
  assert.equal(store.get().settings.currentSongId, ids[1]);
  ctl.dispose();
});

test('Esc panics even from a text field target (unchanged); Cmd+Arrow from a field target does not switch song', async () => {
  const { store, engine, doc, ctl, ids } = await setup();
  doc.activeElement = doc.body;
  engine.clear();
  press(doc, TEXT, { code: 'Escape' });
  assert.deepEqual(engine.calls, [], 'Esc in a text field is the field\'s (inText returns first), as before');
  press(doc, TEXT, { code: 'ArrowRight', metaKey: true });
  await tick();
  assert.equal(store.get().settings.currentSongId, ids[0]);
  ctl.dispose();
});

test('IME composition Enter from a field target is never GO', async () => {
  const { store, doc, ctl, ids } = await setup();
  doc.activeElement = doc.body;
  const ev = press(doc, TEXT, { code: 'Enter', key: 'Process', isComposing: true, keyCode: 229 });
  assert.equal(ev.defaultPrevented, false);
  await tick();
  assert.equal(store.get().settings.currentSongId, ids[0]);
  ctl.dispose();
});
