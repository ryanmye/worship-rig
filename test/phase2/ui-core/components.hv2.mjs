#!/usr/bin/env node
// H-v2 component tests (design/H-v2/implementation.md step 1): onTile, stepChip + stepPanel, headerChipRow,
// holdButton, quickSheet, the overlay rules (Esc / outside tap) and the colour contract, in real Chromium against
// app/styles.css. The components are mounted on a bare fixture page (no engine, no store), so this suite is quick.
//   node test/phase2/ui-core/components.hv2.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const require = createRequire(import.meta.url);
const { createServer } = require('../../../server.js');

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,">
<link rel="stylesheet" href="/styles.css"><title>H-v2 components</title>
<style>
  body { display: block; padding: 20px; }
  .strip { position: relative; width: 180px; height: 520px; display: flex; flex-direction: column; justify-content: flex-end;
    gap: 7px; padding: 9px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; float: left; margin-right: 16px; }
  .mods { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  #area { clear: both; position: relative; padding-top: 20px; }
  #outside, #pass { position: fixed; bottom: 10px; right: 10px; height: 44px; } #pass { right: 120px; }
</style></head><body>
<div id="strips"></div><div id="area"></div>
<button id="outside" type="button">outside</button> <button id="pass" type="button" data-overlay-pass>panic</button>
<script type="module">
  import * as C from '/js/views/components/index.js';
  window.C = C;
  window.log = [];
  window.docKeys = [];
  document.addEventListener('keydown', (e) => window.docKeys.push({ key: e.key, prevented: e.defaultPrevented }));
  document.getElementById('outside').addEventListener('click', () => window.log.push('outside-click'));
  document.getElementById('pass').addEventListener('click', () => window.log.push('pass-click'));
  window.ready = true;
</script></body></html>`;

let server;
let base;
let browser;
let page;
const errors = [];

/** Fresh fixture page per test group (no state leaks between components). */
async function fresh(viewport = { width: 1440, height: 900 }) {
  await page.setViewportSize(viewport);
  await page.goto(`${base}__hv2-components.html`);
  await page.waitForFunction(() => window.ready === true);
}

before(async () => {
  server = createServer({ appDir: path.join(repo, 'app'), port: 20000 + Math.floor(Math.random() * 20000) });
  base = (await server.listen()).url;
  if (!base.endsWith('/')) base += '/';
  browser = await chromium.launch({ channel: 'chromium', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route(`${base}__hv2-components.html`, (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE }),
  );
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${m.text()} @ ${m.location()?.url || ''}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
});

after(async () => {
  await browser?.close();
  await server?.close();
});

/** Relative luminance-ish luma (Rec. 601, 0..255) of a CSS rgb() colour. */
const luma = (rgb) => {
  const [r, g, b] = rgb.match(/[\d.]+/g).map(Number);
  return 0.299 * r + 0.587 * g + 0.114 * b;
};

test('exports: the new building blocks and every existing export', async () => {
  await fresh();
  const names = await page.evaluate(() => Object.keys(window.C).sort());
  for (const n of [
    'onTile',
    'stepChip',
    'stepPanel',
    'headerChipRow',
    'holdButton',
    'quickSheet',
    'openOverlay',
    'AMOUNT_STEPS',
    'OCTAVE_STEPS',
    'SUSTAIN_STEPS',
    'SPACE_CHIPS',
    'SPACE_MORE',
    'ECHO_CHIPS',
    'SONG_OWN',
    'TOUCH_OPTIONS',
    'formatAmount',
    'formatOctave',
    'tapBpm',
    'sameStep',
  ])
    assert.ok(names.includes(n), `exports ${n}`);
  for (const n of [
    'fader',
    'knob',
    'toggle',
    'segmented',
    'select',
    'stepper',
    'keyGrid',
    'miniKeyboard',
    'pianoKeyboard',
    'meter',
    'chordReadout',
    'wheelStrip',
    'setlistStrip',
    'h',
    'relativeDrag',
    'stageName',
  ])
    assert.ok(names.includes(n), `keeps ${n}`);
  const shape = await page.evaluate(() => {
    const C = window.C;
    const made = {
      onTile: C.onTile({ label: 'KEYS' }),
      stepChip: C.stepChip({ label: 'Space', steps: C.AMOUNT_STEPS, value: 0 }),
      stepPanel: C.stepPanel({ title: 'Space', steps: C.AMOUNT_STEPS, value: 0 }),
      headerChipRow: C.headerChipRow({ label: 'Space', options: C.SPACE_CHIPS }),
      holdButton: C.holdButton({ label: 'Revert' }),
      quickSheet: C.quickSheet({}),
    };
    const out = {};
    for (const [k, c] of Object.entries(made)) {
      out[k] = { el: c.el instanceof HTMLElement, destroy: typeof c.destroy === 'function' };
      document.body.append(c.el);
      c.destroy();
      out[k].removed = !c.el.isConnected;
    }
    return out;
  });
  for (const [k, v] of Object.entries(shape)) assert.deepEqual(v, { el: true, destroy: true, removed: true }, k);
});

test('onTile: ON = solid slot colour, OFF = grey #272b32 + struck-through name; tap/keyboard toggle; aria-pressed', async () => {
  await fresh();
  const r = await page.evaluate(() => {
    const C = window.C;
    const t = C.onTile({ label: 'KEYS', color: 'var(--slot-0)', onToggle: (on) => window.log.push(['toggle', on]) });
    t.el.id = 'tile';
    document.getElementById('strips').append(t.el);
    window.tile = t;
    const cs = getComputedStyle(t.el);
    return {
      bg: cs.backgroundColor,
      pressed: t.el.getAttribute('aria-pressed'),
      text: t.el.textContent,
      h: t.el.getBoundingClientRect().height,
    };
  });
  assert.equal(r.bg, 'rgb(255, 138, 61)', 'ON tile background = --slot-0');
  assert.equal(r.pressed, 'true');
  assert.match(r.text, /KEYS.*ON/);
  assert.ok(r.h >= 44, `tile ${r.h}px ≥ 44`);
  await page.click('#tile');
  const off = await page.evaluate(() => {
    const el = document.getElementById('tile');
    return {
      bg: getComputedStyle(el).backgroundColor,
      deco: getComputedStyle(el.querySelector('.ot-name')).textDecorationLine,
      pressed: el.getAttribute('aria-pressed'),
      state: el.querySelector('.ot-state').textContent,
      log: window.log.slice(),
      focused: document.activeElement === el,
      title: el.title,
    };
  });
  assert.equal(off.bg, 'rgb(39, 43, 50)', 'OFF tile is #272b32');
  assert.equal(off.deco, 'line-through');
  assert.equal(off.pressed, 'false');
  assert.equal(off.state, 'OFF');
  assert.deepEqual(off.log, [['toggle', false]]);
  assert.equal(off.focused, false, 'a tap does not leave the tile focused (Space stays sustain)');
  assert.match(off.title, /turn KEYS on/);
  // keyboard: focus + Enter / Space toggle
  await page.focus('#tile');
  await page.keyboard.press('Enter');
  await page.keyboard.press(' ');
  const kb = await page.evaluate(() => ({ log: window.log.slice(1), on: window.tile.get() }));
  assert.deepEqual(kb.log, [
    ['toggle', true],
    ['toggle', false],
  ]);
  assert.equal(kb.on, false);
  // set() never calls back; sub text (drone) and the changed dot
  const s = await page.evaluate(() => {
    const n = window.log.length;
    window.tile.set(true);
    window.tile.setSub('D major');
    window.tile.setChanged(true);
    const el = document.getElementById('tile');
    return {
      calls: window.log.length - n,
      label: el.getAttribute('aria-label'),
      dot: !el.querySelector('.cd').hidden,
      on: el.classList.contains('off') === false,
    };
  });
  assert.deepEqual(s, { calls: 0, label: 'KEYS D major', dot: true, on: true });
});

test('colour contract: ON tiles are ≥ 2× the luma of OFF (every slot + drone); nothing uses --warn outside lock', async () => {
  await fresh();
  const r = await page.evaluate(() => {
    const C = window.C;
    const out = [];
    for (const c of ['var(--slot-0)', 'var(--slot-1)', 'var(--slot-2)', 'var(--slot-3)', 'var(--drone)']) {
      const on = C.onTile({ label: 'X', color: c });
      const off = C.onTile({ label: 'X', color: c, on: false });
      document.body.append(on.el, off.el);
      out.push({ c, on: getComputedStyle(on.el).backgroundColor, off: getComputedStyle(off.el).backgroundColor });
    }
    const chip = C.stepChip({
      label: 'Space',
      steps: C.AMOUNT_STEPS,
      value: 0.5,
      color: 'var(--slot-1)',
      lit: (v) => v > 0,
    });
    const sus = C.stepChip({ label: 'Sustain', steps: C.SUSTAIN_STEPS, value: false, color: 'var(--slot-1)' });
    document.body.append(chip.el, sus.el);
    const warn = getComputedStyle(document.documentElement).getPropertyValue('--warn').trim();
    const hexToRgb = (hx) =>
      `rgb(${parseInt(hx.slice(1, 3), 16)}, ${parseInt(hx.slice(3, 5), 16)}, ${parseInt(hx.slice(5, 7), 16)})`;
    const warnRgb = hexToRgb(warn);
    const usesWarn = [...document.querySelectorAll('.ontile, .ontile *, .mchip, .mchip *')].some((el) => {
      const cs = getComputedStyle(el);
      return [cs.color, cs.backgroundColor, cs.borderTopColor].includes(warnRgb);
    });
    return {
      out,
      chipBg: getComputedStyle(chip.el).backgroundColor,
      tileOn: out[1].on,
      usesWarn,
      susOn: sus.el.classList.contains('on'),
    };
  });
  for (const x of r.out) {
    assert.ok(
      luma(x.on) >= 2 * luma(x.off),
      `${x.c}: ON luma ${luma(x.on).toFixed(0)} ≥ 2× OFF ${luma(x.off).toFixed(0)}`,
    );
  }
  assert.ok(luma(r.chipBg) < luma(r.tileOn) / 2, 'a chip in use is a quiet tint, far below the ON tile');
  assert.equal(r.usesWarn, false, 'amber only means lock');
  assert.equal(r.susOn, false, 'Sustain off is grey, not lit');
});

/** Mount one strip with Space/Echo/Octave/Sustain chips; returns nothing (handles on window.chips). */
async function mountStrip() {
  await page.evaluate(() => {
    const C = window.C;
    const strip = document.createElement('div');
    strip.className = 'strip';
    strip.id = 'strip0';
    const mods = document.createElement('div');
    mods.className = 'mods';
    const cb = (k) => (v) => window.log.push([k, v]);
    const chips = {
      space: C.stepChip({
        label: 'Space',
        owner: 'KEYS',
        steps: C.AMOUNT_STEPS,
        value: 0.25,
        loaded: 0.25,
        color: 'var(--slot-0)',
        format: C.formatAmount,
        lit: (v) => v > 0,
        amount: (v) => v,
        hint: 'how much goes into the Space (Hall)',
        fine: { min: 0, max: 1 },
        onChange: cb('space'),
      }),
      echo: C.stepChip({
        label: 'Echo',
        owner: 'KEYS',
        steps: C.AMOUNT_STEPS,
        value: 0.1,
        loaded: 0.1,
        color: 'var(--slot-0)',
        format: C.formatAmount,
        lit: (v) => v > 0,
        amount: (v) => v,
        onChange: cb('echo'),
      }),
      octave: C.stepChip({
        label: 'Octave',
        owner: 'KEYS',
        steps: C.OCTAVE_STEPS,
        value: 0,
        loaded: 0,
        color: 'var(--slot-0)',
        format: C.formatOctave,
        lit: (v) => v !== 0,
        footnote: 'Starts on your next note; held notes keep ringing.',
        onChange: cb('octave'),
      }),
      sustain: C.stepChip({
        label: 'Sustain',
        owner: 'KEYS',
        steps: C.SUSTAIN_STEPS,
        value: true,
        loaded: true,
        color: 'var(--slot-0)',
        onChange: cb('sustain'),
      }),
    };
    for (const [k, c] of Object.entries(chips)) {
      c.el.id = `chip-${k}`;
      mods.append(c.el);
    }
    const tile = C.onTile({ label: 'KEYS', color: 'var(--slot-0)', onToggle: (on) => window.log.push(['tile', on]) });
    tile.el.id = 'tile0';
    strip.append(tile.el, mods);
    document.getElementById('strips').append(strip);
    window.chips = chips;
  });
}
const panelInfo = () =>
  page.evaluate(() => {
    const p = document.querySelector('.step-panel');
    if (!p) return null;
    return {
      inStrip: p.parentElement?.id,
      label: p.getAttribute('aria-label'),
      steps: [...p.querySelectorAll('.sp-step')].map((b) => ({
        t: b.querySelector('.sp-step-l').textContent,
        on: b.getAttribute('aria-checked') === 'true',
        was: b.classList.contains('was'),
      })),
      hint: p.querySelector('.sp-hint')?.textContent,
      foot: p.querySelector('.sp-foot')?.textContent || null,
      fine: !!p.querySelector('.sp-fine input[type=range]'),
      focusedStep: document.activeElement?.closest?.('.sp-step')?.querySelector('.sp-step-l')?.textContent ?? null,
      within: (() => {
        const a = p.getBoundingClientRect();
        const s = p.parentElement.getBoundingClientRect();
        return a.left >= s.left - 0.5 && a.right <= s.right + 0.5;
      })(),
    };
  });

test('stepChip: chip text/tint/amount bar; tap opens the 5-step panel in its strip; tap a step = done + changed dot', async () => {
  await fresh();
  await mountStrip();
  const chip = await page.evaluate(() => {
    const el = document.getElementById('chip-space');
    return {
      text: el.textContent,
      on: el.classList.contains('on'),
      bar: el.querySelector('.mc-bar').style.width,
      dot: !el.querySelector('.cdi').hidden,
      label: el.getAttribute('aria-label'),
      expanded: el.getAttribute('aria-expanded'),
      h: el.getBoundingClientRect().height,
    };
  });
  assert.match(chip.text, /Space.*25%/);
  assert.equal(chip.on, true);
  assert.equal(chip.bar, '25%');
  assert.equal(chip.dot, false, 'as loaded → no dot');
  assert.equal(chip.label, 'KEYS Space: 25%');
  assert.equal(chip.expanded, 'false');
  assert.ok(chip.h >= 44);
  await page.click('#chip-space');
  const p = await panelInfo();
  assert.ok(p, 'panel open');
  assert.equal(p.inStrip, 'strip0', 'mounted inside its strip');
  assert.ok(p.within, 'never wider than its strip');
  assert.equal(p.label, 'KEYS Space');
  assert.deepEqual(
    p.steps.map((s) => s.t),
    ['100%', '75%', '50%', '25%', 'Off'],
  );
  assert.deepEqual(
    p.steps.map((s) => s.on),
    [false, false, false, true, false],
  );
  assert.equal(p.hint, 'how much goes into the Space (Hall)');
  assert.equal(p.fine, true);
  assert.equal(p.focusedStep, null, 'a tap does not move focus into the panel');
  assert.equal(await page.getAttribute('#chip-space', 'aria-expanded'), 'true');
  const stepH = await page.evaluate(() =>
    Math.min(...[...document.querySelectorAll('.sp-step')].map((b) => b.getBoundingClientRect().height)),
  );
  assert.ok(stepH >= 44, `steps ${stepH.toFixed(0)}px ≥ 44 at 1440×900`);
  await page.click('.sp-step:nth-child(2)');
  const after = await page.evaluate(() => {
    const el = document.getElementById('chip-space');
    return {
      log: window.log.slice(),
      text: el.querySelector('.mc-value').textContent,
      dot: !el.querySelector('.cdi').hidden,
      open: !!document.querySelector('.step-panel'),
      focused: document.activeElement === el || !!document.activeElement?.closest?.('.strip'),
    };
  });
  assert.deepEqual(after.log, [['space', 0.75]]);
  assert.equal(after.text, '75%');
  assert.equal(after.dot, true, 'changed since loaded → white dot');
  assert.equal(after.open, false, 'tap a step = done');
  assert.equal(after.focused, false, 'nothing in the strip keeps focus after a tap');
  // reopen: the loaded step carries "as loaded"
  await page.click('#chip-space');
  const p2 = await panelInfo();
  assert.deepEqual(
    p2.steps.map((s) => s.was),
    [false, false, false, true, false],
  );
  assert.deepEqual(
    p2.steps.map((s) => s.on),
    [false, true, false, false, false],
  );
  // tapping the chip again closes it; tapping the same value does not call back
  await page.click('#chip-space');
  assert.equal(await panelInfo(), null);
  await page.click('#chip-space');
  await page.click('.sp-step:nth-child(2)');
  assert.equal(await page.evaluate(() => window.log.length), 1, 'same value → no onChange');
  // setLoaded / setChanged(null) → dot follows the loaded value again
  const dot = await page.evaluate(() => {
    window.chips.space.setLoaded(0.75);
    const a = !document.querySelector('#chip-space .cdi').hidden;
    window.chips.space.setChanged(true);
    const b = !document.querySelector('#chip-space .cdi').hidden;
    window.chips.space.setChanged(null);
    return [a, b, !document.querySelector('#chip-space .cdi').hidden];
  });
  assert.deepEqual(dot, [false, true, false]);
});

test('stepChip: Octave panel footnote + one panel at a time; Sustain cycles on tap without a panel', async () => {
  await fresh();
  await mountStrip();
  await page.click('#chip-octave');
  let p = await panelInfo();
  assert.deepEqual(
    p.steps.map((s) => s.t),
    ['+2 oct', '+1 oct', 'Normal', '−1 oct', '−2 oct'],
  );
  assert.match(p.foot, /Starts on your next note/);
  assert.equal(p.fine, false);
  await page.click('.sp-step:nth-child(2)');
  assert.equal(await page.textContent('#chip-octave .mc-value'), '+1');
  assert.equal(await page.evaluate(() => document.getElementById('chip-octave').classList.contains('on')), true);
  // a tap on another chip while Space is open only closes Space (outside taps are swallowed); the next tap opens it
  await page.click('#chip-space');
  await page.click('#chip-echo');
  assert.equal(await page.evaluate(() => document.querySelectorAll('.step-panel').length), 0);
  // opening one panel from code closes any other (one panel per page)
  await page.evaluate(() => window.chips.space.open());
  await page.click('#chip-echo');
  assert.equal(await page.evaluate(() => document.querySelectorAll('.step-panel').length), 0);
  await page.evaluate(() => {
    window.chips.space.open();
    window.chips.echo.open();
  });
  const count = await page.evaluate(() => ({
    n: document.querySelectorAll('.step-panel').length,
    label: document.querySelector('.step-panel')?.getAttribute('aria-label'),
    spaceExpanded: document.getElementById('chip-space').getAttribute('aria-expanded'),
  }));
  assert.deepEqual(count, { n: 1, label: 'KEYS Echo', spaceExpanded: 'false' });
  await page.keyboard.press('Escape');
  // Sustain: two steps → a tap cycles
  await page.click('#chip-sustain');
  const sus = await page.evaluate(() => {
    const el = document.getElementById('chip-sustain');
    return {
      log: window.log.slice(-1)[0],
      text: el.textContent,
      pressed: el.getAttribute('aria-pressed'),
      on: el.classList.contains('on'),
      dot: !el.querySelector('.cdi').hidden,
      panel: !!document.querySelector('.step-panel'),
    };
  });
  assert.deepEqual(sus, {
    log: ['sustain', false],
    text: 'Sustain off',
    pressed: 'false',
    on: false,
    dot: true,
    panel: false,
  });
  await page.click('#chip-sustain');
  assert.deepEqual(await page.evaluate(() => window.log.slice(-1)[0]), ['sustain', true]);
  p = await panelInfo();
  assert.equal(p, null);
});

test(
  'stepChip keyboard: Enter opens with focus on the current step, arrows move, Enter picks and focus returns; ' +
    'arrows on the chip step without opening and never reach the document',
  async () => {
    await fresh();
    await mountStrip();
    await page.focus('#chip-space');
    await page.keyboard.press('Enter');
    let p = await panelInfo();
    assert.equal(p.focusedStep, '25%');
    await page.keyboard.press('ArrowUp');
    p = await panelInfo();
    assert.equal(p.focusedStep, '50%');
    assert.equal(await page.evaluate(() => window.log.length), 0, 'arrows only move focus (choosing closes the panel)');
    await page.keyboard.press('Enter');
    const r = await page.evaluate(() => ({
      log: window.log.slice(),
      open: !!document.querySelector('.step-panel'),
      focus: document.activeElement?.id,
    }));
    assert.deepEqual(r, { log: [['space', 0.5]], open: false, focus: 'chip-space' });
    // arrows on the chip itself
    await page.evaluate(() => (window.docKeys.length = 0));
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    const r2 = await page.evaluate(() => ({
      log: window.log.slice(1),
      docKeys: window.docKeys.filter((k) => k.key.startsWith('Arrow')).length,
      open: !!document.querySelector('.step-panel'),
    }));
    assert.deepEqual(r2, {
      log: [
        ['space', 0.25],
        ['space', 0],
        ['space', 0.25],
      ],
      docKeys: 0,
      open: false,
    });
    // Esc on a keyboard-opened panel closes it, returns focus to the chip, and main.js never sees it (no panic)
    await page.keyboard.press('Enter');
    await page.evaluate(() => (window.docKeys.length = 0));
    await page.keyboard.press('Escape');
    const r3 = await page.evaluate(() => ({
      open: !!document.querySelector('.step-panel'),
      focus: document.activeElement?.id,
      docKeys: window.docKeys.slice(),
      overlays: window.C.openOverlayCount(),
    }));
    assert.deepEqual(r3, { open: false, focus: 'chip-space', docKeys: [], overlays: 0 });
    // with nothing open, Esc reaches the document untouched (today's rule: main.js decides)
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('Escape');
    assert.deepEqual(await page.evaluate(() => window.docKeys.slice()), [{ key: 'Escape', prevented: false }]);
  },
);

test(
  'step panel: Esc after a tap-open closes without panic; an outside tap closes and is swallowed except ' +
    'pass-through targets (ON tiles, [data-overlay-pass])',
  async () => {
    await fresh();
    await mountStrip();
    await page.click('#chip-echo');
    await page.evaluate(() => (window.docKeys.length = 0));
    await page.keyboard.press('Escape');
    assert.deepEqual(
      await page.evaluate(() => ({ open: !!document.querySelector('.step-panel'), keys: window.docKeys.length })),
      { open: false, keys: 0 },
    );
    // outside tap on an ordinary control: closes, and that control does not get the click
    await page.click('#chip-echo');
    await page.click('#outside');
    assert.deepEqual(
      await page.evaluate(() => ({ open: !!document.querySelector('.step-panel'), log: window.log.slice() })),
      { open: false, log: [] },
    );
    await page.click('#outside');
    assert.deepEqual(
      await page.evaluate(() => window.log.slice()),
      ['outside-click'],
      'the next click is not swallowed',
    );
    // pass-through: PANIC-like button and the ON tile work through an open panel
    await page.click('#chip-echo');
    await page.click('#pass');
    // (the panel covers its own strip's tile, as in perform-step.png; another strip's tile passes through)
    await page.evaluate(() => {
      const t = window.C.onTile({
        label: 'PAD',
        color: 'var(--slot-1)',
        onToggle: (on) => window.log.push(['pad', on]),
      });
      t.el.id = 'tile1';
      t.el.style.width = '180px';
      document.getElementById('area').append(t.el);
    });
    await page.click('#chip-echo');
    await page.click('#tile1');
    assert.deepEqual(await page.evaluate(() => window.log.slice(1)), ['pass-click', ['pad', false]]);
    assert.equal(await page.evaluate(() => window.C.openOverlayCount()), 0);
  },
);

test('step panel fine slider: moves the value continuously and keeps the panel open', async () => {
  await fresh();
  await mountStrip();
  await page.click('#chip-space');
  const box = await page.locator('.sp-fine input[type=range]').boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - box.height * 0.3, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(80);
  const r = await page.evaluate(() => ({
    last: window.log.slice(-1)[0],
    open: !!document.querySelector('.step-panel'),
    chip: document.querySelector('#chip-space .mc-value').textContent,
  }));
  assert.equal(r.last[0], 'space');
  assert.ok(r.last[1] > 0.45 && r.last[1] < 0.65, `relative drag of 30 % from 25 % → ${r.last[1].toFixed(3)}`);
  assert.equal(r.open, true);
  assert.equal(r.chip, `${Math.round(r.last[1] * 100)}%`);
});

test('stepChip placement:auto (polish-1): below / above / cover from the room in the host; fine slider fills the body',
  async () => {
    await fresh();
    const r = await page.evaluate(async () => {
      const C = window.C;
      const area = document.getElementById('area');
      const mk = (hostH, chipTop) => {
        const host = document.createElement('div');
        host.style.cssText = `position:relative;width:200px;height:${hostH}px;background:#222;margin-bottom:10px`;
        const chip = C.stepChip({ label: 'Echo', steps: C.AMOUNT_STEPS, value: 0.25, mount: host, placement: 'auto',
          fine: { min: 0, max: 1 } });
        chip.el.style.cssText = `position:absolute;left:10px;top:${chipTop}px;width:80px`;
        host.append(chip.el);
        area.append(host);
        return { host, chip };
      };
      const geo = async ({ host, chip }) => {
        chip.open();
        await new Promise((res) => requestAnimationFrame(res));
        const p = host.querySelector('.step-panel');
        const pr = p.getBoundingClientRect();
        const cr = chip.el.getBoundingClientRect();
        const hr = host.getBoundingClientRect();
        const fine = p.querySelector('.sp-fine .fader-input').getBoundingClientRect();
        const body = p.querySelector('.sp-body').getBoundingClientRect();
        const out = { dir: p.dataset.dir, below: pr.top >= cr.bottom - 1, above: pr.bottom <= cr.top + 1,
          inHost: pr.top >= hr.top - 1 && pr.bottom <= hr.bottom + 1, fineFills: fine.height >= body.height - 2 };
        chip.close();
        return out;
      };
      const down = await geo(mk(420, 10));
      const up = await geo(mk(420, 360));
      const cover = await geo(mk(260, 110));
      const legacy = C.stepChip({ label: 'Space', steps: C.AMOUNT_STEPS, value: 0 });
      const lh = document.createElement('div');
      lh.style.cssText = 'position:relative;height:400px;width:180px';
      lh.append(legacy.el);
      area.append(lh);
      legacy.open();
      const legacyDir = lh.querySelector('.step-panel')?.dataset.dir;
      legacy.close();
      return { down, up, cover, legacyDir };
    });
    assert.deepEqual(r.down, { dir: 'down', below: true, above: false, inHost: true, fineFills: true });
    assert.deepEqual(r.up, { dir: 'up', below: false, above: true, inHost: true, fineFills: true });
    assert.equal(r.cover.dir, 'cover');
    assert.ok(r.cover.inHost && r.cover.fineFills, JSON.stringify(r.cover));
    assert.equal(r.legacyDir, 'up', 'without placement the panel still opens above the chip (Perform)');
  });

test('overlay: an overlay inside a [hidden] view never eats Esc or a tap (round3-edit M1); closeOverlaysWithin', async () => {
  await fresh();
  await mountStrip();
  await page.click('#chip-space');
  // hide the strip the way a ⌘E / Ctrl+E view switch hides #view-edit (no outside tap closes the panel)
  await page.evaluate(() => {
    window.docKeys.length = 0;
    document.getElementById('strips').hidden = true;
  });
  await page.keyboard.press('Escape');
  const r = await page.evaluate(() => ({
    keys: window.docKeys.slice(),
    open: !!document.querySelector('.step-panel'),
    overlays: window.C.openOverlayCount(),
  }));
  assert.deepEqual(r, { keys: [{ key: 'Escape', prevented: false }], open: false, overlays: 0 },
    'Esc reaches the document (main.js: Panic) and the hidden panel is pruned');
  // a tap is not swallowed by an invisible overlay either
  await page.evaluate(() => (document.getElementById('strips').hidden = false));
  await page.click('#chip-space');
  await page.evaluate(() => {
    document.getElementById('strips').hidden = true;
    window.log.length = 0;
  });
  await page.click('#outside');
  assert.deepEqual(await page.evaluate(() => window.log.slice()), ['outside-click']);
  assert.equal(await page.evaluate(() => window.C.openOverlayCount()), 0);
  // closeOverlaysWithin(root): the Edit shell's belt and braces on leaving the view
  await page.evaluate(() => (document.getElementById('strips').hidden = false));
  await page.click('#chip-space');
  const n = await page.evaluate(async () => {
    const m = await import('/js/views/components/overlay.js');
    const why = [];
    const other = document.createElement('div');
    document.body.append(other);
    m.openOverlay({ el: other, onClose: (r) => why.push(r) });
    const closed = m.closeOverlaysWithin(document.getElementById('strips'));
    const left = m.openOverlayCount();
    m.closeOverlaysWithin(document.body);
    return { closed, left, why, open: !!document.querySelector('.step-panel') };
  });
  assert.deepEqual(n, { closed: 1, left: 1, why: ['hidden'], open: false });
});

test('stepChip.cancelDrag(): abandons the fine drag and closes the panel (round3-edit M2)', async () => {
  await fresh();
  await mountStrip();
  await page.click('#chip-space');
  const box = await page.locator('.sp-fine input[type=range]').boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - box.height * 0.15, { steps: 3 });
  await page.waitForTimeout(60);
  const n0 = await page.evaluate(() => {
    window.chips.space.cancelDrag();
    return window.log.length;
  });
  await page.mouse.move(x, y - box.height * 0.4, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(80);
  const r = await page.evaluate(() => ({ n: window.log.length, open: window.chips.space.isOpen,
    panel: !!document.querySelector('.step-panel'), overlays: window.C.openOverlayCount() }));
  assert.deepEqual(r, { n: n0, open: false, panel: false, overlays: 0 });
  // no panel open: a no-op
  await page.evaluate(() => window.chips.space.cancelDrag());
});

test('headerChipRow: one-tap presets with hints, selected = steel + white outline, changed dot, "…" menu, Song’s own', async () => {
  await fresh();
  await page.evaluate(() => {
    const C = window.C;
    const space = C.headerChipRow({
      label: 'Space',
      options: C.SPACE_CHIPS,
      more: C.SPACE_MORE,
      value: 'hall',
      onSelect: (id) => window.log.push(['space', id]),
    });
    const echo = C.headerChipRow({
      label: 'Echo',
      options: C.ECHO_CHIPS,
      value: C.SONG_OWN,
      onSelect: (id) => window.log.push(['echo', id]),
    });
    space.el.id = 'row-space';
    echo.el.id = 'row-echo';
    const card = document.createElement('section');
    card.style.cssText = 'width: 640px; display: grid; gap: 7px; position: relative;';
    card.append(space.el, echo.el);
    document.getElementById('area').append(card);
    window.rows = { space, echo };
  });
  const r = await page.evaluate(() => {
    const row = document.getElementById('row-space');
    const on = row.querySelector('.fxc.on');
    const cs = getComputedStyle(on);
    return {
      labels: [...row.querySelectorAll('.fxrow > .fxc')].map((b) => b.textContent),
      on: on.dataset.id,
      checked: on.getAttribute('aria-checked'),
      bg: cs.backgroundColor,
      border: cs.borderTopColor,
      group: row.querySelector('.fxrow').getAttribute('role'),
      minH: Math.min(...[...row.querySelectorAll('.fxc')].map((b) => b.getBoundingClientRect().height)),
    };
  });
  assert.deepEqual(r.labels.slice(0, 5), ['Drynone', 'Roomsmall', 'Stagemedium', 'Hallbig', 'Cathedralhuge']);
  assert.equal(r.on, 'hall');
  assert.equal(r.checked, 'true');
  assert.equal(r.bg, 'rgb(58, 66, 80)', 'selected = --sel-fx steel, never a slot colour');
  assert.equal(r.border, 'rgb(241, 244, 248)');
  assert.equal(r.group, 'radiogroup');
  assert.ok(r.minH >= 44);
  await page.click('#row-space .fxc[data-id="room"]');
  await page.evaluate(() => window.rows.space.setChanged(true));
  assert.deepEqual(
    await page.evaluate(() => ({
      log: window.log.slice(),
      dot: !document.querySelector('#row-space .fxc.on .cd').hidden,
    })),
    { log: [['space', 'room']], dot: true },
  );
  // "…" → Ambient Wash; the more chip then shows it lit
  await page.click('#row-space .fxc.more');
  assert.equal(await page.isVisible('#row-space .fx-more'), true);
  await page.click('#row-space .fx-more .fxc[data-id="wash"]');
  const m = await page.evaluate(() => ({
    log: window.log.slice(-1)[0],
    menu: !!document.querySelector('.fx-more'),
    more: document.querySelector('#row-space .fxc.more').textContent,
    moreOn: document.querySelector('#row-space .fxc.more').classList.contains('on'),
  }));
  assert.deepEqual(m, { log: ['space', 'wash'], menu: false, more: 'Ambient Wash', moreOn: true });
  // Song's own: re-tapping it re-applies (it is the "bring my echo back" button)
  await page.click('#row-echo .fxc.own');
  await page.click('#row-echo .fxc[data-id="none"]');
  await page.click('#row-echo .fxc.own');
  assert.deepEqual(await page.evaluate(() => window.log.slice(-3)), [
    ['echo', 'own'],
    ['echo', 'none'],
    ['echo', 'own'],
  ]);
  assert.match(await page.textContent('#row-echo .fxc.own'), /Song’s own\s*as saved/);
});

test('headerChipRow keyboard: arrows move focus without applying; Enter applies; disabled; compact pill at 1024', async () => {
  await fresh();
  await page.evaluate(() => {
    const C = window.C;
    const row = C.headerChipRow({
      label: 'Echo',
      options: C.ECHO_CHIPS,
      value: 'dotted',
      onSelect: (id) => window.log.push(id),
    });
    row.el.id = 'row';
    document.getElementById('area').append(row.el);
    window.row = row;
  });
  await page.focus('#row .fxc[data-id="dotted"]');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  assert.deepEqual(await page.evaluate(() => ({ log: window.log.slice(), focus: document.activeElement.dataset.id })), {
    log: [],
    focus: 'quarter',
  });
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.log.slice()), ['quarter']);
  await page.evaluate(() => window.row.setDisabled(true));
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#row .fxc')].every((b) => b.disabled)), true);
  await page.evaluate(() => window.row.setDisabled(false));
  // compact: the row collapses into a pill that opens it
  await page.setViewportSize({ width: 1024, height: 700 });
  assert.equal(await page.isVisible('#row .fxrow'), false);
  assert.equal(await page.isVisible('#row .fxpill'), true);
  assert.equal(await page.textContent('#row .fxpill-v'), 'Quarter');
  await page.click('#row .fxpill');
  assert.equal(await page.isVisible('#row .fxrow'), true);
  await page.click('#row .fxc[data-id="none"]');
  assert.deepEqual(
    await page.evaluate(() => ({
      log: window.log.slice(-1)[0],
      pill: document.querySelector('#row .fxpill-v').textContent,
    })),
    { log: 'none', pill: 'Off' },
  );
  assert.equal(await page.isVisible('#row .fxrow'), false, 'choosing closes the compact popover');
});

test('holdButton: a short press does nothing (hint), a 600 ms hold activates once, progress rises, no extra click', async () => {
  await fresh();
  await page.evaluate(() => {
    const b = window.C.holdButton({
      label: 'Revert',
      ms: 600,
      onActivate: () => window.log.push('activate'),
      onHoldCancel: () => window.log.push('cancel'),
    });
    b.el.id = 'hb';
    document.getElementById('area').append(b.el);
    window.hb = b;
  });
  const box = await page.locator('#hb').boundingBox();
  assert.ok(box.height >= 44 && box.width >= 44);
  assert.equal(await page.evaluate(() => document.getElementById('hb').classList.contains('needs-hold')), true);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(200);
  await page.mouse.up();
  const short = await page.evaluate(() => ({
    log: window.log.slice(),
    hint: document.getElementById('hb').classList.contains('hint'),
    cap: document.querySelector('#hb .hb-cap').textContent,
  }));
  assert.deepEqual(short.log, ['cancel']);
  assert.equal(short.hint, true);
  assert.match(short.cap, /press and hold/);
  await page.mouse.down();
  await page.waitForTimeout(330);
  const mid = await page.evaluate(() => ({
    p: window.hb.progress,
    holding: window.hb.holding,
    cls: document.getElementById('hb').classList.contains('holding'),
    cap: document.querySelector('#hb .hb-cap').textContent,
    css: parseFloat(document.getElementById('hb').style.getPropertyValue('--hold')),
  }));
  assert.ok(mid.holding && mid.cls);
  assert.ok(mid.p > 0.2 && mid.p < 0.95, `progress mid-hold ${mid.p}`);
  assert.equal(mid.css, Number(mid.p.toFixed(3)));
  assert.match(mid.cap, /keep holding… \(0\.6 s\)/);
  await page.waitForTimeout(450);
  await page.mouse.up();
  await page.waitForTimeout(50);
  const done = await page.evaluate(() => ({
    log: window.log.slice(),
    holding: window.hb.holding,
    p: window.hb.progress,
  }));
  assert.deepEqual(done.log, ['cancel', 'activate'], 'activated exactly once; the release click is not a second press');
  assert.equal(done.holding, false);
  assert.equal(done.p, 0);
  // a plain click with hold required does nothing
  await page.click('#hb');
  assert.deepEqual(await page.evaluate(() => window.log.filter((x) => x === 'activate').length), 1);
  // disabled: no hold
  await page.evaluate(() => window.hb.setDisabled(true));
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.log.filter((x) => x === 'activate').length), 1);
});

test('holdButton as Lock: a click locks, holding Enter unlocks once and its auto-repeats never re-lock (round2-ui #5)', async () => {
  await fresh();
  await page.evaluate(() => {
    window.locked = false;
    const b = window.C.holdButton({
      label: 'Lock',
      ms: 600,
      requireHold: () => window.locked,
      onActivate: () => {
        window.locked = !window.locked;
        window.log.push(window.locked ? 'lock' : 'unlock');
      },
    });
    b.el.id = 'lock';
    document.getElementById('area').append(b.el);
    window.lockBtn = b;
  });
  await page.click('#lock');
  assert.deepEqual(
    await page.evaluate(() => [window.log.slice(), document.getElementById('lock').classList.contains('needs-hold')]),
    [['lock'], true],
  );
  await page.focus('#lock');
  await page.keyboard.down('Enter');
  await page.waitForTimeout(300);
  await page.keyboard.down('Enter'); // auto-repeat (repeat: true)
  assert.deepEqual(await page.evaluate(() => window.log.slice()), ['lock'], 'still holding');
  await page.waitForTimeout(450);
  for (let i = 0; i < 6; i++) {
    await page.keyboard.down('Enter');
    await page.waitForTimeout(40);
  }
  await page.keyboard.up('Enter');
  await page.waitForTimeout(700);
  assert.deepEqual(await page.evaluate(() => window.log.slice()), ['lock', 'unlock']);
  // now unlocked: one Enter press locks again (no hold needed)
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.log.slice()), ['lock', 'unlock', 'lock']);
  // Space hold works the same, and a short Space press only hints
  await page.keyboard.down(' ');
  await page.waitForTimeout(150);
  await page.keyboard.up(' ');
  assert.deepEqual(
    await page.evaluate(() => [window.log.length, document.getElementById('lock').classList.contains('hint')]),
    [3, true],
  );
  await page.keyboard.down(' ');
  await page.waitForTimeout(750);
  await page.keyboard.up(' ');
  assert.deepEqual(await page.evaluate(() => window.log.slice(-1)), ['unlock']);
});

test('quickSheet: hidden until opened; tempo/TAP, swell, touch, pedal lamp, restart; lock freezes This Mac only', async () => {
  await fresh();
  await page.evaluate(() => {
    const C = window.C;
    const anchor = document.createElement('button');
    anchor.id = 'quick-btn';
    anchor.textContent = 'Quick';
    document.getElementById('area').append(anchor);
    const cb = (k) => (v) => window.log.push([k, v]);
    const q = C.quickSheet({
      anchor,
      onTempo: cb('tempo'),
      onSwell: cb('swell'),
      onTouch: cb('touch'),
      onPedalReversed: cb('reversed'),
      onRestartAudio: () => window.log.push(['restart']),
      onAllSettings: () => window.log.push(['all']),
      onClose: cb('close'),
      state: {
        songName: 'Sunday Pad + Piano',
        tempo: 72,
        swell: 8,
        touch: 'normal',
        sound: 'ok',
        latencyMs: 12,
        echoSynced: false,
      },
    });
    document.getElementById('area').append(q.el);
    anchor.addEventListener('click', () => (q.isOpen ? q.close() : q.open()));
    window.q = q;
  });
  assert.equal(await page.isVisible('[data-testid=quick-sheet]'), false);
  await page.click('#quick-btn');
  const r = await page.evaluate(() => {
    const el = document.querySelector('[data-testid=quick-sheet]');
    return {
      visible: !el.hidden,
      expanded: document.getElementById('quick-btn').getAttribute('aria-expanded'),
      bpm: el.querySelector('.qs-bpm').textContent,
      scope: el.querySelector('.qs-scope').textContent,
      hint: el.querySelector('.qs-tempo-hint').textContent,
      ok: el.querySelector('.qs-ok').textContent,
      hold: !el.querySelector('.qs-restart-hold').hidden,
      restart: !el.querySelector('.qs-restart').hidden,
      role: el.getAttribute('role'),
    };
  });
  assert.deepEqual(r, {
    visible: true,
    expanded: 'true',
    bpm: '72BPM',
    scope: 'saved with “Sunday Pad + Piano” · Revert undoes',
    hint: 'Tap along 4×.This song’s echo keeps its own time.',
    ok: 'Sound OK · 12 ms',
    hold: true,
    restart: false,
    role: 'group',
  });
  // TAP: four taps 500 ms apart → 120 BPM (the rule Edit uses)
  const bpm = await page.evaluate(() => [0, 500, 1000, 1500].map((t) => window.q.tap(10000 + t)));
  assert.deepEqual(bpm, [null, 120, 120, 120]);
  assert.equal(await page.evaluate(() => window.C.tapBpm([0, 1000])), 60);
  await page.click('[data-testid=quick-tap]');
  // swell stepper, touch, reversed
  await page.click('.qs .stepper .step-btn.inc');
  await page.click('.qs .segmented .seg[data-value="hard"]');
  await page.click('.qs .toggle');
  await page.evaluate(() => window.q.set({ pedal: true }));
  const r2 = await page.evaluate(() => ({
    log: window.log.filter((x) => x[0] !== 'tempo'),
    lamp: document.querySelector('.qs-pedal').classList.contains('on'),
    lampLabel: document.querySelector('.qs-pedal').getAttribute('aria-label'),
  }));
  assert.deepEqual(r2, {
    log: [
      ['swell', 9],
      ['touch', 'hard'],
      ['reversed', true],
    ],
    lamp: true,
    lampLabel: 'Sustain pedal: down',
  });
  // lock: This Mac + All settings frozen; This song and restart live
  await page.evaluate(() => window.q.set({ locked: true }));
  const lk = await page.evaluate(() => ({
    touch: [...document.querySelectorAll('.qs .segmented .seg')].every((b) => b.disabled),
    reversed: document.querySelector('.qs .toggle').disabled,
    all: document.querySelector('.qs-all').disabled,
    tap: document.querySelector('.qs-tap').disabled,
    swell: document.querySelector('.qs .stepper .step-btn.inc').disabled,
    restart: document.querySelector('.qs-restart-hold').disabled,
  }));
  assert.deepEqual(lk, { touch: true, reversed: true, all: true, tap: false, swell: false, restart: false });
  // stalled: one-click Restart; OK: hold-to-restart (1 s)
  await page.evaluate(() => window.q.set({ sound: 'stalled' }));
  assert.equal(await page.isVisible('.qs-restart'), true);
  assert.equal(await page.isVisible('.qs-restart-hold'), false);
  await page.click('.qs-restart');
  assert.deepEqual(await page.evaluate(() => window.log.slice(-1)[0]), ['restart']);
  await page.evaluate(() => window.q.set({ sound: 'ok' }));
  const hb = await page.locator('.qs-restart-hold').boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.mouse.up();
  assert.equal(
    await page.evaluate(() => window.log.filter((x) => x[0] === 'restart').length),
    1,
    '0.6 s is not enough for restart',
  );
  await page.mouse.down();
  await page.waitForTimeout(1150);
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.log.filter((x) => x[0] === 'restart').length), 2);
});

test('quickSheet overlay rules: outside taps keep it open (keep playing), Esc closes without panic, × closes', async () => {
  await fresh();
  await page.evaluate(() => {
    const q = window.C.quickSheet({ onClose: (why) => window.log.push(['close', why]) });
    document.getElementById('area').append(q.el);
    window.q = q;
    q.open();
  });
  await page.click('#outside');
  assert.deepEqual(await page.evaluate(() => ({ open: window.q.isOpen, log: window.log.slice() })), {
    open: true,
    log: ['outside-click'],
  });
  await page.evaluate(() => (window.docKeys.length = 0));
  await page.keyboard.press('Escape');
  assert.deepEqual(
    await page.evaluate(() => ({
      open: window.q.isOpen,
      hidden: window.q.el.hidden,
      keys: window.docKeys.length,
      log: window.log.slice(-1)[0],
    })),
    { open: false, hidden: true, keys: 0, log: ['close', 'escape'] },
  );
  await page.evaluate(() => window.q.open({ focus: true }));
  assert.equal(
    await page.evaluate(() => document.activeElement.classList.contains('qs-tap')),
    true,
    'keyboard open focuses TAP',
  );
  await page.click('.qs-x');
  assert.deepEqual(
    await page.evaluate(() => ({
      open: window.q.isOpen,
      log: window.log.slice(-1)[0],
      overlays: window.C.openOverlayCount(),
    })),
    { open: false, log: ['close', 'api'], overlays: 0 },
  );
  // 44 px targets across the sheet
  await page.evaluate(() => window.q.open());
  const small = await page.evaluate(() =>
    [...document.querySelectorAll('.qs button, .qs [role=spinbutton]')]
      .filter((b) => b.offsetParent !== null)
      .map((b) => ({ c: b.className || b.getAttribute('role'), h: b.getBoundingClientRect().height }))
      .filter((x) => x.h < 44),
  );
  assert.deepEqual(small, []);
});

test('no console errors on the fixture page', () => {
  assert.deepEqual(errors, []);
});
