// Song bank Try it (UI v6 U7a, native DECISIONS D17): store trial songs (store.startTrial / endTrial / persisted) and
// the controller's tryBankSong / backFromTrial / keepTrial, end to end against a real server with a bank pack.
// What is proven: a trial song is never saved (storage bytes), exported, backed up (exportJSON is the backup's
// source), put in the library order or a setlist, never marks the library edited, and goes on reload; Back restores
// the song, its setlist entry and its Revert snapshot; Keep is today's Add to library (same record) plus select.
// Every pack and song name here is invented.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { memoryStorage, migrate, isTrialId } from '../../../app/js/store.js';
import { blankSong } from '../../../app/js/presets.js';
import { createController } from '../../../app/js/controller.js';
import { MidiInput } from '../../../app/js/midi.js';
import { songFingerprint } from '../../../app/js/shared/patch-packs.js';
import { makeStore, fakeEngine, fakeTimers, fakeDoc } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { createServer } = require('../../../server.js');

const song = (name, over = {}) => ({ ...blankSong({ name }), ...over });
const entry = (packId, s, over = {}) => {
  const [pack, rest] = packId.split(':');
  return { packId, pack, file: rest.replace(/#.*/, ''), n: null, mtime: 1, hash: 'h1', mode: 'bank', schema: 2,
    song: s, ...over };
};
const raw = (storage) => storage.getItem('rig.v1');

// ------------------------------------------------------------------------------------------ store
test('store: a trial song plays like a song but is never library state, saved, exported or an edit', () => {
  const storage = memoryStorage();
  const s = makeStore({ storage, debounceMs: 0 });
  s.seedFactory();
  s.persistNow();
  assert.equal(s.pristine, true);
  const before = raw(storage);
  const st0 = s.get();
  const prevId = st0.settings.currentSongId;
  const r = s.startTrial(entry('Desk Bank:lantern.json', song('Lantern Hymn', { tempo: 68, hearIn: 3 })));
  assert.equal(r.ok, true);
  assert.ok(isTrialId(r.id));
  assert.equal(s.getSong(r.id).name, 'Lantern Hymn');
  assert.equal(s.get().songOrder.includes(r.id), false);
  assert.ok(s.selectSongId(r.id));
  assert.equal(s.currentSong().id, r.id);
  assert.equal(s.currentIndex(), -1);
  // writes inside it, as the strips make them
  assert.ok(s.set('slots.0.gain', 0.3));
  assert.ok(s.set(`songs.${r.id}.tempo`, 90));
  assert.equal(s.pristine, true, 'never an edit');
  s.persistNow();
  assert.equal(raw(storage), before, 'nothing written: the trial changes nothing persisted');
  // export / backup source / kept copy: no trial song, the selection it replaced
  const exp = JSON.parse(s.exportJSON());
  assert.equal(Object.keys(exp.songs).some(isTrialId), false);
  assert.equal(exp.settings.currentSongId, prevId);
  assert.deepEqual(exp.songOrder, st0.songOrder);
  // another change is saved, without the trial song
  assert.ok(s.set('settings.theme', 'ember'));
  s.persistNow();
  const saved = JSON.parse(raw(storage));
  assert.equal(Object.keys(saved.songs).some(isTrialId), false);
  assert.equal(saved.settings.currentSongId, prevId);
  assert.equal(JSON.stringify({ ...saved, settings: { ...saved.settings, theme: st0.settings.theme } }), before);
  // it never joins the library order or a setlist
  const sl = s.currentSetlist();
  assert.equal(s.addToSetlist(sl.id, r.id), false);
  assert.ok(s.set('songOrder', st0.songOrder.slice().reverse()));
  assert.equal(s.get().songOrder.includes(r.id), false);
  assert.ok(s.set(`setlists.${sl.id}.songIds`, [...sl.songIds, r.id]) === false
    || !s.currentSetlist().songIds.includes(r.id));
  assert.equal(s.duplicateSong(r.id), null);
  assert.equal(s.deleteSong(r.id), false);
  // update() keeps it (migrate drops trial songs: never library state)
  assert.ok(s.update((d) => {
    d.songs[prevId].notes = 'n';
  }));
  assert.ok(s.getSong(r.id));
  assert.equal(s.currentSong().id, r.id);
  assert.equal(Object.keys(migrate({ ...s.get() }).songs).some(isTrialId), false);
  // endTrial: not while it is selected
  assert.equal(s.endTrial(r.id), false);
  assert.ok(s.selectSongId(prevId, 0));
  assert.ok(s.endTrial(r.id));
  assert.equal(s.getSong(r.id), null);
  assert.deepEqual(s.trialIds(), []);
});

test('store: a reload (storage) and a library replace end a trial; a fresh store never sees one', () => {
  const storage = memoryStorage();
  const s = makeStore({ storage, debounceMs: 0 });
  s.seedFactory();
  s.persistNow();
  const r = s.startTrial(entry('Desk Bank:quiet.json', song('Quiet Room')));
  s.selectSongId(r.id);
  s.set('slots.0.gain', 0.2);
  s.persistNow();
  const again = makeStore({ storage });
  assert.deepEqual(again.trialIds(), []);
  assert.notEqual(again.currentSong().id, r.id);
  s.set('settings.theme', 'ember'); // dirty, so a reload sees a difference
  s.persistNow();
  storage.setItem('rig.v1', JSON.stringify({ ...JSON.parse(raw(storage)), settings: {
    ...JSON.parse(raw(storage)).settings, theme: 'sanctuary' } }));
  assert.ok(s.reload());
  assert.deepEqual(s.trialIds(), []);
  assert.equal(isTrialId(s.get().settings.currentSongId), false);
  const r2 = s.startTrial(entry('Desk Bank:quiet.json', song('Quiet Room')));
  s.selectSongId(r2.id);
  const lib = s.exportJSON();
  assert.ok(s.importJSON(lib, { replace: true }).ok);
  assert.deepEqual(s.trialIds(), []);
  // packSongPreview: the song as the library would take it, nothing changed
  const g = s.get();
  const p = s.packSongPreview(entry('Desk Bank:quiet.json', song('Quiet Room', { tempo: 61 })));
  assert.equal(p.tempo, 61);
  assert.equal(s.get(), g);
  assert.equal(s.packSongPreview({ packId: 'x' }), null);
});

// ------------------------------------------------------------------------------------------ controller
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-bank-trial-'));
const samples = path.join(tmp, 'Samples');
const write = (f, data) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data, null, 2));
};
const exportOf = (s, bank) => ({ app: 'worship-rig', kind: 'song', schema: 2, song: s, ...(bank ? { bank } : {}) });
let server;
let port;
before(async () => {
  fs.mkdirSync(path.join(tmp, 'app'), { recursive: true });
  write(path.join(samples, 'Desk Bank', 'pack.json'), { mode: 'bank', name: 'Desk sounds' });
  write(path.join(samples, 'Desk Bank', 'songs', 'lantern.json'), exportOf(song('Lantern Hymn', { tempo: 68, hearIn: 3,
    playIn: 3 }), { title: 'Lantern Hymn', artist: 'Northgate Testers', originalKey: 'Eb', bpm: 68, tags: ['hymn'] }));
  write(path.join(samples, 'Desk Bank', 'songs', 'harbour.json'), exportOf(song('Harbour Light', { tempo: 128 }),
    { title: 'Harbour Light', artist: 'River Testhall', bpm: 128, tags: ['upbeat'] }));
  port = 20437 + Math.floor(Math.random() * 2000);
  server = createServer({ appDir: path.join(tmp, 'app'), port, userSamples: [samples], docsDir: null });
  await server.listen();
});
after(async () => {
  await server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
async function withLocation(href, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { value: new URL(href), configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    if (had) Object.defineProperty(globalThis, 'location', had);
    else delete globalThis.location;
  }
}
async function boot(storage = memoryStorage()) {
  const store = makeStore({ storage, debounceMs: 0 });
  return withLocation(`http://127.0.0.1:${port}/`, async () => {
    const midi = new MidiInput({ nav: null, warn: () => {} });
    midi.access = {};
    const ctl = createController({
      store, engine: fakeEngine(), midi, recorder: null, doc: fakeDoc(), nav: null, win: new EventTarget(), rig: null,
      timers: fakeTimers(), now: () => 0, locks: null, heartbeat: false, indexedDB: null,
    });
    await ctl.start();
    await ctl.packsReady;
    const events = [];
    for (const t of ['trial', 'songSelected']) ctl.addEventListener(t, (e) => events.push([t, e.detail]));
    return { store, ctl, storage, events };
  });
}
const LANTERN = 'Desk Bank:lantern.json';
const HARBOUR = 'Desk Bank:harbour.json';

test('controller: Try it plays the bank song, nothing persisted; Back restores song, entry, Revert', async () => {
  const { store, ctl, storage, events } = await boot();
  const lib = store.get().songOrder;
  const idx = 2;
  const prevId = store.navIds()[idx];
  assert.ok(await ctl.selectSong(prevId, { index: idx }));
  // an edit before trying: Revert after Back must still undo it
  const si = store.getSong(prevId).patch.slots.findIndex(Boolean);
  const g0 = store.getSong(prevId).patch.slots[si].gain;
  store.set(`songs.${prevId}.patch.slots.${si}.gain`, 0.11);
  await new Promise((r) => setTimeout(r, 5));
  store.persistNow();
  const bytes = raw(storage);
  const edited = store.get().meta.edited;
  const r = await ctl.tryBankSong(LANTERN);
  assert.equal(r.ok, true);
  assert.equal(store.currentSong().id, r.id);
  assert.equal(ctl.status.songId, r.id);
  const t = ctl.trial();
  assert.deepEqual([t.title, t.artist, t.key, t.bpm, t.prev.id, t.playing], ['Lantern Hymn', 'Northgate Testers',
    'Eb', 68, prevId, true]);
  assert.ok(events.some(([k, d]) => k === 'songSelected' && d.id === r.id));
  // moving a fader in the trial, then a second Try it (keeps the first one's way back)
  store.set('slots.0.gain', 0.4);
  const r2 = await ctl.tryBankSong(HARBOUR);
  assert.equal(r2.ok, true);
  assert.deepEqual(store.trialIds(), [r2.id], 'the first trial song is gone');
  assert.equal(ctl.trial().prev.id, prevId);
  await new Promise((res) => setTimeout(res, 5));
  store.persistNow();
  assert.equal(raw(storage), bytes, 'storage unchanged while trying');
  assert.equal(store.get().meta.edited, edited);
  assert.deepEqual(store.get().songOrder, lib);
  assert.equal(JSON.parse(store.exportJSON()).settings.currentSongId, prevId);
  // Back
  assert.deepEqual(await ctl.backFromTrial(), { ok: true });
  assert.equal(store.currentSong().id, prevId);
  assert.equal(store.currentIndex(), idx);
  assert.equal(ctl.trial(), null);
  assert.deepEqual(store.trialIds(), []);
  assert.equal(events.at(-1)[0], 'songSelected');
  assert.equal(events.at(-1)[1].songSnapshot.patch.slots[si].gain, g0, 'the Revert snapshot from before Try it');
  assert.ok(events.some(([k, d]) => k === 'trial' && d === null));
  assert.equal(ctl.revertSong(), true);
  assert.equal(store.getSong(prevId).patch.slots[si].gain, g0, 'Revert after Back = Revert before Try it');
  await new Promise((res) => setTimeout(res, 5));
  store.persistNow();
  const after = JSON.parse(raw(storage));
  assert.equal(Object.keys(after.songs).some(isTrialId), false);
  assert.deepEqual(after.songOrder, lib);
  assert.equal(after.meta.packSongs, undefined, 'no pack record: nothing was added');
  ctl.dispose();
});

test('controller: Keep = Add to library (same record) + select; tweaks kept; setlist; Lock; GO ends a trial',
  async () => {
    // a plain Add to library, for the record to compare with
    const ref = await boot();
    const plain = ref.ctl.addFromBank(LANTERN);
    const plainSong = ref.store.getSong(plain.id);
    const plainRec = ref.store.get().meta.packSongs[LANTERN];
    ref.ctl.dispose();

    const { store, ctl } = await boot();
    const n0 = store.get().songOrder.length;
    const sl = store.currentSetlist();
    // Lock: Try it refused; Back allowed
    store.set('settings.performLock', true);
    assert.deepEqual(await ctl.tryBankSong(LANTERN), { ok: false, error: 'perform-locked' });
    store.set('settings.performLock', false);
    const r = await ctl.tryBankSong(LANTERN);
    assert.ok(r.ok);
    store.set('settings.performLock', true);
    assert.deepEqual(await ctl.keepTrial(), { ok: false, error: 'perform-locked' });
    store.set('settings.performLock', false);
    // Keep, untouched: exactly today's add
    const k = await ctl.keepTrial();
    assert.equal(k.ok, true);
    assert.equal(k.selected, true);
    assert.equal(store.currentSong().id, k.id);
    assert.equal(store.get().songOrder.length, n0 + 1);
    assert.equal(store.get().songOrder.at(-1), k.id);
    const rec = store.get().meta.packSongs[LANTERN];
    assert.deepEqual({ hash: rec.hash, sig: rec.sig }, { hash: plainRec.hash, sig: plainRec.sig });
    assert.equal(rec.id, k.id);
    assert.equal(songFingerprint(store.getSong(k.id)), songFingerprint(plainSong));
    assert.equal(store.pristine, false, 'a Song bank add is an edit (O-AW-PP rule 6)');
    assert.equal(ctl.trial(), null);
    assert.deepEqual(store.trialIds(), []);
    // Keep with a tweak and a setlist: the tweak is kept (an edit of the added song), the setlist entry selected
    const r2 = await ctl.tryBankSong(HARBOUR);
    store.set('slots.0.gain', 0.37);
    const k2 = await ctl.keepTrial({ setlistId: sl.id });
    assert.ok(k2.ok);
    assert.equal(store.getSong(k2.id).patch.slots[0].gain, 0.37);
    assert.notEqual(store.get().meta.packSongs[HARBOUR].sig, songFingerprint(store.getSong(k2.id)),
      'edited relative to the pack version: never overwritten by a newer one');
    assert.equal(store.currentSetlist().songIds.at(-1), k2.id);
    assert.equal(store.currentIndex(), store.currentSetlist().songIds.length - 1);
    assert.equal(store.getSong(r2.id), null);
    // a song switch from elsewhere (GO / a library row) ends a trial
    const r3 = await ctl.tryBankSong(HARBOUR);
    assert.ok(r3.ok);
    assert.equal(ctl.trial().id, r3.id);
    assert.ok(await ctl.selectSong(store.navIds()[0], { index: 0 }));
    assert.equal(ctl.trial(), null);
    assert.deepEqual(store.trialIds(), []);
    // already in the library: Keep selects it and leaves it as it is
    const r4 = await ctl.tryBankSong(LANTERN);
    store.set('slots.0.gain', 0.05);
    const before = store.getSong(k.id);
    const k4 = await ctl.keepTrial();
    assert.deepEqual([k4.ok, k4.id, k4.existing], [true, k.id, true]);
    assert.equal(store.getSong(k.id), before);
    assert.equal(store.getSong(r4.id), null);
    assert.deepEqual(await ctl.backFromTrial(), { ok: false, error: 'no-trial' });
    assert.equal((await ctl.tryBankSong('Desk Bank:gone.json')).ok, false);
    ctl.dispose();
  });

// ------------------------------------------------------------------------------------------ skeptic (UI6-U7a)
// F1: list edits during a trial move the replaced selection (what is saved, what Back returns to) as they move the
// selection itself (M4). Before: a removal before a reprise's second entry saved setlistIndex on another entry.
test('skeptic F1: a setlist edited during a trial keeps the replaced entry (saved, Back), as without the trial', () => {
  const mkPair = () => [memoryStorage(), memoryStorage()].map((storage) => {
    const s = makeStore({ storage, debounceMs: 0, now: () => 1000 });
    s.seedFactory();
    const o = s.get().songOrder;
    s.setCurrentSetlist(s.addSetlist('Reprise', [o[0], o[1], o[2], o[0], o[3]]));
    s.selectSongId(o[0], 3); // the reprise: the second entry of o[0]
    s.persistNow();
    return { s, storage };
  });
  const [S, R] = mkPair(); // S tries a bank song; R (the reference) never does
  const o = S.s.get().songOrder;
  const t = S.s.startTrial(entry('Desk Bank:lantern.json', song('Lantern Hymn')));
  S.s.selectSongId(t.id);
  const sl = S.s.get().settings.currentSetlistId;
  for (const X of [S.s, R.s]) X.removeFromSetlist(sl, 1);
  S.s.persistNow();
  R.s.persistNow();
  assert.ok(raw(S.storage) === raw(R.storage), 'saved as if there had been no trial');
  assert.deepEqual(S.s.trialReturn(), { id: o[0], index: 2 }, 'Back: the same (reprise) entry, now at 2');
  // the song it replaced deleted during the trial: the song after it (M4), saved and Back's target
  for (const X of [S.s, R.s]) X.deleteSong(o[0]);
  S.s.persistNow();
  R.s.persistNow();
  assert.ok(raw(S.storage) === raw(R.storage), 'saved as if there had been no trial (song deleted)');
  assert.equal(S.s.trialReturn().id, R.s.get().settings.currentSongId);
  assert.equal(S.s.currentSong().id, t.id, 'the trial plays on');
  assert.equal(raw(S.storage).includes('trial:'), false);
});

// F1, property style: random trial / back / edit / switch / list-edit / persist / reload sequences against a store
// that never sees the trial. Storage and export must always equal the reference's: the library without the trial.
test('skeptic F1: random sequences: storage and export always = the library without the trial', () => {
  const counter = () => {
    let n = 0;
    return (p) => `${p}${++n}`;
  };
  const strip = (j) => {
    const x = JSON.parse(j);
    delete x.exportedAt;
    return x;
  };
  let runs = 0;
  for (let seed = 1; seed <= 60; seed++) {
    let r = seed >>> 0;
    const rnd = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const sS = memoryStorage();
    const sR = memoryStorage();
    const gS = counter();
    const gR = counter();
    const mk = (storage, idGen) => makeStore({ storage, idGen, debounceMs: 0, now: () => 1000 });
    let S = mk(sS, gS);
    const R = mk(sR, gR);
    for (const X of [S, R]) {
      X.seedFactory();
      const o = X.get().songOrder;
      X.setCurrentSetlist(X.addSetlist('Sun', [o[0], o[1], o[2], o[0], o[3]]));
    }
    for (let k = 0; k < 60; k++) {
      const st = R.get();
      const nav = R.navIds();
      const sl = st.settings.currentSetlistId;
      const n = sl ? st.setlists[sl].songIds.length : 0;
      const trialSel = isTrialId(S.get().settings.currentSongId);
      const op = pick(['try', 'try', 'back', 'trialEdit', 'realEdit', 'curEdit', 'select', 'slAdd', 'slRemove',
        'slMove', 'theme', 'reload', 'delete', 'addSong']);
      if (op === 'try') {
        const t = S.startTrial(entry(`Desk Bank:s${k}.json`, song(`Bank ${k}`, { tempo: 70 + k })));
        S.selectSongId(t.id);
        for (const x of S.trialIds()) if (x !== t.id) S.endTrial(x);
      } else if (op === 'back' && trialSel) {
        const back = S.trialReturn();
        for (const X of [S, R]) X.selectSongId(back.id, back.index);
        for (const x of S.trialIds()) S.endTrial(x);
      } else if (op === 'trialEdit' && trialSel) {
        S.set('slots.0.gain', Math.round(rnd() * 100) / 100);
      } else if (op === 'realEdit') {
        const id = pick(st.songOrder);
        for (const X of [S, R]) X.set(`songs.${id}.notes`, `n${k}`);
      } else if (op === 'curEdit' && !trialSel) {
        const v = Math.round(rnd() * 100) / 100;
        for (const X of [S, R]) X.set('slots.0.gain', v);
      } else if (op === 'select' && nav.length) {
        const i = Math.floor(rnd() * nav.length);
        for (const X of [S, R]) X.selectSongId(nav[i], i);
        for (const x of S.trialIds()) S.endTrial(x);
      } else if (op === 'slAdd' && sl) {
        const id = pick(st.songOrder);
        const at = Math.floor(rnd() * (n + 1));
        for (const X of [S, R]) X.addToSetlist(sl, id, at);
      } else if (op === 'slRemove' && n) {
        const at = Math.floor(rnd() * n);
        for (const X of [S, R]) X.removeFromSetlist(sl, at);
      } else if (op === 'slMove' && n > 1) {
        const a = Math.floor(rnd() * n);
        const b = Math.floor(rnd() * n);
        for (const X of [S, R]) X.moveSong(sl, a, b);
      } else if (op === 'theme') {
        const v = pick(['ember', 'sanctuary']);
        for (const X of [S, R]) X.set('settings.theme', v);
      } else if (op === 'reload') {
        S.persistNow();
        S = mk(sS, gS);
      } else if (op === 'delete' && st.songOrder.length > 4) {
        const id = pick(st.songOrder);
        for (const X of [S, R]) X.deleteSong(id);
      } else if (op === 'addSong') {
        for (const X of [S, R]) X.addSong(null, { name: `A${k}` });
      }
      S.persistNow();
      R.persistNow();
      const a = raw(sS);
      assert.equal(a.includes('trial:'), false, `seed ${seed} step ${k} ${op}: a trial song saved`);
      // assert.ok, not equal: a diff of two whole libraries is unreadable
      assert.ok(a === raw(sR), `seed ${seed} step ${k} ${op}: saved library ≠ the library without the trial`);
      assert.ok(JSON.stringify(strip(S.exportJSON())) === JSON.stringify(strip(R.exportJSON())),
        `seed ${seed} step ${k} ${op}: export ≠ the library without the trial`);
      runs++;
    }
  }
  assert.equal(runs, 3600);
});

test('skeptic F1–F3: Back after list edits; a pack update during a trial; Keep drops a removed field', async () => {
  // F2 setup: Lantern in the library (a bank add), playing, then its pack file gets a newer version
  const { store, ctl } = await boot();
  const add = ctl.addFromBank(LANTERN);
  assert.ok(add.ok);
  const o = store.get().songOrder;
  const sl = store.addSetlist('Reprise', [add.id, o[0], o[1], add.id, o[2]]);
  store.setCurrentSetlist(sl);
  assert.ok(await ctl.selectSong(add.id, { index: 3 }));
  const lanternFile = path.join(samples, 'Desk Bank', 'songs', 'lantern.json');
  const before = fs.readFileSync(lanternFile, 'utf8');
  try {
    assert.ok((await ctl.tryBankSong(HARBOUR)).ok);
    // F1: an entry before the reprise removed while trying: Back lands on the same (second) entry
    store.removeFromSetlist(sl, 1);
    assert.equal(ctl.trial().prev.id, add.id);
    // F2: a rescan during the trial updates the (unedited) Lantern in place
    write(lanternFile, exportOf(song('Lantern Hymn', { tempo: 74, hearIn: 3, playIn: 3 }), { title: 'Lantern Hymn' }));
    const res = await ctl.rescanPatchPacks();
    assert.deepEqual(res.updated, [add.id]);
    assert.deepEqual(await ctl.backFromTrial(), { ok: true });
    assert.equal(store.currentSong().id, add.id);
    assert.equal(store.currentIndex(), 2, 'the reprise entry, moved up by the removal');
    store.set(`songs.${add.id}.tempo`, 99);
    assert.equal(ctl.revertSong(), true);
    assert.equal(store.getSong(add.id).tempo, 74, 'Revert after Back = the updated pack version');
    assert.equal(songFingerprint(store.getSong(add.id)), store.get().meta.packSongs[LANTERN].sig,
      'still unedited: later pack versions keep updating it (PP-1)');
    // F3: Keep after the player set the trial song back to 4/4 (timeSig removed)
    write(path.join(samples, 'Desk Bank', 'songs', 'waltz.json'), exportOf(song('Waltz Test', { timeSig: '3/4' }),
      { title: 'Waltz Test' }));
    await ctl.rescanPatchPacks();
    const WALTZ = 'Desk Bank:waltz.json';
    const tr = await ctl.tryBankSong(WALTZ);
    assert.ok(tr.ok);
    assert.equal(store.getSong(tr.id).timeSig, '3/4');
    assert.ok(store.set(`songs.${tr.id}.timeSig`, null));
    assert.equal(store.getSong(tr.id).timeSig, undefined);
    const k = await ctl.keepTrial();
    assert.ok(k.ok);
    assert.equal(store.getSong(k.id).timeSig, undefined, 'kept as it was played (4/4)');
  } finally {
    fs.writeFileSync(lanternFile, before);
    fs.rmSync(path.join(samples, 'Desk Bank', 'songs', 'waltz.json'), { force: true });
    ctl.dispose();
  }
});

// F4: Next / Prev / GO from a trial song step from the entry it replaced. Before: a trial song is in no list, so
// neighbors() gave next = the first song (a Next during a trial mid-set went back to the top of the set).
test('skeptic F4: Next during a trial plays the entry after the replaced one; Prev the one before', async () => {
  const { store, ctl } = await boot();
  const ids = store.navIds();
  assert.ok(ids.length >= 5);
  assert.ok(await ctl.selectSong(ids[2], { index: 2 }));
  const t = await ctl.tryBankSong(LANTERN);
  assert.ok(t.ok);
  assert.equal(store.currentIndex(), -1, 'the trial song itself is in no list');
  const nb = store.neighbors();
  assert.deepEqual([nb.prev, nb.next], [{ id: ids[1], index: 1 }, { id: ids[3], index: 3 }]);
  assert.ok(await ctl.nextSong());
  assert.deepEqual([store.get().settings.currentSongId, store.currentIndex()], [ids[3], 3]);
  assert.equal(ctl.trial(), null, 'Next ended the trial');
  assert.ok((await ctl.tryBankSong(HARBOUR)).ok);
  assert.ok(await ctl.prevSong());
  assert.deepEqual([store.get().settings.currentSongId, store.currentIndex()], [ids[2], 2]);
  assert.deepEqual(store.trialIds(), []);
  ctl.dispose();
});

// UI v6 polish batch 2 (UI6-polish1 O2): the Back-into-the-gap rule (UI6-U7a O2) lives in controller.backFromTrial,
// so every Back follows it (the banner's, and the v6 Perform's destroy on a flag flip, which calls the controller
// directly). Before, it was in views/v6/bank/banner.js and a direct backFromTrial landed on the reprise.
test('polish batch 2 O2: backFromTrial itself puts the song back into the gap of its removed entry', async () => {
  const { store, ctl } = await boot();
  const [a, b, c] = store.get().songOrder;
  const sl = store.addSetlist('Gap test', [a, b, c, b]);
  store.setCurrentSetlist(sl);
  try {
    assert.ok(await ctl.selectSong(b, { index: 1 }));
    assert.ok((await ctl.tryBankSong(LANTERN)).ok);
    assert.ok(store.removeFromSetlist(sl, 1) !== false);
    assert.deepEqual(await ctl.backFromTrial(), { ok: true });
    const st = store.get().settings;
    assert.deepEqual([st.currentSongId, st.setlistIndex, st.setlistGap], [b, 1, true], 'b, in the gap at 1');
    const nb = store.neighbors();
    assert.deepEqual([nb.prev?.id, nb.next?.id], [a, c], 'Prev = a, Next = c (not the reprise\'s neighbours)');
    // no gap to keep: an entry that is still there is selected as before (no gap)
    assert.ok(await ctl.selectSong(c, { index: 1 }));
    assert.ok((await ctl.tryBankSong(LANTERN)).ok);
    assert.deepEqual(await ctl.backFromTrial(), { ok: true });
    assert.deepEqual([store.get().settings.currentSongId, store.currentIndex(), !!store.get().settings.setlistGap],
      [c, 1, false]);
  } finally {
    ctl.dispose();
  }
});

