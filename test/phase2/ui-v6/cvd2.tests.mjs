// CVD2 (native/docs/reviews/UI6-cvd.md O1, O5, O6; native/docs/lanes/UI6-build-plan.md "Queued small tasks"):
// - O1: the range bars' numbers are placed in JS (components/keys.js placeBadges → --cvd-x), so with 16 instruments
//   (two short bars with the same range at positions 9+, a range mostly off the keys shown) no two numbers on rows
//   that touch overlap, each is wholly inside the keyboard and on (or, a bar shorter than it, touching) its own bar;
//   in the v6 Perform's keyboard (views/v6/keyboard.js) and today's (perform.js, flag off, its own page);
// - O5: on a 16-tab v6 Edit row, no tab's changed dot covers its number ("10"–"16");
// - O6: a muted instrument's number goes grey with its bar (the bar's colour behind it, the theme's text on it,
//   ≥ 4.5 : 1), in every theme.
// Run from run.mjs on its page (the v6 UI), after cvd.tests.mjs.
import { MIDI_PERMISSIONS, waitRigReady, pinTheme } from '../../integration/lib.mjs';

/** In the page: every shown bar of `sel` (a .rbars box) with its number badge's box. */
const BADGES = (sel) => {
  const box = document.querySelector(sel);
  const r0 = box.getBoundingClientRect();
  return [...box.querySelectorAll('.rbar[data-slot]')].filter((b) => !b.hidden && b.getBoundingClientRect().width)
    .map((b) => {
      const r = b.getBoundingClientRect();
      const s = getComputedStyle(b, '::before');
      const x = r.left + parseFloat(s.left);
      const cy = (r.top + r.bottom) / 2;
      return { i: Number(b.dataset.slot), L: r.left - r0.left, R: r.right - r0.left, W: r0.width,
        x: x - r0.left, w: parseFloat(s.width), y: cy - r0.top, h: parseFloat(s.height), n: s.content,
        off: b.classList.contains('off'), barBg: getComputedStyle(b).backgroundColor, bg: s.backgroundColor,
        ink: s.color, cx: b.style.getPropertyValue('--cvd-x') };
    });
};
const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
const rgbOf = (s) => (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map((v) => Number(v) / 255);
const contrast = (a, b) => {
  const [x, y] = [lum(rgbOf(a)), lum(rgbOf(b))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/** The O1 checks over BADGES' rows; returns a short summary for messages. */
function checkBadges(assert, list, at) {
  assert.ok(list.length >= 2, `${at}: bars shown (${list.length})`);
  for (const a of list) {
    assert.match(a.n, new RegExp(`"${a.i + 1}"`), `${at}: bar ${a.i + 1} carries its number`);
    assert.ok(a.x >= -0.5 && a.x + a.w <= a.W + 0.5, `${at}: ${a.i + 1} inside the keyboard (${a.x.toFixed(1)})`);
    const visL = Math.max(0, a.L);
    const visR = Math.min(a.W, a.R);
    assert.ok(a.x < visR && a.x + a.w > visL, `${at}: ${a.i + 1} touches its bar (${a.x.toFixed(1)}+${a.w} vs `
      + `${visL.toFixed(1)}–${visR.toFixed(1)})`);
    for (const c of list) {
      if (c.i <= a.i || Math.abs(c.y - a.y) >= (a.h + c.h) / 2 + 1) continue; // rows that don't touch
      const apart = a.x + a.w <= c.x + 0.5 || c.x + c.w <= a.x + 0.5;
      assert.ok(apart, `${at}: ${a.i + 1} (${a.x.toFixed(1)}) and ${c.i + 1} (${c.x.toFixed(1)}) overlap`);
    }
  }
}

/** 16 instruments: 1–8 every key; 9–16 in pairs on four one-octave ranges; 15 / 16 mostly below / above the keys. */
const SPLIT16 = () => {
  const { store } = window.__rig;
  const id = store.currentSong().id;
  while (store.currentSong().patch.slots.length < 16) store.addSlot(id);
  const ranges = [[21, 108], [21, 108], [21, 108], [21, 108], [21, 108], [21, 108], [21, 108], [21, 108],
    [48, 59], [48, 59], [60, 71], [60, 71], [72, 83], [72, 83], [0, 37], [96, 127]];
  ranges.forEach(([lo, hi], i) => {
    const ref = { type: 'synth', id: i % 2 ? 'warm-pad' : 'sub-bass' };
    if (store.currentSong().patch.slots[i]) store.set(`songs.${id}.patch.slots.${i}.instrument`, ref);
    else store.set(`songs.${id}.patch.slots.${i}`, { instrument: ref });
    store.set(`songs.${id}.patch.slots.${i}.lowNote`, lo);
    store.set(`songs.${id}.patch.slots.${i}.highNote`, hi);
    store.set(`songs.${id}.patch.slots.${i}.muted`, false);
  });
  return store.currentSong().patch.slots.length;
};

/**
 * @param {object} x  run.mjs's helpers: {T, page, browser, origin, ev, until, settled, setSlots, assert, errors}
 */
export async function cvd2Tests(x) {
  const { T, page, browser, origin, ev, until, settled, setSlots, assert, errors } = x;

  await T('CVD2 O1: the v6 keyboard’s numbers never stack (16 instruments, identical short ranges, edge slivers; '
    + '1280 / 1180 / 820)', async () => {
    await ev(() => {
      window.__rig.ctx.closeSettings?.();
      window.__rig.ctx.setView('perform');
      window.__rig.store.set('settings.cvd', null);
    });
    assert.equal(await ev(SPLIT16), 16);
    await settled();
    await until(() => document.querySelectorAll('[data-testid="v6-kbd"] .v6-rbar').length === 16);
    try {
      const off = await ev(BADGES, '[data-testid="v6-kbd-bars"]');
      assert.ok(off.every((b) => b.cx === ''), 'Off: no --cvd-x written');
      await ev(() => window.__rig.store.set('settings.cvd', 'rg'));
      await until(() => document.documentElement.classList.contains('cvd-rg'));
      for (const [w, h] of [[1280, 800], [1180, 820], [820, 1180]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(400);
        const on = await ev(BADGES, '[data-testid="v6-kbd-bars"]');
        assert.equal(on.length, 16, `${w}: 16 bars`);
        assert.ok(on.every((b) => b.cx !== ''), `${w}: every bar placed`);
        checkBadges(assert, on, `v6 ${w}`);
      }
      // a drag-free move: a range write moves the bar and its number follows (placed again in the next frame)
      await page.setViewportSize({ width: 1280, height: 800 });
      await ev(() => window.__rig.store.set(`songs.${window.__rig.store.currentSong().id}.patch.slots.9.lowNote`, 52));
      await page.waitForTimeout(300);
      checkBadges(assert, await ev(BADGES, '[data-testid="v6-kbd-bars"]'), 'v6 after a range write');
      // Off: the placements go (Off is today's page)
      await ev(() => window.__rig.store.set('settings.cvd', null));
      await until(() => !/cvd-/.test(document.documentElement.className));
      await page.waitForTimeout(200);
      assert.ok((await ev(BADGES, '[data-testid="v6-kbd-bars"]')).every((b) => b.cx === ''), 'Off: --cvd-x removed');
    } finally {
      await page.setViewportSize({ width: 1280, height: 800 });
      await ev(() => window.__rig.store.set('settings.cvd', null));
    }
  });

  await T('CVD2 O6: a muted instrument’s number goes grey with its bar, legible, in every theme', async () => {
    assert.equal(await setSlots(3), 3);
    await settled();
    const id = await ev(() => window.__rig.store.currentSong().id);
    await ev((sid) => window.__rig.store.set(`songs.${sid}.patch.slots.1.muted`, true), id);
    await ev(() => window.__rig.store.set('settings.cvd', 'by'));
    await until(() => document.documentElement.classList.contains('cvd-by')
      && !!document.querySelector('[data-testid="v6-kbd"] .v6-rbar.off'));
    const theme0 = await ev(() => window.__rig.store.get().settings.theme);
    try {
      for (const t of ['classic', 'sanctuary', 'sanctuary-day', 'daylight-stage', 'daylight-day', 'studio', 'ember',
        'nave']) {
        await ev((v) => window.__rig.store.set('settings.theme', v), t);
        await until((v) => document.documentElement.dataset.theme === v || (v === 'classic'
          && !document.documentElement.dataset.theme), t).catch(() => {});
        await page.waitForTimeout(250);
        const bars = await ev(BADGES, '[data-testid="v6-kbd-bars"]');
        const m = bars.find((b) => b.i === 1);
        const on = bars.find((b) => b.i === 0);
        assert.ok(m && m.off, `${t}: instrument 2 is muted`);
        // the v6 muted bar keeps its lamp colour (pre-existing: .v6 .v6-kbd .v6-rbar out-ranks .rbar.off), so the
        // number is a grey of its own: low chroma, not the lamp colour
        const c = rgbOf(m.bg).map((v) => v * 255);
        assert.ok(Math.max(...c) - Math.min(...c) <= 40, `${t}: its number is grey (${m.bg})`);
        assert.notEqual(m.bg, on.bg, `${t}: not the lamp colour`);
        const cr = contrast(m.ink, m.bg);
        assert.ok(cr >= 4.5, `${t}: the muted number ${cr.toFixed(2)} : 1 (${m.ink} on ${m.bg})`);
        assert.equal(on.bg, on.barBg, `${t}: an instrument that plays keeps its lamp colour`);
      }
    } finally {
      await ev((v) => {
        const { store } = window.__rig;
        store.set('settings.theme', v);
        store.set('settings.cvd', null);
        store.set(`songs.${store.currentSong().id}.patch.slots.1.muted`, false);
      }, theme0);
    }
  });

  await T('CVD2 O5: on a 16-tab v6 Edit row no changed dot covers a tab’s number (nor its name)', async () => {
    assert.equal(await ev(SPLIT16), 16);
    await settled();
    await ev(() => window.__rig.store.set('settings.cvd', 'rg'));
    await until(() => document.documentElement.classList.contains('cvd-rg'));
    try {
      // every tab changed since the song was selected (the Revert baseline): each shows its dot
      await ev(() => {
        const { store } = window.__rig;
        const s = store.currentSong();
        s.patch.slots.forEach((sl, i) => store.set(`songs.${s.id}.patch.slots.${i}.gain`, 0.37 + i / 100));
        window.__rig.ctx.setView('edit');
      });
      await until(() => document.body.dataset.view === 'edit'
        && document.querySelectorAll('.v6e-rt[data-block^="slot:"]').length === 16);
      for (const [w, h] of [[1280, 800], [1024, 700]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(400);
        const tabs = await ev(() => [...document.querySelectorAll('.v6e-rt[data-block^="slot:"]')].map((t) => {
          const name = t.querySelector('.v6e-rt-name');
          const nb = name.getBoundingClientRect();
          const s = getComputedStyle(name, '::before');
          // the name's text box (its content box: the number badge, an inline-block ::before at its start, and the
          // name after it; the badge's own box can't be measured from outside)
          const pr = parseFloat(getComputedStyle(name).paddingRight);
          const num = { l: nb.left, r: nb.right - pr, t: nb.top, b: nb.bottom };
          const dot = t.querySelector('.v6e-rt-cd:not([hidden])');
          const db = dot?.getBoundingClientRect();
          return { i: Number(t.dataset.block.split(':')[1]), n: s.content, num,
            dot: db && db.width ? { l: db.left, r: db.right, t: db.top, b: db.bottom } : null };
        }));
        const withDot = tabs.filter((t) => t.dot);
        if (process.env.O5PROBE) console.log('O5PROBE', JSON.stringify(tabs.slice(8, 11)));
        assert.ok(withDot.length >= 10, `${w}: changed dots shown (${withDot.length})`);
        for (const t of tabs) {
          if (!t.dot) continue;
          const cover = t.dot.l < t.num.r && t.dot.r > t.num.l && t.dot.t < t.num.b && t.dot.b > t.num.t;
          assert.equal(cover, false, `${w}: tab ${t.i + 1}: its dot (${t.dot.l.toFixed(1)}–${t.dot.r.toFixed(1)}) `
            + `over its number / name (${t.num.l.toFixed(1)}–${t.num.r.toFixed(1)})`);
          assert.match(t.n, new RegExp(`"${t.i + 1}"`), `tab ${t.i + 1}: numbered`);
        }
      }
    } finally {
      await page.setViewportSize({ width: 1280, height: 800 });
      await ev(() => {
        window.__rig.store.set('settings.cvd', null);
        window.__rig.ctx.setView('perform');
      });
    }
  });

  await T('CVD2 O1: today’s keyboard (flag off) — numbers never stack with 16 instruments; O6 grey when muted',
    async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      try {
        await pinTheme(context, 'sanctuary');
        await context.grantPermissions([...MIDI_PERMISSIONS], { origin });
        const p = await context.newPage();
        p.on('console', (m) => {
          if (m.type() === 'error') errors.push(`[cvd2 flag off] ${m.text()}`);
        });
        p.on('response', (r) => {
          if (r.status() >= 400) errors.push(`[cvd2 flag off] HTTP ${r.status()} ${r.url()}`);
        });
        await p.goto(`${origin}/`);
        await waitRigReady(p, { timeout: 40000 });
        const pev = (fn, a) => p.evaluate(fn, a);
        assert.equal(await pev(() => 'uiV6' in window.__rig.store.get().settings
          && window.__rig.store.get().settings.uiV6 === true), false, 'flag off');
        assert.equal(await pev(SPLIT16), 16);
        await p.waitForFunction(() => document.querySelectorAll('[data-testid="range-bars"] .rbar:not([hidden])')
          .length === 16, null, { timeout: 30000 });
        const off = await pev(BADGES, '[data-testid="range-bars"]');
        assert.ok(off.every((b) => b.cx === ''), 'Off: no --cvd-x written');
        await pev(() => window.__rig.store.set('settings.cvd', 'rg'));
        await p.waitForFunction(() => document.documentElement.classList.contains('cvd-rg'));
        for (const [w, h] of [[1280, 800], [1024, 700]]) {
          await p.setViewportSize({ width: w, height: h });
          await p.waitForTimeout(400);
          const on = await pev(BADGES, '[data-testid="range-bars"]');
          assert.equal(on.length, 16);
          checkBadges(assert, on, `today ${w}`);
        }
        // O6 here too
        await pev(() => window.__rig.store.set(`songs.${window.__rig.store.currentSong().id}.patch.slots.2.muted`,
          true));
        await p.waitForFunction(() => !!document.querySelector('[data-testid="range-bars"] .rbar.off'));
        await p.waitForTimeout(200);
        // Skeptic FU2 F2: in every theme (Daylight Stage's bar grey under the theme's text was 3.6 : 1)
        for (const t of ['classic', 'sanctuary', 'sanctuary-day', 'daylight-stage', 'daylight-day', 'studio', 'ember',
          'nave']) {
          await pev((v) => window.__rig.store.set('settings.theme', v), t);
          await p.waitForFunction((v) => document.documentElement.dataset.theme === v || (v === 'classic'
            && !document.documentElement.dataset.theme), t).catch(() => {});
          await p.waitForTimeout(250);
          const bars = await pev(BADGES, '[data-testid="range-bars"]');
          const m = bars.find((b) => b.i === 2);
          const on = bars.find((b) => b.i === 0);
          assert.ok(m.off, t);
          const c = rgbOf(m.bg).map((v) => v * 255);
          assert.ok(Math.max(...c) - Math.min(...c) <= 40, `today ${t}: its number is grey (${m.bg})`);
          assert.notEqual(m.bg, on.bg, `today ${t}: not the lamp colour`);
          const cr = contrast(m.ink, m.bg);
          assert.ok(cr >= 4.5, `today ${t}: muted number ${cr.toFixed(2)} : 1 (${m.ink} on ${m.bg})`);
        }
        await pev(() => window.__rig.store.set('settings.theme', 'sanctuary'));
        await pev(() => window.__rig.store.set('settings.cvd', null));
        await p.waitForFunction(() => !/cvd-/.test(document.documentElement.className));
        await p.waitForTimeout(200);
        assert.ok((await pev(BADGES, '[data-testid="range-bars"]')).every((b) => b.cx === ''), 'Off again');
      } finally {
        await context.close();
      }
    });
}
