// Minimal stand-ins for ui-core's component library (SPEC §13), used by settings.js and the H-v2 Edit
// (views/edit/shell.js, ctx.C) ONLY when
// ./components/index.js cannot be imported. Same call shapes: every factory takes an options object with an
// onChange-style callback and returns { el, set(value), destroy() } (+ a few extras ui-core also exposes:
// input, get(), setDisabled()). Plain native inputs; styled by styles-edit.css (.fc-*).
//
// loadComponents() merges ui-core's exports OVER these, so a missing ui-core export still has a stand-in.
import { describe, formatValue } from '../shared/params.js';
import { keyName, noteName } from '../shared/music.js';

let loading = null;
/**
 * Resolve the component set: ui-core's ./components/index.js when it imports, else these fallbacks.
 * @returns {Promise<Record<string, Function> & {__source:'ui-core'|'fallback'}>}
 */
export function loadComponents() {
  if (!loading) {
    // test hook: the settings fixture (test/phase2/settings) and the edit-v2 harness (?components=fallback) set this to
    // exercise the fallback set even when ui-core's exists
    if (globalThis.__RIG_FORCE_FALLBACK_COMPONENTS === true) return (loading = Promise.resolve({ ...FALLBACK, __source: 'fallback' }));
    loading = import('./components/index.js').then(
      (m) => ({ ...FALLBACK, ...m, __source: 'ui-core' }),
      (err) => {
        console.warn(`[ui-edit] components/index.js unavailable (${err && err.message}); using fallback components`);
        return { ...FALLBACK, __source: 'fallback' };
      },
    );
  }
  return loading;
}

/**
 * Shared "a dialog is open" flag for Edit confirms and the Settings modal (reviews/ux.md M1): while any token is
 * open, document.body.dataset.dialogOpen === '1'. An observable state flag (tests, styling); main.js does not read
 * it: Esc already never panics outside Perform, and a confirm left open in the hidden Edit view would keep the flag
 * up and disarm Esc = Panic in Perform (round2-ui #9).
 * @param {string} token  who is open ('edit', 'settings', …)
 * @param {boolean} open
 */
export function markDialog(token, open) {
  const set = (globalThis.__rigOpenDialogs ||= new Set());
  if (open) set.add(token);
  else set.delete(token);
  const body = typeof document !== 'undefined' ? document.body : null;
  if (!body) return;
  if (set.size) body.dataset.dialogOpen = '1';
  else delete body.dataset.dialogOpen;
}

// ---------------------------------------------------------------------------------------------------------------
function el(tag, cls, attrs = {}) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') e.textContent = String(v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, String(v));
  }
  return e;
}
let uid = 0;
const nextId = (p) => `fc-${p}-${++uid}`;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function rafCoalesce(fn) {
  let id = 0;
  let val;
  let has = false;
  const run = () => {
    id = 0;
    if (!has) return;
    has = false;
    fn(val);
  };
  return {
    push(v) {
      val = v;
      has = true;
      if (!id) id = requestAnimationFrame(run);
    },
    flush() {
      if (id) cancelAnimationFrame(id);
      run();
    },
    cancel() {
      if (id) cancelAnimationFrame(id);
      id = 0;
      has = false;
    },
  };
}

function posToValue(p, { min, max, curve }) {
  if (curve === 'log' && min > 0 && max > min) return min * Math.pow(max / min, p);
  if (curve === 'taper') return min + (max - min) * p * p * p;
  return min + (max - min) * p;
}
function valueToPos(v, { min, max, curve }) {
  const n = Number(v);
  if (!Number.isFinite(n) || max === min) return 0;
  if (curve === 'log' && min > 0 && max > min) return clamp(Math.log(Math.max(n, min) / min) / Math.log(max / min), 0, 1);
  const x = clamp((n - min) / (max - min), 0, 1);
  return curve === 'taper' ? Math.cbrt(x) : x;
}

/** fader({label, path, color, min, max, curve, unit, step, default, format, vertical, value, onChange}) */
export function fader(o = {}) {
  const e = o.path ? describe(o.path) : null;
  const min = Number.isFinite(o.min) ? o.min : Number.isFinite(e?.min) ? e.min : 0;
  const max = Number.isFinite(o.max) ? o.max : Number.isFinite(e?.max) ? e.max : 1;
  const unit = o.unit ?? e?.unit ?? 'lin';
  const curve = o.curve ?? (unit === 'dB-display' ? 'taper' : e?.curve ?? 'lin');
  const step = o.step ?? e?.step;
  const def = o.default ?? (e && typeof e.default === 'number' ? e.default : min);
  const format = o.format || (o.path && e && !e.dynamic ? (v) => formatValue(o.path, v) : (v) => String(Math.round(Number(v) * 100) / 100));
  const shape = { min, max, curve };
  const id = nextId('fader');
  const root = el('div', `fc-fader${o.vertical ? ' vertical' : ''}${o.compact ? ' compact' : ''}`);
  const label = el('label', 'fc-label', { for: id, text: o.label || '' });
  const input = el('input', 'fc-range', { type: 'range', id, min: 0, max: 1000, step: 1, 'aria-label': o.label || o.path || 'Level' });
  const out = el('output', 'fc-value', { for: id });
  root.append(label, input, out);
  if (o.color) root.style.setProperty('--fc-color', o.color);
  let value = Number.isFinite(o.value) ? o.value : def;
  const q = (v) => {
    let x = clamp(v, Math.min(min, max), Math.max(min, max));
    if (step === 1) x = Math.round(x);
    else if (step > 0) x = Math.round(x / step) * step;
    return x;
  };
  const render = () => {
    const pos = valueToPos(value, shape);
    input.value = String(Math.round(pos * 1000));
    input.style.setProperty('--pos', `${(pos * 100).toFixed(1)}%`);
    const t = format(value);
    out.textContent = t;
    input.setAttribute('aria-valuetext', t);
  };
  const emit = rafCoalesce((v) => o.onChange && o.onChange(v));
  // round2-ui #2: cancelDrag() (song switch mid-drag) drops pending and later movement until the pointer goes up
  let down = false;
  let ignore = false;
  const onDown = () => {
    down = true;
  };
  const onUp = () => {
    down = false;
    if (ignore) setTimeout(() => (ignore = false), 0);
  };
  const onInput = () => {
    if (ignore) {
      render();
      return;
    }
    value = q(posToValue(Number(input.value) / 1000, shape));
    render();
    emit.push(value);
  };
  const onChangeEv = () => emit.flush();
  const onDbl = (ev) => {
    if (input.disabled) return;
    ev.preventDefault();
    value = q(def);
    render();
    emit.cancel();
    if (o.onChange) o.onChange(value);
  };
  input.addEventListener('input', onInput);
  input.addEventListener('change', onChangeEv);
  input.addEventListener('pointerdown', onDown);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  root.addEventListener('dblclick', onDbl);
  render();
  return {
    el: root,
    input,
    set(v) {
      const n = Number(v);
      if (!Number.isFinite(n)) return;
      value = n;
      render();
    },
    get: () => value,
    setDisabled(b) {
      input.disabled = !!b;
      root.classList.toggle('disabled', !!b);
    },
    setMuted(b) {
      root.classList.toggle('muted', !!b);
    },
    cancelDrag() {
      emit.cancel();
      if (down) ignore = true;
    },
    destroy() {
      emit.cancel();
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      root.remove();
    },
  };
}

export function knob(o = {}) {
  const f = fader({ ...o, vertical: false, compact: true });
  f.el.classList.add('knob');
  return f;
}

/** toggle({label, value, onChange}) → switch button. */
export function toggle(o = {}) {
  const b = el('button', 'fc-toggle', { type: 'button', role: 'switch', 'aria-checked': 'false', title: o.title || null });
  const dot = el('span', 'fc-toggle-dot', { 'aria-hidden': 'true' });
  const lab = el('span', 'fc-toggle-label', { text: o.label || '' });
  b.append(dot, lab);
  let on = !!o.value;
  const render = () => {
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.classList.toggle('on', on);
  };
  const click = () => {
    on = !on;
    render();
    if (o.onChange) o.onChange(on);
  };
  b.addEventListener('click', click);
  render();
  return {
    el: b,
    set(v) {
      on = !!v;
      render();
    },
    get: () => on,
    setDisabled(d) {
      b.disabled = !!d;
    },
    destroy() {
      b.remove();
    },
  };
}

/** segmented({label, options:[{value,label}], value, onChange}) → radiogroup of buttons. */
export function segmented(o = {}) {
  const root = el('div', 'fc-seg', { role: 'radiogroup', 'aria-label': o.label || null });
  let value = o.value;
  const btns = (o.options || []).map((opt) => {
    const b = el('button', 'fc-seg-btn', { type: 'button', role: 'radio', text: opt.label ?? String(opt.value), title: opt.title || null });
    b.dataset.value = String(opt.value);
    b.addEventListener('click', () => {
      value = opt.value;
      render();
      if (o.onChange) o.onChange(opt.value);
    });
    root.append(b);
    return [opt, b];
  });
  const render = () => {
    for (const [opt, b] of btns) {
      const on = String(opt.value) === String(value);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.classList.toggle('on', on);
    }
  };
  render();
  return {
    el: root,
    set(v) {
      value = v;
      render();
    },
    get: () => value,
    setDisabled(d) {
      for (const [, b] of btns) b.disabled = !!d;
    },
    destroy() {
      root.remove();
    },
  };
}

/** select({label, options:[{value,label,group?}], value, onChange}) → native <select> (optgroups by `group`). */
export function select(o = {}) {
  const id = nextId('select');
  const s = el('select', 'fc-select', { id, 'aria-label': o.label || null });
  const wrap = el('div', 'fc-selectwrap');
  if (o.label) wrap.append(el('label', 'fc-label', { for: id, text: o.label }));
  wrap.append(s);
  const groups = new Map();
  for (const opt of o.options || []) {
    const op = el('option', '', { value: String(opt.value), text: opt.label ?? String(opt.value) });
    if (opt.group) {
      let g = groups.get(opt.group);
      if (!g) {
        g = el('optgroup', '', { label: opt.group });
        groups.set(opt.group, g);
        s.append(g);
      }
      g.append(op);
    } else s.append(op);
  }
  const values = (o.options || []).map((x) => x.value);
  if (o.value !== undefined) s.value = String(o.value);
  s.addEventListener('change', () => {
    const v = values.find((x) => String(x) === s.value);
    if (o.onChange) o.onChange(v === undefined ? s.value : v);
  });
  return {
    el: wrap,
    input: s,
    set(v) {
      if (v !== undefined && v !== null) s.value = String(v);
    },
    get: () => s.value,
    setDisabled(d) {
      s.disabled = !!d;
    },
    destroy() {
      wrap.remove();
    },
  };
}

/** stepper({label, min, max, step, value, format, onChange}) → − value + */
export function stepper(o = {}) {
  const min = o.min ?? -Infinity;
  const max = o.max ?? Infinity;
  const step = o.step || 1;
  const fmt = o.format || ((v) => String(v));
  const root = el('div', 'fc-stepper', { role: 'group', 'aria-label': o.label || null });
  if (o.label) root.append(el('span', 'fc-label', { text: o.label }));
  const dec = el('button', 'fc-step-btn', { type: 'button', text: '−', 'aria-label': `${o.label || 'Value'} down` });
  const val = el('span', 'fc-step-val', { role: 'spinbutton', tabindex: 0, 'aria-label': o.label || null });
  const inc = el('button', 'fc-step-btn', { type: 'button', text: '+', 'aria-label': `${o.label || 'Value'} up` });
  root.append(dec, val, inc);
  let value = Number.isFinite(o.value) ? o.value : Math.max(min, Math.min(max, 0));
  const render = () => {
    val.textContent = fmt(value);
    val.setAttribute('aria-valuenow', String(value));
    dec.disabled = value <= min;
    inc.disabled = value >= max;
  };
  const bump = (d) => {
    const n = clamp(value + d * step, min, max);
    if (n === value) return;
    value = n;
    render();
    if (o.onChange) o.onChange(value);
  };
  dec.addEventListener('click', () => bump(-1));
  inc.addEventListener('click', () => bump(1));
  val.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') bump(1);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') bump(-1);
    else return;
    e.preventDefault();
  });
  render();
  return {
    el: root,
    set(v) {
      const n = Number(v);
      if (!Number.isFinite(n)) return;
      value = n;
      render();
    },
    get: () => value,
    destroy() {
      root.remove();
    },
  };
}

/** keyGrid({onSelect(pc)}) — 12 keys; set({pc, minor}). */
export function keyGrid(o = {}) {
  const root = el('div', 'fc-keygrid', { role: 'group', 'aria-label': 'Key' });
  let cur = { pc: 0, minor: false };
  const btns = Array.from({ length: 12 }, (_, pc) => {
    const b = el('button', 'fc-key', { type: 'button' });
    b.addEventListener('click', () => o.onSelect && o.onSelect(pc));
    root.append(b);
    return b;
  });
  const render = () =>
    btns.forEach((b, pc) => {
      b.textContent = keyName(pc, cur.minor);
      b.classList.toggle('on', pc === cur.pc);
      b.setAttribute('aria-pressed', pc === cur.pc ? 'true' : 'false');
    });
  render();
  return {
    el: root,
    set(v) {
      if (v && typeof v === 'object') cur = { pc: v.pc ?? cur.pc, minor: !!v.minor };
      render();
    },
    destroy() {
      root.remove();
    },
  };
}

const BLACK = new Set([1, 3, 6, 8, 10]);
function keyLayout(from, to) {
  const whites = [];
  for (let n = from; n <= to; n++) if (!BLACK.has(n % 12)) whites.push(n);
  return whites;
}

/** miniKeyboard({low, high, onRange(low, high)}) — click sets the nearer bound; shift-click sets high. set({low, high}). */
export function miniKeyboard(o = {}) {
  const from = o.from ?? 21;
  const to = o.to ?? 108;
  let low = o.low ?? 0;
  let high = o.high ?? 127;
  const root = el('div', 'fc-mini', { role: 'group', 'aria-label': 'Key range' });
  const whites = keyLayout(from, to);
  const w = 100 / whites.length;
  const keys = new Map();
  let wi = 0;
  for (let n = from; n <= to; n++) {
    const black = BLACK.has(n % 12);
    const k = el('div', `fc-mini-key ${black ? 'black' : 'white'}`, { title: noteName(n) });
    k.style.left = `${(black ? wi - 0.3 : wi) * w}%`;
    k.style.width = `${(black ? 0.6 : 1) * w}%`;
    if (!black) wi++;
    k.dataset.note = String(n);
    keys.set(n, k);
    root.append(k);
  }
  const render = () => {
    for (const [n, k] of keys) k.classList.toggle('in', n >= low && n <= high);
  };
  root.addEventListener('pointerdown', (e) => {
    const n = Number(e.target && e.target.dataset && e.target.dataset.note);
    if (!Number.isFinite(n)) return;
    if (e.shiftKey || Math.abs(n - high) < Math.abs(n - low)) high = Math.max(n, low);
    else low = Math.min(n, high);
    render();
    if (o.onRange) o.onRange(low, high);
  });
  render();
  return {
    el: root,
    set(v) {
      if (v && typeof v === 'object') {
        low = v.low ?? low;
        high = v.high ?? high;
      }
      render();
    },
    destroy() {
      root.remove();
    },
  };
}

/** pianoKeyboard({from:36, to:96, onNoteOn, onNoteOff}) — clickable/draggable; set(heldSet) highlights. */
export function pianoKeyboard(o = {}) {
  const from = o.from ?? 36;
  const to = o.to ?? 96;
  const root = el('div', 'fc-piano', { role: 'group', 'aria-label': 'On-screen keyboard' });
  const whites = keyLayout(from, to);
  const w = 100 / whites.length;
  const keys = new Map();
  let wi = 0;
  for (let n = from; n <= to; n++) {
    const black = BLACK.has(n % 12);
    const k = el('div', `fc-piano-key ${black ? 'black' : 'white'}`, { title: noteName(n) });
    k.style.left = `${(black ? wi - 0.32 : wi) * w}%`;
    k.style.width = `${(black ? 0.64 : 1) * w}%`;
    if (!black) wi++;
    if (n % 12 === 0) k.append(el('span', 'fc-piano-label', { text: noteName(n) }));
    k.dataset.note = String(n);
    keys.set(n, k);
    root.append(k);
  }
  let down = null;
  const noteAt = (e) => {
    const t = document.elementFromPoint(e.clientX, e.clientY);
    const n = Number(t && t.dataset && t.dataset.note);
    return Number.isFinite(n) && keys.has(n) ? n : null;
  };
  const on = (n) => {
    down = n;
    keys.get(n)?.classList.add('down');
    if (o.onNoteOn) o.onNoteOn(n, 100);
  };
  const off = () => {
    if (down === null) return;
    keys.get(down)?.classList.remove('down');
    const n = down;
    down = null;
    if (o.onNoteOff) o.onNoteOff(n);
  };
  const pd = (e) => {
    const n = noteAt(e);
    if (n === null) return;
    e.preventDefault();
    root.setPointerCapture?.(e.pointerId);
    on(n);
  };
  const pm = (e) => {
    if (down === null) return;
    const n = noteAt(e);
    if (n !== null && n !== down) {
      off();
      on(n);
    }
  };
  root.addEventListener('pointerdown', pd);
  root.addEventListener('pointermove', pm);
  root.addEventListener('pointerup', off);
  root.addEventListener('pointercancel', off);
  root.addEventListener('lostpointercapture', off);
  return {
    el: root,
    set(held) {
      const s = held instanceof Set ? held : new Set(held || []);
      for (const [n, k] of keys) k.classList.toggle('held', s.has(n));
    },
    destroy() {
      off();
      root.remove();
    },
  };
}

/** meter({engine}) — stereo peak/RMS bars from engine.analyserL/R (rAF). */
export function meter(o = {}) {
  const root = el('div', 'fc-meter', { role: 'img', 'aria-label': 'Output level' });
  const bars = [el('div', 'fc-meter-bar'), el('div', 'fc-meter-bar')];
  for (const b of bars) {
    b.append(el('div', 'fc-meter-fill'));
    root.append(b);
  }
  let raf = 0;
  let buf = null;
  const level = (an) => {
    if (!an) return 0;
    if (!buf || buf.length !== an.fftSize) buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    let pk = 0;
    for (let i = 0; i < buf.length; i++) pk = Math.max(pk, Math.abs(buf[i]));
    const db = pk > 0 ? 20 * Math.log10(pk) : -120;
    return clamp((db + 60) / 60, 0, 1);
  };
  const loop = () => {
    raf = requestAnimationFrame(loop);
    if (!root.isConnected || root.offsetParent === null) return;
    const eng = o.engine;
    const v = [level(eng && eng.analyserL), level(eng && eng.analyserR)];
    bars.forEach((b, i) => b.firstChild.style.setProperty('--lvl', v[i].toFixed(3)));
  };
  raf = requestAnimationFrame(loop);
  return {
    el: root,
    set() {},
    destroy() {
      cancelAnimationFrame(raf);
      root.remove();
    },
  };
}

/** chordReadout() — set(chord|null). */
export function chordReadout() {
  const root = el('div', 'fc-chord', { 'aria-live': 'polite', text: '—' });
  return {
    el: root,
    set(c) {
      root.textContent = (c && (c.name || String(c))) || '—';
    },
    destroy() {
      root.remove();
    },
  };
}

/** wheelStrip({onSwell}) — set(value01). */
export function wheelStrip(o = {}) {
  const root = el('div', 'fc-wheel');
  const bar = el('div', 'fc-wheel-bar');
  const fill = el('div', 'fc-wheel-fill');
  bar.append(fill);
  const b = el('button', 'fc-btn', { type: 'button', text: 'Swell' });
  b.addEventListener('click', () => o.onSwell && o.onSwell());
  root.append(bar, b);
  return {
    el: root,
    set(v) {
      fill.style.setProperty('--lvl', String(clamp(Number(v) || 0, 0, 1)));
    },
    destroy() {
      root.remove();
    },
  };
}

/** setlistStrip({onSelect(id, index), onReorder}) — set({songs, currentId, loadingId}). */
export function setlistStrip(o = {}) {
  const root = el('div', 'fc-strip', { role: 'list' });
  return {
    el: root,
    set({ songs = [], currentId = null, loadingId = null } = {}) {
      root.replaceChildren(
        ...songs.map((s, i) => {
          const b = el('button', 'fc-strip-item', { type: 'button', role: 'listitem', text: s.name });
          b.classList.toggle('on', s.id === currentId);
          b.classList.toggle('loading', s.id === loadingId);
          b.addEventListener('click', () => o.onSelect && o.onSelect(s.id, i));
          return b;
        }),
      );
    },
    destroy() {
      root.remove();
    },
  };
}

const FALLBACK = Object.freeze({
  fader, knob, toggle, segmented, select, stepper, keyGrid, miniKeyboard, pianoKeyboard, meter, chordReadout, wheelStrip, setlistStrip,
});
export default FALLBACK;
