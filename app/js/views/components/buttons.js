// toggle(), segmented(), select(), stepper() — SPEC §13. Each returns { el, set(value), destroy() }.
import { h, setText, nextId, disposer, blurAfterPointer, clamp } from './util.js';

/**
 * Toggle button (aria-pressed).
 * @param {{label:string, value?:boolean, onChange?:(on:boolean)=>void, title?:string, className?:string,
 *          onLabel?:string, offLabel?:string, tag?:string}} o
 */
export function toggle(o = {}) {
  const d = disposer();
  let on = !!o.value;
  const text = h('span.toggle-text');
  const tag = o.tag ? h('span.tag', { text: o.tag }) : null;
  const el = h('button.toggle', { type: 'button', title: o.title, 'aria-pressed': String(on) }, h('span.toggle-led', { 'aria-hidden': 'true' }), text, tag);
  if (o.className) el.classList.add(...String(o.className).split(/\s+/).filter(Boolean));
  const render = () => {
    el.setAttribute('aria-pressed', String(on));
    el.classList.toggle('on', on);
    setText(text, on ? o.onLabel ?? o.label ?? '' : o.offLabel ?? o.label ?? '');
  };
  d.listen(el, 'click', () => {
    on = !on;
    render();
    if (typeof o.onChange === 'function') o.onChange(on);
  });
  blurAfterPointer(el, d);
  render();
  return {
    el,
    set(v) {
      on = !!v;
      render();
    },
    get: () => on,
    setDisabled(b) {
      el.disabled = !!b;
    },
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}

/**
 * Segmented control (radio group of buttons). Arrow keys move the selection.
 * @param {{options:Array<{value:any,label:string,title?:string}>, value?:any, label?:string, onChange?:(v:any)=>void, className?:string}} o
 */
export function segmented(o = {}) {
  const d = disposer();
  const el = h('div.segmented', { role: 'radiogroup', 'aria-label': o.label || undefined });
  if (o.className) el.classList.add(...String(o.className).split(/\s+/).filter(Boolean));
  let value = o.value;
  let buttons = [];
  const render = () => {
    for (const b of buttons) {
      const sel = b._value === value;
      b.setAttribute('aria-checked', String(sel));
      b.tabIndex = sel || (!buttons.some((x) => x._value === value) && b === buttons[0]) ? 0 : -1;
      b.classList.toggle('on', sel);
    }
  };
  const choose = (v, focus) => {
    const changed = v !== value;
    value = v;
    render();
    if (focus) buttons.find((b) => b._value === v)?.focus();
    if (changed && typeof o.onChange === 'function') o.onChange(v);
  };
  const build = (options) => {
    el.replaceChildren();
    buttons = options.map((opt) => {
      const b = h('button.seg', { type: 'button', role: 'radio', title: opt.title, 'aria-checked': 'false', dataset: { value: String(opt.value) } }, opt.label);
      b._value = opt.value;
      b.addEventListener('click', (ev) => {
        choose(opt.value, false);
        if (ev.detail > 0) queueMicrotask(() => b.blur());
      });
      b.addEventListener('keydown', (ev) => {
        const i = buttons.indexOf(b);
        let j = -1;
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') j = (i + 1) % buttons.length;
        else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') j = (i - 1 + buttons.length) % buttons.length;
        if (j < 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (!buttons[j].disabled) choose(buttons[j]._value, true);
      });
      el.append(b);
      return b;
    });
    render();
  };
  build(o.options || []);
  return {
    el,
    set(v) {
      value = v;
      render();
    },
    get: () => value,
    setOptions(options) {
      build(options || []);
    },
    setDisabled(b, optValue) {
      for (const x of buttons) if (optValue === undefined || x._value === optValue) x.disabled = !!b;
      el.classList.toggle('disabled', optValue === undefined && !!b);
    },
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}

/**
 * Native <select> (optionally grouped: option.group → <optgroup>).
 * @param {{options:Array<{value:string,label:string,group?:string,disabled?:boolean}>, value?:string, label?:string, onChange?:(v:string)=>void}} o
 */
export function select(o = {}) {
  const d = disposer();
  const id = nextId('select');
  const sel = h('select.select-input', { id, 'aria-label': o.label || undefined });
  const el = h('div.select', {}, o.label ? h('label.select-label', { for: id, text: o.label }) : null, sel);
  if (o.className) el.classList.add(...String(o.className).split(/\s+/).filter(Boolean));
  let value = o.value;
  const build = (options) => {
    sel.replaceChildren();
    const groups = new Map();
    for (const opt of options) {
      const node = h('option', { value: String(opt.value), disabled: !!opt.disabled }, opt.label);
      if (opt.group) {
        let g = groups.get(opt.group);
        if (!g) {
          g = h('optgroup', { label: opt.group });
          groups.set(opt.group, g);
          sel.append(g);
        }
        g.append(node);
      } else sel.append(node);
    }
    if (value !== undefined) sel.value = String(value);
  };
  build(o.options || []);
  d.listen(sel, 'change', () => {
    value = sel.value;
    if (typeof o.onChange === 'function') o.onChange(value);
  });
  return {
    el,
    input: sel,
    set(v) {
      value = v;
      if (v !== undefined && v !== null && sel.value !== String(v)) sel.value = String(v);
    },
    get: () => value,
    setOptions(options) {
      build(options || []);
    },
    setDisabled(b) {
      sel.disabled = !!b;
    },
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}

/**
 * Stepper: [−] value [+] with role=spinbutton; ArrowUp/Down, PageUp/Down, Home/End.
 * @param {{min:number, max:number, step?:number, value?:number, label?:string, format?:(v:number)=>string,
 *          onChange?:(v:number)=>void, wrap?:boolean}} o
 */
export function stepper(o = {}) {
  const d = disposer();
  const min = Number.isFinite(o.min) ? o.min : 0;
  const max = Number.isFinite(o.max) ? o.max : 100;
  const step = o.step || 1;
  const format = o.format || ((v) => String(v));
  let value = Number.isFinite(o.value) ? o.value : min;
  const dec = h('button.step-btn.dec', { type: 'button', 'aria-label': `${o.label || 'Value'} down`, tabindex: '-1' }, '−');
  const inc = h('button.step-btn.inc', { type: 'button', 'aria-label': `${o.label || 'Value'} up`, tabindex: '-1' }, '+');
  const val = h('span.step-value', { role: 'spinbutton', tabindex: '0', 'aria-label': o.label || 'Value', 'aria-valuemin': String(min), 'aria-valuemax': String(max) });
  const el = h('div.stepper', {}, o.label ? h('span.stepper-label', { text: o.label }) : null, dec, val, inc);
  if (o.className) el.classList.add(...String(o.className).split(/\s+/).filter(Boolean));
  const norm = (v) => {
    let x = Math.round(v / step) * step;
    if (o.wrap) {
      const span = max - min + step;
      x = ((((x - min) % span) + span) % span) + min;
    }
    return clamp(Number(x.toFixed(6)), min, max);
  };
  const render = () => {
    setText(val, format(value));
    val.setAttribute('aria-valuenow', String(value));
    val.setAttribute('aria-valuetext', format(value));
    dec.disabled = !o.wrap && value <= min;
    inc.disabled = !o.wrap && value >= max;
  };
  const change = (v) => {
    const n = norm(v);
    if (n === value) return;
    value = n;
    render();
    if (typeof o.onChange === 'function') o.onChange(value);
  };
  d.listen(dec, 'click', () => change(value - step));
  d.listen(inc, 'click', () => change(value + step));
  blurAfterPointer(dec, d);
  blurAfterPointer(inc, d);
  d.listen(val, 'keydown', (ev) => {
    const map = { ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step, PageUp: step * 5, PageDown: -step * 5 };
    if (ev.key in map) change(value + map[ev.key]);
    else if (ev.key === 'Home') change(min);
    else if (ev.key === 'End') change(max);
    else return;
    ev.preventDefault();
    ev.stopPropagation();
  });
  render();
  return {
    el,
    set(v) {
      const n = Number(v);
      if (!Number.isFinite(n)) return;
      value = n;
      render();
    },
    get: () => value,
    setDisabled(b) {
      dec.disabled = inc.disabled = !!b;
      el.classList.toggle('disabled', !!b);
      if (!b) render();
    },
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}
