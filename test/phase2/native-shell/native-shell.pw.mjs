// Lane N0, in the real 2.0 app (app/index.html, headless Chromium) as the native shell runs it: the bridge engine over
// MockNative (?engine=bridge-mock, main.js served with the engine import swapped, as RigSchemeHandler does), Web MIDI
// removed (WKWebView has none), and window.rig from the REAL app/js/native-shell files, injected at document start
// the way RigShellScripts does (test/unit/native-shell/fake-shell.mjs), over a fake webkit.messageHandlers.rigShell.
// Checks: the flags and the merged __rigShell after boot; Settings without Chrome wording (About, Library & Backup,
// the Menu-bar section and the mini-panel button: LaneR O1), no Mac category until a Mac-only feature exists, Back
// up now through the shell, the v6 summaries; iPad wording; the shell's files are never requested; zero
// console.error, no HTTP >= 400. Chrome (no window.rig) keeps its copy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { MIDI_PERMISSIONS, waitRigReady, pinTheme } from '../../integration/lib.mjs';
import { ROOT, documentStartScript } from '../../unit/native-shell/fake-shell.mjs';

const APP = path.join(ROOT, 'app');
const require = createRequire(import.meta.url);
const { createServer } = require(path.join(ROOT, 'server.js'));
const API = fs.readFileSync(path.join(ROOT, 'native/contract/engine-api.json'));
const NEEDLE = "import { AudioEngine } from './engine/index.js';";

const INFO = {
  version: '2.0.0', build: '7', shell: 'native', port: 0, portChanged: false, otherLibrary: null, padsRoot: null,
  userSamplesDir: null, userSampleRoots: [], recordingsDir: '/Users/ryan/Music/Worship Rig',
  backupsDir: '/Users/ryan/Library/Application Support/Worship Rig Native/backups',
};

let server;
let browser;
let origin;
before(async () => {
  server = createServer({ appDir: APP, port: 0 });
  const info = await server.listen();
  origin = `http://127.0.0.1:${info.port}`;
  browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
});
after(async () => {
  await browser?.close();
  await server?.close();
});

/** The fake rigShell handler (page side): records calls; getInfo / backupNow / latestBackup as RigInfo / RigLibrary. */
function fakeShell(info) {
  window.__shell = { calls: [], backups: [] };
  const handlers = {
    getInfo: () => info,
    backupNow: (b) => {
      window.__shell.backups.push(b);
      return { path: `${info.backupsDir}/rig-20261127-120000.json` };
    },
    latestBackup: () => ({ error: 'no backup found' }),
  };
  window.webkit = { messageHandlers: { rigShell: { postMessage: (b) => {
    window.__shell.calls.push(b.m);
    const h = handlers[b.m];
    return Promise.resolve(h ? h(b) : { error: `unknown method ${b.m}` });
  } } } };
}

/** A page of the real app. `platform`: the native shell's ('macos' | 'ipados'), or null for plain Chrome. */
async function openApp({ platform = 'macos' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await pinTheme(context, 'classic');
  await context.grantPermissions([...MIDI_PERMISSIONS], { origin });
  const requests = [];
  const errors = [];
  if (platform) {
    await context.route('**/__bridge/engine-api.json', (r) => r.fulfill({ status: 200, body: API,
      contentType: 'application/json' }));
    await context.route('**/js/main.js', async (route) => {
      const src = fs.readFileSync(path.join(APP, 'js/main.js'), 'utf8');
      assert.ok(src.includes(NEEDLE), 'main.js engine import changed: update this test');
      await route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8',
        body: src.replace(NEEDLE, "import { AudioEngine } from './engine-bridge/select.js';") });
    });
    await context.addInitScript(() => { delete Navigator.prototype.requestMIDIAccess; });
    await context.addInitScript(fakeShell, { ...INFO, platform });
    await context.addInitScript({ content: documentStartScript({ platform, menuOwnsShortcuts: false,
      keepsAwake: false }) });
  }
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${m.text()} @ ${m.location()?.url || '?'}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('request', (r) => requests.push(new URL(r.url()).pathname));
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
  });
  await page.goto(`${origin}/${platform ? '?engine=bridge-mock' : ''}`);
  await waitRigReady(page, { timeout: 45000 });
  // Settings mounts after __rig.ready (a lazy import): opening it before then shows the placeholder, which the mount
  // then hides again (main.js viewsReady; the same in Chrome)
  await page.evaluate(() => window.__rig.viewsReady);
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const until = (fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 50 });
  return { context, page, errors, requests, ev, until };
}

async function openSettings(a) {
  await a.page.click('#btn-settings');
  await a.page.waitForSelector('#view-settings.open', { timeout: 15000 });
}
async function cat(a, id) {
  await a.page.click(`#view-settings [role=tab][data-cat="${id}"]`);
  await a.until((c) => !document.querySelector(`#view-settings [role=tabpanel][data-cat="${c}"]`).hidden, id);
}
const panelText = (a, id) => a.ev((c) => document.querySelector(`#view-settings [role=tabpanel][data-cat="${c}"]`)
  .textContent.replace(/\s+/g, ' '), id);
const tabIds = (a) => a.ev(() => [...document.querySelectorAll('#view-settings [role=tab][data-cat]')]
  .map((t) => t.dataset.cat));

test('native Mac app: flags, merged __rigShell, Settings without Chrome wording, Back up now', { timeout: 240000 },
  async (t) => {
    const a = await openApp({ platform: 'macos' });
    try {
      await t.test('window.rig is the shell’s; the controller merged its quit hook into __rigShell', async () => {
        const r = await a.ev(() => ({
          shell: window.rig.shell, isElectron: window.rig.isElectron, platform: window.rig.platform,
          menuOwnsShortcuts: window.rig.menuOwnsShortcuts, keepsAwake: window.rig.keepsAwake,
          engine: /BridgeEngine/.test(window.__rig.engine.constructor.name),
          menu: typeof window.__rigShell.menu, menuReady: window.__rigShell.menuReady(),
          call: typeof window.__rigShell.call, native: window.__rigShell.native,
          recording: window.__rigShell.recording(), library: window.__rigShell.library(),
        }));
        assert.deepEqual(r, { shell: 'native', isElectron: false, platform: 'macos', menuOwnsShortcuts: false,
          keepsAwake: false, engine: true, menu: 'function', menuReady: true, call: 'function',
          native: true, recording: false, library: null });
        assert.equal(a.requests.filter((p) => p.includes('native-shell')).length, 0, 'the files are injected');
      });

      await t.test('a menu id from the shell reaches the page (openSettings opens Settings)', async () => {
        await a.ev(() => window.__rigShell.menu('openSettings'));
        await a.page.waitForSelector('#view-settings.open', { timeout: 15000 });
        await a.page.locator('#view-settings .st-close').first().click();
        await a.until(() => !document.querySelector('#view-settings.open'));
      });

      await t.test('no Mac category yet; Look holds "Low-resource mode" without menu-bar rows or the mini panel',
        async () => {
          await openSettings(a);
          assert.ok(!(await tabIds(a)).includes('mac'), 'no Mac-only feature exists before N7-N9');
          await cat(a, 'look');
          const mb = await a.ev(() => {
            const s = document.querySelector('#view-settings [data-section="menubar"]');
            return {
              h: s.querySelector('h2').textContent, aria: s.getAttribute('aria-label'),
              mode: !!s.querySelector('[data-testid="setting-mb-mode"]'),
              set: !!s.querySelector('[data-testid="setting-mb-set"]'),
              mini: !!document.querySelector('[data-testid="setting-mb-open-mini"]'),
              login: !!s.querySelector('.st-mb-login-hint'),
              low: !!s.querySelector('[data-testid="setting-mb-lowres"]'),
              text: s.textContent.replace(/\s+/g, ' '),
            };
          });
          assert.deepEqual({ ...mb, text: undefined }, { h: 'Low-resource mode', aria: 'Low-resource mode',
            mode: false, set: false, mini: false, login: false, low: true, text: undefined });
          assert.ok(!/Chrome|mini panel|menu-bar mode/i.test(mb.text), mb.text);
        });

      await t.test('About: version and build from getInfo, the folders; no Chrome / Electron / local server', async () => {
        await cat(a, 'about');
        await a.until(() => /2\.0\.0/.test(document.querySelector('#view-settings .st-about').textContent));
        const about = await a.ev(() => [...document.querySelectorAll('#view-settings .st-about dt')]
          .map((dt) => [dt.textContent, dt.nextElementSibling.textContent]));
        assert.deepEqual(about, [['Version', '2.0.0 (Mac app)'], ['Build', '7'], ['Backups', INFO.backupsDir],
          ['Recordings', INFO.recordingsDir]]);
        assert.ok((await a.ev(() => window.__shell.calls)).includes('getInfo'));
      });

      await t.test('Library & Backup: the app’s copy, Back up now goes through the shell', async () => {
        await cat(a, 'library');
        const text = await panelText(a, 'library');
        assert.ok(!/Chrome and the Mac app|In Chrome|run in the Mac app/.test(text), text);
        assert.ok(text.includes('This app keeps its own library'), text);
        await a.page.getByRole('button', { name: 'Back up now' }).click();
        await a.until(() => window.__shell.backups.length === 1);
        const b = await a.ev(() => window.__shell.backups[0]);
        assert.equal(b.m, 'backupNow');
        assert.equal(JSON.parse(b.json).schema, 2, 'the library JSON text');
        await a.until(() => [...document.querySelectorAll('.toast')].some((x) => /Backup saved/.test(x.textContent)));
      });

      await t.test('every Settings panel: no "In Chrome" / "Chrome and the Mac app" / "browser’s permission"',
        async () => {
          const ids = await tabIds(a);
          const hits = [];
          for (const id of ids) {
            const text = await panelText(a, id);
            for (const re of [/In Chrome/, /Chrome and the Mac app/, /in the Mac app\./, /mini panel/]) {
              if (re.test(text)) hits.push(`${id}: ${re}`);
            }
          }
          assert.deepEqual(hits, []);
        });

      await t.test('the v6 Settings summaries: About names the version, Library the automatic backups', async () => {
        await a.ev(() => window.__rig.store.set('settings.uiV6', true));
        await a.until(() => !!document.querySelector('[data-testid="settings-sum-about"]'));
        await a.until(() => /Version 2\.0\.0/.test(document.querySelector('[data-testid="settings-sum-about"]')
          .textContent));
        const lib = await a.ev(() => document.querySelector('[data-testid="settings-sum-library"]').textContent);
        assert.ok(/backed up|automatic backups/.test(lib), lib);
        assert.ok(!(await tabIds(a)).includes('mac'));
      });

      assert.deepEqual(a.errors, []);
    } finally {
      await a.context.close();
    }
  });

test('native iPad app: About says iPad app; no Mac category', { timeout: 120000 }, async () => {
  const a = await openApp({ platform: 'ipados' });
  try {
    assert.equal(await a.ev(() => window.rig.platform), 'ipados');
    await openSettings(a);
    assert.ok(!(await tabIds(a)).includes('mac'));
    await cat(a, 'about');
    await a.until(() => /iPad app/.test(document.querySelector('#view-settings .st-about').textContent));
    assert.deepEqual(a.errors, []);
  } finally {
    await a.context.close();
  }
});

test('Chrome (no window.rig) keeps its copy: Mode Chrome, the mini panel, the Open-at-login hint', { timeout: 120000 },
  async () => {
    const a = await openApp({ platform: null });
    try {
      assert.equal(await a.ev(() => window.rig === undefined && window.__rigShell === undefined), true);
      await openSettings(a);
      assert.ok(!(await tabIds(a)).includes('mac'));
      await cat(a, 'look');
      const mb = await a.ev(() => {
        const s = document.querySelector('#view-settings [data-section="menubar"]');
        return { h: s.querySelector('h2').textContent, mini: !!s.querySelector('[data-testid="setting-mb-open-mini"]'),
          mode: !!s.querySelector('[data-testid="setting-mb-mode"]'), login: !!s.querySelector('.st-mb-login-hint') };
      });
      assert.deepEqual(mb, { h: 'Menu bar', mini: true, mode: true, login: true });
      await cat(a, 'about');
      assert.ok((await panelText(a, 'about')).includes('Chrome'));
      assert.deepEqual(a.errors, []);
    } finally {
      await a.context.close();
    }
  });
