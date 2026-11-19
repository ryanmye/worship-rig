// Dev/test boot of the bridge engine against MockNative in the same page (no native build needed). Used by
// select.js when the page URL has ?engine=bridge-mock and by test/unit/engine-bridge/boot-smoke.mjs.
// Top-level await: the contract JSON is fetched from /__bridge/engine-api.json (the smoke server and `serve.mjs`-style
// dev servers must provide it; native/contract/engine-api.json is the file).
// Every member the page touches on the engine is recorded in globalThis.__bridgeSeen (name -> count, plus
// `undefined:` entries for members the page asked for that the shim does not have = contract gaps).
import { BridgeEngine } from './bridge-engine.js';
import { MockNative } from './mock-native.js';
import { loopbackPair } from './transports.js';

const api = await (await fetch('/__bridge/engine-api.json')).json();
const seen = (globalThis.__bridgeSeen = globalThis.__bridgeSeen || {});
const count = (k) => {
  seen[k] = (seen[k] || 0) + 1;
};

/** Wrap an object so every property read is counted; functions are bound to the raw target (EventTarget brands). */
function spy(target, prefix) {
  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return Reflect.get(t, prop, t);
      const v = Reflect.get(t, prop, t);
      const name = `${prefix}${String(prop)}`;
      if (v === undefined && !(prop in t)) count(`undefined:${name}`);
      else count(name);
      if (typeof v === 'function') return v.bind(t);
      if (v && typeof v === 'object' && (prop === 'drone' || prop === 'ctx')) return spy(v, `${name}.`);
      return v;
    },
    has(t, prop) {
      if (typeof prop === 'string') count(`has:${prefix}${prop}`);
      return Reflect.has(t, prop);
    },
  });
}

export class AudioEngine {
  constructor(opts = {}) {
    const { js, native, log } = loopbackPair({ schedule: 'microtask' });
    const mock = new MockNative({ api, transport: native, autoTick: true });
    const engine = new BridgeEngine({ transport: js, latency: opts.latency });
    globalThis.__bridgeMock = mock;
    globalThis.__bridgeLog = log;
    globalThis.__bridgeRaw = engine;
    return spy(engine, '');
  }
}
