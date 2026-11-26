// UI v6 Edit › one instrument (U5a; native DECISIONS D15, D18; mockup native/docs/design/mockups/edit.html tabs
// "Instrument · Sound / Tone EQ / Range / iPad portrait", "Change instrument").
//
// Layout: the plain-English sentence (tappable words) + "Change instrument ▾" over three columns: the category list
// (Sound · Tone EQ · Range · Touch · Sustain · Space & Echo · Advanced; each row shows its current state under the
// name and a dot when it changed since the song began), the chosen category in the middle, and the v6 Perform strip
// on the right (views/v6/strip.js, the very same component: D15). At iPad portrait the list is a row of tabs and the
// strip is hidden (CSS).
//
// Every control writes what today's Edit slot panel (views/edit/panels/slot.js) writes, through the panel ctx
// (ctx.set → store.set) and the same lib.js widgets: no new store paths, no engine calls (reads only). The pieces of
// slot.js that are closures there (the picker, the note fields, "Set lowest / highest", the Sustain row, the shelf
// sliders) are re-built here on the same rules; slot.js stays as it is (today's Edit, flag off).
import {
  h, setText, getIn, relOf, hasParam, signed, pct, semitones, formatInstrumentParam, createBinder, wordSlider,
  sentence, spaceNoun,
} from '../../edit/lib.js';
import { defaultSlot, describe, formatValue } from '../../../shared/params.js';
import { noteName } from '../../../shared/music.js';
import { SPACE_PRESETS, ECHO_PRESETS, matchPreset } from '../../../shared/fx-presets.js';
import {
  smartSlidersFor, slotPath, wordFor, formatSmart, describeSlot, sendWords,
} from '../../../shared/smart-controls.js';
import { readEq, shelfWrites, eqSummary as mathSummary } from '../../../shared/eq-math.js';
import { PEDAL_HOLD_TRACK } from '../../../shared/learn.js';
import { hasChange } from '../../../shared/song-diff.js';
import { groupOf, groupOrder, parseKey, TOUCH_LABELS, followSlot, UNDO_MS } from '../../edit/panels/slot.js';
import { rangeKeyboard, rangeText } from '../keyboard.js';
import { createStrip } from '../strip.js';
import { slotColor } from '../lib.js';

/**
 * The category list (D18). `dot` = the slot-relative fields whose change (against the Revert snapshot, the v6 watch
 * list V6_DIFF_WATCH = today's DIFF_WATCH + the range) puts a dot on the row: today's rule, so faders, levels, EQ
 * and sound sliders never dot (CONTRACT §3.6); Range adds lowNote / highNote like v6 Perform's bars.
 */
export const CATEGORIES = Object.freeze([
  { id: 'sound', label: 'Sound', blurb: 'how this instrument itself sounds', dot: [] },
  { id: 'eq', label: 'Tone EQ', blurb: 'drag a point, or double-tap the curve to add one', dot: [] },
  { id: 'range', label: 'Range', blurb: 'which keys play it · drag the ends of the colour, or set by playing',
    dot: ['lowNote', 'highNote', 'octave'] },
  { id: 'touch', label: 'Touch', blurb: 'how it answers your playing', dot: [] },
  { id: 'sustain', label: 'Sustain', blurb: 'what the sustain pedal does to it', dot: ['sustain'] },
  { id: 'sends', label: 'Space & Echo', blurb: 'how much of it goes into the shared effects', dot: ['sends'] },
  { id: 'adv', label: 'Advanced', blurb: 'pan, width, transpose, voices and the instrument’s own settings', dot: [] },
]);
export const CATEGORY_IDS = Object.freeze(CATEGORIES.map((c) => c.id));

const HIDDEN_IN_PICKER = new Set(['synth:drone-osc']);
const TOUCH_HINTS = {
  soft: 'Light: soft playing still sounds full.',
  normal: 'Normal: volume follows how hard you play (and your keyboard’s own touch, if you gave it one in Settings).',
  hard: 'Heavy: you have to dig in for full volume.',
  fixed: 'Fixed: every note plays at the same volume.',
  custom: 'Own: this sound’s own curve.',
};
const VEL_OPTS = ['soft', 'normal', 'hard', 'fixed', 'custom']
  .map((v) => ({ value: v, label: TOUCH_LABELS[v], title: TOUCH_HINTS[v] }));
const MONO_OPTS = [
  { value: 'off', label: 'Chords' },
  { value: 'lowest', label: 'Single note (lowest)' },
  { value: 'highest', label: 'Single note (highest)' },
];
const OCTAVE_TEXT = { 1: 'an octave up', 2: 'two octaves up', '-1': 'an octave down', '-2': 'two octaves down' };
const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), textarea, button:not([disabled]), [tabindex]';
const refKey = (ref) => (ref ? `${ref.type}:${ref.id}` : '');
const capital = (s) => String(s)[0].toUpperCase() + String(s).slice(1);
/** "Flat" / "Shaped · 3 bands" (slot.js eqSummary: "Custom" is not an Edit word). */
const eqSummary = (eq) => mathSummary(eq).replace(/^Custom\b/, 'Shaped');
/** "0.8 s" / "12 s" / "40 ms" (slot.js secs). */
const secs = (v) => {
  if (v < 0.1) return `${Math.round(v * 1000)} ms`;
  return v < 10 ? `${(Math.round(v * 10) / 10).toFixed(1)} s` : `${Math.round(v)} s`;
};
const HOLD_TOP = PEDAL_HOLD_TRACK.top;
const HOLD_NATURAL = PEDAL_HOLD_TRACK.natural;
/** Per-mount id prefix for the category tabs / pane (aria-controls / aria-labelledby). */
let mountSeq = 0;
/** iPad portrait, where the category list is a row of tabs (styles-v6-edit.css; edit.js PORTRAIT_MQ). */
const PORTRAIT_MQ = '(orientation: portrait) and (max-width: 1024px)';

/**
 * dB of the EQ's highest high shelf / lowest low shelf (slot.js shelfDb; 0 when off or absent, round3-edit m1).
 * @param {object} eq @param {'high'|'low'} which @returns {number}
 */
export function shelfDb(eq, which) {
  const type = which === 'high' ? 'highshelf' : 'lowshelf';
  const list = readEq(eq).bands.filter((b) => b.type === type);
  const b = which === 'high' ? list[list.length - 1] : list[0];
  return b && b.on !== false ? b.db : 0;
}

/**
 * The value a smart-slider spec reads from a slot (what slot.js's binder reads).
 * @param {object} spec smartSlidersFor() spec @param {object} slot @returns {number}
 */
function specValue(spec, slot) {
  if (spec.shelf) return shelfDb(slot.eq, spec.shelf);
  const rel = spec.path.replace('slots.<i>.', '');
  const v = getIn(slot, rel);
  return v === undefined ? spec.default : v;
}

/**
 * The instrument's own release in seconds (slot.js ownRelease): its `release` param (a sampler's is τ × 6.9).
 * @returns {number|null}
 */
function ownRelease(slot, meta) {
  const p = meta && Array.isArray(meta.params) ? meta.params.find((x) => x && x.key === 'release') : null;
  if (!p) return null;
  const v = Number(slot?.params?.release ?? p.default);
  if (!(v > 0)) return null;
  return slot.instrument.type === 'sampler' ? Math.min(5, v) * 6.9 : v;
}

/**
 * One category row's current state, in words (the small line under its name).
 * @param {string} cat category id
 * @param {object} slot
 * @param {object|null} meta listInstruments() entry
 * @param {number} i slot index
 * @returns {string}
 */
export function categorySummary(cat, slot, meta, i) {
  if (!slot) return '';
  switch (cat) {
    case 'sound':
      return smartSlidersFor(meta).map((sp) => wordFor(sp.role, specValue(sp, slot), sp) || formatSmart(sp,
        specValue(sp, slot))).join(' · ');
    case 'eq':
      return hasParam(`slots.${i}.eq.b1.db`) ? eqSummary(slot.eq) : 'Low · High';
    case 'range': {
      const oct = Math.round(Number(slot.octave) || 0);
      return `${rangeText(slot.lowNote, slot.highNote)}${oct ? ` · ${OCTAVE_TEXT[oct] || `${signed(oct)} oct`}` : ''}`;
    }
    case 'touch':
      return TOUCH_LABELS[slot.velocityCurve || 'normal'] || 'Normal';
    case 'sustain': {
      const pedal = slot.sustain === false ? 'pedal ignored' : 'pedal holds';
      const rel = Number.isFinite(slot.release) ? secs(slot.release) : 'own release';
      return `${pedal} · ${rel}`;
    }
    case 'sends': {
      const s = slot.sends || {};
      const ch = Number(s.chorus) || 0;
      const chorus = ch > 0.0005 ? ` · chorus ${pct(ch)}` : '';
      return `${pct(Number(s.reverb) || 0)} · ${pct(Number(s.delay) || 0)}${chorus}`;
    }
    case 'adv': {
      const parts = [];
      const pan = Number(slot.pan) || 0;
      if (Math.abs(pan) >= 0.005) parts.push(`Pan ${formatValue(`slots.${i}.pan`, pan)}`);
      if (hasParam(`slots.${i}.width`)) {
        const w = typeof slot.width === 'number' ? slot.width : describe(`slots.${i}.width`).default;
        parts.push(`Width ${w < 0.005 ? 'Mono' : pct(w)}`);
      }
      parts.push(`Transpose ${signed(Math.round(Number(slot.transpose) || 0))}`);
      return parts.join(' · ');
    }
    default:
      return '';
  }
}

/**
 * Sentence parts for v6 (D15: no role word): "Grand Piano plays on every key, a little into the Hall, sustain on".
 * describeSlot()'s parts with the role dropped and the instrument's name moved to the front.
 * @returns {Array<string|object>}
 */
export function v6SentenceParts(slot, meta, o) {
  if (!slot) {
    return [{ text: 'Nothing plays here yet.', key: null }, ' ', { text: 'Choose a sound', key: 'instrument' }];
  }
  const parts = describeSlot(slot, meta, { ...o, role: '' }).slice(1);
  const k = parts.findIndex((p) => p && typeof p === 'object' && p.key === 'instrument');
  if (k < 0) return parts;
  const before = parts.slice(0, k).map((p, n) => (n === k - 1 && typeof p === 'string' ? p.replace(/\s+$/, '') : p));
  return [{ ...parts[k], name: true }, ...before, ...parts.slice(k + 1), '.'];
}

/**
 * Mount the v6 instrument panel.
 * @param {HTMLElement} host
 * @param {object} ctx      the panel ctx (views/edit/CONTRACT.md §3, from shell.js createEditCore)
 * @param {{slot:number, focus?:string}} opts
 * @param {{prefs:{cat:string, setCat(id:string):void}, changes:() => Set<string>, stripV:object,
 *          popHost:HTMLElement}} env
 *   changes: the v6 changed set (song-relative paths, V6_DIFF_WATCH); stripV: the view context strip.js expects
 * @returns {{update(opts:object):void, destroy():void, _debug:object}}
 */
export function mountInstrument(host, ctx, opts, env) {
  const C = ctx.C || {};
  let i = Math.max(0, Math.round(Number(opts.slot) || 0));
  const P = (k) => `slots.${i}.${k}`;
  const REL = () => `patch.slots.${i}`;
  const slotOf = (s) => (s && s.patch && Array.isArray(s.patch.slots) ? s.patch.slots[i] || null : null);
  const curSlot = () => slotOf(ctx.song());
  const metaOf = (slot) => (slot ? ctx.findInstrument(slot.instrument) : null);
  const displayName = (slot, meta) => {
    if (!slot) return 'Empty';
    if (!meta) return `${slot.instrument.id} (not available)`;
    return typeof C.stageName === 'function' ? C.stageName(meta.name, slot.instrument) : meta.name;
  };
  const silent = () => i >= (typeof ctx.controller?.engineSlots === 'function' ? ctx.controller.engineSlots() : 16);
  const slotKey = (slot) => (slot ? `${refKey(slot.instrument)}:${metaOf(slot) ? 1 : 0}` : 'empty');
  const isChangedRel = (f) => hasChange(env.changes(), `${REL()}.${f}`);

  // ---------------------------------------------------------------- frame
  const bar = h('span.v6e-ibar', { 'aria-hidden': 'true' });
  const sentHost = h('div.v6e-sent', { 'data-testid': 'v6e-sentence' });
  const chgBtn = h('button.btn.v6e-chg', {
    type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-testid': 'v6e-change',
  }, h('span', { text: 'Change instrument' }), ' ▾');
  const menuEl = h('div.v6e-imenu', { role: 'menu', hidden: true, tabindex: '-1', 'data-testid': 'v6e-imenu' });
  const actions = h('div.v6e-iact', {}, chgBtn, menuEl);
  const confirmEl = h('div.v6e-confirm', { role: 'alertdialog', hidden: true, 'aria-label': 'Remove this sound' });
  const head = h('div.v6e-ihead', {}, bar, sentHost, actions);
  // skeptic UI6-U5a F1: a real tablist / tabpanel pair. The list is vertical (↑ / ↓) except at iPad portrait, where
  // it is a row of tabs (← / →): aria-orientation says which (renderNav); each tab controls the pane, and the pane is
  // labelled by the chosen tab (the ids are per mount: two panels never share them)
  const uid = `v6e-${(mountSeq += 1)}`;
  const portraitMq = typeof matchMedia === 'function' ? matchMedia(PORTRAIT_MQ) : null;
  const contId = `${uid}-pane`;
  const nav = h('nav.v6e-cnav', {
    role: 'tablist', 'aria-label': 'What to edit', 'aria-orientation': 'vertical', 'data-testid': 'v6e-cnav',
  });
  const navRecs = new Map();
  for (const c of CATEGORIES) {
    const dot = h('span.v6e-cd', { title: 'Changed since the song began', hidden: true });
    const sum = h('small.v6e-cn-sum');
    const b = h('button.v6e-cn', {
      type: 'button', role: 'tab', id: `${uid}-cat-${c.id}`, 'aria-controls': contId, 'aria-selected': 'false',
      tabindex: '-1', dataset: { cat: c.id }, 'data-testid': `v6e-cat-${c.id}`,
    }, h('b', {}, h('span', { text: c.label }), dot), sum);
    b.addEventListener('click', () => choose(c.id, { persist: true }));
    nav.append(b);
    navRecs.set(c.id, { el: b, dot, sum });
  }
  nav.addEventListener('keydown', (e) => {
    const ids = CATEGORY_IDS;
    const k = ids.indexOf(e.target?.dataset?.cat);
    if (k < 0) return;
    const portrait = navIsRow();
    const next = portrait ? 'ArrowRight' : 'ArrowDown';
    const prev = portrait ? 'ArrowLeft' : 'ArrowUp';
    let n = -1;
    if (e.key === next) n = (k + 1) % ids.length;
    else if (e.key === prev) n = (k - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = ids.length - 1;
    if (n < 0) return;
    e.preventDefault();
    e.stopPropagation(); // ←/→ are Prev / Next song and ↑/↓ the mod wheel elsewhere
    choose(ids[n], { persist: true });
    navRecs.get(ids[n]).el.focus();
  });
  const paneTitle = h('h4.v6e-h4');
  const paneHost = h('div.v6e-pane');
  const cont = h('section.v6e-ccont', { role: 'tabpanel', id: contId, 'data-testid': 'v6e-ccont' }, paneTitle,
    paneHost);
  const stageCol = h('section.v6e-stage', { 'data-testid': 'v6e-stage' }, h('h4.v6e-h4', { text: 'On stage' }));
  const cols = h('div.v6e-ncols', {}, nav, cont, stageCol);
  const root = h('div.v6e-inst', { 'data-testid': 'v6e-inst' }, head, confirmEl, cols);
  host.replaceChildren(root);

  // ---------------------------------------------------------------- the strip (D15: the same component as Perform)
  // The strip exists only while Edit shows: Perform's strips are the same component with the same test ids and
  // classes, and a second, hidden strip of slot i would double them (and run its meter) behind the stage.
  let strip = null;
  const editShown = () => ctx.store.get()?.settings?.view === 'edit';
  function makeStrip() {
    strip?.destroy();
    strip = null;
    if (!editShown()) return;
    strip = createStrip(env.stripV, i);
    // R2: the name is a button (D24.3) that opens Range here (stripV.pickRange). Edit never picks a bar, so it is a
    // plain action: no pressed state, and a title that says what it does in Edit
    const who = strip.el.querySelector('.v6-who');
    if (who) {
      who.removeAttribute('aria-pressed');
      who.title = 'Change which keys play this instrument (Range)';
    }
    stageCol.append(strip.el);
  }
  function dropStrip() {
    strip?.destroy();
    strip = null;
  }
  function renderStrip() {
    if (!editShown()) {
      dropStrip();
      return;
    }
    if (!strip) makeStrip();
    const s = ctx.song();
    const slot = slotOf(env.live ? env.live(s) : s);
    const meta = metaOf(slot);
    const base = ctx.editState.baseline;
    strip.render({
      slot, base: base ? base.patch?.slots?.[i] || null : null, changed: env.changes(),
      name: displayName(slot, meta), title: meta ? meta.name : '', silent: !!slot && silent(),
      n: s ? s.patch.slots.length : 0, locked: !!ctx.store.get().settings.performLock, wheel: null,
    });
  }

  // ---------------------------------------------------------------- category state
  let cat = CATEGORY_IDS.includes(env.prefs.cat) ? env.prefs.cat : 'sound';
  /** The mounted pane: its binder, cleanup list and the controls a token / focus reaches. */
  let pane = null;
  let paneKey = '';
  function choose(id, { persist = false } = {}) {
    if (!CATEGORY_IDS.includes(id)) return;
    if (persist) env.prefs.setCat(id);
    if (id === cat && pane) return;
    cat = id;
    buildPane();
    renderNav();
    revealCat();
  }

  function destroyPane() {
    if (!pane) return;
    disarm();
    for (const fn of pane.offs.splice(0).reverse()) {
      try {
        fn();
      } catch (err) {
        console.warn('[v6 edit] pane cleanup failed', err);
      }
    }
    try {
      pane.binder.destroy();
    } catch (err) {
      console.warn('[v6 edit] pane binder destroy failed', err);
    }
    pane = null;
  }

  function buildPane() {
    destroyPane();
    const slot = curSlot();
    const meta = metaOf(slot);
    const binder = createBinder(ctx);
    pane = { binder, offs: [], ctl: {}, cat };
    paneKey = `${cat}|${slotKey(slot)}|${i}`;
    const c = CATEGORIES.find((x) => x.id === cat);
    paneTitle.replaceChildren(c.label, h('small', { text: c.blurb }));
    cont.dataset.cat = cat;
    cont.setAttribute('aria-labelledby', navRecs.get(cat).el.id);
    if (!slot) {
      paneTitle.replaceChildren('Empty');
      paneHost.replaceChildren(buildEmpty());
      return;
    }
    let body;
    switch (cat) {
      case 'sound': body = buildSound(binder, slot, meta); break;
      case 'eq': body = buildEq(binder); break;
      case 'range': body = buildRange(binder, slot); break;
      case 'touch': body = buildTouch(binder); break;
      case 'sustain': body = buildSustain(binder, slot, meta); break;
      case 'sends': body = buildSends(binder); break;
      default: body = buildAdvanced(binder, slot, meta);
    }
    paneHost.replaceChildren(body);
    paneHost.dataset.cat = cat;
  }

  function buildEmpty() {
    const choose1 = h('button.btn.v6e-choose', { type: 'button', 'data-testid': 'v6e-choose' }, 'Choose a sound ▾');
    choose1.addEventListener('click', () => openMenu({ focus: true }));
    const undoLine = h('p.v6e-undo', { hidden: true });
    pane.ctl.undoLine = undoLine;
    queueMicrotask(renderEmptyUndo);
    return h('div.v6e-empty', { dataset: { empty: '1' } },
      h('p.v6e-empty-q', { text: 'Nothing plays here yet.' }),
      h('p.v6e-hint', {
        text: 'Pick an instrument and it takes this place in your rig, with the usual settings for it.',
      }),
      choose1, undoLine);
  }

  // ---- Sound: the three smart sliders (slot.js THE SOUND ITSELF) ----
  function buildSound(binder, slot, meta) {
    const specs = smartSlidersFor(meta);
    const rel = REL();
    const box = h('div.v6e-sound');
    pane.ctl.smart = specs.map((spec) => {
      const addr = slotPath(spec, i);
      const how = spec.shelf ? {
        read: (s) => {
          const sl = slotOf(s);
          return sl ? shelfDb(sl.eq, spec.shelf) : undefined;
        },
        write: (v) => writeShelf(spec.shelf, v),
        rels: [`${rel}.eq`],
      } : {
        read: spec.key ? (s) => {
          const sl = slotOf(s);
          if (!sl) return undefined;
          const v = sl.params ? sl.params[spec.key] : undefined;
          return v === undefined ? spec.default : v;
        } : undefined,
      };
      const ctl = binder.ctl(addr, (onChange) => wordSlider({
        label: spec.label, min: spec.min, max: spec.max, curve: spec.curve, default: spec.default,
        bipolar: spec.bipolar, ends: spec.ends, word: (v) => wordFor(spec.role, v, spec),
        format: (v) => formatSmart(spec, v), onChange,
      }), how);
      ctl.el.dataset.smart = spec.role;
      if (spec.shelf) ctl.el.dataset.noLearn = '1';
      box.append(ctl.el);
      return ctl;
    });
    const toEq = h('button.btn.ghost.v6e-link', { type: 'button', text: 'More tone shaping: Tone EQ ▸' });
    toEq.addEventListener('click', () => choose('eq', { persist: true }));
    box.append(h('div.v6e-row', {}, toEq));
    return box;
  }
  function writeShelf(which, db) {
    const sl = curSlot();
    if (!sl) return;
    for (const [k, v] of shelfWrites(sl.eq, which, db)) ctx.set(P(`eq.${k}`), v);
  }

  // ---- Tone EQ: today's eqKeyboard, mounted only while this category shows (destroyed on leave) ----
  const toneStats = { created: 0, destroyed: 0 };
  let toneEq = null;
  function buildEq(binder) {
    const box = h('div.v6e-eq');
    if (!hasParam(P('eq.b1.db'))) {
      box.append(h('p.v6e-hint', { text: 'This build has no keyboard EQ.' }));
      return box;
    }
    const sum = h('span.v6e-eqsum');
    binder.fn([`${REL()}.eq`], (s) => setText(sum, eqSummary(slotOf(s)?.eq)));
    const toneHost = h('div.v6e-tonehost');
    box.append(h('p.v6e-hint', {}, sum, ' · Brightness and Warmth (Sound) move the high and low shelves.'), toneHost);
    if (typeof C.eqKeyboard !== 'function') {
      toneHost.append(h('p.v6e-hint', { text: 'The tone editor needs the full app.' }));
      return box;
    }
    try {
      toneEq = C.eqKeyboard({
        store: ctx.store, engine: silent() ? null : ctx.engine, controller: ctx.controller, slotIndex: i,
        toast: (msg) => ctx.toast(msg, 'info'), compactBelowHeight: 1000,
      });
      toneStats.created += 1;
      toneHost.append(toneEq.el);
    } catch (err) {
      console.warn('[v6 edit] tone editor failed to mount', err);
      toneEq = null;
    }
    pane.offs.push(() => {
      const e = toneEq;
      toneEq = null;
      if (!e) return;
      try {
        e.destroy();
      } catch (err) {
        console.warn('[v6 edit] tone editor destroy failed', err);
      }
      toneStats.destroyed += 1;
    });
    return box;
  }

  // ---- Range: U2's rangeKeyboard 'range' size + note boxes + Whole keyboard + Set by playing + Octave ----
  function buildRange(binder, slot) {
    // D24.2: the bar writes live while dragged ('live', then 'end'; ←/→ 'key'). Every write names the song it is for
    // (as the v6 Perform's setRange): a §4 'slots.<i>' address resolves to the store's current song, which a song
    // switch has already moved on by the time the leave-song hook cancels the drag (UI6-U5a review R1).
    let dragSong = null;
    const kb = rangeKeyboard({
      size: 'range', testid: 'v6e-range-kbd', label: 'Keyboard range (A0–C8)',
      onRange: (k, f, n, phase, expect) => {
        if ((f !== 'lowNote' && f !== 'highNote') || !Number.isInteger(n)) return false;
        if (phase === 'cancel') {
          // a dropped drag puts its start value back into the song and instrument it wrote (k follows a slot move,
          // remapDrag), and only while that slot still holds the value it last wrote (`expect`), so a restore never
          // lands on another instrument (R1)
          const id = dragSong || ctx.songId();
          dragSong = null;
          const sl = id ? ctx.store.getSong?.(id)?.patch.slots[k] : null;
          if (!sl || sl[f] !== expect) return false;
          return ctx.set(`songs.${id}.patch.slots.${k}.${f}`, n);
        }
        const id = ctx.songId();
        if (k !== i || !id || !slotOf(ctx.store.getSong?.(id))) return false;
        dragSong = phase === 'live' ? id : null;
        return ctx.set(`songs.${id}.patch.slots.${i}.${f}`, n);
      },
      // the keys play (as Perform's): playing one also answers "Set lowest / highest by playing"
      onNoteOn: (n, vel) => ctx.controller?.perform?.noteOn?.(n, Number.isFinite(vel) ? vel : 100),
      onNoteOff: (n) => ctx.controller?.perform?.noteOff?.(n),
    });
    pane.ctl.kb = kb;
    pane.offs.push(() => {
      kb.cancelDrag();
      kb.releaseAll();
      kb.destroy();
    });
    const renderKb = (s) => {
      const sl = slotOf(s);
      if (!sl) return;
      kb.render({
        bars: [{
          i, name: displayName(sl, metaOf(sl)), color: slotColor(i), lo: sl.lowNote, hi: sl.highNote,
          off: !!sl.muted, changed: isChangedRel('lowNote') || isChangedRel('highNote'),
        }],
        locked: false,
      });
    };
    binder.fn([`${REL()}.lowNote`, `${REL()}.highNote`, `${REL()}.muted`, `${REL()}.instrument`], renderKb);
    pane.renderKb = () => renderKb(ctx.song());
    const sayRange = h('span.v6e-rsay', { 'data-testid': 'v6e-range-text' });
    binder.fn([`${REL()}.lowNote`, `${REL()}.highNote`], (s) => {
      const sl = slotOf(s);
      if (sl) setText(sayRange, rangeText(sl.lowNote, sl.highNote));
    });
    const low = noteField(binder, 'Lowest', 'lowNote');
    const high = noteField(binder, 'Highest', 'highNote');
    pane.ctl.low = low;
    pane.ctl.high = high;
    const whole = h('button.btn.v6e-whole', { type: 'button', text: 'Whole keyboard', 'data-testid': 'v6e-whole',
      title: 'Play this instrument across the whole keyboard' });
    whole.addEventListener('click', () => {
      ctx.set(P('lowNote'), 0);
      ctx.set(P('highNote'), 127);
    });
    const armBtn = (arm) => {
      const b = h('button.btn.v6e-arm', { type: 'button', 'aria-pressed': 'false', dataset: { arm },
        'data-testid': `v6e-arm-${arm}` });
      b.addEventListener('click', () => toggleArm(arm));
      return b;
    };
    pane.ctl.armLow = armBtn('low');
    pane.ctl.armHigh = armBtn('high');
    pane.ctl.armHint = h('small.v6e-hint.v6e-armhint', { 'aria-live': 'polite' });
    renderArm();
    const octave = binder.ctl(P('octave'), (onChange) => C.stepper({
      label: 'Octave', min: -2, max: 2, step: 1, format: (v) => (v ? signed(v) : '0'), onChange,
    }));
    pane.ctl.octave = octave;
    return h('div.v6e-range', { dataset: { sec: `v6e-range-${i}` } },
      kb.el,
      h('div.v6e-row.v6e-fields', {}, low, h('span.v6e-to', { text: 'to' }), high, sayRange, h('span.v6e-sp'), whole),
      h('div.v6e-row.v6e-arms', {}, pane.ctl.armLow, pane.ctl.armHigh),
      pane.ctl.armHint,
      h('div.v6e-row.v6e-oct', {}, octave.el,
        h('small.v6e-hint', { text: 'Starts on your next note; held notes keep ringing.' })));
  }

  /** Song-bound note field (slot.js noteField): "C3", "F#2" or a MIDI number. */
  let leavingSong = false;
  function noteField(binder, label, f) {
    const addr = P(f);
    const input = h('input.v6e-note', {
      type: 'text', inputmode: 'text', spellcheck: 'false', autocomplete: 'off', size: 4, 'aria-label': `${label} key`,
      'data-testid': `v6e-${f}`,
    });
    const commit = ctx.songField(input, relOf(addr));
    const comp = {
      el: input,
      set: (v) => {
        input.value = noteName(Number(v));
        input.title = `Key ${noteName(Number(v))} (MIDI note ${v})`;
      },
    };
    input.addEventListener('change', () => {
      const raw = input.value.trim();
      const n = parseKey(raw);
      if (n !== null) commit(n);
      else if (!leavingSong) ctx.toast(`“${raw}” is not a key name — try C4 or F#2`, 'warn');
      if (ctx.fieldSongId(input) !== ctx.songId()) return;
      const cur = getIn(ctx.song(), relOf(addr));
      if (cur !== undefined) comp.set(cur);
    });
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') input.blur();
    });
    binder.ctl(addr, () => comp, { text: 'dirty' });
    return input;
  }

  // ---- "Set lowest / highest by playing": a one-shot on the next held note (slot.js) ----
  /** @type {'low'|'high'|null} */
  let armed = null;
  let heldBefore = new Set();
  function renderArm() {
    const c = pane && pane.ctl;
    if (!c || !c.armLow) return;
    for (const [b, w, text] of [[c.armLow, 'low', 'Set lowest by playing'], [c.armHigh, 'high',
      'Set highest by playing']]) {
      const on = armed === w;
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('armed', on);
      setText(b, on ? 'Play a key…' : text);
    }
    setText(c.armHint, armed
      ? `Play the ${armed === 'low' ? 'lowest' : 'highest'} key this instrument should play. Esc cancels.`
      : 'Tap Set, then play the key on your keyboard.');
  }
  function toggleArm(which) {
    if (armed === which) {
      disarm();
      return;
    }
    closeMenu(false);
    armed = which;
    heldBefore = new Set(ctx.held());
    renderArm();
  }
  function disarm() {
    if (!armed) return false;
    armed = null;
    renderArm();
    return true;
  }
  function onNotes(e) {
    const held = (e && e.detail && e.detail.held) || ctx.held();
    if (!armed) {
      heldBefore = new Set(held);
      return;
    }
    const fresh = [...held].filter((n) => !heldBefore.has(n));
    heldBefore = new Set(held);
    if (!fresh.length) return;
    const sl = curSlot();
    const which = armed;
    disarm();
    if (!sl) return;
    if (which === 'low') {
      const n = Math.min(...fresh);
      ctx.set(P('lowNote'), n);
      if (n > sl.highNote) ctx.set(P('highNote'), 127);
    } else {
      const n = Math.max(...fresh);
      ctx.set(P('highNote'), n);
      if (n < sl.lowNote) ctx.set(P('lowNote'), 0);
    }
  }

  // ---- Touch: today's response choices (velocityCurve) + Own's four sliders ----
  function buildTouch(binder) {
    const resp = binder.ctl(P('velocityCurve'), (onChange) => C.segmented({
      label: 'Touch', options: VEL_OPTS, onChange,
    }));
    pane.ctl.resp = resp;
    const touchSl = (k, o) => {
      const row = describe(P(`touch.${k}`));
      return binder.ctl(P(`touch.${k}`), (onChange) => wordSlider({
        min: row.min, max: row.max, default: row.default, ...o, onChange,
      }));
    };
    const own = [
      touchSl('shape', {
        label: 'Feel', curve: 'log', ends: ['light', 'heavy'], format: (v) => Number(v).toFixed(2),
      }),
      touchSl('min', { label: 'Softest note', format: pct, ends: ['silent', 'loud'] }),
      touchSl('max', { label: 'Loudest note', format: pct, ends: ['quiet', 'full'] }),
      touchSl('top', { label: 'Full volume at', step: 1, format: (v) => `${Math.round(v)}`,
        ends: ['a light press', 'the hardest'] }),
    ];
    const ownBox = h('div.v6e-own', { hidden: true }, own.map((c) => c.el));
    const hint = h('p.v6e-hint', { 'aria-live': 'polite' });
    binder.fn([`${REL()}.velocityCurve`], (s) => {
      const vc = slotOf(s)?.velocityCurve || 'normal';
      ownBox.hidden = vc !== 'custom';
      setText(hint, TOUCH_HINTS[vc] || '');
    });
    return h('div.v6e-touch', {}, resp.el, hint, ownBox);
  }

  // ---- Sustain: the pedal switch + Release (pedal up) / Pedal hold (slot.js sustainRow) ----
  function buildSustain(binder, slot, meta) {
    const box = h('div.v6e-sustain');
    const pedal = binder.ctl(P('sustain'), (onChange) => C.toggle({
      label: 'Sustain pedal holds it', title: 'Notes hold while the sustain pedal is down', onChange,
    }));
    pane.ctl.pedal = pedal;
    box.append(h('div.v6e-row', {}, pedal.el));
    if (!hasParam(P('release')) || !hasParam(P('pedalHold'))) return box;
    const rd = describe(P('release'));
    const own0 = ownRelease(slot, meta) ?? 0.8;
    const ownOf = (s) => ownRelease(slotOf(s), metaOf(slotOf(s))) ?? own0;
    const release = binder.ctl(P('release'), (onChange) => wordSlider({
      label: 'Release (pedal up)', min: rd.min, max: rd.max, curve: 'log', default: own0, ends: ['short', 'long'],
      word: (v) => wordFor('ringout', v, { default: ownOf(ctx.song()) }), format: secs, onChange,
    }), {
      read: (s) => {
        const sl = slotOf(s);
        if (!sl) return undefined;
        return Number.isFinite(sl.release) ? sl.release : ownOf(s);
      },
      write: (v) => ctx.set(P('release'), v === own0 ? null : Math.round(v * 100) / 100),
    });
    const hold = binder.ctl(P('pedalHold'), (onChange) => wordSlider({
      label: 'Pedal hold', min: PEDAL_HOLD_TRACK.min, max: HOLD_TOP, curve: 'log', default: HOLD_TOP,
      ends: ['fades soon', 'natural'],
      word: (v) => (v >= HOLD_NATURAL ? 'Natural' : 'Fades'), format: (v) => (v >= HOLD_NATURAL ? '' : secs(v)),
      onChange,
    }), {
      read: (s) => {
        const sl = slotOf(s);
        if (!sl) return undefined;
        return Number.isFinite(sl.pedalHold) ? sl.pedalHold : HOLD_TOP;
      },
      write: (v) => ctx.set(P('pedalHold'),
        v >= HOLD_NATURAL ? null : Math.min(30, v < 10 ? Math.round(v * 2) / 2 : Math.round(v))),
    });
    release.el.dataset.sustain = 'release';
    hold.el.dataset.sustain = 'pedalHold';
    pane.ctl.release = release;
    pane.ctl.pedalHold = hold;
    const say = h('p.v6e-hint.v6e-sus-say', { 'aria-live': 'polite' });
    binder.fn([`${REL()}.release`, `${REL()}.pedalHold`, `${REL()}.params.release`], (s) => {
      const sl = slotOf(s);
      if (!sl) return;
      const set = Number.isFinite(sl.release);
      const r = set ? sl.release : ownOf(s);
      const a = `Rings ${secs(r)} after you lift the pedal${set ? '' : ' (the instrument’s own)'}.`;
      const natural = sl.instrument.type === 'sampler' ? 'rings to its natural end'
        : 'keeps sounding until you lift it';
      const b = Number.isFinite(sl.pedalHold)
        ? `With the pedal down it fades after ${secs(sl.pedalHold)} (over ${secs(sl.pedalHold / 4)}).`
        : `With the pedal down it ${natural}.`;
      setText(say, `${a} ${b}`);
    });
    box.append(release.el, hold.el, say);
    return box;
  }

  // ---- Space & Echo: the sends (slots.<i>.sends.reverb / delay / chorus; the strip's Space / Echo chips) ----
  function buildSends(binder) {
    const send = (unit, label, ends, word) => binder.ctl(P(`sends.${unit}`), (onChange) => wordSlider({
      label, min: 0, max: 1, default: 0, ends, word, format: (v) => (Number(v) > 0.0005 ? pct(v) : ''), onChange,
    }));
    const spaceWord = (v) => capital(sendWords(v) || 'dry');
    const space = send('reverb', 'Space', ['dry', 'deep'], spaceWord);
    const echo = send('delay', 'Echo', ['none', 'lots'], (v) => capital(sendWords(v) || 'off'));
    const chorus = send('chorus', 'Chorus', ['none', 'lots'], (v) => capital(sendWords(v) || 'off'));
    pane.ctl.space = space;
    pane.ctl.echo = echo;
    pane.ctl.chorus = chorus;
    const what = h('p.v6e-hint.v6e-fxsay');
    binder.fn(['patch.fx.reverb', 'patch.fx.delay'], () => {
      const sp = matchPreset(SPACE_PRESETS, ctx.valueOf);
      const ec = matchPreset(ECHO_PRESETS, ctx.valueOf);
      setText(what, `This song’s Space is ${sp ? sp.name : 'its own'}; its Echo is `
        + `${ec ? (ec.id === 'none' ? 'off' : ec.name) : 'its own'}. Every instrument shares them.`);
    });
    const toFx = h('button.btn.ghost.v6e-link', { type: 'button', text: 'Shape the Space and Echo ▸',
      'data-testid': 'v6e-to-effects' });
    toFx.addEventListener('click', () => ctx.select('effects'));
    return h('div.v6e-sends', {}, space.el, echo.el, chorus.el, what, h('div.v6e-row', {}, toFx));
  }

  // ---- Advanced: pan, width, transpose, voices, pitch bend, the instrument's own settings (slot.js Advanced) ----
  function buildAdvanced(binder, slot, meta) {
    const specs = smartSlidersFor(meta);
    const mapped = new Set(specs.map((s) => s.path.replace('slots.<i>.', '')));
    const row = h('div.v6e-advrow');
    const ws = (addr, o) => binder.ctl(addr, (onChange) => wordSlider({ ...o, onChange }));
    pane.ctl.pan = ws(P('pan'), {
      label: 'Pan', min: -1, max: 1, default: 0, bipolar: true, ends: ['left', 'right'],
      word: (v) => (Math.abs(v) < 0.005 ? 'Center' : v < 0 ? 'Left' : 'Right'),
      format: (v) => (Math.abs(v) < 0.005 ? '' : formatValue(P('pan'), v)),
    });
    row.append(pane.ctl.pan.el);
    if (hasParam(P('width')) && !mapped.has('width')) {
      pane.ctl.width = ws(P('width'), {
        label: 'Width', min: 0, max: 1.5, default: describe(P('width')).default, ends: ['mono', 'wide'],
        word: (v) => wordFor('width', v), format: (v) => (Number(v) < 0.005 ? 'Mono' : pct(v)),
      });
      row.append(pane.ctl.width.el);
    }
    pane.ctl.transpose = binder.ctl(P('transpose'), (onChange) => C.stepper({
      label: 'Transpose', min: -12, max: 12, step: 1, format: semitones, onChange,
    }));
    pane.ctl.voices = binder.ctl(P('mono'), (onChange) => C.select({ label: 'Voices', options: MONO_OPTS, onChange }));
    pane.ctl.bend = binder.ctl(P('bendEnabled'), (onChange) => C.toggle({
      label: 'Pitch bend', title: 'The pitch-bend wheel bends this sound', onChange,
    }));
    const misc = h('div.v6e-row.v6e-advmisc', {}, pane.ctl.transpose.el, pane.ctl.voices.el, pane.ctl.bend.el);
    const params = (meta && Array.isArray(meta.params) ? meta.params : []).filter((p) => p && p.key);
    const mappedKeys = new Set(specs.filter((s) => s.key).map((s) => s.key));
    const grid = h('div.v6e-params');
    const moved = [];
    const readParam = (p) => (s) => {
      const sl = slotOf(s);
      if (!sl) return undefined;
      const v = sl.params ? sl.params[p.key] : undefined;
      return v === undefined ? p.default : v;
    };
    for (const p of params) {
      if (mappedKeys.has(p.key)) {
        moved.push(`${p.label || capital(p.key)} → ${specs.find((s) => s.key === p.key).label}`);
        continue;
      }
      const addr = P(`params.${p.key}`);
      const label = p.label || capital(p.key);
      let c;
      if (p.unit === 'bool' || typeof p.default === 'boolean') {
        c = binder.ctl(addr, (onChange) => C.toggle({ label, onChange }), { read: readParam(p) });
      } else if (p.unit === 'enum' || Array.isArray(p.enum)) {
        const options = (p.enum || []).map((v) => ({ value: v, label: capital(v) }));
        c = binder.ctl(addr, (onChange) => C.select({ label, options, onChange }), { read: readParam(p) });
      } else {
        const min = Number.isFinite(p.min) ? p.min : 0;
        const max = Number.isFinite(p.max) ? p.max : 1;
        c = binder.ctl(addr, (onChange) => wordSlider({
          label, min, max, curve: p.curve === 'log' && min > 0 ? 'log' : 'lin', step: p.step,
          default: typeof p.default === 'number' ? p.default : min, format: (v) => formatInstrumentParam(p, v),
          onChange,
        }), { read: readParam(p) });
      }
      c.el.dataset.param = p.key;
      grid.append(c.el);
    }
    const instBits = [h('b', { text: `${displayName(slot, meta)} settings` })];
    if (params.length) {
      const reset = h('button.btn.ghost.v6e-reset', { type: 'button', text: 'Reset these settings' });
      reset.addEventListener('click', () => {
        for (const p of params) {
          if (p.default !== undefined && p.default !== null) ctx.set(P(`params.${p.key}`), p.default);
        }
      });
      instBits.push(reset);
    }
    const hint = !meta ? 'Instrument details appear once sound has started.'
      : !params.length ? 'This instrument has no extra settings.' : '';
    return h('div.v6e-adv', {},
      row, misc,
      h('div.v6e-row.v6e-insthead', {}, ...instBits),
      hint ? h('p.v6e-hint', { text: hint }) : null,
      moved.length ? h('p.v6e-hint', { text: `In Sound: ${moved.join(' · ')}.` }) : null,
      grid.childElementCount ? grid : null);
  }

  // ---------------------------------------------------------------- "Change instrument ▾" (today's picker)
  let menuOpen = false;
  const menuItems = () => [...menuEl.querySelectorAll('[role^="menuitem"]:not([disabled])')];
  function buildMenu() {
    const slot = curSlot();
    const cur = slot ? refKey(slot.instrument) : '';
    const list = ctx.instruments().filter((it) => {
      const v = refKey(it.ref);
      return (!HIDDEN_IN_PICKER.has(v) && !it.hidden) || v === cur;
    });
    const nodes = [];
    const item = (value, text, checked, title) => h('button.v6e-mi', {
      type: 'button', role: 'menuitemradio', 'aria-checked': String(checked), tabindex: '-1', title,
      dataset: { value },
    }, h('i.v6e-mi-check', { 'aria-hidden': 'true' }), h('span', { text }));
    if (cur && !list.some((it) => refKey(it.ref) === cur)) {
      nodes.push(h('div.v6e-mg', { role: 'group', 'aria-label': 'This song' },
        item(cur, `${slot.instrument.id} (not available)`, true, 'This instrument is not available on this computer')));
    }
    for (const g of groupOrder(list)) {
      const items = list.filter((it) => groupOf(it) === g).map((it) => item(refKey(it.ref), it.name,
        refKey(it.ref) === cur, it.license ? `${it.name} — ${it.license}` : it.name));
      nodes.push(h('div.v6e-mg', { role: 'group', 'aria-label': g },
        h('div.v6e-mg-head', { 'aria-hidden': 'true', text: g }), ...items));
    }
    if (!list.length) nodes.push(h('p.v6e-hint', { text: 'Instruments appear once sound has started.' }));
    if (slot) {
      nodes.push(h('div.v6e-msep', { role: 'separator' }), h('button.v6e-mi.v6e-mi-remove', {
        type: 'button', role: 'menuitem', tabindex: '-1', dataset: { action: 'remove' },
      }, h('i.v6e-mi-check', { 'aria-hidden': 'true' }), h('span', { text: 'Remove this sound…' })));
    }
    menuEl.setAttribute('aria-label', 'Instrument');
    const a = document.activeElement;
    const had = a && menuEl.contains(a) ? { value: a.dataset.value, action: a.dataset.action } : null;
    menuEl.replaceChildren(...nodes);
    if (had) {
      const items = [...menuEl.querySelectorAll('.v6e-mi')];
      const next = items.find((x) => (had.value !== undefined ? x.dataset.value === had.value
        : x.dataset.action === had.action)) || items[0];
      next?.focus();
    }
  }
  function openMenu({ focus = true } = {}) {
    cancelConfirm();
    disarm();
    if (!menuOpen) {
      buildMenu();
      menuEl.hidden = false;
      menuOpen = true;
      chgBtn.setAttribute('aria-expanded', 'true');
      chgBtn.classList.add('open');
      ctx.markDialog(true, 'v6-inst-menu');
    }
    if (focus) {
      const items = menuItems();
      const cur = items.find((b) => b.getAttribute('aria-checked') === 'true');
      (cur || items[0])?.focus({ preventScroll: false });
    }
  }
  function closeMenu(refocus = false) {
    if (!menuOpen) return false;
    menuOpen = false;
    menuEl.hidden = true;
    chgBtn.setAttribute('aria-expanded', 'false');
    chgBtn.classList.remove('open');
    ctx.markDialog(false, 'v6-inst-menu');
    if (refocus) chgBtn.focus();
    else if (menuEl.contains(document.activeElement)) document.activeElement.blur();
    return true;
  }
  chgBtn.addEventListener('click', (e) => {
    if (menuOpen) closeMenu(e.detail === 0);
    else openMenu({ focus: true });
  });
  menuEl.addEventListener('keydown', (e) => {
    const items = menuItems();
    const k = items.indexOf(document.activeElement);
    let n = -1;
    if (e.key === 'ArrowDown') n = (k + 1) % items.length;
    else if (e.key === 'ArrowUp') n = (k - 1 + items.length) % items.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = items.length - 1;
    else if (e.key === 'Tab') {
      closeMenu(false);
      return;
    }
    if (n < 0 || !items.length) return;
    e.preventDefault();
    e.stopPropagation();
    items[n].focus();
  });
  menuEl.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.v6e-mi');
    if (!b || !menuEl.contains(b)) return;
    if (b.dataset.action === 'remove') {
      closeMenu(false);
      askRemove();
      return;
    }
    closeMenu(e.detail === 0);
    pickInstrument(b.dataset.value);
  });

  /** Fill an empty slot (defaultSlot) or swap the instrument, with today's 8 s Undo (slot.js pickInstrument). */
  function pickInstrument(value) {
    const s = ctx.song();
    if (!s || !value) return;
    const k = value.indexOf(':');
    const ref = { type: value.slice(0, k), id: value.slice(k + 1) };
    const slot = slotOf(s);
    undo = null;
    if (!slot) ctx.set(`slots.${i}`, defaultSlot(i, ref));
    else if (refKey(slot.instrument) !== value) {
      const captured = {
        songId: s.id, i, to: value, name: displayName(slot, metaOf(slot)),
        instrument: JSON.parse(JSON.stringify(slot.instrument)), params: JSON.parse(JSON.stringify(slot.params || {})),
      };
      if (!ctx.set(P('instrument'), ref)) return;
      followSlot(ctx.store, captured); // R3 (as slot.js, D23): the record follows its instrument through a move
      const next = slotOf(ctx.store.getSong?.(s.id) || ctx.song());
      const toName = next ? displayName(next, metaOf(next)) : ref.id;
      ctx.toast(`${toName} replaces ${captured.name}.`, 'info', {
        ms: UNDO_MS, action: { label: 'Undo', run: () => undoInstrument(captured) },
      });
    }
  }
  function undoInstrument(u) {
    if (u && u.i < 0) { // R3: that instrument was removed since (followSlot)
      ctx.toast('That sound is no longer in this song, so there is nothing to undo.', 'info');
      return false;
    }
    const song = u && ctx.store.get().songs[u.songId];
    const cur = song && song.patch.slots[u.i];
    if (!cur || refKey(cur.instrument) !== u.to) {
      ctx.toast('That instrument has changed since, so there is nothing to undo.', 'info');
      return false;
    }
    const restored = { ...JSON.parse(JSON.stringify(cur)), instrument: u.instrument, params: u.params };
    return ctx.set(`songs.${u.songId}.patch.slots.${u.i}`, restored);
  }

  // ---- Remove this sound… (confirm → Undo; slot.js) ----
  let confirming = false;
  /** @type {{songId:string, i:number, slot:object, name:string}|null} */
  let undo = null;
  function askRemove() {
    const slot = curSlot();
    if (!slot) return;
    const name = displayName(slot, metaOf(slot));
    confirming = true;
    const cancel = h('button.btn.v6e-cancel', { type: 'button', text: 'Cancel' });
    const yes = h('button.btn.warn.v6e-remove', { type: 'button', text: 'Remove' });
    cancel.addEventListener('click', () => cancelConfirm(true));
    yes.addEventListener('click', () => doRemove());
    confirmEl.replaceChildren(h('span', {
      text: `Remove ${name}? Its place stays, silent, until you pick a sound.`,
    }), h('span.v6e-sp'), yes, cancel);
    confirmEl.hidden = false;
    ctx.markDialog(true, 'v6-inst-confirm');
    cancel.focus();
  }
  function cancelConfirm(refocus = false) {
    if (!confirming) return false;
    confirming = false;
    confirmEl.hidden = true;
    confirmEl.replaceChildren();
    ctx.markDialog(false, 'v6-inst-confirm');
    if (refocus) chgBtn.focus();
    return true;
  }
  function doRemove() {
    const s = ctx.song();
    const slot = slotOf(s);
    cancelConfirm(false);
    if (!slot) return;
    const name = displayName(slot, metaOf(slot));
    const captured = { songId: s.id, i, slot: JSON.parse(JSON.stringify(slot)), name };
    if (!ctx.set(`slots.${i}`, null)) return;
    undo = captured;
    followSlot(ctx.store, captured); // R3: the empty place's Undo follows it through a move
    renderEmptyUndo();
    ctx.toast(`${name} removed.`, 'info', { ms: UNDO_MS, action: { label: 'Undo', run: () => doUndo(captured) } });
  }
  function doUndo(u = undo) {
    if (!u) return false;
    const song = ctx.store.get().songs[u.songId];
    if (!song) return false;
    if (u.i < 0) { // R3 (as slot.js): that (empty) place was removed since (followSlot)
      if (undo === u) undo = null;
      renderEmptyUndo();
      return false;
    }
    if (song.patch.slots[u.i]) {
      ctx.toast('That place has a sound again, so there is nothing to undo.', 'info');
      if (undo === u) undo = null;
      renderEmptyUndo();
      return false;
    }
    const ok = ctx.set(`songs.${u.songId}.patch.slots.${u.i}`, u.slot);
    if (undo === u) undo = null;
    renderEmptyUndo();
    return ok;
  }
  function renderEmptyUndo() {
    const line = pane && pane.ctl.undoLine;
    if (!line) return;
    const show = !!(undo && undo.i === i && undo.songId === ctx.songId() && !curSlot());
    line.hidden = !show;
    if (!show) {
      line.replaceChildren();
      return;
    }
    const b = h('button.btn.ghost.v6e-undo-btn', { type: 'button', text: 'Undo' });
    b.addEventListener('click', () => doUndo());
    line.replaceChildren(h('span', { text: `${undo.name} was removed. ` }), b);
  }

  // ---------------------------------------------------------------- sentence, nav, paint
  let sentKey = '';
  const KEY_CAT = { range: 'range', octave: 'range', reverb: 'sends', sustain: 'sustain' };
  function onToken(part) {
    if (part.key === 'instrument') {
      openMenu({ focus: true });
      return;
    }
    if (part.key === 'muted') {
      const t = strip?.el.querySelector('.ontile');
      t?.focus({ preventScroll: true });
      flash(t);
      return;
    }
    const c = KEY_CAT[part.key];
    if (!c) return;
    choose(c);
    const target = part.key === 'octave' ? pane?.ctl.octave?.el : part.key === 'reverb' ? pane?.ctl.space?.el
      : part.key === 'sustain' ? pane?.ctl.pedal?.el : paneHost.firstElementChild;
    focusIn(target);
  }
  let flashTimer = 0;
  function flash(el) {
    if (!(el instanceof Element)) return;
    for (const x of root.querySelectorAll('.v6e-flash')) x.classList.remove('v6e-flash');
    el.classList.add('v6e-flash');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove('v6e-flash'), 900);
  }
  function focusIn(el) {
    if (!(el instanceof Element)) return;
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    const f = el.matches(FOCUSABLE) ? el : el.querySelector(FOCUSABLE);
    f?.focus({ preventScroll: true });
    flash(el);
  }
  function renderSentence(force = false) {
    const s = ctx.song();
    const slot = slotOf(s);
    const meta = metaOf(slot);
    const sp = s ? matchPreset(SPACE_PRESETS, ctx.valueOf) : null;
    const parts = v6SentenceParts(slot, meta, {
      name: slot ? displayName(slot, meta) : undefined, spaceName: spaceNoun(s ? sp : null),
      isChanged: (f) => isChangedRel(f),
    });
    setText(chgBtn.firstChild, slot ? 'Change instrument' : 'Choose a sound');
    const key = JSON.stringify(parts);
    if (!force && key === sentKey) return;
    sentKey = key;
    const sent = sentence(parts.map((p) => (p && typeof p === 'object' && p.key ? { ...p, control: () => null } : p)),
      { onToken });
    const first = sent.querySelector('.ev2-tok');
    if (first && parts[0] && parts[0].name) first.classList.add('v6e-sn');
    sentHost.replaceChildren(sent);
    sentHost.title = silent() && slot ? 'Silent here: it plays on the 2.0 engine' : '';
  }
  function renderNav() {
    const slot = curSlot();
    const meta = metaOf(slot);
    for (const c of CATEGORIES) {
      const r = navRecs.get(c.id);
      const sel = c.id === cat;
      r.el.setAttribute('aria-selected', String(sel));
      r.el.classList.toggle('on', sel);
      r.el.tabIndex = sel ? 0 : -1;
      r.el.disabled = !slot;
      setText(r.sum, slot ? categorySummary(c.id, slot, meta, i) : '');
      r.dot.hidden = !slot || !c.dot.some((f) => isChangedRel(f));
    }
    const orient = navIsRow() ? 'horizontal' : 'vertical';
    if (nav.getAttribute('aria-orientation') !== orient) nav.setAttribute('aria-orientation', orient);
  }
  /** iPad portrait: the list is a row of tabs (styles-v6-edit.css, the same query; no layout read). */
  function navIsRow() {
    return !!portraitMq?.matches;
  }
  /**
   * skeptic UI6-U5a F2: the chosen category stays in sight (D18 "always visible what is being edited"). At 1024 × 700
   * the list had 308 px for 349 px of rows, so a remembered Advanced sat below its fold. Scrolls the list only (never
   * the page); run when the category changes and when Edit shows again, not on every store event (a layout read).
   */
  function revealCat() {
    const el = navRecs.get(cat)?.el;
    if (!el || !nav.clientHeight || navIsRow()) return;
    const top = el.getBoundingClientRect().top - nav.getBoundingClientRect().top + nav.scrollTop;
    if (top < nav.scrollTop) nav.scrollTop = top;
    else if (top + el.offsetHeight > nav.scrollTop + nav.clientHeight) {
      nav.scrollTop = top + el.offsetHeight - nav.clientHeight;
    }
  }
  function paint() {
    root.dataset.slot = String(i);
    root.style.setProperty('--c', slotColor(i));
  }

  // ---------------------------------------------------------------- wiring
  // registered before any pane binder, so a rebuild replaces the binder before the old one's subscription runs
  // While Perform shows, nothing here is drawn (the strip is gone, see editShown): the store events only mark the
  // panel stale, and the first event with the view back on Edit (the 'settings.view' write itself) redraws it all.
  let stale = false;
  ctx.subscribe((e) => {
    if (!editShown()) {
      stale = true;
      dropStrip();
      return;
    }
    if (stale) {
      stale = false;
      renderSentence(true);
      queueMicrotask(revealCat); // after this event's redraw, with the view laid out again
    }
    const slot = slotOf(e.song);
    const key = `${cat}|${slotKey(slot)}|${i}`;
    if (key !== paneKey) buildPane();
    renderEmptyUndo();
    renderSentence();
    renderNav();
    renderStrip();
    pane?.renderKb?.(); // the bar's changed dot follows the baseline too
  });
  ctx.listen(ctx.editState, 'changes', () => {
    if (!editShown()) {
      stale = true;
      return;
    }
    renderSentence();
    renderNav();
    renderStrip();
    pane?.renderKb?.();
  });
  ctx.listen(ctx.editState, 'instruments', () => {
    if (`${cat}|${slotKey(curSlot())}|${i}` !== paneKey) buildPane();
    renderSentence(true);
    renderNav();
    renderStrip();
    if (menuOpen) buildMenu();
  });
  ctx.listen(ctx.editState, 'notes', onNotes);
  ctx.onLeaveSong(() => {
    leavingSong = true;
    queueMicrotask(() => {
      leavingSong = false;
    });
    closeMenu(false);
    cancelConfirm(false);
    disarm();
    pane?.ctl.kb?.cancelDrag();
    strip?.cancelDrag();
    strip?.closePanels();
  });
  ctx.onLeaveView?.(() => {
    closeMenu(false);
    pane?.ctl.kb?.cancelDrag();
    dropStrip();
  });
  // UI6-U5a review R3 (as the v6 Perform, D23): a move, insert or remove of the shown song's slots (store.onSlotMap,
  // synchronous in the write) re-orders what each index holds. A range drag follows its instrument (remapDrag: its
  // restore goes there, or nowhere when it was removed), then ends, with the strip's fader drag and chip panels, after
  // the store's change notification (no store write from inside the store's own call). The selected tab follows the
  // instrument in edit.js, which then calls update() with the new index.
  const offSlotMap = typeof ctx.store?.onSlotMap === 'function'
    ? ctx.store.onSlotMap(({ id, order }) => {
      if (id !== ctx.songId()) return;
      pane?.ctl.kb?.remapDrag?.(order);
      strip?.cancelDrag();
      strip?.closePanels();
      queueMicrotask(() => pane?.ctl.kb?.cancelDrag());
    })
    : () => {};
  ctx.onEscape(() => {
    if (cancelConfirm(true)) return true;
    if (closeMenu(true)) return true;
    return disarm();
  });
  ctx.listen(document, 'pointerdown', (e) => {
    const t = e.target;
    if (menuOpen && !actions.contains(t)) closeMenu(false);
    if (armed && !(t.closest && (t.closest('.v6e-arm') || t.closest('.ev2-bottom') || t.closest('[data-note]')))) {
      disarm();
    }
  }, true);

  function applyFocus(focus) {
    if (focus === 'instrument') openMenu({ focus: true });
    else if (focus === 'range') {
      if (!curSlot()) openMenu({ focus: true });
      else {
        choose('range');
        focusIn(paneHost.firstElementChild);
      }
    }
  }

  paint();
  makeStrip();
  buildPane();
  renderSentence(true);
  renderNav();
  renderStrip();
  applyFocus(opts.focus);
  queueMicrotask(revealCat); // the panel is in the document (and laid out) once the shell has placed it

  return {
    /** Re-render the strip (a refused mute write puts its tile back). */
    refresh: () => renderStrip(),
    update(next = {}) {
      const ni = Math.max(0, Math.round(Number(next.slot) || 0));
      if (ni !== i) {
        closeMenu(false);
        cancelConfirm(false);
        disarm();
        // UI6-U5a review R1: drop a range / fader drag while `i` still names its instrument, so the live-written
        // range's restore (keyboard.js 'cancel') goes to that instrument and is not refused as another one's
        pane?.ctl.kb?.cancelDrag();
        strip?.cancelDrag();
        i = ni;
        paint();
        makeStrip();
        buildPane();
      }
      renderSentence(true);
      renderNav();
      renderStrip();
      applyFocus(next.focus);
    },
    destroy() {
      offSlotMap();
      clearTimeout(flashTimer);
      closeMenu(false);
      cancelConfirm(false);
      destroyPane();
      strip?.destroy();
      strip = null;
      root.remove();
    },
    /** Test hooks. */
    _debug: {
      slot: () => i,
      cat: () => cat,
      choose: (id) => choose(id, { persist: true }),
      tone: () => ({ mounted: !!toneEq, ...toneStats }),
      strip: () => strip,
      kb: () => pane?.ctl.kb || null,
    },
  };
}
