// Browser init script for ui-core-devhost.mjs (not a module, not a test; the preload adds it to every Playwright
// context the ui-core suite opens). The ui-core suite reads a few Web Audio engine INTERNALS that are not engine
// contract (native/contract/engine-api.json `notContract`, PARITY "UI parity"): `engine.slots` / `retiring` (its
// waitSong helper waits for `slots.some(Boolean)`; voice counts via `slots[i].inst.liveVoiceCount()`), `getParam`,
// `pedaled`, `transpose`, `activeNotes` / `sounding`, `fx.reverb.settled()`, `drone.getState()`. This adapter answers them on the BridgeEngine INSTANCE from
// what the shim already knows (the committed patch mirror, the values it sent, the 1 s `stats` of the tick), so a
// UI test fails on what the UI or the core does, not on a missing internal. It never touches the class (the contract
// surface test still sees exactly the contracted members) and nothing under app/ loads it.
// Not adapted (no page-side equivalent against a native core): `slots[i].strip.pan` (AnalyserNode taps on a Web Audio
// strip), `metronome` internals. Opt out: ui-core-devhost.mjs --no-adapter (RIG_UICORE_NO_ADAPTER=1).
(() => {
  const PATH = /^slots\.(\d+)\.(.+)$/;
  /** Read a dotted PARAMS path from the committed patch (slots.<i>.<row>, fx.<unit>.<key>, master.volume). */
  const fromPatch = (patch, p) => {
    if (!patch) return undefined;
    const m = PATH.exec(p);
    let o = m ? (patch.slots || [])[Number(m[1])] : patch;
    for (const k of (m ? m[2] : p).split('.')) {
      if (o === null || o === undefined) return undefined;
      o = o[k];
    }
    return o;
  };
  const install = (e) => {
    if (!e || e.__uiCoreAdapter) return;
    Object.defineProperty(e, '__uiCoreAdapter', { value: true });
    const sent = new Map(); // path -> last value sent since the last commit
    const setParam = e.setParam.bind(e);
    e.setParam = (path, value, o) => {
      const r = setParam(path, value, o);
      sent.set(String(path), value);
      return r;
    };
    const commit = e.commit.bind(e);
    e.commit = (token, o) => {
      const ok = commit(token, o);
      if (ok) sent.clear(); // the new song's values come from its patch
      return ok;
    };
    /** Web Audio getParam: the value in force (last set, else the committed patch). */
    e.getParam = (path) => {
      const p = String(path);
      if (sent.has(p)) return sent.get(p);
      return fromPatch(e._patch, p);
    };
    const voices = () => Number((e._stats && e._stats.voices) || 0);
    Object.defineProperty(e, 'slots', {
      configurable: true,
      get() {
        const slots = (e._patch && e._patch.slots) || [];
        let first = true;
        return slots.map((cfg) => {
          if (!cfg) return null;
          const own = first; // the core reports one total: counted once, on the first filled slot
          first = false;
          return { cfg, strip: null, inst: { liveVoiceCount: () => (own ? voices() : 0) } };
        });
      },
    });
    Object.defineProperty(e, 'retiring', { configurable: true, get: () => [] });
    Object.defineProperty(e, 'pedaled', {
      configurable: true, get: () => ({ size: Number((e._stats && e._stats.pedaled) || 0) }),
    });
    // audio.js `transpose` (the shim keeps it as `_transpose`) and `activeNotes` / `sounding` (Sets): the held notes
    // the core reports in `notes` events (`sounding` also counts released, still-ringing notes on the web engine;
    // native reports held ones only, so a test of a ringing tail can still fail here)
    Object.defineProperty(e, 'transpose', { configurable: true, get: () => e._transpose });
    let held = new Set();
    e.addEventListener('notes', (ev) => {
      held = new Set((ev.detail && ev.detail.held) || []);
    });
    Object.defineProperty(e, 'activeNotes', { configurable: true, get: () => held });
    Object.defineProperty(e, 'sounding', { configurable: true, get: () => held });
    if (!e.fx) e.fx = { reverb: { settled: () => Promise.resolve(true) } };
    if (e.drone && typeof e.drone.getState !== 'function') {
      e.drone.getState = () => ({ mode: e.drone.cfg && e.drone.cfg.mode, key: e.drone.key });
    }
  };
  const t0 = Date.now();
  const poll = setInterval(() => {
    if (globalThis.__bridgeRaw) install(globalThis.__bridgeRaw);
    if (globalThis.__bridgeRaw || Date.now() - t0 > 60000) clearInterval(poll);
  }, 2);
})();
