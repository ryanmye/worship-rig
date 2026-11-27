// UI v6 polish batch 2 (native/docs/lanes/UI6-build-plan.md "Queued small tasks"; orchestrator screenshot): the v6
// Edit's song name was cut mid-glyph at 1280 × 800 ("Sunday Pad + Pia", no ellipsis): the field shrinks with the
// header, but its ellipsis was only re-checked on a rename. Now: at 1280 × 800, 1180 × 820 and 820 × 1180, and after
// a resize, the name either fits (scrollWidth ≤ clientWidth, caret slack) or ends in an ellipsis with the full name in
// its title. Run from run.mjs on its page (the v6 Edit is on).

/**
 * @param {object} x  run.mjs's helpers: {T, page, ev, until, tid, toEdit, assert, settled}
 */
export async function polish2EditTests(x) {
  const { T, page, ev, until, toEdit, assert, settled } = x;
  const read = () => ev(() => {
    const n = document.querySelector('.v6-edit .ev2-song-name');
    return { v: n.value, sw: n.scrollWidth, cw: n.clientWidth, to: getComputedStyle(n).textOverflow, title: n.title };
  });
  const ok = (r, where) => {
    const fits = r.sw <= r.cw + 2;
    assert.ok(fits || r.to === 'ellipsis', `${where}: cut without an ellipsis ${JSON.stringify(r)}`);
    if (!fits) assert.ok(r.title.includes(r.v), `${where}: the full name in the title ${JSON.stringify(r)}`);
    else assert.equal(r.to, 'clip', `${where}: no ellipsis on a name that fits ${JSON.stringify(r)}`);
    return fits;
  };

  await T('polish2: the v6 Edit’s song name fits or ends in an ellipsis (full name in its title) at 1280×800, '
    + '1180×820, 820×1180, also after a resize and a rename', async () => {
    const id = await ev(async () => {
      const { store, controller } = window.__rig;
      const k = store.get().songOrder.find((s) => store.getSong(s).name === 'Sunday Pad + Piano');
      if (k) await controller.selectSong(k);
      return store.currentSong().id;
    });
    await settled();
    await toEdit();
    const name0 = await ev((s) => window.__rig.store.getSong(s).name, id);
    const LONG = 'Sunday Pad + Piano with the long reprise and the choir';
    const seen = [];
    try {
      for (const [w, h] of [[1280, 800], [1180, 820], [820, 1180], [1280, 800]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(300);
        await ev(() => document.activeElement?.blur?.());
        seen.push([`${w} ${name0}`, ok(await read(), `${w}×${h} “${name0}”`)]);
        await ev(({ s, n }) => window.__rig.store.set(`songs.${s}.name`, n), { s: id, n: LONG });
        await page.waitForTimeout(200);
        assert.equal(ok(await read(), `${w}×${h} long`), false, 'the long name is cut (ellipsis)');
        await ev(({ s, n }) => window.__rig.store.set(`songs.${s}.name`, n), { s: id, n: name0 });
        await page.waitForTimeout(200);
        ok(await read(), `${w}×${h} back to “${name0}”`);
      }
      console.log(`      ${seen.map(([k, f]) => `${k}: ${f ? 'fits' : 'ellipsis'}`).join('; ')}`);
    } finally {
      await ev(({ s, n }) => window.__rig.store.set(`songs.${s}.name`, n), { s: id, n: name0 });
      await page.setViewportSize({ width: 1280, height: 800 });
      await until(() => window.innerWidth === 1280);
    }
  });
}
