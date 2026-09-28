// shared/smart-controls.js (H-v2 sound panel; views/edit/CONTRACT.md §6 "slot" → THE SOUND ITSELF).
// "Every listInstruments() entry gets 3 sliders bound to valid paths": the entries are rebuilt here from the same
// metadata the engine registry merges (synth.js / organ.js / synth-extra.js PATCHES/PRESETS, the sample manifest via
// sampler.normalizeManifest, a My Samples pack, and the built-in fallback synth's param shape).
// Run: node --test test/unit/shared/smart-controls.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  smartSlidersFor, slotPath, isValidSpec, wordFor, formatSmart, describeSlot, positionOf, rangeWords, sendWords,
  isPadLike,
} from '../../../app/js/shared/smart-controls.js';
import { describe as describeParam, isValidPath } from '../../../app/js/shared/params.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const eng = (f) => import(path.join(ROOT, 'app/js/engine', f));

/** listInstruments()-shaped entries from the engine's metadata modules (hidden ones included: the rule must hold). */
async function allInstruments() {
  const [synth, organ, extra, sampler] = await Promise.all([
    eng('synth.js'), eng('organ.js'), eng('synth-extra.js'), eng('sampler.js'),
  ]);
  const out = [];
  const add = (type, d, group) =>
    out.push({ ref: { type, id: d.id }, name: d.name || d.id, group: d.group || group, params: d.params || [] });
  for (const d of synth.PATCHES) add('synth', d, 'Synth Pads');
  for (const d of extra.PATCHES) add('synth', d, 'Synth Pads');
  for (const d of organ.PRESETS) add('organ', d, 'Organ');
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/samples/manifest.json'), 'utf8'));
  const defs = sampler.normalizeManifest(man, 'http://x/app/samples/manifest.json');
  for (const d of Object.values(defs)) add('sampler', d, 'Piano');
  // a My Samples pack (secondary manifest: user: ids, 'My Samples' group)
  const user = sampler.normalizeManifest(
    { instruments: [{ id: 'my-rhodes', name: 'My Rhodes', layers: [{ files: { C4: 'c4.mp3' } }] }] },
    'http://x/user/manifest.json',
    { idPrefix: 'user:', group: 'My Samples', defaultRelease: sampler.USER_RELEASE_DEFAULT },
  );
  for (const d of Object.values(user)) add('sampler', d, 'My Samples');
  // the fallback synth (instruments.js fallbackParams shape: attack, release, tone, tri, movement)
  out.push({
    ref: { type: 'synth', id: 'warm-pad' }, name: 'Warm Pad', group: 'Synth Pads',
    params: [
      { key: 'attack', min: 0.002, max: 8, default: 1, unit: 's', curve: 'log' },
      { key: 'release', min: 0.02, max: 12, default: 2, unit: 's', curve: 'log' },
      { key: 'tone', min: 0, max: 1, default: 0.5, unit: 'lin', curve: 'lin' },
    ],
  });
  return out;
}

test('every instrument gets exactly 3 sliders, each bound to one valid PARAMS path', async () => {
  const list = await allInstruments();
  assert.ok(list.length > 30, `instrument count ${list.length}`);
  assert.ok(list.some((x) => x.ref.id.startsWith('user:')), 'a My Samples entry is included');
  for (const meta of list) {
    const sl = smartSlidersFor(meta);
    const tag = `${meta.ref.type}:${meta.ref.id}`;
    assert.equal(sl.length, 3, tag);
    assert.deepEqual(sl.map((s) => s.role).slice(0, 2), ['brightness', 'warmth'], tag);
    const paths = sl.map((s) => s.path);
    assert.equal(new Set(paths).size, 3, `${tag}: three different paths ${paths}`);
    for (const s of sl) {
      assert.ok(isValidSpec(s), `${tag}: ${s.path} valid`);
      for (let i = 0; i < 4; i++) assert.ok(isValidPath(slotPath(s, i)), `${tag}: ${slotPath(s, i)}`);
      assert.ok(Number.isFinite(s.min) && Number.isFinite(s.max) && s.max > s.min, `${tag}: ${s.path} range`);
      assert.ok(s.default >= s.min && s.default <= s.max, `${tag}: ${s.path} default in range`);
      if (s.key) {
        const p = meta.params.find((x) => x.key === s.key);
        assert.ok(p, `${tag}: param ${s.key} exists`);
        assert.equal(s.path, `slots.<i>.params.${s.key}`);
        assert.equal(s.min, p.min);
        assert.equal(s.max, p.max);
      } else {
        const e = describeParam(slotPath(s, 0));
        assert.ok(e && !e.dynamic, `${tag}: ${s.path} is a table row`);
        assert.equal(s.default, e.default);
      }
      assert.equal(typeof wordFor(s.role, s.default, s), 'string');
      assert.ok(wordFor(s.role, s.default, s).length > 0, `${tag}: ${s.role} has a word at its default`);
      assert.ok(formatSmart(s, s.default).length > 0);
    }
  }
});

test('mapping rule: cutoff → tone → eq.high; eq.low; Fade-in for pads, else Ring-out; Width last', async () => {
  const list = await allInstruments();
  const by = (id) => list.find((x) => x.ref.id === id);
  const roles = (id) => smartSlidersFor(by(id)).map((s) => `${s.role}=${s.path}`);
  assert.deepEqual(roles('warm-pad'), [
    'brightness=slots.<i>.params.cutoff', 'warmth=slots.<i>.eq.low', 'fadein=slots.<i>.params.attack',
  ]);
  assert.deepEqual(roles('salamander-piano'), [
    'brightness=slots.<i>.params.tone', 'warmth=slots.<i>.eq.low', 'ringout=slots.<i>.params.release',
  ]);
  assert.deepEqual(roles('gospel'), [
    'brightness=slots.<i>.eq.high', 'warmth=slots.<i>.eq.low', 'ringout=slots.<i>.params.release',
  ]);
  assert.deepEqual(roles('sub-bass').slice(2), ['ringout=slots.<i>.params.release']); // Bass group: not pad-like
  // unknown / not loaded yet: strip params only
  assert.deepEqual(smartSlidersFor(null).map((s) => s.path),
    ['slots.<i>.eq.high', 'slots.<i>.eq.low', 'slots.<i>.width']);
  assert.deepEqual(smartSlidersFor({ ref: { type: 'synth', id: 'x' }, params: [] }).map((s) => s.role),
    ['brightness', 'warmth', 'width']);
  // a non-numeric 'cutoff' (enum/bool) is never used as a slider
  const odd = {
    ref: { type: 'synth', id: 'y' }, params: [{ key: 'cutoff', unit: 'enum', enum: ['a', 'b'], default: 'a' }],
  };
  assert.equal(smartSlidersFor(odd)[0].path, 'slots.<i>.eq.high');
  // log only when the range starts above 0
  const cut = smartSlidersFor(by('warm-pad'))[0];
  assert.equal(cut.curve, 'log');
  assert.equal(smartSlidersFor(by('soft-keys'))[0].curve, 'lin');
  assert.equal(isPadLike(by('glass-pad')), true);
  assert.equal(isPadLike(by('bell')), false);
  assert.equal(isPadLike(null), false);
  // bipolar only for the EQ shelves
  assert.deepEqual(smartSlidersFor(by('gospel')).map((s) => s.bipolar), [true, true, false]);
  // hv2-edit-integrate: eq.high / eq.low specs are the EQ's shelves (the view writes them with eq-math shelfWrites)
  assert.deepEqual(smartSlidersFor(by('gospel')).map((s) => s.shelf ?? null), ['high', 'low', null]);
  assert.deepEqual(smartSlidersFor(by('warm-pad')).map((s) => s.shelf ?? null), [null, 'low', null]);
});

test('wordFor buckets', () => {
  const hi = smartSlidersFor(null)[0];
  assert.equal(wordFor('brightness', 0, hi), 'Neutral');
  assert.equal(wordFor('brightness', -7, hi), 'Dark');
  assert.equal(wordFor('brightness', -3, hi), 'Mellow');
  assert.equal(wordFor('brightness', 3, hi), 'Bright');
  assert.equal(wordFor('brightness', 9, hi), 'Very bright');
  const tone = { role: 'brightness', min: 0, max: 1, curve: 'lin', unit: 'lin', default: 1 };
  assert.equal(wordFor('brightness', 1, tone), 'Bright'); // mockup "Bright 100%"
  assert.equal(wordFor('brightness', 0.1, tone), 'Dark');
  assert.equal(wordFor('brightness', 0.3, tone), 'Mellow');
  assert.equal(wordFor('brightness', 0.5, tone), 'Natural');
  assert.equal(wordFor('warmth', 0), 'Neutral'); // mockup "Neutral 0 dB"
  assert.equal(wordFor('warmth', -8), 'Thin');
  assert.equal(wordFor('warmth', -3), 'Lean');
  assert.equal(wordFor('warmth', 4), 'Warm');
  assert.equal(wordFor('warmth', 12), 'Full');
  const rel = { role: 'ringout', default: 0.35 };
  assert.equal(wordFor('ringout', 0.35, rel), 'Natural'); // mockup "Natural 0.35 s"
  assert.equal(wordFor('ringout', 0.1, rel), 'Short');
  assert.equal(wordFor('ringout', 1.5, rel), 'Long');
  assert.equal(wordFor('ringout', 3, rel), 'Very long');
  assert.equal(wordFor('fadein', 0.005), 'Instant');
  assert.equal(wordFor('fadein', 0.1), 'Quick');
  assert.equal(wordFor('fadein', 1.2), 'Gentle');
  assert.equal(wordFor('fadein', 3), 'Slow');
  assert.equal(wordFor('fadein', 6), 'Very slow');
  assert.equal(wordFor('width', 0), 'Mono');
  assert.equal(wordFor('width', 0.5), 'Narrow');
  assert.equal(wordFor('width', 1), 'Normal');
  assert.equal(wordFor('width', 1.4), 'Wide');
  assert.equal(wordFor('brightness', NaN, hi), '');
  assert.equal(wordFor('nope', 1), '');
});

test('formatSmart and positionOf', () => {
  assert.equal(formatSmart({ unit: 'dB' }, 0), '0 dB');
  assert.equal(formatSmart({ unit: 'dB' }, 6), '+6.0 dB');
  assert.equal(formatSmart({ unit: 'dB' }, -2.5), '−2.5 dB');
  assert.equal(formatSmart({ unit: 's' }, 0.35), '0.35 s');
  assert.equal(formatSmart({ unit: 's' }, 0.012), '12 ms');
  assert.equal(formatSmart({ unit: 's' }, 2.5), '2.5 s');
  assert.equal(formatSmart({ unit: 's' }, 12), '12 s');
  assert.equal(formatSmart({ unit: 'Hz' }, 1800), '1.8 kHz');
  assert.equal(formatSmart({ unit: 'Hz' }, 250), '250 Hz');
  assert.equal(formatSmart({ role: 'width', unit: 'lin', min: 0, max: 1.5 }, 0), 'Mono');
  assert.equal(formatSmart({ role: 'width', unit: 'lin', min: 0, max: 1.5 }, 1), '100%');
  assert.equal(formatSmart({ role: 'brightness', unit: 'lin', min: 0, max: 1 }, 1), '100%');
  assert.equal(formatSmart({ role: 'brightness', unit: 'lin', min: 0, max: 2 }, 1), '50%');
  assert.equal(formatSmart({ unit: 's' }, NaN), '—');
  const log = { min: 200, max: 14000, curve: 'log' };
  assert.ok(Math.abs(positionOf(log, 200)) < 1e-12);
  assert.ok(Math.abs(positionOf(log, 14000) - 1) < 1e-12);
  assert.ok(Math.abs(positionOf(log, Math.sqrt(200 * 14000)) - 0.5) < 1e-9);
  assert.equal(positionOf({ min: -12, max: 12, curve: 'lin' }, 0), 0.5);
  assert.equal(positionOf({ min: 0, max: 1 }, 5), 1); // clamped
});

test('describeSlot: sentence parts, keys and changed flags', () => {
  const slot = {
    instrument: { type: 'sampler', id: 'salamander-piano' }, lowNote: 0, highNote: 127, octave: 1,
    sends: { reverb: 0.25, delay: 0.1, chorus: 0 }, sustain: true,
  };
  const parts = describeSlot(slot, { name: 'Grand Piano (Salamander)' }, {
    role: 'Keys', name: 'Grand Piano', spaceName: 'Hall', isChanged: (f) => f === 'octave',
  });
  const text = parts.map((p) => (typeof p === 'string' ? p : p.text)).join('');
  assert.equal(text, 'KEYS plays Grand Piano on every key, an octave up, a little into the Hall, sustain on');
  assert.deepEqual(parts[0], { text: 'KEYS', role: true });
  const tok = (k) => parts.find((p) => p && p.key === k);
  assert.equal(tok('instrument').text, 'Grand Piano');
  assert.equal(tok('octave').changed, true);
  assert.equal(tok('reverb').changed, false);
  assert.equal(tok('range').changed, undefined, 'range is not a watched path: no dot');
  // muted, split, no octave, dry, sustain off, meta name
  const slot2 = { ...slot, muted: true, lowNote: 48, highNote: 72, octave: 0, sends: { reverb: 0 }, sustain: false };
  const p2 = describeSlot(slot2, { name: 'Warm Pad' }, { role: 'pad' });
  const t2 = p2.map((p) => (typeof p === 'string' ? p : p.text)).join('');
  assert.equal(t2, 'PAD is switched off, but plays Warm Pad on C3 to C5, dry, sustain off');
  assert.ok(p2.some((p) => p.key === 'muted'));
  // missing instrument, deep send, default space name, octave down
  const p3 = describeSlot({ ...slot, octave: -2, sends: { reverb: 0.9 } }, null, { role: 'bass' });
  const t3 = p3.map((p) => (typeof p === 'string' ? p : p.text)).join('');
  assert.equal(t3,
    'BASS plays salamander-piano (not available) on every key, two octaves down, deep into the Space, sustain on');
  // empty slot
  const p4 = describeSlot(null, null, { role: 'Extra' });
  assert.equal(p4.map((p) => (typeof p === 'string' ? p : p.text)).join(''), 'EXTRA is empty. Add a sound');
  assert.equal(p4[2].key, 'instrument');
});

test('rangeWords and sendWords', () => {
  assert.equal(rangeWords({ lowNote: 0, highNote: 127 }), 'every key');
  assert.equal(rangeWords({ lowNote: 0, highNote: 59 }), 'keys up to B3');
  assert.equal(rangeWords({ lowNote: 60, highNote: 127 }), 'keys from C4 up');
  assert.equal(rangeWords({ lowNote: 48, highNote: 72 }), 'C3 to C5');
  assert.equal(sendWords(0), '');
  assert.equal(sendWords(0.25), 'a little');
  assert.equal(sendWords(0.5), 'well');
  assert.equal(sendWords(0.75), 'deep');
});
