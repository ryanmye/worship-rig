// Settings › Keyboards & MIDI › Your keyboards › Touch…: one keyboard's velocity calibration curve (TOUCH, DECISIONS
// D43; Pianoteq's model). Parts:
//   - a graph (x = how hard the key was played, y = the velocity Rig plays), with the reference diagonal, a histogram
//     of the keyboard's last ~200 notes (controller.recentVelocities), the curve, draggable points (mouse, touch or
//     the arrow keys on a focused point; Delete removes it; a double click on the graph adds one) and a live marker of
//     the last note played;
//   - numbers for each point, presets (Linear plus the old named curves as points), Add point;
//   - Pianoteq's text format both ways (Copy, and paste + Use);
//   - the five-step assistant (silence, p, mp, f, fff; shared/velocity-cal.js fitCalibration).
// Writes go through store.setKeyboard(name, {velocity, touch: null}) only: a curve is saved when the player changes
// something (a drag on release, a number, a preset, a paste, the assistant's "Use this"); just opening the editor
// saves nothing, so an older {shape,min,max,top} curve keeps playing until then (it is shown converted to points).
// Notes reach the editor through controller.captureTouch while it is open (one listener: readout + assistant).
import { h, setText } from './util.js';
import {
  checkCurve, parseVelocity, formatVelocity, compileCurve, calAt, calVelocity, curveFromTouch, CAL_PRESETS,
  CAL_PRESET_LABELS, presetOfCurve, CAL_MAX_POINTS, CAL_MIN_POINTS, CAL_STEPS, CAL_TARGETS, CAL_NOTES, fitCalibration,
  sameCurve, VEL_MAX,
} from '../../shared/velocity-cal.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const W = 260;
const H = 200;
const PL = 26;
const PR = 8;
const PT = 8;
const PB = 20;
const X = (v) => PL + (v / VEL_MAX) * (W - PL - PR);
const Y = (v) => H - PB - (v / VEL_MAX) * (H - PB - PT);
const BINS = 16;
const r2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const copyOf = (c) => ({ in: c.in.slice(), out: c.out.slice() });

/** What each assistant step asks for (the step's median plays CAL_TARGETS[step]). */
export const STEP_TEXT = Object.freeze({
  silence: 'Silence: press keys as gently as you can, so softly that a real piano would make no sound.',
  p: 'p (soft): play as softly as you really play.',
  mp: 'mp (medium soft): a little stronger.',
  f: 'f (loud): play loud.',
  fff: 'fff: as hard as you ever play.',
});

function svgEl(parent, name, attrs = {}) {
  const e = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent.append(e);
  return e;
}

/**
 * One keyboard's curve editor.
 * @param {{name:string, label:string, store:object, controller:object, toast?:(m:string, k?:string)=>void}} o
 * @returns {{el:HTMLElement, update():void, open():void, close():void, destroy():void,
 *   readonly draft:{in:number[], out:number[]}}}
 */
export function velocityEditor({ name, label, store, controller, toast = () => {} }) {
  const entry = () => (store.get().settings.keyboards || {})[name] || {};
  /** The curve on show: the saved points, else the older curve as points, else Linear. */
  const shown = () => {
    const e = entry();
    if (e.velocity) return copyOf(e.velocity);
    if (e.touch) return curveFromTouch(e.touch);
    return copyOf(CAL_PRESETS.linear);
  };
  let draft = shown();
  let drag = null; // {i, pointerId}
  let last = null; // last note {raw, out}
  let stopCapture = null;
  let fit = null; // {step, sets, result?}

  // ---- graph
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'st-cal-graph');
  svg.setAttribute('role', 'group');
  svg.setAttribute('aria-label', `Velocity curve for ${label}: left = soft key press, right = hard; up = louder`);
  svgEl(svg, 'rect', { x: PL, y: PT, width: W - PL - PR, height: H - PT - PB, class: 'st-cal-bg' });
  for (const v of [32, 64, 96]) {
    svgEl(svg, 'line', { x1: X(v), y1: PT, x2: X(v), y2: H - PB, class: 'st-cal-grid' });
    svgEl(svg, 'line', { x1: PL, y1: Y(v), x2: W - PR, y2: Y(v), class: 'st-cal-grid' });
  }
  for (const v of [0, 32, 64, 96, 127]) {
    svgEl(svg, 'text', { x: X(v), y: H - 6, class: 'st-cal-tick', 'text-anchor': 'middle' }).textContent = String(v);
    svgEl(svg, 'text', { x: PL - 4, y: Y(v) + 3, class: 'st-cal-tick', 'text-anchor': 'end' }).textContent = String(v);
  }
  const hist = svgEl(svg, 'g', { class: 'st-cal-hist', 'aria-hidden': 'true' });
  const bars = Array.from({ length: BINS }, (_, i) => svgEl(hist, 'rect', {
    x: X((i * (VEL_MAX + 1)) / BINS) + 0.5, width: Math.max(1, X((VEL_MAX + 1) / BINS) - PL - 1), y: H - PB, height: 0,
  }));
  svgEl(svg, 'line', { x1: X(0), y1: Y(0), x2: X(VEL_MAX), y2: Y(VEL_MAX), class: 'st-kb-ref' });
  const line = svgEl(svg, 'polyline', { class: 'st-kb-line', fill: 'none' });
  const liveV = svgEl(svg, 'line', { class: 'st-cal-live', y1: PT, y2: H - PB });
  const liveDot = svgEl(svg, 'circle', { class: 'st-cal-livedot', r: 3.5 });
  const marks = svgEl(svg, 'g', { class: 'st-cal-marks', 'aria-hidden': 'true' });
  const ptsG = svgEl(svg, 'g', { class: 'st-cal-pts' });

  // ---- side: readout, numbers, presets, text, assistant
  const readout = h('div.st-cal-readout', { 'aria-live': 'polite', dataset: { testid: 'cal-readout' } });
  const histNote = h('small.st-hint.st-cal-histnote');
  const status = h('div.st-cal-status', { 'aria-live': 'polite', dataset: { testid: 'cal-status' } });
  const origin = h('small.st-hint.st-cal-origin');
  const table = h('div.st-cal-table', { role: 'table', 'aria-label': `Points of the curve for ${label}` });
  const addBtn = h('button.ed-btn.st-cal-add', { type: 'button', on: { click: () => addPoint() } }, 'Add point');
  const presetBtns = Object.keys(CAL_PRESETS).map((k) => h('button.ed-btn.st-cal-preset', {
    type: 'button', dataset: { preset: k }, 'aria-pressed': 'false',
    on: { click: () => commit(copyOf(CAL_PRESETS[k])) },
  }, CAL_PRESET_LABELS[k]));
  const text = h('input.st-cal-text', { type: 'text', spellcheck: 'false', autocomplete: 'off',
    'aria-label': `Curve for ${label} in Pianoteq's format`, dataset: { testid: 'cal-text' } });
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      usePasted();
    }
  });
  const copyBtn = h('button.ed-btn.st-cal-copy', { type: 'button', on: { click: () => copyText() } }, 'Copy');
  const useBtn = h('button.ed-btn.st-cal-use', { type: 'button', on: { click: () => usePasted() } }, 'Use pasted');
  const calBtn = h('button.ed-btn.st-cal-start', { type: 'button', on: { click: () => startFit() } }, 'Calibrate…');
  const fitBox = h('div.st-cal-fit', { 'aria-live': 'polite' });

  const el = h('div.st-cal', { dataset: { testid: 'cal-editor' } },
    h('div.st-cal-left', {}, svg, readout, histNote),
    h('div.st-cal-right', {},
      origin,
      h('div.st-cal-presets', { role: 'group', 'aria-label': 'Presets' }, presetBtns, calBtn),
      table,
      h('div.st-cal-row', {}, addBtn),
      h('label.st-cal-textrow', {}, h('span', { text: 'Pianoteq text' }), text),
      h('div.st-cal-row', {}, copyBtn, useBtn),
      status),
    fitBox);

  function say(msg, kind = '') {
    setText(status, msg || '');
    status.dataset.kind = kind;
  }

  // ---- drawing
  function drawHist() {
    const vels = typeof controller.recentVelocities === 'function' ? controller.recentVelocities(name) : [];
    const counts = new Array(BINS).fill(0);
    for (const v of vels) counts[Math.min(BINS - 1, Math.floor((v * BINS) / (VEL_MAX + 1)))] += 1;
    const max = Math.max(1, ...counts);
    const full = (H - PT - PB) * 0.35;
    counts.forEach((c, i) => {
      const hh = (c / max) * full;
      bars[i].setAttribute('y', (H - PB - hh).toFixed(1));
      bars[i].setAttribute('height', hh.toFixed(1));
    });
    setText(histNote, vels.length ? `Bars: the last ${vels.length} notes from this keyboard, by how hard they came in.`
      : 'Bars show how hard your recent notes came in.');
    hist.dataset.count = String(vels.length);
  }

  function drawLive() {
    const c = compileCurve(draft);
    if (!last || !c) {
      liveV.style.display = 'none';
      liveDot.style.display = 'none';
      setText(readout, 'Play a key: its velocity shows here.');
      return;
    }
    const out = calVelocity(c, last.raw);
    liveV.style.display = '';
    liveDot.style.display = '';
    liveV.setAttribute('x1', X(last.raw).toFixed(1));
    liveV.setAttribute('x2', X(last.raw).toFixed(1));
    liveDot.setAttribute('cx', X(last.raw).toFixed(1));
    liveDot.setAttribute('cy', Y(calAt(c, last.raw)).toFixed(1));
    setText(readout, `Last note: ${last.raw} → ${out ? `plays ${out}` : 'silent'}`);
    readout.dataset.raw = String(last.raw);
    readout.dataset.out = String(out);
  }

  function drawMarks(points) {
    marks.replaceChildren();
    for (const [x, y] of points || []) {
      svgEl(marks, 'rect', { x: X(x) - 3.5, y: Y(y) - 3.5, width: 7, height: 7, class: 'st-kb-mark',
        transform: `rotate(45 ${X(x).toFixed(1)} ${Y(y).toFixed(1)})` });
    }
  }

  function drawCurve(curve) {
    const pts = [[0, curve.out[0]], ...curve.in.map((x, i) => [x, curve.out[i]]), [VEL_MAX, curve.out.at(-1)]];
    line.setAttribute('points', pts.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(' '));
    const n = curve.in.length;
    while (ptsG.children.length > n) ptsG.lastChild.remove();
    while (ptsG.children.length < n) {
      const c = svgEl(ptsG, 'circle', { r: 5.5, class: 'st-cal-pt', tabindex: 0, role: 'slider' });
      c.addEventListener('keydown', onPointKey);
    }
    curve.in.forEach((x, i) => {
      const c = ptsG.children[i];
      c.dataset.i = String(i);
      c.setAttribute('cx', X(x).toFixed(1));
      c.setAttribute('cy', Y(curve.out[i]).toFixed(1));
      c.setAttribute('aria-label', `Point ${i + 1}: key ${x} plays ${curve.out[i]}`);
      c.setAttribute('aria-valuenow', String(curve.out[i]));
      c.setAttribute('aria-valuemin', '0');
      c.setAttribute('aria-valuemax', String(VEL_MAX));
      c.setAttribute('aria-valuetext', `key ${x} plays ${curve.out[i]}`);
    });
  }

  function drawTable() {
    const n = draft.in.length;
    if (table.children.length !== n + 1) {
      table.replaceChildren(h('div.st-cal-tr.st-cal-th', { role: 'row' },
        h('span', { role: 'columnheader', text: 'Key' }), h('span', { role: 'columnheader', text: 'Plays' }),
        h('span', { role: 'columnheader', text: '' })));
      for (let i = 0; i < n; i++) {
        const num = (k) => h('input.st-cal-num', { type: 'number', min: 0, max: VEL_MAX, step: 1, inputmode: 'decimal',
          dataset: { cal: k, i: String(i) }, 'aria-label': `Point ${i + 1} ${k === 'in' ? 'key velocity' : 'plays'}`,
          on: { change: onNumber } });
        const rm = h('button.ed-btn.st-cal-rm', { type: 'button', 'aria-label': `Remove point ${i + 1}`,
          dataset: { i: String(i) }, on: { click: () => removePoint(i) } }, '×');
        table.append(h('div.st-cal-tr', { role: 'row' }, num('in'), num('out'), rm));
      }
    }
    for (const inp of table.querySelectorAll('input.st-cal-num')) {
      const i = Number(inp.dataset.i);
      const v = String(inp.dataset.cal === 'in' ? draft.in[i] : draft.out[i]);
      if (document.activeElement !== inp && inp.value !== v) inp.value = v;
      inp.removeAttribute('aria-invalid');
    }
    for (const b of table.querySelectorAll('.st-cal-rm')) b.disabled = n <= CAL_MIN_POINTS;
    addBtn.disabled = n >= CAL_MAX_POINTS;
  }

  function draw() {
    const preview = fit && fit.result && fit.result.ok ? fit.result.curve : null;
    drawCurve(preview || draft);
    if (!preview) drawMarks(null);
    drawTable();
    drawLive();
    drawHist();
    const p = presetOfCurve(draft);
    for (const b of presetBtns) {
      const on = !preview && entry().velocity && p === b.dataset.preset;
      b.setAttribute('aria-pressed', String(!!on));
      b.classList.toggle('on', !!on);
    }
    if (document.activeElement !== text) text.value = formatVelocity(draft);
    const e = entry();
    setText(origin, e.velocity ? 'This keyboard plays this curve. Changes are saved as you make them.'
      : e.touch ? 'This keyboard has an older touch curve, shown here as points. Change anything to save it as points.'
        : 'Standard touch (the Touch setting) until you save a curve: change anything, or calibrate.');
  }

  // ---- edits
  function commit(curve) {
    const r = checkCurve(curve);
    if (!r.ok) {
      say(r.error, 'error');
      return false;
    }
    if (!store.setKeyboard(name, { velocity: r.curve, touch: null })) {
      say('That curve could not be saved.', 'error');
      return false;
    }
    draft = copyOf(r.curve);
    say('');
    draw();
    return true;
  }

  function movePoint(c, i, x, y) {
    const n = c.in.length;
    const lo = i > 0 ? c.in[i - 1] + 1 : 0;
    const hi = i < n - 1 ? c.in[i + 1] - 1 : VEL_MAX;
    if (lo <= hi) c.in[i] = r2(clamp(Math.round(x), lo, hi));
    c.out[i] = r2(clamp(Math.round(y), i > 0 ? c.out[i - 1] : 0, i < n - 1 ? c.out[i + 1] : VEL_MAX));
  }

  function toVel(e) {
    const m = svg.getScreenCTM();
    if (!m) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: ((p.x - PL) / (W - PL - PR)) * VEL_MAX, y: ((H - PB - p.y) / (H - PB - PT)) * VEL_MAX };
  }

  svg.addEventListener('pointerdown', (e) => {
    const t = e.target.closest && e.target.closest('.st-cal-pt');
    if (!t || fit) return;
    drag = { i: Number(t.dataset.i), pointerId: e.pointerId, moved: false };
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {
      // a synthetic pointer (tests) has no capture: the moves still arrive on the svg
    }
    t.focus({ preventScroll: true });
    e.preventDefault();
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = toVel(e);
    if (!p) return;
    movePoint(draft, drag.i, p.x, p.y);
    drag.moved = true;
    drawCurve(draft);
    drawTable();
    drawLive();
    if (document.activeElement !== text) text.value = formatVelocity(draft);
  });
  const endDrag = () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (moved) commit(draft);
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('dblclick', (e) => {
    if (fit || (e.target.closest && e.target.closest('.st-cal-pt'))) return;
    const p = toVel(e);
    if (p) addPoint(p.x);
  });

  function onPointKey(e) {
    if (fit) return;
    const i = Number(e.currentTarget.dataset.i);
    const step = e.shiftKey ? 5 : 1;
    const c = copyOf(draft);
    if (e.key === 'ArrowUp') movePoint(c, i, c.in[i], c.out[i] + step);
    else if (e.key === 'ArrowDown') movePoint(c, i, c.in[i], c.out[i] - step);
    else if (e.key === 'ArrowRight') movePoint(c, i, c.in[i] + step, c.out[i]);
    else if (e.key === 'ArrowLeft') movePoint(c, i, c.in[i] - step, c.out[i]);
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      removePoint(i);
      return;
    } else return;
    e.preventDefault();
    if (!sameCurve(c, draft)) commit(c);
    ptsG.children[i]?.focus({ preventScroll: true });
  }

  function onNumber(e) {
    const inp = e.currentTarget;
    const i = Number(inp.dataset.i);
    const v = inp.value.trim() === '' ? NaN : Number(inp.value);
    const c = copyOf(draft);
    c[inp.dataset.cal][i] = v;
    if (!commit(c)) inp.setAttribute('aria-invalid', 'true');
  }

  function addPoint(atX) {
    const c = copyOf(draft);
    if (c.in.length >= CAL_MAX_POINTS) {
      say(`A curve has at most ${CAL_MAX_POINTS} points.`, 'error');
      return;
    }
    let x = Number.isFinite(atX) ? Math.round(clamp(atX, 0, VEL_MAX)) : null;
    if (x === null) { // the middle of the widest gap (or past the ends)
      const edges = [0, ...c.in, VEL_MAX];
      let best = 0;
      for (let k = 1; k < edges.length; k++) {
        if (edges[k] - edges[k - 1] > best) {
          best = edges[k] - edges[k - 1];
          x = Math.round((edges[k] + edges[k - 1]) / 2);
        }
      }
    }
    if (x === null || c.in.includes(x)) {
      say('There is already a point there.', 'error');
      return;
    }
    const y = r2(calAt(compileCurve(c), x));
    const at = c.in.findIndex((v) => v > x);
    const k = at < 0 ? c.in.length : at;
    c.in.splice(k, 0, x);
    c.out.splice(k, 0, y);
    commit(c);
  }

  function removePoint(i) {
    if (draft.in.length <= CAL_MIN_POINTS) {
      say(`A curve needs at least ${CAL_MIN_POINTS} points.`, 'error');
      return;
    }
    const c = copyOf(draft);
    c.in.splice(i, 1);
    c.out.splice(i, 1);
    commit(c);
  }

  function usePasted() {
    const r = parseVelocity(text.value);
    if (!r.ok) {
      say(r.error, 'error');
      text.setAttribute('aria-invalid', 'true');
      return;
    }
    text.removeAttribute('aria-invalid');
    if (commit(r.curve)) toast(`${label}: pasted curve in use`);
  }

  async function copyText() {
    const t = formatVelocity(draft);
    text.value = t;
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('no clipboard');
      await navigator.clipboard.writeText(t);
      say('Copied. It pastes into Pianoteq (or here on another computer) as it is.');
    } catch {
      text.focus();
      text.select();
      say('Selected: press ⌘C (Ctrl+C) to copy it.');
    }
  }

  // ---- the five-step assistant
  function stopFit() {
    fit = null;
    fitBox.replaceChildren();
    drawMarks(null);
  }
  function startFit() {
    fit = { step: 0, sets: Object.fromEntries(CAL_STEPS.map((k) => [k, []])), result: null };
    say('');
    renderFit();
    draw();
  }
  function onFitNote(v) {
    if (!fit || fit.result) return;
    const k = CAL_STEPS[fit.step];
    fit.sets[k].push(v);
    if (fit.sets[k].length >= CAL_NOTES) {
      fit.step += 1;
      if (fit.step >= CAL_STEPS.length) fit.result = fitCalibration(fit.sets);
    }
    renderFit();
    if (fit.result) draw();
  }
  function renderFit() {
    if (!fit) return;
    const cancel = h('button.ed-btn.st-cal-cancel', { type: 'button', on: { click: () => {
      stopFit();
      draw();
    } } }, 'Cancel');
    const again = h('button.ed-btn.st-cal-again', { type: 'button', on: { click: () => startFit() } }, 'Try again');
    if (!fit.result) {
      const k = CAL_STEPS[fit.step];
      const n = fit.sets[k].length;
      const who = name.startsWith('@') ? ' on the on-screen keys (higher on a key = softer)' : '';
      fitBox.replaceChildren(
        h('strong.st-kb-prompt', { dataset: { step: k },
          text: `Step ${fit.step + 1} of ${CAL_STEPS.length} · ${STEP_TEXT[k]} Play ${CAL_NOTES} notes${who}. `
            + `${n} of ${CAL_NOTES}` }),
        cancel);
      return;
    }
    const r = fit.result;
    if (!r.ok) {
      const msg = r.reason === 'same'
        ? 'Every step came in at about the same strength, so there is nothing to fit. The computer keys always play '
          + 'at one strength.'
        : r.reason === 'order'
          ? `The ${r.step} notes did not come in harder than the step before (${Math.round(r.medians[r.step])}). `
            + 'Try again, with more difference between the steps.'
          : 'Not enough notes came in. Try again.';
      fitBox.replaceChildren(h('span.st-kb-result', { dataset: { result: r.reason }, text: msg }), again, cancel);
      return;
    }
    drawMarks(CAL_STEPS.map((k) => [r.medians[k], CAL_TARGETS[k]]));
    const m = CAL_STEPS.map((k) => `${k} ${Math.round(r.medians[k])}`).join(', ');
    const full = r.curve.in.at(-1);
    fitBox.replaceChildren(
      h('span.st-kb-result', { dataset: { result: 'ok' }, text: `Your notes came in at ${m}. They will play at `
        + `${CAL_STEPS.map((k) => CAL_TARGETS[k]).join(' / ')}, with full level from ${Math.round(full)}`
        + `${full < VEL_MAX ? '' : ' (your keyboard tops out)'}: notes harder than your fff still get louder.` }),
      h('button.ed-btn.st-cal-fituse', { type: 'button', on: { click: () => {
        const c = r.curve;
        stopFit();
        if (commit(c)) toast(`${label} is calibrated`);
      } } }, 'Use this'),
      again, cancel);
  }

  return {
    el,
    get draft() {
      return copyOf(draft);
    },
    /** Store changed: show the saved curve (unless a drag is under way). */
    update() {
      if (!drag) draft = shown();
      draw();
    },
    /** The editor is on show: listen to this keyboard's notes. */
    open() {
      draft = shown();
      if (!stopCapture && typeof controller.captureTouch === 'function') {
        stopCapture = controller.captureTouch((n) => {
          if (n.device !== name) return;
          last = { raw: n.velocity };
          if (fit) onFitNote(n.velocity);
          drawLive();
          drawHist();
        });
      }
      draw();
    },
    /** Hidden: stop listening, drop a running assistant. */
    close() {
      if (stopCapture) stopCapture();
      stopCapture = null;
      stopFit();
      drag = null;
    },
    destroy() {
      this.close();
      el.remove();
    },
  };
}
