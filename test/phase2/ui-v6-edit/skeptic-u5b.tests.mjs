// UI v6 U5b skeptic review (native/docs/reviews/UI6-U5b.md): checks for the findings fixed on lane-u5b. Run from
// run.mjs on its page (the v6 Edit is on), after u5b.tests.mjs.
//   F1 the chooser dims Edit's body only: the bottom row (PANIC, Lock, keys) stays live under no backdrop (mockup);
//   F2 a kind chosen by keyboard keeps the focus (it fell to <body>, where → is Next song under the dialog);
//   F3 an optional object the song began without, set back to its defaults, does not dot (fx.eq, fx.comp, touch);
//   F4 the bottom row's range bars are display only (a tap picked a bar and its ends wrote, unguarded);
//   F5 no test id twice in Edit with Drone › Key & sound open (the module's root and the panel were both v6e-drone);
//   F6 the chooser closes when its place's instrument changes under it (Revert).

/**
 * @param {object} x  run.mjs's helpers: {T, page, ev, until, tid, toEdit, assert, settled}
 */
export async function skepticU5bTests(x) {
  const { T, page, ev, until, tid, toEdit, assert } = x;
  const select = async (b) => {
    await ev((id) => window.__rig.views.edit.editState.select(id), b);
    await until((id) => !!document.querySelector(`.v6e-host[data-panel="${id}"] [data-testid="v6e-${id}"]`)
      || (id.startsWith('slot:') && !!document.querySelector('[data-testid="v6e-inst"]')), b);
  };
  const freshBaseline = async () => {
    await ev(() => window.__rig.ctx.setView('perform'));
    await until(() => document.body.dataset.view === 'perform');
    await page.waitForTimeout(150);
    await toEdit();
  };
  const setStore = (pairs) => ev((p) => {
    const { store } = window.__rig;
    const id = store.currentSong().id;
    for (const [k, v] of p) store.set(`songs.${id}.${k}`, v);
  }, pairs);
  const openChooser = async () => {
    await page.click(tid('v6e-change'));
    await until(() => !!document.querySelector('[data-testid="v6e-chooser"]'));
  };
  const chooserOpen = () => ev(() => !!document.querySelector('[data-testid="v6e-chooser"]'));

  await T('skeptic U5b F1/F2/F6: chooser over the body only (PANIC / Lock / keys live), a kind keeps the focus, '
    + 'closes when Revert swaps the instrument', async () => {
    await toEdit();
    await freshBaseline();
    await select('slot:0');
    const was = await ev(() => window.__rig.store.currentSong().patch.slots[0].instrument);
    // F1: nothing of the bottom row is under the backdrop; PANIC works with the chooser open
    await openChooser();
    const hit = await ev(() => ['v6e-panic', 'v6e-lock', 'v6e-revert', 'v6e-fade', 'v6e-piano'].map((t) => {
      const r = document.querySelector(`[data-testid="${t}"]`).getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return [t, !!at?.closest(`[data-testid="${t}"]`)];
    }));
    assert.deepEqual(hit.filter(([, ok]) => !ok), [], JSON.stringify(hit));
    await ev(() => {
      window.__panics = 0;
      window.__rig.controller.addEventListener('action', (e) => {
        if (e.detail?.type === 'panic') window.__panics += 1;
      });
    });
    await page.click(tid('v6e-panic'));
    await until(() => window.__panics === 1);
    // F2: Enter on a kind keeps the focus on that kind; → then is not Next song
    const songId = await ev(() => window.__rig.store.get().settings.currentSongId);
    const kind = await ev(() => document.querySelector('.v6e-ch-cat:not(.on):not([disabled])').dataset.kind);
    await page.focus(`.v6e-ch-cat[data-kind="${kind}"]`);
    await page.keyboard.press('Enter');
    const f = await ev(() => ({ kind: document.activeElement?.dataset?.kind, on: document.activeElement
      ?.classList.contains('on') }));
    assert.deepEqual(f, { kind, on: true });
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);
    assert.equal(await ev(() => window.__rig.store.get().settings.currentSongId), songId);
    assert.ok(await chooserOpen());
    await page.keyboard.press('Escape');
    await until(() => !document.querySelector('[data-testid="v6e-chooser"]'));
    // F6: another instrument than the snapshot's, the chooser open, then Revert (hold) puts the old one back
    const other = was.id === 'warm-pad' ? { type: 'synth', id: 'sub-bass' } : { type: 'synth', id: 'warm-pad' };
    assert.ok(other, 'another instrument');
    await setStore([['patch.slots.0.instrument', other]]);
    await page.waitForTimeout(150);
    await openChooser();
    const now = await ev(() => document.querySelector('.v6e-ch-tile.cur')?.dataset.value);
    assert.equal(now, `${other.type}:${other.id}`);
    const r = await ev(() => {
      const b = document.querySelector('[data-testid="v6e-revert"]').getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    });
    await page.mouse.move(r.x, r.y);
    await page.mouse.down();
    await page.waitForTimeout(1000);
    await page.mouse.up();
    await until((w) => {
      const i = window.__rig.store.currentSong().patch.slots[0].instrument;
      return i.type === w.type && i.id === w.id;
    }, was);
    await until(() => !document.querySelector('[data-testid="v6e-chooser"]'));
    assert.equal(await ev(() => document.querySelector('[data-testid="v6e-change"]').getAttribute('aria-expanded')),
      'false');
  });
}
