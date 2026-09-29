// keyGrid(), pianoKeyboard(), miniKeyboard() — SPEC §13.
import { keyName, noteName, mod12 } from '../../shared/music.js';
import { h, setText, disposer, clamp } from './util.js';

const BLACK = new Set([1, 3, 6, 8, 10]);
export const isBlack = (n) => BLACK.has(mod12(n));

/**
 * Key geometry for a keyboard spanning [from, to] (both inclusive). Positions are percentages of the width.
 * @returns {Array<{note:number, black:boolean, left:number, width:number}>}
 */
export function keyLayout(from, to) {
  const whites = [];
  for (let n = from; n <= to; n++) if (!isBlack(n)) whites.push(n);
  const ww = 100 / Math.max(1, whites.length);
  const out = [];
  let wi = 0;
  for (let n = from; n <= to; n++) {
    if (!isBlack(n)) {
      out.push({ note: n, black: false, left: wi * ww, width: ww });
      wi += 1;
    } else {
      const bw = ww * 0.62;
      out.push({ note: n, black: true, left: wi * ww - bw / 2, width: bw });
    }
  }
  return out;
}

/**
 * 12-key grid with proper key names (music.keyName). set({pc, minor}) highlights the current key.
 * @param {{onSelect?:(pc:number)=>void, label?:string, pc?:number, minor?:boolean}} o
 */
export function keyGrid(o = {}) {
  const d = disposer();
  const el = h('div.key-grid', { role: 'radiogroup', 'aria-label': o.label || 'Key' });
  let cur = { pc: Number.isInteger(o.pc) ? o.pc : null, minor: !!o.minor };
  const buttons = [];
  for (let pc = 0; pc < 12; pc++) {
    const b = h('button.key-btn', { type: 'button', role: 'radio', 'aria-checked': 'false', dataset: { pc: String(pc) } });
    if (isBlack(pc)) b.classList.add('accidental');
    b.addEventListener('click', (ev) => {
      if (typeof o.onSelect === 'function') o.onSelect(pc);
      if (ev.detail > 0) queueMicrotask(() => b.blur());
    });
    b.addEventListener('keydown', (ev) => {
      const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 6, ArrowUp: -6 }[ev.key];
      if (!step) return;
      ev.preventDefault();
      ev.stopPropagation();
      const next = mod12(pc + step);
      buttons[next].focus();
      if (typeof o.onSelect === 'function') o.onSelect(next);
    });
    buttons.push(b);
    el.append(b);
  }
  const render = () => {
    buttons.forEach((b, pc) => {
      setText(b, keyName(pc, cur.minor));
      const sel = pc === cur.pc;
      b.setAttribute('aria-checked', String(sel));
      b.classList.toggle('on', sel);
      b.tabIndex = sel || (cur.pc === null && pc === 0) ? 0 : -1;
    });
  };
  render();
  return {
    el,
    /** @param {{pc:number, minor?:boolean}} v */
    set(v) {
      if (!v) return;
      cur = { pc: Number.isInteger(v.pc) ? mod12(v.pc) : null, minor: !!v.minor };
      render();
    },
    setDisabled(b) {
      for (const x of buttons) x.disabled = !!b;
    },
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}

/**
 * Clickable/draggable piano (default 61 keys, C2..C7). set(heldSet) highlights held notes.
 * Pointer velocity: lower on the key = louder (40..127). Glissando while the pointer is held.
 * @param {{from?:number, to?:number, onNoteOn?:(note:number, vel:number)=>void, onNoteOff?:(note:number)=>void,
 *          label?:string, labels?:boolean}} o
 */
export function pianoKeyboard(o = {}) {
  const d = disposer();
  const from = Number.isInteger(o.from) ? o.from : 36;
  const to = Number.isInteger(o.to) ? o.to : 96;
  const el = h('div.piano', { role: 'group', 'aria-label': o.label || 'On-screen keyboard' });
  const keys = new Map();
  for (const k of keyLayout(from, to)) {
    const key = h(`div.pkey${k.black ? '.black' : '.white'}`, {
      dataset: { note: String(k.note) },
      style: { left: `${k.left}%`, width: `${k.width}%` },
      title: noteName(k.note),
    });
    if (!k.black && mod12(k.note) === 0 && o.labels !== false) key.append(h('span.pkey-label', { text: noteName(k.note) }));
    keys.set(k.note, key);
    el.append(key);
  }
  const active = new Map(); // pointerId → note
  let held = new Set();
  const letterEls = new Map(); // note → span.pkey-letter

  const noteAt = (x, y) => {
    const t = document.elementFromPoint(x, y);
    const k = t && t.closest ? t.closest('.pkey') : null;
    return k && el.contains(k) ? Number(k.dataset.note) : null;
  };
  const velAt = (note, y) => {
    const k = keys.get(note);
    if (!k) return 100;
    const r = k.getBoundingClientRect();
    const f = r.height > 0 ? clamp((y - r.top) / r.height, 0, 1) : 0.6;
    return Math.round(40 + 87 * f);
  };
  const press = (pid, note, y) => {
    active.set(pid, note);
    keys.get(note)?.classList.add('pressed');
    if (typeof o.onNoteOn === 'function') o.onNoteOn(note, velAt(note, y));
  };
  const release = (pid) => {
    const note = active.get(pid);
    if (note === undefined) return;
    active.delete(pid);
    if (![...active.values()].includes(note)) keys.get(note)?.classList.remove('pressed');
    if (typeof o.onNoteOff === 'function') o.onNoteOff(note);
  };
  d.listen(el, 'pointerdown', (ev) => {
    if (ev.button !== undefined && ev.button !== 0) return;
    const note = noteAt(ev.clientX, ev.clientY);
    if (note === null) return;
    ev.preventDefault();
    try {
      el.setPointerCapture(ev.pointerId);
    } catch {
      /* synthetic pointers */
    }
    press(ev.pointerId, note, ev.clientY);
  });
  d.listen(el, 'pointermove', (ev) => {
    if (!active.has(ev.pointerId)) return;
    const note = noteAt(ev.clientX, ev.clientY);
    if (note === null || note === active.get(ev.pointerId)) return;
    release(ev.pointerId);
    press(ev.pointerId, note, ev.clientY);
  });
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) d.listen(el, t, (ev) => release(ev.pointerId));
  d.listen(el, 'contextmenu', (ev) => ev.preventDefault());

  return {
    el,
    /** @param {Set<number>|number[]} heldSet */
    set(heldSet) {
      const next = new Set(heldSet || []);
      for (const n of held) if (!next.has(n)) keys.get(n)?.classList.remove('held');
      for (const n of next) if (!held.has(n)) keys.get(n)?.classList.add('held');
      held = next;
    },
    releaseAll() {
      for (const pid of [...active.keys()]) release(pid);
    },
    /**
     * onboarding "first 60 seconds": print the computer key that plays each note (null clears them all).
     * @param {Map<number,string>|null} map  MIDI note → key label
     */
    setKeyLetters(map) {
      const next = map instanceof Map ? map : new Map();
      for (const [n, span] of letterEls) {
        if (next.get(n) === span.textContent) continue;
        span.remove();
        letterEls.delete(n);
      }
      for (const [n, txt] of next) {
        if (letterEls.has(n)) continue;
        const k = keys.get(n);
        if (!k) continue;
        const span = h('span.pkey-letter', { text: txt, 'aria-hidden': 'true' });
        k.append(span);
        letterEls.set(n, span);
      }
      el.classList.toggle('with-letters', letterEls.size > 0);
    },
    destroy() {
      for (const pid of [...active.keys()]) release(pid);
      d.dispose();
      el.remove();
    },
  };
}

/**
 * Split-range selector (slot lowNote/highNote). Drag on the keyboard moves the nearest handle; handles are
 * sliders (arrows ±1, Shift ±12); double-click resets to the full range.
 * @param {{low?:number, high?:number, from?:number, to?:number, onRange?:(r:{low:number, high:number})=>void,
 *          label?:string, color?:string}} o
 */
export function miniKeyboard(o = {}) {
  const d = disposer();
  const from = Number.isInteger(o.from) ? o.from : 21;
  const to = Number.isInteger(o.to) ? o.to : 108;
  let low = Number.isInteger(o.low) ? o.low : 0;
  let high = Number.isInteger(o.high) ? o.high : 127;
  const layout = keyLayout(from, to);
  const geo = new Map(layout.map((k) => [k.note, k]));
  const board = h('div.mini-board');
  for (const k of layout) board.append(h(`div.mkey${k.black ? '.black' : '.white'}`, { style: { left: `${k.left}%`, width: `${k.width}%` } }));
  const range = h('div.mini-range', { 'aria-hidden': 'true' });
  const mkHandle = (which) =>
    h('div.mini-handle', { role: 'slider', tabindex: '0', 'aria-label': `${o.label ? `${o.label} ` : ''}${which === 'low' ? 'lowest note' : 'highest note'}`, 'aria-valuemin': '0', 'aria-valuemax': '127', dataset: { which } });
  const hLow = mkHandle('low');
  const hHigh = mkHandle('high');
  const lblLow = h('span.mini-lbl.low');
  const lblHigh = h('span.mini-lbl.high');
  const el = h('div.mini-keyboard', {}, h('div.mini-wrap', {}, board, range, hLow, hHigh), h('div.mini-labels', {}, lblLow, lblHigh));
  if (o.color) el.style.setProperty('--fader-color', o.color);

  const xOf = (n) => {
    const c = clamp(n, from, to);
    const k = geo.get(c);
    if (!k) return 0;
    if (n < from) return 0;
    if (n > to) return 100;
    return k.left + k.width / 2;
  };
  const render = () => {
    const a = low <= from ? 0 : xOf(low);
    const b = high >= to ? 100 : xOf(high);
    range.style.left = `${Math.min(a, b)}%`;
    range.style.width = `${Math.abs(b - a)}%`;
    hLow.style.left = `${a}%`;
    hHigh.style.left = `${b}%`;
    const full = low <= 0 && high >= 127;
    setText(lblLow, full ? 'Full range' : `${noteName(low)}`);
    setText(lblHigh, full ? '' : `${noteName(high)}`);
    hLow.setAttribute('aria-valuenow', String(low));
    hLow.setAttribute('aria-valuetext', noteName(low));
    hHigh.setAttribute('aria-valuenow', String(high));
    hHigh.setAttribute('aria-valuetext', noteName(high));
  };
  const emit = () => {
    if (typeof o.onRange === 'function') o.onRange({ low, high });
  };
  const noteAtX = (clientX) => {
    const r = board.getBoundingClientRect();
    const pct = r.width > 0 ? ((clientX - r.left) / r.width) * 100 : 0;
    if (pct <= 0) return from;
    if (pct >= 100) return to;
    let best = from;
    let bestD = Infinity;
    for (const k of layout) {
      const dd = Math.abs(k.left + k.width / 2 - pct);
      if (dd < bestD) {
        bestD = dd;
        best = k.note;
      }
    }
    return best;
  };
  let dragging = null;
  d.listen(el, 'pointerdown', (ev) => {
    if (ev.button !== undefined && ev.button !== 0) return;
    const n = noteAtX(ev.clientX);
    dragging = ev.target === hLow ? 'low' : ev.target === hHigh ? 'high' : Math.abs(n - low) <= Math.abs(n - high) ? 'low' : 'high';
    try {
      el.setPointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    ev.preventDefault();
    move(n);
  });
  const move = (n) => {
    if (dragging === 'low') low = Math.min(n <= from ? 0 : n, high);
    else if (dragging === 'high') high = Math.max(n >= to ? 127 : n, low);
    render();
    emit();
  };
  d.listen(el, 'pointermove', (ev) => {
    if (dragging) move(noteAtX(ev.clientX));
  });
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) d.listen(el, t, () => (dragging = null));
  d.listen(el, 'dblclick', () => {
    low = 0;
    high = 127;
    render();
    emit();
  });
  const keyHandler = (which) => (ev) => {
    const delta = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[ev.key];
    if (!delta) return;
    ev.preventDefault();
    ev.stopPropagation();
    const dlt = delta * (ev.shiftKey ? 12 : 1);
    if (which === 'low') low = clamp(low + dlt, 0, high);
    else high = clamp(high + dlt, low, 127);
    render();
    emit();
  };
  d.listen(hLow, 'keydown', keyHandler('low'));
  d.listen(hHigh, 'keydown', keyHandler('high'));
  render();
  return {
    el,
    /** @param {{low:number, high:number}} v */
    set(v) {
      if (!v) return;
      if (Number.isFinite(v.low)) low = v.low;
      if (Number.isFinite(v.high)) high = v.high;
      render();
    },
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}
