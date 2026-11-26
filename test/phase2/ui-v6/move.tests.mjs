// UI v6 move + D24 tweaks (native DECISIONS D23.1 / D23.2 / D24.2 / D24.3 / D24.6; UI6-build-plan "U-MOVE",
// "U-TWEAKS", "Small-window fit"; reviews U-MOVE-store.md O1, UI6-U2.md O3, UI6-U3.md O1). Run from run.mjs on its
// page (the v6 Perform is on): ⋯ Duplicate next to the original (scenes + wheel target follow), ⋯ Earlier / Later
// (keyboard focus follows), the strip drag by its grip (mouse; auto-scroll past 5; CDP touch in a touch context), Lock
// and every other way a reorder ends, the position-keyed protections re-keyed on the order (⋯ menus, step panels, the
// range drag + pick, Edit's selected tab and 8 s Undo), PANIC / Lock taps, live range writes (≤ 1 per 50 ms, timed)
// and every cancel path restoring the pre-drag value, pick-first on a mouse, the drone's percentages, and the
// 1024 × 700 fit in a fresh context. Screenshots: move-*.png.
import path from 'node:path';
import { MIDI_PERMISSIONS, waitRigReady, pinTheme } from '../../integration/lib.mjs';

/**
 * @param {object} x  run.mjs's helpers: {T, page, browser, origin, ev, until, tid, song, settled, hold, setSlots,
 *   SHOTS, assert, rectOf, keyRect, dragHandle, pickOn, setRange, armPanics, errors, KB}
 */
export async function moveTests(x) {
  const {
    T, page, browser, origin, ev, until, tid, song, settled, hold, setSlots, SHOTS, assert, rectOf, keyRect,
    dragHandle, pickOn, setRange, armPanics, errors, KB,
  } = x;
  const ids = async () => (await song()).patch.slots.map((s) => (s ? s.instrument.id : null));
  const clearToasts = () => ev(() => document.getElementById('toasts')?.replaceChildren());
  const toPerform = async () => {
    await ev(() => window.__rig.ctx.setView('perform'));
    await until(() => document.body.dataset.view === 'perform');
  };
  /** Press strip i's grip, move to clientX `x1` in steps; mid() while still held; release unless `keep`. */
  async function dragGrip(i, x1, { mid, steps = 12, keep = false } = {}) {
    const g = await rectOf(page, tid(`v6-grip-${i}`));
    await page.mouse.move(g.cx, g.cy);
    await page.mouse.down();
    await page.mouse.move(x1, g.cy + 30, { steps });
    if (mid) await mid();
    if (!keep) await page.mouse.up();
  }
  const stripMid = async (i) => (await rectOf(page, tid(`v6-strip-${i}`))).cx;

  await T('U-MOVE ⋯ Duplicate: the copy sits next to the original and follows its scenes and wheel target',
    async () => {
      await toPerform();
      await ev(() => window.__rig.controller.scenes.go(null));
      await setSlots(3);
      // a scene with distinct levels, and the mod wheel on slot 2's level
      await ev(() => {
        const { store, controller } = window.__rig;
        const id = store.currentSong().id;
        store.set(`songs.${id}.scenes`, []);
        [0.2, 0.5, 0.8].forEach((g, i) => store.set(`songs.${id}.patch.slots.${i}.gain`, g));
        controller.scenes.save(0);
        controller.scenes.go(null);
        store.set(`songs.${id}.patch.modWheel.target`, 'slots.2.gain');
      });
      const before = await song();
      await page.click(tid('v6-more-1'));
      assert.match(await page.getAttribute(tid('v6-dup-1'), 'title'), /next to it/);
      await page.click(tid('v6-dup-1'));
      await until(() => window.__rig.store.currentSong().patch.slots.length === 4);
      const s = await song();
      assert.deepEqual(s.patch.slots.map((x2) => x2.instrument.id),
        [0, 1, 1, 2].map((k) => before.patch.slots[k].instrument.id));
      assert.deepEqual(s.patch.slots[2], s.patch.slots[1], 'a deep copy, every field');
      const sc = s.scenes[0].slots;
      assert.deepEqual([sc[0], sc[1], sc[3]], before.scenes[0].slots.slice(0, 3),
        `the others keep their scene entries: ${JSON.stringify(before.scenes)} → ${JSON.stringify(s.scenes)}`);
      assert.deepEqual(sc[2], sc[1], 'the copy has the original’s scene entry (scenesFrom)');
      assert.equal(s.patch.modWheel.target, 'slots.3.gain', 'the wheel target follows its instrument');
      // colours go by position (D15): strip 2 has position 2's colour, the copy's
      await until(() => document.querySelectorAll('.v6-strip:not([hidden])').length === 4);
      assert.deepEqual(await ev(() => [0, 1, 2, 3].map((i) => document.querySelector(`[data-testid="v6-strip-${i}"]`)
        .style.getPropertyValue('--c'))), ['var(--slot-0)', 'var(--slot-1)', 'var(--slot-2)', 'var(--slot-3)']);
      await ev(() => window.__rig.store.set(`songs.${window.__rig.store.currentSong().id}.scenes`, []));
    });

  await T('U-MOVE ⋯ Earlier / Later move one place (disabled at the ends); from the keyboard the focus follows',
    async () => {
      await setSlots(3);
      const a = await ids();
      await page.click(tid('v6-more-0'));
      assert.deepEqual(await ev(() => ['earlier', 'later'].map((k) => document.querySelector(
        `[data-testid="v6-${k}-0"]`).disabled)), [true, false]);
      await page.click(tid('v6-later-0'));
      await until((w) => JSON.stringify(window.__rig.store.currentSong().patch.slots.map((s) => s.instrument.id))
        === w, JSON.stringify([a[1], a[0], a[2]]));
      assert.equal(await page.$(tid('v6-menu-0')), null, 'the menu closed');
      await page.click(tid('v6-more-2'));
      assert.deepEqual(await ev(() => ['earlier', 'later'].map((k) => document.querySelector(
        `[data-testid="v6-${k}-2"]`).disabled)), [false, true]);
      await page.click(tid('v6-earlier-2'));
      await until((w) => JSON.stringify(window.__rig.store.currentSong().patch.slots.map((s) => s.instrument.id))
        === w, JSON.stringify([a[1], a[2], a[0]]));
      // keyboard: Enter on ⋯, Tab to Later, Enter → the focus is on the moved instrument's ⋯ (strip 2)
      await page.focus(tid('v6-more-1'));
      await page.keyboard.press('Enter');
      await until(() => !!document.querySelector('[data-testid="v6-menu-1"]'));
      await page.focus(tid('v6-later-1'));
      await page.keyboard.press('Enter');
      await until((w) => JSON.stringify(window.__rig.store.currentSong().patch.slots.map((s) => s.instrument.id))
        === w, JSON.stringify([a[1], a[0], a[2]]));
      await until(() => document.activeElement?.dataset.testid === 'v6-more-2');
      await ev(() => document.activeElement.blur());
    });

  await T('U-MOVE drag by the grip (mouse): drop line where it lands, one moveSlot on release; Esc / no move = none',
    async () => {
      await setSlots(4);
      const a = await ids();
      let mid = null;
      const x2 = await stripMid(2);
      await dragGrip(0, x2 + 20, {
        mid: async () => {
          mid = await ev(() => ({
            r: window.__rig.views.v6.reorder,
            cls: document.querySelector('.v6-stripsarea').classList.contains('reordering'),
            src: document.querySelector('[data-testid="v6-strip-0"]').classList.contains('reorder-src'),
            line: !document.querySelector('[data-testid="v6-dropline"]').hidden,
            to: document.querySelector('[data-testid="v6-dropline"]').dataset.to,
            same: JSON.stringify(window.__rig.store.currentSong().patch.slots.map((s) => s.instrument.id)),
          }));
          await clearToasts();
          await page.waitForTimeout(120);
          await page.screenshot({ path: path.join(SHOTS, 'move-drag-1280.png') });
        },
      });
      assert.deepEqual(mid, { r: { from: 0, to: 2 }, cls: true, src: true, line: true, to: '2',
        same: JSON.stringify(a) }, 'nothing is written while dragging');
      await until((w) => JSON.stringify(window.__rig.store.currentSong().patch.slots.map((s) => s.instrument.id))
        === w, JSON.stringify([a[1], a[2], a[0], a[3]]));
      assert.deepEqual(await ev(() => ({
        cls: document.querySelector('.v6-stripsarea').classList.contains('reordering'),
        line: document.querySelector('[data-testid="v6-dropline"]').hidden,
        tf: [...document.querySelectorAll('.v6-strip')].map((e) => e.style.transform).join(''),
      })), { cls: false, line: true, tf: '' });
      // a press without travel, and a drag back onto its own place, write nothing
      const b = await ids();
      const g1 = await rectOf(page, tid('v6-grip-1'));
      await page.mouse.move(g1.cx, g1.cy);
      await page.mouse.down();
      await page.mouse.move(g1.cx + 3, g1.cy);
      await page.mouse.up();
      await dragGrip(1, (await stripMid(1)) + 10);
      // Esc mid-drag: dropped, no panic
      await armPanics();
      await dragGrip(1, (await stripMid(3)) + 40, { keep: true });
      assert.ok(await ev(() => !!window.__rig.views.v6.reorder));
      await page.keyboard.press('Escape');
      await until(() => !window.__rig.views.v6.reorder);
      await page.mouse.up();
      await page.waitForTimeout(150);
      assert.deepEqual(await ids(), b);
      assert.equal(await ev(() => window.__panics), 0, 'Esc ended the drag, no panic');
    });

  await T('U-MOVE drag with > 5 instruments: the row scrolls at its edge; the drop lands past the first five',
    async () => {
      await setSlots(7);
      await until(() => document.querySelectorAll('.v6-strip:not([hidden])').length === 7);
      await ev(() => { document.querySelector('[data-testid="v6-strips"]').scrollLeft = 0; });
      const a = await ids();
      const row = await rectOf(page, tid('v6-strips'));
      let sl = 0;
      await dragGrip(0, row.r - 8, {
        steps: 8,
        mid: async () => {
          await page.waitForTimeout(900);
          sl = await ev(() => document.querySelector('[data-testid="v6-strips"]').scrollLeft);
        },
      });
      assert.ok(sl > 100, `auto-scrolled ${sl} px`);
      const b = await ids();
      const at = b.indexOf(a[0]);
      assert.ok(at >= 5, `the first instrument now sits at ${at}`);
      assert.deepEqual(b.filter((_, k) => k !== at), a.slice(1), 'the others keep their order');
    });

  await T('U-MOVE Lock: no grip, Earlier / Later / Duplicate disabled; Lock, a song switch, Edit or a slot change '
    + 'end a drag unwritten', async () => {
    await setSlots(4);
    const a = await ids();
    await ev(() => window.__rig.store.set('settings.performLock', true));
    await until(() => document.querySelector('[data-testid="v6-grip-0"]').hidden);
    await page.click(tid('v6-more-1'));
    assert.deepEqual(await ev(() => ['earlier', 'later', 'dup'].map((k) => document.querySelector(
      `[data-testid="v6-${k}-1"]`).disabled)), [true, true, true]);
    await page.keyboard.press('Escape');
    assert.equal(await ev(() => window.__rig.views.v6.strips[0] && window.__rig.views.v6.reorder), null);
    await ev(() => window.__rig.store.set('settings.performLock', false));
    await until(() => !document.querySelector('[data-testid="v6-grip-0"]').hidden);
    const ends = {
      lock: () => ev(() => window.__rig.store.set('settings.performLock', true)),
      edit: () => ev(() => window.__rig.ctx.setView('edit')),
      add: () => ev(() => window.__rig.store.addSlot(window.__rig.store.currentSong().id)),
      move: () => ev(() => window.__rig.store.moveSlot(window.__rig.store.currentSong().id, 3, 2)),
      song: () => ev(() => {
        const { store, controller } = window.__rig;
        window.__songBefore = store.currentSong().id;
        const other = store.get().songOrder.find((k) => k !== window.__songBefore);
        controller.selectSong(other);
      }),
    };
    for (const [k, fn] of Object.entries(ends)) {
      const before = await ids();
      await dragGrip(0, (await stripMid(2)) + 20, { keep: true });
      assert.ok(await ev(() => !!window.__rig.views.v6.reorder), `${k}: dragging`);
      await fn();
      await until(() => !window.__rig.views.v6.reorder);
      await page.mouse.up();
      await page.waitForTimeout(150);
      if (k === 'song') {
        await settled();
        await ev(() => window.__rig.controller.selectSong(window.__songBefore));
        await settled();
      }
      const after = await ids();
      const want = k === 'add' ? [...before, null] : k === 'move' ? [before[0], before[1], before[3], before[2]]
        : before;
      assert.deepEqual(after, want, `${k}: no move written by the drag`);
      if (k === 'lock') await ev(() => window.__rig.store.set('settings.performLock', false));
      if (k === 'edit') await toPerform();
      if (k === 'add' || k === 'move') await setSlots(4);
    }
    assert.ok(a.length === 4);
  });

  await T('U-MOVE drag on touch (CDP): the grip drags at once, the row does not scroll, the name is not picked',
    async () => {
      const tc = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true });
      await pinTheme(tc, 'sanctuary');
      await tc.grantPermissions([...MIDI_PERMISSIONS], { origin });
      const tp = await tc.newPage();
      tp.on('console', (m) => {
        if (m.type() === 'error') errors.push(`[move-touch] ${m.text()}`);
      });
      tp.on('pageerror', (e) => errors.push(`[move-touch] pageerror: ${e.message}`));
      tp.on('response', (res) => {
        if (res.status() >= 400) errors.push(`[move-touch] HTTP ${res.status()} ${res.url()}`);
      });
      const tev = (fn, arg) => tp.evaluate(fn, arg);
      const tuntil = (fn, arg) => tp.waitForFunction(fn, arg, { timeout: 15000, polling: 50 });
      const cdp = await tc.newCDPSession(tp);
      const touch = (type, px, py) => cdp.send('Input.dispatchTouchEvent',
        { type, touchPoints: type === 'touchEnd' || type === 'touchCancel' ? [] : [{ x: px, y: py }] });
      try {
        await tp.goto(`${origin}/?ui6=1`);
        await waitRigReady(tp, { timeout: 40000 });
        await tuntil(() => !!window.__rig.views.v6);
        await tev(() => {
          const { store } = window.__rig;
          const id = store.currentSong().id;
          while (store.currentSong().patch.slots.length < 4) store.addSlot(id);
          ['salamander-piano', 'warm-pad', 'sub-bass', 'strings'].forEach((iid, i) => {
            const ref = { type: i === 0 ? 'sampler' : 'synth', id: iid };
            if (store.currentSong().patch.slots[i]) store.set(`songs.${id}.patch.slots.${i}.instrument`, ref);
            else store.set(`songs.${id}.patch.slots.${i}`, { instrument: ref });
          });
        });
        await tuntil(() => document.querySelectorAll('.v6-strip:not([hidden])').length === 4);
        const tids = () => tev(() => window.__rig.store.currentSong().patch.slots.map((s) => s.instrument.id));
        const a = await tids();
        await tp.waitForTimeout(400); // the layout settles (toasts, the sidebar's first paint)
        const g = await rectOf(tp, '[data-testid="v6-grip-1"]');
        const s3 = await rectOf(tp, '[data-testid="v6-strip-3"]');
        const x3 = s3.cx + s3.w / 4; // past strip 3's middle
        await touch('touchStart', g.cx, g.cy);
        for (let k = 1; k <= 10; k++) await touch('touchMove', g.cx + (x3 - g.cx) * k / 10, g.cy + 20);
        const mid = await tev((px) => ({ r: window.__rig.views.v6.reorder,
          sl: document.querySelector('[data-testid="v6-strips"]').scrollLeft, mids: [0, 1, 2, 3].map((i) => {
            const r = document.querySelector(`[data-testid="v6-strip-${i}"]`).getBoundingClientRect();
            return Math.round(r.left + r.width / 2);
          }), px: Math.round(px) }), x3);
        const { mids, px } = mid;
        delete mid.mids;
        delete mid.px;
        await touch('touchEnd');
        assert.deepEqual(mid, { r: { from: 1, to: 3 }, sl: 0 }, `pointer ${px}, strip mids ${mids}`);
        await tuntil((w) => JSON.stringify(window.__rig.store.currentSong().patch.slots.map((s) => s.instrument.id))
          === w, JSON.stringify([a[0], a[2], a[3], a[1]]));
        assert.equal(await tev(() => document.querySelector('.v6-kbd').classList.contains('picking')), false,
          'a grip drag picks no range');
        // a touch cancel (the system taking the touch) writes nothing
        const b = await tids();
        await touch('touchStart', g.cx, g.cy);
        for (let k = 1; k <= 6; k++) await touch('touchMove', g.cx + 40 * k, g.cy);
        await touch('touchCancel');
        await tuntil(() => !window.__rig.views.v6.reorder);
        await tp.waitForTimeout(150);
        assert.deepEqual(await tids(), b);
      } finally {
        await tc.close();
      }
    });

  await T('U-MOVE protections follow the order: a move closes ⋯ / step panels and drops a range drag + pick, '
    + 'restoring the dragged instrument (never its neighbour)', async () => {
    await setSlots(4);
    await setRange(0, 36, 96);
    await setRange(1, 40, 80);
    await setRange(2, 48, 72);
    await setRange(3, 60, 84);
    const id = (await song()).id;
    // ⋯ menu: a move keeps the count (U1 F2 keyed on it), the menu must close anyway
    await page.click(tid('v6-more-2'));
    await until(() => !!document.querySelector('[data-testid="v6-menu-2"]'));
    await ev((sid) => window.__rig.store.moveSlot(sid, 0, 3), id);
    await until(() => !document.querySelector('[data-testid="v6-menu-2"]'));
    // a step panel (Space)
    await page.click(tid('v6-space-1'));
    await until(() => !!document.querySelector('.v6 .step-panel'));
    await ev((sid) => window.__rig.store.moveSlot(sid, 3, 0), id);
    await until(() => !document.querySelector('.v6 .step-panel'));
    // range drag mid-move: slot 2's highest end dragged live, then slot 2 moves to 0
    for (const [label, op, j, gone] of [
      ['move', (sid) => window.__rig.store.moveSlot(sid, 2, 0), 0, false],
      ['insert', (sid) => window.__rig.store.insertSlot(sid, -1, null), 3, false],
      ['remove', (sid) => window.__rig.store.removeSlot(sid, 2), -1, true],
    ]) {
      await setSlots(4);
      await setRange(0, 36, 96);
      await setRange(1, 40, 80);
      await setRange(2, 48, 72);
      await setRange(3, 60, 84);
      await pickOn(page, 2);
      const before = (await song()).patch.slots.map((s) => [s.instrument.id, s.lowNote, s.highNote]);
      const h2 = await rectOf(page, tid(`${KB}-hhi-2`));
      const k65 = await keyRect(page, 65);
      await page.mouse.move(h2.cx, h2.cy);
      await page.mouse.down();
      await page.mouse.move(k65.r, h2.cy, { steps: 6 });
      await until(() => window.__rig.store.currentSong().patch.slots[2].highNote === 65); // live
      await ev(op, id);
      await until(() => !document.querySelector('.v6-kbd').classList.contains('dragging'));
      await page.mouse.move(k65.r - 30, h2.cy, { steps: 2 });
      await page.mouse.up();
      await page.waitForTimeout(200);
      const after = (await song()).patch.slots.map((s) => (s ? [s.instrument.id, s.lowNote, s.highNote] : null));
      const want = label === 'move' ? [before[2], before[0], before[1], before[3]]
        : label === 'insert' ? [null, ...before] : [before[0], before[1], before[3]];
      assert.deepEqual(after, want, `${label}: the dragged instrument is back to 48–72 (at ${j}), the others untouched`);
      assert.equal(await ev(() => window.__rig.views.v6.kb.picked), null, `${label}: the pick ended`);
      assert.ok(gone || after[j][2] === 72);
    }
  });

  await T('U-MOVE Edit: the selected instrument tab and the 8 s Undo follow a move', async () => {
    await setSlots(3);
    const a = await ids();
    const id = (await song()).id;
    await ev(() => window.__rig.ctx.setView('edit'));
    await until(() => document.body.dataset.view === 'edit');
    await ev(() => window.__rig.views.edit.editState.select('slot:2'));
    // Remove this sound… → Remove → the toast's Undo (8 s)
    await page.click('.ev2-slot-chg');
    await page.click('.ev2-slot-mi-remove');
    await page.click('.ev2-slot-remove');
    await until(() => window.__rig.store.currentSong().patch.slots[2] === null);
    await until(() => !!document.querySelector('#toasts .toast-action'));
    // the v6 Perform moves the empty slot 2 to the front (e.g. ⋯ Earlier twice), Edit still mounted
    await ev((sid) => window.__rig.store.moveSlot(sid, 2, 0), id);
    await until(() => window.__rig.views.edit.editState.selected === 'slot:0');
    await page.click('#toasts .toast-action');
    await until(() => !!window.__rig.store.currentSong().patch.slots[0]);
    assert.deepEqual(await ids(), [a[2], a[0], a[1]], 'the sound came back to its own (moved) slot');
    // an instrument change's Undo follows too
    await clearToasts();
    await ev(() => window.__rig.views.edit.editState.select('slot:1'));
    await page.click('.ev2-slot-chg');
    const pickOther = await ev(() => {
      const cur = window.__rig.store.currentSong().patch.slots[1].instrument;
      const b = [...document.querySelectorAll('.ev2-slot-menu [role="menuitemradio"]')]
        .find((x2) => x2.getAttribute('aria-checked') !== 'true' && x2.dataset.value
          && x2.dataset.value !== `${cur.type}:${cur.id}`);
      b.click();
      return b.dataset.value;
    });
    await until((v) => {
      const s = window.__rig.store.currentSong().patch.slots[1].instrument;
      return `${s.type}:${s.id}` === v;
    }, pickOther);
    await until(() => !!document.querySelector('#toasts .toast-action'));
    await ev((sid) => window.__rig.store.moveSlot(sid, 1, 2), id);
    await until(() => window.__rig.views.edit.editState.selected === 'slot:2');
    await page.click('#toasts .toast-action');
    await until((w) => window.__rig.store.currentSong().patch.slots[2].instrument.id === w, a[0]);
    assert.deepEqual(await ids(), [a[2], a[1], a[0]]);
    await clearToasts();
    await toPerform();
  });

  await T('D23.1 PANIC is one tap; Lock: one tap locks, unlocking needs the hold (as today’s Perform)', async () => {
    await armPanics();
    await page.click(tid('v6-panic'));
    await until(() => window.__panics === 1);
    assert.equal(await page.textContent(`${tid('v6-panic')} .panic-k`), 'or Esc');
    await page.click(tid('v6-lock'));
    await until(() => window.__rig.store.get().settings.performLock === true);
    await page.click(tid('v6-lock'));
    await page.waitForTimeout(200);
    assert.equal(await ev(() => window.__rig.store.get().settings.performLock), true, 'a tap does not unlock');
    await hold(tid('v6-lock'));
    await until(() => !window.__rig.store.get().settings.performLock);
  });

  await T('D24.2 range drag heard live: ≤ 1 write per 50 ms, the last on release; per-write cost timed', async () => {
    await setSlots(4);
    await setRange(1, 36, 60);
    await pickOn(page, 1);
    await ev(() => {
      const { store } = window.__rig;
      window.__rw = [];
      if (window.__rwOff) window.__rwOff();
      window.__rwOff = store.subscribe((st, paths) => {
        if (paths.some((p) => /patch\.slots\.1\.highNote$/.test(p))) {
          window.__rw.push([performance.now(), st.songs[st.settings.currentSongId].patch.slots[1].highNote]);
        }
      });
      window.__lt = [];
      try {
        window.__ltObs?.disconnect();
        window.__ltObs = new PerformanceObserver((l) => window.__lt.push(...l.getEntries().map((e) => e.duration)));
        window.__ltObs.observe({ type: 'longtask' });
      } catch { /* no longtask API */ }
    });
    const hd = await rectOf(page, tid(`${KB}-hhi-1`));
    const k84 = await keyRect(page, 84);
    const t0 = Date.now();
    await page.mouse.move(hd.cx, hd.cy);
    await page.mouse.down();
    // ~1.2 s: 60 small moves with a pause each, like a hand sweeping two octaves
    for (let k = 1; k <= 60; k++) {
      await page.mouse.move(hd.cx + (k84.r - hd.cx) * k / 60, hd.cy);
      await page.waitForTimeout(15);
    }
    const midHi = await ev(() => window.__rig.store.currentSong().patch.slots[1].highNote);
    await page.mouse.up();
    const dragMs = Date.now() - t0;
    await until(() => window.__rig.store.currentSong().patch.slots[1].highNote === 84);
    await page.waitForTimeout(100);
    const r = await ev(() => ({ w: window.__rw.slice(), lt: window.__lt.slice() }));
    const gaps = r.w.slice(1).map((w, k) => w[0] - r.w[k][0]);
    assert.ok(midHi > 60, `written while dragging (${midHi})`);
    assert.ok(r.w.length >= 5, `${r.w.length} writes over ${dragMs} ms`);
    // notifications are microtask-batched: two writes inside one task would show as one; 50 ms apart, minus timer
    // jitter (≥ 40 ms) for all but the release write
    const tight = gaps.slice(0, -1).filter((g) => g < 40);
    assert.deepEqual(tight, [], `gaps ${gaps.map((g) => g.toFixed(0)).join(',')}`);
    assert.equal(r.w[r.w.length - 1][1], 84, 'the final value is the release value');
    // the cost of one live write: store.set + its notification (the whole v6 render + the store → engine diff)
    const cost = await ev(() => {
      const { store } = window.__rig;
      const id = store.currentSong().id;
      const t = [];
      for (let k = 0; k < 40; k++) {
        const a = performance.now();
        store.set(`songs.${id}.patch.slots.1.highNote`, 70 + (k % 10));
        store.flush();
        t.push(performance.now() - a);
      }
      t.sort((p, q) => p - q);
      return { med: t[20], p95: t[37], max: t[39] };
    });
    await ev(() => {
      window.__rwOff?.();
      window.__ltObs?.disconnect();
    });
    console.log(`      [timing] ${r.w.length} live writes in a ${dragMs} ms drag; gaps min ${Math.min(...gaps)
      .toFixed(1)} / median ${[...gaps].sort((p, q) => p - q)[gaps.length >> 1].toFixed(1)} ms; one write + render `
      + `median ${cost.med.toFixed(2)} ms, p95 ${cost.p95.toFixed(2)}, max ${cost.max.toFixed(2)} ms; long tasks `
      + `during the drag: ${r.lt.length} (${r.lt.map((d) => d.toFixed(0)).join(', ') || '-'} ms)`);
    assert.ok(cost.p95 < 50, `one write costs ${cost.p95} ms at p95 (the throttle interval is 50)`);
  });

  await T('D24.2 every cancel path puts the pre-drag value back: Lock, Edit, a song switch, a pick switch, '
    + 'a touch cancel', async () => {
    await setSlots(4);
    const id = (await song()).id;
    const paths = {
      lock: { run: () => ev(() => window.__rig.store.set('settings.performLock', true)),
        after: () => ev(() => window.__rig.store.set('settings.performLock', false)) },
      edit: { run: () => ev(() => window.__rig.ctx.setView('edit')), after: toPerform },
      song: {
        run: () => ev((sid) => {
          const { store, controller } = window.__rig;
          controller.selectSong(store.get().songOrder.find((k) => k !== sid));
        }, id),
        after: async () => {
          await settled();
          await ev((sid) => window.__rig.controller.selectSong(sid), id);
          await settled();
        },
      },
      pick: { run: () => ev(() => document.querySelector('[data-testid="v6-who-0"]').click()), after: async () => {} },
    };
    for (const [k, p] of Object.entries(paths)) {
      await setRange(1, 40, 64);
      await pickOn(page, 1);
      const hd = await rectOf(page, tid(`${KB}-hhi-1`));
      const k76 = await keyRect(page, 76);
      await page.mouse.move(hd.cx, hd.cy);
      await page.mouse.down();
      await page.mouse.move(k76.r, hd.cy, { steps: 6 });
      await until(() => window.__rig.store.getSong(window.__rig.store.currentSong().id).patch.slots[1].highNote === 76);
      await p.run();
      await until((sid) => window.__rig.store.getSong(sid).patch.slots[1].highNote === 64, id, 5000)
        .catch(async (e) => {
          throw new Error(`${k}: ${await ev((sid) => JSON.stringify([window.__rig.store.getSong(sid).patch.slots[1],
            window.__rig.views.v6.kb.dragging]), id)} ${e.message}`);
        });
      await page.mouse.up();
      await page.waitForTimeout(150);
      assert.equal(await ev((sid) => window.__rig.store.getSong(sid).patch.slots[1].highNote, id), 64, k);
      await p.after();
    }
    // pointercancel (a touch the system takes): its own touch context
    const tc = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true });
    await pinTheme(tc, 'sanctuary');
    await tc.grantPermissions([...MIDI_PERMISSIONS], { origin });
    const tp = await tc.newPage();
    tp.on('console', (m) => {
      if (m.type() === 'error') errors.push(`[cancel-touch] ${m.text()}`);
    });
    tp.on('pageerror', (e) => errors.push(`[cancel-touch] pageerror: ${e.message}`));
    const cdp = await tc.newCDPSession(tp);
    const touch = (type, px, py) => cdp.send('Input.dispatchTouchEvent',
      { type, touchPoints: type === 'touchCancel' || type === 'touchEnd' ? [] : [{ x: px, y: py }] });
    try {
      await tp.goto(`${origin}/?ui6=1`);
      await waitRigReady(tp, { timeout: 40000 });
      await tp.waitForFunction(() => !!window.__rig.views.v6);
      await tp.evaluate(() => {
        const { store } = window.__rig;
        const sid = store.currentSong().id;
        const p = `songs.${sid}.patch.slots.0`;
        store.set(`${p}.lowNote`, 0);
        store.set(`${p}.highNote`, 127);
        store.set(`${p}.lowNote`, 48);
        store.set(`${p}.highNote`, 72);
      });
      const who = await rectOf(tp, '[data-testid="v6-who-0"]');
      await tp.touchscreen.tap(who.cx, who.cy);
      await tp.waitForFunction(() => window.__rig.views.v6.kb.picked === 0);
      const hd = await rectOf(tp, '[data-testid="v6-kbd-hhi-0"]');
      const k84 = await keyRect(tp, 84);
      await touch('touchStart', hd.cx, hd.cy);
      for (let m = 1; m <= 8; m++) await touch('touchMove', hd.cx + (k84.r - hd.cx) * m / 8, hd.cy);
      await tp.waitForFunction(() => window.__rig.store.currentSong().patch.slots[0].highNote > 72);
      await touch('touchCancel');
      await tp.waitForFunction(() => window.__rig.store.currentSong().patch.slots[0].highNote === 72);
    } finally {
      await tc.close();
    }
  });

  await T('D24.3 pick first on a mouse too: no handles or drag on an unpicked bar; the name or bar picks; '
    + 'the keys / Esc finish', async () => {
    await setSlots(3);
    await setRange(1, 48, 72);
    await ev(() => window.__rig.views.v6.kb.pick(null));
    const b1 = await rectOf(page, tid(`${KB}-bar-1`));
    assert.deepEqual(await ev(() => ({
      shown: [...document.querySelectorAll('.v6-kbd .v6-rh')].filter((e) => getComputedStyle(e).display !== 'none')
        .length,
      role: document.querySelector('[data-testid="v6-who-1"]').getAttribute('role'),
    })), { shown: 0, role: 'button' });
    // hover over the end: no hot handle, a pointer cursor (a click picks); a press-drag there moves nothing
    await page.mouse.move(b1.r, b1.cy);
    await page.mouse.move(b1.r - 1, b1.cy);
    await until(() => document.querySelector('[data-testid="v6-kbd-hit"]').classList.contains('pickable'));
    assert.deepEqual(await ev(() => ({
      hot: !!document.querySelector('.v6-kbd .v6-rh.hot'),
      cursor: getComputedStyle(document.querySelector('[data-testid="v6-kbd-hit"]')).cursor,
    })), { hot: false, cursor: 'pointer' });
    await page.mouse.down();
    await page.mouse.move(b1.r + 80, b1.cy, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    const s1 = (await song()).patch.slots[1];
    assert.deepEqual([s1.lowNote, s1.highNote], [48, 72]);
    assert.equal(await ev(() => window.__rig.views.v6.kb.picked), 1, 'that press picked it');
    assert.match(await page.textContent(tid(`${KB}-pickhint`)), /click another instrument to switch · click the keys/);
    // now the handle is live: hover lights it
    const hh = await rectOf(page, tid(`${KB}-hhi-1`));
    await page.mouse.move(hh.cx, hh.cy);
    await until(() => !!document.querySelector('.v6-kbd .v6-rh.hot'));
    // a click on the keys finishes (no note)
    const k60 = await keyRect(page, 60);
    await page.mouse.click(k60.cx, k60.b - 10);
    await until(() => window.__rig.views.v6.kb.picked === null);
    // a click on the strip name picks, Esc finishes without a panic
    await armPanics();
    await page.click(tid('v6-who-2'));
    await until(() => window.__rig.views.v6.kb.picked === 2);
    assert.equal(await page.getAttribute(tid('v6-who-2'), 'aria-pressed'), 'true');
    await page.keyboard.press('Escape');
    await until(() => window.__rig.views.v6.kb.picked === null);
    assert.equal(await ev(() => window.__panics), 0);
    // Enter on a focused name picks too (the keyboard path)
    await page.focus(tid('v6-who-0'));
    await page.keyboard.press('Enter');
    await until(() => window.__rig.views.v6.kb.picked === 0);
    await page.keyboard.press('Escape');
    await ev(() => document.activeElement?.blur?.());
  });

  await T('D24.6 the drone’s Bright / Move show a percentage beside the word', async () => {
    await ev(() => window.__rig.views.v6.sidebar.open('drone'));
    await until(() => !!document.querySelector('[data-testid="v6-drone-bright"]'));
    const id = (await song()).id;
    await ev((sid) => {
      window.__rig.store.set(`songs.${sid}.drone.brightness`, 0.48);
      window.__rig.store.set(`songs.${sid}.drone.movement`, 0.9);
    }, id);
    await until(() => /48%/.test(document.querySelector('[data-testid="v6-drone-bright"] .fader-value')?.textContent));
    assert.deepEqual(await ev(() => ['bright', 'move'].map((k) => document.querySelector(
      `[data-testid="v6-drone-${k}"] .fader-value`).textContent.trim())), ['Soft · 48%', 'Restless · 90%']);
  });

  await T('small-window fit: 1024×700 starts with the sidebar folded; 4 instruments, slim Add, no sideways scroll; '
    + 'opened once there, it starts open', async () => {
    const sc = await browser.newContext({ viewport: { width: 1024, height: 700 } });
    await pinTheme(sc, 'sanctuary');
    await sc.grantPermissions([...MIDI_PERMISSIONS], { origin });
    const sp = await sc.newPage();
    sp.on('console', (m) => {
      if (m.type() === 'error') errors.push(`[small] ${m.text()}`);
    });
    sp.on('pageerror', (e) => errors.push(`[small] pageerror: ${e.message}`));
    sp.on('response', (res) => {
      if (res.status() >= 400) errors.push(`[small] HTTP ${res.status()} ${res.url()}`);
    });
    const sev = (fn, arg) => sp.evaluate(fn, arg);
    const suntil = (fn, arg) => sp.waitForFunction(fn, arg, { timeout: 15000, polling: 50 });
    const measure = () => sev(() => {
      const row = document.querySelector('[data-testid="v6-strips"]');
      const q = (s) => document.querySelector(s).getBoundingClientRect();
      return {
        rail: document.querySelector('.v6-side').classList.contains('rail'),
        slim: document.querySelector('[data-testid="v6-add"]').classList.contains('slim'),
        rowOver: row.scrollWidth - row.clientWidth,
        pills: !document.querySelector('[data-testid="v6-pills"]').hidden,
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        strip: Math.round(q('[data-testid="v6-strip-0"]').width),
        track: Math.round(document.querySelector('[data-testid="v6-strip-0"] .fader-track').getBoundingClientRect()
          .height),
        side: Math.round(q('.v6-side').width),
      };
    });
    try {
      await sp.goto(`${origin}/?ui6=1`);
      await waitRigReady(sp, { timeout: 40000 });
      await suntil(() => !!window.__rig.views.v6);
      await sev(({ list }) => {
        const { store } = window.__rig;
        const id = store.currentSong().id;
        while (store.currentSong().patch.slots.length < 4) store.addSlot(id);
        while (store.currentSong().patch.slots.length > 4) store.removeSlot(id);
        list.forEach(([type, iid], i) => {
          const ref = { type, id: iid };
          if (store.currentSong().patch.slots[i]) store.set(`songs.${id}.patch.slots.${i}.instrument`, ref);
          else store.set(`songs.${id}.patch.slots.${i}`, { instrument: ref });
        });
      }, { list: [['sampler', 'salamander-piano'], ['synth', 'warm-pad'], ['synth', 'sub-bass'],
        ['synth', 'strings']] });
      await suntil(() => document.querySelectorAll('.v6-strip:not([hidden])').length === 4);
      await sp.waitForTimeout(400);
      const folded = await measure();
      assert.deepEqual({ rail: folded.rail, slim: folded.slim, rowOver: folded.rowOver <= 0, pills: folded.pills,
        page: folded.page }, { rail: true, slim: true, rowOver: true, pills: false, page: 0 }, JSON.stringify(folded));
      await sev(() => document.getElementById('toasts')?.replaceChildren());
      await sp.screenshot({ path: path.join(SHOTS, 'move-fit-1024x700.png') });
      // the player opens it at this size: remembered (per device), so the next start keeps it open
      await sp.click('[data-testid="v6-sb-open"]');
      await suntil(() => !document.querySelector('.v6-side').classList.contains('rail'));
      await sp.waitForTimeout(300);
      const open = await measure();
      assert.equal(await sev(() => JSON.parse(localStorage.getItem('worship-rig.v6.sidebar')).smallOpen), true);
      await sev(() => document.getElementById('toasts')?.replaceChildren());
      await sp.screenshot({ path: path.join(SHOTS, 'move-fit-1024x700-open.png') });
      console.log(`      [fit] 1024×700, 4 instruments: folded ${JSON.stringify(folded)}; open ${JSON.stringify(open)}`);
      await sp.reload();
      await waitRigReady(sp, { timeout: 40000 });
      await suntil(() => !!window.__rig.views.v6);
      assert.equal(await sev(() => document.querySelector('.v6-side').classList.contains('rail')), false,
        'opened here before → starts open');
    } finally {
      await sc.close();
    }
  });
}
