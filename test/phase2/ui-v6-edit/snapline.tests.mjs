// U-SNAP follow-up (UI6-snap O1 / O2; native/docs/lanes/UI6-build-plan.md "Queued small tasks"), the v6 Edit:
// - O1: while a snapshot plays, the header says "Changing snapshot “<name>” for now: Update keeps it, Own levels edits
//   the song" (shared/voice.js sceneEditLine), on a line under the chips; Update / Own levels do what the snapshots
//   row's Update / Own levels do; no line (nor element) while none plays.
// - O2: Effects › Sends' summary ("n of m in the Space") and the instrument's Space & Echo summary read the song as it
//   plays (ctx.view), so they agree with the controls under them.
// Run from run.mjs on its page (the v6 Edit is on).

/**
 * @param {object} x  run.mjs's helpers: {T, page, ev, until, tid, toEdit, assert, settled}
 */
export async function snaplineEditTests(x) {
  const { T, page, ev, until, tid, toEdit, assert, settled } = x;
  const line = () => ev(() => {
    const el = document.querySelector('#view-edit [data-testid="edit-snapline"]');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    const chips = el.parentElement.querySelector('.ev2-song-head').getBoundingClientRect();
    return { shown: !el.hidden && b.height > 0, text: el.innerText.replace(/\s+/g, ' ').trim(),
      below: b.top >= chips.bottom - 1, oneLine: b.height < 26, w: Math.round(b.width) };
  });
  const sum = (sel) => ev((s) => document.querySelector(s)?.innerText.replace(/\s+/g, ' ').trim() ?? null, sel);
  const state = () => ev(() => {
    const { store, controller } = window.__rig;
    const s = store.currentSong();
    return { n: controller.scenes.state().n, scenes: JSON.parse(JSON.stringify(s.scenes || [])),
      own: s.patch.slots[0].sends?.reverb ?? 0, heard: controller.scenes.view(s).patch.slots[0].sends?.reverb ?? 0 };
  });

  await T('UI6-snap O1/O2: v6 Edit under a snapshot: the header line, its Update / Own levels; the Sends and '
    + 'Space & Echo summaries read what plays', async () => {
    await ev(() => window.__rig.ctx.setView('perform'));
    await settled();
    // a 2-instrument song, Keys' own Space 25 %, a snapshot "Hall keys" holding Keys' Space 90 % and slot 1's at 0
    await ev(() => {
      const { store, controller } = window.__rig;
      const s = store.currentSong();
      controller.scenes.go(null);
      store.set(`songs.${s.id}.scenes`, []);
      store.set(`songs.${s.id}.patch.slots.0.sends.reverb`, 0.25);
      for (let i = 1; i < s.patch.slots.length; i++) {
        if (s.patch.slots[i]) store.set(`songs.${s.id}.patch.slots.${i}.sends.reverb`, 0.3);
      }
    });
    await toEdit();
    assert.equal(await line(), null, 'no snapshot plays: no line, no element (the header at rest is unchanged)');
    await ev(() => {
      const { store, controller } = window.__rig;
      const s = store.currentSong();
      const slots = s.patch.slots.map((sl, i) => (sl ? { gain: sl.gain, sends: { reverb: i === 0 ? 0.9 : 0 } } : null));
      store.set(`songs.${s.id}.scenes`, [{ name: 'Hall keys', slots }]);
      controller.scenes.go(0);
    });
    await until(() => !!document.querySelector('#view-edit [data-testid="edit-snapline"]:not([hidden])'));
    let l = await line();
    assert.equal(l.text, 'Changing snapshot “Hall keys” for now: Update keeps it, Own levels edits the song');
    assert.ok(l.shown && l.below && l.oneLine, `a line of its own under the chips at 1280: ${JSON.stringify(l)}`);
    assert.equal(await page.textContent(tid('edit-snap-update')), 'Update');
    assert.equal(await page.textContent(tid('edit-snap-own')), 'Own levels');

    // O2: Effects › Sends ("1 of n in the Space": only Keys goes into the Space under the snapshot)
    const filled = await ev(() => window.__rig.store.currentSong().patch.slots.filter(Boolean).length);
    await ev(() => window.__rig.views.edit.editState.select('effects'));
    await until(() => !!document.querySelector('[data-testid="v6e-effects-cat-sends"]'));
    assert.match(await sum(tid('v6e-effects-cat-sends')), new RegExp(`1 of ${filled} in the Space`));
    // O2: the instrument's Space & Echo row (90 %, as its slider)
    await ev(() => window.__rig.views.edit.editState.select('slot:0'));
    await until(() => !!document.querySelector('[data-testid="v6e-cat-sends"]'));
    assert.match(await sum(tid('v6e-cat-sends')), /^Space & Echo.*90%/);

    // a change in Edit goes on top of the snapshot (heard, the song not written); Update keeps it
    const json0 = await ev(() => JSON.stringify(window.__rig.store.currentSong().patch));
    await ev(() => window.__rig.views.edit.editState.select('slot:0'));
    await ev(() => window.__rig.controller.scenes.take('slots.0.sends.reverb', 0.6));
    let s = await state();
    assert.deepEqual([s.heard, s.own], [0.6, 0.25]);
    assert.equal(await ev(() => JSON.stringify(window.__rig.store.currentSong().patch)), json0);
    await until(() => /60%/.test(document.querySelector('[data-testid="v6e-cat-sends"]')?.innerText || ''));
    await page.click(tid('edit-snap-update'));
    await until(() => window.__rig.store.currentSong().scenes[0].slots[0].sends.reverb === 0.6);
    s = await state();
    assert.deepEqual([s.n, s.scenes[0].name, s.own], [0, 'Hall keys', 0.25],
      'saved over it, name kept, song unchanged');
    await until(() => [...document.querySelectorAll('#toasts *')]
      .some((t) => /“Hall keys” updated\./.test(t.textContent)));
    l = await line();
    assert.ok(l.shown, 'still playing it: the line stays');

    // Own levels: back to the song's own; the line goes, the summaries read the song again
    await page.click(tid('edit-snap-own'));
    await until(() => window.__rig.controller.scenes.state().n === null);
    await until(() => document.querySelector('#view-edit [data-testid="edit-snapline"]')?.hidden === true);
    assert.equal(await ev(() => document.querySelector('#view-edit').querySelector('.ev2-snapping')), null);
    await until(() => /25%/.test(document.querySelector('[data-testid="v6e-cat-sends"]')?.innerText || ''));
    await ev(() => window.__rig.views.edit.editState.select('effects'));
    await until((f) => new RegExp(`${f} of ${f} in the Space`).test(document.querySelector(
      '[data-testid="v6e-effects-cat-sends"]')?.innerText || ''), filled);

    // the snapshots row's Update and Own levels do the same (one path: controller.scenes.save(n) / go(null))
    const viaRow = await ev(() => {
      const { store, controller } = window.__rig;
      controller.scenes.go(0);
      controller.scenes.take('slots.0.sends.reverb', 0.4);
      const st = controller.scenes.state();
      controller.scenes.save(st.n);
      const a = store.currentSong().scenes[0].slots[0].sends.reverb;
      controller.scenes.go(null);
      return [a, controller.scenes.state().n];
    });
    assert.deepEqual(viaRow, [0.4, null]);
    // another song shown: no line for a snapshot of the song that plays (a song still loading has none)
    await ev(() => window.__rig.ctx.setView('perform'));
    await until(() => document.body.dataset.view === 'perform');
    await ev(() => window.__rig.store.set(`songs.${window.__rig.store.currentSong().id}.scenes`, []));
  });

  await T('UI6-snap O1: the line fits at 1180×820 and 820×1180 (one / two lines, nothing cut)', async () => {
    await ev(() => {
      const { store, controller } = window.__rig;
      const s = store.currentSong();
      store.set(`songs.${s.id}.scenes`, [{ name: 'A forty character snapshot name, nearly',
        slots: s.patch.slots.map((sl) => (sl ? { gain: sl.gain } : null)) }]);
      controller.scenes.go(0);
    });
    await toEdit();
    try {
      for (const [w, h] of [[1180, 820], [820, 1180]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(300);
        const r = await ev(() => {
          const el = document.querySelector('#view-edit [data-testid="edit-snapline"]');
          const head = el.parentElement.getBoundingClientRect();
          const out = [...el.querySelectorAll('button'), el].filter((b) => {
            const q = b.getBoundingClientRect();
            return q.left < head.left - 1 || q.right > head.right + 1 || q.bottom > head.bottom + 1;
          }).map((b) => b.textContent.slice(0, 20));
          return { out, h: Math.round(el.getBoundingClientRect().height) };
        });
        assert.deepEqual(r.out, [], `${w}: nothing outside the header ${JSON.stringify(r)}`);
        assert.ok(r.h < 48, `${w}: at most two lines (${r.h} px)`);
      }
    } finally {
      await page.setViewportSize({ width: 1280, height: 800 });
      await until(() => window.innerWidth === 1280);
      await ev(() => window.__rig.ctx.setView('perform'));
      await ev(() => {
        const { store, controller } = window.__rig;
        controller.scenes.go(null);
        store.set(`songs.${store.currentSong().id}.scenes`, []);
      });
    }
  });
}
