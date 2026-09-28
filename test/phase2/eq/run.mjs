#!/usr/bin/env node
// eq-ui suite: shared/eq-math.js unit tests (node:test) + the keyboard EQ component (views/components/eq-keyboard.js)
// in Playwright, mounted by test/phase2/eq/fixture.html against the real store/engine/controller (server.js, free port).
//   node test/phase2/eq/run.mjs                 → unit + browser
//   node test/phase2/eq/run.mjs --only unit|browser
//   VERBOSE=1 … → page console
// Screenshots → test/phase2/eq/screenshots/. Engine features another agent adds concurrently (getEqResponse,
// getSlotPlayRange, eqAudition, the b-row PARAMS) are feature-detected: their absence is a NOTE, not a failure.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const SHOTS = path.join(HERE, 'screenshots');
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  return i > 0 ? process.argv[i + 1] : null;
})();
const VERBOSE = !!process.env.VERBOSE;
fs.mkdirSync(SHOTS, { recursive: true });
for (const f of fs.readdirSync(SHOTS)) if (f.startsWith('FAIL-')) fs.rmSync(path.join(SHOTS, f));

const results = [];
const notes = [];
const note = (msg) => {
  notes.push(msg);
  console.log(`    NOTE ${msg}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, eps, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} vs ${b} (±${eps})`);
const midiF = (n) => 440 * Math.pow(2, (n - 69) / 12);

// ------------------------------------------------------------------------------------------------------------ unit
function runUnit() {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--test', path.join(ROOT, 'test/unit/shared/eq-math.test.mjs')], {
    cwd: ROOT, encoding: 'utf8',
  });
  const out = `${r.stdout}${r.stderr}`;
  const pass = Number(/# pass (\d+)/.exec(out)?.[1] ?? 0);
  const fail = Number(/# fail (\d+)/.exec(out)?.[1] ?? 0);
  const skip = Number(/# skipped (\d+)/.exec(out)?.[1] ?? 0);
  const ok = r.status === 0 && fail === 0;
  results.push({ name: `unit: eq-math (${pass} pass, ${skip} skipped)`, ok, err: ok ? null : out.slice(-3000) });
  console.log(`  ${ok ? '✓' : '✗'} unit: eq-math.test.mjs — ${pass} pass, ${fail} fail, ${skip} skipped (${Date.now() - t0} ms)`);
  if (!ok) console.log(out.split('\n').filter((l) => /not ok|Error|expected|actual/.test(l)).slice(0, 30).join('\n'));
  if (skip) note('eq-math: PARAMS b-row agreement test skipped (slots.<i>.eq.b<k>.* rows not in params.js yet)');
}

// ------------------------------------------------------------------------------------------------------------ browser
async function runBrowser() {
  const { chromium } = await import('playwright');
  const { createServer } = require(path.join(ROOT, 'server.js'));
  const server = createServer({ appDir: ROOT, port: 0 });
  const info = await server.listen();
  const origin = `http://127.0.0.1:${info.port}`;
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(['midi', 'midi-sysex', 'clipboard-read', 'clipboard-write'], { origin });
  const page = await context.newPage();
  const errors = [];
  const warns = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${m.text()} @ ${m.location()?.url || '?'}`);
    else if (m.type() === 'warning' && /\[eq\]/.test(m.text())) warns.push(m.text());
    if (VERBOSE) console.log(`   [page ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  let loaded = false;
  let origin0 = null;
  page.on('crash', () => console.log('    DIAG renderer crashed'));
  page.on('framenavigated', (f) => {
    if (f !== page.mainFrame()) return;
    if (loaded) {
      console.log(`    NAV unexpected navigation → ${f.url()}`);
      errors.push(`unexpected navigation → ${f.url()}`);
    }
  });
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
  });

  const T = async (name, fn) => {
    const t0 = Date.now();
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
    } catch (err) {
      if (/Execution context was destroyed/.test(String(err))) {
        const now = await page.evaluate(() => ({ origin: performance.timeOrigin, url: location.href,
          changes: window.__eq?.changes?.length ?? null })).catch((e) => ({ err: String(e) }));
        console.log(`    DIAG context destroyed: timeOrigin ${origin0} → ${now.origin} (${now.origin === origin0 ? 'same page' : 'RELOADED'}), ` +
          `url ${now.url}, onChange count ${now.changes}`);
      }
      results.push({ name, ok: false, err });
      console.log(`  ✗ ${name}\n      ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 7).join('\n      ')}`);
      await page.screenshot({ path: path.join(SHOTS, `FAIL-${name.replace(/[^\w]+/g, '-').slice(0, 60)}.png`), timeout: 10000 })
        .catch(() => {});
    }
  };
  const ev = (fn, arg) => page.evaluate(fn, arg);
  /** Screenshots are artifacts, not assertions: a slow box must not fail a test (or strand its state) on one. */
  const shot = (name, o = {}) => page.screenshot({ path: path.join(SHOTS, name), timeout: 15000, ...o })
    .catch((err) => note(`screenshot ${name} skipped: ${String(err.message || err).split('\n')[0]}`));
  const settle = () => ev(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  const dbg = () => ev(() => {
    const d = window.__eq.comp.debug();
    delete d.xOfF;
    delete d.xOfMidi;
    delete d.yOfDb;
    delete d.curveAt;
    return d;
  });
  const geo = (fn, arg) => ev(({ fn, arg }) => window.__eq.comp.debug()[fn](arg), { fn, arg });
  const eq = (i = 0) => ev((i) => window.__eq.eq(i), i);
  const band = async (k, i = 0) => {
    const e = (await eq(i)) || {};
    return e[`b${k}`] ?? null;
  };
  const node = async (k) => (await dbg()).nodes.find((n) => n.k === k);
  const row = (k) => page.locator(`.eqk-bands tr[data-k="${k}"]`);
  const pixel = (sel, x, y) => ev(({ sel, x, y }) => {
    const c = document.querySelector(sel);
    const r = c.getBoundingClientRect();
    const dpr = c.width / r.width;
    return [...c.getContext('2d').getImageData(Math.round((x - r.left) * dpr), Math.round((y - r.top) * dpr), 1, 1).data];
  }, { sel, x, y });
  const lum = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
  /** Fresh slot `i` with an instrument, split and a clean EQ, then mount the component for it. */
  // no import() inside page.evaluate: under load it intermittently failed with "Execution context was destroyed"
  // (same page, no navigation); the fixture exposes the modules on window.__eq instead
  const setupSlot = (i, o = {}) => ev(({ i, o }) => {
    const { store } = window.__rig;
    const { defaultSlot } = window.__eq.params;
    const s = store.currentSong();
    store.set('song.hearIn', s.playIn); // no song transpose
    store.set(`slots.${i}`, { ...defaultSlot(i, { type: 'sampler', id: o.inst || 'salamander-piano' }),
      lowNote: o.lowNote ?? 0, highNote: o.highNote ?? 127, octave: o.octave ?? 0, transpose: 0 });
    store.flush();
    window.__eq.mount({ slot: i, compact: !!o.compact, rta: o.rta !== false });
    return true;
  }, { i, o }).then(settle);
  const typeCell = async (k, f, text) => {
    const inp = row(k).locator(`input[data-f="${f}"]`);
    await inp.click();
    await inp.fill(text);
    await inp.press('Enter');
    await settle();
  };

  try {
    await page.goto(`${origin}/test/phase2/eq/fixture.html?key=eqtest-${Date.now()}`);
    await page.waitForFunction(() => window.__fixture && window.__rig, null, { timeout: 30000 });
    await ev(() => window.__rig.ready);
    loaded = true;
    origin0 = await ev(() => performance.timeOrigin);
    const caps = await ev(() => {
      const e = window.__rig.engine;
      return {
        getEqResponse: typeof e.getEqResponse === 'function', getSlotPlayRange: typeof e.getSlotPlayRange === 'function',
        eqAudition: typeof e.eqAudition === 'function' || typeof window.__rig.controller.eqAudition === 'function',
        slotAnalysers: typeof e.slotAnalysers === 'function',
      };
    });
    const rows = await ev(() => !!window.__eq.params.describe('slots.0.eq.b1.hz'));
    for (const [k, v] of Object.entries(caps)) if (!v) note(`engine has no ${k}() yet → component fallback in use`);
    if (!rows) note('PARAMS has no slots.<i>.eq.b<k>.* rows yet: the store accepts the writes as unknown nested fields (not clamped)');

    // pixel checks mount with rta:false (the song's drone would paint the spectrum under the sample points).
    // Tests build on each other; ensureB2() re-creates their precondition so one failure doesn't cascade.
    const ensureB2 = async () => {
      if ((await dbg()).slotIndex !== 0) await setupSlot(0, { lowNote: 48, highNote: 127 });
      const b = await band(2);
      if (!b || b.type !== 'peak' || !b.on) {
        await ev(() => {
          const st = window.__rig.store;
          for (const [k, v] of Object.entries({ on: true, type: 'peak', hz: 440, db: 0, q: 1 })) st.set(`slots.0.eq.b2.${k}`, v);
          st.flush();
        });
        await settle();
      }
    };
    await T('mount slot 0: Grand Piano split C3–C8 → keys below C3 greyed, overtones zone above C8', async () => {
      await setupSlot(0, { lowNote: 48, highNote: 127, rta: false });
      await settle();
      const d = await dbg();
      assert.equal(d.zone.lo, 48, 'lowest sounding note C3');
      assert.equal(d.zone.hi, 108, 'highest = C8 (88-key controller)');
      near(d.zone.fLo, midiF(47.5), 1e-6);
      near(d.zone.fHi, midiF(108.5), 1e-6);
      assert.deepEqual(d.model.bands.map((b) => [b.k, b.type, b.legacy]), [[1, 'lowshelf', true], [8, 'highshelf', true]]);
      const kb = d.kb;
      const y = kb.top + kb.height * 0.62;
      const c2 = await pixel('.eqk-kb', await geo('xOfMidi', 36), y);
      const c4 = await pixel('.eqk-kb', await geo('xOfMidi', 60), y);
      assert.ok(lum(c4) > 150 && lum(c2) < 90, `C2 greyed (${c2}) vs C4 lit (${c4})`);
      // plot: hatched no-notes zone below C3 and the overtones tint above C8, vs the plain in-range background
      const py = d.plot.top + d.plot.height * 0.55;
      const inRange = await pixel('.eqk-plot', await geo('xOfF', 700), py);
      const over = await pixel('.eqk-plot', await geo('xOfF', 11000), py);
      assert.ok(lum(over) > lum(inRange) + 2, `overtones tint ${over} vs in-range ${inRange}`);
      let hatch = 0;
      for (let dx = 0; dx < 14; dx++) {
        const p = await pixel('.eqk-plot', (await geo('xOfF', 70)) + dx, py);
        if (lum(p) > lum(inRange) + 4) hatch++;
      }
      assert.ok(hatch >= 2, `hatch strokes below C3 (${hatch}/14 bright px)`);
      await shot('eq-mount-keys-1440.png', { fullPage: true });
    });

    await T('Bass (B2 top, octave down): overtones zone starts at B2, zones follow the slot live', async () => {
      await setupSlot(3, { lowNote: 0, highNote: 59, octave: -1, inst: 'salamander-piano', rta: false });
      await settle();
      try {
        await bassChecks();
      } finally {
        await setupSlot(0, { lowNote: 48, highNote: 127 });
      }
    });
    async function bassChecks() {
      let d = await dbg();
      assert.equal(d.zone.hi, 47);
      assert.equal(d.zone.lo, 21 - 12);
      const py = d.plot.top + d.plot.height * 0.55;
      const inRange = await pixel('.eqk-plot', await geo('xOfF', 70), py);
      const over = await pixel('.eqk-plot', await geo('xOfF', 700), py);
      assert.ok(lum(over) > lum(inRange) + 2, `tint above B2 ${over} vs ${inRange}`);
      await ev(() => window.__rig.store.set('slots.3.highNote', 64));
      await settle();
      d = await dbg();
      assert.equal(d.zone.hi, 52, 'split change re-greys live');
    }

    await T('double-tap empty graph adds a PEQ at that key (b2, then b3: on/type/hz/db/q); legacy shelves migrate', async () => {
      const d = await dbg();
      await page.mouse.dblclick(await geo('xOfMidi', 69), await geo('yOfDb', 7));
      await settle();
      let b2 = await band(2);
      assert.deepEqual(b2 && { ...b2, hz: Math.round(b2.hz * 1000) / 1000 }, { on: true, type: 'peak', hz: 440, db: 0, q: 1 });
      const e = await eq();
      assert.equal(e.b1.type, 'lowshelf', 'b1 migrated');
      assert.equal(e.b8.type, 'highshelf', 'b8 migrated');
      await page.mouse.dblclick(await geo('xOfMidi', 84), await geo('yOfDb', -7));
      await settle();
      const b3 = await band(3);
      assert.ok(b3, 'b3 written');
      assert.deepEqual([b3.on, b3.type, b3.db, b3.q], [true, 'peak', 0, 1]);
      near(b3.hz, midiF(84), 1e-6, 'snapped to C6');
      const dd = await dbg();
      assert.equal(dd.sel, 3, 'new band selected');
      assert.equal(await page.locator('.eqk-bands tbody tr').count(), 4, 'table grew to 4 rows');
      b2 = await band(2);
      assert.ok(b2.on);
      assert.ok(d.nodes.length === 2);
    });

    await T('Delete removes the selected band (b3.on false, type off); row ✕ too', async () => {
      if (!(await band(3)) || (await band(3)).type === 'off') {
        await page.mouse.dblclick(await geo('xOfMidi', 84), await geo('yOfDb', -7));
        await settle();
      }
      await page.locator('.eqk-plot').focus();
      await page.keyboard.press('3');
      await page.keyboard.press('Delete');
      await settle();
      const b3 = await band(3);
      assert.equal(b3.on, false);
      assert.equal(b3.type, 'off');
      assert.equal((await dbg()).model.bands.some((b) => b.k === 3), false);
      assert.equal(await page.locator('.eqk-bands tbody tr').count(), 3);
      // re-add and remove with the row ✕
      await page.mouse.dblclick(await geo('xOfMidi', 76), await geo('yOfDb', 8));
      await settle();
      assert.equal((await band(3)).type, 'peak', 'freed slot 3 reused');
      await row(3).locator('.eqk-del').click();
      await settle();
      assert.equal((await band(3)).type, 'off');
    });

    await T('type switch to notch updates the curve (and the store); back to PEQ', async () => {
      await ensureB2();
      await typeCell(2, 'hz', '440');
      const before = await geo('curveAt', 440);
      near(before, 0, 0.3, 'flat at 440 before');
      await row(2).locator('select').selectOption('notch');
      await settle();
      const b2 = await band(2);
      assert.equal(b2.type, 'notch');
      assert.ok(b2.q >= 2, `notch gets a narrow Q (${b2.q})`);
      const after = await geo('curveAt', 440);
      assert.ok(after < -10, `curve dips at 440 Hz: ${after}`);
      assert.equal(await row(2).locator('input[data-f="db"]').isDisabled(), true, 'notch has no gain cell');
      await shot('eq-notch.png');
      await row(2).locator('select').selectOption('peak');
      await settle();
      assert.equal((await band(2)).type, 'peak');
      assert.equal((await band(2)).q, 1);
    });

    await T('drag band 2 → store hz/db change (snapped to a key, 0.5 dB) and the curve follows', async () => {
      await ensureB2();
      const n = await node(2);
      const c0 = (await dbg()).curve.db;
      await page.mouse.move(n.x, n.y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(n.x + 9 * i, n.y - 7 * i);
      await page.mouse.up();
      await settle();
      const b2 = await band(2);
      const semi = 69 + 12 * Math.log2(b2.hz / 440);
      near(semi, Math.round(semi), 1e-6, 'snapped to a key');
      assert.ok(b2.hz > 440, `moved up (${b2.hz})`);
      assert.ok(b2.db > 2 && Math.abs(b2.db * 2 - Math.round(b2.db * 2)) < 1e-9, `boosted in 0.5 dB steps (${b2.db})`);
      const at = await geo('curveAt', b2.hz);
      near(at, b2.db, 0.35, 'curve peak at the band');
      const c1 = (await dbg()).curve.db;
      assert.ok(c1.some((v, i) => Math.abs(v - c0[i]) > 1), 'curve changed');
      assert.ok((await ev(() => window.__eq.changes.length)) > 0, 'onChange fired');
    });

    await T('typed 250 Hz stays 250 Hz: Enter on the unchanged note cell and a vertical drag do not re-snap', async () => {
      await ensureB2();
      await typeCell(2, 'hz', '250');
      assert.equal((await band(2)).hz, 250);
      assert.match(await row(2).locator('input[data-f="note"]').inputValue(), /B3/);
      const note = row(2).locator('input[data-f="note"]');
      await note.click();
      await note.press('Enter');
      await settle();
      assert.equal((await band(2)).hz, 250, 'Enter on unchanged note cell');
      const n = await node(2);
      await page.mouse.move(n.x, n.y);
      await page.mouse.down();
      for (let i = 1; i <= 5; i++) await page.mouse.move(n.x + (i % 2), n.y - 5 * i);
      await page.mouse.up();
      await settle();
      const b2 = await band(2);
      assert.equal(b2.hz, 250, 'vertical drag keeps 250 Hz');
      assert.ok(b2.db > (await dbg()).model.bands.find((b) => b.k === 2).db - 1e-9);
      await typeCell(2, 'q', '1 oct');
      near((await band(2)).q, 1.414, 0.01, '1 oct → Q');
      await typeCell(2, 'db', '-4.5');
      assert.equal((await band(2)).db, -4.5);
      await typeCell(2, 'note', 'F#2');
      near((await band(2)).hz, midiF(42), 1e-6);
      await typeCell(2, 'hz', 'abc');
      assert.equal(await row(2).locator('input[data-f="hz"]').evaluate((e) => e.classList.contains('bad')), true);
      await row(2).locator('input[data-f="hz"]').press('Escape');
    });

    await T('keyboard: 1–8 select, arrows move by a semitone / 0.5 dB, [ ] width, o = on/off', async () => {
      await ensureB2();
      await typeCell(2, 'hz', '440');
      await typeCell(2, 'db', '0');
      await page.locator('.eqk-plot').focus();
      await page.keyboard.press('2');
      const b0 = await band(2);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press(']');
      await settle();
      const b1 = await band(2);
      near(b1.hz, midiF(70), 1e-6, 'A4 → Bb4');
      assert.equal(b1.db, b0.db + 0.5);
      assert.ok(b1.q > b0.q);
      await page.keyboard.press('o');
      await settle();
      assert.equal((await band(2)).on, false);
      await page.keyboard.press('o');
      await settle();
      assert.equal((await band(2)).on, true);
      assert.equal((await dbg()).sel, 2);
    });

    await T('Q: wheel over the node narrows, dragging a wing widens', async () => {
      await ensureB2();
      await typeCell(2, 'db', '6');
      const n = await node(2);
      const q0 = (await band(2)).q;
      await page.mouse.move(n.x, n.y);
      await page.mouse.wheel(0, -200);
      await settle();
      const q1 = (await band(2)).q;
      assert.ok(q1 > q0 * 1.2, `wheel up narrows: ${q0} → ${q1}`);
      const w = (await dbg()).wings;
      assert.ok(w && w.length === 2, 'wings shown on the selected PEQ');
      await page.mouse.move(w[1].x, w[1].y);
      await page.mouse.down();
      await page.mouse.move(w[1].x + 40, w[1].y, { steps: 4 });
      await page.mouse.up();
      await settle();
      const q2 = (await band(2)).q;
      assert.ok(q2 < q1, `wing out widens: ${q1} → ${q2}`);
      // plain wheel over empty space is left to the page (no Q change)
      const d = await dbg();
      await page.mouse.move(await geo('xOfF', 60), d.plot.top + 30);
      await page.mouse.wheel(0, -200);
      await settle();
      near((await band(2)).q, q2, 1e-9, 'empty-space wheel ignored');
    });

    await T('double-click a node → 0 dB; long-press → off; drag off the bottom → removed', async () => {
      await ensureB2();
      await typeCell(2, 'db', '4');
      let n = await node(2);
      await page.mouse.dblclick(n.x, n.y);
      await settle();
      assert.equal((await band(2)).db, 0);
      n = await node(2);
      await page.mouse.move(n.x, n.y);
      await page.mouse.down();
      await sleep(900);
      await page.mouse.up();
      await settle();
      assert.equal((await band(2)).on, false, 'long-press switched it off');
      await row(2).locator('.eqk-onoff').click();
      await settle();
      assert.equal((await band(2)).on, true, 'row toggle on');
      n = await node(2);
      const d = await dbg();
      await page.mouse.move(n.x, n.y);
      await page.mouse.down();
      await page.mouse.move(n.x + 2, n.y + 20, { steps: 3 });
      await page.mouse.move(n.x + 2, d.plot.bottom + 40, { steps: 6 });
      await shot('eq-drag-off-bottom.png');
      await page.mouse.up();
      await settle();
      assert.equal((await band(2)).type, 'off', 'dragged off the bottom → removed');
    });

    await T('low/high cuts: drag LC in from the edge, type the HC, off again', async () => {
      const lc = (await dbg()).cuts.find((c) => c.cut === 'lc');
      assert.equal(lc.on, false);
      const x80 = await geo('xOfF', 80);
      await page.mouse.move(lc.x, lc.y);
      await page.mouse.down();
      await page.mouse.move(x80, lc.y, { steps: 6 });
      await page.mouse.up();
      await settle();
      const e = await eq();
      assert.ok(e.cutHz > 70 && e.cutHz < 95, `cutHz ${e.cutHz}`);
      assert.ok((await geo('curveAt', e.cutHz)) < -2.5, 'curve −3 dB at the cut');
      await page.locator('.eqk-hicut-hz').fill('12k');
      await page.locator('.eqk-hicut-hz').press('Enter');
      await settle();
      assert.equal((await eq()).hiCutHz, 12000);
      await page.locator('.eqk-cut-on').click();
      await page.locator('.eqk-hicut-on').click();
      await settle();
      const e2 = await eq();
      assert.deepEqual([e2.cutHz, e2.hiCutHz], [20, 20000]);
    });

    await T('paste "Filter 1: ON PK Fc 1000 Hz Gain -3 dB Q 1.4" → band set (replaces the EQ)', async () => {
      await page.locator('.eqk-paste summary').click();
      await page.locator('.eqk-paste-text').fill('Filter 1: ON PK Fc 1000 Hz Gain -3 dB Q 1.4');
      await page.locator('.eqk-paste-apply').click();
      await settle();
      assert.deepEqual(await band(1), { on: true, type: 'peak', hz: 1000, db: -3, q: 1.4 });
      const d = await dbg();
      assert.deepEqual(d.model.bands.map((b) => b.k), [1], 'only the pasted band remains');
      assert.equal((await band(8)).type, 'off');
      near(await geo('curveAt', 1000), -3, 0.3);
      assert.equal(await page.locator('.eqk-paste-out li.applied').count(), 1);
      await shot('eq-paste.png');
    });

    await T('preset Warm sets the expected values; Wing channel = 6 bands; Copy as text', async () => {
      await page.locator('.eqk-preset[data-preset="Warm"]').click();
      await settle();
      const e = await eq();
      near(e.b1.hz, midiF(50), 1e-6);
      assert.deepEqual([e.b1.type, e.b1.db, e.b1.on], ['lowshelf', 3, true]);
      assert.deepEqual([e.b2.type, e.b2.hz, e.b2.db, e.b2.q], ['peak', 3000, -3, 0.9]);
      assert.deepEqual([e.b8.type, e.b8.hz, e.b8.db], ['highshelf', 8000, -2]);
      assert.equal(e.cutHz, 20);
      assert.deepEqual((await dbg()).model.bands.map((b) => b.k), [1, 2, 8]);
      await shot('eq-warm-1440.png', { fullPage: true });
      await page.locator('.eqk-copy').click();
      await sleep(80);
      const txt = (await dbg()).copyText;
      assert.match(txt, /Filter 2: ON PK Fc 3000 Hz Gain -3\.0 dB Q 0\.90/);
      const clip = await ev(() => navigator.clipboard.readText().catch(() => null));
      if (clip !== null) assert.equal(clip, txt);
      await page.locator('.eqk-preset[data-preset="Wing channel"]').click();
      await settle();
      assert.deepEqual((await dbg()).model.bands.map((b) => [b.k, b.type]),
        [[1, 'lowshelf'], [2, 'peak'], [3, 'peak'], [4, 'peak'], [5, 'peak'], [8, 'highshelf']]);
    });

    await T('A/B: B bypasses (not persisted past A), A restores exactly; an edit in B returns to A', async () => {
      await page.locator('.eqk-preset[data-preset="Warm"]').click();
      await settle();
      const before = await eq();
      const d0 = await dbg();
      await page.locator('.eqk-ab-b').click();
      await settle();
      let d = await dbg();
      assert.equal(d.ab, 'b');
      assert.equal(await page.locator('.eqk-ab-b').getAttribute('aria-pressed'), 'true');
      assert.deepEqual(d.model.bands.map((b) => b.db), d0.model.bands.map((b) => b.db), 'B still shows the EQ being compared');
      if (d.abMode === 'store') {
        const byp = await eq();
        assert.ok([1, 2, 8].every((k) => byp[`b${k}`].on === false), 'store compare: bands off while B');
      } else note(`A/B uses ${d.abMode}.eqAudition (not persisted)`);
      await page.locator('.eqk-ab-a').click();
      await settle();
      assert.deepEqual(await eq(), before, 'A restores exactly');
      assert.equal((await dbg()).ab, 'a');
      await page.locator('.eqk-plot').focus();
      await page.keyboard.press('b');
      await settle();
      assert.equal((await dbg()).ab, 'b', 'B key');
      await page.keyboard.press('2');
      await page.keyboard.press('ArrowUp');
      await settle();
      d = await dbg();
      assert.equal(d.ab, 'a', 'an edit leaves B');
      const e = await eq();
      assert.equal(e.b2.db, before.b2.db + 0.5);
      assert.ok(e.b1.on && e.b8.on, 'restored before the edit');
    });

    await T('engine curve (getEqResponse) agrees with the stored model; play range source', async () => {
      await sleep(600);
      const d = await dbg();
      if (caps.getEqResponse) {
        assert.equal(d.curveSource, 'engine');
        assert.ok(d.curveMismatch < 0.5, `engine vs local ${d.curveMismatch} dB`);
      } else assert.equal(d.curveSource, 'local');
      assert.equal(d.zone.source, caps.getSlotPlayRange ? 'engine' : 'slot');
      if (caps.getSlotPlayRange) assert.deepEqual([d.zone.lo, d.zone.hi], [48, 108]);
      if (!caps.getEqResponse) return;
      // every band type + both cuts: the engine's biquads and eq-math's RBJ must draw the same curve
      await page.locator('.eqk-paste-text').fill(['LSC 100 Hz +3 dB', 'PK 400 Hz -4 dB Q 2', 'NO 60 Hz Q 8', 'HP 50 Hz',
        'HPQ 35 Hz Q 1.2', 'LPQ 15000 Hz Q 0.9', 'HS 7000 Hz -2 dB', 'LP 16000 Hz'].join('\n'));
      await page.locator('.eqk-paste-apply').click();
      await sleep(700);
      const d2 = await dbg();
      assert.deepEqual(d2.model.bands.map((b) => b.type), ['lowshelf', 'lowcut', 'notch', 'peak', 'highcut', 'highshelf']);
      assert.deepEqual([(await eq()).cutHz, (await eq()).hiCutHz], [50, 16000]);
      assert.equal(d2.curveSource, 'engine');
      assert.ok(d2.curveMismatch < 0.5, `engine vs eq-math with every type: ${d2.curveMismatch} dB`);
      console.log(`    info engine.getEqResponse vs eq-math, every type + both cuts: max ${d2.curveMismatch.toExponential(2)} dB`);
    });

    await T('analyser behind the curve while notes play (screenshot)', async () => {
      await ev(async () => {
        const c = window.__rig.controller;
        for (const n of [50, 57, 62, 66, 69]) c.perform.noteOn(n, 100);
      });
      await sleep(700);
      await shot('eq-analyser-1440.png', { fullPage: true });
      const running = await ev(() => window.__rig.engine.ctx?.state);
      await ev(() => {
        const c = window.__rig.controller;
        for (const n of [50, 57, 62, 66, 69]) c.perform.noteOff(n);
      });
      if (running !== 'running') note(`audio context ${running}: analyser not drawn`);
    });

    await T('8 bands max: the 9th double-tap is refused, + Add disabled', async () => {
      await page.locator('.eqk-preset[data-preset="Wing channel"]').click();
      await settle();
      for (const m of [30, 96]) {
        await page.mouse.dblclick(await geo('xOfMidi', m), await geo('yOfDb', 9));
        await settle();
      }
      assert.equal((await dbg()).model.bands.length, 8);
      assert.equal(await page.locator('.eqk-add').isDisabled(), true);
      await page.mouse.dblclick(await geo('xOfMidi', 40), await geo('yOfDb', 11));
      await settle();
      assert.equal((await dbg()).model.bands.length, 8);
    });

    await T('1024×700: compact layout with 8 bands fits, no horizontal overflow (screenshot)', async () => {
      await page.setViewportSize({ width: 1024, height: 700 });
      await sleep(150);
      await settle();
      const m = await ev(() => {
        const el = window.__eq.comp.el;
        const r = el.getBoundingClientRect();
        const t = el.querySelector('.eqk-bands').getBoundingClientRect();
        return {
          h: r.height, w: r.width, top: r.top, sw: el.scrollWidth, cw: el.clientWidth, docW: document.documentElement.scrollWidth,
          compact: el.dataset.compact || null, tableRight: t.right, right: r.right,
          plotNodeR: window.__eq.comp.debug().nodes.length,
        };
      });
      assert.ok(m.compact, 'compact mode on at 1024');
      assert.ok(m.top + m.h <= 700, `fits in 700 px: top ${m.top} + ${m.h}`);
      console.log(`    info 1024×700 compact, 8 bands, paste box open: ${Math.round(m.h)} px tall, ${Math.round(m.w)} px wide`);
      assert.ok(m.sw <= m.cw + 1 && m.docW <= 1024, `no horizontal overflow (${m.sw}/${m.cw}, doc ${m.docW})`);
      assert.ok(m.tableRight <= m.right, 'table inside the card');
      await shot('eq-1024x700.png');
      // node hit targets stay ≥ 40 px: a click 19 px off-centre (above: empty space) still grabs node 1
      const n = await node(1);
      await page.mouse.click(n.x, n.y - 19);
      await settle();
      assert.equal((await dbg()).sel, 1);
      await page.setViewportSize({ width: 1440, height: 900 });
      await sleep(100);
    });

    await T('eqMiniCurve: hidden while flat, a sparkline once shaped, click opens; follows the store', async () => {
      const r = await ev(async () => {
        const { eqMiniCurve, params: { defaultSlot } } = window.__eq;
        const { store } = window.__rig;
        let opened = 0;
        store.set('slots.1', null);
        store.set('slots.1', defaultSlot(1, { type: 'sampler', id: 'salamander-piano' }));
        const m = eqMiniCurve({ store, slotIndex: 1, onOpen: () => opened++ });
        document.getElementById('host').append(m.el);
        const flat = m.el.hidden;
        store.set('slots.1.eq.b2.on', true);
        store.set('slots.1.eq.b2.type', 'peak');
        store.set('slots.1.eq.b2.hz', 1000);
        store.set('slots.1.eq.b2.db', 6);
        store.flush();
        const shaped = !m.el.hidden;
        const px = m.el.querySelector('canvas').getContext('2d').getImageData(0, 0, 240, 56).data;
        let lit = 0;
        for (let i = 3; i < px.length; i += 4) if (px[i] > 0) lit++;
        m.el.click();
        const label = m.el.getAttribute('aria-label');
        m.destroy();
        return { flat, shaped, lit, opened, label, attached: m.el.isConnected };
      });
      assert.equal(r.flat, true, 'hidden while flat');
      assert.equal(r.shaped, true, 'shown once a band does something');
      assert.ok(r.lit > 100, `drew something (${r.lit} px)`);
      assert.equal(r.opened, 1);
      assert.match(r.label, /Custom · 1 band/);
      assert.equal(r.attached, false);
    });

    await T('destroy() removes listeners, the store subscription and the frame loop; B is restored', async () => {
      await setupSlot(0, { lowNote: 48, highNote: 127 });
      await settle();
      await page.locator('.eqk-preset[data-preset="Air"]').click();
      await settle();
      const before = await eq();
      const g0 = await ev(() => ({ g: window.__listeners.global(), subs: window.__eq.subs() }));
      // a second instance, then destroy it while in B
      const r = await ev(async () => {
        const { eqKeyboard } = window.__eq;
        const { store, engine } = window.__rig;
        const c = eqKeyboard({ store, engine, slotIndex: 0 });
        document.getElementById('host').append(c.el);
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        const during = { g: window.__listeners.global(), subs: window.__eq.subs(), own: window.__listeners.on(c.el) };
        c.el.querySelector('.eqk-ab-b').click();
        const inB = JSON.parse(JSON.stringify(window.__eq.eq(0)));
        c.destroy();
        c.destroy(); // idempotent
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        return {
          during, inB, after: { g: window.__listeners.global(), subs: window.__eq.subs(), own: window.__listeners.on(c.el) },
          attached: c.el.isConnected, dbg: c.debug().destroyed, raf: c.debug().rafActive,
        };
      });
      assert.ok(r.during.subs === g0.subs + 1 && r.during.g > g0.g && r.during.own > 10, `instance listened (${JSON.stringify(r.during)})`);
      assert.equal(r.after.subs, g0.subs, 'store unsubscribed');
      assert.equal(r.after.g, g0.g, 'window/document/engine listeners removed');
      assert.equal(r.after.own, 0, 'element listeners removed');
      assert.equal(r.attached, false, 'el removed');
      assert.equal(r.raf, false, 'frame loop stopped');
      assert.deepEqual(await eq(), before, 'B restored on destroy');
    });

    await T('zero console errors, no HTTP ≥ 400', async () => {
      assert.deepEqual(errors, []);
      if (warns.length) note(`component warnings: ${[...new Set(warns)].join(' | ')}`);
    });
  } finally {
    await browser.close();
    await server.close();
  }
}

// ------------------------------------------------------------------------------------------------------------ main
const t0 = Date.now();
console.log('eq-ui suite');
if (!ONLY || ONLY === 'unit') runUnit();
if (!ONLY || ONLY === 'browser') await runBrowser();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed, ${notes.length} notes (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
if (failed.length) {
  console.log(`FAILED: ${failed.map((r) => r.name).join(' · ')}`);
  process.exit(1);
}
