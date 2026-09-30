// shell-3: My Samples server routes, store/params pass-through (PARAMS-driven), factory top-up, controller hooks
// (preload pins, refused commit, status.pedal, songSelected/revertSong, rescanUserSamples, slot strip params).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createStore, memoryStorage, normalizeSong, SONG_CATEGORIES } from '../../../app/js/store.js';
import { createController } from '../../../app/js/controller.js';
import { MidiInput } from '../../../app/js/midi.js';
import { FACTORY_SONGS, FACTORY_SINCE, FACTORY_VERSION } from '../../../app/js/presets.js';
import { PARAMS, clamp, describe } from '../../../app/js/shared/params.js';
import { makeStore, idGen, fakeEngine, fakeTimers, fakeDoc, tick } from './helpers.mjs';

const require = createRequire(import.meta.url);
const { createServer, scanUserSamples, defaultUserSampleRoots, userSamplesHome } = require('../../../server.js');

// ------------------------------------------------------------------------------------------ helpers
function req(port, p, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.end();
  });
}
const json = (r) => JSON.parse(r.body.toString('utf8'));
const BIN = Buffer.from(Array.from({ length: 2000 }, (_, i) => i % 251));
const write = (f, data) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
};
const pack = (id, layers, extra = {}) => JSON.stringify({ instruments: [{ id, name: id, category: 'piano', ext: 'm4a', layers, ...extra }] });

async function setupCtl(opts = {}) {
  const store = opts.store || makeStore();
  const engine = opts.engine || fakeEngine(opts.engineOpts);
  const midi = new MidiInput({ nav: null, warn: () => {} });
  midi.access = {};
  const warns = [];
  const ctl = createController({ store, engine, midi, recorder: null, doc: fakeDoc(), nav: null, win: new EventTarget(), rig: opts.rig || null, timers: fakeTimers(), now: () => 0, locks: null, heartbeat: false, indexedDB: null, ...opts.ctl });
  ctl.addEventListener('warn', (e) => warns.push(e.detail.message));
  await ctl.start();
  return { store, engine, midi, ctl, warns };
}
const inject = (midi, bytes, input = 'kbd') => midi._inject(bytes, 0, input);

// ------------------------------------------------------------------------------------------ server: My Samples
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-shell3-'));
const rootA = path.join(tmp, 'project', 'user-samples'); // project-local root (first)
const rootB = path.join(tmp, 'Music', 'Worship Rig', 'Samples'); // ~/Music root (second)
const outside = path.join(tmp, 'outside');
const port = 20000 + Math.floor(Math.random() * 20000);
let srv;

before(async () => {
  fs.mkdirSync(path.join(tmp, 'app'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'app', 'index.html'), '<!doctype html>');
  // A: "Grand Piano" (GarageBand m4a, two layers) + "Steinway Copy" (duplicate id of B's → B's dropped)
  write(path.join(rootA, 'Grand Piano', 'manifest.json'), pack('gb-grand', [{ vel: [0, 80], dir: 'v1', notes: ['C4', 'Db4'] }, { vel: [81, 127], dir: 'v2 loud', notes: ['C4'] }], { license: 'Apple-SLA-personal-use' }));
  write(path.join(rootA, 'Grand Piano', 'v1', 'C4.m4a'), BIN);
  write(path.join(rootA, 'Grand Piano', 'v1', 'Db4.m4a'), BIN);
  write(path.join(rootA, 'Grand Piano', 'v2 loud', 'C4.m4a'), BIN);
  write(path.join(rootA, 'Grand Piano', 'notes.txt'), 'not audio');
  // A: files-map layer, a layer escaping with '..' (skipped), a caf file
  write(path.join(rootA, 'Mallets', 'manifest.json'), JSON.stringify({ instruments: [
    { id: 'gb-vibes', name: 'Vibes', layers: [{ vel: [0, 127], files: { C4: 'wav/C4.caf', D4: '../../escape.caf', E4: 'https://evil/x.caf' } }] },
    { id: 'gb-bad', name: 'Bad', layers: [{ vel: [0, 127], dir: '../x', notes: ['C4'] }] },
  ] }));
  write(path.join(rootA, 'Mallets', 'wav', 'C4.caf'), BIN);
  // B: same slug as A (skipped), another id collision, a normal pack, a broken manifest, a dot folder, an escaping link
  write(path.join(rootB, 'Grand Piano', 'manifest.json'), pack('gb-grand-b', [{ vel: [0, 127], dir: 'v', notes: ['C4'] }]));
  write(path.join(rootB, 'Choir', 'manifest.json'), pack('gb-grand', [{ vel: [0, 127], dir: 'v', notes: ['C4'] }]));
  write(path.join(rootB, 'Strings', 'manifest.json'), JSON.stringify([{ id: 'gb-strings', layers: [{ vel: [0, 127], notes: ['A3'] }] }])); // top-level array, dir defaults to the id
  write(path.join(rootB, 'Strings', 'gb-strings', 'A3.wav'), BIN);
  write(path.join(rootB, 'Broken', 'manifest.json'), '{ nope');
  write(path.join(rootB, '.hidden', 'manifest.json'), pack('hidden', [{ vel: [0, 127], dir: 'v', notes: ['C4'] }]));
  write(path.join(outside, 'manifest.json'), pack('outside', [{ vel: [0, 127], dir: 'v', notes: ['C4'] }]));
  write(path.join(outside, 'v', 'C4.wav'), BIN);
  fs.symlinkSync(outside, path.join(rootB, 'Linked Out'), 'dir');
  // a sample symlink inside a pack that points outside it
  write(path.join(tmp, 'secret.wav'), BIN);
  fs.symlinkSync(path.join(tmp, 'secret.wav'), path.join(rootB, 'Strings', 'gb-strings', 'B3.wav'));
  write(path.join(tmp, 'docs', 'garageband-import.md'), '# GarageBand\n');
  srv = createServer({ appDir: path.join(tmp, 'app'), port, userSamples: [rootA, rootB, path.join(tmp, 'missing')], docsDir: path.join(tmp, 'docs') });
  await srv.listen();
});
after(async () => {
  await srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('My Samples: /api/health advertises it; the merged manifest rewrites dirs to /user-samples/<token>/<slug>/…', async () => {
  const h = json(await req(port, '/api/health'));
  assert.equal(h.userSamples, true);
  assert.deepEqual(h.features, ['user-samples']);
  const r = await req(port, '/api/user-samples/manifest.json');
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  const m = json(r);
  assert.deepEqual(m.roots, [rootA, rootB, path.join(tmp, 'missing')]);
  assert.deepEqual(m.instruments.map((i) => i.id), ['gb-grand', 'gb-vibes', 'gb-strings'], 'root order, then folder name; ids NOT namespaced (the engine adds user:)');
  const g = m.instruments[0];
  assert.match(g.layers[0].dir, /^\/user-samples\/[A-Za-z0-9_-]+\/Grand%20Piano\/v1$/);
  assert.match(g.layers[1].dir, /\/Grand%20Piano\/v2%20loud$/);
  assert.equal(g.pack, 'Grand Piano');
  assert.equal(g.license, 'Apple-SLA-personal-use', 'other fields pass through');
  const v = m.instruments[1];
  assert.deepEqual(Object.keys(v.layers[0].files), ['C4'], "'..' and URL file entries are dropped");
  assert.match(v.layers[0].files.C4, /\/Mallets\/wav\/C4\.caf$/);
  assert.match(m.instruments[2].layers[0].dir, /\/Strings\/gb-strings$/, 'dir defaults to the instrument id');
  assert.deepEqual(m.packs.map((p) => p.slug), ['Grand Piano', 'Mallets', 'Choir', 'Strings']);
  const errs = m.errors.join('\n');
  assert.match(errs, /gb-bad/);
  assert.match(errs, /Grand Piano.*earlier folder/);
  assert.match(errs, /"gb-grand" is already used/);
  assert.match(errs, /Broken/);
  assert.doesNotMatch(errs, /hidden/);
  assert.match(errs, /Linked Out: is a link to a folder outside My Samples/, 'round2-shell #6: skipped, but not silently');
  assert.ok(!m.instruments.some((i) => i.id === 'outside' || i.id === 'hidden'));
});

test('My Samples: audio served with Range; realpath/extension/token checks → 404', async () => {
  const m = json(await req(port, '/api/user-samples/manifest.json'));
  const c4 = `${m.instruments[0].layers[0].dir}/C4.m4a`;
  const full = await req(port, c4);
  assert.equal(full.status, 200);
  assert.equal(full.headers['content-type'], 'audio/mp4');
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.deepEqual(full.body, BIN);
  const part = await req(port, c4, { headers: { Range: 'bytes=10-19' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers['content-range'], `bytes 10-19/${BIN.length}`);
  assert.deepEqual(part.body, BIN.subarray(10, 20));
  const caf = await req(port, m.instruments[1].layers[0].files.C4);
  assert.equal(caf.status, 200);
  assert.equal(caf.headers['content-type'], 'audio/x-caf');
  const tok = srv.userSampleRoots && /^\/user-samples\/([^/]+)\//.exec(c4)[1];
  for (const p of [
    `/user-samples/${tok}/Grand%20Piano/manifest.json`, // not audio
    `/user-samples/${tok}/Grand%20Piano/notes.txt`,
    `/user-samples/${tok}/Grand%20Piano/..%2F..%2Fsecret.wav`,
    `/user-samples/${tok}/Strings/gb-strings/B3.wav`, // symlink leaving the pack
    `/user-samples/${tok}/Linked%20Out/v/C4.wav`, // pack symlink leaving the root
    `/user-samples/${tok}/Nope/C4.wav`,
    `/user-samples/wrongtoken/Grand%20Piano/v1/C4.m4a`,
    `/user-samples/${tok}`,
  ]) assert.equal((await req(port, p)).status, 404, p);
});

test('My Samples: a pack added later is found on the next manifest request; rescanUserSamples() reports counts', async () => {
  write(path.join(rootB, 'Zither', 'manifest.json'), pack('gb-zither', [{ vel: [0, 127], dir: 'z', notes: ['G3'] }]));
  write(path.join(rootB, 'Zither', 'z', 'G3.aif'), BIN);
  const r = await srv.rescanUserSamples();
  assert.equal(r.count, 4);
  assert.ok(r.packs.some((p) => p.slug === 'Zither' && p.count === 1 && p.dir.endsWith('Zither')));
  const m = json(await req(port, '/api/user-samples/manifest.json'));
  const z = m.instruments.find((i) => i.id === 'gb-zither');
  const f = await req(port, `${z.layers[0].dir}/G3.aif`);
  assert.equal(f.status, 200);
  assert.equal(f.headers['content-type'], 'audio/aiff');
  // file route alone (no manifest request first) also picks up a new pack
  write(path.join(rootA, 'Late', 'manifest.json'), pack('gb-late', [{ vel: [0, 127], dir: 'l', notes: ['C4'] }]));
  write(path.join(rootA, 'Late', 'l', 'C4.wav'), BIN);
  const tok = /^\/user-samples\/([^/]+)\//.exec(z.layers[0].dir)[1];
  assert.equal((await req(port, `/user-samples/${tok}/Late/l/C4.wav`)).status, 200);
});

test('My Samples: missing/empty roots and a server without the feature answer 200 with an empty list', async () => {
  const empty = path.join(tmp, 'empty-root');
  fs.mkdirSync(empty);
  const p2 = port + 1;
  const s2 = createServer({ appDir: path.join(tmp, 'app'), port: p2, userSamples: [empty, path.join(tmp, 'nope')] });
  await s2.listen();
  const p3 = port + 2;
  const s3 = createServer({ appDir: path.join(tmp, 'app'), port: p3 });
  await s3.listen();
  try {
    const a = await req(p2, '/api/user-samples/manifest.json');
    assert.equal(a.status, 200);
    assert.deepEqual(json(a).instruments, []);
    const b = await req(p3, '/api/user-samples/manifest.json');
    assert.equal(b.status, 200);
    assert.deepEqual(json(b).instruments, []);
    assert.equal(json(await req(p3, '/api/health')).userSamples, false, 'the engine will not request it at all');
    assert.equal((await req(p3, '/user-samples/x/y/C4.wav')).status, 404);
  } finally {
    await s2.close();
    await s3.close();
  }
});

test('API routes also answer under a page sub-folder (fixture pages at /app/… resolve ./api/… there)', async () => {
  const h = await req(port, '/app/api/health');
  assert.equal(h.status, 200);
  assert.equal(json(h).app, 'worship-rig');
  assert.equal((await req(port, '/app/api/user-samples/manifest.json')).status, 200);
  assert.equal((await req(port, '/app/api/nope')).status, 404);
  assert.equal((await req(port, '/app/api/health/x')).status, 404);
});

test('/api/user-samples summary (Settings in Chrome) and /docs/<name>.md as text/plain', async () => {
  const u = json(await req(port, '/api/user-samples'));
  assert.equal(u.enabled, true);
  assert.equal(u.dir, rootA, 'explicit roots: the first one is the folder to open');
  assert.ok(u.count >= 3);
  const d = await req(port, '/docs/garageband-import.md');
  assert.equal(d.status, 200);
  assert.equal(d.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(d.body.toString(), '# GarageBand\n');
  for (const p of ['/docs/nope.md', '/docs/..%2Fapp%2Findex.html', '/docs/x.txt']) assert.equal((await req(port, p)).status, 404, p);
});

test('My Samples roots: repo user-samples then ~/Music/Worship Rig/Samples; RIG_USER_SAMPLES overrides; asar skips the repo folder', () => {
  const home = '/Users/ryan';
  assert.deepEqual(defaultUserSampleRoots({ repoRoot: '/Users/ryan/Projects/worship-rig', env: {}, home }), [
    '/Users/ryan/Projects/worship-rig/user-samples',
    '/Users/ryan/Music/Worship Rig/Samples',
  ]);
  assert.deepEqual(defaultUserSampleRoots({ repoRoot: '/Applications/Worship Rig.app/Contents/Resources/app.asar', env: {}, home }), ['/Users/ryan/Music/Worship Rig/Samples']);
  assert.deepEqual(defaultUserSampleRoots({ repoRoot: '/r', env: { RIG_USER_SAMPLES: `/a${path.delimiter}/b` }, home }), ['/a', '/b']);
  assert.equal(userSamplesHome({ env: {}, home }), '/Users/ryan/Music/Worship Rig/Samples');
  assert.equal(userSamplesHome({ env: { RIG_USER_SAMPLES: `/a${path.delimiter}/b` }, home }), '/a');
});

test('scanUserSamples() is usable on its own (tools / tests)', async () => {
  const r = await scanUserSamples([rootA], 'tok');
  assert.ok(r.instruments.every((i) => i.layers.every((L) => (L.dir || Object.values(L.files)[0]).startsWith('/user-samples/tok/'))));
  assert.ok(r.packs.get('Grand Piano').dir.endsWith(path.join('user-samples', 'Grand Piano')));
});

// ------------------------------------------------------------------------------------------ store
/** A valid, non-default value for a table entry (different from `cur`). */
function sampleValue(e, cur) {
  if (e.unit === 'bool') return !cur;
  if (e.unit === 'enum') return e.enum.find((x) => x !== cur);
  for (const f of [0.37, 0.61, 0.83]) {
    let v = e.min + (e.max - e.min) * f;
    if (e.step === 1) v = Math.round(v);
    if (v !== cur) return v;
  }
  return e.max;
}

test('store.set(): every PARAMS entry (incl. slots.<i>.width/eq, fx.eq, fx.comp) passes through, clamps, persists', () => {
  const storage = memoryStorage();
  const s = makeStore({ storage });
  const cur = s.currentSong();
  const song = () => s.currentSong();
  const at = (p) => {
    const segs = p === 'master.volume' ? ['fx', 'master', 'volume'] : p.split('.');
    if (segs[0] === 'drone') return song().drone[segs[1]];
    return segs.reduce((o, k) => (o == null ? undefined : o[k]), song().patch);
  };
  const tried = [];
  for (const e of PARAMS) {
    const paths = e.path.includes('<i>') ? [0, 1].map((i) => e.path.replace('<i>', String(i))) : [e.path];
    for (const p of paths) {
      assert.ok(describe(p), p);
      const v = sampleValue(e, at(p));
      assert.equal(s.set(p, v), true, `set ${p} = ${v}`);
      assert.deepEqual(at(p), clamp(p, v), p);
      tried.push([p, clamp(p, v)]);
      if (e.unit !== 'bool' && e.unit !== 'enum') {
        assert.equal(s.set(p, Number.NaN), false, `${p} NaN refused`);
        assert.equal(s.set(p, 'x'), false, `${p} string refused`);
        s.set(p, e.max + 1000);
        assert.equal(at(p), e.max, `${p} clamps high`);
        s.set(p, clamp(p, v));
      }
    }
  }
  assert.ok(tried.some(([p]) => p === 'slots.1.width') && tried.some(([p]) => p === 'fx.comp.amount'), 'new table params covered');
  assert.ok(s.persistNow());
  const b = createStore({ storage, idGen: idGen(), requestIdle: null, warn: () => {}, autoFlush: false });
  const reloaded = b.getSong(cur.id);
  for (const [p, v] of tried) {
    const segs = p === 'master.volume' ? ['fx', 'master', 'volume'] : p.split('.');
    const got = segs[0] === 'drone' ? reloaded.drone[segs[1]] : segs.reduce((o, k) => (o == null ? undefined : o[k]), reloaded.patch);
    assert.deepEqual(got, v, `${p} survives a reload`);
  }
});

test('normalizeSong: optional strip/master params are clamped when present and stay absent otherwise', () => {
  const f = JSON.parse(JSON.stringify(FACTORY_SONGS[0]));
  const plain = normalizeSong(f, 'x');
  assert.equal('width' in plain.patch.slots[0], false);
  assert.equal('eq' in plain.patch.slots[0], false);
  assert.equal('eq' in plain.patch.fx, false);
  f.patch.slots[0].width = 9;
  f.patch.slots[0].eq = { low: -40, high: 3 };
  f.patch.fx.eq = { low: 30, mid: 1, high: -2 };
  f.patch.fx.comp = { amount: 4 };
  const n = normalizeSong(f, 'x');
  assert.equal(n.patch.slots[0].width, 1.5);
  assert.deepEqual(n.patch.slots[0].eq, { low: -12, high: 3 });
  assert.deepEqual(n.patch.fx.eq, { low: 12, mid: 1, high: -2 });
  assert.deepEqual(n.patch.fx.comp, { amount: 1 });
  assert.deepEqual(normalizeSong(n, 'x'), n, 'idempotent');
});

test("category 'synth' is a known category and round-trips", () => {
  assert.ok(SONG_CATEGORIES.includes('synth') && SONG_CATEGORIES.includes('user'));
  const s = makeStore();
  const id = s.currentSong().id;
  assert.equal(s.set(`songs.${id}.category`, 'synth'), true);
  assert.equal(s.getSong(id).category, 'synth');
  assert.ok(FACTORY_SONGS.some((x) => x.category === 'synth'));
});

test('seedFactory tops up a factory-v1 library once with the v2 songs (library only, not the setlist)', () => {
  const v1 = FACTORY_SONGS.filter((f) => FACTORY_SINCE[f.id] === 1);
  const storage = memoryStorage();
  const a = createStore({ storage, idGen: idGen(), requestIdle: null, warn: () => {}, autoFlush: false, factory: v1 });
  a.update((d) => {
    d.meta.factoryVersion = 1;
  });
  const deleted = a.get().songOrder[2];
  a.deleteSong(deleted);
  a.persistNow();
  const before = a.get();
  const b = createStore({ storage, idGen: () => `n${Math.random().toString(36).slice(2)}`, requestIdle: null, warn: () => {}, autoFlush: false });
  const added = b.seedFactory();
  assert.equal(added.length, FACTORY_SONGS.length - v1.length);
  assert.deepEqual(added.map((id) => b.getSong(id).factoryId), FACTORY_SONGS.filter((f) => FACTORY_SINCE[f.id] === 2).map((f) => f.id));
  assert.equal(b.get().meta.factoryVersion, FACTORY_VERSION);
  assert.deepEqual(b.get().songOrder.slice(0, before.songOrder.length), before.songOrder, 'appended to the library');
  assert.deepEqual(b.get().setlists, before.setlists, 'setlists untouched');
  assert.equal(b.get().settings.currentSongId, before.settings.currentSongId);
  assert.equal(b.getSong(deleted), null, 'a deleted v1 song does not come back');
  assert.deepEqual(b.seedFactory(), [], 'once');
  // an already-current library is untouched
  const c = makeStore();
  const order = c.get().songOrder;
  assert.deepEqual(c.seedFactory(), []);
  assert.equal(c.get().songOrder, order);
});

// ------------------------------------------------------------------------------------------ controller
test('controller: preload pins — setlist {pin:replace}, neighbours {pin:add}', async () => {
  // morning-prep: a selected setlist is pinned whole (the fake engine has no estimatePreloadMB, so no budget check)
  // and its neighbours join it; without a setlist only the current window is pinned (memory.test.mjs)
  const store = makeStore();
  const set = store.get().songOrder.slice(0, 6);
  store.setCurrentSetlist(store.addSetlist('Set', set));
  const { engine, ctl } = await setupCtl({ store });
  await tick();
  await tick();
  const pre = engine.of('preload');
  assert.ok(pre.some((c) => c[2] && c[2].pin === 'replace' && c[1].length === set.length), 'the setlist, replace');
  await ctl.nextSong();
  await tick();
  const after = engine.of('preload');
  assert.ok(after.some((c) => c[2] && c[2].pin === 'add' && c[1].length <= 2), 'neighbours, add');
  assert.ok(after.every((c) => c[2] && ['add', 'replace'].includes(c[2].pin)), 'never the engine default (auto)');
});

test('controller: a refused commit (restart during prepare, engine-core #18) re-runs selectSong once, then reverts', async () => {
  const engine = fakeEngine();
  let refuse = 0;
  engine.commit = (...a) => {
    engine.calls.push(['commit', ...a]);
    if (refuse > 0) {
      refuse -= 1;
      return false;
    }
    return true;
  };
  const { store, ctl, warns } = await setupCtl({ engine });
  const ids = store.navIds();
  refuse = 1;
  engine.clear();
  assert.equal(await ctl.selectSong(ids[1]), true);
  assert.equal(engine.of('prepare').length, 2, 'prepared again');
  assert.equal(engine.of('commit').length, 2);
  assert.equal(ctl.status.songId, ids[1]);
  refuse = 2;
  assert.equal(await ctl.selectSong(ids[2]), false);
  assert.equal(ctl.status.songId, ids[1], 'back to what the engine plays');
  assert.equal(store.get().settings.currentSongId, ids[1]);
  assert.ok(warns.some((w) => /refused/.test(w)));
});

test('controller: status.pedal follows CC64 after pedalInvert (and Space / panic)', async () => {
  const { ctl, midi, store } = await setupCtl();
  const seen = [];
  ctl.on('status', (s) => seen.push(s.pedal));
  assert.equal(ctl.status.pedal, false);
  inject(midi, [0xb0, 64, 127]);
  assert.equal(ctl.status.pedal, true);
  inject(midi, [0xb0, 64, 0]);
  assert.equal(ctl.status.pedal, false);
  store.set('settings.pedalInvert', true);
  await tick();
  inject(midi, [0xb0, 64, 0]); // reversed pedal at rest… pressed
  assert.equal(ctl.status.pedal, true);
  ctl.panic();
  assert.equal(ctl.status.pedal, false);
  assert.ok(seen.includes(true) && seen.includes(false));
});

test("controller: 'songSelected' carries snapshots; revertSong() restores sound edits but keeps the name", async () => {
  const { ctl, store, engine } = await setupCtl();
  const events = [];
  const off = ctl.on('songSelected', (d) => events.push(d));
  const ids = store.navIds();
  await ctl.selectSong(ids[0]);
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.id, ids[0]);
  assert.deepEqual(ev.patchSnapshot, JSON.parse(JSON.stringify(store.getSong(ids[0]).patch)));
  assert.equal(Object.isFrozen(ev.patchSnapshot), false, 'a plain copy the UI may keep');
  const orig = store.getSong(ids[0]);
  store.set('slots.0.gain', 0.2);
  store.set('fx.reverb.size', 0.99);
  store.set('drone.gain', 0.1);
  store.set('song.name', 'Renamed');
  store.set('song.tempo', 133);
  await tick();
  engine.clear();
  assert.equal(ctl.revertSong(), true);
  await tick();
  const now = store.getSong(ids[0]);
  assert.deepEqual(now.patch, orig.patch);
  assert.deepEqual(now.drone, orig.drone);
  assert.equal(now.tempo, orig.tempo);
  assert.equal(now.name, 'Renamed');
  assert.ok(engine.of('setParam').some((c) => c[1] === 'slots.0.gain' && c[2] === orig.patch.slots[0].gain), 'the engine follows the revert');
  assert.equal(ctl.revertSong(), false, 'nothing left to revert');
  off();
  await ctl.selectSong(ids[1]);
  assert.equal(events.length, 1, 'unsubscribed');
});

test('controller: slot strip params (width, eq.*) reach the engine; a removed one sends the table default', async () => {
  const { ctl, store, engine } = await setupCtl();
  await tick();
  engine.clear();
  store.set('slots.0.width', 0.4);
  store.set('slots.0.eq.low', -3);
  store.set('fx.eq.high', 2);
  store.set('fx.comp.amount', 0.5);
  await tick();
  const sp = engine.of('setParam').map((c) => [c[1], c[2]]);
  assert.deepEqual(sp, [['slots.0.width', 0.4], ['slots.0.eq.low', -3], ['fx.eq.high', 2], ['fx.comp.amount', 0.5]]);
  engine.clear();
  const id = store.currentSong().id;
  store.update((d) => {
    delete d.songs[id].patch.slots[0].width;
  });
  await tick();
  assert.deepEqual(engine.of('setParam').map((c) => [c[1], c[2]]), [['slots.0.width', 1]]);
  assert.equal(ctl.status.songId, id);
});

test('sustain: store validation of slots.<i>.release / pedalHold (optional, words, removal, normalize, reload)', () => {
  const storage = memoryStorage();
  const s = makeStore({ storage });
  const id = s.currentSong().id;
  const sl = () => s.currentSong().patch.slots[0];
  assert.equal('release' in sl() || 'pedalHold' in sl(), false, 'absent by default (today’s sound)');
  assert.equal(s.set('slots.0.release', 2.5), true);
  assert.equal(sl().release, 2.5);
  assert.equal(s.set('slots.0.release', 50), true);
  assert.equal(sl().release, 8, 'clamped to 8 s');
  assert.equal(s.set('slots.0.release', 'long'), false, 'a string is refused');
  assert.equal(s.set('slots.0.release', Number.NaN), false);
  assert.equal(s.set('slots.0.release', null), true, 'null removes it (the instrument’s own again)');
  assert.equal('release' in sl(), false);
  assert.equal(s.set('slots.0.pedalHold', 6), true);
  assert.equal(sl().pedalHold, 6);
  assert.equal(s.set('slots.0.pedalHold', 0.5), true);
  assert.equal(sl().pedalHold, 2, 'clamped to 2 s');
  assert.equal(s.set('slots.0.pedalHold', 'natural'), true);
  assert.equal(sl().pedalHold, 'natural');
  assert.equal(s.set('slots.0.pedalHold', 'forever'), false, 'only the table’s words');
  assert.equal(s.set('slots.0.pedalHold', undefined), true);
  assert.equal('pedalHold' in sl(), false);
  // a stored song with junk values normalizes (SCHEMA unchanged, fields optional)
  const raw = JSON.parse(JSON.stringify(s.currentSong()));
  raw.patch.slots[0] = { ...raw.patch.slots[0], release: -4, pedalHold: 'forever' };
  raw.patch.slots[1] = { ...raw.patch.slots[1], release: null, pedalHold: 90 };
  const n = normalizeSong(raw, id);
  assert.deepEqual([n.patch.slots[0].release, n.patch.slots[0].pedalHold], [0.05, 'natural']);
  assert.equal('release' in n.patch.slots[1], false, 'a null release stays absent');
  assert.equal(n.patch.slots[1].pedalHold, 30);
  // persisted and reloaded as set
  s.set('slots.1.release', 1.2);
  s.set('slots.1.pedalHold', 12);
  assert.ok(s.persistNow());
  const b = createStore({ storage, idGen: idGen(), requestIdle: null, warn: () => {}, autoFlush: false });
  const r = b.getSong(id).patch.slots[1];
  assert.deepEqual([r.release, r.pedalHold], [1.2, 12]);
});

test('sustain: controller sends slots.<i>.release / pedalHold; a removed one sends the table default (null / natural)',
  async () => {
    const { store, engine } = await setupCtl();
    await tick();
    engine.clear();
    store.set('slots.0.release', 3);
    store.set('slots.1.pedalHold', 8);
    await tick();
    assert.deepEqual(engine.of('setParam').map((c) => [c[1], c[2]]), [['slots.0.release', 3], ['slots.1.pedalHold', 8]]);
    engine.clear();
    store.set('slots.0.release', null);
    store.set('slots.1.pedalHold', undefined);
    await tick();
    assert.deepEqual(engine.of('setParam').map((c) => [c[1], c[2]]), [['slots.0.release', null], ['slots.1.pedalHold', 'natural']]);
  });

test('controller: rescanUserSamples() → rig rescan + engine.reloadManifests(); without it a warn asks for a restart', async () => {
  const rigCalls = [];
  const rig = { rescanUserSamples: async () => (rigCalls.push('rescan'), { count: 3, errors: [] }) };
  const engine = fakeEngine();
  let reloaded = 0;
  engine.reloadManifests = async () => {
    reloaded += 1;
  };
  const a = await setupCtl({ engine, rig });
  const events = [];
  a.ctl.on('user-samples', (d) => events.push(d));
  assert.deepEqual(await a.ctl.rescanUserSamples(), { count: 3, reloaded: true, errors: [] });
  assert.equal(reloaded, 1);
  assert.deepEqual(rigCalls, ['rescan']);
  assert.equal(events.length, 1);
  await a.ctl.onMenu('rescanUserSamples');
  assert.equal(reloaded, 2, 'menu id wired');

  const b = await setupCtl({ rig: { rescanUserSamples: async () => ({ count: 1, errors: ['X: bad manifest'] }) } });
  const r = await b.ctl.rescanUserSamples();
  assert.deepEqual(r, { count: 1, reloaded: false, errors: ['X: bad manifest'] });
  assert.ok(b.warns.some((w) => /1 instrument found\. Restart/.test(w)), b.warns.join('|'));
  assert.ok(b.warns.some((w) => /bad manifest/.test(w)));
  const c = await setupCtl({ rig: { rescanUserSamples: async () => ({ error: 'boom' }) } });
  assert.equal((await c.ctl.rescanUserSamples()).error, 'boom');
});
