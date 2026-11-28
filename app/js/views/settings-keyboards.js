// Settings › MIDI keyboard › "Your keyboards" (v11-touch). One row per keyboard (connected MIDI inputs, keyboards
// saved in settings.keyboards, and the on-screen + computer keys), keyed by device name:
//   - Touch: "Standard" (the Touch setting above) or the keyboard's own curve. "Touch…" opens the calibration editor
//     (TOUCH, D43: components/velocity-editor.js; Pianoteq's points curve, its text format, a five-step assistant,
//     a live readout and a histogram) and "Back to standard". An older {shape,min,max,top} curve (v11-touch) keeps
//     playing until the player saves points. Slots on Response "Normal" follow the keyboard's curve.
//   - Dynamics (settings.dynamicRange, TOUCH D43): one slider in dB for every keyboard on this computer.
//   - Remember (MIDI only, BACKLOG B "first input heuristics"): prefer this keyboard when the input is "First keyboard
//     (automatic)", even when its name looks like a virtual port. "Forget" drops everything saved for it.
// Quiet by default: nothing is saved until the player uses a control; a keyboard without an entry behaves as before.
// settings.keyboards is device-local (v11-decisions, checklist Q7): it stays on this computer, never in an export.
// Writes go through store.setKeyboard (names contain dots, so they are not set() paths); notes through the controller.
import {
  normalizeTouch, touchWord, COMPUTER_KEYBOARD, DYN_RANGE, DYN_SPAN_MULTI_DB, DYN_SPAN_SINGLE_DB,
  velocityDb, dynamicsDb, rangeOfDynamicsDb,
} from '../shared/touch-curve.js';
import { presetOfCurve, CAL_PRESET_LABELS } from '../shared/velocity-cal.js';
import { say } from './components/voice.js';
import { velocityEditor } from './components/velocity-editor.js';

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
    // add, never replace: btn() passes {class} on top of the tag's .ed-btn (screenshot pass 2026-11-20: every button
    // in Your keyboards lost its styling)
    else if (k === 'class') e.classList.add(...String(v).split(/\s+/).filter(Boolean));
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}
const btn = (text, on, attrs = {}) => h('button.ed-btn', { type: 'button', ...attrs, on: { click: on } }, text);
const setText = (e, t) => {
  if (e.textContent !== String(t)) e.textContent = String(t);
};

/**
 * @param {{store:object, controller:object, midi?:object, listen:(t:EventTarget, type:string, fn:Function)=>void,
 *          toast?:(msg:string, kind?:string)=>void}} o
 * @returns {{el:HTMLElement, render():void, stop():void, destroy():void}}
 */
export function mountKeyboards({ store, controller, midi, listen, toast = () => {} }) {
  const list = h('div.st-kb-list', { role: 'list' });
  // Dynamics (settings.dynamicRange; Ryan 2026-11-20, TOUCH D43): one slider for every keyboard on this computer, in dB
  // like Pianoteq's Dynamics: the span from the softest note to the loudest on a multi-layer (piano) sound. The store
  // keeps the multiplier (1 = the built-in 10 dB); synths and organ keep their own response.
  const dbMin = DYN_SPAN_MULTI_DB * DYN_RANGE.min;
  const dbMax = DYN_SPAN_MULTI_DB * DYN_RANGE.max;
  const rangeIn = h('input', { type: 'range', min: dbMin, max: dbMax, step: DYN_SPAN_MULTI_DB * DYN_RANGE.step,
    'aria-label': 'Dynamics: decibels from the softest note to the loudest',
    dataset: { testid: 'setting-dynamic-range' } });
  const rangeOut = h('output.st-kb-val', { dataset: { testid: 'dynamic-range-value' } });
  const rangeSpan = h('small.st-hint', { dataset: { testid: 'dynamic-range-span' } });
  rangeIn.addEventListener('input', () => store.set('settings.dynamicRange', rangeOfDynamicsDb(Number(rangeIn.value))));
  const rangeRow = h('div.st-kb-range', {},
    h('label.st-kb-slider', {}, h('span', { text: 'Dynamics' }), rangeIn, rangeOut),
    rangeSpan);
  const el = h('div.st-kbs', { dataset: { testid: 'settings-keyboards' } },
    h('h3.st-h3', { text: 'Your keyboards' }),
    h('p.st-hint', { text: say('keyboardsHint') }), // v11-decisions: device-local, said so
    rangeRow,
    list);
  const fmtDb = (v) => `${Number(v.toFixed(1))} dB`;
  function renderRange() {
    const r = store.get().settings.dynamicRange ?? 1;
    const db = dynamicsDb(r);
    if (document.activeElement !== rangeIn) rangeIn.value = String(Math.round(db * 10) / 10);
    rangeOut.textContent = fmtDb(db);
    rangeOut.dataset.range = String(r);
    const single = dynamicsDb(r, DYN_SPAN_SINGLE_DB);
    const top = velocityDb(1, DYN_SPAN_MULTI_DB, r);
    const capped = single < DYN_SPAN_SINGLE_DB * r - 1e-9;
    rangeSpan.textContent = `From the softest note to the loudest on pianos (sounds with several sample layers)`
      + `${top > 0.05 ? `; the hardest notes play up to +${top.toFixed(1)} dB over the standard` : ''}. `
      + `Other sampled sounds: ${fmtDb(single)}${capped ? ' (their most)' : ''}. Synths and organ keep their own `
      + `response. ${fmtDb(DYN_SPAN_MULTI_DB)} is the standard; Pianoteq's default is 60 dB.`;
  }
  /** @type {Map<string, ReturnType<typeof makeRow>>} */
  const rows = new Map();
  let openName = null;

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
      store.setKeyboard(name, null);
      toast(`Forgot ${labelOf(name)}`);
    }, { class: 'st-kb-forget', 'aria-label': `Forget ${labelOf(name)}` });

    // ---- editor (built once, shown while open; it listens to notes only while open)
    const cal = velocityEditor({ name, label: labelOf(name), store, controller, toast });
    const stdBtn = btn('Back to standard', () => store.setKeyboard(name, { touch: null, velocity: null }),
      { class: 'st-kb-std' });
    const editor = h('div.st-kb-edit', { hidden: true }, cal.el, h('div.st-kb-btns', {}, stdBtn));
    const head = h('div.st-kb-head', {}, h('span.st-kb-who', {}, title, state), summary,
      h('span.st-kb-acts', {}, touchBtn, remember, forget));
    const rowEl = h('div.st-kb', { role: 'listitem', dataset: { keyboard: name } }, head, editor);
    let wasOpen = false;

    return {
      el: rowEl,
      cal,
      update(connected, virtual) {
        const e = saved()[name] || {};
        setText(state, isPc ? '' : connected ? (virtual ? 'connected · virtual port' : 'connected') : 'not connected');
        const t = e.touch ? normalizeTouch(e.touch) : null;
        const p = e.velocity ? presetOfCurve(e.velocity) : null;
        setText(summary, e.velocity ? `Own curve · ${p ? CAL_PRESET_LABELS[p] : `${e.velocity.in.length} points`}`
          : t ? `Own touch · ${touchWord(t)}` : 'Standard touch');
        summary.classList.toggle('own', !!(t || e.velocity));
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
        stdBtn.disabled = !(t || e.velocity);
        if (open && !wasOpen) cal.open();
        else if (!open && wasOpen) cal.close();
        else if (open) cal.update();
        wasOpen = open;
      },
      close() {
        if (wasOpen) cal.close();
        wasOpen = false;
      },
    };
  }

  function toggle(name) {
    openName = openName === name ? null : name;
    render();
  }

  function render() {
    renderRange();
    const want = names();
    const order = want.map((w) => w.name);
    for (const [n, r] of rows) {
      if (!order.includes(n)) {
        if (openName === n) openName = null;
        r.cal.destroy();
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
    /** Settings closed: stop listening to notes and drop a running assistant (the editor stays open). */
    stop() {
      for (const r of rows.values()) r.close();
    },
    destroy() {
      for (const r of rows.values()) r.cal.destroy();
      rows.clear();
      el.remove();
    },
  };
}
