// Settings suite, "mac" mode (v11-electron): the Mac-app-only parts of Settings — global shortcuts (Settings › Menu
// bar) and the "update available" line (Settings › About) — on the settings fixture with a FAKE window.rig standing
// in for Electron main (registration results, update status, openUpdate). Never touches the network: the fake answers
// everything. Electron main itself (global-hotkeys.js / update-check.js) is unit-tested in test/unit/shell and
// self-tested in test/phase1/shell/electron.boot.mjs. Called by run.mjs; results go into its table.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { MIDI_PERMISSIONS, waitRigReady, pinTheme } from '../../integration/lib.mjs';
import { runImporterTests } from './importer.mjs';

/**
 * The fake bridge (page init script). Registration: 'Control+Alt+Command+P' is "taken by another app"; everything
 * else registers. window.__fake holds the calls and lets the test push statuses / press a shortcut.
 */
function installFakeRig() {
  const subs = { hk: new Set(), up: new Set(), bus: new Set(), gb: new Set(), test: new Set() };
  const sub = (set) => (cb) => {
    set.add(cb);
    return () => set.delete(cb);
  };
  const F = {
    calls: [],
    cfg: null,
    paused: false,
    taken: 'Control+Alt+Command+P',
    up: { enabled: true, supported: true, current: '1.0.1', state: 'latest', latest: '1.0.1', checkedAt: Date.now(),
      pageUrl: 'https://github.com/ryanmye/worship-rig/releases', downloadUrl: null, asset: null, error: null },
    nextCheck: null,
    hkStatus() {
      const keys = {};
      const c = F.cfg || { on: false, keys: {} };
      for (const [id, acc] of Object.entries(c.keys || {})) {
        const state = !c.on ? 'off' : !acc ? 'none' : F.paused ? 'paused' : acc === F.taken ? 'taken' : 'ok';
        keys[id] = { accelerator: acc, state };
      }
      return { on: !!c.on, paused: F.paused, keys };
    },
    pushHk() {
      const s = F.hkStatus();
      for (const cb of subs.hk) cb(s);
      return s;
    },
    pushUp(patch = {}) {
      F.up = { ...F.up, ...patch };
      for (const cb of subs.up) cb({ ...F.up });
      return { ...F.up };
    },
    /** main.js relaying a press: the bus command arrives at the controller like a tray click */
    press(cmd) {
      for (const cb of subs.bus) cb(JSON.stringify({ v: 1, ...cmd }));
    },
    // v11-hotkey-test: main's test mode (global-hotkeys.js test / cancelTest). testing = the id under test
    testing: null,
    testingAcc: null,
    pushTest(ev) {
      for (const cb of subs.test) cb({ ...ev });
    },
    /** the global shortcut for `id` fires: under test → reported and swallowed, else the action (like main) */
    pressHotkey(id) {
      if (F.testing === id) {
        F.testing = null;
        F.pushTest({ id, accelerator: F.cfg.keys[id], fired: true });
        return 'swallowed';
      }
      if (id === 'nextSong' || id === 'prevSong' || id === 'panic') F.press({ type: id });
      return 'sent';
    },
    /** like main's apply(): a test only holds while its combination stays registered */
    endTestIfGone() {
      const st = F.testing && F.hkStatus().keys[F.testing];
      if (F.testing && (!st || st.state !== 'ok' || st.accelerator !== F.testingAcc)) {
        const id = F.testing;
        F.testing = null;
        F.pushTest({ id, fired: false, reason: 'changed' });
      }
    },
    // v11-importer: GarageBand import (importer-host.js stand-in). gbScan = the next scan's answer; gbImportReply =
    // the next import's answer; gbPush(snapshot) = a progress event from main
    gbScan: null,
    gbImportReply: null,
    gbStatus: { state: 'idle', items: [] },
    gbPush(snap) {
      F.gbStatus = snap;
      for (const cb of subs.gb) cb(JSON.parse(JSON.stringify(snap)));
      return snap;
    },
  };
  window.__fake = F;
  window.rig = {
    isElectron: true,
    platform: 'darwin',
    getInfo: async () => ({ version: '1.0.1', electron: '44.4.5', platform: 'darwin', port: Number(location.port),
      backupsDir: '/tmp/rig-backups', recordingsDir: '/tmp/rig-recordings' }),
    backupNow: async () => ({ path: '/tmp/rig-backups/rig.json' }),
    latestBackup: async () => ({ error: 'no backup found' }),
    openFolder: async () => ({ ok: true }),
    choosePadFolder: async () => null,
    listPads: async () => [],
    padsBaseUrl: async () => '/pads/fake/',
    onMenu: () => () => {},
    busPublish: async () => ({ ok: true, seq: 1 }),
    onBusCommand: sub(subs.bus),
    setMenuBarMode: async (on) => ({ on }),
    getMenuBarState: async () => ({ on: false, popoverOpen: false, loginItem: false, windowVisible: true, tray: false }),
    onMenuBarState: () => () => {},
    setLoginItem: async (on) => ({ on: false, loginItem: on }),
    setHotkeys: async (cfg) => {
      F.calls.push(['setHotkeys', cfg]);
      F.cfg = cfg;
      F.endTestIfGone();
      return F.pushHk();
    },
    pauseHotkeys: async (on) => {
      F.calls.push(['pauseHotkeys', on]);
      F.paused = on;
      F.endTestIfGone();
      return F.pushHk();
    },
    testHotkey: async (id, acc) => {
      F.calls.push(['testHotkey', [id, acc]]);
      const st = F.hkStatus().keys[id];
      F.testing = null;
      if (!st || st.state !== 'ok') return { error: 'not registered', state: st ? st.state : 'off' };
      if (acc !== undefined && acc !== st.accelerator) return { error: 'not registered', state: 'changed' };
      F.testing = id;
      F.testingAcc = st.accelerator;
      return { ok: true, id, accelerator: st.accelerator, timeoutMs: 10000 };
    },
    cancelHotkeyTest: async () => {
      F.calls.push(['cancelHotkeyTest']);
      F.testing = null;
      return { ok: true };
    },
    onHotkeyTest: sub(subs.test),
    getHotkeyStatus: async () => F.hkStatus(),
    onHotkeyStatus: sub(subs.hk),
    setUpdateCheck: async (on) => {
      F.calls.push(['setUpdateCheck', on]);
      return F.pushUp({ enabled: on });
    },
    checkForUpdate: async () => {
      F.calls.push(['checkForUpdate']);
      return F.pushUp(F.nextCheck || {});
    },
    getUpdateStatus: async () => ({ ...F.up }),
    onUpdateStatus: sub(subs.up),
    openUpdate: async (kind) => {
      F.calls.push(['openUpdate', kind]);
      return { ok: true, url: kind === 'download' ? F.up.downloadUrl : F.up.pageUrl };
    },
    rescanUserSamples: async () => {
      F.calls.push(['rescanUserSamples']);
      return { count: 0, instruments: [], packs: [], roots: [], errors: [] };
    },
    garageBandScan: async (opts) => {
      F.calls.push(['garageBandScan', opts ?? null]);
      await new Promise((r) => setTimeout(r, 150)); // the "Looking for…" state is visible for a moment
      return JSON.parse(JSON.stringify(F.gbScan));
    },
    garageBandImport: async (keys) => {
      F.calls.push(['garageBandImport', keys]);
      if (F.gbImportReply) return F.gbImportReply;
      const names = new Map((F.gbScan.instruments || []).map((it) => [it.key, it.name]));
      F.gbPush({ state: 'importing', startedAt: Date.now(), total: keys.length, imported: 0, failed: 0, current: -1,
        items: keys.map((k) => ({ key: k, name: names.get(k), state: 'waiting', done: 0, files: 0 })) });
      return { ok: true, total: keys.length };
    },
    garageBandCancel: async () => {
      F.calls.push(['garageBandCancel']);
      F.gbPush({ ...F.gbStatus, cancelling: true });
      return { ok: true };
    },
    garageBandStatus: async () => JSON.parse(JSON.stringify(F.gbStatus)),
    onGarageBandProgress: sub(subs.gb),
  };
}

/**
 * @param {{browser: import('playwright').Browser, createServer: Function, ROOT: string, SHOTS: string,
 *   results: object[]}} o
 */
export async function runMac({ browser, createServer, ROOT, SHOTS, results }) {
  const mode = 'mac';
  const userSamplesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-settings-mac-samples-'));
  const server = createServer({ appDir: ROOT, port: 0, userSamples: [userSamplesDir] });
  const info = await server.listen();
  const origin = `http://127.0.0.1:${info.port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await pinTheme(context, 'classic');
  await context.grantPermissions([...MIDI_PERMISSIONS], { origin });
  const errors = [];
  const watch = (page) => {
    page.on('console', (m) => m.type() === 'error' && errors.push(`${m.text()} @ ${m.location()?.url || '?'}`));
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  };
  let page = null;
  const T = async (name, fn) => {
    const t0 = Date.now();
    try {
      await fn();
      results.push({ mode, name, ok: true });
      console.log(`  ✓ [${mode}] ${name} (${Date.now() - t0} ms)`);
    } catch (err) {
      results.push({ mode, name, ok: false, err });
      console.log(`  ✗ [${mode}] ${name}\n      ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 6).join('\n      ')}`);
    }
  };
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const until = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
  const fixture = `${origin}/test/phase2/settings/fixture.html?key=rig.v1`;
  const boot = async (p) => {
    await p.goto(fixture);
    await p.waitForFunction(() => !!(window.__rig && window.__rig.views && window.__rig.views.settings), null,
      { timeout: 20000 });
    await waitRigReady(p, { timeout: 30000, what: `[${mode}] window.__rig.ready` });
  };
  const openSettings = async (p = page) => {
    await p.evaluate(() => window.__rig.ctx.openSettings());
    await p.waitForFunction(() => window.__rig.views.settings.isOpen, null, { timeout: 5000 });
  };
  const closeSettings = async () => {
    await page.click('.st-close');
    await until(() => document.getElementById('view-settings').hidden);
  };
  const calls = (name) => ev((n) => window.__fake.calls.filter((c) => c[0] === n).map((c) => c[1]), name);
  const keyText = (id) => page.textContent(`[data-testid="hotkey-${id}"]`);

  console.log(`\n[${mode}] ${origin} (fake window.rig)`);
  try {
    // first, before the fake bridge is installed (a context init script reaches every later navigation); closed
    // afterwards, since a second tab on the same origin would make the next page a secondary (Web Lock) controller
    const chrome = await context.newPage();
    watch(chrome);
    await T('Chrome (no window.rig): no global shortcuts, no update line, no GarageBand import (the CLI steps)', async () => {
      try {
        await boot(chrome);
        await openSettings(chrome);
        assert.equal(await chrome.locator('[data-testid="settings-hotkeys"]').count(), 0);
        assert.equal(await chrome.locator('[data-testid="settings-update"]').count(), 0);
        // v11-importer: Mac app only; Chrome keeps the Terminal steps
        assert.equal(await chrome.locator('[data-testid="gb-open"]').count(), 0);
        assert.equal(await chrome.locator('[data-testid="gb-dialog"]').count(), 0);
        assert.match(await chrome.textContent('.st-samples .st-howto-steps'), /node tools\/import-garageband\.mjs --list/);
      } finally {
        await chrome.close();
      }
    });
    await context.addInitScript(installFakeRig);
    page = await context.newPage();
    watch(page);

    await T('boot: the store is mirrored to main once (shortcuts off with the standard keys, checking on)', async () => {
      await boot(page);
      await until(() => window.__fake.calls.some((c) => c[0] === 'setHotkeys')
        && window.__fake.calls.some((c) => c[0] === 'setUpdateCheck'));
      const hk = await calls('setHotkeys');
      assert.equal(hk.length, 1);
      assert.equal(hk[0].on, false, 'off by default');
      assert.equal(hk[0].keys.panic, 'Control+Alt+Command+P');
      assert.deepEqual(await calls('setUpdateCheck'), [true], 'checking is on unless switched off');
      assert.equal(await ev(() => 'hotkeys' in window.__rig.store.get().settings), false, 'absent until set');
    });

    await T('global shortcuts: off by default; on → shown in Mac symbols; "taken" in plain words', async () => {
      await openSettings();
      const sec = page.locator('[data-testid="settings-menubar"] [data-testid="settings-hotkeys"]');
      await sec.scrollIntoViewIfNeeded();
      assert.equal(await page.isHidden('[data-testid="hotkey-list"]'), true, 'quiet: the list only shows when on');
      await page.click('[data-testid="setting-hotkeys-on"]');
      await until(() => window.__rig.store.get().settings.hotkeys?.on === true);
      await until(() => window.__fake.cfg && window.__fake.cfg.on === true);
      assert.equal(await page.isVisible('[data-testid="hotkey-list"]'), true);
      // L11-3: macOS can't report another app's shortcut, so the Mac copy says so (the 'taken' state stays for a
      // register() that really fails)
      // v11-hotkey-test: … and points at the Test button
      assert.equal(await page.textContent('[data-testid="hotkey-mac-taken"]'),
        'macOS can’t tell apps when another app (Rectangle, Magnet, Raycast…) uses a shortcut. Test each one once.');
      await until(() => document.querySelector('[data-testid="hotkey-test-nextSong"]').disabled === false);
      assert.equal(await page.isVisible('[data-testid="hotkey-test-nextSong"]'), true, 'Test where main holds it');
      assert.equal(await page.isVisible('[data-testid="hotkey-test-panic"]'), false, '"taken" already says why not');
      assert.equal(await page.textContent('[data-testid="hotkey-result-nextSong"]'), '', 'quiet until tested');
      assert.equal(await keyText('nextSong'), '⌃⌥⌘]');
      assert.equal(await keyText('prevSong'), '⌃⌥⌘[');
      assert.equal(await keyText('masterUp'), '⌃⌥⌘=');
      await until(() => document.querySelector('[data-testid="hotkey-state-panic"]').textContent !== '');
      assert.equal(await page.textContent('[data-testid="hotkey-state-panic"]'), 'Another app already uses this. Pick another.');
      assert.equal(await page.textContent('[data-testid="hotkey-state-nextSong"]'), '', 'registered: nothing to say');
    });

    await T('global shortcuts: record a new combination (ours paused meanwhile); Esc cancels without closing Settings', async () => {
      await page.click('[data-testid="hotkey-nextSong"]');
      assert.equal(await keyText('nextSong'), 'Press keys…');
      await until(() => window.__fake.paused === true);
      assert.equal(await ev(() => document.documentElement.getAttribute('data-hotkey-capture')), 'nextSong');
      await page.keyboard.down('Control');
      await page.keyboard.down('Alt');
      await page.keyboard.down('Meta');
      await page.keyboard.press('KeyN');
      await page.keyboard.up('Meta');
      await page.keyboard.up('Alt');
      await page.keyboard.up('Control');
      await until(() => window.__rig.store.get().settings.hotkeys.keys.nextSong === 'Control+Alt+Command+N');
      await until(() => window.__fake.paused === false && window.__fake.cfg.keys.nextSong === 'Control+Alt+Command+N');
      assert.equal(await keyText('nextSong'), '⌃⌥⌘N');
      // Esc: the recording stops, Settings stays open, nothing changes
      await page.click('[data-testid="hotkey-prevSong"]');
      await page.keyboard.press('Escape');
      await until(() => !document.documentElement.hasAttribute('data-hotkey-capture'));
      assert.equal(await ev(() => window.__rig.views.settings.isOpen), true, 'Settings is still open');
      assert.equal(await keyText('prevSong'), '⌃⌥⌘[');
      assert.equal(await ev(() => window.__fake.paused), false);
      // a second Esc (nothing recording) closes Settings as before
      await page.keyboard.press('Escape');
      await until(() => !window.__rig.views.settings.isOpen);
      await openSettings();
    });

    await T('global shortcuts: weak and duplicate combinations are refused in plain words; Delete clears one', async () => {
      const before = await ev(() => JSON.stringify(window.__rig.store.get().settings.hotkeys));
      await page.click('[data-testid="hotkey-prevSong"]');
      await page.keyboard.press('Meta+KeyC');
      await until(() => !document.querySelector('[data-testid="hotkey-message"]').hidden);
      assert.match(await page.textContent('[data-testid="hotkey-message"]'), /at least two of ⌃ ⌥ ⌘/);
      await page.click('[data-testid="hotkey-prevSong"]');
      await page.keyboard.press('Control+Alt+Meta+KeyN');
      await until(() => /already the shortcut for Next song/.test(document.querySelector('[data-testid="hotkey-message"]').textContent));
      assert.equal(await ev(() => JSON.stringify(window.__rig.store.get().settings.hotkeys)), before, 'nothing written');
      await page.click('[data-testid="hotkey-masterDown"]');
      await page.keyboard.press('Delete');
      await until(() => window.__rig.store.get().settings.hotkeys.keys.masterDown === '');
      assert.equal(await keyText('masterDown'), 'None');
      assert.equal(await page.isHidden('[data-testid="hotkey-message"]'), true, 'the old message is gone');
      // the computer keyboard never played while recording (Delete / ⌘C / N reached only the recorder)
      assert.equal(await ev(() => window.__rig.controller.status.activeNotes?.length ?? 0), 0);
      await page.click('[data-testid="hotkey-reset"]');
      await until(() => window.__rig.store.get().settings.hotkeys.keys.nextSong === 'Control+Alt+Command+]'
        && window.__rig.store.get().settings.hotkeys.keys.masterDown === 'Control+Alt+Command+-');
      const sec = page.locator('[data-testid="settings-menubar"]');
      await sec.scrollIntoViewIfNeeded();
      await ev(() => document.activeElement?.blur?.());
      await sec.screenshot({ path: path.join(SHOTS, 'mac-menubar-hotkeys.png') });
    });

    await T('global shortcuts: a press (relayed by main as a bus command) steps the setlist\'s songs', async () => {
      // v11-decisions (Ryan, checklist Q3): next / previous = Perform's → / ←, not the menu-bar modes
      const r = await ev(async () => {
        const c = window.__rig.controller;
        const st = window.__rig.store;
        const wait = async (cond) => {
          const t0 = performance.now();
          while (!cond() && performance.now() - t0 < 5000) await new Promise((res) => setTimeout(res, 50));
        };
        const before = st.get().settings.currentSongId;
        const expectNext = st.neighbors().next?.id ?? null;
        window.__fake.press({ type: 'nextSong' });
        await wait(() => st.get().settings.currentSongId !== before);
        const afterNext = st.get().settings.currentSongId;
        window.__fake.press({ type: 'prevSong' });
        await wait(() => st.get().settings.currentSongId !== afterNext);
        const afterPrev = st.get().settings.currentSongId;
        const song = st.currentSong();
        window.__fake.press({ type: 'master', value: 0.25 });
        await new Promise((res) => setTimeout(res, 50));
        return { before, expectNext, afterNext, afterPrev, master: st.getSong(song.id).patch.fx.master.volume,
          labels: [...document.querySelectorAll('.st-hk-label')].slice(0, 2).map((e) => e.textContent),
          hint: document.querySelector('[data-testid="hotkey-list"] > p.st-hint').textContent,
          modeCount: c.modes.list().length };
      });
      assert.ok(r.expectNext, 'the fixture has a next song');
      assert.equal(r.afterNext, r.expectNext, 'nextSong = the song → would pick');
      assert.equal(r.afterPrev, r.before, 'prevSong comes back');
      assert.equal(r.master, 0.25);
      assert.deepEqual(r.labels, ['Next song', 'Previous song']);
      assert.match(r.hint, /Next and previous song go through the setlist/);
    });

    const result = (id) => page.textContent(`[data-testid="hotkey-result-${id}"]`);
    const songNow = () => ev(() => window.__rig.store.get().settings.currentSongId);

    await T('press to test: Test → "Press ⌃⌥⌘] in any app…" → the press → Works; the song stays', async () => {
      await page.locator('[data-testid="settings-hotkeys"]').scrollIntoViewIfNeeded();
      const before = await songNow();
      await page.click('[data-testid="hotkey-test-nextSong"]');
      assert.equal(await result('nextSong'), 'Press ⌃⌥⌘] in any app…');
      await until(() => window.__fake.testing === 'nextSong');
      assert.deepEqual((await calls('testHotkey')).at(-1), ['nextSong', 'Control+Alt+Command+]']);
      assert.equal(await ev(() => document.documentElement.getAttribute('data-hotkey-capture')), 'test');
      assert.equal(await ev(() => window.__fake.pressHotkey('nextSong')), 'swallowed');
      await until(() => document.querySelector('[data-testid="hotkey-result-nextSong"]').textContent === 'Works');
      assert.equal(await ev(() => document.querySelector('[data-testid="hotkey-result-nextSong"]').dataset.phase),
        'works');
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(await songNow(), before, 'a test of Next song does not switch songs');
      await until(() => !document.documentElement.hasAttribute('data-hotkey-capture'));
      assert.equal(await ev(() => window.__rig.views.settings.isOpen), true);
      await ev(() => document.activeElement?.blur?.());
      await page.locator('[data-testid="settings-hotkeys"]')
        .screenshot({ path: path.join(SHOTS, 'mac-hotkey-test.png') });
    });

    await T('press to test: one at a time; Esc cancels without closing Settings; nothing in 5 s → pick another',
      async () => {
        await page.click('[data-testid="hotkey-test-prevSong"]');
        await until(() => window.__fake.testing === 'prevSong');
        await page.click('[data-testid="hotkey-test-masterUp"]');
        assert.equal(await result('prevSong'), '', 'the first test is replaced');
        assert.equal(await result('masterUp'), 'Press ⌃⌥⌘= in any app…');
        await until(() => window.__fake.testing === 'masterUp');
        assert.equal(await result('nextSong'), 'Works', 'a finished result stays');
        // a late press of the replaced one reaches neither row
        await ev(() => window.__fake.pushTest({ id: 'prevSong', fired: true }));
        assert.equal(await result('prevSong'), '');
        await page.keyboard.press('Escape');
        await until(() => document.querySelector('[data-testid="hotkey-result-masterUp"]').textContent === '');
        await until(() => window.__fake.testing === null);
        await until(() => !document.documentElement.hasAttribute('data-hotkey-capture'));
        assert.equal(await ev(() => window.__rig.views.settings.isOpen), true, 'Esc cancelled the test only');
        // no press: after 5 s the hint, main's test mode is ended, the key is marked
        const t0 = Date.now();
        await page.click('[data-testid="hotkey-test-prevSong"]');
        await until(() => window.__fake.testing === 'prevSong');
        await until(() => /^Nothing came through/.test(document.querySelector('[data-testid="hotkey-result-prevSong"]')
          .textContent), null, 9000);
        const waited = Date.now() - t0;
        assert.ok(waited >= 4900 && waited < 8000, `waited ${waited} ms`);
        assert.equal(await result('prevSong'), 'Nothing came through. Another app may use this. Pick another.');
        assert.equal(await ev(() => window.__fake.testing), null, 'main is told to stop swallowing the press');
        assert.equal(await ev(() => document.querySelector('[data-testid="hotkey-prevSong"]').classList
          .contains('warn')), true);
        assert.equal(await page.textContent('[data-testid="hotkey-state-prevSong"]'), '',
          '"taken" stays for register()');
        // a press now does its job again
        const before = await songNow();
        await ev(() => window.__fake.press({ type: 'nextSong' }));
        await until((b) => window.__rig.store.get().settings.currentSongId !== b, before);
        assert.equal(await ev(() => window.__fake.pressHotkey('prevSong')), 'sent');
        await until((b) => window.__rig.store.get().settings.currentSongId === b, before);
      });

    await T('press to test: runs right after recording a new combination; closing Settings cancels it', async () => {
      await page.click('[data-testid="hotkey-nextSong"]');
      await until(() => window.__fake.paused === true);
      await page.keyboard.press('Control+Alt+Meta+KeyJ');
      await until(() => window.__rig.store.get().settings.hotkeys.keys.nextSong === 'Control+Alt+Command+J');
      assert.equal(await result('nextSong'), 'Press ⌃⌥⌘J in any app…', 'the old "Works" was for ⌃⌥⌘]');
      // armed only once main holds the new combination (not while paused, not on the old one)
      await until(() => window.__fake.testing === 'nextSong');
      assert.deepEqual((await calls('testHotkey')).at(-1), ['nextSong', 'Control+Alt+Command+J']);
      assert.equal(await ev(() => window.__fake.cfg.keys.nextSong), 'Control+Alt+Command+J');
      assert.equal(await ev(() => document.documentElement.getAttribute('data-hotkey-capture')), 'test');
      await closeSettings();
      await until(() => window.__fake.testing === null);
      await until(() => !document.documentElement.hasAttribute('data-hotkey-capture'));
      await openSettings();
      assert.equal(await result('nextSong'), '', 'a closed Settings forgets the test');
      // recording a combination another app holds: no test, the row says "taken"
      await page.locator('[data-testid="settings-hotkeys"]').scrollIntoViewIfNeeded();
      await page.click('[data-testid="hotkey-panic"]');
      await page.keyboard.press('Delete');
      await until(() => window.__rig.store.get().settings.hotkeys.keys.panic === '');
      await page.click('[data-testid="hotkey-nextSong"]');
      await page.keyboard.press('Control+Alt+Meta+KeyP');
      await until(() => window.__rig.store.get().settings.hotkeys.keys.nextSong === 'Control+Alt+Command+P');
      await until(() => document.querySelector('[data-testid="hotkey-state-nextSong"]').textContent !== '');
      assert.equal(await page.textContent('[data-testid="hotkey-state-nextSong"]'),
        'Another app already uses this. Pick another.');
      await until(() => document.querySelector('[data-testid="hotkey-result-nextSong"]').textContent === '');
      assert.equal(await ev(() => window.__fake.testing), null);
      await until(() => !document.documentElement.hasAttribute('data-hotkey-capture'));
      await page.click('[data-testid="hotkey-reset"]');
      await until(() => window.__rig.store.get().settings.hotkeys.keys.nextSong === 'Control+Alt+Command+]'
        && window.__rig.store.get().settings.hotkeys.keys.panic === 'Control+Alt+Command+P');
    });

    await T('global shortcuts: off → main hears it, the list hides', async () => {
      await page.click('[data-testid="setting-hotkeys-on"]');
      await until(() => window.__fake.cfg.on === false);
      assert.equal(await page.isHidden('[data-testid="hotkey-list"]'), true);
      await closeSettings();
    });

    await T('updates: quiet when up to date; "Version x is available" + Download opens the dmg; never outside Settings', async () => {
      await openSettings();
      const line = '[data-testid="update-status"]';
      await page.locator('[data-testid="settings-update"]').scrollIntoViewIfNeeded();
      await until((s) => document.querySelector(s).textContent !== '', line);
      assert.equal(await page.textContent(line), 'You have the latest version (1.0.1), checked today.');
      assert.equal(await page.isHidden('[data-testid="update-download"]'), true);
      await closeSettings();
      // a check finds 1.1.1 while Settings is closed (e.g. mid-set): nothing appears anywhere — no toast, no dialog
      await ev(() => window.__fake.pushUp({ state: 'update', latest: '1.1.1',
        pageUrl: 'https://github.com/ryanmye/worship-rig/releases/tag/v1.1.1', asset: 'Worship-Rig-arm64.dmg',
        downloadUrl: 'https://github.com/ryanmye/worship-rig/releases/download/v1.1.1/Worship-Rig-arm64.dmg' }));
      await new Promise((r) => setTimeout(r, 300));
      const outside = await ev(() => ({
        toasts: document.querySelectorAll('#toasts > *').length,
        dialog: document.body.dataset.dialogOpen || '',
        settingsHidden: document.getElementById('view-settings').hidden,
      }));
      assert.deepEqual(outside, { toasts: 0, dialog: '', settingsHidden: true });
      await openSettings();
      await page.locator('[data-testid="settings-update"]').scrollIntoViewIfNeeded();
      await until((s) => /1\.1\.1/.test(document.querySelector(s).textContent), line);
      assert.equal(await page.textContent(line), 'Version 1.1.1 is available. You have 1.0.1.');
      await page.click('[data-testid="update-download"]');
      await until(() => window.__fake.calls.some((c) => c[0] === 'openUpdate' && c[1] === 'download'));
      await until(() => !document.querySelector('[data-testid="update-how"]').hidden);
      assert.match(await page.textContent('[data-testid="update-how"]'), /quit Worship Rig, open the \.dmg/);
      await page.click('[data-testid="update-notes"]');
      await until(() => window.__fake.calls.some((c) => c[0] === 'openUpdate' && c[1] === 'page'));
      await ev(() => document.activeElement?.blur?.());
      await page.locator('.st-section[aria-label="About"]').screenshot({ path: path.join(SHOTS, 'mac-about-update.png') });
    });

    await T('updates: Check now failures in plain words; the toggle writes settings.updateCheck; unsupported says why', async () => {
      const line = '[data-testid="update-status"]';
      await ev(() => window.__fake.pushUp({ state: 'latest', latest: '1.0.1', downloadUrl: null }));
      await ev(() => {
        window.__fake.nextCheck = { state: 'latest', error: 'offline' };
      });
      await page.click('[data-testid="update-check-now"]');
      await until(() => window.__fake.calls.some((c) => c[0] === 'checkForUpdate'));
      await until((s) => /Couldn’t reach GitHub/.test(document.querySelector(s).textContent), line);
      await page.click('[data-testid="setting-update-check"]');
      await until(() => window.__rig.store.get().settings.updateCheck === false);
      await until(() => window.__fake.calls.filter((c) => c[0] === 'setUpdateCheck').map((c) => c[1]).join() === 'true,false');
      await page.click('[data-testid="setting-update-check"]');
      await until(() => window.__rig.store.get().settings.updateCheck === true);
      await ev(() => window.__fake.pushUp({ state: 'unsupported', error: null }));
      await until((s) => document.querySelector(s).textContent === 'Update checks run in the installed Mac app.', line);
      assert.equal(await page.isHidden('[data-testid="update-check-now"]'), true);
      await closeSettings();
    });
    await runImporterTests({ page, T, ev, until, openSettings, calls, SHOTS });
  } finally {
    await T('zero console.error', async () => {
      assert.deepEqual(errors, []);
    });
    await context.close();
    await server.close();
  }
}
