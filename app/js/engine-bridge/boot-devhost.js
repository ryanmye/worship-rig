// Boot of the bridge engine against the native dev host (native/devhost, `rig-devhost`): `new AudioEngine(opts)` is
// a BridgeEngine over a WebSocket to the real native core. rig-devhost serves app/ and swaps main.js's engine import
// for this file on the fly (nothing under app/ is edited); `?devhost=ws://host:port/__rig/ws` points it elsewhere.
// `?spy=1` counts every engine member the page touches in globalThis.__bridgeSeen (as boot-mock.js does), for
// test/unit/engine-bridge/boot-devhost.mjs.
import { BridgeEngine } from './bridge-engine.js';
import { websocketTransport, devhostUrl } from './ws-transport.js';

const params = (() => {
  try {
    return new URLSearchParams(globalThis.location.search);
  } catch {
    return new URLSearchParams('');
  }
})();

/** Same counting proxy as boot-mock.js (functions bound to the raw target for EventTarget brands). */
function spy(target, prefix, seen) {
  const count = (k) => {
    seen[k] = (seen[k] || 0) + 1;
  };
  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return Reflect.get(t, prop, t);
      const v = Reflect.get(t, prop, t);
      const name = `${prefix}${String(prop)}`;
      if (v === undefined && !(prop in t)) count(`undefined:${name}`);
      else count(name);
      if (typeof v === 'function') return v.bind(t);
      if (v && typeof v === 'object' && (prop === 'drone' || prop === 'ctx')) return spy(v, `${name}.`, seen);
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
    const status = (globalThis.__devhostStatus = []);
    const transport = websocketTransport({
      url: devhostUrl(),
      onStatus: (s, info) => status.push({ s, ...(info || {}), at: Date.now() }),
    });
    const engine = new BridgeEngine({ transport, latency: opts.latency, app: 'worship-rig-ui (devhost)' });
    globalThis.__bridgeRaw = engine;
    globalThis.__devhostTransport = transport;
    if (params.get('spy') !== '1') return engine;
    const seen = (globalThis.__bridgeSeen = globalThis.__bridgeSeen || {});
    return spy(engine, '', seen);
  }
}
