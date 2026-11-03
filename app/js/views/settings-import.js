// Settings › My Samples › "Import from GarageBand / Logic…" (v11-importer). Mac app only: mounted when window.rig
// has garageBandScan (Electron main + importer-host.js); the Chrome version keeps the Terminal steps instead.
// Quiet by default: one button; the dialog opens over Settings only when asked. Flow: scan the Apple library (in a
// worker process) → a list with sizes and checkboxes → Import → per-instrument progress with Stop → automatic
// Rescan (settings.js rescanSamples → controller.rescanUserSamples → engine.reloadManifests) → in the picker.
// The page never sends a path: only the opaque keys of the latest scan. An import keeps running when the dialog or
// Settings closes; a line under the button tells how far it is.

/** Plain words for the importer's error codes (importer-host.js / tools/exs/importer.mjs). */
export const GB_ERROR_TEXT = Object.freeze({
  busy: 'An import is already running.',
  'no-encoder': 'No audio converter was found. Install ffmpeg (in Terminal: brew install ffmpeg), then press Scan '
    + 'again.',
  'no-space': 'There isn’t enough free disk space for these instruments. Pick fewer, or free some space.',
  'too-big': 'That’s too much at once. Pick fewer instruments.',
  'too-many': 'That’s too many at once. Pick fewer instruments.',
  'no-samples': 'Its sounds aren’t on this Mac. Download them in GarageBand first.',
  'convert-failed': 'Its sounds could not be converted.',
  'worker-exit': 'The importer stopped unexpectedly. Try again.',
  timeout: 'Looking through the library took too long. Try again.',
  'scan-failed': 'The GarageBand library could not be read.',
  error: 'Something went wrong with this one.',
});
const GB_ERROR_DEFAULT = 'That didn’t work. Press Scan again and try once more.';
export const GB_LICENSE = 'For your own use on this Mac. Apple’s sounds must not be shared or copied to other '
  + 'people.';
export const GB_EMPTY = 'No GarageBand or Logic instruments were found on this Mac. Open GarageBand once and let it '
  + 'download its sounds (GarageBand › Sound Library › Download All Available Sounds), then press Scan again.';
export const GB_NO_FFMPEG = 'ffmpeg isn’t installed, so Worship Rig uses the Mac’s own converter: the sounds are '
  + 'saved as AAC (.m4a) and the import takes longer. For the best result install ffmpeg (in Terminal: brew install '
  + 'ffmpeg), then press Scan again.';

/** "0.5 MB", "35 MB", "1.2 GB" */
export function formatSize(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1024 * 1048576) return `${(b / (1024 * 1048576)).toFixed(1)} GB`;
  const m = b / 1048576;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)} MB`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const errText = (code) => GB_ERROR_TEXT[code] || GB_ERROR_DEFAULT;

/** One line about an instrument's state in the list. */
function itemNote(it) {
  if (!it.found) return 'Sounds not downloaded';
  if (it.found < it.needed) return `${it.found} of ${it.needed} sounds found`;
  return it.installed ? 'Already in My Samples (imports again)' : '';
}

/** The progress line of one instrument while importing. */
function progressText(it) {
  switch (it.state) {
    case 'waiting': return 'Waiting';
    case 'converting': return it.files ? `${it.done} of ${it.files} files` : 'Getting ready…';
    case 'done': return `Done: ${plural(it.notes || 0, 'note')}${it.missing ? ` (${it.missing} sounds missing)` : ''}`;
    case 'cancelled': return 'Not imported';
    default: return errText(it.reason || 'error');
  }
}

/**
 * @param {{ rig: object, h: Function, btn: Function, rescan: () => Promise<any>, host: HTMLElement }} d
 *   settings.js helpers; `rescan` is Settings' Rescan (controller.rescanUserSamples); `host` = the settings dialog
 *   element the panel overlays
 * @returns {{ button: HTMLElement, line: HTMLElement, open: () => void, close: () => void, readonly isOpen: boolean,
 *   destroy: () => void }}
 */
export function mountGarageBandImport(d) {
  const { rig, h, btn, rescan, host } = d;
  const cleanups = [];
  let isOpen = false;
  let view = 'idle'; // idle | scanning | list | empty | error | importing | finished
  let scan = null; // last scan result
  let scanError = null;
  let job = null; // last progress snapshot
  let selected = new Set();
  let filter = '';
  let rescanned = null; // startedAt of the job already rescanned for
  let rescanState = ''; // '' | 'running' | 'done'
  let starting = false;
  let prevFocus = null;

  const button = btn('Import from GarageBand / Logic…', () => open(),
    { class: 'st-gb-open', 'data-testid': 'gb-open' });
  const line = h('p.st-hint.st-gb-line', { 'data-testid': 'gb-line', 'aria-live': 'polite', hidden: true });
  const titleId = 'st-gb-title';
  const closeX = btn('Close', () => close(), { class: 'st-gb-close', 'data-testid': 'gb-close',
    'aria-label': 'Close the GarageBand import' });
  const body = h('div.st-gb-body', { 'data-testid': 'gb-body' });
  const foot = h('div.st-gb-foot.st-inline');
  const card = h('div.st-gb-card', {},
    h('header.st-gb-head', {}, h('h2.st-gb-title', { id: titleId, text: 'Import from GarageBand / Logic' }), closeX),
    h('p.st-hint.st-gb-license', { 'data-testid': 'gb-license', text: GB_LICENSE }),
    body,
    foot);
  const panel = h('div.st-gb', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId,
    'data-testid': 'gb-dialog', hidden: true }, card);
  host.append(panel);

  // ---- events
  const onKey = (e) => {
    if (!isOpen || e.key !== 'Escape') return;
    e.preventDefault();
    close();
  };
  window.addEventListener('keydown', onKey);
  cleanups.push(() => window.removeEventListener('keydown', onKey));
  card.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    e.stopPropagation(); // Settings' own Tab trap would send focus behind the panel
    const f = [...card.querySelectorAll('button:not([disabled]),input:not([disabled])')]
      .filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) {
      e.preventDefault();
      f[f.length - 1].focus();
    } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
      e.preventDefault();
      f[0].focus();
    }
  });
  if (typeof rig.onGarageBandProgress === 'function') {
    cleanups.push(rig.onGarageBandProgress((snap) => onSnapshot(snap)));
  }

  function onSnapshot(snap) {
    if (!snap || typeof snap !== 'object' || !Array.isArray(snap.items)) return;
    job = snap;
    if (snap.state === 'importing') view = 'importing';
    else if (['done', 'cancelled', 'failed'].includes(snap.state) && (view === 'importing' || view === 'idle')) {
      view = 'finished';
      autoRescan();
    }
    renderLine();
    if (isOpen) render();
  }

  /** After an import that installed something: Rescan once, so the packs show up in the picker without a restart. */
  async function autoRescan() {
    if (!job || !job.imported || rescanned === job.startedAt) return;
    rescanned = job.startedAt;
    rescanState = 'running';
    if (scan) for (const it of job.items) if (it.state === 'done') markInstalled(it.key);
    if (isOpen) render();
    try {
      await rescan();
    } finally {
      rescanState = 'done';
      renderLine();
      if (isOpen) render();
    }
  }

  function markInstalled(key) {
    const it = scan && scan.instruments.find((x) => x.key === key);
    if (it) it.installed = true;
  }

  // ---- open / close
  function open() {
    if (isOpen) return;
    isOpen = true;
    prevFocus = document.activeElement;
    panel.hidden = false;
    // settings.js / main.js close Settings on Esc in a window capture listener; this tells them the panel owns it
    document.documentElement.setAttribute('data-gb-import', '');
    if (view === 'idle' || view === 'error') startScan(false);
    else render();
    rig.garageBandStatus?.().then((s) => {
      if (s && s.state === 'importing') onSnapshot(s);
    }).catch(() => {});
    queueMicrotask(() => (card.querySelector('.st-gb-filter') || closeX).focus());
  }
  function close() {
    if (!isOpen) return;
    isOpen = false;
    panel.hidden = true;
    document.documentElement.removeAttribute('data-gb-import');
    if (view === 'finished' && job && job.state !== 'importing') view = scan ? 'list' : 'idle';
    if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === 'function') prevFocus.focus();
    else button.focus();
    prevFocus = null;
  }

  async function startScan(reindex) {
    view = 'scanning';
    scanError = null;
    render();
    let r;
    try {
      r = await rig.garageBandScan(reindex ? { reindex: true } : undefined);
    } catch (err) {
      r = { error: (err && err.message) || 'scan-failed' };
    }
    if (view !== 'scanning') return; // an import started meanwhile (another window) took over
    if (!r || r.error) {
      scanError = (r && r.error) || 'scan-failed';
      view = 'error';
      if (r && r.error !== 'busy') console.warn('[settings] GarageBand scan', r);
    } else {
      scan = r;
      const keys = new Set(r.instruments.map((it) => it.key));
      selected = new Set([...selected].filter((k) => keys.has(k)));
      view = r.instruments.length ? 'list' : 'empty';
    }
    if (isOpen) {
      render();
      if (view === 'list') card.querySelector('.st-gb-filter')?.focus();
    }
  }

  async function startImport() {
    if (starting || !selected.size) return;
    starting = true;
    render();
    let r;
    try {
      r = await rig.garageBandImport([...selected]);
    } catch (err) {
      r = { error: (err && err.message) || 'import-failed' };
    }
    starting = false;
    if (!r || r.error) {
      scanError = (r && r.error) || 'import-failed';
      if (r && r.error !== 'busy') console.warn('[settings] GarageBand import', r);
      render();
      return;
    }
    selected = new Set();
    scanError = null;
    rescanState = '';
    if (view !== 'finished') view = 'importing';
    render();
  }

  // ---- render
  function shown() {
    const q = filter.trim().toLowerCase();
    const all = scan ? scan.instruments : [];
    return q ? all.filter((it) => it.name.toLowerCase().includes(q) || String(it.category).includes(q)) : all;
  }

  function selection() {
    const items = scan ? scan.instruments.filter((it) => selected.has(it.key)) : [];
    return { n: items.length, bytes: items.reduce((s, it) => s + (it.estBytes || 0), 0) };
  }

  const errorLine = () => h('p.st-status.warn', { 'data-testid': 'gb-error', role: 'status',
    text: errText(scanError) });

  function renderList() {
    const kids = [];
    const enc = scan.encoder || {};
    if (enc.error) kids.push(h('p.st-status.warn', { 'data-testid': 'gb-encoder', text: errText(enc.error) }));
    else if (!enc.ffmpeg) kids.push(h('p.st-hint.st-gb-note', { 'data-testid': 'gb-encoder', text: GB_NO_FFMPEG }));
    if (scanError) kids.push(errorLine());
    const filterEl = h('input.st-gb-filter', { type: 'search', placeholder: 'Find an instrument', value: filter,
      'aria-label': 'Find an instrument', 'data-testid': 'gb-filter' });
    filterEl.addEventListener('input', () => {
      filter = filterEl.value;
      listEl.replaceChildren(...rows());
    });
    const listEl = h('div.st-gb-list', { role: 'group', 'aria-label': 'Instruments', 'data-testid': 'gb-list' });
    const rows = () => {
      const list = shown();
      if (!list.length) return [h('p.st-hint', { text: 'No instrument matches.' })];
      return list.map((it) => {
        const note = itemNote(it);
        const cb = h('input', { type: 'checkbox', 'data-key': it.key, disabled: !it.found,
          'data-testid': `gb-pick-${it.id}` });
        cb.checked = selected.has(it.key);
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(it.key);
          else selected.delete(it.key);
          renderFoot();
        });
        return h('label.st-gb-row', { class: it.found ? '' : 'off', 'data-id': it.id, title: it.source || '' },
          cb,
          h('span.st-gb-name', { text: it.name }),
          h('span.st-gb-size', { text: `about ${formatSize(it.estBytes)}`,
            title: `About ${formatSize(it.estBytes)} once converted (${formatSize(it.sourceBytes)} of audio in `
              + `${it.origin === 'EXS' ? 'the library' : it.origin})` }),
          h('span.st-gb-meta', { text: [it.origin === 'EXS' ? null : it.origin, it.category,
            plural(it.notes, 'note')].filter(Boolean).join(' · ') }),
          note ? h('span.st-gb-flag', { text: note, 'data-flag': !it.found ? 'missing' : it.installed && it.found
            >= it.needed ? 'installed' : 'partial' }) : null);
      });
    };
    listEl.replaceChildren(...rows());
    kids.push(filterEl, listEl);
    if (scan.truncated) kids.push(h('p.st-hint', { text: 'Only the first instruments are listed. Use the search.' }));
    body.replaceChildren(...kids);
  }

  function renderFoot() {
    const kids = [];
    if (view === 'list') {
      const s = selection();
      const lim = (scan && scan.limits) || { maxPerImport: 40, maxTotalMb: 2048 };
      const over = s.n > lim.maxPerImport || s.bytes > lim.maxTotalMb * 1048576;
      const noEnc = !!(scan && scan.encoder && scan.encoder.error);
      kids.push(h('span.st-status.st-gb-sum', { 'data-testid': 'gb-summary', class: over ? 'warn' : '',
        text: s.n ? `${plural(s.n, 'instrument')} · about ${formatSize(s.bytes)}${over ? ' — too much at once' : ''}`
          : 'Tick the instruments you want.' }));
      kids.push(btn(starting ? 'Starting…' : 'Import', startImport, { class: 'st-gb-go', 'data-testid': 'gb-import',
        disabled: !s.n || over || noEnc || starting }));
      kids.push(btn('Scan again', () => startScan(true), { class: 'st-gb-rescan', 'data-testid': 'gb-scan' }));
    } else if (view === 'empty' || view === 'error') {
      kids.push(btn('Scan again', () => startScan(true), { class: 'st-gb-rescan', 'data-testid': 'gb-scan' }));
    } else if (view === 'importing') {
      const stopping = !!(job && job.cancelling);
      kids.push(btn(stopping ? 'Stopping…' : 'Stop', async () => {
        await rig.garageBandCancel();
      }, { class: 'st-gb-cancel', 'data-testid': 'gb-cancel', disabled: stopping }));
      kids.push(h('span.st-hint', { text: 'You can close this; the import keeps going.' }));
    } else if (view === 'finished') {
      kids.push(btn('Done', () => close(), { class: 'st-gb-done', 'data-testid': 'gb-done' }));
      kids.push(btn('Import more', () => {
        view = scan ? 'list' : 'idle';
        if (scan) render();
        else startScan(false);
      }, { class: 'st-gb-more', 'data-testid': 'gb-more' }));
    }
    foot.replaceChildren(...kids);
  }

  function summaryText() {
    if (!job) return '';
    const n = job.imported || 0;
    if (job.state === 'importing') {
      const at = Math.max(0, job.items.findIndex((it) => it.state === 'converting'));
      return `Importing ${Math.min(at + 1, job.total)} of ${job.total}…`;
    }
    if (job.state === 'failed' && !n) return errText(job.error);
    const got = n ? `${plural(n, 'instrument')} ${n === 1 ? 'is' : 'are'} in My Samples now.` : 'Nothing was imported.';
    if (job.state === 'cancelled') return `Stopped. ${got}`;
    return job.failed ? `${got} ${plural(job.failed, 'instrument')} could not be imported.` : got;
  }

  function renderProgress() {
    const kids = [h('p.st-gb-summary', { 'data-testid': 'gb-progress-summary', role: 'status', text: summaryText() })];
    if (view === 'finished' && job && job.imported) {
      kids.push(h('p.st-hint', { 'data-testid': 'gb-rescan-state', text: rescanState === 'running'
        ? 'Adding them to the instrument picker…'
        : 'They’re in the instrument picker under “My Samples”.' }));
    }
    const list = h('div.st-gb-list.st-gb-progress', { 'data-testid': 'gb-progress' });
    for (const it of (job && job.items) || []) {
      const bar = h('progress.st-gb-bar', { max: Math.max(1, it.files || 1), 'aria-label': `${it.name} progress` });
      bar.value = it.state === 'done' ? bar.max : it.done || 0;
      list.append(h('div.st-gb-prow', { 'data-state': it.state, 'data-key': it.key },
        h('span.st-gb-name', { text: it.name }),
        h('span.st-gb-state', { text: progressText(it) }),
        it.state === 'converting' || it.state === 'done' ? bar : null));
    }
    kids.push(list);
    body.replaceChildren(...kids);
  }

  function render() {
    if (view === 'scanning') {
      body.replaceChildren(h('p.st-gb-summary', { role: 'status', 'data-testid': 'gb-scanning',
        text: 'Looking for GarageBand and Logic instruments…' }),
      h('p.st-hint', { text: 'The first look can take a minute on a big library.' }));
    } else if (view === 'empty') {
      body.replaceChildren(h('p.st-hint', { 'data-testid': 'gb-empty', text: GB_EMPTY }));
    } else if (view === 'error') {
      body.replaceChildren(errorLine());
    } else if (view === 'list' && scan) renderList();
    else if (view === 'importing' || view === 'finished') renderProgress();
    renderFoot();
  }

  function renderLine() {
    let t = '';
    if (job && job.state === 'importing') t = summaryText();
    else if (job && view === 'finished' && !isOpen && job.imported) t = summaryText();
    line.textContent = t;
    line.hidden = !t;
  }

  return {
    button,
    line,
    open,
    close,
    get isOpen() {
      return isOpen;
    },
    destroy() {
      close();
      for (const c of cleanups.splice(0)) {
        try {
          c();
        } catch {
          /* ignore */
        }
      }
      panel.remove();
    },
  };
}
