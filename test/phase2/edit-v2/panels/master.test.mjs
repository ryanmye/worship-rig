// OWNER: master agent (views/edit/CONTRACT.md §6). Tests for panels/master.js (the Master tab + Wheels & pedal).
// Run alone: node test/phase2/edit-v2/run.mjs --only master
// (or node --test --test-reporter=spec <this file>).
// Ported from ui-edit: the lofi/master half of "FX: reverb / delay / chorus / lofi / master reach the engine", the
// routing half of "routing + drone controls write the song", and the fx.eq / fx.comp half of "new strip/master
// params render only when params.describe has them".
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mountPanelForTest, smoke, shutdown } from '../harness.mjs';

after(shutdown);

const MINUS6 = 10 ** (-6 / 20);
const rangeOf = (t, addr) => `${t.host} [data-bind="${addr}"] input[type=range]`;
const selectOf = (t, addr) => `${t.host} [data-bind="${addr}"] select`;
const sec = (t, id) => `${t.host} details[data-sec="${id}"]`;
const sumOf = (t, id) => t.page.textContent(`${sec(t, id)} > summary .ev2-sec-sum`);
const title = (t) => t.page.textContent('#view-edit .ev2-title .ev2-sent');
/** Open a lib.section by clicking its summary (only when closed). */
async function open(t, ...ids) {
  for (const id of ids) {
    if (!(await t.ev((s) => document.querySelector(s).open, sec(t, id)))) await t.click(`${sec(t, id)} > summary`);
    await t.until((s) => document.querySelector(s).open, sec(t, id));
  }
}
/** Which of the given PARAMS paths this build describes (hasParam). */
const described = (t, paths) => t.ev(async (ps) => {
  const { hasParam } = await import('/app/js/views/edit/lib.js');
  return Object.fromEntries(ps.map((p) => [p, hasParam(p)]));
}, paths);

test('master: harness smoke (mount, ctx fields, store → engine, no console errors)', async () => {
  const t = await mountPanelForTest('master');
  try {
    await smoke(t);
    await t.screenshot('master-1440');
  } finally {
    await t.close();
  }
});

test('master: title sentence, volume taper + reset, Tape / Tone / Glue reach the engine with summaries', async () => {
  const t = await mountPanelForTest('master');
  try {
    // a known starting point, whatever the first factory song carries
    for (const [a, v] of [['master.volume', MINUS6], ['fx.lofi.amount', 0], ['fx.eq.low', 0], ['fx.eq.mid', 0],
      ['fx.eq.high', 0], ['fx.comp.amount', 0]]) await t.setParam(a, v);
    const have = await described(t, ['fx.eq.low', 'fx.eq.mid', 'fx.eq.high', 'fx.comp.amount']);
    const tail = `${have['fx.eq.low'] ? ', tone flat' : ''}${have['fx.comp.amount'] ? ', glue off' : ''}`;
    await t.until((w) => document.querySelector('#view-edit .ev2-title .ev2-sent')?.textContent === w,
      `MASTER is at −6.0 dB, tape off${tail}`);
    // the sections exist only for described params (ui-edit "new strip/master params…")
    for (const p of Object.keys(have)) {
      assert.equal(await t.ev((s) => !!document.querySelector(s), `${t.host} [data-bind="${p}"]`), have[p], p);
    }
    assert.equal(!!(await t.page.$(sec(t, 'master-eq'))), have['fx.eq.low'] || have['fx.eq.mid'] || have['fx.eq.high']);
    assert.equal(!!(await t.page.$(sec(t, 'master-glue'))), have['fx.comp.amount']);

    // master volume: taper 2·pos³ → engine; double-click → −6 dB
    await t.setRange(rangeOf(t, 'master.volume'), 700);
    await t.until(() => Math.abs(window.__rig.engine.getParam('master.volume') - 2 * 0.7 ** 3) < 0.01);
    assert.match(await title(t), /^MASTER is at −3\.3 dB,/);
    await t.page.dblclick(rangeOf(t, 'master.volume'));
    await t.until((g) => Math.abs(window.__rig.store.currentSong().patch.fx.master.volume - g) < 1e-6, MINUS6);
    await t.untilEngine('master.volume', MINUS6, 1e-4);

    // Tape: amount + the details sub-section (ui-edit FX test: lofi 0.4, crackle 0.7)
    assert.equal(await sumOf(t, 'master-tape'), 'Off');
    await open(t, 'master-tape');
    await t.setRange(rangeOf(t, 'fx.lofi.amount'), 400);
    await t.untilEngine('fx.lofi.amount', 0.4, 0.002);
    assert.equal(await sumOf(t, 'master-tape'), '40%');
    assert.match(await title(t), /, tape 40%/);
    await open(t, 'master-tape-details');
    await t.setRange(rangeOf(t, 'fx.lofi.crackle'), 700);
    await t.untilEngine('fx.lofi.crackle', 0.7, 0.002);
    assert.match(await sumOf(t, 'master-tape-details'), /Crackle 70%/);
    await t.setRange(rangeOf(t, 'fx.lofi.amount'), 0);
    await t.untilEngine('fx.lofi.amount', 0, 1e-6);
    assert.equal(await sumOf(t, 'master-tape'), 'Off');

    if (have['fx.eq.low']) {
      await open(t, 'master-eq');
      await t.setRange(rangeOf(t, 'fx.eq.low'), 625); // −12..12 → +3 dB
      await t.until(() => Math.abs(window.__rig.store.currentSong().patch.fx.eq.low - 3) < 0.05);
      await t.untilEngine('fx.eq.low', 3, 0.05);
      assert.match(await sumOf(t, 'master-eq'), /Low \+3\.0 dB/);
      assert.equal(await t.page.textContent(`${t.host} [data-bind="fx.eq.low"] .ev2-ws-num`), '+3.0 dB');
      assert.match(await title(t), /, tone low \+3\.0 dB/);
      await t.page.dblclick(rangeOf(t, 'fx.eq.low'));
      await t.until(() => window.__rig.store.currentSong().patch.fx.eq.low === 0);
      assert.equal(await sumOf(t, 'master-eq'), 'Flat');
    }
    if (have['fx.comp.amount']) {
      await open(t, 'master-glue');
      await t.setRange(rangeOf(t, 'fx.comp.amount'), 500);
      await t.untilEngine('fx.comp.amount', 0.5, 0.002);
      assert.equal(await sumOf(t, 'master-glue'), '50%');
      assert.match(await title(t), /, glue 50%$/);
      await t.page.dblclick(rangeOf(t, 'fx.comp.amount'));
      await t.until(() => window.__rig.store.currentSong().patch.fx.comp.amount === 0);
      assert.equal(await sumOf(t, 'master-glue'), 'Off');
    }
    assert.ok((await t.playAndMeasure(64)) > -50, 'still sounds after the master edits');

    // a title token jumps to its control (opens its section, focuses, flashes)
    await t.ev(() => {
      for (const d of document.querySelectorAll('#view-edit details[data-sec="master-tape"]')) d.open = false;
    });
    await t.click('#view-edit .ev2-title .ev2-tok[title="Tape amount"]');
    await t.until((s) => document.querySelector(s).open, sec(t, 'master-tape'));
    await t.until(() => !!document.querySelector('#view-edit .ev2-flash [data-bind="fx.lofi.amount"], '
      + '#view-edit .ev2-flash[data-bind="fx.lofi.amount"]'));
    t.assertNoConsoleErrors();
  } finally {
    await t.close();
  }
});

test('master: Wheels & pedal write the song and the engine routing; swell counts as a change', async () => {
  const t = await mountPanelForTest('master');
  try {
    await open(t, 'master-wheels');
    // ui-edit "routing + drone controls write the song" (routing half)
    await t.page.selectOption(selectOf(t, 'song.patch.modWheel.target'), 'macro.wash');
    await t.until(() => window.__rig.store.currentSong().patch.modWheel.target === 'macro.wash'
      && window.__rig.engine._routing.modWheel.target === 'macro.wash');
    await t.page.selectOption(selectOf(t, 'song.patch.bend.mode'), 'tape');
    await t.until(() => window.__rig.engine._routing.bend.mode === 'tape');
    assert.match(await sumOf(t, 'master-wheels'), /Mod wheel: Wash · .*Bend: Tape stop \/ filter sweep/);

    // From / To (0–1, %) for the wheel and the pedal
    await t.setRange(rangeOf(t, 'song.patch.modWheel.min'), 250);
    await t.until(() => Math.abs(window.__rig.store.currentSong().patch.modWheel.min - 0.25) < 0.002);
    await t.setRange(rangeOf(t, 'song.patch.expression.max'), 800);
    await t.until(() => Math.abs(window.__rig.store.currentSong().patch.expression.max - 0.8) < 0.002);
    assert.equal(await t.page.textContent(`${t.host} [data-bind="song.patch.expression.max"] .ev2-ws-num`), '80%');
    // routed to Nothing → From/To are disabled
    await t.page.selectOption(selectOf(t, 'song.patch.expression.target'), 'none');
    await t.until(() => document.querySelector('[data-bind="song.patch.expression.min"] input').disabled);
    await t.page.selectOption(selectOf(t, 'song.patch.expression.target'), 'slots.1.gain');
    await t.until(() => !document.querySelector('[data-bind="song.patch.expression.min"] input').disabled
      && window.__rig.store.currentSong().patch.expression.target === 'slots.1.gain');
    await t.page.selectOption(selectOf(t, 'song.patch.volume.target'), 'drone.gain');
    await t.until(() => window.__rig.store.currentSong().patch.volume.target === 'drone.gain');

    // bend range stepper 0–24
    await t.setParam('song.patch.bend.range', 2);
    const step = `${t.host} [data-bind="song.patch.bend.range"]`;
    await t.until((s) => document.querySelector(`${s} .step-value`).textContent === '2 semitones', step);
    await t.click(`${step} .step-btn.inc`);
    await t.until(() => window.__rig.store.currentSong().patch.bend.range === 3);
    await t.setParam('song.patch.bend.range', 24);
    await t.until((s) => document.querySelector(`${s} .step-btn.inc`).disabled, step);

    // swell 1–60 s, log: the midpoint is √60 ≈ 7.7 s; the only watched path here → change line + dot
    const foot = `${t.host} .ev2-foot .ev2-chg`;
    assert.equal(await t.page.textContent(foot), 'No changes since the song was loaded');
    const s0 = (await t.song()).patch.swell.seconds;
    await t.setRange(rangeOf(t, 'song.patch.swell.seconds'), 500);
    await t.until(() => Math.abs(window.__rig.store.currentSong().patch.swell.seconds - Math.sqrt(60)) < 0.01);
    assert.equal(await t.page.textContent(`${t.host} [data-bind="song.patch.swell.seconds"] .ev2-ws-num`), '7.7 s');
    if (Math.abs(s0 - Math.sqrt(60)) > 1e-3) {
      await t.until((s) => /^1 change since the song was loaded$/.test(document.querySelector(s).textContent), foot);
      assert.equal(await t.ev((s) => document.querySelector(s).classList.contains('none'), foot), false);
      assert.equal(await t.ev(() =>
        document.querySelector('[data-bind="song.patch.swell.seconds"] .ev2-cdi').hidden), false);
    }
    await t.page.dblclick(rangeOf(t, 'song.patch.swell.seconds')); // → 8 s
    await t.until(() => window.__rig.store.currentSong().patch.swell.seconds === 8);
    await t.until(() => window.__rig.engine._routing.swell.seconds === 8);
    t.assertNoConsoleErrors();
  } finally {
    await t.close();
  }
});

test('master: focus wheels/tape on mount and in update(); values update in place; song switch; 1024 fits', async () => {
  const t = await mountPanelForTest('master', {
    panelOpts: { focus: 'wheels' }, viewport: { width: 1024, height: 700 },
  });
  try {
    // mount with {focus:'wheels'} (the rig bar's "Wheels & pedal" link): open, focused, in view
    await t.until((s) => {
      const d = document.querySelector(s);
      return d.open && d.contains(document.activeElement);
    }, sec(t, 'master-wheels'));
    assert.equal(await t.ev(() => document.activeElement.matches('[data-bind="song.patch.modWheel.target"] select')),
      true);
    await t.screenshot('master-1024-wheels');
    const r = await t.ev((host) => {
      const b = document.querySelector(host).closest('.ev2-body');
      const d = document.querySelector(`${host} details[data-sec="master-wheels"]`).getBoundingClientRect();
      const v = b.getBoundingClientRect();
      return {
        page: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        body: b.scrollWidth <= b.clientWidth,
        visible: d.top < v.bottom && d.bottom > v.top,
      };
    }, t.host);
    assert.deepEqual(r, { page: true, body: true, visible: true });

    // mark elements: update() and store changes must not rebuild them
    await t.ev((host) => {
      for (const s of ['[data-bind="fx.lofi.amount"] input', '[data-bind="song.patch.modWheel.target"] select']) {
        document.querySelector(`${host} ${s}`).dataset.mark = '1';
      }
    }, t.host);
    await t.select('master', { focus: 'tape' }); // the Effects footer's "Tape & finish" link
    await t.until((s) => {
      const d = document.querySelector(s);
      return d.open && d.contains(document.activeElement);
    }, sec(t, 'master-tape'));
    assert.equal(await t.ev(() => document.activeElement.dataset.mark), '1', 'update(), not a remount');

    await t.ev(() => document.activeElement.blur());
    await t.setParam('fx.lofi.amount', 0.25);
    await t.until((h) => document.querySelector(`${h} [data-bind="fx.lofi.amount"] input`).value === '250', t.host);
    await t.setParam('song.patch.modWheel.target', 'drone.gain');
    await t.until((h) => document.querySelector(`${h} [data-bind="song.patch.modWheel.target"] select`).value
      === 'drone.gain', t.host);
    assert.equal(await t.ev((h) => document.querySelectorAll(`${h} [data-mark="1"]`).length, t.host), 2);

    // song switch: same elements, the new song's values
    const other = await t.ev(() => {
      const st = window.__rig.store;
      return st.get().songOrder.find((x) => x !== st.currentSong().id);
    });
    await t.selectSong(other);
    const want = await t.ev(() => {
      const p = window.__rig.store.currentSong().patch;
      return { lofi: p.fx.lofi.amount, wheel: p.modWheel.target };
    });
    await t.until(([h, w]) => {
      const s = document.querySelector(`${h} [data-bind="song.patch.modWheel.target"] select`);
      const l = document.querySelector(`${h} [data-bind="fx.lofi.amount"] input`);
      return s.value === w.wheel && Math.abs(Number(l.value) - Math.round(w.lofi * 1000)) <= 1;
    }, [t.host, want]);
    assert.equal(await t.ev((h) => document.querySelectorAll(`${h} [data-mark="1"]`).length, t.host), 2);
    const vol = await t.ev(async () => {
      const { formatValue } = await import('/app/js/shared/params.js');
      return formatValue('master.volume', window.__rig.store.currentSong().patch.fx.master.volume);
    });
    assert.match(await title(t), new RegExp(`^MASTER is at ${vol.replace(/[+.]/g, '\\$&')}, tape `));

    // footer link → Effects
    const sel = await t.ev(() => new Promise((res) => {
      window.__rig.view.editState.addEventListener('select', (e) => res(e.detail.id), { once: true });
      document.querySelector('#view-edit [data-goto="effects"]').click();
    }));
    assert.equal(sel, 'effects');
    t.assertNoConsoleErrors();
  } finally {
    await t.close();
  }
});
