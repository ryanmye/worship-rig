// Settings (SPEC §10 Settings, §13). mountSettings(el, ctx) → { destroy, open(), close() }.
// A modal panel over the current view. Everything persisted goes through ctx.store.set('settings.*') (the controller
// reacts: latency → engine.restart, output → setSinkId, mono → setMono, MIDI input → midi.select); transient actions
// (restart audio, MIDI learn, pads) go through ctx.controller.
import { loadComponents, markDialog } from './_fallback-components.js';
import { LEARNABLE, ROLE_DEFAULTS } from '../shared/params.js';
import { noteName } from '../shared/music.js';

const C = await loadComponents();

// ---------------------------------------------------------------------------------------------------------------
export const LEARN_NAMES = Object.freeze({
  'slots.0.gain': `${ROLE_DEFAULTS[0].name} level`,
  'slots.1.gain': `${ROLE_DEFAULTS[1].name} level`,
  'slots.2.gain': `${ROLE_DEFAULTS[2].name} level`,
  'slots.3.gain': `${ROLE_DEFAULTS[3].name} level`,
  'drone.gain': 'Drone level',
  'fx.reverb.returnGain': 'Reverb level',
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

  colA.append(
    h('section.st-section', { 'aria-label': 'Audio' },
      h('h2.st-h2', { text: 'Audio' }),
      row('Latency', h('div.st-inline', {}, seg('latency', LATENCY_OPTS, 'Latency').el, latencyInfo), 'Lower = more responsive; raise it if you hear crackles. Changing it restarts audio for a moment.'),
      row('Output device', h('div.st-inline', {}, outputSelect, labelsBtn), null),
      outputNote,
      row('Mono output', tog('monoOutput', 'Mono').el, 'Sum to mono for a single speaker or a mono PA feed.'),
      row('Audio engine', restartBtn, 'Use if sound stops or after changing audio hardware.'),
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

  // pedal polarity detector
  const pedalBox = h('div.st-pedal', { 'aria-live': 'polite' });
  let pedalListener = null;
  let pedalTimer = null;
  function stopPedalTest() {
    if (pedalListener && midi) midi.removeEventListener('cc', pedalListener);
    pedalListener = null;
    clearTimeout(pedalTimer);
    pedalTimer = null;
  }
  /** Replace the pedal box content without dropping keyboard focus to <body>. */
  function pedalShow(...kids) {
    const hadFocus = pedalBox.contains(document.activeElement);
    pedalBox.replaceChildren(...kids.filter(Boolean));
    if (hadFocus) pedalBox.querySelector('button')?.focus();
  }
  function pedalIdle(msg) {
    pedalShow(btn('Test my pedal', startPedalTest, { class: 'st-pedal-test' }), msg ? h('span.st-hint', { text: msg }) : null);
  }
  function startPedalTest() {
    if (!midi) {
      pedalIdle('MIDI is not available.');
      return;
    }
    stopPedalTest();
    pedalShow(h('strong.st-pedal-prompt', { text: 'Press your sustain pedal now…' }), btn('Cancel', () => {
      stopPedalTest();
      pedalIdle();
    }));
    pedalListener = (e) => {
      const d = e.detail || {};
      if (d.cc !== 64) return;
      stopPedalTest();
      const invert = inferPedalInvert(d.value);
      const cur = !!S().pedalInvert;
      const msg = invert
        ? `Your pedal sent ${d.value} when pressed — it is wired the other way round.`
        : `Your pedal sent ${d.value} when pressed — normal polarity.`;
      const kids = [h('span.st-pedal-result', { dataset: { invert: String(invert) }, text: msg })];
      if (invert !== cur) {
        kids.push(btn(invert ? 'Invert pedal' : 'Turn invert off', () => {
          store.set('settings.pedalInvert', invert);
          pedalIdle(invert ? 'Pedal inverted. Press it again to check sustain.' : 'Pedal set to normal.');
        }, { class: 'st-pedal-apply' }));
      } else kids.push(h('span.st-hint', { text: 'Your setting is already right.' }));
      kids.push(btn('Test again', startPedalTest));
      pedalShow(...kids);
    };
    midi.addEventListener('cc', pedalListener);
    pedalTimer = setTimeout(() => {
      stopPedalTest();
      pedalIdle('No pedal message received. Is the pedal in the keyboard’s SUSTAIN jack and the keyboard selected above?');
    }, 15000);
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
  const samplesPath = h('p.st-hint.st-samples-path');
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
    setText(samplesPath, dir ? `Folder: ${dir}` : supported ? 'Your My Samples folder is ready.' : 'My Samples isn’t turned on here — start Worship Rig with its normal launcher to use it.');
    samplesPath.title = dir || '';
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
      samplesPath,
      samplesBtns,
      samplesStatus,
      h('details.st-howto', {},
        h('summary', { text: 'Bringing GarageBand instruments over' }),
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
      row('Play notes', tog('computerKeyboard', 'Enabled').el, 'A W S E D F T G Y H U J K = notes, Z/X = octave, Space = sustain, ↑/↓ = mod wheel.'),
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

  // ---- status (latency, MIDI)
  if (typeof controller.onStatus === 'function') {
    cleanups.push(
      controller.onStatus((st) => {
        const ms = Number(st.latencyMs) || 0;
        setText(latencyInfo, ms ? `${Math.round(ms)} ms${ms > 40 ? ' — high' : ''}` : '');
        latencyInfo.classList.toggle('warn', ms > 40);
        const m = st.midi || {};
        setText(
          midiStatus,
          !m.available
            ? m.pending || m.reason === 'pending' // polish-1 (local L-3): Chrome's prompt is open; no reload needed
              ? 'Waiting for MIDI permission — if Chrome shows a prompt, click Allow.'
              : m.reason === 'denied'
                ? 'MIDI is blocked — allow MIDI in the address bar, then reload.'
                : m.reason
                  ? 'MIDI isn’t available — allow MIDI in the address bar (or plug the keyboard in), then reload.'
                  : 'MIDI starting…'
            : m.connected
              ? `Connected: ${m.name}`
              : 'No keyboard connected — check the USB cable.',
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
  function open() {
    if (isOpen) return;
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
