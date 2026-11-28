// Lane N3 (B2): app/js/native-shell/30-files.js in a vm the way RigShellScripts injects it, over a fake rigShell.
// rig.saveText's call shape, and the window click listener that takes over every <a download> on a blob: / data:
// URL (its default prevented, so WKWebView never starts a navigation; the content saved through `saveFile`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadShell, fakeHandler, plain } from './fake-shell.mjs';

const SWIFT_FILES = path.join(ROOT, 'native/apple/Sources/Shared/RigFiles.swift');
const settle = () => new Promise((r) => setTimeout(r, 20));

/** A window with click listeners, fetch over a URL → Blob table, btoa. */
function filesWindow({ saveFile = () => ({ saved: true, name: 'x' }), blobs = {} } = {}) {
  const handler = fakeHandler({ saveFile });
  const listeners = [];
  const fetched = [];
  const s = loadShell({
    handler,
    pre: (w) => {
      w.addEventListener = (type, fn, capture) => listeners.push({ type, fn, capture });
      w.btoa = (x) => Buffer.from(x, 'latin1').toString('base64');
      w.fetch = (href) => {
        fetched.push(href);
        if (!(href in blobs)) return Promise.reject(new TypeError('Failed to fetch'));
        return Promise.resolve({ blob: () => Promise.resolve(blobs[href]) });
      };
    },
  });
  /** Dispatches a click whose composed path is `nodes` (target first) to the capture listeners. */
  const click = (...nodes) => {
    const ev = {
      defaultPrevented: false, target: nodes[0],
      composedPath: () => nodes, preventDefault() { this.defaultPrevented = true; },
    };
    for (const l of listeners) if (l.type === 'click') l.fn(ev);
    return ev;
  };
  return { ...s, listeners, fetched, click };
}

/** A fake element. */
function el(tag, attrs = {}, href) {
  return {
    nodeType: 1, tagName: tag.toUpperCase(), href,
    hasAttribute: (n) => n in attrs, getAttribute: (n) => (n in attrs ? attrs[n] : null),
  };
}

test('saveText: one saveFile call with the name and the text; the reply comes back as is', async () => {
  const { win, handler } = filesWindow({ saveFile: (b) => ({ saved: true, name: b.name, path: `/Users/r/${b.name}` }) });
  assert.equal(typeof win.rig.saveText, 'function');
  const r = await win.rig.saveText('Worship Rig library 2026-11-27.json', '{"schema":2}');
  assert.deepEqual(plain(r), { saved: true, name: 'Worship Rig library 2026-11-27.json',
    path: '/Users/r/Worship Rig library 2026-11-27.json' });
  await win.rig.saveText(null, 42);
  assert.deepEqual(plain(handler.calls), [
    { name: 'Worship Rig library 2026-11-27.json', text: '{"schema":2}', m: 'saveFile' },
    { name: '', text: '42', m: 'saveFile' },
  ]);
});

test('saveText: canceled and error replies pass through; no handler answers {error}', async () => {
  const c = filesWindow({ saveFile: () => ({ canceled: true }) });
  assert.deepEqual(plain(await c.win.rig.saveText('a.json', 'x')), { canceled: true });
  const e = filesWindow({ saveFile: () => ({ error: 'busy' }) });
  assert.deepEqual(plain(await e.win.rig.saveText('a.json', 'x')), { error: 'busy' });
  const none = loadShell({ handler: null, pre: (w) => { w.addEventListener = () => {}; } }).win;
  assert.deepEqual(plain(await none.rig.saveText('a.json', 'x')), { error: 'shell unavailable' });
});

test('one capture listener on window for click; injected twice it is still one', () => {
  const s = filesWindow();
  assert.deepEqual(s.listeners.map((l) => [l.type, l.capture]), [['click', true]]);
  const save = s.win.rig.saveText;
  s.run();
  assert.equal(s.listeners.length, 1);
  assert.equal(s.win.rig.saveText, save);
});

test('a blob: <a download> click is taken over: default prevented, the JSON text saved under its name', async () => {
  const href = 'blob:rig://app/0b5e';
  const s = filesWindow({ blobs: { [href]: new Blob(['{"kind":"song","é":1}'], { type: 'application/json' }) } });
  const a = el('a', { download: 'Amazing Grace.rig-song.json', href }, href);
  const ev = s.click(a, el('body'));
  assert.equal(ev.defaultPrevented, true, 'WebKit must never see this click');
  await settle();
  assert.deepEqual(s.fetched, [href], 'read at once (before any revokeObjectURL)');
  assert.deepEqual(plain(s.handler.calls), [{ name: 'Amazing Grace.rig-song.json', text: '{"kind":"song","é":1}',
    m: 'saveFile' }]);
});

test('a click on a child of the anchor; a data: URL; text/* types go as text', async () => {
  const href = 'data:text/plain;charset=utf-8,hi%20there';
  const s = filesWindow({ blobs: { [href]: new Blob(['hi there'], { type: 'text/plain;charset=utf-8' }) } });
  const a = el('a', { download: 'notes.txt' }, href);
  const ev = s.click(el('span'), a, el('body'));
  assert.equal(ev.defaultPrevented, true);
  await settle();
  assert.deepEqual(plain(s.handler.calls), [{ name: 'notes.txt', text: 'hi there', m: 'saveFile' }]);
});

test('binary (a WAV, an untyped blob) goes as base64, byte for byte; an empty download attribute names it', async () => {
  const bytes = Uint8Array.from({ length: 70000 }, (_, i) => (i * 37) & 255);
  const s = filesWindow({ blobs: {
    'blob:rig://app/w': new Blob([bytes], { type: 'audio/wav' }),
    'blob:rig://app/u': new Blob([Uint8Array.of(0, 255, 1)]),
  } });
  s.click(el('a', { download: 'Rig 2026-11-27 1015.wav' }, 'blob:rig://app/w'));
  s.click(el('a', { download: '' }, 'blob:rig://app/u'));
  await settle();
  const [wav, untyped] = s.handler.calls;
  assert.equal(wav.name, 'Rig 2026-11-27 1015.wav');
  assert.equal(wav.text, undefined);
  assert.deepEqual(Buffer.from(wav.base64, 'base64'), Buffer.from(bytes));
  assert.deepEqual(plain(untyped), { name: 'download', base64: 'AP8B', m: 'saveFile' });
});

test('left alone: links without download, http(s) / rig:// downloads, clicks already prevented, non-anchors',
  async () => {
    const s = filesWindow({ blobs: { 'blob:rig://app/1': new Blob(['x'], { type: 'text/plain' }) } });
    const cases = [
      [el('a', {}, 'blob:rig://app/1')],
      [el('a', { download: 'x.json' }, 'https://example.com/x.json')],
      [el('a', { download: 'x.json' }, 'rig://app/docs/x.json')],
      [el('button', { download: 'x' })],
      [{ nodeType: 3 }, el('div')],
    ];
    for (const c of cases) assert.equal(s.click(...c).defaultPrevented, false, JSON.stringify(c[0].href || c[0]));
    const pre = { defaultPrevented: true, composedPath: () => [el('a', { download: 'x' }, 'blob:rig://app/1')],
      preventDefault() { throw new Error('not again'); } };
    s.listeners[0].fn(pre);
    await settle();
    assert.deepEqual(s.handler.calls, []);
    assert.deepEqual(s.fetched, []);
  });

test('a read that fails or a refused save warns (never console.error) and resolves {error}', async () => {
  const s = filesWindow({ saveFile: () => ({ error: 'disk full' }),
    blobs: { 'blob:rig://app/ok': new Blob(['x'], { type: 'text/plain' }) } });
  s.click(el('a', { download: 'gone.json' }, 'blob:rig://app/revoked'));
  s.click(el('a', { download: 'full.json' }, 'blob:rig://app/ok'));
  await settle();
  const texts = s.warns.map((w) => String(w[0]));
  assert.equal(texts.length, 2, texts.join(' | '));
  assert.ok(texts.some((t) => /could not read gone\.json/.test(t)), texts.join(' | '));
  assert.ok(texts.some((t) => /could not save full\.json: disk full/.test(t)), texts.join(' | '));
});

test('not the native shell: no saveText, no listener (Chrome / Electron keep their <a download>)', () => {
  const listeners = [];
  const theirs = { isElectron: true };
  const s = loadShell({ pre: (w) => { w.rig = theirs; w.addEventListener = (...a) => listeners.push(a); } });
  assert.equal(s.win.rig.saveText, undefined);
  assert.deepEqual(listeners, []);
});

test('Swift side: RigFiles answers saveFile, caps at the same size, and reads text or base64', () => {
  const swift = fs.readFileSync(SWIFT_FILES, 'utf8');
  assert.match(swift, /let methods: \[String\] = \["saveFile"\]/);
  assert.match(swift, /static let maxBytes = 64 \* 1024 \* 1024/);
  const js = fs.readFileSync(path.join(ROOT, 'app/js/native-shell/30-files.js'), 'utf8');
  assert.match(js, /var MAX_BYTES = 64 \* 1024 \* 1024;/);
  assert.ok(swift.includes('body["text"] as? String') && swift.includes('body["base64"] as? String'));
});
