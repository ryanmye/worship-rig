// Settings (SPEC §10 Settings, §13). mountSettings(el, ctx) → { destroy, open(), close() }.
// A modal panel over the current view. Everything persisted goes through ctx.store.set('settings.*') (the controller
// reacts: latency → engine.restart, output → setSinkId, mono → setMono, MIDI input → midi.select); transient actions
// (restart audio, MIDI learn, pads) go through ctx.controller.
import { loadComponents, markDialog } from './_fallback-components.js';
import { LEARNABLE, ROLE_DEFAULTS } from '../shared/params.js';
import { noteName } from '../shared/music.js';
import { pickableThemes, resolveThemeId } from '../shared/themes.js';
import { latencyHint } from './components/latencyHint.js';

const C = await loadComponents();

// ---------------------------------------------------------------------------------------------------------------
export const LEARN_NAMES = Object.freeze({
  'slots.0.gain': `${ROLE_DEFAULTS[0].name} level`,
  'slots.1.gain': `${ROLE_DEFAULTS[1].name} level`,
  'slots.2.gain': `${ROLE_DEFAULTS[2].name} level`,
  'slots.3.gain': `${ROLE_DEFAULTS[3].name} level`,
  'drone.gain': 'Drone level',
  'fx.reverb.returnGain': 'Space level', // polish-2B: the name Edit's Wheels & pedal uses (lib.TARGET_LABELS)
  'master.volume': 'Master volume',
  nextSong: 'Next song',
  prevSong: 'Previous song',
  panic: 'Panic (all notes off)',
  fadeOutAll: 'Fade out all',
  swell: 'Swell',
});
/** Rows of the Learn table: params.LEARNABLE, plus 'swell' (the controller accepts it; see CONTRACT_CHANGES shell #4). */
export const LEARN_ROWS = Object.freeze([...LEARNABLE, ...(LEARNABLE.includes('swell') ? [] : ['swell'])]);
const LATENCY_OPTS = [
  { value: 'lowest', label: 'Lowest' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'safe', label: 'Safe' },
];
const VEL_OPTS = [
  { value: 'soft', label: 'Light', title: 'Soft playing still sounds full' },
  { value: 'normal', label: 'Normal', title: 'Volume follows how hard you play' },
  { value: 'hard', label: 'Heavy', title: 'You have to dig in for full volume' },
  { value: 'fixed', label: 'Fixed', title: 'Every note plays at the same volume' },
];
/** Plain-words explanation of each velocity setting (shown under the control). */
export const VEL_HINTS = Object.freeze({
  soft: 'Light: soft playing still sounds full — good for a light or unweighted keyboard.',
  normal: 'Normal: the harder you play, the louder it gets.',
  hard: 'Heavy: you have to play firmly for full volume — good for a heavy hand or a very sensitive keyboard.',
  fixed: 'Fixed: every note plays at the same volume, however hard you press.',
});
export const LEARN_MESSAGES = Object.freeze({
  'sustain-pedal-reserved': 'That’s the sustain pedal — it always sustains and can’t be mapped. Use another knob, fader, pedal or pad.',
});
export const GARAGEBAND_DOC = 'docs/garageband-import.md';

/**
 * Settings › MIDI line while Web MIDI is not available (polish-2A, "## l3" UI follow-up). 'pending' is Chrome's
 * permission prompt (or a slow CoreMIDI) and attaches by itself, so it is info with no reload advice; 'denied' points
 * at the site settings; 'failed' keeps the unplug / replug advice.
 * @param {{reason?:string|null, pending?:boolean}} m  controller.status.midi
 * @param {boolean} [electron]
 * @returns {string}
 */
export function midiStatusText(m, electron = false) {
  const reason = m && (m.pending ? 'pending' : m.reason);
  if (reason === 'pending') return 'MIDI starting… answer the browser’s permission prompt if it appears.';
  if (reason === 'denied') {
    // the app grants MIDI itself (main.js permission handler), so there is no site setting to point at there
    return electron ? 'MIDI access was denied.' : 'MIDI was blocked — allow it in the browser’s site settings.';
  }
  if (reason === 'unsupported') return 'This browser has no Web MIDI — use Chrome or the Worship Rig app.';
  if (reason) return 'MIDI could not start — unplug and replug the keyboard, then reload.';
  return 'MIDI starting…';
}
const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|aac|aif|aiff|flac|webm)$/i;

/** "CC 20 · ch 1" / "Note C4 · any ch" / "—" */
export function mappingText(m) {
  if (!m) return '—';
  const what = Number.isInteger(m.cc) ? `CC ${m.cc}` : Number.isInteger(m.note) ? `Note ${noteName(m.note)}` : '?';
  const ch = m.channel === null || m.channel === undefined ? 'any ch' : `ch ${m.channel + 1}`;
  return `${what} · ${ch}`;
}

/** Pedal polarity from the first CC64 value after "press your pedal": < 64 on press → reversed. */
export function inferPedalInvert(firstValue) {
  return Number(firstValue) < 64;
}

/**
 * hardware-fixes: polarity from BOTH states of the pedal (the settled CC64 value while held down, then after letting
 * go). One value can't tell a reversed pedal from a keyboard that read the pedal's direction while it was held at
 * plug-in, or from a foot that let go early; the pair can: the states must fall on opposite sides of 64.
 * @param {number} down  CC64 value while pressed
 * @param {number} up    CC64 value after release
 * @returns {boolean|null} true = reversed, false = normal, null = the two states read the same (no verdict)
 */
export function inferPedalPolarity(down, up) {
  const d = Number(down) >= 64;
  const u = Number(up) >= 64;
  if (!Number.isFinite(Number(down)) || !Number.isFinite(Number(up)) || d === u) return null;
  return !d;
}

function h(tag, attrs = {}, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag) || [];
  const e = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') e.classList.add(part.slice(1));
    else e.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') e.textContent = String(v);
    else if (k === 'class') e.classList.add(...String(v).split(/\s+/).filter(Boolean));
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k === 'on') for (const [t, fn] of Object.entries(v)) e.addEventListener(t, fn);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}
const btn = (text, on, attrs = {}) => h('button.ed-btn', { type: 'button', ...attrs, on: { click: on } }, text);
const setText = (e, t) => {
  const s = String(t);
  if (e.textContent !== s) e.textContent = s;
};
function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = h('a', { href: url, download: filename });
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// IndexedDB: remember the Chrome pad-folder handle (SPEC §7 "showDirectoryPicker handle in IndexedDB")
const IDB_NAME = 'worship-rig-ui';
function idb(mode, fn) {
  return new Promise((resolve) => {
    if (!globalThis.indexedDB) return resolve(null);
    let req;
    try {
      req = indexedDB.open(IDB_NAME, 1);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction('handles', mode);
        const r = fn(tx.objectStore('handles'));
        tx.oncomplete = () => {
          db.close();
          resolve(r && 'result' in r ? r.result : null);
        };
        tx.onerror = () => {
          db.close();
          resolve(null);
        };
      } catch {
        db.close();
        resolve(null);
      }
    };
  });
}
const saveHandle = (hd) => idb('readwrite', (s) => s.put(hd, 'padFolder'));
const loadHandle = () => idb('readonly', (s) => s.get('padFolder'));

async function listDirectory(handle, prefix = '', depth = 0, out = []) {
  for await (const entry of handle.values()) {
    if (entry.kind === 'file' && AUDIO_EXT.test(entry.name)) {
      const f = await entry.getFile();
      out.push({ name: entry.name, path: prefix + entry.name, file: f });
    } else if (entry.kind === 'directory' && depth < 2 && !entry.name.startsWith('.')) {
      await listDirectory(entry, `${prefix}${entry.name}/`, depth + 1, out);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
/**
 * @param {HTMLElement} el  mount point (#view-settings; hidden while closed)
 * @param {{store, controller, engine, midi?, recorder?, toast?, openSettings?, closeSettings?, setView?}} ctx
 * @returns {{destroy():void, open():void, close():void, isOpen:boolean}}
 */
export function mountSettings(el, ctx) {
  const { store, controller, engine, midi } = ctx;
  const rig = globalThis.rig || null;
  const isElectron = !!(rig && rig.isElectron);
  const toast = (msg, kind = 'info') => {
    if (typeof ctx.toast === 'function') ctx.toast(msg, kind);
  };
  const cleanups = [];
  const listen = (target, type, fn, opts) => {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };
  const comps = [];
  const settingBinds = []; // {key, apply(settings)}
  const S = () => store.get().settings;
  let isOpen = false;
  let statsTimer = null;
  let prevFocus = null;

  // ---- generic setting controls
  function bindSetting(key, comp) {
    comp.el.dataset.bind = `settings.${key}`;
    comps.push(comp);
    const apply = (s) => comp.set(s[key]);
    settingBinds.push({ key, apply });
    apply(S());
    return comp;
  }
  const seg = (key, options, label) => bindSetting(key, C.segmented({ label, options, onChange: (v) => store.set(`settings.${key}`, v) }));
  const tog = (key, label) => bindSetting(key, C.toggle({ label, onChange: (v) => store.set(`settings.${key}`, !!v) }));
  // H-v2 two-chip Perform strips: settings.performChips 4 | 2 (unknown settings are kept by the store; unset = 4)
  const performChips = C.segmented({
    label: 'Chips per sound',
    options: [
      { value: 4, label: '4 chips' },
      { value: 2, label: '2 chips' },
    ],
    onChange: (v) => store.set('settings.performChips', v === 2 ? 2 : 4),
  });
  performChips.el.dataset.bind = 'settings.performChips';
  performChips.el.dataset.testid = 'setting-perform-chips';
  comps.push(performChips);
  settingBinds.push({ key: 'performChips', apply: (s) => performChips.set(s.performChips === 2 ? 2 : 4) });
  performChips.set(S().performChips === 2 ? 2 : 4);
  const row = (label, control, hint) =>
    h('div.st-row', {}, h('div.st-label', {}, h('span', { text: label }), hint ? h('span.st-hint', { text: hint }) : null), h('div.st-control', {}, control));

  // ---- skeleton
  const titleId = `st-title-${Math.random().toString(36).slice(2, 8)}`;
  // User-initiated close goes through ctx.closeSettings (main.js keeps its own open flag and calls our close());
  // close() itself never calls back into ctx, so there is no recursion.
  const requestClose = () => {
    if (typeof ctx.closeSettings === 'function') {
      try {
        ctx.closeSettings();
      } catch (err) {
        console.warn('[settings] closeSettings failed', err);
      }
    }
    if (isOpen) close();
  };
  const closeBtn = btn('Close', requestClose, { class: 'st-close', 'aria-label': 'Close settings' });
  const colA = h('div.st-col');
  const colB = h('div.st-col');
  const body = h('div.st-body', {}, colA, colB);
  const dialog = h('div.st-dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: -1 },
    h('header.st-head', {}, h('h1.st-title', { id: titleId, text: 'Settings' }), closeBtn),
    body,
  );
  const backdrop = h('div.st-backdrop', { 'aria-hidden': 'true' });
  el.classList.add('st-host');
  el.replaceChildren(backdrop, dialog);
  el.hidden = true;
  el.__rigCtx = ctx;
  listen(backdrop, 'click', requestClose);
  // Esc closes wherever focus is (it may have fallen to <body>); preventDefault keeps the controller from
  // treating it as Panic. main.js has its own capture listener; whichever runs first closes, the other no-ops.
  listen(window, 'keydown', (e) => {
    if (!isOpen || e.key !== 'Escape') return;
    e.preventDefault();
    requestClose();
  }, true);
  listen(el, 'keydown', (e) => {
    if (e.key === 'Tab') {
      const f = [...dialog.querySelectorAll('button:not([disabled]),select:not([disabled]),input:not([disabled]):not([type=hidden]),[tabindex="0"]')].filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  // =============================================================================================================
  // Audio
  // =============================================================================================================
  const latencyInfo = h('span.st-status');
  // hardware-fixes: > 60 ms output latency (Bluetooth) gets a one-line hint, dismissed per output device name
  const latencyWarn = latencyHint({ className: 'st-latency-warn', testid: 'settings-latency-hint' });
  cleanups.push(() => latencyWarn.destroy());
  settingBinds.push({ key: 'outputDeviceId', apply: (st) => latencyWarn.set({ deviceId: st.outputDeviceId }) });
  const outputSelect = h('select.ed-select.st-output', { 'aria-label': 'Audio output' });
  const outputNote = h('p.st-hint');
  const labelsBtn = btn('Show device names', askLabels, { hidden: true, class: 'st-labels' });
  outputSelect.dataset.bind = 'settings.outputDeviceId';
  listen(outputSelect, 'change', () => store.set('settings.outputDeviceId', outputSelect.value || 'default'));
  settingBinds.push({ key: 'outputDeviceId', apply: (s) => populateOutputs(s.outputDeviceId, false) });
  let outputs = [];

  async function enumerateOutputs() {
    const md = navigator.mediaDevices;
    if (!md || typeof md.enumerateDevices !== 'function') return null;
    try {
      return (await md.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
    } catch (err) {
      console.warn('[settings] enumerateDevices failed', err);
      return null;
    }
  }
  async function refreshOutputs() {
    const list = await enumerateOutputs();
    outputs = list || [];
    populateOutputs(S().outputDeviceId, list === null);
  }
  function populateOutputs(selected, unsupported) {
    const opts = [h('option', { value: 'default', text: 'System default' })];
    let n = 0;
    let unlabeled = false;
    for (const d of outputs) {
      if (d.deviceId === 'default' || d.deviceId === 'communications' || !d.deviceId) continue;
      n += 1;
      if (!d.label) unlabeled = true;
      opts.push(h('option', { value: d.deviceId, text: d.label || `Output ${n} (${d.deviceId.slice(0, 8)}…)` }));
    }
    const sel = selected || 'default';
    if (sel !== 'default' && !outputs.some((d) => d.deviceId === sel)) opts.push(h('option', { value: sel, text: `Not connected (${sel.slice(0, 8)}…)` }));
    outputSelect.replaceChildren(...opts);
    outputSelect.value = sel;
    labelsBtn.hidden = !unlabeled;
    const canSink = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
    setText(
      outputNote,
      unsupported
        ? 'This browser cannot list audio outputs; audio uses the system default.'
        : canSink
          ? unlabeled
            ? 'Device names are hidden until you allow it (nothing is recorded).'
            : ''
          : 'Switching output restarts audio in this browser.',
    );
  }
  async function askLabels() {
    // Chrome only reveals output labels after a media permission; open and immediately stop a stream.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const t of stream.getTracks()) t.stop();
    } catch (err) {
      console.warn('[settings] device labels', err);
      toast('Device names stay hidden unless you allow the browser to show them.', 'warn');
    }
    refreshOutputs();
  }
  if (navigator.mediaDevices) listen(navigator.mediaDevices, 'devicechange', () => isOpen && refreshOutputs());

  const restartBtn = btn('Restart audio', async () => {
    restartBtn.disabled = true;
    try {
      const ok = await controller.restartAudio();
      toast(ok ? 'Audio restarted' : 'Audio restart failed', ok ? 'info' : 'error');
    } finally {
      restartBtn.disabled = false;
    }
  }, { class: 'st-restart' });
  // lowres2-scope (Ryan 2026-09-30): audio sleep only runs inside low-resource mode, so the "Sleep audio after" row is
  // gone; settings.audioSleepSec (absent = 30 s) stays in the store as the low-resource idle window, with no UI.
  const asleepNote = h('p.st-hint', { hidden: true, text: 'Audio asleep — play a note or press a key to wake' });

  colA.append(
    h('section.st-section', { 'aria-label': 'Audio' },
      h('h2.st-h2', { text: 'Audio' }),
      row('Latency', h('div.st-inline', {}, seg('latency', LATENCY_OPTS, 'Latency').el, latencyInfo), 'Lower = more responsive; raise it if you hear crackles. Changing it restarts audio for a moment.'),
      latencyWarn.el,
      row('Output device', h('div.st-inline', {}, outputSelect, labelsBtn), null),
      outputNote,
      row('Mono output', tog('monoOutput', 'Mono').el, 'Sum to mono for a single speaker or a mono PA feed.'),
      row('Audio engine', restartBtn, 'Use if sound stops or after changing audio hardware.'),
      asleepNote,
    ),
  );

  // =============================================================================================================
  // MIDI
  // =============================================================================================================
  const midiStatus = h('span.st-status');
  const midiSelect = h('select.ed-select.st-midi-input', { 'aria-label': 'MIDI input' });
  midiSelect.dataset.bind = 'settings.midiInputId';
  listen(midiSelect, 'change', () => store.set('settings.midiInputId', midiSelect.value || 'first'));
  function populateMidi() {
    const sel = S().midiInputId || 'first';
    const inputs = midi ? midi.inputs : [];
    const opts = [h('option', { value: 'first', text: 'First keyboard (automatic)' }), h('option', { value: 'all', text: 'All inputs' })];
    for (const i of inputs) opts.push(h('option', { value: i.id, text: `${i.name}${i.virtual ? ' (virtual)' : ''}${i.state === 'disconnected' ? ' — unplugged' : ''}` }));
    if (sel !== 'first' && sel !== 'all' && !inputs.some((i) => i.id === sel)) opts.push(h('option', { value: sel, text: 'Saved keyboard (not connected)' }));
    midiSelect.replaceChildren(...opts);
    midiSelect.value = sel;
  }
  settingBinds.push({ key: 'midiInputId', apply: populateMidi });
  listen(midi, 'devices', populateMidi);

  // pedal polarity detector. hardware-fixes (hardware pass: the one-value test depended on the pedal's state when the
  // keyboard was plugged in): press → settle → release → settle, and the verdict comes from the pair
  const pedalBox = h('div.st-pedal', { 'aria-live': 'polite' });
  const PEDAL_SETTLE_MS = 300; // a half-pedal / continuous pedal sends a run of values; take the one it rests on
  const PEDAL_WAIT_MS = 15000;
  let pedalListener = null;
  let pedalTimer = null;
  let pedalSettle = null;
  function stopPedalTest() {
    if (pedalListener && midi) midi.removeEventListener('cc', pedalListener);
    pedalListener = null;
    clearTimeout(pedalTimer);
    clearTimeout(pedalSettle);
    pedalTimer = null;
    pedalSettle = null;
  }
  /** Replace the pedal box content without dropping keyboard focus to <body>. */
  function pedalShow(...kids) {
    const hadFocus = pedalBox.contains(document.activeElement);
    pedalBox.replaceChildren(...kids.filter(Boolean));
    if (hadFocus) pedalBox.querySelector('button')?.focus();
  }
  // hardware pass (local, 2026-09-29): many keyboards read the pedal's direction when they power up or the pedal is
  // plugged in, so a pedal held down then reads backwards; the test says so before and after
  const PEDAL_TIP = 'Plug in the pedal and the keyboard with your foot off the pedal (pedal UP): many keyboards read '
    + 'its direction then.';
  const PEDAL_NONE = 'No pedal message received. Is the pedal in the keyboard’s SUSTAIN jack and the keyboard selected above?';
  function pedalIdle(msg) {
    pedalShow(btn('Test my pedal', startPedalTest, { class: 'st-pedal-test' }), h('span.st-hint', { text: msg || PEDAL_TIP }));
  }
  function pedalCancelBtn() {
    return btn('Cancel', () => {
      stopPedalTest();
      pedalIdle();
    });
  }
  /**
   * One step of the test: show `prompt`, then call done(value, tapped) with the CC64 value the pedal settles on (no
   * CC64 for PEDAL_SETTLE_MS). `differentFrom`: ignore values on the same side of 64 as this one (a release step
   * waits for the pedal to actually come up). `tapped`: the pedal went down and up again within the step (a switch
   * pedal's 0/127 flipped once, or any pedal crossed 64 twice). Times out to the "no pedal message" line.
   */
  function pedalStep(step, prompt, differentFrom, done) {
    stopPedalTest();
    pedalShow(h('strong.st-pedal-prompt', { dataset: { step }, text: prompt }), pedalCancelBtn());
    let last = null;
    let flips = 0;
    let extremesOnly = true;
    pedalListener = (e) => {
      const d = e.detail || {};
      if (d.cc !== 64) return;
      const v = Number(d.value);
      if (differentFrom !== null && last === null && (v >= 64) === (differentFrom >= 64)) return;
      if (last !== null && (v >= 64) !== (last >= 64)) flips += 1;
      if (v > 1 && v < 126) extremesOnly = false;
      last = v;
      clearTimeout(pedalSettle);
      pedalSettle = setTimeout(() => {
        stopPedalTest();
        done(last, flips >= 2 || (flips === 1 && extremesOnly));
      }, PEDAL_SETTLE_MS);
    };
    midi.addEventListener('cc', pedalListener);
    pedalTimer = setTimeout(() => {
      stopPedalTest();
      pedalIdle(PEDAL_NONE);
    }, PEDAL_WAIT_MS);
  }
  function startPedalTest() {
    if (!midi) {
      pedalIdle('MIDI is not available.');
      return;
    }
    pressStep('Press your sustain pedal now and keep it down…');
  }
  function pressStep(prompt) {
    pedalStep('press', prompt, null, (down, tapped) => {
      // a quick tap ends on the released value: ask again rather than read it as "pressed"
      if (tapped) return pressStep('Press the pedal and keep it down until “Now let go” appears…');
      pedalStep('release', 'Now let go of the pedal…', down, (up) => pedalResult(down, up));
    });
  }
  function pedalResult(down, up) {
    const invert = inferPedalPolarity(down, up);
    const kids = [];
    if (invert === null) {
      kids.push(h('span.st-pedal-result', { dataset: { invert: 'unknown' },
        text: `Your pedal sent ${down} pressed and ${up} released — that doesn’t tell which way round it is. Keep it `
          + 'down until “Now let go” appears, then test again.' }));
    } else {
      const cur = !!S().pedalInvert;
      const msg = invert
        ? `Your pedal sent ${down} pressed and ${up} released — it works the other way round. If it was held down `
          + 'when the keyboard was switched on or plugged in, let go, unplug and replug the keyboard, and test again first.'
        : `Your pedal sent ${down} pressed and ${up} released — normal polarity.`;
      kids.push(h('span.st-pedal-result', { dataset: { invert: String(invert) }, text: msg }));
      if (invert !== cur) {
        kids.push(btn(invert ? 'Invert pedal' : 'Turn invert off', () => {
          store.set('settings.pedalInvert', invert);
          pedalIdle(invert ? 'Pedal inverted. Press it again to check sustain.' : 'Pedal set to normal.');
        }, { class: 'st-pedal-apply' }));
      } else kids.push(h('span.st-hint', { text: 'Your setting is already right.' }));
    }
    kids.push(btn('Test again', startPedalTest, { class: 'st-pedal-again' }));
    pedalShow(...kids);
  }
  pedalIdle();

  const velHint = h('p.st-hint.st-vel-hint', { 'aria-live': 'polite' });
  settingBinds.push({ key: 'velocitySens', apply: (s) => setText(velHint, VEL_HINTS[s.velocitySens] || VEL_HINTS.normal) });

  // MIDI Learn table
  const learnBody = h('tbody');
  const learnCells = new Map(); // id → {map, learnBtn}
  const learnNotes = new Map(); // id → message shown in the row for a few seconds (e.g. sustain pedal refused)
  let learningId = null;
  for (const id of LEARN_ROWS) {
    const map = h('td.st-map', { text: '—' });
    const learnBtn = btn('Learn', () => toggleLearn(id), { class: 'st-learn', 'aria-label': `Learn ${LEARN_NAMES[id] || id}`, disabled: !midi });
    const clearBtn = btn('Clear', () => {
      if (typeof controller.clearLearn === 'function') controller.clearLearn(id);
      else store.setMidiLearn(id, null);
    }, { class: 'st-clear', 'aria-label': `Clear ${LEARN_NAMES[id] || id}` });
    learnBody.append(h('tr', { dataset: { control: id } }, h('th', { scope: 'row', text: LEARN_NAMES[id] || id }), map, h('td.st-learn-btns', {}, learnBtn, clearBtn)));
    learnCells.set(id, { map, learnBtn, clearBtn });
  }
  function renderLearn(s = S()) {
    const ml = s.midiLearn || {};
    for (const [id, c] of learnCells) {
      if (id === learningId) {
        setText(c.map, 'Move a knob/fader or press a key/pad…');
        setText(c.learnBtn, 'Cancel');
        c.learnBtn.classList.add('on');
      } else {
        const note = learnNotes.get(id);
        setText(c.map, note || mappingText(ml[id]));
        c.map.classList.toggle('st-map-note', !!note);
        setText(c.learnBtn, 'Learn');
        c.learnBtn.classList.remove('on');
      }
      c.clearBtn.disabled = !ml[id];
    }
  }
  settingBinds.push({ key: 'midiLearn', apply: renderLearn });
  async function toggleLearn(id) {
    if (learningId === id) {
      learningId = null;
      if (typeof controller.cancelLearn === 'function') controller.cancelLearn();
      else midi?.cancelLearn?.();
      renderLearn();
      return;
    }
    learningId = id;
    learnNotes.delete(id);
    renderLearn();
    let r = null;
    try {
      if (typeof controller.learn === 'function') r = await controller.learn(id);
      else if (midi) {
        const res = await midi.learn(id);
        if (res) {
          r = res.cc !== undefined ? { cc: res.cc, channel: res.channel } : { note: res.note, channel: res.channel };
          store.setMidiLearn(id, r);
        }
      }
    } catch (err) {
      console.warn('[settings] learn failed', err);
    }
    if (learningId === id) {
      learningId = null;
      if (r && r.error) {
        const msg = LEARN_MESSAGES[r.error] || 'That control can’t be used here — try a different one.';
        learnNotes.set(id, msg);
        setTimeout(() => {
          if (learnNotes.get(id) === msg) {
            learnNotes.delete(id);
            renderLearn();
          }
        }, 6000);
        toast(msg, 'warn');
      } else if (r) toast(`${LEARN_NAMES[id] || id} → ${mappingText(r)}`);
      else toast('Nothing was received — press Learn and try again', 'warn');
    }
    renderLearn();
  }

  colB.append(
    h('section.st-section', { 'aria-label': 'MIDI' },
      h('h2.st-h2', { text: 'MIDI keyboard' }),
      row('Input', h('div.st-inline', {}, midiSelect, midiStatus)),
      row('Touch', seg('velocitySens', VEL_OPTS, 'Touch sensitivity').el, 'How hard you have to play for full volume.'),
      velHint,
      row('Sustain pedal', h('div.st-inline', {}, tog('pedalInvert', 'Reversed').el), 'If notes hold when your foot is off the pedal, turn this on — or let the test below decide.'),
      pedalBox,
      row('Song buttons', tog('programChange', 'Keyboard picks songs').el, 'Lets the keyboard’s program/patch buttons choose songs: 1 = first song in the setlist, 2 = second, …'),
      h('h3.st-h3', { text: 'MIDI Learn' }),
      h('p.st-hint', { text: 'Press Learn, then move a knob, fader or pedal, or press a key or pad. A hardware fader takes over once you move it past the current level. The sustain pedal can’t be mapped — it always sustains.' }),
      h('table.st-learn-table', {}, h('thead', {}, h('tr', {}, h('th', { text: 'Control' }), h('th', { text: 'Mapped to' }), h('th', { text: '' }))), learnBody),
    ),
  );

  // =============================================================================================================
  // Pads, keyboard, library, diagnostics, about
  // =============================================================================================================
  const padInfo = h('p.st-hint.st-pad-info');
  const padStatus = h('p.st-pad-status', { 'aria-live': 'polite' });
  const padFileInput = h('input', { type: 'file', multiple: true, accept: 'audio/*,.mp3,.wav,.ogg,.m4a,.aif,.aiff,.flac', hidden: true, 'aria-label': 'Choose pad files' });
  let objectUrls = [];
  let attachedThisSession = false;
  const canFsa = typeof globalThis.showDirectoryPicker === 'function';

  function padSummary(info) {
    if (!info) return;
    if (info.error) {
      if (info.error !== 'missing') console.warn('[settings] pads', info.error);
      setText(padStatus, info.error === 'missing' ? 'My Pads folder not found — is the drive plugged in?' : 'The My Pads folder could not be read.');
      return;
    }
    const un = info.unmatched || [];
    setText(padStatus, `${info.count} of ${info.total} pad file${info.total === 1 ? '' : 's'} matched to a key${un.length ? `; not recognised: ${un.slice(0, 4).join(', ')}${un.length > 4 ? '…' : ''}` : ''}.`);
  }
  listen(controller, 'pads', (e) => padSummary(e.detail));
  // the controller reattached a remembered Chrome folder at start-up (no prompt): hide Reconnect
  listen(controller, 'pads-restored', (e) => {
    attachedThisSession = true;
    padSummary(e.detail);
    renderPadInfo();
  });
  function attachFiles(files, folderSetting) {
    for (const u of objectUrls) URL.revokeObjectURL(u);
    objectUrls = [];
    const list = files.map((f) => {
      const url = URL.createObjectURL(f.file);
      objectUrls.push(url);
      return { name: f.name, url };
    });
    const info = controller.attachPads(list);
    attachedThisSession = true;
    if (folderSetting !== undefined) store.set('settings.padFolder', folderSetting);
    padSummary(info);
    renderPadInfo();
    return info;
  }
  async function choosePads() {
    if (isElectron && typeof rig.choosePadFolder === 'function') {
      const r = await rig.choosePadFolder();
      if (!r || r.error || !r.path) {
        if (r && r.error) {
          console.warn('[settings] choosePadFolder', r.error);
          toast('That folder could not be opened. Try choosing it again.', 'error');
        }
        return;
      }
      store.set('settings.padFolder', { kind: 'electron', path: r.path });
      padSummary(await controller.reloadPads());
      renderPadInfo();
      return;
    }
    if (canFsa) {
      let handle;
      try {
        handle = await globalThis.showDirectoryPicker({ id: 'worship-rig-pads', mode: 'read' });
      } catch (err) {
        if (err && err.name !== 'AbortError') {
          console.warn('[settings] showDirectoryPicker', err);
          toast('That folder could not be opened. Try choosing it again.', 'error');
        }
        return;
      }
      await saveHandle(handle);
      attachFiles(await listDirectory(handle), { kind: 'fsa', name: handle.name });
      return;
    }
    padFileInput.click();
  }
  async function reconnectPads() {
    const pf = S().padFolder;
    if (pf && pf.kind === 'electron') {
      padSummary(await controller.reloadPads());
      return;
    }
    const handle = await loadHandle();
    if (!handle) {
      toast('Choose the pad folder again', 'warn');
      return choosePads();
    }
    try {
      const perm = (await handle.queryPermission?.({ mode: 'read' })) === 'granted' || (await handle.requestPermission?.({ mode: 'read' })) === 'granted';
      if (!perm) throw new Error('permission denied');
      attachFiles(await listDirectory(handle));
    } catch (err) {
      console.warn('[settings] reconnect pads', err);
      toast('The My Pads folder could not be reopened. Choose it again.', 'error');
    }
  }
  listen(padFileInput, 'change', () => {
    const files = [...(padFileInput.files || [])].filter((f) => AUDIO_EXT.test(f.name)).map((f) => ({ name: f.name, file: f }));
    padFileInput.value = '';
    if (files.length) attachFiles(files, null);
  });
  const padButtons = h('div.st-inline');
  function renderPadInfo(s = S()) {
    const pf = s.padFolder;
    setText(
      padInfo,
      !pf
        ? attachedThisSession
          ? 'Using the pad files you picked (pick them again after a restart).'
          : 'No My Pads folder yet — songs set to My Pads use the synth drone.'
        : pf.kind === 'electron'
          ? `Folder: ${pf.path}`
          : `Folder: ${pf.name || 'chosen folder'}${attachedThisSession ? '' : ' — press Reconnect to use it this session.'}`,
    );
    const kids = [
      btn(pf ? 'Change pad folder…' : isElectron || canFsa ? 'Choose pad folder…' : 'Choose pad files…', choosePads, { class: 'st-pads-choose' }),
      pf && (pf.kind === 'electron' || !attachedThisSession) ? btn(pf.kind === 'electron' ? 'Reload' : 'Reconnect', reconnectPads, { class: 'st-pads-reload' }) : null,
      pf
        ? btn('Forget', () => {
            store.set('settings.padFolder', null);
            controller.attachPads([]);
            attachedThisSession = false;
            setText(padStatus, '');
          })
        : null,
      padFileInput,
    ];
    padButtons.replaceChildren(...kids.filter(Boolean)); // (replaceChildren(null) would insert the text "null")
  }
  settingBinds.push({ key: 'padFolder', apply: renderPadInfo });

  const stats = h('p.st-stats');
  function renderStats() {
    let d = null;
    try {
      d = engine && typeof engine._debugStats === 'function' ? engine._debugStats() : null;
    } catch {
      d = null;
    }
    setText(stats, d ? `Decoded samples: ${Number(d.decodedMB || 0).toFixed(1)} MB${Number.isFinite(d.pinnedMB) ? ` (${d.pinnedMB.toFixed(1)} MB kept loaded)` : ''}${controller.status?.memory?.note ? ` · ${controller.status.memory.note}` : ''} · Voices: ${d.voices} · Audio nodes: ${d.nodes}${d.retiring ? ` · Retiring: ${d.retiring}` : ''}` : 'Audio engine not started.');
  }

  const importInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, 'aria-label': 'Import library file' });
  listen(importInput, 'change', async () => {
    const f = importInput.files && importInput.files[0];
    importInput.value = '';
    if (!f) return;
    const r = store.importJSON(await f.text());
    toast(r.ok ? `Imported ${r.songIds.length} songs` : r.error || 'That file could not be imported.', r.ok ? 'info' : 'error');
  });
  const storageNote = h('p.st-hint');
  const li = store.loadInfo || {};
  if (li.status === 'corrupt') setText(storageNote, `The saved library could not be read, so the factory songs were restored. The old data was kept (${li.backupKey}).`);
  else if (li.status === 'future-schema') setText(storageNote, `Your library was saved by a newer version of Worship Rig; it was kept (${li.backupKey}) and a fresh library started.`);

  const backupBox = h('div.st-inline');
  const restoreBox = h('div.st-restore');
  const aboutBox = h('dl.st-about');

  // ---- import latest backup (controller.importLatestBackup; replaces the library after backing it up)
  function restoreIdle() {
    restoreBox.replaceChildren();
    // only where disk backups exist (Electron: rig.latestBackup); in Chrome the button would always say "not available"
    const r = globalThis.rig;
    if (typeof controller.importLatestBackup !== 'function' || !r || typeof r.latestBackup !== 'function') return;
    restoreBox.append(btn('Import latest backup…', restoreAsk, { class: 'st-import-backup', title: 'Replace your library with the newest automatic backup' }));
  }
  function restoreAsk() {
    restoreBox.replaceChildren(
      h('span.st-restore-q', { text: 'Replace your whole library with the newest backup? Your current library is saved as a backup first.' }),
      btn('Replace library', restoreRun, { class: 'ed-danger st-import-backup-confirm' }),
      btn('Cancel', restoreIdle, { class: 'st-import-backup-cancel' }),
    );
    queueMicrotask(() => restoreBox.querySelector('.st-import-backup-cancel')?.focus());
  }
  async function restoreRun() {
    restoreBox.replaceChildren(h('span.st-hint', { text: 'Importing…' }));
    let r = null;
    try {
      r = await controller.importLatestBackup();
    } catch (err) {
      console.warn('[settings] importLatestBackup', err);
      r = { ok: false, error: 'failed' };
    }
    if (r && r.ok) toast(`Library restored from the latest backup (${(r.songIds || []).length} songs)`);
    else {
      const e = r && r.error;
      if (e && e !== 'not available' && e !== 'no backup found') console.warn('[settings] importLatestBackup', e);
      toast(
        e === 'not available'
          ? 'Automatic backups are kept by the Mac app. In Chrome, use Import… with a file you exported.'
          : e === 'no backup found'
            ? 'No backup has been saved yet.'
            : 'The backup could not be imported. Your library was not changed.',
        'warn',
      );
    }
    restoreIdle();
  }
  restoreIdle();

  // ---- My Samples (user sample instruments; shell: /api/user-samples, rig.openUserSamplesFolder/rescanUserSamples)
  // onboarding O9: the raw folder path sits inside the "Bringing GarageBand instruments over" disclosure with the
  // Terminal steps; outside it only a plain sentence (samplesNote)
  const samplesPath = h('p.st-hint.st-samples-path');
  const samplesNote = h('p.st-hint.st-samples-note');
  const samplesStatus = h('p.st-samples-status', { 'aria-live': 'polite' });
  const samplesBtns = h('div.st-inline');
  const docLink = h('a.st-doc-link', { href: GARAGEBAND_DOC, target: '_blank', rel: 'noopener', text: 'Open the GarageBand guide' });
  listen(docLink, 'click', (e) => {
    const r = globalThis.rig;
    if (r && typeof r.openDoc === 'function') {
      e.preventDefault();
      r.openDoc('garageband-import');
    } else {
      e.preventDefault();
      window.open(new URL(GARAGEBAND_DOC, location.href).href, '_blank', 'noopener');
    }
  });
  const userSampleCount = () => {
    try {
      const l = engine && typeof engine.listInstruments === 'function' ? engine.listInstruments() : [];
      return (Array.isArray(l) ? l : []).filter((x) => x && (x.group === 'My Samples' || String(x.ref && x.ref.id).startsWith('user:'))).length;
    } catch {
      return 0;
    }
  };
  async function userSamplesInfo() {
    const r = globalThis.rig;
    if (r && typeof r.getInfo === 'function') {
      try {
        const info = await r.getInfo();
        if (info && info.userSamplesDir) return { dir: info.userSamplesDir, supported: true };
      } catch {
        /* fall through */
      }
    }
    // Chrome: the local server advertises the feature in /api/health; only then ask /api/user-samples (no 404 noise)
    try {
      const hr = await fetch('/api/health', { cache: 'no-store' });
      const hj = hr.ok ? await hr.json() : null;
      const on = !!(hj && (hj.userSamples === true || (Array.isArray(hj.features) && hj.features.includes('user-samples'))));
      if (!on) return { dir: null, supported: false };
      const ur = await fetch('/api/user-samples', { cache: 'no-store' });
      const uj = ur.ok ? await ur.json() : null;
      const dir = uj && (uj.dir || uj.path || uj.folder || uj.root) ? String(uj.dir || uj.path || uj.folder || uj.root) : null;
      return { dir, supported: true };
    } catch {
      return { dir: null, supported: false };
    }
  }
  let samplesNeedReload = false;
  async function renderSamples() {
    const r = globalThis.rig;
    const { dir, supported } = await userSamplesInfo();
    const n = userSampleCount();
    setText(samplesPath, dir ? `Folder: ${dir}` : supported ? 'Your My Samples folder is ready.' : 'My Samples isn’t turned on here.');
    samplesPath.title = dir || '';
    setText(samplesNote, supported ? '' : 'My Samples isn’t turned on here — start Worship Rig with its normal launcher to use it.');
    samplesNote.hidden = supported;
    setText(
      samplesStatus,
      samplesNeedReload
        ? 'New samples are picked up when Worship Rig restarts — press Reload now (sound stops for a moment).'
        : n
          ? `${n} sample instrument${n === 1 ? '' : 's'} in the instrument picker under “My Samples”.`
          : 'No sample instruments yet.',
    );
    const kids = [];
    if (r && typeof r.openUserSamplesFolder === 'function') kids.push(btn('Open folder', () => openSamplesFolder(), { class: 'st-samples-open' }));
    // no Rescan without server support: the controller would request a route that isn't there (a 404 = console error)
    if (supported) kids.push(btn('Rescan', rescanSamples, { class: 'st-samples-rescan', title: 'Look for new or changed sample instruments' }));
    if (samplesNeedReload) kids.push(btn('Reload', () => location.reload(), { class: 'st-samples-reload', title: 'Restart the sound engine to load new samples' }));
    samplesBtns.replaceChildren(...kids);
  }
  async function openSamplesFolder() {
    try {
      const res = await globalThis.rig.openUserSamplesFolder();
      if (res && res.error) throw new Error(res.error);
    } catch (err) {
      console.warn('[settings] openUserSamplesFolder', err);
      toast('The My Samples folder could not be opened.', 'error');
    }
  }
  async function rescanSamples() {
    const before = userSampleCount();
    const btnEl = samplesBtns.querySelector('.st-samples-rescan');
    if (btnEl) btnEl.disabled = true;
    try {
      // controller.rescanUserSamples() re-reads the folder (Electron IPC or the server) and, when the engine can,
      // reloads the instrument list live (engine.reloadManifests); otherwise it warns and a restart is needed.
      let res = null;
      if (typeof controller.rescanUserSamples === 'function') res = await controller.rescanUserSamples();
      else if (engine && typeof engine.reloadManifests === 'function') {
        await engine.reloadManifests();
        res = { reloaded: true };
      } else {
        const r = globalThis.rig;
        if (r && typeof r.rescanUserSamples === 'function') res = await r.rescanUserSamples();
        res = { ...(res || {}), reloaded: false };
      }
      if (res && res.error) {
        console.warn('[settings] rescan user samples', res.error); // the controller already told the user
      } else if (res && res.reloaded) {
        samplesNeedReload = false;
        window.dispatchEvent(new CustomEvent('rig-instruments-changed'));
        const n = userSampleCount();
        toast(n === before ? `No new sample instruments (${n} in My Samples).` : `${n} sample instrument${n === 1 ? '' : 's'} ready in My Samples.`);
      } else samplesNeedReload = true;
    } catch (err) {
      console.warn('[settings] rescan user samples', err);
      toast('The My Samples folder could not be scanned.', 'error');
    }
    renderSamples();
  }
  async function renderAbout() {
    const rows = [];
    let info = null;
    if (isElectron && typeof rig.getInfo === 'function') {
      try {
        info = await rig.getInfo();
      } catch {
        info = null;
      }
    }
    if (info && !info.error) {
      rows.push(['Version', `${info.version || '?'} (Mac app)`], ['Electron', info.electron || '?'], ['Local server port', String(info.port ?? location.port)]);
      if (info.backupsDir) rows.push(['Backups', info.backupsDir]);
      if (info.recordingsDir) rows.push(['Recordings', info.recordingsDir]);
    } else {
      rows.push(['Mode', 'Chrome'], ['Local server', location.host]);
    }
    rows.push(['Library', 'Chrome and the Mac app keep separate libraries — use Export / Import to move songs between them.']);
    aboutBox.replaceChildren(...rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]));
    backupBox.replaceChildren();
    if (isElectron) {
      backupBox.append(
        btn('Back up now', async () => {
          const r = await rig.backupNow(store.exportJSON({ pretty: false }));
          if (r && r.error) console.warn('[settings] backupNow', r.error);
          toast(r && !r.error ? 'Backup saved' : 'The backup could not be saved.', r && !r.error ? 'info' : 'error');
        }),
        typeof rig.openFolder === 'function' ? btn('Open backups folder', () => rig.openFolder('backups')) : null,
      );
    } else backupBox.append(h('span.st-hint', { text: 'Automatic backups (last 10) run in the Mac app. In Chrome, use Export library.' }));
  }

  colA.append(
    h('section.st-section', { 'aria-label': 'My Pads' },
      h('h2.st-h2', { text: 'My Pads folder' }),
      padInfo,
      padButtons,
      padStatus,
      h('p.st-hint', { text: 'Used when a song’s drone is set to My Pads. Put the key in each file name, e.g. “Pad - Eb.mp3” or “Warm Pad F#m.wav”.' }),
    ),
    h('section.st-section.st-samples', { 'aria-label': 'My Samples' },
      h('h2.st-h2', { text: 'My Samples' }),
      h('p.st-hint', { text: 'Extra sampled instruments on this Mac (for example GarageBand’s pianos). They appear in the instrument picker under “My Samples”.' }),
      samplesNote,
      samplesBtns,
      samplesStatus,
      h('details.st-howto', {},
        h('summary', { text: 'Bringing GarageBand instruments over' }),
        samplesPath,
        h('ol.st-howto-steps', {},
          h('li', {}, 'On the Mac, open Terminal in the Worship Rig folder and run ', h('code', { text: 'node tools/import-garageband.mjs --list' }), ' to see what GarageBand has installed.'),
          h('li', {}, 'Import one, e.g. ', h('code', { text: 'node tools/import-garageband.mjs --import "Steinway"' }), '. It is copied into the My Samples folder.'),
          h('li', { text: 'Press Rescan (or restart Worship Rig). It shows up under “My Samples” in the instrument picker.' }),
        ),
        h('p.st-hint', { text: 'For your own playing only — Apple’s sounds must not be shared or copied to other people.' }),
        docLink,
      ),
    ),
    h('section.st-section', { 'aria-label': 'Perform view' },
      h('h2.st-h2', { text: 'Perform view' }),
      row('Chips per sound', performChips.el, 'Under each Perform fader. 2 = Space and Echo only, for a longer fader.'),
    ),
    h('section.st-section', { 'aria-label': 'Computer keyboard' },
      h('h2.st-h2', { text: 'Computer keyboard' }),
      // onboarding O5: the whole map (controller KEY_MAP runs to K O L P ;), and where the notes start
      row('Play notes', tog('computerKeyboard', 'Enabled').el, 'A W S E D F T G Y H U J K O L P ; = notes from middle C (A = C), '
        + 'Z/X = octave, Space = sustain, ↑/↓ = mod wheel, ←/→ = previous / next song.'),
    ),
    h('section.st-section', { 'aria-label': 'Library' },
      h('h2.st-h2', { text: 'Library & backups' }),
      h('div.st-inline', {},
        btn('Export library', () => download(`Worship Rig library ${new Date().toISOString().slice(0, 10)}.json`, store.exportJSON()), { class: 'st-export' }),
        btn('Import…', () => importInput.click(), { class: 'st-import' }),
        importInput,
      ),
      storageNote,
      backupBox,
      restoreBox,
    ),
    h('details.st-section.st-diag', { 'aria-label': 'Diagnostics' }, h('summary.st-h2', { text: 'Diagnostics' }), stats),
    h('section.st-section', { 'aria-label': 'About' }, h('h2.st-h2', { text: 'About' }), aboutBox),
  );

  // =============================================================================================================
  // Menu bar (docs/menubar-mode.md; C7 menubar-B): menu-bar mode, which set the popover's modes come from,
  // low-resource mode, open at login (Mac app only) and a live resource line (engine._debugStats, 1 s while open)
  // =============================================================================================================
  const mbSetSelect = h('select.ed-select.st-mb-set', { 'aria-label': 'Menu-bar set',
    'data-testid': 'setting-mb-set' });
  const mbModes = h('p.st-hint.st-mb-modes', { 'data-testid': 'setting-mb-modes' });
  // L-30: the tray icon has no slot in a full macOS menu bar; main.js toasts once and sets <html data-tray-hidden>
  const mbTrayHidden = h('p.st-hint.st-mb-tray-hidden', { 'data-testid': 'menubar-tray-hidden', hidden: true,
    text: 'The menu-bar icon is hidden — your Mac’s menu bar is full. Hide a few items in System Settings › '
      + 'Control Center, or use the Rig menu › Show Worship Rig.' });
  const syncTrayHidden = (hidden) => { mbTrayHidden.hidden = !hidden; };
  syncTrayHidden(document.documentElement.hasAttribute('data-tray-hidden'));
  listen(controller, 'menu', (e) => {
    if (e.detail?.id === 'trayHidden') syncTrayHidden(true);
    else if (e.detail?.id === 'trayShown') syncTrayHidden(false);
  });
  const mbResource = h('p.st-status.st-mb-resource', { 'data-testid': 'setting-mb-resource' });
  const mbMode = tog('menuBarMode', 'Keep in the menu bar');
  mbMode.el.dataset.testid = 'setting-mb-mode';
  // low-resource: controller.setLowResource when it exists (it also tells the engine), else the setting alone
  const mbLow = C.toggle({
    label: 'Low-resource',
    onChange: (v) => {
      if (typeof controller.setLowResource === 'function') controller.setLowResource(!!v);
      else store.set('settings.lowResource', !!v);
    },
  });
  mbLow.el.dataset.bind = 'settings.lowResource';
  mbLow.el.dataset.testid = 'setting-mb-lowres';
  comps.push(mbLow);
  settingBinds.push({ key: 'lowResource', apply: (s) => mbLow.set(!!s.lowResource) });
  mbLow.set(!!S().lowResource);
  let mbLogin = null;
  if (rig && typeof rig.setLoginItem === 'function') {
    mbLogin = C.toggle({
      label: 'Open at login',
      onChange: async (v) => {
        const r = await rig.setLoginItem(!!v);
        if (r && r.error) {
          console.warn('[settings] setLoginItem', r.error);
          toast('Open at login could not be changed.', 'error');
          mbLogin.set(!v);
        }
      },
    });
    mbLogin.el.dataset.testid = 'setting-mb-login';
    comps.push(mbLogin);
  }
  /** The popover's modes, as the controller will list them (fallback: the contract's rule, computed here). */
  function mbModeNames(state) {
    try {
      const list = controller.modes && typeof controller.modes.list === 'function' ? controller.modes.list() : null;
      if (Array.isArray(list)) return list.map((m) => m.name);
    } catch {
      /* fall through */
    }
    const st = state.settings;
    const own = st.menuBarSetlistId && state.setlists[st.menuBarSetlistId];
    const cur = st.currentSetlistId && state.setlists[st.currentSetlistId];
    const nav = cur && cur.songIds.length ? cur.songIds : state.songOrder || [];
    const ids = own ? own.songIds.slice(0, 6) : nav.slice(0, 3);
    return ids.map((id) => state.songs[id]?.name).filter(Boolean);
  }
  function renderMbSets(state = store.get()) {
    const cur = state.settings.menuBarSetlistId || '';
    const opts = [h('option', { value: '', text: 'Current setlist (first 3 songs)' })];
    for (const id of state.setlistOrder || []) {
      const sl = state.setlists[id];
      if (!sl) continue;
      opts.push(h('option', { value: id, text: `${sl.name || 'Setlist'} (${Math.min(6, sl.songIds.length)})` }));
    }
    mbSetSelect.replaceChildren(...opts);
    mbSetSelect.value = cur && state.setlists[cur] ? cur : '';
    const names = mbModeNames(state);
    setText(mbModes, names.length ? `Modes: ${names.join(' · ')}` : 'No modes yet: add songs to the setlist.');
  }
  listen(mbSetSelect, 'change', () => store.set('settings.menuBarSetlistId', mbSetSelect.value || null));
  settingBinds.push({ key: 'menuBarSetlistId', apply: () => renderMbSets() });
  settingBinds.push({ key: 'currentSetlistId', apply: () => renderMbSets() });
  cleanups.push(
    store.subscribe((state, paths) => {
      const hit = (p) => p === 'setlistOrder' || p.startsWith('setlists') || p === 'songOrder'
        || /^songs\.[^.]+(\.name)?$/.test(p);
      if (paths.some(hit)) renderMbSets(state);
    }),
  );
  function renderMbResource() {
    let d = null;
    try {
      d = engine && typeof engine._debugStats === 'function' ? engine._debugStats() : null;
    } catch {
      d = null;
    }
    const st = controller.status || {};
    const low = d && typeof d.lowResource === 'boolean' ? d.lowResource : !!st.lowResource;
    const parts = [low ? 'Low-resource: on' : 'Low-resource: off'];
    const mm = st.memory && st.memory.mode;
    if (mm) parts.push(mm === 'current-only' ? 'current song kept loaded' : `keeps ${mm}`);
    if (d) {
      if (Number.isFinite(d.pinnedMB)) parts.push(`${d.pinnedMB.toFixed(1)} MB kept loaded`);
      if (Number.isFinite(d.slotLevelTaps)) parts.push(`level taps ${d.slotLevelTaps}`);
      if (Number.isFinite(d.voices)) parts.push(`voices ${d.voices}`);
    }
    setText(mbResource, parts.join(' · '));
    mbResource.dataset.low = String(low);
  }
  let mbTimer = null;
  listen(el, 'settings-open', () => {
    renderMbSets();
    renderMbResource();
    clearInterval(mbTimer);
    mbTimer = setInterval(renderMbResource, 1000);
    const readLogin = mbLogin && (typeof rig.getLoginItem === 'function' ? rig.getLoginItem
      : typeof rig.getMenuBarState === 'function' ? rig.getMenuBarState : null);
    if (readLogin) {
      Promise.resolve(readLogin()).then((r) => {
        if (r && typeof r === 'object' && typeof r.openAtLogin === 'boolean') mbLogin.set(r.openAtLogin);
        else if (typeof r === 'boolean') mbLogin.set(r);
      }, () => {});
    }
  });
  listen(el, 'settings-close', () => {
    clearInterval(mbTimer);
    mbTimer = null;
  });
  cleanups.push(() => clearInterval(mbTimer));
  // Chrome: the popover runs as a small window over BroadcastChannel (same origin); the Mac app uses the tray icon
  const mbOpenMini = isElectron ? null : btn('Open mini panel', () => {
    window.open('mini.html', 'worship-rig-mini', 'popup,width=320,height=440');
  }, { class: 'st-mb-open-mini', 'data-testid': 'setting-mb-open-mini' });
  colB.append(
    h('section.st-section.st-menubar', { 'aria-label': 'Menu bar', 'data-testid': 'settings-menubar' },
      h('h2.st-h2', { text: 'Menu bar' }),
      row('Menu-bar mode', mbMode.el, isElectron
        ? 'Closing the window keeps the sound running; switch modes from the menu-bar icon. Quit from its menu.'
        : 'Used by the Mac app. In Chrome, keep this tab open and use the mini panel.'),
      // onboarding O9: "Modes" defined where it first appears
      row('Menu-bar songs', h('div.st-inline', {}, mbSetSelect),
        'The songs (“modes”) the menu-bar icon lets you switch between, up to 6.'),
      mbTrayHidden,
      mbModes,
      row('Low-resource', mbLow.el, 'Only the current song stays loaded and the meters stop. Sound is unchanged. '
        + 'In menu-bar mode it is on by itself while the window is hidden.'),
      mbLogin
        ? row('Open at login', mbLogin.el, 'Start Worship Rig in the menu bar when you log in.')
        : h('p.st-hint.st-mb-login-hint', { text: 'Open at login is available in the Mac app.' }),
      mbOpenMini ? row('Mini panel', mbOpenMini, 'Mode buttons, master, drone and panic in a 320×440 window.') : null,
    ),
  );
  // onboarding O9: the live resource line is a diagnostic, not a setting
  (colA.querySelector('.st-diag') || colB).append(mbResource);
  renderMbSets();

  // =============================================================================================================
  // Appearance › Theme (themes-setup; shared/themes.js). One card per pickable theme: name, Light/Dark, a 4-colour
  // strip (bg, panel, text, accent, hand-copied from the theme file). A radiogroup with a roving tabindex: arrows move
  // and select, like native radios. Selecting writes settings.theme; main.js applyTheme() does the rest.
  // =============================================================================================================
  const themeCards = pickableThemes().map((t) => h('button.st-theme', {
    type: 'button', role: 'radio', 'aria-checked': 'false', tabindex: -1, 'data-theme-id': t.id,
    'data-testid': `theme-card-${t.id}`, title: `${t.name} (${t.mode === 'light' ? 'light' : 'dark'})`,
    on: { click: () => store.set('settings.theme', t.id) },
  },
  h('span.st-theme-strip', { 'aria-hidden': 'true' },
    ...['bg', 'panel', 'text', 'accent'].map((k) => {
      const sw = h('i');
      sw.style.background = t.swatch[k];
      return sw;
    })),
  h('span.st-theme-name', { text: t.name }),
  h('span.st-theme-tag', { text: t.mode === 'light' ? 'Light' : 'Dark' })));
  const themeGrid = h('div.st-themes', { role: 'radiogroup', 'aria-label': 'Theme', 'data-testid': 'setting-theme' },
    ...themeCards);
  const renderThemes = (s = S()) => {
    const cur = resolveThemeId(s.theme);
    let any = false;
    for (const c of themeCards) {
      const on = c.dataset.themeId === cur;
      any = any || on;
      c.setAttribute('aria-checked', String(on));
      c.classList.toggle('on', on);
      c.tabIndex = on ? 0 : -1;
    }
    if (!any && themeCards[0]) themeCards[0].tabIndex = 0; // current is a hidden ("coming") theme
  };
  settingBinds.push({ key: 'theme', apply: renderThemes });
  renderThemes();
  listen(themeGrid, 'keydown', (e) => {
    const i = themeCards.indexOf(e.target);
    if (i < 0) return;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    const to = step ? (i + step + themeCards.length) % themeCards.length
      : e.key === 'Home' ? 0 : e.key === 'End' ? themeCards.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    e.stopPropagation(); // ↑/↓ are the mod wheel on the computer keyboard
    themeCards[to].focus();
    themeCards[to].click();
  });
  const appearance = h('section.st-section.st-appearance', { 'aria-label': 'Appearance', 'data-section': 'appearance',
    'data-testid': 'settings-appearance' },
  h('h2.st-h2', { text: 'Appearance' }),
  h('div.st-row.st-row-themes', {},
    h('div.st-label', {}, h('span', { text: 'Theme' }),
      h('span.st-hint', { text: 'How the whole app looks. The sound doesn’t change.' })),
    h('div.st-control', {}, themeGrid)));
  colA.insertBefore(appearance, colA.querySelector('.st-section[aria-label="Perform view"]'));
  /** open({section}): bring that section into view and focus its first control (Quick › This Mac › Theme). */
  function revealSection(name) {
    if (!name) return;
    const sec = dialog.querySelector(`[data-section="${name}"]`);
    if (!sec) return;
    setTimeout(() => {
      if (!isOpen) return;
      sec.scrollIntoView({ block: 'start' });
      const f = sec.querySelector('[role=radio][tabindex="0"]') || sec.querySelector('button, select, input');
      f?.focus({ preventScroll: true });
    }, 0);
  }

  // ---- status (latency, MIDI)
  if (typeof controller.onStatus === 'function') {
    cleanups.push(
      controller.onStatus((st) => {
        const ms = Number(st.latencyMs) || 0;
        setText(latencyInfo, ms ? `${Math.round(ms)} ms${ms > 40 ? ' — high' : ''}` : '');
        asleepNote.hidden = st.audio !== 'asleep'; // lowres2
        latencyInfo.classList.toggle('warn', ms > 40);
        latencyWarn.set({ latencyMs: ms, deviceId: S().outputDeviceId });
        const m = st.midi || {};
        setText(
          midiStatus,
          !m.available
            ? midiStatusText(m, isElectron)
            : m.connected
              ? `Connected: ${m.name}`
              : 'No keyboard connected — plug one in (it connects by itself), or play the computer keys A–;.',
        );
        midiStatus.classList.toggle('warn', !m.connected);
      }),
    );
  }

  // ---- store → view
  cleanups.push(
    store.subscribe((state, paths) => {
      const keys = new Set();
      for (const p of paths) {
        if (p === 'settings') for (const b of settingBinds) keys.add(b.key);
        else if (p.startsWith('settings.')) keys.add(p.split('.')[1]);
      }
      if (!keys.size) return;
      for (const b of settingBinds) if (keys.has(b.key)) b.apply(state.settings);
    }),
  );

  // ---- open / close
  function open(opts = {}) {
    if (isOpen) return revealSection(opts && opts.section);
    isOpen = true;
    prevFocus = document.activeElement;
    el.hidden = false;
    el.classList.add('open');
    for (const b of settingBinds) b.apply(S());
    refreshOutputs();
    populateMidi();
    renderStats();
    renderAbout();
    renderSamples();
    restoreIdle();
    markDialog('settings', true);
    statsTimer = setInterval(renderStats, 1000);
    queueMicrotask(() => closeBtn.focus());
    el.dispatchEvent(new CustomEvent('settings-open'));
    revealSection(opts && opts.section);
  }
  function close() {
    if (!isOpen) return;
    isOpen = false;
    el.hidden = true;
    el.classList.remove('open');
    markDialog('settings', false);
    clearInterval(statsTimer);
    statsTimer = null;
    stopPedalTest();
    pedalIdle();
    if (learningId) {
      learningId = null;
      if (typeof controller.cancelLearn === 'function') controller.cancelLearn();
      renderLearn();
    }
    // Under main.js (ctx.closeSettings present) the shell decides where focus goes: keyboard users get their
    // opener back, pointer users get nothing focused so Space = sustain (round2-ui #1). Standalone: restore here.
    const shellOwnsFocus = typeof ctx.closeSettings === 'function';
    const canRestore = prevFocus && prevFocus !== document.body && typeof prevFocus.focus === 'function' && prevFocus.isConnected;
    if (!shellOwnsFocus && canRestore) prevFocus.focus();
    else if (document.activeElement && dialog.contains(document.activeElement)) document.activeElement.blur();
    prevFocus = null;
    el.dispatchEvent(new CustomEvent('settings-close'));
  }

  renderLearn();
  renderPadInfo();
  populateOutputs(S().outputDeviceId, false);
  populateMidi();

  return {
    open,
    close,
    get isOpen() {
      return isOpen;
    },
    destroy() {
      close();
      for (const c of cleanups.splice(0)) {
        try {
          c();
        } catch (err) {
          console.warn('[settings] cleanup failed', err);
        }
      }
      for (const c of comps) {
        try {
          c.destroy();
        } catch {
          /* ignore */
        }
      }
      for (const u of objectUrls) URL.revokeObjectURL(u);
      el.replaceChildren();
      el.classList.remove('st-host', 'open');
      delete el.__rigCtx;
    },
    _debug: { startPedalTest, toggleLearn, renderSamples, components: C.__source },
  };
}
