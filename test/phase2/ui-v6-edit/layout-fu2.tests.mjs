// FU2 layout quirks (native/docs/reviews/UI6-fu.md, "pre-existing, and the same at rest without the line"):
// - the v6 Edit's ⋯ Song button stuck out of the header at 1024×700 on a coarse pointer (and, with the Chart button,
//   D33, with a mouse too): every item of the header row now lies inside the header, chart on and off, mouse and
//   touch; at 1280×800 nothing gives way (the key chip's "you play" is whole);
// - today's Edit (flag off) was 1004 px wide in an 820 px window, its right side past the edge: it is 820 wide, no
//   element of it past the edge, PANIC on screen, and the top bar's lamps don't overlap.
// Run from run.mjs (own contexts on its server), before the console check.

/**
 * @param {object} x  run.mjs's helpers: {T, browser, origin, assert, MIDI_PERMISSIONS, waitRigReady, pinTheme, errors}
 */
export async function layoutFu2Tests(x) {
  const { T, browser, origin, assert, MIDI_PERMISSIONS, waitRigReady, pinTheme, errors } = x;
  async function open(v6, w, hgt, touch) {
    const context = await browser.newContext({ viewport: { width: w, height: hgt },
      ...(touch ? { hasTouch: true, isMobile: true } : {}) });
    await pinTheme(context, 'sanctuary');
    await context.grantPermissions([...MIDI_PERMISSIONS], { origin });
    const page = await context.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`[layout-fu2] ${m.text()}`);
    });
    page.on('pageerror', (e) => errors.push(`[layout-fu2] pageerror: ${e.message}`));
    page.on('response', (r) => {
      if (r.status() >= 400) errors.push(`[layout-fu2] HTTP ${r.status()} ${r.url()}`);
    });
    await page.goto(`${origin}/${v6 ? '?ui6=1' : ''}`);
    await waitRigReady(page, { timeout: 40000 });
    await page.waitForFunction((on) => !!window.__rig.views.edit && (!on || !!window.__rig.views.edit._debug?.v6),
      v6, { timeout: 30000, polling: 100 });
    return { context, page };
  }

  await T('UI6-fu ⋯ Song: the v6 Edit header row stays inside the header (1024×700 touch / mouse, chart on / off)',
    async () => {
      for (const [w, hgt, touch] of [[1024, 700, true], [1024, 700, false], [1101, 760, true], [1101, 760, false],
        [1180, 820, true], [1280, 800, false]]) {
        const { context, page } = await open(true, w, hgt, touch);
        try {
          for (const chart of [false, true]) {
            await page.evaluate((c) => {
              window.__rig.store.set('settings.chartView', c);
              window.__rig.ctx.setView('edit');
            }, chart);
            await page.waitForFunction(() => document.body.dataset.view === 'edit');
            await page.waitForFunction((c) => !!document.querySelector('[data-testid="v6e-chart"]')
              && document.querySelector('[data-testid="v6e-chart"]').hidden === !c, chart);
            await page.waitForTimeout(250);
            const r = await page.evaluate(() => {
              const head = document.querySelector('[data-testid="v6e-head"]');
              const hb = head.getBoundingClientRect();
              const cs = getComputedStyle(head);
              const inner = [hb.left + parseFloat(cs.paddingLeft) - 0.5, hb.right - parseFloat(cs.paddingRight) + 0.5];
              const out = [...head.querySelector('.ev2-song-head').children].filter((c) => {
                const b = c.getBoundingClientRect();
                return b.width > 0 && (b.left < inner[0] || b.right > inner[1] || b.top < hb.top - 0.5
                  || b.bottom > hb.bottom + 0.5);
              }).map((c) => `${c.className}: ${Math.round(c.getBoundingClientRect().right)} > ${Math.round(inner[1])}`);
              const menu = head.querySelector('.ev2-song-menubtn').getBoundingClientRect();
              const play = head.querySelector('.ev2-song-keychip .ev2-song-muted');
              return { out, menuW: Math.round(menu.width), playCut: play.scrollWidth > play.clientWidth + 1,
                time: getComputedStyle(head.querySelector('.v6e-sigbox .v6e-cap')).clipPath,
                timeName: head.querySelector('.v6e-sig').getAttribute('aria-label') };
            });
            const at = `${w}×${hgt}${touch ? ' touch' : ''} chart ${chart ? 'on' : 'off'}`;
            assert.deepEqual(r.out, [], `${at}: inside the header`);
            assert.ok(r.menuW >= (touch ? 44 : 30), `${at}: ⋯ keeps its size (${r.menuW})`);
            assert.equal(r.timeName, 'Time signature', at);
            if (w > 1100) {
              assert.equal(r.time, 'none', `${at}: the Time caption shows above 1100 px`);
              if (!chart) assert.equal(r.playCut, false, `${at}: nothing gives way at this width`);
            }
          }
        } finally {
          await page.evaluate(() => window.__rig.store.set('settings.chartView', false)).catch(() => {});
          await context.close();
        }
      }
    });

  // Skeptic FU2 F1: below 1100 px the key chip shrank in proportion with the song name (flex-shrink .1), so "· you
  // play C" was cut, the played key itself under the ellipsis, at every width up to 1100 (1100 with a mouse: the
  // name still 151 px wide). Now the name gives way first, to its 6ch, and inside the chip the words "· you play"
  // give way before the key: the key is whole unless the words are already gone (1024 touch, the Chart button, a
  // key with an octave word).
  await T('FU2 skeptic F1: the v6 Edit key chip keeps the key you play (the name gives way first, then the words)',
    async () => {
      for (const touch of [false, true]) {
        const { context, page } = await open(true, 1024, 700, touch);
        try {
          for (const [play, minor, oct] of [[0, false, 0], [6, true, -1]]) {
            for (const chart of [true, false]) {
              await page.evaluate(({ play, minor, oct, chart }) => {
                const { store } = window.__rig;
                const id = store.currentSong().id;
                store.set(`songs.${id}.name`, 'How Great Is Our God (live)');
                store.set(`songs.${id}.playIn`, play);
                store.set(`songs.${id}.minor`, minor);
                store.set(`songs.${id}.transposeOctave`, oct);
                store.set('settings.chartView', chart);
                window.__rig.ctx.setView('edit');
              }, { play, minor, oct, chart });
              await page.waitForFunction(() => document.body.dataset.view === 'edit');
              for (const w of [1024, 1040, 1064, 1100]) {
                await page.setViewportSize({ width: w, height: 700 });
                await page.waitForTimeout(200);
                const r = await page.evaluate(() => {
                  const head = document.querySelector('[data-testid="v6e-head"]');
                  const chip = head.querySelector('.ev2-song-keychip');
                  const muted = chip.querySelector('.ev2-song-muted');
                  const text = muted.textContent;
                  // the played key: the text after "you play " (one text node or a span of its own)
                  const walker = document.createTreeWalker(muted, NodeFilter.SHOW_TEXT);
                  const start = text.indexOf('you play ') + 9;
                  let acc = 0;
                  let keyNode = null;
                  let last = null;
                  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                    if (!keyNode && acc + n.data.length > start) keyNode = { n, from: Math.max(0, start - acc) };
                    acc += n.data.length;
                    last = n;
                  }
                  const rg = document.createRange();
                  rg.setStart(keyNode.n, keyNode.from);
                  rg.setEnd(last, last.data.length);
                  const kr = rg.getBoundingClientRect();
                  // every box from the key's text up to the chip that clips: the key whole inside it, and it not
                  // overflowing (an overflowing box with an ellipsis draws "…" over its last characters)
                  let cut = '';
                  for (let el = keyNode.n.parentElement; el && el !== chip.parentElement; el = el.parentElement) {
                    if (getComputedStyle(el).overflowX === 'visible') continue;
                    const b = el.getBoundingClientRect();
                    if (kr.right > b.right + 0.5 || el.scrollWidth > el.clientWidth) cut ||= el.className;
                  }
                  const words = muted.querySelector('.ev2-song-playw');
                  const name = head.querySelector('.ev2-song-name');
                  return { text, cut, wordsW: words ? words.getBoundingClientRect().width : null,
                    nameW: name.getBoundingClientRect().width, nameMin: parseFloat(getComputedStyle(name).minWidth),
                    chipCut: [...chip.querySelectorAll('*')].some((e) => e.scrollWidth > e.clientWidth + 0.5
                      && getComputedStyle(e).overflowX !== 'visible') };
                });
                const at = `${w}${touch ? ' touch' : ''} chart ${chart ? 'on' : 'off'} "${r.text}"`;
                assert.ok(!r.cut || r.wordsW === 0, `${at}: the played key is cut (${r.cut}; words ${r.wordsW} px)`);
                if (r.nameW > r.nameMin + 1) {
                  assert.equal(r.chipCut, false, `${at}: the chip gave way while the name had room (${r.nameW})`);
                }
              }
            }
          }
        } finally {
          await page.evaluate(() => window.__rig.store.set('settings.chartView', null)).catch(() => {});
          await context.close();
        }
      }
    });

  await T('UI6-fu: today’s Edit fits an 820 px window (no part past the edge; the top bar lamps apart)', async () => {
    for (const touch of [false, true]) {
      const { context, page } = await open(false, 820, 1180, touch);
      try {
        await page.evaluate(() => window.__rig.ctx.setView('edit'));
        await page.waitForFunction(() => document.body.dataset.view === 'edit');
        await page.waitForTimeout(400);
        const r = await page.evaluate(() => {
          const vw = window.innerWidth;
          const past = [...document.querySelectorAll('#view-edit *, #topbar *')].filter((el) => {
            const b = el.getBoundingClientRect();
            if (!b.width || !b.height || b.right <= vw + 0.5) return false;
            for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
              if (getComputedStyle(p).overflowX !== 'visible' && p.getBoundingClientRect().right <= vw + 0.5) {
                return false; // clipped inside the window
              }
            }
            return true;
          }).map((el) => el.className);
          const lamps = ['#midi-status', '#audio-status', '#ready-status'].map((q) => {
            const el = document.querySelector(q);
            const box = el.getBoundingClientRect();
            // what each lamp draws: its children's right edge (an item whose words overflow it drew on the next)
            const right = Math.max(...[...el.children].filter((c) => c.getBoundingClientRect().width > 0)
              .map((c) => c.getBoundingClientRect().right));
            return { left: box.left, right: getComputedStyle(el).overflow === 'hidden' ? box.right : right };
          });
          const overlap = lamps.slice(1).some((l, i) => l.left < lamps[i].right - 0.5);
          const panic = document.querySelector('#view-edit .ev2-kb-panic');
          return { vw, editW: Math.round(document.querySelector('#view-edit').getBoundingClientRect().width),
            docW: document.documentElement.scrollWidth, past, overlap,
            panic: panic ? Math.round(panic.getBoundingClientRect().right) : null };
        });
        const at = `820×1180${touch ? ' touch' : ''}`;
        assert.equal(r.editW, 820, `${at}: Edit is the window's width`);
        assert.equal(r.docW, 820, `${at}: nothing scrolls sideways`);
        assert.deepEqual(r.past, [], `${at}: nothing past the right edge`);
        assert.equal(r.overlap, false, `${at}: the lamps don't overlap`);
        assert.ok(r.panic !== null && r.panic <= 820, `${at}: PANIC on screen (${r.panic})`);
      } finally {
        await context.close();
      }
    }
    // the flag-off Perform keeps its 1024 px minimum (only Edit changed)
    const { context, page } = await open(false, 820, 1180, false);
    try {
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).minWidth), '1024px');
    } finally {
      await context.close();
    }
  });
}
