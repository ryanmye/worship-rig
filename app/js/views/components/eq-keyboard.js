// Keyboard EQ ("Tone EQ"): a WING-style parametric EQ drawn over a pitch-true 88-key axis (design/eq/DECISION.md,
// overridden by design/eq/AMENDMENT.md; ported from the design/eq/curve prototype).
//
//   eqKeyboard({ store, engine, slotIndex, onChange, controller?, compact?, toast? }) → { el, update(), setSlot(i),
//     destroy(), debug() }
//
// • Up to 8 bands (b1..b8) + a dedicated low cut and high cut. Double-tap/double-click empty graph space adds a PEQ at
//   that key (0 dB, Q 1); drag a node off the bottom, press Delete/Backspace, or the row's ✕ to remove it. Each band
//   has a type (PEQ, low/high shelf, notch, low/high cut) and an on/off switch (row toggle, long-press on the node).
// • Big numbered nodes (≥ 40 px hit target), Q "wings" on the selected node (drag them, pinch, wheel over the node or
//   ctrl/alt+wheel anywhere), drag = note × gain with a 4 px per-axis deadzone, snap to keys (ISO thirds outside
//   A0–C8), ⌥ = no snap, ⇧ = fine, double-click a node = 0 dB.
// • Greyed zones from engine.getSlotPlayRange (feature-detected; else the slot's split/octave/transpose + song
//   transpose): hatched "no notes" below the lowest sounding note, a light "tone (overtones)" tint above the top one.
// • Curve from engine.getEqResponse when present (it is what you hear), else computed here (shared/eq-math.js RBJ).
// • A/B: controller.eqAudition / engine.eqAudition when present (not persisted); otherwise a store compare that
//   switches the bands off and restores them (M.bypassWrites), restored on A, on any edit, on setSlot and on destroy.
// • Every write goes through store.set('slots.<i>.eq.<key>', v) with the AMENDMENT keys (b<k>.on/type/hz/db/q,
//   cutHz, hiCutHz); M.writesFor() computes the minimal set, and migrates legacy eq.low/eq.high on the first edit.
// Engine calls (getEqResponse, getSlotPlayRange, slotAnalysers, eqAudition, auditionNote) go through the
// controller's pass-through when it has one, else the engine (CLAUDE.md: views never call the engine), all
// feature-detected; the master analyser engine.analyserL/R and engine.ctx are read directly.
// See CONTRACT_CHANGES "## eq-ui".
import { h, disposer } from './util.js';
import * as M from '../../shared/eq-math.js';
import { ROLE_DEFAULTS } from '../../shared/params.js';

const SLOT_HEX = ['#ff8a3d', '#3ddc84', '#4aa8ff', '#b784ff'];
const SLOT_INK = ['#1f0e00', '#002010', '#001a33', '#1a0a33'];
const CUT_BLUE = '#7cc4ff';
const DB_RANGE = 15;
const DEADZONE = 4;
const LONG_PRESS_MS = 550;
const DOUBLE_MS = 400;
const CUT_Y_DB = -10;
/** How long the curve waits for engine.getEqResponse to catch up with an edit (see recomputeCurve). */
const ENGINE_WAIT_MS = 3000;

/**
 * Mount the keyboard EQ for one slot of the current song.
 * @param {object} o
 * @param {object} o.store         createStore() instance (reads currentSong(), writes set('slots.<i>.eq.<key>'))
 * @param {object} [o.engine]      AudioEngine: optional getEqResponse / getSlotPlayRange / slotAnalysers /
 *                                 eqAudition / auditionNote / analyserL/R / ctx / listInstruments
 * @param {number} o.slotIndex     0..3
 * @param {(e:{slotIndex:number, writes:[string, any][], why:string}) => void} [o.onChange]
 * @param {object} [o.controller]  optional: eqAudition(i, mode) / auditionNote(i, midi) take precedence
 * @param {boolean} [o.compact]    force the compact layout (auto below 1180 px wide)
 * @param {(msg:string) => void} [o.toast] app toast; default = the component's own
 * @param {boolean} [o.rta=true] draw the analyser behind the curve
 * @returns {{el:HTMLElement, update():void, setSlot(i:number):void, destroy():void, debug():object}}
 */
export function eqKeyboard(o = {}) {
  const { store, engine = null, controller = null, onChange = null } = o;
  if (!store || typeof store.set !== 'function') throw new TypeError('eqKeyboard: store is required');
  let slotIndex = Number(o.slotIndex) || 0;
  const d = disposer();
  let destroyed = false;

  // ------------------------------------------------------------------------------------------------ state
  let model = M.readEq(undefined);
  let zone = M.soundingRange({});
  let sel = null; // band k, 'lc', 'hc' or null
  let eqSig = '';
  let zoneSig = '';
  let ab = 'a';
  let abState = null; // store-mode compare: {songId, slot, restore:[key, v][], snapEq}
  /** controller pass-through when it has one (views never call the engine, CLAUDE.md), else the engine, else null */
  const via = (name) => (typeof controller?.[name] === 'function' ? controller
    : typeof engine?.[name] === 'function' ? engine : null);
  const abMode = via('eqAudition') === controller && controller ? 'controller' : via('eqAudition') ? 'engine' : 'store';
  let drag = null;
  let pinch = null;
  const pointers = new Map();
  let lastTap = null;
  let lastDouble = 0; // when the pointer path last handled a double tap (the native dblclick then stands down)
  let hover = null;
  let hoverHit = null;
  let pressedKey = null;
  let dirty = true;
  let dirtyKeys = true;
  let engineCurveUntil = 0;
  let enginePending = false;
  let curve = { xs: [], db: new Float64Array(0), source: 'local' };
  let curveMismatch = 0;
  let warnedMismatch = false;
  let raf = 0;
  let slotAn = null; // {pre, post, release}
  let slotAnTried = -1;

  // ------------------------------------------------------------------------------------------------ DOM
  const presetBtns = Object.keys(M.EQ_PRESETS).map((name) =>
    h('button', { type: 'button', class: 'eqk-preset', dataset: { preset: name }, text: name }));
  const abA = h('button', { type: 'button', class: 'eqk-ab-a', 'aria-pressed': 'true', text: 'A · EQ on' });
  const abB = h('button', { type: 'button', class: 'eqk-ab-b', 'aria-pressed': 'false', text: 'B · Bypass' });
  const summary = h('div.eqk-summary');
  const plot = h('canvas.eqk-plot', {
    tabindex: '0', role: 'application',
    'aria-label': 'EQ curve over a piano keyboard. Arrow keys move the selected band, [ and ] change its width, ' +
      '1 to 8 pick a band, Insert adds one, Delete removes it, B compares.',
  });
  const kb = h('canvas.eqk-kb', { 'aria-label': 'Piano keyboard: the keys this slot plays are lit' });
  const readout = h('div.eqk-readout', { 'aria-hidden': 'true' });
  const toastEl = h('div.eqk-toast', { role: 'status' });
  const live = h('div.eqk-sr', { 'aria-live': 'polite' });
  const graph = h('div.eqk-graph', {}, plot, kb, readout, toastEl);
  const tbody = h('tbody');
  const addBtn = h('button', { type: 'button', class: 'eqk-add', text: '+ Add band' });
  const addHint = h('span.eqk-hint', { text: 'or double-tap the graph' });
  const table = h('table.eqk-bands', {},
    h('colgroup', {}, ...['n', 't', 'note', 'hz', 'db', 'q', 'acts', 'on', 'x'].map((c) => h(`col.c-${c}`))),
    h('thead', {}, h('tr', {},
      ...['', 'Band', 'Note', 'Hz', 'dB', 'Q', 'Acts on', 'On', ''].map((t) => h('th', { text: t })))),
    tbody,
    h('tfoot', {}, h('tr', {}, h('td', { colspan: '9' }, addBtn, addHint))));
  const cutIn = h('input', { type: 'text', class: 'eqk-cut-hz', 'aria-label': 'Low cut Hz', dataset: { cut: 'lc' } });
  const hiCutIn = h('input', {
    type: 'text', class: 'eqk-hicut-hz', 'aria-label': 'High cut Hz', dataset: { cut: 'hc' },
  });
  const cutOn = h('button', { type: 'button', class: 'eqk-onoff eqk-cut-on', 'aria-label': 'Low cut on' });
  const hiCutOn = h('button', { type: 'button', class: 'eqk-onoff eqk-hicut-on', 'aria-label': 'High cut on' });
  const copyBtn = h('button', { type: 'button', class: 'eqk-btn eqk-copy', text: 'Copy as text',
    title: 'Copy the bands as EqualizerAPO/REW lines' });
  const copied = h('span.eqk-copied');
  const pasteTa = h('textarea', { class: 'eqk-paste-text', rows: '4', spellcheck: 'false',
    placeholder: 'Filter 1: ON PK Fc 250 Hz Gain -3 dB Q 1.4\nLSC 120 Hz +2 dB · HP 80 Hz · notch 60 Hz Q 10' });
  const pasteBtn = h('button', { type: 'button', class: 'eqk-btn eqk-paste-apply', text: 'Replace this EQ' });
  const pasteOut = h('ul.eqk-paste-out');
  const paste = h('details.eqk-paste', {},
    h('summary', { text: 'Bring an EQ over (paste)' }),
    h('div.eqk-paste-body', {}, pasteTa, h('div.eqk-row', {}, pasteBtn,
      h('span.eqk-hint', { text: 'EqualizerAPO / REW lines, one per band' })), pasteOut));
  const side = h('aside.eqk-side', {},
    h('div.eqk-cuts', {},
      h('label.eqk-cut', {}, h('span', { text: 'Low cut' }), cutIn, cutOn),
      h('label.eqk-cut', {}, h('span', { text: 'High cut' }), hiCutIn, hiCutOn)),
    h('div.eqk-legend', {},
      h('span', {}, h('i.eqk-lg-curve'), 'EQ curve (±15 dB)'),
      h('span', {}, h('i.eqk-lg-hear'), 'What you hear (analyser)'),
      h('span', {}, h('i.eqk-lg-none'), 'No notes · ', h('i.eqk-lg-over'), 'Overtones')),
    h('div.eqk-row', {}, copyBtn, copied),
    paste);
  const el = h('section.eqk', { 'aria-label': 'Tone EQ' },
    h('div.eqk-head', {},
      h('span.eqk-title', { text: 'Tone EQ' }),
      summary,
      h('span.eqk-sp'),
      h('span.eqk-seg-label', { text: 'Start from' }),
      h('div.eqk-seg.eqk-presets', {}, ...presetBtns),
      h('div.eqk-seg.eqk-ab', { title: 'A/B compare (B key)' }, abA, abB)),
    graph,
    h('div.eqk-lower', {}, h('div.eqk-table-wrap', {}, table), side),
    live);
  if (o.compact) el.dataset.compact = 'forced';

  const g2 = plot.getContext('2d');
  const k2 = kb.getContext('2d');
  const G = { L: 44, R: 12, T: 14, RULER: 22, w: 0, h: 0, kh: 0, dpr: 1, font: 'sans-serif', r: 17, hit: 22 };

  // ------------------------------------------------------------------------------------------------ store access
  const song = () => (typeof store.currentSong === 'function' ? store.currentSong() : null);
  const slotNow = () => song()?.patch?.slots?.[slotIndex] || null;
  const color = () => SLOT_HEX[slotIndex] || SLOT_HEX[0];
  const ink = () => SLOT_INK[slotIndex] || SLOT_INK[0];
  const slotName = () => ROLE_DEFAULTS[slotIndex]?.name || `Slot ${slotIndex + 1}`;
  const fs = () => engine?.ctx?.sampleRate || 48000;

  function instLabel(slot) {
    const ref = slot?.instrument;
    if (!ref) return 'nothing';
    let name = null;
    try {
      const e = engine?.listInstruments?.().find((x) => x.ref?.type === ref.type && x.ref?.id === ref.id);
      name = e?.name || null;
    } catch {
      name = null;
    }
    return String(name || ref.id).replace(/\s*\([^)]*\)\s*$/, '');
  }

  /** Sounding range: engine.getSlotPlayRange when it exists (and answers), else the slot's own fields. */
  function computeZone(slot) {
    const s = song();
    let songT = 0;
    try {
      songT = s && typeof store.transposeSemisOf === 'function' ? Number(store.transposeSemisOf(s)) || 0 : 0;
    } catch {
      songT = 0;
    }
    const fb = M.soundingRange(slot || {}, { songTranspose: songT });
    const pr = via('getSlotPlayRange');
    if (!pr || !slot) return { ...fb, source: 'slot' };
    let r = null;
    try {
      r = pr.getSlotPlayRange(slotIndex);
    } catch {
      r = null;
    }
    if (!r || !Number.isFinite(r.lowNote) || !Number.isFinite(r.highNote)) return { ...fb, source: 'slot' };
    const shift = Number.isFinite(r.transpose) ? r.transpose : fb.shift;
    // the engine knows the split and the instrument; the 88-key controller clamp is ours (DECISION §5 `ctrl`)
    const lo = Math.max(r.lowNote, M.MIDI_LO + shift);
    const hi = Math.max(lo, Math.min(r.highNote, M.MIDI_HI + shift));
    // "stretched" = sounding but outside the real samples (the sampler repitches its nearest one, DECISION §7)
    const instRange = Array.isArray(r.instrumentRange) ? r.instrumentRange
      : Number.isFinite(r.sampledLow) && Number.isFinite(r.sampledHigh) ? [r.sampledLow, r.sampledHigh] : null;
    const z = M.zoneOf(lo, hi, { shift, instRange, why: fb.why });
    if (instRange && lo === instRange[0] && lo > fb.lo) z.why = { ...z.why, lo: 'instrument' };
    if (instRange && hi === instRange[1] && hi < fb.hi) z.why = { ...z.why, hi: 'instrument' };
    return { ...z, source: 'engine' };
  }

  // ------------------------------------------------------------------------------------------------ writes
  const bandByK = (k) => model.bands.find((b) => b.k === k) || null;
  const targetOf = (bands, cuts = {}) => ({
    bands, cutHz: cuts.cutHz ?? model.cutHz, hiCutHz: cuts.hiCutHz ?? model.hiCutHz,
  });

  /**
   * Write `target` (writesFor) to the store. Edits always land on the real EQ, so B is left first.
   * @returns {boolean} something was written
   */
  function commit(target, why) {
    if (ab === 'b') setAB('a', { quiet: true });
    const slot = slotNow();
    if (!slot) return false;
    const writes = M.writesFor(slot.eq, target);
    if (!writes.length) return false;
    for (const [key, v] of writes) store.set(`slots.${slotIndex}.eq.${key}`, v);
    refresh();
    if (typeof onChange === 'function') {
      try {
        onChange({ slotIndex, writes, why });
      } catch (err) {
        console.warn('[eq] onChange failed', err);
      }
    }
    return true;
  }
  const setBand = (k, patch, why = 'edit') =>
    commit(targetOf(model.bands.map((b) => (b.k === k ? { ...b, ...patch } : b))), why);

  function addBand(hz) {
    const k = M.freeBand(model);
    if (k === null) {
      say(`${M.MAX_BANDS} bands is the most a slot has · remove one first`);
      return null;
    }
    const b = { k, on: true, type: 'peak', hz: M.clamp(hz, M.F_MIN, M.F_MAX), db: 0, q: 1 };
    sel = k;
    commit(targetOf([...model.bands, b]), 'add');
    say(`Band ${k} added at ${M.noteLabel(b.hz)}`);
    focusPlot();
    return k;
  }
  function removeBand(k) {
    if (!bandByK(k)) return;
    const rest = model.bands.filter((b) => b.k !== k);
    commit(targetOf(rest), 'remove');
    if (sel === k) sel = rest.length ? rest.reduce((a, b) => (Math.abs(b.k - k) < Math.abs(a.k - k) ? b : a)).k : null;
    say(`Band ${k} removed`);
    refresh(true);
  }
  function setType(k, type) {
    const b = bandByK(k);
    if (!b || b.type === type) return;
    const patch = { type };
    const cut = (t) => t === 'lowcut' || t === 'highcut';
    if (cut(type) && !cut(b.type)) patch.q = M.CUT_Q;
    else if (type === 'notch' && b.q < 2) patch.q = 8;
    else if (type === 'peak' && (cut(b.type) || b.type === 'notch')) patch.q = 1;
    setBand(k, patch, 'type');
  }
  const setCuts = (cuts, why = 'cut') => commit(targetOf(model.bands, cuts), why);

  // ------------------------------------------------------------------------------------------------ A/B
  function setAB(next, { quiet = false } = {}) {
    if (next === ab) return;
    if (abMode === 'controller' || abMode === 'engine') {
      try {
        const target = abMode === 'controller' ? controller : engine;
        target.eqAudition(slotIndex, next === 'b' ? 'bypass' : 'on');
      } catch (err) {
        console.warn('[eq] eqAudition failed', err);
      }
      ab = next;
    } else if (next === 'b') {
      const s = song();
      const slot = slotNow();
      if (!s || !slot) return;
      const snapEq = slot.eq ? JSON.parse(JSON.stringify(slot.eq)) : {};
      const { off, restore } = M.bypassWrites(slot.eq);
      abState = { songId: s.id, slot: slotIndex, restore, snapEq };
      ab = 'b';
      for (const [key, v] of off) store.set(`slots.${slotIndex}.eq.${key}`, v);
    } else {
      restoreAB();
    }
    for (const b of [abA, abB]) b.setAttribute('aria-pressed', String((b === abB) === (ab === 'b')));
    el.classList.toggle('eqk-bypassed', ab === 'b');
    if (!quiet) say(ab === 'b' ? 'B · bypass: the dry sound' : 'A · EQ on');
    refresh(true);
  }
  /** Store-mode compare: put back exactly what B switched off (to the song it was taken from). */
  function restoreAB() {
    const st = abState;
    abState = null;
    ab = 'a';
    if (!st) return;
    const s = song();
    for (const [key, v] of st.restore) {
      const path = s && s.id === st.songId ? `slots.${st.slot}.eq.${key}`
        : `songs.${st.songId}.patch.slots.${st.slot}.eq.${key}`;
      store.set(path, v);
    }
  }
  function leaveAB() {
    if (ab !== 'b') return;
    if (abMode === 'store') restoreAB();
    else {
      try {
        (abMode === 'controller' ? controller : engine).eqAudition(slotIndex, 'on');
      } catch {
        /* engine gone */
      }
    }
    ab = 'a';
    for (const b of [abA, abB]) b.setAttribute('aria-pressed', String(b === abA));
    el.classList.remove('eqk-bypassed');
  }

  // ------------------------------------------------------------------------------------------------ refresh
  /** Re-read the store; `force` re-syncs the DOM even when nothing changed. */
  function refresh(force = false) {
    if (destroyed) return;
    const slot = slotNow();
    const eqSrc = ab === 'b' && abState ? abState.snapEq : slot?.eq;
    const sig = JSON.stringify(eqSrc ?? null) + (slot ? '' : '∅');
    const z = computeZone(slot);
    const zs = `${z.lo}|${z.hi}|${z.source}|${slot?.instrument?.id}|${z.stretched.join(';')}`;
    if (!force && sig === eqSig && zs === zoneSig) return;
    eqSig = sig;
    zoneSig = zs;
    model = M.readEq(eqSrc);
    zone = z;
    if (typeof sel === 'number' && !bandByK(sel)) sel = null;
    el.style.setProperty('--eqk-c', color());
    el.style.setProperty('--eqk-ink', ink());
    el.classList.toggle('eqk-empty', !slot);
    syncSummary(slot);
    syncTable();
    syncCuts();
    dirty = dirtyKeys = true;
    engineCurveUntil = performance.now() + ENGINE_WAIT_MS;
    recomputeCurve();
  }

  function syncSummary(slot) {
    summary.textContent = '';
    if (!slot) {
      summary.append(h('span.eqk-big', {}, h('b', { text: slotName() }), ' is empty · pick a sound first'));
      return;
    }
    const nm = M.noteName;
    summary.append(
      h('span.eqk-big', {}, h('b', { text: slotName() }), ' plays ', h('b', { text: instLabel(slot) }), ' from ',
        h('b', { text: nm(zone.lo) }), ' to ', h('b', { text: nm(zone.hi) })),
      h('span.eqk-hz', { text: ` (${M.fmtHz(M.midiF(zone.lo))} – ${M.fmtHz(M.midiF(zone.hi))})` }),
      h('span.eqk-state', { text: ` · ${M.eqSummary(ab === 'b' && abState ? abState.snapEq : slot.eq)}` }));
  }

  // ------------------------------------------------------------------------------------------------ table
  const isCompact = () => !!el.dataset.compact;
  const noteCell = (f) => (isCompact() ? M.noteLabel(f).split(' · ')[0] : M.noteLabel(f));
  const rowSig = () => model.bands.map((b) => b.k).join(',');
  let builtSig = null;

  function syncTable() {
    const sigNow = rowSig();
    if (sigNow !== builtSig) buildRows();
    for (const tr of tbody.rows) syncRow(tr);
    addBtn.disabled = model.bands.length >= M.MAX_BANDS || ab === 'b';
    addHint.textContent = model.bands.length >= M.MAX_BANDS ? `${M.MAX_BANDS} bands: remove one to add`
      : 'or double-tap the graph';
  }

  function buildRows() {
    const a = document.activeElement;
    const keep = a && tbody.contains(a) ? { k: a.closest('tr')?.dataset.k, f: a.dataset.f } : null;
    tbody.textContent = '';
    for (const b of model.bands) tbody.append(makeRow(b.k));
    builtSig = rowSig();
    if (keep) tbody.querySelector(`tr[data-k="${keep.k}"] [data-f="${keep.f}"]`)?.focus();
  }

  function makeRow(k) {
    const cell = (f, label, title) => {
      const inp = h('input', {
        type: 'text', class: `eqk-${f}`, dataset: { f }, 'aria-label': `Band ${k} ${label}`, title,
      });
      d.listen(inp, 'focus', () => {
        selectBand(k, { focus: false });
        inp.select();
      });
      d.listen(inp, 'change', () => onCell(k, f, inp));
      d.listen(inp, 'keydown', (e) => {
        // Enter on an unchanged cell must not re-parse its display text (review: "≈B3 +21¢ · 250 Hz" → B3)
        if (e.key === 'Enter') {
          if (inp.value !== inp.defaultValue) onCell(k, f, inp);
          inp.blur();
        } else if (e.key === 'Escape') {
          inp.value = inp.defaultValue;
          inp.classList.remove('bad');
          inp.blur();
        }
      });
      return inp;
    };
    const typeSel = h('select', { class: 'eqk-type', dataset: { f: 'type' }, 'aria-label': `Band ${k} type` },
      ...M.MENU_TYPES.map((t) => h('option', { value: t, text: M.TYPE_LABEL[t] })));
    d.listen(typeSel, 'change', () => setType(k, typeSel.value));
    d.listen(typeSel, 'focus', () => selectBand(k, { focus: false }));
    const num = h('button', { type: 'button', class: 'eqk-num', text: String(k), 'aria-label': `Select band ${k}` });
    d.listen(num, 'click', () => selectBand(k));
    const onoff = h('button', {
      type: 'button', class: 'eqk-onoff', dataset: { f: 'on' }, 'aria-label': `Band ${k} on`,
    });
    d.listen(onoff, 'click', () => {
      const b = bandByK(k);
      if (b) setBand(k, { on: !b.on }, 'on');
    });
    const del = h('button', {
      type: 'button', class: 'eqk-del', dataset: { f: 'del' }, text: '✕', 'aria-label': `Remove band ${k}`,
    });
    d.listen(del, 'click', () => removeBand(k));
    const tr = h('tr', { dataset: { k: String(k) } },
      h('td', {}, num), h('td', {}, typeSel),
      h('td', {}, cell('note', 'note', 'A note (A3, F#2) or Hz')),
      h('td', {}, cell('hz', 'Hz', 'Hz: 220, 1.2k, 3500')),
      h('td', {}, cell('db', 'gain dB')),
      h('td', {}, cell('q', 'Q', 'Q, or a width in octaves: 1 oct')),
      h('td.eqk-acts'), h('td', {}, onoff), h('td', {}, del));
    d.listen(tr, 'pointerdown', () => {
      if (sel !== k) selectBand(k, { focus: false });
    });
    return tr;
  }

  function setCell(inp, text, disabled = false) {
    if (inp.disabled !== disabled) inp.disabled = disabled;
    if (document.activeElement === inp) return;
    if (inp.value !== text) inp.value = text;
    inp.defaultValue = text;
    inp.classList.remove('bad');
  }

  function syncRow(tr) {
    const k = Number(tr.dataset.k);
    const b = bandByK(k);
    if (!b) return;
    tr.classList.toggle('sel', sel === k);
    tr.classList.toggle('off', !b.on);
    const typeSel = tr.querySelector('select');
    if (typeSel.value !== b.type) typeSel.value = b.type;
    const q = (f) => tr.querySelector(`input[data-f="${f}"]`);
    setCell(q('note'), noteCell(b.hz));
    setCell(q('hz'), M.fmtHzNum(b.hz));
    setCell(q('db'), M.hasGain(b.type) ? M.fmtDb(b.db) : '—', !M.hasGain(b.type));
    setCell(q('q'), M.hasQ(b.type) ? b.q.toFixed(2) : '—', !M.hasQ(b.type));
    if (!M.hasQ(b.type)) q('q').title = 'Shelves use a fixed slope (Q 0.71) in Web Audio';
    const acts = M.actsOn(b, zone, fs());
    const td = tr.querySelector('.eqk-acts');
    const text = isCompact() ? acts.text.replace(/: tone colour, not notes$/, '') : acts.text;
    const key = `${acts.kind}|${acts.pill}|${text}`;
    if (td.dataset.key !== key) {
      td.dataset.key = key;
      td.textContent = '';
      td.append(h(`span.eqk-pill.${acts.kind}`, { text: acts.pill }), text);
    }
    tr.querySelector('.eqk-onoff').setAttribute('aria-pressed', String(b.on));
    tr.querySelectorAll('input, select, button').forEach((x) => {
      if (x.dataset.f !== 'del') x.toggleAttribute('data-bypassed', ab === 'b');
    });
  }

  function onCell(k, f, inp) {
    const b = bandByK(k);
    if (!b) return;
    const v = inp.value;
    let patch = null;
    if (f === 'note' || f === 'hz') {
      const hz = M.parseFreq(v);
      if (hz !== null) patch = { hz: M.clamp(hz, M.F_MIN, M.F_MAX) };
    } else if (f === 'db') {
      const g = M.parseDb(v);
      if (g !== null) patch = { db: g };
    } else if (f === 'q') {
      const q = M.parseQ(v, b.hz, fs());
      if (q !== null) patch = { q };
    }
    if (!patch) {
      inp.classList.add('bad');
      return;
    }
    inp.classList.remove('bad');
    if (!b.on && (f === 'db' || f === 'q')) patch.on = true;
    // the typed value is exact: no snapping (DECISION "prototype fixes")
    inp.defaultValue = inp.value;
    setBand(k, patch, `cell:${f}`);
    // re-sync this cell too (it has focus, so syncRow skipped it)
    const nb = bandByK(k);
    if (nb) {
      const text = f === 'note' ? noteCell(nb.hz) : f === 'hz' ? M.fmtHzNum(nb.hz)
        : f === 'db' ? M.fmtDb(nb.db) : nb.q.toFixed(2);
      inp.value = inp.defaultValue = text;
    }
  }

  function syncCuts() {
    const lcOn = model.cutHz > M.CUT_OFF_HZ;
    const hcOn = model.hiCutHz < M.HICUT_OFF_HZ;
    setCell(cutIn, lcOn ? M.fmtHz(model.cutHz) : 'off');
    setCell(hiCutIn, hcOn ? M.fmtHz(model.hiCutHz) : 'off');
    cutOn.setAttribute('aria-pressed', String(lcOn));
    hiCutOn.setAttribute('aria-pressed', String(hcOn));
  }
  function onCutCell(which, inp) {
    const v = inp.value.trim().toLowerCase();
    let hz;
    if (v === 'off' || v === '') hz = which === 'lc' ? 20 : 20000;
    else hz = M.parseFreq(v);
    if (hz === null) {
      inp.classList.add('bad');
      return;
    }
    inp.defaultValue = inp.value;
    setCuts(which === 'lc' ? { cutHz: hz } : { hiCutHz: hz });
    inp.value = inp.defaultValue = which === 'lc'
      ? (model.cutHz > M.CUT_OFF_HZ ? M.fmtHz(model.cutHz) : 'off')
      : (model.hiCutHz < M.HICUT_OFF_HZ ? M.fmtHz(model.hiCutHz) : 'off');
  }
  for (const [inp, which] of [[cutIn, 'lc'], [hiCutIn, 'hc']]) {
    d.listen(inp, 'change', () => onCutCell(which, inp));
    d.listen(inp, 'focus', () => {
      sel = which;
      inp.select();
      dirty = true;
    });
    d.listen(inp, 'keydown', (e) => {
      if (e.key === 'Enter') {
        if (inp.value !== inp.defaultValue) onCutCell(which, inp);
        inp.blur();
      } else if (e.key === 'Escape') {
        inp.value = inp.defaultValue;
        inp.blur();
      }
    });
  }
  d.listen(cutOn, 'click', () => setCuts({ cutHz: model.cutHz > M.CUT_OFF_HZ ? 20 : 80 }));
  d.listen(hiCutOn, 'click', () => setCuts({ hiCutHz: model.hiCutHz < M.HICUT_OFF_HZ ? 20000 : 12000 }));

  // ------------------------------------------------------------------------------------------------ header controls
  for (const b of presetBtns) {
    d.listen(b, 'click', () => {
      const name = b.dataset.preset;
      const p = M.EQ_PRESETS[name];
      commit({ bands: p.bands.map((x) => ({ ...x })), cutHz: p.cutHz, hiCutHz: p.hiCutHz }, `preset:${name}`);
      sel = p.bands.find((x) => x.type === 'peak')?.k ?? p.bands[0]?.k ?? null;
      refresh(true);
      say(`${name} applied to ${slotName()}`);
    });
  }
  d.listen(abA, 'click', () => setAB('a'));
  d.listen(abB, 'click', () => setAB('b'));
  d.listen(addBtn, 'click', () => {
    const f = M.midiF(Math.round((zone.lo + zone.hi) / 2));
    addBand(M.snapF(M.clamp(f, 40, 12000)));
  });
  d.listen(copyBtn, 'click', async () => {
    const txt = M.formatEqText(model, `${slotName()} · ${instLabel(slotNow())}`);
    let ok = false;
    try {
      await navigator.clipboard.writeText(txt);
      ok = true;
    } catch {
      ok = false;
    }
    if (!ok) {
      // clipboard blocked (no permission / insecure origin): hand the text over in the paste box
      paste.open = true;
      pasteTa.value = txt;
      pasteTa.select();
    }
    copied.textContent = ok ? 'Copied' : 'Select + copy below';
    copyText = txt;
    setTimeout(() => {
      if (!destroyed) copied.textContent = '';
    }, 1600);
  });
  let copyText = '';
  d.listen(pasteBtn, 'click', () => {
    const r = M.parseForeign(pasteTa.value, fs());
    pasteOut.textContent = '';
    const applied = r.lines.filter((l) => l.status === 'applied');
    for (const l of r.lines) {
      pasteOut.append(h(`li.${l.status}`, {},
        h('span.eqk-pill', { text: l.status === 'applied' ? l.band : 'skipped' }),
        h('code', { text: l.raw }),
        l.why ? h('span.eqk-why', { text: ` · ${l.why}` }) : null,
        ...(l.notes || []).map((n) => h('span.eqk-why', { text: ` · ${n}` }))));
    }
    if (!applied.length) {
      pasteOut.append(h('li.skipped', { text: 'Nothing to apply: no filter lines found' }));
      return;
    }
    commit({ bands: r.bands, cutHz: r.cutHz, hiCutHz: r.hiCutHz }, 'paste');
    sel = r.bands[0]?.k ?? null;
    refresh(true);
    say(`${applied.length} line${applied.length > 1 ? 's' : ''} applied to ${slotName()}`);
  });

  // ------------------------------------------------------------------------------------------------ geometry
  const plotW = () => G.w - G.L - G.R;
  const plotB = () => G.h - G.RULER;
  const xOfU = (u) => G.L + (u / M.TOTAL_U) * plotW();
  const xOfF = (f) => xOfU(M.uOfF(f));
  const fOfX = (x) => M.fOfU(M.clamp((x - G.L) / plotW(), 0, 1) * M.TOTAL_U);
  const xOfSemi = (s) => xOfU(M.uOfSemi(s));
  const yOfDb = (v) => G.T + (1 - (v + DB_RANGE) / (2 * DB_RANGE)) * (plotB() - G.T);
  const dbOfY = (y) => (1 - (y - G.T) / (plotB() - G.T)) * 2 * DB_RANGE - DB_RANGE;
  const yOfSpec = (v) => plotB() - M.clamp((v + 105) / 85, 0, 1) * (plotB() - G.T);
  const nodeDb = (b) => (M.hasGain(b.type) && b.on ? b.db : 0);
  const nodePos = (b) => ({ x: xOfF(b.hz), y: yOfDb(nodeDb(b)) });
  function cutPos(which) {
    const on = which === 'lc' ? model.cutHz > M.CUT_OFF_HZ : model.hiCutHz < M.HICUT_OFF_HZ;
    const f = which === 'lc' ? model.cutHz : model.hiCutHz;
    const x = on ? xOfF(f) : which === 'lc' ? G.L + 16 : G.w - G.R - 16;
    return { x, y: yOfDb(CUT_Y_DB), on };
  }
  /** Q wings (half-gain points for a PEQ, −3 dB points for a notch) of band b, or null. */
  function wings(b) {
    if (!b || !b.on || !(b.type === 'peak' || b.type === 'notch')) return null;
    const half = M.bwOfQ(b.q, b.hz, fs()) / 2;
    const f1 = b.hz / Math.pow(2, half);
    const f2 = b.hz * Math.pow(2, half);
    const y = b.type === 'peak' ? yOfDb(b.db / 2) : yOfDb(-3);
    return [{ x: xOfF(f1), y, f: f1 }, { x: xOfF(f2), y, f: f2 }];
  }

  function resize() {
    if (destroyed) return;
    const w = el.clientWidth;
    if (o.compact) el.dataset.compact = 'forced';
    else if (w && w < 1180) el.dataset.compact = 'auto';
    else delete el.dataset.compact;
    G.dpr = window.devicePixelRatio || 1;
    const r = plot.getBoundingClientRect();
    const kr = kb.getBoundingClientRect();
    G.w = r.width;
    G.h = r.height;
    G.kh = kr.height;
    G.r = isCompact() ? 15 : 17;
    G.hit = 22;
    plot.width = Math.max(1, Math.round(r.width * G.dpr));
    plot.height = Math.max(1, Math.round(r.height * G.dpr));
    kb.width = Math.max(1, Math.round(kr.width * G.dpr));
    kb.height = Math.max(1, Math.round(kr.height * G.dpr));
    G.font = getComputedStyle(el).fontFamily || 'sans-serif';
    anCols = null;
    recomputeCurve();
    syncTable();
    dirty = dirtyKeys = true;
  }

  // ------------------------------------------------------------------------------------------------ curve
  /**
   * Curve = what you hear, without ever drawing a stale one: the store reaches the engine a hop later (store notify
   * → controller → engine.setParam), so right after an edit the engine still answers with the old EQ. The local
   * RBJ curve (the target) is drawn until the engine agrees within 0.5 dB, polled every frame for up to
   * ENGINE_WAIT_MS; if it still disagrees then, the engine's curve wins (it is the sound) and a warning says so once.
   */
  function recomputeCurve() {
    if (!G.w) return;
    const xs = [];
    for (let x = G.L; x <= G.w - G.R + 0.01; x += 1.5) xs.push(x);
    const freqs = new Float32Array(xs.map(fOfX));
    const local = M.eqResponseDb(model, freqs, fs());
    let db = local;
    let source = 'local';
    enginePending = false;
    const er = via('getEqResponse');
    if (ab !== 'b' && er) {
      let r = null;
      try {
        r = er.getEqResponse(slotIndex, freqs);
      } catch {
        r = null;
      }
      if (r && r.length === freqs.length && Array.prototype.every.call(r, Number.isFinite)) {
        let mx = 0;
        for (let i = 0; i < local.length; i++) {
          mx = Math.max(mx, Math.abs(M.clamp(local[i], -40, 40) - M.clamp(r[i], -40, 40)));
        }
        curveMismatch = mx;
        if (mx <= 0.5) {
          db = r;
          source = 'engine';
        } else if (performance.now() < engineCurveUntil) {
          enginePending = true; // not caught up yet: keep the target on screen and ask again next frame
        } else {
          db = r;
          source = 'engine';
          if (!warnedMismatch) {
            warnedMismatch = true;
            console.warn(`[eq] engine.getEqResponse differs from the stored EQ by ${mx.toFixed(2)} dB ` +
              `(slot ${slotIndex})`);
          }
        }
      }
    }
    curve = { xs, db, source, local };
  }

  // ------------------------------------------------------------------------------------------------ analyser
  let anCols = null;
  let anBuf = null;
  let anBuf2 = null;
  function analysers() {
    if (o.rta === false) return null;
    const ctx = engine?.ctx;
    if (!ctx || ctx.state !== 'running') return null;
    const sa = via('slotAnalysers');
    if (sa && slotAnTried !== slotIndex) {
      slotAnTried = slotIndex;
      try {
        slotAn?.release?.();
        const r = sa.slotAnalysers(slotIndex);
        slotAn = r ? { pre: r.pre ?? r[0] ?? null, post: r.post ?? r[1] ?? null, release: r.release ?? null } : null;
      } catch {
        slotAn = null;
      }
    }
    if (slotAn?.post) return { post: slotAn.post, pre: slotAn.pre || null, kind: 'slot' };
    const L = engine.analyserL;
    if (!L) return null;
    return { post: L, post2: engine.analyserR || null, pre: null, kind: 'master' };
  }
  function specColumns(an) {
    if (anCols && anCols.fft === an.fftSize) return anCols;
    const binHz = fs() / an.fftSize;
    const cols = [];
    for (let x = Math.floor(G.L); x <= G.w - G.R; x += 2) {
      cols.push({ x, b0: fOfX(x - 1) / binHz, b1: fOfX(x + 1) / binHz });
    }
    anCols = { fft: an.fftSize, cols };
    return anCols;
  }
  function sampleSpec(arr, c) {
    const i0 = Math.floor(c.b0);
    const i1 = Math.ceil(c.b1);
    if (i1 - i0 <= 1) {
      const m = (c.b0 + c.b1) / 2;
      const i = Math.min(Math.floor(m), arr.length - 1);
      const t = m - i;
      return arr[i] * (1 - t) + arr[Math.min(i + 1, arr.length - 1)] * t;
    }
    let mx = -200;
    for (let i = i0; i <= Math.min(i1, arr.length - 1); i++) if (arr[i] > mx) mx = arr[i];
    return mx;
  }

  // ------------------------------------------------------------------------------------------------ drawing
  const hexA = (hex, a) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  };
  const rr = (c, x, y, w, hh, r) => {
    c.beginPath();
    if (c.roundRect) c.roundRect(x, y, w, hh, r);
    else c.rect(x, y, w, hh);
  };
  const font = (spec) => `${spec} ${G.font}`;

  function drawGraph() {
    const c = g2;
    const W = G.w;
    const H = G.h;
    const col = color();
    const byp = ab === 'b';
    c.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    c.fillStyle = '#0f1216';
    c.fillRect(0, 0, W, H);
    const pB = plotB();
    const pT = G.T;
    const xk0 = xOfSemi(M.S_LO);
    const xk1 = xOfSemi(M.S_HI);
    c.fillStyle = '#12151a';
    c.fillRect(G.L, pT, xk0 - G.L, pB - pT);
    c.fillRect(xk1, pT, W - G.R - xk1, pB - pT);
    // no-notes zone (hatched) and the overtones zone (a light tint, not a disabled veil: DECISION §5)
    const xs = M.clamp(xOfF(zone.fLo), G.L, W - G.R);
    const xo = M.clamp(xOfF(zone.fHi), G.L, W - G.R);
    if (xs > G.L + 1) {
      c.save();
      c.beginPath();
      c.rect(G.L, pT, xs - G.L, pB - pT);
      c.clip();
      c.fillStyle = '#1a1d22';
      c.fillRect(G.L, pT, xs - G.L, pB - pT);
      c.strokeStyle = '#262a31';
      c.lineWidth = 1;
      for (let x = G.L - (pB - pT); x < xs; x += 7) {
        c.beginPath();
        c.moveTo(x, pB);
        c.lineTo(x + (pB - pT), pT);
        c.stroke();
      }
      c.restore();
    }
    if (xo < W - G.R - 1) {
      c.fillStyle = 'rgba(255,255,255,0.035)';
      c.fillRect(xo, pT, W - G.R - xo, pB - pT);
    }
    // grid: C octaves, Hz decades, dB
    c.lineWidth = 1;
    c.strokeStyle = '#1f242b';
    for (let n = 24; n <= 108; n += 12) {
      const x = Math.round(xOfSemi(n)) + 0.5;
      c.beginPath();
      c.moveTo(x, pT);
      c.lineTo(x, pB);
      c.stroke();
    }
    c.strokeStyle = '#2a3038';
    c.setLineDash([2, 3]);
    for (const f of [100, 1000, 10000]) {
      const x = Math.round(xOfF(f)) + 0.5;
      c.beginPath();
      c.moveTo(x, pT);
      c.lineTo(x, pB);
      c.stroke();
    }
    c.setLineDash([]);
    c.font = font('600 11px');
    c.textBaseline = 'middle';
    for (let v = -12; v <= 12; v += 6) {
      const y = Math.round(yOfDb(v)) + 0.5;
      c.strokeStyle = v === 0 ? '#3a414d' : '#1f242b';
      c.beginPath();
      c.moveTo(G.L, y);
      c.lineTo(W - G.R, y);
      c.stroke();
      c.fillStyle = v === 0 ? '#a3acb8' : '#6b7380';
      c.textAlign = 'right';
      c.fillText((v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v) + (v === 0 ? ' dB' : ''), G.L - 6, y);
    }
    c.strokeStyle = '#3a414d';
    for (const x of [xk0, xk1]) {
      c.beginPath();
      c.moveTo(Math.round(x) + 0.5, pT);
      c.lineTo(Math.round(x) + 0.5, H);
      c.stroke();
    }
    // zone labels
    c.textBaseline = 'top';
    c.textAlign = 'left';
    const zoneLabel = (x0, x1, lines, colr) => {
      if (x1 - x0 < 70) return;
      c.save();
      c.beginPath();
      c.rect(x0, pT, x1 - x0, pB - pT);
      c.clip();
      c.fillStyle = colr;
      lines.forEach((t, i) => {
        c.font = font(i ? '500 11.5px' : '700 12px');
        c.fillText(t, x0 + 8, pT + 4 + i * 15);
      });
      c.restore();
    };
    const nm = M.noteName;
    if (xs - G.L > 70) {
      const why = zone.why.lo === 'split' ? `below the split (${nm(zone.lo)})`
        : zone.why.lo === 'instrument' ? 'below the lowest sample' : 'below your keyboard';
      zoneLabel(Math.max(G.L, xk0), xs, [`${slotName()} doesn't play here`, why, 'no notes to shape, only rumble'],
        '#8a93a0');
    }
    if (xo < xk1 - 4) {
      zoneLabel(xo, W - G.R, [`Tone (overtones) of ${nm(zone.lo)}–${nm(zone.hi)}`,
        `no ${slotName()} notes above ${nm(zone.hi)}`], '#9aa3ae');
    }
    else zoneLabel(xk1, W - G.R, ['Air', 'overtones only'], '#6b7380');

    // analyser behind the curve (WING: RTA behind)
    const an = analysers();
    if (an) {
      const n = an.post.frequencyBinCount;
      if (!anBuf || anBuf.length !== n) {
        anBuf = new Float32Array(n);
        anBuf2 = new Float32Array(n);
      }
      const { cols } = specColumns(an.post);
      an.post.getFloatFrequencyData(anBuf);
      if (an.post2 && an.post2.frequencyBinCount === n) {
        an.post2.getFloatFrequencyData(anBuf2);
        for (let i = 0; i < n; i++) anBuf[i] = Math.max(anBuf[i], anBuf2[i]);
      }
      const path = (arr) => {
        c.beginPath();
        cols.forEach((cl, i) => {
          const y = yOfSpec(sampleSpec(arr, cl));
          if (i) c.lineTo(cl.x, y);
          else c.moveTo(cl.x, y);
        });
      };
      if (an.pre) {
        const pre = new Float32Array(an.pre.frequencyBinCount);
        an.pre.getFloatFrequencyData(pre);
        path(pre);
        c.strokeStyle = 'rgba(215,220,227,.55)';
        c.lineWidth = 1;
        c.stroke();
      }
      path(anBuf);
      c.lineTo(cols[cols.length - 1].x, pB);
      c.lineTo(cols[0].x, pB);
      c.closePath();
      const gr = c.createLinearGradient(0, pT, 0, pB);
      gr.addColorStop(0, hexA(byp ? '#a3acb8' : col, 0.3));
      gr.addColorStop(1, hexA(byp ? '#a3acb8' : col, 0.04));
      c.fillStyle = gr;
      c.fill();
      path(anBuf);
      c.strokeStyle = hexA(byp ? '#c9d0d8' : col, 0.85);
      c.lineWidth = 1.3;
      c.stroke();
    }

    // selected band's own contribution
    const sb = typeof sel === 'number' ? bandByK(sel) : null;
    if (sb && !byp && M.bandFilter(sb)) {
      c.beginPath();
      c.moveTo(G.L, yOfDb(0));
      for (let x = G.L; x <= W - G.R; x += 2) {
        c.lineTo(x, yOfDb(M.clamp(M.bandDb(sb, fOfX(x), fs()), -DB_RANGE, DB_RANGE)));
      }
      c.lineTo(W - G.R, yOfDb(0));
      c.closePath();
      // lift in the slot colour, anything that takes away (cut, notch, low/high cut) in blue, as on the keys
      c.fillStyle = hexA(M.hasGain(sb.type) && sb.db > 0 ? col : CUT_BLUE, 0.16);
      c.fill();
    }
    // composite curve
    c.beginPath();
    curve.xs.forEach((x, i) => {
      const y = yOfDb(M.clamp(curve.db[i], -DB_RANGE - 1, DB_RANGE + 1));
      if (i) c.lineTo(x, y);
      else c.moveTo(x, y);
    });
    c.lineWidth = 2.6;
    c.strokeStyle = byp ? '#6b7380' : '#ffffff';
    if (byp) c.setLineDash([6, 5]);
    c.stroke();
    c.setLineDash([]);

    // cuts: rounded-square nodes on the slope, with a dashed stalk to the curve
    for (const which of ['lc', 'hc']) {
      const p = cutPos(which);
      const isSel = sel === which;
      const hot = hoverHit?.cut === which || drag?.cut === which;
      if (p.on) {
        c.strokeStyle = hexA(CUT_BLUE, 0.5);
        c.setLineDash([2, 3]);
        c.beginPath();
        c.moveTo(p.x, p.y);
        c.lineTo(p.x, yOfDb(-3));
        c.stroke();
        c.setLineDash([]);
      }
      const s = 13 + (hot ? 2 : 0);
      rr(c, p.x - s, p.y - s * 0.8, 2 * s, 1.6 * s, 6);
      c.fillStyle = isSel && p.on ? CUT_BLUE : '#15181d';
      c.fill();
      c.lineWidth = 2;
      c.strokeStyle = p.on ? CUT_BLUE : '#6b7380';
      if (!p.on) c.setLineDash([3, 2.5]);
      c.stroke();
      c.setLineDash([]);
      c.fillStyle = isSel && p.on ? '#08131f' : p.on ? CUT_BLUE : '#8a93a0';
      c.font = font('800 11px');
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(which === 'lc' ? 'LC' : 'HC', p.x, p.y + 0.5);
    }

    // Q wings for the selected band
    const ws = sb && !byp ? wings(sb) : null;
    if (ws) {
      c.strokeStyle = hexA(col, 0.8);
      c.lineWidth = 1.5;
      c.setLineDash([3, 3]);
      c.beginPath();
      c.moveTo(ws[0].x, ws[0].y);
      c.lineTo(ws[1].x, ws[1].y);
      c.stroke();
      c.setLineDash([]);
      for (const [i, w] of ws.entries()) {
        const hot = drag?.wing === i || hoverHit?.wing === i;
        c.fillStyle = hot ? col : '#0f1216';
        c.strokeStyle = col;
        c.lineWidth = 2;
        rr(c, w.x - 6, w.y - 14, 12, 28, 5);
        c.fill();
        c.stroke();
        c.strokeStyle = hot ? ink() : hexA(col, 0.9);
        c.lineWidth = 1.2;
        for (const dy of [-5, 0, 5]) {
          c.beginPath();
          c.moveTo(w.x - 2.5, w.y + dy);
          c.lineTo(w.x + 2.5, w.y + dy);
          c.stroke();
        }
      }
    }

    // band nodes (big, numbered: WING-Q)
    const order = model.bands.slice().sort((a, b) => (a.k === sel) - (b.k === sel));
    for (const b of order) {
      const p = nodePos(b);
      const r = M.actsOn(b, zone, fs());
      const isSel = b.k === sel;
      const hot = drag?.k === b.k || hoverHit?.k === b.k;
      const doomed = drag?.k === b.k && drag.remove;
      const inGrey = r.kind === 'over' || r.kind === 'none';
      const R = G.r + (hot ? 2 : 0);
      if (isSel) {
        const cue = drag?.k === b.k && drag.lpCue;
        c.beginPath();
        c.arc(p.x, p.y, R + 6, 0, Math.PI * 2);
        c.strokeStyle = cue ? '#ffffff' : hexA(doomed ? '#ff4d4f' : col, 0.35);
        c.lineWidth = cue ? 4 : 3;
        c.stroke();
      }
      c.beginPath();
      c.arc(p.x, p.y, R, 0, Math.PI * 2);
      c.fillStyle = doomed ? '#ff4d4f' : !b.on || byp ? '#15181d' : isSel ? col : 'rgba(21,24,29,.92)';
      c.fill();
      c.lineWidth = 2.5;
      c.strokeStyle = doomed ? '#ff4d4f' : !b.on || byp ? '#6b7380' : inGrey ? '#a3acb8' : col;
      if (inGrey || !b.on) c.setLineDash([3, 2.5]);
      c.stroke();
      c.setLineDash([]);
      c.fillStyle = doomed ? '#fff' : isSel && b.on && !byp ? ink()
        : !b.on || byp ? '#8a93a0' : inGrey ? '#c9d0d8' : col;
      c.font = font(`800 ${G.r >= 17 ? 15 : 13}px`);
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(doomed ? '✕' : String(b.k), p.x, p.y + 0.5);
      // a small type glyph under the number for non-PEQ bands
      const glyph = { lowshelf: 'LS', highshelf: 'HS', notch: 'N', lowcut: 'LC', highcut: 'HC' }[b.type];
      if (glyph && !doomed) {
        c.font = font('700 9px');
        c.fillText(glyph, p.x, p.y + R * 0.62);
      }
      let tag = null;
      if (doomed) tag = ['release to remove', '#5a0d10', '#ffc9ca'];
      else if (inGrey && r.kind === 'over') tag = ['overtones only', '#3a3f48', '#e6e9ee'];
      else if (inGrey) tag = ['no effect', '#4a2326', '#ffc9ca'];
      else if (!b.on) tag = ['off', '#2a2f37', '#a3acb8'];
      if (tag) {
        c.font = font('700 11px');
        const tw = c.measureText(tag[0]).width + 12;
        const ty = p.y + R + 22 > pB ? p.y - R - 22 : p.y + R + 5;
        c.fillStyle = tag[1];
        rr(c, p.x - tw / 2, ty, tw, 17, 8);
        c.fill();
        c.fillStyle = tag[2];
        c.fillText(tag[0], p.x, ty + 9);
      }
    }

    // Hz ruler
    c.fillStyle = '#0b0d10';
    c.fillRect(0, pB, W, G.RULER);
    c.strokeStyle = '#2d333d';
    c.beginPath();
    c.moveTo(0, pB + 0.5);
    c.lineTo(W, pB + 0.5);
    c.stroke();
    c.strokeStyle = '#3a414d';
    for (const f of [30, 40, 60, 70, 80, 90, 150, 300, 400, 600, 700, 800, 900, 1500, 3000, 4000, 7000, 9000, 15000]) {
      const x = Math.round(xOfF(f)) + 0.5;
      c.beginPath();
      c.moveTo(x, pB);
      c.lineTo(x, pB + 4);
      c.stroke();
    }
    c.font = font('600 11px');
    c.textBaseline = 'middle';
    const major = [[20, '20'], [50, '50'], [100, '100 Hz'], [200, '200'], [500, '500'], [1000, '1 kHz'], [2000, '2k'],
      [5000, '5k'], [10000, '10k'], [20000, '20k']];
    for (const [f, t] of major) {
      const x = Math.round(xOfF(f)) + 0.5;
      c.strokeStyle = '#6b7380';
      c.beginPath();
      c.moveTo(x, pB);
      c.lineTo(x, pB + 7);
      c.stroke();
      c.fillStyle = '#c9d0d8';
      c.textAlign = f === 20 ? 'left' : f === 20000 ? 'right' : 'center';
      c.fillText(t, f === 20 ? x + 2 : f === 20000 ? x - 2 : x, pB + 14);
    }
    const x440 = Math.round(xOfF(440)) + 0.5;
    c.strokeStyle = 'rgba(255,201,77,.7)';
    c.beginPath();
    c.moveTo(x440, pB);
    c.lineTo(x440, pB + 6);
    c.stroke();
    c.fillStyle = '#ffc94d';
    c.textAlign = 'center';
    c.fillText('440', x440, pB + 14);
    c.textAlign = 'left';
    c.fillStyle = '#6b7380';
    c.fillText('Hz', 6, pB + 12);
    if (hover && !drag && hover.y < pB && hover.x > G.L) {
      c.strokeStyle = 'rgba(241,244,248,.35)';
      c.lineWidth = 1;
      const x = Math.round(hover.x) + 0.5;
      c.beginPath();
      c.moveTo(x, pT);
      c.lineTo(x, H);
      c.stroke();
    }
  }

  const KEYS = M.keyRects();
  function drawKeys() {
    const c = k2;
    const W = G.w;
    const H = G.kh;
    const col = color();
    c.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    c.fillStyle = '#0b0d10';
    c.fillRect(0, 0, W, H);
    const bar = 11;
    const top = bar + 2;
    const kh = H - top - 1;
    const inR = (n) => n >= zone.lo && n <= zone.hi;
    const stretched = (n) => zone.stretched.some(([a, b]) => n >= a && n <= b);
    const sb = typeof sel === 'number' && ab !== 'b' ? bandByK(sel) : null;
    // range bar
    c.fillStyle = '#1c2027';
    c.fillRect(xOfSemi(M.S_LO), 3, xOfSemi(M.S_HI) - xOfSemi(M.S_LO), 6);
    const r0 = xOfSemi(Math.max(M.S_LO, zone.lo - 0.5));
    const r1 = xOfSemi(Math.min(M.S_HI, zone.hi + 0.5));
    if (r1 > r0) {
      c.fillStyle = col;
      rr(c, r0, 3, r1 - r0, 6, 3);
      c.fill();
    }
    c.font = font('700 11px');
    c.textBaseline = 'middle';
    c.fillStyle = '#a3acb8';
    c.textAlign = 'right';
    c.fillText(slotName(), G.L - 6, 6);
    c.fillStyle = '#12151a';
    c.fillRect(G.L, top, xOfSemi(M.S_LO) - G.L - 1, kh);
    const xa = xOfSemi(M.S_HI) + 1;
    const ag = c.createLinearGradient(xa, 0, W - G.R, 0);
    ag.addColorStop(0, '#1b1f25');
    ag.addColorStop(1, '#101317');
    c.fillStyle = ag;
    c.fillRect(xa, top, W - G.R - xa, kh);
    const airW = W - G.R - xa;
    if (airW > 70) {
      c.fillStyle = '#8a93a0';
      c.textAlign = 'center';
      c.font = font('700 11px');
      c.fillText('no keys up here', xa + airW / 2, top + kh / 2 - 7);
      c.font = font('500 11px');
      c.fillText('overtones · 4.2–20 kHz', xa + airW / 2, top + kh / 2 + 8);
    }
    const tint = (n) => (sb && sb.on ? M.bandDb(sb, M.midiF(n), fs()) : 0);
    const drawKey = (k) => {
      const x0 = xOfSemi(k.l);
      const x1 = xOfSemi(k.r);
      const w = x1 - x0;
      const on = inR(k.n);
      const hh = k.black ? kh * 0.6 : kh;
      let fill = k.black ? (on ? '#1b1e23' : '#23272e') : on ? '#b4bcc6' : '#3a3f47';
      if (pressedKey === k.n && on) fill = k.black ? '#c79a1c' : '#ffc94d';
      c.fillStyle = fill;
      rr(c, x0 + 0.5, top, w - 1, hh, [0, 0, 3, 3]);
      c.fill();
      if (!on || stretched(k.n)) {
        c.save();
        rr(c, x0 + 0.5, top, w - 1, hh, [0, 0, 3, 3]);
        c.clip();
        c.strokeStyle = !on ? (k.black ? '#2c3139' : '#454b54') : 'rgba(35,39,46,.35)';
        c.lineWidth = 1;
        for (let y = top - w; y < top + hh; y += on ? 9 : 6) {
          c.beginPath();
          c.moveTo(x0, y + w);
          c.lineTo(x1, y);
          c.stroke();
        }
        c.restore();
      }
      const v = tint(k.n);
      if (Math.abs(v) >= 0.4 && !(pressedKey === k.n && on)) {
        const a = M.clamp(Math.abs(v) / 9, 0.12, 0.85) * (on ? 1 : 0.45);
        c.fillStyle = v > 0 ? hexA(col, a) : `rgba(124,196,255,${a})`;
        rr(c, x0 + 0.5, top + (k.black ? 0 : kh * 0.62), w - 1, k.black ? hh : kh * 0.38, [0, 0, 3, 3]);
        c.fill();
      }
      if (!k.black) {
        c.strokeStyle = '#0b0d10';
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(Math.round(x1) + 0.5, top);
        c.lineTo(Math.round(x1) + 0.5, top + kh);
        c.stroke();
      }
      if (!k.black && k.n % 12 === 0 && w > 6) {
        c.fillStyle = on ? '#23272e' : '#8a93a0';
        c.font = font('800 10px');
        c.textAlign = 'center';
        c.fillText(M.noteName(k.n), (x0 + x1) / 2, top + kh - 8);
      }
    };
    KEYS.filter((k) => !k.black).forEach(drawKey);
    KEYS.filter((k) => k.black).forEach(drawKey);
    // bracket over the selected band's half-gain span
    if (sb && M.bandFilter(sb)) {
      const g0 = M.hasGain(sb.type) ? Math.abs(sb.db) / 2 : 3;
      let a = null;
      let z = null;
      for (let x = G.L; x <= W - G.R; x += 1) {
        if (Math.abs(M.bandDb(sb, fOfX(x), fs())) >= g0) {
          if (a === null) a = x;
          z = x;
        }
      }
      if (a !== null && g0 >= 0.25) {
        c.strokeStyle = '#fff';
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(a, top + 7);
        c.lineTo(a, top + 1);
        c.lineTo(z, top + 1);
        c.lineTo(z, top + 7);
        c.stroke();
      }
    }
  }

  // ------------------------------------------------------------------------------------------------ interaction
  function localXY(e, target) {
    const r = target.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  /** Hit test, most specific first: wings of the selected band, the selected node, other nodes, cuts. */
  function hitTest(x, y) {
    const sb = typeof sel === 'number' ? bandByK(sel) : null;
    const ws = sb && ab !== 'b' ? wings(sb) : null;
    if (ws) {
      for (const [i, w] of ws.entries()) {
        if (Math.abs(w.x - x) <= 10 && Math.abs(w.y - y) <= 16) return { wing: i, k: sb.k };
      }
    }
    let best = null;
    let bd = G.hit * G.hit;
    for (const b of model.bands) {
      const p = nodePos(b);
      const dd = (p.x - x) ** 2 + (p.y - y) ** 2 - (b.k === sel ? 60 : 0);
      if (dd < bd) {
        bd = dd;
        best = { k: b.k };
      }
    }
    if (best) return best;
    for (const which of ['lc', 'hc']) {
      const p = cutPos(which);
      if (Math.abs(p.x - x) <= 20 && Math.abs(p.y - y) <= 20) return { cut: which };
    }
    return null;
  }
  function selectBand(k, { focus = true } = {}) {
    sel = k;
    for (const tr of tbody.rows) tr.classList.toggle('sel', Number(tr.dataset.k) === k);
    dirty = dirtyKeys = true;
    if (focus) focusPlot();
  }
  function focusPlot() {
    try {
      plot.focus({ preventScroll: true });
    } catch {
      /* detached */
    }
  }

  /** Double tap / double click: on a node → 0 dB, on a cut → off, on empty graph → add a PEQ there. */
  function onDouble(hit, x, y, alt) {
    if (hit?.k !== undefined && hit.wing === undefined) {
      const b = bandByK(hit.k);
      if (b && M.hasGain(b.type)) {
        setBand(b.k, { db: 0 }, 'zero');
        say(`Band ${b.k} back to 0 dB`);
      }
    } else if (hit?.cut) {
      setCuts(hit.cut === 'lc' ? { cutHz: 20 } : { hiCutHz: 20000 });
      say(`${hit.cut === 'lc' ? 'Low' : 'High'} cut off`);
    } else if (!hit && y < plotB() && x > G.L) {
      addBand(M.snapF(fOfX(x), alt));
    }
  }
  d.listen(plot, 'pointerdown', (e) => {
    if (e.button !== undefined && e.button > 0) return;
    const { x, y } = localXY(e, plot);
    pointers.set(e.pointerId, { x, y });
    try {
      plot.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    // pinch (two fingers) on the selected band: spreading = wider = lower Q
    if (pointers.size === 2) {
      const b = typeof sel === 'number' ? bandByK(sel) : null;
      cancelDrag();
      if (b && M.hasQ(b.type)) {
        const [p1, p2] = [...pointers.values()];
        pinch = { k: b.k, d0: Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1, q0: b.q };
      }
      return;
    }
    const hit = hitTest(x, y);
    // input time, not handling time: on a loaded machine two quick presses can be handled far apart
    const now = e.timeStamp || performance.now();
    const dbl = lastTap && now - lastTap.t < DOUBLE_MS && Math.hypot(x - lastTap.x, y - lastTap.y) < 16 &&
      (lastTap.hit?.k ?? lastTap.hit?.cut ?? null) === (hit?.k ?? hit?.cut ?? null);
    lastTap = dbl ? null : { t: now, x, y, hit };
    if (dbl) {
      lastDouble = now;
      onDouble(hit, x, y, e.altKey);
      return;
    }
    if (!hit) return;
    if (hit.wing !== undefined) {
      drag = { k: hit.k, wing: hit.wing };
      dirty = true;
      return;
    }
    if (hit.cut) {
      sel = hit.cut;
      const p = cutPos(hit.cut);
      drag = { cut: hit.cut, dx: x - p.x, x0: x, moved: false };
      dirty = dirtyKeys = true;
      focusPlot();
      return;
    }
    const b = bandByK(hit.k);
    selectBand(b.k);
    const p = nodePos(b);
    drag = {
      k: b.k, dx: x - p.x, dy: y - p.y, x0: x, y0: y, u0: M.uOfF(b.hz), db0: b.db, hz0: b.hz,
      moveF: false, moveG: false, remove: false, lp: 0, t0: e.timeStamp || performance.now(), lpCue: false,
    };
    // long-press = on/off (AMENDMENT §3). Decided on release from input timestamps (a busy main thread can't turn a
    // quick drag into a toggle); the timer only shows the cue that releasing now will switch the band.
    drag.lp = setTimeout(() => {
      if (!drag || drag.k !== b.k || drag.moveF || drag.moveG) return;
      drag.lpCue = true;
      dirty = true;
      const cur = bandByK(b.k);
      if (cur) say(`Release to switch band ${b.k} ${cur.on ? 'off' : 'on'}`, { toast: true });
    }, LONG_PRESS_MS);
  });

  // Fallback for a double click whose two presses arrived > DOUBLE_MS apart (a loaded machine, a slow mouse setting):
  // the browser's own dblclick still comes; the pointer path above stands down when it already acted.
  d.listen(plot, 'dblclick', (e) => {
    if (Math.abs((e.timeStamp || performance.now()) - lastDouble) < 800) return;
    const { x, y } = localXY(e, plot);
    cancelDrag();
    lastTap = null;
    lastDouble = e.timeStamp || performance.now();
    onDouble(hitTest(x, y), x, y, e.altKey);
  });
  d.listen(plot, 'pointermove', (e) => {
    const { x, y } = localXY(e, plot);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x, y });
    if (pinch && pointers.size >= 2) {
      const [p1, p2] = [...pointers.values()];
      const dd = Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1;
      const q = M.clamp(pinch.q0 * (pinch.d0 / dd), M.eqRow('b1.q').min ?? 0.1, M.eqRow('b1.q').max ?? 10);
      setBand(pinch.k, { q }, 'pinch');
      return;
    }
    hover = { x, y };
    if (drag) {
      onDragMove(e, x, y);
      return;
    }
    hoverHit = hitTest(x, y);
    plot.dataset.cursor = hoverHit?.wing !== undefined || hoverHit?.cut ? 'ew' : hoverHit ? 'grab' : '';
    showReadout(x, y, hoverHit);
    dirty = true;
  });

  function onDragMove(e, x, y) {
    if (drag.wing !== undefined) {
      const b = bandByK(drag.k);
      if (!b) return;
      const f = fOfX(x);
      const bw = M.clamp(2 * Math.abs(Math.log2(f / b.hz)), 0.02, 6);
      const q = M.clamp(M.qOfBw(bw, b.hz, fs()), M.eqRow('b1.q').min ?? 0.1, M.eqRow('b1.q').max ?? 10);
      setBand(b.k, { q }, 'wing');
      showReadout(x, y, { k: b.k });
      return;
    }
    if (drag.cut) {
      if (Math.abs(x - drag.x0) > DEADZONE) drag.moved = true;
      if (!drag.moved) return;
      let f = M.snapF(fOfX(x - drag.dx), e.altKey || e.shiftKey);
      if (drag.cut === 'lc') {
        if (f <= 21) f = 20;
        setCuts({ cutHz: f }, 'drag-cut');
      } else {
        if (f >= 19500) f = 20000;
        setCuts({ hiCutHz: f }, 'drag-cut');
      }
      showReadout(x, y, { cut: drag.cut });
      return;
    }
    const b = bandByK(drag.k);
    if (!b) return;
    const fine = e.shiftKey;
    const free = e.altKey || fine;
    // per-axis deadzone: a vertical nudge must not re-snap a typed frequency, nor a sideways one the gain
    if (Math.abs(x - drag.x0) > DEADZONE) drag.moveF = true;
    if (Math.abs(y - drag.y0) > DEADZONE) drag.moveG = true;
    if (drag.moveF || drag.moveG) {
      clearTimeout(drag.lp);
      drag.lpCue = false;
    }
    const remove = y > plotB() + 14;
    if (remove !== drag.remove) {
      drag.remove = remove;
      dirty = true;
    }
    const patch = {};
    if (drag.moveF) {
      const scale = fine ? 0.2 : 1;
      const u = drag.u0 + ((x - drag.x0) / plotW()) * M.TOTAL_U * scale;
      const f = M.snapF(M.fOfU(M.clamp(u, 0, M.TOTAL_U)), free);
      if (Math.abs(f - b.hz) > 1e-9) patch.hz = f;
    }
    if (drag.moveG && !remove && M.hasGain(b.type)) {
      const scale = fine ? 0.2 : 1;
      const g = drag.db0 + (dbOfY(y) - dbOfY(drag.y0)) * scale;
      const lim = M.eqRow('b1.db');
      const gg = M.clamp(free ? Math.round(g * 10) / 10 : Math.round(g * 2) / 2, lim.min ?? -15, lim.max ?? 15);
      if (Math.abs(gg - b.db) > 1e-9) patch.db = gg;
    }
    if ((patch.hz !== undefined || patch.db !== undefined) && !b.on) patch.on = true;
    if (Object.keys(patch).length) setBand(b.k, patch, 'drag');
    showReadout(x, y, remove ? { remove: b.k } : { k: b.k });
  }

  function cancelDrag() {
    if (drag?.lp) clearTimeout(drag.lp);
    drag = null;
  }
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!drag) return;
    const dr = drag;
    cancelDrag();
    if (dr.remove && dr.k !== undefined) removeBand(dr.k);
    else if (e.type === 'pointerup' && dr.t0 !== undefined && !dr.moveF && !dr.moveG &&
      (e.timeStamp || performance.now()) - dr.t0 >= LONG_PRESS_MS) {
      const cur = bandByK(dr.k);
      if (cur) {
        setBand(dr.k, { on: !cur.on }, 'on');
        say(`Band ${dr.k} ${cur.on ? 'off' : 'on'}`);
      }
    }
    dirty = dirtyKeys = true;
    syncTable();
  };
  d.listen(plot, 'pointerup', endPointer);
  d.listen(plot, 'pointercancel', endPointer);
  d.listen(plot, 'pointerleave', () => {
    hover = null;
    hoverHit = null;
    if (!drag) readout.style.display = 'none';
    dirty = true;
  });
  d.listen(plot, 'wheel', (e) => {
    const { x, y } = localXY(e, plot);
    const hit = hitTest(x, y);
    // only take the wheel over a node, or with a modifier (ctrl = trackpad pinch) — otherwise the panel scrolls
    if (!hit && !e.ctrlKey && !e.altKey && !e.metaKey) return;
    const k = hit?.k ?? (typeof sel === 'number' ? sel : null);
    const b = k !== null ? bandByK(k) : null;
    if (!b) return;
    e.preventDefault();
    if (sel !== b.k) selectBand(b.k, { focus: false });
    if (!M.hasQ(b.type)) {
      say('Shelves have a fixed slope here · switch the band to PEQ for a width');
      return;
    }
    // wheel up = narrower; pinch-out (ctrl+wheel, deltaY < 0) = wider
    const kk = e.ctrlKey ? 0.01 : -0.0025;
    const lim = M.eqRow('b1.q');
    setBand(b.k, { q: M.clamp(b.q * Math.exp(kk * e.deltaY), lim.min ?? 0.1, lim.max ?? 10) }, 'wheel');
    const nb = bandByK(b.k);
    say(`Band ${b.k} width: Q ${nb.q.toFixed(2)} · ${M.bwOfQ(nb.q, nb.hz, fs()).toFixed(2)} oct`, { toast: true });
  }, { passive: false });

  d.listen(plot, 'keydown', (e) => {
    const key = e.key;
    if (/^[1-8]$/.test(key)) {
      const k = Number(key);
      if (bandByK(k)) {
        selectBand(k);
        say(bandText(bandByK(k)));
      }
      e.preventDefault();
      return;
    }
    if (key === 'b' || key === 'B') {
      setAB(ab === 'b' ? 'a' : 'b');
      e.preventDefault();
      return;
    }
    if (key === 'Insert' || key === '+' || key === 'n' || key === 'N') {
      const b = typeof sel === 'number' ? bandByK(sel) : null;
      addBand(b ? M.snapF(b.hz * 2) : M.snapF(M.midiF(Math.round((zone.lo + zone.hi) / 2))));
      e.preventDefault();
      return;
    }
    if (sel === 'lc' || sel === 'hc') {
      const cur = sel === 'lc' ? model.cutHz : model.hiCutHz;
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        const f = M.snapF(M.midiF(Math.round(M.semiOf(cur)) + (key === 'ArrowRight' ? 1 : -1)));
        setCuts(sel === 'lc' ? { cutHz: f } : { hiCutHz: f });
        e.preventDefault();
      } else if (key === 'Delete' || key === 'Backspace') {
        setCuts(sel === 'lc' ? { cutHz: 20 } : { hiCutHz: 20000 });
        e.preventDefault();
      }
      return;
    }
    const b = typeof sel === 'number' ? bandByK(sel) : null;
    if (!b) {
      if (key.startsWith('Arrow') && model.bands.length) {
        selectBand(model.bands[0].k);
        e.preventDefault();
      }
      return;
    }
    const lim = M.eqRow('b1.db');
    const qlim = M.eqRow('b1.q');
    const step = (dir) => {
      if (e.shiftKey || e.altKey) return M.clamp(b.hz * Math.pow(2, dir / 120), M.F_MIN, M.F_MAX); // 10 cents
      const s = M.semiOf(b.hz);
      if (s >= M.S_LO && s <= M.S_HI) return M.snapF(M.midiF(Math.round(s) + dir));
      // outside the keys: the next ISO third-octave up / down
      const iso = M.ISO_THIRDS;
      if (dir > 0) return iso.find((v) => v > b.hz * 1.001) ?? iso[iso.length - 1];
      return [...iso].reverse().find((v) => v < b.hz / 1.001) ?? iso[0];
    };
    const acts = {
      ArrowLeft: () => ({ hz: step(-1) }),
      ArrowRight: () => ({ hz: step(1) }),
      ArrowUp: () => (M.hasGain(b.type) ? { db: M.clamp(b.db + (e.shiftKey ? 0.1 : 0.5), lim.min, lim.max) } : null),
      ArrowDown: () => (M.hasGain(b.type) ? { db: M.clamp(b.db - (e.shiftKey ? 0.1 : 0.5), lim.min, lim.max) } : null),
      '[': () => (M.hasQ(b.type) ? { q: M.clamp(b.q / 1.12, qlim.min, qlim.max) } : null),
      ']': () => (M.hasQ(b.type) ? { q: M.clamp(b.q * 1.12, qlim.min, qlim.max) } : null),
      0: () => (M.hasGain(b.type) ? { db: 0 } : null),
      o: () => ({ on: !b.on }),
      O: () => ({ on: !b.on }),
    };
    if (key === 'Delete' || key === 'Backspace') {
      e.preventDefault();
      removeBand(b.k);
      return;
    }
    const fn = acts[key];
    if (!fn) return;
    e.preventDefault();
    const patch = fn();
    if (patch) {
      setBand(b.k, patch, 'key');
      say(bandText(bandByK(b.k)));
    }
  });

  function bandText(b) {
    if (!b) return '';
    return `Band ${b.k} ${M.TYPE_LABEL[b.type]} · ${M.noteLabel(b.hz)}` +
      `${M.hasGain(b.type) ? ` · ${M.fmtDb(b.db)} dB` : ''}` +
      `${M.hasQ(b.type) ? ` · Q ${b.q.toFixed(2)}` : ''}${b.on ? '' : ' · off'}`;
  }

  function showReadout(x, y, hit) {
    if (y > plotB() + 40 || x < G.L) {
      readout.style.display = 'none';
      return;
    }
    let text;
    if (hit?.remove !== undefined) text = `Release to remove band ${hit.remove}`;
    else if (hit?.k !== undefined) {
      const b = bandByK(hit.k);
      if (!b) return;
      text = bandText(b);
      x = nodePos(b).x;
    } else if (hit?.cut) {
      const on = hit.cut === 'lc' ? model.cutHz > M.CUT_OFF_HZ : model.hiCutHz < M.HICUT_OFF_HZ;
      const f = hit.cut === 'lc' ? model.cutHz : model.hiCutHz;
      text = `${hit.cut === 'lc' ? 'Low' : 'High'} cut · ${on ? `${M.noteLabel(f)} · 12 dB/oct` : 'off · drag it in'}`;
      x = cutPos(hit.cut).x;
    } else {
      if (y > plotB()) {
        readout.style.display = 'none';
        return;
      }
      const f = fOfX(x);
      const i = M.clamp(Math.round((x - G.L) / 1.5), 0, curve.db.length - 1);
      const v = curve.db[i] ?? 0;
      const z = f < zone.fLo ? ` · ${slotName()} doesn't play here` : f > zone.fHi ? ' · tone (overtones)' : '';
      text = `${M.noteLabel(f)} · EQ ${M.fmtDb(v)} dB${z}`;
    }
    readout.textContent = text;
    readout.style.display = 'block';
    const w = readout.offsetWidth;
    readout.style.left = `${M.clamp(x, w / 2 + 4, G.w - w / 2 - 4)}px`;
  }

  // keyboard strip: a click names the key (and auditions it when the app offers that)
  function keyAt(x, y) {
    const top = 13;
    const kh = G.kh - top - 1;
    const u = ((x - G.L) / plotW()) * M.TOTAL_U - M.SUB_U + M.S_LO;
    if (y < top + kh * 0.6) {
      const n = Math.round(u);
      if (M.isBlackKey(n) && Math.abs(u - n) <= 0.46 && n >= M.MIDI_LO && n <= M.MIDI_HI) return n;
    }
    return KEYS.find((k) => !k.black && u >= k.l && u < k.r)?.n ?? null;
  }
  d.listen(kb, 'pointerdown', (e) => {
    const { x, y } = localXY(e, kb);
    const n = keyAt(x, y);
    if (n === null) return;
    const nm = M.noteName;
    if (n < zone.lo || n > zone.hi) {
      say(`${slotName()} doesn't play ${nm(n)} (${M.fmtHz(M.midiF(n))}) · its notes are ${nm(zone.lo)}–${nm(zone.hi)}`,
        { toast: true });
      return;
    }
    pressedKey = n;
    dirtyKeys = true;
    const i = M.clamp(Math.round((xOfSemi(n) - G.L) / 1.5), 0, curve.db.length - 1);
    say(`${nm(n)} · ${M.fmtHz(M.midiF(n))} · EQ at this note ${M.fmtDb(curve.db[i] ?? 0)} dB`, { toast: true });
    const aud = via('auditionNote');
    if (aud) {
      try {
        aud.auditionNote(slotIndex, n, {});
      } catch (err) {
        console.warn('[eq] auditionNote failed', err);
      }
    }
  });
  d.listen(window, 'pointerup', () => {
    if (pressedKey !== null) {
      pressedKey = null;
      dirtyKeys = true;
    }
  });

  // ------------------------------------------------------------------------------------------------ toast / live
  let toastT = 0;
  function say(msg, { toast = false } = {}) {
    live.textContent = msg;
    if (!toast && typeof o.toast === 'function') {
      o.toast(msg);
      return;
    }
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toastT);
    toastT = setTimeout(() => toastEl.classList.remove('on'), 1600);
  }

  // ------------------------------------------------------------------------------------------------ lifecycle
  function frame() {
    raf = requestAnimationFrame(frame);
    if (!el.isConnected) return;
    if (!G.w) {
      resize(); // mounted hidden (a closed drawer): the ResizeObserver catches later changes
      if (!G.w) return;
    }
    const settling = enginePending;
    if (settling) recomputeCurve();
    const an = !!analysers();
    if (dirty || an || settling) drawGraph();
    if (dirtyKeys) drawKeys();
    dirty = dirtyKeys = false;
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null;
  ro?.observe(el);
  d.add(() => ro?.disconnect());
  const unsub = typeof store.subscribe === 'function' ? store.subscribe(() => refresh()) : null;
  d.add(() => unsub?.());
  if (typeof engine?.addEventListener === 'function') {
    // a prepared patch / new instrument list can change the play range and the engine curve
    for (const t of ['ready', 'instruments', 'loading', 'statechange']) d.listen(engine, t, () => refresh(true));
  }
  refresh(true);
  raf = requestAnimationFrame(frame);

  return {
    el,
    /** Re-read store + engine and redraw (the component also follows the store on its own). */
    update() {
      refresh(true);
    },
    /** Show another slot (leaves B first, so the compare never outlives its slot). */
    setSlot(i) {
      if (i === slotIndex) return;
      leaveAB();
      slotAn?.release?.();
      slotAn = null;
      slotAnTried = -1;
      slotIndex = Number(i) || 0;
      sel = null;
      builtSig = null;
      refresh(true);
    },
    destroy() {
      if (destroyed) return;
      leaveAB();
      destroyed = true;
      cancelAnimationFrame(raf);
      cancelDrag();
      clearTimeout(toastT);
      try {
        slotAn?.release?.();
      } catch {
        /* engine gone */
      }
      d.dispose();
      el.remove();
    },
    /** Test/inspection hook: the component's current state (read-only copies) and a few geometry helpers. */
    debug() {
      if (!G.w && el.isConnected) resize(); // geometry before the first frame (a test right after mount)
      const r = plot.getBoundingClientRect();
      const kr = kb.getBoundingClientRect();
      return {
        slotIndex, sel, ab, abMode, model: JSON.parse(JSON.stringify(model)),
        zone: {
          lo: zone.lo, hi: zone.hi, fLo: zone.fLo, fHi: zone.fHi, source: zone.source, stretched: zone.stretched,
        },
        curveSource: curve.source, curveMismatch, curve: { xs: curve.xs.slice(), db: Array.from(curve.db) },
        copyText, destroyed, compact: isCompact(), rafActive: !!raf && !destroyed,
        nodes: model.bands.map((b) => ({ k: b.k, ...(() => {
          const p = nodePos(b);
          return { x: r.left + p.x, y: r.top + p.y };
        })() })),
        cuts: ['lc', 'hc'].map((w) => {
          const p = cutPos(w);
          return { cut: w, x: r.left + p.x, y: r.top + p.y, on: p.on };
        }),
        wings: (() => {
          const b = typeof sel === 'number' ? bandByK(sel) : null;
          const ws = b ? wings(b) : null;
          return ws ? ws.map((w) => ({ x: r.left + w.x, y: r.top + w.y })) : null;
        })(),
        plot: {
          left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.top + plotB(), plotL: r.left + G.L,
        },
        kb: { left: kr.left, top: kr.top, width: kr.width, height: kr.height },
        xOfF: (f) => r.left + xOfF(f),
        xOfMidi: (n) => r.left + xOfSemi(n),
        yOfDb: (v) => r.top + yOfDb(v),
        curveAt: (f) => {
          const x = xOfF(f);
          const i = M.clamp(Math.round((x - G.L) / 1.5), 0, curve.db.length - 1);
          return curve.db[i];
        },
      };
    },
  };
}

/**
 * Mini read-only curve for the Sound panel header (DECISION §4): a 120 × 28 px sparkline of the summed response on
 * the same key axis, the no-notes zone greyed. Hidden (`el.hidden`) while the EQ is flat; a click calls onOpen
 * (open Advanced → Tone). Computed locally (eq-math), so it never touches the engine.
 * @param {object} o
 * @param {object} o.store
 * @param {number} o.slotIndex
 * @param {() => void} [o.onOpen]
 * @param {number} [o.width=120]
 * @param {number} [o.height=28]
 * @returns {{el:HTMLButtonElement, update():void, setSlot(i:number):void, destroy():void}}
 */
export function eqMiniCurve(o = {}) {
  const { store, onOpen = null } = o;
  const W = o.width || 120;
  const H = o.height || 28;
  let slotIndex = Number(o.slotIndex) || 0;
  const d = disposer();
  const cv = h('canvas', { width: String(W), height: String(H), style: { width: `${W}px`, height: `${H}px` } });
  const el = h('button', { type: 'button', class: 'eqk-mini' }, cv);
  let sig = '';
  function draw() {
    const song = store.currentSong?.();
    const slot = song?.patch?.slots?.[slotIndex] || null;
    const summary = slot ? M.eqSummary(slot.eq) : 'Flat';
    let songT = 0;
    try {
      songT = song ? Number(store.transposeSemisOf?.(song)) || 0 : 0;
    } catch {
      songT = 0;
    }
    const s = JSON.stringify([slot?.eq ?? null, slot?.lowNote, slot?.highNote, slot?.octave, slot?.transpose, songT]);
    if (s === sig) return;
    sig = s;
    el.hidden = !slot || summary === 'Flat';
    el.setAttribute('aria-label', `Tone EQ: ${summary}. Open the Tone panel`);
    el.title = `Tone EQ: ${summary}`;
    if (el.hidden) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const xOfF = (f) => (M.uOfF(f) / M.TOTAL_U) * W;
    const zone = M.soundingRange(slot, { songTranspose: songT });
    const xs = M.clamp(xOfF(zone.fLo), 0, W);
    if (xs > 0) {
      c.fillStyle = 'rgba(58,63,71,.55)';
      c.fillRect(0, 0, xs, H);
    }
    c.strokeStyle = 'rgba(163,172,184,.35)';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(0, H / 2 + 0.5);
    c.lineTo(W, H / 2 + 0.5);
    c.stroke();
    const freqs = Array.from({ length: W + 1 }, (_, x) => M.fOfU((x / W) * M.TOTAL_U));
    const r = M.eqResponseDb(M.readEq(slot.eq), freqs);
    c.beginPath();
    r.forEach((v, x) => {
      const y = H / 2 - (M.clamp(v, -15, 15) / 15) * (H / 2 - 2);
      if (x) c.lineTo(x, y);
      else c.moveTo(x, y);
    });
    c.strokeStyle = SLOT_HEX[slotIndex] || SLOT_HEX[0];
    c.lineWidth = 1.6;
    c.stroke();
  }
  d.listen(el, 'click', () => {
    if (typeof onOpen === 'function') onOpen();
  });
  const unsub = store.subscribe?.(() => draw());
  d.add(() => unsub?.());
  draw();
  return {
    el,
    update() {
      sig = '';
      draw();
    },
    setSlot(i) {
      slotIndex = Number(i) || 0;
      sig = '';
      draw();
    },
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}
