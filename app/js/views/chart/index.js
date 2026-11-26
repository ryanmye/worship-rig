// Chart view (D7, hidden; CONTRACT_CHANGES "Chart view (D7, hidden)"). main.js imports this module only while
// settings.chartView is true and mounts it on Perform's two mount points (perform.js `chartMounts`): a "Chart" toggle
// after the Notes button and a panel over the stage row (.p-main). With the flag off none of this exists.
//
// The panel shows the committed song's chart (settings.currentSongId: a cued song in lane-s's Cue-then-Go is not
// committed, so it never swaps the chart), transposed live to the key on show (logic.js chartView), with big-type
// steps, auto-scroll (pace from tempo × a multiplier) and manual scroll. Persisted chart data goes through
// store.setChart / store.set only; view preferences (open, type size, speed, mode) are this machine's, in
// localStorage like Edit's section state. Provisional UI: plain styling on the theme tokens (D7).
import { h, setText, disposer, blurAfterPointer } from '../components/util.js';
import {
  stepIndex, CHART_FONT_STEPS, CHART_FONT_DEFAULT, CHART_SPEED_STEPS, CHART_SPEED_DEFAULT, CHART_MODES, FALLBACK_TEMPO,
} from './logic.js';
import { createChartCore, CHART_PREFS_KEY, readStoredPrefs, writeStoredPrefs } from './core.js';

export { CHART_PREFS_KEY };
export const CHART_CSS_HREF = './styles-chart.css';
const REMOVE_CONFIRM_MS = 3000;

function readPrefs() {
  const p = readStoredPrefs();
  const idx = (v, steps, def) => (Number.isInteger(v) && v >= 0 && v < steps.length ? v : def);
  return {
    open: p.open === true,
    font: idx(p.font, CHART_FONT_STEPS, CHART_FONT_DEFAULT),
    speed: idx(p.speed, CHART_SPEED_STEPS, CHART_SPEED_DEFAULT),
    mode: CHART_MODES.includes(p.mode) ? p.mode : 'hear',
  };
}

/**
 * Mount the chart toggle and panel on Perform.
 * @param {{store:object, toast?:Function}} ctx main.js ctx
 * @param {{after:HTMLElement, stage:HTMLElement}} mounts perform.js `chartMounts`
 * @returns {{destroy():void, open():void, close():void, readonly isOpen:boolean, state():object,
 *   openImport():object|null}}
 */
export function mountChartView(ctx, mounts) {
  const { store } = ctx;
  const d = disposer();
  const prefs = readPrefs();
  const savePrefs = () => writeStoredPrefs(prefs);
  // the stylesheet is loaded with the view and removed with it (nothing is fetched while the flag is off)
  let css = document.querySelector('link[data-chart-css]');
  const ownCss = !css;
  if (!css) {
    css = h('link', { rel: 'stylesheet', href: CHART_CSS_HREF, 'data-chart-css': '' });
    document.head.append(css);
  }

  const btn = (cls, content, attrs = {}) => {
    const b = h(`button.btn.chv-btn${cls}`, { type: 'button', ...attrs }, content);
    blurAfterPointer(b, d);
    return b;
  };
  // ---- toggle (Perform's song row)
  const toggle = btn('.chv-toggle', 'Chart', { 'aria-pressed': 'false', 'aria-controls': 'perform-chart',
    'data-testid': 'chart-toggle', title: 'Show this song’s chord chart' });
  mounts.after.after(toggle);

  // ---- panel (over the stage row)
  const titleEl = h('span.chv-title', { 'data-testid': 'chart-title' });
  const keyEl = h('span.chv-key', { 'data-testid': 'chart-key' });
  const modeHear = btn('.chv-mode', 'Heard', { 'data-mode': 'hear', title: 'Chords in the key the band hears' });
  const modePlay = btn('.chv-mode', 'Hands', { 'data-mode': 'play', title: 'Chords in the key your hands play' });
  const fontDown = btn('', 'A−', { 'aria-label': 'Smaller type', 'data-testid': 'chart-font-down' });
  const fontUp = btn('', 'A+', { 'aria-label': 'Bigger type', 'data-testid': 'chart-font-up' });
  const autoBtn = btn('.chv-auto', 'Auto-scroll', { 'aria-pressed': 'false', 'data-testid': 'chart-auto' });
  const speedDown = btn('', '−', { 'aria-label': 'Scroll slower', 'data-testid': 'chart-speed-down' });
  const speedVal = h('span.chv-speed', { 'data-testid': 'chart-speed' });
  const speedUp = btn('', '+', { 'aria-label': 'Scroll faster', 'data-testid': 'chart-speed-up' });
  const pageUp = btn('', '▲', { 'aria-label': 'Scroll up', 'data-testid': 'chart-page-up' });
  const pageDown = btn('', '▼', { 'aria-label': 'Scroll down', 'data-testid': 'chart-page-down' });
  const addBtn = btn('', 'Add chart…', { 'data-testid': 'chart-add' });
  const removeBtn = btn('', 'Remove', { 'data-testid': 'chart-remove' });
  const closeBtn = btn('.chv-close', '×', { 'aria-label': 'Close the chart', 'data-testid': 'chart-close' });
  const sheet = h('div.chv-sheet', { 'data-testid': 'chart-sheet' });
  const emptyAdd = btn('', 'Add chart…', { 'data-testid': 'chart-add-empty' });
  const empty = h('div.chv-empty', { 'data-testid': 'chart-empty' },
    h('p', { text: 'No chart for this song yet.' }), emptyAdd);
  const body = h('div.chv-body', {}, sheet, empty);
  const panel = h('section.panel.chv-panel', { id: 'perform-chart', 'aria-label': 'Chord chart', hidden: true,
    'data-testid': 'chart-panel' },
  h('div.chv-head', {},
    h('div.chv-info', {}, titleEl, keyEl),
    h('div.chv-tools', {},
      h('span.chv-group', { role: 'group', 'aria-label': 'Key on show' }, modeHear, modePlay),
      h('span.chv-group', {}, fontDown, fontUp),
      h('span.chv-group', {}, autoBtn, speedDown, speedVal, speedUp),
      h('span.chv-group', {}, pageUp, pageDown),
      h('span.chv-group', {}, addBtn, removeBtn),
      closeBtn)),
  body);
  mounts.stage.append(panel);

  // ---- state
  let removeArmed = 0;
  let removeTimer = null;
  let importDlg = null;
  const song = () => store.currentSong();
  const locked = () => !!store.get().settings.performLock;
  // U7b: the render cache, auto-scroll and paging are shared with the v6 chart (core.js)
  const core = createChartCore({
    store, panel, body, sheet, empty,
    mode: () => prefs.mode,
    speed: () => prefs.speed,
    onTools: () => renderTools(),
    onView: (view, s) => {
      if (!view) {
        setText(titleEl, s ? s.name : '—');
        setText(keyEl, '');
        return;
      }
      setText(titleEl, view.model.title || s.name);
      const written = view.shift ? ` · written in ${view.sourceKey}` : '';
      const capo = view.model.capo ? ` · capo ${view.model.capo}` : '';
      setText(keyEl, `Key ${view.shownKey}${prefs.mode === 'play' ? ' (your hands)' : ''}${written}${capo}`);
    },
  });
  const render = (force) => core.render(force);

  function renderTools() {
    const s = song();
    const has = !!(s && s.chart);
    for (const b of [modeHear, modePlay]) b.setAttribute('aria-pressed', String(b.dataset.mode === prefs.mode));
    fontDown.disabled = prefs.font === 0;
    fontUp.disabled = prefs.font === CHART_FONT_STEPS.length - 1;
    sheet.style.setProperty('--chv-size', `${CHART_FONT_STEPS[prefs.font]}px`);
    setText(speedVal, `×${CHART_SPEED_STEPS[prefs.speed]}`);
    speedDown.disabled = prefs.speed === 0;
    speedUp.disabled = prefs.speed === CHART_SPEED_STEPS.length - 1;
    autoBtn.setAttribute('aria-pressed', String(core.auto));
    autoBtn.disabled = !has;
    // Perform lock freezes library changes (perform.js LOCK.frozen); reading and scrolling stay live
    addBtn.disabled = !s || locked();
    emptyAdd.disabled = !s || locked();
    setText(addBtn, has ? 'Replace…' : 'Add chart…');
    removeBtn.hidden = !has;
    removeBtn.disabled = locked();
    setText(removeBtn, removeArmed ? 'Remove? Tap again' : 'Remove');
    const t = s && s.tempo ? '' : ` · no tempo, scrolls at ${FALLBACK_TEMPO} BPM`;
    autoBtn.title = `Scroll through the song at its tempo${t}`;
  }

  // ---- open / close
  const isOpen = () => !panel.hidden;
  function setOpen(on) {
    panel.hidden = !on;
    toggle.setAttribute('aria-pressed', String(on));
    mounts.stage.classList.toggle('chv-host', on);
    if (prefs.open !== on) {
      prefs.open = on;
      savePrefs();
    }
    if (on) render(true);
    else core.stopAuto();
  }
  d.listen(toggle, 'click', () => setOpen(!isOpen()));
  d.listen(closeBtn, 'click', () => setOpen(false));

  // ---- tools
  d.listen(modeHear, 'click', () => setMode('hear'));
  d.listen(modePlay, 'click', () => setMode('play'));
  function setMode(m) {
    if (prefs.mode === m) return;
    prefs.mode = m;
    savePrefs();
    render();
  }
  const stepFont = (dir) => {
    prefs.font = stepIndex(CHART_FONT_STEPS, prefs.font, dir);
    savePrefs();
    renderTools();
  };
  d.listen(fontDown, 'click', () => stepFont(-1));
  d.listen(fontUp, 'click', () => stepFont(1));
  const stepSpeed = (dir) => {
    prefs.speed = stepIndex(CHART_SPEED_STEPS, prefs.speed, dir);
    savePrefs();
    renderTools();
  };
  d.listen(speedDown, 'click', () => stepSpeed(-1));
  d.listen(speedUp, 'click', () => stepSpeed(1));
  d.listen(pageUp, 'click', () => core.page(-1));
  d.listen(pageDown, 'click', () => core.page(1));

  d.add(() => core.destroy());
  d.listen(autoBtn, 'click', () => core.toggleAuto());

  // ---- chart add / replace / remove (frozen under Perform lock)
  let destroyed = false;
  async function openImport(opener = null) {
    const s = song();
    if (!s || locked() || importDlg || destroyed) return importDlg;
    const { openChartImport } = await import('./import.js');
    // skeptic V3: the view may have gone (flag off), the song switched or Lock come on while the module loaded
    if (importDlg || destroyed || locked() || song()?.id !== s.id) return importDlg;
    importDlg = openChartImport(ctx, s.id, { onClose: () => (importDlg = null), opener });
    return importDlg;
  }
  // a keyboard-opened dialog gives focus back on close; a tapped one doesn't (a focused button would hold off Space =
  // sustain and Esc = Panic, main.js)
  d.listen(addBtn, 'click', (e) => openImport(e.detail === 0 ? addBtn : null));
  d.listen(emptyAdd, 'click', (e) => openImport(e.detail === 0 ? emptyAdd : null));
  d.listen(removeBtn, 'click', () => {
    const s = song();
    if (!s || !s.chart || locked()) return;
    if (!removeArmed) {
      removeArmed = 1;
      clearTimeout(removeTimer);
      removeTimer = setTimeout(() => {
        removeArmed = 0;
        renderTools();
      }, REMOVE_CONFIRM_MS);
      renderTools();
      return;
    }
    removeArmed = 0;
    clearTimeout(removeTimer);
    store.setChart(s.id, null);
  });
  d.add(() => clearTimeout(removeTimer));

  // ---- store: the committed song, its chart and its key (a closed panel only marks itself stale)
  let lastSongId = store.get().settings.currentSongId;
  const unsub = store.subscribe((state) => {
    const id = state.settings.currentSongId;
    if (id !== lastSongId) {
      lastSongId = id;
      removeArmed = 0;
      importDlg?.close(); // the dialog belongs to the song it was opened for
    }
    if (state.settings.performLock) importDlg?.close(); // skeptic V4: Lock freezes Add / Replace, even mid-dialog
    if (isOpen()) render();
    else core.invalidate();
  });
  d.add(unsub);

  setOpen(prefs.open);
  renderTools();

  return {
    get isOpen() {
      return isOpen();
    },
    open: () => setOpen(true),
    close: () => setOpen(false),
    openImport: () => openImport(),
    /** Test/debug: what the panel shows. */
    state() {
      return {
        open: isOpen(), songId: song()?.id ?? null, hasChart: !!core.view, shownKey: core.view?.shownKey ?? null,
        sourceKey: core.view?.sourceKey ?? null, shift: core.view?.shift ?? 0, mode: prefs.mode, auto: core.auto,
        lines: core.lines, rate: core.rate(), font: CHART_FONT_STEPS[prefs.font], speed: CHART_SPEED_STEPS[prefs.speed],
      };
    },
    destroy() {
      destroyed = true;
      importDlg?.close();
      d.dispose();
      toggle.remove();
      panel.remove();
      mounts.stage.classList.remove('chv-host');
      if (ownCss) css.remove();
    },
  };
}
