// Chart view (D7, hidden): the part every chart panel shares. Today's panel (index.js) and the UI v6 chart (U7b,
// views/v6/chart/) each build their own header around it; this owns what they must not do twice:
//   - the committed song's chart transposed to the key on show (logic.js chartView), re-rendered only when the song,
//     its chart, its keys or the mode change (render.js renderChart);
//   - auto-scroll: one rAF loop at autoScrollRate (tempo × the speed multiplier), only while the panel is on screen, a
//     manual scroll wins, it stops at the end and on a song switch (which also goes back to the top);
//   - paging by a share of the visible height.
// No store writes, no listeners of its own: the panel calls render() from its store subscription.
import { chartView, songLineCount, autoScrollRate, CHART_SPEED_STEPS } from './logic.js';
import { renderChart } from './render.js';

const PAGE_FRACTION = 0.8;

/** localStorage key of this machine's chart preferences (today's view and, U7b, the v6 chart share it). */
export const CHART_PREFS_KEY = 'worship-rig.chart';

/** The stored preferences object as it is ({} when absent or unreadable). */
export function readStoredPrefs() {
  let p = {};
  try {
    p = JSON.parse(globalThis.localStorage?.getItem(CHART_PREFS_KEY) || '{}') || {};
  } catch {
    p = {};
  }
  return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
}

/**
 * Store `prefs` over what is stored, so the fields one view doesn't know are kept (U7b: today's view keeps the v6
 * chart's percent size and placement, the v6 chart keeps today's px index).
 * @param {object} prefs
 */
export function writeStoredPrefs(prefs) {
  try {
    globalThis.localStorage?.setItem(CHART_PREFS_KEY, JSON.stringify({ ...readStoredPrefs(), ...prefs }));
  } catch {
    /* private window / full storage: the preferences just don't stick */
  }
}

/**
 * @param {object} o
 * @param {{currentSong():object|null}} o.store
 * @param {HTMLElement} o.panel  the panel (auto-scroll stops when it is hidden or detached)
 * @param {HTMLElement} o.body   the scrolling element
 * @param {HTMLElement} o.sheet  where the chart is drawn
 * @param {HTMLElement} o.empty  shown instead of the sheet when the song has no chart
 * @param {() => 'hear'|'play'} o.mode  the key on show
 * @param {() => number} o.speed  index into CHART_SPEED_STEPS
 * @param {() => void} [o.onTools]  the header's own refresh (auto on / off, a render)
 * @param {(view:object|null, song:object|null) => void} [o.onView]  a new view was drawn (title, key line, jumps)
 * @returns {{render(force?:boolean):void, readonly view:object|null, readonly lines:number, readonly auto:boolean,
 *   startAuto():void, stopAuto():void, toggleAuto():void, rate():number, page(dir:number):void,
 *   scrollTo(y:number):void,
 *   invalidate():void, destroy():void}}
 */
export function createChartCore(o) {
  const { store, panel, body, sheet, empty } = o;
  let renderedKey = null;
  let view = null; // last chartView() result
  let lineCount = 0;
  const song = () => store.currentSong();
  const tools = () => o.onTools?.();

  function render(force = false) {
    const s = song();
    const mode = o.mode();
    const k = s ? [s.id, s.chart, s.hearIn, s.playIn, s.minor, mode] : [null];
    const same = !force && renderedKey && k.length === renderedKey.length && k.every((v, i) => v === renderedKey[i]);
    tools();
    if (same) return;
    const songChanged = !renderedKey || renderedKey[0] !== k[0];
    renderedKey = k;
    view = s ? chartView(s, mode) : null;
    if (songChanged) {
      stopAuto();
      body.scrollTop = 0;
    }
    if (!view) {
      sheet.replaceChildren();
      sheet.hidden = true;
      empty.hidden = false;
      lineCount = 0;
      o.onView?.(null, s);
      return;
    }
    sheet.hidden = false;
    empty.hidden = true;
    renderChart(sheet, view.model);
    lineCount = songLineCount(view.model);
    sheet.dataset.key = view.shownKey;
    o.onView?.(view, s);
  }

  // ---- auto-scroll: one rAF loop, only while on and the panel is on screen
  let auto = false;
  let raf = 0;
  let last = 0;
  let pos = 0;
  const scrollPx = () => Math.max(0, body.scrollHeight - body.clientHeight);
  const rate = () => {
    const s = song();
    return autoScrollRate({ tempo: s ? s.tempo : null, timeSig: s ? s.timeSig : undefined, lines: lineCount,
      scrollPx: scrollPx(), multiplier: CHART_SPEED_STEPS[o.speed()] });
  };
  function frame(t) {
    raf = 0;
    if (!auto) return;
    if (!panel.isConnected || panel.hidden || panel.offsetParent === null) {
      stopAuto();
      return;
    }
    const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
    last = t;
    if (Math.abs(body.scrollTop - Math.round(pos)) > 2) pos = body.scrollTop; // a manual scroll wins
    const max = scrollPx();
    pos = Math.min(max, pos + rate() * dt);
    body.scrollTop = pos;
    if (pos >= max - 0.5) {
      stopAuto(); // the end of the chart
      return;
    }
    raf = requestAnimationFrame(frame);
  }
  function startAuto() {
    if (auto || !view) return;
    auto = true;
    last = 0;
    pos = body.scrollTop;
    raf = requestAnimationFrame(frame);
    tools();
  }
  function stopAuto() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (!auto) return;
    auto = false;
    tools();
  }
  const scrollTo = (y) => {
    body.scrollTop = Math.max(0, Math.min(scrollPx(), y));
    pos = body.scrollTop;
  };
  const page = (dir) => scrollTo(body.scrollTop + Math.max(40, body.clientHeight * PAGE_FRACTION) * dir);

  return {
    render,
    get view() {
      return view;
    },
    get lines() {
      return lineCount;
    },
    get auto() {
      return auto;
    },
    startAuto,
    stopAuto,
    toggleAuto: () => (auto ? stopAuto() : startAuto()),
    rate,
    page,
    scrollTo,
    /** The next render() draws again (a closed panel marks itself stale instead of drawing). */
    invalidate() {
      renderedKey = null;
    },
    destroy: stopAuto,
  };
}
