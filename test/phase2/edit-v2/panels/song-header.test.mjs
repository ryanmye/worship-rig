// OWNER: song agent (views/edit/CONTRACT.md §6). Tests for panels/song-header.js (region 'head'). Ports ui-edit
// "tap tempo", the name half of "song name + notes", the name half of "round2-ui #3" and "reset to factory".
// Run alone: node test/phase2/edit-v2/run.mjs --only song-header
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mountPanelForTest, smoke, shutdown } from '../harness.mjs';

// One shared mount (1440, resized to 1024 for the last test): each mount costs 10–45 s on the shared 2-CPU box, and
// node:test's per-test timeout also bounds the whole file.
let t;
before(async () => {
  t = await mountPanelForTest('song-header');
});
after(async () => {
  await t?.close();
  await shutdown();
});

const ES = () => t.ev(() => {
  const es = window.__rig.view.editState;
  return { selected: es.selected, opts: es.opts, drawer: es.drawer };
});
const visible = (sel) => t.ev((s) => {
  const e = document.querySelector(s);
  return !!e && e.checkVisibility();
}, sel);
const toasts = () => t.ev(() => window.__rig.toasts.map((x) => x.msg));
const menuOpen = () => t.ev(() => {
  const p = document.querySelector('.ev2-song-pop');
  return p && !p.hidden ? p.getAttribute('role') : null;
});

test('song-header: harness smoke (mount, ctx fields, store → engine, no console errors)', async () => {
  await smoke(t);
  await t.screenshot('song-header-1440');
});

test('song-header: LIVE, name, KEY / BPM / Notes chips select the Song panel; changed dots; Loading…', async () => {
  const H = t.host;
  const s = await t.song();
  assert.match(await t.page.textContent(`${H} .ev2-song-live`), /LIVE/);
  assert.equal(await t.page.inputValue(`${H} .ev2-song-name`), s.name);
  assert.equal(await visible(`${H} .ev2-song-livehint`), true, 'live hint at 1440');
  assert.equal(await visible(`${H} [data-drawer-toggle]`), false, '☰ Songs only at ≤ 1250 px');
  assert.match(await t.page.textContent(`${H} [data-chip="key"]`), /Key.*· you play/);

  await t.click(`${H} [data-chip="key"]`);
  assert.deepEqual(await ES(), { selected: 'song', opts: { focus: 'key' }, drawer: false });
  await t.click(`${H} .ev2-song-bpmnum`);
  assert.deepEqual((await ES()).opts, { focus: 'tempo' });
  await t.click(`${H} [data-chip="notes"]`);
  assert.deepEqual((await ES()).opts, { focus: 'notes' });

  // dots: KEY for hearIn/playIn/octave/minor, BPM for tempo; back to the loaded value → no dot
  const dot = (chip) => t.ev((c) => {
    const e = document.querySelector(`[data-chip="${c}"]`);
    return [e.dataset.changed, e.querySelector('.ev2-cdi').checkVisibility()];
  }, chip);
  assert.deepEqual(await dot('key'), ['false', false]);
  await t.setParam('song.hearIn', (s.hearIn + 2) % 12);
  await t.until(() => document.querySelector('[data-chip="key"]').dataset.changed === 'true');
  assert.deepEqual(await dot('key'), ['true', true]);
  await t.setParam('song.transposeOctave', 1);
  await t.until(() => /\+1 oct/.test(document.querySelector('[data-chip="key"]').textContent));
  await t.setParam('song.transposeOctave', s.transposeOctave);
  await t.setParam('song.hearIn', s.hearIn);
  await t.until(() => document.querySelector('[data-chip="key"]').dataset.changed === 'false');
  const bpm = s.tempo === 133 ? 134 : 133;
  await t.setParam('song.tempo', bpm);
  await t.until((b) => document.querySelector('.ev2-song-bpmval').textContent === String(b), bpm);
  assert.deepEqual(await dot('bpm'), ['true', true]);
  await t.setParam('song.tempo', s.tempo);
  await t.until(() => document.querySelector('[data-chip="bpm"]').dataset.changed === 'false');

  // Loading… follows controller.onStatus
  // dispatch + read in one evaluate: a real status event (audio/MIDI state) could land in between two round trips
  const shown = await t.ev((sel) => {
    const c = window.__rig.controller;
    const e = () => document.querySelector(sel).checkVisibility();
    const out = [e()];
    c.dispatchEvent(new CustomEvent('status', { detail: { ...c.status, loading: true } }));
    out.push(e());
    c.dispatchEvent(new CustomEvent('status', { detail: { ...c.status, loading: false } }));
    out.push(e());
    return out;
  }, `${H} .ev2-song-loading`);
  assert.deepEqual(shown, [false, true, false]);
  t.assertNoConsoleErrors();
});

test('song-header: song name — Enter commits, empty reverts, Esc cancels; round2-ui #3 (name typed before a switch)',
  async () => {
    const name = `${t.host} .ev2-song-name`;
    await t.ev(() => {
      window.__panics = 0;
      window.__rig.controller.addEventListener('action', (e) => {
        if (e.detail && e.detail.type === 'panic') window.__panics += 1;
      });
    });
    await t.page.fill(name, 'My Edited Song');
    await t.page.press(name, 'Enter');
    await t.until(() => window.__rig.store.currentSong().name === 'My Edited Song');
    assert.equal(await t.ev(() => document.activeElement?.classList.contains('ev2-song-name')), false, 'Enter blurs');
    await t.page.fill(name, '   ');
    await t.page.press(name, 'Enter');
    await t.until((s) => document.querySelector(s).value === 'My Edited Song', name);
    assert.equal((await t.song()).name, 'My Edited Song', 'an empty name is refused');
    await t.click(name);
    await t.page.keyboard.type('zzz');
    await t.page.keyboard.press('Escape');
    assert.equal(await t.page.inputValue(name), 'My Edited Song', 'Esc restores the name');
    await t.sleep(50);
    assert.equal((await t.song()).name, 'My Edited Song', 'Esc commits nothing');
    assert.equal(await t.ev(() => window.__panics), 0, 'Esc never panics');

    // round2-ui #3: a name typed before a non-pointer song switch goes to the song it was typed in
    const [a, b] = await t.ev(() => {
      const st = window.__rig.store;
      const cur = st.currentSong().id;
      return [cur, st.navIds().find((x) => x !== cur && st.getSong(x).name !== st.getSong(cur).name)];
    });
    const snap = () => t.ev(([x, y]) => {
      const st = window.__rig.store;
      return { a: st.getSong(x).name, b: st.getSong(y).name };
    }, [a, b]);
    const s0 = await snap();
    await t.click(name);
    await t.page.keyboard.press('End');
    await t.page.keyboard.type(' (live)');
    await t.selectSong(b);
    assert.equal(await t.page.inputValue(name), s0.b, 'the name field shows the new song at once');
    await t.page.keyboard.press('Enter');
    await t.sleep(80);
    const s1 = await snap();
    assert.equal(s1.a, `${s0.a} (live)`, 'the typed name went to the song it was typed in');
    assert.equal(s1.b, s0.b, 'the next song is not renamed');
    await t.ev(([x, n]) => window.__rig.store.set(`songs.${x}.name`, n), [a, s0.a]);
    await t.selectSong(a);
    t.assertNoConsoleErrors();
  });

test('song-header: polish-1 text:"dirty" — the focused name follows an outside rename until typed in', async () => {
  const name = `${t.host} .ev2-song-name`;
  const s0 = await t.song();
  const rename = (n) => t.ev(([i, x]) => window.__rig.store.set(`songs.${i}.name`, x), [s0.id, n]);
  await t.click(name);
  await rename('Renamed in the setlist');
  await t.until((s) => document.querySelector(s).value === 'Renamed in the setlist', name);
  await t.page.keyboard.press('End');
  await t.page.keyboard.type('!');
  await rename('Renamed again');
  await t.sleep(60);
  assert.equal(await t.page.inputValue(name), 'Renamed in the setlist!', 'a typed draft is not overwritten');
  await t.page.keyboard.press('Escape'); // Esc cancels the draft → the stored name
  await t.until((s) => document.querySelector(s).value === 'Renamed again', name);
  assert.equal((await t.song()).name, 'Renamed again');
  await rename(s0.name);
  await t.until(([s, n]) => document.querySelector(s).value === n, [name, s0.name]);
  t.assertNoConsoleErrors();
});

test('song-header: tap tempo (4 taps @ 500 ms) → ~120 BPM in store and engine', async () => {
  // first tap is a real click; the rest are timed in-page (Playwright's click latency would skew the BPM). The
  // expected BPM comes from the actual click times, so a loaded machine (late timers) can't fail the test.
  await t.ev(() => {
    window.__taps = [];
    document.querySelector('[data-tap="head"]')
      .addEventListener('click', () => window.__taps.push(performance.now()), { capture: true });
  });
  await t.click('[data-tap="head"]');
  await t.ev(async () => {
    const b = document.querySelector('[data-tap="head"]');
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 500));
      b.click();
    }
  });
  const tempo = await t.ev(() => window.__rig.store.currentSong().tempo); // Tap writes synchronously
  let seq = [];
  for (const x of await t.ev(() => window.__taps)) {
    if (seq.length && x - seq[seq.length - 1] > 2000) seq = []; // same reset rule as the view
    seq.push(x);
  }
  seq = seq.slice(-4);
  const want = 60000 / ((seq[seq.length - 1] - seq[0]) / (seq.length - 1));
  assert.ok(Math.abs(tempo - want) <= 1.5, `tempo ${tempo} vs ${want.toFixed(1)} from the click times`);
  if (Math.abs(tempo - 120) > 4) console.log(`   note: tap timers ran late (${want.toFixed(1)} BPM for 500 ms taps)`);
  await t.until((x) => window.__rig.engine.tempo === x, tempo);
  assert.equal(await t.page.textContent(`${t.host} .ev2-song-bpmval`), String(tempo));
  t.assertNoConsoleErrors();
});

test('song-header: ⋯ Song menu — keyboard, Esc (no panic), outside click, Duplicate, Rename, Export song', async () => {
  const H = t.host;
  const btn = `${H} .ev2-song-menubtn`;
  const s = await t.song();
  await t.click(btn);
  assert.equal(await menuOpen(), 'menu');
  assert.equal(await t.page.getAttribute(btn, 'aria-expanded'), 'true');
  assert.equal(await t.ev(() => document.body.dataset.dialogOpen), '1', 'body[data-dialog-open] while open');
  const focused = () => t.ev(() => document.activeElement?.dataset.act || document.activeElement?.className);
  assert.equal(await focused(), 'duplicate', 'open → first item focused');
  const acts = await t.ev(() => [...document.querySelectorAll('.ev2-song-pop [role="menuitem"]')]
    .map((b) => b.dataset.act));
  assert.deepEqual(acts, s.factoryId ? ['duplicate', 'rename', 'export', 'reset', 'delete']
    : ['duplicate', 'rename', 'export', 'delete']);
  await t.page.keyboard.press('ArrowDown');
  assert.equal(await focused(), 'rename');
  await t.page.keyboard.press('End');
  assert.equal(await focused(), 'delete');
  await t.page.keyboard.press('Home');
  assert.equal(await focused(), 'duplicate');
  await t.page.keyboard.press('ArrowUp');
  assert.equal(await focused(), 'delete', '↑ wraps');
  assert.equal((await t.song()).id, s.id, 'arrows in the menu never switch songs');
  await t.page.keyboard.press('Escape');
  assert.equal(await menuOpen(), null, 'Esc closes');
  assert.equal(await t.ev(() => document.activeElement?.classList.contains('ev2-song-menubtn')), true, 'focus returns');
  await t.until(() => !document.body.dataset.dialogOpen);
  assert.equal(await t.ev(() => window.__panics), 0, 'Esc never panics');
  // ↓ on the button opens it; an outside click closes it
  await t.page.keyboard.press('ArrowDown');
  assert.equal(await menuOpen(), 'menu');
  await t.click(`${H} .ev2-song-live`);
  assert.equal(await menuOpen(), null, 'outside click closes');

  // Duplicate
  await t.click(btn);
  await t.click('.ev2-song-pop [data-act="duplicate"]');
  await t.until((n) => Object.values(window.__rig.store.get().songs).some((x) => x.name === `${n} (copy)`), s.name);
  assert.ok((await toasts()).includes(`Duplicated “${s.name}”`));
  // Rename focuses the name
  await t.click(btn);
  await t.click('.ev2-song-pop [data-act="rename"]');
  await t.until(() => document.activeElement?.classList.contains('ev2-song-name'));
  await t.page.keyboard.press('Escape');
  // Export song
  await t.click(btn);
  const [dl] = await Promise.all([
    t.page.waitForEvent('download', { timeout: 15000 }),
    t.click('.ev2-song-pop [data-act="export"]'),
  ]);
  assert.match(dl.suggestedFilename(), /\.rig-song\.json$/);
  const j = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  assert.equal(j.kind, 'song');
  assert.equal(j.song.id, s.id);
  assert.equal(await menuOpen(), null);
  t.assertNoConsoleErrors();
});

test('song-header: reset to factory (Glass Ocean) — confirm, Esc cancels, reverb back to 0.82', async () => {
  const H = t.host;
  const btn = `${H} .ev2-song-menubtn`;
  await t.selectSong('factory:glass-ocean');
  await t.until(() => document.querySelector('.ev2-song-name').value === 'Glass Ocean');
  await t.setParam('fx.reverb.size', 0.1);
  await t.untilEngine('fx.reverb.size', 0.1, 0.002);
  await t.click(btn);
  await t.click('.ev2-song-pop [data-act="reset"]');
  assert.equal(await menuOpen(), 'alertdialog');
  assert.match(await t.page.textContent('.ev2-song-pop'),
    /Put this song’s sound back to the factory version\? The key and notes stay\./);
  assert.equal(await t.ev(() => document.activeElement?.dataset.act), 'cancel', 'Cancel focused on open');
  assert.equal(await t.ev(() => document.body.dataset.dialogOpen), '1');
  await t.page.keyboard.press('Escape');
  assert.equal(await menuOpen(), null, 'Esc cancels');
  assert.ok(Math.abs((await t.readParam('fx.reverb.size')) - 0.1) < 0.002, 'nothing changed before the confirm');
  assert.equal(await t.ev(() => window.__panics), 0);
  await t.click(btn);
  await t.click('.ev2-song-pop [data-act="reset"]');
  await t.click('.ev2-song-pop [data-act="reset-go"]');
  await t.until(() => Math.abs(window.__rig.store.currentSong().patch.fx.reverb.size - 0.82) < 1e-9);
  await t.untilEngine('fx.reverb.size', 0.82, 0.002);
  assert.ok((await toasts()).includes('“Glass Ocean” reset to factory'));
  await t.click(btn);
  await t.click('.ev2-song-pop [data-act="reset"]');
  await t.click('.ev2-song-pop [data-act="reset-go"]');
  await t.until(() => window.__rig.toasts.some((x) => x.msg === 'Already the factory sound'));
  t.assertNoConsoleErrors();
});

test('song-header: Delete song… (confirm; Cancel keeps it) and no Reset for a non-factory song', async () => {
  const H = t.host;
  const btn = `${H} .ev2-song-menubtn`;
  const id = await t.ev(() => window.__rig.store.addSong(null, { select: true, name: 'Scratch Song' }));
  await t.until((i) => window.__rig.controller.status.songId === i && !window.__rig.controller.status.loading, id,
    30000);
  await t.until(() => document.querySelector('.ev2-song-name').value === 'Scratch Song');
  await t.click(btn);
  assert.equal(await t.page.$('.ev2-song-pop [data-act="reset"]'), null, 'no Reset to factory… for own songs');
  await t.click('.ev2-song-pop [data-act="delete"]');
  assert.equal(await menuOpen(), 'alertdialog');
  assert.match(await t.page.textContent('.ev2-song-pop'), /Delete “Scratch Song” from your library\?/);
  await t.click('.ev2-song-pop [data-act="cancel"]');
  assert.equal(await menuOpen(), null);
  assert.ok(await t.ev((i) => !!window.__rig.store.getSong(i), id), 'Cancel keeps the song');
  await t.click(btn);
  await t.click('.ev2-song-pop [data-act="delete"]');
  await t.click('.ev2-song-pop [data-act="delete-go"]');
  await t.until((i) => !window.__rig.store.getSong(i), id);
  assert.ok((await toasts()).includes('Deleted “Scratch Song”'));
  await t.until((i) => window.__rig.store.currentSong()?.id !== i
    && document.querySelector('.ev2-song-name').value === window.__rig.store.currentSong().name, id);
  t.assertNoConsoleErrors();
});

test('song-header: 1024×700 — ☰ Songs toggles the drawer, compact row fits, menu stays on screen', async () => {
  // the same page, resized: a second mount doubles the boot cost on the loaded box, and the ≤ 1250 rules are CSS
  const u = t;
  await u.page.setViewportSize({ width: 1024, height: 700 });
  const H = u.host;
  const vis = (sel) => u.ev((s) => !!document.querySelector(s)?.checkVisibility(), sel);
  assert.equal(await vis(`${H} [data-drawer-toggle]`), true);
  assert.equal(await vis(`${H} .ev2-song-livehint`), false, 'live hint hidden ≤ 1250');
  assert.equal(await vis(`${H} .ev2-song-menubtn`), true, '⋯ stays reachable');
  await u.click(`${H} [data-drawer-toggle]`);
  assert.equal(await u.ev(() => window.__rig.view.editState.drawer), true);
  assert.equal(await u.page.getAttribute(`${H} [data-drawer-toggle]`, 'aria-expanded'), 'true');
  await u.click(`${H} [data-drawer-toggle]`);
  assert.equal(await u.ev(() => window.__rig.view.editState.drawer), false);
  const o = await u.ev(() => {
    const bad = [];
    for (const e of document.querySelectorAll('#view-edit .ev2, #view-edit .ev2 *')) {
      if (e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible') bad.push(e.className);
    }
    const head = document.querySelector('.ev2-song-head');
    const last = document.querySelector('.ev2-song-menubtn').getBoundingClientRect();
    return {
      page: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      bad,
      fits: last.right <= head.getBoundingClientRect().right + 1,
      height: document.querySelector('.ev2-head').getBoundingClientRect().height,
    };
  });
  assert.ok(o.page, 'page does not scroll sideways');
  assert.deepEqual(o.bad, []);
  assert.ok(o.fits, 'the ⋯ button is not clipped');
  assert.equal(Math.round(o.height), 48, 'header row is 48 px at ≤ 1250');
  await u.screenshot('song-header-1024');
  await u.click(`${H} .ev2-song-menubtn`);
  const r = await u.ev(() => {
    const b = document.querySelector('.ev2-song-pop').getBoundingClientRect();
    return { left: b.left, right: b.right, bottom: b.bottom, w: innerWidth, h: innerHeight };
  });
  assert.ok(r.left >= 0 && r.right <= r.w && r.bottom <= r.h, `menu on screen ${JSON.stringify(r)}`);
  await u.page.screenshot({ path: new URL('../screenshots/song-header-menu-1024.png', import.meta.url).pathname });
  u.assertNoConsoleErrors();
});
