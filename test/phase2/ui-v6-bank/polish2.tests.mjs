// UI v6 polish batch 2 (native/docs/lanes/UI6-build-plan.md "Queued small tasks"; reviews UI6-polish1 O2, UI6-U8a
// O1). Run from run.mjs on its page (the v6 Perform with the bank packs), after polish1.tests.mjs and before the
// flag-off test.
//   O2 the Back-into-the-gap rule is controller.backFromTrial's: a flag flip mid-trial (the v6 Perform's destroy goes
//      Back) lands in the gap too, as the banner's Back does;

/**
 * @param {object} x  run.mjs's helpers: {T, page, ev, until, tid, settled, assert, closeBank, QUIET}
 */
export async function polish2BankTests(x) {
  const { T, page, ev, until, tid, settled, assert, closeBank, QUIET } = x;

  await T('polish2 O2: a flag flip mid-trial (the v6 Perform goes Back as it unmounts) lands in the gap too',
    async () => {
      await closeBank();
      const set = await ev(async () => {
        const { store, controller } = window.__rig;
        const [a, b, c] = store.get().songOrder.filter((id) => store.getSong(id));
        const prevList = store.get().settings.currentSetlistId ?? null;
        const sl = store.addSetlist('Polish2 reprise', [a, b, c, b]);
        store.setCurrentSetlist(sl);
        await controller.selectSong(b, { index: 1 });
        return { a, b, c, sl, prevList };
      });
      try {
        await settled();
        await ev((pid) => window.__rig.controller.tryBankSong(pid), QUIET);
        await until(() => window.__rig.controller.trial()?.playing === true);
        await settled();
        assert.equal(await ev((s) => window.__rig.store.removeFromSetlist(s.sl, 1), set), true);
        await ev(() => window.__rig.setUiV6(false));
        await until(() => !window.__rig.controller.trial() && !window.__rig.views.v6);
        await settled();
        const r = await ev(() => {
          const { store } = window.__rig;
          const st = store.get().settings;
          const n = store.neighbors();
          return { cur: st.currentSongId, gap: st.setlistGap === true, at: st.setlistIndex, prev: n.prev?.id ?? null,
            next: n.next?.id ?? null };
        });
        assert.deepEqual(r, { cur: set.b, gap: true, at: 1, prev: set.a, next: set.c });
      } finally {
        await ev(() => window.__rig.setUiV6(true));
        await until(() => !!window.__rig.views.v6);
        await ev(async (s) => {
          const { store } = window.__rig;
          store.setCurrentSetlist(s.prevList);
          store.deleteSetlist(s.sl);
        }, set);
        await settled();
      }
    });

}
