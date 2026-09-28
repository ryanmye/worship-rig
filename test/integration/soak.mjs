#!/usr/bin/env node
// Soak: real-time random playing against the REAL app (server.js + app/) in headless Chromium (SPEC §11).
//   node test/integration/soak.mjs [--minutes 20] [--fast] [--seed N] [--sample-sec 30] [--headed] [--no-setlist]
//   --no-setlist = deselect the seeded "My Set" (all factory songs) first, so navigation is the library order
//   --fast = --minutes 2 (unless --minutes is given). SOAK_MINUTES env also works.
//
// Warm-up: every factory song is selected once and a chord is played on it (decodes every sample set, creates any
// lazily built FX such as lofi), then the reference song (first in the library) is selected, everything released,
// GC'd and measured → baseline {nodes, JS heap}.
// Random phase (seeded, in-page so timing is real-time): notes and 1–4-note chords (vel 30–127, holds 80 ms–2.5 s),
// sustain pedal, mod-wheel sweeps, pitch bend, expression; song switch every 20–40 s (every 3rd switch goes to a lofi
// song; half the switches happen while a chord is held), panic every 45–120 s, drone key changes (transposeBy)
// every 25–50 s. engine._debugStats() + performance.memory are sampled every --sample-sec → test/logs/soak.csv;
// the analysers are checked for NaN every 250 ms.
// End: release everything (no panic) → keyboard voices must reach 0 within 20 s; reference song re-selected at its
// baseline key → nodes ≤ baseline × 1.10; JS heap growth (after GC) < 20 MB; zero console.error; zero NaN.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { checker, freePort, logsDir, repoRoot, sleep, waitRigReady } from './lib.mjs';

const require = createRequire(import.meta.url);
const { createServer } = require('../../server.js');

const argv = process.argv.slice(2);
const arg = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
const FAST = argv.includes('--fast');
const MINUTES = Number(arg('--minutes', process.env.SOAK_MINUTES || (FAST ? 2 : 20)));
const SEED = Number(arg('--seed', Date.now() % 1e9));
const SAMPLE_SEC = Number(arg('--sample-sec', 30));
const HEADED = argv.includes('--headed');
const NO_SETLIST = argv.includes('--no-setlist');
const CSV = path.join(logsDir, 'soak.csv');

const { check, finish } = checker('soak');
console.log(`# soak: ${MINUTES} min random phase, seed ${SEED}, sample every ${SAMPLE_SEC} s`);

// ------------------------------------------------------------------------------------------------ page side
/** Installed into the page with evaluate(); exposes window.__soak. */
const INSTALL = () => {
  // (inline, not eval'd: the app's CSP has no 'unsafe-eval')
  const __itMeter = (engine) => {
    let worst = -Infinity;
    let nan = false;
    for (const an of [engine.analyserL, engine.analyserR]) {
      if (!an) continue;
      const buf = new Float32Array(an.fftSize);
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i];
        if (!Number.isFinite(v)) nan = true;
        else s += v * v;
      }
      worst = Math.max(worst, 10 * Math.log10(s / buf.length + 1e-20));
    }
    return { db: worst, nan };
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rig = window.__rig;
  const { engine, controller, store } = rig;
  const S = (window.__soak = {
    events: 0, notes: 0, chords: 0, switches: 0, lofiSwitches: 0, panics: 0, keyChanges: 0, sweeps: 0,
    nan: 0, nanAt: [], maxDb: -Infinity, done: false, error: null, stop: false, log: [],
  });
  const droneVoices = () => (engine.drone && engine.drone.liveVoiceCount ? engine.drone.liveVoiceCount() : 0);
  const kbVoices = () => engine._debugStats().voices - droneVoices();
  S.kbVoices = kbVoices;
  S.droneVoices = droneVoices;
  S.heap = () => (performance.memory ? performance.memory.usedJSHeapSize : null);
  S.gc = async () => {
    if (typeof window.gc === 'function') {
      for (let i = 0; i < 3; i++) {
        window.gc();
        await sleep(200);
      }
    }
  };
  S.snapshot = () => {
    const st = engine._debugStats();
    return {
      ...st, droneVoices: droneVoices(), kbVoices: st.voices - droneVoices(), heap: S.heap(), ctxTime: engine.ctx ? +engine.ctx.currentTime.toFixed(2) : null,
      ctxState: engine.ctx ? engine.ctx.state : 'none', audio: controller.status.audio, memMode: controller.status.memory?.mode, budgetMB: controller.status.memory?.budgetMB, memNote: controller.status.memory?.note, song: store.currentSong()?.factoryId || store.currentSong()?.id,
      events: S.events, switches: S.switches, panics: S.panics, keyChanges: S.keyChanges, nan: S.nan, maxDb: +S.maxDb.toFixed(1),
    };
  };
  // NaN / level monitor
  S.monitor = setInterval(() => {
    try {
      const r = __itMeter(engine);
      if (r.nan) {
        S.nan += 1;
        if (S.nanAt.length < 20) S.nanAt.push({ t: performance.now(), song: store.currentSong()?.factoryId });
      }
      if (Number.isFinite(r.db)) S.maxDb = Math.max(S.maxDb, r.db);
    } catch (e) {
      S.error = String(e);
    }
  }, 250);

  const waitSong = async (id, ms = 30000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const s = controller.status;
      if (!s.loading && s.songId === id) return true;
      await sleep(50);
    }
    return false;
  };
  S.waitSong = waitSong;

  /** Warm-up: every song once with a chord; returns per-song peak level. */
  S.warmup = async () => {
    const out = [];
    for (const id of store.get().songOrder) {
      await controller.selectSong(id);
      const loaded = await waitSong(id);
      for (const n of [48, 60, 64, 67]) controller.perform.noteOn(n, 96);
      let m = -Infinity;
      for (let i = 0; i < 60; i++) {
        m = Math.max(m, __itMeter(engine).db);
        await sleep(20);
      }
      for (const n of [48, 60, 64, 67]) controller.perform.noteOff(n);
      await sleep(250);
      out.push({ id: store.getSong(id).factoryId || id, loaded, db: +m.toFixed(1) });
    }
    return out;
  };

  /** Release everything the way a player would (no panic) and wait for keyboard voices = 0. */
  S.releaseAndWait = async (ms = 20000) => {
    controller.perform.releaseAll();
    controller.perform.sustain(false);
    controller.perform.wheel(0);
    controller.perform.bend(0);
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const st = engine._debugStats();
      if (st.voices - droneVoices() === 0 && st.sounding === 0 && st.pedaled === 0) return { ok: true, sec: +((performance.now() - t0) / 1000).toFixed(2), stats: st };
      await sleep(100);
    }
    return { ok: false, sec: ms / 1000, stats: engine._debugStats(), droneVoices: droneVoices() };
  };

  /** Wait until nodes / voices / retiring are stable for 2 s (drone crossfades, FX tails). */
  S.settle = async (ms = 25000) => {
    const t0 = performance.now();
    let last = null;
    let since = performance.now();
    while (performance.now() - t0 < ms) {
      const st = engine._debugStats();
      const key = `${st.nodes}/${st.voices}/${st.retiring}`;
      if (key !== last) {
        last = key;
        since = performance.now();
      } else if (performance.now() - since >= 2000 && st.retiring === 0) return { ok: true, stats: st };
      await sleep(100);
    }
    return { ok: false, stats: engine._debugStats() };
  };

  /** The random real-time phase. */
  S.run = async ({ seed, durationMs }) => {
    let a = seed >>> 0;
    const rnd = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const rint = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
    const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
    const held = new Map(); // note → count of our own pending note-offs
    const on = (n, v) => {
      if (n < 21 || n > 108) return;
      controller.perform.noteOn(n, v);
      held.set(n, (held.get(n) || 0) + 1);
      S.events += 1;
      S.notes += 1;
    };
    const off = (n) => {
      controller.perform.noteOff(n);
      S.events += 1;
      const c = (held.get(n) || 1) - 1;
      if (c <= 0) held.delete(n);
      else held.set(n, c);
    };
    const songs = store.get().songOrder.map((id) => ({ id, lofi: store.getSong(id).category === 'lofi' }));
    const lofi = songs.filter((s) => s.lofi);
    const t0 = performance.now();
    const now = () => performance.now() - t0;
    let nextSwitch = rint(20000, 40000);
    let nextPanic = rint(45000, 90000); // first one early so a 2-min run has one
    let nextKey = rint(25000, 50000);
    let pedal = false;
    let pedalSince = 0;
    let wheel = 0;
    let sweeping = false;
    const sweep = async (to, ms) => {
      sweeping = true;
      S.sweeps += 1;
      const from = wheel;
      const steps = Math.max(5, Math.round(ms / 40));
      for (let i = 1; i <= steps && !S.stop; i++) {
        wheel = from + ((to - from) * i) / steps;
        controller.perform.wheel(wheel);
        S.events += 1;
        await sleep(ms / steps);
      }
      sweeping = false;
    };
    try {
      while (now() < durationMs && !S.stop) {
        const r = rnd();
        if (r < 0.5) {
          // note or chord
          const size = rnd() < 0.55 ? 1 : rint(2, 4);
          const root = rint(36, 84);
          const shape = pick([[0, 4, 7, 12], [0, 3, 7, 10], [0, 5, 7, 14], [0, 7, 12, 16], [0, 2, 7, 11]]);
          const vel = rint(30, 127);
          const hold = rnd() < 0.8 ? rint(80, 900) : rint(900, 2500);
          const notes = shape.slice(0, size).map((d) => root + d);
          for (const n of notes) on(n, vel);
          if (size > 1) S.chords += 1;
          setTimeout(() => notes.forEach(off), hold);
        } else if (r < 0.62) {
          pedal = !pedal;
          pedalSince = now();
          controller.perform.sustain(pedal);
          S.events += 1;
        } else if (r < 0.68) {
          if (!sweeping) sweep(rnd(), rint(800, 3000));
        } else if (r < 0.71) {
          const b = rnd() * 2 - 1;
          controller.perform.bend(b);
          setTimeout(() => controller.perform.bend(0), rint(100, 600));
          S.events += 2;
        } else if (r < 0.73) {
          controller.perform.expression(0.3 + rnd() * 0.7);
          S.events += 1;
        }
        if (pedal && now() - pedalSince > 6000) {
          pedal = false;
          controller.perform.sustain(false);
        }
        if (now() >= nextSwitch) {
          nextSwitch = now() + rint(20000, 40000);
          const wantLofi = S.switches % 3 === 1 && lofi.length;
          const cur = store.get().settings.currentSongId;
          const pool = (wantLofi ? lofi : songs).filter((s) => s.id !== cur);
          const target = pick(pool.length ? pool : songs);
          const holdChord = rnd() < 0.5;
          const chord = holdChord ? [rint(48, 60)].flatMap((x) => [x, x + 4, x + 7]) : [];
          for (const n of chord) on(n, 90);
          S.switches += 1;
          if (target.lofi) S.lofiSwitches += 1;
          S.log.push({ t: Math.round(now() / 1000), switch: store.getSong(target.id).factoryId || target.id, holdChord });
          await controller.selectSong(target.id);
          await waitSong(target.id, 20000);
          if (chord.length) setTimeout(() => chord.forEach(off), 1000);
        }
        if (now() >= nextPanic) {
          nextPanic = now() + rint(45000, 120000);
          controller.panic();
          held.clear();
          pedal = false;
          S.panics += 1;
          S.events += 1;
          S.log.push({ t: Math.round(now() / 1000), panic: true });
        }
        if (now() >= nextKey) {
          nextKey = now() + rint(25000, 50000);
          const d = pick([-5, -3, -2, -1, 1, 2, 3, 5]);
          if (!controller.transposeBy(d)) controller.transposeBy(-d);
          S.keyChanges += 1;
          S.events += 1;
          S.log.push({ t: Math.round(now() / 1000), key: store.currentSong().hearIn });
        }
        await sleep(rint(60, 500));
      }
      // let our own pending note-offs fire
      await sleep(2700);
    } catch (e) {
      S.error = String((e && e.stack) || e);
    }
    S.done = true;
  };
};

// ------------------------------------------------------------------------------------------------ node side
fs.mkdirSync(logsDir, { recursive: true });
const port = await freePort();
const server = createServer({ appDir: path.join(repoRoot, 'app'), port });
const info = await server.listen();
const base = `http://127.0.0.1:${info.port}`;
const browser = await chromium.launch({
  channel: 'chromium',
  headless: !HEADED,
  args: ['--autoplay-policy=no-user-gesture-required', '--enable-precise-memory-info', '--js-flags=--expose-gc', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
const consoleErrors = [];
const rows = [];
const COLS = ['t_s', 'phase', 'song', 'voices', 'kbVoices', 'droneVoices', 'nodes', 'retiring', 'sounding', 'pedaled', 'timers', 'decodedMB', 'pinnedMB', 'capMB', 'budgetMB', 'memMode', 'memNote', 'heapMB', 'ctxTime', 'ctxState', 'audio', 'events', 'switches', 'panics', 'keyChanges', 'nan', 'maxDb'];
const tStart = Date.now();
let exitCode = 1;

function record(phase, s) {
  const row = { t_s: Math.round((Date.now() - tStart) / 1000), phase, ...s, heapMB: s.heap != null ? +(s.heap / 1048576).toFixed(2) : '' };
  rows.push(row);
  fs.writeFileSync(CSV, [COLS.join(','), ...rows.map((r) => COLS.map((c) => JSON.stringify(r[c] ?? '')).join(','))].join('\n') + '\n');
  console.log(`[${String(row.t_s).padStart(5)} s] ${phase.padEnd(8)} ${String(row.song).padEnd(28)} voices ${row.voices} (kb ${row.kbVoices}, drone ${row.droneVoices}) nodes ${row.nodes} retiring ${row.retiring} heap ${row.heapMB} MB decoded ${row.decodedMB} MB (pinned ${row.pinnedMB}, ${row.memMode}) events ${row.events} nan ${row.nan} audio ${row.audio}`);
  return row;
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    await context.grantPermissions(['midi'], { origin: base });
  } catch {
    /* not supported in this build */
  }
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`${m.text()} @ ${m.location()?.url || ''}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('crash', () => consoleErrors.push('page crashed'));
  await page.goto(`${base}/`);
  await page.waitForFunction(() => !!window.__rig, null, { timeout: 30000 });
  // L-4: bounded; a hang throws with controller.status.midi instead of eating the soak's budget.
  await waitRigReady(page, { timeout: 30000, what: 'soak: window.__rig.ready' });
  await page.evaluate((ms) => Promise.race([window.__rig.viewsReady, new Promise((_, rej) =>
    setTimeout(() => rej(new Error(`soak: window.__rig.viewsReady did not resolve within ${ms} ms`)), ms))]), 30000);
  if (await page.isVisible('#overlay-start')) await page.click('#overlay-start');
  await page.waitForFunction(() => window.__rig.engine.ctx && window.__rig.engine.ctx.state === 'running', null, { timeout: 10000 });
  await page.evaluate(INSTALL);
  if (NO_SETLIST) {
    await page.evaluate(async () => {
      window.__rig.store.setCurrentSetlist(null);
      for (let i = 0; i < 100 && !window.__rig.controller.status.ready; i++) await new Promise((r) => setTimeout(r, 100));
    });
  }
  console.log(`# navigation: ${await page.evaluate(() => (window.__rig.store.currentSetlist() ? `setlist "${window.__rig.store.currentSetlist().name}" (${window.__rig.store.navIds().length} songs)` : 'library order (no setlist)'))}`);

  // warm-up + baseline
  const warm = await page.evaluate(() => window.__soak.warmup());
  record('warmup', await page.evaluate(() => window.__soak.snapshot()));
  console.log(`# warm-up: ${warm.map((w) => `${w.id} ${w.db} dB${w.loaded ? '' : ' (NOT LOADED)'}`).join(', ')}`);
  check('warm-up: every song loads and sounds (> −50 dBFS)', warm.every((w) => w.loaded && w.db > -50), warm.filter((w) => !w.loaded || w.db <= -50).map((w) => `${w.id}: ${w.db}`).join(', ') || `${warm.length} songs`);
  const ref = await page.evaluate(async () => {
    const { store, controller } = window.__rig;
    const id = store.get().songOrder[0];
    await controller.selectSong(id);
    await window.__soak.waitSong(id);
    const s = store.getSong(id);
    return { id, factoryId: s.factoryId, hearIn: s.hearIn, transposeOctave: s.transposeOctave };
  });
  const quiesce = async () =>
    page.evaluate(async () => {
      const rel = await window.__soak.releaseAndWait(20000);
      const settle = await window.__soak.settle(25000);
      await window.__soak.gc();
      await new Promise((r) => setTimeout(r, 500));
      return { rel, settle, snap: window.__soak.snapshot() };
    });
  const q0 = await quiesce();
  const baseline = record('baseline', q0.snap);
  console.log(`# baseline on ${ref.factoryId}: nodes ${baseline.nodes}, heap ${baseline.heapMB || 'n/a'} MB (settled ${q0.settle.ok})`);

  // random phase
  const durationMs = Math.round(MINUTES * 60000);
  await page.evaluate(({ seed, durationMs }) => {
    window.__soak.run({ seed, durationMs });
  }, { seed: SEED, durationMs });
  const tRun = Date.now();
  let nextSample = tRun + SAMPLE_SEC * 1000;
  for (;;) {
    await sleep(1000);
    const done = await page.evaluate(() => window.__soak.done);
    if (Date.now() >= nextSample || done) {
      nextSample += SAMPLE_SEC * 1000;
      record(done ? 'end' : 'play', await page.evaluate(() => window.__soak.snapshot()));
    }
    if (done) break;
    if (Date.now() - tRun > durationMs + 120000) {
      await page.evaluate(() => (window.__soak.stop = true));
      check('random phase finished on time', false, 'driver did not finish within duration + 2 min');
      break;
    }
  }
  const summary = await page.evaluate(() => {
    const S = window.__soak;
    return { events: S.events, notes: S.notes, chords: S.chords, switches: S.switches, lofiSwitches: S.lofiSwitches, panics: S.panics, keyChanges: S.keyChanges, sweeps: S.sweeps, nan: S.nan, nanAt: S.nanAt, error: S.error, log: S.log };
  });
  console.log(`# random phase: ${JSON.stringify({ ...summary, log: undefined, nanAt: undefined })}`);
  console.log(`# timeline: ${summary.log.map((l) => `${l.t}s ${l.switch ? `→${l.switch}${l.holdChord ? '(held)' : ''}` : l.panic ? 'PANIC' : `key ${l.key}`}`).join(', ')}`);
  check('driver ran without throwing', !summary.error, summary.error || '');
  const expSwitches = Math.max(1, Math.floor((MINUTES * 60) / 40));
  check(`exercised: ≥ ${expSwitches} song switches incl. a lofi song, key changes, sweeps, ≥ ${Math.round(MINUTES * 100)} events`,
    summary.switches >= expSwitches && (MINUTES < 1 || summary.lofiSwitches >= 1) && summary.events >= MINUTES * 100 && (MINUTES < 1 || summary.keyChanges >= 1),
    `${summary.switches} switches (${summary.lofiSwitches} lofi), ${summary.panics} panics, ${summary.keyChanges} key changes, ${summary.sweeps} sweeps, ${summary.events} events`);

  // end state: release (no panic) → voices 0
  const rel = await page.evaluate(() => window.__soak.releaseAndWait(20000));
  check('keyboard voices back to 0 after release (≤ 20 s, no panic)', rel.ok, `${rel.sec} s: ${JSON.stringify(rel.stats)}`);
  // reference song at its baseline key → node count vs baseline
  await page.evaluate(async (r) => {
    const { store, controller } = window.__rig;
    store.set(`songs.${r.id}.hearIn`, r.hearIn);
    store.set(`songs.${r.id}.transposeOctave`, r.transposeOctave);
    await controller.selectSong(r.id);
    await window.__soak.waitSong(r.id);
  }, ref);
  const q1 = await quiesce();
  const end = record('final', q1.snap);
  check('final state settled (nodes/voices stable, nothing retiring)', q1.settle.ok, JSON.stringify(q1.settle.stats));
  check('node count within +10 % of the post-warm-up baseline', end.nodes <= baseline.nodes * 1.1, `baseline ${baseline.nodes} → ${end.nodes} (${(((end.nodes - baseline.nodes) / baseline.nodes) * 100).toFixed(1)} %)`);
  check('voices on the reference song equal the baseline (drone only)', end.voices === baseline.voices, `baseline ${baseline.voices} → ${end.voices}`);
  if (baseline.heap != null && end.heap != null) {
    const growth = (end.heap - baseline.heap) / 1048576;
    check('JS heap growth < 20 MB (after GC)', growth < 20, `${baseline.heapMB} → ${end.heapMB} MB (${growth >= 0 ? '+' : ''}${growth.toFixed(2)} MB)`);
  } else console.log('SKIP  JS heap growth — performance.memory not available');
  check('audio still running (not stalled / suspended)', end.ctxState === 'running' && end.audio === 'running', `${end.ctxState} / ${end.audio}`);
  check('no NaN on the analysers during the whole run', summary.nan === 0 && end.nan === 0, summary.nan ? JSON.stringify(summary.nanAt) : '');
  // morning-prep (integration-2 round 2 #3): pins are limited, so the LRU keeps the decoded cache under its cap
  const peak = rows.reduce((m, r) => (Number(r.decodedMB) > m.decodedMB ? r : m), { decodedMB: -1 });
  // L-8: and the pinned window is a byte budget (status.memory.budgetMB, 600): pinnedMB ≤ budget in every row, except
  // while the current song alone is bigger (it is then pinned alone, note "This song alone is … MB")
  const pinPeak = rows.reduce((m, r) => (Number(r.pinnedMB) > m.pinnedMB ? r : m), { pinnedMB: -1 });
  const pinsOk = (r) => !(r.budgetMB > 0) || !(r.pinnedMB > r.budgetMB) || /alone/.test(r.memNote || '');
  check('decoded samples stay under the engine cache cap (pins limited)',
    rows.every((r) => (!(r.capMB > 0) || r.decodedMB <= r.capMB) && pinsOk(r)),
    `max ${peak.decodedMB} MB (pinned ${peak.pinnedMB} MB, ${peak.memMode}) of ${peak.capMB} MB cap; max pinned ` +
    `${pinPeak.pinnedMB} MB on ${pinPeak.song} (budget ${pinPeak.budgetMB} MB)`);
  check('zero console.error', consoleErrors.length === 0, consoleErrors.slice(0, 10).join(' | '));
  exitCode = finish();
  console.log(`# CSV: ${path.relative(repoRoot, CSV)} (${rows.length} rows)`);
} catch (e) {
  console.log(`FAIL  soak crashed: ${(e && e.stack) || e}`);
  finish();
  exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  await server.close();
}
process.exit(exitCode);
