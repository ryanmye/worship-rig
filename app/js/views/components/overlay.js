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

/**
 * An overlay that can't be seen (its element left the DOM, or sits inside a `[hidden]` ancestor such as the view a
 * ⌘E / Ctrl+E switch just hid) must never eat an Esc (= Panic) or a tap (round3-edit M1). Close every such entry
 * (reason 'hidden') before acting on the top one. Returns the visible top entry, if any.
 */
const unseen = (entry) => !entry.el || !entry.el.isConnected || !!entry.el.closest('[hidden]');
function pruneHidden() {
  for (const entry of stack.slice()) if (unseen(entry)) entry.close('hidden');
  return stack[stack.length - 1] || null;
}
function onKey(e) {
  if (e.key !== 'Escape' || !stack.length || e.metaKey || e.ctrlKey || e.altKey) return;
  const top = pruneHidden();
  if (!top) return;
  e.preventDefault();
  e.stopPropagation();
  top.close('escape');
}
function onPointerDown(e) {
  if (!stack.length) return;
  const top = pruneHidden();
  if (!top || !top.outside || inside(top, e.target)) return;
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
 * @param {(reason:'escape'|'outside'|'replaced'|'api'|'hidden') => void} [o.onClose]
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

/** Close every open overlay whose element sits inside `root` (a view being hidden). Returns how many closed. */
export function closeOverlaysWithin(root, reason = 'hidden') {
  if (!root) return 0;
  let n = 0;
  for (const entry of stack.slice()) {
    if (entry.el && (root === entry.el || root.contains(entry.el))) {
      entry.close(reason);
      n++;
    }
  }
  return n;
}
