// Security & privacy review (reviews/security.md S2, S3; CONTRACT_CHANGES "## security"): hostile library/song
// imports (prototype keys, deep nesting, oversize) and what a library export carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStorage, LIBRARY_MAX_CHARS, IMPORT_MAX_DEPTH, DEVICE_LOCAL_SETTINGS } from '../../../app/js/store.js';
import { makeStore } from './helpers.mjs';

const deep = (n) => '{"x":'.repeat(n) + '1' + '}'.repeat(n);
const songFile = (song) => JSON.stringify({ app: 'worship-rig', kind: 'song', schema: 1, song: { patch: {}, ...song } });

test('S1: prototype keys in an import never reach Object.prototype or the library maps', () => {
  const s = makeStore();
  const evil = '{"schema":1,"__proto__":{"p1":1},' +
    '"songs":{"__proto__":{"name":"x","patch":{}},"constructor":{"name":"c","patch":{}},' +
    '"a":{"name":"A","patch":{"__proto__":{"p2":1},"slots":[{"instrument":{"type":"sampler","id":"x",' +
    '"__proto__":{"p3":1}},"params":{"__proto__":{"p4":1}}}]},"drone":{"__proto__":{"p5":1}}}},' +
    '"setlists":[{"id":"__proto__","name":"s","songIds":["a"]}],' +
    '"settings":{"__proto__":{"p6":1},"midiLearn":{"__proto__":{"cc":1},"toString":{"cc":2}}}}';
  assert.equal(s.importJSON(evil).ok, true);
  assert.equal(s.importJSON(evil, { replace: true }).ok, true);
  const probe = {};
  for (const k of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'cc']) assert.equal(k in probe, false, `Object.prototype.${k}`);
  const st = s.get();
  assert.deepEqual(Object.keys(st.songs), ['a'], 'only the real song survives');
  assert.equal(Object.getPrototypeOf(st.songs), Object.prototype);
  assert.equal(Object.hasOwn(st.settings.midiLearn, 'toString'), false);
  for (const p of ['songs.__proto__.name', 'settings.__proto__', 'songs.a.__proto__.x']) {
    assert.equal(s.set(p, { p7: 1 }), false, p);
  }
  assert.equal('p7' in {}, false);
  s.dispose();
});

test('S2: a deeply nested import is refused cleanly (was an uncaught RangeError), state untouched', () => {
  for (const replace of [false, true]) {
    for (const n of [IMPORT_MAX_DEPTH + 1, 5000, 100000]) {
      const s = makeStore({ storage: memoryStorage(), debounceMs: 0 });
      const before = s.get();
      let r;
      // the raw text the UI hands over (JSON.parse copes with all three depths; clone/deepFreeze did not)
      assert.doesNotThrow(() => {
        r = s.importJSON(`{"kind":"song","schema":1,"song":{"patch":{},"junk":${deep(n)}}}`, { replace });
      });
      assert.equal(r.ok, false, `depth ${n}`);
      assert.match(r.error, /not a Worship Rig library/);
      assert.equal(s.get(), before, 'no partial write');
      s.dispose();
    }
    // an object argument is checked before it is cloned
    const s = makeStore();
    const r = s.importJSON(JSON.parse(`{"kind":"song","schema":1,"song":{"patch":{},"junk":${deep(3000)}}}`), { replace });
    assert.equal(r.ok, false);
    s.dispose();
  }
  // a merge of several songs where a later one is hostile: nothing from the file lands in the state
  const s = makeStore();
  const n0 = s.get().songOrder.length;
  const lib = `{"schema":1,"songs":[{"id":"ok","name":"OK","patch":{}},{"id":"bad","name":"Bad","patch":{},"j":${deep(3000)}}]}`;
  assert.equal(s.importJSON(lib).ok, false);
  assert.equal(s.get().songOrder.length, n0);
  assert.equal(Object.keys(s.get().songs).length, n0);
  // ordinary nesting still imports (EQ bands are the deepest real path)
  const eq = { name: 'EQ', patch: { slots: [{ instrument: { type: 'sampler', id: 'salamander-piano' }, eq: { b3: { hz: 900, db: 2 } } }] } };
  assert.equal(s.importJSON(songFile(eq)).ok, true);
  s.dispose();
});

test('S2: an import that would not fit localStorage is refused before it can break saving', () => {
  const s = makeStore();
  const n0 = s.get().songOrder.length;
  const big = songFile({ name: 'big', blob: 'A'.repeat(LIBRARY_MAX_CHARS) });
  for (const replace of [false, true]) {
    const r = s.importJSON(big, { replace });
    assert.equal(r.ok, false);
    assert.match(r.error, /too large/);
  }
  assert.equal(s.importJSON('x'.repeat(4 * LIBRARY_MAX_CHARS + 1)).error, s.importJSON(big).error, 'huge text: not parsed');
  assert.equal(s.get().songOrder.length, n0);
  // many small songs add up the same way (merge counts the current library too)
  const many = Array.from({ length: 300 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, patch: {}, notes: 'n'.repeat(9000) }));
  assert.equal(s.importJSON(JSON.stringify(many)).ok, false);
  // a normal-size file still goes through
  assert.equal(s.importJSON(JSON.stringify(many.slice(0, 20))).ok, true);
  s.dispose();
});

test('S3: a library export leaves the device-local settings (pad folder path, device names/ids) out', () => {
  const a = makeStore();
  a.set('settings.padFolder', { kind: 'electron', path: '/Users/someone/Music/Worship Pads' });
  a.set('settings.midiInputName', "Someone's KeyLab 61");
  a.set('settings.midiInputId', 'kbd-7f3a');
  a.set('settings.outputDeviceId', 'b1946ac92492d2347c6235b4d2611184');
  a.set('settings.pedalInvert', true);
  const text = a.exportJSON();
  assert.doesNotMatch(text, /someone|KeyLab|kbd-7f3a|b1946ac9/i);
  const doc = JSON.parse(text);
  for (const k of DEVICE_LOCAL_SETTINGS) assert.equal(k in doc.settings, false, k);
  assert.equal(doc.settings.pedalInvert, true, 'library settings are still exported');
  // a replace-import on another machine keeps that machine's device settings, as before
  const b = makeStore();
  b.set('settings.outputDeviceId', 'usb-b');
  assert.equal(b.importJSON(text, { replace: true }).ok, true);
  assert.equal(b.get().settings.outputDeviceId, 'usb-b');
  assert.equal(b.get().settings.pedalInvert, true);
  assert.deepEqual(b.get().songs, a.get().songs);
  a.dispose();
  b.dispose();
});
