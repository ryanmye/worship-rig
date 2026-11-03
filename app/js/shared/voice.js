// Voice strings per theme (v11-polish; BACKLOG A "Copy changes"). Pure: no DOM.
//
// Each warmth direction came with its own voice (design/warmth/sanctuary/concept.md §5 for Sanctuary and Nave,
// sanctuary-v2/concept.md §6.3, ember/concept.md §5, studio/concept.md §4, daylight-v2/concept.md §3 / OPTIONS.md
// §3.1 #6). A theme is CSS only, so the words live here: the views ask `voiceText(themeId, key, vars)` and re-render
// when html[data-theme] changes (views/components/voice.js). Classic is today's app word for word (the rollback);
// a voice that has no entry for a key says what Classic says.
//
// Left out on purpose: the default setlist name ("Today's set", Sanctuary #12) is library data the store writes once,
// not chrome a theme can re-word; the Daily hook start screens (not in v1.1).

/**
 * @typedef {string|((vars: Record<string, any>) => string|null)} VoiceEntry
 * A string, or a function of the call's vars; null means "fall back to Classic".
 */

/** @type {Readonly<Record<string, VoiceEntry>>} Classic = the app's words before v11 */
const CLASSIC = Object.freeze({
  overlayTitle: 'Click anywhere to start audio',
  overlaySub: 'Your browser needs one click before it can play sound.',
  loading: ({ done, total }) => (total ? `Loading ${done}/${total}` : 'Loading…'),
  ready: 'Ready',
  midiNoDevice: 'No device',
  midiBlocked: 'Blocked',
  midiDenied: 'MIDI was blocked — allow it in the browser’s site settings.',
  midiPrompt: 'Chrome will ask to use your MIDI devices — click “Allow”.',
  audioStopped: 'Sound stopped — click “Restart sound”.',
  fadedChip: 'Faded — play to resume',
  fadedButton: 'Faded — play to resume',
  // after Fade out on the last song of a setlist; null = the plain faded chip
  setEnd: () => null,
  nextCap: 'Next',
  prevStart: '◀ Prev',
  notesEmpty: 'No notes for this song. Add some in Edit.',
  padsNone: 'My Pads: no folder chosen',
  revertNone: 'nothing changed',
  emptySlot: ' · empty',
  quickSub: 'Changes apply now. Keep playing.',
  quickPedalHint: 'press it: the light comes on',
  quickRestart: 'Hold to restart audio',
  editFoot: 'No switch changes since the song was loaded',
  editHint: 'Pick a part to edit it. The dot on a tab means a switch changed since the song was loaded.',
  editStripFoot: 'Same switches, same colours as your Perform strip',
  // v11-metronome: Perform's click chip
  clickOff: 'Click',
  clickOn: 'Click on',
  clickCounting: 'Count-in',
  clickTitle: 'Start or stop the click at this song’s tempo (count-in and level: Edit › Song)',
  // v11-scenes: saved levels per song (Perform's scene numbers, Quick › This song, Edit › Song)
  sceneOwn: 'Scenes: playing the song’s own levels',
  sceneLabel: ({ n }) => `Scene ${n}`,
  sceneBack: 'Playing. Tap to go back to the song’s own levels',
  sceneSaveCap: 'Save as scene',
  sceneSaveTitle: ({ n }) => `Save what you hear now (levels, ON switches, drone level, wheel) as scene ${n}`,
  sceneSaved: ({ n }) => `Saved as scene ${n}. A footswitch or the scene numbers step through them.`,
  sceneEditHint: 'Up to 3 saved sets of levels for this song: faders, ON switches, the drone level and the wheel. '
    + 'The song always starts on its own levels; step through the scenes with a footswitch (Settings › MIDI › '
    + 'Next scene), the numbers in Perform, or a hotkey. A change glides, held notes keep sounding.',
  sceneEditSub: 'Saved levels to step through while you play. The song always starts on its own levels.',
  scenePlaying: 'playing',
  sceneNone: 'No scenes yet.',
});

/** Sanctuary v1 §5 (Nave) = what Sanctuary v2 §6.3 asks for: a verger who likes you. */
const SANCTUARY = Object.freeze({
  overlayTitle: 'Before the service',
  overlaySub: 'Your browser asks for one tap before it can play.',
  loading: ({ done, total }) => (total ? `Preparing ${done} of ${total}` : 'Preparing…'),
  ready: ({ total }) => (total ? `All ${total} ready` : 'All ready'),
  midiBlocked: 'Not allowed yet',
  midiDenied: 'Keyboard not allowed yet. Allow MIDI in the browser’s site settings.',
  fadedChip: 'Faded out. Play to bring it back.',
  fadedButton: 'Faded out',
  setEnd: () => 'That’s the set. Thank you for serving.',
  nextCap: 'Up next',
  notesEmpty: 'Nothing written for this song yet. Add a note in Edit.',
  padsNone: 'No pad folder yet. The built-in drone is playing.',
  editFoot: 'Just as the song began',
  editHint: 'Choose a part to shape it. A dot means it has moved since the song began.',
  emptySlot: ' · add a sound',
});

/** Ember §5: a friendly stagehand, not telemetry. */
const EMBER = Object.freeze({
  overlayTitle: 'Tap anywhere to light the room.',
  overlaySub: 'Your browser needs one tap before it can make sound.',
  loading: ({ done, total }) => (total ? `Warming up · ${done} of ${total}` : 'Warming up…'),
  ready: 'Ready to play',
  midiBlocked: 'Not allowed yet',
  midiDenied: 'Your keyboard isn’t allowed yet. Allow MIDI in site settings.',
  fadedChip: 'Resting. Play to bring it back.',
  fadedButton: 'Resting',
  setEnd: () => 'That’s the set. Thanks for serving.',
  padsNone: 'No pad folder yet. Songs use the built-in drone.',
  revertNone: 'as saved',
  emptySlot: ' · add a sound',
  quickSub: 'Changes are live. Keep playing.',
  editFoot: 'Just as you saved it',
});

/** Studio §4: the engineer who's on your side. */
const STUDIO = Object.freeze({
  overlayTitle: 'Start the session',
  loading: ({ done, total }) => (total ? `Warming up · ${done} of ${total}` : 'Warming up…'),
  ready: 'All sounds ready',
  midiBlocked: 'Not allowed yet',
  midiDenied: 'Your keyboard is blocked. Allow MIDI in Chrome’s site settings, then come back.',
  midiPrompt: 'Chrome’s about to ask about your keyboard. Say Allow.',
  setEnd: () => 'That’s a wrap.',
  padsNone: 'No pad folder yet. Songs use the built-in drone.',
  revertNone: 'As saved',
  emptySlot: ' · add a sound',
  quickPedalHint: 'Press the pedal. Does its lamp light?',
  quickRestart: 'Hold to restart the sound',
  editFoot: 'Just as you saved it',
  editHint: 'Pick a channel to work on. A dot means you’ve moved something since loading.',
  editStripFoot: 'Same channel as on your Perform page',
});

/** Daylight v2 §3 / OPTIONS §3.1 #6 (the strings its CSS bridge used to fake). */
const DAYLIGHT = Object.freeze({
  overlayTitle: 'Tap anywhere to wake the sound.',
  loading: 'Warming up…', // the setlist chips already spin per song (concept §3)
  ready: 'Ready to play',
  midiNoDevice: 'Not plugged in',
  midiBlocked: 'Not allowed yet',
  midiDenied: 'The keyboard is blocked. Allow MIDI in the browser’s site settings, then plug it in again.',
  audioStopped: 'The sound stopped.',
  fadedChip: 'Faded. Play to bring it back.',
  fadedButton: 'Faded',
  prevStart: 'Start of set',
  padsNone: 'No pad folder yet. Songs use the built-in drone.',
  revertNone: 'As saved',
  emptySlot: ' · add a sound',
  editFoot: 'Just as you saved it',
  editHint: 'Pick a part to shape it. A dot means you changed something since the song loaded.',
});

/** voice id → table. Theme ids map to a voice by their registry family (shared/themes.js). */
export const VOICES = Object.freeze({
  classic: CLASSIC, sanctuary: SANCTUARY, ember: EMBER, studio: STUDIO, daylight: DAYLIGHT,
});

/** theme id → voice id. Nave (the v1 Sanctuary) speaks Sanctuary's v1 §5 voice, which v2 §6.3 adopted. */
const THEME_VOICE = Object.freeze({
  classic: 'classic',
  sanctuary: 'sanctuary',
  'sanctuary-day': 'sanctuary',
  nave: 'sanctuary',
  'daylight-stage': 'daylight',
  'daylight-day': 'daylight',
  studio: 'studio',
  ember: 'ember',
});

/** Every key a view may ask for (Classic has them all). */
export const VOICE_KEYS = Object.freeze(Object.keys(CLASSIC));

/**
 * @param {unknown} themeId html[data-theme] (unknown / absent → Classic's words)
 * @returns {string} the voice id
 */
export function voiceOf(themeId) {
  return (typeof themeId === 'string' && THEME_VOICE[themeId]) || 'classic';
}

const render = (entry, vars) => (typeof entry === 'function' ? entry(vars || {}) : entry);

/**
 * The words theme `themeId` uses for `key`.
 * @param {unknown} themeId
 * @param {string} key one of VOICE_KEYS
 * @param {Record<string, any>} [vars] e.g. {done, total} for 'loading'
 * @returns {string|null} null only for an optional line (setEnd) that this voice and Classic both leave out
 */
export function voiceText(themeId, key, vars) {
  const v = VOICES[voiceOf(themeId)];
  if (Object.prototype.hasOwnProperty.call(v, key)) {
    const out = render(v[key], vars);
    if (out !== null && out !== undefined) return out;
  }
  if (!Object.prototype.hasOwnProperty.call(CLASSIC, key)) throw new Error(`voice: unknown key ${key}`);
  const out = render(CLASSIC[key], vars);
  return out === undefined ? null : out;
}
