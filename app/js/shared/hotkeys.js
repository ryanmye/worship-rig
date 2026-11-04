// Menu-bar global hotkeys (v11-electron; docs/menubar-mode.md "Global hotkeys"): the actions, their default
// accelerators, and the pure helpers Settings and the store use: validate an Electron accelerator string, build one
// from a KeyboardEvent (the "press the keys" recorder), show it in Mac symbols, and normalise settings.hotkeys.
// Electron main registers them (globalShortcut, global-hotkeys.js) and turns a press into a bus command.
// v11-decisions (Ryan 2026-11-03, checklist Q3): next / previous step the setlist's songs (Perform's → / ←, the
// footswitch nextSong / prevSong), not the menu-bar modes; the ids were nextMode / prevMode before (LEGACY_HOTKEY_IDS).
// Pure module: no DOM, no Web Audio.

/** The actions, in Settings order. `id` is the key in settings.hotkeys.keys and in main.js's status. */
export const HOTKEY_ACTIONS = Object.freeze([
  Object.freeze({ id: 'nextSong', label: 'Next song' }), // v11-decisions: was nextMode ("Next mode")
  Object.freeze({ id: 'prevSong', label: 'Previous song' }),
  Object.freeze({ id: 'panic', label: 'Panic (all notes off)' }),
  Object.freeze({ id: 'masterUp', label: 'Master louder' }),
  Object.freeze({ id: 'masterDown', label: 'Master softer' }),
  Object.freeze({ id: 'nextScene', label: 'Next scene' }), // v11-scenes
  Object.freeze({ id: 'prevScene', label: 'Previous scene' }),
]);
export const HOTKEY_IDS = Object.freeze(HOTKEY_ACTIONS.map((a) => a.id));
/**
 * v11-decisions: stored ids from v1.1 builds before the rename → today's id. normalizeHotkeys reads a legacy entry
 * when the new id is absent, so a saved combination (or a saved "none") carries over; the old key is then dropped.
 */
export const LEGACY_HOTKEY_IDS = Object.freeze({ nextMode: 'nextSong', prevMode: 'prevSong' });
/** Master ± step in dB (global-hotkeys.js MASTER_STEP_DB uses the same number). */
export const MASTER_STEP_DB = 2;

/**
 * Defaults: ⌃⌥⌘ + a key. Three modifiers keep them clear of app shortcuts (⌘…, ⌘⇧…) and of typing (⌥ letters make
 * accented characters). ] / [ for songs (the ⌘] / ⌘[ forward/back idiom) and = / − for master (the zoom idiom), not
 * the arrows: window managers (Rectangle, Magnet) take ⌃⌥⌘←/→ for "next / previous display". P for Panic.
 */
export const DEFAULT_HOTKEYS = Object.freeze({
  nextSong: 'Control+Alt+Command+]',
  prevSong: 'Control+Alt+Command+[',
  panic: 'Control+Alt+Command+P',
  masterUp: 'Control+Alt+Command+=',
  masterDown: 'Control+Alt+Command+-',
  // v11-scenes: . / , (the > / < keys) step the song's scenes
  nextScene: 'Control+Alt+Command+.',
  prevScene: 'Control+Alt+Command+,',
});

// canonical modifier names (Electron accelerators) and their aliases
const MOD_ALIASES = Object.freeze({
  control: 'Control', ctrl: 'Control',
  alt: 'Alt', option: 'Alt',
  shift: 'Shift',
  command: 'Command', cmd: 'Command', super: 'Command', meta: 'Command',
  commandorcontrol: 'CommandOrControl', cmdorctrl: 'CommandOrControl',
});
/** Apple's order: ⌃ ⌥ ⇧ ⌘. */
const MOD_ORDER = Object.freeze(['Control', 'Alt', 'Shift', 'Command', 'CommandOrControl']);
const MOD_SYMBOL = Object.freeze({ Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘', CommandOrControl: '⌘' });
const MOD_WORD = Object.freeze({
  Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Command: 'Super', CommandOrControl: 'Ctrl',
});

const NAMED_KEYS = Object.freeze({
  space: 'Space', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', insert: 'Insert', return: 'Return',
  enter: 'Return', up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'PageUp',
  pagedown: 'PageDown', escape: 'Escape', esc: 'Escape', plus: 'Plus',
});
const PUNCTUATION = new Set(['-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`']);
const KEY_SYMBOL = Object.freeze({
  Left: '←', Right: '→', Up: '↑', Down: '↓', Return: '↩', Backspace: '⌫', Delete: '⌦', Escape: 'Esc', Tab: '⇥',
  Space: 'Space', PageUp: 'Page Up', PageDown: 'Page Down', Plus: '+',
});
/**
 * macOS keeps these for itself (or they are a common app/system command), so a global shortcut would either never
 * fire or take the combination away from the Mac. Canonical form.
 */
const RESERVED = Object.freeze({
  'Alt+Command+Escape': 'Force Quit',
  'Control+Command+Q': 'Lock Screen',
  'Control+Command+Space': 'the emoji picker',
  'Control+Command+F': 'full screen',
  'Alt+Command+D': 'showing and hiding the Dock',
  'Alt+Command+H': 'Hide Others',
  'Alt+Command+M': 'Minimise All',
  'Alt+Command+W': 'Close All',
  'Control+Alt+Command+8': 'Invert Colours',
});

const fnKey = (k) => /^F([1-9]|1\d|2[0-4])$/.test(k);

/** @param {string} raw @returns {string|null} the canonical key name, or null when it isn't one */
function canonicalKey(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  if (/^[a-z]$/i.test(raw)) return raw.toUpperCase();
  if (/^\d$/.test(raw)) return raw;
  if (/^f\d{1,2}$/i.test(raw) && fnKey(raw.toUpperCase())) return raw.toUpperCase();
  if (PUNCTUATION.has(raw)) return raw;
  return NAMED_KEYS[raw.toLowerCase()] || null;
}

/**
 * Split an accelerator into modifiers and key (aliases resolved, order normalised).
 * @param {string} acc  e.g. 'Control+Alt+Command+Right' ('Plus' is the + key)
 * @returns {{mods: string[], key: string, canonical: string}|{error: string}}
 */
export function parseAccelerator(acc) {
  if (typeof acc !== 'string' || !acc.trim()) return { error: 'empty' };
  if (acc.length > 80) return { error: 'too long' };
  const parts = acc.split('+').map((s) => s.trim());
  const mods = new Set();
  let key = null;
  for (const p of parts) {
    if (!p) return { error: 'malformed' };
    const m = MOD_ALIASES[p.toLowerCase()];
    if (m) {
      if (key) return { error: 'modifiers must come before the key' };
      if (mods.has(m)) return { error: 'repeated modifier' };
      mods.add(m);
      continue;
    }
    if (key) return { error: 'more than one key' };
    key = canonicalKey(p);
    if (!key) return { error: `unknown key "${p.slice(0, 12)}"` };
  }
  if (!key) return { error: 'no key, only modifiers' };
  const list = MOD_ORDER.filter((m) => mods.has(m));
  return { mods: list, key, canonical: [...list, key].join('+') };
}

/**
 * The global-hotkey rule on a parsed accelerator: a function key, or two of ⌃ ⌥ ⌘ (⇧ doesn't count). v11-decisions
 * R-4: Electron main applies the same rule (global-hotkeys.js isStrongAccelerator, a CJS mirror kept in step by
 * test/unit/shared/hotkeys.test.mjs), so a single plain key can't be taken system-wide whoever writes the setting.
 * @param {{mods: string[], key: string}} p
 * @returns {boolean}
 */
function strongEnough(p) {
  return fnKey(p.key) || p.mods.filter((m) => m !== 'Shift').length >= 2;
}

/**
 * The rule alone (no reserved-shortcut check): can this be a global hotkey at all?
 * @param {string} acc
 * @returns {boolean} false for a malformed accelerator too
 */
export function isStrongAccelerator(acc) {
  const p = parseAccelerator(acc);
  return !p.error && strongEnough(p);
}

/**
 * Can this accelerator be a global hotkey? It needs two of ⌃ ⌥ ⌘ (⇧ may come on top), or a function key: a single
 * ⌘ / ⌃ / ⌥ combination belongs to apps or to typing everywhere on the Mac. A few system shortcuts are refused.
 * @param {string} acc
 * @returns {string|null} null when fine, else a reason in plain words (for Settings)
 */
export function acceleratorError(acc) {
  const p = parseAccelerator(acc);
  if (p.error) return `That isn’t a key combination (${p.error}).`;
  if (fnKey(p.key)) return null;
  if (!strongEnough(p)) return 'Use at least two of ⌃ ⌥ ⌘ (⇧ can be added), or a function key — '
    + 'shorter combinations belong to other apps.';
  const reserved = RESERVED[p.canonical];
  if (reserved) return `macOS uses ${formatAccelerator(p.canonical)} for ${reserved}.`;
  return null;
}

const CODE_KEYS = Object.freeze({
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Space: 'Space', Tab: 'Tab',
  Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Enter: 'Return', NumpadEnter: 'Return', Home: 'Home',
  End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Escape: 'Escape', Minus: '-', Equal: '=', BracketLeft: '[',
  BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
});

/**
 * The "press the keys" recorder: a keydown → an accelerator in canonical form. Reads `code` (the physical key), so
 * ⌥ doesn't turn letters into accented characters. A modifier on its own gives null (keep waiting).
 * @param {{code?: string, key?: string, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean, metaKey?: boolean}} e
 * @returns {string|null}
 */
export function acceleratorFromEvent(e) {
  if (!e || typeof e.code !== 'string') return null;
  const c = e.code;
  let key = null;
  if (/^Key[A-Z]$/.test(c)) key = c.slice(3);
  else if (/^Digit\d$/.test(c)) key = c.slice(5);
  else if (/^F\d{1,2}$/.test(c) && fnKey(c)) key = c;
  else key = CODE_KEYS[c] || null;
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Command');
  return [...mods, key].join('+');
}

/**
 * Show an accelerator the way the platform does: '⌃⌥⌘→' on the Mac, 'Ctrl+Alt+Right' elsewhere.
 * @param {string} acc
 * @param {{mac?: boolean}} [o] default true (the app is a Mac app)
 * @returns {string} '' for an empty or unreadable accelerator
 */
export function formatAccelerator(acc, { mac = true } = {}) {
  const p = parseAccelerator(acc);
  if (p.error) return '';
  if (mac) return p.mods.map((m) => MOD_SYMBOL[m]).join('') + (KEY_SYMBOL[p.key] || p.key);
  return [...p.mods.map((m) => MOD_WORD[m]), p.key].join('+');
}

/**
 * settings.hotkeys → its normal form: `{on: boolean, keys: {<id>: accelerator | ''}}`. Every action gets a key
 * ('' = none; a missing one gets its default); unreadable accelerators, and ones acceleratorError refuses (a single
 * plain key, a macOS system shortcut), become ''; a duplicate keeps the first action.
 * Unknown action ids are dropped; a legacy id (LEGACY_HOTKEY_IDS) stands in for its renamed action when that one is
 * absent. The same function the store uses on set and on load (schema stays 1).
 * @param {*} v
 * @returns {{on: boolean, keys: Object<string, string>}|null} null when `v` is not an object
 */
export function normalizeHotkeys(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const src = v.keys && typeof v.keys === 'object' && !Array.isArray(v.keys) ? v.keys : {};
  const keys = {};
  const used = new Set();
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
  const legacy = Object.fromEntries(Object.entries(LEGACY_HOTKEY_IDS).map(([old, id]) => [id, old]));
  for (const id of HOTKEY_IDS) {
    const from = has(id) ? id : legacy[id] && has(legacy[id]) ? legacy[id] : null;
    const raw = from ? src[from] : DEFAULT_HOTKEYS[id];
    const p = typeof raw === 'string' && raw ? parseAccelerator(raw) : null;
    // v11-decisions R-4: the store holds only what Settings would accept (the two-of-⌃⌥⌘ / F-key rule, no macOS
    // system shortcut), whoever writes settings.hotkeys; anything else becomes none
    const ok = p && !p.error && acceleratorError(p.canonical) === null;
    const acc = ok && !used.has(p.canonical) ? p.canonical : '';
    if (acc) used.add(acc);
    keys[id] = acc;
  }
  return { on: v.on === true, keys };
}

/**
 * The effective settings (absent settings.hotkeys = off, with the defaults).
 * @param {object} settings
 * @returns {{on: boolean, keys: Object<string, string>}}
 */
export function hotkeysOf(settings) {
  return normalizeHotkeys(settings && settings.hotkeys) || normalizeHotkeys({ on: false });
}

/**
 * Which other action already uses this accelerator?
 * @param {Object<string, string>} keys
 * @param {string} id the action being changed
 * @param {string} acc
 * @returns {string|null} the other action's id
 */
export function hotkeyConflict(keys, id, acc) {
  const p = parseAccelerator(acc);
  if (p.error) return null;
  for (const other of HOTKEY_IDS) {
    if (other === id || !keys || !keys[other]) continue;
    const q = parseAccelerator(keys[other]);
    if (!q.error && q.canonical === p.canonical) return other;
  }
  return null;
}
