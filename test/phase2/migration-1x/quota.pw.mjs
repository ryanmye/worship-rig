// D8/D9 skeptic (reviews/D8-D9.md): the kept-copy quota policy against real Chromium localStorage (~5.2 M
// characters per origin), not a stand-in. The 2.0 store module runs in a blank page of the app's origin.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT } from './lib.mjs';

const require = createRequire(import.meta.url);
const { createServer } = require(path.join(ROOT, 'server.js'));
let server;
let browser;
let origin;
before(async () => {
  server = createServer({ appDir: path.join(ROOT, 'app'), port: 0 });
  origin = `http://127.0.0.1:${(await server.listen()).port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  await server?.close();
});

async function blankPage() {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route(`${origin}/__quota.html`, (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>q</title>' }));
  await page.goto(`${origin}/__quota.html`);
  return { ctx, page, errors };
}

test('real Chromium quota: room comes only from earlier states of a kept library; a different library and the main key survive', { timeout: 300000 }, async () => {
  const { ctx, page, errors } = await blankPage();
  const r = await page.evaluate(async () => {
    const S = await import('/js/store.js');
    const K = `${S.STORAGE_KEY}.kept-`;
    let n = 0;
    const mem = () => S.createStore({ storage: S.memoryStorage(), seed: false, idGen: (p) => `${p}-${++n}`, requestIdle: null, warn: () => {}, autoFlush: false });
    const grow = (s, to, tag) => {
      // C-SHIP skeptic (O4 per D9): an add is refused only past LIBRARY_RESTORE_MAX_CHARS; fail here, never loop
      while (JSON.stringify(s.get()).length < to) {
        const id = s.addSong(null, { name: tag });
        if (!id) throw new Error(`grow(${tag}): addSong refused at ${JSON.stringify(s.get()).length} characters`);
        s.set(`songs.${id}.notes`, 'n'.repeat(10000));
      }
      return JSON.stringify(s.get());
    };
    // how much this origin holds (key + value characters)
    localStorage.clear();
    let quota = 0;
    for (let step = 1 << 23; step >= 1024; step >>= 1) {
      try {
        localStorage.setItem('probe', 'x'.repeat(quota + step));
        quota += step;
      } catch {
        /* too big: smaller step */
      }
    }
    localStorage.clear();
    const real = mem();
    const realOld = grow(real, 1700000, 'Real');
    const trivial = grow(mem(), 20000, 'Trivial');
    localStorage.setItem(`${K}1000.downgrade.s2`, realOld);
    localStorage.setItem(`${K}2000.downgrade.s2`, trivial);
    // the main library: the real one, grown on (a later state of realOld)
    localStorage.setItem(S.STORAGE_KEY, grow(real, 1900000, 'Real'));
    const s = S.createStore({ storage: localStorage, idGen: (p) => `${p}-${++n}`, requestIdle: null, warn: () => {}, autoFlush: false, debounceMs: 0 });
    const notices = [];
    s.onNotice((x) => notices.push(x.type));
    grow(s, 2300000, 'Real'); // D9: past the cap, still saved
    // C-SHIP skeptic: 100 blank songs (still inside the 2.5 M restore cap, so the adds go through) whose notes the
    // loop below fills in: a library grows past the restore cap only by edits
    const blanks = [];
    for (let i = 0; i < 100; i++) {
      const id = s.addSong(null, { name: `blank ${i}` });
      if (!id) return { addRefusedAt: JSON.stringify(s.get()).length };
      blanks.push(id);
    }
    const saved1 = s.persistNow();
    const keep1 = s.keepCurrent();
    const afterKeep1 = Object.keys(localStorage).filter((k) => k.startsWith(K)).sort();
    const keep2 = s.keepCurrent(); // no earlier state left to remove: refused, nothing removed
    const afterKeep2 = Object.keys(localStorage).filter((k) => k.startsWith(K)).sort();
    // grow until a save does not fit: every save before it is complete, the failed one leaves the last good one
    let mainBefore = localStorage.getItem(S.STORAGE_KEY);
    let saved2 = true;
    for (let i = 0; i < 100 && saved2; i++) {
      mainBefore = localStorage.getItem(S.STORAGE_KEY);
      // C-SHIP skeptic: grown by edits (D9: saves past the cap), giving the blank songs their notes; new songs stop at
      // the 2.5 M restore cap (O4 per D9), which comes before this origin's quota does
      for (let j = 0; j < 5; j++) {
        const id = blanks.shift();
        if (!id) return { outOfBlanks: true };
        s.set(`songs.${id}.notes`, 'm'.repeat(10000));
      }
      saved2 = s.persistNow();
      if (saved2 && localStorage.getItem(S.STORAGE_KEY) !== JSON.stringify(s.get())) return { torn: true };
    }
    const mainAfter = localStorage.getItem(S.STORAGE_KEY);
    const reopened = S.createStore({ storage: localStorage, requestIdle: null, warn: () => {}, autoFlush: false });
    const used = Object.keys(localStorage).reduce((m, k) => m + k.length + localStorage.getItem(k).length, 0);
    s.dispose?.();
    return {
      quota, saved1, keep1: keep1.ok, afterKeep1, keep2: keep2.ok, afterKeep2, saved2,
      mainUnchanged: mainAfter === mainBefore, reopenedSongs: reopened.get().songOrder.length,
      mainSongs: JSON.parse(mainBefore).songOrder.length,
      trivialKept: localStorage.getItem(`${K}2000.downgrade.s2`) === trivial,
      realOldGone: localStorage.getItem(`${K}1000.downgrade.s2`) === null, notices, used,
    };
  });
  console.log(JSON.stringify({ ...r, afterKeep1: r.afterKeep1.length, afterKeep2: r.afterKeep2.length }));
  assert.ok(r.quota > 4500000, `quota ${r.quota}`);
  assert.equal(r.saved1, true, 'the 2.3 M library is saved (D9)');
  assert.equal(r.keep1, true, 'a copy is kept by removing the earlier state of the same library');
  assert.equal(r.realOldGone, true);
  assert.equal(r.trivialKept, true, 'the different (trivial) library is never removed');
  assert.equal(r.keep2, false, 'nothing else may go: refused');
  assert.deepEqual(r.afterKeep2, r.afterKeep1, 'and nothing was removed trying');
  assert.equal(r.saved2, false, 'a save that cannot fit fails');
  assert.equal(r.mainUnchanged, true, 'the main key is untouched by the failed save');
  assert.equal(r.reopenedSongs, r.mainSongs, 'and it loads');
  assert.ok(r.notices.includes('library-size') && r.notices.includes('kept-removed'), r.notices.join());
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('real Chromium quota: restoring a 2.47 M copy over an edited library (kept first) fits, and survives a reload', { timeout: 300000 }, async () => {
  const { ctx, page, errors } = await blankPage();
  const r = await page.evaluate(async () => {
    const S = await import('/js/store.js');
    const K = `${S.STORAGE_KEY}.kept-`;
    let n = 0;
    localStorage.clear();
    const big = S.createStore({ storage: S.memoryStorage(), seed: false, idGen: (p) => `${p}-${++n}`, requestIdle: null, warn: () => {}, autoFlush: false });
    while (JSON.stringify(big.get()).length < S.LIBRARY_RESTORE_MAX_CHARS - 40000) {
      big.set(`songs.${big.addSong(null, { name: 'Near' })}.notes`, 'n'.repeat(10000));
    }
    const near = JSON.stringify(big.get());
    localStorage.setItem(`${K}1.downgrade.s2`, near);
    const s = S.createStore({ storage: localStorage, idGen: (p) => `${p}-${++n}`, requestIdle: null, warn: () => {}, autoFlush: false, debounceMs: 0 });
    s.addSong(null, { name: 'Current work' });
    s.persistNow();
    const cur = localStorage.getItem(S.STORAGE_KEY);
    const kept = s.keepCurrent('restore', { protect: `${K}1.downgrade.s2` });
    const restored = s.restoreKept(`${K}1.downgrade.s2`);
    const saved = s.persistNow();
    const again = S.createStore({ storage: localStorage, requestIdle: null, warn: () => {}, autoFlush: false });
    return {
      nearChars: near.length, kept: kept.ok, restored: restored.ok, saved,
      reloaded: again.get().songOrder.length, want: JSON.parse(near).songOrder.length,
      undoKept: kept.ok && localStorage.getItem(kept.key) === cur,
      used: Object.keys(localStorage).reduce((m, k) => m + k.length + localStorage.getItem(k).length, 0),
    };
  });
  console.log(JSON.stringify(r));
  assert.ok(r.nearChars > 2400000);
  assert.deepEqual([r.kept, r.restored, r.saved, r.undoKept], [true, true, true, true]);
  assert.equal(r.reloaded, r.want);
  assert.deepEqual(errors, []);
  await ctx.close();
});
