// Shared fixtures for the engine-bridge unit tests (not a test file).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeEngine } from '../../../app/js/engine-bridge/bridge-engine.js';
import { MockNative } from '../../../app/js/engine-bridge/mock-native.js';
import { loopbackPair } from '../../../app/js/engine-bridge/transports.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const API_PATH = path.join(here, '../../../native/contract/engine-api.json');
export const api = JSON.parse(fs.readFileSync(API_PATH, 'utf8'));

/** A manual page clock (ms) with setTimeout/setInterval, advanced by hand. */
export function fakeEnv(start = 1000) {
  let t = start;
  let seq = 0;
  const jobs = new Map();
  const env = {
    now: () => t,
    timers: {
      setTimeout(fn, ms) {
        const id = ++seq;
        jobs.set(id, { at: t + ms, fn, every: 0 });
        return id;
      },
      clearTimeout(id) {
        jobs.delete(id);
      },
      setInterval(fn, ms) {
        const id = ++seq;
        jobs.set(id, { at: t + ms, fn, every: ms });
        return id;
      },
      clearInterval(id) {
        jobs.delete(id);
      },
    },
    /** Move the clock forward, firing due timers in order. */
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, j] of jobs) if (j.at <= end && (!next || j.at < next.j.at)) next = { id, j };
        if (!next) break;
        t = Math.max(t, next.j.at);
        if (next.j.every) next.j.at += next.j.every;
        else jobs.delete(next.id);
        next.j.fn();
      }
      t = end;
    },
    pending: () => jobs.size,
  };
  return env;
}

/**
 * Engine + mock native over a loopback, both on the same fake clock. Messages are delivered synchronously, so a
 * request resolves after one microtask turn (`await flush()`).
 */
export function rig(o = {}) {
  const env = o.env || fakeEnv();
  const { js, native, log } = loopbackPair({ schedule: o.schedule || 'sync' });
  const mock = new MockNative({
    api, transport: native, now: env.now, timers: env.timers, sampleRate: o.sampleRate, channels: o.channels,
  });
  const engine = new BridgeEngine({ transport: js, now: env.now, timers: env.timers, ...(o.engine || {}) });
  const events = [];
  for (const e of api.events) {
    engine.addEventListener(e.name, (x) => events.push({ name: e.name, detail: x.detail }));
  }
  return { env, engine, mock, log, events, js, native };
}

export const flush = () => new Promise((r) => setImmediate(r));
