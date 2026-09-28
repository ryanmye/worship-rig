// OWNER: drone+bottom agent (views/edit/CONTRACT.md §6). Tests for panels/bottom.js.
// Run alone: node test/phase2/edit-v2/run.mjs --only bottom
// (or node --test --test-reporter=spec <this file>).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mountPanelForTest, smoke, shutdown } from '../harness.mjs';

// The whole file shares node --test's 240 s budget (run.mjs --test-timeout applies to the file's own test too), so
// the 1440 tests share one mount (the keyboard test destroys the view, so it runs last on it) and the 1024 test gets
// the second.
let shared = null;
const mountA = async () => (shared ??= await mountPanelForTest('bottom', { song: SONG }));
after(async () => {
  await shared?.close();
  await shutdown();
});

const SONG = 'Sunday Pad + Piano'; // Keys + Pad
const noOverflow = (t) => t.ev((host) => {
  const bad = [];
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth) bad.push(`page ${de.scrollWidth} > ${de.clientWidth}`);
  for (const e of document.querySelectorAll(`${host}, ${host} *`)) {
    if (getComputedStyle(e).overflowX === 'visible') continue;
    if (e.scrollWidth > e.clientWidth + 1) bad.push(`${e.className} ${e.scrollWidth} > ${e.clientWidth}`);
  }
  return bad;
}, t.host);

test('bottom: harness smoke (mount, ctx fields, store → engine, no console errors)', async () => {
  const t = await mountA();
  await smoke(t);
  await t.screenshot('bottom-1440');
  const cols = await t.ev((host) => getComputedStyle(document.querySelector(`${host} .ev2-kb`))
    .gridTemplateColumns.split(' ').length, t.host);
  assert.equal(cols, 5);
  assert.deepEqual(await noOverflow(t), []);
});

test('bottom: legend + range bars follow the slots (range, muted, selected, empty)', async () => {
  const t = await mountA();
  const rows = () => t.ev((h) => [...document.querySelectorAll(`${h} .ev2-kb-lrow`)].map((r) => ({
    slot: r.dataset.slot, text: r.textContent, muted: r.classList.contains('muted'), dim: r.classList.contains('dim'),
  })), t.host);
  const bar = (i) => t.ev(([h, s]) => {
    const e = document.querySelector(`${h} .ev2-kb-bar[data-slot="${s}"]`);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    const k = document.querySelector(`${h} .ev2-kb-keys`).getBoundingClientRect();
    return {
      cls: [...e.classList].filter((c) => c !== 'ev2-kb-bar').sort(), l: (r.left - k.left) / k.width,
      w: r.width / k.width, top: r.top, opacity: Number(getComputedStyle(e).opacity),
    };
  }, [t.host, i]);
  let r = await rows();
  assert.deepEqual(r.map((x) => [x.slot, x.text]), [['0', 'Keysall'], ['1', 'Padall']]);
  // the harness selects slot:0 by default → the other sounds step back (mockup)
  assert.deepEqual(r.map((x) => x.dim), [false, true]);
  const b0 = await bar(0);
  assert.deepEqual(b0.cls, ['open-l', 'open-r']);
  assert.ok(Math.abs(b0.l) < 0.005 && Math.abs(b0.w - 1) < 0.005, JSON.stringify(b0));
  // add a Bass to B3 → a third row "to B3", open on the left only, ending at the right edge of B3
  // (the store fills the Bass role defaults from the instrument ref: normalizeSlot → defaultSlot(3, ref))
  assert.equal(await t.setParam('slots.3', { instrument: { type: 'synth', id: 'sub-bass' } }), true);
  // (the Bass role default is already 0..59; a same-value set returns false, so these are not asserted)
  await t.setParam('slots.3.lowNote', 0);
  await t.setParam('slots.3.highNote', 59);
  await t.until((h) => document.querySelectorAll(`${h} .ev2-kb-lrow`).length === 3, t.host);
  r = await rows();
  assert.equal(r[2].text, 'Bassto B3');
  const b3 = await bar(3);
  assert.deepEqual(b3.cls.filter((c) => c.startsWith('open')), ['open-l']);
  // B3 is the 14th white key of 36 (C2..C7): right edge = 14/36
  assert.ok(Math.abs(b3.w - 14 / 36) < 0.01, `bass bar width ${b3.w}`);
  assert.ok(b3.top > (await bar(1)).top, 'one row per slot');
  // C3..C5 → "C3 to C5", closed ends
  await t.setParam('slots.3.lowNote', 48);
  await t.setParam('slots.3.highNote', 72);
  await t.until((h) => /C3 to C5/.test(document.querySelector(`${h} .ev2-kb-lrow[data-slot="3"]`).textContent),
    t.host);
  assert.deepEqual((await bar(3)).cls.filter((c) => c.startsWith('open')), []);
  // muted → dimmed grey row + bar
  await t.setParam('slots.1.muted', true);
  await t.until((h) => document.querySelector(`${h} .ev2-kb-lrow[data-slot="1"]`).classList.contains('muted'),
    t.host);
  assert.ok((await bar(1)).cls.includes('muted'));
  assert.ok((await bar(1)).opacity < 0.5);
  await t.setParam('slots.1.muted', false);
  await t.until((h) => !document.querySelector(`${h} .ev2-kb-bar[data-slot="1"]`).classList.contains('muted'),
    t.host);
  // selecting another sound moves the emphasis; a shared block un-dims everything
  await t.select('slot:1');
  r = await rows();
  assert.deepEqual(r.map((x) => x.dim), [true, false, true]);
  await t.select('effects');
  r = await rows();
  assert.deepEqual(r.map((x) => x.dim), [false, false, false]);
  // clearing a slot drops its row and bar; a gain move never rebuilds (display-only, keyed on what it shows)
  await t.ev((h) => {
    document.querySelector(`${h} .ev2-kb-lrow[data-slot="0"]`).dataset.mark = 'kept';
  }, t.host);
  await t.setParam('slots.0.gain', 0.5);
  await t.sleep(100);
  assert.equal(await t.page.getAttribute(`${t.host} .ev2-kb-lrow[data-slot="0"]`, 'data-mark'), 'kept');
  await t.setParam('slots.3', null);
  await t.until((h) => document.querySelectorAll(`${h} .ev2-kb-bar`).length === 2, t.host);
  // song switch → the new song's slots
  await t.selectSong('Grand Piano');
  await t.until((h) => document.querySelectorAll(`${h} .ev2-kb-lrow`).length
    === window.__rig.store.currentSong().patch.slots.filter(Boolean).length, t.host);
  t.assertNoConsoleErrors();
});

test('bottom: PANIC "⌘ ." ≥ 4.5:1 at rest and on hover, at 1440 and 1024 (polish-2A request, ux-round2 #6)',
  async () => {
    const t = await mountA();
    const sel = `${t.host} [data-action="panic"] small`;
    // WCAG 2.x: the label's colour × its cumulative opacity, over the button's own background (opaque #d9363a)
    const ratio = () => t.ev((s) => {
      const el = document.querySelector(s);
      const rgb = (c) => (/rgba?\(([^)]+)\)/.exec(c)[1]).split(/[ ,/]+/).filter(Boolean).map(Number);
      const lum = ([r, g, b]) => [r, g, b].map((v) => {
        const u = v / 255;
        return u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
      }).reduce((a, x, i) => a + x * [0.2126, 0.7152, 0.0722][i], 0);
      const btn = el.closest('button');
      const bg = rgb(getComputedStyle(btn).backgroundColor);
      const fg = rgb(getComputedStyle(el).color);
      let op = fg.length > 3 ? fg[3] : 1;
      for (let e = el; e && e !== btn.parentElement; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
      const mix = [0, 1, 2].map((i) => fg[i] * op + bg[i] * (1 - op));
      const [a, b] = [lum(mix), lum(bg)].sort((x, y) => y - x);
      return { ratio: (a + 0.05) / (b + 0.05), px: parseFloat(getComputedStyle(el).fontSize), bgA: bg[3] ?? 1,
        text: el.textContent };
    }, sel);
    const vp0 = t.page.viewportSize();
    try {
      for (const w of [1440, 1024]) {
        await t.page.setViewportSize({ width: w, height: w === 1024 ? 700 : 860 });
        await t.page.mouse.move(2, 2);
        const rest = await ratio();
        assert.equal(rest.text, '⌘ .');
        assert.equal(rest.bgA, 1, 'the button background is opaque (no ancestor compositing needed)');
        assert.ok(rest.ratio >= 4.5, `"⌘ ." at rest ${rest.ratio.toFixed(2)}:1 at ${w}`);
        assert.ok(rest.px >= 12, `"⌘ ." is ${rest.px}px at ${w}`);
        await t.page.hover(`${t.host} [data-action="panic"]`);
        const hov = await ratio();
        await t.sleep(250); // past any background transition
        const hov2 = await ratio();
        assert.ok(hov2.ratio > rest.ratio + 0.5,
          `hover darkens to #c42f33, never lightens (${hov2.ratio.toFixed(2)} vs ${rest.ratio.toFixed(2)})`);
        assert.ok(hov.ratio >= 4.5 && hov2.ratio >= 4.5, `"⌘ ." on hover ${hov2.ratio.toFixed(2)}:1 at ${w}`);
      }
    } finally {
      await t.page.mouse.move(2, 2);
      if (vp0) await t.page.setViewportSize(vp0);
    }
    t.assertNoConsoleErrors();
  });

test('bottom: on-screen keyboard plays through controller.perform (ui-edit port) + releaseAll on destroy',
  async () => {
  const t = await mountA();
    const keys = await t.page.locator(`${t.host} [data-note]`).count();
    assert.equal(keys, 61, '61 keys, C2..C7');
    const key = t.page.locator(`${t.host} [data-note="67"]`).first();
    const b = await key.boundingBox();
    await t.page.mouse.move(b.x + b.width / 2, b.y + b.height * 0.8);
    await t.page.mouse.down();
    await t.until(() => window.__rig.controller._debug().held.some(([n]) => n === 67));
    await t.until((h) => document.querySelector(`${h} [data-note="67"]`).classList.contains('held'), t.host);
    await t.page.mouse.up();
    await t.until(() => !window.__rig.controller._debug().held.some(([n]) => n === 67));
    await t.until((h) => !document.querySelector(`${h} [data-note="67"]`).classList.contains('held'), t.host);
    // a note held from elsewhere (MIDI path → controller 'notes') lights the key too
    await t.ev(() => window.__rig.controller.perform.noteOn(60, 90));
    await t.until((h) => document.querySelector(`${h} [data-note="60"]`).classList.contains('held'), t.host);
    await t.ev(() => window.__rig.controller.perform.noteOff(60));
    // a key still down when the row goes away is released (controller.perform.releaseAll)
    const k2 = await t.page.locator(`${t.host} [data-note="72"]`).first().boundingBox();
    await t.page.mouse.move(k2.x + k2.width / 2, k2.y + k2.height * 0.8);
    await t.page.mouse.down();
    await t.until(() => window.__rig.controller._debug().held.some(([n]) => n === 72));
    await t.ev(() => window.__rig.view.destroy());
    await t.until(() => !window.__rig.controller._debug().held.some(([n]) => n === 72));
    await t.page.mouse.up();
    t.assertNoConsoleErrors();
  });

test('bottom: Fade out → controller.fadeOutAll, PANIC (⌘ .) → controller.panic; meter; 1024 layout', async () => {
  const t = await mountPanelForTest('bottom', { song: SONG, viewport: { width: 1024, height: 700 } });
  try {
    await t.ev(() => {
      window.__acts = [];
      window.__rig.controller.addEventListener('action', (e) => window.__acts.push(e.detail.type));
    });
    await t.click(`${t.host} [data-action="fade-out"]`);
    await t.until(() => window.__acts.includes('fadeOutAll'));
    const panic = `${t.host} [data-action="panic"]`;
    assert.match(await t.page.textContent(panic), /PANIC\s*⌘ \./);
    await t.ev(() => window.__rig.controller.perform.noteOn(64, 100));
    await t.until(() => window.__rig.controller._debug().held.length > 0);
    await t.click(panic);
    await t.until(() => window.__acts.includes('panic') && window.__rig.controller._debug().held.length === 0);
    // output meter (ui-core meter: role=meter, two bars)
    assert.equal(await t.page.locator(`${t.host} .ev2-kb-meter [role="meter"] .meter-bar`).count(), 2);
    // ≤ 1250 px: 1fr 70px 84px 92px, no legend, no meter caption
    const lay = await t.ev((host) => {
      const g = getComputedStyle(document.querySelector(`${host} .ev2-kb`)).gridTemplateColumns.split(' ');
      return {
        cols: g.slice(1),
        legend: getComputedStyle(document.querySelector(`${host} .ev2-kb-leg`)).display,
        cap: getComputedStyle(document.querySelector(`${host} .ev2-kb-meter .ev2-cap`)).display,
        keysH: document.querySelector(`${host} .ev2-kb-keys`).getBoundingClientRect().height,
      };
    }, t.host);
    assert.deepEqual(lay.cols, ['70px', '84px', '92px']);
    assert.equal(lay.legend, 'none');
    assert.equal(lay.cap, 'none');
    assert.ok(lay.keysH >= 28, `keys stay playable at 1024 (${lay.keysH}px)`);
    await t.screenshot('bottom-1024');
    assert.deepEqual(await noOverflow(t), []);
    t.assertNoConsoleErrors();
  } finally {
    await t.close();
  }
});
