// OWNER: setlist agent (views/edit/CONTRACT.md §6). Tests for panels/setlist.js; run alone with
//   node test/phase2/edit-v2/run.mjs --only setlist      (or: node --test-reporter=spec test/phase2/edit-v2/panels/setlist.test.mjs)
// Keep the harness smoke test first; replace the stub test with the panel's behaviour tests (CONTRACT.md §6 checklist).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mountPanelForTest, smoke, shutdown } from '../harness.mjs';

after(shutdown);

test('setlist: harness smoke (mount, ctx fields, store → engine, no console errors)', async () => {
  const t = await mountPanelForTest('setlist');
  try {
    await smoke(t);
    await t.screenshot('setlist-1440');
  } finally {
    await t.close();
  }
});

test('setlist: stub follows the current song (DELETE when the real panel lands)', async () => {
  const t = await mountPanelForTest('setlist');
  try {
    const box = `${t.host} .ev2-stub[data-stub="setlist"]`;
    const id0 = await t.ev(() => window.__rig.store.currentSong().id);
    assert.equal(await t.page.getAttribute(box, 'data-song-id'), id0);
    const other = await t.ev(() => window.__rig.store.get().songOrder.find((x) => x !== window.__rig.store.currentSong().id));
    await t.selectSong(other);
    await t.until(([sel, want]) => document.querySelector(sel)?.dataset.songId === want, [box, other]);
    t.assertNoConsoleErrors();
  } finally {
    await t.close();
  }
});
