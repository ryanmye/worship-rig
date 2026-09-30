// Menu-bar bus (docs/menubar-mode.md, contract v1; C7 menubar-A): the main renderer publishes `state`, the popover(s)
// and the Electron Tray send `command`s back. One API, two transports, picked per direction:
//   • Electron: window.rig.busPublish(json) / rig.onBusCommand(cb) in the main renderer, rig.miniSubscribe(cb) /
//     rig.miniCommand(json) in the popover (LOCAL's preload relay). Each method is feature-detected on its own.
//   • Browser fallback: BroadcastChannel('rig-bus') between the main tab and a mini.html tab/window, with the same
//     messages, so the popover and its tests run on Linux without Electron.
// Every message is validated against the contract (v:1 and the required fields); an invalid one is dropped with a
// console.warn. State publishes are throttled to ≤ 4/s (leading + trailing edge: the newest state always goes out).
// Pure module: no DOM, no Web Audio (BroadcastChannel is a plain web API; it is injectable for tests).

export const BUS_VERSION = 1;
export const BUS_CHANNEL = 'rig-bus';
/** Minimum spacing of state publishes (ms): ≤ 4 per second. */
export const BUS_THROTTLE_MS = 250;
/** Every command type in contract v1. */
export const COMMAND_TYPES = Object.freeze([
  'hello', 'selectMode', 'nextMode', 'prevMode', 'panic', 'fadeOutAll', 'master', 'droneToggle', 'droneKey',
  'lowResource', 'openMain', 'record',
]);
/**
 * 'asleep' (lowres2): suspended on purpose after settings.audioSleepSec idle in low-resource mode (lowres2-scope);
 * any input except a popover `hello` wakes it, and so does leaving low-resource. v stays 1.
 */
export const AUDIO_STATES = Object.freeze(['running', 'stalled', 'suspended', 'asleep']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string';
const isBool = (v) => typeof v === 'boolean';
const isNumOrNull = (v) => v === null || isNum(v);
const isId = (v) => isStr(v) && v !== '';
const isIndex = (v) => Number.isInteger(v) && v >= 0;
const isMode = (m) => isObj(m) && isId(m.id) && isStr(m.name) && isStr(m.key) && isIndex(m.index);
const isCurrent = (c) => c === null || (isObj(c) && isId(c.id) && isStr(c.name) && isStr(c.key));

/**
 * Check a `state` message against contract v1. `current` may be null (no song), `masterDb` null (master at 0 =
 * −∞ dB, which JSON can't carry), `memoryMB` null (unknown), `midi.name` null (nothing connected).
 * Optional (mini-theme, still v1): `theme`, the applied theme id (a non-empty string; the popover resolves an unknown
 * id to the default the way the app does). Absent = the publisher doesn't send it; the popover then follows the
 * localStorage mirror alone.
 * @param {any} m
 * @returns {string|null} null when valid, else the first problem
 */
export function stateError(m) {
  if (!isObj(m)) return 'not an object';
  if (m.v !== BUS_VERSION) return `v must be ${BUS_VERSION}`;
  if (!isCurrent(m.current)) return 'current';
  if (!Array.isArray(m.modes) || !m.modes.every(isMode)) return 'modes';
  if (!isNum(m.master) || m.master < 0 || m.master > 2) return 'master';
  if (!isNumOrNull(m.masterDb)) return 'masterDb';
  if (!isBool(m.droneOn)) return 'droneOn';
  if (!isStr(m.droneKey)) return 'droneKey';
  if (!AUDIO_STATES.includes(m.audio)) return 'audio';
  if (!isNum(m.latencyMs)) return 'latencyMs';
  if (!isObj(m.midi) || !isBool(m.midi.connected) || !(m.midi.name === null || isStr(m.midi.name))) return 'midi';
  if (!isBool(m.lowResource)) return 'lowResource';
  if (!isBool(m.recording)) return 'recording';
  if (!isBool(m.windowVisible)) return 'windowVisible';
  if (!isNumOrNull(m.memoryMB)) return 'memoryMB';
  if (m.theme !== undefined && !isId(m.theme)) return 'theme';
  return null;
}

/**
 * Check a `command` message against contract v1 (per-type payload: selectMode.id, master.value 0..2,
 * droneKey.pc 0..11, lowResource.on / record.on booleans).
 * @param {any} m
 * @returns {string|null} null when valid, else the first problem
 */
export function commandError(m) {
  if (!isObj(m)) return 'not an object';
  if (m.v !== BUS_VERSION) return `v must be ${BUS_VERSION}`;
  if (!COMMAND_TYPES.includes(m.type)) return `unknown type ${JSON.stringify(m.type)}`;
  switch (m.type) {
    case 'selectMode':
      return isStr(m.id) && m.id !== '' ? null : 'selectMode.id';
    case 'master':
      return isNum(m.value) && m.value >= 0 && m.value <= 2 ? null : 'master.value (0..2)';
    case 'droneKey':
      return Number.isInteger(m.pc) && m.pc >= 0 && m.pc <= 11 ? null : 'droneKey.pc (0..11)';
    case 'lowResource':
    case 'record':
      return isBool(m.on) ? null : `${m.type}.on`;
    default:
      return null;
  }
}

export const isValidState = (m) => stateError(m) === null;
export const isValidCommand = (m) => commandError(m) === null;

/** A state message carries no `type`; a command always does (both travel on one BroadcastChannel). */
const isCommandShape = (m) => isObj(m) && typeof m.type === 'string';

function parse(raw) {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Create a bus endpoint.
 * @param {{role:'main'|'mini', rig?:object|null, BroadcastChannel?:Function|null, timers?:{setTimeout,clearTimeout},
 *          now?:() => number, hello?:boolean, warn?:(msg:string) => void, throttleMs?:number}} o
 *   role 'main' (the audio renderer: publish + onCommand) or 'mini' (popover / Tray: subscribe + command).
 *   rig: defaults to globalThis.rig; BroadcastChannel: defaults to globalThis.BroadcastChannel (null disables it).
 *   hello (mini, default true): the first subscribe() sends {type:'hello'} so the main renderer answers with a state.
 * @returns {{role:string, transport:{publish:string, commands:string, subscribe:string, command:string},
 *   publish:(state:object) => boolean, flush:() => void, onCommand:(cb:(cmd:object) => void) => () => void,
 *   subscribe:(cb:(state:object) => void) => () => void, command:(cmd:object) => boolean,
 *   readonly lastState:object|null, readonly sent:number, close:() => void}}
 *   transport names each direction's transport ('rig' | 'broadcast' | 'none'); `sent` counts state messages sent.
 */
export function createBus(o = {}) {
  const role = o.role === 'mini' ? 'mini' : 'main';
  const rig = o.rig !== undefined ? o.rig : globalThis.rig || null;
  const globalBC = typeof globalThis.BroadcastChannel === 'function' ? globalThis.BroadcastChannel : null;
  const BC = o.BroadcastChannel !== undefined ? o.BroadcastChannel : globalBC;
  const timers = o.timers || {
    setTimeout: (...a) => globalThis.setTimeout(...a),
    clearTimeout: (id) => globalThis.clearTimeout(id),
  };
  const now = o.now || (() => Date.now());
  const warn = o.warn || ((msg) => console.warn(`[bus] ${msg}`));
  const throttleMs = o.throttleMs ?? BUS_THROTTLE_MS;
  const wantHello = o.hello !== false;
  const has = (name) => !!(rig && typeof rig[name] === 'function');

  // per-direction transport (feature-detected one method at a time, as the contract asks)
  const pick = (name) => (has(name) ? 'rig' : BC ? 'broadcast' : 'none');
  const transport = role === 'main'
    ? { publish: pick('busPublish'), commands: pick('onBusCommand'), subscribe: 'none', command: 'none' }
    : { publish: 'none', commands: 'none', subscribe: pick('miniSubscribe'), command: pick('miniCommand') };
  const needBC = Object.values(transport).includes('broadcast');
  let channel = null;
  if (needBC) {
    try {
      channel = new BC(BUS_CHANNEL);
    } catch (err) {
      warn(`BroadcastChannel unavailable (${err && err.message})`);
      for (const k of Object.keys(transport)) if (transport[k] === 'broadcast') transport[k] = 'none';
    }
  }

  const commandCbs = new Set();
  const stateCbs = new Set();
  const offs = [];
  let closed = false;
  let lastState = null;
  let pending = null; // newest state not sent yet (trailing edge)
  let timer = null;
  let lastSentAt = -Infinity;
  let sent = 0;
  let helloSent = false;

  function sendState(state) {
    if (closed) return;
    lastSentAt = now();
    sent++;
    if (transport.publish === 'rig') {
      try {
        rig.busPublish(JSON.stringify(state));
      } catch (err) {
        warn(`busPublish failed: ${err && err.message}`);
      }
    } else if (transport.publish === 'broadcast' && channel) {
      try {
        channel.postMessage(state);
      } catch (err) {
        warn(`postMessage failed: ${err && err.message}`);
      }
    }
  }

  function flush() {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    if (!pending) return;
    const s = pending;
    pending = null;
    sendState(s);
  }

  function deliverCommand(raw) {
    const m = parse(raw);
    if (m === undefined) return void warn('dropped a command that is not JSON');
    const err = commandError(m);
    if (err) return void warn(`dropped an invalid command (${err})`);
    if (m.type === 'hello' && lastState) {
      // answer at once (bypasses the throttle): a popover that just opened must not wait up to 250 ms
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      pending = null;
      sendState(lastState);
    }
    for (const cb of [...commandCbs]) {
      try {
        cb(m);
      } catch (e) {
        warn(`command handler failed: ${e && e.message}`);
      }
    }
  }

  function deliverState(raw) {
    const m = parse(raw);
    if (m === undefined) return void warn('dropped a state that is not JSON');
    const err = stateError(m);
    if (err) return void warn(`dropped an invalid state (${err})`);
    for (const cb of [...stateCbs]) {
      try {
        cb(m);
      } catch (e) {
        warn(`state handler failed: ${e && e.message}`);
      }
    }
  }

  if (channel) {
    channel.onmessage = (ev) => {
      if (closed) return;
      const m = ev && ev.data;
      if (isCommandShape(m)) {
        if (transport.commands === 'broadcast') deliverCommand(m); // minis ignore each other's commands
      } else if (transport.subscribe === 'broadcast') deliverState(m); // the main renderer ignores states
    };
  }
  if (transport.commands === 'rig') {
    const off = rig.onBusCommand((raw) => !closed && deliverCommand(raw));
    if (typeof off === 'function') offs.push(off);
  }
  if (transport.subscribe === 'rig') {
    const off = rig.miniSubscribe((raw) => !closed && deliverState(raw));
    if (typeof off === 'function') offs.push(off);
  }

  const api = {
    role,
    transport,
    /**
     * (main) Publish a state. Validated (invalid → dropped with a warning, returns false); throttled to one send
     * per BUS_THROTTLE_MS: the first goes out at once, later ones inside the window collapse into one trailing send
     * of the newest state.
     */
    publish(state) {
      if (closed || role !== 'main') return false;
      const err = stateError(state);
      if (err) {
        warn(`not publishing an invalid state (${err})`);
        return false;
      }
      lastState = state;
      const wait = lastSentAt + throttleMs - now();
      if (wait <= 0 && timer === null) {
        pending = null;
        sendState(state);
        return true;
      }
      pending = state;
      if (timer === null) timer = timers.setTimeout(flush, Math.max(0, wait));
      return true;
    },
    /** (main) Send a pending throttled state now. */
    flush,
    /** (main) Receive validated commands. @returns {() => void} unsubscribe */
    onCommand(cb) {
      commandCbs.add(cb);
      return () => commandCbs.delete(cb);
    },
    /** (mini) Receive validated states. The first subscribe sends 'hello' (unless hello:false). @returns unsubscribe */
    subscribe(cb) {
      stateCbs.add(cb);
      if (role === 'mini' && wantHello && !helloSent) {
        helloSent = true;
        api.command({ type: 'hello' });
      }
      return () => stateCbs.delete(cb);
    },
    /** (mini) Send a command; `v` defaults to 1. Invalid → dropped with a warning. @returns {boolean} sent */
    command(cmd) {
      if (closed || role !== 'mini') return false;
      const m = isObj(cmd) && cmd.v === undefined ? { v: BUS_VERSION, ...cmd } : cmd;
      const err = commandError(m);
      if (err) {
        warn(`not sending an invalid command (${err})`);
        return false;
      }
      if (transport.command === 'rig') {
        try {
          rig.miniCommand(JSON.stringify(m));
        } catch (e) {
          warn(`miniCommand failed: ${e && e.message}`);
          return false;
        }
        return true;
      }
      if (transport.command === 'broadcast' && channel) {
        channel.postMessage(m);
        return true;
      }
      return false;
    },
    get lastState() {
      return lastState;
    },
    get sent() {
      return sent;
    },
    /** Stop everything: pending trailing publish dropped, channel closed, rig listeners removed. */
    close() {
      if (closed) return;
      closed = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      pending = null;
      commandCbs.clear();
      stateCbs.clear();
      for (const off of offs.splice(0)) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
      if (channel) {
        channel.onmessage = null;
        try {
          channel.close();
        } catch {
          /* ignore */
        }
      }
    },
  };
  return api;
}
