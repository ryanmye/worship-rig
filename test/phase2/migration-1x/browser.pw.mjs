// Lane E5, in the real 2.0 app (app/index.html, headless Chromium): a real 1.1 library arrives through
//   (a) the native shell's first-launch path: window.rig is the native shell's own (app/js/native-shell), the page
//       passes Swift's readyProbe (store.pristine && __rigShell.menuReady()), then __rigShell.menu('importLatestBackup');
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
import { documentStartScript } from '../../unit/native-shell/fake-shell.mjs';

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

/**
 * The native shell's Swift side for these tests (RigLibrary over RigShellRouter): a fake
 * webkit.messageHandlers.rigShell with the staged 1.x backup and a disk log. The window.rig in front of it is the
 * real one (app/js/native-shell, lane N0: `NATIVE_SHELL`), injected after this.
 */
const FAKE_NATIVE = (text) => {
  window.__disk = { backups: [], staged: text ? { path: '/Electron/backups/rig-20261124-210000.json', origin: 'http://127.0.0.1:8438', savedAt: 1, text } : null };
  const handlers = {
    backupNow: ({ json, kind }) => {
      window.__disk.backups.push({ kind: kind || 'library', json });
      return { path: `/Native/backups/rig-${window.__disk.backups.length}.json` };
    },
    latestBackup: () => window.__disk.staged || { error: 'no backup found' },
  };
  window.webkit = { messageHandlers: { rigShell: {
    postMessage: (b) => Promise.resolve(handlers[b.m] ? handlers[b.m](b) : { error: `unknown method ${b.m}` }),
  } } };
};
const NATIVE_SHELL = documentStartScript({ platform: 'macos', menuOwnsShortcuts: false, keepsAwake: false });

async function open(text, { via, install } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions([...MIDI_PERMISSIONS], { origin });
  await context.addInitScript(FAKE_NATIVE, text);
  await context.addInitScript({ content: NATIVE_SHELL });
  // D11: how the shell found the staged file, and 1.1.1's marker already on this origin (same-origin Chrome)
  if (via) await context.addInitScript((v) => { if (window.__disk.staged) window.__disk.staged.via = v; }, via);
  if (install) await context.addInitScript((id) => localStorage.setItem('rig.install', id), install);
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

// ============================================================================================ D11: device settings
const DEV_BACKUP = fixture('v1.1.1', 'devices.backup.json');
const DEV_EXPORT = fixture('v1.1.1', 'devices.export.json');
const DEV = JSON.parse(DEV_EXPORT).deviceSettings;
const settingsNow = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__rig.store.get().settings)));
/** The 1.1.1 settings that need no device here (the MIDI input, clock port and audio output are not in CI). */
const PORTABLE = ['menuBarMode', 'audioSleepSec', 'hotkeys', 'updateCheck', 'click', 'keyboards', 'dynamicRange'];

test('D11 native first launch: a 1.1.1 backup (via first-launch) also brings its device settings; missing devices are noted', async () => {
  const { context, page, errors } = await open(DEV_BACKUP, { via: 'first-launch' });
  await page.evaluate(() => {
    window.__toastLog = [];
    new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => window.__toastLog.push(n.textContent))))
      .observe(document.getElementById('toasts'), { childList: true });
  });
  const r = await page.evaluate(() => window.__rig.controller.importLatestBackup());
  assert.equal(r.ok, true, r.error);
  const st = await settingsNow(page);
  for (const k of PORTABLE) assert.deepEqual(st[k], DEV.settings[k], k);
  assert.equal(st.outputDeviceId, 'default', 'a made-up audio output is not found here: skipped');
  assert.equal(st.padFolder, null);
  assert.ok(r.device.skipped.includes('outputDeviceId'));
  await until(page, () => window.__toastLog.some((t) => /Not found on this computer/.test(t)));
  assert.deepEqual(await page.evaluate(() => window.__rig.store.machineMarkers()), [DEV.install]);
  assert.deepEqual(errors, []);
  await context.close();
});

async function importWithOffer(page, file) {
  if (!(await page.evaluate(() => !!document.querySelector('#view-settings.open')))) {
    await openSettings(page);
    await cat(page, 'library');
  }
  await page.setInputFiles('input[type=file][aria-label="Import library file"]', file);
  await page.getByTestId('import-device-offer').waitFor({ state: 'visible', timeout: 10000 });
  return page.getByTestId('import-device-check');
}

test('D11 Settings › Import… of a 1.1.1 export from this computer: the box is ticked, Import uses the settings', async () => {
  const { context, page, errors } = await open(null, { install: DEV.install });
  const file = path.join(tmp, 'Worship Rig library 2026-11-26.json');
  fs.writeFileSync(file, DEV_EXPORT);
  const before = await settingsNow(page);
  const box = await importWithOffer(page, file);
  assert.equal(await box.isChecked(), true);
  assert.match(await page.getByTestId('import-device-offer').textContent(), /this computer had in Worship Rig 1\.x/);
  assert.deepEqual(await settingsNow(page), before, 'nothing happens before Import');
  await page.getByTestId('import-device-go').click();
  await until(page, () => [...document.querySelectorAll('#toasts > *')].some((t) => /Device settings used: \d+/.test(t.textContent)));
  const st = await settingsNow(page);
  for (const k of PORTABLE) assert.deepEqual(st[k], DEV.settings[k], k);
  assert.equal(await page.evaluate(() => window.__rig.store.get().songOrder.length), 20, 'the library came too');
  await closeSettings(page);
  assert.deepEqual(errors, []);
  await context.close();
});

test('D11 Settings › Import… of a 1.1.1 export from another computer: the box is unticked; the library alone comes in', async () => {
  const { context, page, errors } = await open(null);
  const file = path.join(tmp, 'Worship Rig library other.json');
  fs.writeFileSync(file, DEV_EXPORT);
  const before = await settingsNow(page);
  const box = await importWithOffer(page, file);
  assert.equal(await box.isChecked(), false);
  assert.match(await page.getByTestId('import-device-offer').textContent(), /from another computer/);
  await page.getByTestId('import-device-go').click();
  await until(page, () => [...document.querySelectorAll('#toasts > *')].some((t) => /Library imported: 20 songs/.test(t.textContent)));
  const st = await settingsNow(page);
  for (const k of [...PORTABLE, 'midiInputId', 'outputDeviceId', 'padFolder', 'lowResource']) {
    assert.deepEqual(st[k], before[k], `${k}: not applied`);
  }
  assert.equal(await page.getByTestId('import-device-offer').isHidden(), true);
  // a second file, ticked by hand this time: then it is used (only unset ones)
  await page.evaluate(() => window.__rig.store.set('settings.audioSleepSec', 15));
  const box2 = await importWithOffer(page, file);
  await box2.check();
  await page.getByTestId('import-device-go').click();
  await until(page, () => window.__rig.store.get().settings.menuBarMode === true);
  assert.equal((await settingsNow(page)).audioSleepSec, 15, 'a setting changed here stays');
  await closeSettings(page);
  assert.deepEqual(errors, []);
  await context.close();
});
