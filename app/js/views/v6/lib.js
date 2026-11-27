// UI v6 shared helpers (D22, native/docs/lanes/UI6-build-plan.md U1): position colours, icons, instrument names and
// small popover plumbing used by every v6 module. Pure view code: no store writes, no engine calls.
import { h, disposer, blurAfterPointer } from '../components/util.js';
import { openOverlay } from '../components/overlay.js';
import { stageName } from '../components/instrument-groups.js';

export const MINUS = '−';
/** Press-and-hold time for the guarded controls (Revert, PANIC, Lock, Remove; locked key / transpose). */
export const HOLD_MS = 600;
/** Strips the row shows side by side before it scrolls (D16: "more than 5 instruments scroll sideways"). */
export const STRIPS_ACROSS = 5;
/** Per-device fold state of the snapshots row (D16, "The snapshots row folds"). */
export const SNAPS_FOLD_KEY = 'worship-rig.v6.snapshots';

/** "+2", "−3", "0". */
export const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `${MINUS}${-n}` : '0');
const humanize = (id) => String(id || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Colour of the instrument at position `i` (D15: by position, never by kind of sound). The first four are the theme's
 * --slot-0..3; positions 4..6 are the mockup's POS_COL (mock_v6.py), as --v6-pos-4..6 in styles-v6.css so a theme
 * can override them; the seven then repeat.
 * @param {number} i
 * @returns {string} a CSS colour
 */
export function slotColor(i) {
  const k = ((Number(i) || 0) % 7 + 7) % 7;
  return k < 4 ? `var(--slot-${k})` : `var(--v6-pos-${k})`;
}

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  note: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 11h7M9 15h7M9 7h4"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  room: '<path d="M3.5 20V11a8.5 8.5 0 0 1 17 0v9"/><path d="M8 20v-8a4 4 0 0 1 8 0v8"/><path d="M2 20h20"/>',
};
/**
 * Inline stroke icon (static markup from the table above, never user data).
 * @param {string} name
 * @param {number} [size]
 * @returns {SVGElement}
 */
export function icon(name, size = 18) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const attrs = {
    class: `ic ic-${name}`, width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.9', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
  };
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, String(v));
  s.innerHTML = ICONS[name] || '';
  return s;
}

/**
 * Instrument display names from the engine's registry (the same source perform.js reads), refreshed on demand.
 * @param {object} engine
 * @returns {{refresh():boolean, name(ref:object|null):string, full(ref:object|null):string}}
 *   refresh() returns true when a name changed
 */
export function instrumentNames(engine) {
  let names = new Map();
  let sig = '';
  const key = (ref) => `${ref.type}:${ref.id}`;
  const api = {
    refresh() {
      try {
        const list = engine?.listInstruments?.() || [];
        names = new Map(list.map((x) => [key(x.ref), x.name]));
      } catch {
        names = new Map();
      }
      const next = [...names].join('\u0001');
      const changed = next !== sig;
      sig = next;
      return changed;
    },
    name: (ref) => (ref ? stageName(names.get(key(ref)) || humanize(ref.id), ref) : '—'),
    full: (ref) => (ref ? names.get(key(ref)) || api.name(ref) : ''),
  };
  api.refresh();
  return api;
}

/** A plain button that lets go of focus after a pointer click (Space stays the sustain pedal; SPEC §10). */
export function button(d, cls, content, attrs = {}) {
  const b = h(`button.btn${cls}`, { type: 'button', ...attrs }, content);
  blurAfterPointer(b, d);
  return b;
}

/**
 * A small popover under an anchor, closed by Esc / an outside tap (overlay.js), owning its own listeners.
 * @param {object} o
 * @param {HTMLElement} o.host      positioned ancestor the popover is appended to
 * @param {HTMLElement} o.anchor    the button that opened it (taps on it count as inside)
 * @param {string} o.label          accessible name
 * @param {string} [o.className]
 * @param {string} [o.testid]
 * @param {'start'|'end'} [o.align]  which anchor edge the popover lines up with
 * @param {HTMLElement} [o.beside]  open beside this element instead (a strip's ⋯ menu)
 * @param {(body:HTMLElement, pd:ReturnType<typeof disposer>, close:() => void) => (() => void)|void} o.build
 *   fills the body; may return a render() the caller can run while it is open
 * @param {() => void} [o.onClose]
 * @returns {{el:HTMLElement, close():void, render():void}}
 */
export function popover(o) {
  const pd = disposer();
  const el = h(`div.v6-pop${o.className ? `.${o.className}` : ''}`, {
    role: 'dialog', 'aria-label': o.label, 'data-testid': o.testid, 'data-perform-overlay': '',
  });
  let closeFn = null;
  const close = () => closeFn?.('api');
  const render = o.build(el, pd, close) || (() => {});
  o.host.append(el);
  const ar = o.anchor.getBoundingClientRect();
  const hr = o.host.getBoundingClientRect();
  if (o.beside) {
    // beside a strip (mockup .pop), on the side with room; the host is outside the strips' scroller, so nothing
    // clips it
    const br = o.beside.getBoundingClientRect();
    const w = el.offsetWidth || 280;
    const right = br.right + 10 + w <= hr.right;
    el.style.left = `${Math.round(right ? br.right - hr.left + 10 : Math.max(8, br.left - hr.left - 10 - w))}px`;
    el.style.top = `${Math.round(Math.max(8, Math.min(br.top - hr.top + 110, hr.height - el.offsetHeight - 8)))}px`;
  } else {
    el.style.top = `${Math.round(ar.bottom - hr.top + 8)}px`;
    if (o.align === 'end') el.style.right = `${Math.max(8, Math.round(hr.right - ar.right))}px`;
    else {
      // U8a: kept inside the host on the right too (the song bar's ⋯ sits at the right of its first row at iPad
      // portrait; its 280 px menu ran 21 px off the screen)
      const w = el.offsetWidth || 0;
      el.style.left = `${Math.max(8, Math.min(Math.round(ar.left - hr.left), Math.round(hr.width - w - 8)))}px`;
    }
  }
  o.anchor.setAttribute('aria-expanded', 'true');
  o.anchor.classList.add('open');
  closeFn = openOverlay({
    el,
    anchors: [o.anchor],
    group: 'v6-pop',
    // polish batch 2 (UI6-polish1 O1, U7c F3): Settings can open over it (⌘,): the Esc that closes Settings is
    // Settings' alone
    underModal: true,
    onClose: () => {
      pd.dispose();
      el.remove();
      o.anchor.setAttribute('aria-expanded', 'false');
      o.anchor.classList.remove('open');
      closeFn = null;
      o.onClose?.();
    },
  });
  return { el, close, render };
}
