// Lane E5, in the real 2.0 app (app/index.html, headless Chromium): a real 1.1 library arrives through
//   (a) the native shell's first-launch path: window.rig is RigLibrary.swift's polyfill, the page passes Swift's
//       readyProbe (store.pristine && __rigShell.menuReady()), then __rigShell.menu('importLatestBackup');
//   (b) Settings › "Import latest backup…" › Replace library, over an edited library (backed up first);
//   (c) Settings › Import… with the 1.1 Settings export, into the untouched factory library (E5: replaces it).
// Each time Perform shows the 1.1 song and setlist and Settings shows its settings; zero console.error, no HTTP ≥ 400.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, fixture, tmpDir } from './lib.mjs';
import { MIDI_PERMISSIONS, waitRigReady } from '../../integration/lib.mjs';

const require = createRequire(import.meta.url);
const { createServer } = require(path.join(ROOT, 'server.js'));
const BACKUP = fixture('v1.1.0', 'rich.backup.json');
const EXPORT = fixture('v1.1.0', 'rich.export.json');
const V1 = JSON.parse(fixture('v1.1.0', 'rich.localstorage.json'));
const SUNDAY = V1.setlists[V1.settings.currentSetlistId];
const CURRENT = V1.songs[V1.settings.currentSongId].name;

let server;
let browser;
let origin;
const tmp = tmpDir('pw');
before(async () => {
  server = createServer({ appDir: path.join(ROOT, 'app'), port: 0 });
  const info = await server.listen();
  origin = `http://127.0.0.1:${info.port}`;
  browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
});
after(async () => {
  await browser?.close();
  await server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** RigLibrary.swift's document-start polyfill (same shape), with the staged 1.x backup and a disk log. */
const POLYFILL = (text) => {
  const menu = [];
  window.__disk = { backups: [], staged: text ? { path: '/Electron/backups/rig-20261124-210000.json', origin: 'http://127.0.0.1:8438', savedAt: 1, text } : null };
  const shell = window.__rigShell = window.__rigShell || {};
  shell.menu = (id) => menu.slice().forEach((cb) => { try { cb(id); } catch (e) { console.warn(e); } });
  shell.menuReady = () => menu.length > 0;
  window.rig = {
    isElectron: false,
    platform: 'darwin',
    backupNow: async (json, kind) => {
      window.__disk.backups.push({ kind: kind || 'library', json });
      return { path: `/Native/backups/rig-${window.__disk.backups.length}.json` };
    },
    latestBackup: async () => window.__disk.staged || { error: 'no backup found' },
    onMenu: (cb) => {
      if (typeof cb !== 'function') return () => {};
      menu.push(cb);
      return () => { menu.splice(menu.indexOf(cb), 1); };
    },
  };
};

async function open(text) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions([...MIDI_PERMISSIONS], { origin });
  await context.addInitScript(POLYFILL, text);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${m.text()} @ ${m.location()?.url || '?'}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
  });
  await page.goto(`${origin}/`);
  await waitRigReady(page, { timeout: 60000 });
  return { context, page, errors };
}
const until = (page, fn, arg, timeout = 20000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
async function openSettings(page) {
  await page.click('#btn-settings');
  await page.waitForSelector('#view-settings.open', { timeout: 15000 });
}
async function cat(page, id) {
  await page.click(`#view-settings [role=tab][data-cat="${id}"]`);
  await until(page, (c) => !document.querySelector(`#view-settings [role=tabpanel][data-cat="${c}"]`).hidden, id);
}
async function closeSettings(page) {
  await page.locator('#view-settings .st-close').first().click();
  await until(page, () => !document.querySelector('#view-settings.open'));
}
/** What the UI shows after the import: Perform's song + setlist, Settings' toggles, the theme. */
async function assertShows1x(page, label) {
  await until(page, (name) => document.querySelector('[data-testid=song-name]')?.textContent.trim() === name, CURRENT);
  const strip = await page.locator('[data-testid=setlist]').first().textContent();
  for (const id of SUNDAY.songIds) assert.ok(strip.includes(V1.songs[id].name), `${label}: setlist shows ${V1.songs[id].name}`);
  const st = await page.evaluate(() => {
    const s = window.__rig.store.get();
    return { setlists: s.setlistOrder.map((id) => s.setlists[id].name), songs: s.songOrder.length,
      theme: window.__rig.theme.current, html: document.documentElement.dataset.theme };
  });
  assert.deepEqual(st.setlists, V1.setlistOrder.map((id) => V1.setlists[id].name), label);
  assert.equal(st.songs, V1.songOrder.length, label);
  assert.equal(st.theme, 'studio', `${label}: the 1.1 theme is applied`);
  await openSettings(page);
  for (const key of ['programChange', 'pedalInvert']) {
    const b = page.locator(`[data-bind="settings.${key}"]`).first();
    const on = (await b.getAttribute('aria-pressed')) ?? (await b.getAttribute('aria-checked'));
    assert.equal(on, 'true', `${label}: Settings shows ${key} on`);
  }
  await closeSettings(page);
}

test('native first launch: Swift’s ready probe passes, menu importLatestBackup brings the 1.1 library in', async () => {
  const { context, page, errors } = await open(BACKUP);
  // RigLibrary.readyProbe, verbatim in spirit: store present, the controller's onMenu registered, pristine
  const ready = await page.evaluate(async () => {
    for (let i = 0; i < 120; i++) {
      const s = window.__rig && window.__rig.store;
      if (s && window.__rigShell && window.__rigShell.menuReady()) return s.pristine === true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  });
  assert.equal(ready, true);
  await page.evaluate(() => window.__rigShell.menu('importLatestBackup'));
  await assertShows1x(page, 'first launch');
  const disk = await page.evaluate(() => window.__disk.backups.length);
  assert.equal(disk, 0, 'the untouched seed was not backed up');
  assert.deepEqual(errors, []);
  await context.close();
});

test('Settings › Import latest backup… › Replace library: the edited library is backed up first, then replaced', async () => {
  const { context, page, errors } = await open(BACKUP);
  await page.evaluate(() => window.__rig.store.set('song.tempo', 97)); // an edited 2.0 library
  const mine = await page.evaluate(() => JSON.stringify(window.__rig.store.get().songs));
  await page.evaluate(() => {
    // every toast that appears (a short one can come and go between two polls while the songs load)
    window.__toastLog = [];
    new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => window.__toastLog.push(n.textContent))))
      .observe(document.getElementById('toasts'), { childList: true });
  });
  await openSettings(page);
  await cat(page, 'library');
  await page.locator('.st-import-backup').first().click();
  await page.locator('.st-import-backup-confirm').first().click();
  await until(page, () => window.__toastLog.some((t) => /Library restored from the latest backup \(20 songs\)/.test(t)))
    .catch(async (e) => {
      throw new Error(`${e.message}; toasts seen: ${JSON.stringify(await page.evaluate(() => window.__toastLog))}`);
    });
  await closeSettings(page);
  await assertShows1x(page, 'Settings restore');
  const backups = await page.evaluate(() => window.__disk.backups);
  assert.equal(backups.length >= 1, true);
  const saved = JSON.parse(backups[0].json);
  assert.equal(saved.origin, origin);
  assert.equal(JSON.stringify(saved.songs), mine, 'the backup is the library that was replaced');
  assert.deepEqual(errors, []);
  await context.close();
});

test('Settings › Import… with the 1.1 export into the untouched library: replaced, settings included (E5)', async () => {
  const { context, page, errors } = await open(null);
  const file = path.join(tmp, 'Worship Rig library 2026-11-20.json');
  fs.writeFileSync(file, EXPORT);
  await openSettings(page);
  await page.setInputFiles('input[type=file][aria-label="Import library file"]', file);
  await until(page, () => [...document.querySelectorAll('#toasts > *')].some((t) => /Library imported: 20 songs, 3 setlists/.test(t.textContent)));
  await closeSettings(page);
  await assertShows1x(page, 'Settings import');
  assert.deepEqual(errors, []);
  await context.close();
});
