// v11-electron: app/js/shared/hotkeys.js — accelerator parsing/validation, the keydown recorder, Mac formatting and
// settings.hotkeys normalisation. Plus the cross-checks with the Electron-main side (global-hotkeys.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  HOTKEY_ACTIONS, HOTKEY_IDS, DEFAULT_HOTKEYS, MASTER_STEP_DB, LEGACY_HOTKEY_IDS, parseAccelerator, acceleratorError,
  acceleratorFromEvent, formatAccelerator, normalizeHotkeys, hotkeysOf, hotkeyConflict,
} from '../../../app/js/shared/hotkeys.js';

const require = createRequire(import.meta.url);
const main = require('../../../global-hotkeys.js');

test('parseAccelerator: aliases, order and case are normalised', () => {
  assert.deepEqual(parseAccelerator('cmd+ctrl+option+right'), {
    mods: ['Control', 'Alt', 'Command'], key: 'Right', canonical: 'Control+Alt+Command+Right',
  });
  assert.equal(parseAccelerator('Shift+Command+Alt+p').canonical, 'Alt+Shift+Command+P');
  assert.equal(parseAccelerator('Control+Alt+Command+]').canonical, 'Control+Alt+Command+]');
  assert.equal(parseAccelerator('Control+Alt+Esc').canonical, 'Control+Alt+Escape');
  assert.equal(parseAccelerator('Control+Alt+Plus').key, 'Plus');
  assert.equal(parseAccelerator('F13').canonical, 'F13');
});

test('parseAccelerator: malformed input is an error, never a throw', () => {
  for (const bad of ['', '   ', 'Control+Alt', 'Control++A', 'A+Control', 'Control+A+B', 'Control+Control+A',
    'Control+Alt+Banana', 'F25', 'x'.repeat(100), null, 42, {}]) {
    assert.ok(parseAccelerator(bad).error, JSON.stringify(bad));
  }
});

test('acceleratorError: two of ⌃⌥⌘, or a function key; system shortcuts refused', () => {
  assert.equal(acceleratorError('Control+Alt+Command+P'), null);
  assert.equal(acceleratorError('Control+Command+N'), null);
  assert.equal(acceleratorError('Alt+Shift+Command+Right'), null);
  assert.equal(acceleratorError('F19'), null, 'a bare function key is fine');
  assert.equal(acceleratorError('Shift+F5'), null);
  assert.match(acceleratorError('Command+C'), /two of/, '⌘C belongs to every app');
  assert.match(acceleratorError('Shift+Command+S'), /two of/);
  assert.match(acceleratorError('Alt+E'), /two of/, '⌥E types an accent');
  assert.match(acceleratorError('P'), /two of/);
  assert.match(acceleratorError('Alt+Command+Escape'), /Force Quit/);
  assert.match(acceleratorError('Control+Command+Q'), /Lock Screen/);
  assert.match(acceleratorError('nope+'), /isn’t a key combination/);
});

test('every default is valid, distinct and accepted by main’s guard', () => {
  assert.deepEqual(Object.keys(DEFAULT_HOTKEYS), HOTKEY_IDS);
  for (const [id, acc] of Object.entries(DEFAULT_HOTKEYS)) {
    assert.equal(acceleratorError(acc), null, id);
    assert.equal(parseAccelerator(acc).canonical, acc, `${id} is canonical`);
  }
  assert.equal(new Set(Object.values(DEFAULT_HOTKEYS)).size, HOTKEY_IDS.length);
  assert.deepEqual(main.sanitizeHotkeyConfig({ on: true, keys: DEFAULT_HOTKEYS }).keys, DEFAULT_HOTKEYS);
});

test('the renderer and Electron main agree on the action ids and the master step', () => {
  assert.deepEqual([...main.HOTKEY_IDS], [...HOTKEY_IDS]);
  assert.deepEqual(HOTKEY_ACTIONS.map((a) => a.id), [...HOTKEY_IDS]);
  assert.equal(main.MASTER_STEP_DB, MASTER_STEP_DB);
});

test('acceleratorFromEvent: physical keys (⌥ never turns letters into accents), modifier-only waits', () => {
  const ev = (code, mods = {}) => ({ code, key: '?', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
  const all = { ctrlKey: true, altKey: true, metaKey: true };
  assert.equal(acceleratorFromEvent(ev('KeyP', all)), 'Control+Alt+Command+P');
  assert.equal(acceleratorFromEvent(ev('KeyE', { altKey: true, key: '´' })), 'Alt+E');
  assert.equal(acceleratorFromEvent(ev('BracketRight', all)), 'Control+Alt+Command+]');
  assert.equal(acceleratorFromEvent(ev('Minus', all)), 'Control+Alt+Command+-');
  assert.equal(acceleratorFromEvent(ev('ArrowLeft', { ctrlKey: true, shiftKey: true })), 'Control+Shift+Left');
  assert.equal(acceleratorFromEvent(ev('Digit7', { metaKey: true, ctrlKey: true })), 'Control+Command+7');
  assert.equal(acceleratorFromEvent(ev('F19')), 'F19');
  assert.equal(acceleratorFromEvent(ev('Enter', all)), 'Control+Alt+Command+Return');
  for (const c of ['ShiftLeft', 'MetaRight', 'AltLeft', 'ControlLeft', 'CapsLock', 'Fn', 'AudioVolumeUp']) {
    assert.equal(acceleratorFromEvent(ev(c, all)), null, c);
  }
  assert.equal(acceleratorFromEvent(null), null);
  // whatever the recorder makes parses back to itself
  for (const c of ['KeyA', 'Digit0', 'Slash', 'Backquote', 'Quote', 'PageDown', 'Space', 'F24']) {
    const acc = acceleratorFromEvent(ev(c, all));
    assert.equal(parseAccelerator(acc).canonical, acc, c);
  }
});

test('formatAccelerator: Mac symbols in Apple’s order; words elsewhere', () => {
  assert.equal(formatAccelerator('Control+Alt+Command+]'), '⌃⌥⌘]');
  assert.equal(formatAccelerator('Command+Shift+Alt+Control+Right'), '⌃⌥⇧⌘→');
  assert.equal(formatAccelerator('Control+Alt+Command+Escape'), '⌃⌥⌘Esc');
  assert.equal(formatAccelerator('Control+Alt+Right', { mac: false }), 'Ctrl+Alt+Right');
  assert.equal(formatAccelerator(''), '');
  assert.equal(formatAccelerator('Control+'), '');
});

test('normalizeHotkeys: every action, canonical, duplicates and junk dropped, off unless on === true', () => {
  assert.equal(normalizeHotkeys(null), null);
  assert.equal(normalizeHotkeys([]), null);
  assert.equal(normalizeHotkeys('on'), null);
  assert.deepEqual(normalizeHotkeys({}), { on: false, keys: { ...DEFAULT_HOTKEYS } }, 'missing keys get the defaults');
  const n = normalizeHotkeys({
    on: 1,
    keys: { nextSong: 'cmd+ctrl+alt+n', prevSong: 'Command+Control+Alt+N', panic: '', masterUp: 'Banana', zap: 'F13' },
  });
  assert.equal(n.on, false, 'only true turns them on');
  assert.equal(n.keys.nextSong, 'Control+Alt+Command+N');
  assert.equal(n.keys.prevSong, '', 'a duplicate keeps the first action');
  assert.equal(n.keys.panic, '', "'' stays none");
  assert.equal(n.keys.masterUp, '', 'unreadable → none');
  assert.equal(n.keys.masterDown, DEFAULT_HOTKEYS.masterDown);
  assert.deepEqual(Object.keys(n.keys), HOTKEY_IDS, 'unknown ids dropped');
  assert.deepEqual(normalizeHotkeys(n), n, 'idempotent');
  assert.deepEqual(hotkeysOf({}), { on: false, keys: { ...DEFAULT_HOTKEYS } }, 'absent = off with the defaults');
});

test('v11-decisions: the pre-rename ids (nextMode / prevMode) carry over to nextSong / prevSong', () => {
  assert.deepEqual(LEGACY_HOTKEY_IDS, { nextMode: 'nextSong', prevMode: 'prevSong' });
  assert.deepEqual(HOTKEY_ACTIONS.slice(0, 2).map((a) => [a.id, a.label]),
    [['nextSong', 'Next song'], ['prevSong', 'Previous song']]);
  assert.equal(DEFAULT_HOTKEYS.nextSong, 'Control+Alt+Command+]', 'the standard keys stay ⌃⌥⌘] / ⌃⌥⌘[');
  assert.equal(DEFAULT_HOTKEYS.prevSong, 'Control+Alt+Command+[');
  // a v1.1-beta library: a custom next key, "none" for previous
  const old = { on: true, keys: { nextMode: 'Control+Alt+Command+N', prevMode: '', panic: 'F13' } };
  const n = normalizeHotkeys(old);
  assert.equal(n.on, true);
  assert.equal(n.keys.nextSong, 'Control+Alt+Command+N', 'the saved combination moves to the new id');
  assert.equal(n.keys.prevSong, '', 'a saved "none" stays none (not the default)');
  assert.equal(n.keys.panic, 'F13');
  assert.ok(!('nextMode' in n.keys) && !('prevMode' in n.keys), 'the old ids are dropped');
  assert.deepEqual(normalizeHotkeys(n), n, 'idempotent');
  // the new id wins when both are there
  assert.equal(normalizeHotkeys({ keys: { nextMode: 'F14', nextSong: 'F15' } }).keys.nextSong, 'F15');
  // the defaults when neither is there
  assert.equal(normalizeHotkeys({ keys: { panic: 'F13' } }).keys.nextSong, DEFAULT_HOTKEYS.nextSong);
});

test('hotkeyConflict names the other action using a combination', () => {
  const keys = { ...DEFAULT_HOTKEYS };
  assert.equal(hotkeyConflict(keys, 'nextSong', 'cmd+alt+ctrl+p'), 'panic');
  assert.equal(hotkeyConflict(keys, 'panic', 'Control+Alt+Command+P'), null, 'its own combination is no conflict');
  assert.equal(hotkeyConflict(keys, 'panic', 'Control+Alt+Command+K'), null);
  assert.equal(hotkeyConflict({ ...keys, panic: '' }, 'nextSong', 'Control+Alt+Command+P'), null);
});
