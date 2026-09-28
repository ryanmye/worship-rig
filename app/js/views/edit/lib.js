// H-v2 Edit: shared helpers for the shell and every panel module (views/edit/CONTRACT.md §3).
// Owned by the shell (hv2-edit-setup). Panel agents import from here and never edit it; ask the integrator for
// additions. Pure DOM helpers only: no store/engine access (panels get those through their ctx).
import { describe, faderTaper, inverseTaper, SLOT_COUNT } from '../../shared/params.js';

// ---------------------------------------------------------------------------------------------------------------
// DOM
/**
 * Create an element. 'div.cls.cls2#id' shorthand; attrs: text, class, style (object; `--x` custom properties
 * allowed), dataset (object), on ({type: fn}), boolean attributes; everything else is setAttribute.
 * @param {string} tag
 * @param {object} [attrs]
 * @param {...(Node|string|number|null|false|Array)} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs = {}, ...children) {
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

/** Set text only when it changed. @param {Element} e @param {*} t */
export function setText(e, t) {
  const s = String(t ?? '');
  if (e.textContent !== s) e.textContent = s;
}

/** A plain `<button type=button>`. @returns {HTMLButtonElement} */
export const button = (text, onClick, attrs = {}) =>
  h('button', { type: 'button', ...attrs, on: { ...(attrs.on || {}), click: onClick } }, text);

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Stroke icons from the H-v2 mockup (design/H-v2/src/helpers.mjs). Static paths only. */
export const ICON_PATHS = Object.freeze({
  piano: [
    'M3 21V5.5A2.5 2.5 0 0 1 5.5 3H12c3.6 0 5 3.2 6.6 6 1.4 2.4 2.4 4.2 2.4 7v5H3z', 'M3 16.5h18',
    'M7 16.5V21M11 16.5V21M15 16.5V21',
  ],
  pad: ['M2 12c2.5-5 5-5 7.5 0s5 5 7.5 0 3.5-3 5-2'],
  extra: ['M12 3v4M12 17v4M3 12h4M17 12h4', 'M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6'],
  bass: ['M9 18a3 3 0 1 1-3-3h3V4l10-2v12', 'M19 14a3 3 0 1 1-3-3h3'],
  drone: ['M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0', 'M12 12m-7.5 0a7.5 7.5 0 1 0 15 0a7.5 7.5 0 1 0-15 0'],
  room: ['M4 21V10a8 8 0 0 1 16 0v11', 'M8 21v-9a4 4 0 0 1 8 0v9', 'M2 21h20'],
  echo: ['M4 12h2M9 12h2M14 12h2', 'M20 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0z'],
  chorus: ['M3 12c1.5-3 3-3 4.5 0s3 3 4.5 0 3-3 4.5 0 3 3 4.5 0'],
  master: ['M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3', 'M1 14h6M9 8h6M17 16h6'],
  keyboard: ['M2 6h20v12H2z', 'M6.5 6v7M10 6v7M14 6v7M17.5 6v7', 'M2 13h20'],
  notes: ['M6 3h9l4 4v14H6z', 'M9 11h7M9 15h7M9 7h4'],
  tempo: ['M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0', 'M12 12m-7.5 0a7.5 7.5 0 1 0 15 0a7.5 7.5 0 1 0-15 0'],
  song: ['M9 18V5l12-2v13', 'M9 18a3 3 0 1 1-3-3h3', 'M21 16a3 3 0 1 1-3-3h3'],
  dots: ['M5 12h.01M12 12h.01M19 12h.01'],
  down: ['M6 9l6 6 6-6'],
  right: ['M9 6l6 6-6 6'],
  close: ['M6 6l12 12M18 6L6 18'],
  plus: ['M12 5v14M5 12h14'],
});
/**
 * An inline stroke icon.
 * @param {keyof ICON_PATHS} name
 * @param {number} [size=18]
 * @returns {SVGSVGElement}
 */
export function icon(name, size = 18) {
  const s = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({
    class: 'ev2-ic', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': name === 'dots' ? 3 : 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })) s.setAttribute(k, String(v));
  for (const d of ICON_PATHS[name] || []) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    s.append(p);
  }
  return s;
}

// ---------------------------------------------------------------------------------------------------------------
// values, paths, formatting (copied from views/edit.js so the old view keeps its own exports untouched)
export const MINUS = '−';
/** @param {number} n @returns {string} "+2" / "−1" / "0" */
export const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `${MINUS}${Math.abs(n)}` : '0');
/** @param {number} v 0..1 @returns {string} "25%" */
export const pct = (v) => `${Math.round(Number(v) * 100)}%`;
/** "+2 semitones" / "0 semitones" / "−1 semitone" */
export const semitones = (v) => {
  const n = Math.round(Number(v) || 0);
  return `${signed(n)} semitone${Math.abs(n) === 1 ? '' : 's'}`;
};

/** Read a dotted path of an object ('patch.slots.0.gain'). */
export function getIn(obj, rel) {
  if (!rel) return obj;
  let o = obj;
  for (const s of rel.split('.')) {
    if (o === null || o === undefined) return undefined;
    o = o[s];
  }
  return o;
}
/** Shallow-or-JSON equality used by the bindings. */
export const sameVal = (a, b) =>
  a === b || (typeof a === 'object' && typeof b === 'object' && a && b && JSON.stringify(a) === JSON.stringify(b));
/** Two dotted paths overlap when one is a prefix of the other. */
export const overlaps = (a, b) => a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);

/**
 * Store address → path relative to a Song object. §4 addresses ('slots.0.gain', 'fx.reverb.size', 'master.volume',
 * 'drone.gain') and 'song.<field>' aliases both work.
 * @param {string} addr
 * @returns {string} e.g. 'patch.slots.0.gain'
 */
export function relOf(addr) {
  if (addr.startsWith('song.')) return addr.slice(5);
  if (addr === 'master.volume') return 'patch.fx.master.volume';
  if (addr.startsWith('drone.')) return addr;
  return `patch.${addr}`;
}
/** A §4 param that exists in this build's PARAMS table (feature detection for newer engine params). */
export const hasParam = (addr) => {
  const d = describe(addr);
  return !!d && !d.dynamic;
};

/** Human value for an instrument param (metadata from engine.listInstruments()). */
export function formatInstrumentParam(p, v) {
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (typeof v === 'string') return v;
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (p.unit === 's') return n < 1 ? `${Math.round(n * 1000)} ms` : `${n.toFixed(2)} s`;
  if (p.unit === 'Hz') {
    if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)} kHz`;
    return n >= 10 ? `${Math.round(n)} Hz` : `${n.toFixed(2)} Hz`;
  }
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
/** Save text as a download (library / song export). */
export function download(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export const today = () => new Date().toISOString().slice(0, 10);
export const safeName = (s) => String(s || 'song').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);

// ---------------------------------------------------------------------------------------------------------------
// the rig's blocks (tabs) — the selection model's vocabulary (CONTRACT.md §2)
const SLOT_ROLES = ['Keys', 'Pad', 'Extra', 'Bass'];
/**
 * Block ids in tab order. `panel` = the registered panel module, `opts` = its mount options, `prefixes` = the
 * song-relative paths whose song-diff changes put a white dot on the tab.
 * @type {ReadonlyArray<{id:string, panel:string, opts:object, role:string, color:string, prefixes:string[],
 *   shared?:boolean}>}
 */
export const BLOCKS = Object.freeze([
  ...Array.from({ length: SLOT_COUNT }, (_, i) => Object.freeze({
    id: `slot:${i}`, panel: 'slot', opts: Object.freeze({ slot: i }), role: SLOT_ROLES[i] || `Slot ${i + 1}`,
    color: `var(--slot-${i})`, prefixes: Object.freeze([`patch.slots.${i}`]),
  })),
  Object.freeze({
    id: 'drone', panel: 'drone', opts: Object.freeze({}), role: 'Drone', color: 'var(--drone, #e8d9a8)',
    prefixes: Object.freeze(['drone']),
  }),
  Object.freeze({
    id: 'effects', panel: 'effects', opts: Object.freeze({}), role: 'Effects', color: 'var(--fx, #9fb3c8)',
    shared: true,
    prefixes: Object.freeze(['patch.fx.reverb', 'patch.fx.delay', 'patch.fx.chorus']),
  }),
  Object.freeze({
    id: 'master', panel: 'master', opts: Object.freeze({}), role: 'Master', color: 'var(--fx, #9fb3c8)', shared: true,
    prefixes: Object.freeze([
      'patch.fx.lofi', 'patch.fx.eq', 'patch.fx.comp', 'patch.swell', 'patch.modWheel', 'patch.expression',
      'patch.bend', 'patch.volume',
    ]),
  }),
]);
/** The 'song' block has no tab (header chips select it). */
export const SONG_BLOCK = Object.freeze({
  id: 'song', panel: 'song', opts: Object.freeze({}), role: 'Song', color: 'var(--accent, #ffc94d)',
  prefixes: Object.freeze(['hearIn', 'playIn', 'transposeOctave', 'minor', 'tempo', 'name', 'notes']),
});
/**
 * Resolve a block id ('slot:2', 'drone', 'effects', 'master', 'song').
 * @param {string} id
 * @returns {object|null} the BLOCKS / SONG_BLOCK entry
 */
export function blockOf(id) {
  if (id === 'song') return SONG_BLOCK;
  return BLOCKS.find((b) => b.id === id) || null;
}

// ---------------------------------------------------------------------------------------------------------------
// changed dots (H-v2 concept §2)
/** Inline white dot placed before a changed value. @returns {HTMLElement} */
export const changedDot = (title = 'Changed since the song was loaded') =>
  h('em.ev2-cdi', { title, 'aria-label': 'changed' });
/** Footer copy: "1 change since the song was loaded". @param {number} n */
export const changeText = (n) =>
  (n === 0 ? 'No changes since the song was loaded' : `${n} change${n === 1 ? '' : 's'} since the song was loaded`);

// ---------------------------------------------------------------------------------------------------------------
// sentence titles
/**
 * Build an H-v2 sentence. Parts:
 *  - 'plain text'
 *  - {text, role:true}                      the block's role word (coloured --c, bold caps)
 *  - {text, control, changed?, title?}      an underlined word; a click calls onToken(part) (the shell focuses the
 *                                           control). `control` = CSS selector (resolved inside the panel body), an
 *                                           Element, or () => Element.
 *  - {text, changed:true}                   bold value with a changed dot, no control
 * @param {Array<string|object>} parts
 * @param {{onToken?:(part:object, el:HTMLElement) => void}} [o]
 * @returns {HTMLElement} span.ev2-sent
 */
export function sentence(parts, { onToken } = {}) {
  const out = h('span.ev2-sent');
  for (const p of parts || []) {
    if (p === null || p === undefined || p === false) continue;
    if (typeof p === 'string' || typeof p === 'number') {
      out.append(String(p));
      continue;
    }
    if (p.changed) out.append(changedDot());
    if (p.role) {
      out.append(h('span.ev2-sent-role', { text: p.text }));
    } else if (p.control) {
      const b = h('button.ev2-tok', { type: 'button', title: p.title || `Go to ${p.text}`, text: p.text });
      b.addEventListener('click', () => onToken && onToken(p, b));
      out.append(b);
    } else {
      out.append(h('b.ev2-sent-val', { text: p.text }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// bindings: targeted store → view refresh (the edit.js bindCtl/bindFn/refresh pattern, per panel)
/**
 * Create a binder for one panel instance. It subscribes through ctx.subscribe (auto-cleaned with the panel) and
 * refreshes only the bindings whose song-relative path overlaps a changed path; on a song switch every binding is
 * re-applied. Text-like bindings (`text:true`) never overwrite a focused field.
 * @param {object} ctx  the panel ctx (CONTRACT.md §3)
 * @returns {{ctl:Function, fn:Function, refresh:Function, track:Function, cancelDrags:Function, destroy:Function}}
 */
export function createBinder(ctx) {
  /** @type {Set<object>} */
  const binds = new Set();
  const comps = [];
  const apply = (b, song, force) => {
    if (!song) return;
    if (b.fnBind) {
      b.cb(song);
      return;
    }
    const v = b.read(song);
    if (!force && sameVal(v, b.last)) return;
    if (b.text && b.comp.el && b.comp.el.contains(document.activeElement)) return;
    b.last = v;
    if (v !== undefined) b.comp.set(v);
  };
  const api = {
    /**
     * Bind a component ({el, set(v), destroy?}) to a store address. Writes go through `write(v)` when given, else
     * ctx.set(addr, v). Sets el.dataset.bind = addr.
     * @param {string} addr   §4 address or 'song.<field>'
     * @param {(onChange:(v:any)=>void) => {el:HTMLElement, set:Function}} make
     * @param {{read?:(song)=>any, write?:(v)=>void, text?:boolean}} [o]
     */
    ctl(addr, make, { read, write, text } = {}) {
      const rel = relOf(addr);
      const comp = make((v) => (write ? write(v) : ctx.set(addr, v)));
      if (comp.el) comp.el.dataset.bind = addr;
      const def = hasParam(addr) ? describe(addr).default : undefined;
      const b = { rels: [rel], comp, read: read || ((s) => getIn(s, rel) ?? def), last: undefined, text };
      binds.add(b);
      comps.push(comp);
      apply(b, ctx.song(), true);
      return comp;
    },
    /** Run cb(song) now and whenever a path overlapping one of `rels` (song-relative) changes. */
    fn(rels, cb) {
      const b = { rels, fnBind: true, cb };
      binds.add(b);
      const s = ctx.song();
      if (s) cb(s);
      return b;
    },
    /** Remember a component so destroy() / cancelDrags() reach it. */
    track(comp) {
      comps.push(comp);
      return comp;
    },
    /** Re-apply bindings overlapping `rels` (null = all, forced). */
    refresh(rels) {
      const s = ctx.song();
      if (!s) return;
      for (const b of binds) {
        if (!rels) apply(b, s, true);
        else if (b.rels.some((r) => rels.some((x) => overlaps(x, r)))) apply(b, s, false);
      }
    },
    /** Abandon pointer drags (round2-ui #2); the shell also calls this on a song switch via onLeaveSong. */
    cancelDrags() {
      for (const c of comps) c.cancelDrag?.();
    },
    destroy() {
      for (const c of comps.splice(0)) {
        try {
          c.destroy?.();
        } catch (err) {
          console.warn('[edit] destroy failed', err);
        }
      }
      binds.clear();
    },
  };
  ctx.subscribe((e) => {
    if (e.songChanged || e.full) api.refresh(null);
    else if (e.rels.length) api.refresh(e.rels);
  });
  ctx.onLeaveSong(() => api.cancelDrags());
  return api;
}

// ---------------------------------------------------------------------------------------------------------------
// collapsible sections (per-viewer open state, like ui-edit-2's SECTIONS_KEY but a new key for the new ids)
export const SECTIONS_KEY_V2 = 'worship-rig.edit2.sections';
function readSections() {
  try {
    const o = JSON.parse(globalThis.localStorage?.getItem(SECTIONS_KEY_V2) || '{}');
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}
/**
 * `<details class="ev2-sec">` closed by default; its open state is remembered per id in localStorage; the header
 * carries a one-line summary refreshed through `binder.fn(rels, …)`.
 * @param {string} id  globally unique, prefix it with your panel ('fx-reverb', 'master-tape', 'slot0-adv')
 * @param {string} title
 * @param {{open?:boolean, summary?:(song)=>string, rels?:string[], binder?:object, cls?:string}} o
 * @param {...Node} children
 * @returns {HTMLDetailsElement}
 */
export function section(id, title, { open = false, summary, rels = [], binder, cls = '' } = {}, ...children) {
  const sum = h('span.ev2-sec-sum');
  const det = h('details.ev2-sec', { class: cls, dataset: { sec: id } },
    h('summary.ev2-sec-head', {}, icon('right', 14), h('span.ev2-sec-title', { text: title }), sum),
    h('div.ev2-sec-body', {}, ...children),
  );
  const st = readSections();
  det.open = typeof st[id] === 'boolean' ? st[id] : open;
  det.addEventListener('toggle', () => {
    const cur = readSections();
    if (cur[id] === det.open) return;
    cur[id] = det.open;
    try {
      globalThis.localStorage?.setItem(SECTIONS_KEY_V2, JSON.stringify(cur));
    } catch {
      /* private window / quota: open state is a convenience only */
    }
  });
  if (summary && binder) binder.fn(rels, (s) => setText(sum, summary(s)));
  return det;
}

// ---------------------------------------------------------------------------------------------------------------
// word slider (H implementation §1 `wordSlider`; lives here because components/* belong to the Perform agent)
const POS_MAX = 1000;
/**
 * Position 0..1000 ↔ value, per curve: 'lin', 'log' (min > 0), 'taper' (gains: 2·pos³ over 0..2).
 * @returns {{toPos:(v:number)=>number, toVal:(p:number)=>number}}
 */
export function sliderScale(min, max, curve = 'lin') {
  if (curve === 'taper') {
    return {
      toPos: (v) => Math.round(inverseTaper(v) * POS_MAX),
      toVal: (p) => faderTaper(p / POS_MAX),
    };
  }
  if (curve === 'log' && min > 0) {
    const a = Math.log(min);
    const b = Math.log(max);
    return {
      toPos: (v) => Math.round(((Math.log(Math.max(min, Math.min(max, v))) - a) / (b - a)) * POS_MAX),
      toVal: (p) => Math.exp(a + (p / POS_MAX) * (b - a)),
    };
  }
  return {
    toPos: (v) => Math.round(((Math.max(min, Math.min(max, v)) - min) / (max - min)) * POS_MAX),
    toVal: (p) => min + (p / POS_MAX) * (max - min),
  };
}
/**
 * Word slider: label + word value (number beside it) over a thick track, end words under it. A native
 * `<input type=range min=0 max=1000>` (keyboard, screen readers, tests via input/change events).
 * Double-click resets to `default`. `bipolar` fills from the centre.
 * @param {object} o
 * @param {string} o.label
 * @param {number} [o.min=0]
 * @param {number} [o.max=1]
 * @param {'lin'|'log'|'taper'} [o.curve='lin']
 * @param {number} [o.step]              value quantum (1 = integers)
 * @param {number} [o.default]
 * @param {(v:number) => string} [o.word]    'Bright' / 'Neutral' …
 * @param {(v:number) => string} [o.format]  the small number beside the word ('100%', '0.35 s')
 * @param {[string,string]} [o.ends]    ['darker', 'brighter']
 * @param {boolean} [o.bipolar]
 * @param {string} [o.color]            track fill (sets --c); default: inherits the panel's --c
 * @param {(v:number) => void} [o.onChange]
 * @returns {{el:HTMLElement, input:HTMLInputElement, set(v:number):void, get():number, setDisabled(b:boolean):void,
 *            cancelDrag():void, destroy():void}}
 */
export function wordSlider(o = {}) {
  const { label = '', min = 0, max = 1, curve = 'lin', step, word, format, ends, bipolar, color, onChange } = o;
  const scale = sliderScale(min, max, curve);
  const def = Number.isFinite(o.default) ? o.default : min;
  const input = h('input.ev2-ws-input', { type: 'range', min: 0, max: POS_MAX, step: 1, 'aria-label': label });
  const wordEl = h('span.ev2-ws-word');
  const numEl = h('small.ev2-ws-num');
  const el = h('div.ev2-ws', { class: bipolar ? 'bipolar' : '', style: color ? { '--c': color } : undefined },
    h('div.ev2-ws-head', {}, h('b.ev2-ws-label', { text: label }), h('span.ev2-ws-val', {}, wordEl, numEl)),
    h('div.ev2-ws-track', {}, input),
    ends ? h('div.ev2-ws-ends', {}, h('span', { text: ends[0] }), h('span', { text: ends[1] })) : null,
  );
  let value = Number.isFinite(o.value) ? o.value : def;
  let dead = false; // cancelDrag(): ignore this pointer's movement until it goes up
  const quant = (v) => (step ? Math.round(v / step) * step : v);
  const paint = () => {
    const p = scale.toPos(value);
    if (Number(input.value) !== p && document.activeElement !== input) input.value = String(p);
    const f = Number(input.value) / POS_MAX;
    el.style.setProperty('--p', String(f));
    setText(wordEl, word ? word(value) : '');
    setText(numEl, format ? format(value) : String(Math.round(value * 100) / 100));
    input.setAttribute('aria-valuetext', `${word ? `${word(value)} ` : ''}${format ? format(value) : value}`);
  };
  const commit = () => {
    if (dead) return;
    const v = quant(scale.toVal(Number(input.value)));
    if (v === value) return paint();
    value = v;
    paint();
    onChange && onChange(v);
  };
  input.addEventListener('input', commit);
  input.addEventListener('change', commit);
  input.addEventListener('pointerdown', () => {
    dead = false;
  });
  input.addEventListener('pointerup', () => {
    dead = false;
  });
  input.addEventListener('dblclick', () => {
    value = def;
    input.value = String(scale.toPos(def));
    paint();
    onChange && onChange(def);
  });
  paint();
  return {
    el,
    input,
    set(v) {
      const n = Number(v);
      if (!Number.isFinite(n)) return;
      value = n;
      input.value = String(scale.toPos(n));
      paint();
    },
    get: () => value,
    setDisabled(b) {
      input.disabled = !!b;
      el.classList.toggle('disabled', !!b);
    },
    cancelDrag() {
      dead = true;
    },
    destroy() {
      el.remove();
    },
  };
}
