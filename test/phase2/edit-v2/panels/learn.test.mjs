// 2.x step 5 (FX-gap-analysis "MIDI learn", DECISIONS O-AW-ML): the Edit "Learn MIDI knob" menu (views/edit/
// learn-menu.js). Right-click the Pad's reverb send (the Space chip), Learn, move a knob through midi._inject: the
// send follows in the store and the engine. Forget; the menu does not open on a switch or under Perform Lock; Esc
// closes it and cancels the learn; zero console errors.
// Run alone: node test/phase2/edit-v2/run.mjs --only learn
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mountPanelForTest, shutdown } from '../harness.mjs';

after(shutdown);

let shared = null;
const page = async () => shared || (shared = await mountPanelForTest('slot', { panelOpts: { slot: 1 } }));
const SEND = '[data-bind="slots.1.sends.reverb"]';
const MENU = '[data-testid="ev2-learn-menu"]';

test('learn: right-click the reverb send → Learn → a CC moves it (store and engine)', async () => {
  const t = await page();
  await t.setParam('slots.1.sends.reverb', 0.3);
  await t.ev(() => window.__rig.store.setMidiLearn('slots.1.sends.reverb', null));
  await t.click(SEND, { button: 'right' });
  await t.until((m) => !!document.querySelector(m), MENU);
  assert.equal(await t.ev((m) => document.querySelector(m).dataset.addr, MENU), 'slots.1.sends.reverb');
  assert.match(await t.ev((m) => document.querySelector(m).textContent, MENU), /Pad reverb send.*No knob yet/);
  await t.screenshot('learn-menu');
  await t.click(`${MENU} [data-act="learn"]`);
  await t.until(() => window.__rig.midi.learning === 'slots.1.sends.reverb');
  await t.ev(() => window.__rig.midi._inject([0xb0, 74, 40])); // the learning gesture
  await t.until(() => window.__rig.store.get().settings.midiLearn['slots.1.sends.reverb']?.cc === 74);
  await t.until((m) => !document.querySelector(m), MENU); // closed once learned
  assert.deepEqual(await t.ev(() => window.__rig.store.get().settings.midiLearn['slots.1.sends.reverb']),
    { cc: 74, channel: 0 });
  // the knob: pickup at 0.3 (sweep up past it), then the send follows; spaced past the 20 ms write window
  await t.ev(async () => {
    for (let v = 0; v <= 127; v += 8) {
      window.__rig.midi._inject([0xb0, 74, v]);
      await new Promise((r) => setTimeout(r, 25));
    }
    window.__rig.midi._inject([0xb0, 74, 127]);
  });
  await t.until(() => Math.abs(window.__rig.store.currentSong().patch.slots[1].sends.reverb - 1) < 1e-9);
  await t.untilEngine('slots.1.sends.reverb', 1, 1e-6);
  await t.ev(() => window.__rig.midi._inject([0xb0, 74, 64]));
  await t.until(() => Math.abs(window.__rig.store.currentSong().patch.slots[1].sends.reverb - 64 / 127) < 1e-9);
  await t.untilEngine('slots.1.sends.reverb', 64 / 127, 1e-6);
  // the chip shows it (the Edit binder refreshes from the store)
  await t.until((s) => document.querySelector(s).textContent.length > 0, SEND);
  t.assertNoConsoleErrors();
});

test('learn: the menu offers Forget; a switch and the shelf sliders get the browser menu; Esc cancels', async () => {
  const t = await page();
  await t.click(SEND, { button: 'right' });
  await t.until((m) => !!document.querySelector(m), MENU);
  assert.match(await t.ev((m) => document.querySelector(m).textContent, MENU), /Knob: CC 74 · ch 1/);
  await t.click(`${MENU} [data-act="forget"]`);
  await t.until(() => !window.__rig.store.get().settings.midiLearn['slots.1.sends.reverb']);
  await t.until((m) => !document.querySelector(m), MENU);
  // a switch (sustain) is not continuous: no menu, the default is not prevented
  const prevented = await t.ev(() => {
    const el = document.querySelector('[data-bind="slots.1.sustain"]');
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  });
  assert.equal(prevented, false);
  assert.equal(await t.ev((m) => !!document.querySelector(m), MENU), false);
  // shelf sliders opt out (data-no-learn)
  const shelf = await t.ev(() => [...document.querySelectorAll('[data-no-learn]')].map((e) => e.dataset.bind));
  for (const b of shelf) assert.match(b, /^slots\.1\.eq\.(low|high)$/);
  // Esc closes the menu and cancels a pending learn
  await t.click(SEND, { button: 'right' });
  await t.until((m) => !!document.querySelector(m), MENU);
  await t.click(`${MENU} [data-act="learn"]`);
  await t.until(() => window.__rig.midi.learning === 'slots.1.sends.reverb');
  await t.page.keyboard.press('Escape');
  await t.until((m) => !document.querySelector(m), MENU);
  await t.until(() => window.__rig.midi.learning === null);
  t.assertNoConsoleErrors();
});

test('learn: under Perform Lock the menu stays shut and learn() is refused; a learned knob still plays', async () => {
  const t = await page();
  await t.ev(() => window.__rig.store.setMidiLearn('fx.delay.feedback', { cc: 75, channel: 0 }));
  await t.ev(() => window.__rig.store.set('settings.performLock', true));
  const prevented = await t.ev(() => {
    const el = document.querySelector('[data-bind="slots.1.sends.reverb"]');
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  });
  assert.equal(prevented, false, 'locked: the browser menu, no learn menu');
  assert.equal(await t.ev((m) => !!document.querySelector(m), MENU), false);
  assert.deepEqual(await t.ev(() => window.__rig.controller.learn('slots.1.sends.reverb')),
    { error: 'perform-locked' });
  assert.equal(await t.ev(() => window.__rig.midi.learning), null);
  await t.setParam('fx.delay.feedback', 0);
  await t.ev(async () => {
    window.__rig.midi._inject([0xb0, 75, 0]);
    await new Promise((r) => setTimeout(r, 30));
    window.__rig.midi._inject([0xb0, 75, 127]);
  });
  await t.until(() => Math.abs(window.__rig.store.currentSong().patch.fx.delay.feedback - 0.9) < 1e-9);
  await t.ev(() => {
    window.__rig.store.set('settings.performLock', false);
    window.__rig.store.setMidiLearn('fx.delay.feedback', null);
  });
  t.assertNoConsoleErrors();
});
