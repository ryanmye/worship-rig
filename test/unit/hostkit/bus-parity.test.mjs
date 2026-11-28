// Remote lane (D45): rig_bus.h (native/core/src/hostkit/bus_check.cpp) against app/js/shared/bus.js, the reference,
// behind Electron main.js's caps (64 KB state / 4 KB command, in string length). One generated corpus runs through
// both: every reason must be the same string ("too large …" compared by prefix: the C++ text adds the numbers).
// Needs the rig-hostkit CLI: RIG_HOSTKIT_CLI=<path> (ctest `unit.hostkit-bus-parity` sets it), else the first one built
// under native/core/build*/; skipped when there is none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  stateError, commandError, COMMAND_TYPES, AUDIO_STATES, REMOTE_VIA, SCENE_NAME_MAX,
} from '../../../app/js/shared/bus.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const STATE_MAX = 64 * 1024; // main.js BUS_STATE_MAX
const COMMAND_MAX = 4 * 1024; // main.js BUS_COMMAND_MAX
const DEPTH = 16; // bus_check.cpp: deeper is not a bus message

function findCli() {
  if (process.env.RIG_HOSTKIT_CLI) return process.env.RIG_HOSTKIT_CLI;
  const core = path.join(root, 'native/core');
  for (const d of fs.readdirSync(core).filter((n) => n.startsWith('build')).sort()) {
    for (const sub of ['', 'release', 'debug', 'asan']) {
      const p = path.join(core, d, sub, 'rig-hostkit');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}
const CLI = findCli();
const skip = CLI ? false : 'rig-hostkit not built (cmake --build <dir> --target rig-hostkit), or set RIG_HOSTKIT_CLI';

function deeperThan(v, max, d = 0) {
  if (v === null || typeof v !== 'object') return false;
  if (d >= max) return true;
  for (const x of Array.isArray(v) ? v : Object.values(v)) if (deeperThan(x, max, d + 1)) return true;
  return false;
}

/** The reference: main.js parseBusJson's cap, JSON.parse, the depth bound, then bus.js. */
function reference(text, isState) {
  if (text.length > (isState ? STATE_MAX : COMMAND_MAX)) return 'too large';
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return 'not JSON';
  }
  if (deeperThan(m, DEPTH)) return 'too deep';
  return (isState ? stateError(m) : commandError(m)) ?? 'ok';
}

function native(texts, isState) {
  const input = `${texts.map((t) => Buffer.from(t, 'utf8').toString('hex')).join('\n')}\n`;
  const out = execFileSync(CLI, [isState ? 'bus-state' : 'bus-command'], { input, maxBuffer: 1 << 28 }).toString();
  return out.trimEnd().split('\n').map((l) => {
    if (l === 'ok') return 'ok';
    const r = Buffer.from(l.slice(4), 'hex').toString('utf8');
    return r.startsWith('too large (') ? 'too large' : r;
  });
}

// ---- corpus
const VALUES = [undefined, null, true, false, 0, -0, 1, 2, 2.5, -1, 11, 12, 0.5, '', 'x', 'running', [], [1], {},
  { a: 1 }, 'Bridge'];
const RAW_NUMS = ['1e999', '-1e999', '1.0', '2.0000000000000001', '1e-400', '-0.0'];

function baseState() {
  return {
    v: 1, current: { id: 'a', name: 'Sunday', key: 'D' }, modes: [{ id: 'a', name: 'Sunday', key: 'D', index: 0 }],
    master: 1, masterDb: 0, droneOn: false, droneKey: 'D', audio: 'running', latencyMs: 5.5,
    midi: { connected: false, name: null }, lowResource: false, recording: false, windowVisible: true, memoryMB: null,
  };
}

/** Set a dotted path (creating objects on the way); undefined deletes. */
function setPath(o, p, v) {
  const keys = p.split('.');
  let t = o;
  for (const k of keys.slice(0, -1)) {
    if (t[k] === null || typeof t[k] !== 'object') t[k] = {};
    t = t[k];
  }
  const last = keys.at(-1);
  if (v === undefined) delete t[last];
  else t[last] = v;
  return o;
}

function stateCorpus() {
  const out = [];
  const paths = ['v', 'current', 'current.id', 'current.name', 'current.key', 'modes', 'modes.0', 'modes.0.id',
    'modes.0.index', 'master', 'masterDb', 'droneOn', 'droneKey', 'audio', 'latencyMs', 'midi', 'midi.connected',
    'midi.name', 'lowResource', 'recording', 'windowVisible', 'memoryMB', 'theme', 'scene', 'scene.n', 'scene.count',
    'scene.name', 'locked'];
  for (const p of paths) {
    for (const v of VALUES) {
      const s = baseState();
      if (p.startsWith('scene.')) s.scene = { n: 0, count: 2 };
      out.push(JSON.stringify(setPath(s, p, v)));
    }
  }
  // numbers JSON.stringify can't write (Infinity, rounding, -0)
  for (const raw of RAW_NUMS) {
    for (const k of ['master', 'latencyMs', 'masterDb', 'memoryMB', 'v']) {
      out.push(JSON.stringify(baseState()).replace(`"${k}":`, `"${k}":${raw},"_${k}":`));
    }
    out.push(JSON.stringify({ ...baseState(), scene: { n: 0, count: 2 } }).replace('"count":2', `"count":${raw}`));
  }
  // scene names: code points vs UTF-16 units, lone surrogates, escapes
  const sc = (name) => JSON.stringify({ ...baseState(), scene: { n: 1, count: 2, name } });
  for (const name of ['x'.repeat(39), 'x'.repeat(40), 'x'.repeat(41), '😀'.repeat(40), '😀'.repeat(41),
    `${'😀'.repeat(39)}é`, 'é'.repeat(20), 'é'.repeat(21), '\ud800'.repeat(40), '\ud800'.repeat(41),
    `${'\udc00\ud800'.repeat(20)}`, `a${'\u0000'.repeat(39)}`]) out.push(sc(name));
  out.push(JSON.stringify({ ...baseState(), scene: { n: 0, count: 2 } })
    .replace('"count":2', `"count":2,"name":"${'\\ud83d\\ude00'.repeat(40)}"`));
  out.push(JSON.stringify({ ...baseState(), scene: { n: 0, count: 2 } })
    .replace('"count":2', `"count":2,"name":"${'\\ud83d'.repeat(41)}"`));
  // skeptic S1: every enum value and cap bus.js exports, so a value added on one side only fails here
  for (const a of AUDIO_STATES) out.push(JSON.stringify({ ...baseState(), audio: a }));
  for (const n of [SCENE_NAME_MAX - 1, SCENE_NAME_MAX, SCENE_NAME_MAX + 1]) out.push(sc('n'.repeat(n)));
  // duplicate keys (the later value wins), key order, extra fields
  out.push(JSON.stringify(baseState()).replace('"v":1', '"v":1,"v":2'));
  out.push(JSON.stringify(baseState()).replace('"v":1', '"v":2,"v":1'));
  out.push(JSON.stringify({ zzz: 1, ...baseState(), __proto__x: 1, constructor: 'x' }));
  out.push(JSON.stringify(baseState()).replace('{', '{"__proto__":{"v":2},'));
  // whole-message shapes, JSON edge cases, size and depth
  out.push('', ' ', 'null', '[]', '1', '"x"', '{', '{}', '{"v":1}', ' {"v":1} ', '﻿{"v":1}');
  const big = JSON.stringify({ ...baseState(), pad: '' });
  out.push(big.replace('"pad":""', `"pad":"${'a'.repeat(STATE_MAX - big.length)}"`));
  out.push(big.replace('"pad":""', `"pad":"${'a'.repeat(STATE_MAX - big.length + 1)}"`));
  out.push(big.replace('"pad":""', `"pad":"${'é'.repeat(STATE_MAX - big.length)}"`)); // 2 bytes per unit, still fits
  out.push(JSON.stringify({ ...baseState(), deep: JSON.parse(`${'['.repeat(14)}${']'.repeat(14)}`) }));
  out.push(JSON.stringify({ ...baseState(), deep: JSON.parse(`${'['.repeat(15)}${']'.repeat(15)}`) }));
  out.push(JSON.stringify({ ...baseState(), deep: JSON.parse(`${'['.repeat(16)}${']'.repeat(16)}`) }));
  // many modes
  out.push(JSON.stringify({ ...baseState(), modes: Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, name: `S ${i}`,
    key: 'C', index: i })) }));
  return out;
}

function commandCorpus() {
  const out = [];
  for (const type of [...COMMAND_TYPES, 'nope', '', 'PANIC', 'constructor', '__proto__', 'toString']) {
    out.push(JSON.stringify({ v: 1, type }));
    for (const k of ['id', 'value', 'pc', 'on', 'via']) {
      for (const v of VALUES) out.push(JSON.stringify(setPath({ v: 1, type }, k, v)));
    }
    for (const via of REMOTE_VIA) out.push(JSON.stringify({ v: 1, type, via }));
  }
  for (const t of [undefined, null, 1, true, [], {}, { a: [1, null, 'x'] }, '\ud800', 'é"\\\n']) {
    out.push(JSON.stringify(setPath({ v: 1 }, 'type', t)));
  }
  for (const on of [true, false]) out.push(JSON.stringify({ v: 1, type: 'droneToggle', on, via: 'remote' }));
  for (const raw of RAW_NUMS) {
    out.push(`{"v":1,"type":"master","value":${raw}}`, `{"v":1,"type":"droneKey","pc":${raw}}`,
      `{"v":${raw},"type":"panic"}`);
  }
  out.push('', 'null', '[]', '{', '{"v":1,"type":"panic"', '{"v":1,"type":"panic"}x', '{"v":1,"type":"panic",}');
  const pad = '{"v":1,"type":"panic","p":""}';
  out.push(pad.replace('""', `"${'a'.repeat(COMMAND_MAX - pad.length)}"`));
  out.push(pad.replace('""', `"${'a'.repeat(COMMAND_MAX - pad.length + 1)}"`));
  out.push(pad.replace('""', `"${'😀'.repeat((COMMAND_MAX - pad.length) / 2)}"`)); // 4 bytes, 2 units each: fits
  return out;
}

test('bus states: rig_bus_check_state = bus.js stateError behind main.js\'s cap', { skip }, () => {
  const cases = stateCorpus();
  const got = native(cases, true);
  assert.equal(got.length, cases.length);
  let ok = 0;
  for (let i = 0; i < cases.length; i++) {
    assert.equal(got[i], reference(cases[i], true), `case ${i}: ${cases[i].slice(0, 200)}`);
    if (got[i] === 'ok') ok++;
  }
  assert.ok(ok > 20 && ok < cases.length - 100, `the corpus has both kinds (${ok} valid of ${cases.length})`);
});

test('bus commands: rig_bus_check_command = bus.js commandError behind main.js\'s cap', { skip }, () => {
  const cases = commandCorpus();
  const got = native(cases, false);
  assert.equal(got.length, cases.length);
  let ok = 0;
  for (let i = 0; i < cases.length; i++) {
    assert.equal(got[i], reference(cases[i], false), `case ${i}: ${cases[i].slice(0, 200)}`);
    if (got[i] === 'ok') ok++;
  }
  assert.ok(ok > 30 && ok < cases.length - 100, `the corpus has both kinds (${ok} valid of ${cases.length})`);
});
