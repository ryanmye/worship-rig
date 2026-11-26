// UI v6 polish batch 1 (native/docs/lanes/UI6-build-plan.md "Queued small tasks"; review UI6-U7a O1–O3). Run from
// run.mjs on its page (the v6 Perform with the two bank packs), before the flag-off test.
//   O1 Esc typed in the browser's search box clears the search first; the next Esc closes the browser; neither panics;
//   O2 Back after the replaced setlist entry was removed during the trial: that song again, in the gap (Next = the
//      entry after the removed one, Prev = the one before), not another copy of it or outside the list;
//   O3 Export song (the song header's ⋯ menu and the library's Library file section) refuses a trial song: no file
//      with a `trial:` id, a "Keep it first" note; a library song still exports.

/**
 * @param {object} x  run.mjs's helpers: {T, page, ev, until, tid, settled, assert, closeBank, QUIET}
 */
export async function polish1BankTests(x) {
  const { T, page, ev, until, tid, settled, assert, closeBank, QUIET } = x;
  const armPanics = () => ev(() => {
    window.__p1panics = 0;
    if (window.__p1hooked) return;
    window.__p1hooked = true;
    window.__rig.controller.addEventListener('action', (e) => {
      if (e.detail?.type === 'panic') window.__p1panics += 1;
    });
  });

  await T('polish1 U7a O1: Esc in the search box clears it first, the next Esc closes the browser; no panic',
    async () => {
      await closeBank();
      await armPanics();
      await ev(() => window.__rig.ctx.openBank({ mode: 'bank' }));
      await until(() => window.__rig.views.v6.bank?.isOpen === true);
      const all = await ev(() => window.__rig.views.v6.bank.rows.length);
      await page.fill(tid('v6-bank-search'), 'river');
      await until((n) => window.__rig.views.v6.bank.rows.length < n, all);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
      const r = await ev(() => ({
        open: window.__rig.views.v6.bank.isOpen,
        q: document.querySelector('[data-testid="v6-bank-search"]').value,
        rows: window.__rig.views.v6.bank.rows.length,
        focus: document.activeElement?.dataset?.testid || document.activeElement?.tagName,
        panics: window.__p1panics,
      }));
      assert.deepEqual(r, { open: true, q: '', rows: all, focus: 'v6-bank-search', panics: 0 });
      await page.keyboard.press('Escape');
      await until(() => window.__rig.views.v6.bank.isOpen === false);
      await page.waitForTimeout(150);
      assert.equal(await ev(() => window.__p1panics), 0, 'the Esc that closes it does not panic');
      // an empty search box: one Esc closes (as before)
      await ev(() => window.__rig.ctx.openBank({ mode: 'bank', focus: true }));
      await until(() => document.activeElement?.dataset?.testid === 'v6-bank-search');
      await page.keyboard.press('Escape');
      await until(() => window.__rig.views.v6.bank.isOpen === false);
    });

  await T('polish1 U7a O2: Back after the replaced entry was removed: that song, in the gap (not another copy)',
    async () => {
      await closeBank();
      const set = await ev(async () => {
        const { store, controller } = window.__rig;
        const lib = store.get().songOrder.filter((id) => store.getSong(id));
        const [a, b, c] = lib;
        const prevList = store.get().settings.currentSetlistId ?? null;
        const sl = store.addSetlist('Polish reprise', [a, b, c, b]);
        store.setCurrentSetlist(sl);
        await controller.selectSong(b, { index: 1 });
        return { a, b, c, sl, prevList };
      });
      try {
        await settled();
        assert.equal(await ev(() => window.__rig.store.currentIndex()), 1);
        await ev((pid) => window.__rig.controller.tryBankSong(pid), QUIET);
        await until(() => window.__rig.controller.trial()?.playing === true);
        await settled();
        // the entry the trial replaced goes from the list while trying
        assert.equal(await ev((s) => window.__rig.store.removeFromSetlist(s.sl, 1), set), true);
        await page.click(tid('v6-try-back'));
        await until(() => !window.__rig.controller.trial());
        await settled();
        const r = await ev(() => {
          const { store } = window.__rig;
          const st = store.get().settings;
          const n = store.neighbors();
          return { cur: st.currentSongId, gap: st.setlistGap === true, at: st.setlistIndex, index: store.currentIndex(),
            prev: n.prev?.id ?? null, next: n.next?.id ?? null, nextAt: n.next?.index ?? null };
        });
        assert.deepEqual(r, { cur: set.b, gap: true, at: 1, index: -1, prev: set.a, next: set.c, nextAt: 1 },
          'the song it replaced, between A and C (as a removal while it played)');
        // the saved selection agrees
        await ev(() => window.__rig.store.persistNow());
        const saved = await ev(() => {
          const s = JSON.parse(localStorage.getItem('rig.v1')).settings;
          return [s.currentSongId, s.setlistIndex, s.setlistGap === true];
        });
        assert.deepEqual(saved, [set.b, 1, true]);
      } finally {
        await ev(async (s) => {
          const { store } = window.__rig;
          store.setCurrentSetlist(s.prevList);
          store.deleteSetlist(s.sl);
        }, set);
        await settled();
      }
    });

  await T('polish1 U7a O3: Export song refuses a trial song ("Keep it first"), both menus; a library song exports',
    async () => {
      await closeBank();
      await ev(() => {
        window.__p1downloads = [];
        if (window.__p1dlHooked) return;
        window.__p1dlHooked = true;
        const click = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
          if (this.download) window.__p1downloads.push(this.download);
          if (this.download && this.href.startsWith('blob:')) return undefined; // no real download in the test
          return click.call(this);
        };
      });
      await ev((pid) => window.__rig.controller.tryBankSong(pid), QUIET);
      await until(() => window.__rig.controller.trial()?.playing === true);
      await settled();
      await ev(() => window.__rig.ctx.setView('edit'));
      await until(() => document.body.dataset.view === 'edit');
      await ev(() => document.getElementById('toasts')?.replaceChildren());
      const exportBoth = () => ev(async () => {
        const v = document.getElementById('view-edit');
        v.querySelector('.ev2-song-menubtn').click();
        await new Promise((r) => setTimeout(r, 50));
        v.querySelector('.ev2-song-mi[data-act="export"]').click();
        await new Promise((r) => setTimeout(r, 50));
        v.querySelector('[data-file="export-song"]').click();
        await new Promise((r) => setTimeout(r, 50));
        return { dl: window.__p1downloads.slice(), toasts: document.getElementById('toasts').textContent };
      });
      const t = await exportBoth();
      assert.deepEqual(t.dl, [], 'no file for a trial song');
      assert.match(t.toasts, /Keep it first/);
      // Back, then a library song exports from both places as before
      await ev(() => window.__rig.ctx.setView('perform'));
      await until(() => document.body.dataset.view === 'perform');
      await page.click(tid('v6-try-back'));
      await until(() => !window.__rig.controller.trial());
      await settled();
      await ev(() => window.__rig.ctx.setView('edit'));
      await until(() => document.body.dataset.view === 'edit');
      const l = await exportBoth();
      assert.equal(l.dl.length, 2);
      assert.ok(l.dl.every((f) => f.endsWith('.rig-song.json')), JSON.stringify(l.dl));
      await ev(() => window.__rig.ctx.setView('perform'));
      await until(() => document.body.dataset.view === 'perform');
    });
}
