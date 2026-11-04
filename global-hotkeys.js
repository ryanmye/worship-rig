'use strict';
// Menu-bar global hotkeys, Electron-main side (v11-electron; docs/menubar-mode.md "Global hotkeys").
// The renderer mirrors settings.hotkeys here (rig.setHotkeys); this module registers them through an injected
// globalShortcut-like object, reports each one's state in plain terms, and turns a press into a bus command the
// controller already has a path for (nextSong / prevSong = Perform's → / ← and the footswitch, v11-decisions; panic /
// master; v11-scenes: nextScene / prevScene), so no new engine path exists. Pure: no
// Electron import, so the unit tests drive it with a fake globalShortcut (test/unit/shell/global-hotkeys.test.mjs).
// The accelerator rules the user sees live in app/js/shared/hotkeys.js (ES module, Settings + store); main only
// guards the shape here and lets globalShortcut.register decide the rest.
// v11-hotkey-test (L11-3): macOS lets two apps register one combination (register() → true), so `taken` never shows
// there. Settings' "press it to test" puts one id in test mode (test / cancelTest): its next press goes to onTest
// instead of the bus, and a safety timeout ends the mode if the page goes away.

/** Same ids as app/js/shared/hotkeys.js HOTKEY_IDS (a unit test keeps them in step). */
const HOTKEY_IDS = Object.freeze(['nextSong', 'prevSong', 'panic', 'masterUp', 'masterDown', 'nextScene', 'prevScene']);
/** dB per master step (shared/hotkeys.js MASTER_STEP_DB). */
const MASTER_STEP_DB = 2;
/** Below this the next step down is silence (0); the first step up from silence lands here. */
const MASTER_FLOOR_DB = -40;
const MASTER_MAX = 2; // contract `master` 0..2 (+6 dB)
/** A master press within this long of the last one steps from the value sent then, not the (throttled) state. */
const MASTER_PENDING_MS = 1500;
/**
 * v11-hotkey-test: main ends a press-to-test on its own after this long. Settings gives up after 5 s
 * (shared/hotkeys.js HOTKEY_TEST_MS) and cancels; this is the safety net for a page that went away mid-test, so a
 * shortcut never stays swallowed.
 */
const HOTKEY_TEST_SAFETY_MS = 10000;
const ACC_RE = /^[A-Za-z0-9+\-=[\]\\;',./`]{1,80}$/;
/** Modifier spellings Electron accepts → the canonical name (shared/hotkeys.js MOD_ALIASES, Shift left out). */
const STRONG_MODS = Object.freeze({
  control: 'Control', ctrl: 'Control', alt: 'Alt', option: 'Alt', command: 'Command', cmd: 'Command',
  super: 'Command', meta: 'Command', commandorcontrol: 'CommandOrControl', cmdorctrl: 'CommandOrControl',
});

/**
 * v11-decisions R-4: the global-hotkey rule, as Settings applies it (shared/hotkeys.js isStrongAccelerator; a unit
 * test keeps the two in step): a function key (F1–F24) as the key, or two different ones of ⌃ ⌥ ⌘ (⇧ doesn't
 * count). Main never trusts the page, so a single plain key ('A', 'Space', 'Return') is refused here too: it would
 * take that key from every app on the Mac and report each press to the page.
 * @param {string} acc an accelerator that passed ACC_RE
 * @returns {boolean}
 */
function isStrongAccelerator(acc) {
  if (typeof acc !== 'string' || !acc) return false;
  const parts = acc.split('+').map((s) => s.trim().toLowerCase());
  const key = parts[parts.length - 1];
  if (/^f([1-9]|1\d|2[0-4])$/.test(key)) return true;
  const mods = new Set(parts.slice(0, -1).map((m) => STRONG_MODS[m]).filter(Boolean));
  return mods.size >= 2;
}

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
  // v11-decisions (Ryan, checklist Q3): next / previous step the setlist's songs (was nextMode / prevMode)
  if (id === 'nextSong' || id === 'prevSong' || id === 'panic') return { v: 1, type: id };
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
 *   onTest?: (ev: {id, accelerator, fired: boolean, reason?: string}) => void, // v11-hotkey-test, to Settings
 *   setTimer?: (fn: Function, ms: number) => *, clearTimer?: (handle: *) => void, // the test's safety timeout
 *   testSafetyMs?: number,
 * }} o
 */
function createHotkeys(o) {
  const now = o.now || Date.now;
  const setTimer = o.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer || ((h) => clearTimeout(h));
  const testSafetyMs = o.testSafetyMs > 0 ? o.testSafetyMs : HOTKEY_TEST_SAFETY_MS;
  /** v11-hotkey-test: {id, accelerator, until, timer} while Settings tests one shortcut, else null */
  let testing = null;
  let cfg = { on: false, keys: Object.fromEntries(HOTKEY_IDS.map((id) => [id, ''])) };
  let paused = false;
  /** accelerator → id, as registered right now */
  const held = new Map();
  /** id → 'ok' | 'taken' | 'invalid' | 'none' | 'off' | 'paused' */
  const states = {};
  let pendingMaster = null; // {value, at}: the master this module sent last

  /** End the running test. With a reason (timeout / changed), Settings hears it; a cancel from the page is silent. */
  function endTest(reason) {
    if (!testing) return;
    const t = testing;
    testing = null;
    clearTimer(t.timer);
    if (reason && o.onTest) o.onTest({ id: t.id, accelerator: t.accelerator, fired: false, reason });
  }

  function fire(id) {
    if (testing && testing.id === id) {
      // v11-hotkey-test: the press under test is reported to Settings and swallowed (a test of Next song must not
      // switch songs). One press ends the test; the next press runs the action again.
      const live = now() <= testing.until;
      const { accelerator } = testing;
      endTest(null);
      if (live) {
        if (o.onTest) o.onTest({ id, accelerator, fired: true });
        return null;
      }
    }
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
      else if (!isStrongAccelerator(acc)) states[id] = 'invalid'; // v11-decisions R-4: never registered
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
    // v11-hotkey-test: a test only holds while its combination is still registered (a pause for recording, off, or a
    // new combination ends it); Settings hears this before the status, so it can test again on the new one
    if (testing && (states[testing.id] !== 'ok' || cfg.keys[testing.id] !== testing.accelerator)) endTest('changed');
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
    /** A press (also the self-test's way in). @returns {object|null} the command sent (null: none, or swallowed) */
    fire,
    /**
     * v11-hotkey-test: Settings' "press it to test". Until the next press of `id` (or cancelTest, or the safety
     * timeout) that press is reported through onTest and does not run its action. Replaces a running test.
     * @param {string} id
     * @param {string} [accelerator] the combination Settings shows; refused when main holds another one for `id`
     * @returns {{ok: true, id, accelerator, timeoutMs}|{error: string, state?: string}}
     */
    test(id, accelerator) {
      if (typeof id !== 'string' || !HOTKEY_IDS.includes(id)) return { error: 'unknown shortcut' };
      if (accelerator !== undefined && (typeof accelerator !== 'string' || !ACC_RE.test(accelerator))) {
        return { error: 'bad accelerator' };
      }
      endTest(null);
      const acc = cfg.keys[id];
      if (states[id] !== 'ok' || !acc) return { error: 'not registered', state: states[id] || 'off' };
      if (accelerator !== undefined && accelerator !== acc) return { error: 'not registered', state: 'changed' };
      testing = { id, accelerator: acc, until: now() + testSafetyMs, timer: null };
      testing.timer = setTimer(() => endTest('timeout'), testSafetyMs);
      return { ok: true, id, accelerator: acc, timeoutMs: testSafetyMs };
    },
    /** v11-hotkey-test: Esc / Settings closed / the page's own timeout. @returns {{ok: true}} */
    cancelTest() {
      endTest(null);
      return { ok: true };
    },
    /** @returns {string|null} the id under test */
    testing: () => (testing ? testing.id : null),
    /** Quit / window gone: unregister everything we hold. */
    dispose() {
      endTest(null);
      releaseAll();
      for (const id of HOTKEY_IDS) states[id] = 'off';
    },
    /** @returns {string[]} the accelerators registered now */
    registered: () => [...held.keys()],
  };
}

module.exports = {
  HOTKEY_IDS, MASTER_STEP_DB, MASTER_FLOOR_DB, masterStep, sanitizeHotkeyConfig, hotkeyCommand, createHotkeys,
  isStrongAccelerator, HOTKEY_TEST_SAFETY_MS,
};
