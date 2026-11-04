// Settings parts that only exist in the Mac app (v11-electron): global shortcuts in Settings › Menu bar and the
// "update available" line in Settings › About. Both are quiet by default: shortcuts are off until switched on, and
// the update line only says something when there is something to say. Nothing here ever opens a dialog over Perform.
// Writes go through store.set (settings.hotkeys / settings.updateCheck; shell-mirror.js passes them to Electron main);
// the rest is window.rig (main's registration results, "Check now", opening the download in the browser).
import {
  HOTKEY_ACTIONS, MASTER_STEP_DB, acceleratorError, acceleratorFromEvent, formatAccelerator, hotkeyConflict, hotkeysOf,
  DEFAULT_HOTKEYS,
} from '../shared/hotkeys.js';
import { say } from './components/voice.js';

/** Plain words for main.js's per-shortcut state (HotkeyStatus.keys[id].state). */
export const HOTKEY_STATE_TEXT = Object.freeze({
  taken: 'Another app already uses this. Pick another.',
  invalid: 'This combination can’t be used. Pick another.',
});
/** Plain words for a failed "Check now" (UpdateStatus.error). An automatic check never shows its error. */
export const UPDATE_ERROR_TEXT = Object.freeze({
  offline: 'Couldn’t reach GitHub. Check the internet connection and try again.',
  'rate-limited': 'GitHub is busy right now. Try again in an hour.',
  'bad-response': 'GitHub sent an unexpected answer. Try again later.',
});

/** v11-decisions: actions whose label is voice copy (shared/voice.js); the rest read HOTKEY_ACTIONS' label. */
const LABEL_VOICE = Object.freeze({ nextSong: 'hotkeyNextSong', prevSong: 'hotkeyPrevSong' });
const labelOf = (a) => (LABEL_VOICE[a.id] ? say(LABEL_VOICE[a.id]) : a.label);

const LABEL_HINT = Object.freeze({
  masterUp: `+${MASTER_STEP_DB} dB`,
  masterDown: `−${MASTER_STEP_DB} dB`,
});

/** "today", "yesterday", "3 days ago" (for "checked …"). */
function ago(ms, now = Date.now()) {
  const days = Math.floor((now - ms) / 86400000);
  if (!Number.isFinite(days) || days <= 0) return 'today';
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/**
 * Global shortcuts (Settings › Menu bar). Mounted only when window.rig.setHotkeys exists (the Mac app).
 * @param {{store: object, rig: object, h: Function, btn: Function, row: Function, toggle: Function}} d  settings.js
 *   helpers (h, btn, row) and the toggle component
 * @returns {{el: HTMLElement, refresh: () => void, cancel: () => void, destroy: () => void}}
 */
export function mountHotkeys(d) {
  const { store, rig, h, btn, row } = d;
  const mac = (rig.platform || 'darwin') === 'darwin';
  let status = null; // the last HotkeyStatus from main
  let capturing = null; // action id while recording
  let message = '';
  const cleanups = [];
  const cfg = () => hotkeysOf(store.get().settings);
  const write = (next) => store.set('settings.hotkeys', next);

  const onToggle = d.toggle({ label: 'Work in any app', onChange: (v) => write({ ...cfg(), on: !!v }) });
  onToggle.el.dataset.testid = 'setting-hotkeys-on';
  onToggle.el.dataset.bind = 'settings.hotkeys';
  const keyBtns = {};
  const stateEls = {};
  const rows = HOTKEY_ACTIONS.map((a) => {
    keyBtns[a.id] = btn('', () => (capturing === a.id ? stop() : start(a.id)), {
      class: 'st-hk-key', 'data-testid': `hotkey-${a.id}`, 'aria-label': `${labelOf(a)} shortcut`,
    });
    keyBtns[a.id].addEventListener('blur', () => {
      if (capturing === a.id) stop();
    });
    stateEls[a.id] = h('span.st-hk-state', { 'data-testid': `hotkey-state-${a.id}`, role: 'status' });
    return h('div.st-hk-row', { 'data-hotkey': a.id },
      h('span.st-hk-label', {}, labelOf(a), LABEL_HINT[a.id] ? h('span.st-hint', { text: ` ${LABEL_HINT[a.id]}` }) : null),
      keyBtns[a.id],
      stateEls[a.id]);
  });
  const msg = h('p.st-status.warn.st-hk-msg', { 'data-testid': 'hotkey-message', role: 'status', hidden: true });
  const reset = btn('Use the standard keys', () => {
    message = '';
    write({ ...cfg(), keys: { ...DEFAULT_HOTKEYS } });
  }, { class: 'st-hk-reset', 'data-testid': 'hotkey-reset' });
  const list = h('div.st-hk-list', { 'data-testid': 'hotkey-list', hidden: true },
    ...rows,
    h('p.st-hint', { text: say('hotkeysListHint') }),
    mac ? h('p.st-hint', { 'data-testid': 'hotkey-mac-taken', text: say('hotkeysMacTakenHint') }) : null,
    msg,
    h('div.st-inline', {}, reset));
  const el = h('div.st-hotkeys', { 'data-testid': 'settings-hotkeys' },
    row('Global shortcuts', onToggle.el, say('hotkeysSub')),
    list);

  function render() {
    const c = cfg();
    onToggle.set(c.on);
    list.hidden = !c.on;
    for (const a of HOTKEY_ACTIONS) {
      const acc = c.keys[a.id];
      const b = keyBtns[a.id];
      const rec = capturing === a.id;
      b.textContent = rec ? 'Press keys…' : acc ? formatAccelerator(acc, { mac }) : 'None';
      b.classList.toggle('recording', rec);
      b.setAttribute('aria-pressed', String(rec));
      b.title = acc ? acc : '';
      const st = status && status.keys && status.keys[a.id];
      // only a result for the combination shown counts (main answers asynchronously)
      const word = st && st.accelerator === acc && c.on && !rec ? HOTKEY_STATE_TEXT[st.state] || '' : '';
      stateEls[a.id].textContent = word;
      stateEls[a.id].dataset.state = st && st.accelerator === acc ? st.state : '';
      b.classList.toggle('warn', !!word);
    }
    msg.hidden = !message;
    msg.textContent = message;
  }

  function onKey(e) {
    if (!capturing) return;
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
    if (plain && e.key === 'Tab') return stop(); // focus moves on
    e.preventDefault();
    e.stopPropagation(); // never a note, sustain or panic while recording
    if (plain && e.key === 'Escape') return stop();
    const id = capturing;
    if (plain && (e.key === 'Backspace' || e.key === 'Delete')) {
      message = '';
      write({ ...cfg(), keys: { ...cfg().keys, [id]: '' } });
      return stop();
    }
    const acc = acceleratorFromEvent(e);
    if (!acc) return; // a modifier on its own: keep waiting for the key
    const err = acceleratorError(acc);
    const other = err ? null : hotkeyConflict(cfg().keys, id, acc);
    if (err) message = err;
    else if (other) message = `${formatAccelerator(acc, { mac })} is already the shortcut for `
      + `${labelOf(HOTKEY_ACTIONS.find((a) => a.id === other))}.`;
    else {
      message = '';
      write({ ...cfg(), keys: { ...cfg().keys, [id]: acc } });
    }
    stop();
  }

  function start(id) {
    if (capturing) stop();
    capturing = id;
    message = '';
    // settings.js and main.js close Settings on Esc in a window capture listener; this attribute tells them not to
    document.documentElement.setAttribute('data-hotkey-capture', id);
    window.addEventListener('keydown', onKey, true);
    // our own registered combinations would never reach the page: let go of them while recording
    Promise.resolve(rig.pauseHotkeys && rig.pauseHotkeys(true)).catch(() => {});
    render();
    keyBtns[id].focus();
  }
  function stop() {
    if (!capturing) return;
    capturing = null;
    window.removeEventListener('keydown', onKey, true);
    // removed after this keydown has finished travelling, so Settings' own Esc handler still skips it
    setTimeout(() => {
      if (!capturing) document.documentElement.removeAttribute('data-hotkey-capture');
    }, 0);
    Promise.resolve(rig.pauseHotkeys && rig.pauseHotkeys(false)).catch(() => {});
    render();
  }

  const setStatus = (s) => {
    if (s && typeof s === 'object' && !s.error && s.keys) {
      status = s;
      render();
    }
  };
  if (typeof rig.onHotkeyStatus === 'function') {
    const off = rig.onHotkeyStatus(setStatus);
    if (typeof off === 'function') cleanups.push(off);
  }
  cleanups.push(store.subscribe((_s, paths) => {
    if (paths.some((p) => p === 'settings' || p.startsWith('settings.hotkeys'))) render();
  }));
  render();

  return {
    el,
    refresh() {
      if (typeof rig.getHotkeyStatus === 'function') Promise.resolve(rig.getHotkeyStatus()).then(setStatus, () => {});
      render();
    },
    cancel() {
      message = '';
      stop();
    },
    destroy() {
      stop();
      for (const c of cleanups.splice(0)) c();
      onToggle.destroy?.();
    },
  };
}

/**
 * "Update available" (Settings › About). Mounted only when window.rig.setUpdateCheck exists (the Mac app).
 * @param {{store: object, rig: object, h: Function, btn: Function, row: Function, toggle: Function}} d
 * @returns {{el: HTMLElement, refresh: () => void, destroy: () => void}}
 */
export function mountUpdates(d) {
  const { store, rig, h, btn, row } = d;
  let status = null;
  let opened = false;
  const cleanups = [];
  const onToggle = d.toggle({ label: 'Check for updates', onChange: (v) => store.set('settings.updateCheck', !!v) });
  onToggle.el.dataset.testid = 'setting-update-check';
  onToggle.el.dataset.bind = 'settings.updateCheck';
  const line = h('p.st-status.st-update-line', { 'data-testid': 'update-status', role: 'status' });
  const open = (kind) => async () => {
    const r = await rig.openUpdate(kind);
    if (r && r.error) console.warn('[settings] openUpdate', r.error);
    else if (kind === 'download') {
      opened = true;
      render();
    }
  };
  const download = btn('Download', open('download'), { class: 'st-update-download', 'data-testid': 'update-download',
    title: 'Opens the download for this Mac in your browser' });
  const notes = btn('What’s new', open('page'), { class: 'st-update-notes', 'data-testid': 'update-notes' });
  let busy = false;
  const check = btn('Check now', async () => {
    busy = true;
    render();
    try {
      const r = await rig.checkForUpdate();
      if (r && typeof r.state === 'string') status = r;
    } finally {
      busy = false;
      render();
    }
  }, { class: 'st-update-now', 'data-testid': 'update-check-now' });
  const how = h('p.st-hint.st-update-how', { 'data-testid': 'update-how', hidden: true,
    text: 'When the download has finished: quit Worship Rig, open the .dmg and drag Worship Rig to Applications '
      + '(replace the old one). Your songs stay.' });
  const buttons = h('div.st-inline', {}, download, notes, check);
  const el = h('div.st-update', { 'data-testid': 'settings-update' },
    row('Updates', onToggle.el, 'Once a day Worship Rig asks GitHub whether a newer version is out. It never installs '
      + 'anything by itself.'),
    line, buttons, how);

  function render() {
    const on = store.get().settings.updateCheck !== false;
    onToggle.set(on);
    const s = status || {};
    let text = '';
    const update = s.state === 'update';
    if (s.state === 'unsupported') text = 'Update checks run in the installed Mac app.';
    else if (s.state === 'checking') text = 'Checking…';
    else if (update) text = `Version ${s.latest} is available. You have ${s.current}.`;
    else if (s.error && UPDATE_ERROR_TEXT[s.error]) text = UPDATE_ERROR_TEXT[s.error];
    else if (s.state === 'latest') {
      text = `You have the latest version (${s.current})${s.checkedAt ? `, checked ${ago(s.checkedAt)}` : ''}.`;
    }
    line.textContent = text;
    line.hidden = !text;
    line.dataset.state = s.state || '';
    line.classList.toggle('st-update-new', update);
    download.hidden = !update;
    notes.hidden = !update;
    check.hidden = s.state === 'unsupported' || !status;
    check.disabled = busy || s.state === 'checking';
    how.hidden = !(update && opened);
  }
  const setStatus = (s) => {
    if (s && typeof s === 'object' && typeof s.state === 'string') { // an IPC failure is a bare {error}
      status = s;
      render();
    }
  };
  if (typeof rig.onUpdateStatus === 'function') {
    const off = rig.onUpdateStatus(setStatus);
    if (typeof off === 'function') cleanups.push(off);
  }
  cleanups.push(store.subscribe((_s, paths) => {
    if (paths.some((p) => p === 'settings' || p === 'settings.updateCheck')) render();
  }));
  render();
  return {
    el,
    refresh() {
      if (typeof rig.getUpdateStatus === 'function') Promise.resolve(rig.getUpdateStatus()).then(setStatus, () => {});
      render();
    },
    destroy() {
      for (const c of cleanups.splice(0)) c();
      onToggle.destroy?.();
    },
  };
}
