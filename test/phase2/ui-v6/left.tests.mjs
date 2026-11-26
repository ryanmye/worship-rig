// UI v6 U4: the left panel (app/js/views/v6/left.js; native/docs/lanes/UI6-build-plan.md U4; mockup perform-v6.html
// "Left · Quick open"). Run from run.mjs on its page (the v6 Perform is on): the Quick button and the top bar's open
// the one Quick sheet (anchored to the opener, floating: the strips don't move), Esc closes it and hands focus back,
// TAP / Swell time / Touch / Reversed write today's paths, the wheel column follows simulated MIDI (CC1 with pickup,
// CC11, CC64, pitch bend) and the on-screen wheel / Swell the way ui-core tests today's, the target names the
// instrument, Lock leaves it all live but This Mac, the 1024×700 fit, iPad portrait (no sideways page scroll, the
// panel at the left of the strips) and screenshots (1280×800, 1024×700, 820×1180).
import path from 'node:path';
import { MIDI_PERMISSIONS, waitRigReady, pinTheme } from '../../integration/lib.mjs';

/**
 * Wait for the sheet's open animation (the theme's fade, e.g. Sanctuary's 160 ms sanct-fade): a screenshot taken at
 * once showed the sheet half transparent over the strips (skeptic UI6-U4 F2).
 * @param {import('playwright').Page} p
 */
const settledAnim = (p) => p.evaluate(() => Promise.all(document.querySelector('.qs').getAnimations({ subtree: true })
  .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime))
  .map((a) => a.finished.catch(() => {}))));

/**
 * @param {object} x  run.mjs's helpers: {T, page, browser, origin, ev, until, tid, song, settled, setSlots, SHOTS,
 *   assert}
 */
export async function leftTests(x) {
  const { T, page, browser, origin, ev, until, tid, song, settled, setSlots, SHOTS, assert } = x;
  const rect = (sel) => ev((s) => {
    const e = document.querySelector(s);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height };
  }, sel);
  const quickOpen = () => ev(() => window.__rig.views.v6.quickOpen);
  const shown = () => ev(() => document.querySelector('.v6-left .wheel-value').textContent);
  const inject = (bytes) => ev((b) => window.__rig.midi._inject(b), bytes);
  const clearToasts = () => ev(() => document.getElementById('toasts')?.replaceChildren());

  await T('U4 left panel: Quick on top, today’s wheel column below (no placeholder)', async () => {
    await ev(() => window.__rig.ctx.setView('perform'));
    await settled();
    await setSlots(2);
    const r = await ev(() => {
      const left = document.querySelector('[data-testid="v6-left"]');
      const kids = [...left.children].map((c) => c.className);
      return {
        placeholder: left.classList.contains('v6-slot-ph'),
        kids,
        quick: !!left.querySelector('[data-testid="v6-quick"]'),
        wheel: !!left.querySelector('[data-testid="v6-wheel"] .wheel-input'),
        swell: !!left.querySelector('.swell-btn'),
        pedal: !!left.querySelector('[data-testid="pedal-lamp"]'),
        bend: !!left.querySelector('.drone-swell'),
        width: left.getBoundingClientRect().width,
        sheets: document.querySelectorAll('[data-testid="quick-sheet"]').length,
        leftOfStrips: left.getBoundingClientRect().right <= document.querySelector('.v6-stripsarea')
          .getBoundingClientRect().left,
      };
    });
    assert.deepEqual(r, { placeholder: false, kids: ['btn v6-quick', 'panel v6-wheel'], quick: true, wheel: true,
      swell: true, pedal: true, bend: true, width: 84, sheets: 1, leftOfStrips: true });
  });

  await T('U4 Quick: both buttons open the one sheet, anchored to the opener; strips don’t move; Esc closes',
    async () => {
    const strips0 = await rect('.v6-stripsarea');
    const btn = await rect(tid('v6-quick'));
    await page.click(tid('v6-quick'));
    await until(() => window.__rig.views.v6.quickOpen === true);
    const a = await ev(() => ({
      sheets: document.querySelectorAll('[data-testid="quick-sheet"]').length,
      cls: document.querySelector('.qs').className,
      left: document.querySelector('[data-testid="v6-quick"]').getAttribute('aria-expanded'),
      top: document.getElementById('btn-quick').getAttribute('aria-expanded'),
      on: document.querySelector('[data-testid="v6-quick"]').classList.contains('on'),
      sections: [...document.querySelectorAll('.qs .qs-sec')].map((s) => s.getAttribute('aria-label')),
      inV6: !!document.querySelector('.v6 > .qs'),
    }));
    assert.deepEqual(a, { sheets: 1, cls: 'qs from-left', left: 'true', top: 'true', on: true,
      sections: ['This song', 'This Mac', 'If something’s wrong'], inV6: true });
    const qs = await rect('.qs');
    assert.ok(qs.l >= btn.r + 4 && qs.l <= btn.r + 20, `the sheet sits beside the button (${qs.l} vs ${btn.r})`);
    assert.ok(Math.abs(qs.t - btn.t) <= 1, `top-aligned with the button (${qs.t} vs ${btn.t})`);
    assert.ok(qs.b <= 800, `inside the window (${qs.b})`);
    assert.deepEqual(await rect('.v6-stripsarea'), strips0, 'nothing reflows');
    // the top bar's Quick closes the same sheet; opening from it drops it under that button instead
    await page.click('#btn-quick');
    await until(() => window.__rig.views.v6.quickOpen === false);
    assert.equal(await page.getAttribute(tid('v6-quick'), 'aria-expanded'), 'false');
    await page.click('#btn-quick');
    await until(() => window.__rig.views.v6.quickOpen === true);
    const tb = await rect('#btn-quick');
    const qs2 = await rect('.qs');
    assert.equal(await ev(() => document.querySelector('.qs').className), 'qs from-top');
    assert.equal(await ev(() => document.querySelectorAll('[data-testid="quick-sheet"]').length), 1);
    assert.ok(qs2.t > tb.b && qs2.l <= tb.l + tb.w / 2 && qs2.r >= tb.l + tb.w / 2, 'under the top bar’s Quick');
    // the left button closes it too (one sheet, two openers)
    await page.click(tid('v6-quick'));
    await until(() => window.__rig.views.v6.quickOpen === false);
    // Esc: closes without a panic, focus back on the opener
    await ev(() => {
      window.__u4panics = 0;
      window.__rig.controller.addEventListener('action', (e) => {
        if (e.detail?.type === 'panic') window.__u4panics += 1;
      });
    });
    await page.click(tid('v6-quick'));
    await until(() => window.__rig.views.v6.quickOpen === true);
    await page.focus(tid('quick-tap'));
    await page.keyboard.press('Escape');
    await until(() => window.__rig.views.v6.quickOpen === false);
    const esc = await ev(() => ({
      panics: window.__u4panics,
      focus: document.activeElement?.dataset.testid,
      hidden: document.querySelector('.qs').hidden,
    }));
    assert.deepEqual(esc, { panics: 0, focus: 'v6-quick', hidden: true });
    await ev(() => document.activeElement?.blur());
    // the sheet closes when Perform is left (as today)
    await page.click(tid('v6-quick'));
    await until(() => window.__rig.views.v6.quickOpen === true);
    await ev(() => window.__rig.ctx.setView('edit'));
    await until(() => window.__rig.views.v6.quickOpen === false);
    await ev(() => window.__rig.ctx.setView('perform'));
    assert.equal(await page.getAttribute(tid('v6-quick'), 'aria-expanded'), 'false');
  });

  await T('U4 skeptic F1: an open sheet follows its opener on a window resize / rotation and a snapshots fold',
    async () => {
      // the sheet used to be placed once, on open: 1280 → 1024 left it 34 px off the left Quick (the column narrows to
      // 64 px), 24 px below it, its arrow pointing at nothing and over Revert
      const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
      const fit = async (from) => {
        const q = await rect('.qs');
        const b = await rect(from === 'left' ? tid('v6-quick') : '#btn-quick');
        return from === 'left' ? { beside: near(q.l - b.r, 12), top: near(q.t, b.t) }
          : { beside: q.t > b.b && q.l <= b.l + b.w / 2 && q.r >= b.l + b.w / 2, top: true };
      };
      try {
        for (const from of ['left', 'top']) {
          const sel = from === 'left' ? tid('v6-quick') : '#btn-quick';
          await page.setViewportSize({ width: 1280, height: 800 });
          await page.click(sel);
          await until(() => window.__rig.views.v6.quickOpen === true);
          assert.deepEqual(await fit(from), { beside: true, top: true }, `${from}: 1280×800`);
          for (const [w, h] of [[1024, 700], [820, 1180], [1180, 820]]) {
            await page.setViewportSize({ width: w, height: h });
            await page.waitForTimeout(150);
            assert.deepEqual(await fit(from), { beside: true, top: true }, `${from}: resized to ${w}×${h}`);
            const qs = await rect('.qs');
            assert.ok(qs.r <= w && qs.b <= h, `${from} ${w}×${h}: inside the window (${qs.r}, ${qs.b})`);
          }
          await page.click(sel);
          await until(() => window.__rig.views.v6.quickOpen === false);
        }
        // the snapshots row folds (⌃) and unfolds (the song bar's chip) under an open sheet: the board moves
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.click(tid('v6-quick'));
        await until(() => window.__rig.views.v6.quickOpen === true);
        const t0 = (await rect(tid('v6-quick'))).t;
        await page.click(tid('v6-snap-fold'));
        await page.waitForTimeout(150);
        assert.ok((await rect(tid('v6-quick'))).t < t0 - 20, 'the fold moved the board up');
        assert.deepEqual(await fit('left'), { beside: true, top: true }, 'after the fold');
        await page.click(tid('v6-snap-chip'));
        await page.waitForTimeout(150);
        assert.deepEqual(await fit('left'), { beside: true, top: true }, 'after the unfold');
        assert.equal(await quickOpen(), true, 'the sheet stays open');
        await page.click(tid('v6-quick'));
        await until(() => window.__rig.views.v6.quickOpen === false);
      } finally {
        await page.setViewportSize({ width: 1280, height: 800 });
        await ev(() => window.__rig.views.v6.closeQuick());
      }
    });

  await T('U4 Quick: TAP sets the tempo; Swell time, Touch, Reversed write today’s paths', async () => {
    const before = await song();
    const st0 = await ev(() => {
      const s = window.__rig.store.get().settings;
      return { touch: s.velocitySens, inv: !!s.pedalInvert };
    });
    await page.click(tid('v6-quick'));
    await until(() => window.__rig.views.v6.quickOpen === true);
    // four taps ~500 ms apart ≈ 120 BPM (quickSheet tapBpm: the mean of the last ≤ 4 intervals); a loaded box drifts
    // the timers, so the expected tempo comes from the taps' own times
    const want = await ev(async () => {
      const b = document.querySelector('[data-testid="quick-tap"]');
      const ts = [];
      for (let k = 0; k < 4; k++) {
        ts.push(performance.now());
        b.click();
        if (k < 3) await new Promise((r) => setTimeout(r, 500));
      }
      return Math.round(60000 / ((ts[3] - ts[0]) / 3));
    });
    assert.ok(want >= 30 && want <= 300, `taps at ${want} BPM`);
    await until((w) => Math.abs((window.__rig.store.currentSong().tempo || 0) - w) <= 2, want);
    const bpm = await ev(() => document.querySelector('.qs-bpm').firstChild.textContent);
    assert.equal(Number(bpm), (await song()).tempo, 'the sheet shows the new tempo');
    // Swell time +
    const sw0 = before.patch.swell?.seconds ?? 8;
    await page.locator('.qs .stepper .step-btn').last().click();
    await until((s) => window.__rig.store.currentSong().patch.swell?.seconds === s + 1, sw0);
    // Touch → settings.velocitySens; Reversed → settings.pedalInvert
    const next = st0.touch === 'hard' ? 'soft' : 'hard';
    await page.click(`.qs .segmented [data-value="${next}"]`);
    await until((v) => window.__rig.store.get().settings.velocitySens === v, next);
    await page.click('.qs .qs-pedalrow .toggle');
    await until((v) => !!window.__rig.store.get().settings.pedalInvert === !v, st0.inv);
    // put them back
    await ev(({ id, tempo, swell, st }) => {
      const { store } = window.__rig;
      store.set(`songs.${id}.tempo`, tempo);
      store.set(`songs.${id}.patch.swell.seconds`, swell);
      store.set('settings.velocitySens', st.touch);
      store.set('settings.pedalInvert', st.inv);
    }, { id: before.id, tempo: before.tempo, swell: sw0, st: st0 });
    await page.click(tid('v6-quick'));
    await until(() => window.__rig.views.v6.quickOpen === false);
  });

  await T('U4 wheel column follows MIDI: CC1 (pickup), CC11, CC64 pedal lamp, pitch bend; panic clears the bend',
    async () => {
      // the on-screen value first (as ui-core: controller.perform.wheel)
      await ev(() => window.__rig.controller.perform.wheel(0.5));
      await until(() => document.querySelector('.v6-left .wheel-value').textContent === '50%');
      // hardware below the virtual value: pickup ghost, value held
      await inject([0xb0, 1, 20]);
      await until(() => document.querySelector('.v6-left .wheel-strip').classList.contains('pickup'));
      assert.equal(await shown(), '50%');
      // crossing it takes over; the column follows the hardware from then on
      await inject([0xb0, 1, 70]);
      await inject([0xb0, 1, 100]);
      await until(() => document.querySelector('.v6-left .wheel-value').textContent === '79%');
      assert.equal(await ev(() => document.querySelector('.v6-left .wheel-strip').classList.contains('pickup')), false);
      const mod = await ev(() => window.__rig.engine.wheelValues().mod);
      assert.ok(Math.abs(mod - 100 / 127) < 0.01, `engine mod ${mod}`);
      await inject([0xb0, 1, 127]);
      await until(() => document.querySelector('.v6-left .wheel-value').textContent === '100%');
      // CC11: the Expr row appears once expression has been seen
      await inject([0xb0, 11, 64]);
      await until(() => {
        const r = document.querySelectorAll('.v6-left .wheel-extra')[0];
        return !r.hidden && /50%/.test(r.textContent);
      });
      await inject([0xb0, 11, 127]);
      // CC64: the pedal lamp (and "pedal-down" on the view)
      await inject([0xb0, 64, 127]);
      await until(() => document.querySelector('.v6-left [data-testid="pedal-lamp"]').classList.contains('down')
        && document.querySelector('.v6-perform').classList.contains('pedal-down'), null, 3000);
      assert.equal(await page.getAttribute('.v6-left [data-testid="pedal-lamp"]', 'aria-label'), 'Sustain pedal down');
      await inject([0xb0, 64, 0]);
      await until(() => !document.querySelector('.v6-left [data-testid="pedal-lamp"]').classList.contains('down'),
        null, 3000);
      // pitch bend → the drone-swell lamp, while the song bends the drone
      const id = (await song()).id;
      const mode0 = (await song()).patch.bend?.mode;
      await ev((i) => window.__rig.store.set(`songs.${i}.patch.bend.mode`, 'drone-swell'), id);
      await until(() => !document.querySelector('.v6-left .drone-swell').hidden);
      await inject([0xe0, 0x7f, 0x7f]);
      await until(() => document.querySelector('.v6-left .drone-swell').classList.contains('up'));
      await ev(() => window.__rig.controller.panic());
      await until(() => !document.querySelector('.v6-left .drone-swell').classList.contains('up'));
      await inject([0xe0, 0x00, 0x40]);
      if (mode0 && mode0 !== 'drone-swell') {
        await ev(({ i, m }) => window.__rig.store.set(`songs.${i}.patch.bend.mode`, m), { i: id, m: mode0 });
        await until(() => document.querySelector('.v6-left .drone-swell').hidden);
      }
    });

  await T('U4 wheel: the target names the instrument; Swell raises the wheel, again returns; tap doesn’t jump',
    async () => {
      const id = (await song()).id;
      const t0 = (await song()).patch.modWheel?.target;
      const name = await ev(() => document.querySelector('[data-testid="v6-strip-1"] .v6-nm').textContent);
      await ev((i) => window.__rig.store.set(`songs.${i}.patch.modWheel.target`, 'slots.1.gain'), id);
      await until((n) => document.querySelector('.v6-left .wheel-target').textContent === `→ ${n} level`, name);
      await ev((i) => window.__rig.store.set(`songs.${i}.patch.modWheel.target`, 'drone.gain'), id);
      await until(() => document.querySelector('.v6-left .wheel-target').textContent === '→ Drone');
      if (t0) await ev(({ i, t }) => window.__rig.store.set(`songs.${i}.patch.modWheel.target`, t), { i: id, t: t0 });
      // Swell (as ui-core "Swell raises the wheel value over time; pressing again returns")
      const r = await ev(async () => {
        const e = window.__rig.engine;
        const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
        const b = document.querySelector('.v6-left .swell-btn');
        b.click();
        await sleep(300);
        const a = e.wheelValues().mod;
        await sleep(1200);
        const w = e.wheelValues();
        await sleep(50);
        const out = { a, b: w.mod, swelling: w.swelling, pressed: b.getAttribute('aria-pressed'),
          shown: document.querySelector('.v6-left .wheel-value').textContent };
        b.click();
        await sleep(300);
        return out;
      });
      assert.ok(r.b > r.a + 0.05, `wheel rises (${r.a.toFixed(3)} → ${r.b.toFixed(3)})`);
      assert.equal(r.swelling, true);
      assert.equal(r.pressed, 'true');
      assert.ok(Math.abs(parseInt(r.shown, 10) - r.b * 100) <= 6,
        `column shows ${r.shown} ≈ ${Math.round(r.b * 100)}%`);
      // a tap on the empty top of the track doesn't jump the wheel (relative drag, as today)
      await ev(() => window.__rig.controller.perform.wheel(0.3));
      await page.waitForTimeout(80);
      const wb = await page.locator('.v6-left .wheel-input').boundingBox();
      await page.mouse.move(wb.x + wb.width / 2, wb.y + 4);
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(80);
      const wv = await ev(() => window.__rig.engine.wheelValues().mod);
      assert.ok(Math.abs(wv - 0.3) < 0.02, `wheel tap does not jump (0.3 → ${wv.toFixed(3)})`);
      // a drag up moves it (→ controller.perform.wheel)
      await page.mouse.move(wb.x + wb.width / 2, wb.y + wb.height * 0.7);
      await page.mouse.down();
      await page.mouse.move(wb.x + wb.width / 2, wb.y + wb.height * 0.4, { steps: 6 });
      await page.mouse.up();
      await until(() => window.__rig.engine.wheelValues().mod > 0.45);
      await ev(() => window.__rig.controller.perform.wheel(1));
    });

  await T('U4 Lock: wheel, Swell and Quick stay live; in the sheet This Mac is frozen, This song live', async () => {
    await ev(() => window.__rig.store.set('settings.performLock', true));
    try {
      const r = await ev(() => ({
        input: document.querySelector('.v6-left .wheel-input').disabled,
        swell: document.querySelector('.v6-left .swell-btn').disabled,
        quick: document.querySelector('[data-testid="v6-quick"]').disabled,
      }));
      assert.deepEqual(r, { input: false, swell: false, quick: false });
      await page.click(tid('v6-quick'));
      await until(() => window.__rig.views.v6.quickOpen === true);
      const q = await ev(() => ({
        locked: document.querySelector('.qs').classList.contains('locked'),
        touch: [...document.querySelectorAll('.qs .segmented .seg')].every((b) => b.disabled),
        all: document.querySelector('.qs .qs-all').disabled,
        tap: document.querySelector('[data-testid="quick-tap"]').disabled,
        lockNote: getComputedStyle(document.querySelector('.qs .qs-lock')).display !== 'none',
      }));
      assert.deepEqual(q, { locked: true, touch: true, all: true, tap: false, lockNote: true });
      await page.click(tid('v6-quick'));
      await until(() => window.__rig.views.v6.quickOpen === false);
      await ev(() => window.__rig.controller.perform.wheel(0.4));
      await until(() => document.querySelector('.v6-left .wheel-value').textContent === '40%');
      await ev(() => window.__rig.controller.perform.wheel(1));
    } finally {
      await ev(() => window.__rig.store.set('settings.performLock', false));
    }
  });

  await T('U4 1280×800 / 1024×700: the column fits (track ≥ 100 px, Swell + pedal inside); sheet inside the window',
    async () => {
      // the factory song as shipped, so the screenshots show a fresh song (the tests above changed it)
      await ev(() => {
        const { store, controller } = window.__rig;
        controller.scenes.go(null);
        store.resetToFactory(store.currentSong().id);
      });
      for (const [w, h, n] of [[1280, 800, 5], [1024, 700, 7], [1024, 700, 4]]) {
        await page.setViewportSize({ width: w, height: h });
        await setSlots(n);
        await page.waitForTimeout(250);
        const r = await ev(() => {
          const q = (s) => document.querySelector(s).getBoundingClientRect();
          const left = q('.v6-left');
          const board = q('.v6-board');
          return {
            track: q('.v6-left .wheel-track').height,
            inside: ['.v6-quick', '.v6-left .swell-btn', '.v6-left [data-testid="pedal-lamp"]', '.v6-left .drone-swell']
              .every((s) => {
                const e = document.querySelector(s);
                if (e.hidden) return true;
                const b = e.getBoundingClientRect();
                return b.top >= left.top - 0.5 && b.bottom <= left.bottom + 0.5 && b.height > 0;
              }),
            fits: left.bottom <= board.bottom + 0.5,
            swellH: q('.v6-left .swell-btn').height,
            quickH: q('.v6-quick').height,
            sw: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        });
        assert.ok(r.track >= 100, `${w}×${h} (${n}): wheel track ${r.track} px`);
        assert.deepEqual({ inside: r.inside, fits: r.fits, sw: r.sw }, { inside: true, fits: true, sw: 0 },
          `${w}×${h} (${n})`);
        assert.ok(r.swellH >= 43.5 && r.quickH >= 43.5, `${w}×${h}: 44 px targets (${r.swellH}, ${r.quickH})`);
        await page.click(tid('v6-quick'));
        await until(() => window.__rig.views.v6.quickOpen === true);
        const qs = await rect('.qs');
        assert.ok(qs.b <= h && qs.r <= w, `${w}×${h}: the sheet stays in the window (${qs.r}, ${qs.b})`);
        await clearToasts();
        await settledAnim(page);
        if (n !== 4) await page.screenshot({ path: path.join(SHOTS, `u4-quick-${w}x${h}.png`) });
        await page.click(tid('v6-quick'));
        await until(() => window.__rig.views.v6.quickOpen === false);
        await clearToasts();
        await ev(() => document.activeElement?.blur?.());
        await page.waitForTimeout(150);
        if (n !== 4) await page.screenshot({ path: path.join(SHOTS, `u4-${w}x${h}.png`) });
      }
      await page.setViewportSize({ width: 1280, height: 800 });
      await setSlots(2);
    });

  await T('U4 iPad portrait 820×1180: no sideways page scroll; the panel at the left of the strips; Quick opens',
    async () => {
      const c = await browser.newContext({ viewport: { width: 820, height: 1180 } });
      const errs = [];
      try {
        await pinTheme(c, 'sanctuary');
        await c.grantPermissions([...MIDI_PERMISSIONS], { origin });
        const p = await c.newPage();
        p.on('console', (m) => {
          if (m.type() === 'error') errs.push(m.text());
        });
        p.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
        p.on('response', (r) => {
          if (r.status() >= 400) errs.push(`HTTP ${r.status()} ${r.url()}`);
        });
        await p.goto(`${origin}/?ui6=1`);
        await waitRigReady(p, { timeout: 40000 });
        await p.waitForFunction(() => !!window.__rig.views.v6, null, { timeout: 20000 });
        await p.waitForTimeout(800);
        const r = await p.evaluate(() => {
          const q = (s) => document.querySelector(s).getBoundingClientRect();
          const left = q('.v6-left');
          const strips = q('.v6-stripsarea');
          const de = document.documentElement;
          return {
            scroll: de.scrollWidth - de.clientWidth,
            bodyW: document.body.getBoundingClientRect().width,
            beside: left.right <= strips.left && Math.abs(left.top - strips.top) < 1,
            compact: left.width <= 64.5,
            aboveSide: left.bottom <= q('.v6-side').top + 0.5,
          };
        });
        assert.deepEqual(r, { scroll: 0, bodyW: 820, beside: true, compact: true, aboveSide: true });
        await p.evaluate(() => document.getElementById('toasts')?.replaceChildren());
        await p.waitForTimeout(200);
        await p.screenshot({ path: path.join(SHOTS, 'u4-820x1180.png') });
        await p.click('[data-testid="v6-quick"]');
        await p.waitForFunction(() => window.__rig.views.v6.quickOpen === true);
        const qs = await p.evaluate(() => {
          const b = document.querySelector('.qs').getBoundingClientRect();
          return { r: b.right, b: b.bottom, scroll: document.documentElement.scrollWidth - 820 };
        });
        assert.ok(qs.r <= 820 && qs.b <= 1180 && qs.scroll === 0, JSON.stringify(qs));
        await settledAnim(p);
        await p.screenshot({ path: path.join(SHOTS, 'u4-quick-820x1180.png') });
        // Edit (today's) keeps today's minimum width: the override is the v6 Perform's only
        await p.evaluate(() => window.__rig.ctx.setView('edit'));
        await p.waitForFunction(() => document.body.dataset.view === 'edit');
        assert.equal(await p.evaluate(() => getComputedStyle(document.body).minWidth), '1024px');
        assert.deepEqual(errs, []);
      } finally {
        await c.close();
      }
    });
}
