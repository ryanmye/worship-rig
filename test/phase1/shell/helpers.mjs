// Shared fakes for shell node:tests.
import { createStore, memoryStorage } from '../../../app/js/store.js';

export function idGen() {
  let n = 0;
  return (prefix) => `${prefix}${++n}`;
}

export function makeStore(opts = {}) {
  return createStore({ storage: opts.storage || memoryStorage(), idGen: idGen(), requestIdle: null, warn: () => {}, autoFlush: false, ...opts });
}

export const tick = () => new Promise((r) => setTimeout(r, 0));

/** Fake AudioEngine recording every call. prepare() resolves immediately unless `manual` is set. */
export function fakeEngine({ manual = false } = {}) {
  const e = new EventTarget();
  const calls = [];
  const pending = [];
  let tok = 0;
  const rec = (name) => (...args) => {
    calls.push([name, ...args]);
  };
  e.calls = calls;
  e.pending = pending;
  e.ctx = { state: 'running', currentTime: 0, sampleRate: 48000, resume: () => { calls.push(['ctx.resume']); return Promise.resolve(); } };
  e.latencyMs = 12;
  e.start = () => { calls.push(['start']); return Promise.resolve(); };
  e.restart = (o) => { calls.push(['restart', o]); e.ctx = { ...e.ctx, state: 'running' }; return Promise.resolve(); };
  e.prepare = (patch) => {
    const token = ++tok;
    calls.push(['prepare', token, patch]);
    if (!manual) return Promise.resolve(token);
    return new Promise((resolve, reject) => pending.push({ token, patch, resolve: () => resolve(token), reject }));
  };
  for (const n of ['commit', 'preload', 'setParam', 'setTranspose', 'setRouting', 'setTempo', 'noteOn', 'noteOff', 'sustain',
    'pitchBend', 'modWheel', 'expression', 'volumeCC', 'setWheel', 'swell', 'allNotesOff', 'fadeOutAll', 'setSinkId', 'setMono', 'setKeyContext']) e[n] = rec(n);
  e.drone = {
    setKey: rec('drone.setKey'),
    configure: rec('drone.configure'),
    attachFiles: (list) => (calls.push(['drone.attachFiles', list]), list.filter((f) => !/random/.test(f.name)).length),
  };
  e.names = () => calls.map((c) => c[0]);
  e.of = (name) => calls.filter((c) => c[0] === name);
  e.clear = () => calls.splice(0);
  return e;
}

/** Fake timers (manual interval/timeout driving). */
export function fakeTimers() {
  let id = 0;
  const intervals = new Map();
  const timeouts = new Map();
  return {
    setInterval: (fn, ms) => (intervals.set(++id, { fn, ms }), id),
    clearInterval: (i) => intervals.delete(i),
    setTimeout: (fn, ms) => (timeouts.set(++id, { fn, ms }), id),
    clearTimeout: (i) => timeouts.delete(i),
    runIntervals: () => { for (const { fn } of [...intervals.values()]) fn(); },
    runTimeouts: () => { const t = [...timeouts.entries()]; timeouts.clear(); for (const [, { fn }] of t) fn(); },
    intervals,
    timeouts,
  };
}

/** Minimal document-like EventTarget with a settable activeElement. */
export function fakeDoc() {
  const d = new EventTarget();
  d.body = { tagName: 'BODY' };
  d.documentElement = { tagName: 'HTML' };
  d.activeElement = d.body;
  d.visibilityState = 'visible';
  return d;
}

export function key(doc, type, props) {
  const ev = new Event(type, { cancelable: true });
  Object.assign(ev, { code: '', key: '', repeat: false, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...props });
  doc.dispatchEvent(ev);
  return ev;
}
