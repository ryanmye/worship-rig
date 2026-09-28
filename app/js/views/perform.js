// Perform view (SPEC §10, §13; reviews/ux.md; design/H-v2). Built once; every update patches the DOM in place from
// store.subscribe / controller events (no re-render on song switch).
// Writes: store.set(...) for persisted song/settings values, controller.* for transient actions.
//
// H-v2 layout (design/H-v2/perform.png): song header (KEY ▾ → "Sing it in…"), Transpose, one-tap Space / Echo chips,
// Chord; setlist row with Prev / Next; Wheel · four strips (ON tile = the mute, fader, Space · Echo · Octave · Sustain
// chips) · Key & drone (the same ON tile) · Notes; keyboard with range bars · Revert (hold) · Fade out · PANIC · Lock.
// A white dot marks what changed since the song was loaded (shared/song-diff.js); Revert counts the dots.
//
// Lock rule (H-v2 concept §1.3, OK'd by Ryan; the LOCK table below): playing stays live, the song key and Revert need
// a 600 ms hold, soundcheck settings are frozen.
import { keyName, transposeSemis, mod12 } from '../shared/music.js';
import { transposeSemisOf } from '../store.js';
import { ROLE_DEFAULTS, SLOT_COUNT, isValidPath, formatValue } from '../shared/params.js';
import { SPACE_PRESETS, ECHO_PRESETS, VIBE_PRESETS, matchPreset } from '../shared/fx-presets.js';
import { changedPaths, hasChange, droneOnMode, sameValue } from '../shared/song-diff.js';
import { h, setText, disposer, blurAfterPointer, rafCoalesce } from './components/util.js';
import { fader } from './components/fader.js';
import { toggle, segmented } from './components/buttons.js';
import { keyGrid, pianoKeyboard, keyLayout } from './components/keys.js';
import { chordReadout, wheelStrip } from './components/readouts.js';
import { setlistStrip } from './components/setlist.js';
import { stageName, groupOf } from './components/instrument-groups.js';
import { onTile } from './components/onTile.js';
import { stepChip, AMOUNT_STEPS, OCTAVE_STEPS, SUSTAIN_STEPS, formatAmount, formatOctave } from './components/stepChip.js';
import { headerChipRow, SPACE_CHIPS, SPACE_MORE, ECHO_CHIPS, SONG_OWN } from './components/headerChipRow.js';
import { holdButton } from './components/holdButton.js';
import { quickSheet } from './components/quickSheet.js';
import { openOverlay } from './components/overlay.js';

const lerp = (a, b, x) => a + (b - a) * x;
const MINUS = '−';
const HOLD_MS = 600;
const PEDAL_STUCK_MS = 20000;
const humanize = (id) => String(id || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `${MINUS}${-n}` : '0');

/**
 * What each Perform control does while Perform lock is on (H-v2 concept §1.3; OPTIONS.md decision 2, OK'd).
 * live: works as unlocked · hold: needs a 600 ms press-and-hold (amber HOLD tag) · frozen: disabled.
 * Revert needs the hold whether locked or not (OPTIONS.md round-3 fix 2).
 */
export const LOCK = Object.freeze({
  live: Object.freeze([
    'slot faders', 'ON tiles', 'drone ON tile', 'drone level', 'wheel', 'Swell', 'strip chips', 'header Space / Echo',
    'Quick › This song', 'Quick › restart audio', 'Prev / Next / setlist tap', 'Fade out', 'PANIC',
  ]),
  hold: Object.freeze(['KEY ▾ Sing it in…', 'Transpose −/+', 'drone key grid', 'Major / Minor', 'Revert']),
  frozen: Object.freeze([
    'Edit', 'Settings', 'drone Synth / My Pads', 'Brightness', 'Movement', 'Follow chords', 'Continue across songs',
    'pad folder', 'setlist reorder', 'Quick › This Mac',
  ]),
});

/** Wheel target → short label. */
export function wheelTargetLabel(target) {
  const m = /^slots\.(\d)\.gain$/.exec(target || '');
  if (m) return `${ROLE_DEFAULTS[Number(m[1])]?.name || `Slot ${Number(m[1]) + 1}`} level`;
  return (
    {
      'drone.gain': 'Drone',
      'fx.reverb.returnGain': 'Reverb',
      'master.volume': 'Master',
      'macro.intensity': 'Intensity',
      'macro.wash': 'Wash',
      none: 'Nothing',
    }[target] || ''
  );
}

/**
 * Effective multiplier the wheels apply to slot i (mirrors engine._factorFor + macro.intensity on slot 1).
 * @returns {number|null} null when no wheel routes to this slot
 */
export function slotWheelFactor(patch, i, w) {
  if (!patch) return null;
  const t = `slots.${i}.gain`;
  let f = 1;
  let routed = false;
  const mw = patch.modWheel || {};
  const ex = patch.expression || {};
  if (mw.target === t) {
    f *= lerp(mw.min ?? 0, mw.max ?? 1, w.mod);
    routed = true;
  }
  if (ex.target === t) {
    f *= lerp(ex.min ?? 0, ex.max ?? 1, w.expr);
    routed = true;
  }
  if (patch.volume?.target === t) {
    f *= w.vol;
    routed = true;
  }
  if (i === 1) {
    let I = null;
    if (mw.target === 'macro.intensity') I = lerp(mw.min ?? 0, mw.max ?? 1, w.mod);
    if (ex.target === 'macro.intensity') I = (I ?? 1) * lerp(ex.min ?? 0, ex.max ?? 1, w.expr);
    if (I !== null) {
      f *= lerp(0.35, 1, I);
      routed = true;
    }
  }
  return routed ? f : null;
}

/** Slot mute state: first-class `muted` (store), falling back to the old gain 0 + mutedGain convention. */
export function slotMuteState(slot) {
  if (!slot) return { muted: false, level: null };
  const before = Number.isFinite(slot.gainBeforeMute) ? slot.gainBeforeMute : Number.isFinite(slot.mutedGain) ? slot.mutedGain : null;
  const muted = slot.muted === true || (slot.muted === undefined && slot.gain === 0 && before !== null);
  return { muted, level: muted ? (before ?? 0) : slot.gain };
}

/** Song fields a "Revert to saved" restores (what Perform can change). */
// same fields as controller.revertSong() (shell-3 §2); tempo and swell time also change from Quick (H-v2)
const SAVED_FIELDS = ['patch', 'drone', 'tempo', 'hearIn', 'playIn', 'transposeOctave', 'minor'];
const savedJSON = (s) => (s ? JSON.stringify(SAVED_FIELDS.map((k) => s[k])) : '');
/** The song key is one change for Revert's count, though a key tap writes hearIn + playIn (or + transposeOctave). */
const KEY_PATHS = new Set(['hearIn', 'playIn', 'transposeOctave']);
/** "↺ Revert · ● n changed": changed paths (shared/song-diff.js), the key counted once. */
export const changeCount = (paths) => new Set([...paths].map((p) => (KEY_PATHS.has(p) ? 'key' : p))).size;

/** Current value of an FX preset path ('fx.<unit>.<key>' / 'master.<key>') in a song. */
export function songFxValue(song, path) {
  if (!song) return undefined;
  const [a, b, c] = String(path).split('.');
  if (a === 'fx') return song.patch?.fx?.[b]?.[c];
  if (a === 'master') return song.patch?.fx?.master?.[b];
  return undefined;
}

/**
 * The transpose step that makes the band hear `pc` while the hands stay in the song's Play-In key ("Sing it in…"):
 * the nearest shift in −6…+5 semitones (H implementation §2: D → G = +5, D → B = −3).
 * @param {number} playIn  0..11
 * @param {number} pc      0..11, the key the band should hear
 * @returns {number} semitones, −6..+5
 */
export function singItInShift(playIn, pc) {
  return mod12(pc - playIn + 6) - 6;
}

/** Words for the drone's two character sliders (display only; the value is the PARAMS number). */
const brightnessWord = (v) => (v < 0.25 ? 'Dark' : v < 0.55 ? 'Soft' : v < 0.8 ? 'Clear' : 'Bright');
const movementWord = (v) => (v < 0.1 ? 'Still' : v < 0.45 ? 'Gentle' : v < 0.75 ? 'Moving' : 'Restless');

// ---------------------------------------------------------------------------------------------- icons (24×24 stroke)
const ICONS = {
  piano: '<path d="M3 21V5.5A2.5 2.5 0 0 1 5.5 3H12c3.6 0 5 3.2 6.6 6 1.4 2.4 2.4 4.2 2.4 7v5H3z"/><path d="M3 16.5h18"/><path d="M7 16.5V21M11 16.5V21M15 16.5V21"/>',
  pad: '<path d="M2 10c2.7-4.5 5.3-4.5 8 0s5.3 4.5 8 0c1.3-2.2 2.7-3 4-3"/><path d="M2 16c2.7-4.5 5.3-4.5 8 0s5.3 4.5 8 0c1.3-2.2 2.7-3 4-3" opacity=".55"/>',
  bass: '<path d="M2 12c2.4-8 5.6-8 8 0s5.6 8 8 0" stroke-width="2.6"/><path d="M19 12h3"/>',
  wave: '<path d="M2 12h3l2-6 3 12 3-9 2 5 2-2h5"/>',
  room: '<path d="M3.5 20V11a8.5 8.5 0 0 1 17 0v9"/><path d="M8 20v-8a4 4 0 0 1 8 0v8"/><path d="M2 20h20"/>',
  echo: '<circle cx="5.5" cy="12" r="3"/><circle cx="12.5" cy="12" r="2.2" opacity=".72"/><circle cx="18.5" cy="12" r="1.5" opacity=".45"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  note: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 11h7M9 15h7M9 7h4"/>',
};
/** Inline stroke icon (static markup from the table above, never user data). */
function icon(name, size = 20) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ class: `ic ic-${name}`, width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.9', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, String(v));
  s.innerHTML = ICONS[name] || '';
  return s;
}
const GROUP_ICON = { Piano: 'piano', 'Electric Piano': 'piano', Organ: 'piano', 'Synth Keys': 'piano', 'Mallets & Bells': 'piano', 'Synth Pads': 'pad', Bass: 'bass' };

/**
 * Press-and-hold gate for a group of plain buttons (the drone key grid, Major/Minor) while locked: a tap does nothing
 * and shows the hint; a 600 ms hold runs `run(button)`. Unlocked, the buttons work as usual (the gate is off).
 * The progress is the `--hold` custom property on the held button (0..1), like holdButton().
 */
function holdGate(root, { selector, ms = HOLD_MS, enabled, run, onHint, d }) {
  let timer = null;
  let raf = 0;
  let btn = null;
  let t0 = 0;
  let key = null;
  let doneUntil = 0;
  const stop = () => {
    clearTimeout(timer);
    timer = null;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (btn) {
      btn.classList.remove('holding');
      btn.style.removeProperty('--hold');
    }
    btn = null;
  };
  const tick = () => {
    raf = 0;
    if (!timer || !btn) return;
    btn.style.setProperty('--hold', Math.min(1, (performance.now() - t0) / ms).toFixed(3));
    raf = requestAnimationFrame(tick);
  };
  const start = (b) => {
    stop();
    btn = b;
    t0 = performance.now();
    b.classList.add('holding');
    timer = setTimeout(() => {
      const target = btn;
      stop();
      doneUntil = performance.now() + 700; // the click that follows the release is not a second (short) press
      run(target);
    }, ms);
    raf = requestAnimationFrame(tick);
  };
  const cancel = (early) => {
    if (!timer) return;
    stop();
    if (early) onHint?.();
  };
  const target = (e) => (e.target instanceof Element ? e.target.closest(selector) : null);
  d.listen(root, 'pointerdown', (e) => {
    const b = target(e);
    if (!b || !enabled() || b.disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault(); // no focus (Space stays the sustain pedal)
    try {
      root.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic */
    }
    start(b);
  }, true);
  d.listen(root, 'pointerup', () => cancel(true), true);
  d.listen(root, 'pointercancel', () => cancel(false), true);
  d.listen(root, 'lostpointercapture', () => cancel(false), true);
  d.listen(root, 'keydown', (e) => {
    if ((e.key !== 'Enter' && e.key !== ' ') || !enabled()) return;
    const b = target(e);
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat && key === null) {
      key = e.key;
      start(b);
    }
  }, true);
  d.listen(root, 'keyup', (e) => {
    if (e.key !== key) return;
    e.preventDefault();
    key = null;
    cancel(true);
  }, true);
  d.listen(root, 'focusout', () => {
    key = null;
    cancel(false);
  });
  d.add(stop);
  return {
    /** A short tap (or an arrow key) reached the control while locked: true when a hold just completed instead. */
    justHeld: () => performance.now() < doneUntil,
  };
}

/**
 * @param {HTMLElement} root
 * @param {{store, controller, engine, midi, recorder, toast, openSettings, closeSettings, setView, quickButton?}} ctx
 * @returns {{el:HTMLElement, savedSnapshot:object|null, toggleQuick():void, openQuick():void, closeQuick():void,
 *            readonly quickOpen:boolean, destroy():void}}
 */
export function mountPerform(root, ctx) {
  const { store, controller, engine, midi } = ctx;
  const d = disposer();
  const comps = [];
  const use = (c) => (comps.push(c), c);
  const btn = (cls, content, attrs = {}) => {
    const b = h(`button.btn${cls}`, { type: 'button', ...attrs }, content);
    blurAfterPointer(b, d);
    return b;
  };
  const isLocked = () => !!store.get().settings.performLock;
  const holdTag = () => h('span.hold-tag', { 'aria-hidden': 'true', text: 'HOLD' });

  // ---------------------------------------------------------------- head: song, key, transpose, effects, chord
  const songName = h('div.song-name', { 'data-testid': 'song-name', text: '—', 'aria-live': 'polite' });
  const songKey = h('b.song-key', { 'data-testid': 'song-key', text: '' });
  const keyBtn = use(
    holdButton({
      content: [songKey, icon('down', 18)],
      ms: HOLD_MS,
      requireHold: isLocked,
      className: 'key-open',
      title: 'Sing it in a different key: the band hears the new key, your hands stay where they are',
      ariaLabel: 'Key: sing it in a different key',
      holdText: 'keep holding… (0.6 s)',
      testid: 'key-button',
      onActivate: () => toggleKeyPop(),
    }),
  );
  keyBtn.el.setAttribute('aria-haspopup', 'true');
  keyBtn.el.setAttribute('aria-expanded', 'false');
  const songPlayIn = h('span.song-playin', { 'data-testid': 'song-playin', hidden: true });
  const songBpm = h('span.song-bpm', { 'data-testid': 'song-bpm', text: '' });
  const songLoading = h('span.song-loading', { role: 'status' }, h('span.song-loading-spin', { 'aria-hidden': 'true' }), h('span', { text: 'Loading…' }));
  const fadedChip = h('span.faded-chip', { hidden: true, role: 'status', 'data-testid': 'faded-chip', text: 'Faded — play to resume' });
  const notesBtn = btn('.notes-btn', [icon('note', 16), 'Notes'], { 'aria-pressed': 'false', 'aria-controls': 'perform-notes', 'data-testid': 'notes-toggle' });
  const songBlock = h(
    'section.panel.song-block',
    { 'aria-label': 'Current song' },
    h('div.song-flags', {}, songLoading),
    songName,
    h('div.song-sub', {}, h('span.song-key-cap', { text: 'Key' }), keyBtn.el, songPlayIn, songBpm, holdTag(), notesBtn),
  );

  const tDown = use(holdButton({ label: MINUS, ms: HOLD_MS, requireHold: isLocked, className: 't-down', ariaLabel: 'Transpose down a semitone', testid: 'transpose-down', onActivate: () => controller.transposeDown() }));
  const tUp = use(holdButton({ label: '+', ms: HOLD_MS, requireHold: isLocked, className: 't-up', ariaLabel: 'Transpose up a semitone', testid: 'transpose-up', onActivate: () => controller.transposeUp() }));
  const tVal = h('b.transpose-val', { 'data-testid': 'transpose-val', text: '0' });
  const transposeBox = h(
    'section.panel.transpose',
    { 'aria-label': 'Transpose' },
    h('div.transpose-head', {}, h('span.section-title', { text: 'Transpose' }), holdTag()),
    h('div.transpose-row', {}, tDown.el, tVal, tUp.el),
  );

  // Space / Echo: one tap applies an fx-presets.js preset to this song (H-v2 concept §1.5 4a). "…" holds Ambient Wash
  // and the whole-song Vibes (space + echo together), which today's Perform had as its own picker.
  const VIBE_MORE = VIBE_PRESETS.map((p) => ({ id: `vibe:${p.id}`, label: p.name, hint: 'vibe: space + echo', title: p.blurb }));
  const SPACE_OWN = { id: SONG_OWN, label: 'Song’s own', hint: 'as saved', own: true, title: 'This song’s own room, as it was saved' };
  // Space's "Song's own" is always built and only shown for songs saved with a room that is no preset, so a song
  // switch never rebuilds the row (DOM patched in place)
  const spaceRow = use(headerChipRow({ label: 'Space', options: [...SPACE_CHIPS, SPACE_OWN], more: [...SPACE_MORE, ...VIBE_MORE], icon: icon('room', 20), onSelect: (id) => pickFx('reverb', id) }));
  spaceRow.el.dataset.testid = 'space-row';
  const spaceOwnChip = spaceRow.el.querySelector(`.fxc[data-id="${SONG_OWN}"]`);
  const echoRow = use(headerChipRow({ label: 'Echo', options: ECHO_CHIPS, icon: icon('echo', 20), onSelect: (id) => pickFx('delay', id) }));
  echoRow.el.dataset.testid = 'echo-row';
  let spaceHasOwn = false;
  const fxBox = h('section.panel.p-fx', { 'aria-label': 'Shared effects (this song)' }, spaceRow.el, echoRow.el);

  const chord = use(chordReadout({ label: 'Chord' }));
  chord.el.classList.add('panel');
  chord.el.append(fadedChip); // covers the (idle) chord readout while faded — never over the song name
  const head = h('div.p-head', {}, songBlock, transposeBox, fxBox, chord.el);

  // ---------------------------------------------------------------- setlist row
  // Prev / Next pass through an open step panel's outside-tap swallow (OPTIONS.md round-3 fix 4)
  const prevBtn = btn('.nav-btn.prev', '◀ Prev', { 'aria-label': 'Previous song', 'data-testid': 'prev-song', 'data-overlay-pass': '' });
  const nextName = h('b.nav-next-name', { 'data-testid': 'next-name', text: '' });
  const nextBtn = h(
    'button.btn.nav-btn.next',
    { type: 'button', 'aria-label': 'Next song', 'data-testid': 'next-song', 'data-overlay-pass': '' },
    h('span.nav-next-text', {}, h('small.nav-next-cap', { text: 'Next' }), nextName),
    icon('chevron', 22),
  );
  blurAfterPointer(nextBtn, d);
  d.listen(prevBtn, 'click', () => controller.prevSong());
  d.listen(nextBtn, 'click', () => controller.nextSong());
  const setlist = use(
    setlistStrip({
      label: 'Setlist',
      dragNeedsAlt: true, // a sloppy click-drag must not reorder the service (UX S2)
      onSelect: (id, index) => controller.selectSong(id, { index }),
      onReorder: (from, to) => {
        if (isLocked()) return;
        const st = store.get();
        const slId = st.settings.currentSetlistId;
        const sl = slId && st.setlists[slId];
        store.moveSong(sl && sl.songIds.length ? slId : null, from, to);
      },
    }),
  );
  setlist.el.classList.add('panel');
  setlist.el.dataset.testid = 'setlist';
  const nav = h('div.p-nav', {}, prevBtn, setlist.el, nextBtn);

  // ---------------------------------------------------------------- wheel strip
  const wheel = use(
    wheelStrip({
      label: 'Wheel',
      relative: true,
      onSwell: () => controller.swell(),
      onWheel: (v) => controller.perform.wheel(v),
    }),
  );
  const wheelPanel = h('section.panel.p-wheel', { 'data-testid': 'wheel-strip' }, wheel.el);

  // ---------------------------------------------------------------- strips
  const slots = [];
  const slotsEl = h('section.p-slots', { 'aria-label': 'Instrument slots' });
  for (let i = 0; i < SLOT_COUNT; i++) {
    const role = ROLE_DEFAULTS[i];
    const ROLE = role.name.toUpperCase();
    const color = `var(--slot-${i})`;
    const tile = use(onTile({ label: ROLE, color, testid: `slot-on-${i}`, onToggle: (on) => setMuted(i, !on) }));
    const instIcon = h('span.slot-icon', {}, icon('wave', 20));
    const inst = h('span.slot-inst', { text: '—' });
    const badge = h('span.wheel-badge', { text: '' });
    const chorusBadge = h('span.slot-badge.chorus-badge', { hidden: true });
    const octBadge = h('span.slot-badge.oct-badge', { hidden: true }, h('em.cdi', { hidden: true }), h('span', {}));
    const susBadge = h('span.slot-badge.sus-badge', { hidden: true, text: 'Sus. off' });
    const f = use(
      fader({
        path: `slots.${i}.gain`,
        label: `${role.name} level`,
        vertical: true,
        relative: true,
        resetOnDoubleClick: false,
        color,
        onChange: (v) => setSlotGain(i, v),
      }),
    );
    f.el.dataset.testid = `slot-fader-${i}`;
    const chip = (o) => use(stepChip({ owner: ROLE, color, ...o }));
    const space = chip({
      label: 'Space',
      steps: AMOUNT_STEPS,
      format: formatAmount,
      lit: (v) => Number(v) > 0.0005,
      amount: (v) => Number(v) || 0,
      fine: { min: 0, max: 1, format: (v) => `${Math.round(v * 100)}%` },
      hint: 'how much goes into the Space',
      footnote: 'Tap a step: done. Slide for in-between.',
      testid: `slot-space-${i}`,
      onChange: (v) => setSlot(i, 'sends.reverb', v),
    });
    const echo = chip({
      label: 'Echo',
      steps: AMOUNT_STEPS,
      format: formatAmount,
      lit: (v) => Number(v) > 0.0005,
      amount: (v) => Number(v) || 0,
      fine: { min: 0, max: 1, format: (v) => `${Math.round(v * 100)}%` },
      hint: 'how much goes into the Echo',
      footnote: 'Tap a step: done. Slide for in-between.',
      testid: `slot-echo-${i}`,
      onChange: (v) => setSlot(i, 'sends.delay', v),
    });
    const octave = chip({
      label: 'Octave',
      steps: OCTAVE_STEPS,
      format: formatOctave,
      lit: (v) => Number(v) !== 0,
      hint: `shifts only the ${role.name.toLowerCase()}`,
      footnote: 'Tap one: done. Starts on your next note; held notes keep ringing.',
      className: 'x4',
      testid: `slot-octave-${i}`,
      onChange: (v) => setSlot(i, 'octave', v),
    });
    const sustain = chip({
      label: 'Sustain',
      steps: SUSTAIN_STEPS,
      format: (v) => (v ? 'Sustain' : 'Sustain off'),
      lit: (v) => v === true,
      className: 'x4',
      title: 'Does the sustain pedal hold this sound? Tap to switch.',
      testid: `slot-sustain-${i}`,
      onChange: (v) => setSlot(i, 'sustain', !!v),
    });
    const addBtn = btn('.slot-add', icon('plus', 18), { 'aria-label': `${role.name} is empty: add a sound in Edit`, title: 'Empty slot: add a sound in Edit', 'data-testid': `slot-add-${i}` });
    d.listen(addBtn, 'click', () => ctx.setView?.('edit'));
    const empty = h('div.slot-empty', { hidden: true }, addBtn, h('div.slot-vt', {}, ROLE, h('span', { text: ' · empty' })));
    const elSlot = h(
      'div.panel.slot.strip',
      { dataset: { slot: String(i) }, 'data-testid': `slot-${i}`, style: { '--c': color } },
      tile.el,
      h('div.slot-who', {}, instIcon, inst),
      h('div.slot-tag', {}, badge, chorusBadge, octBadge, susBadge),
      h('div.slot-body', {}, f.el),
      h('div.slot-mods', {}, space.el, echo.el, octave.el, sustain.el),
      empty,
    );
    slots.push({ el: elSlot, tile, instIcon, inst, badge, chorusBadge, octBadge, susBadge, fader: f, space, echo, octave, sustain, empty, gain: null, muted: false });
    slotsEl.append(elSlot);
  }

  // ---------------------------------------------------------------- key & drone
  // The drone uses the same ON tile (OPTIONS.md round-3 fix 1); the card keeps the title "Key & drone" because the
  // grid re-keys everything the band hears (fix 2). Selections inside the card are outline-only.
  let lastDroneSource = null; // Synth / My Pads before the tile turned the drone off (view memory, fix 5)
  const droneTile = use(
    onTile({
      label: 'DRONE',
      color: 'var(--drone)',
      testid: 'drone-on',
      title: 'Tap to turn the drone on or off',
      onToggle: (on) => setDroneOn(on),
    }),
  );
  const droneMode = use(
    segmented({
      label: 'Drone sound',
      options: [
        { value: 'synth', label: 'Synth' },
        { value: 'files', label: 'My Pads' },
      ],
      onChange: (v) => {
        if (isLocked() || !shownId) return renderSong(store.get()); // frozen under lock
        setSong('drone.mode', v);
      },
    }),
  );
  droneMode.el.dataset.testid = 'drone-mode';
  const grid = use(
    keyGrid({
      label: 'Song key',
      onSelect: (pc) => {
        if (isLocked()) {
          if (!gridGate.justHeld()) lockHint();
          return renderSong(store.get());
        }
        setSongKey(pc);
      },
    }),
  );
  grid.el.dataset.testid = 'key-grid';
  const quality = use(
    segmented({
      label: 'Major or minor',
      options: [
        { value: false, label: 'Major' },
        { value: true, label: 'Minor' },
      ],
      onChange: (v) => {
        if (isLocked()) {
          if (!qualityGate.justHeld()) lockHint();
          return renderSong(store.get());
        }
        setSong('minor', !!v);
      },
    }),
  );
  quality.el.dataset.testid = 'key-quality';
  const gridGate = holdGate(grid.el, { selector: '.key-btn', enabled: isLocked, run: (b) => setSongKey(Number(b.dataset.pc)), onHint: () => lockHint(), d });
  const qualityGate = holdGate(quality.el, { selector: '.seg', enabled: isLocked, run: (b) => setSong('minor', b.dataset.value === 'true'), onHint: () => lockHint(), d });
  const droneGain = use(fader({ path: 'drone.gain', label: 'Drone level', compact: true, color: 'var(--drone)', relative: true, resetOnDoubleClick: false, onChange: (v) => setSong('drone.gain', v) }));
  droneGain.el.dataset.testid = 'drone-gain';
  const brightness = use(fader({ path: 'drone.brightness', label: 'Brightness', compact: true, color: 'var(--drone)', relative: true, resetOnDoubleClick: false, format: (v) => `${brightnessWord(v)} · ${Math.round(v * 100)}%`, onChange: (v) => setSong('drone.brightness', v) }));
  brightness.el.dataset.testid = 'drone-brightness';
  const movement = use(fader({ path: 'drone.movement', label: 'Movement', compact: true, color: 'var(--drone)', relative: true, resetOnDoubleClick: false, format: (v) => `${movementWord(v)} · ${Math.round(v * 100)}%`, onChange: (v) => setSong('drone.movement', v) }));
  movement.el.dataset.testid = 'drone-movement';
  const follow = use(toggle({ label: 'Follow chords', tag: 'experimental', title: 'The synth drone follows the chords you hold below middle C (experimental)', onChange: (v) => setSong('drone.chordFollow', v) }));
  follow.el.dataset.testid = 'drone-follow';
  const cont = use(toggle({ label: 'Continue across songs', title: 'Keep the drone playing when you switch songs (it glides to the new key)', onChange: (v) => setSong('drone.continueAcrossSongs', v) }));
  cont.el.dataset.testid = 'drone-continue';
  const padText = h('span.pad-status-text', { text: '' });
  const padBtn = btn('.pad-btn', 'Choose folder…', { 'data-testid': 'pad-folder-btn' });
  d.listen(padBtn, 'click', () => {
    const st = store.get().settings;
    if (padsInfo && padsInfo.total > 0 && ctx.rig?.isElectron && typeof controller.reloadPads === 'function' && st.padFolder) {
      controller.reloadPads().then((r) => {
        if (r && !r.error) ctx.toast?.(`Pad folder rescanned: ${r.count} key${r.count === 1 ? '' : 's'} found.`, 'ok');
      });
    } else ctx.openSettings?.({ section: 'pads' });
  });
  const padStatus = h('div.pad-status', { 'data-testid': 'pad-status' }, padText, padBtn);
  // "Eb major · −9.1 dB" from what the engine plays; spoken (aria-live), the tile shows the key
  const droneReadout = h('span.drone-readout', { 'data-testid': 'drone-readout', role: 'status', 'aria-live': 'off', text: '' });
  const lockLine = h('div.drone-lockline', {}, h('span.hold-tag', { text: 'HOLD' }), h('span', { text: 'a key or Major/Minor to change it while locked' }));
  const droneEl = h(
    'section.panel.p-drone.drone-block',
    { 'aria-label': 'Song key and drone', 'data-testid': 'drone' },
    h('div.drone-title', {}, h('span.section-title', { text: 'Key & drone' }), droneReadout),
    h('div.drone-head', {}, droneTile.el, droneMode.el),
    grid.el,
    h('div.drone-row', {}, quality.el, h('div.drone-level', {}, droneGain.el)),
    lockLine,
    h('div.drone-char', {}, brightness.el, movement.el),
    h('div.drone-toggles', {}, follow.el, cont.el),
    padStatus,
  );

  // ---------------------------------------------------------------- notes
  const notesText = h('div.notes-text', { 'data-testid': 'notes', tabindex: '0' });
  // round2-ui #12: a keyboard-focused notes panel scrolls itself; the keys must not also reach the controller
  // (↑/↓ = mod wheel there, which would change the sound while the player only meant to read on).
  d.listen(notesText, 'keydown', (e) => {
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const line = 40;
    const page = Math.max(line, notesText.clientHeight * 0.9);
    const dy = { ArrowUp: -line, ArrowDown: line, PageUp: -page, PageDown: page }[e.key];
    if (dy !== undefined) notesText.scrollTop += dy;
    else if (e.key === 'Home') notesText.scrollTop = 0;
    else if (e.key === 'End') notesText.scrollTop = notesText.scrollHeight;
    else return;
    e.preventDefault(); // the controller ignores defaultPrevented keys
    e.stopPropagation();
  });
  const notesClose = btn('.notes-close', 'Close', { 'aria-label': 'Close notes' });
  const notesEl = h('section.panel.p-notes', { id: 'perform-notes', 'aria-label': 'Song notes' }, h('div.notes-head', {}, h('span.section-title', { text: 'Notes' }), notesClose), notesText);

  const main = h('div.p-main', {}, wheelPanel, slotsEl, droneEl, notesEl);

  // ---------------------------------------------------------------- bottom: keyboard + actions
  const PIANO_FROM = 36;
  const PIANO_TO = 96;
  const piano = use(
    pianoKeyboard({
      from: PIANO_FROM,
      to: PIANO_TO,
      label: 'On-screen keyboard (C2–C7)',
      onNoteOn: (n, v) => controller.perform.noteOn(n, v),
      onNoteOff: (n) => controller.perform.noteOff(n),
    }),
  );
  piano.el.dataset.testid = 'piano';
  // range bars: where each sound plays (display only, from lowNote/highNote); an OFF sound's bar is grey
  const layout = new Map(keyLayout(PIANO_FROM, PIANO_TO).map((k) => [k.note, k]));
  const rangeBars = Array.from({ length: SLOT_COUNT }, (_, i) => h('i.rbar', { hidden: true, style: { '--c': `var(--slot-${i})` }, dataset: { slot: String(i) } }));
  const rbars = h('div.rbars', { 'aria-hidden': 'true', 'data-testid': 'range-bars' }, ...rangeBars);

  const revertCount = h('span.rv-cnt-t', { text: '' });
  const revertBtn = use(
    holdButton({
      content: [h('span.rv-l', { text: '↺ Revert' }), h('span.rv-cnt', {}, h('i.rv-dot', { 'aria-hidden': 'true' }), revertCount), holdTag()],
      ms: HOLD_MS,
      requireHold: true, // always a hold: it also un-parks mutes and snaps every fader (OPTIONS.md round-3 fix 2)
      className: 'btn-revert',
      title: 'Press and hold: put this song back the way it was when you selected it (levels, key, drone, effects)',
      testid: 'revert-song',
      onActivate: () => revertSong(),
    }),
  );
  revertBtn.setDisabled(true);
  const fadeLabel = h('span.fade-label', { text: 'Fade out' });
  const fadeBtn = btn('.btn-fade', fadeLabel, { title: 'Fade everything out over 6 s (⌘⇧F). Play any note to bring the sound back.', 'data-testid': 'fade-out' });
  const panicBtn = btn('.btn-panic', [h('span.panic-l', { text: 'PANIC' }), h('small.panic-k', { text: 'Esc' })], { title: 'All notes off (Esc, ⌘.)', 'data-testid': 'panic', 'aria-label': 'Panic: all notes off' });
  // Lock: one press locks; unlocking needs a 600 ms press-and-hold (UX S1). round2-ui #5 lives in holdButton.
  const lockText = h('span.lock-text', { text: 'Lock' });
  const lockSub = h('span.lock-sub', { text: '' });
  const lockBtn = use(
    holdButton({
      content: [h('span.lock-l', {}, icon('lock', 18), lockText), lockSub],
      ms: HOLD_MS,
      requireHold: isLocked,
      className: 'lock-toggle',
      testid: 'perform-lock',
      holdText: 'keep holding… (0.6 s)',
      title: 'Perform lock: playing stays live (faders, ON tiles, chips, Space/Echo, wheel, Prev/Next, Fade out, PANIC); the key, transpose and Revert need a hold; Edit, Settings and the drone sound are frozen. Hold to unlock.',
      onActivate: () => store.set('settings.performLock', !isLocked()),
    }),
  );
  const flash = (el) => {
    el.classList.remove('flash-action');
    void el.offsetWidth;
    el.classList.add('flash-action');
  };
  d.listen(fadeBtn, 'click', () => {
    controller.fadeOutAll();
    flash(fadeBtn);
    setFaded(true);
  });
  d.listen(panicBtn, 'click', () => {
    controller.panic();
    flash(panicBtn);
  });
  const bottom = h(
    'div.p-bottom',
    {},
    h('section.panel.p-keys', {}, rbars, piano.el),
    h('div.p-actions', {}, revertBtn.el, fadeBtn, panicBtn, lockBtn.el),
  );

  // ---------------------------------------------------------------- Quick sheet (over the header + setlist rows)
  const quick = use(
    quickSheet({
      anchor: ctx.quickButton || null,
      onTempo: (bpm) => setSong('tempo', bpm),
      onSwell: (s) => setSong('patch.swell.seconds', s),
      onTouch: (v) => !isLocked() && store.set('settings.velocitySens', v),
      onPedalReversed: (b) => !isLocked() && store.set('settings.pedalInvert', !!b),
      onRestartAudio: () => controller.restartAudio(),
      onAllSettings: () => {
        quick.close();
        ctx.openSettings?.();
      },
    }),
  );

  const perform = h('div.perform', {}, head, nav, main, bottom, quick.el);
  root.replaceChildren(perform);
  // compact layouts (< 1340 px wide): the notes card shares the drone column and is toggled from the song block
  const showNotes = (on) => {
    perform.classList.toggle('show-notes', on);
    notesBtn.setAttribute('aria-pressed', String(on));
    if (on) checkNotesOverflow();
  };
  d.listen(notesBtn, 'click', () => showNotes(!perform.classList.contains('show-notes')));
  d.listen(notesClose, 'click', () => showNotes(false));

  const openQuick = (opts) => {
    if (quick.isOpen) return;
    renderQuick();
    // the sheet's arrow points at the top-bar Quick button
    const a = ctx.quickButton?.getBoundingClientRect();
    const p = perform.getBoundingClientRect();
    if (a && a.width) quick.el.style.setProperty('--qx', `${Math.max(12, Math.round(a.left + a.width / 2 - p.left - 14 - 7))}px`);
    quick.open(opts);
  };

  // ---------------------------------------------------------------- "Sing it in…" (KEY ▾)
  let keyPop = null;
  let closeKeyPop = null;
  function toggleKeyPop() {
    if (closeKeyPop) return closeKeyPop('api');
    const song = store.currentSong();
    if (!song) return;
    const sing = keyGrid({ label: 'The key the band hears', onSelect: (pc) => singItIn(pc) });
    sing.el.dataset.testid = 'sing-grid';
    const hears = h('b.kp-hears');
    const plays = h('span.kp-plays');
    const shift = h('b.kp-shift');
    const back = h('button.btn.kp-back', { type: 'button', 'data-testid': 'sing-back' });
    const hands = h('b.kp-hands');
    const el = h(
      'div.keypop',
      { role: 'group', 'aria-label': 'Sing it in', 'data-perform-overlay': '', 'data-testid': 'sing-it-in' },
      h('h3', { text: 'Sing it in…' }),
      h('p', {}, 'Tap the key the band will sing in. ', h('b', {}, 'Your hands stay in ', hands), '; the app shifts every sound.'),
      sing.el,
      h('div.kp-foot', {}, 'Band hears ', hears, ' · ', plays, ' · ', shift, back),
      h('div.kp-note', {}, 'Want to play in the new key yourself too? Use the key grid in ', h('b.kp-drone', { text: 'Key & drone' }), '.'),
    );
    d.listen(back, 'click', () => {
      const s = store.currentSong();
      if (s) singItIn(s.playIn);
    });
    blurAfterPointer(back, d);
    const render = () => {
      const s = store.currentSong();
      if (!s) return;
      sing.set({ pc: s.hearIn, minor: s.minor });
      for (const b of sing.el.querySelectorAll('.key-btn')) b.classList.toggle('hands', Number(b.dataset.pc) === s.playIn);
      const semis = transposeSemisOf(s);
      setText(hands, keyName(s.playIn, s.minor));
      setText(hears, keyName(s.hearIn, s.minor));
      setText(plays, `you play ${keyName(s.playIn, s.minor)}`);
      setText(shift, signed(semis));
      setText(back, `Back to ${keyName(s.playIn, s.minor)}`);
      back.disabled = semis === 0;
    };
    render();
    const kb = keyBtn.el.getBoundingClientRect();
    const pr = perform.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.round(kb.left - pr.left - 36))}px`;
    el.style.top = `${Math.round(kb.bottom - pr.top + 10)}px`;
    perform.append(el);
    keyBtn.el.classList.add('open');
    keyBtn.el.setAttribute('aria-expanded', 'true');
    keyPop = { el, render, sing };
    closeKeyPop = openOverlay({
      el,
      anchors: [keyBtn.el],
      swallow: true,
      group: 'key-pop',
      onClose: () => {
        sing.destroy();
        el.remove();
        keyPop = null;
        closeKeyPop = null;
        keyBtn.el.classList.remove('open');
        keyBtn.el.setAttribute('aria-expanded', 'false');
      },
    });
  }
  d.add(() => closeKeyPop?.('api'));
  /** "Sing it in…": the band hears `pc`, the hands stay in Play-In (the existing transpose path). */
  function singItIn(pc) {
    const s = store.currentSong();
    if (!s) return;
    const delta = singItInShift(s.playIn, pc) - transposeSemisOf(s);
    if (delta) controller.transposeBy(delta);
  }

  // ---------------------------------------------------------------- lock hint (key grid / Major-Minor)
  let lockHintTimer = null;
  function lockHint() {
    lockLine.classList.remove('hint');
    void lockLine.offsetWidth;
    lockLine.classList.add('hint');
    clearTimeout(lockHintTimer);
    lockHintTimer = setTimeout(() => lockLine.classList.remove('hint'), 1600);
  }
  d.add(() => clearTimeout(lockHintTimer));

  /** Setlist "gap" position (current entry removed; Next plays that index) or null (round2-ui #4). */
  const gapOf = (nb) => (nb && Number.isInteger(nb.gap) ? nb.gap : null);

  // ---------------------------------------------------------------- writes
  let shownId = null; // id of the song the view shows
  /** A song field. The frozen / hold rules are enforced by the controls (LOCK); this only needs a song. */
  function setSong(field, value) {
    if (!shownId) return false;
    return store.set(`songs.${shownId}.${field}`, value);
  }
  function setSlot(i, field, value) {
    if (!shownId || !store.getSong(shownId)?.patch.slots[i]) return;
    store.set(`songs.${shownId}.patch.slots.${i}.${field}`, value);
  }
  function setSlotGain(i, v) {
    setSlot(i, 'gain', v);
  }
  function setMuted(i, muted) {
    if (!shownId) return;
    const slot = store.getSong(shownId)?.patch.slots[i];
    if (!slot) return;
    // first-class mute (shell fixes §1 migrates the old gain 0 + mutedGain convention; round2-ui #9 dropped the
    // write fallback — a refused set means a read-only store, where the fallback writes were refused too)
    if (slotMuteState(slot).muted !== muted) store.set(`songs.${shownId}.patch.slots.${i}.muted`, muted);
    renderSlots(store.getSong(shownId)); // a refused write puts the tile back
  }
  /** Drone ON tile: off ↔ the last source (this session), else the snapshot's source, else Synth (round-3 fix 5). */
  function setDroneOn(on) {
    const s = shownId && store.getSong(shownId);
    if (!s) return;
    if (!on) {
      if (s.drone.mode !== 'off') lastDroneSource = s.drone.mode;
      setSong('drone.mode', 'off');
    } else if (s.drone.mode === 'off') {
      setSong('drone.mode', lastDroneSource || droneOnMode(snap && snap.id === s.id ? snap.song : s));
    }
    renderSong(store.get());
  }
  /** Key grid: the key the band hears. Keeps the current transpose amount (Play-In moves with it). */
  function setSongKey(pc) {
    if (!shownId) return;
    const s = store.getSong(shownId);
    if (!s) return;
    const semis = transposeSemis(s.playIn, s.hearIn);
    if (s.hearIn === mod12(pc)) return;
    store.set(`songs.${shownId}.hearIn`, mod12(pc));
    store.set(`songs.${shownId}.playIn`, mod12(pc - semis));
  }
  function applyPreset(list, id) {
    const p = list.find((x) => x.id === id);
    if (!p || !shownId) return;
    for (const [path, v] of Object.entries(p.params)) {
      if (!isValidPath(path)) continue; // e.g. an EQ/comp param this build doesn't have
      const target = path.startsWith('master.') ? `songs.${shownId}.patch.fx.master.${path.slice(7)}` : `songs.${shownId}.patch.${path}`;
      store.set(target, v);
    }
  }
  /** Header chip → preset; "Song's own" writes back only that effect from the Revert snapshot (H implementation §2). */
  function pickFx(unit, id) {
    if (!shownId) return;
    if (id === SONG_OWN) {
      const own = snap && snap.id === shownId ? snap.song.patch?.fx?.[unit] : null;
      if (own) store.set(`songs.${shownId}.patch.fx.${unit}`, JSON.parse(JSON.stringify(own)));
    } else if (id.startsWith('vibe:')) applyPreset(VIBE_PRESETS, id.slice(5));
    else applyPreset(unit === 'reverb' ? SPACE_PRESETS : ECHO_PRESETS, id);
    renderPresets(store.getSong(shownId)); // a no-op write (same values) still re-syncs the row
  }

  // "Revert to saved": the song as it was when it was selected (or when Edit was left)
  let snap = null; // {id, song, json}
  const takeSnapshot = (song) => {
    snap = song ? { id: song.id, song, json: savedJSON(song) } : null;
  };
  function revertSong() {
    if (!snap || !shownId || snap.id !== shownId) return;
    const s = snap.song;
    const cur = store.getSong(shownId);
    if (!cur) return;
    for (const k of SAVED_FIELDS) {
      if (JSON.stringify(cur[k]) !== JSON.stringify(s[k])) store.set(`songs.${shownId}.${k}`, s[k]);
    }
    ctx.toast?.(`“${s.name}” is back to how it was when you selected it.`, 'ok', { ms: 3000 });
  }

  // ---------------------------------------------------------------- reads
  let instNames = new Map();
  let instGroups = new Map();
  const refreshNames = () => {
    try {
      const list = engine?.listInstruments?.() || [];
      instNames = new Map(list.map((x) => [`${x.ref.type}:${x.ref.id}`, x.name]));
      instGroups = new Map(list.map((x) => [`${x.ref.type}:${x.ref.id}`, groupOf(x)]));
    } catch {
      instNames = new Map();
      instGroups = new Map();
    }
  };
  refreshNames();
  const instName = (ref) => (ref ? stageName(instNames.get(`${ref.type}:${ref.id}`) || humanize(ref.id), ref) : '—');

  let status = controller.status || {};
  let padsInfo = null;
  let bendValue = 0;
  let lastView = store.get().settings.view;
  let changed = new Set();
  const seen = { expr: false, vol: false };
  const wheelNow = () => {
    try {
      return engine?.wheelValues?.() || { mod: 1, expr: 1, vol: 1 };
    } catch {
      return { mod: 1, expr: 1, vol: 1 };
    }
  };

  function renderSong(state) {
    const st = state.settings;
    const song = state.songs[st.currentSongId] || null;
    const newId = song ? song.id : null;
    if (newId !== shownId) {
      // round2-ui #2: a hand still on a fader when the song changes (MIDI Next / program change) must not carry
      // the drag into the new song; drop it before the faders show the new song's levels.
      for (const S of slots) S.fader.cancelDrag?.();
      droneGain.cancelDrag?.();
      brightness.cancelDrag?.();
      movement.cancelDrag?.();
      for (const S of slots) for (const c of [S.space, S.echo, S.octave]) c.close();
      closeKeyPop?.('api');
      lastDroneSource = null;
    }
    shownId = newId;
    const locked = !!st.performLock;
    // round2-ui #8: the snapshot follows the controller's *commit* ('songSelected'), not the store's selection
    // request, so a refused/failed load keeps the applied song's snapshot. Leaving Edit makes the edits the baseline.
    if (!song) snap = null;
    else if (!snap || (st.view === 'perform' && lastView === 'edit')) takeSnapshot(song);
    lastView = st.view;
    if (st.view !== 'perform') quick.close();
    changed = song && snap && snap.id === song.id ? changedPaths(song, snap.song) : new Set();
    // head
    setText(songName, song ? song.name : 'No song');
    songName.title = song ? song.name : '';
    if (song) {
      setText(songKey, keyName(song.hearIn, song.minor));
      const semis = transposeSemisOf(song);
      const transposed = semis !== 0;
      const play = keyName(song.playIn, song.minor);
      const oct = song.transposeOctave ? ` · oct ${signed(song.transposeOctave)}` : '';
      songPlayIn.hidden = !transposed;
      songBpm.hidden = transposed;
      if (transposed) songPlayIn.replaceChildren(h('span.pl-cap', { text: 'you play ' }), `${play}${oct}`);
      setText(songBpm, `you play ${play}${song.tempo ? ` · ${Math.round(song.tempo)} BPM` : ''}`);
      setText(tVal, signed(semis));
      tVal.classList.toggle('shift', transposed);
    } else {
      setText(songKey, '');
      songPlayIn.hidden = true;
      setText(songBpm, '');
      setText(tVal, '0');
      tVal.classList.remove('shift');
    }
    keyBtn.setDisabled(!song);
    tDown.setDisabled(!song);
    tUp.setDisabled(!song);
    for (const b of [keyBtn, tDown, tUp, lockBtn]) b.refresh();
    keyPop?.render();
    // setlist
    const ids = store.navIds();
    setlist.set({
      songs: ids.map((id) => {
        const s = state.songs[id];
        return { id, name: s ? s.name : '?', key: s ? keyName(s.hearIn, s.minor) : '' };
      }),
      currentId: st.currentSongId,
      currentIndex: store.currentIndex(),
      gap: gapOf(store.neighbors()),
      loadingId: status.loading ? status.songId : null,
      reorderable: !locked,
    });
    const nb = store.neighbors();
    prevBtn.disabled = !nb.prev;
    nextBtn.disabled = !nb.next;
    const ns = nb.next ? state.songs[nb.next.id] : null;
    if (ns) {
      const k = keyName(ns.hearIn, ns.minor);
      nextName.replaceChildren(`${ns.name} · `, h('em', { text: k }));
      nextBtn.title = `${ns.name} · ${k}`;
      nextBtn.setAttribute('aria-label', `Next song: ${ns.name}, key ${k}`);
    } else {
      setText(nextName, 'End of set');
      nextBtn.title = '';
      nextBtn.setAttribute('aria-label', 'Next song (end of set)');
    }
    // strips
    perform.classList.toggle('chips-2', st.performChips === 2);
    renderSlots(song);
    // drone
    if (song) {
      const dr = song.drone;
      const on = dr.mode !== 'off';
      droneTile.set(on);
      droneMode.set(on ? dr.mode : lastDroneSource || droneOnMode(snap && snap.id === song.id ? snap.song : song));
      grid.set({ pc: song.hearIn, minor: song.minor });
      quality.set(!!song.minor);
      droneGain.set(dr.gain);
      brightness.set(Number.isFinite(dr.brightness) ? dr.brightness : 0.5);
      movement.set(Number.isFinite(dr.movement) ? dr.movement : 0.3);
      follow.set(dr.chordFollow);
      follow.el.hidden = dr.mode !== 'synth';
      cont.set(dr.continueAcrossSongs);
      droneEl.classList.toggle('off', !on);
    }
    droneTile.setDisabled(!song);
    droneMode.setDisabled(locked || !song);
    grid.setDisabled(!song);
    quality.setDisabled(!song);
    droneGain.setDisabled(!song);
    brightness.setDisabled(locked || !song);
    movement.setDisabled(locked || !song);
    follow.setDisabled(locked);
    cont.setDisabled(locked);
    droneEl.classList.toggle('locked', locked);
    renderDroneReadout();
    renderPads(state);
    renderPresets(song);
    spaceRow.setDisabled(!song);
    echoRow.setDisabled(!song);
    renderRevert(song);
    wheel.set({ target: song ? wheelTargetLabel(song.patch.modWheel?.target) : '', bendMode: song?.patch.bend?.mode });
    renderWheel();
    // notes
    const notes = song && song.notes ? song.notes : '';
    notesText.classList.toggle('empty', !notes);
    notesBtn.classList.toggle('has-notes', !!notes);
    setText(notesText, notes || 'No notes for this song. Add some in Edit.');
    checkNotesOverflow();
    // lock
    renderLock(locked);
    root.classList.toggle('locked', locked);
    perform.classList.toggle('locked', locked);
    renderQuick();
  }

  function renderLock(locked) {
    lockBtn.el.classList.toggle('on', locked);
    lockBtn.el.setAttribute('aria-pressed', String(locked));
    lockBtn.el.setAttribute('aria-label', locked ? 'Perform lock is on. Press and hold to unlock.' : 'Lock Perform view');
    setText(lockText, locked ? 'Locked' : 'Lock');
    setText(lockSub, locked ? 'playing stays live · hold to unlock' : '');
  }

  function renderRevert(song = store.currentSong()) {
    const same = !song || !snap || snap.id !== song.id || savedJSON(song) === snap.json;
    const n = changeCount(changed);
    revertBtn.setDisabled(same);
    revertBtn.el.classList.toggle('none', n === 0);
    // faders and mutes carry no dot and aren't counted (concept §2, round-3 fix 2); Revert still restores them
    setText(revertCount, same ? 'nothing changed' : n ? `${n} changed` : 'levels only');
    revertBtn.el.dataset.count = String(same ? 0 : n);
  }

  function renderPresets(song) {
    const base = song && snap && snap.id === song.id ? snap.song : null;
    // Space gets "Song's own" only when the song was loaded with a room that is no preset (Echo always has it)
    const own = !!base && !matchPreset(SPACE_PRESETS, (p) => songFxValue(base, p));
    spaceHasOwn = own;
    if (spaceOwnChip) spaceOwnChip.hidden = !own;
    for (const [row, unit, list] of [
      [spaceRow, 'reverb', SPACE_PRESETS],
      [echoRow, 'delay', ECHO_PRESETS],
    ]) {
      if (!song) {
        row.set(null);
        row.setChanged(false);
        continue;
      }
      const m = matchPreset(list, (p) => songFxValue(song, p));
      const baseM = base ? matchPreset(list, (p) => songFxValue(base, p)) : null;
      const asSaved = !!base && sameValue(song.patch.fx?.[unit], base.patch.fx?.[unit]);
      const hasOwn = unit === 'delay' || spaceHasOwn;
      row.set(hasOwn && asSaved && !baseM ? SONG_OWN : m ? m.id : null);
      row.setChanged(hasChange(changed, `patch.fx.${unit}`));
    }
  }

  const notesRaf = rafCoalesce(() => notesText.classList.toggle('overflowing', notesText.scrollHeight > notesText.clientHeight + 4));
  d.add(() => notesRaf.cancel());
  function checkNotesOverflow() {
    notesRaf.push();
  }

  function renderSlots(song) {
    const w = wheelNow();
    const base = song && snap && snap.id === song.id ? snap.song : null;
    const spaceName = song ? matchPreset(SPACE_PRESETS, (p) => songFxValue(song, p))?.name : null;
    let bar = 0;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const S = slots[i];
      const slot = song ? song.patch.slots[i] : null;
      const empty = !slot;
      S.el.classList.toggle('empty', empty);
      S.empty.hidden = !empty;
      S.fader.setDisabled(empty);
      for (const c of [S.space, S.echo, S.octave, S.sustain]) c.setDisabled(empty);
      S.tile.setDisabled(empty);
      const rb = rangeBars[i];
      if (empty) {
        setText(S.inst, 'Empty');
        S.inst.title = 'Empty slot (add an instrument in Edit)';
        setText(S.badge, '');
        S.el.classList.remove('muted');
        S.tile.set(true);
        S.gain = null;
        rb.hidden = true;
        continue;
      }
      const key = `${slot.instrument.type}:${slot.instrument.id}`;
      const name = instName(slot.instrument);
      setText(S.inst, name);
      S.inst.title = instNames.get(key) || name;
      const ic = GROUP_ICON[instGroups.get(key)] || 'wave';
      if (S.instIcon.dataset.icon !== ic) {
        S.instIcon.dataset.icon = ic;
        S.instIcon.replaceChildren(icon(ic, 20));
      }
      const { muted, level } = slotMuteState(slot);
      S.gain = level;
      S.muted = muted;
      S.fader.set(level);
      S.fader.setMuted(muted);
      S.el.classList.toggle('muted', muted);
      S.tile.set(!muted);
      const f = slotWheelFactor(song.patch, i, w);
      S.fader.setIndicator(f === null || muted ? null : level * f);
      setText(S.badge, f === null ? '' : `↻ wheel ${Math.round(f * 100)}%`);
      // chips (+ the white dot = changed since loaded; "as loaded" in the step panel)
      const P = `patch.slots.${i}`;
      const sends = slot.sends || {};
      const bs = base?.patch.slots[i] || null;
      S.space.set(Number(sends.reverb) || 0);
      S.echo.set(Number(sends.delay) || 0);
      S.octave.set(Number(slot.octave) || 0);
      S.sustain.set(slot.sustain !== false);
      S.space.setLoaded(bs ? Number(bs.sends?.reverb) || 0 : undefined);
      S.echo.setLoaded(bs ? Number(bs.sends?.delay) || 0 : undefined);
      S.octave.setLoaded(bs ? Number(bs.octave) || 0 : undefined);
      S.sustain.setLoaded(bs ? bs.sustain !== false : undefined);
      S.space.setChanged(hasChange(changed, `${P}.sends.reverb`));
      S.echo.setChanged(hasChange(changed, `${P}.sends.delay`));
      S.octave.setChanged(hasChange(changed, `${P}.octave`));
      S.sustain.setChanged(hasChange(changed, `${P}.sustain`));
      S.space.setHint(`how much goes into the Space${spaceName ? ` (${spaceName})` : ''}`);
      // tag line: wheel + Chorus (changed in Edit); 2-chip mode adds Octave / Sustain badges when not normal
      const chorus = Number(sends.chorus) || 0;
      S.chorusBadge.hidden = !(chorus > 0.0005);
      setText(S.chorusBadge, `Chorus ${Math.round(chorus * 100)}%`);
      const oct = Number(slot.octave) || 0;
      S.octBadge.hidden = oct === 0;
      setText(S.octBadge.lastChild, `Oct ${signed(oct)}`);
      S.octBadge.firstChild.hidden = !hasChange(changed, `${P}.octave`);
      S.susBadge.hidden = slot.sustain !== false;
      // range bar
      const lo = Math.max(PIANO_FROM, Number.isFinite(slot.lowNote) ? slot.lowNote : 0);
      const hi = Math.min(PIANO_TO, Number.isFinite(slot.highNote) ? slot.highNote : 127);
      const a = layout.get(lo);
      const b = layout.get(hi);
      rb.hidden = !(a && b && hi >= lo);
      if (!rb.hidden) {
        rb.style.left = `${a.left.toFixed(2)}%`;
        rb.style.width = `${(b.left + b.width - a.left).toFixed(2)}%`;
        rb.style.setProperty('--row', String(bar));
        rb.classList.toggle('off', muted);
        rb.classList.toggle('open-l', (slot.lowNote ?? 0) < PIANO_FROM);
        rb.classList.toggle('open-r', (slot.highNote ?? 127) > PIANO_TO);
        bar += 1;
      }
    }
  }

  function renderWheel() {
    const w = wheelNow();
    wheel.set({ value: w.mod, swelling: !!w.swelling, expr: seen.expr ? w.expr : null, vol: seen.vol ? w.vol : null });
    const song = store.currentSong();
    if (song) {
      for (let i = 0; i < SLOT_COUNT; i++) {
        const S = slots[i];
        if (S.gain === null) continue;
        const f = slotWheelFactor(song.patch, i, w);
        S.fader.setIndicator(f === null || S.muted ? null : S.gain * f);
        setText(S.badge, f === null ? '' : `↻ wheel ${Math.round(f * 100)}%`);
      }
    }
  }
  const wheelRaf = rafCoalesce(renderWheel);
  d.add(() => wheelRaf.cancel());

  /** "Eb major · −9.1 dB" from what the engine actually plays; "Drone off" when silent. The tile shows the key. */
  function renderDroneReadout() {
    const song = store.currentSong();
    let text = '';
    let sub = '';
    if (song) {
      let mode = song.drone.mode;
      let key = { pc: song.hearIn, minor: !!song.minor };
      try {
        const dr = engine?.drone;
        if (dr?.cfg?.mode) mode = dr.cfg.mode;
        if (dr?.key && Number.isInteger(dr.key.pc)) key = { pc: dr.key.pc, minor: !!dr.key.minor };
      } catch {
        /* engine not started */
      }
      const kn = `${keyName(key.pc, key.minor).replace(/m$/, '')} ${key.minor ? 'minor' : 'major'}`;
      sub = song.drone.mode === 'off' ? `${keyName(song.hearIn, song.minor).replace(/m$/, '')} ${song.minor ? 'minor' : 'major'}` : kn;
      if (mode === 'off') text = 'Drone off';
      else {
        const pads = mode === 'files' ? (padsInfo && padsInfo.count > 0 ? ' · My Pads' : ' · synth (no pads)') : '';
        text = `${kn} · ${formatValue('drone.gain', song.drone.gain)}${pads}`;
      }
    }
    setText(droneReadout, text);
    if (droneTile.el.querySelector('.ot-sub')?.textContent !== sub) droneTile.setSub(sub);
  }

  function renderPads(state) {
    const st = state.settings;
    const song = state.songs[st.currentSongId];
    const mode = song?.drone.mode;
    const locked = !!st.performLock;
    if (padsInfo && padsInfo.total > 0) {
      setText(padText, `My Pads: ${padsInfo.count} key${padsInfo.count === 1 ? '' : 's'} from ${padsInfo.total} file${padsInfo.total === 1 ? '' : 's'}`);
      setText(padBtn, ctx.rig?.isElectron && st.padFolder ? 'Rescan' : 'Change…');
    } else if (st.padFolder) {
      setText(padText, mode === 'files' ? 'Pad folder not connected — using the synth drone' : 'Pad folder chosen (not loaded yet)');
      setText(padBtn, 'Pad folder…');
    } else {
      setText(padText, mode === 'files' ? 'No pad folder — using the synth drone' : 'My Pads: no folder chosen');
      setText(padBtn, 'Choose folder…');
    }
    padStatus.classList.toggle('attention', mode === 'files' && !(padsInfo && padsInfo.count > 0));
    padBtn.disabled = locked && !(ctx.rig?.isElectron && padsInfo && padsInfo.total > 0);
  }

  function renderQuick() {
    const state = store.get();
    const st = state.settings;
    const song = state.songs[st.currentSongId] || null;
    const dl = song?.patch.fx?.delay;
    const a = status.audio;
    quick.set({
      songName: song ? song.name : '',
      tempo: song?.tempo ?? null,
      swell: song?.patch.swell?.seconds ?? 8,
      touch: st.velocitySens,
      pedalReversed: !!st.pedalInvert,
      pedal: pedalDown,
      sound: a === 'stalled' ? 'stalled' : a === 'restarting' ? 'restarting' : 'ok',
      latencyMs: Number(status.latencyMs) || null,
      locked: !!st.performLock,
      echoSynced: !dl || !(Number(dl.returnGain) > 0) ? null : dl.sync && dl.sync !== 'off',
    });
  }

  // ---------------------------------------------------------------- runtime lamps (pedal, faded, drone)
  let faded = false;
  let pedalDown = false;
  let pedalSince = 0;
  function setFaded(on) {
    faded = !!on;
    fadedChip.hidden = !faded;
    fadeBtn.classList.toggle('faded', faded);
    setText(fadeLabel, faded ? 'Faded — play to resume' : 'Fade out');
  }
  function readRuntime() {
    let p = false;
    let f = faded;
    try {
      p = !!engine?.pedal;
      const rs = typeof engine?.getRuntimeState === 'function' ? engine.getRuntimeState() : null;
      f = rs ? !!rs.faded : !!engine?._fade;
    } catch {
      /* engine not started */
    }
    const t = performance.now();
    if (p !== pedalDown) {
      pedalDown = p;
      pedalSince = t;
      if (quick.isOpen) quick.set({ pedal: p });
    }
    wheel.set({ pedal: pedalDown, pedalStuck: pedalDown && t - pedalSince > PEDAL_STUCK_MS });
    if (f !== faded) setFaded(f);
    renderDroneReadout();
  }
  // round2-ui #10: no polling while Perform is hidden (Edit); showing it again catches up within one tick
  const runtimeTimer = setInterval(() => {
    if (!root.hidden) readRuntime();
  }, 150);
  d.add(() => clearInterval(runtimeTimer));

  // ---------------------------------------------------------------- subscriptions
  d.add(store.subscribe((state) => renderSong(state)));
  d.add(
    controller.onStatus((s) => {
      const prevLoading = status.loading;
      const prevSong = status.songId;
      status = s;
      songBlock.classList.toggle('loading', !!s.loading);
      if (prevLoading !== s.loading || prevSong !== s.songId) {
        const st = store.get();
        setlist.set({ loadingId: s.loading ? s.songId : null, currentId: st.settings.currentSongId, currentIndex: store.currentIndex(), gap: gapOf(store.neighbors()) });
      }
      if (quick.isOpen) renderQuick();
    }),
  );
  d.listen(controller, 'wheel', (e) => {
    const det = e.detail || {};
    if (det.source === 'mod' || det.source === 'virtual') {
      if (det.pickup) wheel.set({ pickup: true, hardware: det.hardware });
      else wheel.set({ pickup: false });
    }
    if (det.source === 'expr') seen.expr = true;
    if (det.source === 'vol') seen.vol = true;
    wheelRaf.push();
  });
  d.listen(controller, 'action', (e) => {
    const det = e.detail || {};
    if (det.type === 'swell') wheelRaf.push();
    if (det.type === 'panic') {
      piano.releaseAll();
      bendValue = 0;
      wheel.set({ bend: 0 });
      wheelRaf.push();
      readRuntime();
    }
    if (det.type === 'fadeOutAll') setFaded(true);
    if (det.type === 'importBackup') {
      takeSnapshot(store.currentSong());
      renderSong(store.get());
    }
  });
  // round2-ui #8: snapshot = the song as the controller committed it (a plain deep copy from the controller)
  d.listen(controller, 'songSelected', (e) => {
    const det = e.detail || {};
    const song = det.songSnapshot || store.getSong(det.id);
    if (!song) return;
    takeSnapshot(song);
    quick.close(); // the sheet belongs to the song it was opened on (H concept §2 Quick sheet)
    renderSong(store.get());
  });
  // a second window taking over re-reads the library (store.reload): the old snapshot would write stale values back
  d.listen(controller, 'instance', (e) => {
    if (e.detail?.instance !== 'primary') return;
    takeSnapshot(store.currentSong());
    renderSong(store.get());
  });
  d.listen(controller, 'chord', (e) => {
    const c = e.detail ? e.detail.chord : null;
    chord.set(c);
    const n = String(c?.name || '').length;
    chord.el.dataset.len = n > 4 ? 'xl' : n > 2 ? 'l' : ''; // the chord column is narrow (H-v2: 116 px)
  });
  d.listen(controller, 'notes', (e) => {
    const held = e.detail ? e.detail.held : [];
    piano.set(held);
    if (faded && held && (held.size || held.length)) queueMicrotask(readRuntime);
  });
  d.listen(controller, 'pads', (e) => {
    padsInfo = e.detail || null;
    renderPads(store.get());
    renderDroneReadout();
  });
  // Instrument names: the registry is ready at start and changes on a My Samples rescan (engine-3 / shell-3); the
  // same four sources Edit listens to (round2-ui #6), so a new `user:` pack shows its name, not its id.
  const onInstruments = () => {
    const before = [...instNames].join('\u0001');
    refreshNames();
    if ([...instNames].join('\u0001') !== before) renderSong(store.get());
  };
  d.listen(controller, 'ready', onInstruments);
  if (engine) {
    d.listen(engine, 'ready', onInstruments);
    d.listen(engine, 'instruments', onInstruments);
  }
  d.listen(controller, 'instruments', onInstruments);
  d.listen(controller, 'user-samples', onInstruments);
  d.listen(window, 'rig-instruments-changed', onInstruments);
  d.listen(controller, 'song', () => {
    wheelRaf.push();
    renderDroneReadout();
  });
  if (midi) {
    d.listen(midi, 'bend', (e) => {
      const v = Number(e.detail?.value) || 0;
      if (Math.abs(v - bendValue) < 0.02 && v !== 0) return;
      bendValue = v;
      wheel.set({ bend: v });
    });
    // sustain pedal: reflect CC64 immediately (the engine's pedal state is polled as the source of truth)
    d.listen(midi, 'cc', (e) => {
      if (e.detail?.cc === 64) queueMicrotask(readRuntime);
    });
  }

  renderSong(store.get());
  songBlock.classList.toggle('loading', !!status.loading);
  readRuntime();

  return {
    el: perform,
    /** Test/debug: the snapshot "Revert song" restores. */
    get savedSnapshot() {
      return snap ? snap.song : null;
    },
    /** Test/debug: the paths that carry a "changed" dot (shared/song-diff.js). */
    get changedPaths() {
      return [...changed];
    },
    /** The top-bar Quick button. */
    toggleQuick() {
      if (quick.isOpen) quick.close();
      else openQuick();
    },
    openQuick,
    closeQuick: () => quick.close(),
    get quickOpen() {
      return quick.isOpen;
    },
    destroy() {
      d.dispose();
      for (const c of comps.splice(0)) c.destroy();
      root.replaceChildren();
    },
  };
}
