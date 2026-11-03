// v11-polish: per-theme voice strings (shared/voice.js) and Daylight's light switch (shared/themes.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { VOICES, VOICE_KEYS, voiceOf, voiceText } from '../../../app/js/shared/voice.js';
import {
  THEMES, effectiveThemeId, lightSiblings, LIGHT_AUTO_KEY, DEFAULT_THEME_ID,
} from '../../../app/js/shared/themes.js';

test('every registered theme has a voice; unknown ids speak Classic', () => {
  for (const t of THEMES) assert.ok(VOICES[voiceOf(t.id)], t.id);
  assert.equal(voiceOf('classic'), 'classic');
  assert.equal(voiceOf('nave'), 'sanctuary', 'Nave = Sanctuary v1 §5, which v2 §6.3 adopted');
  assert.equal(voiceOf('daylight-day'), voiceOf('daylight-stage'));
  assert.equal(voiceOf('nope'), 'classic');
  assert.equal(voiceOf(undefined), 'classic');
});

test('Classic is the app word for word (the strings the pinned suites assert)', () => {
  assert.equal(voiceText('classic', 'ready'), 'Ready');
  assert.equal(voiceText('classic', 'loading', { done: 3, total: 11 }), 'Loading 3/11');
  assert.equal(voiceText('classic', 'loading', {}), 'Loading…');
  assert.equal(voiceText('classic', 'midiBlocked'), 'Blocked');
  assert.equal(voiceText('classic', 'midiDenied'), 'MIDI was blocked — allow it in the browser’s site settings.');
  assert.equal(voiceText('classic', 'fadedChip'), 'Faded — play to resume');
  assert.equal(voiceText('classic', 'revertNone'), 'nothing changed');
  assert.equal(voiceText('classic', 'editFoot'), 'No switch changes since the song was loaded');
  assert.equal(voiceText('classic', 'emptySlot'), ' · empty');
  assert.equal(voiceText('classic', 'setEnd'), null, 'no end-of-set line in Classic');
  assert.equal(voiceText('classic', 'overlayTitle'), 'Click anywhere to start audio');
});

test('each direction speaks its concept table', () => {
  assert.equal(voiceText('sanctuary', 'loading', { done: 15, total: 19 }), 'Preparing 15 of 19');
  assert.equal(voiceText('sanctuary', 'ready', { total: 19 }), 'All 19 ready');
  assert.equal(voiceText('sanctuary', 'nextCap'), 'Up next');
  assert.equal(voiceText('sanctuary-day', 'setEnd'), 'That’s the set. Thank you for serving.');
  assert.equal(voiceText('ember', 'fadedChip'), 'Resting. Play to bring it back.');
  assert.equal(voiceText('ember', 'revertNone'), 'as saved');
  assert.equal(voiceText('studio', 'loading', { done: 15, total: 19 }), 'Warming up · 15 of 19');
  assert.equal(voiceText('studio', 'quickRestart'), 'Hold to restart the sound');
  assert.equal(voiceText('daylight-day', 'prevStart'), 'Start of set');
  assert.equal(voiceText('daylight-stage', 'midiNoDevice'), 'Not plugged in');
  for (const id of ['sanctuary', 'ember', 'studio', 'daylight-day', 'nave']) {
    assert.equal(voiceText(id, 'emptySlot'), ' · add a sound', `${id}: "Extra · add a sound"`);
  }
});

test('a key a voice leaves out falls back to Classic; an unknown key throws', () => {
  assert.equal(voiceText('studio', 'nextCap'), 'Next');
  assert.equal(voiceText('daylight-day', 'setEnd'), null);
  assert.throws(() => voiceText('classic', 'noSuchKey'), /unknown key/);
  for (const v of Object.values(VOICES)) {
    for (const k of Object.keys(v)) assert.ok(VOICE_KEYS.includes(k), `${k} is a Classic key`);
  }
});

test('voices stay plain: no "!" and no "Oops" (Ember §5, Sanctuary §5 rules)', () => {
  for (const [id, v] of Object.entries(VOICES)) {
    for (const k of Object.keys(v)) {
      const s = voiceText(id === 'classic' ? 'classic' : THEMES.find((t) => voiceOf(t.id) === id).id, k,
        { done: 1, total: 2 }) || '';
      assert.ok(!/!|oops/i.test(s), `${id}.${k}: ${s}`);
    }
  }
});

test('light switch: only Daylight has it; Lock forces Stage; Auto follows the Mac', () => {
  assert.deepEqual(lightSiblings('daylight-day'), { dark: 'daylight-stage', light: 'daylight-day' });
  assert.equal(lightSiblings('sanctuary'), null);
  assert.equal(lightSiblings('classic'), null);
  assert.equal(effectiveThemeId('daylight-day'), 'daylight-day');
  assert.equal(effectiveThemeId('daylight-day', { locked: true }), 'daylight-stage');
  assert.equal(effectiveThemeId('daylight-stage', { auto: true, osLight: true }), 'daylight-day');
  assert.equal(effectiveThemeId('daylight-day', { auto: true, osLight: false }), 'daylight-stage');
  assert.equal(effectiveThemeId('daylight-day', { auto: true, osLight: true, locked: true }), 'daylight-stage');
  assert.equal(effectiveThemeId('sanctuary-day', { locked: true }), 'sanctuary-day', 'no switch, no change');
  assert.equal(effectiveThemeId('nope'), DEFAULT_THEME_ID);
});

test('boot.js reads the same Auto key and applies it before first paint', () => {
  const src = fs.readFileSync(new URL('../../../app/themes/boot.js', import.meta.url), 'utf8');
  assert.ok(src.includes(`'${LIGHT_AUTO_KEY}'`), 'boot.js uses LIGHT_AUTO_KEY');
  assert.match(src, /prefers-color-scheme: light/);
});
