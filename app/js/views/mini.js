// Menu-bar popover (docs/menubar-mode.md, contract v1): app/mini.html. A SEPARATE renderer with no audio; it shows
// the main window's `state` and sends `command`s over the bus (shared/bus.js: the Electron preload relay, or
// BroadcastChannel 'rig-bus' in a browser, so this page and its Playwright suite run on Linux too).
// Layout for 320×440, no scroll: header (‹ current mode + key ›) · 2–6 mode buttons (1 column, 2 at 5–6
// modes) · master fader (relative drag) · Drone pill + key sheet · Fade · Panic (hold 600 ms) · Open · Rec ·
// Eco · status line.
// Until the first `state` arrives it shows "Waiting for Worship Rig…" and sends `hello` now and every 2 s.
// Theme (mini-theme): boot.js themes the page from the localStorage mirror before first paint; while open, the
// popover follows the Settings theme live from the mirror's `storage` event and from an optional `state.theme`
// (createThemeFollower below). mini.css is tokens only, so a theme's tokens theme the popover.

import { createBus } from '../shared/bus.js';
import { resolveThemeId, themeAttrs, THEME_MIRROR_KEY } from '../shared/themes.js';
import { warmThemeFonts, releaseWarmedFonts } from './components/themeFonts.js';

const HELLO_MS = 2000;
const PANIC_HOLD_MS = 600;
const MASTER_SEND_MS = 50; // ≤ 20 master commands/s while dragging
const MASTER_ECHO_MS = 400; // ignore state.master this long after our own send (no thumb jitter from the echo)
const MAX_MODES = 6;
const PC_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/**
 * Key name ("D", "F#", "Bb", "E♭m", "C# minor") → pitch class 0..11, or null.
 * @param {string} k
 * @returns {number|null}
 */
export function keyToPc(k) {
  const m = /^\s*([A-Ga-g])\s*([#♯b♭]?)/.exec(String(k ?? ''));
  if (!m) return null;
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0;
  return (LETTER_PC[m[1].toUpperCase()] + acc + 12) % 12;
}

/** Fader position 0..1 ↔ linear gain 0..2: the app's dB-display taper (shared/params.js faderTaper, 2·p³). */
export const taper = (p) => 2 * Math.pow(Math.min(1, Math.max(0, p)), 3);
/** @param {number} g linear gain @returns {number} position 0..1 */
export const untaper = (g) => (g > 0 ? Math.min(1, Math.cbrt(g / 2)) : 0);

/**
 * Linear gain → "−6.0 dB" ("−∞ dB" at 0).
 * @param {number} g
 * @returns {string}
 */
export function formatDb(g) {
  if (!(g > 1e-5)) return '−∞ dB';
  const db = 20 * Math.log10(g);
  const r = Math.abs(db) < 0.05 ? 0 : db;
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(1)} dB`;
}

/**
 * Status line: audio state · latency · MIDI device.
 * @param {object} s bus state
 * @returns {{text:string, led:'ok'|'warn'|'bad'}}
 */
export function statusLine(s) {
  const a = s?.audio;
  // lowres2: the app's own audio sleep is a normal state (it wakes on the next note or key), so its LED stays 'ok'
  const audio = { running: 'Sound OK', asleep: 'Audio asleep', suspended: 'Sound paused', stalled: 'Sound stopped' }[a]
    || 'Sound…';
  const lat = Number(s?.latencyMs) > 0 ? `${Math.round(s.latencyMs)} ms` : '— ms';
  const midi = s?.midi?.connected ? s.midi.name || 'MIDI connected' : 'No MIDI keyboard';
  const led = a === 'running' ? (Number(s?.latencyMs) >= 40 ? 'warn' : 'ok') : a === 'asleep' ? 'ok'
    : a === 'stalled' ? 'bad' : 'warn';
  return { text: `${audio} · ${lat} · ${midi}`, led };
}

// ------------------------------------------------------------------------------------------------ DOM helpers
function h(tag, attrs = {}, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag) || [];
  const e = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') e.classList.add(part.slice(1));
    else e.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') e.textContent = String(v);
    else if (k === 'on') for (const [t, fn] of Object.entries(v)) e.addEventListener(t, fn);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}
const setText = (e, t) => {
  const s = String(t ?? '');
  if (e.textContent !== s) e.textContent = s;
};
const setAttr = (e, k, v) => {
  const s = String(v);
  if (e.getAttribute(k) !== s) e.setAttribute(k, s);
};
function icon(d, size = 20) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  const attrs = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' };
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, String(v));
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', d);
  s.append(p);
  return s;
}
const ICON = {
  prev: 'M15 5l-7 7 7 7',
  next: 'M9 5l7 7-7 7',
  chev: 'M6 9l6 6 6-6',
  open: 'M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  fade: 'M4 6c6 0 10 4 16 12',
};

// ------------------------------------------------------------------------------------------------ view
/**
 * Build the popover into `el` and wire it to `bus`.
 * @param {HTMLElement} el
 * @param {{bus:{send:(cmd:object)=>void, onState:(cb:(s:object)=>void)=>(()=>void), close?:()=>void},
 *   helloMs?:number}} o
 * @returns {{readonly state:object|null, sent:object[], destroy():void}}
 */
export function mountMini(el, o) {
  const bus = o.bus;
  const sent = [];
  const cleanups = [];
  let state = null;
  let modesSig = '';
  let modeBtns = [];
  const send = (type, extra = {}) => {
    const cmd = { v: 1, type, ...extra };
    sent.push(cmd);
    if (sent.length > 200) sent.splice(0, sent.length - 200);
    try {
      bus.send(cmd);
    } catch (err) {
      console.warn('[mini] send failed', err);
    }
  };
  const listen = (t, type, fn, opts) => {
    t.addEventListener(type, fn, opts);
    cleanups.push(() => t.removeEventListener(type, fn, opts));
  };

  // ---- waiting
  const waitOpen = h('button.mini-btn.wait-open', { type: 'button', 'data-testid': 'mini-wait-open' },
    'Open Worship Rig');
  const waiting = h('section.mini-wait', { role: 'status', 'data-testid': 'mini-waiting' },
    h('img.wait-logo', { src: './assets/mark.svg', alt: '', width: 56, height: 56 }),
    h('p.wait-title', { text: 'Waiting for Worship Rig…' }),
    h('p.wait-sub', { text: 'Start the app (or reload it). This panel connects by itself.' }),
    waitOpen,
  );
  listen(waitOpen, 'click', () => send('openMain'));

  // ---- header: ‹ current ›
  const prevBtn = h('button.mini-btn.nav-btn', { type: 'button', 'aria-label': 'Previous mode', title: 'Previous mode',
    'data-testid': 'mini-prev' }, icon(ICON.prev, 22));
  const nextBtn = h('button.mini-btn.nav-btn', { type: 'button', 'aria-label': 'Next mode', title: 'Next mode',
    'data-testid': 'mini-next' }, icon(ICON.next, 22));
  const curName = h('div.cur-name', { 'data-testid': 'mini-current' });
  const curKey = h('span.cur-key', { 'data-testid': 'mini-key' });
  const curPos = h('span.cur-pos');
  const header = h('header.mini-head', {}, prevBtn,
    h('div.cur', { 'aria-live': 'polite' }, curName, h('div.cur-sub', {}, curKey, curPos)), nextBtn);
  listen(prevBtn, 'click', () => send('prevMode'));
  listen(nextBtn, 'click', () => send('nextMode'));

  // ---- modes (+ the drone key sheet over them)
  const modesEl = h('div.modes', { role: 'group', 'aria-label': 'Modes', 'data-testid': 'mini-modes' });
  const keyBtns = PC_NAMES.map((n, pc) => h('button.mini-btn.dk', { type: 'button', 'data-pc': pc,
    'aria-pressed': 'false', 'data-testid': `mini-dk-${pc}` }, n));
  const sheetDone = h('button.mini-btn.sheet-done', { type: 'button' }, 'Done');
  const droneSheet = h('div.drone-sheet', { hidden: true, role: 'group', 'aria-label': 'Drone key',
    'data-testid': 'mini-drone-sheet' },
    h('div.sheet-head', {}, h('span', { text: 'Drone key' }), sheetDone),
    h('div.dk-grid', {}, ...keyBtns));
  const modesWrap = h('div.modes-wrap', {}, modesEl, droneSheet);
  for (const b of keyBtns) listen(b, 'click', () => send('droneKey', { pc: Number(b.dataset.pc) }));

  // ---- master fader (relative drag: a tap never jumps the whole-house volume, as the top-bar fader, UX S7/B2)
  const mFill = h('i.mf-fill');
  const mThumb = h('i.mf-thumb');
  const mDb = h('span.mf-db', { 'data-testid': 'mini-master-db' });
  const fader = h('div.mf', { role: 'slider', tabindex: 0, 'aria-label': 'Master volume', 'aria-valuemin': 0,
    'aria-valuemax': 2, 'data-testid': 'mini-master' },
  h('span.mf-track', {}, mFill, mThumb), h('span.mf-label', { text: 'Master' }), mDb);
  let masterPos = untaper(0.5);
  let drag = null;
  let lastSendAt = 0;
  let sendTimer = null;
  let lastLocalAt = -Infinity;
  const renderMaster = () => {
    const g = taper(masterPos);
    fader.style.setProperty('--pos', masterPos.toFixed(4));
    setText(mDb, formatDb(g));
    setAttr(fader, 'aria-valuenow', g.toFixed(3));
    setAttr(fader, 'aria-valuetext', formatDb(g));
  };
  const flushMaster = () => {
    clearTimeout(sendTimer);
    sendTimer = null;
    lastSendAt = performance.now();
    lastLocalAt = lastSendAt;
    send('master', { value: Math.round(taper(masterPos) * 1e4) / 1e4 });
  };
  const queueMaster = () => {
    lastLocalAt = performance.now();
    const wait = MASTER_SEND_MS - (lastLocalAt - lastSendAt);
    if (wait <= 0) flushMaster();
    else if (!sendTimer) sendTimer = setTimeout(flushMaster, wait);
  };
  const setPos = (p) => {
    masterPos = Math.min(1, Math.max(0, p));
    renderMaster();
    queueMaster();
  };
  listen(fader, 'pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const r = fader.getBoundingClientRect();
    drag = { id: e.pointerId, last: e.clientX, len: Math.max(60, r.width - 24) };
    try {
      fader.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events */
    }
    fader.classList.add('dragging');
  });
  listen(fader, 'pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.last;
    drag.last = e.clientX;
    if (dx) setPos(masterPos + (dx / drag.len) * (e.shiftKey ? 0.25 : 1));
  });
  const endDrag = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    drag = null;
    fader.classList.remove('dragging');
    if (sendTimer) flushMaster();
  };
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(fader, t, endDrag);
  listen(fader, 'keydown', (e) => {
    const step = e.shiftKey ? 0.005 : 0.02;
    const d = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step }[e.key];
    if (d === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    setPos(masterPos + d);
  });

  // ---- actions: Drone · keys ▾ · Fade · Panic (hold)
  const droneBtn = h('button.mini-btn.pill.drone', { type: 'button', 'aria-pressed': 'false',
    'data-testid': 'mini-drone' },
    h('i.pill-dot', { 'aria-hidden': 'true' }), h('span.pill-t', { text: 'Drone' }), h('span.pill-k'));
  const droneMore = h('button.mini-btn.sq', { type: 'button', 'aria-label': 'Choose the drone key', title: 'Drone key',
    'aria-expanded': 'false', 'data-testid': 'mini-drone-keys' }, icon(ICON.chev, 20));
  const fadeBtn = h('button.mini-btn.fade', { type: 'button', title: 'Fade everything out',
    'data-testid': 'mini-fade' },
    icon(ICON.fade, 18), h('span', { text: 'Fade' }));
  const panicSub = h('span.panic-sub', { text: 'hold' });
  const panicBtn = h('button.mini-btn.panic', { type: 'button', title: 'Hold to stop all sound',
    'data-testid': 'mini-panic' },
    h('span.panic-t', { text: 'Panic' }), panicSub);
  listen(droneBtn, 'click', () => send('droneToggle'));
  const setSheet = (open) => {
    droneSheet.hidden = !open;
    setAttr(droneMore, 'aria-expanded', open);
    el.classList.toggle('sheet-open', open);
  };
  listen(droneMore, 'click', () => setSheet(droneSheet.hidden));
  listen(sheetDone, 'click', () => setSheet(false));
  listen(fadeBtn, 'click', () => send('fadeOutAll'));

  let holdTimer = null;
  let holdRaf = 0;
  let holdT0 = 0;
  let hintTimer = null;
  const holdTick = () => {
    holdRaf = 0;
    if (!holdTimer) return;
    panicBtn.style.setProperty('--hold', Math.min(1, (performance.now() - holdT0) / PANIC_HOLD_MS).toFixed(3));
    holdRaf = requestAnimationFrame(holdTick);
  };
  const holdStop = () => {
    clearTimeout(holdTimer);
    holdTimer = null;
    if (holdRaf) cancelAnimationFrame(holdRaf);
    holdRaf = 0;
    panicBtn.classList.remove('holding');
    panicBtn.style.removeProperty('--hold');
  };
  const holdStart = () => {
    holdStop();
    holdT0 = performance.now();
    panicBtn.classList.add('holding');
    holdTimer = setTimeout(() => {
      holdStop();
      send('panic');
      panicBtn.classList.add('fired');
      setText(panicSub, 'stopped');
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => {
        panicBtn.classList.remove('fired');
        setText(panicSub, 'hold');
      }, 900);
    }, PANIC_HOLD_MS);
    holdRaf = requestAnimationFrame(holdTick);
  };
  const holdCancel = () => {
    if (!holdTimer) return;
    holdStop();
    setText(panicSub, 'keep holding');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => setText(panicSub, 'hold'), 1400);
  };
  listen(panicBtn, 'pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    holdStart();
  });
  for (const t of ['pointerup', 'pointerleave', 'pointercancel']) listen(panicBtn, t, holdCancel);
  listen(panicBtn, 'keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
      e.preventDefault();
      holdStart();
    }
  });
  listen(panicBtn, 'keyup', (e) => {
    if (e.key === 'Enter' || e.key === ' ') holdCancel();
  });
  listen(panicBtn, 'contextmenu', (e) => e.preventDefault());

  // ---- footer: Open · Rec · Eco
  const openBtn = h('button.mini-btn.open', { type: 'button', 'data-testid': 'mini-open' }, icon(ICON.open, 18),
    h('span', { text: 'Open Worship Rig' }));
  const recBtn = h('button.mini-btn.rec', { type: 'button', 'aria-pressed': 'false', title: 'Record to WAV',
    'data-testid': 'mini-rec' }, h('i.rec-dot', { 'aria-hidden': 'true' }), h('span.rec-t', { text: 'Rec' }));
  const ecoBtn = h('button.mini-btn.eco', { type: 'button', role: 'switch', 'aria-checked': 'false',
    'aria-label': 'Low-resource mode',
    title: 'Low-resource mode: only the current song kept loaded, no meters. Sound is unchanged.',
    'data-testid': 'mini-lowres' }, h('i.eco-sw', { 'aria-hidden': 'true' }), h('span', { text: 'Eco' }));
  listen(openBtn, 'click', () => send('openMain'));
  listen(recBtn, 'click', () => send('record', { on: !state?.recording }));
  listen(ecoBtn, 'click', () => send('lowResource', { on: !state?.lowResource }));

  // ---- status line
  const led = h('i.led', { 'aria-hidden': 'true' });
  const statusText = h('span.st-text', { 'data-testid': 'mini-status' });
  const statusEl = h('footer.mini-status', { role: 'status' }, led, statusText);

  const live = h('section.mini-live', {},
    header,
    modesWrap,
    fader,
    h('div.row.actions', {}, droneBtn, droneMore, fadeBtn, panicBtn),
    h('div.row.foot', {}, openBtn, recBtn, ecoBtn),
    statusEl,
  );
  el.replaceChildren(waiting, live);
  el.dataset.state = 'waiting';
  renderMaster();

  // ---- render
  function renderModes(s) {
    const modes = (Array.isArray(s.modes) ? s.modes : []).slice(0, MAX_MODES);
    const sig = modes.map((m) => `${m.id}\u0001${m.name}\u0001${m.key}`).join('\u0002');
    if (sig !== modesSig) {
      modesSig = sig;
      modeBtns = modes.map((m, i) => {
        const b = h('button.mini-btn.mode', { type: 'button', 'aria-pressed': 'false', 'data-id': m.id,
          'data-testid': `mini-mode-${i}`, title: `${m.name}${m.key ? ` · ${m.key}` : ''} (${i + 1})` },
        h('span.m-num', { text: String(i + 1), 'aria-hidden': 'true' }),
        h('span.m-name', { text: m.name || 'Untitled' }),
        h('span.m-key', { text: m.key || '' }));
        b.addEventListener('click', () => {
          b.classList.add('sent');
          send('selectMode', { id: m.id });
        });
        return b;
      });
      modesEl.replaceChildren(...modeBtns);
      modesEl.dataset.n = String(modes.length);
      modesEl.classList.toggle('two-col', modes.length >= 5);
      if (!modes.length) {
        const text = 'No modes yet — choose a set in Worship Rig › Settings › Menu bar.';
        modesEl.append(h('p.modes-empty', { text }));
      }
    }
    const curId = s.current?.id;
    let pos = -1;
    modeBtns.forEach((b, i) => {
      const on = b.dataset.id === curId;
      if (on) pos = i;
      b.classList.toggle('current', on);
      b.classList.remove('sent');
      setAttr(b, 'aria-pressed', on);
    });
    return { pos, n: modes.length };
  }

  function render(s) {
    const { pos, n } = renderModes(s);
    setText(curName, s.current?.name || 'No song');
    setText(curKey, s.current?.key ? `Key ${s.current.key}` : '');
    setText(curPos, pos >= 0 ? `${pos + 1} of ${n}` : n ? 'not in the set' : '');
    prevBtn.disabled = nextBtn.disabled = n < 2 && pos >= 0;
    // master: the main window is the source of truth; hold our own value while dragging and just after a send
    if (!drag && performance.now() - lastLocalAt > MASTER_ECHO_MS && Number.isFinite(s.master)) {
      masterPos = untaper(s.master);
      renderMaster();
    }
    const dOn = !!s.droneOn;
    droneBtn.classList.toggle('on', dOn);
    setAttr(droneBtn, 'aria-pressed', dOn);
    setText(droneBtn.querySelector('.pill-k'), s.droneKey || '');
    droneBtn.title = dOn ? `Drone on (${s.droneKey || '—'}) — click to stop` : 'Drone off — click to start';
    const dpc = keyToPc(s.droneKey);
    for (const b of keyBtns) {
      const on = Number(b.dataset.pc) === dpc;
      b.classList.toggle('on', on);
      setAttr(b, 'aria-pressed', on);
    }
    const rec = !!s.recording;
    recBtn.classList.toggle('on', rec);
    setAttr(recBtn, 'aria-pressed', rec);
    setText(recBtn.querySelector('.rec-t'), rec ? 'Stop' : 'Rec');
    const lr = !!s.lowResource;
    ecoBtn.classList.toggle('on', lr);
    setAttr(ecoBtn, 'aria-checked', lr);
    const st = statusLine(s);
    setText(statusText, st.text);
    led.className = `led ${st.led}`;
    statusEl.title = Number.isFinite(s.memoryMB) ? `${st.text} · ${Math.round(s.memoryMB)} MB` : st.text;
    el.classList.toggle('low-resource', lr);
  }

  let helloTimer = null;
  const offState = bus.onState((s) => {
    if (!s || typeof s !== 'object' || s.v !== 1) return;
    const first = !state;
    state = s;
    if (first) {
      el.dataset.state = 'live';
      clearInterval(helloTimer);
      helloTimer = null;
    }
    render(s);
  });
  if (typeof offState === 'function') cleanups.push(offState);

  // ---- keyboard: 1–6 select a mode; Esc closes the key sheet
  listen(document, 'keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape' && !droneSheet.hidden) {
      e.preventDefault();
      setSheet(false);
      return;
    }
    if (!state || !/^[1-6]$/.test(e.key)) return;
    const b = modeBtns[Number(e.key) - 1];
    if (!b) return;
    e.preventDefault();
    b.click();
  });

  // ---- hello until the first state
  send('hello');
  if (!state) {
    helloTimer = setInterval(() => {
      if (!state) send('hello');
    }, o.helloMs ?? HELLO_MS);
  }
  cleanups.push(() => clearInterval(helloTimer));
  cleanups.push(() => {
    clearTimeout(sendTimer);
    clearTimeout(hintTimer);
    holdStop();
  });

  return {
    get state() {
      return state;
    },
    sent,
    destroy() {
      for (const c of cleanups.splice(0)) c();
      el.replaceChildren();
    },
  };
}

// ------------------------------------------------------------------------------------------------ theme
/**
 * Follow the app's theme while the popover is open (mini-theme). The same switch as app/js/main.js applyTheme, minus
 * the mirror write (the popover is a follower; the main window owns settings.theme and the mirror): the new sheet is
 * loaded disabled (media="not all") at the end of <head>, its @font-face files are warmed (≤ 1.5 s), then ONE task
 * enables it, drops the old sheet and flips html/body[data-theme|data-mode] + color-scheme. So the card always shows
 * the old theme or the new one, never an unstyled frame. Siblings in one file (Daylight Stage ↔ Day) and Classic
 * only flip attributes. A newer switch cancels an older one.
 * @param {{doc?:Document, win?:Window}} [o]
 * @returns {{follow:(id:unknown) => Promise<string>|null, apply:(id:unknown) => Promise<string>,
 *   readonly current:string|null, readonly wanted:string|null, readonly pending:Promise<string>, destroy():void}}
 *   follow(id) is apply(id) unless id resolves to the theme already shown or on its way (then null).
 */
export function createThemeFollower(o = {}) {
  const doc = o.doc || document;
  const win = o.win || window;
  const root = doc.documentElement;
  let seq = 0;
  let current = root.dataset.theme || null; // what boot.js applied
  let wanted = current;
  let pending = Promise.resolve(current);
  const cleanups = [];

  const setAttrs = (a) => {
    root.dataset.theme = a.html.theme;
    root.dataset.mode = a.html.mode;
    root.style.colorScheme = a.colorScheme;
    if (doc.body) {
      doc.body.dataset.theme = a.body.theme;
      doc.body.dataset.mode = a.body.mode;
    }
  };
  async function run(tid, my) {
    const a = themeAttrs(tid);
    const cur = doc.getElementById('theme-css');
    const curHref = cur ? cur.getAttribute('href') : null;
    if (curHref === a.css || (!a.css && !cur)) {
      setAttrs(a); // same file (Daylight Stage ↔ Day) or Classic → Classic
      current = tid;
      return tid;
    }
    if (!a.css) {
      cur.remove();
      setAttrs(a);
      current = tid;
      return tid;
    }
    for (const n of doc.head.querySelectorAll('link[data-theme-next]')) n.remove(); // an overtaken switch
    const next = doc.createElement('link');
    next.rel = 'stylesheet';
    next.media = 'not all';
    next.dataset.themeNext = tid;
    const loaded = new Promise((res) => {
      next.addEventListener('load', () => res(true), { once: true });
      next.addEventListener('error', () => res(false), { once: true });
    });
    next.href = a.css;
    doc.head.append(next);
    const ok = await loaded;
    // themes-final T1/T2: full-descriptor copies, deleted once the sheet's own faces are loaded (themeFonts.js)
    const faces = ok ? await warmThemeFonts(next.sheet, doc) : [];
    if (my !== seq || !ok) {
      next.remove();
      await releaseWarmedFonts(faces, doc);
      if (!ok) {
        console.warn('[mini] theme stylesheet failed to load:', a.css);
        if (my === seq) wanted = current; // let a later event retry
      }
      return current;
    }
    next.removeAttribute('media');
    delete next.dataset.themeNext;
    doc.getElementById('theme-css')?.remove();
    next.id = 'theme-css';
    setAttrs(a);
    current = tid;
    await releaseWarmedFonts(faces, doc);
    return tid;
  }
  const apply = (id) => {
    const tid = resolveThemeId(id);
    wanted = tid;
    pending = run(tid, ++seq);
    return pending;
  };
  const follow = (id) => (resolveThemeId(id) === wanted ? null : apply(id));
  const readMirror = () => {
    try {
      return win.localStorage.getItem(THEME_MIRROR_KEY);
    } catch {
      return null; // storage blocked: keep what boot showed
    }
  };
  const on = (t, type, fn) => {
    t.addEventListener(type, fn);
    cleanups.push(() => t.removeEventListener(type, fn));
  };
  // the main window writes the mirror first thing in its applyTheme, so this fires as the switch starts there;
  // `key === null` is localStorage.clear()
  on(win, 'storage', (e) => {
    if (e.key === THEME_MIRROR_KEY || e.key === null) {
      const v = e.key === null ? null : e.newValue;
      if (v !== null) follow(v);
    }
  });
  // belt and braces for a popover that was hidden when the event fired: re-read on show/focus (cheap, no reflow)
  const recheck = () => {
    const v = readMirror();
    if (v !== null) follow(v);
  };
  on(doc, 'visibilitychange', () => doc.visibilityState === 'visible' && recheck());
  on(win, 'focus', recheck);
  return {
    follow,
    apply,
    get current() {
      return current;
    },
    get wanted() {
      return wanted;
    },
    get pending() {
      return pending;
    },
    destroy() {
      for (const c of cleanups.splice(0)) c();
    },
  };
}

// ------------------------------------------------------------------------------------------------ transport
const host = typeof document !== 'undefined' ? document.getElementById('mini') : null;
if (host) {
  // hello:false — mountMini sends its own hello now and every 2 s until the first state (the bus sends only one)
  const bus = createBus({ role: 'mini', hello: false });
  const theme = createThemeFollower();
  // state.theme is optional (bus contract v1, mini-theme): present and different → follow it before rendering
  const onState = (cb) => bus.subscribe((s) => {
    if (typeof s.theme === 'string') theme.follow(s.theme);
    cb(s);
  });
  const view = mountMini(host, {
    bus: { send: (cmd) => bus.command(cmd), onState, close: () => bus.close() },
  });
  globalThis.__mini = Object.assign(view, { bus, theme }); // test / debugging handle (not an API)
}
