// The class must cover 100 % of the contracted surface, and nothing public beyond it (engine-api.json `methods`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BridgeEngine } from '../../../app/js/engine-bridge/bridge-engine.js';
import { loopbackPair } from '../../../app/js/engine-bridge/transports.js';
import { api } from './helpers.mjs';

function makeEngine() {
  const { js } = loopbackPair();
  return new BridgeEngine({ transport: js });
}

/** Contract names -> dotted member paths ('drone.cfg / drone.key / drone.files' lists three). */
function members() {
  const out = [];
  for (const m of api.methods) {
    if (m.kind === 'ctor') continue;
    const parts = m.name.split(' / ').map((s) => s.trim());
    const prefix = parts[0].includes('.') ? `${parts[0].split('.')[0]}.` : '';
    parts.forEach((p, i) => out.push({ path: i > 0 && !p.includes('.') ? prefix + p : p, kind: m.kind, name: m.name }));
  }
  return out;
}

const has = (obj, name) => name in obj;
const resolve = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

test('the contract lists 68 entries and the shim expands them to members', () => {
  // 63 + setDynamicRange (T12 O1) + the native-only setPolyphony / setVoiceLimit / setBufferFrames / setDroneFreeze
  // (Settings review item 2, UIB: contracted instead of allow-listed below)
  assert.equal(api.methods.length, 68);
  assert.ok(members().length >= 68);
});

test('every contracted method, getter and property exists with the right kind', () => {
  const e = makeEngine();
  const missing = [];
  for (const m of members()) {
    const top = m.path.split('.');
    const parent = top.length > 1 ? resolve(e, top.slice(0, -1).join('.')) : e;
    const leaf = top[top.length - 1];
    if (!parent || !has(parent, leaf)) {
      missing.push(m.path);
      continue;
    }
    if (m.kind === 'method' && typeof parent[leaf] !== 'function') missing.push(`${m.path} (not a function)`);
  }
  assert.deepEqual(missing, []);
  e._dispose();
});

test('the constructor is the class itself, with hello as its bridge op', () => {
  const ctor = api.methods.find((m) => m.kind === 'ctor');
  assert.equal(ctor.bridge.op, 'hello');
  assert.equal(typeof BridgeEngine, 'function');
});

test('no public member beyond the contract (underscore-prefixed helpers and EventTarget only)', () => {
  const e = makeEngine();
  const contract = new Set(members().map((m) => m.path.split('.')[0]));
  // the 2.0 Settings › Sound setters (D1, D2, D4, D5) are in engine-api.json `methods` (nativeOnly) since UIB
  const allowed = new Set(['removeEventListener', 'dispatchEvent', 'constructor']);
  const names = new Set();
  for (let o = e; o && o !== EventTarget.prototype && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) names.add(k);
  }
  const extra = [...names].filter((k) => !k.startsWith('_') && !contract.has(k) && !allowed.has(k));
  assert.deepEqual(extra, []);
  e._dispose();
});

test('engine.drone exposes exactly setKey, configure, attachFiles, cfg, key, files', () => {
  const e = makeEngine();
  const names = new Set();
  for (let o = e.drone; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) if (!k.startsWith('_') && k !== 'constructor') names.add(k);
  }
  assert.deepEqual([...names].sort(), ['attachFiles', 'cfg', 'configure', 'files', 'key', 'setKey']);
  e._dispose();
});

test('the not-contract list stays out of the class', () => {
  const e = makeEngine();
  for (const n of api.notContract) assert.ok(!has(e, n.name), `not-contract member leaked: ${n.name}`);
  e._dispose();
});

test('every contracted event name can be listened to (EventTarget)', () => {
  const e = makeEngine();
  for (const ev of api.events) e.addEventListener(ev.name, () => {});
  assert.equal(api.events.length, 10);
  e._dispose();
});

test('each contracted method names a bridge op that exists, or is answered locally', () => {
  const ops = new Set(api.messages.ops.map((o) => o.op));
  for (const m of api.methods) {
    if (m.bridge && m.bridge.op) assert.ok(ops.has(m.bridge.op), `${m.name} -> ${m.bridge.op}`);
    else assert.ok(m.bridge && m.bridge.local, `${m.name} has neither op nor local`);
  }
});
