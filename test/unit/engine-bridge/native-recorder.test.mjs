// NativeRecorder (G10): replayed against a log recorded from the real native core through rig-devhost
// (data/rec-session.jsonl, made by record-devhost-log.mjs), plus the cases a live session cannot provoke on demand
// (native ends the take, write error, unsupported, not-started, pagehide) on a scripted native side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeEngine } from '../../../app/js/engine-bridge/bridge-engine.js';
import { loopbackPair } from '../../../app/js/engine-bridge/transports.js';
import { NativeRecorder, isBridgeEngine } from '../../../app/js/engine-bridge/native-recorder.js';
import { Recorder } from '../../../app/js/recorder.js';
import { runRecScenario } from './rec-scenario.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(here, 'data/rec-session.jsonl');
const EXPECT = path.join(here, 'data/rec-session.expect.json');
const macro = () => new Promise((r) => setTimeout(r, 0));
const quiet = () => {
  const warn = console.warn;
  console.warn = () => {};
  return () => {
    console.warn = warn;
  };
};

/** Key a message for matching a live post to a recorded one (ids differ, args do not). */
const keyOf = (m) => [m.op, m.action ?? m.what ?? m.e ?? '', m.filename ?? ''].join('|');

/**
 * The recorded native side: each JS post consumes the first unconsumed recorded "in" message with the same key and
 * plays back the native output that followed it in the live session (reply ids remapped), one batch per macrotask
 * so promise continuations interleave as they did live.
 */
function replayNative(lines, native) {
  const segs = [];
  for (const l of lines) {
    if (l.dir === 'in') segs.push({ msg: l.msg, outs: [], used: false });
    else if (segs.length) segs[segs.length - 1].outs.push(l.msg);
  }
  const stats = { matched: 0, unmatched: [] };
  native.onMessage((m) => {
    const seg = segs.find((s) => !s.used && !Array.isArray(s.msg) && keyOf(s.msg) === keyOf(m));
    if (!seg) {
      stats.unmatched.push(keyOf(m));
      return;
    }
    seg.used = true;
    stats.matched += 1;
    const remap = (x) => {
      if (Array.isArray(x)) return x.map(remap);
      if (x && x.re !== undefined && x.re === seg.msg.id) return { ...x, re: m.id };
      return x;
    };
    for (const o of seg.outs) {
      setTimeout(() => native.post(remap(o)), 0);
    }
  });
  return { segs, stats };
}

test('replay of the recorded rig-devhost session gives the facade the same view as live', async () => {
  const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const expect = JSON.parse(fs.readFileSync(EXPECT, 'utf8'));
  const { js, native } = loopbackPair({ schedule: 'sync' });
  const rp = replayNative(lines, native);
  const engine = new BridgeEngine({ transport: js });
  const restore = quiet();
  let got;
  try {
    got = await runRecScenario(engine, { wait: () => new Promise((r) => setTimeout(r, 5)) });
  } finally {
    restore();
    engine._dispose();
  }
  assert.deepEqual(rp.stats.unmatched, [], 'every JS message has a recorded counterpart');
  for (const k of ['states', 'levels', 'warns', 'results', 'errors', 'engineStart', 'committed', 'start1',
    'busyWhileRecording', 'stopWhenIdle', 'nativeStopWhenIdle', 'start2', 'finalState', 'recordingFilename']) {
    assert.deepEqual(got[k], expect[k], k);
  }
  // what the recording looked like on the wire (the core's behaviour the facade relies on)
  assert.equal(expect.wavFiles, 2);
  assert.ok(expect.levels >= 5, 'level events at ~10 Hz while recording');
  assert.ok(expect.maxPeak > 0.01, 'the take is not silence (test voice sounding)');
  assert.ok(Math.abs(expect.results[0].durationSec - 1.4) < 0.3);
  assert.equal(expect.results[0].bytes - 44, expect.results[0].dataBytes);
  assert.equal(expect.results[0].dataBytes, Math.round(expect.results[0].durationSec * 48000) * 4);
  const sent = lines.filter((l) => l.dir === 'in').map((l) => l.msg);
  const recStarts = sent.filter((m) => m.op === 'rec' && m.action === 'start');
  assert.ok(recStarts.every((m) => m.dir === undefined), 'JS never sends a dir (SHELL.md G10)');
  assert.equal(recStarts.filter((m) => m.filename).length, 1, 'filename only when the caller gave one');
  const last = sent[sent.length - 1];
  assert.deepEqual(last, [{ v: 1, op: 'play', e: 'panic' }, { v: 1, op: 'rec', action: 'stop' }],
    'rig-devhost posts panic + rec stop when the page goes away');
});

/** A scripted native: hello/audio/get answered, `rec` replies from `onRec(msg) -> [reply-or-error, ...events]`. */
function scripted(onRec) {
  const { js, native, log } = loopbackPair({ schedule: 'sync' });
  native.onMessage((m) => {
    const reply = (result) => setTimeout(() => native.post({ v: 1, re: m.id, ok: true, result }), 0);
    if (m.op === 'hello') return reply({ protocol: 1, minor: 0, engine: 'scripted', caps: ['rec'], sampleRate: 44100 });
    if (m.op === 'audio') return reply({ state: 'running', sleep: 'awake', latencyMs: 5, sampleRate: 44100 });
    if (m.op === 'get') return reply([]);
    if (m.op !== 'rec' || m.id === undefined) return undefined;
    for (const x of onRec(m)) {
      setTimeout(() => native.post(x.error ? { v: 1, re: m.id, ok: false, error: x.error }
        : x.result !== undefined ? { v: 1, re: m.id, ok: true, result: x.result } : x), 0);
    }
    return undefined;
  });
  const engine = new BridgeEngine({ transport: js });
  return { engine, native, log };
}

const recEvent = (o) => ({ v: 1, ev: 'rec', ...o });

function collect(rec) {
  const c = { states: [], warns: [], levels: [] };
  rec.addEventListener('state', (e) => c.states.push(e.detail));
  rec.addEventListener('warn', (e) => c.warns.push(e.detail.message));
  rec.addEventListener('level', (e) => c.levels.push(e.detail));
  return c;
}

test('native ends the take on its own (rate change): idle with the result and a warning', async () => {
  const s = scripted((m) => (m.action === 'start' ? [{ result: { path: '/r/Rig A.wav' } }] : []));
  const rec = new NativeRecorder({ engine: s.engine });
  const c = collect(rec);
  const restore = quiet();
  try {
    assert.equal((await rec.start()).ok, true);
    s.native.post(recEvent({ state: 'recording', level: { peakL: 0.5, peakR: 0.25 } }));
    s.native.post(recEvent({ state: 'stopped', path: '/r/Rig A.wav', seconds: 12.5, bytes: 2205044,
      message: 'sample rate changed: recording stopped' }));
    await macro();
  } finally {
    restore();
  }
  assert.deepEqual(c.levels, [{ peakL: 0.5, peakR: 0.25, peak: 0.5 }]);
  const last = c.states[c.states.length - 1];
  assert.equal(last.state, 'idle');
  assert.equal(last.result.path, '/r/Rig A.wav');
  assert.equal(last.result.filename, 'Rig A.wav');
  assert.equal(last.result.durationSec, 12.5);
  assert.equal(last.result.dataBytes, 2205000);
  assert.equal(last.result.sampleRate, 44100);
  assert.match(c.warns[0], /sample rate changed/);
  assert.equal(rec.isRecording, false);
  assert.equal(rec.elapsed, 12.5);
  assert.equal(await rec.stop(), null);
  s.engine._dispose();
});

test('write error: while recording, and during our own stop (event before the reply)', async () => {
  const s = scripted((m) => (m.action === 'start' ? [{ result: { path: '/r/x.wav' } }]
    : [recEvent({ state: 'error', path: '/r/x.wav', seconds: 3, bytes: 1000, message: 'rec: write failed (disk full?)' }),
      { result: { path: '/r/x.wav', seconds: 3, bytes: 1000 } }]));
  const restore = quiet();
  try {
    const rec = new NativeRecorder({ engine: s.engine });
    const c = collect(rec);
    await rec.start();
    const r = await rec.stop();
    assert.equal(r.error, 'rec: write failed (disk full?)');
    assert.equal(r.durationSec, 3);
    assert.match(c.warns.join('\n'), /writing the recording failed: rec: write failed/);
    assert.equal(c.states[c.states.length - 1].state, 'idle');
    await rec.start();
    s.native.post(recEvent({ state: 'error', path: '/r/x.wav', seconds: 1, bytes: 88244, message: 'disk gone' }));
    await macro();
    assert.equal(rec.state, 'idle');
    assert.equal(c.states[c.states.length - 1].result.error, 'disk gone');
  } finally {
    restore();
    s.engine._dispose();
  }
});

test('unsupported -> unavailable (main.js shows "Recording isn\'t available"); not-started -> ok:false', async () => {
  const restore = quiet();
  try {
    let s = scripted(() => [{ error: { code: 'unsupported', message: 'rec is not implemented in this build' } }]);
    let rec = new NativeRecorder({ engine: s.engine });
    let c = collect(rec);
    let r = await rec.start();
    assert.deepEqual(r, { ok: false, error: 'Recording unavailable', code: 'unsupported' });
    assert.equal(rec.state, 'unavailable');
    assert.match(c.warns[0], /Recording unavailable: rec is not implemented/);
    assert.equal(c.states[c.states.length - 1].reason, 'rec is not implemented in this build');
    s.engine._dispose();
    s = scripted(() => [{ error: { code: 'not-started', message: 'rec: audio is not started' } }]);
    rec = new NativeRecorder({ engine: s.engine });
    c = collect(rec);
    r = await rec.start();
    assert.equal(r.ok, false);
    assert.equal(r.code, 'not-started');
    assert.equal(rec.state, 'idle');
    assert.deepEqual(c.states.map((x) => x.state), ['starting', 'idle']);
    s.engine._dispose();
  } finally {
    restore();
  }
});

test('pagehide while recording sends a fire-and-forget rec stop; dispose stops listening', async () => {
  const s = scripted((m) => (m.action === 'start' ? [{ result: { path: '/r/p.wav' } }] : []));
  const handlers = {};
  const win = { addEventListener: (n, f) => { handlers[n] = f; }, removeEventListener: (n) => { delete handlers[n]; } };
  const rec = new NativeRecorder({ engine: s.engine, win });
  await rec.start();
  assert.equal(typeof handlers.pagehide, 'function');
  const before = s.log.toNative.length;
  handlers.pagehide();
  const sent = s.log.toNative.slice(before);
  assert.deepEqual(sent, [{ v: 1, op: 'rec', action: 'stop' }]);
  rec.dispose();
  s.native.post(recEvent({ state: 'stopped', path: '/r/p.wav', seconds: 1, bytes: 44 }));
  await macro();
  assert.equal(rec.state, 'recording', 'a disposed facade ignores events');
  s.engine._dispose();
});

test('isBridgeEngine: BridgeEngine (also behind a spy Proxy) yes; Web engine stand-ins no', () => {
  const { js } = loopbackPair();
  const engine = new BridgeEngine({ transport: js });
  assert.equal(isBridgeEngine(engine), true);
  assert.equal(isBridgeEngine(new Proxy(engine, {})), true);
  assert.equal(isBridgeEngine({ ctx: {}, recordTap: {} }), false);
  assert.equal(isBridgeEngine(null), false);
  assert.equal(isBridgeEngine(new Proxy({}, { get() { throw new Error('x'); } })), false);
  engine._dispose();
});

test('surface parity: every public Recorder member exists on NativeRecorder with the same kind', () => {
  const pub = (C) => Object.getOwnPropertyNames(C.prototype).filter((n) => n !== 'constructor' && !n.startsWith('_'));
  const kind = (C, n) => {
    const d = Object.getOwnPropertyDescriptor(C.prototype, n);
    return d.get ? 'getter' : typeof d.value;
  };
  for (const n of pub(Recorder)) {
    assert.ok(pub(NativeRecorder).includes(n), `NativeRecorder.${n}`);
    assert.equal(kind(NativeRecorder, n), kind(Recorder, n), n);
  }
  assert.ok(new NativeRecorder({ engine: null }) instanceof EventTarget);
});
