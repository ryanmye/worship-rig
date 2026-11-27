// E4: the JavaScript of the Mac app's --self-test (native/apple/Sources/Shared/RigSelfTest.swift), lifted out of the
// Swift raw strings and run under node, plus the migration fixture (native/apple/selftest/electron-backups) through
// the real store. The Swift around them is only built on the macOS CI runner; this is the part that runs here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createStore, memoryStorage, SCHEMA } from '../../../app/js/store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const swiftFile = path.join(root, 'native/apple/Sources/Shared/RigSelfTest.swift');
const swift = fs.readFileSync(swiftFile, 'utf8');
const fixtureDir = path.join(root, 'native/apple/selftest/electron-backups');
const AsyncFunction = (async () => {}).constructor;

/**
 * The body of `static let <name> = #"""…"""#`, dedented by the closing delimiter's indentation (Swift's rule).
 * @param {string} name @returns {string}
 */
function rawString(name) {
  const m = new RegExp(`static let ${name} = #"""\\n([\\s\\S]*?)\\n( *)"""#`).exec(swift);
  assert.ok(m, `${name} not found as a #"""…"""# raw string in RigSelfTest.swift`);
  const indent = m[2].length;
  return m[1].split('\n').map((l) => {
    const ok = l.trim() === '' || l.startsWith(' '.repeat(indent));
    assert.ok(ok, `${name}: a line is indented less than its closing """#`);
    return l.slice(indent);
  }).join('\n');
}

function swiftConst(name) {
  const m = new RegExp(`static let ${name} = "([^"]*)"`).exec(swift);
  assert.ok(m, `${name} not found`);
  return m[1];
}

/**
 * The fixture file RigBackups.latestAnywhere serves: the newest (mtime, then name: `newerFirst`; a git export gives
 * both the same mtime) that parses as a library. Mirrors `RigBackups.isLibrary` (review E5 open item 3).
 * @returns {string} file name
 */
function servedFixture() {
  const names = fs.readdirSync(fixtureDir).filter((f) => /^rig-\d{8}-\d{6}(-\d+)?\.json$/.test(f)).sort().reverse();
  for (const n of names) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(fixtureDir, n), 'utf8'));
    } catch {
      continue;
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.kind === 'song') continue;
    const songs = doc.songs && typeof doc.songs === 'object';
    if (!songs && doc.kind !== 'library') continue;
    if ('schema' in doc && !(typeof doc.schema === 'number' && doc.schema <= SCHEMA)) continue;
    return n;
  }
  return null;
}

function makeStore() {
  return createStore({ storage: memoryStorage(), requestIdle: null, warn: () => {}, autoFlush: false });
}

/** A window for the page hook: listeners, a console, optionally the rigSelfTest handler. */
function fakeWindow({ handler = true } = {}) {
  const posted = [];
  const listeners = {};
  const logged = [];
  const win = {
    console: { error: (...a) => logged.push(a), warn: () => {} },
    addEventListener: (type, fn, capture) => (listeners[type] ||= []).push({ fn, capture: !!capture }),
    webkit: handler ? { messageHandlers: { rigSelfTest: { postMessage: (m) => posted.push(m) } } } : undefined,
  };
  const fire = (type, ev) => (listeners[type] || []).forEach((l) => l.fn(ev));
  return { win, posted, listeners, logged, fire };
}

test('the Swift file has no interpolation or escapes inside the JS (raw strings only)', () => {
  for (const name of ['pageHook', 'bootProbe', 'importProbe', 'packsProbe']) {
    const body = rawString(name);
    assert.ok(!body.includes('"""'), name);
    const compile = () => (name === 'pageHook' ? new Function('window', body)
      : new AsyncFunction('timeoutMs', 'marker', ...(name === 'packsProbe' ? ['phase'] : []), body));
    assert.doesNotThrow(compile, name);
  }
});

test('pageHook: console.error, uncaught errors, resource errors, rejections and CSP are counted and posted', () => {
  const { win, posted, listeners, logged, fire } = fakeWindow();
  new Function('window', rawString('pageHook'))(win);
  assert.ok(win.__rigSelfTest, 'state object installed');
  assert.equal(listeners.error[0].capture, true, 'error listener in the capture phase (resource errors do not bubble)');

  win.console.error('engine', { a: 1 }, new Error('boom'));
  assert.equal(logged.length, 1, 'the original console.error still runs');
  const uncaught = { target: win, message: 'ReferenceError: x is not defined', filename: 'rig://app/js/main.js' };
  fire('error', { ...uncaught, lineno: 7 });
  fire('error', { target: { src: 'rig://app/js/missing.js' } });
  fire('unhandledrejection', { reason: new Error('nope') });
  fire('securitypolicyviolation', { violatedDirective: 'script-src', blockedURI: 'https://example.invalid/x.js' });

  assert.equal(win.__rigSelfTest.count, 5);
  assert.deepEqual(posted.map((p) => p.kind), ['console.error', 'error', 'resource', 'unhandledrejection', 'csp']);
  assert.match(posted[0].text, /^engine \{"a":1\} Error: boom/);
  assert.match(posted[1].text, /ReferenceError: x is not defined @ rig:\/\/app\/js\/main\.js:7/);
  assert.equal(posted[2].text, 'rig://app/js/missing.js');
  assert.match(posted[3].text, /nope/);
  assert.equal(posted[4].text, 'script-src https://example.invalid/x.js');
  assert.ok(posted.every((p) => p.text.length <= 400));
});

test('pageHook: inert without the rigSelfTest handler (the normal app) and installs once', () => {
  const plain = fakeWindow({ handler: false });
  const before = plain.win.console.error;
  new Function('window', rawString('pageHook'))(plain.win);
  assert.equal(plain.win.__rigSelfTest, undefined);
  assert.equal(plain.win.console.error, before, 'console.error untouched');
  assert.equal(Object.keys(plain.listeners).length, 0);

  const t = fakeWindow();
  const hook = new Function('window', rawString('pageHook'));
  hook(t.win);
  hook(t.win); // a second injection (reload into the same window object) must not double-count
  t.win.console.error('once');
  assert.equal(t.posted.length, 1);
  assert.equal(t.listeners.error.length, 1);
});

test('pageHook: a huge or unprintable argument cannot break console.error', () => {
  const { win, posted } = fakeWindow();
  new Function('window', rawString('pageHook'))(win);
  const cyclic = {};
  cyclic.self = cyclic;
  win.console.error('x'.repeat(5000), cyclic);
  assert.equal(posted.length, 1);
  assert.ok(posted[0].text.length <= 400);
});

const probe = (name, args) => {
  const body = rawString(name);
  return (win) => new AsyncFunction('window', 'document', 'navigator', ...Object.keys(args), body)(
    win, { visibilityState: 'visible' }, { userAgent: 'node-test' }, ...Object.values(args));
};

test('bootProbe: describes a booted page (real store, a BridgeEngine-named engine)', async () => {
  class BridgeEngine {}
  const store = makeStore();
  const win = { __rig: { ready: Promise.resolve(), store, engine: new BridgeEngine() } };
  const out = JSON.parse(await probe('bootProbe', { timeoutMs: 2000 })(win));
  assert.equal(out.phase, 'ok');
  assert.equal(out.readyError, null);
  assert.equal(out.store, true);
  assert.equal(out.schema, SCHEMA);
  assert.equal(out.schema, 2, 'the self-test checks schema 2 (CLAUDE.md: SCHEMA = 2)');
  assert.ok(out.songs > 0, 'factory songs seeded');
  assert.equal(out.pristine, true);
  assert.ok(['ok', 'fresh'].includes(out.loadStatus), out.loadStatus);
  assert.equal(out.engineKind, 'BridgeEngine');
  assert.equal(out.visibility, 'visible');
});

test('bootProbe: a rejected __rig.ready, a page that never sets __rig, and a ready that never settles', async () => {
  const rej = { __rig: { ready: Promise.reject(new Error('audio start failed')), store: makeStore(), engine: {} } };
  rej.__rig.ready.catch(() => {});
  const a = JSON.parse(await probe('bootProbe', { timeoutMs: 2000 })(rej));
  assert.equal(a.phase, 'rejected');
  assert.equal(a.readyError, 'audio start failed');
  assert.equal(a.engineKind, 'Object', 'a Web Audio / plain engine is told apart from BridgeEngine');

  const t0 = Date.now();
  const b = JSON.parse(await probe('bootProbe', { timeoutMs: 300 })({}));
  assert.equal(b.phase, 'no-__rig');
  assert.ok(Date.now() - t0 < 2000);

  const never = { __rig: { ready: new Promise(() => {}), store: null } };
  const c = JSON.parse(await probe('bootProbe', { timeoutMs: 300 })(never));
  assert.equal(c.phase, 'timeout');
  assert.equal(c.store, false);
});

test('fixture: a 1.x Electron rotation backup that RigBackups accepts', () => {
  const files = fs.readdirSync(fixtureDir).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(files, ['rig-20261101-120000.json', 'rig-20261201-120000.json']);
  // RigBackups.nameRE and origin(of:) in RigLibrary.swift
  for (const f of files) assert.match(f, /^rig-\d{8}-\d{6}(-\d+)?\.json$/);
  assert.equal(servedFixture(), files[0], 'the good, older file is the one latestAnywhere serves');
  const text = fs.readFileSync(path.join(fixtureDir, files[0]), 'utf8');
  const m = /^\{"origin":"([^"]+)"/.exec(text.slice(0, 200));
  assert.equal(m && m[1], 'http://127.0.0.1:8438');
  const doc = JSON.parse(text);
  assert.equal(doc.schema, 1, 'a schema-1 (1.x) library, so the import also runs migrate()');
  for (const id of doc.songOrder) assert.equal(doc.songs[id].patch.slots.length, 4, '1.x songs have 4 slots');
  assert.ok(text.length < 16 * 1024 * 1024, 'RigBackups.maxBytes');
});

test('migration: the fixture through store.importJSON (as importLatestBackup does), then importProbe', async () => {
  const marker = swiftConst('defaultMarker');
  const file = servedFixture();
  const text = fs.readFileSync(path.join(fixtureDir, file), 'utf8');
  const store = makeStore();
  const win = { __rig: { store } };

  const before = JSON.parse(await probe('importProbe', { marker, timeoutMs: 150 })(win));
  assert.equal(before.hit, false, 'the factory library does not have the marker song');
  assert.equal(before.pristine, true);

  const r = store.importJSON(text, { replace: true });
  assert.equal(r.ok, true, r.error);
  const after = JSON.parse(await probe('importProbe', { marker, timeoutMs: 1000 })(win));
  assert.equal(after.hit, true);
  assert.equal(after.schema, 2, 'migrated to SCHEMA 2');
  assert.equal(after.songs, 2);
  assert.equal(after.pristine, false);
  assert.ok(after.generation >= 1);
  const st = store.get();
  for (const id of st.songOrder) assert.equal(st.songs[id].patch.slots.length, 4, 'schema-1 songs keep their 4 slots');
  assert.equal(st.setlistOrder.length, 1);
});

test('fixture (review E5 item 3): the newer rotation file is truncated; served, it would fail the migration step',
  () => {
    const newest = fs.readdirSync(fixtureDir).filter((f) => f.endsWith('.json')).sort().at(-1);
    assert.notEqual(newest, servedFixture());
    const text = fs.readFileSync(path.join(fixtureDir, newest), 'utf8');
    assert.throws(() => JSON.parse(text), SyntaxError, 'not JSON: the Swift JSONSerialization check skips it');
    const good = fs.readFileSync(path.join(fixtureDir, servedFixture()), 'utf8');
    assert.ok(good.startsWith(text), 'a cut-off copy of the good file (a write interrupted half-way)');
    const store = makeStore();
    const r = store.importJSON(text, { replace: true });
    assert.equal(r.ok, false, 'importLatestBackup would refuse it, and the marker would never arrive');
    assert.equal(store.pristine, true);
  });

test('RigBackups constants track the JS side: maxSchema = store SCHEMA, keepLibrary = main.js BACKUPS_KEEP', () => {
  const lib = fs.readFileSync(path.join(root, 'native/apple/Sources/Shared/RigLibrary.swift'), 'utf8');
  const num = (name) => Number((new RegExp(`static let ${name} = (\\d+)`).exec(lib) || [])[1]);
  assert.equal(num('maxSchema'), SCHEMA);
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.equal(num('keepLibrary'), Number(/const BACKUPS_KEEP = (\d+);/.exec(main)[1]));
  assert.match(lib, /prune\(dir, prefix: nil, keep: keepLibrary\)/);
});

test('importProbe: waits for the import to land', async () => {
  const marker = swiftConst('defaultMarker');
  const file = servedFixture();
  const text = fs.readFileSync(path.join(fixtureDir, file), 'utf8');
  const store = makeStore();
  setTimeout(() => store.importJSON(text, { replace: true }), 250);
  const out = JSON.parse(await probe('importProbe', { marker, timeoutMs: 3000 })({ __rig: { store } }));
  assert.equal(out.hit, true);
});

test('packsProbe (lane N1): its pack files are valid songs; Rescan, Song bank and Add to library on the real store',
  async () => {
    const store = makeStore();
    const out = JSON.parse(await probe('packsProbe', { phase: 'export', timeoutMs: 2000 })({
      __rig: { store, controller: { rescanPatchPacks() {} } },
    }));
    assert.deepEqual(Object.keys(out.files).sort(), ['N1 Auto \u00c4/songs/auto song.json', 'N1 Bank/pack.json',
      'N1 Bank/songs/bank 1.json', 'N1 Bank/songs/bank 2.json']);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-selftest-packs-'));
    try {
      for (const [rel, text] of Object.entries(out.files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), text);
      }
      // the reference scanner (rig_hostkit, which the Mac app runs, matches it byte for byte: test/unit/hostkit)
      const { scanUserPatches } = createRequire(import.meta.url)(path.join(root, 'server.js'));
      let entries = [];
      let errors = [];
      const bank = () => entries.filter((e) => e.mode === 'bank')
        .map((e) => ({ packId: e.packId, title: (e.bank && e.bank.title) || e.song.name }));
      const controller = {
        async rescanPatchPacks() {
          const j = JSON.parse(JSON.stringify(await scanUserPatches([dir])));
          entries = j.patches;
          errors = j.errors;
          return { ...store.topUpPacks(entries), errors };
        },
        patchPacks: () => ({ songs: entries.length, packs: 2, bankSongs: bank().length, bank: bank(), errors }),
        addFromBank: (id) => store.addPackSong(entries.find((e) => e.packId === id)),
      };
      const fetch = async () => ({ ok: true, json: async () => ({ userPatches: true, features: ['user-patches'] }) });
      const r = JSON.parse(await probe('packsProbe', { phase: 'check', timeoutMs: 2000 })({
        __rig: { store, controller }, fetch,
      }));
      assert.deepEqual([r.userPatches, r.songs, r.bankSongs, r.autoInLibrary, r.addOk, r.addedName, r.errors],
        [true, 3, 2, true, true, 'N1 bank one', []]);
      assert.deepEqual(r.bank.sort(), ['N1 bank one', 'N1 bank two']);
      assert.equal(r.added, 1, 'the auto song, once');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
