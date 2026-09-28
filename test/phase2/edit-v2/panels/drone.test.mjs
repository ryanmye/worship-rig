// OWNER: drone+bottom agent (views/edit/CONTRACT.md §6). Tests for panels/drone.js.
// Run alone: node test/phase2/edit-v2/run.mjs --only drone
// (or node --test --test-reporter=spec <this file>).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mountPanelForTest, smoke, shutdown } from '../harness.mjs';

// The whole file shares node --test's 240 s budget (run.mjs --test-timeout applies to the file's own test too), so
// the 1440 tests share one mount and the 1024 test gets the second (CONTRACT.md §7: ~2 mounts per file).
let shared = null;
const mountA = async () => (shared ??= await mountPanelForTest('drone', { song: SONG }));
after(async () => {
  await shared?.close();
  await shutdown();
});

const SONG = 'Sunday Pad + Piano'; // synth drone, key C (hearIn 0), Keys + Pad
const TITLE = '#view-edit .ev2-title .ev2-sent';
const noOverflow = (t) => t.ev((host) => {
  const bad = [];
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth) bad.push(`page ${de.scrollWidth} > ${de.clientWidth}`);
  for (const e of document.querySelectorAll(`${host}, ${host} *`)) {
    if (getComputedStyle(e).overflowX === 'visible') continue;
    if (e.scrollWidth > e.clientWidth + 1) bad.push(`${e.className} ${e.scrollWidth} > ${e.clientWidth}`);
  }
  return bad;
}, t.host);

test('drone: harness smoke (mount, ctx fields, store → engine, no console errors)', async () => {
  const t = await mountA();
  await smoke(t);
  await t.screenshot('drone-1440');
  assert.deepEqual(await noOverflow(t), []);
});

test('drone: ON tile turns on with droneOnMode(baseline) when this panel has no last source', async () => {
  const t = await mountA();
  const tile = `${t.host} [data-drone-on]`;
  // Revert snapshot says My Pads; the drone was turned off elsewhere (store) → the tile brings My Pads back
  await t.ev(() => {
    const s = window.__rig.store.currentSong();
    window.__rig.setBaseline({ ...s, drone: { ...s.drone, mode: 'files' } });
  });
  assert.equal(await t.setParam('song.drone.mode', 'off'), true);
  await t.until((sel) => document.querySelector(sel).getAttribute('aria-pressed') === 'false', tile);
  await t.click(tile);
  await t.until(() => window.__rig.store.currentSong().drone.mode === 'files');
  // a snapshot with the drone off → Synth
  await t.ev(() => {
    const s = window.__rig.store.currentSong();
    window.__rig.setBaseline({ ...s, drone: { ...s.drone, mode: 'off' } });
  });
  assert.equal(await t.setParam('song.drone.mode', 'off'), true);
  await t.until((sel) => document.querySelector(sel).getAttribute('aria-pressed') === 'false', tile);
  await t.click(tile);
  await t.until(() => window.__rig.store.currentSong().drone.mode === 'synth');
  t.assertNoConsoleErrors();
});

test('drone: round3-edit m4 — the ON tile remembers its source across a tab switch (remount), not a song change',
  async () => {
    const t = await mountA();
    const tile = `${t.host} [data-drone-on]`;
    const song = await t.ev(() => window.__rig.store.currentSong().id);
    await t.ev(() => {
      const s = window.__rig.store.currentSong();
      window.__rig.setBaseline({ ...s, drone: { ...s.drone, mode: 'synth' } });
    });
    assert.equal(await t.setParam('song.drone.mode', 'files'), true);
    await t.until((sel) => document.querySelector(sel).getAttribute('aria-pressed') === 'true', tile);
    await t.click(tile);
    await t.until(() => window.__rig.store.currentSong().drone.mode === 'off');
    // a tab switch unmounts the panel; coming back mounts a fresh one
    await t.ev(() => window.__rig.view.remount());
    await t.until((sel) => document.querySelector(sel)?.getAttribute('aria-pressed') === 'false', tile);
    await t.click(tile);
    await t.until(() => window.__rig.store.currentSong().drone.mode === 'files');
    // a song change forgets it (as in Perform): off → other song → back → ON gives the baseline's source
    await t.click(tile);
    await t.until(() => window.__rig.store.currentSong().drone.mode === 'off');
    await t.selectSong('Organ Swell');
    await t.selectSong(song);
    await t.ev(() => {
      const s = window.__rig.store.currentSong();
      window.__rig.setBaseline({ ...s, drone: { ...s.drone, mode: 'synth' } });
    });
    await t.until((sel) => document.querySelector(sel)?.getAttribute('aria-pressed') === 'false', tile);
    await t.click(tile);
    await t.until(() => window.__rig.store.currentSong().drone.mode === 'synth');
    t.assertNoConsoleErrors();
  });

test('drone: routing + drone controls write the song (ui-edit port: synth, brightness → engine, files, off)',
  async () => {
    const t = await mountA();
    const mode = (v) => `${t.host} [data-bind="song.drone.mode"] button[data-value="${v}"]`;
    // Synth / My Pads carry data-value; there is no 'off' option (the ON tile is the off switch)
    assert.equal(await t.page.locator(`${t.host} [data-bind="song.drone.mode"] button[data-value]`).count(), 2);
    await t.click(mode('synth'));
    await t.until(() => window.__rig.store.currentSong().drone.mode === 'synth');
    await t.setRange(`${t.host} [data-bind="drone.brightness"] input[type=range]`, 700);
    await t.until(() => Math.abs(window.__rig.engine.getParam('drone.brightness') - 0.7) < 0.002);
    assert.match(await t.page.textContent(`${t.host} [data-bind="drone.brightness"]`), /Clear\s*70%/);
    // the other word sliders reach the store and the engine
    await t.setRange(`${t.host} [data-bind="drone.movement"] input[type=range]`, 500);
    await t.untilEngine('drone.movement', 0.5, 0.002);
    await t.setRange(`${t.host} [data-bind="drone.width"] input[type=range]`, 200);
    await t.untilEngine('drone.width', 0.2, 0.002);
    await t.setRange(`${t.host} [data-bind="drone.fade"] input[type=range]`, 1000);
    assert.equal(await t.readParam('drone.fade'), 20);
    assert.match(await t.page.textContent(`${t.host} [data-bind="drone.fade"]`), /Slow\s*20 s/);
    // level fader: taper 2·pos³ (pos 700 → 0.686)
    await t.setRange(`${t.host} [data-bind="drone.gain"] input[type=range]`, 700);
    await t.untilEngine('drone.gain', 2 * 0.7 ** 3, 0.003);
    // synth note
    const note = `${t.host} .ev2-drone-note`;
    assert.match(await t.page.textContent(note), /^Synth drone in C: root, fifth and octave/);
    // files → chord follow disabled (+ .disabled) and the My Pads note
    const follow = `${t.host} [data-bind="song.drone.chordFollow"]`;
    assert.equal(await t.page.isDisabled(follow), false);
    await t.click(mode('files'));
    await t.until((sel) => document.querySelector(sel).classList.contains('disabled'), follow);
    assert.equal(await t.page.isDisabled(follow), true);
    assert.match(await t.page.textContent(note), /My Pads folder \(Settings\)\. Chord follow only works/);
    // off through the ON tile, then back on to the last source (My Pads)
    const tile = `${t.host} [data-drone-on]`;
    assert.equal(await t.page.getAttribute(tile, 'aria-pressed'), 'true');
    await t.click(tile);
    await t.until(() => window.__rig.store.currentSong().drone.mode === 'off');
    assert.equal(await t.page.getAttribute(tile, 'aria-pressed'), 'false');
    assert.equal(await t.page.textContent(note), 'The drone is off for this song.');
    assert.equal(await t.page.locator(`${t.host} [data-bind="song.drone.mode"] button.on`).count(), 0);
    await t.click(tile);
    await t.until(() => window.__rig.store.currentSong().drone.mode === 'files');
    // the other two switches
    const cont = await t.readParam('song.drone.continueAcrossSongs'); // factory default: true
    await t.click(`${t.host} [data-bind="song.drone.continueAcrossSongs"]`);
    await t.until((c) => window.__rig.store.currentSong().drone.continueAcrossSongs === !c, cont);
    const before = await t.readParam('song.drone.minorUsesRelativeMajorFile');
    await t.click(`${t.host} [data-bind="song.drone.minorUsesRelativeMajorFile"]`);
    await t.until((b) => window.__rig.store.currentSong().drone.minorUsesRelativeMajorFile === !b, before);
    await t.click(mode('synth'));
    await t.until((sel) => !document.querySelector(sel).classList.contains('disabled'), follow);
    await t.click(follow);
    await t.until(() => window.__rig.store.currentSong().drone.chordFollow === true);
    t.assertNoConsoleErrors();
  });

test('drone: song switch updates in place', async () => {
  const t = await mountA();
  await t.ev((host) => {
    document.querySelector(`${host} [data-bind="drone.brightness"]`).dataset.mark = 'kept';
  }, t.host);
  await t.selectSong('Organ Swell'); // drone off
  await t.until((sel) => /· off$/.test(document.querySelector(sel).textContent.trim()), TITLE);
  assert.equal(await t.page.getAttribute(`${t.host} [data-bind="drone.brightness"]`, 'data-mark'), 'kept');
  assert.equal(await t.page.getAttribute(`${t.host} [data-drone-on]`, 'aria-pressed'), 'false');
  t.assertNoConsoleErrors();
});

test('drone: sentence title, key token → song {focus:key}, changed dots + change line, tab text', async () => {
  const t = await mountPanelForTest('drone', { song: SONG, viewport: { width: 1024, height: 700 } });
  try {
    assert.equal((await t.page.textContent(TITLE)).trim(), 'DRONE holds C major · Synth');
    assert.equal(await t.setParam('song.hearIn', 2), true);
    await t.until((sel) => document.querySelector(sel).textContent.trim() === 'DRONE holds D major · Synth', TITLE);
    // minor spelling follows the key chip (C#m → "C# minor")
    await t.setParam('song.hearIn', 1);
    await t.setParam('song.minor', true);
    await t.until((sel) => /holds C# minor/.test(document.querySelector(sel).textContent), TITLE);
    const tab = await t.ev(async () => {
      const m = await import('/app/js/views/edit/panels/drone.js');
      return m.default.tab(window.__rig.store.currentSong());
    });
    assert.deepEqual(tab, { name: 'C# minor', sub: '· Synth', off: false });
    await t.setParam('song.minor', false);
    await t.setParam('song.hearIn', 2);
    // the key word selects the song block with focus 'key'
    await t.click(`${TITLE} .ev2-tok >> text=D major`);
    await t.until(() => window.__rig.view.editState.selected === 'song'
      && window.__rig.view.editState.opts.focus === 'key');
    // no source change yet → no dots, "No changes"
    const chg = `${t.host} .ev2-chg`;
    assert.match(await t.page.textContent(chg), /No switch changes since the song was loaded/);
    assert.equal(await t.page.locator(`${TITLE} .ev2-cdi`).count(), 0);
    // Synth → My Pads is a change (source); the title word gets the dot, the footer counts it
    await t.click(`${t.host} [data-bind="song.drone.mode"] button[data-value="files"]`);
    await t.until((sel) => /^1 change since/.test(document.querySelector(sel).textContent), chg);
    assert.match(await t.page.textContent(TITLE), /· My Pads/);
    assert.equal(await t.page.locator(`${TITLE} .ev2-cdi`).count(), 1);
    // the ON tile (mode ↔ off) and the level are playing moves: never counted
    await t.click(`${t.host} [data-drone-on]`);
    await t.until(() => window.__rig.store.currentSong().drone.mode === 'off');
    assert.match(await t.page.textContent(TITLE), /DRONE holds D major · off/);
    await t.setRange(`${t.host} [data-bind="drone.gain"] input[type=range]`, 300);
    await t.click(`${t.host} [data-drone-on]`);
    await t.until(() => window.__rig.store.currentSong().drone.mode === 'files');
    assert.match(await t.page.textContent(chg), /^1 change since/);
    // a switch change: its row dot shows, the count goes to 2
    await t.click(`${t.host} [data-bind="song.drone.continueAcrossSongs"]`);
    await t.until((sel) => /^2 changes since/.test(document.querySelector(sel).textContent), chg);
    const dotShown = await t.ev((host) => {
      const sw = document.querySelector(`${host} [data-bind="song.drone.continueAcrossSongs"]`);
      const row = sw.closest('.ev2-drone-opt');
      return getComputedStyle(row.querySelector('.ev2-cdi')).visibility === 'visible';
    }, t.host);
    assert.equal(dotShown, true);
    // the "off" word focuses the ON tile
    await t.click(`${t.host} [data-drone-on]`);
    await t.click(`${TITLE} .ev2-tok >> text=off`);
    await t.until((host) => document.activeElement === document.querySelector(`${host} [data-drone-on]`), t.host);
    await t.screenshot('drone-1024');
    assert.deepEqual(await noOverflow(t), []);
    t.assertNoConsoleErrors();
  } finally {
    await t.close();
  }
});
