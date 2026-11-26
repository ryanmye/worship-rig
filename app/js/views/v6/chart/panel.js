// UI v6 chart panel (D7, D12, D16; UI6-build-plan U7b; mockup native/docs/design/mockups/chart.html, mock_chart.py
// chart_head() / chart_panel()). One component for both places the chart can be: on the stage (beside the mini
// faders) or in the right sidebar (the Chart module). Header: title + "Key C · written in G · 72 bpm · 4/4",
// Heard / Hands, the text size group (small A · % · big A · Fit), Edit chart…, ⇥ Sidebar / ⤢ Stage; ▶ Scroll with its
// speed; section jump buttons. Body: today's sheet (render.js) under a reading line, the line at it lit.
// The chart logic is today's (views/chart/core.js + logic.js: the key on show follows the song key incl. the relative
// key, auto-scroll pace, paging); nothing of it is copied here. Reading, scrolling and the text size stay live under
// Lock; Edit chart… is refused under Lock (chart-view V4).
import { h, setText, disposer, rafCoalesce } from '../../components/util.js';
import { createChartCore } from '../../chart/core.js';
import {
  CHART_SPEED_STEPS, CHART_PCT_DEFAULT, FALLBACK_TEMPO, stepIndex, stepPct, pctPx, fitPct, longestLineCh, jumpLabel,
} from '../../chart/logic.js';
import { DEFAULT_TIME_SIG } from '../../../shared/click-math.js';
import { button } from '../lib.js';

/** Where the reading line sits, as a share of the visible chart's height (mockup .readline top: 38 %). */
export const READ_AT = 0.38;
/** How long "Text 150%" shows after a size change. */
const READOUT_MS = 1300;
/** ⌘-scroll / trackpad pinch: this much wheel delta is one step. */
const WHEEL_STEP = 60;
/** Two-finger pinch: the distance ratio that is one step. */
const PINCH_STEP = 1.18;
/** Arrow keys on the focused chart scroll by this much (as the Notes module). */
const LINE_PX = 40;

const speedText = (x) => `${Number.isInteger(x) ? x.toFixed(1) : String(x)}×`;

/**
 * @param {object} c  the chart controller (views/v6/chart/chart.js): store, prefs, save(), locked(), pct(where),
 *   setPct(where, pct, why), setPlacement(where), closeStage(), openEdit(opener)
 * @param {'stage'|'side'} where
 * @returns {{el:HTMLElement, render(force?:boolean):void, step(dir:number, why?:string):void, reset():void, fit():void,
 *   state():object, destroy():void}}
 */
export function chartPanel(c, where) {
  const { store } = c;
  const d = disposer();
  const T = (id) => `v6-chart-${id}`;
  const btn = (cls, content, attrs = {}) => button(d, cls, content, attrs);

  // ---- header
  const titleEl = h('b.v6-ch-title', { 'data-testid': T('title') });
  const keyEm = h('em', {});
  const keyRest = h('span', {});
  const keyEl = h('small.v6-ch-key', { 'data-testid': T('key') }, keyEm, keyRest);
  const modeHear = btn('.v6-ch-seg', 'Heard', {
    'data-mode': 'hear', 'data-testid': T('hear'), title: 'Chords in the key the band hears',
  });
  const modePlay = btn('.v6-ch-seg', 'Hands', {
    'data-mode': 'play', 'data-testid': T('play'), title: 'Chords in the key your hands play (Easy Transpose)',
  });
  const smaller = btn('.v6-ts-b.sm-a', 'A', { 'aria-label': 'Smaller text', 'data-testid': T('smaller') });
  const pctBtn = btn('.v6-ts-n', '100%', { 'data-testid': T('pct'), title: 'Text size: tap to go back to 100%' });
  const bigger = btn('.v6-ts-b.big-a', 'A', { 'aria-label': 'Bigger text', 'data-testid': T('bigger') });
  const fitBtn = btn('.v6-ts-fit', 'Fit', {
    'data-testid': T('fit'), title: 'Biggest size where the longest line still fits',
  });
  const editBtn = btn('.ghost.v6-ch-edit', 'Edit chart…', { 'data-testid': T('edit') });
  const placeBtn = btn('.ghost.v6-ch-place', [h('span', { text: where === 'stage' ? '⇥' : '⤢' }),
    h('span.v6-ch-lab', { text: where === 'stage' ? ' Sidebar' : ' Stage' })], {
    'data-testid': T('place'), 'aria-label': where === 'stage' ? 'Sidebar' : 'Stage',
    title: where === 'stage' ? 'Show the chart in the sidebar instead (this device remembers)'
      : 'Show the chart on the stage, with the instruments as small faders (this device remembers)',
  });
  const autoBtn = btn('.v6-ch-play', '▶ Scroll', { 'aria-pressed': 'false', 'data-testid': T('auto') });
  const slower = btn('.v6-ch-sq', '−', { 'aria-label': 'Scroll slower', 'data-testid': T('slower') });
  const speedEl = h('b.v6-ch-speed', { 'data-testid': T('speed') });
  const faster = btn('.v6-ch-sq', '+', { 'aria-label': 'Scroll faster', 'data-testid': T('faster') });
  const jumps = h('div.v6-ch-jumps', { role: 'group', 'aria-label': 'Jump to a section', 'data-testid': T('jumps') });
  const head = h('div.v6-ch-head', {},
    h('div.v6-ch-r1', {},
      h('div.v6-ch-t', {}, titleEl, keyEl),
      h('div.v6-ch-grp', {},
        h('div.v6-ch-mode', { role: 'group', 'aria-label': 'Key on show' }, modeHear, modePlay),
        h('div.v6-tsize', { role: 'group', 'aria-label': 'Text size' }, smaller, pctBtn, bigger, fitBtn),
        where === 'stage' ? editBtn : null, placeBtn)),
    h('div.v6-ch-r2', {},
      jumps,
      // the sidebar's narrower header puts Edit chart… after the scroll controls (one row fewer)
      h('div.v6-ch-scroll', {}, autoBtn, slower, speedEl, faster, where === 'side' ? editBtn : null)));

  // ---- body: the sheet under the reading line
  const sheet = h('div.chv-sheet.v6-ch-sheet', { 'data-testid': T('sheet') });
  const probe = h('span.v6-ch-probe', { 'aria-hidden': 'true', text: '0000000000' });
  const addBtn = btn('', 'Add a chart…', { 'data-testid': T('add') });
  const empty = h('div.v6-ch-empty', { 'data-testid': T('empty') }, h('p', { text: 'No chart for this song yet.' }),
    addBtn);
  const body = h('div.v6-ch-body', {
    tabindex: '0', 'data-testid': T('body'), 'aria-label': 'Chord chart',
  }, sheet, empty, probe);
  const readline = h('div.v6-ch-readline', { 'aria-hidden': 'true', 'data-testid': T('readline') });
  const readout = h('div.v6-ch-readout', { role: 'status', hidden: true, 'data-testid': T('readout') });
  const wrap = h('div.v6-ch-wrap', {}, body, readline, readout);
  const el = h(`section.v6-chart.v6-chart-${where}`, {
    'data-testid': T(where), 'aria-label': 'Chord chart', dataset: { where },
  }, head, wrap);

  const song = () => store.currentSong();
  let sections = []; // the drawn <section>s, for the jumps and the current section
  let lines = []; // the drawn lines, for the reading line
  let curLine = null;
  let curSec = -1;

  const core = createChartCore({
    store, panel: el, body, sheet, empty,
    mode: () => c.prefs.mode,
    speed: () => c.prefs.speed,
    onTools: () => renderTools(),
    onView: (view, s) => {
      renderKeyLine(view, s);
      sections = [...sheet.querySelectorAll('section.chv-sec')];
      lines = [...sheet.querySelectorAll('.chv-line, .chv-comment, .chv-raw')];
      curLine = null;
      curSec = -1;
      jumps.replaceChildren(...(view ? view.model.sections : []).filter(Boolean).map((sec, i) => {
        const b = btn('.v6-ch-jp', jumpLabel(sec, i), {
          'data-sec': String(i), title: `Go to ${sections[i]?.querySelector('h3')?.textContent || jumpLabel(sec, i)}`,
        });
        return b;
      }));
      jumps.hidden = !view || !sections.length;
      renderTools(); // core.render ran the tools before this view existed (Scroll / Fit follow it)
      mark.push();
    },
  });

  function renderKeyLine(view, s) {
    if (!view) {
      setText(titleEl, s ? s.name : '—');
      setText(keyEm, '');
      setText(keyRest, s ? '' : 'No song');
      return;
    }
    setText(titleEl, view.model.title || s.name);
    setText(keyEm, `Key ${view.shownKey}${c.prefs.mode === 'play' ? ' (your hands)' : ''}`);
    const bits = [];
    if (view.shift) bits.push(`written in ${view.sourceKey}`);
    if (view.model.capo) bits.push(`capo ${view.model.capo}`);
    bits.push(s.tempo ? `${s.tempo} bpm` : 'no tempo');
    bits.push(s.timeSig || DEFAULT_TIME_SIG);
    setText(keyRest, ` · ${bits.join(' · ')}`);
    keyEl.title = s.tempo ? '' : `No tempo: auto-scroll paces it at ${FALLBACK_TEMPO} BPM`;
  }

  const pct = () => c.pct(where);
  function renderTools() {
    const s = song();
    const has = !!core.view;
    const locked = c.locked();
    for (const b of [modeHear, modePlay]) {
      const on = b.dataset.mode === c.prefs.mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    const p = pct();
    sheet.style.setProperty('--chv-size', `${pctPx(p)}px`);
    setText(pctBtn, `${p}%`);
    pctBtn.setAttribute('aria-label', `Text size ${p}%. Tap for 100%`);
    smaller.disabled = p <= stepPct(p, -1);
    bigger.disabled = p >= stepPct(p, 1);
    fitBtn.disabled = !has;
    setText(speedEl, speedText(CHART_SPEED_STEPS[c.prefs.speed]));
    slower.disabled = c.prefs.speed === 0 || !has;
    faster.disabled = c.prefs.speed === CHART_SPEED_STEPS.length - 1 || !has;
    autoBtn.disabled = !has;
    autoBtn.setAttribute('aria-pressed', String(core.auto));
    autoBtn.classList.toggle('on', core.auto);
    setText(autoBtn, core.auto ? '❚❚ Scroll' : '▶ Scroll');
    autoBtn.title = `${core.auto ? 'Stop scrolling' : 'Scroll through the song at its tempo'}`
      + `${s && s.tempo ? '' : ` (no tempo: ${FALLBACK_TEMPO} BPM)`}`;
    // chart-view V4: Perform lock freezes library changes; reading, scrolling and the text size stay live
    editBtn.disabled = !s || locked;
    addBtn.disabled = !s || locked;
    setText(editBtn, has || (s && s.chart) ? 'Edit chart…' : 'Add a chart…');
    editBtn.title = locked ? 'Perform lock is on: unlock to edit the chart' : 'Change the chart’s text';
    addBtn.title = editBtn.title;
  }

  // ---- the reading line: the line at it is lit, its section is the current one (and its jump button)
  const mark = rafCoalesce(() => {
    if (!el.isConnected) return;
    // the line is drawn where the code reads (the body's visible height, without a scrollbar)
    const top = `${Math.round(body.offsetTop + body.clientHeight * READ_AT)}px`;
    if (readline.style.top !== top) readline.style.top = top;
    const y = body.scrollTop + body.clientHeight * READ_AT;
    let line = null;
    for (const l of lines) {
      if (l.offsetTop <= y) line = l;
      else break;
    }
    if (line !== curLine) {
      curLine?.classList.remove('now');
      line?.classList.add('now');
      curLine = line;
    }
    const sec = line ? sections.indexOf(line.closest('section.chv-sec')) : (sections.length ? 0 : -1);
    if (sec !== curSec) {
      sections[curSec]?.classList.remove('cur');
      sections[sec]?.classList.add('cur');
      for (const b of jumps.children) b.classList.toggle('on', Number(b.dataset.sec) === sec);
      curSec = sec;
    }
  });
  d.add(() => mark.cancel());
  d.listen(body, 'scroll', () => mark.push(), { passive: true });
  /** Put section `i`'s first line on the reading line. */
  function jumpTo(i) {
    const sec = sections[i];
    if (!sec) return;
    const first = sec.querySelector('.chv-line, .chv-comment, .chv-raw') || sec;
    core.scrollTo(first.offsetTop - body.clientHeight * READ_AT + 2);
    mark.push();
  }
  d.listen(jumps, 'click', (e) => {
    const b = e.target.closest('button[data-sec]');
    if (b) jumpTo(Number(b.dataset.sec));
  });

  // ---- text size (D16): steps, 100 %, Fit, the readout
  let readoutTimer = 0;
  function showReadout(p) {
    setText(readout, `Text ${p}%`);
    readout.hidden = false;
    clearTimeout(readoutTimer);
    readoutTimer = setTimeout(() => (readout.hidden = true), READOUT_MS);
  }
  d.add(() => clearTimeout(readoutTimer));
  /** A new size, keeping the line at the reading line where it is. */
  function setSize(p, why) {
    const before = pct();
    const anchor = curLine;
    const off = anchor ? anchor.offsetTop - body.scrollTop : 0;
    c.setPct(where, p, why);
    renderTools();
    if (pct() !== before && anchor && anchor.isConnected) core.scrollTo(anchor.offsetTop - off);
    showReadout(pct());
    mark.push();
  }
  const step = (dir, why = 'button') => setSize(stepPct(pct(), dir), why);
  const reset = (why = 'button') => setSize(CHART_PCT_DEFAULT, why);
  function fit() {
    const view = core.view;
    if (!view) return;
    const cs = getComputedStyle(body);
    const room = body.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    probe.style.fontSize = `${pctPx(CHART_PCT_DEFAULT)}px`;
    const chPx = probe.getBoundingClientRect().width / 10;
    setSize(fitPct(longestLineCh(view.model), chPx, room), 'fit');
  }
  d.listen(smaller, 'click', () => step(-1));
  d.listen(bigger, 'click', () => step(1));
  d.listen(pctBtn, 'click', () => reset());
  d.listen(fitBtn, 'click', () => fit());
  // ⌘-scroll / a trackpad pinch (Chromium: a wheel with ctrlKey) on the chart: one step per WHEEL_STEP of delta
  let wheelAcc = 0;
  let wheelAt = 0;
  d.listen(wrap, 'wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const now = performance.now();
    if (now - wheelAt > 400) wheelAcc = 0;
    wheelAt = now;
    wheelAcc += e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY;
    if (Math.abs(wheelAcc) >= WHEEL_STEP) {
      step(wheelAcc < 0 ? 1 : -1, 'wheel');
      wheelAcc = 0;
    }
  }, { passive: false });
  // two-finger pinch on a touch screen (iPad): one step per PINCH_STEP change in the fingers' distance. skeptic
  // UI6-U7b F2: only fingers that came down on the chart count (e.touches is every finger on the screen: a hand on a
  // mini fader plus a finger scrolling the chart was a "pinch", which resized the text and stopped the scroll)
  let pinch = 0;
  const onChart = (e) => [...e.touches].filter((t) => t.target instanceof Node && wrap.contains(t.target));
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  d.listen(wrap, 'touchstart', (e) => {
    const t = onChart(e);
    pinch = t.length === 2 ? dist(t) : 0;
  }, { passive: true });
  d.listen(wrap, 'touchmove', (e) => {
    const t = onChart(e);
    if (t.length !== 2 || !pinch) return;
    e.preventDefault(); // no page zoom, no scroll while pinching
    const r = dist(t) / pinch;
    if (r >= PINCH_STEP || r <= 1 / PINCH_STEP) {
      step(r > 1 ? 1 : -1, 'pinch');
      pinch = dist(t);
    }
  }, { passive: false });
  d.listen(wrap, 'touchend', (e) => {
    if (onChart(e).length < 2) pinch = 0;
  }, { passive: true });

  // skeptic UI6-U7b F1: a tap or click on the chart must not leave it focused. A focused chart took Space (the
  // sustain pedal: the browser scrolled the chart a page instead) and the first Esc only let go of it (no Panic).
  // Today's chart body was never focusable. Tab still reaches it (:focus-visible), and then the keys below scroll it.
  d.listen(body, 'focus', () => {
    let keyboard = true;
    try {
      keyboard = body.matches(':focus-visible');
    } catch {
      keyboard = true; // an engine without :focus-visible keeps today's focus
    }
    if (!keyboard) queueMicrotask(() => document.activeElement === body && body.blur());
  });

  // ---- keys on the focused chart: ↑/↓/PgUp/PgDn/Home/End scroll it (never the mod wheel), Space stays the pedal
  d.listen(body, 'keydown', (e) => {
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const page = Math.max(LINE_PX, body.clientHeight * 0.8);
    const dy = { ArrowUp: -LINE_PX, ArrowDown: LINE_PX, PageUp: -page, PageDown: page }[e.key];
    if (dy !== undefined) core.scrollTo(body.scrollTop + dy);
    else if (e.key === 'Home') core.scrollTo(0);
    else if (e.key === 'End') core.scrollTo(body.scrollHeight);
    else return;
    e.preventDefault(); // the controller ignores defaultPrevented keys
    e.stopPropagation();
  });

  // ---- the rest of the header
  const setMode = (m) => {
    if (c.prefs.mode === m) return;
    c.prefs.mode = m;
    c.save();
    core.render();
  };
  d.listen(modeHear, 'click', () => setMode('hear'));
  d.listen(modePlay, 'click', () => setMode('play'));
  const stepSpeed = (dir) => {
    c.prefs.speed = stepIndex(CHART_SPEED_STEPS, c.prefs.speed, dir);
    c.save();
    renderTools();
  };
  d.listen(slower, 'click', () => stepSpeed(-1));
  d.listen(faster, 'click', () => stepSpeed(1));
  d.listen(autoBtn, 'click', () => core.toggleAuto());
  // a keyboard-opened dialog gives focus back on close; a tapped one doesn't (Space = sustain, Esc = Panic)
  d.listen(editBtn, 'click', (e) => c.openEdit(e.detail === 0 ? editBtn : null));
  d.listen(addBtn, 'click', (e) => c.openEdit(e.detail === 0 ? addBtn : null));
  d.listen(placeBtn, 'click', () => c.setPlacement(where === 'stage' ? 'side' : 'stage'));

  d.add(store.subscribe(() => core.render()));
  d.add(() => core.destroy());
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => mark.push()) : null;
  ro?.observe(body);
  d.add(() => ro?.disconnect());
  core.render(true);

  return {
    el,
    render: (force) => core.render(force),
    step,
    reset,
    fit,
    /** Test / debug: what the panel shows. */
    state() {
      const v = core.view;
      return {
        where, songId: song()?.id ?? null, hasChart: !!v, shownKey: v?.shownKey ?? null,
        sourceKey: v?.sourceKey ?? null, shift: v?.shift ?? 0, mode: c.prefs.mode, auto: core.auto,
        lines: core.lines, rate: core.rate(), pct: pct(), px: pctPx(pct()),
        speed: CHART_SPEED_STEPS[c.prefs.speed], section: curSec, line: curLine ? lines.indexOf(curLine) : -1,
        jumps: [...jumps.children].map((b) => b.textContent),
      };
    },
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}
