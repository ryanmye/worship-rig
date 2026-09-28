// Worship Rig bootstrap (SPEC §13): store → engine → midi/recorder → controller → views.
// Also owns the top bar, view switching, the settings modal, toasts, the start overlay and first-run hints.
import { createStore } from './store.js';
import { FACTORY_SONGS } from './presets.js';
import { AudioEngine } from './engine/index.js';
import { MidiInput } from './midi.js';
import { Recorder } from './recorder.js';
import { createController, engineLatency } from './controller.js';
import { mountPerform } from './views/perform.js';
import { h, setText, segmented, fader, meter } from './views/components/index.js';

const $ = (id) => document.getElementById(id);
const rig = globalThis.rig || null;
const isElectron = !!(rig && rig.isElectron);

// ------------------------------------------------------------------------------------------ toasts
const TOAST_MS = { info: 4500, ok: 4000, warn: 7000, error: 10000 };
const toastsEl = $('toasts');
const liveToasts = new Map(); // message → {el, timer, count}

/**
 * Show a toast. Identical messages that are still visible are merged (×N).
 * @param {string} msg
 * @param {'info'|'ok'|'warn'|'error'} [kind='info']
 * @param {{ms?:number, action?:{label:string, run:()=>void}}} [opts]
 */
function toast(msg, kind = 'info', opts = {}) {
  const text = String(msg ?? '').trim();
  if (!text || !toastsEl) return;
  const k = TOAST_MS[kind] ? kind : 'info';
  const ms = opts.ms ?? TOAST_MS[k];
  const arm = (fn) => (Number.isFinite(ms) && ms > 0 ? setTimeout(fn, ms) : null); // ms 0 / Infinity = stays
  const existing = liveToasts.get(text);
  if (existing) {
    existing.count += 1;
    setText(existing.countEl, `×${existing.count}`);
    clearTimeout(existing.timer);
    existing.timer = arm(() => dismiss(text));
    return;
  }
  const countEl = h('span.toast-count');
  const el = h('div.toast', { role: k === 'error' ? 'alert' : 'status', class: k, 'data-kind': k }, h('span.toast-msg', { text }), countEl);
  if (opts.action && typeof opts.action.run === 'function') {
    const b = h('button.btn.toast-action', { type: 'button' }, opts.action.label || 'OK');
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.action.run();
      dismiss(text);
    });
    el.insertBefore(b, countEl);
  }
  const entry = { el, countEl, count: 1, timer: arm(() => dismiss(text)) };
  liveToasts.set(text, entry);
  toastsEl.append(el);
  // keep the stack short on stage
  while (liveToasts.size > 2) dismiss(liveToasts.keys().next().value);
}
function dismiss(text) {
  const e = liveToasts.get(text);
  if (!e) return;
  liveToasts.delete(text);
  clearTimeout(e.timer);
  e.el.classList.add('leaving');
  setTimeout(() => e.el.remove(), 220);
}

/**
 * Stage copy: raw engine/browser wording → plain sentences (UX copy pass). The raw text goes to the console.
 * @returns {{text:string, kind?:string, once?:boolean}|null} null = don't show
 */
const shownOnce = new Set();
function plainMessage(raw) {
  const m = String(raw ?? '').trim();
  if (!m) return null;
  if (/wake ?lock/i.test(m)) return { text: 'Your screen might dim during long songs. Keep the laptop plugged in.', kind: 'info', once: true };
  if (/AudioContext|audio ?context/i.test(m) && /suspend|interrupt|closed|not allowed/i.test(m)) return { text: 'Audio stopped — click “Restart sound”.', kind: 'warn' };
  if (/CC ?64/i.test(m)) return { text: m.replace(/CC ?64/gi, 'the sustain pedal') };
  if (/CC ?7\b/i.test(m)) return { text: m.replace(/CC ?7\b/gi, 'the volume knob') };
  if (/CC ?11\b/i.test(m)) return { text: m.replace(/CC ?11\b/gi, 'the expression pedal') };
  if (/^engine\.[\w.]+(\(\))? (failed|not available)/.test(m)) return { text: 'Something in the sound engine went wrong. If the sound seems wrong, press PANIC; if that doesn’t help, reload.', kind: 'warn', once: true };
  return { text: m };
}
function plainToast(raw, kind = 'warn', opts = {}) {
  const p = plainMessage(raw);
  if (!p) return;
  if (p.text !== String(raw).trim()) console.warn('[ui]', raw);
  if (p.once) {
    if (shownOnce.has(p.text)) return;
    shownOnce.add(p.text);
  }
  toast(p.text, p.kind || kind, opts);
}

// ------------------------------------------------------------------------------------------ core objects
function storageAdapter() {
  try {
    const ls = globalThis.localStorage;
    ls.setItem('__rig_probe__', '1');
    ls.removeItem('__rig_probe__');
    return ls;
  } catch {
    return undefined; // store falls back to memory
  }
}

const store = createStore({ storage: storageAdapter() });
store.seedFactory(FACTORY_SONGS); // no-op once seeded
const engine = new AudioEngine({ latency: engineLatency(store.get().settings) });
const midi = new MidiInput();
const recorder = new Recorder({ engine, rig });
const controller = createController({ store, engine, midi, recorder, rig });

// ------------------------------------------------------------------------------------------ views
const els = {
  perform: $('view-perform'),
  edit: $('view-edit'),
  settings: $('view-settings'),
  overlay: $('overlay-start'),
};
let editView = null;
let settingsView = null;
let settingsOpen = false;
let lastFocus = null;
let lastFocusKb = false; // was the opener keyboard-focused (:focus-visible) when Settings opened

const locked = () => !!store.get().settings.performLock;

/**
 * Switch view. `opts.block` (+ `opts.focus`) selects an Edit block when switching to Edit, e.g. Perform's empty-slot
 * "+" → {block: 'slot:2', focus: 'instrument'} (H-v2 Edit selection model, views/edit/CONTRACT.md §2).
 */
function setView(name, opts = {}) {
  if (name === 'settings') return openSettings();
  if (name !== 'perform' && name !== 'edit') return false;
  if (name === 'edit' && locked()) {
    toast('Perform lock is on — unlock it to edit.', 'warn');
    return false;
  }
  store.set('settings.view', name);
  applyView(name);
  if (name === 'edit' && opts && opts.block) {
    const { block, ...rest } = opts;
    editView?.editState?.select?.(block, rest);
  }
  return true;
}

function applyView(name) {
  const v = name === 'edit' ? 'edit' : 'perform';
  els.perform.hidden = v !== 'perform';
  els.edit.hidden = v !== 'edit';
  document.body.dataset.view = v;
  viewSwitch.set(v);
}

function openSettings(opts = {}) {
  if (locked()) {
    toast('Perform lock is on — unlock it to open Settings.', 'warn');
    return false;
  }
  if (!settingsOpen) {
    settingsOpen = true;
    lastFocus = document.activeElement;
    // round2-ui #1: remember *now* whether the opener was keyboard-focused; by close time settings.js or the
    // pointer-click blur has changed that, and a pointer user must come back to nothing focused (Space = sustain).
    lastFocusKb = !!lastFocus?.matches?.(':focus-visible');
    els.settings.hidden = false;
    document.body.classList.add('settings-open');
    try {
      settingsView?.open?.(opts);
    } catch (err) {
      console.warn('[ui] settings open failed', err);
    }
    queueMicrotask(() => {
      const f = els.settings.querySelector('[autofocus], button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (f && typeof f.focus === 'function') f.focus({ preventScroll: true });
    });
  } else if (opts && opts.section) {
    try {
      settingsView?.open?.(opts);
    } catch (err) {
      console.warn('[ui] settings open failed', err);
    }
  }
  $('btn-settings').setAttribute('aria-expanded', 'true');
  return true;
}

function closeSettings() {
  if (!settingsOpen) return;
  settingsOpen = false;
  els.settings.hidden = true;
  document.body.classList.remove('settings-open');
  $('btn-settings').setAttribute('aria-expanded', 'false');
  try {
    settingsView?.close?.();
  } catch (err) {
    console.warn('[ui] settings close failed', err);
  }
  const f = lastFocus;
  const kb = lastFocusKb;
  lastFocus = null;
  lastFocusKb = false;
  // return focus only to keyboard users' targets; pointer users get nothing focused (Space = sustain)
  if (kb && f && f !== document.body && typeof f.focus === 'function' && document.contains(f)) f.focus({ preventScroll: true });
  else if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur?.();
}

// quickButton: the top-bar Quick button; Perform owns the sheet it opens (H-v2 quick.png).
// getBaseline: Perform's Revert snapshot (perform.js savedSnapshot), so Edit's changed dots count against the same
// song state as Perform's Revert (views/edit/CONTRACT.md §3.6). performView is assigned below; Edit mounts later.
const ctx = {
  store, controller, engine, midi, recorder, rig, isElectron, toast, openSettings, closeSettings, setView,
  quickButton: $('btn-quick'),
  getBaseline: () => {
    try {
      return performView?.savedSnapshot ?? null;
    } catch {
      return null; // before mountPerform ran
    }
  },
};

// ------------------------------------------------------------------------------------------ top bar
const viewSwitch = segmented({
  label: 'View',
  options: [
    { value: 'perform', label: 'Perform' },
    { value: 'edit', label: 'Edit' },
  ],
  value: 'perform',
  onChange: (v) => {
    if (!setView(v)) viewSwitch.set(store.get().settings.view);
  },
});
viewSwitch.el.dataset.testid = 'view-switch';
$('view-switch').append(viewSwitch.el);

$('btn-settings').addEventListener('click', () => (settingsOpen ? closeSettings() : openSettings()));
$('btn-settings').setAttribute('aria-expanded', 'false');
$('btn-settings').setAttribute('aria-controls', 'view-settings');

const master = fader({
  path: 'master.volume',
  label: 'Master',
  compact: true,
  relative: true, // a tap never jumps the whole-house volume (UX S7/B2)
  resetOnDoubleClick: false,
  color: 'var(--text)',
  onChange: (v) => store.set('master.volume', v),
});
master.el.dataset.testid = 'master-fader';
$('master-mount').append(master.el);
$('meter-mount').append(meter({ engine, compact: true, label: 'Output level' }).el);

// ------------------------------------------------------------------------------------------ banners
// Full-width, persistent, under the top bar (UX B1): stalled sound, second window, library not saving, newer library.
const bannersEl = $('banners');
const audioBanner = $('audio-banner');
const restartBtn = $('btn-restart-audio');
restartBtn.addEventListener('click', () => {
  setText(audioBanner.querySelector('.banner-msg'), 'Restarting sound…');
  restartBtn.disabled = true;
  Promise.resolve(controller.restartAudio()).finally(() => {
    restartBtn.disabled = false;
  });
});
const banners = new Map(); // id → {el, msg, btns}
/**
 * Show / update / hide a banner.
 * @param {string} id
 * @param {null|{text:string, kind?:'danger'|'warn'|'info', actions?:Array<{label:string, run:()=>void, testid?:string}>}} b
 */
function setBanner(id, b) {
  let cur = banners.get(id);
  if (!b) {
    if (cur) {
      cur.el.remove();
      banners.delete(id);
      layoutBanners();
    }
    return;
  }
  const sig = `${b.kind}|${b.text}|${(b.actions || []).map((a) => a.label).join(',')}`;
  if (cur && cur.sig === sig) return;
  const msg = h('span.banner-msg', { text: b.text });
  const el = h(`div.banner.${b.kind || 'warn'}`, { role: b.kind === 'danger' ? 'alert' : 'status', 'data-testid': `banner-${id}` }, msg);
  for (const a of b.actions || []) {
    const btn = h('button.btn.banner-btn', { type: 'button', 'data-testid': a.testid || null }, a.label);
    btn.addEventListener('click', () => a.run(btn));
    el.append(btn);
  }
  if (cur) cur.el.replaceWith(el);
  else bannersEl.append(el);
  banners.set(id, { el, sig });
  layoutBanners();
}
function layoutBanners() {
  requestAnimationFrame(() => document.documentElement.style.setProperty('--banner-h', `${bannersEl.offsetHeight}px`));
}
function setAudioBanner(state) {
  const on = state === 'stalled' || state === 'restarting';
  if (on === !audioBanner.hidden && !on) return;
  audioBanner.hidden = !on;
  if (state === 'stalled') {
    setText(audioBanner.querySelector('.banner-msg'), 'Sound stopped — click “Restart sound”.');
    restartBtn.disabled = false;
  } else if (state === 'restarting') setText(audioBanner.querySelector('.banner-msg'), 'Restarting sound…');
  layoutBanners();
}
let libraryOfferDismissed = false;
function renderStatusBanners(s) {
  setAudioBanner(s.audio);
  setBanner(
    'instance',
    s.instance === 'secondary'
      ? { kind: 'warn', text: s.instanceMessage || 'Worship Rig is already open in another window. This one is muted and read-only — close it and use the other window.' }
      : null,
  );
  const lib = s.library || {};
  let libBanner = null;
  if (s.instance !== 'secondary' && lib.readOnly) {
    libBanner = {
      kind: 'danger',
      text: lib.readOnlyReason === 'backup-failed' ? 'Your saved library could not be read or backed up, so changes are NOT being saved. Export it from Settings before you edit.' : 'Changes are not being saved right now.',
      actions: locked() ? [] : [{ label: 'Open Settings', run: () => openSettings({ section: 'backups' }) }],
    };
  } else if (lib.persistError) {
    libBanner = {
      kind: 'warn',
      text: 'Your latest changes could not be saved yet — retrying. To be safe, export the library from Settings.',
      actions: locked() ? [] : [{ label: 'Open Settings', run: () => openSettings({ section: 'backups' }) }],
    };
  }
  setBanner('library', libBanner);
  const other = s.otherLibrary;
  if (other && other.path && !libraryOfferDismissed) {
    const when = other.savedAt ? new Date(other.savedAt).toLocaleString() : 'recently';
    const actions = [];
    if (typeof controller.importLatestBackup === 'function') {
      actions.push({
        label: 'Use that library',
        testid: 'import-latest-backup',
        run: async (b) => {
          b.disabled = true;
          const r = await controller.importLatestBackup();
          if (r && r.ok) {
            toast('The newer library was loaded. Your previous one was backed up first.', 'ok');
            setBanner('other-library', null);
          } else {
            b.disabled = false;
            toast('That library could not be loaded. Nothing was changed.', 'error');
            if (r && r.error) console.warn('[ui] importLatestBackup:', r.error);
          }
        },
      });
    }
    actions.push({
      label: 'Not now',
      run: () => {
        libraryOfferDismissed = true;
        setBanner('other-library', null);
      },
    });
    setBanner('other-library', { kind: 'info', text: `A newer song library (saved ${when}) is available from an earlier session.`, actions });
  } else setBanner('other-library', null);
}

// REC
const recBtn = $('btn-rec');
const recTime = $('rec-time');
let recTimer = null;
const fmtTime = (s) => {
  const t = Math.max(0, Math.floor(s));
  const hh = Math.floor(t / 3600);
  const mm = Math.floor((t % 3600) / 60);
  const ss = t % 60;
  const p = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
};
recBtn.addEventListener('click', async () => {
  // called straight from the click so Chrome's save dialog keeps the user gesture
  const r = await controller.record();
  if (r && r.ok === false && !r.cancelled && r.error) {
    console.warn('[ui] recording did not start:', r.error);
    toast('Recording didn’t start. Check that there is free disk space, then try again.', 'error');
  }
});
recorder.addEventListener('state', (e) => {
  const det = e.detail || {};
  const st = det.state;
  recBtn.classList.toggle('recording', st === 'recording');
  recBtn.classList.toggle('busy', st === 'starting' || st === 'stopping');
  recBtn.classList.toggle('unavailable', st === 'unavailable');
  recBtn.setAttribute('aria-pressed', String(st === 'recording'));
  recTime.classList.toggle('on', st === 'recording');
  if (st === 'recording') {
    clearInterval(recTimer);
    setText(recTime, '00:00');
    recTimer = setInterval(() => setText(recTime, fmtTime(recorder.elapsed)), 250);
    toast(`Recording${det.path ? ` to ${det.path}` : det.filename ? ` “${det.filename}”` : ''}`, 'info', { ms: 3000 });
  } else if (st === 'idle' || st === 'unavailable') {
    clearInterval(recTimer);
    recTimer = null;
    const res = det.result;
    if (res && !res.error) {
      const where = res.path ? `Saved ${res.path}` : res.sink === 'fsa' ? `Saved “${res.filename}”` : `Saved “${res.filename}” (downloaded)`;
      toast(`${where} — ${fmtTime(res.durationSec || 0)}`, 'ok', res.path && rig?.revealFile ? { ms: 8000, action: { label: 'Show', run: () => rig.revealFile(res.path) } } : {});
    }
    if (st === 'unavailable') {
      if (det.reason) console.warn('[ui] recording unavailable:', det.reason);
      toast('Recording isn’t available on this computer right now.', 'error');
    }
  }
  document.body.classList.toggle('recording', st === 'recording');
});
recorder.addEventListener('warn', (e) => plainToast(e.detail?.message, 'warn'));

// Ready light (UX state table): "Loading 3/11" → "Ready". Counted from the engine's decoded-sample cache.
let readyTimer = null;
function songsLoaded() {
  const ids = store.navIds();
  let done = 0;
  try {
    const cache = engine.cache;
    const samplers = engine.registry?.samplers;
    if (!cache?.entries || !samplers) return null;
    for (const id of ids) {
      const song = store.getSong(id);
      if (!song) continue;
      let ok = true;
      for (const sl of song.patch.slots) {
        if (!sl || sl.instrument.type !== 'sampler') continue;
        const def = samplers.get(sl.instrument.id);
        if (!def) continue;
        for (const L of def.layers || []) for (const smp of L.samples || []) if (!cache.entries.has(smp.url) && !cache.failed?.has?.(smp.url)) ok = false;
      }
      if (ok) done += 1;
    }
  } catch {
    return null;
  }
  return { done, total: ids.length };
}
function renderReady(s) {
  const ready = !!s.ready;
  setLed(readyLed, ready ? 'ok' : s.instance === 'secondary' ? null : 'warn');
  $('ready-status').classList.toggle('on', ready);
  if (ready || s.instance === 'secondary') {
    setText(readyText, ready ? 'Ready' : 'Not loaded');
    clearInterval(readyTimer);
    readyTimer = null;
    return;
  }
  const upd = () => {
    const c = songsLoaded();
    setText(readyText, c && c.total ? `Loading ${Math.min(c.done, c.total)}/${c.total}` : 'Loading…');
  };
  upd();
  if (!readyTimer) readyTimer = setInterval(upd, 500);
}
controller.addEventListener('menu', (e) => {
  if (e.detail?.id === 'openSettings') openSettings();
});

// perform lock + view from the store
let lastView = null;
let lastLock = null;
let lastSongId;
function onSettings(state) {
  const st = state.settings;
  if (st.performLock !== lastLock) {
    lastLock = st.performLock;
    document.body.classList.toggle('perform-locked', !!st.performLock);
    viewSwitch.setDisabled(!!st.performLock, 'edit');
    $('btn-settings').disabled = !!st.performLock;
    if (st.performLock && settingsOpen) closeSettings();
  }
  if (st.view !== lastView) {
    if (st.view === 'edit' && st.performLock) {
      // ⌘E / menu while locked: stay in Perform
      toast('Perform lock is on — unlock it to edit.', 'warn');
      store.set('settings.view', 'perform');
      return;
    }
    lastView = st.view;
    applyView(st.view);
  }
  const song = state.songs[st.currentSongId];
  if (st.currentSongId !== lastSongId) {
    lastSongId = st.currentSongId;
    master.cancelDrag?.(); // round2-ui #2: 'master.volume' is a current-song alias; don't drag into the next song
  }
  master.set(song ? song.patch.fx.master.volume : master.get());
  master.setDisabled(!song);
}
store.subscribe(onSettings);
onSettings(store.get());

// status lights
const midiLed = $('midi-led');
const midiName = $('midi-name');
const audioLed = $('audio-led');
const audioText = $('audio-text');
const audioLatency = $('audio-latency');
const readyLed = $('ready-led');
const readyText = $('ready-text');
const setLed = (el, cls) => {
  el.classList.remove('ok', 'warn', 'bad');
  if (cls) el.classList.add(cls);
};
let lastStatus = null;
let midiHintShown = false;
let midiPendingShown = false;
controller.onStatus((s) => {
  const m = s.midi || {};
  if (m.connected) {
    setLed(midiLed, 'ok');
    setText(midiName, m.name || 'Connected');
    midiName.classList.remove('off');
  } else if (m.available) {
    setLed(midiLed, 'warn');
    setText(midiName, 'No device');
    midiName.classList.add('off');
  } else if (m.pending || m.reason === 'pending') {
    // polish-1 (local L-3 follow-up): Web MIDI has not answered yet (Chrome's permission prompt, a slow CoreMIDI);
    // it attaches by itself when it does, so this is "waiting", not an error
    setLed(midiLed, 'warn');
    setText(midiName, 'Waiting…');
    midiName.classList.add('off');
  } else if (m.reason) {
    setLed(midiLed, 'bad');
    setText(midiName, { denied: 'Blocked', unsupported: 'Not supported', failed: 'Error' }[m.reason] || 'Off');
    midiName.classList.add('off');
  } else {
    setLed(midiLed, null);
    setText(midiName, 'Waiting…');
  }
  const pending = !!(m.pending || m.reason === 'pending');
  $('midi-status').title = m.connected ? `MIDI input: ${m.name}` : pending ? 'Waiting for MIDI permission'
    : m.reason ? `MIDI unavailable (${m.reason})` : 'MIDI input';

  const a = s.audio;
  const lat = Number(s.latencyMs) || 0;
  const secondary = s.instance === 'secondary';
  setLed(audioLed, secondary ? 'warn' : a === 'running' ? (lat >= 40 ? 'warn' : 'ok') : a === 'stalled' ? 'bad' : 'warn');
  setText(audioText, secondary ? 'Muted' : { running: 'Sound OK', suspended: 'Paused', stalled: 'Stopped', restarting: 'Restarting…' }[a] || 'Sound');
  setText(audioLatency, lat > 0 ? `${Math.round(lat)} ms` : '— ms');
  audioLatency.classList.toggle('warn', lat >= 40);
  audioLatency.title = lat >= 40 ? 'The delay between key and sound is high (40 ms or more). In Settings, choose “Lowest” delay or another output.' : 'Delay between key and sound';
  renderReady(s);
  renderStatusBanners(s);
  if (!midiHintShown && m.available && !m.connected && (m.inputs || []).length === 0 && lastStatus && !lastStatus.midi?.available) {
    midiHintShown = true;
    toast('No MIDI keyboard found. Plug it in any time — it connects automatically. Meanwhile the computer keys A–; play notes.', 'info', { ms: 8000 });
  }
  // pending is not a failure: no "could not start" toast, and midiHintShown stays free for a later denial
  if (pending && !midiPendingShown) {
    midiPendingShown = true;
    toast(isElectron ? 'MIDI is taking a while to start. The computer keys A–; play notes meanwhile.'
      : 'Waiting for MIDI permission — click Allow in Chrome’s prompt to play your keyboard.', 'info', { ms: 10000 });
  }
  if (!midiHintShown && !pending && m.reason && m.reason !== lastStatus?.midi?.reason) {
    midiHintShown = true;
    if (m.reason === 'denied') toast(isElectron ? 'MIDI access was denied.' : 'MIDI is blocked for this page. Click the icon at the left of the address bar, allow MIDI devices, then reload.', 'warn', { ms: 10000 });
    else if (m.reason === 'unsupported') toast('This browser has no Web MIDI. Use Chrome or the Worship Rig app to play a MIDI keyboard.', 'warn', { ms: 10000 });
    else toast('MIDI could not start. Unplug and replug the keyboard, then reload.', 'warn');
  }
  lastStatus = s;
});
let flashTimer = null;
controller.addEventListener('midi-activity', () => {
  midiLed.classList.add('flash');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => midiLed.classList.remove('flash'), 90);
});
controller.addEventListener('warn', (e) => {
  const m = e.detail?.message;
  // shown as a persistent banner instead of a toast
  if (m && (m === controller.status.instanceMessage || /another worship rig window/i.test(m) || /newer library from/i.test(m))) return;
  plainToast(m, 'warn');
});
controller.addEventListener('statechange', (e) => {
  if (e.detail?.state === 'restarted') toast(e.detail.auto ? 'Sound was restarted automatically.' : 'Sound restarted.', 'ok');
});
controller.addEventListener('pads-restored', (e) => {
  const n = e.detail?.count;
  if (Number.isFinite(n)) toast(`My Pads reconnected: ${n} key${n === 1 ? '' : 's'}.`, 'ok', { ms: 3000 });
});

// ------------------------------------------------------------------------------------------ Esc safety (UX M1)
// The controller treats Esc as Panic unless the event is defaultPrevented. Panic on Esc only in Perform with no
// dialog / confirm open and nothing focused; otherwise Esc does its usual job (close, cancel, leave a control).
// Registered on document (bubble) *before* controller.start() adds its own document listener, so element handlers
// (ui-edit's confirm cancel etc.) have already run and the controller sees defaultPrevented.
// Only reached in Perform (Edit/Settings return earlier), so Edit's confirms need no selectors here (round2-ui #9).
// body.dataset.dialogOpen (markDialog) is deliberately not read: a confirm left open in the hidden Edit view would
// keep it up and silently disarm Esc = Panic in Perform.
function popupOpen() {
  if (settingsOpen) return true;
  const visible = (el) => el.getClientRects().length > 0;
  for (const el of document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]')) {
    if (el.closest('[hidden]') || !visible(el)) continue; // e.g. Settings' inner dialog while the modal is closed
    return true;
  }
  return false;
}
function focusedControl() {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  return el.matches?.('button, input, select, textarea, summary, [role="button"], [role="radio"], [role="slider"], [role="spinbutton"], [contenteditable=""], [contenteditable="true"], [tabindex]') ? el : null;
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  const view = store.get().settings.view;
  if (view !== 'perform' || popupOpen()) {
    e.preventDefault(); // Edit / dialogs: Esc cancels, never panics (⌘. stays the global panic)
    return;
  }
  const f = focusedControl();
  if (f && !els.overlay.contains(f)) {
    e.preventDefault(); // first Esc just lets go of the focused control; the next one panics
    f.blur?.();
  }
});

// settings modal: backdrop click and Esc close it (Esc does not panic while Settings is open)
els.settings.addEventListener('click', (e) => {
  if (e.target === els.settings) closeSettings();
});
window.addEventListener(
  'keydown',
  (e) => {
    if (settingsOpen && e.key === 'Escape') {
      e.preventDefault();
      closeSettings();
    }
  },
  true,
);

// buttons blur after a pointer click (Space = sustain only when nothing is focused; SPEC §10)
document.addEventListener('click', (e) => {
  if (e.detail === 0) return;
  const b = e.target instanceof Element ? e.target.closest('button, [role="button"], [role="radio"], input[type="checkbox"], input[type="range"]') : null;
  if (b && !els.settings.contains(b)) queueMicrotask(() => b.blur());
});

// Don't cut the sound (or a take) by closing / reloading the tab (UX M2). Chrome: armed once audio has run.
// Electron asks natively only while recording (its will-prevent-unload dialog is recording-specific), so there the
// guard stays recording-only.
let audioHasRun = false;
window.addEventListener('beforeunload', (e) => {
  if (engine.ctx && engine.ctx.state === 'running') audioHasRun = true;
  const guard = recorder.isRecording || (!isElectron && audioHasRun && controller.status.instance !== 'secondary');
  if (guard) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ------------------------------------------------------------------------------------------ mount views
const performView = mountPerform(els.perform, ctx);
// Quick settings sheet (H-v2): Perform only; the sheet is non-modal, so the keys keep playing while it is open
$('btn-quick').addEventListener('click', () => {
  if (store.get().settings.view !== 'perform') return;
  performView.toggleQuick();
});

function placeholder(el, text) {
  el.replaceChildren(h('div.view-placeholder', { text }));
}
function settingsPlaceholder(el) {
  const close = h('button.btn', { type: 'button' }, 'Close');
  close.addEventListener('click', () => closeSettings());
  el.replaceChildren(h('div.settings-placeholder', { role: 'dialog', 'aria-label': 'Settings' }, h('h2', { text: 'Settings' }), h('p', { text: 'Settings view loading…' }), close));
}

async function loadModule(path, fnName) {
  try {
    const mod = await import(path);
    return typeof mod[fnName] === 'function' ? mod[fnName] : null;
  } catch (err) {
    console.warn(`[ui] ${path} not available: ${err && err.message}`);
    return null;
  }
}
placeholder(els.edit, 'Edit view loading…');
settingsPlaceholder(els.settings);
els.settings.setAttribute('role', 'dialog');
els.settings.setAttribute('aria-modal', 'true');
els.settings.setAttribute('aria-label', 'Settings');
const viewsReady = Promise.all([
  // H-v2 Edit (views/edit/shell.js; hv2-edit-integrate). The old views/edit.js is retired.
  loadModule('./views/edit/shell.js', 'mountEdit').then((mountEdit) => {
    if (!mountEdit) return;
    try {
      editView = mountEdit(els.edit, ctx) || null;
    } catch (err) {
      console.warn('[ui] mountEdit failed', err);
      placeholder(els.edit, 'Edit view failed to load.');
    }
  }),
  loadModule('./views/settings.js', 'mountSettings').then((mountSettings) => {
    if (!mountSettings) return;
    try {
      settingsView = mountSettings(els.settings, ctx) || null;
      // round2-ui #11: settings.js renders its own role=dialog aria-modal; the host keeps them only for the placeholder
      if (settingsView) for (const a of ['role', 'aria-modal', 'aria-label']) els.settings.removeAttribute(a);
    } catch (err) {
      console.warn('[ui] mountSettings failed', err);
      settingsPlaceholder(els.settings);
    }
  }),
]);

// ------------------------------------------------------------------------------------------ start
const info = store.loadInfo;
layoutBanners();
if (info.status === 'corrupt') toast('Your saved library could not be read, so the factory songs were loaded. The old data was kept as a backup.', 'error', { ms: 14000 });
else if (info.status === 'future-schema') toast('Your library was saved by a newer version of Worship Rig. It was kept as a backup and the factory songs were loaded.', 'error', { ms: 14000 });

let overlayArmed = false;
function audioRunning() {
  return !!(engine.ctx && engine.ctx.state === 'running');
}
function showOverlay() {
  if (audioRunning() || overlayArmed) return;
  overlayArmed = true;
  els.overlay.hidden = false;
  const go = async (e) => {
    e?.preventDefault?.();
    await controller.resumeAudio();
    if (audioRunning()) hideOverlay();
  };
  els.overlay.addEventListener('pointerdown', go);
  window.addEventListener('keydown', go, { capture: true, once: true });
  els.overlay._go = go;
}
function hideOverlay() {
  els.overlay.hidden = true;
  if (els.overlay._go) {
    els.overlay.removeEventListener('pointerdown', els.overlay._go);
    window.removeEventListener('keydown', els.overlay._go, { capture: true });
  }
  overlayArmed = false;
}
engine.addEventListener('statechange', () => {
  if (audioRunning()) {
    audioHasRun = true;
    hideOverlay();
  }
});

async function firstRunHints() {
  if (isElectron || !navigator.permissions?.query) return;
  try {
    const p = await navigator.permissions.query({ name: 'midi' });
    if (p.state === 'prompt') toast('Chrome will ask to use your MIDI devices — click “Allow”.', 'info', { ms: 10000 });
  } catch {
    /* permission name unsupported */
  }
}

const started = controller.start(); // creates the AudioContext synchronously, then loads the current song
firstRunHints();
// Only show the overlay if the context didn't start on its own (autoplay-allowed launchers and Electron start at once).
setTimeout(() => {
  if (!audioRunning()) showOverlay();
}, 600);
started.then(() => {
  if (!audioRunning()) showOverlay();
});
applyView(store.get().settings.view === 'edit' && !locked() ? 'edit' : 'perform');

// test / debugging handle (not an API)
globalThis.__rig = { store, engine, controller, midi, recorder, ctx, views: { perform: performView, get edit() { return editView; }, get settings() { return settingsView; } }, ready: started, viewsReady, ui: { setBanner, plainMessage, toast } };
