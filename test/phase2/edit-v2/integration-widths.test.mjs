// OWNER: polish-2B (reviews/ux-round2.md #4, #5, L1, §5 Edit rows). The H-v2 Edit inside the REAL app at the window
// sizes between the two designed breakpoints — 1280×800, 1366×768, 1440×860 (a 1440×900 Mac window after the menu
// bar) — plus 1024×700 and 1512×900 on either side:
//   - every tab (and Keys › Advanced › Tone, Show wiring): no horizontal overflow, no ellipsized or clipped text;
//   - Effects: the 7 Space chips ("Song's own" included) and the Echo chips keep whole words at every width;
//   - naming: one vocabulary — no visible text (or option / title / aria-label) matches
//     /\bCustom\b|Reverb level|the Space\b/ over every tab, the Vibe menu, wiring, Wheels & pedal and Tone;
//   - contrast (WCAG 2.x, the ux-round2 §5 method) of the tab labels and the bottom bar (PANIC "⌘ .", legend), and
//     ≥ 44 px Fade out / PANIC and tabs at every width;
//   - the Tone EQ in the slot panel: table and graph inside the card, compact per the re-tuned rule, key-strip
//     captions that fit.
// Screenshots → screenshots/widths-<w>-<what>.png. Own server and one page for the file, tests in order.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { chromium } from 'playwright';
import { ROOT, SHOTS } from './harness.mjs';
import { MIDI_PERMISSIONS, waitRigReady } from '../../integration/lib.mjs';

const require = createRequire(import.meta.url);
const { createServer } = require(path.join(ROOT, 'server.js'));
const VERBOSE = !!process.env.VERBOSE;

/** [width, height, label] — the review's sizes (ux-round2 §1, L1). */
const SIZES = [[1024, 700], [1280, 800], [1366, 768], [1440, 860], [1512, 900]];
const TABS = ['slot:0', 'slot:1', 'slot:2', 'slot:3', 'drone', 'effects', 'master', 'song'];
/** ux-round2 #5: the words that must never be on screen in Edit. */
const BANNED = /\bCustom\b|Reverb level|the Space\b/;

let server;
let browser;
let context;
let page;
let samplesDir;
const errors = [];
const ev = (fn, arg) => page.evaluate(fn, arg);
const until = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const selectBlock = (id, opts) => ev(([i, o]) => window.__rig.views.edit.editState.select(i, o || {}), [id, opts]);
const info = (msg) => console.log(`    info ${msg}`);

async function shot(name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await ev(() => {
    for (const x of document.querySelectorAll('#toasts > *')) x.remove();
    document.activeElement?.blur?.();
  });
  await sleep(200);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}
async function size(w, h) {
  await page.setViewportSize({ width: w, height: h });
  await sleep(350); // ResizeObservers (tab fit, EQ) run on the next frames
}

/**
 * In-page layout audit of #view-edit: horizontal overflow, ellipsized text, text clipped by an overflow:hidden box.
 * Vertical scrolling inside the panel body is allowed (it is the design); a clipped text box is not.
 */
const layoutAudit = () => ev(() => {
  const root = document.querySelector('#view-edit');
  const shown = (e) => {
    const r = e.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1 && !e.closest('[hidden]') && getComputedStyle(e).visibility !== 'hidden';
  };
  const bad = [];
  if (document.documentElement.scrollWidth > innerWidth + 1) bad.push(`page ${document.documentElement.scrollWidth}`);
  for (const e of root.querySelectorAll('*')) {
    if (!shown(e) || e.tagName === 'CANVAS' || e.tagName === 'TEXTAREA') continue;
    const cs = getComputedStyle(e);
    const txt = (e.textContent || '').trim().slice(0, 40);
    const tag = `${e.tagName.toLowerCase()}.${[...e.classList].join('.')} "${txt}"`;
    const wide = e.scrollWidth > e.clientWidth + 1;
    if (cs.textOverflow === 'ellipsis' && wide && txt) bad.push(`ellipsis ${tag} ${e.scrollWidth}>${e.clientWidth}`);
    else if (/hidden|clip/.test(cs.overflowX) && wide && !e.children.length && txt) {
      bad.push(`clipped-x ${tag} ${e.scrollWidth}>${e.clientWidth}`);
    }
    if (/auto|scroll/.test(cs.overflowX) && wide) bad.push(`h-scroll ${tag} ${e.scrollWidth}>${e.clientWidth}`);
    // a text box cut at the bottom (the 1280 header hint was 4 lines in a 56 px box); line clamps are ellipses
    if (/hidden|clip/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 2 && txt && e.children.length <= 2
      && !/-webkit-box/.test(cs.display) && !/\bev2-(rig|left|bottom|body|panel)\b/.test(e.className)) {
      bad.push(`clipped-y ${tag} ${e.scrollHeight}>${e.clientHeight}`);
    }
    if (/-webkit-box/.test(cs.display) && e.scrollHeight > e.clientHeight + 2 && txt) {
      bad.push(`line-clamped ${tag} ${e.scrollHeight}>${e.clientHeight}`);
    }
  }
  const body = root.querySelector('.ev2-body');
  return { bad, body: body ? [body.scrollHeight, body.clientHeight] : null };
});

/** Every user-visible string in #view-edit: text nodes, <option>s, titles, aria-labels, placeholders. */
const visibleStrings = () => ev(() => {
  const root = document.querySelector('#view-edit');
  const out = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const p = n.parentElement;
    const t = n.textContent.trim();
    if (!t || !p || p.closest('[hidden]') || p.closest('script, style')) continue;
    const r = p.getBoundingClientRect();
    if ((r.width >= 1 && r.height >= 1) || p.closest('option')) out.push(t);
  }
  for (const e of root.querySelectorAll('[title], [aria-label], [placeholder]')) {
    if (e.closest('[hidden]')) continue;
    for (const a of ['title', 'aria-label', 'placeholder']) if (e.getAttribute(a)) out.push(`@${a} ${e.getAttribute(a)}`);
  }
  return out;
});

/** WCAG 2.x contrast of every visible text run under `sel` (ux-round2 §5: colour composited over the ancestors'
 *  backgrounds with the cumulative opacity; a gradient counts as its first stop). */
const contrast = (sel) => ev((s) => {
  const parse = (c) => {
    const x = /color\(srgb ([^)]+)\)/.exec(c || '');
    if (x) {
      const p = x[1].split(/[ /]+/).filter(Boolean).map(Number);
      return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1];
    }
    const m = /rgba?\(([^)]+)\)/.exec(c || '');
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const over = (top, bot) => {
    const a = top[3] + bot[3] * (1 - top[3]);
    return a ? [0, 1, 2].map((i) => (top[i] * top[3] + bot[i] * bot[3] * (1 - top[3])) / a).concat(a) : [0, 0, 0, 0];
  };
  const lum = (c) => {
    const f = (v) => {
      const u = v / 255;
      return u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const bgOf = (el) => {
    const chain = [];
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) chain.unshift(e);
    let bg = [11, 13, 16, 1];
    for (const e of chain) {
      const cs = getComputedStyle(e);
      const c = (/gradient\(/.test(cs.backgroundImage) && parse(cs.backgroundImage)) || parse(cs.backgroundColor);
      if (c && c[3] > 0) bg = over(c, bg);
    }
    return bg;
  };
  const out = [];
  const w = document.createTreeWalker(document.querySelector(s), NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const t = n.textContent.trim();
    const el = n.parentElement;
    if (!t || !el || el.closest('[hidden]')) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || cs.visibility === 'hidden') continue;
    let op = 1;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
    const fg = parse(cs.color);
    if (!fg || op < 0.02) continue;
    const bg = bgOf(el);
    const c = over([fg[0], fg[1], fg[2], fg[3] * op], bg);
    const ratio = (Math.max(lum(c), lum(bg)) + 0.05) / (Math.min(lum(c), lum(bg)) + 0.05);
    const px = parseFloat(cs.fontSize);
    const large = px >= 24 || (Number(cs.fontWeight) >= 700 && px >= 18.66);
    const ctl = el.closest('button, input, select');
    out.push({ t: t.slice(0, 30), ratio: Math.round(ratio * 100) / 100, need: large ? 3 : 4.5, px,
      disabled: !!(ctl && ctl.disabled), where: `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}` });
  }
  return out;
}, sel);

before(async () => {
  samplesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-edit-v2-widths-samples-'));
  server = createServer({ appDir: path.join(ROOT, 'app'), port: 0, userSamples: [samplesDir] });
  const { port } = await server.listen();
  const origin = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(MIDI_PERMISSIONS, { origin });
  page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${m.text()} @ ${m.location()?.url || '?'}`);
    else if (VERBOSE) console.log(`   [page ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${origin}/`, { timeout: 30000 });
  await waitRigReady(page, { timeout: 30000, what: 'edit-v2 widths: __rig.ready' });
  await ev(() => window.__rig.viewsReady);
  const overlay = await page.$('#overlay-start:not([hidden])');
  if (overlay) await overlay.click();
  // the review's song: Keys + Pad, a room and an echo that match no preset (Song's own), chorus on the Pad
  const id = await ev(() => {
    const st = window.__rig.store.get();
    return st.songOrder.find((k) => st.songs[k].factoryId === 'factory:sunday-pad-piano');
  });
  await ev((i) => window.__rig.controller.selectSong(i), id);
  await until((i) => window.__rig.controller.status.songId === i && !window.__rig.controller.status.loading, id, 60000);
  await page.click('#view-switch button[data-value="edit"]');
  await until(() => !document.getElementById('view-edit').hidden && !!document.querySelector('#view-edit .ev2'));
});
after(async () => {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  await server?.close?.();
  if (samplesDir) fs.rmSync(samplesDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------
test('widths: every tab at 1024 / 1280 / 1366 / 1440×860 / 1512 — no overflow, no ellipsized or clipped text',
  async () => {
    const report = [];
    for (const [w, h] of SIZES) {
      await size(w, h);
      for (const tab of TABS) {
        await selectBlock(tab);
        await sleep(250);
        const a = await layoutAudit();
        assert.deepEqual(a.bad, [], `${w}×${h} ${tab}`);
        report.push(`${tab} ${a.body ? `${a.body[0]}/${a.body[1]}` : ''}`);
        if (tab === 'slot:0' || tab === 'effects') await shot(`widths-${w}-${tab.replace(':', '')}`);
      }
      // tab summaries: a tab that can't fit its sub drops it (never "Custom · ec…"); the full text is its title
      const tabs = await ev(() => [...document.querySelectorAll('#view-edit .ev2-tab')].map((t) => ({
        id: t.dataset.block, nosub: t.classList.contains('nosub'), title: t.title,
        fits: t.querySelector('.ev2-tab-name').scrollWidth <= t.querySelector('.ev2-tab-name').clientWidth + 1,
      })));
      for (const t of tabs) assert.ok(t.fits, `${w}: tab ${t.id} fits (${t.title})`);
      info(`${w}×${h} body scroll/height: ${report.splice(0).join(' · ')}; sub dropped on ${
        tabs.filter((t) => t.nosub).map((t) => t.id).join(', ') || 'none'}`);
    }
    // the header's live hint: shown only where it fits in its row (hidden < 1341 px; LIVE's title has the text)
    for (const [w, h, want] of [[1280, 800, false], [1366, 768, true], [1440, 860, true]]) {
      await size(w, h);
      const hint = await ev(() => {
        const e = document.querySelector('#view-edit .ev2-song-livehint');
        return { shown: e.getBoundingClientRect().width > 0, cut: e.scrollHeight > e.clientHeight + 2,
          title: document.querySelector('#view-edit .ev2-song-live').title };
      });
      assert.equal(hint.shown, want, `live hint at ${w}`);
      assert.equal(hint.cut, false, `live hint not cut at ${w}`);
      assert.match(hint.title, /Changes are heard now/);
    }
    // Show wiring (lane labels) and Keys › Advanced (+ Tone) at every width
    await selectBlock('slot:0');
    await page.click('#view-edit .ev2-wiretog');
    await until(() => !document.querySelector('#view-edit .ev2-wire').hidden);
    for (const [w, h] of SIZES) {
      await size(w, h);
      assert.deepEqual((await layoutAudit()).bad, [], `${w}×${h} wiring`);
      if (w === 1280) await shot('widths-1280-wiring');
    }
    await page.click('#view-edit .ev2-wiretog');
    await until(() => document.querySelector('#view-edit .ev2-wire').hidden);
    assert.deepEqual(errors, []);
  });

test('widths: Effects preset chips keep whole words at every width ("Song’s own" included; ux-round2 #4)',
  async () => {
    await selectBlock('effects');
    for (const [w, h] of SIZES) {
      await size(w, h);
      const r = await ev(() => [...document.querySelectorAll('#view-edit .ev2-fx-pchips')].map((row) => {
        const chips = [...row.children].filter((c) => !c.hidden);
        const rr = row.getBoundingClientRect();
        return {
          kind: row.dataset.preset,
          names: chips.map((c) => c.querySelector('.ev2-fx-pc-name').textContent),
          cut: chips.flatMap((c) => [...c.querySelectorAll('.ev2-fx-pc-name, .ev2-fx-pc-hint')])
            .filter((s) => s.scrollWidth > s.clientWidth + 0.5).map((s) => s.textContent),
          rows: new Set(chips.map((c) => Math.round(c.getBoundingClientRect().top))).size,
          inside: chips.every((c) => {
            const cr = c.getBoundingClientRect();
            return cr.left >= rr.left - 1 && cr.right <= rr.right + 1;
          }),
          minW: Math.round(Math.min(...chips.map((c) => c.getBoundingClientRect().width))),
          minH: Math.round(Math.min(...chips.map((c) => c.getBoundingClientRect().height))),
          width: Math.round(rr.width),
        };
      }));
      const space = r.find((x) => x.kind === 'space');
      const echo = r.find((x) => x.kind === 'echo');
      assert.equal(space.names.length, 7, `7 Space chips at ${w}: ${space.names}`);
      assert.ok(space.names.includes('Song’s own'));
      for (const x of r) {
        assert.deepEqual(x.cut, [], `${x.kind} chips at ${w}×${h}: whole words`);
        assert.ok(x.inside, `${x.kind} chips inside their column at ${w}`);
        assert.ok(x.rows <= 3, `${x.kind}: at most 3 rows at ${w} (${x.rows})`);
        assert.ok(x.minH >= 36, `${x.kind} chips ≥ 36 px tall at ${w} (${x.minH})`);
      }
      if (w >= 1366) assert.equal(space.rows, 1, `one Space row at ${w}`);
      // a who-goes-in step panel (the lowest line, the tightest case) holds all five steps at every width
      await page.click('#view-edit [data-line="chorus"] [data-bind="slots.1.sends.chorus"]');
      await until(() => !!document.querySelector('#view-edit .ev2-fx-sphost .step-panel'));
      const sp = await ev(() => {
        const pe = document.querySelector('#view-edit .ev2-fx-sphost .step-panel');
        const p = pe.getBoundingClientRect();
        const out = [...pe.querySelectorAll('*')].map((k) => k.getBoundingClientRect())
          .filter((k) => k.height > 0 && (k.top < p.top - 1 || k.bottom > p.bottom + 1)).length;
        return { dir: pe.dataset.dir, h: Math.round(p.height), out };
      });
      assert.equal(sp.out, 0, `${w}: chorus step panel (${sp.dir}, ${sp.h} px) holds its steps`);
      await page.keyboard.press('Escape');
      await until(() => !document.querySelector('#view-edit .ev2-fx-sphost .step-panel'));
      info(`${w}×${h}: Space ${space.rows} row(s) in ${space.width} px (narrowest chip ${space.minW} px, ${
        space.minH} px tall), Echo ${echo.rows} row(s); chorus step panel ${sp.dir} ${sp.h} px`);
    }
    await shot('widths-1280-effects-chips');
  });

test('naming: no visible Edit text says "Custom", "Reverb level" or "the Space" (ux-round2 #5)', async () => {
  await size(1440, 900);
  const hits = [];
  const check = async (where) => {
    for (const s of await visibleStrings()) if (BANNED.test(s)) hits.push(`${where}: ${s}`);
  };
  // a shaped Tone EQ on Keys (its summary said "Custom · n bands") and the song's own room/echo (Sunday Pad + Piano)
  await ev(() => {
    const { store } = window.__rig;
    for (const [k, v] of [['type', 'peak'], ['hz', 1000], ['db', 4], ['q', 1.2], ['on', true]]) {
      store.set(`slots.0.eq.b2.${k}`, v);
    }
    store.flush?.();
  });
  for (const tab of TABS) {
    await selectBlock(tab);
    await sleep(200);
    await ev(() => {
      for (const d of document.querySelectorAll('#view-edit details')) d.open = true; // every section (Tone mounts)
    });
    await sleep(300);
    await check(tab);
  }
  // a tweaked room (no preset, not the song's own either), the Vibe menu, the wiring strip, a step panel's hint
  await selectBlock('effects');
  await ev(() => window.__rig.store.set(`songs.${window.__rig.store.currentSong().id}.patch.fx.reverb.size`, 0.33));
  await sleep(150);
  await check('effects (tweaked room)');
  const tabText = await ev(() => document.querySelector('#view-edit .ev2-tab[data-block="effects"]').textContent);
  assert.match(tabText, /Song’s own/, 'the Effects tab calls a room with no preset "Song’s own"');
  await page.click('#view-edit .ev2-fx-vibe-btn');
  await until(() => !document.querySelector('#view-edit .ev2-fx-vibe-menu').hidden);
  await check('vibe menu');
  assert.equal(await ev(() => document.querySelector('#view-edit .ev2-fx-vibe-btn').textContent), 'Vibe: your own mix');
  await page.keyboard.press('Escape');
  await page.click('#view-edit [data-line="reverb"] [data-bind="slots.0.sends.reverb"]');
  await until(() => !!document.querySelector('#view-edit .ev2-fx-sphost .step-panel'));
  await check('Space step panel');
  assert.equal(await ev(() => document.querySelector('#view-edit .ev2-fx-sphost .sp-hint').textContent),
    'how much of the Keys goes into the song’s own Space');
  await page.keyboard.press('Escape');
  await until(() => !document.querySelector('#view-edit .ev2-fx-sphost .step-panel'));
  await page.click('#view-edit .ev2-wiretog');
  await until(() => !document.querySelector('#view-edit .ev2-wire').hidden);
  await check('wiring');
  assert.match(await ev(() => document.querySelector('#view-edit .ev2-wn').textContent), /^Space\s*song’s own$/);
  await page.click('#view-edit .ev2-wiretog');
  // the Keys sentence and its Space chip hint, and Master › Wheels & pedal's target list
  await selectBlock('slot:0');
  await sleep(200);
  assert.match(await ev(() => document.querySelector('#view-edit .ev2-sent').textContent),
    /a little into the song’s own Space/);
  await selectBlock('master', { focus: 'wheels' });
  await sleep(300);
  const opts = await ev(() => [...document.querySelectorAll('#view-edit option')].map((o) => o.textContent));
  assert.ok(opts.includes('Space level'), `Wheels & pedal lists "Space level" (${opts.join(' | ')})`);
  await check('master wheels');
  assert.deepEqual(hits, [], hits.join('\n'));
  // back to the song as loaded (the other tests measure the review's state)
  await ev(() => {
    const { store } = window.__rig;
    store.set('slots.0.eq.b2.on', false);
    store.set(`songs.${store.currentSong().id}.patch.fx.reverb.size`,
      window.__rig.views.perform.savedSnapshot.patch.fx.reverb.size);
  });
  await ev(() => {
    for (const d of document.querySelectorAll('#view-edit details[open]')) d.open = false;
  });
  assert.deepEqual(errors, []);
});

test('contrast + hit targets: tab labels, bottom bar (PANIC "⌘ .", legend) ≥ AA; Fade out / PANIC / tabs ≥ 44 px',
  async () => {
    // a muted Pad (OFF tab + muted legend row) next to the selected Keys: the dimmed states the review measured
    await ev(() => window.__rig.store.set('slots.1.muted', true));
    await selectBlock('slot:0');
    try {
      for (const [w, h] of SIZES) {
        await size(w, h);
        const runs = [
          ...(await contrast('#view-edit .ev2-tabs')).map((r) => ({ ...r, area: 'tabs' })),
          ...(await contrast('#view-edit .ev2-bottom')).map((r) => ({ ...r, area: 'bottom' })),
        ];
        const low = runs.filter((r) => !r.disabled && r.ratio < r.need);
        assert.deepEqual(low.map((r) => `${r.area} "${r.t}" ${r.ratio}:1 (${r.px}px ${r.where})`), [],
          `${w}×${h}: text under AA`);
        const panicSub = runs.find((r) => r.t === '⌘ .');
        const min = Math.min(...runs.map((r) => r.ratio));
        const hits = await ev(() => {
          const r = (s) => [...document.querySelectorAll(s)].map((e) => e.getBoundingClientRect())
            .filter((b) => b.width > 0);
          return {
            big: r('#view-edit .ev2-kb-big').map((b) => [Math.round(b.width), Math.round(b.height)]),
            tabs: Math.round(Math.min(...r('#view-edit .ev2-tab').map((b) => b.height))),
            white: Math.round(Math.min(...r('#view-edit .ev2-bottom .pkey.white').map((b) => b.height))),
          };
        });
        for (const [bw, bh] of hits.big) assert.ok(bw >= 44 && bh >= 44, `${w}: Fade out / PANIC ${bw}×${bh}`);
        assert.ok(hits.tabs >= 44, `${w}: tabs ${hits.tabs} px tall`);
        assert.ok(hits.white >= 44, `${w}: on-screen white keys ${hits.white} px tall`);
        info(`${w}×${h}: PANIC "⌘ ." ${panicSub?.ratio}:1, lowest tab/bottom text ${min}:1; Fade/PANIC ${
          hits.big.map((b) => b.join('×')).join(', ')}; tabs ${hits.tabs} px; white keys ${hits.white} px tall`);
        if (w === 1280 || w === 1366) await shot(`widths-${w}-keys-pad-off`);
      }
    } finally {
      await ev(() => window.__rig.store.set('slots.1.muted', false));
    }
  });

test('Tone EQ in the slot panel at every width: table + graph inside the card, compact rule, captions fit',
  async () => {
    await selectBlock('slot:0');
    await ev(() => {
      document.querySelector('#view-edit details[data-sec="slot0-adv"]').open = true;
      document.querySelector('#view-edit details[data-sec="slot0-tone"]').open = true;
    });
    await until(() => !!document.querySelector('#view-edit .ev2-slot-tone-host .eqk'));
    for (const [w, h] of [...SIZES, [1920, 1080]]) {
      await size(w, h);
      await ev(() => document.querySelector('#view-edit .eqk-plot').scrollIntoView({ block: 'start' }));
      await sleep(250);
      const m = await ev(() => {
        const eq = document.querySelector('#view-edit .eqk');
        const er = eq.getBoundingClientRect();
        const out = [...eq.querySelectorAll('*')].map((e) => [e, e.getBoundingClientRect()])
          .filter(([, r]) => r.width > 0 && (r.left < er.left - 1 || r.right > er.right + 1))
          .map(([e]) => e.className);
        const scrolls = [eq, ...eq.querySelectorAll('.eqk-table-wrap, .eqk-head, .eqk-lower, .eqk-graph')]
          .filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.className);
        const inputs = [...eq.querySelectorAll('.eqk-bands input, .eqk-bands select')]
          .filter((e) => e.getBoundingClientRect().width > 0 && e.scrollWidth > e.clientWidth + 1)
          .map((e) => e.value);
        const d = window.__rig.views.edit._debug.instance('slot')._debug.tone().inst.debug();
        return { w: Math.round(er.width), compact: d.compact, air: d.airLabels, out, scrolls, inputs,
          plot: Math.round(eq.querySelector('.eqk-plot').getBoundingClientRect().height) };
      });
      assert.deepEqual(m.out, [], `${w}: nothing outside the EQ card`);
      assert.deepEqual(m.scrolls, [], `${w}: nothing scrolls sideways in the EQ`);
      assert.deepEqual(m.inputs, [], `${w}: band cells show their whole value`);
      // re-tuned rule (eq-keyboard COMPACT_BELOW_PX = 1080; Edit passes compactBelowHeight 1000)
      assert.equal(m.compact, m.w < 1080 || h < 1000, `${w}×${h}: compact ${m.compact} at ${m.w} px`);
      assert.ok(m.air.every((t) => t === null || typeof t === 'string'), 'air captions');
      info(`${w}×${h}: EQ ${m.w} px, ${m.compact ? 'compact' : 'full'}, plot ${m.plot} px, key-strip captions ${
        JSON.stringify(m.air)}`);
      if (w !== 1920) await shot(`widths-${w}-tone-eq`);
    }
    await ev(() => {
      document.querySelector('#view-edit details[data-sec="slot0-tone"]').open = false;
      document.querySelector('#view-edit details[data-sec="slot0-adv"]').open = false;
    });
    await size(1440, 900);
    assert.deepEqual(errors, []);
  });
