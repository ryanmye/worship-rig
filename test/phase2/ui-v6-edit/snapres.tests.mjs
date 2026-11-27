// UI6-fu O2 (native/docs/lanes/UI6-build-plan.md "Queued small tasks", FU2): while the shown song has a snapshot,
// both Edit views (today's, flag off, and the v6 Edit) keep the snapshot line's room (`.ev2-snapres`; with none
// playing the line is `.ev2-snapidle`: laid out, visibility hidden), so a footswitch snapshot change shifts nothing.
// Measured: every visible element of #view-edit outside the line (meters aside) keeps its rect, to 0.5 px, when a
// snapshot starts, when another (a 40-character name) follows, and on Own levels; at 1280×800 and 1024×700 with a
// mouse and 820×1180 on touch (pointer: coarse, the 44 px line). A song without snapshots has today's header: no
// .ev2-snapres, the line hidden (or absent), the header as tall as before it had them.
// Run from run.mjs (own contexts on its server), before the console check.

/**
 * @param {object} x  run.mjs's helpers: {T, browser, origin, assert, MIDI_PERMISSIONS, waitRigReady, pinTheme, errors}
 */
export async function snapresEditTests(x) {
  const { T, browser, origin, assert, MIDI_PERMISSIONS, waitRigReady, pinTheme, errors } = x;
  const CASES = [[1280, 800, false], [1024, 700, false], [820, 1180, true]];

  const measure = (page) => page.evaluate(() => {
    const root = document.querySelector('#view-edit');
    const line = root.querySelector('[data-testid="edit-snapline"]');
    const rects = [];
    for (const el of root.querySelectorAll('*')) {
      if (line && line.contains(el)) continue;
      if (el.closest('.ev2-song-pop') || el.closest('[class*="meter"]')) continue;
      const b = el.getBoundingClientRect();
      rects.push([b.left, b.top, b.width, b.height, `${el.tagName}.${el.className}`]);
    }
    const head = root.querySelector('.ev2-head');
    return { rects, head: head.getBoundingClientRect().height, res: head.classList.contains('ev2-snapres'),
      line: line ? { hidden: line.hidden, idle: line.classList.contains('ev2-snapidle'),
        vis: getComputedStyle(line).visibility, h: line.getBoundingClientRect().height } : null };
  });
  const shift = (a, b) => {
    assert.equal(a.rects.length, b.rects.length, 'the same elements');
    let max = 0;
    let who = '';
    a.rects.forEach((p, i) => {
      const q = b.rects[i];
      for (let j = 0; j < 4; j++) {
        const d = Math.abs(p[j] - q[j]);
        if (d > max) [max, who] = [d, p[4]];
      }
    });
    return { max: Math.round(max * 10) / 10, who };
  };

  for (const v6 of [false, true]) {
    await T(`UI6-fu O2: ${v6 ? 'the v6' : 'today’s'} Edit keeps the snapshot line's room while the song has `
      + 'snapshots: 0 px shift at 1280×800, 1024×700 and 820×1180 touch', async () => {
      for (const [w, hgt, touch] of CASES) {
        const context = await browser.newContext({ viewport: { width: w, height: hgt },
          ...(touch ? { hasTouch: true, isMobile: true } : {}) });
        try {
          await pinTheme(context, 'sanctuary');
          await context.grantPermissions([...MIDI_PERMISSIONS], { origin });
          const page = await context.newPage();
          page.on('console', (m) => {
            if (m.type() === 'error') errors.push(`[snapres] ${m.text()}`);
          });
          page.on('pageerror', (e) => errors.push(`[snapres] pageerror: ${e.message}`));
          page.on('response', (r) => {
            if (r.status() >= 400) errors.push(`[snapres] HTTP ${r.status()} ${r.url()}`);
          });
          await page.goto(`${origin}/${v6 ? '?ui6=1' : ''}`);
          await waitRigReady(page, { timeout: 40000 });
          await page.waitForFunction((on) => !!window.__rig.views.edit && (!on || !!window.__rig.views.edit._debug?.v6),
            v6, { timeout: 30000, polling: 100 });
          const ev = (fn, a) => page.evaluate(fn, a);
          const at = `${v6 ? 'v6' : 'today'} ${w}×${hgt}${touch ? ' touch' : ''}`;
          await ev(() => {
            const { store, controller } = window.__rig;
            controller.scenes.go(null);
            store.set(`songs.${store.currentSong().id}.scenes`, []);
            window.__rig.ctx.setView('edit');
          });
          await page.waitForFunction(() => document.body.dataset.view === 'edit');
          await page.waitForTimeout(400);
          const bare = await measure(page);
          assert.equal(bare.res, false, `${at}: no snapshots, no reserved room`);
          assert.equal(bare.line, null, `${at}: no line element before a song has snapshots`);
          await ev(() => {
            const { store } = window.__rig;
            const s = store.currentSong();
            const lv = (k) => s.patch.slots.map((sl) => (sl ? { gain: sl.gain * k } : null));
            store.set(`songs.${s.id}.scenes`, [{ name: 'Hall', slots: lv(1) },
              { name: 'A forty character snapshot name, nearly', slots: lv(0.5) }]);
          });
          await page.waitForFunction(() => !!document.querySelector('#view-edit .ev2-head.ev2-snapres'));
          await page.waitForTimeout(250);
          const rest = await measure(page);
          assert.deepEqual([rest.line.hidden, rest.line.idle, rest.line.vis], [false, true, 'hidden'], at);
          assert.ok(rest.line.h > 0, `${at}: the room is there (${rest.line.h} px)`);
          const steps = [['the first snapshot', 0], ['a long-named one', 1], ['Own levels', null]];
          let prev = rest;
          for (const [what, n] of steps) {
            await ev((k) => window.__rig.controller.scenes.go(k), n);
            await page.waitForFunction((k) => {
              const l = document.querySelector('#view-edit [data-testid="edit-snapline"]');
              return l && l.classList.contains('ev2-snapidle') === (k === null);
            }, n);
            await page.waitForTimeout(250);
            const m = await measure(page);
            const d = shift(prev, m);
            assert.ok(d.max <= 0.5, `${at}: ${what} moved ${d.who} by ${d.max} px`);
            assert.equal(m.head, rest.head, `${at}: ${what}: the header keeps its height`);
            if (n !== null) assert.equal(m.line.vis, 'visible', `${at}: ${what} shows the line`);
            prev = m;
          }
          // the last snapshot removed: today's header again (as tall as before)
          await ev(() => window.__rig.store.set(`songs.${window.__rig.store.currentSong().id}.scenes`, []));
          await page.waitForFunction(() => !document.querySelector('#view-edit .ev2-head.ev2-snapres'));
          await page.waitForTimeout(250);
          const gone = await measure(page);
          assert.equal(gone.line.hidden, true, at);
          assert.equal(gone.head, bare.head, `${at}: no snapshots left: the header at rest again`);
        } finally {
          await context.close();
        }
      }
    });
  }
}
