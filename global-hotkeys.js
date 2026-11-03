'use strict';
// Menu-bar global hotkeys, Electron-main side (v11-electron; docs/menubar-mode.md "Global hotkeys").
// The renderer mirrors settings.hotkeys here (rig.setHotkeys); this module registers them through an injected
// globalShortcut-like object, reports each one's state in plain terms, and turns a press into an EXISTING bus command
// (nextMode / prevMode / panic / master; v11-scenes: nextScene / prevScene), so no new engine path exists. Pure: no
// Electron import, so the unit tests drive it with a fake globalShortcut (test/unit/shell/global-hotkeys.test.mjs).
// The accelerator rules the user sees live in app/js/shared/hotkeys.js (ES module, Settings + store); main only
// guards the shape here and lets globalShortcut.register decide the rest.

/** Same ids as app/js/shared/hotkeys.js HOTKEY_IDS (a unit test keeps them in step). */
const HOTKEY_IDS = Object.freeze(['nextMode', 'prevMode', 'panic', 'masterUp', 'masterDown', 'nextScene', 'prevScene']);
/** dB per master step (shared/hotkeys.js MASTER_STEP_DB). */
const MASTER_STEP_DB = 2;
/** Below this the next step down is silence (0); the first step up from silence lands here. */
const MASTER_FLOOR_DB = -40;
const MASTER_MAX = 2; // contract `master` 0..2 (+6 dB)
/** A master press within this long of the last one steps from the value sent then, not the (throttled) state. */
const MASTER_PENDING_MS = 1500;
const ACC_RE = /^[A-Za-z0-9+\-=[\]\\;',./`]{1,80}$/;

/**
 * One master step in dB from the current linear master (0..2).
 * @param {number} value current master (linear gain, 0 = silent)
 * @param {1|-1} dir
 * @param {number} [stepDb]
 * @returns {number} the next value, 0..2, rounded to 4 decimals
 */
function masterStep(value, dir, stepDb = MASTER_STEP_DB) {
  const v = Number.isFinite(value) ? Math.min(MASTER_MAX, Math.max(0, value)) : 0;
  const db = v > 0 ? 20 * Math.log10(v) : -Infinity;
  let next;
  if (dir > 0) next = db < MASTER_FLOOR_DB ? MASTER_FLOOR_DB : db + stepDb;
  else {
    next = db - stepDb;
    if (next < MASTER_FLOOR_DB - 1e-9) return 0;
  }
  return Math.round(Math.min(MASTER_MAX, 10 ** (next / 20)) * 1e4) / 1e4;
}

/**
 * The renderer's payload → {on, keys}; anything off-shape is dropped (main never trusts the page's types).
 * @param {*} cfg
 * @returns {{on: boolean, keys: Object<string, string>}}
 */
function sanitizeHotkeyConfig(cfg) {
  const o = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  const src = o.keys && typeof o.keys === 'object' && !Array.isArray(o.keys) ? o.keys : {};
  const keys = {};
  for (const id of HOTKEY_IDS) keys[id] = typeof src[id] === 'string' && ACC_RE.test(src[id]) ? src[id] : '';
  return { on: o.on === true, keys };
}

/**
 * The bus command a press sends (docs/menubar-mode.md `command`), or null (master with no state yet).
 * @param {string} id
 * @param {number|null} master the master to step from (null = unknown)
 * @returns {object|null}
 */
function hotkeyCommand(id, master) {
  if (id === 'nextMode' || id === 'prevMode' || id === 'panic') return { v: 1, type: id };
  if (id === 'nextScene' || id === 'prevScene') return { v: 1, type: id }; // v11-scenes
  if (id === 'masterUp' || id === 'masterDown') {
    if (!Number.isFinite(master)) return null;
    return { v: 1, type: 'master', value: masterStep(master, id === 'masterUp' ? 1 : -1) };
  }
  return null;
}

/**
 * The hotkey registrar main.js keeps one of.
 * @param {{
 *   shortcuts: {register: (acc: string, cb: Function) => boolean, unregister: (acc: string) => void},
 *   send: (cmd: object) => void,          // relay a bus command to the main renderer
 *   masterNow: () => number|null,         // the last published state's master
 *   now?: () => number,
 *   onStatus?: (status: object) => void,  // pushed to the renderers on every change
 * }} o
 */
function createHotkeys(o) {
  const now = o.now || Date.now;
  let cfg = { on: false, keys: Object.fromEntries(HOTKEY_IDS.map((id) => [id, ''])) };
  let paused = false;
  /** accelerator → id, as registered right now */
  const held = new Map();
  /** id → 'ok' | 'taken' | 'invalid' | 'none' | 'off' | 'paused' */
  const states = {};
  let pendingMaster = null; // {value, at}: the master this module sent last

  function fire(id) {
    let master = o.masterNow();
    if (id === 'masterUp' || id === 'masterDown') {
      if (pendingMaster && now() - pendingMaster.at < MASTER_PENDING_MS) master = pendingMaster.value;
    }
    const cmd = hotkeyCommand(id, master);
    if (!cmd) return null;
    if (cmd.type === 'master') pendingMaster = { value: cmd.value, at: now() };
    o.send(cmd);
    return cmd;
  }

  function releaseAll() {
    for (const acc of held.keys()) {
      try {
        o.shortcuts.unregister(acc);
      } catch {
        /* already gone */
      }
    }
    held.clear();
  }

  function apply() {
    releaseAll();
    for (const id of HOTKEY_IDS) {
      const acc = cfg.keys[id];
      if (!cfg.on) states[id] = 'off';
      else if (!acc) states[id] = 'none';
      else if (paused) states[id] = 'paused';
      else if ([...held.keys()].some((a) => a.toLowerCase() === acc.toLowerCase())) states[id] = 'invalid';
      else {
        let ok = false;
        let bad = false;
        try {
          ok = o.shortcuts.register(acc, () => fire(id)) === true;
        } catch {
          bad = true; // Electron throws on an accelerator it can't parse
        }
        if (ok) held.set(acc, id);
        // register() → false: another app (or macOS) holds the combination
        states[id] = ok ? 'ok' : bad ? 'invalid' : 'taken';
      }
    }
    const s = status();
    if (o.onStatus) o.onStatus(s);
    return s;
  }

  /** @returns {{on, paused, keys: Object<string, {accelerator: string, state: string}>}} */
  function status() {
    const keys = {};
    for (const id of HOTKEY_IDS) keys[id] = { accelerator: cfg.keys[id], state: states[id] || 'off' };
    return { on: cfg.on, paused, keys };
  }

  return {
    /** Mirror settings.hotkeys (re-registers everything). @returns the status */
    set(next) {
      cfg = sanitizeHotkeyConfig(next);
      return apply();
    },
    /** Settings is recording a new combination: let go of ours so the keys reach the page. @returns the status */
    pause(on) {
      paused = !!on;
      return apply();
    },
    status,
    /** A press (also the self-test's way in). @returns {object|null} the command sent */
    fire,
    /** Quit / window gone: unregister everything we hold. */
    dispose() {
      releaseAll();
      for (const id of HOTKEY_IDS) states[id] = 'off';
    },
    /** @returns {string[]} the accelerators registered now */
    registered: () => [...held.keys()],
  };
}

module.exports = {
  HOTKEY_IDS, MASTER_STEP_DB, MASTER_FLOOR_DB, masterStep, sanitizeHotkeyConfig, hotkeyCommand, createHotkeys,
};
