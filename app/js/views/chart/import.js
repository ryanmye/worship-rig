// Chart view (D7, hidden): the "Add chart…" dialog. A file picker or pasted text → readImport (logic.js) → a review:
// the parser's warnings, and the title / key / tempo / time signature the chart has, each OFFERED as an unticked
// update to the song (never applied silently). Save stores the source text (store.setChart) and writes only the
// ticked offers. A WorshipTools song-list CSV instead offers placeholder songs for the titles not in the library.
// Provisional UI (D7: Ryan designs the look later).
import { h, setText } from '../components/util.js';
import { openOverlay } from '../components/overlay.js';
import { markDialog } from '../_fallback-components.js';
import { keyName } from '../../shared/music.js';
import { CHART_MAX_CHARS, chartError } from '../../store.js';
import {
  CHART_ACCEPT, readImport, importOffers, offerWrites, csvPlaceholders, songKeyName, songLineCount,
} from './logic.js';

/** Files larger than this are refused before they are read (a song list may be larger than one chart). */
export const IMPORT_FILE_MAX_BYTES = 1024 * 1024;
const WARN_SHOWN = 12;
const REVIEW_DEBOUNCE_MS = 250;

/**
 * Open the dialog for one song.
 * @param {{store:object, toast?:Function}} ctx
 * @param {string} songId
 * @param {{onClose?:() => void, opener?:Element|null}} [o] opener: focus goes back to it on close
 * @returns {{el:HTMLElement, close:() => void}}
 */
export function openChartImport(ctx, songId, o = {}) {
  const { store } = ctx;
  const song = () => store.getSong(songId);
  const token = {};
  let fileName = '';
  let result = null; // readImport result for the current text
  let reviewTimer = null;

  const fileInput = h('input', { type: 'file', accept: CHART_ACCEPT, hidden: true, 'data-testid': 'chart-file' });
  const fileBtn = h('button.btn.chv-btn', { type: 'button', text: 'Choose file…' });
  const fileLabel = h('span.chv-file', { text: '' });
  const text = h('textarea.chv-text', {
    rows: 10, spellcheck: 'false', 'aria-label': 'Chart text', 'data-testid': 'chart-paste',
    placeholder: 'Or paste a chart here: ChordPro ([G]lyrics) or chords over lyrics',
  });
  const format = h('select.chv-select', { 'aria-label': 'Format', 'data-testid': 'chart-format' },
    h('option', { value: 'auto', text: 'Format: detect' }), h('option', { value: 'chordpro', text: 'ChordPro' }),
    h('option', { value: 'plain', text: 'Chords over lyrics' }));
  const review = h('div.chv-review', { 'data-testid': 'chart-review', 'aria-live': 'polite' });
  const error = h('p.chv-error', { role: 'alert', hidden: true, 'data-testid': 'chart-error' });
  const cancelBtn = h('button.btn.chv-btn', { type: 'button', text: 'Cancel' });
  const saveBtn = h('button.btn.chv-btn.primary', { type: 'button', text: 'Save chart', disabled: true,
    'data-testid': 'chart-save' });
  const title = h('h2.chv-dlg-h', {});
  setText(title, `Add a chart to “${song()?.name ?? ''}”`);
  const dlg = h('div.chv-dlg', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Add chart', tabindex: -1,
    'data-testid': 'chart-import' },
  title,
  h('div.chv-dlg-row', {}, fileBtn, fileLabel, fileInput, format),
  text, error, review,
  h('div.chv-dlg-foot', {}, cancelBtn, saveBtn));
  const host = h('div.chv-dlg-host', {}, dlg);
  document.body.append(host);
  markDialog(token, true);

  const showError = (msg) => {
    error.hidden = !msg;
    setText(error, msg || '');
  };

  // ---- review
  let offerBoxes = []; // [{offer, box}]
  let keySel = null;
  let tempoIn = null;
  // skeptic V8: Element.append(null) inserts the text "null" (warnList gives null when there are no warnings)
  const add = (...nodes) => review.append(...nodes.filter((n) => n !== null && n !== undefined && n !== false));
  function renderReview() {
    const s = song();
    review.replaceChildren();
    offerBoxes = [];
    keySel = null;
    tempoIn = null;
    saveBtn.textContent = 'Save chart';
    const src = text.value;
    if (!s || !src.trim()) {
      result = null;
      saveBtn.disabled = true;
      return;
    }
    result = readImport(src, { name: fileName, format: format.value });
    if (result.kind === 'csv') {
      const p = csvPlaceholders(result.songs, store.songsInOrder().map((x) => x.name));
      add(
        h('p', { text: `A song list: ${result.songs.length} song${result.songs.length === 1 ? '' : 's'}. `
          + `${p.add.length} new placeholder song${p.add.length === 1 ? '' : 's'} can be added to the library`
          + (p.skipped.length ? ` (${p.skipped.length} already there).` : '.') }),
        p.add.length ? h('ul.chv-list', {}, p.add.slice(0, 20).map((x) => h('li', { text: x.name }))) : null,
        warnList(result.warnings));
      saveBtn.textContent = p.add.length ? `Add ${p.add.length} song${p.add.length === 1 ? '' : 's'}`
        : 'Nothing to add';
      saveBtn.disabled = !p.add.length;
      return;
    }
    const m = result.model;
    const lines = songLineCount(m);
    const err = chartError({ text: src });
    review.append(h('p', { 'data-testid': 'chart-summary',
      text: `Read as ${result.format === 'chordpro' ? 'ChordPro' : 'chords over lyrics'}: ${m.sections.length} `
        + `section${m.sections.length === 1 ? '' : 's'}, ${lines} line${lines === 1 ? '' : 's'}.` }));
    add(warnList(m.warnings));
    const { offers, notes, askTempo } = importOffers(m, s);
    if (offers.length) {
      const list = h('div.chv-offers', { 'data-testid': 'chart-offers' },
        h('p.chv-cap', { text: 'The chart says something different. Tick what to copy to the song:' }));
      for (const off of offers) {
        const box = h('input', { type: 'checkbox', 'data-offer': off.field });
        list.append(h('label.chv-offer', {}, box, h('span', { text: `${off.label}: ${off.to}` }),
          h('span.chv-was', { text: ` (song: ${off.from})` })));
        offerBoxes.push({ offer: off, box });
      }
      review.append(list);
    }
    for (const n of notes) review.append(h('p.chv-note', { text: n }));
    if (!m.key) {
      // the key it is written in, so Easy Transpose can move it; default = the song's key (stored as chart.key)
      keySel = h('select.chv-select', { 'aria-label': 'Chart is written in', 'data-testid': 'chart-written-in' });
      const cur = songKeyName(s);
      for (const minor of [false, true]) {
        for (let pc = 0; pc < 12; pc++) {
          const k = keyName(pc, minor);
          keySel.append(h('option', { value: k, text: k, selected: k === cur }));
        }
      }
      review.append(h('label.chv-field', {}, h('span', { text: 'No key in the chart. It is written in ' }), keySel));
    }
    if (askTempo) {
      tempoIn = h('input.chv-num', { type: 'number', min: 30, max: 300, step: 1, placeholder: '—',
        'aria-label': 'Tempo (BPM)', 'data-testid': 'chart-tempo' });
      review.append(h('label.chv-field', {}, h('span', { text: 'No tempo in the chart or the song. Tempo (sets the '
        + 'auto-scroll pace; optional): ' }), tempoIn));
    }
    showError(err);
    saveBtn.disabled = !!err;
  }
  function warnList(warnings) {
    if (!warnings || !warnings.length) return null;
    const shown = warnings.slice(0, WARN_SHOWN);
    return h('details.chv-warn', { 'data-testid': 'chart-warnings' },
      h('summary', { text: `${warnings.length} note${warnings.length === 1 ? '' : 's'} from the parser` }),
      h('ul.chv-list', {}, shown.map((w) => h('li', { text: w })),
        warnings.length > WARN_SHOWN ? h('li', { text: `…and ${warnings.length - WARN_SHOWN} more` }) : null));
  }
  const scheduleReview = () => {
    clearTimeout(reviewTimer);
    reviewTimer = setTimeout(() => {
      reviewTimer = null;
      renderReview();
    }, REVIEW_DEBOUNCE_MS);
  };

  // ---- save
  function save() {
    // text typed since the last review: show the new review first (its offers start unticked again), don't save
    if (reviewTimer) {
      clearTimeout(reviewTimer);
      reviewTimer = null;
      renderReview();
      return;
    }
    const s = song();
    if (!s || !result) return;
    if (store.get().settings.performLock) { // skeptic V4: Perform lock freezes library changes
      showError('Perform is locked, so the chart was not saved. Unlock first.');
      return;
    }
    if (result.kind === 'csv') {
      const p = csvPlaceholders(result.songs, store.songsInOrder().map((x) => x.name));
      for (const x of p.add) {
        const id = store.addSong(null, { name: x.name, setlistId: null });
        if (x.notes) store.set(`songs.${id}.notes`, x.notes);
      }
      ctx.toast?.(`Added ${p.add.length} placeholder song${p.add.length === 1 ? '' : 's'} to the library.`, 'ok',
        { ms: 4000 });
      close();
      return;
    }
    const chart = { text: text.value, format: result.format };
    if (fileName) chart.name = fileName;
    if (keySel) chart.key = keySel.value;
    const r = store.setChart(songId, chart);
    if (!r.ok) {
      showError(r.error);
      return;
    }
    const ticked = offerBoxes.filter((x) => x.box.checked).map((x) => x.offer);
    const writes = offerWrites(ticked, s);
    const t = tempoIn && tempoIn.value.trim() ? Math.round(Number(tempoIn.value)) : null;
    if (Number.isFinite(t) && t !== null) writes.push(['tempo', Math.max(30, Math.min(300, t))]);
    for (const [p, v] of writes) store.set(`songs.${songId}.${p}`, v);
    ctx.toast?.('Chart saved.', 'ok', { ms: 2500 });
    close();
  }

  // ---- wiring (every listener lives on the dialog's own nodes, so removing it releases them)
  fileBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!f) return;
    if (f.size > IMPORT_FILE_MAX_BYTES) {
      showError(`That file is too large (${Math.ceil(f.size / 1024)} KB). A chart can be at most `
        + `${CHART_MAX_CHARS / 1024} KB.`);
      return;
    }
    try {
      text.value = await f.text();
    } catch (err) {
      showError(`That file could not be read (${err && err.message ? err.message : err}).`);
      return;
    }
    fileName = f.name || '';
    setText(fileLabel, fileName);
    showError('');
    clearTimeout(reviewTimer);
    reviewTimer = null;
    renderReview();
  });
  text.addEventListener('input', () => {
    showError('');
    scheduleReview();
  });
  format.addEventListener('change', () => renderReview());
  cancelBtn.addEventListener('click', () => close());
  saveBtn.addEventListener('click', save);
  // skeptic V5: a modal keeps Tab inside it (as settings-import.js does); the app behind is covered, not inert
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
    clearTimeout(reviewTimer);
    closeOverlay();
    markDialog(token, false);
    host.remove();
    o.onClose?.();
    // back to the button that opened it, if it is still there; otherwise nothing stays focused (Esc = Panic again)
    if (o.opener && o.opener.isConnected && typeof o.opener.focus === 'function' && !o.opener.disabled) {
      o.opener.focus({ preventScroll: true });
    }
  }
  queueMicrotask(() => text.focus());
  return { el: dlg, close, review: renderReview };
}
