import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  changedPaths,
  changedCount,
  hasChange,
  droneOnMode,
  sameValue,
  DIFF_WATCH,
} from '../../../app/js/shared/song-diff.js';
import { normalizeSong } from '../../../app/js/store.js';
import { FACTORY_SONGS } from '../../../app/js/presets.js';
import { SPACE_PRESETS, ECHO_PRESETS, applyPreset } from '../../../app/js/shared/fx-presets.js';

const base = () => {
  const f = FACTORY_SONGS.find((s) => s.id === 'factory:sunday-pad-piano') || FACTORY_SONGS[0];
  return normalizeSong(structuredClone(f), f.id);
};
/** Set a dotted path on a clone (what store.set does to the song). */
const setPath = (song, path, v) => {
  const segs = path.split('.');
  let o = song;
  for (const k of segs.slice(0, -1)) o = o[k];
  o[segs.at(-1)] = v;
  return song;
};
const edit = (fn) => {
  const b = base();
  const s = structuredClone(b);
  fn(s);
  return { s, b };
};

test('an untouched song has no changes', () => {
  const b = base();
  assert.equal(changedCount(structuredClone(b), b), 0);
  assert.deepEqual([...changedPaths(b, b)], []);
});

test('faders and levels never count (slot gain, drone gain, master volume)', () => {
  const { s, b } = edit((s) => {
    s.patch.slots[0].gain = 0.31;
    s.drone.gain = 1.4;
    s.patch.fx.master = { ...(s.patch.fx.master || {}), volume: 0.2 };
    s.drone.brightness = 0.9;
  });
  assert.deepEqual([...changedPaths(s, b)], []);
});

test('mutes never count: first-class muted, the old gain 0 + mutedGain convention, and the drone ON tile', () => {
  const { s, b } = edit((s) => {
    s.patch.slots[0].muted = true;
    s.patch.slots[1].gain = 0;
    s.patch.slots[1].mutedGain = 0.8;
    s.drone.mode = 'off';
  });
  assert.equal(changedCount(s, b), 0);
  // …and turning the drone back on from an OFF snapshot is the tile too
  const off = base();
  off.drone.mode = 'off';
  const on = structuredClone(off);
  on.drone.mode = 'files';
  assert.equal(changedCount(on, off), 0);
});

test('changing sends.reverb → exactly that path', () => {
  const { s, b } = edit((s) => setPath(s, 'patch.slots.1.sends.reverb', 0.75));
  assert.deepEqual([...changedPaths(s, b)], ['patch.slots.1.sends.reverb']);
});

test('each strip chip path is watched: octave, sustain, echo, chorus, instrument', () => {
  const { s, b } = edit((s) => {
    s.patch.slots[0].octave = 1;
    s.patch.slots[0].sustain = !s.patch.slots[0].sustain;
    s.patch.slots[0].sends.delay = 0.5;
    s.patch.slots[1].sends.chorus = 0;
    s.patch.slots[1].instrument = { type: 'synth', id: 'other-pad' };
  });
  assert.deepEqual(
    [...changedPaths(s, b)],
    [
      'patch.slots.0.sends.delay',
      'patch.slots.0.octave',
      'patch.slots.0.sustain',
      'patch.slots.1.instrument',
      'patch.slots.1.sends.chorus',
    ],
  );
  assert.ok(hasChange(changedPaths(s, b), 'patch.slots.0'));
  assert.ok(!hasChange(changedPaths(s, b), 'patch.slots.3'));
  assert.ok(!hasChange(changedPaths(s, b), 'patch.slots.1.sends.reverb'));
});

test('applying a space preset → one grouped patch.fx.reverb entry; an echo preset → one patch.fx.delay', () => {
  const hall = SPACE_PRESETS.find((p) => p.id === 'cathedral');
  const dotted = ECHO_PRESETS.find((p) => p.id === 'dotted');
  const { s, b } = edit((s) => {
    applyPreset(hall, (path, v) => setPath(s, `patch.${path}`, v));
    applyPreset(dotted, (path, v) => setPath(s, `patch.${path}`, v));
  });
  assert.deepEqual([...changedPaths(s, b)], ['patch.fx.reverb', 'patch.fx.delay']);
});

test('song key, tempo, swell time and drone switches are watched; a drone source change counts', () => {
  const { s, b } = edit((s) => {
    s.hearIn = (s.hearIn + 5) % 12;
    s.minor = !s.minor;
    s.tempo = 96;
    s.patch.swell.seconds = 4;
    s.drone.chordFollow = !s.drone.chordFollow;
    s.drone.mode = 'files';
  });
  const got = changedPaths(s, b);
  for (const p of ['hearIn', 'minor', 'tempo', 'patch.swell.seconds', 'drone.chordFollow', 'drone.mode']) {
    assert.ok(got.has(p), `${p} counted`);
  }
  assert.equal(got.size, 6);
});

test('reverting (copying the snapshot back) → an empty set', () => {
  const { s, b } = edit((s) => {
    s.patch.slots[0].octave = 2;
    s.patch.fx.reverb.size = 0.9;
  });
  assert.equal(changedCount(s, b), 2);
  for (const k of ['patch', 'drone', 'tempo', 'hearIn', 'playIn', 'transposeOctave', 'minor'])
    s[k] = structuredClone(b[k]);
  assert.equal(changedCount(s, b), 0);
});

test('tolerates float noise and missing sides', () => {
  const { s, b } = edit((s) => {
    s.patch.slots[0].sends.reverb += 1e-9;
  });
  assert.equal(changedCount(s, b), 0);
  assert.equal(changedCount(null, b), 0);
  assert.equal(changedCount(s, undefined), 0);
  assert.ok(sameValue({ a: 1, b: undefined }, { a: 1 }));
  assert.ok(!sameValue([1, 2], { 0: 1, 1: 2 }));
});

test('empty slots (null) and a custom watch list', () => {
  const { s, b } = edit((s) => {
    s.patch.slots[3] = s.patch.slots[3] || null;
    s.tempo = 120;
  });
  assert.deepEqual([...changedPaths(s, b, ['tempo'])], ['tempo']);
  assert.ok(Object.isFrozen(DIFF_WATCH));
  assert.ok(!DIFF_WATCH.some((p) => /muted|gain/.test(p)), 'no mute or gain paths in the watch list');
});

test('droneOnMode: the snapshot source when it had one, else Synth', () => {
  assert.equal(droneOnMode({ drone: { mode: 'files' } }), 'files');
  assert.equal(droneOnMode({ drone: { mode: 'synth' } }), 'synth');
  assert.equal(droneOnMode({ drone: { mode: 'off' } }), 'synth');
  assert.equal(droneOnMode(null), 'synth');
});
