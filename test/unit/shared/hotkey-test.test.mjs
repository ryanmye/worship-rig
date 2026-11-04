// v11-hotkey-test (L11-3 follow-up): the press-to-test state machine Settings › Menu bar runs (shared/hotkeys.js
// hotkeyTestStep). The view holds the timer and sends 'timeout'; main reports the press ('fired').
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOTKEY_TEST_MS, hotkeyTestInit, hotkeyTestStep, hotkeyTestPhase, DEFAULT_HOTKEYS,
} from '../../../app/js/shared/hotkeys.js';
import { voiceText } from '../../../app/js/shared/voice.js';

const NEXT = DEFAULT_HOTKEYS.nextSong;
const PREV = DEFAULT_HOTKEYS.prevSong;
const step = (s, ...evs) => evs.reduce(hotkeyTestStep, s);

test('the wait is 5 s', () => {
  assert.equal(HOTKEY_TEST_MS, 5000);
});

test('start → testing; the press main reports → works; nothing is running afterwards', () => {
  const s0 = hotkeyTestInit();
  assert.equal(hotkeyTestPhase(s0, 'nextSong', NEXT), null, 'quiet until someone tests');
  const s1 = step(s0, { type: 'start', id: 'nextSong', accelerator: NEXT });
  assert.equal(hotkeyTestPhase(s1, 'nextSong', NEXT), 'testing');
  assert.equal(s1.active.id, 'nextSong');
  assert.equal(s0.active, null, 'pure: the old state is untouched');
  const s2 = step(s1, { type: 'fired', id: 'nextSong' });
  assert.equal(hotkeyTestPhase(s2, 'nextSong', NEXT), 'works');
  assert.equal(s2.active, null);
  // the timer that was running for it no longer counts
  assert.equal(step(s2, { type: 'timeout', token: s1.active.token }), s2);
  // a second press after the test has ended changes nothing
  assert.equal(step(s2, { type: 'fired', id: 'nextSong' }), s2);
});

test('no press before the timer → nothing came through', () => {
  const s1 = step(hotkeyTestInit(), { type: 'start', id: 'panic', accelerator: DEFAULT_HOTKEYS.panic });
  const s2 = step(s1, { type: 'timeout', token: s1.active.token });
  assert.equal(hotkeyTestPhase(s2, 'panic', DEFAULT_HOTKEYS.panic), 'nothing');
  assert.equal(s2.active, null);
  // a press that arrives too late doesn't turn it into "Works"
  assert.equal(hotkeyTestPhase(step(s2, { type: 'fired', id: 'panic' }), 'panic', DEFAULT_HOTKEYS.panic), 'nothing');
});

test('cancel (Esc, recording, closing Settings) ends the test with no result', () => {
  const s1 = step(hotkeyTestInit(), { type: 'start', id: 'nextSong', accelerator: NEXT });
  const s2 = step(s1, { type: 'cancel' });
  assert.equal(s2.active, null);
  assert.equal(hotkeyTestPhase(s2, 'nextSong', NEXT), null);
  assert.equal(step(s2, { type: 'timeout', token: s1.active.token }), s2, 'its timer is ignored');
  assert.equal(step(s2, { type: 'fired', id: 'nextSong' }), s2, 'a press after the cancel is ignored');
  assert.equal(step(s2, { type: 'cancel' }), s2, 'nothing to cancel');
});

test('one test at a time: a second test replaces the first (its result goes, its timer stops counting)', () => {
  const works = step(hotkeyTestInit(), { type: 'start', id: 'masterUp', accelerator: DEFAULT_HOTKEYS.masterUp },
    { type: 'fired', id: 'masterUp' });
  const s1 = step(works, { type: 'start', id: 'nextSong', accelerator: NEXT });
  const s2 = step(s1, { type: 'start', id: 'prevSong', accelerator: PREV });
  assert.equal(s2.active.id, 'prevSong');
  assert.equal(hotkeyTestPhase(s2, 'nextSong', NEXT), null, 'the replaced test shows nothing');
  assert.equal(hotkeyTestPhase(s2, 'prevSong', PREV), 'testing');
  assert.equal(hotkeyTestPhase(s2, 'masterUp', DEFAULT_HOTKEYS.masterUp), 'works', 'finished results stay');
  assert.equal(step(s2, { type: 'timeout', token: s1.active.token }), s2, 'the first test\'s timer is ignored');
  assert.equal(step(s2, { type: 'fired', id: 'nextSong' }), s2, 'a press of the first one is ignored');
  // restarting the same row: a new token, so the old timer can't end the new test
  const s3 = step(s2, { type: 'start', id: 'prevSong', accelerator: PREV });
  assert.notEqual(s3.active.token, s2.active.token);
  assert.equal(step(s3, { type: 'timeout', token: s2.active.token }), s3);
  assert.equal(hotkeyTestPhase(step(s3, { type: 'timeout', token: s3.active.token }), 'prevSong', PREV), 'nothing');
});

test('a result only counts for the combination it was tested with', () => {
  const s = step(hotkeyTestInit(), { type: 'start', id: 'nextSong', accelerator: NEXT },
    { type: 'fired', id: 'nextSong' });
  assert.equal(hotkeyTestPhase(s, 'nextSong', NEXT), 'works');
  assert.equal(hotkeyTestPhase(s, 'nextSong', 'Control+Alt+Command+N'), null, 'a new recording starts quiet');
  assert.equal(hotkeyTestPhase(s, 'nextSong', ''), null);
});

test('bad events change nothing', () => {
  const s0 = hotkeyTestInit();
  assert.equal(step(s0, { type: 'start', id: 'formatDisk', accelerator: NEXT }), s0);
  assert.equal(step(s0, { type: 'start', id: 'nextSong', accelerator: '' }), s0, 'no shortcut, nothing to test');
  assert.equal(step(s0, { type: 'start', id: 'nextSong' }), s0);
  assert.equal(step(s0, { type: 'nope' }), s0);
  assert.equal(step(s0, null), s0);
  assert.equal(hotkeyTestStep(undefined, { type: 'start', id: 'nextSong', accelerator: NEXT }).active.id, 'nextSong');
});

test('the words (Classic): the formatted combination, Works, the pick-another hint, the Mac hint', () => {
  assert.equal(voiceText('classic', 'hotkeyTesting', { keys: '⌃⌥⌘]' }), 'Press ⌃⌥⌘] in any app…');
  assert.equal(voiceText('classic', 'hotkeyWorks'), 'Works');
  assert.equal(voiceText('classic', 'hotkeyNothing'), 'Nothing came through. Another app may use this. Pick another.');
  assert.match(voiceText('classic', 'hotkeysMacTakenHint'), /macOS can’t tell apps .*Rectangle.*Test each one once/);
  assert.equal(voiceText('ember', 'hotkeyWorks'), 'Works', 'the other voices say what Classic says');
});
