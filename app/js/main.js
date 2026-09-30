// Worship Rig bootstrap (SPEC §13): store → engine → midi/recorder → controller → views.
// Also owns the top bar, view switching, the settings modal, toasts, the start overlay and first-run hints.
import { createStore } from './store.js';
import { FACTORY_SONGS } from './presets.js';
import { AudioEngine } from './engine/index.js';
import { MidiInput } from './midi.js';
import { Recorder } from './recorder.js';
import { createController, engineLatency } from './controller.js';
import { mountPerform } from './views/perform.js';
import { h, setText, segmented, fader, meter, openOverlay, wakeMeters, meterClockStats } from './views/components/index.js';
import { guardKeyActivation } from './views/components/util.js';
import { warmThemeFonts, releaseWarmedFonts } from './views/components/themeFonts.js';
import { resolveThemeId, themeAttrs, THEME_MIRROR_KEY } from './shared/themes.js';

const $ = (id) => document.getElementById(id);
const rig = globalThis.rig || null;
const isElectron = !!(rig && rig.isElectron);

// ------------------------------------------------------------------------------------------ toasts
const TOAST_MS = { info: 4500, ok: 4000, warn: 7000, error: 10000 };
const toastsEl = $('toasts');
const liveToasts = new Map(); // message → {el, timer, count, kind}
// round4-perform P8: when the stack is trimmed, the lowest severity goes first (an error outlives later infos)
const TOAST_RANK = { info: 0, ok: 0, warn: 1, error: 2 };

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
  const entry = { el, countEl, count: 1, kind: k, timer: arm(() => dismiss(text)) };
  liveToasts.set(text, entry);
  toastsEl.append(el);
  // keep the stack short on stage: drop the oldest of the lowest severity (Map order = oldest first)
  while (liveToasts.size > 2) {
    let victim = null;
    let rank = Infinity;
    for (const [t, e] of liveToasts) {
      const r = TOAST_RANK[e.kind] ?? 0;
      if (r < rank) [victim, rank] = [t, r];
    }
    dismiss(victim);
  }
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
  // onboarding O7: plugging in doesn't stop the display sleeping; say what does
  if (/wake ?lock/i.test(m)) return { text: 'The screen may dim or sleep during long songs. For the service, set the display to stay on.', kind: 'info', once: true };
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

// ------------------------------------------------------------------------------------------ theme (themes-setup)
// app/themes/boot.js already set html/body[data-theme|data-mode] and linked #theme-css from the localStorage mirror
// before first paint. Here the store wins: settings.theme (absent = default) is applied at boot and on every change,
// and the mirror follows it. A switch loads the new sheet disabled (media="not all") at the end of <head>, warms its
// fonts, then enables it, drops the old one and flips the attributes in one task: the page shows the old theme or the
// new one, never an unstyled frame (test/phase2/themes).
let themeSeq = 0;
let themeApplied = null;
let themePending = Promise.resolve();
function setThemeAttrs(a) {
  const html = document.documentElement;
  html.dataset.theme = a.html.theme;
  html.dataset.mode = a.html.mode;
  html.style.colorScheme = a.colorScheme;
  if (document.body) {
    document.body.dataset.theme = a.body.theme;
    document.body.dataset.mode = a.body.mode;
  }
}
/**
 * Switch the page to theme `id` (unknown → default). Resolves once the new look is showing.
 * @param {string} id
 * @returns {Promise<string>} the applied id
 */
async function applyTheme(id) {
  const tid = resolveThemeId(id);
  const a = themeAttrs(tid);
  const seq = ++themeSeq;
  try {
    localStorage.setItem(THEME_MIRROR_KEY, tid);
  } catch {
    /* storage blocked: boot falls back to the default, then this corrects it */
  }
  themeApplied = tid;
  const cur = document.getElementById('theme-css');
  const curHref = cur ? cur.getAttribute('href') : null;
  if (curHref === a.css || (!a.css && !cur)) {
    setThemeAttrs(a); // same file (Daylight Stage ↔ Day) or Classic → Classic: attributes only
    return tid;
  }
  if (!a.css) {
    cur.remove();
    setThemeAttrs(a);
    return tid;
  }
  for (const n of document.head.querySelectorAll('link[data-theme-next]')) n.remove(); // an earlier, overtaken switch
  const next = document.createElement('link');
  next.rel = 'stylesheet';
  next.media = 'not all';
  next.dataset.themeNext = tid;
  const loaded = new Promise((res) => {
    next.addEventListener('load', () => res(true), { once: true });
    next.addEventListener('error', () => res(false), { once: true });
  });
  next.href = a.css;
  document.head.append(next);
  const ok = await loaded;
  // T1/T2 (themes-critic): the copies carry every descriptor (metric overrides, unicode-range) and are deleted once
  // the enabled sheet's own faces are loaded, so a runtime switch renders exactly like a fresh boot
  const faces = ok ? await warmThemeFonts(next.sheet) : [];
  if (seq !== themeSeq || !ok) {
    next.remove();
    await releaseWarmedFonts(faces);
    if (!ok) console.warn('[ui] theme stylesheet failed to load:', a.css);
    return themeApplied;
  }
  next.removeAttribute('media');
  delete next.dataset.themeNext;
  cur?.remove();
  next.id = 'theme-css';
  setThemeAttrs(a);
  await releaseWarmedFonts(faces);
  return tid;
}
function onThemeSetting(state) {
  const tid = resolveThemeId(state.settings.theme);
  if (tid === themeApplied) return;
  themePending = applyTheme(tid);
}
store.subscribe(onThemeSetting);
// boot reconcile: the store wins over the mirror boot.js read (e.g. a library imported in another window)
if (document.documentElement.dataset.theme === resolveThemeId(store.get().settings.theme)) {
  themeApplied = document.documentElement.dataset.theme;
  try {
    localStorage.setItem(THEME_MIRROR_KEY, themeApplied);
  } catch {
    /* storage blocked */
  }
}
onThemeSetting(store.get());
// Quick › This Mac › Theme asks for Settings › Appearance with a DOM event (quickSheet has no ctx)
document.addEventListener('rig-open-settings', (e) => openSettings({ section: e.detail?.section }));

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
// onboarding O13: Edit and ⚙ are disabled under Perform lock, and a disabled button gets no click; Chromium still
// sends pointerdown, so a tap on one says why instead of doing nothing
const LOCKED_TAP_TEXT = 'Perform lock is on — hold Lock to unlock, then edit.';
document.addEventListener('pointerdown', (e) => {
  if (!locked()) return;
  const b = e.target?.closest?.('button:disabled');
  if (b && (b.id === 'btn-settings' || b.closest('#view-switch'))) toast(LOCKED_TAP_TEXT, 'info', { ms: 3000 });
}, true);

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
  // round4-perform P4: an unfolded banner strip ("Open Settings" is one of its actions) must not stay over the modal
  setBstripOpen(false);
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
// Under the top bar (UX B1). Stalled sound keeps its full-width banner (index.html; brief, and it has the one action
// that matters). The persistent ones (second window, library not saving, newer library) share ONE 32 px strip
// (polish-2A, ux-round2 L2: 58–66 px each took the faders' throw for a whole service): the most urgent message on one
// line with its buttons, "+N" when there are more, and a chevron that drops the full texts over the stage (never
// taller in the layout). Esc or a tap outside folds it back.
const bannersEl = $('banners');
const BANNER_RANK = { danger: 0, warn: 1, info: 2 };
const bstripList = h('div.bstrip-list');
const bstripCount = h('span.bstrip-count');
const bstripMore = h(
  'button.bstrip-more',
  {
    type: 'button', 'aria-expanded': 'false', 'aria-label': 'Show the whole message', title: 'Show the whole message',
    'data-testid': 'banner-expand',
  },
  bstripCount,
  h('span.bstrip-chev', { 'aria-hidden': 'true', text: '▾' }),
);
const bstrip = h('div.bstrip', { hidden: true, 'data-testid': 'banner-strip' }, bstripList, bstripMore);
bannersEl.append(bstrip);
let closeBstrip = null;
function setBstripOpen(open) {
  if (!open) return closeBstrip?.('api');
  if (closeBstrip) return;
  bstrip.classList.add('open');
  bstripMore.setAttribute('aria-expanded', 'true');
  closeBstrip = openOverlay({
    el: bstripList,
    anchors: [bstripMore],
    group: 'banners',
    onClose: () => {
      bstrip.classList.remove('open');
      bstripMore.setAttribute('aria-expanded', 'false');
      closeBstrip = null;
    },
  });
}
bstripMore.addEventListener('click', () => setBstripOpen(!closeBstrip));
function layoutBstrip() {
  const items = [...banners.values()].sort((a, b) => a.rank - b.rank || a.order - b.order);
  items.forEach((b, i) => {
    if (bstripList.children[i] !== b.el) bstripList.insertBefore(b.el, bstripList.children[i] || null);
  });
  const n = items.length;
  bstrip.hidden = n === 0;
  bstrip.dataset.kind = n ? items[0].kind : '';
  setText(bstripCount, n > 1 ? `+${n - 1}` : '');
  bstripMore.setAttribute('aria-label', n > 1 ? `Show all ${n} messages` : 'Show the whole message');
  if (!n) setBstripOpen(false);
}
let bannerOrder = 0;
const audioBanner = $('audio-banner');
const restartBtn = $('btn-restart-audio');
restartBtn.addEventListener('click', () => {
  setText(audioBanner.querySelector('.banner-msg'), 'Restarting sound…');
  restartBtn.disabled = true;
  Promise.resolve(controller.restartAudio()).finally(() => {
    restartBtn.disabled = false;
  });
});
const banners = new Map(); // id → {el, sig, kind, rank, order}
/**
 * Show / update / hide a persistent banner (one line of the shared strip).
 * @param {string} id
 * @param {null|{text:string, short?:string, kind?:'danger'|'warn'|'info',
 *   actions?:Array<{label:string, run:()=>void, testid?:string}>}} b
 *   short: the words the folded strip shows (the full text shows when it is unfolded, and as the tooltip)
 */
function setBanner(id, b) {
  const cur = banners.get(id);
  if (!b) {
    if (cur) {
      cur.el.remove();
      banners.delete(id);
      layoutBstrip();
      layoutBanners();
    }
    return;
  }
  const kind = b.kind || 'warn';
  const sig = `${kind}|${b.text}|${b.short || ''}|${(b.actions || []).map((a) => a.label).join(',')}`;
  if (cur && cur.sig === sig) return;
  const msg = h('span.banner-msg', { text: b.text });
  const short = b.short ? h('span.banner-short', { text: b.short, 'aria-hidden': 'true' }) : null;
  const el = h(
    `div.banner.${kind}`,
    {
      role: kind === 'danger' ? 'alert' : 'status', 'data-testid': `banner-${id}`, title: b.text,
      class: short ? 'has-short' : '',
    },
    h('span.banner-dot', { 'aria-hidden': 'true' }),
    short,
    msg,
  );
  for (const a of b.actions || []) {
    const btn = h('button.btn.banner-btn', { type: 'button', 'data-testid': a.testid || null }, a.label);
    btn.addEventListener('click', () => a.run(btn));
    el.append(btn);
  }
  if (cur) cur.el.replaceWith(el);
  banners.set(id, { el, sig, kind, rank: BANNER_RANK[kind] ?? 1, order: cur ? cur.order : ++bannerOrder });
  layoutBstrip();
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
      ? { kind: 'warn', short: 'Another Worship Rig window is open — this one is muted',
        text: s.instanceMessage
          || 'Worship Rig is already open in another window. This one is muted and read-only — '
          + 'close it and use the other window.' }
      : null,
  );
  const lib = s.library || {};
  let libBanner = null;
  if (s.instance !== 'secondary' && lib.readOnly) {
    libBanner = {
      kind: 'danger',
      short: 'Changes are NOT being saved',
      text: lib.readOnlyReason === 'backup-failed' ? 'Your saved library could not be read or backed up, so changes are NOT being saved. Export it from Settings before you edit.' : 'Changes are not being saved right now.',
      actions: locked() ? [] : [{ label: 'Open Settings', run: () => openSettings({ section: 'backups' }) }],
    };
  } else if (lib.persistError) {
    libBanner = {
      kind: 'warn',
      short: 'Latest changes not saved yet — retrying',
      text: 'Your latest changes could not be saved yet — retrying. To be safe, export the library from Settings.',
      actions: locked() ? [] : [{ label: 'Open Settings', run: () => openSettings({ section: 'backups' }) }],
    };
  }
  setBanner('library', libBanner);
  const other = s.otherLibrary;
  if (other && other.path && !libraryOfferDismissed) {
    const when = other.savedAt ? new Date(other.savedAt).toLocaleString() : 'recently';
    const actions = [];
    // round4-perform P6: replacing the whole library is withheld under Perform lock (as "Open Settings" is); the offer
    // keeps "Not now", and the button comes back on the next status tick after unlocking
    if (typeof controller.importLatestBackup === 'function' && !locked()) {
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
    setBanner('other-library', {
      kind: 'info',
      short: 'A newer song library is available',
      text: `A newer song library (saved ${when}) is available from an earlier session.`,
      actions,
    });
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
  // onboarding O11: stopping can take a while (the file is finished and written); say so where the time was
  recTime.classList.toggle('on', st === 'recording' || st === 'stopping');
  recTime.classList.toggle('saving', st === 'stopping');
  if (st === 'stopping') {
    clearInterval(recTimer);
    recTimer = null;
    setText(recTime, 'Saving…');
  }
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
const READY_TITLE = 'Every song in the set is loaded and switches instantly';
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
    $('ready-status').title = READY_TITLE;
    setText(readyText, ready ? 'Ready' : 'Not loaded');
    clearInterval(readyTimer);
    readyTimer = null;
    return;
  }
  const upd = () => {
    const c = songsLoaded();
    setText(readyText, c && c.total ? `Loading ${Math.min(c.done, c.total)}/${c.total}` : 'Loading…');
    // onboarding O3: the count is the rest of the set loading behind the current song, which can be played now
    $('ready-status').title = c && c.total
      ? `Loading the songs in the set (${Math.min(c.done, c.total)} of ${c.total} ready). You can play now.`
      : 'Loading sounds. You can play once the song name stops saying “Loading…”.';
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
    // round4-perform P6: the banners' lock-gated actions follow the lock at once, not on the next status tick
    // (a microtask: the first call runs before `lastStatus` is declared below)
    queueMicrotask(() => {
      if (lastStatus) renderStatusBanners(lastStatus);
    });
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
let midiPromptHintShown = false; // round4-perform P7: firstRunHints already told Chrome users about the prompt
// polish-2A ("## l3" UI follow-up): pending is info, never a failure, and a reload would not help
const MIDI_PENDING_TEXT = 'MIDI starting… answer the browser’s permission prompt if it appears.';
const MIDI_PENDING_TEXT_ELECTRON = 'MIDI is taking a while to start. The computer keys A–; play notes meanwhile.';
const MIDI_DENIED_TEXT = 'MIDI was blocked — allow it in the browser’s site settings.';
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
    // polish-1 / polish-2A (local L-3 follow-up): Web MIDI has not answered yet (Chrome's permission prompt, a slow
    // CoreMIDI); it attaches by itself when it does, so this is "starting", not an error
    setLed(midiLed, 'warn');
    setText(midiName, 'Starting…');
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
  $('midi-status').title = m.connected ? `MIDI input: ${m.name}` : pending ? MIDI_PENDING_TEXT
    : m.reason === 'denied' && !isElectron ? MIDI_DENIED_TEXT
      : m.reason === 'failed' ? 'MIDI could not start — unplug and replug the keyboard'
        : m.reason ? `MIDI unavailable (${m.reason})` : 'MIDI input';

  renderAudioStatus(s);
  renderReady(s);
  renderStatusBanners(s);
  if (!midiHintShown && m.available && !m.connected && (m.inputs || []).length === 0 && lastStatus && !lastStatus.midi?.available) {
    midiHintShown = true;
    toast('No MIDI keyboard found. Plug it in any time — it connects automatically. Meanwhile the computer keys A–; play notes.', 'info', { ms: 8000 });
  }
  // pending is not a failure: no "could not start" toast, and midiHintShown stays free for a later denial
  if (pending && !midiPendingShown) {
    midiPendingShown = true;
    if (isElectron) toast(MIDI_PENDING_TEXT_ELECTRON, 'info', { ms: 10000 });
    else if (!midiPromptHintShown) toast(MIDI_PENDING_TEXT, 'info', { ms: 10000 });
  }
  // round4-perform P7: the "starting" toast goes as soon as MIDI has answered (the lamp says the rest)
  if (!pending) {
    dismiss(MIDI_PENDING_TEXT);
    dismiss(MIDI_PENDING_TEXT_ELECTRON);
  }
  if (!midiHintShown && !pending && m.reason && m.reason !== lastStatus?.midi?.reason) {
    midiHintShown = true;
    if (m.reason === 'denied') toast(isElectron ? 'MIDI access was denied.' : MIDI_DENIED_TEXT, 'warn', { ms: 10000 });
    else if (m.reason === 'unsupported') toast('This browser has no Web MIDI. Use Chrome or the Worship Rig app to play a MIDI keyboard.', 'warn', { ms: 10000 });
    else toast('MIDI could not start. Unplug and replug the keyboard, then reload.', 'warn');
  }
  lastStatus = s;
});
/**
 * Top-bar sound lamp. onboarding O14: the controller starts out 'running' and only corrects itself on its 1 s tick, so
 * a plain Chrome tab said "Sound OK" under the "Click anywhere to start audio" overlay; the context's own state wins
 * (also re-run when the context changes state or the overlay shows).
 */
function renderAudioStatus(s) {
  if (!s) return;
  const ctxState = engine.ctx?.state;
  const a = s.audio === 'running' && ctxState !== 'running' ? (ctxState ? 'suspended' : 'starting') : s.audio;
  const lat = Number(s.latencyMs) || 0;
  const secondary = s.instance === 'secondary';
  // lowres2: 'asleep' is the controller's own audio sleep (it wakes on the next input), a normal state, not a warning;
  // the controller keeps status.audio 'asleep' while the context is suspended, so the ctx override above leaves it
  const led = a === 'running' ? (lat >= 40 ? 'warn' : 'ok') : a === 'asleep' ? 'ok' : a === 'stalled' ? 'bad' : 'warn';
  setLed(audioLed, secondary ? 'warn' : led);
  const text = { running: 'Sound OK', asleep: 'Asleep', suspended: 'Paused', stalled: 'Stopped', restarting: 'Restarting…' };
  setText(audioText, secondary ? 'Muted' : text[a] || 'Sound');
  setText(audioLatency, lat > 0 ? `${Math.round(lat)} ms` : '— ms');
  audioLatency.classList.toggle('warn', lat >= 40);
  audioLatency.title = lat >= 40 ? 'The delay between key and sound is high (40 ms or more). In Settings, choose “Lowest” delay or another output.' : 'Delay between key and sound';
}
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
  renderAudioStatus(lastStatus); // O14: never "Sound OK" under "Click anywhere to start audio"
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
  renderAudioStatus(lastStatus); // O14
});

async function firstRunHints() {
  if (isElectron || !navigator.permissions?.query) return;
  try {
    const p = await navigator.permissions.query({ name: 'midi' });
    if (p.state !== 'prompt') return;
    midiPromptHintShown = true;
    toast('Chrome will ask to use your MIDI devices — click “Allow”.', 'info', { ms: 10000 });
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

// ------------------------------------------------------------------------------------------ menu-bar mode
// docs/menubar-mode.md (C7 menubar-B). The main bus is created by the controller (menubar-A defaultBus(): the Electron
// relay or BroadcastChannel 'rig-bus'), so this renderer does not open a second one. Here: window visibility →
// controller, low-resource → <html data-low-resource> (styles.css hides the meters, which stops their rAF loops via
// their IntersectionObservers), settings.menuBarMode → Electron main.
const WINDOW_MENU_IDS = { windowShown: true, windowHidden: false, windowFollowDocument: null };
const setWindowVisible = (v) => {
  // idle-cpu R4: a hidden window (Electron keeps rendering: backgroundThrottling is off) hides the meters the way
  // low-resource does, which takes them out of their IntersectionObservers and stops their loops
  document.documentElement.toggleAttribute('data-window-hidden', v === false);
  try {
    controller.setWindowVisible?.(v);
  } catch (err) {
    console.warn('[ui] setWindowVisible failed', err);
  }
};
// Electron keeps backgroundThrottling off (audio), so a hidden window may never fire visibilitychange there; the
// Electron main process reports show/hide as rig menu ids instead (controller re-emits unknown ids as 'menu').
document.addEventListener('visibilitychange', () => setWindowVisible(document.visibilityState !== 'hidden'));
controller.addEventListener('menu', (e) => {
  const id = e.detail?.id;
  if (id in WINDOW_MENU_IDS) setWindowVisible(WINDOW_MENU_IDS[id]);
});
// idle-cpu R4 / menubar-electron: LOCAL's preload re-dispatches main's 'rig:window-visible' IPC on window as a DOM
// event, on every show / hide / minimize in every mode (the menu ids above only come in menu-bar mode)
window.addEventListener('rig:window-visible', (e) => {
  if (typeof e.detail?.visible === 'boolean') setWindowVisible(e.detail.visible);
});
controller.addEventListener('openMain', () => {
  if (isElectron) return; // Electron main shows + focuses the window
  try {
    window.focus();
  } catch {
    /* best effort in a browser tab */
  }
});
// idle-cpu R1 / idle-cpu-ui: the shared meter loop stops once every meter is silent; the controller's activity signal
// (any input incl. note-on, a song applied, drone / master edits, recording, an audio wake) restarts it. 'notes' too,
// for a controller without onActivity.
if (typeof controller.onActivity === 'function') controller.onActivity(() => wakeMeters());
controller.addEventListener('notes', () => wakeMeters());
// L-24: a key press interrupted by a focus loss (window hidden / ⌘H / ⌘-Tab) never activates a button, and key
// auto-repeat never re-activates one (util.js guardKeyActivation)
guardKeyActivation(document, window);
// L-24 diagnostics (the drone flipped synth → off in store and engine while the window was hidden on the Mac, 2 of 4
// runs, with no click on the tile): every change of the current song's drone.mode is logged with the last input kind,
// the window/focus state and the last bus commands, in __rig.diag.drone (≤ 20 entries). Costs one compare per store
// change.
const diag = { drone: [], bus: [] };
controller.addEventListener('bus-command', (e) => {
  diag.bus.push({ t: Math.round(performance.now()), type: e.detail?.type ?? e.detail?.cmd ?? String(e.detail) });
  if (diag.bus.length > 20) diag.bus.shift();
});
let diagDrone = null;
let diagSetStack = null; // the call site of the last store.set(…drone.mode) (the store notifies in a microtask)
const storeSet = store.set;
store.set = function (path, ...rest) {
  if (typeof path === 'string' && path.endsWith('drone.mode')) {
    diagSetStack = new Error().stack.split('\n').slice(2, 9).map((l) => l.trim());
  }
  return storeSet.call(this, path, ...rest);
};
store.subscribe((state) => {
  const song = state.songs[state.settings.currentSongId];
  const mode = song ? `${song.id}:${song.drone.mode}` : null;
  if (mode === diagDrone) return;
  const prev = diagDrone;
  diagDrone = mode;
  if (!prev || !mode || prev.split(':')[0] !== mode.split(':')[0]) return; // a song switch, not a toggle
  let input = null;
  try {
    input = controller._sleepDebug?.().lastInputKind ?? null;
  } catch {
    /* debug only */
  }
  diag.drone.push({ t: Math.round(performance.now()), from: prev.split(':')[1], to: mode.split(':')[1], input,
    focused: document.hasFocus(), visibility: document.visibilityState, active: document.activeElement?.dataset?.testid
      || document.activeElement?.tagName || null, hidden: document.documentElement.hasAttribute('data-window-hidden'),
    bus: diag.bus.slice(-3), setBy: diagSetStack });
  diagSetStack = null;
  if (diag.drone.length > 20) diag.drone.shift();
});
let lastLowRes = null;
controller.onStatus((s) => {
  const low = !!s.lowResource;
  if (low === lastLowRes) return;
  lastLowRes = low;
  document.documentElement.toggleAttribute('data-low-resource', low);
});
let lastMenuBarMode = null;
function mirrorMenuBarMode(state) {
  const on = !!state.settings.menuBarMode;
  if (on === lastMenuBarMode) return;
  lastMenuBarMode = on;
  if (typeof rig?.setMenuBarMode === 'function') {
    Promise.resolve(rig.setMenuBarMode(on)).then((r) => r && r.error && console.warn('[ui] setMenuBarMode:', r.error), () => {});
  }
}
store.subscribe(mirrorMenuBarMode);
mirrorMenuBarMode(store.get());

// test / debugging handle (not an API)
globalThis.__rig = { store, engine, controller, midi, recorder, ctx, views: { perform: performView, get edit() { return editView; }, get settings() { return settingsView; } }, ready: started, viewsReady, ui: { setBanner, plainMessage, toast } };
globalThis.__rig.diag = diag;
globalThis.__rig.meters = { stats: meterClockStats, wake: wakeMeters }; // idle-cpu-ui test hook
globalThis.__rig.theme = { apply: applyTheme, get current() { return themeApplied; }, get pending() { return themePending; } };
