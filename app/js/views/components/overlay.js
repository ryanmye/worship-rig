// Perform overlays (step panels, the header "…" menu, the Quick sheet): one place for Esc and outside taps.
// - Esc closes the top overlay and is preventDefault()ed, so main.js's Esc = Panic never fires for it. With nothing
//   open, Esc behaves as today (OPTIONS.md round-3 fix 4 / #10: "Esc closes an overlay without panicking, Esc with
//   nothing open panics, ⌘. always panics"). The listener is a window capture listener, so it runs before main.js's
//   document listener even when the overlay was opened with the mouse and nothing is focused.
// - An outside pointer-down closes it. With `swallow`, that tap is also swallowed (H concept §2: "an outside click is
//   swallowed") unless the target matches `passThrough`: PANIC, Fade out, ON tiles and Prev/Next always work
//   (round-3 fix 4). Perform marks those with `data-overlay-pass`.

export const PASS_THROUGH = '.ontile, [data-overlay-pass], .btn-panic, .btn-fade';

const stack = []; // [{el, anchors, close, swallow, passThrough, group}]
let swallowClickUntil = 0;
let listening = false;

const inside = (entry, node) =>
  node instanceof Node && (entry.el.contains(node) || entry.anchors.some((a) => a && a.contains(node)));

function onKey(e) {
  if (e.key !== 'Escape' || !stack.length || e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  e.stopPropagation();
  stack[stack.length - 1].close('escape');
}
function onPointerDown(e) {
  if (!stack.length) return;
  const top = stack[stack.length - 1];
  if (!top.outside || inside(top, e.target)) return;
  const pass = e.target instanceof Element && e.target.closest(top.passThrough);
  top.close('outside');
  if (top.swallow && !pass) {
    e.preventDefault();
    e.stopPropagation();
    swallowClickUntil = performance.now() + 1000;
  }
}
function onClick(e) {
  if (performance.now() < swallowClickUntil) {
    swallowClickUntil = 0;
    e.preventDefault();
    e.stopPropagation();
  }
}
let clickHooked = false;
function listen(on) {
  // the click swallow outlives the overlay (the tap that closed it clicks after the close), so it stays installed
  if (!clickHooked) {
    clickHooked = true;
    window.addEventListener('click', onClick, true);
  }
  if (on === listening) return;
  listening = on;
  const f = on ? 'addEventListener' : 'removeEventListener';
  window[f]('keydown', onKey, true);
  window[f]('pointerdown', onPointerDown, true);
}

/**
 * Register an open overlay. Returns `close(reason)`; calling it twice is harmless.
 * @param {object} o
 * @param {HTMLElement} o.el
 * @param {HTMLElement[]} [o.anchors]   taps on these count as inside (the chip that opened the panel)
 * @param {(reason:'escape'|'outside'|'replaced'|'api') => void} [o.onClose]
 * @param {boolean} [o.swallow=false]
 * @param {boolean} [o.closeOnOutside=true]  false: only Esc / the caller closes it (the Quick sheet: keep playing)
 * @param {string} [o.passThrough=PASS_THROUGH]
 * @param {string} [o.group]            opening an overlay closes the open ones of the same group
 * @returns {(reason?:string) => void}
 */
export function openOverlay(o) {
  if (o.group) for (const e of stack.slice()) if (e.group === o.group) e.close('replaced');
  const entry = {
    el: o.el,
    anchors: o.anchors || [],
    swallow: !!o.swallow,
    outside: o.closeOnOutside !== false,
    passThrough: o.passThrough || PASS_THROUGH,
    group: o.group || null,
    closed: false,
    close(reason = 'api') {
      if (entry.closed) return;
      entry.closed = true;
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      if (!stack.length) listen(false);
      if (typeof o.onClose === 'function') o.onClose(reason);
    },
  };
  stack.push(entry);
  listen(true);
  return entry.close;
}

/** Number of open overlays (tests). */
export const openOverlayCount = () => stack.length;
