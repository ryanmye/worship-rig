// Settings › MIDI keyboard › "Your keyboards" (v11-touch). One row per keyboard (connected MIDI inputs, keyboards
// saved in settings.keyboards, and the on-screen + computer keys), keyed by device name:
//   - Touch: "Standard" (the Touch setting above) or the keyboard's own curve. "Touch…" opens an editor: a curve
//     diagram, Feel / Softest / Loudest / Full volume at, "Fit to my touch" (play soft, then hard: shared/touch-curve
//     fitTouch over controller.captureTouch) and "Back to standard". Slots on Response "Normal" follow this curve.
//   - Remember (MIDI only, BACKLOG B "first input heuristics"): prefer this keyboard when the input is "First keyboard
//     (automatic)", even when its name looks like a virtual port. "Forget" drops everything saved for it.
// Quiet by default: nothing is saved until the player uses a control; a keyboard without an entry behaves as before.
// settings.keyboards is device-local (v11-decisions, checklist Q7): it stays on this computer, never in an export.
// Writes go through store.setKeyboard (names contain dots, so they are not set() paths); notes through the controller.
import {
  TOUCH_RANGE, normalizeTouch, compileTouch, touchAt, touchWord, fitTouch, FIT_NOTES, LINEAR_TOUCH, COMPUTER_KEYBOARD,
} from '../shared/touch-curve.js';
import { say } from './components/voice.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Display name of the on-screen + computer keys entry. */
export const COMPUTER_KEYBOARD_LABEL = 'On-screen & computer keys';

function h(tag, attrs = {}, ...kids) {
  const [name, ...cls] = tag.split('.');
  const e = document.createElement(name || 'div');
  if (cls.length) e.className = cls.join(' ');
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') e.textContent = String(v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k === 'on') for (const [t, fn] of Object.entries(v)) e.addEventListener(t, fn);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}
const btn = (text, on, attrs = {}) => h('button.ed-btn', { type: 'button', ...attrs, on: { click: on } }, text);
const setText = (e, t) => {
  if (e.textContent !== String(t)) e.textContent = String(t);
};
const pct = (v) => `${Math.round(v * 100)}%`;

/**
 * Curve diagram (x = how hard you play, y = how loud it sounds) as an SVG, coloured by theme tokens only (the
 * reference diagonal is --line-2: visible on the Day themes, themes-critic T3).
 * @param {string} label
 * @returns {{el:SVGSVGElement, draw(curve:object|null, marks?:number[]):void}}
 */
export function curveDiagram(label) {
  const W = 120;
  const H = 64;
  const P = 4;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'st-kb-curve');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  const mk = (n, a) => {
    const e = document.createElementNS(SVG_NS, n);
    for (const [k, v] of Object.entries(a)) e.setAttribute(k, String(v));
    svg.append(e);
    return e;
  };
  mk('line', { x1: P, y1: H - P, x2: W - P, y2: P, class: 'st-kb-ref' });
  const path = mk('polyline', { class: 'st-kb-line', fill: 'none' });
  const dots = [mk('circle', { r: 3, class: 'st-kb-mark' }), mk('circle', { r: 3, class: 'st-kb-mark' })];
  const X = (v) => P + ((v - 1) / 126) * (W - 2 * P);
  const Y = (y) => H - P - y * (H - 2 * P);
  return {
    el: svg,
    draw(curve, marks = []) {
      const c = curve || LINEAR_TOUCH;
      const pts = [];
      for (let v = 1; v <= 127; v += 3) pts.push(`${X(v).toFixed(1)},${Y(touchAt(c, v)).toFixed(1)}`);
      pts.push(`${X(127).toFixed(1)},${Y(touchAt(c, 127)).toFixed(1)}`);
      path.setAttribute('points', pts.join(' '));
      dots.forEach((d, i) => {
        const m = marks[i];
        d.style.display = Number.isFinite(m) ? '' : 'none';
        if (Number.isFinite(m)) {
          d.setAttribute('cx', X(m).toFixed(1));
          d.setAttribute('cy', Y(touchAt(c, m)).toFixed(1));
        }
      });
    },
  };
}

/** Shape slider position (−2..2, log2 of the exponent) ↔ shape. */
const shapeOfPos = (p) => Math.round(Math.pow(2, p) * 1000) / 1000;
const posOfShape = (s) => Math.log2(s);

/**
 * @param {{store:object, controller:object, midi?:object, listen:(t:EventTarget, type:string, fn:Function)=>void,
 *          toast?:(msg:string, kind?:string)=>void}} o
 * @returns {{el:HTMLElement, render():void, stop():void, destroy():void}}
 */
export function mountKeyboards({ store, controller, midi, listen, toast = () => {} }) {
  const list = h('div.st-kb-list', { role: 'list' });
  const el = h('div.st-kbs', { dataset: { testid: 'settings-keyboards' } },
    h('h3.st-h3', { text: 'Your keyboards' }),
    h('p.st-hint', { text: say('keyboardsHint') }), // v11-decisions: device-local, said so
    list);
  /** @type {Map<string, ReturnType<typeof makeRow>>} */
  const rows = new Map();
  let openName = null;
  let fit = null; // {name, step:'soft'|'hard'|'result', soft:[], hard:[], stop()}

  const saved = () => store.get().settings.keyboards || {};
  const names = () => {
    const out = [];
    const seen = new Set();
    const add = (n, connected, virtual) => {
      if (!n || seen.has(n)) return;
      seen.add(n);
      out.push({ name: n, connected, virtual });
    };
    for (const i of (midi && midi.inputs) || []) {
      if (i.state !== 'disconnected') add(i.name, true, !!i.virtual && !i.remembered);
    }
    for (const n of Object.keys(saved())) if (n !== COMPUTER_KEYBOARD) add(n, false, false);
    add(COMPUTER_KEYBOARD, true, false);
    return out;
  };
  const labelOf = (name) => (name === COMPUTER_KEYBOARD ? COMPUTER_KEYBOARD_LABEL : name);

  function stopFit() {
    if (!fit) return;
    fit.stop();
    fit = null;
  }

  function makeRow(name) {
    const isPc = name === COMPUTER_KEYBOARD;
    const title = h('span.st-kb-name', { text: labelOf(name) });
    const state = h('small.st-kb-state');
    const summary = h('span.st-kb-sum');
    const touchBtn = btn('Touch…', () => toggle(name), { class: 'st-kb-touch', 'aria-expanded': 'false',
      'aria-label': `Touch for ${labelOf(name)}` });
    const remember = isPc ? null : btn('Remember', () => {
      const on = saved()[name]?.remember === true;
      store.setKeyboard(name, { remember: on ? null : true });
      if (!on) toast(`${name} will be picked first when it is connected`);
    }, { class: 'st-kb-remember', 'aria-pressed': 'false', title: 'Prefer this keyboard when the input is automatic' });
    const forget = btn('Forget', () => {
      if (fit && fit.name === name) stopFit();
      store.setKeyboard(name, null);
      toast(`Forgot ${labelOf(name)}`);
    }, { class: 'st-kb-forget', 'aria-label': `Forget ${labelOf(name)}` });

    // ---- editor (built once, shown while open)
    const diagram = curveDiagram(`Touch curve for ${labelOf(name)}`);
    const slider = (key, label, min, max, step, fmt) => {
      const input = h('input', { type: 'range', min, max, step, 'aria-label': `${label} (${labelOf(name)})`,
        dataset: { touch: key } });
      const out = h('output.st-kb-val');
      const wrap = h('label.st-kb-slider', {}, h('span', { text: label }), input, out);
      input.addEventListener('input', () => {
        const cur = normalizeTouch(saved()[name]?.touch);
        const v = Number(input.value);
        cur[key] = key === 'shape' ? shapeOfPos(v) : key === 'top' ? Math.round(v) : v;
        if (key === 'min' && cur.min > cur.max) cur.max = cur.min; // keep them ordered (the curve never runs backwards)
        if (key === 'max' && cur.max < cur.min) cur.min = cur.max;
        store.setKeyboard(name, { touch: cur });
      });
      return { wrap, input, out, fmt, key };
    };
    const sliders = [
      slider('shape', 'Feel', -2, 2, 0.01, (t) => touchWord(t)),
      slider('min', 'Softest', 0, 1, 0.01, (t) => pct(t.min)),
      slider('max', 'Loudest', 0, 1, 0.01, (t) => pct(t.max)),
      slider('top', 'Full volume at', TOUCH_RANGE.top.min, TOUCH_RANGE.top.max, 1, (t) => String(t.top)),
    ];
    const fitBox = h('div.st-kb-fit', { 'aria-live': 'polite' });
    const fitBtn = btn('Fit to my touch', () => startFit(name), { class: 'st-kb-fitbtn' });
    const stdBtn = btn('Back to standard', () => store.setKeyboard(name, { touch: null }), { class: 'st-kb-std' });
    const editor = h('div.st-kb-edit', { hidden: true },
      h('div.st-kb-graph', {}, diagram.el,
        h('small.st-hint', { text: 'Left = soft key press, right = hard; up = louder.' })),
      h('div.st-kb-sliders', {}, sliders.map((s) => s.wrap)),
      h('div.st-kb-btns', {}, fitBtn, stdBtn),
      fitBox);
    const head = h('div.st-kb-head', {}, h('span.st-kb-who', {}, title, state), summary,
      h('span.st-kb-acts', {}, touchBtn, remember, forget));
    const rowEl = h('div.st-kb', { role: 'listitem', dataset: { keyboard: name } }, head, editor);

    return {
      el: rowEl,
      fitBox,
      update(connected, virtual) {
        const e = saved()[name] || {};
        setText(state, isPc ? '' : connected ? (virtual ? 'connected · virtual port' : 'connected') : 'not connected');
        const t = e.touch ? normalizeTouch(e.touch) : null;
        setText(summary, t ? `Own touch · ${touchWord(t)}` : 'Standard touch');
        summary.classList.toggle('own', !!t);
        if (remember) {
          const on = e.remember === true;
          remember.setAttribute('aria-pressed', String(on));
          remember.classList.toggle('on', on);
          setText(remember, on ? 'Remembered' : 'Remember');
        }
        forget.hidden = !Object.keys(e).length;
        const open = openName === name;
        editor.hidden = !open;
        touchBtn.setAttribute('aria-expanded', String(open));
        stdBtn.disabled = !t;
        const shown = t || normalizeTouch();
        for (const s of sliders) {
          const v = s.key === 'shape' ? posOfShape(shown.shape) : shown[s.key];
          if (document.activeElement !== s.input) s.input.value = String(v);
          s.out.value = s.fmt(shown);
          setText(s.out, s.fmt(shown));
        }
        if (!(fit && fit.name === name && fit.step === 'result')) diagram.draw(t ? compileTouch(t) : null);
      },
      preview(touch, marks) {
        diagram.draw(compileTouch(touch), marks);
      },
    };
  }

  function toggle(name) {
    if (openName === name) {
      if (fit && fit.name === name) stopFit();
      openName = null;
    } else {
      stopFit();
      openName = name;
    }
    render();
  }

  // ---- "play soft, then hard"
  function startFit(name) {
    stopFit();
    if (typeof controller.captureTouch !== 'function') return;
    const f = { name, step: 'soft', soft: [], hard: [], stop: () => {} };
    fit = f;
    f.stop = controller.captureTouch((n) => {
      if (fit !== f || n.device !== name) return; // only the keyboard being fitted
      if (f.step === 'soft') {
        f.soft.push(n.velocity);
        if (f.soft.length >= FIT_NOTES) f.step = 'hard';
      } else if (f.step === 'hard') {
        f.hard.push(n.velocity);
        if (f.hard.length >= FIT_NOTES) {
          f.step = 'result';
          f.stop();
        }
      }
      renderFit();
    });
    renderFit();
  }

  function renderFit() {
    const f = fit;
    if (!f) return;
    const row = rows.get(f.name);
    if (!row) return;
    const cancel = btn('Cancel', () => {
      stopFit();
      row.fitBox.replaceChildren();
      render();
    }, { class: 'st-kb-cancel' });
    const who = f.name === COMPUTER_KEYBOARD ? 'the on-screen keys (higher on a key = softer)' : f.name;
    if (f.step === 'soft') {
      row.fitBox.replaceChildren(h('strong.st-kb-prompt', { dataset: { step: 'soft' },
        text: `Play ${FIT_NOTES} notes softly on ${who}, as quietly as you would really play. `
          + `${f.soft.length} of ${FIT_NOTES}` }),
      cancel);
      return;
    }
    if (f.step === 'hard') {
      row.fitBox.replaceChildren(h('strong.st-kb-prompt', { dataset: { step: 'hard' },
        text: `Now play ${FIT_NOTES} notes hard, as strongly as you ever play. ${f.hard.length} of ${FIT_NOTES}` }),
      cancel);
      return;
    }
    const r = fitTouch(f.soft, f.hard, saved()[f.name]?.touch);
    if (!r.ok) {
      const msg = r.reason === 'same'
        ? `Your soft and hard notes came in at about the same strength (${Math.round(r.soft)}), so there is nothing to `
          + 'fit. The computer keys always play at one strength; try again with more difference.'
        : 'Not enough notes came in. Try again.';
      row.fitBox.replaceChildren(h('span.st-kb-result', { dataset: { result: r.reason }, text: msg }),
        btn('Try again', () => startFit(f.name), { class: 'st-kb-again' }), cancel);
      return;
    }
    row.preview(r.touch, [r.soft, r.hard]);
    row.fitBox.replaceChildren(
      h('span.st-kb-result', { dataset: { result: 'ok' }, text: `Soft notes came in around ${Math.round(r.soft)}, hard `
        + `around ${Math.round(r.hard)}. With this curve they play at about 30% and full volume.` }),
      btn('Use this', () => {
        stopFit();
        row.fitBox.replaceChildren();
        store.setKeyboard(f.name, { touch: r.touch });
        toast(`${labelOf(f.name)} now has its own touch`);
      }, { class: 'st-kb-use' }),
      btn('Try again', () => startFit(f.name), { class: 'st-kb-again' }),
      cancel);
  }

  function render() {
    const want = names();
    const order = want.map((w) => w.name);
    for (const [n, r] of rows) {
      if (!order.includes(n)) {
        if (fit && fit.name === n) stopFit();
        if (openName === n) openName = null;
        r.el.remove();
        rows.delete(n);
      }
    }
    for (const w of want) {
      let r = rows.get(w.name);
      if (!r) rows.set(w.name, (r = makeRow(w.name)));
      r.update(w.connected, w.virtual);
    }
    const els = order.map((n) => rows.get(n).el);
    if (els.some((e, i) => list.children[i] !== e) || list.children.length !== els.length) list.replaceChildren(...els);
  }

  if (midi) listen(midi, 'devices', render);
  render();
  return {
    el,
    render,
    /** Stop a running fit (Settings closed). */
    stop() {
      stopFit();
      for (const r of rows.values()) r.fitBox.replaceChildren();
      render();
    },
    destroy() {
      stopFit();
      rows.clear();
      el.remove();
    },
  };
}
