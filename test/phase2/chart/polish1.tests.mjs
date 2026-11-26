// UI v6 polish batch 1 (native/docs/lanes/UI6-build-plan.md "Queued small tasks"; review UI6-U7b O1–O3). Run from
// v6.tests.mjs on its page (the v6 Perform with the chart on), before its console check.
//   O1 a tap on the sidebar's Notes leaves nothing focused (Space = the pedal, not a page of notes; Esc = Panic);
//      Tab still reaches them and ↓ scrolls them;
//   O2 auto-scroll keeps running (and the line being read stays) when the chart changes place (⇥ Sidebar / ⤢ Stage);
//   O3 a chart set on a trial song whose bank song is already in the library says it is for this try only (Keep it
//      plays the library copy as it is), in the Edit chart title and the toast.

/**
 * @param {object} x  v6.tests.mjs's helpers: {T, page, ev, until, tid, st, setSong, assert}
 */
export async function polish1ChartTests(x) {
  const { T, page, ev, until, tid, st, setSong, assert } = x;

  await T('U7b polish1 O1: a tap on the Notes module leaves nothing focused (Space = pedal, Esc = Panic); Tab still '
    + 'scrolls', async () => {
    await ev(() => window.__rig.views.chart.setPlacement('side'));
    await ev(() => {
      const { store } = window.__rig;
      const lines = Array.from({ length: 60 }, (_, i) => `Note line ${i + 1}: count the tiles again`);
      store.set(`songs.${store.currentSong().id}.notes`, lines.join('\n'));
    });
    await page.click(tid('v6-sb-tab-notes'));
    await until(() => !!document.querySelector('[data-testid="v6-notes-text"]'));
    const sel = tid('v6-notes-text');
    await until((s) => document.querySelector(s).scrollHeight > document.querySelector(s).clientHeight + 40, sel);
    const b = await page.locator(sel).boundingBox();
    await page.mouse.click(b.x + 60, b.y + 30);
    await page.waitForTimeout(50);
    assert.equal(await ev(() => document.activeElement?.dataset?.testid ?? null), null, 'the notes let go');
    const y0 = await ev((s) => document.querySelector(s).scrollTop, sel);
    await page.keyboard.down('Space');
    await until(() => window.__rig.controller.status.pedal === true, null, 3000);
    await page.keyboard.up('Space');
    await until(() => window.__rig.controller.status.pedal === false, null, 3000);
    assert.equal(await ev((s) => document.querySelector(s).scrollTop, sel), y0, 'Space did not page the notes');
    await ev(() => {
      window.__p1Panics = 0;
      if (window.__p1PanicHooked) return;
      window.__p1PanicHooked = true;
      window.__rig.controller.on('action', (a) => {
        if (a && (a.type === 'panic' || a.action === 'panic')) window.__p1Panics++;
      });
    });
    await page.mouse.click(b.x + 60, b.y + 30);
    await page.keyboard.press('Escape');
    await until(() => window.__p1Panics === 1, null, 3000);
    // the keyboard path is kept: focused from the keyboard, ↓ scrolls the notes (not the mod wheel)
    await page.keyboard.press('Shift');
    await ev((s) => document.querySelector(s).focus(), sel);
    assert.equal(await ev(() => document.activeElement?.dataset?.testid), 'v6-notes-text');
    await page.keyboard.press('ArrowDown');
    assert.ok((await ev((s) => document.querySelector(s).scrollTop, sel)) > y0, '↓ scrolls the focused notes');
    await ev(() => document.activeElement?.blur());
    await ev(() => {
      const { store } = window.__rig;
      store.set(`songs.${store.currentSong().id}.notes`, '');
    });
  });

  await T('U7b polish1 O2: auto-scroll keeps running and the line read stays when the chart changes place (⇥ / ⤢)',
    async () => {
      await ev(() => window.__rig.views.chart.setPlacement('stage'));
      await until(() => !!document.querySelector('[data-testid="v6-chart-stage"]'));
      await setSong();
      await ev(() => window.__rig.store.set('song.tempo', 300));
      const body = (where) => `${tid(`v6-chart-${where}`)} ${tid('v6-chart-body')}`;
      const y0 = await ev((s) => document.querySelector(s).scrollTop, body('stage'));
      await page.click(`${tid('v6-chart-stage')} ${tid('v6-chart-auto')}`);
      await until((a) => document.querySelector(a.s).scrollTop > a.y + 30, { s: body('stage'), y: y0 }, 10000);
      const at = (await st()).line;
      assert.ok(at > 0, `reading line ${at}`);
      // ⇥ Sidebar
      await page.click(`${tid('v6-chart-stage')} ${tid('v6-chart-place')}`);
      await until(() => !!document.querySelector('[data-testid="v6-chart-side"]'));
      const s1 = await st();
      assert.equal(s1.auto, true, 'still scrolling in the sidebar');
      assert.ok(s1.line >= at, `the sidebar went on from line ${at} (at ${s1.line})`);
      assert.equal(await page.getAttribute(`${tid('v6-chart-side')} ${tid('v6-chart-auto')}`, 'aria-pressed'), 'true');
      const ys = await ev((s) => document.querySelector(s).scrollTop, body('side'));
      await until((a) => document.querySelector(a.s).scrollTop > a.y + 10, { s: body('side'), y: ys }, 10000);
      // ⤢ Stage
      const at2 = (await st()).line;
      await page.click(`${tid('v6-chart-side')} ${tid('v6-chart-place')}`);
      await until(() => !!document.querySelector('[data-testid="v6-chart-stage"]'));
      const s2 = await st();
      assert.equal(s2.auto, true, 'still scrolling on the stage');
      assert.ok(s2.line >= at2, `the stage went on from line ${at2} (at ${s2.line})`);
      // stopped stays stopped
      await page.click(`${tid('v6-chart-stage')} ${tid('v6-chart-auto')}`);
      await page.click(`${tid('v6-chart-stage')} ${tid('v6-chart-place')}`);
      await until(() => !!document.querySelector('[data-testid="v6-chart-side"]'));
      assert.equal((await st()).auto, false);
      await ev(() => window.__rig.views.chart.setPlacement('stage'));
      await until(() => !!document.querySelector('[data-testid="v6-chart-stage"]'));
    });

  await T('U7b polish1 O3: a chart set on a trial of a bank song already in the library says it is for this try only',
    async () => {
      const ids = await ev(() => {
        const { store, controller } = window.__rig;
        const song = JSON.parse(JSON.stringify(store.currentSong()));
        delete song.id;
        song.name = 'Library Tiles';
        delete song.chart;
        const e = { packId: 'polish1:tiles.json', hash: 'p1', mode: 'bank', song };
        const lib = store.addPackSong(e);
        const back = store.currentSong().id;
        const r = store.startTrial(e);
        store.set('settings.currentSongId', r.id);
        // the controller's view of this trial (a store-made trial has none): its bank song is the library copy
        window.__p1trial = controller.trial;
        controller.trial = () => ({ id: r.id, packId: e.packId, title: 'Library Tiles', prev: null });
        return { trial: r.id, lib: lib.id, back, existing: !!store.packSongs()[e.packId] };
      });
      try {
        assert.equal(ids.existing, true);
        await until((i) => window.__rig.views.chart.state().songId === i, ids.trial);
        await ev(() => window.__rig.views.chart.openEdit());
        await until(() => !!document.querySelector('[data-testid="v6-ce-text"]'));
        assert.match(await page.textContent('.v6-ce-h'), /already in your library, so this chart is for this try only/);
        await page.fill(tid('v6-ce-text'), '{key: G}\n[G]Tried [C]again');
        await page.waitForTimeout(350);
        await ev(() => document.getElementById('toasts')?.replaceChildren());
        await page.click(tid('v6-ce-save'));
        await until(() => !document.querySelector('[data-testid="v6-chart-editor"]'));
        const toast = await ev(() => document.getElementById('toasts').textContent);
        assert.match(toast, /for this try only: this song is already in your library/);
        assert.doesNotMatch(toast, /Keep it to save it/);
      } finally {
        await ev((x2) => {
          const { store, controller } = window.__rig;
          controller.trial = window.__p1trial;
          store.set('settings.currentSongId', x2.back);
          store.endTrial(x2.trial);
          store.deleteSong(x2.lib);
        }, ids);
      }
    });
}
