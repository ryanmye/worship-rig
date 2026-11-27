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
  const bars = [...document.querySelectorAll('[data-testid="v6-kbd"] .v6-rbar')];
  return {
    cls: document.documentElement.className,
    mirror: localStorage.getItem('worship-rig.cvd'),
    strips: strips.map((s) => {
      const nm = s.querySelector('.v6-nm');
      return { i: Number(s.dataset.slot), ico: cs(s.querySelector('.v6-ico')).backgroundColor,
        n: cs(nm, '::before').content, nBg: cs(nm, '::before').backgroundColor, nInk: cs(nm, '::before').color,
        // the name's top and height: its width grows by the number (a short name; a long one ellipsises sooner)
        box: rect(s), nm: [rect(nm)[1], rect(nm)[3]], who: rect(s.querySelector('.v6-who')) };
    }),
    bars: bars.map((b) => ({ i: Number(b.dataset.slot), bg: cs(b).backgroundColor, n: cs(b, '::before').content,
      nBg: cs(b, '::before').backgroundColor, nInk: cs(b, '::before').color, box: rect(b) })),
    piano: rect(document.querySelector('[data-testid="v6-kbd"]')),
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
    await ev(() => { // the 8th gets a sound too (setSlots fills 7), so it has a range bar
      const { store } = window.__rig;
      const id = store.currentSong().id;
      const ref = { type: 'synth', id: 'warm-pad' };
      if (store.currentSong().patch.slots[7]) store.set(`songs.${id}.patch.slots.7.instrument`, ref);
      else store.set(`songs.${id}.patch.slots.7`, { instrument: ref });
    });
    await settled();
    await until(() => document.querySelectorAll('.v6-strip[data-slot]').length === 8
      && document.querySelectorAll('[data-testid="v6-kbd"] .v6-rbar').length === 8);
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
        assert.equal(s.n, `"${s.i + 1}" / ""`, `${type} strip ${s.i}: its number before the name`);
        assert.equal(s.nBg, want);
        const cr = contrast(rgbOf(s.nInk), rgbOf(s.nBg));
        assert.ok(cr >= 4.5, `${type} strip ${s.i}: number ${cr.toFixed(2)} : 1`);
      }
      for (const b of on.bars) {
        assert.equal(b.bg, toRgb(PAL[type][b.i % 8]), `${type} bar ${b.i}`);
        assert.equal(b.n, `"${b.i + 1}" / ""`, `${type} bar ${b.i}: its number`);
        assert.ok(contrast(rgbOf(b.nInk), rgbOf(b.nBg)) >= 4.5, `${type} bar ${b.i}: number contrast`);
      }
      assert.notEqual(on.strips[7].ico, on.strips[0].ico, `${type}: position 7 has its own colour`);
      // no layout shift: every strip, name, bar and the keyboard stay where they were
      assert.deepEqual(on.strips.map((s) => [s.box, s.nm, s.who]), off.strips.map((s) => [s.box, s.nm, s.who]),
        'strips, their name rows and names’ line boxes');
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
        assert.equal(t.n, `"${k + 1}" / ""`, `tab ${t.b}: its number`);
        assert.equal(t.h, off.tabs[k].h, `tab ${t.b}: same height`);
      });
      assert.deepEqual(on.bar, { bg: toRgb(PAL.rg[2]), n: '"3" / ""' }, 'Edit › Range: instrument 3');
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

  await T('U-CVD skeptic F1: a range bar’s number stays on its own bar when the bar is short (split ranges, '
    + 'later positions)', async () => {
    await ev(() => window.__rig.store.set('settings.cvd', null));
    assert.equal(await setSlots(8), 8);
    // position 7 (staggered 2 + 7 × 16 = 114 px) on a fifth (C4–G4, ≈ 80 px at 1280 px); position 3 on one octave
    await ev(() => {
      const { store } = window.__rig;
      const id = store.currentSong().id;
      const ref = { type: 'synth', id: 'warm-pad' };
      if (store.currentSong().patch.slots[7]) store.set(`songs.${id}.patch.slots.7.instrument`, ref);
      else store.set(`songs.${id}.patch.slots.7`, { instrument: ref });
      store.set(`songs.${id}.patch.slots.7.lowNote`, 60);
      store.set(`songs.${id}.patch.slots.7.highNote`, 67);
      store.set(`songs.${id}.patch.slots.3.lowNote`, 36);
      store.set(`songs.${id}.patch.slots.3.highNote`, 47);
    });
    await settled();
    await ev(() => window.__rig.store.set('settings.cvd', 'rg'));
    await until(() => document.documentElement.classList.contains('cvd-rg')
      && document.querySelectorAll('[data-testid="v6-kbd"] .v6-rbar').length === 8);
    await page.waitForTimeout(200);
    try {
      const bars = await ev(() => [...document.querySelectorAll('[data-testid="v6-kbd"] .v6-rbar')].map((b) => {
        const r = b.getBoundingClientRect();
        const bs = getComputedStyle(b, '::before');
        const left = r.left + parseFloat(bs.left);
        return { i: Number(b.dataset.slot), L: r.left, R: r.right, bl: left, br: left + parseFloat(bs.width) };
      }));
      for (const b of bars) {
        if (b.R - b.L < 24) continue; // a sliver at the keyboard's edge: the number may overhang it
        assert.ok(b.bl >= b.L - 0.5 && b.br <= b.R + 0.5,
          `bar ${b.i + 1} (${Math.round(b.L)}–${Math.round(b.R)}): its number at `
          + `${Math.round(b.bl)}–${Math.round(b.br)}`);
      }
      assert.ok(bars.some((b) => b.i === 7 && b.R - b.L < 114),
        'the case: position 7 on a bar shorter than its stagger');
    } finally {
      await ev(() => {
        const { store } = window.__rig;
        const id = store.currentSong().id;
        store.set('settings.cvd', null);
        for (const i of [3, 7]) {
          store.set(`songs.${id}.patch.slots.${i}.lowNote`, 21);
          store.set(`songs.${id}.patch.slots.${i}.highNote`, 108);
        }
      });
    }
  });

  await T('U-CVD skeptic F2: the numbers are not read out (strip names, Edit tabs and the range bars say the same '
    + 'as Off)', async () => {
    const snap = async () => {
      const out = {
        strips: await page.locator('[data-testid="v6-strips"], .v6-strips').first().ariaSnapshot(),
        bars: await page.locator('[data-testid="v6-kbd-bars"]').ariaSnapshot(),
      };
      return out;
    };
    await ev(() => {
      window.__rig.store.set('settings.cvd', null);
      window.__rig.ctx.setView('perform');
    });
    assert.equal(await setSlots(3), 3);
    await settled();
    await page.waitForTimeout(200);
    const off = await snap();
    await ev(() => window.__rig.store.set('settings.cvd', 'by'));
    await until(() => document.documentElement.classList.contains('cvd-by'));
    await page.waitForTimeout(200);
    try {
      assert.deepEqual(await snap(), off, 'Perform: the same accessible names / text with the numbers shown');
      // the badges are still drawn (content "1"…), with empty alt text
      assert.equal(await ev(() => getComputedStyle(document.querySelector('.v6-strip[data-slot="0"] .v6-nm'),
        '::before').content), '"1" / ""');
      await ev(() => window.__rig.ctx.setView('edit'));
      await until(() => document.body.dataset.view === 'edit' && !!window.__rig.views.edit?._debug?.v6);
      const tabs = () => page.locator('[role="tablist"]').filter({ has: page.locator('.v6e-rt') }).first()
        .ariaSnapshot();
      const on = await tabs();
      await ev(() => window.__rig.store.set('settings.cvd', null));
      await until(() => !/cvd-/.test(document.documentElement.className));
      await page.waitForTimeout(150);
      assert.equal(on, await tabs(), 'Edit tabs: the same accessible names');
    } finally {
      await ev(() => {
        window.__rig.store.set('settings.cvd', null);
        window.__rig.ctx.setView('perform');
      });
    }
  });

  await T('U-CVD skeptic F3: a live toggle redraws v6 Edit › Tone EQ’s canvases in the new colour', async () => {
    assert.equal(await setSlots(3), 3);
    await ev(() => {
      window.__rig.store.set('settings.cvd', null);
      window.__rig.ctx.setView('edit');
    });
    await until(() => document.body.dataset.view === 'edit' && !!window.__rig.views.edit?._debug?.v6);
    await ev(() => window.__rig.views.edit.editState.select('slot:2'));
    await page.click(tid('v6e-cat-eq'));
    await until(() => !!document.querySelector('#view-edit canvas.eqk-kb')?.offsetParent);
    await page.waitForTimeout(400);
    // the EQ keyboard strip's most common saturated pixel vs the slot colour it should be drawn in
    const read = () => ev(() => {
      const cv = document.querySelector('#view-edit canvas.eqk-kb');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      const m = new Map();
      for (let k = 0; k < d.length; k += 4) {
        if (d[k + 3] < 250 || Math.max(d[k], d[k + 1], d[k + 2]) - Math.min(d[k], d[k + 1], d[k + 2]) < 40) continue;
        const key = `${d[k]},${d[k + 1]},${d[k + 2]}`;
        m.set(key, (m.get(key) || 0) + 1);
      }
      const top = [...m].sort((a, b) => b[1] - a[1])[0];
      const probe = document.createElement('i');
      probe.style.color = 'var(--slot-2)';
      cv.parentElement.append(probe);
      const g = document.createElement('canvas').getContext('2d');
      g.fillStyle = getComputedStyle(probe).color;
      probe.remove();
      g.fillRect(0, 0, 1, 1);
      return { drawn: top ? top[0].split(',').map(Number) : null,
        want: [...g.getImageData(0, 0, 1, 1).data].slice(0, 3) };
    });
    const near = (r) => r.drawn && r.drawn.every((v, k) => Math.abs(v - r.want[k]) <= 10);
    try {
      const off = await read();
      assert.ok(near(off), `Off: drawn ${off.drawn}, slot colour ${off.want}`);
      await ev(() => window.__rig.store.set('settings.cvd', 'rg'));
      await until(() => document.documentElement.classList.contains('cvd-rg'));
      await page.waitForTimeout(400);
      const on = await read();
      assert.notDeepEqual(on.want, off.want, 'the slot colour changed');
      assert.ok(near(on), `Red–green: drawn ${on.drawn}, slot colour ${on.want}`);
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
