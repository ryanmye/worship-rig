// Lane N0, in the real 2.0 app (app/index.html, headless Chromium) as the native shell runs it: the bridge engine over
// MockNative (?engine=bridge-mock, main.js served with the engine import swapped, as RigSchemeHandler does), Web MIDI
// removed (WKWebView has none), and window.rig from the REAL app/js/native-shell files, injected at document start
// the way RigShellScripts does (test/unit/native-shell/fake-shell.mjs), over a fake webkit.messageHandlers.rigShell.
// Checks: the flags and the merged __rigShell after boot; Settings without Chrome wording (About, Library & Backup,
// the Menu-bar section and the mini-panel button: LaneR O1), a Mac category once a Mac-only feature exists (the remote
// lane's Settings › Mac › Remote, D45, is the first), Back
// up now through the shell, the v6 summaries; iPad wording; the shell's files are never requested; zero
// console.error, no HTTP >= 400. Chrome (no window.rig) keeps its copy.
// Lane N3 (B2, n0-skeptic O1): every export goes through rig.saveText (or the <a download> listener), never a
// download or a page load, and a recording running meanwhile is not stopped; Import… reads a picked file; Chrome
// still downloads.
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
  window.__shell = { calls: [], backups: [], saves: [],
    remote: { on: false, port: 0, code: '123456', paired: 0, pausedSec: 0, addresses: [], url: null, pairUrl: null,
      qr: null } };
  const handlers = {
    getInfo: () => info,
    backupNow: (b) => {
      window.__shell.backups.push(b);
      return { path: `${info.backupsDir}/rig-20261127-120000.json` };
    },
    latestBackup: () => ({ error: 'no backup found' }),
    // remote lane (D45): RigBus (the command bus + the browser remote), as rig_remote_info_json answers
    busPublish: (b) => {
      window.__shell.states = (window.__shell.states || 0) + 1;
      return JSON.parse(b.json).v === 1 ? { ok: true } : { error: 'v must be 1' };
    },
    remoteInfo: () => window.__shell.remote,
    remoteSetEnabled: (b) => {
      const r = window.__shell.remote;
      Object.assign(r, b.on ? { on: true, port: 8450, pairingSec: 300, url: 'http://192.168.1.20:8450/',
        pairUrl: `http://192.168.1.20:8450/#p=${r.code}`, qr: { size: 21, modules: '1'.repeat(7) + '0'.repeat(434) },
        addresses: [{ name: 'en0', ip: '192.168.1.20' }] } : { on: false, port: 0, url: null, qr: null, addresses: [] });
      return r;
    },
    remoteNewCode: () => Object.assign(window.__shell.remote, { code: '654321' }),
    remoteForgetAll: () => Object.assign(window.__shell.remote, { paired: 0 }),
    // lane N3: RigFiles (the Mac's save panel; here the user always picks the suggested name)
    saveFile: (b) => {
      window.__shell.saves.push(b);
      const next = window.__shell.nextSave; // n3-skeptic F1: one scripted answer (a Cancel)
      if (next) {
        window.__shell.nextSave = null;
        return next;
      }
      return { saved: true, name: b.name, path: `/Users/ryan/Desktop/${b.name}` };
    },
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
/** An export's JSON without its `exportedAt` stamp (two exports a few ms apart differ only there). */
const unstamped = (text) => {
  const o = JSON.parse(text);
  delete o.exportedAt;
  return o;
};
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

      // remote lane (D45): the browser remote is the native app's first Mac-only feature, so the Mac category exists
      // and the Low-resource section moves there (settings.js macCat), still without menu-bar rows or the mini panel
      await t.test('a Mac category (Remote); it holds "Low-resource mode" without menu-bar rows or the mini panel',
        async () => {
          await openSettings(a);
          assert.ok((await tabIds(a)).includes('mac'), 'rig.remote is a Mac-only feature');
          await cat(a, 'mac');
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

      await t.test('remote lane: Settings › Mac › Remote: off by default, on shows address, QR and code, live info',
        async () => {
          await cat(a, 'mac');
          const q = (sel) => a.ev((x) => {
            const el = document.querySelector(`#view-settings [data-testid="${x}"]`);
            return el ? { hidden: !!el.closest('[hidden]'), text: el.textContent, pressed: el.getAttribute('aria-pressed'),
              disabled: !!el.disabled } : null;
          }, sel);
          await a.until(() => window.__shell.calls.includes('remoteInfo'));
          assert.equal((await q('setting-remote')).pressed, 'false', 'off by default (D34)');
          assert.equal((await q('remote-details')).hidden, true);
          await a.page.click('#view-settings [data-testid="setting-remote"]');
          await a.until(() => document.querySelector('#view-settings [data-testid="setting-remote"]')
            .getAttribute('aria-pressed') === 'true');
          assert.equal((await q('remote-details')).hidden, false);
          assert.match((await q('remote-url')).text, /open http:\/\/192\.168\.1\.20:8450\//);
          assert.equal((await q('remote-code')).text, 'Code 123456');
          assert.equal((await q('remote-window')).text, 'Phones can pair for 5:00.');
          assert.equal((await q('remote-paired')).text, '0 phones paired');
          assert.equal((await q('remote-forget')).disabled, true, 'nothing to forget');
          const qr = await a.ev(() => {
            const c = document.querySelector('#view-settings [data-testid="remote-qr"]');
            return { w: c.width, hidden: c.hidden, px: Array.from(c.getContext('2d').getImageData(16, 16, 1, 1).data) };
          });
          assert.deepEqual(qr, { w: (21 + 8) * 4, hidden: false, px: [0, 0, 0, 255] }, 'the first dark module');
          // the shell pushes a change (a phone paired)
          await a.ev(() => window.__rigShell.remoteInfo(JSON.stringify({ ...window.__shell.remote, paired: 2 })));
          await a.until(() => /2 phones/.test(document.querySelector('#view-settings [data-testid="remote-paired"]')
            .textContent));
          await a.page.click('#view-settings [data-testid="remote-new-code"]');
          await a.until(() => /654321/.test(document.querySelector('#view-settings [data-testid="remote-code"]')
            .textContent));
          await a.page.click('#view-settings [data-testid="setting-remote"]');
          await a.until(() => document.querySelector('#view-settings [data-testid="setting-remote"]')
            .getAttribute('aria-pressed') === 'false');
          assert.equal((await q('remote-details')).hidden, true);
          assert.deepEqual((await a.ev(() => window.__shell.calls)).filter((m) => /^remote/.test(m)),
            ['remoteInfo', 'remoteSetEnabled', 'remoteNewCode', 'remoteSetEnabled']);
          assert.ok((await a.ev(() => window.__shell.states)) > 0, 'the controller publishes through rig.busPublish');
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
        assert.ok((await tabIds(a)).includes('mac'), 'remote lane (D45): Mac › Remote');
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
      // lane N3: Export library is still a browser download in Chrome, the store's text byte for byte
      await cat(a, 'library');
      const want = await a.ev(() => window.__rig.store.exportJSON());
      const [dl] = await Promise.all([a.page.waitForEvent('download', { timeout: 15000 }),
        a.page.click('#view-settings .st-export')]);
      assert.match(dl.suggestedFilename(), /^Worship Rig library \d{4}-\d{2}-\d{2}\.json$/);
      assert.deepEqual(unstamped(fs.readFileSync(await dl.path(), 'utf8')), unstamped(want));
      assert.deepEqual(a.errors, []);
    } finally {
      await a.context.close();
    }
  });

test('B2 (lane N3): exports during a recording go through rig.saveText: no download, no page load, the take runs on; '
  + 'Import… reads the picked file', { timeout: 240000 }, async (t) => {
  const a = await openApp({ platform: 'macos' });
  const downloads = [];
  const loads = [];
  a.page.on('download', (d) => downloads.push(d.suggestedFilename()));
  a.page.on('framenavigated', (f) => {
    if (f === a.page.mainFrame()) loads.push(f.url());
  });
  const saves = () => a.ev(() => window.__shell.saves.map((b) => ({ name: b.name, text: b.text, base64: b.base64 })));
  const recOps = () => a.ev(() => window.__bridgeMock.received.filter((m) => m.op === 'rec').map((m) => m.action));
  try {
    const url0 = a.page.url();
    await a.ev(() => { window.__n3Marker = 'this page'; });

    await t.test('a recording runs (NativeRecorder over MockNative)', async () => {
      await a.ev(() => window.__rig.controller.record());
      await a.until(() => window.__rigShell.recording() === true);
      assert.deepEqual(await recOps(), ['start']);
    });

    await t.test('Settings › Export library → saveFile with the library text', async () => {
      await openSettings(a);
      await cat(a, 'library');
      const want = await a.ev(() => window.__rig.store.exportJSON());
      await a.page.click('#view-settings .st-export');
      await a.until(() => window.__shell.saves.length === 1);
      const [s0] = await saves();
      assert.match(s0.name, /^Worship Rig library \d{4}-\d{2}-\d{2}\.json$/);
      assert.deepEqual(unstamped(s0.text), unstamped(want));
      await a.page.locator('#view-settings .st-close').first().click();
      await a.until(() => !document.querySelector('#view-settings.open'));
    });

    await t.test('Edit › Library file: Export library and Export song', async () => {
      await a.ev(() => window.__rig.ctx.setView('edit'));
      await a.until(() => !!document.querySelector('[data-file="export-song"]'));
      const song = await a.ev(() => {
        const s = window.__rig.store.currentSong();
        return { name: s.name, text: window.__rig.store.exportSong(s.id) };
      });
      await a.ev(() => document.querySelector('[data-file="export"]').click());
      await a.ev(() => document.querySelector('[data-file="export-song"]').click());
      await a.until(() => window.__shell.saves.length === 3);
      await a.ev(() => window.__rig.ctx.setView('perform'));
      const [, lib, one] = await saves();
      assert.match(lib.name, /^Worship Rig library .*\.json$/);
      assert.equal(JSON.parse(lib.text).schema, 2);
      assert.match(one.name, /\.rig-song\.json$/);
      assert.deepEqual(unstamped(one.text), unstamped(song.text));
    });

    await t.test('the v6 song menu: Export this song…', async () => {
      await a.ev(() => window.__rig.store.set('settings.uiV6', true));
      await a.until(() => !!document.querySelector('[data-testid="v6-songmenu-btn"]'));
      await a.page.click('[data-testid="v6-songmenu-btn"]');
      await a.until(() => !!document.querySelector('[data-testid="v6-songmenu"]'));
      await a.page.click('[data-testid="v6-sm-export"]');
      await a.until(() => window.__shell.saves.length === 4);
      const s3 = (await saves())[3];
      assert.match(s3.name, /\.rig-song\.json$/);
      assert.equal(JSON.parse(s3.text).kind, 'song');
      await a.until(() => [...document.querySelectorAll('.toast')].some((x) => /Exported/.test(x.textContent)));
    });

    await t.test('n3-skeptic F1: Cancel in the save panel → saveFile answered {canceled}, no "Exported" toast',
      async () => {
        await a.ev(() => {
          window.__shell.nextSave = { canceled: true };
          window.__n3Toasts = [];
          window.__n3Obs = new MutationObserver((ms) => {
            for (const m of ms) {
              const at = m.target.nodeType === 1 ? m.target : m.target.parentElement;
              const el = at?.closest?.('.toast') || [...m.addedNodes].find((n) => n.classList?.contains('toast'));
              if (el) window.__n3Toasts.push(el.textContent);
            }
          });
          window.__n3Obs.observe(document.body, { subtree: true, childList: true, characterData: true });
        });
        await a.page.click('[data-testid="v6-songmenu-btn"]');
        await a.until(() => !!document.querySelector('[data-testid="v6-songmenu"]'));
        await a.page.click('[data-testid="v6-sm-export"]');
        await a.until(() => window.__shell.saves.length === 5);
        await a.page.waitForTimeout(400);
        const seen = await a.ev(() => {
          window.__n3Obs.disconnect();
          return window.__n3Toasts;
        });
        assert.ok(!seen.some((x) => /Exported/.test(x)), `toasts after a Cancel: ${JSON.stringify(seen)}`);
      });

    await t.test('any other <a download> on blob: / data: (as recorder.js downloadBlob) is taken over', async () => {
      await a.ev(() => {
        const click = (href, name) => {
          const x = document.createElement('a');
          x.href = href;
          x.download = name;
          document.body.append(x);
          x.click();
          x.remove();
        };
        click(URL.createObjectURL(new Blob([new Uint8Array([82, 73, 70, 70, 0, 255])], { type: 'audio/wav' })),
          'Rig take.wav');
        click('data:application/json,%7B%22a%22%3A1%7D', 'tiny.json');
      });
      await a.until(() => window.__shell.saves.length === 7);
      // each read is async (text vs arrayBuffer): the order of the two saves is not the order of the clicks
      const [wav, tiny] = (await saves()).slice(5).sort((x, y) => (x.name < y.name ? -1 : 1));
      assert.deepEqual(wav, { name: 'Rig take.wav', text: undefined, base64: 'UklGRgD/' });
      assert.deepEqual(tiny, { name: 'tiny.json', text: '{"a":1}', base64: undefined });
    });

    await t.test('nothing downloaded, the page never left, the recording was never stopped', async () => {
      await new Promise((r) => setTimeout(r, 500)); // a late download / navigation would show by now
      assert.deepEqual(downloads, []);
      assert.deepEqual(loads.filter((u) => !u.startsWith(url0.split('?')[0])), [], 'no main-frame load elsewhere');
      assert.equal(await a.ev(() => window.__n3Marker), 'this page');
      assert.equal(await a.ev(() => window.__rigShell.recording()), true);
      assert.deepEqual(await recOps(), ['start'], 'no rec stop reached the engine');
      await a.ev(() => window.__rig.controller.record());
      await a.until(() => window.__rigShell.recording() === false);
      assert.deepEqual(await recOps(), ['start', 'stop'], 'the check sees a stop when there is one');
    });

    await t.test('Settings › Import… reads the picked file (the song exported above comes back as a copy)',
      async () => {
        await a.ev(() => window.__rig.store.set('settings.uiV6', false));
        const one = (await saves())[2];
        const n0 = await a.ev(() => window.__rig.store.get().songOrder.length);
        await openSettings(a);
        await cat(a, 'library');
        const [chooser] = await Promise.all([a.page.waitForEvent('filechooser', { timeout: 15000 }),
          a.page.click('#view-settings .st-import')]);
        await chooser.setFiles({ name: one.name, mimeType: 'application/json', buffer: Buffer.from(one.text) });
        await a.until((n) => window.__rig.store.get().songOrder.length === n + 1, n0);
        await a.until(() => [...document.querySelectorAll('.toast')]
          .some((x) => /Imported 1 song/.test(x.textContent)));
      });

    assert.deepEqual(a.errors, []);
  } finally {
    await a.context.close();
  }
});
