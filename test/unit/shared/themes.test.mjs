// themes-setup: the theme registry (app/js/shared/themes.js), its copy in the boot script (app/themes/boot.js), and
// settings.theme validation in the store. node --test test/unit/shared/themes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  THEMES, DEFAULT_THEME_ID, THEME_MIRROR_KEY, byId, isValidId, resolveThemeId, pickableThemes, themeAttrs,
} from '../../../app/js/shared/themes.js';
import { createStore, memoryStorage, STORAGE_KEY, SCHEMA } from '../../../app/js/store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const APP = path.join(ROOT, 'app');
const BOOT = fs.readFileSync(path.join(APP, 'themes', 'boot.js'), 'utf8');

/** Run boot.js in a fake page. @returns the fake document/window after the first include */
function runBoot({ stored = null, withBody = false, storageThrows = false } = {}) {
  const attrs = (o) => ({
    attrs: {},
    style: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    hasAttribute(k) { return k in this.attrs; },
    ...o,
  });
  const head = { children: [], appendChild(n) { this.children.push(n); return n; } };
  const body = attrs({});
  const doc = {
    documentElement: attrs({}),
    head,
    body: withBody ? body : null,
    listeners: {},
    createElement: (tag) => attrs({ tag, setAttribute(k, v) { this.attrs[k] = String(v); } }),
    getElementById: (id) => head.children.find((n) => n.id === id) || null,
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
  };
  const observers = [];
  const win = {
    document: doc,
    localStorage: { getItem: (k) => { if (storageThrows) throw new Error('blocked'); return k === THEME_MIRROR_KEY ? stored : null; } },
    MutationObserver: class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} disconnect() { this.off = true; } },
  };
  win.window = win;
  vm.runInNewContext(BOOT, win);
  return { win, doc, head, body, observers, runAgain: () => vm.runInNewContext(BOOT, win) };
}

test('registry: shape, unique ids, default registered and not coming, css files exist', () => {
  const ids = THEMES.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, ['classic', 'sanctuary', 'sanctuary-day', 'daylight-stage', 'daylight-day', 'studio', 'ember', 'nave']);
  assert.ok(isValidId(DEFAULT_THEME_ID) && !byId(DEFAULT_THEME_ID).coming);
  assert.equal(DEFAULT_THEME_ID, 'sanctuary');
  for (const t of THEMES) {
    assert.match(t.id, /^[a-z][a-z0-9-]*$/);
    assert.ok(t.name && typeof t.name === 'string');
    assert.ok(['light', 'dark'].includes(t.mode), t.id);
    assert.ok(t.family, t.id);
    for (const k of ['bg', 'panel', 'text', 'accent']) assert.match(t.swatch[k], /^#[0-9a-f]{6}$/, `${t.id}.${k}`);
    if (t.css === null) continue;
    assert.match(t.css, /^\/themes\/[a-z0-9-]+\/theme\.css$/, 'root-absolute /themes/<dir>/theme.css');
    assert.ok(fs.existsSync(path.join(APP, t.css)), `${t.css} exists`);
  }
  assert.equal(byId('classic').css, null);
  assert.equal(byId('sanctuary-day').coming, true);
  assert.ok(Object.isFrozen(THEMES) && Object.isFrozen(THEMES[1]) && Object.isFrozen(THEMES[1].swatch));
});

test('registry helpers: byId / isValidId / resolveThemeId / pickableThemes / themeAttrs', () => {
  assert.equal(byId('ember').name, 'Ember');
  assert.equal(byId('nope'), null);
  assert.equal(byId(undefined), null);
  assert.equal(isValidId('sanctuary-day'), true, 'coming themes are valid, only hidden');
  for (const bad of [undefined, null, '', 'Sanctuary', 'toString', '__proto__', 7, {}]) {
    assert.equal(isValidId(bad), false, String(bad));
    assert.equal(resolveThemeId(bad), DEFAULT_THEME_ID);
  }
  assert.equal(resolveThemeId('studio'), 'studio');
  assert.ok(!pickableThemes().some((t) => t.coming));
  assert.equal(pickableThemes().length, THEMES.length - 1);
  assert.deepEqual(themeAttrs('daylight-day'), {
    html: { theme: 'daylight-day', mode: 'light' }, body: { theme: 'daylight-v2', mode: 'day' },
    colorScheme: 'light', css: '/themes/daylight-v2/theme.css',
  });
  assert.deepEqual(themeAttrs('classic').body, { theme: 'classic', mode: 'dark' });
  assert.equal(themeAttrs('bogus').html.theme, DEFAULT_THEME_ID);
});

test('boot.js map stays in sync with the registry (id → css, mode, body shim; default; mirror key)', () => {
  const { win } = runBoot();
  const B = win.__rigThemeBoot;
  assert.ok(B, 'boot.js exposes window.__rigThemeBoot');
  assert.equal(B.def, DEFAULT_THEME_ID);
  assert.equal(B.key, THEME_MIRROR_KEY);
  assert.deepEqual(Object.keys(B.map).sort(), THEMES.map((t) => t.id).sort());
  for (const t of THEMES) {
    const m = B.map[t.id];
    assert.equal(m.css, t.css, `${t.id} css`);
    assert.equal(m.mode, t.mode, `${t.id} mode`);
    assert.deepEqual(m.body ? [...m.body] : null, t.body ? [t.body.theme, t.body.mode] : null, `${t.id} body shim`);
  }
});

test('boot.js: mirror → html attrs, color-scheme, preload, render-blocking link on the second include', () => {
  const r = runBoot({ stored: 'daylight-day' });
  const html = r.doc.documentElement;
  assert.equal(html.attrs['data-theme'], 'daylight-day');
  assert.equal(html.attrs['data-mode'], 'light');
  assert.equal(html.style.colorScheme, 'light');
  assert.equal(r.head.children.length, 1);
  assert.equal(r.head.children[0].rel, 'preload');
  r.runAgain(); // the include at the end of <head>
  const link = r.doc.getElementById('theme-css');
  assert.ok(link, 'link#theme-css');
  assert.equal(link.rel, 'stylesheet');
  assert.equal(link.href, '/themes/daylight-v2/theme.css');
  assert.equal(link.attrs.blocking, 'render');
  r.runAgain();
  assert.equal(r.head.children.filter((n) => n.id === 'theme-css').length, 1, 'idempotent');
  // body appears → legacy body attributes
  r.doc.body = r.body;
  r.observers[0].cb();
  assert.equal(r.body.attrs['data-theme'], 'daylight-v2');
  assert.equal(r.body.attrs['data-mode'], 'day');
});

test('boot.js: unknown / blocked mirror → default; classic links nothing; body present at once', () => {
  for (const opts of [{ stored: 'bogus' }, { stored: null }, { storageThrows: true }, { stored: 'constructor' }]) {
    const r = runBoot(opts);
    assert.equal(r.doc.documentElement.attrs['data-theme'], DEFAULT_THEME_ID, JSON.stringify(opts));
  }
  const c = runBoot({ stored: 'classic', withBody: true });
  c.runAgain();
  assert.equal(c.doc.getElementById('theme-css'), null);
  assert.equal(c.head.children.length, 0, 'no preload either');
  assert.equal(c.body.attrs['data-theme'], 'classic');
  assert.equal(c.body.attrs['data-mode'], 'dark');
  // one include only: the sheet still comes, at DOMContentLoaded (not render-blocking once <body> exists)
  const once = runBoot({ stored: 'ember' });
  once.doc.body = once.body;
  for (const fn of once.doc.listeners.DOMContentLoaded) fn();
  const l = once.doc.getElementById('theme-css');
  assert.equal(l.href, '/themes/ember/theme.css');
  assert.equal(l.attrs.blocking, undefined);
  assert.equal(once.body.attrs['data-theme'], 'ember');
});

test('both pages include boot.js first in <head> and again as the last element of <head>', () => {
  for (const f of ['index.html', 'mini.html']) {
    const html = fs.readFileSync(path.join(APP, f), 'utf8');
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
    const tags = [...head.matchAll(/<(script|link|title|meta)\b[^>]*>/g)].map((m) => m[0]);
    const boots = tags.map((t, i) => (/src="\.\/themes\/boot\.js"/.test(t) ? i : -1)).filter((i) => i >= 0);
    assert.equal(boots.length, 2, `${f}: two boot.js includes`);
    assert.ok(tags.slice(0, boots[0]).every((t) => /^<meta/.test(t)), `${f}: first include precedes every non-meta tag`);
    assert.equal(boots[1], tags.length - 1, `${f}: second include is the last tag of <head>`);
    assert.ok(!/<script[^>]*src="\.\/themes\/boot\.js"[^>]*type="module"/.test(head), 'classic script');
  }
});

test('store: settings.theme is optional, validated, falls back to the default, no schema bump', async () => {
  const mk = (settings) => createStore({
    storage: memoryStorage(settings ? { [STORAGE_KEY]: JSON.stringify({ schema: SCHEMA, songs: {}, setlists: {}, settings }) } : {}),
    warn: () => {}, requestIdle: null, autoFlush: false,
  });
  assert.equal(SCHEMA, 1);
  const s = mk();
  assert.equal('theme' in s.get().settings, false, 'absent by default');
  s.set('settings.theme', 'ember');
  assert.equal(s.get().settings.theme, 'ember');
  s.set('settings.theme', 'sanctuary-day');
  assert.equal(s.get().settings.theme, 'sanctuary-day', 'coming themes are storable');
  assert.doesNotThrow(() => s.set('settings.theme', 'no-such-theme'));
  assert.equal(s.get().settings.theme, DEFAULT_THEME_ID);
  s.set('settings.theme', 'studio');
  s.set('settings.theme.x', 1);
  assert.equal(s.get().settings.theme, 'studio', 'nested writes refused');
  // loaded libraries
  assert.equal(mk({ theme: 'nave' }).get().settings.theme, 'nave');
  assert.equal(mk({ theme: 'gone-theme' }).get().settings.theme, DEFAULT_THEME_ID);
  assert.equal(mk({ theme: 42 }).get().settings.theme, DEFAULT_THEME_ID);
  assert.equal('theme' in mk({ view: 'perform' }).get().settings, false);
});

test('store: picking a theme does not mark a fresh library as edited', () => {
  const s = createStore({ storage: memoryStorage(), warn: () => {}, requestIdle: null, autoFlush: false });
  assert.equal(s.get().meta.edited, false);
  s.set('settings.theme', 'ember');
  assert.equal(s.get().meta.edited, false, 'a look is not a library edit');
  s.set('settings.monoOutput', true);
  assert.equal(s.get().meta.edited, true, 'control: a real settings edit does count');
});

test('size budget: each registered theme (its folder + the /fonts files it names) is ≤ 250 KB', () => {
  const seen = new Set();
  for (const t of THEMES) {
    if (!t.css || seen.has(t.css)) continue;
    seen.add(t.css);
    const dir = path.join(APP, path.dirname(t.css));
    let bytes = 0;
    for (const f of fs.readdirSync(dir, { recursive: true })) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isFile()) bytes += fs.statSync(p).size;
    }
    const css = fs.readFileSync(path.join(APP, t.css), 'utf8');
    for (const m of css.matchAll(/url\(['"]?(\/fonts\/[^'")]+)/g)) {
      assert.ok(fs.existsSync(path.join(APP, m[1])), `${t.css}: ${m[1]} exists`);
      bytes += fs.statSync(path.join(APP, m[1])).size;
    }
    assert.ok(!/url\(['"]?\/themes\/[a-z0-9-]+\/fonts\//.test(css), `${t.css}: fonts come from /fonts`);
    assert.ok(bytes <= 250 * 1024, `${t.css}: ${(bytes / 1024).toFixed(0)} KB > 250 KB`);
  }
});
