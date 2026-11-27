// UI v6 Edit chart dialog (D7; UI6-build-plan U7b; mockup native/docs/design/mockups/dialogs.html "Edit chart",
// mock_dialogs.py chart_editor()). The chart's source on the left (ChordPro or chords over words, typed, pasted or from
// a file), the chart as it will show on the right, live as you type, and a line under them: "Written in G · shown in C
// (the song’s key) · 0 problems". Save / Cancel. Also "Add a chart" (the same dialog, empty).
// Nothing of the parsing or saving is new: today's review (views/chart/import.js chartReview: readImport, the offers,
// store.setChart, a song list's placeholder songs) sits under the text, so the rule stays the same: the song's title,
// key, tempo and time are only OFFERED, unticked, and only ticked ones are written. Refused under Perform lock
// (chart-view V4): Save refuses, and Lock coming on closes the dialog (chart.js).
import { h, setText } from '../../components/util.js';
import { openOverlay } from '../../components/overlay.js';
import { markDialog } from '../../_fallback-components.js';
import { CHART_MAX_CHARS, isTrialId } from '../../../store.js';
import { detectFormat } from '../../../shared/chart-parse.js';
import {
  chartReview, IMPORT_FILE_MAX_BYTES, fileTooLargeMessage, keepClearOfPanic, trialKeepsLibraryCopy,
} from '../../chart/import.js';
import { CHART_ACCEPT, CHART_SIDE_PCT, chartView, pctPx } from '../../chart/logic.js';
import { renderChart } from '../../chart/render.js';

const PREVIEW_DEBOUNCE_MS = 200;
const REMOVE_CONFIRM_MS = 3000;
/** Insert section ▾: ChordPro environments, or a heading line for chords over words. */
const SECTIONS = Object.freeze([
  ['verse', 'Verse', '{start_of_verse: Verse}\n\n{end_of_verse}\n'],
  ['chorus', 'Chorus', '{start_of_chorus}\n\n{end_of_chorus}\n'],
  ['prechorus', 'Pre-chorus', '{comment: Pre-chorus}\n'],
  ['bridge', 'Bridge', '{start_of_bridge}\n\n{end_of_bridge}\n'],
  ['intro', 'Intro', '{comment: Intro}\n'],
  ['tag', 'Tag', '{comment: Tag}\n'],
]);

/**
 * Open the Edit chart dialog for one song.
 * @param {{store:object, toast?:Function}} ctx
 * @param {string} songId
 * @param {{host:HTMLElement, mode:() => 'hear'|'play', onClose?:() => void, opener?:Element|null}} o
 *   host: inside the v6 view (its styles are scoped under .v6); opener: focus goes back to it on close
 * @returns {{el:HTMLElement, close():void, state():object}}
 */
export function openChartEditor(ctx, songId, o) {
  const { store } = ctx;
  const song = () => store.getSong(songId);
  const s0 = song();
  const had = s0?.chart || null;
  const token = {};
  let fileName = had?.name || '';
  let fmt = had?.format === 'chordpro' || had?.format === 'plain' ? had.format : null; // null: detect
  let writtenIn = had?.key || null;
  let timer = null;
  let removeArmed = false;
  let removeTimer = null;
  let last = { canSave: false, label: 'Save chart' };
  const rv = chartReview(ctx, songId);

  // ---- source (left)
  const seg = (f, text) => h('button.btn.v6-ce-seg', { type: 'button', 'data-fmt': f, text,
    'data-testid': `v6-ce-fmt-${f}`, 'aria-pressed': 'false' });
  const proBtn = seg('chordpro', 'ChordPro');
  const plainBtn = seg('plain', 'Chords over words');
  const insert = h('select.v6-ce-insert', { 'aria-label': 'Insert section', 'data-testid': 'v6-ce-insert' },
    h('option', { value: '', text: 'Insert section ▾' }),
    ...SECTIONS.map(([k, t]) => h('option', { value: k, text: t })));
  const fileInput = h('input', { type: 'file', accept: CHART_ACCEPT, hidden: true, 'data-testid': 'v6-ce-file' });
  const fileBtn = h('button.btn.ghost.v6-ce-filebtn', { type: 'button', text: 'Choose file…',
    'data-testid': 'v6-ce-file-btn' });
  const text = h('textarea.v6-ce-text', {
    spellcheck: 'false', 'aria-label': 'Chart text', 'data-testid': 'v6-ce-text',
    placeholder: 'Type or paste a chart: ChordPro ([G]lyrics) or chords over words', wrap: 'off',
  });
  text.value = had?.text || '';
  const src = h('div.v6-ce-src', {},
    h('div.v6-ce-tools', {}, h('div.v6-ce-fmt', { role: 'group', 'aria-label': 'Read the text as' }, proBtn, plainBtn),
      insert, fileBtn, fileInput),
    text, rv.error, rv.review);

  // ---- preview (right)
  const pTitle = h('b.v6-ce-ptitle', { 'data-testid': 'v6-ce-ptitle' });
  const pKey = h('small.v6-ce-pkey', {});
  const pSheet = h('div.chv-sheet.v6-ce-psheet', { 'data-testid': 'v6-ce-psheet',
    style: { '--chv-size': `${pctPx(CHART_SIDE_PCT)}px` } });
  const pEmpty = h('p.v6-ce-pempty', { text: 'The chart shows here as you type.' });
  const prev = h('div.v6-ce-prev', { 'data-testid': 'v6-ce-preview', 'aria-label': 'Preview', role: 'region' },
    h('div.v6-ce-phead', {}, pTitle, pKey), h('div.v6-ce-pbody', {}, pSheet, pEmpty));

  // ---- foot
  const status = h('small.v6-ce-status', { 'data-testid': 'v6-ce-status', 'aria-live': 'polite' });
  const removeBtn = h('button.btn.ghost.warn.v6-ce-remove', { type: 'button', text: 'Remove chart',
    'data-testid': 'v6-ce-remove', hidden: !had });
  const cancelBtn = h('button.btn.ghost', { type: 'button', text: 'Cancel', 'data-testid': 'v6-ce-cancel' });
  const saveBtn = h('button.btn.v6-ce-save', { type: 'button', text: 'Save chart', disabled: true,
    'data-testid': 'v6-ce-save' });

  const titleText = h('span', {});
  // skeptic UI6-U7b F4: on a trial song (Song bank Try it) nothing is saved until Keep it. UI6-U7b O3: a bank song
  // already in the library is kept as the library copy (U7a's Keep rule), so the chart is for this try only there
  setText(titleText, `${s0?.name ?? ''} · ${!isTrialId(songId) ? 'changes show on the right as you type'
    : trialKeepsLibraryCopy(ctx, songId)
      ? 'trying this song: already in your library, so this chart is for this try only'
      : 'trying this song: Keep it to save the chart'}`);
  const dlg = h('div.v6-ce', { role: 'dialog', 'aria-modal': 'true', 'aria-label': had ? 'Edit chart' : 'Add a chart',
    tabindex: -1, 'data-testid': 'v6-chart-editor' },
  h('div.v6-ce-h', {}, h('b', { text: had ? 'Edit chart' : 'Add a chart' }), titleText),
  h('div.v6-ce-b', {}, src, prev),
  h('div.v6-ce-foot', {}, status, removeBtn, cancelBtn, saveBtn));
  const host = h('div.v6-ce-host', { 'data-testid': 'v6-chart-editor-host' }, dlg);
  o.host.append(host);
  markDialog(token, true);
  // C-SHIP (chart-view review O1): the on-screen PANIC sits above this backdrop (styles.css .chart-dlg-open), so it
  // stays reachable and working while the dialog is open, as ⌘. already did
  document.body.classList.add('chart-dlg-open');
  const unclear = keepClearOfPanic(host); // C-SHIP skeptic F2: never under PANIC

  // ---- live review + preview
  function refresh() {
    clearTimeout(timer);
    timer = null;
    const value = text.value;
    last = rv.update(value, {
      fileName, format: fmt || 'auto', writtenIn, onWrittenIn: (k) => {
        writtenIn = k;
        refresh();
      },
    });
    saveBtn.textContent = last.label;
    saveBtn.disabled = !last.canSave;
    const r = rv.result;
    const shownFmt = fmt || (r && r.kind === 'chart' ? r.format : value.trim() ? detectFormat(fileName, value) : null);
    for (const b of [proBtn, plainBtn]) {
      const on = b.dataset.fmt === shownFmt;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    const s = song();
    // skeptic UI6-U7b F3: a source over the cap can't be saved, so it is not drawn either (a 300 KB paste drew 5000
    // lines: ~1 s of main thread per pause in typing, with the keys live behind the dialog)
    const tooBig = value.length > CHART_MAX_CHARS;
    if (!s || !r || r.kind !== 'chart' || tooBig) {
      pSheet.replaceChildren();
      pEmpty.hidden = false;
      setText(pEmpty, tooBig ? 'Too large to show: a chart can be at most '
        + `${CHART_MAX_CHARS / 1024} KB.` : 'The chart shows here as you type.');
      setText(pTitle, s?.name ?? '');
      setText(pKey, '');
      setText(status, r && r.kind === 'csv' ? 'A song list, not a chart: Save adds the songs that are new.'
        : tooBig ? 'Too large to save' : '');
      return;
    }
    setText(pEmpty, 'The chart shows here as you type.');
    const draft = { text: value, format: r.format };
    const k = rv.writtenIn();
    if (k) draft.key = k;
    const view = chartView({ ...s, chart: draft }, o.mode());
    pEmpty.hidden = !!view;
    if (view) renderChart(pSheet, view.model);
    else pSheet.replaceChildren();
    setText(pTitle, view?.model.title || s.name);
    setText(pKey, view ? ` Key ${view.shownKey}` : '');
    const probs = (r.model.warnings?.length || 0) + (rv.error.hidden ? 0 : 1);
    const shownWhy = o.mode() === 'play' ? 'your hands’ key' : 'the song’s key';
    setText(status, view ? `Written in ${view.sourceKey} · shown in ${view.shownKey} (${shownWhy}) · ${probs} `
      + `problem${probs === 1 ? '' : 's'}` : '');
  }
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, PREVIEW_DEBOUNCE_MS);
  };

  // ---- save / remove / close
  function save() {
    if (timer) { // typed since the last preview: show it first (its offers start unticked again), don't save
      refresh();
      return;
    }
    if (rv.save(text.value).done) close();
  }
  function remove() {
    const s = song();
    if (!s || !s.chart) return;
    if (store.get().settings.performLock) {
      rv.showError('Perform is locked, so the chart was not removed. Unlock first.');
      return;
    }
    if (!removeArmed) {
      removeArmed = true;
      setText(removeBtn, 'Remove? Tap again');
      clearTimeout(removeTimer);
      removeTimer = setTimeout(() => {
        removeArmed = false;
        setText(removeBtn, 'Remove chart');
      }, REMOVE_CONFIRM_MS);
      return;
    }
    store.setChart(songId, null);
    ctx.toast?.('Chart removed.', 'ok', { ms: 2500 });
    close();
  }

  text.addEventListener('input', () => {
    rv.showError('');
    schedule();
  });
  for (const b of [proBtn, plainBtn]) {
    b.addEventListener('click', () => {
      fmt = b.dataset.fmt;
      refresh();
    });
  }
  insert.addEventListener('change', () => {
    const row = SECTIONS.find(([k]) => k === insert.value);
    insert.value = '';
    if (!row) return;
    const plain = (fmt || (text.value.trim() ? detectFormat(fileName, text.value) : 'chordpro')) === 'plain';
    const snippet = plain ? `${row[1]}\n` : row[2];
    const at = text.selectionStart ?? text.value.length;
    const lead = at > 0 && text.value[at - 1] !== '\n' ? '\n' : '';
    text.focus();
    text.setRangeText(lead + snippet, at, text.selectionEnd ?? at, 'end');
    refresh();
  });
  fileBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    if (f.size > IMPORT_FILE_MAX_BYTES) {
      rv.showError(fileTooLargeMessage(f.size)); // C-SHIP (chart-view O7)
      return;
    }
    try {
      text.value = await f.text();
    } catch (err) {
      rv.showError(`That file could not be read (${err && err.message ? err.message : err}).`);
      return;
    }
    if (closed) return;
    fileName = f.name || '';
    fmt = null;
    rv.showError('');
    refresh();
  });
  removeBtn.addEventListener('click', remove);
  cancelBtn.addEventListener('click', () => close());
  saveBtn.addEventListener('click', save);
  // a modal keeps Tab inside it (chart-view V5); the app behind is covered, not inert
  dlg.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = [...dlg.querySelectorAll('button:not([disabled]), input:not([disabled]):not([hidden]), select, textarea, '
      + 'summary')].filter((x) => x.getClientRects().length > 0);
    if (!f.length) return;
    const i = f.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) {
      e.preventDefault();
      f[f.length - 1].focus();
    } else if (!e.shiftKey && (i === -1 || i === f.length - 1)) {
      e.preventDefault();
      f[0].focus();
    }
  });

  const closeOverlay = openOverlay({ el: dlg, closeOnOutside: false, onClose: () => close() });
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    clearTimeout(removeTimer);
    closeOverlay();
    markDialog(token, false);
    document.body.classList.remove('chart-dlg-open');
    unclear();
    host.remove();
    o.onClose?.();
    if (o.opener && o.opener.isConnected && typeof o.opener.focus === 'function' && !o.opener.disabled) {
      o.opener.focus({ preventScroll: true });
    }
  }
  refresh();
  queueMicrotask(() => {
    if (!closed) text.focus({ preventScroll: true });
  });
  return {
    el: dlg,
    close,
    /** Test / debug: the dialog's state. */
    state: () => ({ format: fmt, writtenIn: rv.writtenIn(), status: status.textContent, canSave: last.canSave }),
  };
}
