// v11-electron: global-hotkeys.js (Electron main side) with a fake globalShortcut — registration states, pause,
// off/dispose unregister everything, presses become valid contract-v1 bus commands, master steps in dB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { commandError } from '../../../app/js/shared/bus.js';

const require = createRequire(import.meta.url);
const { masterStep, hotkeyCommand, sanitizeHotkeyConfig, createHotkeys, MASTER_FLOOR_DB } = require('../../../global-hotkeys.js');

const db = (v) => 20 * Math.log10(v);
const KEYS = {
  nextSong: 'Control+Alt+Command+]', prevSong: 'Control+Alt+Command+[', panic: 'Control+Alt+Command+P',
  masterUp: 'Control+Alt+Command+=', masterDown: 'Control+Alt+Command+-',
  nextScene: 'Control+Alt+Command+.', prevScene: 'Control+Alt+Command+,', // v11-scenes
};

/** A globalShortcut stand-in: `taken` are held by "another app" (register → false), `bad` throw like Electron does. */
function fakeShortcuts({ taken = [], bad = [] } = {}) {
  const held = new Map();
  return {
    held,
    register(acc, cb) {
      if (bad.includes(acc)) throw new TypeError('conversion failure');
      if (taken.includes(acc) || held.has(acc)) return false;
      held.set(acc, cb);
      return true;
    },
    unregister(acc) {
      held.delete(acc);
    },
    press(acc) {
      const cb = held.get(acc);
      if (cb) cb();
      return !!cb;
    },
  };
}

function setup(o = {}) {
  const sc = fakeShortcuts(o);
  const sent = [];
  const statuses = [];
  let t = 1000;
  let master = o.master === undefined ? 0.5 : o.master;
  const hk = createHotkeys({
    shortcuts: sc,
    send: (c) => sent.push(c),
    masterNow: () => master,
    now: () => t,
    onStatus: (s) => statuses.push(s),
  });
  return { sc, sent, statuses, hk, advance: (ms) => (t += ms), setMaster: (v) => (master = v) };
}

test('masterStep: ±2 dB, silence below −40 dB, the first step up from silence lands at −40 dB, capped at 2', () => {
  assert.ok(Math.abs(db(masterStep(0.5, 1)) - (db(0.5) + 2)) < 0.01);
  assert.ok(Math.abs(db(masterStep(0.5, -1)) - (db(0.5) - 2)) < 0.01);
  assert.equal(masterStep(0, -1), 0);
  assert.ok(Math.abs(db(masterStep(0, 1)) - MASTER_FLOOR_DB) < 0.01);
  assert.equal(masterStep(10 ** (-39 / 20), -1), 0, '−39 dB − 2 → below the floor → silent');
  assert.equal(masterStep(2, 1), 2);
  assert.equal(masterStep(1.9, 1), 2);
  assert.equal(masterStep(NaN, 1), masterStep(0, 1));
  // ten steps down and ten up come back (rounding stays small)
  let v = 1;
  for (let i = 0; i < 10; i++) v = masterStep(v, -1);
  for (let i = 0; i < 10; i++) v = masterStep(v, 1);
  assert.ok(Math.abs(v - 1) < 1e-3, String(v));
});

test('hotkeyCommand: every press is a valid contract-v1 bus command', () => {
  for (const id of ['nextSong', 'prevSong', 'panic', 'masterUp', 'masterDown', 'nextScene', 'prevScene']) {
    const c = hotkeyCommand(id, 0.5);
    assert.equal(commandError(c), null, `${id}: ${JSON.stringify(c)}`);
  }
  assert.equal(hotkeyCommand('masterUp', null), null, 'no state yet: master keys do nothing');
  assert.equal(hotkeyCommand('formatDisk', 0.5), null);
  assert.deepEqual(hotkeyCommand('panic', null), { v: 1, type: 'panic' });
  assert.deepEqual(hotkeyCommand('nextScene', null), { v: 1, type: 'nextScene' }, 'v11-scenes');
  assert.deepEqual(hotkeyCommand('prevScene', null), { v: 1, type: 'prevScene' });
  // v11-decisions (Ryan, checklist Q3): next / previous step the setlist's songs, never the menu-bar modes
  assert.deepEqual(hotkeyCommand('nextSong', null), { v: 1, type: 'nextSong' });
  assert.deepEqual(hotkeyCommand('prevSong', null), { v: 1, type: 'prevSong' });
  assert.equal(hotkeyCommand('nextMode', null), null, 'the pre-rename ids are not actions any more');
});

test('sanitizeHotkeyConfig: only known ids and accelerator-shaped strings survive', () => {
  const s = sanitizeHotkeyConfig({ on: 'yes', keys: { nextSong: 'Control+Alt+N', panic: 'rm -rf /;', zap: 'F1', prevSong: 7 } });
  assert.equal(s.on, false);
  assert.deepEqual(s.keys, {
    nextSong: 'Control+Alt+N', prevSong: '', panic: '', masterUp: '', masterDown: '', nextScene: '', prevScene: '',
  });
  assert.deepEqual(sanitizeHotkeyConfig(null).keys.panic, '');
  assert.equal(sanitizeHotkeyConfig([1]).on, false);
});

test('register: ok / taken (another app) / invalid (Electron throws) / none; status pushed each time', () => {
  const { sc, hk, statuses } = setup({ taken: [KEYS.panic], bad: [KEYS.masterUp] });
  const s = hk.set({ on: true, keys: { ...KEYS, masterDown: '', nextScene: '', prevScene: '' } });
  assert.deepEqual(Object.fromEntries(Object.entries(s.keys).map(([k, v]) => [k, v.state])), {
    nextSong: 'ok', prevSong: 'ok', panic: 'taken', masterUp: 'invalid', masterDown: 'none', nextScene: 'none',
    prevScene: 'none',
  });
  assert.equal(s.keys.nextSong.accelerator, KEYS.nextSong);
  assert.deepEqual([...sc.held.keys()].sort(), [KEYS.nextSong, KEYS.prevSong].sort());
  assert.equal(statuses.length, 1);
  assert.deepEqual(hk.status(), s);
});

test('off and dispose unregister everything; re-setting replaces the old combinations', () => {
  const { sc, hk } = setup();
  hk.set({ on: true, keys: KEYS });
  assert.equal(sc.held.size, 7);
  hk.set({ on: true, keys: { ...KEYS, nextSong: 'Control+Alt+Command+N' } });
  assert.ok(sc.held.has('Control+Alt+Command+N') && !sc.held.has(KEYS.nextSong), 'the old one is released');
  assert.equal(sc.held.size, 7);
  const off = hk.set({ on: false, keys: KEYS });
  assert.equal(sc.held.size, 0);
  assert.ok(Object.values(off.keys).every((k) => k.state === 'off'));
  hk.set({ on: true, keys: KEYS });
  hk.dispose();
  assert.equal(sc.held.size, 0);
  assert.deepEqual(hk.registered(), []);
});

test('pause (Settings is recording a combination) lets go, unpause takes them back', () => {
  const { sc, hk } = setup();
  hk.set({ on: true, keys: KEYS });
  const p = hk.pause(true);
  assert.equal(sc.held.size, 0);
  assert.equal(p.paused, true);
  assert.ok(Object.values(p.keys).every((k) => k.state === 'paused'));
  hk.pause(false);
  assert.equal(sc.held.size, 7);
});

test('presses send the existing bus commands; master steps from the value just sent, then from the state', () => {
  const { sc, hk, sent, advance, setMaster } = setup({ master: 0.5 });
  hk.set({ on: true, keys: KEYS });
  sc.press(KEYS.nextSong);
  sc.press(KEYS.prevSong);
  sc.press(KEYS.panic);
  assert.deepEqual(sent.splice(0), [{ v: 1, type: 'nextSong' }, { v: 1, type: 'prevSong' }, { v: 1, type: 'panic' }]);
  sc.press(KEYS.nextScene); // v11-scenes
  sc.press(KEYS.prevScene);
  assert.deepEqual(sent.splice(0), [{ v: 1, type: 'nextScene' }, { v: 1, type: 'prevScene' }]);
  // two quick presses: the second steps from the first (the published state is throttled to ≤ 4/s)
  sc.press(KEYS.masterUp);
  advance(100);
  sc.press(KEYS.masterUp);
  assert.equal(sent.length, 2);
  assert.ok(Math.abs(db(sent[1].value) - (db(0.5) + 4)) < 0.02, JSON.stringify(sent));
  // later, the published state wins again (someone moved the fader meanwhile)
  advance(5000);
  setMaster(1);
  sc.press(KEYS.masterDown);
  assert.ok(Math.abs(db(sent[2].value) - -2) < 0.02, JSON.stringify(sent[2]));
  for (const c of sent) assert.equal(commandError(c), null);
});

test('master keys before any state do nothing (no command)', () => {
  const { sc, hk, sent } = setup({ master: null });
  hk.set({ on: true, keys: KEYS });
  sc.press(KEYS.masterUp);
  assert.deepEqual(sent, []);
  assert.equal(hk.fire('masterDown'), null);
});
