// UI v6 polish batch 1 (native/docs/lanes/UI6-build-plan.md "Queued small tasks"). Run from run.mjs on its page
// (the v6 Edit is on), after the U5b checks.
//   UI6-U5a P1: the range keyboard's label (keyboard.js showTip) no longer forces a layout on a live range write: its
//     widths are read in the next animation frame (Edit › Range, where it always shows, and the v6 Perform with a
//     pick), and it still lands centred over its bar;
//   UI6-U5b O2: ← / → (Shift, ⌘ / Ctrl too) never change the song while the chooser is open, whatever has the focus
//     (nothing after a pointer click on a kind, a tile, the search box); after it closes they do again;
//   UI6-U5b O3: a place whose instrument is not in the engine's list says "<id> (not available)";
//   UI6-U5b O5: the kinds list fits at 1024 × 700 without scrolling (40 px rows kept);
//   UI6-U7a O4: Edit's Song bank… title says it opens the browser.

/**
 * @param {object} x  run.mjs's helpers: {T, page, ev, until, tid, toEdit, assert, settled}
 */
export async function polish1EditTests(x) {
  const { T, page, ev, until, tid, toEdit, assert, settled } = x;
  const choose = async (cat) => {
    await page.click(tid(`v6e-cat-${cat}`));
    await until((c) => document.querySelector('[data-testid="v6e-ccont"]')?.dataset.cat === c, cat);
  };
  const openChooser = async () => {
    await page.click(tid('v6e-change'));
    await until(() => !!document.querySelector('[data-testid="v6e-chooser"]'));
  };
  const chooserOpen = () => ev(() => !!document.querySelector('[data-testid="v6e-chooser"]'));
  const curId = () => ev(() => window.__rig.store.get().settings.currentSongId);

  /**
   * Count the label's layout reads (offsetWidth on the tip, clientWidth on the bar area) made outside an animation
   * frame callback, around one live range write of `slots.<i>.lowNote`. Then, two frames on, where the label is
   * against its bar.
   */
  const tipProbe = (o) => ev(async ({ prefix, i, note }) => {
    const raf0 = window.requestAnimationFrame;
    let inRaf = false;
    window.requestAnimationFrame = (cb) => raf0.call(window, (t) => {
      inRaf = true;
      try {
        cb(t);
      } finally {
        inRaf = false;
      }
    });
    const ow = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    const cw = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
    let forced = 0;
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() {
        if (!inRaf && this.classList?.contains('v6-rtip')) forced += 1;
        return ow.get.call(this);
      },
    });
    Object.defineProperty(Element.prototype, 'clientWidth', {
      configurable: true,
      get() {
        if (!inRaf && this.classList?.contains('v6-rbars')) forced += 1;
        return cw.get.call(this);
      },
    });
    try {
      const { store } = window.__rig;
      const id = store.currentSong().id;
      store.set(`songs.${id}.patch.slots.${i}.lowNote`, note);
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      const during = forced;
      await new Promise((r) => raf0.call(window, () => raf0.call(window, r)));
      const tip = document.querySelector(`[data-testid="${prefix}-tip"]`);
      const bar = document.querySelector(`[data-testid="${prefix}-bar-${i}"]`).getBoundingClientRect();
      const t = tip.getBoundingClientRect();
      return { forced: during, shown: !tip.hidden, text: tip.textContent,
        off: Math.round(Math.abs((t.left + t.right) / 2 - (bar.left + bar.right) / 2)) };
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', ow);
      Object.defineProperty(Element.prototype, 'clientWidth', cw);
      window.requestAnimationFrame = raf0;
    }
  }, o);

  await T('polish1 U5a P1: a live range write forces no layout for the label (Edit › Range, Perform pick); the '
    + 'label still sits centred over its bar', async () => {
    await toEdit();
    await ev(() => window.__rig.views.edit.editState.select('slot:0'));
    await until(() => !!document.querySelector('[data-testid="v6e-inst"]'));
    await choose('range');
    await ev(() => {
      const { store } = window.__rig;
      const id = store.currentSong().id;
      store.set(`songs.${id}.patch.slots.0.lowNote`, 48);
      store.set(`songs.${id}.patch.slots.0.highNote`, 72);
    });
    await until(() => document.querySelector('[data-testid="v6e-range-kbd-tip"]')?.textContent.endsWith('C3–C5'));
    const e = await tipProbe({ prefix: 'v6e-range-kbd', i: 0, note: 50 });
    assert.equal(e.forced, 0, `Edit: layout reads outside a frame: ${e.forced}`);
    assert.deepEqual([e.shown, e.text.endsWith('D3–C5')], [true, true], e.text);
    assert.ok(e.off <= 2, `Edit: the label is ${e.off} px off its bar's centre`);
    // the v6 Perform: the label shows for the picked instrument
    await ev(() => window.__rig.ctx.setView('perform'));
    await until(() => document.body.dataset.view === 'perform');
    await ev(() => window.__rig.views.v6.kb.pick(0));
    await until(() => !document.querySelector('[data-testid="v6-kbd-tip"]').hidden);
    const p = await tipProbe({ prefix: 'v6-kbd', i: 0, note: 52 });
    assert.equal(p.forced, 0, `Perform: layout reads outside a frame: ${p.forced}`);
    assert.deepEqual([p.shown, p.text.endsWith('E3–C5')], [true, true], p.text);
    assert.ok(p.off <= 2, `Perform: the label is ${p.off} px off its bar's centre`);
    await ev(() => window.__rig.views.v6.kb.pick(null));
    await ev(() => {
      const { store } = window.__rig;
      store.set(`songs.${store.currentSong().id}.patch.slots.0.lowNote`, 36);
    });
  });

  await T('polish1 U5b O2: ← / → (Shift, Ctrl) never change the song under the open chooser, whatever has the '
    + 'focus; after it closes they do', async () => {
    await toEdit();
    await ev(() => window.__rig.views.edit.editState.select('slot:0'));
    await until(() => !!document.querySelector('[data-testid="v6e-change"]'));
    await settled();
    const id0 = await curId();
    await openChooser();
    // a pointer click on a kind: nothing focused (the app-wide convention)
    await page.click('[data-testid="v6e-chooser"] .v6e-ch-cat:nth-child(2)');
    assert.equal(await ev(() => document.activeElement === document.body), true, 'nothing focused');
    for (const k of ['ArrowRight', 'ArrowLeft', 'Shift+ArrowRight', 'Control+ArrowRight']) {
      await page.keyboard.press(k);
      await page.waitForTimeout(120);
      assert.equal(await curId(), id0, `${k} with nothing focused`);
      assert.equal(await chooserOpen(), true, `${k}: the chooser stays`);
    }
    // a tile: the arrows move through the tiles (the dialog's own keys), never the song
    await ev(() => document.querySelector('[data-testid="v6e-chooser"] .v6e-ch-tile').focus());
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(120);
    assert.equal(await ev(() => [...document.querySelectorAll('[data-testid="v6e-chooser"] .v6e-ch-tile')]
      .indexOf(document.activeElement)), 1, '→ moved to the next tile');
    assert.equal(await curId(), id0);
    // the search box keeps its caret keys
    await page.click(tid('v6e-ch-search'));
    await page.keyboard.type('pa');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await ev(() => document.activeElement.selectionStart), 1, '← moved the caret');
    assert.equal(await curId(), id0);
    await page.click(tid('v6e-ch-cancel'));
    await until(() => !document.querySelector('[data-testid="v6e-chooser"]'));
    // closed: → is Next song again (with nothing focused), ← goes back
    await ev(() => document.activeElement?.blur?.());
    await page.keyboard.press('ArrowRight');
    await until((a) => window.__rig.store.get().settings.currentSongId !== a, id0);
    await settled();
    await page.keyboard.press('ArrowLeft');
    await until((a) => window.__rig.store.get().settings.currentSongId === a, id0);
    await settled();
  });

  await T('polish1 U5b O3: an instrument missing from the engine list shows "<id> (not available)"; a pick '
    + 'replaces it', async () => {
    await toEdit();
    await ev(() => window.__rig.views.edit.editState.select('slot:0'));
    await until(() => !!document.querySelector('[data-testid="v6e-change"]'));
    const before = await ev(() => JSON.stringify(window.__rig.store.currentSong().patch.slots[0].instrument));
    await ev(() => {
      const { store } = window.__rig;
      store.set(`songs.${store.currentSong().id}.patch.slots.0.instrument`, { type: 'sampler', id: 'gone-grand' });
    });
    try {
      await openChooser();
      const r = await ev(() => {
        const m = document.querySelector('[data-testid="v6e-ch-missing"]');
        return { shown: !!m && !m.hidden && m.getClientRects().length > 0, text: m?.textContent || '',
          use: document.querySelector('[data-testid="v6e-ch-use"]').disabled };
      });
      assert.equal(r.shown, true);
      assert.match(r.text, /^gone-grand \(not available\) · This instrument is not available on this computer/);
      assert.equal(r.use, true, 'Use waits for a pick');
      await page.click('[data-testid="v6e-chooser"] .v6e-ch-tile');
      assert.equal(await page.isDisabled(tid('v6e-ch-use')), false);
      await page.click(tid('v6e-ch-cancel'));
      await until(() => !document.querySelector('[data-testid="v6e-chooser"]'));
      // an instrument the engine has: no line
      await ev((b) => {
        const { store } = window.__rig;
        store.set(`songs.${store.currentSong().id}.patch.slots.0.instrument`, JSON.parse(b));
      }, before);
      await openChooser();
      assert.equal(await ev(() => document.querySelector('[data-testid="v6e-ch-missing"]').hidden), true);
      await page.click(tid('v6e-ch-cancel'));
      await until(() => !document.querySelector('[data-testid="v6e-chooser"]'));
    } finally {
      await ev((b) => {
        const { store } = window.__rig;
        store.set(`songs.${store.currentSong().id}.patch.slots.0.instrument`, JSON.parse(b));
      }, before);
    }
  });

  await T('polish1 U5b O5: at 1024×700 the chooser’s kinds list fits without scrolling (40 px rows)', async () => {
    await page.setViewportSize({ width: 1024, height: 700 });
    try {
      await toEdit();
      await ev(() => window.__rig.views.edit.editState.select('slot:0'));
      await until(() => !!document.querySelector('[data-testid="v6e-change"]'));
      await page.waitForTimeout(250);
      await openChooser();
      await page.waitForTimeout(250);
      const r = await ev(() => {
        const cats = document.querySelector('[data-testid="v6e-ch-cats"]');
        const box = cats.getBoundingClientRect();
        const rows = [...cats.querySelectorAll('.v6e-ch-cat')];
        return { n: rows.length, scrolls: cats.scrollHeight > cats.clientHeight + 0.5,
          allIn: rows.every((b) => b.getBoundingClientRect().bottom <= box.bottom + 0.5),
          h: Math.min(...rows.map((b) => Math.round(b.getBoundingClientRect().height))),
          use: document.querySelector('[data-testid="v6e-ch-use"]').getBoundingClientRect().bottom
            <= document.querySelector('[data-testid="v6e-chooser"]').getBoundingClientRect().bottom + 0.5 };
      });
      assert.ok(r.n >= 9, `kinds: ${r.n}`);
      assert.deepEqual({ scrolls: r.scrolls, allIn: r.allIn, h: r.h, use: r.use },
        { scrolls: false, allIn: true, h: 40, use: true });
      await page.click(tid('v6e-ch-cancel'));
      await until(() => !document.querySelector('[data-testid="v6e-chooser"]'));
    } finally {
      await page.setViewportSize({ width: 1280, height: 800 });
    }
  });
}
