// OWNER: shell / integrator (views/edit/CONTRACT.md §6). The H-v2 Edit shell with whatever panels are registered:
// layout, tab row (tablist pattern, summaries, off/empty state, changed dots), Show wiring, selection → panel host,
// Wheels & pedal, Esc, 1440/1024 layout. Panel behaviour is tested in panels/*.test.mjs.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mountPanelForTest, shutdown } from './harness.mjs';

let t;
before(async () => {
  t = await mountPanelForTest(null, { full: true });
});
after(async () => {
  await t?.close();
  await shutdown();
});

const tabSel = (id) => `#view-edit .ev2-tab[data-block="${id}"]`;

test('shell: regions + 7 tabs mounted; Keys selected; panel labelled by its tab', async () => {
  const r = await t.ev(() => ({
    mounted: window.__rig.view._debug.mounted(),
    tabs: [...document.querySelectorAll('#view-edit .ev2-tab')].map((x) => x.dataset.block),
    roles: [...document.querySelectorAll('#view-edit .ev2-tab-role')].map((x) => x.textContent),
    sel: document.querySelector('#view-edit .ev2-tab[aria-selected="true"]')?.dataset.block,
    labelledBy: document.getElementById('ev2-panel').getAttribute('aria-labelledby'),
    role: document.getElementById('ev2-panel').getAttribute('role'),
  }));
  assert.deepEqual(r.mounted.sort(), ['bottom', 'setlist', 'slot', 'song-header'].sort());
  assert.deepEqual(r.tabs, ['slot:0', 'slot:1', 'slot:2', 'slot:3', 'drone', 'effects', 'master']);
  assert.deepEqual(r.roles, ['KEYS', 'PAD', 'EXTRA', 'BASS', 'DRONE', 'EFFECTS', 'MASTER']);
  assert.equal(r.sel, 'slot:0');
  assert.equal(r.role, 'tabpanel');
  assert.equal(r.labelledBy, 'ev2-tab-slot-0');
  t.assertNoConsoleErrors();
});

test('shell: arrow keys move the selection (tablist pattern) and remount the panel', async () => {
  await t.page.focus(tabSel('slot:0'));
  await t.page.keyboard.press('ArrowRight');
  await t.until(() => window.__rig.view.editState.selected === 'slot:1');
  assert.equal(await t.ev(() => document.activeElement?.dataset?.block), 'slot:1');
  assert.equal(await t.page.getAttribute(tabSel('slot:1'), 'aria-selected'), 'true');
  assert.equal(await t.page.getAttribute(tabSel('slot:1'), 'tabindex'), '0');
  assert.equal(await t.page.getAttribute(tabSel('slot:0'), 'tabindex'), '-1');
  await t.page.keyboard.press('End');
  await t.until(() => window.__rig.view.editState.selected === 'master');
  await t.until(() => window.__rig.view._debug.mounted().includes('master'));
  assert.equal(await t.page.getAttribute('#ev2-panel', 'aria-labelledby'), 'ev2-tab-master');
  await t.page.keyboard.press('ArrowRight'); // wraps
  await t.until(() => window.__rig.view.editState.selected === 'slot:0');
  await t.page.keyboard.press('ArrowLeft');
  await t.until(() => window.__rig.view.editState.selected === 'master');
  await t.page.keyboard.press('Home');
  await t.until(() => window.__rig.view.editState.selected === 'slot:0');
  await t.ev(() => document.activeElement?.blur());
});

test('shell: "Wheels & pedal" selects Master with focus "wheels"; header can select the song block', async () => {
  await t.click('#view-edit .ev2-wheels');
  await t.until(() => window.__rig.view.editState.selected === 'master' && window.__rig.view.editState.opts.focus === 'wheels');
  await t.select('song', { focus: 'notes' });
  await t.until(() => window.__rig.view._debug.mounted().includes('song'));
  assert.equal(await t.ev(() => document.querySelector('#view-edit .ev2-tab[aria-selected="true"]')), null, 'no tab selected for the song block');
  assert.equal(await t.page.getAttribute('#ev2-panel', 'aria-label'), 'Song');
  await t.click(tabSel('slot:0'));
  await t.until(() => window.__rig.view.editState.selected === 'slot:0');
});

test('shell: tab summaries, off (muted) and empty slots', async () => {
  const s = await t.song();
  const names = await t.ev(() => [...document.querySelectorAll('#view-edit .ev2-tab-name-text')].map((x) => x.textContent));
  for (let i = 0; i < 4; i++) {
    const empty = !s.patch.slots[i];
    assert.equal(await t.ev((sel) => document.querySelector(sel).classList.contains('empty'), tabSel(`slot:${i}`)), empty, `slot ${i} empty`);
    if (empty) assert.equal(names[i], '+ Add a sound');
  }
  assert.match(names[6], /dB$/, 'master tab shows the master level');
  const i = s.patch.slots.findIndex(Boolean);
  await t.setParam(`slots.${i}.muted`, true);
  await t.until((sel) => document.querySelector(sel).classList.contains('off'), tabSel(`slot:${i}`));
  await t.setParam(`slots.${i}.muted`, false);
  await t.until((sel) => !document.querySelector(sel).classList.contains('off'), tabSel(`slot:${i}`));
});

test('shell: changed dot on a tab follows song-diff (octave yes, gain no); baseline getter wins for its song', async () => {
  const s = await t.song();
  const i = s.patch.slots.findIndex(Boolean);
  const cd = `${tabSel(`slot:${i}`)} .ev2-tab-cd`;
  assert.equal(await t.ev((sel) => document.querySelector(sel).hidden, cd), true);
  await t.setParam(`slots.${i}.gain`, 1.1);
  await t.sleep(80);
  assert.equal(await t.ev((sel) => document.querySelector(sel).hidden, cd), true, 'faders carry no dot');
  await t.setParam(`slots.${i}.octave`, 1);
  await t.until((sel) => !document.querySelector(sel).hidden, cd);
  assert.deepEqual(await t.ev(() => window.__rig.view._debug.changes()), [`patch.slots.${i}.octave`]);
  assert.equal(await t.ev(() => window.__rig.view.editState.changeCount(['patch.slots'])), 1);
  // an app baseline (perform.js savedSnapshot) for this song is used instead of the shell's own
  await t.ev(() => window.__rig.setBaseline(window.__rig.store.currentSong()));
  await t.setParam(`slots.${i}.gain`, 1.0); // any store change recomputes
  await t.until((sel) => document.querySelector(sel).hidden, cd);
  await t.ev(() => window.__rig.setBaseline(null));
  await t.setParam(`slots.${i}.octave`, 0);
  await t.setParam(`slots.${i}.gain`, s.patch.slots[i].gain);
  await t.until((sel) => document.querySelector(sel).hidden, cd);
});

test('shell: Show wiring shows Math.round(sends × 100) per slot and lane, and never writes the store', async () => {
  const before = JSON.stringify(await t.song());
  await t.click('#view-edit .ev2-wiretog');
  await t.until(() => !document.querySelector('#view-edit .ev2-wire').hidden);
  assert.equal(await t.page.getAttribute('#view-edit .ev2-wiretog', 'aria-checked'), 'true');
  const s = await t.song();
  const cells = await t.ev(() => [...document.querySelectorAll('#view-edit .ev2-wv[data-slot]')].map((x) => ({
    lane: x.dataset.lane, slot: Number(x.dataset.slot), value: Number(x.dataset.value), text: x.textContent,
  })));
  const filled = s.patch.slots.filter(Boolean).length;
  assert.equal(cells.length, filled * 3);
  for (const c of cells) {
    const want = Math.round(s.patch.slots[c.slot].sends[c.lane] * 100);
    assert.equal(c.value, want, `${c.lane} slot ${c.slot}`);
    assert.equal(c.text, want === 0 ? '–' : `${want}%`);
  }
  // live update
  const i = s.patch.slots.findIndex(Boolean);
  await t.setParam(`slots.${i}.sends.reverb`, 0.75);
  await t.until((sel) => document.querySelector(sel)?.textContent === '75%', `#view-edit .ev2-wv[data-lane="reverb"][data-slot="${i}"]`);
  await t.setParam(`slots.${i}.sends.reverb`, s.patch.slots[i].sends.reverb);
  await t.screenshot('shell-1440-wiring');
  await t.click('#view-edit .ev2-wiretog');
  await t.until(() => document.querySelector('#view-edit .ev2-wire').hidden);
  assert.equal(JSON.stringify(await t.song()), before, 'toggling wiring wrote nothing');
});

test('shell: Esc in Edit never panics; a held note survives', async () => {
  const p0 = await t.ev(() => {
    window.__panics = { n: 0 };
    window.__rig.controller.addEventListener('action', (e) => {
      if (e.detail && e.detail.type === 'panic') window.__panics.n += 1;
    });
    window.__rig.controller.perform.noteOn(62, 100);
    return 0;
  });
  await t.page.keyboard.press('Escape');
  await t.sleep(100);
  assert.equal(await t.ev(() => window.__panics.n), p0);
  assert.ok(await t.ev(() => window.__rig.controller._debug().held.some(([n]) => n === 62)));
  await t.ev(() => window.__rig.controller.perform.noteOff(62));
});

test('shell: song switch reaches every mounted module; layout fits at 1440×900 and 1024×700 (drawer)', async () => {
  const other = await t.ev(() => window.__rig.store.get().songOrder.find((x) => x !== window.__rig.store.currentSong().id));
  await t.selectSong(other);
  await t.until((id) => [...document.querySelectorAll('#view-edit .ev2-stub')].every((x) => x.dataset.songId === id), other);
  for (const [w, h] of [[1440, 900], [1024, 700]]) {
    await t.page.setViewportSize({ width: w, height: h });
    await t.sleep(200);
    const r = await t.ev(() => ({
      page: document.documentElement.scrollWidth - innerWidth,
      tabs: [...document.querySelectorAll('#view-edit .ev2-tab')].map((x) => x.getBoundingClientRect().bottom),
      left: getComputedStyle(document.querySelector('#view-edit .ev2-left')).display,
    }));
    assert.ok(r.page <= 1, `no horizontal overflow at ${w}×${h}`);
    assert.ok(Math.max(...r.tabs) < h - 200, `tabs visible at ${w}×${h}`);
    if (w === 1024) {
      assert.equal(r.left, 'none', 'setlist is a drawer at 1024');
      await t.ev(() => window.__rig.view.editState.setDrawer(true));
      assert.notEqual(await t.ev(() => getComputedStyle(document.querySelector('#view-edit .ev2-left')).display), 'none');
      await t.page.keyboard.press('Escape');
      await t.until(() => !window.__rig.view.editState.drawer);
    }
    await t.screenshot(`shell-${w}`);
  }
  await t.page.setViewportSize({ width: 1440, height: 900 });
  t.assertNoConsoleErrors();
});

test('shell: destroy() cleans up and a remount works', async () => {
  const r = await t.ev(async () => {
    const { view, shell, ctx } = window.__rig;
    const host = document.getElementById('view-edit');
    view.destroy();
    const empty = host.childElementCount === 0 && !host.classList.contains('ev2-host');
    window.__rig.view = shell.mountEdit(host, ctx);
    return { empty, tabs: document.querySelectorAll('#view-edit .ev2-tab').length };
  });
  assert.equal(r.empty, true);
  assert.equal(r.tabs, 7);
  t.assertNoConsoleErrors();
});
