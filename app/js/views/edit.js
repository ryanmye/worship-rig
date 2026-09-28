// Edit view (SPEC §10 Edit, §13). mountEdit(el, ctx) → { destroy }.
// Left: setlists & songs (select, search, reorder by drag or Alt+↑/↓, rename, duplicate, delete, factory browser, library file).
// Center: song header (name, tempo + tap), Notes / Easy Transpose sections, four slot cards (instrument, level, mute,
// sends summary; everything else under "More"), Wheels & pedals, Key drone.
// Right: Vibe / Space / Echo preset pickers, then collapsed Reverb / Echo / Chorus / Lofi / Tone (EQ) / Glue / Master.
// Bottom: 61-key on-screen keyboard + meter.
//
// Progressive disclosure (reviews/ux.md M9): every section is a <details> closed by default; its open state is
// remembered per section in localStorage and its header carries a one-line value summary.
//
// Every persisted change goes through ctx.store.set(...) / store helpers; transient actions through ctx.controller.
// The engine is only *read* (listInstruments, 'ready'/'notes' events, analysers for the meter).
// Store → view updates are targeted: each control is a binding on a song-relative path and is refreshed in place
// when a changed path overlaps it. A slot card body is rebuilt only when that slot's instrument (or emptiness) changes.
import { loadComponents, markDialog } from './_fallback-components.js';
import { ROLE_DEFAULTS, SLOT_COUNT, defaultSlot, formatValue, describe } from '../shared/params.js';
import { keyName, noteName, parseNoteName, mod12 } from '../shared/music.js';
import { WHEEL_TARGETS, BEND_MODES, CATEGORIES, CATEGORY_LABELS, factoryByCategory } from '../presets.js';
import { SPACE_PRESETS, ECHO_PRESETS, VIBE_PRESETS, matchPreset, applyPreset } from '../shared/fx-presets.js';
import { transposeSemisOf } from '../store.js';

const C = await loadComponents();
/** The engine's own velocity curve (engine/audio.js); a local copy only if that module cannot load. */
const curveVelocity = await import('../engine/audio.js').then(
  (m) => (typeof m.curveVelocity === 'function' ? m.curveVelocity : localCurve),
  () => localCurve,
);
function localCurve(vel127, curve) {
  const v = Math.min(1, Math.max(0, (Number(vel127) || 0) / 127));
  if (curve === 'soft') return Math.pow(v, 0.6);
  if (curve === 'hard') return Math.pow(v, 1.6);
  if (curve === 'fixed') return 100 / 127;
  return v;
}

// ---------------------------------------------------------------------------------------------------------------
// constants
/**
 * Picker group order. The group itself comes from the engine (listInstruments()[i].group); groups not listed here
 * are shown after the known ones (alphabetically), and 'My Samples' is always last.
 */
export const INSTRUMENT_GROUPS = Object.freeze([
  'Piano', 'Electric Piano', 'Organ', 'Synth Pads', 'Synth Keys', 'Brass & Leads', 'Mallets & Bells', 'Guitar & Plucks', 'Guitar', 'Bass', 'My Samples',
]);
const ROLE_COLORS = ['#ff8a3d', '#3ddc84', '#4aa8ff', '#b784ff']; // fallbacks for --slot-0..3 (styles.css)
const NEUTRAL = 'var(--ed-neutral, #c9d1db)'; // non-slot sliders: colour only ever means a slot (ux.md M4)
/** Engine-internal patches listInstruments() may expose but a slot should not offer (the drone's own voice). */
const HIDDEN_IN_PICKER = new Set(['synth:drone-osc']);
export const TARGET_LABELS = Object.freeze({
  'slots.0.gain': 'Keys level',
  'slots.1.gain': 'Pad level',
  'slots.2.gain': 'Extra level',
  'slots.3.gain': 'Bass level',
  'drone.gain': 'Drone level',
  'fx.reverb.returnGain': 'Reverb level',
  'master.volume': 'Master volume',
  'macro.intensity': 'Intensity (pad, filter and reverb together)',
  'macro.wash': 'Wash (reverb size and echo together)',
  none: 'Nothing',
});
const BEND_LABELS = { pitch: 'Bends the pitch', morph: 'Changes the instrument’s character', 'drone-swell': 'Swells the drone', tape: 'Tape stop / filter sweep', none: 'Does nothing' };
const MONO_OPTS = [
  { value: 'off', label: 'Chords' },
  { value: 'lowest', label: 'Single note (lowest)' },
  { value: 'highest', label: 'Single note (highest)' },
];
/** Same words as Settings ▸ Velocity. */
export const TOUCH_LABELS = Object.freeze({ soft: 'Light', normal: 'Normal', hard: 'Heavy', fixed: 'Fixed' });
const TOUCH_HINTS = {
  soft: 'Light: soft playing still sounds full.',
  normal: 'Normal: volume follows how hard you play.',
  hard: 'Heavy: you have to dig in for full volume.',
  fixed: 'Fixed: every note plays at the same volume.',
};
const VEL_OPTS = ['soft', 'normal', 'hard', 'fixed'].map((v) => ({ value: v, label: TOUCH_LABELS[v] }));
const SYNC_OPTS = [
  { value: 'off', label: 'Free time' },
  { value: '1/4', label: 'Quarter notes' },
  { value: '1/8d', label: 'Dotted eighths' },
  { value: '1/8', label: 'Eighth notes' },
];
const SYNC_NAMES = { '1/4': 'Quarter notes', '1/8d': 'Dotted eighths', '1/8': 'Eighth notes' };
const SYNC_BEATS = { '1/4': 1, '1/8d': 0.75, '1/8': 0.5 };
const SEARCH_MIN = 9; // song search appears when a list has more than 8 songs
export const SECTIONS_KEY = 'worship-rig.edit.sections';

// ---------------------------------------------------------------------------------------------------------------
// small DOM helpers
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
    else if (k === 'style' && typeof v === 'object') {
      // custom properties cannot be set by property assignment (ux.md M4)
      for (const [p, val] of Object.entries(v)) {
        if (p.startsWith('--')) e.style.setProperty(p, String(val));
        else e.style[p] = val;
      }
    } else if (k === 'on') for (const [t, fn] of Object.entries(v)) e.addEventListener(t, fn);
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
const iconBtn = (label, glyph, on, attrs = {}) =>
  h('button.ed-icon', { type: 'button', title: label, 'aria-label': label, ...attrs, on: { click: on } }, glyph);
const setText = (e, t) => {
  const s = String(t);
  if (e.textContent !== s) e.textContent = s;
};

function getIn(obj, rel) {
  if (!rel) return obj;
  let o = obj;
  for (const s of rel.split('.')) {
    if (o === null || o === undefined) return undefined;
    o = o[s];
  }
  return o;
}
const sameVal = (a, b) => a === b || (typeof a === 'object' && typeof b === 'object' && a && b && JSON.stringify(a) === JSON.stringify(b));
const overlaps = (a, b) => a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
const MINUS = '−';
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `${MINUS}${Math.abs(n)}` : '0');
const pct = (v) => `${Math.round(Number(v) * 100)}%`;
/** "+2 semitones" / "0 semitones" / "−1 semitone" */
export const semitones = (v) => {
  const n = Math.round(Number(v) || 0);
  return `${signed(n)} semitone${Math.abs(n) === 1 ? '' : 's'}`;
};

/** Store address → path relative to a Song object. */
export function relOf(addr) {
  if (addr.startsWith('song.')) return addr.slice(5);
  if (addr === 'master.volume') return 'patch.fx.master.volume';
  if (addr.startsWith('drone.')) return addr;
  return `patch.${addr}`;
}
/** A §4 param that exists in this build's params table (new engine params are feature-detected with this). */
const hasParam = (addr) => {
  const d = describe(addr);
  return !!d && !d.dynamic;
};

/** Human value for an instrument param (metadata from listInstruments()). */
export function formatInstrumentParam(p, v) {
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (typeof v === 'string') return v;
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (p.unit === 's') return n < 1 ? `${Math.round(n * 1000)} ms` : `${n.toFixed(2)} s`;
  if (p.unit === 'Hz') return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)} kHz` : n >= 10 ? `${Math.round(n)} Hz` : `${n.toFixed(2)} Hz`;
  if (p.unit === 'dB') return `${Math.abs(n) < 0.05 ? '0.0' : (n > 0 ? '+' : MINUS) + Math.abs(n).toFixed(1)} dB`;
  if (p.step === 1) return String(Math.round(n));
  if (p.min === 0 && p.max === 1) return `${Math.round(n * 100)}%`;
  return String(Math.round(n * 100) / 100);
}

/** First sentence of a song's notes (factory browser one-liner). */
export function firstSentence(text) {
  const t = String(text || '').trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  return m ? m[1] : t.slice(0, 140);
}

/** BPM from tap timestamps (ms): mean interval of the last ≤4 taps; null with < 2 taps. */
export function bpmFromTaps(taps) {
  const t = taps.slice(-4);
  if (t.length < 2) return null;
  const iv = (t[t.length - 1] - t[0]) / (t.length - 1);
  if (!(iv > 0)) return null;
  return 60000 / iv;
}

/**
 * Picker group for an instrument: the engine's group string; a 'pluck' category without a group → 'Guitar & Plucks';
 * otherwise 'Other'.
 */
export function groupOf(it) {
  if (it && typeof it.group === 'string' && it.group.trim()) return it.group.trim();
  if (it && it.category === 'pluck') return 'Guitar & Plucks';
  return 'Other';
}
/** Ordered group names for a list of instruments (known order, then unknown A–Z, 'My Samples' last). */
export function groupOrder(list) {
  const present = new Set(list.map(groupOf));
  const known = INSTRUMENT_GROUPS.filter((g) => g !== 'My Samples' && present.has(g));
  const extra = [...present].filter((g) => !INSTRUMENT_GROUPS.includes(g)).sort((a, b) => (a === 'Other') - (b === 'Other') || a.localeCompare(b));
  return [...known, ...extra, ...(present.has('My Samples') ? ['My Samples'] : [])];
}

function download(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const today = () => new Date().toISOString().slice(0, 10);
const safeName = (s) => String(s || 'song').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);

function readSections() {
  try {
    const o = JSON.parse(globalThis.localStorage?.getItem(SECTIONS_KEY) || '{}');
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}
function writeSections(o) {
  try {
    globalThis.localStorage?.setItem(SECTIONS_KEY, JSON.stringify(o));
  } catch {
    /* private window / quota: open state is a convenience only */
  }
}

// ---------------------------------------------------------------------------------------------------------------
/**
 * @param {HTMLElement} el
 * @param {{store, controller, engine, midi?, recorder?, toast?, openSettings?, closeSettings?, setView?}} ctx
 * @returns {{destroy():void}}
 */
export function mountEdit(el, ctx) {
  const { store, controller, engine } = ctx;
  const toast = (msg, kind = 'info') => {
    if (typeof ctx.toast === 'function') ctx.toast(msg, kind);
    else if (kind === 'error') console.warn(`[edit] ${msg}`);
  };
  const cleanups = [];
  const listen = (target, type, fn, opts) => {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };

  /** @type {Set<{group:string, rel:string, comp:any, read:Function, last:any, text?:boolean}>} */
  const binds = new Set();
  const comps = new Map(); // group → [component]
  let song = store.currentSong();
  let shownId = song ? song.id : null;
  let instruments = readInstruments();
  const secState = readSections();

  function readInstruments() {
    try {
      const l = engine && typeof engine.listInstruments === 'function' ? engine.listInstruments() : [];
      return Array.isArray(l) ? l : [];
    } catch (err) {
      console.warn('[edit] listInstruments failed', err);
      return [];
    }
  }
  const findInst = (ref) => (ref ? instruments.find((x) => x.ref.type === ref.type && x.ref.id === ref.id) || null : null);

  // ---- song-bound text fields (round2-ui #3) -------------------------------------------------------------------
  // A text field writes to the song it was focused on, never to "the current song" at commit time: a MIDI Next /
  // program change while the player is typing must not rename or re-note the next song. showSong() also commits
  // and blurs a focused field before switching (commitSongFields).
  const fieldIds = new WeakMap(); // input → song id captured on focus
  function armSongField(input) {
    input.dataset.songField = '1';
    listen(input, 'focus', () => {
      if (shownId) fieldIds.set(input, shownId);
    });
  }
  /** Song id a song-bound field writes to (captured on focus; the shown song otherwise). */
  const fieldSongId = (input) => fieldIds.get(input) || shownId;
  /** Write a song-relative path of the song `input` is editing. */
  const setField = (input, rel, v) => {
    const id = fieldSongId(input);
    return id ? store.set(`songs.${id}.${rel}`, v) : false;
  };

  // ---- bindings ------------------------------------------------------------------------------------------------
  function track(group, comp) {
    if (!comps.has(group)) comps.set(group, []);
    comps.get(group).push(comp);
    return comp;
  }
  function applyBind(b, s, force) {
    if (!s) return;
    const v = b.read(s);
    if (!force && sameVal(v, b.last)) return;
    if (b.text && b.comp.el.contains(document.activeElement)) return; // never clobber typing
    b.last = v;
    if (v !== undefined) b.comp.set(v);
  }
  /** Bind a component to a store address. make(onChange) → component. */
  function bindCtl(group, addr, make, { read, text, write } = {}) {
    const rel = relOf(addr);
    const comp = make((v) => (write ? write(v) : store.set(addr, v)));
    comp.el.dataset.bind = addr;
    // params added to the table later (slot width/EQ, master EQ, glue) are absent from older songs: show the default
    const def = hasParam(addr) ? describe(addr).default : undefined;
    const b = { group, rel, comp, read: read || ((s) => getIn(s, rel) ?? def), last: undefined, text };
    binds.add(b);
    track(group, comp);
    applyBind(b, song, true);
    return comp;
  }
  /** Bind an arbitrary refresh function (labels, summaries, enable states) to song-relative paths. */
  function bindFn(group, rels, fn) {
    const b = { group, rel: rels[0], rels, comp: { el: { contains: () => false }, set: fn }, read: (s) => s, last: undefined, fnBind: true };
    binds.add(b);
    if (song) fn(song);
    return b;
  }
  function destroyGroup(prefix) {
    for (const b of [...binds]) if (b.group === prefix || b.group.startsWith(`${prefix}.`)) binds.delete(b);
    for (const [g, list] of [...comps]) {
      if (g === prefix || g.startsWith(`${prefix}.`)) {
        for (const c of list) {
          try {
            c.destroy();
          } catch (err) {
            console.warn('[edit] destroy failed', err);
          }
        }
        comps.delete(g);
      }
    }
  }
  function refresh(rels) {
    if (!song) return;
    for (const b of binds) {
      if (b.fnBind) {
        if (!rels || b.rels.some((r) => rels.some((x) => overlaps(x, r)))) b.comp.set(song);
        continue;
      }
      if (!rels || rels.some((x) => overlaps(x, b.rel))) applyBind(b, song, false);
    }
  }
  /** Current song value for a §4 address (default when the song doesn't carry it yet). */
  const valueOf = (addr) => {
    const v = song ? getIn(song, relOf(addr)) : undefined;
    return v === undefined ? describe(addr)?.default : v;
  };

  // component makers (labels are ours so every control looks the same whichever component set is loaded)
  const fad = (group, label, addr, extra = {}) =>
    bindCtl(group, addr, (onChange) => C.fader({ label, path: hasParam(addr) ? addr : undefined, color: NEUTRAL, ...extra, onChange }), extra.bind);
  const kn = (group, label, addr, extra = {}) =>
    bindCtl(group, addr, (onChange) => C.knob({ label, path: hasParam(addr) ? addr : undefined, color: NEUTRAL, ...extra, onChange }), extra.bind);
  const tog = (group, label, addr, extra = {}) => bindCtl(group, addr, (onChange) => C.toggle({ label, title: extra.title, onChange }), extra.bind);
  function field(label, node, cls = '') {
    return h(`div.ed-field${cls ? `.${cls}` : ''}`, {}, h('span.ed-field-label', { text: label }), node);
  }
  // select/stepper render their own visible label (ui-core and fallback alike)
  const selField = (group, label, addr, options, extra = {}) => {
    const c = bindCtl(group, addr, (onChange) => C.select({ label, options, onChange }), extra.bind);
    c.el.classList.add('ed-sel');
    return c.el;
  };
  const segField = (group, label, addr, options, extra = {}) =>
    field(label, bindCtl(group, addr, (onChange) => C.segmented({ label, options, onChange }), extra.bind).el);
  const stepField = (group, label, addr, o, extra = {}) => {
    const c = bindCtl(group, addr, (onChange) => C.stepper({ label, ...o, onChange }), extra.bind);
    c.el.classList.add('ed-step');
    return c.el;
  };

  /**
   * Collapsible section: <details> closed by default, open state remembered per id (localStorage), one-line
   * summary in the header (summary(song) → string, refreshed when a path in `rels` changes).
   */
  function section(id, title, { open = false, cls = '', dataset, summary, rels = [], group = 'sections', label } = {}, ...children) {
    const sum = h('span.ed-sec-sum');
    const det = h(`details.ed-sec${cls ? `.${cls.split(/\s+/).join('.')}` : ''}`, { dataset: { sec: id, ...(dataset || {}) }, 'aria-label': label || title },
      h('summary.ed-sec-head', {}, h('span.ed-sec-title', { text: title }), sum),
      h('div.ed-sec-body', {}, ...children),
    );
    det.open = typeof secState[id] === 'boolean' ? secState[id] : open;
    det.addEventListener('toggle', () => {
      if (secState[id] === det.open) return;
      secState[id] = det.open;
      writeSections(secState);
    });
    if (summary) bindFn(group, rels, (s) => setText(sum, s ? summary(s) : ''));
    return det;
  }

  /** A text field that accepts a note name ("C4", "F#2") or a MIDI number. */
  function noteField(group, label, addr) {
    const input = h('input.ed-input.ed-note', { type: 'text', inputmode: 'text', spellcheck: 'false', 'aria-label': `${label} key`, size: 4 });
    const comp = {
      el: input,
      set: (v) => {
        input.value = noteName(Number(v));
        input.title = `Key ${noteName(Number(v))} (MIDI note ${v})`;
      },
      destroy: () => input.remove(),
    };
    input.addEventListener('change', () => {
      const raw = input.value.trim();
      let n = Number(raw);
      if (!Number.isInteger(n)) {
        try {
          n = parseNoteName(raw.replace(/^([a-g])/, (c) => c.toUpperCase()));
        } catch {
          n = NaN;
        }
      }
      if (Number.isInteger(n) && n >= 0 && n <= 127) setField(input, relOf(addr), n);
      else toast(`“${raw}” is not a key name — try C4 or F#2`, 'warn');
      if (fieldSongId(input) !== shownId) return; // committed to the song we just left; showSong refreshes us
      const cur = getIn(store.currentSong(), relOf(addr));
      if (cur !== undefined) comp.set(cur);
    });
    armSongField(input);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
    });
    bindCtl(group, addr, () => comp, { text: true });
    return field(label, input, 'ed-field-note');
  }

  // ---- root layout ---------------------------------------------------------------------------------------------
  const left = h('aside.ed-left', { 'aria-label': 'Songs and setlists' });
  const center = h('main.ed-center', { 'aria-label': 'Song editor' });
  const right = h('aside.ed-right', { 'aria-label': 'Effects' });
  const bottom = h('footer.ed-bottom', { 'aria-label': 'On-screen keyboard' });
  const root = h('div.ed', {}, left, center, right, bottom);
  el.classList.add('ed-host');
  el.replaceChildren(root);
  el.__rigCtx = ctx; // test/debug handle (the view's own context)

  // pointer clicks shouldn't leave focus on buttons/selects: Space = sustain and ←/→ = songs only work unfocused
  let lastPointer = 0;
  listen(root, 'pointerdown', () => {
    lastPointer = performance.now();
  });
  listen(root, 'click', (e) => {
    const b = e.target && e.target.closest && e.target.closest('button, summary');
    if (b && e.detail > 0 && !b.closest('.ed-song')) queueMicrotask(() => b.blur());
  });
  listen(root, 'change', (e) => {
    const t = e.target;
    if (t && t.tagName === 'SELECT' && performance.now() - lastPointer < 4000) queueMicrotask(() => t.blur());
  });

  // =============================================================================================================
  // LEFT: setlists + songs
  // =============================================================================================================
  const setSelect = h('select.ed-select', { 'aria-label': 'Setlist' });
  const setNameInput = h('input.ed-input', { type: 'text', 'aria-label': 'Setlist name', hidden: true, maxlength: 120 });
  const setConfirm = h('div.ed-confirm', { hidden: true, role: 'alertdialog', 'aria-label': 'Delete setlist' });
  const songList = h('ol.ed-songs', { role: 'listbox', 'aria-label': 'Songs' });
  const listTitle = h('h2.ed-h2', { text: 'Songs' });
  const searchInput = h('input.ed-input.ed-search', { type: 'search', placeholder: 'Find a song…', 'aria-label': 'Find a song', hidden: true, spellcheck: 'false' });
  const gapNote = h('p.ed-hint.ed-gap-note', { hidden: true, 'aria-live': 'polite' });
  const factoryPanel = h('div.ed-browser', { hidden: true, 'aria-label': 'Factory sounds' });
  const libraryPanel = h('div.ed-browser', { hidden: true, 'aria-label': 'Library songs' });
  const importInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, 'aria-label': 'Import library or song file' });

  const btnFactory = btn('Factory', () => togglePanel(factoryPanel), { 'aria-expanded': 'false', class: 'ed-add-factory', title: 'Add a factory sound to this setlist', 'aria-label': 'Add a factory sound' });
  const btnLibrary = btn('Library', () => togglePanel(libraryPanel), { 'aria-expanded': 'false', class: 'ed-add-library', title: 'Add a song from your library to this setlist', 'aria-label': 'Add a song from your library' });
  left.append(
    h('section.ed-card.ed-sets', {},
      h('h2.ed-h2', { text: 'Setlist' }),
      h('div.ed-row', {}, setSelect, setNameInput),
      h('div.ed-row.ed-row-tight', {},
        btn('New', newSetlist, { title: 'New setlist' }),
        btn('Rename', renameSetlist, { title: 'Rename setlist', class: 'ed-set-rename' }),
        btn('Delete', askDeleteSetlist, { title: 'Delete setlist', class: 'ed-danger-text' }),
      ),
      setConfirm,
    ),
    h('section.ed-card.ed-list', {},
      listTitle,
      searchInput,
      gapNote,
      songList,
      h('div.ed-row.ed-row-tight.ed-add-row', {},
        btn('New', () => store.addSong(null, { select: true, name: 'New Song' }), { class: 'ed-add-blank', title: 'New blank song (piano + pad)', 'aria-label': 'New blank song' }),
        btnFactory,
        btnLibrary,
      ),
      factoryPanel,
      libraryPanel,
    ),
    section('library-file', 'Library file', { cls: 'ed-card ed-io', summary: () => 'Export / import' },
      h('div.ed-row.ed-row-wrap', {},
        btn('Export library', exportLibrary, { class: 'ed-export' }),
        btn('Export song', exportSong, { class: 'ed-export-song' }),
        btn('Import…', () => importInput.click(), { class: 'ed-import' }),
        importInput,
      ),
      h('p.ed-hint', { text: 'Imported songs are added to your library; nothing is overwritten.' }),
    ),
  );

  function togglePanel(panel) {
    const open = panel.hidden;
    closePanels();
    panel.hidden = !open;
    (panel === factoryPanel ? btnFactory : btnLibrary).setAttribute('aria-expanded', String(open));
    if (open && panel === libraryPanel) renderLibraryPanel();
  }
  function closePanels() {
    const was = !factoryPanel.hidden || !libraryPanel.hidden;
    factoryPanel.hidden = true;
    libraryPanel.hidden = true;
    btnFactory.setAttribute('aria-expanded', 'false');
    btnLibrary.setAttribute('aria-expanded', 'false');
    return was;
  }

  // factory browser (static content)
  {
    const byCat = factoryByCategory();
    for (const cat of CATEGORIES) {
      const items = byCat[cat] || [];
      if (!items.length) continue;
      factoryPanel.append(h('h3.ed-h3', { text: CATEGORY_LABELS[cat] || cat }));
      for (const f of items) {
        factoryPanel.append(
          h('div.ed-browser-item', { dataset: { factoryId: f.id } },
            h('div.ed-browser-text', {}, h('div.ed-browser-name', { text: f.name }), h('div.ed-browser-desc', { text: firstSentence(f.notes) })),
            btn('Add', () => {
              // select:true → the controller sees currentSongId change and loads it
              if (store.addSong(f, { select: true })) toast(`Added “${f.name}”`);
            }, { 'aria-label': `Add ${f.name}` }),
          ),
        );
      }
    }
  }

  function renderLibraryPanel() {
    const st = store.get();
    const sl = store.currentSetlist();
    libraryPanel.replaceChildren();
    if (!sl) {
      libraryPanel.append(h('p.ed-hint', { text: 'Choose a setlist first.' }));
      return;
    }
    const inSet = new Set(sl.songIds);
    const rest = st.songOrder.filter((id) => !inSet.has(id));
    if (!rest.length) libraryPanel.append(h('p.ed-hint', { text: 'Every library song is already in this setlist.' }));
    for (const id of rest) {
      const s = st.songs[id];
      libraryPanel.append(
        h('div.ed-browser-item', {},
          h('div.ed-browser-text', {}, h('div.ed-browser-name', { text: s.name })),
          btn('Add', () => {
            store.addToSetlist(sl.id, id);
            renderLibraryPanel();
          }, { 'aria-label': `Add ${s.name} to setlist` }),
        ),
      );
    }
  }

  // ---- dialogs (inline confirms): Esc closes them; body[data-dialog-open] tells the app's Esc→Panic to stand down
  let resetConfirming = false;
  function syncDialog() {
    markDialog('edit', confirmIdx >= 0 || !setConfirm.hidden || resetConfirming);
  }

  // ---- setlist controls
  listen(setSelect, 'change', () => store.setCurrentSetlist(setSelect.value || null));
  function newSetlist() {
    const id = store.addSetlist('New Setlist', [], { select: true });
    renderList();
    if (id) beginSetRename();
  }
  function renameSetlist() {
    if (store.currentSetlist()) beginSetRename();
  }
  function beginSetRename() {
    const sl = store.currentSetlist();
    if (!sl) return;
    setSelect.hidden = true;
    setNameInput.hidden = false;
    setNameInput.value = sl.name;
    setNameInput.focus();
    setNameInput.select();
  }
  function endSetRename(commit) {
    if (setNameInput.hidden) return;
    const sl = store.currentSetlist();
    const v = setNameInput.value.trim();
    setNameInput.hidden = true;
    setSelect.hidden = false;
    if (commit && sl && v) store.set(`setlists.${sl.id}.name`, v);
  }
  listen(setNameInput, 'keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      endSetRename(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      endSetRename(false);
    }
  });
  listen(setNameInput, 'blur', () => endSetRename(true));
  function closeSetConfirm() {
    setConfirm.hidden = true;
    setConfirm.replaceChildren();
    syncDialog();
  }
  function askDeleteSetlist() {
    const sl = store.currentSetlist();
    if (!sl) return;
    setConfirm.hidden = false;
    setConfirm.replaceChildren(
      h('span', { text: `Delete the setlist “${sl.name}”? Its songs stay in your library.` }),
      btn('Delete setlist', () => {
        store.deleteSetlist(sl.id);
        closeSetConfirm();
      }, { class: 'ed-danger' }),
      btn('Cancel', closeSetConfirm, { class: 'ed-cancel' }),
    );
    syncDialog();
    queueMicrotask(() => setConfirm.querySelector('.ed-cancel')?.focus({ preventScroll: true }));
  }

  // ---- song list
  let renamingIdx = -1;
  let confirmIdx = -1;
  let focusIdx = -1; // restore keyboard focus after a re-render
  let dragFrom = -1;
  let query = '';

  function listContext() {
    const st = store.get();
    const sl = store.currentSetlist();
    return { st, sl, ids: sl ? sl.songIds : st.songOrder, setlistId: sl ? sl.id : null };
  }
  function currentRowIndex(ids, st) {
    if (st.settings.setlistGap) return -1; // the current entry was removed from this list
    const cur = st.settings.currentSongId;
    const pos = st.settings.setlistIndex;
    if (Number.isInteger(pos) && pos >= 0 && ids[pos] === cur) return pos;
    return ids.indexOf(cur);
  }
  const matches = (s) => !query || (s && s.name.toLowerCase().includes(query.toLowerCase()));

  function renderList() {
    const { st, sl, ids } = listContext();
    // setlist select
    const opts = [h('option', { value: '', text: 'All songs (library)' })];
    for (const id of st.setlistOrder) opts.push(h('option', { value: id, text: st.setlists[id].name }));
    setSelect.replaceChildren(...opts);
    setSelect.value = sl ? sl.id : '';
    setText(listTitle, sl ? `Songs in “${sl.name}”` : 'All songs');
    // search box only for long lists
    const wantSearch = ids.length >= SEARCH_MIN;
    if (!wantSearch && query) query = '';
    searchInput.hidden = !wantSearch;
    if (searchInput.value !== query && document.activeElement !== searchInput) searchInput.value = query;
    // "gap": the current song was removed from this setlist → Next plays the song that followed it
    const nb = typeof store.neighbors === 'function' ? store.neighbors() : null;
    const gap = !!(sl && st.settings.setlistGap && nb && Number.isInteger(nb.gap));
    gapNote.hidden = !gap;
    if (gap) {
      const next = nb.next ? st.songs[nb.next.id] : null;
      setText(gapNote, next ? `The song you were on was removed from this set. Next plays “${next.name}”.` : 'The song you were on was removed from the end of this set.');
    }
    const curIdx = currentRowIndex(ids, st);
    const rows = [];
    let shown = 0;
    ids.forEach((id, i) => {
      if (gap && i === nb.gap) rows.push(h('li.ed-gap-row', { 'aria-hidden': 'true' }, h('span', { text: 'removed — Next continues here' })));
      const r = songRow(st.songs[id], i, i === curIdx, !!sl);
      if (!matches(st.songs[id]) && renamingIdx !== i && confirmIdx !== i) r.hidden = true;
      else shown += 1;
      rows.push(r);
    });
    if (gap && nb.gap >= ids.length) rows.push(h('li.ed-gap-row', { 'aria-hidden': 'true' }, h('span', { text: 'removed — end of set' })));
    songList.replaceChildren(...rows);
    if (!ids.length) songList.append(h('li.ed-empty', { text: sl ? 'This setlist is empty — add songs below.' : 'No songs yet.' }));
    else if (!shown) songList.append(h('li.ed-empty', { text: `No songs match “${query}”.` }));
    if (focusIdx >= 0) {
      const r = songList.querySelector(`.ed-song[data-index="${Math.min(focusIdx, ids.length - 1)}"]`);
      if (r && !r.hidden) r.focus();
      focusIdx = -1;
    }
    if (!libraryPanel.hidden) renderLibraryPanel();
    syncDialog();
  }
  listen(searchInput, 'input', () => {
    query = searchInput.value.trim();
    renderList();
  });
  listen(searchInput, 'keydown', (e) => {
    if (e.key === 'Escape' && searchInput.value) {
      e.preventDefault();
      searchInput.value = '';
      query = '';
      renderList();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      songList.querySelector('.ed-song:not([hidden])')?.focus();
    } else if (e.key === 'Enter') {
      const first = songList.querySelector('.ed-song:not([hidden])');
      if (first) first.click();
    }
  });

  function cancelRowConfirm() {
    if (confirmIdx < 0) return false;
    focusIdx = confirmIdx;
    confirmIdx = -1;
    renderList();
    return true;
  }

  function songRow(s, i, current, inSetlist) {
    if (!s) return h('li.ed-song.missing', { text: '(missing song)' });
    const li = h('li.ed-song', {
      tabindex: 0,
      role: 'option',
      draggable: 'true',
      'aria-selected': current ? 'true' : 'false',
      dataset: { index: String(i), id: s.id },
      title: 'Click to open · drag or Alt+↑/↓ to move · F2 rename · Delete key removes',
    });
    if (current) li.classList.add('current');
    const num = h('span.ed-song-num', { text: String(i + 1) });
    const grip = h('span.ed-grip', { 'aria-hidden': 'true', text: '⋮⋮' });
    let name;
    if (renamingIdx === i) {
      name = h('input.ed-input.ed-song-rename', { type: 'text', value: s.name, 'aria-label': 'Song name', maxlength: 120 });
      const done = (commit) => {
        if (renamingIdx !== i) return;
        renamingIdx = -1;
        const v = name.value.trim();
        focusIdx = i;
        // deferred: a blur fired while the list is being replaced must not re-enter renderList
        queueMicrotask(() => {
          if (!(commit && v && v !== s.name && store.set(`songs.${s.id}.name`, v))) renderList();
        });
      };
      name.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          done(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          done(false);
        }
      });
      name.addEventListener('blur', () => done(true));
      name.addEventListener('click', (e) => e.stopPropagation());
      queueMicrotask(() => {
        name.focus();
        name.select();
      });
    } else {
      name = h('span.ed-song-name', { text: s.name, title: s.category && CATEGORY_LABELS[s.category] ? `${s.name} · ${CATEGORY_LABELS[s.category]}` : s.name });
      name.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        renamingIdx = i;
        renderList();
      });
    }
    li.append(grip, num, name);
    if (confirmIdx === i) {
      li.classList.add('confirming');
      li.setAttribute('aria-selected', 'true');
      const box = h('span.ed-row-confirm', { role: 'group', 'aria-label': `Remove ${s.name}` },
        h('span.ed-row-confirm-q', {
          text: inSetlist ? `Remove “${s.name}” from this set, or delete it from your library everywhere?` : `Delete “${s.name}” from your library?`,
        }),
        inSetlist ? btn('Remove from set', (e) => {
          e.stopPropagation();
          confirmIdx = -1;
          focusIdx = i;
          store.removeFromSetlist(store.currentSetlist().id, i);
        }, { class: 'ed-remove-from-set' }) : null,
        btn('Delete song', (e) => {
          e.stopPropagation();
          confirmIdx = -1;
          focusIdx = i;
          const nm = s.name;
          if (store.deleteSong(s.id)) toast(`Deleted “${nm}”`);
          else renderList();
        }, { class: 'ed-danger ed-confirm-delete' }),
        btn('Cancel', (e) => {
          e.stopPropagation();
          cancelRowConfirm();
        }, { class: 'ed-cancel' }),
      );
      li.append(box);
    } else {
      li.append(
        h('span.ed-song-actions', {},
          iconBtn(`Rename ${s.name}`, '✎', (e) => {
            e.stopPropagation();
            renamingIdx = i;
            renderList();
          }, { class: 'ed-act-rename' }),
          iconBtn(`Duplicate ${s.name}`, '⧉', (e) => {
            e.stopPropagation();
            const id = store.duplicateSong(s.id);
            if (id) toast(`Duplicated “${s.name}”`);
          }, { class: 'ed-act-dup' }),
          iconBtn(inSetlist ? `Remove or delete ${s.name}` : `Delete ${s.name}`, '✕', (e) => {
            e.stopPropagation();
            confirmIdx = i;
            focusIdx = i;
            renderList();
          }, { class: 'ed-act-del' }),
        ),
      );
    }
    li.addEventListener('click', () => {
      if (renamingIdx === i || confirmIdx === i) return;
      if (!current) controller.selectSong(s.id, { index: inSetlist ? i : undefined });
    });
    li.addEventListener('keydown', (e) => onRowKey(e, s, i, current, inSetlist));
    li.addEventListener('dragstart', (e) => {
      dragFrom = i;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
    });
    li.addEventListener('dragend', () => {
      dragFrom = -1;
      li.classList.remove('dragging');
      for (const r of songList.querySelectorAll('.drop-before,.drop-after')) r.classList.remove('drop-before', 'drop-after');
    });
    li.addEventListener('dragover', (e) => {
      if (dragFrom < 0) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const r = li.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      li.classList.toggle('drop-after', after);
      li.classList.toggle('drop-before', !after);
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'));
    li.addEventListener('drop', (e) => {
      if (dragFrom < 0) return;
      e.preventDefault();
      const r = li.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      const to = dropTarget(dragFrom, i, after);
      const from = dragFrom;
      dragFrom = -1;
      move(from, to);
    });
    return li;
  }

  /** Index to pass to store.moveSong when dropping `from` before/after row `j`. */
  function dropTarget(from, j, after) {
    if (after) return j >= from ? j : j + 1;
    return j > from ? j - 1 : j;
  }
  function move(from, to) {
    const { setlistId, ids } = listContext();
    if (to < 0 || to >= ids.length || from === to) return;
    focusIdx = to;
    if (!store.moveSong(setlistId, from, to)) focusIdx = -1;
  }

  function onRowKey(e, s, i, current, inSetlist) {
    if (e.target !== e.currentTarget) return;
    const visible = () => [...songList.querySelectorAll('.ed-song:not([hidden])')];
    const focusStep = (d) => {
      const v = visible();
      const k = v.indexOf(e.currentTarget);
      const t = v[k + d];
      if (t) t.focus();
    };
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault(); // keep the controller from nudging the mod wheel
        const d = e.key === 'ArrowUp' ? -1 : 1;
        if (e.altKey) move(i, i + d);
        else focusStep(d);
        break;
      }
      case 'Home':
        e.preventDefault();
        visible()[0]?.focus();
        break;
      case 'End':
        e.preventDefault();
        visible().at(-1)?.focus();
        break;
      case 'Enter':
        e.preventDefault();
        if (!current) controller.selectSong(s.id, { index: inSetlist ? i : undefined });
        break;
      case 'F2':
        e.preventDefault();
        renamingIdx = i;
        renderList();
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        confirmIdx = i;
        focusIdx = i;
        renderList();
        break;
      default:
        break;
    }
  }

  // ---- import / export
  function exportLibrary() {
    download(`Worship Rig library ${today()}.json`, store.exportJSON());
    toast('Library exported');
  }
  function exportSong() {
    const s = store.currentSong();
    if (!s) return;
    download(`${safeName(s.name)}.rig-song.json`, store.exportSong(s.id));
  }
  function importText(text) {
    const r = store.importJSON(text);
    if (r.ok) toast(`Imported ${r.songIds.length} song${r.songIds.length === 1 ? '' : 's'}${r.setlistIds.length ? ` and ${r.setlistIds.length} setlist${r.setlistIds.length === 1 ? '' : 's'}` : ''}`);
    else toast(r.error || 'That file could not be imported.', 'error');
    return r;
  }
  listen(importInput, 'change', async () => {
    const f = importInput.files && importInput.files[0];
    importInput.value = '';
    if (!f) return;
    try {
      importText(await f.text());
    } catch (err) {
      console.warn('[edit] import read failed', err);
      toast(`Could not open “${f.name}”. Is it a Worship Rig export?`, 'error');
    }
  });

  // =============================================================================================================
  // CENTER: song header, notes, Easy Transpose, slots, routing, drone
  // =============================================================================================================
  // ---- header
  const G_SONG = 'song';
  const nameInput = h('input.ed-input.ed-song-title', { type: 'text', 'aria-label': 'Song name', maxlength: 120 });
  bindCtl(G_SONG, 'song.name', () => ({ el: nameInput, set: (v) => (nameInput.value = v ?? ''), destroy() {} }), { text: true });
  armSongField(nameInput);
  listen(nameInput, 'change', () => {
    const v = nameInput.value.trim();
    if (v) setField(nameInput, 'name', v);
    else nameInput.value = store.currentSong()?.name ?? '';
  });
  listen(nameInput, 'keydown', (e) => {
    if (e.key === 'Enter') nameInput.blur();
  });

  const notesArea = h('textarea.ed-input.ed-notes', { rows: 4, 'aria-label': 'Song notes', placeholder: 'Notes for this song (shown in Perform)', maxlength: 10000 });
  bindCtl(G_SONG, 'song.notes', () => ({ el: notesArea, set: (v) => (notesArea.value = v ?? ''), destroy() {} }), { text: true });
  let notesTimer = null;
  armSongField(notesArea);
  const flushNotes = () => {
    clearTimeout(notesTimer);
    notesTimer = null;
    setField(notesArea, 'notes', notesArea.value);
  };
  listen(notesArea, 'input', () => {
    clearTimeout(notesTimer);
    notesTimer = setTimeout(flushNotes, 500);
  });
  listen(notesArea, 'blur', () => {
    if (notesTimer) flushNotes();
  });

  const tempoInput = h('input.ed-input.ed-tempo', { type: 'number', min: 30, max: 300, step: 1, placeholder: '—', 'aria-label': 'Tempo (beats per minute)' });
  bindCtl(G_SONG, 'song.tempo', () => ({ el: tempoInput, set: (v) => (tempoInput.value = v === null || v === undefined ? '' : String(Math.round(v))), destroy() {} }), {
    text: true,
    read: (s) => (s.tempo === null ? null : s.tempo),
  });
  armSongField(tempoInput);
  listen(tempoInput, 'change', () => {
    const raw = tempoInput.value.trim();
    if (raw === '') setField(tempoInput, 'tempo', null);
    else if (Number.isFinite(Number(raw))) setField(tempoInput, 'tempo', Math.round(Number(raw)));
    if (fieldSongId(tempoInput) !== shownId) return;
    const cur = store.currentSong();
    tempoInput.value = cur && cur.tempo !== null ? String(Math.round(cur.tempo)) : '';
  });
  let taps = [];
  const tapBtn = btn('Tap', () => {
    const t = performance.now();
    if (taps.length && t - taps[taps.length - 1] > 2000) taps = [];
    taps.push(t);
    taps = taps.slice(-4);
    const bpm = bpmFromTaps(taps);
    tapBtn.classList.remove('flash');
    void tapBtn.offsetWidth;
    tapBtn.classList.add('flash');
    if (bpm !== null && bpm >= 30 && bpm <= 300) store.set('song.tempo', Math.round(bpm));
  }, { class: 'ed-tap', title: 'Tap 2–4 times in time' });
  const clearTempo = btn('Clear', () => store.set('song.tempo', null), { class: 'ed-tempo-clear', title: 'Remove the tempo from this song' });

  const resetBox = h('span.ed-reset');
  function renderReset(s) {
    resetConfirming = false;
    resetBox.replaceChildren();
    syncDialog();
    if (!s || !s.factoryId) return;
    resetBox.append(
      btn('Reset to factory', () => {
        resetConfirming = true;
        resetBox.replaceChildren(
          h('span', { text: 'Put this song’s sound back to the factory version? The key and notes stay.' }),
          btn('Reset', () => {
            if (store.resetToFactory(s.id)) toast(`“${s.name}” reset to factory`);
            else toast('Already the factory sound');
            renderReset(store.currentSong());
          }, { class: 'ed-danger ed-reset-confirm' }),
          btn('Cancel', () => renderReset(store.currentSong()), { class: 'ed-cancel' }),
        );
        syncDialog();
      }, { class: 'ed-reset-btn', title: 'Put the factory sound back (keeps the key and notes)' }),
    );
  }
  bindFn(G_SONG, ['factoryId', 'name'], renderReset);
  const loadingBadge = h('span.ed-badge', { hidden: true, text: 'Loading…' });

  const firstLine = (t) => {
    const l = String(t || '').trim().split('\n')[0] || '';
    return l.length > 60 ? `${l.slice(0, 58)}…` : l;
  };
  center.append(
    h('section.ed-card.ed-songhead', {},
      h('div.ed-row.ed-row-head', {}, nameInput, loadingBadge, resetBox),
      h('div.ed-row.ed-row-head2', {},
        h('span.ed-field-label', { text: 'Tempo' }),
        h('span.ed-tempo-wrap', {}, tempoInput, h('span.ed-unit', { text: 'BPM' }), tapBtn, clearTempo),
      ),
    ),
    section('notes', 'Notes', { cls: 'ed-card ed-notes-sec', rels: ['notes'], summary: (s) => firstLine(s.notes) || 'No notes' }, notesArea),
  );

  // ---- Easy Transpose
  const G_TR = 'transpose';
  function keySelect(addr, label) {
    const s = h('select.ed-select.ed-keysel', { 'aria-label': label });
    for (let pc = 0; pc < 12; pc++) s.append(h('option', { value: String(pc) }));
    const relabel = (minor) => {
      [...s.options].forEach((o, pc) => setText(o, keyName(pc, minor)));
    };
    s.addEventListener('change', () => store.set(addr, Number(s.value)));
    bindCtl(G_TR, addr, () => ({ el: s, set: (v) => (s.value = String(mod12(v))), destroy() {} }));
    bindFn(G_TR, ['minor'], (sg) => relabel(!!(sg && sg.minor)));
    return field(label, s, 'ed-field-key');
  }
  const trReadout = h('div.ed-tr-readout', { 'aria-live': 'polite' });
  const trSentence = (s) => {
    const semis = transposeSemisOf(s);
    return semis === 0
      ? `No transpose — you hear what you play (${keyName(s.hearIn, s.minor)}).`
      : `Play in ${keyName(s.playIn, s.minor)}, sounds in ${keyName(s.hearIn, s.minor)} (${semitones(semis)}).`;
  };
  bindFn(G_TR, ['playIn', 'hearIn', 'transposeOctave', 'minor'], (s) => setText(trReadout, trSentence(s)));
  center.append(
    section('transpose', 'Easy Transpose', {
      cls: 'ed-card ed-transpose',
      rels: ['playIn', 'hearIn', 'transposeOctave', 'minor'],
      summary: (s) => {
        const semis = transposeSemisOf(s);
        return semis === 0 ? `Key of ${keyName(s.hearIn, s.minor)} · no transpose` : `Play in ${keyName(s.playIn, s.minor)} → hear ${keyName(s.hearIn, s.minor)}`;
      },
    },
    h('div.ed-row.ed-row-wrap', {},
      keySelect('song.playIn', 'Play In'),
      keySelect('song.hearIn', 'Hear In'),
      segField(G_TR, 'Octave', 'song.transposeOctave', [
        { value: -1, label: `${MINUS}1` },
        { value: 0, label: '0' },
        { value: 1, label: '+1' },
      ]),
      field('Key', tog(G_TR, 'Minor', 'song.minor').el),
    ),
    trReadout,
    ),
  );

  // ---- slot cards
  const slotGrid = h('div.ed-slots');
  center.append(h('section.ed-slots-wrap', { 'aria-label': 'Instrument slots' }, slotGrid));
  const cards = [];

  function pickerOptions(sel, slot) {
    const cur = slot ? `${slot.instrument.type}:${slot.instrument.id}` : '';
    const visible = instruments.filter((it) => {
      const v = `${it.ref.type}:${it.ref.id}`;
      return (!HIDDEN_IN_PICKER.has(v) && !it.hidden) || v === cur;
    });
    const nodes = [h('option', { value: '', text: '— empty —' })];
    let found = cur === '';
    for (const g of groupOrder(visible)) {
      const og = h('optgroup', { label: g });
      for (const it of visible) {
        if (groupOf(it) !== g) continue;
        const v = `${it.ref.type}:${it.ref.id}`;
        if (v === cur) found = true;
        og.append(h('option', { value: v, text: it.name, title: it.license ? `${it.name} — ${it.license}` : it.name }));
      }
      nodes.push(og);
    }
    if (!found) nodes.push(h('option', { value: cur, text: `${slot.instrument.id} (not available)` }));
    sel.replaceChildren(...nodes);
    sel.value = cur;
  }

  function makeCard(i) {
    const role = ROLE_DEFAULTS[i];
    const picker = h('select.ed-select.ed-picker', { 'aria-label': `${role.name} instrument` });
    const body = h('div.ed-slot-body');
    const card = h('section.ed-card.ed-slot', {
      dataset: { slot: String(i) },
      'aria-label': `${role.name} slot`,
      style: { '--role': `var(--slot-${i}, ${ROLE_COLORS[i]})` },
    },
    h('header.ed-slot-head', {}, h('span.ed-slot-role', { text: role.name }), picker),
    body,
    );
    picker.addEventListener('change', () => pickInstrument(i, picker.value));
    slotGrid.append(card);
    return { i, card, picker, body, key: undefined };
  }
  for (let i = 0; i < SLOT_COUNT; i++) cards.push(makeCard(i));

  function pickInstrument(i, value) {
    const s = store.currentSong();
    if (!s) return;
    if (!value) {
      store.set(`song.patch.slots.${i}`, null);
      return;
    }
    const k = value.indexOf(':');
    const ref = { type: value.slice(0, k), id: value.slice(k + 1) };
    if (s.patch.slots[i]) store.set(`song.patch.slots.${i}.instrument`, ref);
    else store.set(`song.patch.slots.${i}`, defaultSlot(i, ref));
  }

  const slotKey = (slot) => (slot ? `${slot.instrument.type}:${slot.instrument.id}:${findInst(slot.instrument) ? 1 : 0}` : 'empty');

  function syncCard(i, force = false) {
    const c = cards[i];
    const slot = song ? song.patch.slots[i] : null;
    const key = slotKey(slot);
    if (!force && key === c.key) return false;
    c.key = key;
    pickerOptions(c.picker, slot);
    c.card.classList.toggle('empty', !slot);
    buildSlotBody(c, slot);
    return true;
  }

  /** Tiny velocity-curve graph: x = how hard you play, y = how loud it sounds. */
  function curveSpark(card, i) {
    const cv = h('canvas.ed-vel-spark', { width: 128, height: 48, role: 'img', 'aria-label': 'Touch curve' });
    return {
      el: cv,
      draw(curve) {
        cv.dataset.curve = curve;
        cv.title = `${TOUCH_HINTS[curve] || ''} Left = soft key press, right = hard.`;
        const g = cv.getContext && cv.getContext('2d');
        if (!g) return;
        const W = cv.width;
        const H = cv.height;
        const pad = 4;
        g.clearRect(0, 0, W, H);
        g.strokeStyle = 'rgba(255,255,255,.18)';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(pad, H - pad);
        g.lineTo(W - pad, pad); // the "Normal" diagonal for reference
        g.stroke();
        const col = (getComputedStyle(card).getPropertyValue('--role') || '').trim() || ROLE_COLORS[i];
        g.strokeStyle = col;
        g.lineWidth = 3;
        g.lineJoin = 'round';
        g.beginPath();
        for (let v = 1; v <= 127; v += 2) {
          const x = pad + ((v - 1) / 126) * (W - 2 * pad);
          const y = H - pad - curveVelocity(v, curve) * (H - 2 * pad);
          if (v === 1) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.stroke();
      },
      destroy() {
        cv.remove();
      },
    };
  }

  function slotSummary(slot, i) {
    const parts = [];
    if (Math.abs(slot.pan) > 0.005) parts.push(`Pan ${formatValue(`slots.${i}.pan`, slot.pan)}`);
    if (slot.lowNote > 0 || slot.highNote < 127) parts.push(`Keys ${noteName(slot.lowNote)}–${noteName(slot.highNote)}`);
    if (slot.octave) parts.push(`Octave ${signed(slot.octave)}`);
    if (slot.transpose) parts.push(semitones(slot.transpose));
    if (slot.mono && slot.mono !== 'off') parts.push('Single note');
    if (slot.velocityCurve && slot.velocityCurve !== 'normal') parts.push(`${TOUCH_LABELS[slot.velocityCurve]} touch`);
    if (!slot.sustain) parts.push('No sustain');
    if (hasParam(`slots.${i}.width`) && typeof slot.width === 'number' && Math.abs(slot.width - 1) > 0.01) parts.push(`Width ${pct(slot.width)}`);
    const eq = slot.eq || {};
    if ((Number(eq.low) || 0) !== 0 || (Number(eq.high) || 0) !== 0) parts.push('Tone EQ');
    if (!parts.length) return 'Standard';
    return parts.length > 3 ? `${parts.slice(0, 3).join(' · ')} …` : parts.join(' · ');
  }

  function buildSlotBody(c, slot) {
    const i = c.i;
    const g = `slot${i}`;
    destroyGroup(g);
    c.body.replaceChildren();
    if (!slot) {
      c.body.append(h('p.ed-hint', { text: 'Empty — pick an instrument above to use this slot.' }));
      return;
    }
    const role = ROLE_DEFAULTS[i];
    const P = (k) => `slots.${i}.${k}`;
    const rel = `patch.slots.${i}`;
    const color = `var(--slot-${i}, ${ROLE_COLORS[i]})`;
    const level = fad(g, 'Level', P('gain'), { color });
    const mute = tog(g, 'Mute', P('muted'), { bind: { read: (s) => !!(s.patch.slots[i] && s.patch.slots[i].muted) }, title: `Mute ${role.name}` });
    mute.el.classList.add('ed-mute');
    mute.el.setAttribute('aria-label', `Mute ${role.name}`);
    bindFn(g, [rel], (s) => {
      const muted = !!(s.patch.slots[i] && s.patch.slots[i].muted);
      level.setMuted?.(muted);
      c.card.classList.toggle('muted', muted);
    });
    const sendsSum = h('p.ed-sends-sum');
    bindFn(g, [`${rel}.sends`], (s) => {
      const sl = s.patch.slots[i];
      if (!sl) return;
      const x = sl.sends;
      setText(sendsSum, `Reverb ${pct(x.reverb)} · Echo ${pct(x.delay)} · Chorus ${pct(x.chorus)}`);
    });

    // ---- "More": everything else
    const pan = kn(g, 'Pan', P('pan'));
    const sends = h('div.ed-sends', {},
      pan.el,
      kn(g, 'Reverb', P('sends.reverb'), { color }).el,
      kn(g, 'Echo', P('sends.delay'), { color }).el,
      kn(g, 'Chorus', P('sends.chorus'), { color }).el,
    );
    // strip tone (engine-3 params; rendered only when this build's params table has them)
    const tone = [];
    if (hasParam(P('width'))) tone.push(kn(g, 'Width', P('width'), { color, format: (v) => (Number(v) < 0.005 ? 'Mono' : pct(v)) }).el);
    if (hasParam(P('eq.low'))) tone.push(kn(g, 'Lows', P('eq.low'), { color, format: (v) => formatValue(P('eq.low'), v) }).el);
    if (hasParam(P('eq.high'))) tone.push(kn(g, 'Highs', P('eq.high'), { color, format: (v) => formatValue(P('eq.high'), v) }).el);
    const toneRow = tone.length ? h('div.ed-tone', {}, ...tone) : null;

    // split: mini keyboard + note fields
    const mini = C.miniKeyboard({
      low: slot.lowNote,
      high: slot.highNote,
      onRange: (a, b) => {
        const r = a && typeof a === 'object' ? a : { low: a, high: b };
        let lo = Math.round(Number(r.low ?? r.lowNote ?? r[0]));
        let hi = Math.round(Number(r.high ?? r.highNote ?? r[1]));
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
        if (lo > hi) [lo, hi] = [hi, lo];
        store.set(P('lowNote'), lo);
        store.set(P('highNote'), hi);
      },
    });
    mini.el.dataset.bind = P('split');
    track(g, mini);
    const miniBind = { group: g, rel, comp: mini, read: (s) => (s.patch.slots[i] ? { low: s.patch.slots[i].lowNote, high: s.patch.slots[i].highNote } : undefined), last: undefined };
    binds.add(miniBind);
    applyBind(miniBind, song, true);
    const rangeNote = h('span.ed-range-note');
    bindFn(g, [`${rel}.lowNote`, `${rel}.highNote`], (s) => {
      const sl = s.patch.slots[i];
      if (sl) setText(rangeNote, sl.lowNote <= 0 && sl.highNote >= 127 ? 'Whole keyboard' : `${noteName(sl.lowNote)} to ${noteName(sl.highNote)}`);
    });

    const split = h('div.ed-split', {},
      h('div.ed-split-head', {}, h('span.ed-field-label', { text: 'Key range' }), rangeNote),
      h('div.ed-split-fields', {},
        noteField(g, 'Lowest', P('lowNote')),
        noteField(g, 'Highest', P('highNote')),
        btn('Whole keyboard', () => {
          store.set(P('lowNote'), 0);
          store.set(P('highNote'), 127);
        }, { class: 'ed-split-full', title: 'Play this sound across the whole keyboard' }),
      ),
      mini.el,
    );

    const spark = curveSpark(c.card, i);
    track(g, spark);
    bindFn(g, [`${rel}.velocityCurve`], (s) => {
      const sl = s.patch.slots[i];
      if (sl) spark.draw(sl.velocityCurve || 'normal');
    });
    const opts = h('div.ed-slot-opts', {},
      stepField(g, 'Octave', P('octave'), { min: -2, max: 2, step: 1, format: (v) => signed(Math.round(v)) }),
      stepField(g, 'Transpose', P('transpose'), { min: -12, max: 12, step: 1, format: semitones }),
      selField(g, 'Play', P('mono'), MONO_OPTS),
      h('div.ed-touch', {}, selField(g, 'Touch', P('velocityCurve'), VEL_OPTS), spark.el),
    );
    const toggles = h('div.ed-slot-toggles', {},
      tog(g, 'Sustain pedal', P('sustain'), { title: 'Notes hold while the sustain pedal is down' }).el,
      tog(g, 'Pitch bend', P('bendEnabled'), { title: 'The pitch-bend wheel bends this sound' }).el,
    );

    // instrument params
    const meta = findInst(slot.instrument);
    const params = (meta && Array.isArray(meta.params) ? meta.params : []).filter((p) => p && p.key);
    const grid = h('div.ed-params-grid');
    const gp = `${g}.params`;
    for (const p of params) {
      const addr = P(`params.${p.key}`);
      const read = (s) => {
        const sl = s.patch.slots[i];
        if (!sl) return undefined;
        const v = sl.params ? sl.params[p.key] : undefined;
        return v === undefined ? p.default : v;
      };
      if (p.unit === 'bool' || typeof p.default === 'boolean') {
        grid.append(bindCtl(gp, addr, (onChange) => C.toggle({ label: p.label || p.key, onChange }), { read }).el);
      } else if (p.unit === 'enum' || Array.isArray(p.enum)) {
        const options = (p.enum || []).map((v) => ({ value: v, label: String(v)[0].toUpperCase() + String(v).slice(1) }));
        grid.append(bindCtl(gp, addr, (onChange) => C.select({ label: p.label || p.key, options, onChange }), { read }).el);
      } else {
        const min = Number.isFinite(p.min) ? p.min : 0;
        const max = Number.isFinite(p.max) ? p.max : 1;
        grid.append(
          bindCtl(gp, addr, (onChange) => C.knob({
            label: p.label || p.key,
            min,
            max,
            curve: p.curve === 'log' && min > 0 ? 'log' : 'lin',
            step: p.step,
            unit: p.unit,
            default: typeof p.default === 'number' ? p.default : min,
            format: (v) => formatInstrumentParam(p, v),
            color,
            onChange,
          }), { read }).el,
        );
      }
    }
    if (params.length) {
      grid.append(
        btn('Reset these settings', () => {
          // write every default explicitly (removing keys would not reach an older controller — see findings)
          for (const p of params) if (p.default !== undefined && p.default !== null) store.set(P(`params.${p.key}`), p.default);
        }, { class: 'ed-params-reset' }),
      );
    } else grid.append(h('p.ed-hint', { text: meta ? 'This instrument has no extra settings.' : 'Instrument details appear once sound has started.' }));
    const instName = meta ? meta.name : slot.instrument.id;
    const instSec = section(`slot${i}-inst`, `${instName} settings`, { cls: 'ed-params', group: g, summary: () => (params.length ? `${params.length}` : '') }, grid);

    const more = section(`slot${i}-more`, `More for ${role.name}`, {
      cls: 'ed-more',
      group: g,
      rels: [rel],
      summary: (s) => (s.patch.slots[i] ? slotSummary(s.patch.slots[i], i) : ''),
    },
    sends, toneRow, split, opts, toggles, instSec,
    );

    c.body.append(h('div.ed-slot-main', {}, level.el, mute.el), sendsSum, more);
  }

  // ---- routing
  const G_RT = 'routing';
  const targetOpts = WHEEL_TARGETS.map((t) => ({ value: t, label: TARGET_LABELS[t] || t }));
  const rangeKnob = (label, addr, def) => kn(G_RT, label, addr, { min: 0, max: 1, curve: 'lin', default: def, format: pct }).el;
  center.append(
    section('routing', 'Wheels & pedals', {
      cls: 'ed-card ed-routing',
      rels: ['patch.modWheel', 'patch.expression', 'patch.bend'],
      summary: (s) => `Mod wheel: ${TARGET_LABELS[s.patch.modWheel.target] || s.patch.modWheel.target} · Bend: ${BEND_LABELS[s.patch.bend.mode] || s.patch.bend.mode}`,
    },
    h('div.ed-route-row', {}, selField(G_RT, 'Mod wheel controls', 'song.patch.modWheel.target', targetOpts), rangeKnob('From', 'song.patch.modWheel.min', 0), rangeKnob('To', 'song.patch.modWheel.max', 1)),
    h('div.ed-route-row', {}, selField(G_RT, 'Expression pedal controls', 'song.patch.expression.target', targetOpts), rangeKnob('From', 'song.patch.expression.min', 0), rangeKnob('To', 'song.patch.expression.max', 1)),
    h('div.ed-route-row', {}, selField(G_RT, 'Volume knob controls', 'song.patch.volume.target', targetOpts)),
    h('div.ed-route-row', {},
      selField(G_RT, 'Pitch-bend wheel', 'song.patch.bend.mode', BEND_MODES.map((m) => ({ value: m, label: BEND_LABELS[m] || m }))),
      stepField(G_RT, 'Bend range', 'song.patch.bend.range', { min: 0, max: 24, step: 1, format: (v) => `${v} semitone${Number(v) === 1 ? '' : 's'}` }),
      kn(G_RT, 'Swell time', 'song.patch.swell.seconds', { min: 1, max: 60, curve: 'log', default: 8, format: (v) => `${Number(v).toFixed(v < 10 ? 1 : 0)} s` }).el,
    ),
    ),
  );

  // ---- drone
  const G_DR = 'drone';
  const droneNote = h('p.ed-hint.ed-drone-note');
  const chordFollow = tog(G_DR, 'Chord follow (experimental)', 'song.drone.chordFollow', { title: 'The synth drone follows the chords you play' });
  bindFn(G_DR, ['drone.mode', 'hearIn', 'minor'], (s) => {
    const files = s.drone.mode === 'files';
    chordFollow.setDisabled?.(files);
    chordFollow.el.classList.toggle('ed-disabled', files);
    setText(
      droneNote,
      s.drone.mode === 'off'
        ? 'The drone is off for this song.'
        : files
          ? 'Plays the pad file for this key from your My Pads folder (Settings). Chord follow only works with the synth drone.'
          : `Synth drone in ${keyName(s.hearIn, s.minor)}: root, fifth and octave (plus a ninth when bright).`,
    );
  });
  const DRONE_MODE = { off: 'Off', synth: 'Synth', files: 'My Pads' };
  center.append(
    section('drone', 'Key drone', {
      cls: 'ed-card ed-drone',
      rels: ['drone', 'hearIn', 'minor'],
      label: 'Key drone',
      summary: (s) => (s.drone.mode === 'off' ? 'Off' : `${DRONE_MODE[s.drone.mode] || s.drone.mode} · ${keyName(s.hearIn, s.minor)} · ${formatValue('drone.gain', s.drone.gain)}`),
    },
    h('div.ed-row.ed-row-wrap', {},
      segField(G_DR, 'Drone', 'song.drone.mode', [
        { value: 'off', label: 'Off' },
        { value: 'synth', label: 'Synth' },
        { value: 'files', label: 'My Pads' },
      ]),
    ),
    h('div.ed-drone-ctl', {},
      fad(G_DR, 'Level', 'drone.gain').el,
      kn(G_DR, 'Brightness', 'drone.brightness').el,
      kn(G_DR, 'Movement', 'drone.movement').el,
      kn(G_DR, 'Width', 'drone.width').el,
      kn(G_DR, 'Key fade', 'drone.fade').el,
    ),
    h('div.ed-slot-toggles', {},
      chordFollow.el,
      tog(G_DR, 'Continues across songs', 'song.drone.continueAcrossSongs', { title: 'Keeps sounding when you move to the next song' }).el,
      tog(G_DR, 'Minor keys use the major pad', 'song.drone.minorUsesRelativeMajorFile', { title: 'For a minor key with no pad file, use the relative-major pad' }).el,
    ),
    droneNote,
    ),
  );

  // =============================================================================================================
  // RIGHT: presets + FX sections
  // =============================================================================================================
  const G_FX = 'fx';
  const presetBlurb = h('p.ed-hint.ed-preset-blurb', { 'aria-live': 'polite' });
  let lastPreset = null; // blurb of the preset the user picked last (else the matching vibe / space)
  function presetPicker(kind, label, presets) {
    const sel = h('select.ed-select.ed-preset', { 'aria-label': `${label} preset`, dataset: { preset: kind } });
    sel.append(...presets.map((p) => h('option', { value: p.id, text: p.name, title: p.blurb })), h('option.ed-custom', { value: 'custom', text: 'Custom', disabled: true }));
    sel.addEventListener('change', () => {
      const p = presets.find((x) => x.id === sel.value);
      if (!p) return;
      lastPreset = p;
      applyPreset(p, (path, v) => store.set(path, v));
    });
    const paths = [...new Set(presets.flatMap((p) => Object.keys(p.params)))].map(relOf);
    bindFn(G_FX, paths, () => {
      const m = matchPreset(presets, valueOf);
      const v = m ? m.id : 'custom';
      if (sel.value !== v) sel.value = v;
      sel.title = m ? m.blurb : 'Your own settings — change them in the sections below.';
    });
    return field(label, sel, 'ed-field-preset');
  }
  const presetCard = h('section.ed-card.ed-presets', { 'aria-label': 'Sound presets' },
    h('h2.ed-h2', { text: 'Sound' }),
    h('div.ed-preset-grid', {},
      presetPicker('vibe', 'Vibe', VIBE_PRESETS),
      presetPicker('space', 'Space', SPACE_PRESETS),
      presetPicker('echo', 'Echo', ECHO_PRESETS),
    ),
    presetBlurb,
  );
  bindFn(G_FX, ['patch.fx'], () => {
    const vibe = matchPreset(VIBE_PRESETS, valueOf);
    const space = matchPreset(SPACE_PRESETS, valueOf);
    const pick = lastPreset && matchPreset([lastPreset], valueOf) ? lastPreset : null; // still in effect?
    const p = pick || vibe || space;
    setText(presetBlurb, p ? p.blurb : 'Custom sound — fine-tune it in the sections below.');
  });

  const delayTime = kn(G_FX, 'Time', 'fx.delay.time');
  const delayNote = h('p.ed-hint.ed-delay-note');
  bindFn(G_FX, ['patch.fx.delay.sync', 'tempo'], (s) => {
    const sync = s.patch.fx.delay.sync;
    const synced = sync && sync !== 'off';
    delayTime.setDisabled?.(synced);
    delayTime.el.classList.toggle('ed-disabled', synced);
    if (!synced) setText(delayNote, '');
    else if (!s.tempo) setText(delayNote, `${SYNC_NAMES[sync]} need the song’s tempo — set one (or tap it) at the top.`);
    else setText(delayNote, `${SYNC_NAMES[sync]} at ${Math.round(s.tempo)} BPM = ${Math.round((60 / s.tempo) * SYNC_BEATS[sync] * 1000)} ms`);
  });
  const lofiMore = h('details.ed-params.ed-lofi-more', {}, h('summary', { text: 'Tape & vinyl details' }),
    h('div.ed-params-grid', {},
      kn(G_FX, 'Wow', 'fx.lofi.wow').el,
      kn(G_FX, 'Flutter', 'fx.lofi.flutter').el,
      kn(G_FX, 'Crackle', 'fx.lofi.crackle').el,
      kn(G_FX, 'Bit crush', 'fx.lofi.bits').el,
      kn(G_FX, 'Tone', 'fx.lofi.tone').el,
      kn(G_FX, 'Saturation', 'fx.lofi.saturation').el,
    ),
  );
  const fxSec = (id, title, rels, summary, ...kids) =>
    section(`fx-${id}`, title, { cls: 'ed-card ed-fx', dataset: { fx: id }, rels, summary }, ...kids);
  const levelOr = (addr, v, rest) => (Number(v) <= 0.0001 ? 'Off' : `${formatValue(addr, v)}${rest ? ` · ${rest}` : ''}`);
  right.append(
    presetCard,
    fxSec('reverb', 'Reverb', ['patch.fx.reverb'], (s) => {
      const r = s.patch.fx.reverb;
      const m = matchPreset(SPACE_PRESETS, valueOf);
      return levelOr('fx.reverb.returnGain', r.returnGain, m ? m.name : `size ${pct(r.size)}`);
    },
    fad(G_FX, 'Level', 'fx.reverb.returnGain').el,
    kn(G_FX, 'Size', 'fx.reverb.size').el,
    kn(G_FX, 'Darkness', 'fx.reverb.damp').el,
    kn(G_FX, 'Pre-delay', 'fx.reverb.predelay').el,
    ),
    fxSec('delay', 'Echo', ['patch.fx.delay', 'tempo'], (s) => {
      const d = s.patch.fx.delay;
      return levelOr('fx.delay.returnGain', d.returnGain, d.sync && d.sync !== 'off' ? SYNC_NAMES[d.sync] : formatValue('fx.delay.time', d.time));
    },
    fad(G_FX, 'Level', 'fx.delay.returnGain').el,
    selField(G_FX, 'Timing', 'fx.delay.sync', SYNC_OPTS),
    delayTime.el,
    delayNote,
    kn(G_FX, 'Repeats', 'fx.delay.feedback').el,
    kn(G_FX, 'Tone', 'fx.delay.tone').el,
    tog(G_FX, 'Ping-pong (left/right)', 'fx.delay.pingpong').el,
    ),
    fxSec('chorus', 'Chorus', ['patch.fx.chorus'], (s) => levelOr('fx.chorus.returnGain', s.patch.fx.chorus.returnGain),
      fad(G_FX, 'Level', 'fx.chorus.returnGain').el,
      kn(G_FX, 'Speed', 'fx.chorus.rate').el,
      kn(G_FX, 'Depth', 'fx.chorus.depth').el,
    ),
    fxSec('lofi', 'Lofi tape', ['patch.fx.lofi'], (s) => (s.patch.fx.lofi.amount <= 0.0001 ? 'Off' : pct(s.patch.fx.lofi.amount)),
      fad(G_FX, 'Amount', 'fx.lofi.amount').el,
      lofiMore,
    ),
  );
  if (hasParam('fx.eq.low') || hasParam('fx.eq.mid') || hasParam('fx.eq.high')) {
    const bands = [['low', 'Low'], ['mid', 'Mid'], ['high', 'High']].filter(([k]) => hasParam(`fx.eq.${k}`));
    right.append(
      fxSec('eq', 'Tone (EQ)', ['patch.fx.eq'], () => {
        const nz = bands.filter(([k]) => Math.abs(Number(valueOf(`fx.eq.${k}`)) || 0) >= 0.05);
        return nz.length ? nz.map(([k, n]) => `${n} ${formatValue(`fx.eq.${k}`, valueOf(`fx.eq.${k}`))}`).join(' · ') : 'Flat';
      },
      ...bands.map(([k, n]) => kn(G_FX, n, `fx.eq.${k}`).el),
      h('p.ed-hint', { text: 'Whole mix: low = warmth, mid = body, high = air. Double-click a slider to reset.' }),
      ),
    );
  }
  if (hasParam('fx.comp.amount')) {
    right.append(
      fxSec('comp', 'Glue', ['patch.fx.comp'], () => (Number(valueOf('fx.comp.amount')) <= 0.0001 ? 'Off' : pct(valueOf('fx.comp.amount'))),
        kn(G_FX, 'Glue', 'fx.comp.amount').el,
        h('p.ed-hint', { text: 'Gently evens out the whole mix so it sits together. Off = untouched.' }),
      ),
    );
  }
  right.append(
    fxSec('master', 'Master', ['patch.fx.master'], (s) => formatValue('master.volume', s.patch.fx.master.volume),
      fad(G_FX, 'Volume', 'master.volume').el,
    ),
  );

  // =============================================================================================================
  // BOTTOM: keyboard + meter
  // =============================================================================================================
  const perform = controller && controller.perform;
  const piano = C.pianoKeyboard({
    from: 36,
    to: 96,
    onNoteOn: (n, v) => perform && perform.noteOn(n, Number.isFinite(v) ? v : 100),
    onNoteOff: (n) => perform && perform.noteOff(n),
  });
  track('bottom', piano);
  const meter = C.meter({ engine });
  track('bottom', meter);
  bottom.append(h('div.ed-piano', {}, piano.el), h('div.ed-meter', {}, meter.el));
  const onNotes = (e) => {
    const held = e && e.detail && e.detail.held;
    if (held) piano.set(held);
  };
  listen(controller, 'notes', onNotes);

  // =============================================================================================================
  // Esc (ux.md M1): inside Edit, Esc closes the open confirm / panel and never panics. Capture phase on window so it
  // runs before the controller's document-level handler (which ignores defaultPrevented events).
  // =============================================================================================================
  const editVisible = () => root.isConnected && !el.hidden && !el.closest('[hidden]');
  listen(window, 'keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !editVisible()) return;
    if (document.querySelector('.st-host.open')) return; // Settings is on top and closes itself
    const t = e.target;
    const own = t && t.closest && (t.closest('.ed-song-rename') || t === setNameInput || t === searchInput);
    if (own) return; // those inputs handle Esc themselves
    let closed = false;
    if (confirmIdx >= 0) closed = cancelRowConfirm();
    else if (!setConfirm.hidden) {
      closeSetConfirm();
      closed = true;
    } else if (resetConfirming) {
      renderReset(store.currentSong());
      closed = true;
    } else if (closePanels()) closed = true;
    e.preventDefault(); // Esc is never Panic in Edit (⌘. still is)
    if (closed) {
      e.stopPropagation();
      markDialog('edit', true); // keep the flag up for any later Esc listener of this same event…
      setTimeout(syncDialog, 0); // …then drop it
    }
  }, true);

  // =============================================================================================================
  // wiring
  // =============================================================================================================
  /**
   * Before the shown song changes: commit what is being typed to the song it belongs to, and let go of the field so
   * it shows the new song (applyBind never overwrites a focused text field); abandon fader/knob drags (#2, #3).
   */
  function leaveSong() {
    if (notesTimer) flushNotes();
    const a = document.activeElement;
    if (a && a.dataset?.songField && root.contains(a)) a.blur(); // fires its change → setField(old id)
    for (const list of comps.values()) for (const c of list) c.cancelDrag?.();
  }
  function showSong(s) {
    if ((s ? s.id : null) !== shownId) leaveSong();
    song = s;
    shownId = s ? s.id : null;
    root.classList.toggle('no-song', !s);
    for (let i = 0; i < SLOT_COUNT; i++) syncCard(i);
    for (const b of binds) b.last = undefined;
    refresh(null);
  }

  function onStore(state, paths) {
    const cur = state.settings.currentSongId;
    const next = cur ? state.songs[cur] || null : null;
    let listDirty = false;
    let full = false;
    const rels = [];
    for (const p of paths) {
      if (p === 'settings' || p.startsWith('settings.currentS') || p.startsWith('settings.setlist')) listDirty = true;
      else if (p.startsWith('setlists') || p === 'songOrder' || p === 'setlistOrder' || p === 'songs') listDirty = true;
      else if (p.startsWith('songs.')) {
        const segs = p.split('.');
        const id = segs[1];
        const rest = segs.slice(2).join('.');
        if (!rest || rest === 'name' || rest === 'category') listDirty = true;
        if (id === cur) {
          if (!rest) full = true;
          else rels.push(rest);
        }
      }
    }
    if (cur !== shownId || (next && !song)) {
      showSong(next);
      listDirty = true;
    } else if (next) {
      song = next;
      if (full) {
        for (let i = 0; i < SLOT_COUNT; i++) syncCard(i);
        refresh(null);
      } else if (rels.length) {
        for (let i = 0; i < SLOT_COUNT; i++) {
          const sr = `patch.slots.${i}`;
          if (rels.some((r) => r === 'patch' || r === 'patch.slots' || r === sr || r.startsWith(`${sr}.instrument`))) syncCard(i);
        }
        refresh(rels);
      }
    } else if (!next && song) showSong(null);
    if (listDirty) renderList();
  }
  cleanups.push(store.subscribe(onStore));

  // instrument list arrives when the engine has started (registry init) and changes on a My Samples rescan
  const onInstruments = () => {
    const l = readInstruments();
    if (l.length === instruments.length && l.every((x, k) => x.ref.id === instruments[k].ref.id && x.ref.type === instruments[k].ref.type && x.group === instruments[k].group)) return;
    instruments = l;
    for (let i = 0; i < SLOT_COUNT; i++) syncCard(i, true);
    refresh(null);
  };
  listen(engine, 'ready', onInstruments);
  listen(engine, 'instruments', onInstruments);
  listen(controller, 'instruments', onInstruments);
  listen(window, 'rig-instruments-changed', onInstruments);
  listen(controller, 'user-samples', onInstruments);
  if (typeof controller?.onStatus === 'function') {
    cleanups.push(
      controller.onStatus((st) => {
        loadingBadge.hidden = !st.loading;
        if (!instruments.length) onInstruments();
      }),
    );
  }

  showSong(song);
  renderList();

  return {
    el: root,
    destroy() {
      clearTimeout(notesTimer);
      for (const c of cleanups.splice(0)) {
        try {
          c();
        } catch (err) {
          console.warn('[edit] cleanup failed', err);
        }
      }
      try {
        perform?.releaseAll?.();
      } catch {
        /* ignore */
      }
      markDialog('edit', false);
      for (const g of [...comps.keys()]) destroyGroup(g);
      binds.clear();
      el.replaceChildren();
      el.classList.remove('ed-host');
      delete el.__rigCtx;
    },
    /** Test hooks. */
    _debug: {
      importText,
      bindCount: () => binds.size,
      cardKeys: () => cards.map((c) => c.key),
      components: C.__source,
      groups: () => groupOrder(instruments.filter((it) => !HIDDEN_IN_PICKER.has(`${it.ref.type}:${it.ref.id}`) && !it.hidden)),
      sections: () => ({ ...secState }),
    },
  };
}
