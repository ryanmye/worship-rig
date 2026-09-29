// Small DOM helpers shared by the UI components (no framework, no innerHTML for user data).

/**
 * Create an element.
 * @param {string} tag  'div.cls.cls2#id' shorthand is supported
 * @param {object} [attrs]  attributes; `class`, `text`, `style` (object), `dataset` (object), `on` ({type: fn}), boolean attrs
 * @param {...(Node|string|null|false)} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs = {}, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag) || [];
  const el = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') String(v).split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'style' && typeof v === 'object') {
      // custom properties can't be set by property assignment (UX M4)
      for (const [p, val] of Object.entries(v)) {
        if (p.startsWith('--')) el.style.setProperty(p, String(val));
        else el.style[p] = val;
      }
    }
    else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
    else if (k === 'on' && typeof v === 'object') for (const [t, fn] of Object.entries(v)) el.addEventListener(t, fn);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/**
 * Set text only when it changed (no layout work for identical updates). An element holding one Text node gets that
 * node's data changed in place (performance #3d: `textContent =` replaces the node, a remove + insert for layout).
 */
export function setText(el, text) {
  const s = String(text);
  const t = el.firstChild;
  if (t && t === el.lastChild && t.nodeType === 3) {
    if (t.data !== s) t.data = s;
  } else if (el.textContent !== s) el.textContent = s;
}

/** Toggle an attribute. */
export function setAttr(el, name, on, value = '') {
  if (on) {
    if (el.getAttribute(name) !== String(value)) el.setAttribute(name, String(value));
  } else if (el.hasAttribute(name)) el.removeAttribute(name);
}

let uid = 0;
/** Unique DOM id. */
export const nextId = (prefix = 'c') => `${prefix}-${++uid}`;

/**
 * Collects cleanup functions; `listen()` registers an event listener that is removed on `dispose()`.
 */
export function disposer() {
  const fns = [];
  return {
    add(fn) {
      if (typeof fn === 'function') fns.push(fn);
      return fn;
    },
    listen(target, type, fn, opts) {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, fn, opts);
      fns.push(() => target.removeEventListener(type, fn, opts));
    },
    dispose() {
      for (const fn of fns.splice(0).reverse()) {
        try {
          fn();
        } catch (err) {
          console.warn('[ui] cleanup failed', err);
        }
      }
    },
  };
}

/**
 * Coalesce calls to one per animation frame; the latest argument wins.
 * @param {(v:any) => void} fn
 * @returns {{push(v:any):void, flush():void, cancel():void}}
 */
export function rafCoalesce(fn) {
  let pending = false;
  let value;
  let id = 0;
  const run = () => {
    id = 0;
    if (!pending) return false;
    pending = false;
    fn(value);
    return true;
  };
  return {
    push(v) {
      value = v;
      pending = true;
      if (!id) id = requestAnimationFrame(run);
    },
    /** Run a pending call now; true when there was one. */
    flush() {
      if (id) cancelAnimationFrame(id);
      return run();
    },
    cancel() {
      if (id) cancelAnimationFrame(id);
      id = 0;
      pending = false;
    },
  };
}

/**
 * Blur a control after a pointer click so Space stays the sustain pedal and arrows stay song navigation
 * (SPEC §10: "blur buttons after click"). Keyboard activation (detail 0) keeps focus for accessibility.
 */
export function blurAfterPointer(el, d) {
  const fn = (e) => {
    if (e.detail > 0 || e.pointerType) queueMicrotask(() => el.blur());
  };
  if (d) d.listen(el, 'click', fn);
  else el.addEventListener('click', fn);
}

/** Clamp helper. */
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/**
 * Relative drag for a native range input (UX B2): a pointer-down never moves the value (no jump-to-click); the value
 * follows the pointer's *movement*, 1 track length = full range, Shift = fine (¼ speed). Pointer capture keeps the
 * drag alive outside the track. Works for mouse, pen and touch (the input needs `touch-action:none`).
 * @param {HTMLInputElement} input
 * @param {{vertical:boolean, getPos:()=>number, setPos:(p:number)=>void, onStart?:()=>void, onEnd?:()=>void,
 *          d:ReturnType<typeof disposer>}} o
 */
export function relativeDrag(input, o) {
  let drag = null; // {id, last, pos, len}
  const coord = (e) => (o.vertical ? e.clientY : e.clientX);
  o.d.listen(input, 'pointerdown', (e) => {
    if (input.disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault(); // no native jump, no compat mousedown, no focus
    const r = input.getBoundingClientRect();
    drag = { id: e.pointerId, last: coord(e), pos: o.getPos(), len: Math.max(40, o.vertical ? r.height : r.width) };
    try {
      input.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events */
    }
    input.classList.add('dragging');
    o.onStart?.();
  });
  o.d.listen(input, 'pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    e.preventDefault();
    const c = coord(e);
    const delta = (o.vertical ? drag.last - c : c - drag.last) / drag.len;
    drag.last = c;
    if (!delta) return;
    drag.pos = clamp(drag.pos + delta * (e.shiftKey ? 0.25 : 1), 0, 1);
    o.setPos(drag.pos);
  });
  const end = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    try {
      input.releasePointerCapture(drag.id);
    } catch {
      /* not captured */
    }
    drag = null;
    input.classList.remove('dragging');
    o.onEnd?.();
  };
  o.d.listen(input, 'pointerup', end);
  o.d.listen(input, 'pointercancel', end);
  o.d.listen(input, 'lostpointercapture', end);
  return {
    get active() {
      return !!drag;
    },
    /** Abandon the drag without calling onEnd: later moves of this pointer are ignored (round2-ui #2). */
    cancel() {
      if (!drag) return;
      const id = drag.id;
      drag = null; // first, so the lostpointercapture below is a no-op
      input.classList.remove('dragging');
      try {
        input.releasePointerCapture(id);
      } catch {
        /* not captured */
      }
    },
  };
}
