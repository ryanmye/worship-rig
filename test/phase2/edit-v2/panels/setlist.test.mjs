// OWNER: setlist agent (views/edit/CONTRACT.md §6). Tests for panels/setlist.js (region 'left').
// Run alone: node test/phase2/edit-v2/run.mjs --only setlist
// (or node --test --test-reporter=spec <this file>).
// Ports the ui-edit tests "song search", "setlist gap", "add song from factory", "reorder", "rename inline, duplicate,
// delete", "setlist: new + select + delete", "export library → re-import", "round2-ui #7" and the M1 Esc/dialog-flag
// checks. One shared single-panel mount runs the tests in order (they build on each other like the ui-edit run);
// the drawer/layout test mounts the whole view.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mountPanelForTest, smoke, shutdown } from '../harness.mjs';

let t;
before(async () => {
  t = await mountPanelForTest('setlist');
});
after(async () => {
  await t?.close();
  await shutdown();
});

const H = '#view-edit [data-panel="setlist"]';
const row = (i) => `${H} .ev2-list-row[data-index="${i}"]`;
const rowId = (id) => `${H} .ev2-list-row[data-id="${id}"]`;
const setIds = () => t.ev(() => window.__rig.store.currentSetlist().songIds.slice());
const cur = () => t.ev(() => window.__rig.store.get().settings.currentSongId);
const loadedIn = (h, id) => h.until((i) => {
  const st = window.__rig.controller.status;
  return st.songId === i && !st.loading;
}, id, 30000);
const loaded = (id) => loadedIn(t, id);
/** Wait for a toast whose text matches `src` (a RegExp source) and, optionally, `kind`. */
const toastSeen = (src, kind = '') => t.until(([re, k]) => [...document.querySelectorAll(`#toasts .toast${k}`)]
  .some((x) => new RegExp(re).test(x.textContent)), [src, kind ? `.${kind}` : '']);
/** Count controller 'panic' actions from now on; returns a reader. */
async function panicCounter() {
  await t.ev(() => {
    if (window.__panics) return;
    window.__panics = { n: 0 };
    window.__rig.controller.addEventListener('action', (e) => {
      if (e.detail && e.detail.type === 'panic') window.__panics.n += 1;
    });
  });
  return () => t.ev(() => window.__panics.n);
}

test('setlist: harness smoke (mount, ctx fields, store → engine, no console errors)', async () => {
  await smoke(t);
  await t.screenshot('setlist-single');
});

test('setlist: rows (number, name, key), current highlight, click/Enter select, ↑/↓/Home/End focus', async () => {
  const r = await t.ev(async (host) => {
    const { keyName } = await import('/app/js/shared/music.js');
    const st = window.__rig.store;
    const ids = st.currentSetlist().songIds;
    const rows = [...document.querySelectorAll(`${host} .ev2-list-row`)];
    return {
      n: rows.length,
      ids: rows.map((x) => x.dataset.id),
      nums: rows.map((x) => x.querySelector('.ev2-list-num').textContent),
      names: rows.map((x) => x.querySelector('.ev2-list-name').textContent),
      keys: rows.map((x) => x.querySelector('.ev2-list-key').textContent),
      wantNames: ids.map((id) => st.getSong(id).name),
      wantKeys: ids.map((id) => keyName(st.getSong(id).hearIn, st.getSong(id).minor)),
      want: ids,
      role: document.querySelector(`${host} .ev2-list-songs`).getAttribute('role'),
      label: document.querySelector(`${host} .ev2-list-songs`).getAttribute('aria-label'),
      on: [...document.querySelectorAll(`${host} .ev2-list-row.on`)].map((x) => x.dataset.index),
      selected: [...document.querySelectorAll(`${host} .ev2-list-row[aria-selected="true"]`)]
        .map((x) => x.dataset.index),
      keep: rows.every((x) => x.hasAttribute('data-keep-focus') && x.getAttribute('role') === 'option'),
      setName: st.currentSetlist().name,
    };
  }, H);
  assert.deepEqual(r.ids, r.want);
  assert.deepEqual(r.names, r.wantNames);
  assert.deepEqual(r.keys, r.wantKeys);
  assert.deepEqual(r.nums, r.want.map((_, i) => String(i + 1)));
  assert.equal(r.role, 'listbox');
  assert.equal(r.label, `Songs in “${r.setName}”`);
  assert.deepEqual(r.on, ['0']);
  assert.deepEqual(r.selected, ['0']);
  assert.ok(r.keep, 'rows are role=option with data-keep-focus');

  // click a row → controller.selectSong; the highlight follows
  const ids = await setIds();
  await t.click(`${row(2)} .ev2-list-name`);
  await t.until((id) => window.__rig.store.get().settings.currentSongId === id, ids[2]);
  await loaded(ids[2]);
  await t.until((sel) => document.querySelector(`${sel}.on`)?.getAttribute('aria-selected') === 'true', row(2));
  assert.equal(await t.ev(() => document.activeElement?.dataset?.index), '2', 'a clicked row keeps focus');
  // ↓ moves focus (never nudges the mod wheel), Enter opens
  const wheel = await t.ev(() => window.__rig.controller._debug().virtualWheel);
  await t.page.keyboard.press('ArrowDown');
  assert.equal(await t.ev(() => document.activeElement.dataset.index), '3');
  const wheelNow = await t.ev(() => window.__rig.controller._debug().virtualWheel);
  assert.equal(wheelNow, wheel, 'plain ↓ does not move the wheel');
  await t.page.keyboard.press('Enter');
  await t.until((id) => window.__rig.store.get().settings.currentSongId === id, ids[3]);
  await loaded(ids[3]);
  await t.page.keyboard.press('End');
  assert.equal(await t.ev(() => document.activeElement.dataset.index), String(ids.length - 1));
  await t.page.keyboard.press('Home');
  assert.equal(await t.ev(() => document.activeElement.dataset.index), '0');
  // back to the first song for the tests below
  await t.page.keyboard.press('Enter');
  await t.until((id) => window.__rig.store.get().settings.currentSongId === id, ids[0]);
  await loaded(ids[0]);
  await t.ev(() => document.activeElement?.blur());
  t.assertNoConsoleErrors();
});

test('setlist: row focus survives a re-render; a half-typed rename survives one too', async () => {
  const ids = await setIds();
  await t.page.focus(row(3));
  await t.ev((id) => window.__rig.store.set(`songs.${id}.name`, 'Renamed Elsewhere'), ids[0]);
  await t.until((sel) => document.querySelector(`${sel} .ev2-list-name`).textContent === 'Renamed Elsewhere', row(0));
  assert.equal(await t.ev(() => document.activeElement?.dataset?.index), '3', 'focus kept on row 3');
  // start renaming row 1, type, then a store change re-renders the list
  const name1 = await t.ev((id) => window.__rig.store.getSong(id).name, ids[1]);
  await t.page.keyboard.press('ArrowUp');
  await t.page.keyboard.press('ArrowUp');
  assert.equal(await t.ev(() => document.activeElement.dataset.index), '1');
  await t.page.keyboard.press('F2');
  await t.until(() => document.activeElement?.classList.contains('ev2-list-rename'));
  await t.page.keyboard.type('Half');
  await t.ev((id) => window.__rig.store.set(`songs.${id}.name`, 'First Song'), ids[0]);
  await t.until((sel) => document.querySelector(`${sel} .ev2-list-name`).textContent === 'First Song', row(0));
  await t.until(() => document.activeElement?.classList.contains('ev2-list-rename'));
  assert.equal(await t.ev(() => document.activeElement.value), 'Half', 'typed text kept');
  assert.equal(await t.ev((id) => window.__rig.store.getSong(id).name, ids[1]), name1, 'nothing committed yet');
  // Esc cancels (data-own-escape: never Panic), focus back on the row
  await t.page.keyboard.press('Escape');
  await t.until(() => !document.querySelector('.ev2-list-rename') && document.activeElement?.dataset?.index === '1');
  assert.equal(await t.ev((id) => window.__rig.store.getSong(id).name, ids[1]), name1);
  await t.ev(() => document.activeElement?.blur());
  t.assertNoConsoleErrors();
});

test('setlist: rename inline, duplicate, delete with confirm (ui-edit port) + double-click rename', async () => {
  // row actions show on hover / focus (like the Finder), so hover first as a user would
  await t.page.hover(row(0));
  await t.click(`${row(0)} [data-act="rename"]`);
  await t.page.fill(`${H} .ev2-list-rename`, 'Opener');
  await t.page.press(`${H} .ev2-list-rename`, 'Enter');
  await t.until(() => window.__rig.store.getSong(window.__rig.store.currentSetlist().songIds[0]).name === 'Opener');
  const n = (await setIds()).length;
  await t.page.hover(row(0));
  await t.click(`${row(0)} [data-act="dup"]`);
  await t.until((k) => window.__rig.store.currentSetlist().songIds.length === k + 1, n);
  const dupId = (await setIds())[1];
  assert.equal(await t.ev((id) => window.__rig.store.getSong(id).name, dupId), 'Opener (copy)');
  await toastSeen('Duplicated “Opener”');
  // double-click the name → inline rename; Enter commits
  await t.page.dblclick(`${rowId(dupId)} .ev2-list-name`);
  await t.page.fill(`${H} .ev2-list-rename`, 'Opener Two');
  await t.page.press(`${H} .ev2-list-rename`, 'Enter');
  await t.until((id) => window.__rig.store.getSong(id).name === 'Opener Two', dupId);
  // delete: nothing changes before the confirm
  await t.page.hover(rowId(dupId));
  await t.click(`${rowId(dupId)} [data-act="del"]`);
  assert.ok(await t.page.$(`${rowId(dupId)}.confirming`));
  assert.equal((await setIds()).length, n + 1, 'nothing deleted before confirm');
  await t.click(`${rowId(dupId)} [data-confirm="delete"]`);
  await t.until((id) => !window.__rig.store.getSong(id), dupId);
  assert.equal((await setIds()).length, n);
  await toastSeen('Deleted “Opener Two”');
  t.assertNoConsoleErrors();
});

test('setlist: M1 — Delete key → confirm (Cancel focused, dialog flag); Esc closes it, never panics', async () => {
  const panics = await panicCounter();
  const p0 = await panics();
  await t.ev(() => window.__rig.controller.perform.noteOn(62, 100));
  const ids = await setIds();
  // Delete key on a focused row
  await t.page.focus(row(1));
  await t.page.keyboard.press('Delete');
  await t.until(() => !!document.querySelector('.ev2-list-row.confirming'));
  assert.equal(await t.ev(() => document.body.dataset.dialogOpen), '1');
  assert.match(await t.page.textContent(`${H} .ev2-list-row.confirming .ev2-list-q`),
    /Remove “.+” from this set, or delete it from your library everywhere\?/);
  assert.equal(await t.page.getAttribute(`${H} .ev2-list-row.confirming`, 'aria-selected'), 'true');
  await t.until(() => document.activeElement?.dataset?.confirm === 'cancel');
  assert.deepEqual(await t.ev(() => [...document.querySelectorAll('.ev2-list-row.confirming [data-confirm]')]
    .map((b) => b.textContent)), ['Remove from set', 'Delete song', 'Cancel']);
  await t.page.keyboard.press('Escape');
  await t.until(() => !document.querySelector('.ev2-list-row.confirming'));
  await t.until(() => document.body.dataset.dialogOpen === undefined);
  assert.equal(await t.ev(() => document.activeElement?.dataset?.index), '1', 'focus back on the row');
  // hover ✕ → confirm; Cancel button closes it too
  await t.page.hover(row(1));
  await t.click(`${row(1)} [data-act="del"]`);
  await t.click(`${H} .ev2-list-row.confirming [data-confirm="cancel"]`);
  await t.until(() => !document.querySelector('.ev2-list-row.confirming')
    && document.body.dataset.dialogOpen === undefined);
  // setlist delete confirm
  await t.click(`${H} button[title="Delete setlist"]`);
  await t.until(() => !document.querySelector('.ev2-list-confirm').hidden && document.body.dataset.dialogOpen === '1');
  assert.match(await t.page.textContent(`${H} .ev2-list-confirm`),
    /Delete the setlist “.+”\? Its songs stay in your library\./);
  assert.equal(await t.ev(() => document.activeElement?.dataset?.confirm), 'cancel');
  await t.page.keyboard.press('Escape');
  await t.until(() => document.querySelector('.ev2-list-confirm').hidden
    && document.body.dataset.dialogOpen === undefined);
  // nothing open: Esc is still not Panic inside Edit
  await t.ev(() => document.activeElement?.blur?.());
  await t.page.keyboard.press('Escape');
  await t.sleep(100);
  assert.equal(await panics(), p0, 'no panic from Esc in Edit');
  assert.ok(await t.ev(() => window.__rig.controller._debug().held.some(([k]) => k === 62)), 'held note survives Esc');
  assert.deepEqual(await setIds(), ids, 'nothing removed');
  assert.ok(await t.ev(() => window.__rig.store.get().setlistOrder.length >= 1), 'nothing deleted');
  await t.ev(() => window.__rig.controller.perform.noteOff(62));
  // in the library ("All songs") the confirm is delete-only
  const set0 = await t.ev(() => window.__rig.store.get().settings.currentSetlistId);
  await t.page.selectOption(`${H} .ev2-list-select`, '');
  await t.until(() => window.__rig.store.get().settings.currentSetlistId === null);
  await t.page.focus(row(2));
  await t.page.keyboard.press('Backspace');
  await t.until(() => !!document.querySelector('.ev2-list-row.confirming'));
  assert.match(await t.page.textContent(`${H} .ev2-list-row.confirming .ev2-list-q`),
    /^Delete “.+” from your library\?$/);
  assert.equal(await t.page.$(`${H} .ev2-list-row.confirming [data-confirm="remove"]`), null);
  await t.page.keyboard.press('Escape');
  await t.until(() => !document.querySelector('.ev2-list-row.confirming'));
  await t.page.selectOption(`${H} .ev2-list-select`, set0);
  await t.until((c) => window.__rig.store.get().settings.currentSetlistId === c, set0);
  t.assertNoConsoleErrors();
});

test('setlist: song search appears for > 8 songs and filters rows (ui-edit port)', async () => {
  const set0 = await t.ev(() => window.__rig.store.get().settings.currentSetlistId);
  await t.page.selectOption(`${H} .ev2-list-select`, '');
  await t.until(() => !document.querySelector('.ev2-list-search').hidden);
  assert.equal(await t.page.getAttribute(`${H} .ev2-list-search`, 'data-own-escape'), '');
  assert.equal(await t.page.getAttribute(`${H} .ev2-list-songs`, 'aria-label'), 'All songs');
  await t.page.fill(`${H} .ev2-list-search`, 'organ');
  await t.until(() => {
    const vis = [...document.querySelectorAll('.ev2-list-row:not([hidden]) .ev2-list-name')].map((x) => x.textContent);
    return vis.length >= 1 && vis.every((x) => /organ/i.test(x));
  });
  // ↓ focuses the first shown row; Enter in the box opens it
  const first = await t.ev(() => document.querySelector('.ev2-list-row:not([hidden])').dataset.id);
  await t.page.press(`${H} .ev2-list-search`, 'ArrowDown');
  assert.equal(await t.ev(() => document.activeElement?.dataset?.id), first);
  await t.page.focus(`${H} .ev2-list-search`);
  await t.page.keyboard.press('Enter');
  await t.until((id) => window.__rig.store.get().settings.currentSongId === id, first);
  await loaded(first);
  // no match → the empty line
  await t.page.fill(`${H} .ev2-list-search`, 'zzzz');
  await t.until(() => document.querySelector('.ev2-list-empty')?.textContent === 'No songs match “zzzz”.');
  // Esc clears (and never panics)
  const panics = await panicCounter();
  const p0 = await panics();
  await t.page.press(`${H} .ev2-list-search`, 'Escape');
  await t.until(() => document.querySelector('.ev2-list-search').value === ''
    && [...document.querySelectorAll('.ev2-list-row')].every((r) => !r.hidden));
  assert.equal(await panics(), p0);
  await t.page.selectOption(`${H} .ev2-list-select`, set0);
  await t.until((c) => window.__rig.store.get().settings.currentSetlistId === c, set0);
  t.assertNoConsoleErrors();
});

test('setlist: removing the current song from the set shows where Next continues (setlistGap)', async () => {
  const r0 = await t.ev(() => {
    const st = window.__rig.store;
    const ids = st.currentSetlist().songIds;
    return { id: ids[1], next: st.getSong(ids[2]).name, setId: st.currentSetlist().id };
  });
  await t.click(`${row(1)} .ev2-list-name`);
  await t.until((id) => window.__rig.store.get().settings.currentSongId === id, r0.id);
  await loaded(r0.id);
  await t.page.hover(row(1));
  await t.click(`${row(1)} [data-act="del"]`);
  await t.click(`${H} .ev2-list-row.confirming [data-confirm="remove"]`);
  await t.until(() => window.__rig.store.get().settings.setlistGap === true);
  await t.until((n) => !document.querySelector('.ev2-list-gapnote').hidden
    && document.querySelector('.ev2-list-gapnote').textContent
      === `The song you were on was removed from this set. Next plays “${n}”.`, r0.next);
  assert.equal(await t.page.textContent(`${H} .ev2-list-songs .ev2-list-gap`), 'removed — Next continues here');
  assert.equal(await t.ev(() => document.querySelector('.ev2-list-gap').nextElementSibling.dataset.index), '1');
  assert.equal(await t.page.$(`${H} .ev2-list-row.on`), null, 'no row claims to be current');
  assert.equal(await t.page.$(`${H} .ev2-list-row[aria-selected="true"]`), null);
  // put it back where it was and select it again → gap cleared
  await t.ev(({ setId, id }) => {
    window.__rig.store.addToSetlist(setId, id, 1);
    window.__rig.controller.selectSong(id, { index: 1 });
  }, r0);
  await t.until(() => document.querySelector('.ev2-list-gapnote').hidden && !document.querySelector('.ev2-list-gap'));
  await loaded(r0.id);
  t.assertNoConsoleErrors();
});

test('setlist: add song from the factory browser (ui-edit port) + round2-ui #7 headings', async () => {
  const before = (await setIds()).length;
  await t.click(`${H} [data-add="factory"]`);
  assert.equal(await t.page.getAttribute(`${H} [data-add="factory"]`, 'aria-expanded'), 'true');
  const heads = await t.ev(() => [...document.querySelectorAll('.ev2-list-bcat')].map((e) => e.textContent));
  assert.ok(heads.includes('Synth'), `headings: ${heads.join(', ')}`);
  assert.ok(!heads.some((x) => /^[a-z]/.test(x)), `no raw category ids: ${heads.join(', ')}`);
  assert.match(await t.page.textContent(`${H} [data-factory-id="factory:glass-ocean"] .ev2-list-bdesc`), /glassy pad/);
  const desc = await t.ev(async () => {
    const { FACTORY_SONGS } = await import('/app/js/presets.js');
    const { firstSentence } = await import('/app/js/views/edit/lib.js');
    const f = FACTORY_SONGS.find((x) => x.id === 'factory:glass-ocean');
    return firstSentence(f.notes);
  });
  assert.equal(await t.page.textContent(`${H} [data-factory-id="factory:glass-ocean"] .ev2-list-bdesc`), desc);
  await t.click(`${H} [aria-label="Add Glass Ocean"]`);
  await t.until((n) => window.__rig.store.currentSetlist().songIds.length === n + 1, before);
  const r = await t.ev(() => {
    const st = window.__rig.store;
    const ids = st.currentSetlist().songIds;
    const id = ids[ids.length - 1];
    return { id, name: st.getSong(id).name, factoryId: st.getSong(id).factoryId, cur: st.get().settings.currentSongId };
  });
  assert.equal(r.name, 'Glass Ocean');
  assert.equal(r.factoryId, 'factory:glass-ocean');
  assert.equal(r.cur, r.id);
  await t.until((id) => !!document.querySelector(`.ev2-list-row.on[data-id="${id}"]`), r.id);
  await loaded(r.id);
  await toastSeen('^Added “Glass Ocean”$');
  // Esc closes the browser
  await t.ev(() => document.activeElement?.blur?.());
  await t.page.keyboard.press('Escape');
  await t.until(() => document.querySelector('.ev2-list-browser[data-browser="factory"]').hidden);
  assert.equal(await t.page.getAttribute(`${H} [data-add="factory"]`, 'aria-expanded'), 'false');
  t.assertNoConsoleErrors();
});

test('setlist: "+ New" and the Library… browser (songs not in this set → addToSetlist)', async () => {
  const n0 = (await setIds()).length;
  // critics-fix (onboarding O12): each "New" says what it makes
  assert.equal((await t.page.textContent(`${H} [data-add="new"]`)).trim(), '+ New song');
  assert.equal((await t.page.textContent(`${H} button[title="New setlist"]`)).trim(), '+ Setlist');
  await t.click(`${H} [data-add="new"]`);
  await t.until((n) => window.__rig.store.currentSetlist().songIds.length === n + 1, n0);
  const newId = await t.ev(() => window.__rig.store.get().settings.currentSongId);
  assert.equal(await t.ev((id) => window.__rig.store.getSong(id).name, newId), 'New Song');
  assert.equal((await setIds()).at(-1), newId);
  await loaded(newId);
  // a library-only song shows up in the Library… browser
  const libId = await t.ev(() => window.__rig.store.addSong(null, { setlistId: null, name: 'Lib Only' }));
  await t.click(`${H} [data-add="library"]`);
  await t.until(() => !document.querySelector('.ev2-list-browser[data-browser="library"]').hidden);
  assert.ok(await t.page.$(`${H} [aria-label="Add Lib Only to setlist"]`));
  const inSet = await t.ev(() => {
    const ids = new Set(window.__rig.store.currentSetlist().songIds);
    return [...document.querySelectorAll('.ev2-list-browser[data-browser="library"] [data-song-id]')]
      .filter((x) => ids.has(x.dataset.songId)).length;
  });
  assert.equal(inSet, 0, 'only songs not in this set are offered');
  await t.click(`${H} [aria-label="Add Lib Only to setlist"]`);
  await t.until((id) => window.__rig.store.currentSetlist().songIds.at(-1) === id, libId);
  await t.until(() => !document.querySelector('[aria-label="Add Lib Only to setlist"]'));
  await t.until((id) => !!document.querySelector(`.ev2-list-row[data-id="${id}"]`), libId);
  // the close button closes it
  await t.click(`${H} .ev2-list-browser[data-browser="library"] .ev2-list-iconbtn`);
  await t.until(() => document.querySelector('.ev2-list-browser[data-browser="library"]').hidden);
  t.assertNoConsoleErrors();
});

test('setlist: reorder — Alt+↑ keyboard and drag-and-drop → store.moveSong order (ui-edit port)', async () => {
  const ids0 = await setIds();
  const n = ids0.length;
  await t.page.focus(row(n - 1));
  await t.page.keyboard.press('Alt+ArrowUp');
  await t.until(({ id, n: k }) => window.__rig.store.currentSetlist().songIds[k - 2] === id, { id: ids0[n - 1], n });
  await t.until((k) => document.activeElement?.dataset?.index === String(k - 2), n);
  // Alt+↓ moves it back down
  await t.page.keyboard.press('Alt+ArrowDown');
  await t.until(({ id, n: k }) => window.__rig.store.currentSetlist().songIds[k - 1] === id, { id: ids0[n - 1], n });
  await t.until((k) => document.activeElement?.dataset?.index === String(k - 1), n);
  await t.page.keyboard.press('Alt+ArrowUp');
  await t.until((k) => document.activeElement?.dataset?.index === String(k - 2), n);
  // plain ↑ moves focus only (and must not nudge the wheel)
  const wheel = await t.ev(() => window.__rig.controller._debug().virtualWheel);
  await t.page.keyboard.press('ArrowUp');
  assert.equal(await t.ev(() => document.activeElement.dataset.index), String(n - 3));
  assert.equal(await t.ev(() => window.__rig.controller._debug().virtualWheel), wheel);
  // drag row 0 onto the lower half of row 2 → lands at index 2
  const ids1 = await setIds();
  const box = await t.page.locator(row(2)).boundingBox();
  await t.page.dragAndDrop(`${row(0)} .ev2-list-num`, row(2), { targetPosition: { x: 40, y: box.height - 4 } });
  await t.until((id) => window.__rig.store.currentSetlist().songIds[2] === id, ids1[0]);
  const ids2 = await setIds();
  assert.deepEqual(ids2.slice(0, 3), [ids1[1], ids1[2], ids1[0]]);
  // drag it back onto the upper half of row 0 → index 0
  await t.page.dragAndDrop(`${row(2)} .ev2-list-num`, row(0), { targetPosition: { x: 40, y: 4 } });
  await t.until((id) => window.__rig.store.currentSetlist().songIds[0] === id, ids1[0]);
  assert.deepEqual((await setIds()).slice(0, 3), ids1.slice(0, 3));
  await t.ev(() => document.activeElement?.blur());
  t.assertNoConsoleErrors();
});

test('setlist: new (inline rename) + rename + select + delete (ui-edit port); empty state', async () => {
  const set0 = await t.ev(() => window.__rig.store.get().settings.currentSetlistId);
  await t.click(`${H} button[title="New setlist"]`);
  await t.until(() => document.activeElement?.getAttribute('aria-label') === 'Setlist name');
  assert.equal(await t.page.getAttribute(`${H} input[aria-label="Setlist name"]`, 'data-own-escape'), '');
  await t.page.fill(`${H} input[aria-label="Setlist name"]`, 'Sunday AM');
  await t.page.press(`${H} input[aria-label="Setlist name"]`, 'Enter');
  await t.until(() => window.__rig.store.currentSetlist()?.name === 'Sunday AM');
  assert.equal(await t.page.getAttribute(`${H} .ev2-list-songs`, 'aria-label'), 'Songs in “Sunday AM”');
  assert.equal(await t.page.textContent(`${H} .ev2-list-empty`), 'This setlist is empty — add songs below.');
  // Rename: Esc cancels, blur commits
  await t.click(`${H} button[title="Rename setlist"]`);
  await t.page.fill(`${H} input[aria-label="Setlist name"]`, 'Nope');
  await t.page.press(`${H} input[aria-label="Setlist name"]`, 'Escape');
  await t.until(() => document.querySelector('.ev2-list-setname').hidden);
  assert.equal(await t.ev(() => window.__rig.store.currentSetlist().name), 'Sunday AM');
  await t.click(`${H} button[title="Rename setlist"]`);
  await t.page.fill(`${H} input[aria-label="Setlist name"]`, 'Sunday PM');
  await t.ev(() => document.activeElement.blur());
  await t.until(() => window.__rig.store.currentSetlist()?.name === 'Sunday PM');
  // select another, then back, then delete (confirm)
  await t.page.selectOption(`${H} .ev2-list-select`, set0);
  await t.until((c) => window.__rig.store.get().settings.currentSetlistId === c, set0);
  const newId = await t.ev(() => Object.values(window.__rig.store.get().setlists)
    .find((s) => s.name === 'Sunday PM').id);
  await t.page.selectOption(`${H} .ev2-list-select`, newId);
  await t.until((c) => window.__rig.store.get().settings.currentSetlistId === c, newId);
  await t.click(`${H} button[title="Delete setlist"]`);
  assert.ok(await t.ev((id) => !!window.__rig.store.get().setlists[id], newId), 'nothing deleted before confirm');
  await t.click(`${H} .ev2-list-confirm [data-confirm="delete"]`);
  await t.until((id) => !window.__rig.store.get().setlists[id], newId);
  await t.until(() => document.body.dataset.dialogOpen === undefined);
  await t.page.selectOption(`${H} .ev2-list-select`, set0);
  await t.until((c) => window.__rig.store.get().settings.currentSetlistId === c, set0);
  t.assertNoConsoleErrors();
});

test('setlist: export library → JSON → re-import (merge); export song; bad file → toast (ui-edit port)', async () => {
  await t.click(`${H} details[data-sec="list-file"] > summary`);
  await t.until(() => document.querySelector('details[data-sec="list-file"]').open);
  assert.equal(await t.page.textContent(`${H} details[data-sec="list-file"] .ev2-sec-sum`), 'Export / import');
  const [dl] = await Promise.all([t.page.waitForEvent('download'), t.click(`${H} [data-file="export"]`)]);
  assert.match(dl.suggestedFilename(), /^Worship Rig library \d{4}-\d{2}-\d{2}\.json$/);
  const text = fs.readFileSync(await dl.path(), 'utf8');
  const doc = JSON.parse(text);
  assert.equal(doc.app, 'worship-rig');
  assert.equal(doc.kind, 'library');
  const n = await t.ev(() => window.__rig.store.get().songOrder.length);
  assert.equal(doc.songOrder.length, n);
  const [dls] = await Promise.all([t.page.waitForEvent('download'), t.click(`${H} [data-file="export-song"]`)]);
  const songName = await t.ev(() => window.__rig.store.currentSong().name);
  assert.equal(dls.suggestedFilename(), `${songName.replace(/[\\/:*?"<>|]+/g, '-')}.rig-song.json`);
  assert.equal(JSON.parse(fs.readFileSync(await dls.path(), 'utf8')).kind, 'song');
  const fileSel = `${H} details[data-sec="list-file"] input[type=file]`;
  await t.page.setInputFiles(fileSel, { name: 'lib.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await t.until((k) => window.__rig.store.get().songOrder.length === 2 * k, n);
  await toastSeen(`^Imported ${n} songs and 1 setlist$`);
  // a garbage file is refused with a message, not an exception
  await t.page.setInputFiles(fileSel, { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{nope') });
  await toastSeen('not valid JSON', 'error');
  t.assertNoConsoleErrors();
});

test('setlist: whole view — picking a song closes the ≤ 1250 px drawer; layout at 1440 and 1024', async () => {
  // last test: release the shared mount first (its running AudioContext costs CPU on the shared 2-CPU box)
  await t?.close();
  t = null;
  const f = await mountPanelForTest(null, { full: true });
  try {
    const left = '#view-edit .ev2 > .ev2-left';
    const fits = () => f.ev((sel) => {
      const el = document.querySelector(sel);
      const list = el.querySelector('.ev2-list-songs');
      return {
        page: document.documentElement.scrollWidth - innerWidth,
        host: el.scrollWidth - el.clientWidth,
        list: list.scrollWidth - list.clientWidth,
        width: el.getBoundingClientRect().width,
      };
    }, left);
    let r = await fits();
    assert.ok(r.page <= 1 && r.host <= 1 && r.list <= 1, `no horizontal overflow at 1440: ${JSON.stringify(r)}`);
    assert.ok(Math.abs(r.width - 252) <= 2, `column is 252 px wide: ${r.width}`);
    await f.screenshot('setlist-1440');
    await f.page.setViewportSize({ width: 1024, height: 700 });
    await f.sleep(200);
    assert.equal(await f.ev((sel) => getComputedStyle(document.querySelector(sel)).display, left), 'none');
    await f.ev(() => window.__rig.view.editState.setDrawer(true));
    await f.until((sel) => getComputedStyle(document.querySelector(sel)).display !== 'none', left);
    r = await fits();
    assert.ok(r.page <= 1 && r.host <= 1 && r.list <= 1, `no horizontal overflow in the drawer: ${JSON.stringify(r)}`);
    await f.screenshot('setlist-drawer-1024');
    const ids = await f.ev(() => window.__rig.store.currentSetlist().songIds.slice());
    await f.click(`${left} .ev2-list-row[data-index="2"] .ev2-list-name`);
    await f.until((id) => window.__rig.store.get().settings.currentSongId === id
      && !window.__rig.view.editState.drawer, ids[2]);
    await f.until((sel) => getComputedStyle(document.querySelector(sel)).display === 'none', left);
    // Esc closes a confirm first, then (next Esc) the drawer
    await f.ev(() => window.__rig.view.editState.setDrawer(true));
    await f.page.focus(`${left} .ev2-list-row[data-index="1"]`);
    await f.page.keyboard.press('Delete');
    await f.until(() => !!document.querySelector('.ev2-list-row.confirming'));
    await f.page.keyboard.press('Escape');
    await f.until(() => !document.querySelector('.ev2-list-row.confirming'));
    assert.equal(await f.ev(() => window.__rig.view.editState.drawer), true, 'the first Esc only closed the confirm');
    await f.page.keyboard.press('Escape');
    await f.until(() => !window.__rig.view.editState.drawer);
    await loadedIn(f, ids[2]);
    f.assertNoConsoleErrors();
  } finally {
    await f.close();
  }
});
