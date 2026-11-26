// UI v6 keyboard with draggable range bars (D18 "The range colours on Perform's keyboard are draggable", "Range uses
// a real keyboard"; UI6-build-plan U2; mockups perform-v6.html "Drag a colour to set its range" / "iPad · pick, then
// drag a range", edit.html "Instrument · Range"; mock_v6.py kbd() / range_bar() / RANGE_JS / range_kbd()).
// One component, two sizes (D15 "one module, used everywhere"):
//   'perform'  today's on-screen keys C2–C7 (components/keys.js pianoKeyboard: key letters, held notes) with one range
//              bar per instrument above them, coloured by position;
//   'range'    Edit › Range: 88 keys A0–C8, one instrument's bar, keys outside its range dimmed, shorter.
// Each bar has a handle at each end. A drag snaps to keys (all 12 semitones: a handle's edge goes to the nearest key
// edge, black keys included, at their real positions), keeps lowest < highest, shows "Sub Bass · C2–C5" while it moves
// and writes once, on release (see `finishDrag`). Past the keyboard's outer edge it snaps to "every key that way"
// (0 / 127, today's Edit miniKeyboard rule), so a range can go back to the whole keyboard from here. A range that
// reaches outside the keys shown is drawn clipped with an edge marker and never rewritten unless that end is dragged.
// Pointers: fine → handles always live, with a 34 px tall hit area around the thin bars (one hit layer picks the
// nearest handle, so stacked handles at the same key stay reachable); coarse (iPad, '(pointer: coarse)') on the
// 'perform' size → tap an instrument first (its strip name, through the shell, or its bar): only that bar is grabbable
// with 26 px handles, the others dim; tap another to switch, the keys or Esc to finish. Keyboard: handles are sliders,
// ←/→ a semitone, Shift+←/→ an octave, aria-valuetext with the note name.
// Pure view code: reads come in through render(), writes go out through o.onRange (the shell does store.set).
import { h, setText, disposer, clamp } from '../components/util.js';
import { pianoKeyboard, keyLayout } from '../components/keys.js';
import { openOverlay } from '../components/overlay.js';
import { noteName, mod12 } from '../../shared/music.js';

/** Keys each size shows (MIDI notes, inclusive). */
export const KEYBOARD_SIZES = Object.freeze({
  perform: Object.freeze({ from: 36, to: 96, label: 'On-screen keyboard (C2–C7)' }),
  range: Object.freeze({ from: 21, to: 108, label: 'Keyboard range (A0–C8)' }),
});
/** Lowest / highest note a slot range can hold (PARAMS slots.<i>.lowNote / highNote). */
const MIN_NOTE = 0;
const MAX_NOTE = 127;
/** Pointer travel (px) before a press on a handle becomes a drag: a tap never rewrites a clipped end. */
const DRAG_SLOP = 4;
/** Height of the bar area per size (px; CSS --rb-h mirrors it). */
const BARS_H = { perform: 26, range: 10 };
const MEDIA_COARSE = '(pointer: coarse)';

/**
 * "C2–C5", "every key", "up to B3", "C4 and up" (the open ends are today's Edit "Whole keyboard" values 0 / 127).
 * @param {number} lo
 * @param {number} hi
 * @returns {string}
 */
export function rangeText(lo, hi) {
  const a = lo <= MIN_NOTE;
  const b = hi >= MAX_NOTE;
  if (a && b) return 'every key';
  if (a) return `up to ${noteName(hi)}`;
  if (b) return `${noteName(lo)} and up`;
  return `${noteName(lo)}–${noteName(hi)}`;
}

/**
 * The keyboard with range bars.
 * @param {object} o
 * @param {'perform'|'range'} [o.size]  default 'perform'
 * @param {string} [o.label]            the keys' accessible name
 * @param {(note:number, vel:number) => void} [o.onNoteOn]  keys play while set (pianoKeyboard)
 * @param {(note:number) => void} [o.onNoteOff]
 * @param {(i:number, field:'lowNote'|'highNote', note:number) => boolean|void} o.onRange
 *   one end changed (one call per release / key press; only the end that moved)
 * @param {(i:number|null) => void} [o.onPick]  coarse 'perform' size: the instrument being changed (null: done)
 * @param {(coarse:boolean) => void} [o.onCoarse]  the pointer kind changed (and once at mount)
 * @param {boolean} [o.coarse]          force the pointer kind (harness); default matchMedia('(pointer: coarse)')
 * @param {string} [o.testid]
 * @returns {{el:HTMLElement, keysEl:HTMLElement, render(x:{bars:Array<{i:number, name:string, color:string,
 *   lo:number, hi:number, off?:boolean, changed?:boolean}>, locked?:boolean}):void,
 *   setHeld(held:any, partOf?:Function):void,
 *   setKeyLetters(map:Map<number,string>|null):void, releaseAll():void, pick(i:number|null):void,
 *   readonly picked:number|null, readonly coarse:boolean, readonly dragging:boolean, cancelDrag():void,
 *   destroy():void}}
 */
export function rangeKeyboard(o = {}) {
  const size = o.size === 'range' ? 'range' : 'perform';
  const { from, to } = KEYBOARD_SIZES[size];
  const d = disposer();
  const tid = o.testid || (size === 'range' ? 'v6-range-kbd' : 'v6-kbd');
  const piano = pianoKeyboard({
    from, to, label: o.label || KEYBOARD_SIZES[size].label, labels: size !== 'range',
    onNoteOn: (n, vel) => o.onNoteOn?.(n, vel),
    onNoteOff: (n) => o.onNoteOff?.(n),
  });
  piano.el.dataset.testid = `${tid}-piano`;
  const layout = keyLayout(from, to);
  const geo = new Map(layout.map((k) => [k.note, k]));
  const whiteW = 100 / Math.max(1, layout.filter((k) => !k.black).length); // % of the width
  const keyEls = new Map([...piano.el.querySelectorAll('.pkey')].map((k) => [Number(k.dataset.note), k]));
  if (size === 'range') {
    // 52 white keys: "C" only, the octave number on C4 (mockup range_kbd labels every C small)
    for (const [n, k] of keyEls) {
      if (mod12(n) === 0) k.append(h('span.pkey-label', { text: n === 60 ? 'C4' : 'C' }));
    }
  }

  const hit = h('div.v6-rhit', { 'aria-hidden': 'true', 'data-testid': `${tid}-hit` });
  const tip = h('span.v6-rtip', { 'aria-hidden': 'true', 'data-testid': `${tid}-tip`, hidden: true });
  const rbars = h('div.rbars.v6-rbars', {
    role: 'group', 'aria-label': 'Instrument ranges', 'data-testid': `${tid}-bars`,
  }, hit, tip);
  const hint = h('div.v6-pickhint', { 'aria-live': 'polite', 'data-testid': `${tid}-pickhint`, hidden: true });
  const el = h(`div.v6-kbd.v6-kbd-${size}`, { 'data-testid': tid, dataset: { size } }, hint, rbars, piano.el);

  /** One per shown bar, in row order: {i, el, lo, hi (handles), b (its render input), row, L, R (%), y (px)}. */
  const views = [];
  const pool = new Map(); // slot index → {el, lo, hi}
  let bars = [];
  let locked = false;
  let picked = null;
  let pickClose = null;
  let drag = null; // {v, end, pid, x0, off, lo, hi, moved}
  let hot = null; // {v, end} under a fine pointer
  let focused = null; // {v, end} with keyboard focus
  let coarse = typeof o.coarse === 'boolean' ? o.coarse : false;
  let mq = null;
  if (typeof o.coarse !== 'boolean' && typeof matchMedia === 'function') {
    mq = matchMedia(MEDIA_COARSE);
    coarse = mq.matches;
    d.listen(mq, 'change', () => {
      coarse = mq.matches;
      if (!coarse) pick(null);
      layoutBars();
      o.onCoarse?.(coarse);
    });
  }
  /** Pick mode: coarse pointers on the Perform size (Edit's single bar is always live). */
  const pickMode = () => coarse && size === 'perform';

  // ------------------------------------------------------------------ geometry
  const leftOf = (n) => geo.get(n).left;
  const rightOf = (n) => geo.get(n).left + geo.get(n).width;
  /** Shown extent (%) of a range: clipped to the keys; a range wholly outside shows as a stub at that edge. */
  function extent(lo, hi) {
    const stub = whiteW * 0.6;
    let L = lo < from ? 0 : lo > to ? 100 - stub : leftOf(lo);
    let R = hi > to ? 100 : hi < from ? stub : rightOf(hi);
    if (R < L + 0.2) R = Math.min(100, L + 0.2);
    if (L > R - 0.2) L = Math.max(0, R - 0.2);
    return { L, R, clipL: lo < from || lo > to, clipR: hi > to || hi < from };
  }
  /** The note an end snaps to at x px (rbars-relative): the nearest key edge, or the open end past the keyboard. */
  function snap(end, x, W) {
    let best = end === 'lo' ? MIN_NOTE : MAX_NOTE;
    let bd = Math.abs(x - (end === 'lo' ? -whiteW / 2 : 100 + whiteW / 2) * W / 100);
    for (const k of layout) {
      const e = (end === 'lo' ? k.left : k.left + k.width) * W / 100;
      const dd = Math.abs(x - e);
      if (dd < bd - 1e-6) {
        bd = dd;
        best = k.note;
      }
    }
    return best;
  }
  const clampEnd = (end, n, lo, hi) => (end === 'lo' ? clamp(n, MIN_NOTE, hi - 1) : clamp(n, lo + 1, MAX_NOTE));

  // ------------------------------------------------------------------ bars
  function ensure(i) {
    let p = pool.get(i);
    if (p) return p;
    const handle = (end) => h('span.v6-rh', {
      class: end === 'lo' ? 'l' : 'r', role: 'slider', tabindex: '0', 'aria-orientation': 'horizontal',
      'data-testid': `${tid}-h${end}-${i}`, dataset: { end },
    });
    const lo = handle('lo');
    const hi = handle('hi');
    const bel = h('i.rbar.v6-rbar', { 'data-testid': `${tid}-bar-${i}`, dataset: { slot: String(i) } }, lo, hi);
    p = { el: bel, lo, hi };
    pool.set(i, p);
    for (const hd of [lo, hi]) {
      d.listen(hd, 'keydown', (ev) => onKey(ev, i, hd.dataset.end));
      d.listen(hd, 'focus', () => {
        focused = { i, end: hd.dataset.end };
        showTip();
      });
      d.listen(hd, 'blur', () => {
        focused = null;
        showTip();
      });
    }
    return p;
  }
  const valuesOf = (v) => (drag && drag.i === v.i ? { lo: drag.lo, hi: drag.hi } : { lo: v.b.lo, hi: v.b.hi });

  function paintBar(v) {
    const { lo, hi } = valuesOf(v);
    const x = extent(lo, hi);
    v.L = x.L;
    v.R = x.R;
    const s = v.el.style;
    s.left = `${x.L.toFixed(3)}%`;
    s.width = `${(x.R - x.L).toFixed(3)}%`;
    v.el.classList.toggle('clip-l', x.clipL);
    v.el.classList.toggle('clip-r', x.clipR);
    // today's class names (styles.css / themes: .rbar.open-l / .open-r square the clipped ends)
    v.el.classList.toggle('open-l', x.clipL);
    v.el.classList.toggle('open-r', x.clipR);
    const live = !locked && (!pickMode() || picked === v.i);
    for (const [hd, end, val, min, max] of [[v.lo, 'lo', lo, MIN_NOTE, hi - 1], [v.hi, 'hi', hi, lo + 1, MAX_NOTE]]) {
      const out = end === 'lo' ? x.clipL : x.clipR;
      hd.classList.toggle('beyond', out);
      hd.setAttribute('aria-label', `${v.b.name}: ${end === 'lo' ? 'lowest' : 'highest'} note`);
      hd.setAttribute('aria-valuemin', String(min));
      hd.setAttribute('aria-valuemax', String(max));
      hd.setAttribute('aria-valuenow', String(val));
      hd.setAttribute('aria-valuetext', noteText(val, out));
      hd.tabIndex = live ? 0 : -1;
      if (live) hd.removeAttribute('aria-disabled');
      else hd.setAttribute('aria-disabled', 'true');
    }
    if (size === 'range') dimKeys(lo, hi);
  }
  const noteText = (n, out) => {
    if (n <= MIN_NOTE) return `${noteName(n)}, the lowest note (every key down)`;
    if (n >= MAX_NOTE) return `${noteName(n)}, the highest note (every key up)`;
    return out ? `${noteName(n)}, outside the keys shown` : noteName(n);
  };
  let dimmed = '';
  function dimKeys(lo, hi) {
    const k = `${lo}:${hi}`;
    if (k === dimmed) return;
    dimmed = k;
    for (const [n, kel] of keyEls) kel.classList.toggle('out', n < lo || n > hi);
  }

  /** Rows, thickness and the handles' state from `bars`; then every bar's extent. */
  function layoutBars() {
    const shown = new Set();
    views.length = 0;
    const n = bars.length;
    const H = BARS_H[size];
    // rows: up to 10 px apart, 7 px bars (mock_v6.css .rbars), thinner as instruments are added; the stack sits on
    // the keys (the slack goes above, where the handles and the label have room)
    const pitch = n ? Math.min(10, H / n) : 10;
    const thick = clamp(pitch * 0.7, 1.5, 7);
    const top0 = H - (n ? (n - 1) * pitch + thick : 0);
    bars.forEach((b, row) => {
      const p = ensure(b.i);
      shown.add(b.i);
      const v = { i: b.i, el: p.el, lo: p.lo, hi: p.hi, b, row, L: 0, R: 0, y: top0 + row * pitch + thick / 2 };
      views.push(v);
      p.el.style.setProperty('--c', b.color);
      p.el.style.top = `${(top0 + row * pitch).toFixed(2)}px`;
      p.el.style.height = `${thick.toFixed(2)}px`;
      p.el.classList.toggle('off', !!b.off);
      p.el.classList.toggle('changed', !!b.changed); // a white dot: changed since the song was selected (Revert)
      p.el.classList.toggle('picked', picked === b.i);
      if (rbars.children[row] !== p.el) rbars.insertBefore(p.el, rbars.children[row] || hit);
      paintBar(v);
    });
    for (const [i, p] of pool) if (!shown.has(i) && p.el.parentNode) p.el.remove();
    el.classList.toggle('locked', locked);
    el.classList.toggle('coarse', coarse);
    el.classList.toggle('picking', pickMode() && picked !== null);
    el.style.setProperty('--rb-thick', `${thick.toFixed(2)}px`);
    showTip();
    renderHint();
  }

  // ------------------------------------------------------------------ the label ("Sub Bass · C2–C5")
  function showTip() {
    const who = drag ? drag.i : focused ? focused.i : hot ? hot.i : pickMode() && picked !== null ? picked
      : size === 'range' && views[0] ? views[0].i : null;
    const v = who === null ? null : views.find((x) => x.i === who);
    if (!v) {
      tip.hidden = true;
      return;
    }
    const { lo, hi } = valuesOf(v);
    setText(tip, `${v.b.name} · ${rangeText(lo, hi)}`);
    tip.style.setProperty('--c', v.b.color);
    tip.style.top = `${(v.y - 4).toFixed(2)}px`;
    tip.hidden = false;
    tip.classList.toggle('live', !!drag);
    // centred over the bar, kept inside the keyboard
    const W = rbars.clientWidth || 1;
    const tw = tip.offsetWidth || 0;
    const c = ((v.L + v.R) / 2) * W / 100;
    tip.style.left = `${clamp(c - tw / 2, -4, Math.max(-4, W - tw + 4)).toFixed(1)}px`;
  }

  // ------------------------------------------------------------------ pick mode (coarse 'perform')
  function renderHint() {
    const on = pickMode() && picked !== null;
    hint.hidden = !on;
    if (!on) return;
    const v = views.find((x) => x.i === picked);
    hint.replaceChildren('Drag the ends of ', h('b', { text: v ? v.b.name : 'this instrument' }),
      ' · tap another instrument to switch · tap the keys to finish');
  }
  /**
   * Choose the instrument whose range the coarse pointer changes (null: finish). No-op on fine pointers, on the
   * 'range' size and while locked.
   */
  function pick(i) {
    const next = i === null || i === undefined || !pickMode() || locked || !bars.some((b) => b.i === i) ? null : i;
    if (next === picked) return;
    if (drag) cancelDrag();
    picked = next;
    if (picked !== null && !pickClose) {
      // Esc finishes (an overlay: the Esc never reaches main.js's panic); outside taps keep it (only the keys finish)
      pickClose = openOverlay({
        el, anchors: [], closeOnOutside: false, group: 'v6-range-pick',
        onClose: (reason) => {
          pickClose = null;
          if (reason !== 'api' && picked !== null) {
            picked = null;
            layoutBars();
            o.onPick?.(null);
          }
        },
      });
    } else if (picked === null && pickClose) pickClose('api');
    layoutBars();
    o.onPick?.(picked);
  }
  // "tap the keys to finish": the tap only finishes (no note), ahead of pianoKeyboard's own pointerdown
  d.listen(piano.el, 'pointerdown', (ev) => {
    if (picked === null) return;
    ev.preventDefault();
    ev.stopPropagation();
    pick(null);
  }, true);

  // ------------------------------------------------------------------ pointer: one hit layer for every handle
  /** The handle a press at (x, y) (rbars px) grabs: the nearest live end within reach; null when none. */
  function handleAt(x, y, W) {
    let best = null;
    let bs = Infinity;
    const out = coarse ? 26 : 17;
    for (const v of views) {
      if (locked || (pickMode() && picked !== v.i)) continue;
      const lx = v.L * W / 100;
      const rx = v.R * W / 100;
      const inward = Math.min(coarse ? 22 : 14, (rx - lx) / 2);
      for (const [end, ex] of [['lo', lx], ['hi', rx]]) {
        const dx = x - ex;
        const ok = end === 'lo' ? dx >= -out && dx <= inward : dx <= out && dx >= -inward;
        if (!ok) continue;
        const s = Math.abs(dx) + Math.abs(y - v.y);
        if (s < bs) {
          bs = s;
          best = { v, end, ex };
        }
      }
    }
    return best;
  }
  /** The bar under (x, y) (coarse: a tap on a bar picks it): the nearest row whose extent holds x. */
  function barAt(x, y, W) {
    let best = null;
    let bs = Infinity;
    for (const v of views) {
      if (x < v.L * W / 100 - 6 || x > v.R * W / 100 + 6) continue;
      const s = Math.abs(y - v.y);
      if (s < bs) {
        bs = s;
        best = v;
      }
    }
    return best;
  }
  const local = (ev) => {
    const r = rbars.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top, W: r.width || 1 };
  };
  function setHot(next) {
    const same = next && hot && next.v.i === hot.i && next.end === hot.end;
    if (same || (!next && !hot)) return;
    if (hot) pool.get(hot.i)?.[hot.end]?.classList.remove('hot');
    hot = next ? { i: next.v.i, end: next.end } : null;
    if (hot) pool.get(hot.i)?.[hot.end]?.classList.add('hot');
    hit.classList.toggle('grab', !!hot);
    showTip();
  }

  d.listen(hit, 'pointerdown', (ev) => {
    if (ev.button !== undefined && ev.button !== 0) return;
    if (drag) return;
    const { x, y, W } = local(ev);
    const hd = locked ? null : handleAt(x, y, W);
    if (!hd) {
      // a tap on a bar picks it (coarse Perform); a tap on the picked bar's middle keeps it
      if (pickMode() && !locked) {
        const b = barAt(x, y, W);
        if (b && b.i !== picked) {
          ev.preventDefault();
          pick(b.i);
        }
      }
      return;
    }
    ev.preventDefault(); // no focus, no text selection, no scroll
    ev.stopPropagation();
    try {
      hit.setPointerCapture(ev.pointerId);
    } catch {
      /* synthetic pointers */
    }
    const { lo, hi } = valuesOf(hd.v);
    drag = { i: hd.v.i, end: hd.end, pid: ev.pointerId, x0: ev.clientX, off: x - hd.ex, lo, hi, lo0: lo, hi0: hi,
      moved: false };
    setHot(null);
    pool.get(drag.i)?.el.classList.add('drag');
    pool.get(drag.i)?.[drag.end]?.classList.add('drag');
    el.classList.add('dragging');
    showTip();
  });
  d.listen(hit, 'pointermove', (ev) => {
    if (!drag) {
      if (ev.pointerType === 'mouse' || ev.pointerType === 'pen') {
        const { x, y, W } = local(ev);
        setHot(locked ? null : handleAt(x, y, W));
      }
      return;
    }
    if (ev.pointerId !== drag.pid) return;
    if (!drag.moved && Math.abs(ev.clientX - drag.x0) < DRAG_SLOP) return;
    drag.moved = true;
    const { x, W } = local(ev);
    const n = clampEnd(drag.end, snap(drag.end, x - drag.off, W), drag.lo, drag.hi);
    if (drag.end === 'lo' ? n === drag.lo : n === drag.hi) return;
    if (drag.end === 'lo') drag.lo = n;
    else drag.hi = n;
    const v = views.find((x2) => x2.i === drag.i);
    if (v) paintBar(v);
    showTip();
  });
  d.listen(hit, 'pointerleave', () => {
    if (!drag) setHot(null);
  });
  d.listen(hit, 'pointerup', (ev) => {
    if (drag && ev.pointerId === drag.pid) finishDrag(true);
  });
  d.listen(hit, 'pointercancel', (ev) => {
    if (drag && ev.pointerId === drag.pid) finishDrag(false);
  });
  d.listen(hit, 'lostpointercapture', (ev) => {
    if (drag && ev.pointerId === drag.pid) finishDrag(true);
  });

  /**
   * End a drag. The store is written once, here, on release (not during the drag): one change per gesture keeps the
   * shell's render (strips, changed dots, Revert count, store → engine diff) out of the pointer's path and gives the
   * player one clean "changed" step; the label shows the range live meanwhile. A cancelled drag writes nothing.
   */
  function finishDrag(commit) {
    const g = drag;
    if (!g) return;
    drag = null;
    const p = pool.get(g.i);
    p?.el.classList.remove('drag');
    p?.lo.classList.remove('drag');
    p?.hi.classList.remove('drag');
    el.classList.remove('dragging');
    try {
      if (hit.hasPointerCapture?.(g.pid)) hit.releasePointerCapture(g.pid);
    } catch {
      /* already released */
    }
    const field = g.end === 'lo' ? 'lowNote' : 'highNote';
    const val = g.end === 'lo' ? g.lo : g.hi;
    const was = g.end === 'lo' ? g.lo0 : g.hi0;
    if (commit && !locked && g.moved && val !== was) o.onRange?.(g.i, field, val);
    // back to the values render() last gave (a write re-renders on the store's change, a microtask later)
    for (const v of views) if (v.i === g.i) paintBar(v);
    showTip();
  }
  /** Drop a drag in progress without writing (song change, lock, pick switch). */
  function cancelDrag() {
    finishDrag(false);
  }

  // ------------------------------------------------------------------ keys on a focused handle
  function onKey(ev, i, end) {
    const dir = { ArrowLeft: -1, ArrowRight: 1 }[ev.key];
    if (!dir) return;
    // never Prev / Next song, cue steps or a played note (controller.js skips a defaultPrevented key)
    ev.preventDefault();
    ev.stopPropagation();
    if (locked || drag) return;
    const v = views.find((x) => x.i === i);
    if (!v) return;
    const { lo, hi } = v.b;
    const cur = end === 'lo' ? lo : hi;
    const n = clampEnd(end, cur + dir * (ev.shiftKey ? 12 : 1), lo, hi);
    if (n !== cur) o.onRange?.(i, end === 'lo' ? 'lowNote' : 'highNote', n);
  }

  return {
    el,
    keysEl: piano.el,
    /**
     * @param {{bars:Array<{i:number, name:string, color:string, lo:number, hi:number, off?:boolean,
     *          changed?:boolean}>, locked?:boolean}} x  bars in row order ('range' size: one); changed: a white dot
     */
    render(x) {
      const next = (x.bars || []).map((b) => ({
        i: b.i, name: b.name || '—', color: b.color, off: !!b.off, changed: !!b.changed,
        lo: Number.isFinite(b.lo) ? Math.round(b.lo) : MIN_NOTE,
        hi: Number.isFinite(b.hi) ? Math.round(b.hi) : MAX_NOTE,
      })).slice(0, size === 'range' ? 1 : undefined);
      locked = !!x.locked;
      bars = next;
      if (drag && (locked || !bars.some((b) => b.i === drag.i))) cancelDrag();
      if (picked !== null && (locked || !bars.some((b) => b.i === picked))) pick(null);
      layoutBars();
    },
    setHeld(held, partOf) {
      piano.set(held, partOf);
    },
    setKeyLetters(map) {
      piano.setKeyLetters(map);
    },
    releaseAll() {
      piano.releaseAll();
    },
    pick,
    get picked() {
      return picked;
    },
    get coarse() {
      return coarse;
    },
    get dragging() {
      return !!drag;
    },
    cancelDrag,
    destroy() {
      cancelDrag();
      if (pickClose) pickClose('api');
      d.dispose();
      piano.destroy();
      el.remove();
    },
  };
}
