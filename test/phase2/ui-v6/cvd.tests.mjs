// U-CVD (native DECISIONS D32), flag on: Settings › Look › Colour-blind colours. settings.cvd 'rg' / 'by' puts
// html.cvd-rg / .cvd-by (main.js; themes/boot.js before first paint from the mirror): the strips, range bars and
// Edit tabs take the palette for that type (8 colours, position 7 its own), each instrument's number shows on its
// range bar and before its name (strip, Edit tab) with no layout shift, and Off puts back exactly what was there.
// Run from run.mjs on its page (the v6 Perform is on, Sanctuary).
import { readPalettes, contrast } from '../../../tools/themes/cvd-check.mjs';

const toRgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;

/** Page side: what the cue and the colours look like now. */
const LOOK = () => {
  const cs = (el, pseudo) => (el ? getComputedStyle(el, pseudo || null) : null);
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10);
  };
  const strips = [...document.querySelectorAll('.v6-strip[data-slot]')];
  const bars = [...document.querySelectorAll('[data-testid="v6-piano"] .v6-rbar')];
  return {
    cls: document.documentElement.className,
    mirror: localStorage.getItem('worship-rig.cvd'),
    strips: strips.map((s) => {
      const nm = s.querySelector('.v6-nm');
      return { i: Number(s.dataset.slot), ico: cs(s.querySelector('.v6-ico')).backgroundColor,
        n: cs(nm, '::before').content, nBg: cs(nm, '::before').backgroundColor, nInk: cs(nm, '::before').color,
        box: rect(s), nm: rect(nm).slice(1) }; // the name's top / width / height (its x moves with scrolling)
    }),
    bars: bars.map((b) => ({ i: Number(b.dataset.slot), bg: cs(b).backgroundColor, n: cs(b, '::before').content,
      nBg: cs(b, '::before').backgroundColor, nInk: cs(b, '::before').color, box: rect(b) })),
    piano: rect(document.querySelector('[data-testid="v6-piano"]')),
  };
};
const rgbOf = (s) => (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map((v) => Number(v) / 255);

/**
 * @param {object} x  run.mjs's helpers: {T, page, browser, origin, ev, until, tid, settled, setSlots, assert}
 */
export async function cvdTests(x) {
  const { T, page, browser, origin, ev, until, tid, settled, setSlots, assert } = x;
  const PAL = readPalettes().sanctuary;

  await T('U-CVD: Colour-blind colours recolour the strips / bars (8 positions), number them, and Off restores '
    + 'exactly', async () => {
    await ev(() => {
      window.__rig.ctx.closeSettings?.();
      window.__rig.ctx.setView('perform');
      window.__rig.store.set('settings.cvd', null);
    });
    assert.equal(await setSlots(8), 8);
    await settled();
    await until(() => document.querySelectorAll('.v6-strip[data-slot]').length === 8
      && document.querySelectorAll('[data-testid="v6-piano"] .v6-rbar').length === 8);
    await page.waitForTimeout(300);
    const off = await ev(LOOK);
    assert.equal(off.cls.includes('cvd-'), false);
    assert.equal(off.mirror, null);
    assert.ok(off.strips.every((s) => s.n === 'none') && off.bars.every((b) => b.n === 'none'), 'Off: no numbers');
    assert.equal(off.strips[7].ico, off.strips[0].ico, 'Off: position 7 is position 0’s colour (today’s cycle)');
    for (const [type, cls] of [['rg', 'cvd-rg'], ['by', 'cvd-by']]) {
      await ev((t) => window.__rig.store.set('settings.cvd', t), type);
      await until((c) => document.documentElement.classList.contains(c), cls);
      await page.waitForTimeout(150);
      const on = await ev(LOOK);
      assert.equal(on.mirror, type, 'the mirror boot.js reads');
      assert.equal(on.cls.split(/\s+/).filter((c) => c.startsWith('cvd-')).join(), cls);
      for (const s of on.strips) {
        const want = toRgb(PAL[type][s.i % 8]);
        assert.equal(s.ico, want, `${type} strip ${s.i}: the palette's colour`);
        assert.equal(s.n, `"${s.i + 1}"`, `${type} strip ${s.i}: its number before the name`);
        assert.equal(s.nBg, want);
        const cr = contrast(rgbOf(s.nInk), rgbOf(s.nBg));
        assert.ok(cr >= 4.5, `${type} strip ${s.i}: number ${cr.toFixed(2)} : 1`);
      }
      for (const b of on.bars) {
        assert.equal(b.bg, toRgb(PAL[type][b.i % 8]), `${type} bar ${b.i}`);
        assert.equal(b.n, `"${b.i + 1}"`, `${type} bar ${b.i}: its number`);
        assert.ok(contrast(rgbOf(b.nInk), rgbOf(b.nBg)) >= 4.5, `${type} bar ${b.i}: number contrast`);
      }
      assert.notEqual(on.strips[7].ico, on.strips[0].ico, `${type}: position 7 has its own colour`);
      // no layout shift: every strip, name, bar and the keyboard stay where they were
      assert.deepEqual(on.strips.map((s) => [s.box, s.nm]), off.strips.map((s) => [s.box, s.nm]), 'strips / names');
      assert.deepEqual(on.bars.map((b) => b.box), off.bars.map((b) => b.box), 'range bars');
      assert.deepEqual(on.piano, off.piano, 'the keyboard');
    }
    await ev(() => window.__rig.store.set('settings.cvd', null));
    await until(() => !/cvd-/.test(document.documentElement.className));
    await page.waitForTimeout(150);
    const back = await ev(LOOK);
    assert.deepEqual(back, off, 'Off puts back exactly what was there');
  });

  await T('U-CVD: v6 Edit tabs and Edit › Range take the palette and the number; Off restores', async () => {
    const read = () => ev(() => {
      const tabs = [...document.querySelectorAll('.v6e-rt[data-block^="slot:"]')];
      const bar = document.querySelector('.v6-kbd-range .v6-rbar');
      return {
        tabs: tabs.map((t) => ({ b: t.dataset.block, top: getComputedStyle(t).borderTopColor,
          n: getComputedStyle(t.querySelector('.v6e-rt-name'), '::before').content,
          h: t.getBoundingClientRect().height })),
        bar: bar ? { bg: getComputedStyle(bar).backgroundColor, n: getComputedStyle(bar, '::before').content } : null,
      };
    });
    await ev(() => window.__rig.ctx.setView('edit'));
    await until(() => document.body.dataset.view === 'edit' && !!window.__rig.views.edit?._debug?.v6);
    await ev(() => window.__rig.views.edit.editState.select('slot:2'));
    await page.click(tid('v6e-cat-range'));
    await until(() => !!document.querySelector('.v6-kbd-range .v6-rbar'));
    try {
      const off = await read();
      assert.ok(off.tabs.length >= 8 && off.tabs.every((t) => t.n === 'none') && off.bar.n === 'none');
      await ev(() => window.__rig.store.set('settings.cvd', 'rg'));
      await until(() => document.documentElement.classList.contains('cvd-rg'));
      await page.waitForTimeout(150);
      const on = await read();
      on.tabs.forEach((t, k) => {
        assert.equal(t.top, toRgb(PAL.rg[k % 8]), `tab ${t.b}`);
        assert.equal(t.n, `"${k + 1}"`, `tab ${t.b}: its number`);
        assert.equal(t.h, off.tabs[k].h, `tab ${t.b}: same height`);
      });
      assert.deepEqual(on.bar, { bg: toRgb(PAL.rg[2]), n: '"3"' }, 'Edit › Range: instrument 3');
      await ev(() => window.__rig.store.set('settings.cvd', null));
      await until(() => !/cvd-/.test(document.documentElement.className));
      await page.waitForTimeout(150);
      assert.deepEqual(await read(), off);
    } finally {
      await ev(() => {
        window.__rig.store.set('settings.cvd', null);
        window.__rig.ctx.setView('perform');
      });
    }
  });

  await T('U-CVD: boot.js sets the class before first paint from the mirror (mini.html, no main.js); a store '
    + 'without the setting clears a stale mirror', async () => {
    const ctx = await browser.newContext({ viewport: { width: 400, height: 500 } });
    try {
      await ctx.addInitScript(() => localStorage.setItem('worship-rig.cvd', 'by'));
      const p = await ctx.newPage();
      await p.goto(`${origin}/mini.html`);
      assert.equal(await p.evaluate(() => document.documentElement.classList.contains('cvd-by')), true);
    } finally {
      await ctx.close();
    }
    // the app page: a stale mirror with the setting absent goes (the store wins)
    await ev(() => localStorage.setItem('worship-rig.cvd', 'rg'));
    await page.reload();
    await until(() => !!window.__rig?.ready && !!window.__rig.views.v6, null, 40000);
    assert.deepEqual(await ev(() => ({ cls: /cvd-/.test(document.documentElement.className),
      mirror: localStorage.getItem('worship-rig.cvd') })), { cls: false, mirror: null });
    await settled();
  });
}
