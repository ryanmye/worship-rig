// quickSheet(): Quick settings (H-v2 quick.png, OPTIONS.md "Quick settings"). A sheet that drops from the Quick
// button over the song header + setlist rows only; strips, drone, keyboard and PANIC stay visible and live, so an
// outside tap never closes it (Esc, ×, or the Quick button do).
//   This song (Revert undoes)  Tempo + big TAP, Swell time stepper            live under lock
//   This Mac (soundcheck)      Touch, live PEDAL DOWN light, pedal Reversed    frozen under lock
//   If something's wrong       Sound OK readout, hold-to-restart audio         live under lock
// The sheet only reports intents through callbacks; Perform writes the store / calls the controller.
import { h, setText, disposer } from './util.js';
import { stepper, segmented, toggle } from './buttons.js';
import { holdButton } from './holdButton.js';
import { openOverlay } from './overlay.js';
import { byId, resolveThemeId } from '../../shared/themes.js';

/** Touch options = settings.velocitySens (same words as Settings). */
export const TOUCH_OPTIONS = Object.freeze(
  [
    { value: 'soft', label: 'Light', title: 'Soft playing still sounds full' },
    { value: 'normal', label: 'Normal', title: 'Volume follows how hard you play' },
    { value: 'hard', label: 'Heavy', title: 'You have to dig in for full volume' },
    { value: 'fixed', label: 'Fixed', title: 'Every note plays at the same volume' },
  ].map(Object.freeze),
);

/**
 * BPM from tap timestamps (ms): mean interval of the last ≤ 4 taps; null with < 2 taps. Same rule as Edit's Tap
 * (edit.js bpmFromTaps), repeated here so Perform does not import the Edit view.
 * @param {number[]} taps
 * @returns {number|null}
 */
export function tapBpm(taps) {
  const t = taps.slice(-4);
  if (t.length < 2) return null;
  const iv = (t[t.length - 1] - t[0]) / (t.length - 1);
  return iv > 0 ? 60000 / iv : null;
}

/** "If something's wrong" headline per `sound` state (round4-perform P3). */
const SOUND_TEXT = {
  ok: 'Sound OK',
  stalled: 'Sound stalled',
  restarting: 'Restarting…',
  paused: 'Sound paused',
  muted: 'Muted (another window is open)',
};

/**
 * Quick settings sheet (hidden until open()).
 * @param {object} o
 * @param {HTMLElement} [o.anchor]              the Quick button: taps on it are "inside" (it toggles the sheet itself)
 * @param {(bpm:number) => void} [o.onTempo]    from TAP (30..300, rounded)
 * @param {(seconds:number) => void} [o.onSwell]
 * @param {(v:'soft'|'normal'|'hard'|'fixed') => void} [o.onTouch]
 * @param {(b:boolean) => void} [o.onPedalReversed]
 * @param {() => void} [o.onRestartAudio]       after the 1 s hold (or one click while the sound is stalled)
 * @param {() => void} [o.onResumeAudio]        one click while the sound is paused (falls back to onRestartAudio)
 * @param {() => void} [o.onAllSettings]
 * @param {() => void} [o.onTheme]           Theme row (default: event 'rig-open-settings' {section:'appearance'})
 * @param {(reason:string) => void} [o.onClose]
 * @param {object} [o.state]                    initial state, see set()
 * @returns {{el:HTMLElement, set(state:object):void, open(opts?:{focus?:boolean}):void, close():void,
 *            readonly isOpen:boolean, tap(now?:number):number|null, destroy():void}}
 */
export function quickSheet(o = {}) {
  const d = disposer();
  const call = (fn, ...a) => {
    if (typeof fn === 'function') fn(...a);
  };
  const st = {
    songName: '',
    tempo: null,
    swell: 8,
    touch: 'normal',
    pedal: false,
    pedalReversed: false,
    sound: 'ok',
    latencyMs: null,
    locked: false,
    echoSynced: null,
  };

  // ---- header
  const lockNote = h(
    'span.qs-lock',
    {},
    // onboarding O8: "frozen" read as a fault; say what the lock does to each half
    'Under Lock: ',
    h('b', { text: 'This song' }),
    ' still works, ',
    h('b', { text: 'This Mac' }),
    ' can’t be changed',
  );
  const allBtn = h('button.btn.qs-all', { type: 'button', text: 'All settings' });
  const xBtn = h('button.qs-x', { type: 'button', 'aria-label': 'Close Quick settings', title: 'Close' }, '×');
  const head = h(
    'div.qs-h',
    {},
    h('h2', { text: 'Quick settings' }),
    h('span.qs-sub', { text: 'Changes apply now. Keep playing.' }),
    lockNote,
    allBtn,
    xBtn,
  );

  // ---- This song
  const scope = h('span.qs-scope');
  const bpm = h('span.qs-bpm');
  const tapBtn = h('button.qs-tap', { type: 'button', title: 'Tap along 4 times', 'data-testid': 'quick-tap' }, 'TAP');
  const tempoHint = h('span.qs-tempo-hint');
  const swell = stepper({
    min: 1,
    max: 60,
    step: 1,
    value: st.swell,
    label: 'Swell time',
    format: (v) => `${v} s`,
    onChange: (v) => call(o.onSwell, v),
  });
  d.add(() => swell.destroy());
  const secSong = h(
    'section.qs-sec',
    { 'aria-label': 'This song' },
    h('div.qs-st', {}, h('span.cap', { text: 'This song' }), scope),
    h(
      'div.qs-row',
      {},
      h('div.qs-lbl', {}, h('b', { text: 'Tempo' }), h('small', { text: 'synced echoes follow' })),
      h('div.qs-tempo', {}, bpm, tapBtn, tempoHint),
    ),
    h(
      'div.qs-row',
      {},
      h('div.qs-lbl', {}, h('b', { text: 'Swell time' }), h('small', { text: 'length of ◢ Swell' })),
      swell.el,
    ),
  );

  // ---- This Mac
  const touch = segmented({
    options: TOUCH_OPTIONS,
    value: st.touch,
    label: 'Touch',
    onChange: (v) => call(o.onTouch, v),
  });
  const reversed = toggle({
    label: 'Reversed',
    value: false,
    title: 'Turn on if notes hold when your foot is off the pedal',
    onChange: (v) => call(o.onPedalReversed, v),
  });
  d.add(() => touch.destroy());
  d.add(() => reversed.destroy());
  const pedalLamp = h(
    'span.qs-pedal',
    { role: 'status', 'aria-label': 'Sustain pedal' },
    h('i', { 'aria-hidden': 'true' }),
    h('span', { text: 'PEDAL DOWN' }),
  );
  // themes-setup: a compact "Theme: <name> ▸" in This Mac's caption row (no extra row: the sheet's height is fixed).
  // It opens Settings › Appearance (o.onTheme overrides; else a DOM event main.js answers, since this sheet has no
  // ctx). The name comes from html[data-theme], which boot.js / applyTheme set.
  const themeBtn = h('button.qs-theme', { type: 'button', 'data-testid': 'quick-theme',
    title: 'Choose a theme in Settings › Appearance' });
  const secMac = h(
    'section.qs-sec',
    { 'aria-label': 'This Mac' },
    h(
      'div.qs-st',
      {},
      h('span.cap', { text: 'This Mac' }),
      h('span.qs-scope', { text: 'every song · soundcheck settings' }),
      themeBtn,
    ),
    h(
      'div.qs-row',
      {},
      h('div.qs-lbl', {}, h('b', { text: 'Touch' }), h('small', { text: 'how hard to play' })),
      touch.el,
    ),
    h(
      'div.qs-row',
      {},
      h('div.qs-lbl', {}, h('b', { text: 'Sustain pedal' }), h('small', {
        text: 'press it: the light comes on',
        title: 'Press your pedal: the light should come on. If it is on while your foot is up, turn on Reversed.',
      })),
      h('div.qs-pedalrow', {}, pedalLamp, reversed.el),
    ),
  );

  // ---- If something's wrong
  const okLine = h(
    'div.qs-ok',
    { role: 'status' },
    h('i.led', { 'aria-hidden': 'true' }),
    h('span.qs-ok-t'),
    h('small'),
  );
  const restartHold = holdButton({
    ms: 1000,
    label: 'Hold to restart audio',
    holdText: 'keep holding… (1 s)',
    className: 'qs-restart-hold',
    title: 'Press and hold for 1 second: restarts the audio engine (a short gap in the sound)',
    onActivate: () => call(o.onRestartAudio),
  });
  d.add(() => restartHold.destroy());
  const restartNow = h(
    'button.qs-restart',
    { type: 'button', hidden: true, 'data-testid': 'quick-restart' },
    'Restart audio',
  );
  const secFix = h(
    'section.qs-sec',
    { 'aria-label': 'If something’s wrong' },
    h('div.qs-st', {}, h('span.cap', { text: 'If something’s wrong' })),
    okLine,
    restartHold.el,
    restartNow,
  );

  const el = h(
    'aside.qs',
    {
      role: 'group',
      'aria-label': 'Quick settings',
      'data-perform-overlay': '',
      hidden: true,
      'data-testid': 'quick-sheet',
    },
    head,
    h('div.qs-b', {}, secSong, secMac, secFix),
  );

  // ---- behaviour
  let taps = [];
  const tap = (now = performance.now()) => {
    if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
    taps.push(now);
    taps = taps.slice(-4);
    tapBtn.classList.remove('flash');
    void tapBtn.offsetWidth;
    tapBtn.classList.add('flash');
    const b = tapBpm(taps);
    if (b === null || b < 30 || b > 300) return null;
    const r = Math.round(b);
    call(o.onTempo, r);
    return r;
  };
  d.listen(tapBtn, 'click', () => tap());
  d.listen(restartNow, 'click', () =>
    call(st.sound === 'paused' && o.onResumeAudio ? o.onResumeAudio : o.onRestartAudio));
  d.listen(allBtn, 'click', () => call(o.onAllSettings));
  d.listen(themeBtn, 'click', () => {
    if (typeof o.onTheme === 'function') return o.onTheme();
    closeOverlay?.('api');
    document.dispatchEvent(new CustomEvent('rig-open-settings', { detail: { section: 'appearance' } }));
  });
  let closeOverlay = null;
  d.listen(xBtn, 'click', () => closeOverlay?.('api'));

  const render = () => {
    setText(scope, st.songName ? `saved with “${st.songName}” · Revert undoes` : 'Revert undoes');
    bpm.replaceChildren(
      document.createTextNode(st.tempo ? String(Math.round(st.tempo)) : '—'),
      h('small', { text: 'BPM' }),
    );
    tempoHint.replaceChildren(
      'Tap along 4×.',
      h('br'),
      st.echoSynced === true
        ? 'The echo follows the tempo.'
        : st.echoSynced === false
          ? 'This song’s echo keeps its own time.' // onboarding O8: "fixed" read as "repaired"
          : '',
    );
    swell.set(st.swell);
    touch.set(st.touch);
    reversed.set(st.pedalReversed);
    pedalLamp.classList.toggle('on', !!st.pedal);
    pedalLamp.setAttribute('aria-label', st.pedal ? 'Sustain pedal: down' : 'Sustain pedal: up');
    // round4-perform P3: the sheet says what the top bar says. 'paused' (context suspended) and 'muted' (a second
    // window) are not OK; paused offers one click to resume, muted has nothing to restart here.
    const sound = SOUND_TEXT[st.sound] ? st.sound : 'ok';
    const bad = sound !== 'ok';
    const oneClick = sound === 'stalled' || sound === 'restarting' || sound === 'paused';
    okLine.classList.toggle('bad', bad);
    okLine.dataset.sound = sound;
    okLine.querySelector('.led').className = `led ${bad ? 'warn' : 'ok'}`;
    setText(okLine.querySelector('.qs-ok-t'), SOUND_TEXT[sound]);
    setText(
      okLine.querySelector('small'),
      !bad && Number.isFinite(st.latencyMs) ? ` · ${Math.round(st.latencyMs)} ms` : '',
    );
    // stalled / paused: Restart is a normal one-click primary button (quick.png problem state); OK: hold, so a stray
    // tap can't
    restartHold.el.hidden = oneClick;
    restartNow.hidden = !oneClick;
    restartNow.disabled = sound === 'restarting';
    setText(restartNow, sound === 'paused' ? 'Resume sound' : 'Restart audio');
    // lock: This Mac + All settings are frozen; This song and restart stay live (concept §1.3)
    touch.setDisabled(st.locked);
    reversed.setDisabled(st.locked);
    allBtn.disabled = !!st.locked;
    const theme = byId(resolveThemeId(document.documentElement.dataset.theme));
    setText(themeBtn, `Theme: ${theme.name} ▸`);
    themeBtn.disabled = !!st.locked;
    secMac.classList.toggle('frozen', !!st.locked);
    el.classList.toggle('locked', !!st.locked);
  };

  const open = ({ focus = false } = {}) => {
    if (closeOverlay) return;
    el.hidden = false;
    o.anchor?.setAttribute('aria-expanded', 'true');
    closeOverlay = openOverlay({
      el,
      anchors: o.anchor ? [o.anchor] : [],
      closeOnOutside: false,
      group: 'quick',
      onClose: (reason) => {
        closeOverlay = null;
        restartHold.cancel();
        el.hidden = true;
        o.anchor?.setAttribute('aria-expanded', 'false');
        if (reason === 'escape' && el.contains(document.activeElement)) o.anchor?.focus();
        call(o.onClose, reason);
      },
    });
    if (focus) tapBtn.focus();
  };
  d.add(() => closeOverlay?.('api'));
  Object.assign(st, o.state || {});
  render();
  return {
    el,
    set(state) {
      Object.assign(st, state || {});
      render();
    },
    open,
    close() {
      closeOverlay?.('api');
    },
    get isOpen() {
      return !!closeOverlay;
    },
    tap,
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}
