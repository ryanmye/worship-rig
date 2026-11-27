// U-EDITRANGE (native DECISIONS D26.2, D18 "Same for every screen with the bottom keyboard"; UI6-build-plan "Queued
// small tasks"): the range bars above the v6 Edit's bottom-row keyboard are draggable like Perform's, behind the same
// guards (views/v6/range-guard.js). Run from run.mjs on its page (the v6 Edit is on), after the other files.
//   pick first on a mouse (a press on an unpicked bar only picks it), live throttled writes while dragging (D24.2),
//   one commit on release (nothing more once the last live write said it) that Revert undoes, a changed dot;
//   every cancel path puts the start value back on the song and instrument it wrote: Esc, pointercancel, a window
//   blur, leaving Edit, a song switch, Lock, an Add, a move, the flag going off; Lock blocks a pick; 16 instruments.

/**
 * @param {object} x  run.mjs's helpers: {T, page, ev, until, tid, toEdit, assert, settled, setSlots}
 */
export async function editRangeTests(x) {
  const { T, page, ev, until, tid, toEdit, assert, settled, setSlots } = x;
  const KB = 'v6e-kbd';
  const rectOf = (sel) => ev((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { l: r.left, r: r.right, t: r.top, b: r.bottom, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  }, sel);
  const keyRect = (n) => rectOf(`[data-testid="${KB}"] .pkey[data-note="${n}"]`);
  const setRange = (i, lo, hi, sid) => ev(({ i, lo, hi, sid }) => {
    const { store } = window.__rig;
    const p = `songs.${sid || store.currentSong().id}.patch.slots.${i}`;
    store.set(`${p}.lowNote`, 0);
    store.set(`${p}.highNote`, 127);
    store.set(`${p}.lowNote`, lo);
    store.set(`${p}.highNote`, hi);
  }, { i, lo, hi, sid });
  const hiOf = (i, sid) => ev(({ i, sid }) => {
    const { store } = window.__rig;
    return store.getSong(sid || store.currentSong().id).patch.slots[i]?.highNote ?? null;
  }, { i, sid });
  const toPerform = async () => {
    await ev(() => window.__rig.ctx.setView('perform'));
    await until(() => document.body.dataset.view === 'perform');
  };
  /** Back to Edit with a fresh Revert snapshot (Perform takes one on its way back from Edit). */
  const freshEdit = async () => {
    await toPerform();
    await page.waitForTimeout(150);
    await toEdit();
    await until((k) => !!document.querySelector(`[data-testid="${k}-bar-0"]`), KB);
  };
  /** Pick instrument i with a click on its bar (D24.3: the press picks, nothing moves). */
  const pickBar = async (i) => {
    if (await ev((k) => window.__rig.views.edit._debug.bottomKb()?.picked === k, i)) return;
    const b = await rectOf(tid(`${KB}-bar-${i}`));
    await page.mouse.click(b.cx, b.cy);
    await until((k) => window.__rig.views.edit._debug.bottomKb()?.picked === k, i);
  };
  /** Pick i, press its highest end and drag it to key `to`; resolves once the live write reached the store. */
  const holdHiAt = async (i, to, sid) => {
    await pickBar(i);
    const hd = await rectOf(tid(`${KB}-hhi-${i}`));
    const k = await keyRect(to);
    await page.mouse.move(hd.cx, hd.cy);
    await page.mouse.down();
    await page.mouse.move(k.r, hd.cy, { steps: 6 });
    await until(({ i, to, sid }) => {
      const { store } = window.__rig;
      return store.getSong(sid || store.currentSong().id).patch.slots[i].highNote === to;
    }, { i, to, sid });
  };
  const hold = async (sel, ms = 850) => {
    const b = await rectOf(sel);
    await page.mouse.move(b.cx, b.cy);
    await page.mouse.down();
    await page.waitForTimeout(ms);
    await page.mouse.up();
  };

  await T('U-EDITRANGE pick first (a press on an unpicked bar only picks), live throttled writes, one commit on '
    + 'release, a changed dot, Revert undoes it', async () => {
    await toEdit();
    await setSlots(3);
    await setRange(1, 40, 64);
    await freshEdit();
    await ev(() => window.__rig.views.edit._debug.bottomKb().pick(null));
    // the bars are draggable now (skeptic U5b F4 had made them display only), but only once picked (D24.3)
    const b1 = await rectOf(tid(`${KB}-bar-1`));
    await ev(() => {
      const { store } = window.__rig;
      window.__erw = [];
      window.__erOff?.();
      window.__erOff = store.subscribe((st, paths) => {
        if (paths.some((p) => /patch\.slots\.1\.highNote$/.test(p))) {
          window.__erw.push([performance.now(), st.songs[st.settings.currentSongId].patch.slots[1].highNote]);
        }
      });
    });
    await page.mouse.move(b1.r - 1, b1.cy);
    await page.mouse.down();
    await page.mouse.move(b1.r + 60, b1.cy, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    assert.equal(await hiOf(1), 64, 'a press-drag on an unpicked bar moves nothing');
    assert.equal(await ev(() => window.__rig.views.edit._debug.bottomKb().picked), 1, 'that press picked it');
    assert.equal(await page.isHidden(tid(`${KB}-pickhint`)), false, 'the hint says what to do');
    assert.deepEqual(await ev(() => [...document.querySelectorAll('[data-testid="v6e-kbd"] .v6-rh')]
      .filter((e) => e.tabIndex === 0).map((e) => e.dataset.testid)), [`${KB}-hlo-1`, `${KB}-hhi-1`]);
    // a hand-like drag of the picked bar's highest end: heard live, ≤ 1 write per 50 ms
    const hd = await rectOf(tid(`${KB}-hhi-1`));
    const k84 = await keyRect(84);
    await page.mouse.move(hd.cx, hd.cy);
    await page.mouse.down();
    for (let k = 1; k <= 40; k++) {
      await page.mouse.move(hd.cx + (k84.r - hd.cx) * k / 40, hd.cy);
      await page.waitForTimeout(15);
    }
    await page.waitForTimeout(120); // the trailing write
    const mid = await ev(() => window.__erw.slice());
    await page.mouse.up();
    await page.waitForTimeout(200);
    const all = await ev(() => window.__erw.slice());
    await ev(() => window.__erOff?.());
    assert.ok(mid.length >= 3, `written while dragging (${mid.length} writes)`);
    assert.equal(mid[mid.length - 1][1], 84, 'the last live write is where the hand stopped');
    const gaps = mid.slice(1).map((w, k) => w[0] - mid[k][0]);
    assert.deepEqual(gaps.filter((g) => g < 40), [], `gaps ${gaps.map((g) => g.toFixed(0)).join(',')}`);
    // one commit: the release writes nothing more once the last live write already said it
    assert.equal(all.length - mid.length, 0, 'no extra write on release');
    assert.equal(await hiOf(1), 84);
    // the cost of one live write in Edit: store.set + its notification (the v6 Edit + the hidden Perform + the diff)
    const cost = await ev(() => {
      const { store } = window.__rig;
      const sid = store.currentSong().id;
      const t = [];
      for (let k = 0; k < 40; k++) {
        const a = performance.now();
        store.set(`songs.${sid}.patch.slots.1.highNote`, 70 + (k % 10));
        store.flush();
        t.push(performance.now() - a);
      }
      store.set(`songs.${sid}.patch.slots.1.highNote`, 84);
      store.flush();
      t.sort((p, q) => p - q);
      return { med: t[20], p95: t[37], max: t[39] };
    });
    console.log(`      [timing] ${mid.length} live writes; one Edit write + render median ${cost.med.toFixed(2)} ms, `
      + `p95 ${cost.p95.toFixed(2)}, max ${cost.max.toFixed(2)} ms`);
    assert.ok(cost.p95 < 50, `one write costs ${cost.p95} ms at p95 (the throttle interval is 50)`);
    // a release away from the last live value: exactly one write
    await ev(() => {
      const { store } = window.__rig;
      window.__erw = [];
      window.__erOff = store.subscribe((st, paths) => {
        if (paths.some((p) => /patch\.slots\.1\.highNote$/.test(p))) window.__erw.push(1);
      });
    });
    const hd2 = await rectOf(tid(`${KB}-hhi-1`));
    const k79 = await keyRect(79);
    await page.mouse.move(hd2.cx, hd2.cy);
    await page.mouse.down();
    await page.mouse.move(k79.r, hd2.cy); // one move, then release at once: the release is the commit
    await page.mouse.up();
    await page.waitForTimeout(200);
    assert.equal(await hiOf(1), 79);
    assert.equal((await ev(() => window.__erw.length)), 1, 'one write for the whole drag');
    await ev(() => window.__erOff?.());
    // the bar dots (changed since the song began) and Revert (hold) puts the snapshot's range back
    assert.equal(await ev(() => document.querySelector('[data-testid="v6e-kbd-bar-1"]').classList.contains('changed')),
      true);
    await ev(() => window.__rig.views.edit._debug.bottomKb().pick(null));
    await hold(tid('v6e-revert'));
    await until(() => window.__rig.store.currentSong().patch.slots[1].highNote === 64);
    assert.equal(await ev(() => document.querySelector('[data-testid="v6e-kbd-bar-1"]').classList.contains('changed')),
      false);
  });

  await T('U-EDITRANGE every cancel path puts the start value back: Esc, pointercancel, a window blur, leaving '
    + 'Edit, a song switch, Lock, an Add, a move, the flag going off', async () => {
    await toEdit();
    await setSlots(3);
    const id = await ev(() => window.__rig.store.currentSong().id);
    const other = await ev((cur) => {
      const { store } = window.__rig;
      return Object.keys(store.get().songs).find((k) => k !== cur && store.getSong(k).patch.slots[1]);
    }, id);
    assert.ok(other, 'a second song with two instruments');
    const paths = {
      esc: { run: () => page.keyboard.press('Escape') },
      pointercancel: {
        run: () => ev(() => document.querySelector('[data-testid="v6e-kbd-hit"]').dispatchEvent(
          new PointerEvent('pointercancel', { pointerId: 1, bubbles: true, pointerType: 'mouse' }))),
      },
      blur: { run: () => ev(() => window.dispatchEvent(new Event('blur'))) },
      view: { run: () => ev(() => window.__rig.ctx.setView('perform')), after: toEdit },
      song: {
        run: () => ev((o) => window.__rig.controller.selectSong(o), other),
        after: async () => {
          await settled();
          await ev((sid) => window.__rig.controller.selectSong(sid), id);
          await settled();
          await until(() => !!window.__rig.views.edit._debug.bottomKb());
        },
      },
      lock: {
        // Perform lock freezes Edit (main.js sends a locked Edit back to Perform): the drag is dropped either way
        run: () => ev(() => window.__rig.store.set('settings.performLock', true)),
        after: async () => {
          await ev(() => window.__rig.store.set('settings.performLock', false));
          await toEdit();
        },
      },
      add: {
        run: () => ev(() => window.__rig.store.addSlot(window.__rig.store.currentSong().id)),
        after: () => setSlots(3),
      },
      move: {
        // the instrument moves from 1 to 2: the restore follows it there
        run: () => ev(() => window.__rig.store.moveSlot(window.__rig.store.currentSong().id, 1, 2)),
        at: 2,
        after: () => ev(() => window.__rig.store.moveSlot(window.__rig.store.currentSong().id, 2, 1)),
      },
      flag: {
        run: () => ev(() => window.__rig.setUiV6(false)),
        after: async () => {
          await ev(() => window.__rig.setUiV6(true));
          await until(() => !!window.__rig.views.edit?._debug?.v6 && !!window.__rig.views.v6);
          await toEdit();
          await until(() => !!window.__rig.views.edit._debug.bottomKb());
        },
      },
    };
    const otherBefore = await ev((o) => JSON.stringify(window.__rig.store.getSong(o).patch.slots), other);
    for (const [k, p] of Object.entries(paths)) {
      await setRange(1, 40, 64, id);
      await page.waitForTimeout(80);
      await holdHiAt(1, 76, id);
      await p.run();
      const at = p.at ?? 1;
      await until(({ sid, at }) => window.__rig.store.getSong(sid).patch.slots[at].highNote === 64,
        { sid: id, at }, 5000).catch(async (e) => {
          throw new Error(`${k}: ${JSON.stringify(await ev((sid) => window.__rig.store.getSong(sid).patch.slots
            .map((s) => s && [s.lowNote, s.highNote]), id))} ${e.message}`);
        });
      await page.mouse.move(10, 10); // a further move after the cancel writes nothing either
      await page.mouse.up();
      await page.waitForTimeout(150);
      assert.equal(await hiOf(at, id), 64, `${k}: the release wrote nothing`);
      assert.equal(await ev(() => window.__rig.views.edit._debug.bottomKb?.()?.dragging || false), false, k);
      if (k === 'song') {
        assert.equal(await ev((o) => JSON.stringify(window.__rig.store.getSong(o).patch.slots), other), otherBefore,
          'song switch: the next song is untouched');
      }
      if (p.after) await p.after();
      await ev(() => window.__rig.views.edit._debug.bottomKb?.()?.pick(null));
    }
  });

  await T('U-EDITRANGE Lock blocks a pick and a write; 16 instruments: the 16th bar picks and drags, nothing else '
    + 'is written', async () => {
    await toEdit();
    // Lock (a store write: the Edit stays shown; its own Lock button goes to Perform first): no pick, no live handle,
    // a press-drag on a bar's end writes nothing (keyboard.js locked; range-guard.js refuses all but a restore)
    await setSlots(3);
    await setRange(0, 40, 64);
    await ev(() => window.__rig.views.edit._debug.bottomKb().pick(null));
    await ev(() => window.__rig.store.set('settings.performLock', true));
    await until(() => document.querySelector('[data-testid="v6e-kbd"]')?.classList.contains('locked'));
    const b0 = await rectOf(tid(`${KB}-bar-0`));
    await page.mouse.click(b0.cx, b0.cy);
    await page.waitForTimeout(100);
    assert.equal(await ev(() => window.__rig.views.edit._debug.bottomKb().pick(0) ?? window.__rig.views.edit._debug
      .bottomKb().picked), null, 'no pick under Lock (click or API)');
    assert.equal(await ev(() => document.querySelectorAll('[data-testid="v6e-kbd"] .v6-rh[tabindex="0"]').length), 0);
    await page.mouse.move(b0.r - 1, b0.cy);
    await page.mouse.down();
    await page.mouse.move(b0.r + 80, b0.cy, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    assert.equal(await hiOf(0), 64, 'nothing written under Lock');
    await ev(() => window.__rig.store.set('settings.performLock', false));
    await until(() => !document.querySelector('[data-testid="v6e-kbd"]')?.classList.contains('locked'));
    // 16 instruments
    await ev(() => {
      const { store } = window.__rig;
      const id = store.currentSong().id;
      while (store.currentSong().patch.slots.length < 16) store.addSlot(id);
      for (let i = 0; i < 16; i++) {
        if (store.currentSong().patch.slots[i]) continue;
        store.set(`songs.${id}.patch.slots.${i}`, { instrument: { type: 'synth', id: 'warm-pad' } });
      }
      for (let i = 0; i < 16; i++) {
        store.set(`songs.${id}.patch.slots.${i}.lowNote`, 40);
        store.set(`songs.${id}.patch.slots.${i}.highNote`, 64);
      }
    });
    await until(() => document.querySelectorAll('[data-testid^="v6e-kbd-bar-"]').length === 16);
    const before = await ev(() => window.__rig.store.currentSong().patch.slots.map((s) => [s.lowNote, s.highNote]));
    await ev(() => window.__rig.views.edit._debug.bottomKb().pick(15));
    const hd = await rectOf(tid(`${KB}-hhi-15`));
    const k72 = await keyRect(72);
    await page.mouse.move(hd.cx, hd.cy);
    await page.mouse.down();
    await page.mouse.move(k72.r, hd.cy, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const after = await ev(() => window.__rig.store.currentSong().patch.slots.map((s) => [s.lowNote, s.highNote]));
    assert.deepEqual(after.slice(0, 15), before.slice(0, 15), 'no other instrument written');
    assert.deepEqual(after[15], [40, 72]);
    await ev(() => window.__rig.views.edit._debug.bottomKb().pick(null));
    await setSlots(3);
  });
}
