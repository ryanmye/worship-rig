// fader() and knob(): styled <input type=range> + fixed-width value label (SPEC §13).
// Curves map the slider position (0..1) to a value: 'lin', 'log' (min > 0), 'taper' (min + (max−min)·pos³ —
// for gains 0..2 this is exactly params.faderTaper, i.e. 2·pos³, top ≈ +6 dB).
import { describe, formatValue } from '../../shared/params.js';
import { h, setText, nextId, disposer, rafCoalesce, clamp, relativeDrag } from './util.js';

const POS_STEPS = 1000;

/** Position (0..1) → value for a curve. */
export function posToValue(pos, { min, max, curve }) {
  const p = clamp(Number(pos) || 0, 0, 1);
  if (curve === 'log' && min > 0 && max > min) return min * Math.pow(max / min, p);
  if (curve === 'taper') return min + (max - min) * p * p * p;
  return min + (max - min) * p;
}

/** Value → position (0..1) for a curve. */
export function valueToPos(value, { min, max, curve }) {
  const v = Number(value);
  if (!Number.isFinite(v) || max === min) return 0;
  if (curve === 'log' && min > 0 && max > min) return clamp(Math.log(Math.max(v, min) / min) / Math.log(max / min), 0, 1);
  const x = clamp((v - min) / (max - min), 0, 1);
  return curve === 'taper' ? Math.cbrt(x) : x;
}

function defaultFormat(unit, step) {
  return (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    const s = step === 1 ? String(Math.round(n)) : String(Math.round(n * 100) / 100);
    return unit && !['lin', 'dB-display', 'bool', 'enum'].includes(unit) ? `${s} ${unit}` : s;
  };
}

/**
 * Fader.
 * @param {object} o
 * @param {string} [o.label]
 * @param {string} [o.path]      §4 path: fills min/max/default/unit/curve and the label format from params.describe
 * @param {string} [o.color]     CSS color for the fill (e.g. 'var(--slot-1)')
 * @param {number} [o.min]
 * @param {number} [o.max]
 * @param {'lin'|'log'|'taper'} [o.curve]   default 'taper' for dB-display params, else the table curve
 * @param {string} [o.unit]
 * @param {number} [o.step]      1 → integer values
 * @param {number} [o.default]   double-click reset value (default: params.describe(path).default)
 * @param {(v:number) => string} [o.format]
 * @param {boolean} [o.vertical=false]
 * @param {boolean} [o.compact=false]
 * @param {number} [o.value]
 * @param {(v:number) => void} [o.onChange]   emitted on input, coalesced per animation frame (flushed on release)
 * @param {boolean} [o.relative=false]  relative drag (Perform): pointer-down never jumps, movement = delta, Shift = fine
 * @param {boolean} [o.resetOnDoubleClick=true]  false in Perform (a double-tap must not jump the level)
 * @returns {{el:HTMLElement, input:HTMLInputElement, set(v:number):void, get():number, setIndicator(v:number|null):void,
 *            setDisabled(b:boolean):void, setLabel(s:string):void, setMuted(b:boolean):void, cancelDrag():void,
 *            dragging:boolean, destroy():void}}
 */
export function fader(o = {}) {
  const d = disposer();
  const e = o.path ? describe(o.path) : null;
  const min = Number.isFinite(o.min) ? o.min : Number.isFinite(e?.min) ? e.min : 0;
  const max = Number.isFinite(o.max) ? o.max : Number.isFinite(e?.max) ? e.max : 1;
  const unit = o.unit ?? e?.unit ?? 'lin';
  const curve = o.curve ?? (unit === 'dB-display' ? 'taper' : e?.curve ?? 'lin');
  const step = o.step ?? e?.step;
  const def = o.default ?? (e && e.default !== null && typeof e.default === 'number' ? e.default : min);
  const format = o.format || (o.path && e && !e.dynamic ? (v) => formatValue(o.path, v) : defaultFormat(unit, step));
  const shape = { min, max, curve };
  const id = nextId('fader');

  const input = h('input.fader-input', {
    type: 'range',
    id,
    min: 0,
    max: POS_STEPS,
    step: 1,
    'aria-label': o.label || o.path || 'Level',
  });
  const indicator = h('div.fader-indicator', { 'aria-hidden': 'true', hidden: true });
  let indPos = NaN; // last --ind written (thousandths)
  const label = h('label.fader-label', { for: id, text: o.label || '' });
  const out = h('output.fader-value', { for: id, 'aria-hidden': 'true' });
  const el = h(
    `div.fader${o.vertical ? '.vertical' : '.horizontal'}${o.compact ? '.compact' : ''}`,
    { dataset: o.path ? { path: o.path } : {} },
    label,
    h('div.fader-track', {}, input, indicator),
    out,
  );
  if (o.color) el.style.setProperty('--fader-color', o.color);
  if (o.className) el.classList.add(...String(o.className).split(/\s+/).filter(Boolean));

  let value = Number.isFinite(o.value) ? o.value : def;
  let dragging = false;
  let stash = null;
  // round2-ui #2: after cancelDrag() the native (non-relative) range drag keeps firing input events until the
  // pointer goes up; they are undone instead of written (the song they were aimed at is gone).
  let ignoreUntilUp = false;
  let rel = null;

  const quantize = (v) => {
    let x = clamp(v, Math.min(min, max), Math.max(min, max));
    if (step === 1) x = Math.round(x);
    else if (step > 0) x = Math.round(x / step) * step;
    return x;
  };
  const render = () => {
    const pos = valueToPos(value, shape);
    const iv = Math.round(pos * POS_STEPS);
    if (Number(input.value) !== iv) input.value = String(iv);
    input.style.setProperty('--pos', `${(pos * 100).toFixed(2)}%`);
    const txt = format(value);
    setText(out, txt);
    input.setAttribute('aria-valuetext', txt);
  };
  const emitter = rafCoalesce((v) => {
    if (typeof o.onChange === 'function') o.onChange(v);
  });
  const fromInput = () => {
    if (ignoreUntilUp || (o.relative && dragging)) {
      render(); // a native (touch) jump during a relative drag is undone
      return;
    }
    value = quantize(posToValue(Number(input.value) / POS_STEPS, shape));
    render();
    emitter.push(value);
  };

  d.listen(input, 'input', fromInput);
  d.listen(input, 'change', () => emitter.flush());
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    // round2-ui #2(b): a store change that arrived during the drag (stashed) wins when the drag has nothing left
    // to write; otherwise the flushed write re-renders through set() anyway.
    const s = stash;
    stash = null;
    const wrote = emitter.flush();
    if (!wrote && s !== null) {
      value = s;
      render();
    }
  };
  /** Abandon a drag in progress: nothing more is written, the display shows the stashed/current value. */
  const cancelDrag = () => {
    emitter.cancel();
    rel?.cancel();
    if (!dragging) return;
    dragging = false;
    if (!o.relative) ignoreUntilUp = true;
    if (stash !== null) value = stash;
    stash = null;
    render();
  };
  const releaseIgnore = () => {
    if (ignoreUntilUp) setTimeout(() => (ignoreUntilUp = false), 0); // after the release's own change/input
  };
  if (o.relative) {
    // Perform (UX B2): movement maps to a delta; a tap never changes the level
    rel = relativeDrag(input, {
      vertical: !!o.vertical,
      d,
      getPos: () => valueToPos(value, shape),
      setPos: (p) => {
        const v = quantize(posToValue(p, shape));
        if (v === value) return;
        value = v;
        render();
        emitter.push(value);
      },
      onStart: () => {
        dragging = true;
      },
      onEnd: endDrag,
    });
  } else {
    d.listen(input, 'pointerdown', () => {
      dragging = true;
    });
    d.listen(window, 'pointerup', endDrag);
    d.listen(window, 'pointercancel', endDrag);
    d.listen(window, 'pointerup', releaseIgnore);
    d.listen(window, 'pointercancel', releaseIgnore);
  }
  // pointer users: drop focus afterwards so the computer keyboard keeps playing notes (controller ignores keys
  // while a range input has focus); keyboard users keep focus.
  d.listen(input, 'pointerup', () => queueMicrotask(() => input.blur()));
  d.listen(input, 'keydown', (ev) => {
    const k = ev.key;
    const dir = k === 'ArrowUp' || k === 'ArrowRight' ? 1 : k === 'ArrowDown' || k === 'ArrowLeft' ? -1 : 0;
    const page = k === 'PageUp' ? 1 : k === 'PageDown' ? -1 : 0;
    if (!dir && !page) return;
    ev.preventDefault();
    const stepPos = page ? 0.1 : ev.shiftKey ? 0.1 : 0.02;
    let pos = valueToPos(value, shape) + (dir || page) * stepPos;
    if (step === 1 && !page && !ev.shiftKey) {
      value = quantize(value + (dir || page) * 1);
    } else {
      pos = clamp(pos, 0, 1);
      value = quantize(posToValue(pos, shape));
    }
    render();
    emitter.push(value);
    emitter.flush();
  });
  d.listen(el, 'dblclick', (ev) => {
    if (input.disabled || o.resetOnDoubleClick === false) return;
    ev.preventDefault();
    value = quantize(def);
    render();
    emitter.cancel();
    if (typeof o.onChange === 'function') o.onChange(value);
  });

  render();

  return {
    el,
    input,
    set(v) {
      const n = Number(v);
      if (!Number.isFinite(n)) return;
      if (dragging) {
        stash = n;
        return;
      }
      value = n;
      render();
    },
    get: () => value,
    /** Show a secondary marker (e.g. the effective level after the mod wheel), in value units; null hides it. */
    setIndicator(v) {
      // performance #3c: called every frame while the wheel moves; write only what changed, and put --ind on the
      // indicator itself so a change restyles one element, not the whole fader subtree
      if (v === null || v === undefined || !Number.isFinite(Number(v))) {
        if (!indicator.hidden) indicator.hidden = true;
        return;
      }
      if (indicator.hidden) indicator.hidden = false;
      const pos = Math.round(valueToPos(Number(v), shape) * 1000) / 1000;
      if (pos === indPos) return;
      indPos = pos;
      indicator.style.setProperty('--ind', String(pos));
    },
    setDisabled(b) {
      input.disabled = !!b;
      el.classList.toggle('disabled', !!b);
    },
    setLabel(s) {
      setText(label, s);
      input.setAttribute('aria-label', s || o.path || 'Level');
    },
    setMuted(b) {
      el.classList.toggle('muted', !!b);
    },
    get stash() {
      return stash;
    },
    /** True while a pointer drag is in progress. */
    get dragging() {
      return dragging;
    },
    /**
     * Abandon a pointer drag (the target changed, e.g. a song switch mid-drag): pending and later movement is
     * dropped, and the fader shows the value set() delivered during the drag (round2-ui #2).
     */
    cancelDrag,
    destroy() {
      emitter.cancel();
      d.dispose();
      el.remove();
    },
  };
}

/**
 * Knob: same API as fader, compact horizontal variant (no rotary mousing on stage).
 * @param {Parameters<typeof fader>[0]} o
 */
export function knob(o = {}) {
  const f = fader({ ...o, vertical: false, compact: true });
  f.el.classList.add('knob');
  return f;
}
