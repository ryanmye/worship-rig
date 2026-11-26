#!/usr/bin/env node
// Theme screenshots + contrast audit for ANY registered theme (themes-setup; generalised from the Daylight v2
// design shoot, design/warmth/daylight-v2/shoot.mjs, which this replaces). The theme is applied the way the app does
// it (settings.theme → boot.js + main.js applyTheme), not injected, so what you see is what ships.
//   node tools/themes/shoot.mjs --theme <id> [--out <dir>] [--only perform,quick,edit,eq,settings,mini] [--size 1440x900]
//   default --out: design/warmth/shots/<id>/
// Writes <out>/{perform,quick,edit,edit-tone-eq,settings-<category>}.png, <out>/{mini,mini-drone-keys}.png (the menu-bar popover,
// app/mini.html at 320×440, live on the app's real bus state; mini-theme: the critic shoots it per theme), <out>/audit-<shot>-<W>.json (every visible text run: computed
// colour vs the median rendered background behind it, WCAG 4.5 / 3 for large text; disabled controls exempt) and
// <out>/summary.json (per shot: runs, fails, lowest; console/HTTP errors).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(ROOT, 'package.json'));
const { chromium } = require('playwright');
const { createServer } = require(path.join(ROOT, 'server.js'));
const { THEMES, byId } = await import(path.join(ROOT, 'app/js/shared/themes.js'));
// the measuring code lives in audit-lib.mjs, shared with shoot-v6.mjs (U8b)
const { audit } = await import('./audit-lib.mjs');
const args = process.argv.slice(2);
const opt = (n, d = null) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const THEME = opt('--theme');
if (!THEME || !byId(THEME)) {
  console.error(`usage: node tools/themes/shoot.mjs --theme <${THEMES.map((t) => t.id).join('|')}> [--out dir] `
    + '[--only perform,quick,edit,eq,settings,mini] [--size 1440x900]');
  process.exit(2);
}
const OUT = path.resolve(opt('--out', path.join(ROOT, 'design/warmth/shots', THEME)));
const only = (opt('--only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (k) => !only.length || only.includes(k);
const [W, H] = (opt('--size', '1440x900')).split('x').map(Number);
fs.mkdirSync(OUT, { recursive: true });

const server = createServer({ appDir: path.join(ROOT, 'app'), port: 0, userSamples: false });
const { url } = await server.listen();
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const consoleErrors = [];

async function boot() {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1,
    colorScheme: byId(THEME).mode });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) consoleErrors.push(`${r.status()} ${r.url()}`); });
  page.setDefaultTimeout(120000);
  const ready = async () => {
    await page.waitForFunction(() => !!window.__rig, null, { timeout: 120000 });
    if (await page.isVisible('#overlay-start')) await page.click('#overlay-start');
    await page.waitForFunction(() => window.__rig.engine.ctx?.state === 'running', null, { timeout: 120000 });
  };
  await page.goto(url, { timeout: 120000 });
  await ready();
  // the app's own path: settings.theme → mirror → reload → boot.js links it before first paint
  await page.evaluate(async (id) => {
    window.__rig.store.set('settings.theme', id);
    await new Promise((r) => setTimeout(r, 0));
    await window.__rig.theme.pending;
    window.__rig.store.persistNow();
  }, THEME);
  await page.reload({ timeout: 120000 });
  await ready();
  await page.waitForFunction(() => window.__rig.controller.status.ready === true, null, { timeout: 30000 }).catch(() => {});
  const idx = await page.evaluate(() => [...document.querySelectorAll('[data-testid=setlist] .setlist-chip')]
    .findIndex((c) => /Sunday Pad \+ Piano/.test(c.textContent)));
  if (idx >= 0) await page.click(`[data-testid=setlist] .setlist-chip[data-index="${idx}"]`);
  // Lane S (D6): the chip cues the song; GO plays it
  if (await page.evaluate(() => !!window.__rig.controller.status.cue)) await page.click('[data-testid=next-song]');
  await page.waitForFunction(() => !window.__rig.controller.status.loading && !window.__rig.controller.status.go,
    null, { timeout: 240000, polling: 500 });
  await page.evaluate(() => document.fonts.ready);
  // perform.js fits the song name on a resize of the song block, not on a font swap: a 1 px nudge refits it
  await page.setViewportSize({ width: W - 1, height: H });
  await page.waitForTimeout(150);
  await page.setViewportSize({ width: W, height: H });
  // stills only: this box runs at a few fps under load, so transitions would be caught mid-way
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation-duration: 0s !important; }' });
  await page.waitForTimeout(400);
  return { ctx, page };
}
const clearToasts = (page) => page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach((t) => t.remove()));
const hold = (page) => page.evaluate(() => {
  const p = window.__rig.controller.perform;
  p.wheel?.(0.62);
  for (const n of [48, 55, 60, 64, 67, 71]) p.noteOn(n, 104);
});
const sounding = (page) => page.waitForFunction(() => (window.__rig.controller.slotLevel?.(0)?.peak || 0) > 0.01, null,
  { timeout: 60000, polling: 250 }).then(() => true).catch(() => false);
const release = (page) => page.evaluate(() => window.__rig.controller.perform.releaseAll());

async function shoot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  const { count, fails, lowest } = await audit(page, { out: OUT, label: `${name}-${W}`, shot: file });
  return { count, fails, lowest };
}

const summary = { theme: THEME, size: `${W}x${H}`, shots: {} };
try {
  const { ctx, page } = await boot();
  summary.shown = await page.evaluate(() => ({ html: document.documentElement.dataset.theme,
    css: document.getElementById('theme-css')?.getAttribute('href') ?? null }));
  await hold(page);
  summary.sounding = await sounding(page);
  await page.waitForTimeout(800);
  await clearToasts(page);
  if (want('perform')) summary.shots.perform = await shoot(page, 'perform');
  if (want('quick')) {
    await page.click('#btn-quick');
    await page.waitForTimeout(400);
    await clearToasts(page);
    summary.shots.quick = await shoot(page, 'quick');
    await page.click('#btn-quick');
    await page.waitForTimeout(200);
  }
  await release(page);
  if (want('edit') || want('eq')) {
    await page.evaluate(() => window.__rig.store.set('settings.view', 'edit'));
    await page.waitForSelector('#view-edit .ev2', { state: 'visible' });
    await page.waitForTimeout(1200);
    if (want('edit')) {
      await hold(page);
      await page.waitForTimeout(700);
      await clearToasts(page);
      summary.shots.edit = await shoot(page, 'edit');
      await release(page);
    }
    if (want('eq')) {
      // the slot EQ sits straight in Advanced (Ryan 2026-09-30: no Tone disclosure)
      const ok = await page.evaluate(() => {
        const adv = document.querySelector('#view-edit details[data-sec="slot0-adv"]');
        if (!adv) return false;
        adv.open = true;
        return true;
      });
      if (ok && await page.waitForSelector('#view-edit .eqk', { timeout: 20000 }).then(() => true, () => false)) {
        await page.waitForTimeout(600);
        await page.evaluate(() => document.querySelector('#view-edit .eqk')?.scrollIntoView({ block: 'end' }));
        await page.waitForTimeout(400);
        await clearToasts(page);
        summary.shots.eq = await shoot(page, 'edit-tone-eq');
      } else summary.shots.eq = 'Advanced / EQ did not mount';
    }
  }
  if (want('settings')) {
    // U8b: today's Settings, every category (UI6-U6 O3, Daylight Day's engine note, was only seen by hand)
    await page.evaluate(() => window.__rig.store.set('settings.view', 'perform'));
    await page.evaluate(() => window.__rig.ctx.openSettings());
    await page.waitForFunction(() => window.__rig.views.settings.isOpen, null, { timeout: 20000 });
    const cats = await page.evaluate(() => [...document.querySelectorAll('#view-settings [role=tab]')].map((t) => t.dataset.cat));
    summary.shots.settings = {};
    for (const c of cats) {
      await page.click(`#view-settings [role=tab][data-cat="${c}"]`);
      await page.waitForFunction((cc) => !document.querySelector(`#view-settings [role=tabpanel][data-cat="${cc}"]`)?.hidden, c,
        { timeout: 10000 });
      await page.evaluate(() => { for (const b of document.querySelectorAll('.st-body')) b.scrollTop = 0; document.activeElement?.blur?.(); });
      await page.mouse.move(0, 0);
      await page.waitForTimeout(250);
      await clearToasts(page);
      summary.shots.settings[c] = await shoot(page, `settings-${c}`);
    }
    await page.evaluate(() => window.__rig.ctx.closeSettings());
  }
  if (want('mini')) {
    // the menu-bar popover (app/mini.html) in the same context: it boots from the mirror the app wrote and goes live
    // on the app's real bus state (BroadcastChannel 'rig-bus'); the audit runs on the 320×440 page
    const mp = await ctx.newPage();
    mp.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[mini] ${m.text()}`); });
    mp.on('response', (r) => { if (r.status() >= 400) consoleErrors.push(`[mini] ${r.status()} ${r.url()}`); });
    await mp.setViewportSize({ width: 320, height: 440 });
    await mp.goto(new URL('mini.html', url).href, { timeout: 120000 });
    await mp.waitForFunction(() => document.getElementById('mini')?.dataset.state === 'live', null, { timeout: 60000 });
    await mp.evaluate(() => document.fonts.ready);
    await mp.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation-duration: 0s !important; }' });
    await mp.waitForTimeout(300);
    summary.miniShown = await mp.evaluate(() => document.documentElement.dataset.theme);
    const shootMini = async (name) => {
      const file = path.join(OUT, `${name}.png`);
      await mp.screenshot({ path: file });
      const { count, fails, lowest } = await audit(mp, { out: OUT, label: `${name}-320`, shot: file });
      return { count, fails, lowest };
    };
    summary.shots.mini = await shootMini('mini');
    await mp.click('[data-testid="mini-drone-keys"]');
    await mp.mouse.move(0, 0);
    await mp.waitForTimeout(200);
    summary.shots.miniKeys = await shootMini('mini-drone-keys');
    await mp.close();
  }
  await ctx.close();
} finally {
  await browser.close();
  await server.close();
}
summary.errors = consoleErrors.filter((e) => !/MIDI|midi|requestMIDIAccess/.test(e));
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
console.log('summary', JSON.stringify(summary, null, 1));
process.exit(summary.errors.length ? 1 : 0);
