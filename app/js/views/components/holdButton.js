// holdButton(): press-and-hold with a progress ring and a rising fill (H-v2 implementation §1, lifted from the Perform
// Lock hold, perform.js "lock (hold to unlock)"). Used by Lock/unlock, Revert (always hold, OPTIONS.md round-3 fix 2),
// and the locked key controls (concept §1.3), and by Quick › "Hold to restart audio".
//
// requireHold true: a press must be held `ms` to activate; letting go early activates nothing and shows the hint.
// requireHold false: a plain click activates (so Lock can lock with one press and need a hold to unlock).
// Keyboard: Enter / Space held = the same hold. round2-ui #5: the key that started a hold owns the button until it is
// released, so its auto-repeats after the hold completes never click (a held Enter used to re-lock ~0.6 s later).
import { h, setText, disposer } from './util.js';

/**
 * Press-and-hold button.
 * @param {object} o
 * @param {string|Node|Array<string|Node>} [o.content]  button content (default: o.label as text)
 * @param {string} [o.label]            text content and accessible name
 * @param {number} [o.ms=600]           hold time
 * @param {boolean|(() => boolean)} [o.requireHold=true]
 * @param {() => void} [o.onActivate]   after a completed hold, or a click when no hold is needed
 * @param {() => void} [o.onHoldStart]
 * @param {() => void} [o.onHoldCancel] released early (not called when the hold is abandoned by blur/cancel)
 * @param {string} [o.holdText]         caption while holding; default "keep holding… (0.6 s)"
 * @param {string} [o.hintText]         caption after a too-short press; default "press and hold (0.6 s)"
 * @param {string} [o.title]
 * @param {string} [o.ariaLabel]
 * @param {string} [o.className]
 * @returns {{el:HTMLButtonElement, readonly holding:boolean, readonly progress:number, setContent(c):void,
 *            setRequireHold(b:boolean|(()=>boolean)):void, setDisabled(b:boolean):void, refresh():void, cancel():void,
 *            destroy():void}}
 */
export function holdButton(o = {}) {
  const d = disposer();
  const ms = Number.isFinite(o.ms) && o.ms > 0 ? o.ms : 600;
  let requireHold = o.requireHold ?? true;
  const needsHold = () => (typeof requireHold === 'function' ? !!requireHold() : !!requireHold);
  const holdText = o.holdText || `keep holding… (${(ms / 1000).toFixed(1)} s)`;
  const hintText = o.hintText || `press and hold (${(ms / 1000).toFixed(1)} s)`;

  const fill = h('span.hb-fill', { 'aria-hidden': 'true' });
  const ring = h('span.hb-ring', { 'aria-hidden': 'true' });
  const body = h('span.hb-body');
  const cap = h('span.hb-cap', { role: 'status', 'aria-live': 'polite', hidden: true });
  const el = h(
    'button.hold-btn',
    { type: 'button', title: o.title, 'aria-label': o.ariaLabel, 'data-testid': o.testid },
    fill,
    ring,
    body,
    cap,
  );
  if (o.className) el.classList.add(...String(o.className).split(/\s+/).filter(Boolean));
  el.style.setProperty('--hold', '0');
  el.style.setProperty('--hold-ms', `${ms}ms`);

  const setContent = (c) => {
    const list = c === undefined || c === null ? [o.label ?? ''] : Array.isArray(c) ? c : [c];
    body.replaceChildren(...list.map((x) => (x instanceof Node ? x : document.createTextNode(String(x)))));
  };
  setContent(o.content);

  let timer = null;
  let raf = 0;
  let t0 = 0;
  let progress = 0;
  let suppressClickUntil = 0;
  let holdKey = null;
  let hintTimer = null;

  const renderRequire = () => {
    const req = needsHold();
    el.classList.toggle('needs-hold', req);
    el.dataset.hold = req ? String(ms) : '';
  };
  const setProgress = (p) => {
    progress = p;
    el.style.setProperty('--hold', p.toFixed(3));
  };
  const tick = () => {
    raf = 0;
    if (!timer) return;
    setProgress(Math.min(1, (performance.now() - t0) / ms));
    raf = requestAnimationFrame(tick);
  };
  const hint = () => {
    el.classList.add('hint');
    setText(cap, hintText);
    cap.hidden = false;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      el.classList.remove('hint');
      if (!timer) cap.hidden = true;
    }, 1600);
  };
  const stop = () => {
    clearTimeout(timer);
    timer = null;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    el.classList.remove('holding');
    el.removeAttribute('aria-busy');
    cap.hidden = true;
    setProgress(0);
  };
  const activate = () => {
    if (typeof o.onActivate === 'function') o.onActivate();
    renderRequire();
  };
  const startHold = () => {
    if (timer || el.disabled || !needsHold()) return;
    t0 = performance.now();
    clearTimeout(hintTimer);
    el.classList.remove('hint');
    el.classList.add('holding');
    el.setAttribute('aria-busy', 'true');
    setText(cap, holdText);
    cap.hidden = false;
    setProgress(0);
    timer = setTimeout(() => {
      stop();
      suppressClickUntil = performance.now() + 600; // the click that follows the pointerup is not a second press
      el.classList.add('done');
      setTimeout(() => el.classList.remove('done'), 300);
      activate();
    }, ms);
    raf = requestAnimationFrame(tick);
    if (typeof o.onHoldStart === 'function') o.onHoldStart();
  };
  const cancelHold = (early) => {
    if (!timer) return;
    stop();
    if (early) {
      hint();
      if (typeof o.onHoldCancel === 'function') o.onHoldCancel();
    }
  };

  d.listen(el, 'pointerdown', (e) => {
    if (el.disabled || !needsHold() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault(); // keep focus off the button (Space stays the sustain pedal)
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events */
    }
    startHold();
  });
  d.listen(el, 'pointerup', () => cancelHold(true));
  d.listen(el, 'pointercancel', () => cancelHold(false));
  d.listen(el, 'lostpointercapture', () => cancelHold(false));
  d.listen(el, 'keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (holdKey === e.key) {
      e.preventDefault(); // auto-repeat of the key that owns the button
      return;
    }
    if (needsHold()) {
      e.preventDefault();
      if (!e.repeat) {
        holdKey = e.key;
        startHold();
      }
    }
  });
  d.listen(el, 'keyup', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (timer || holdKey === e.key) e.preventDefault(); // Space would click on keyup
    if (holdKey === e.key) holdKey = null;
    cancelHold(true);
  });
  d.listen(el, 'blur', () => {
    holdKey = null;
    cancelHold(false);
  });
  d.listen(el, 'click', (e) => {
    if (e.detail > 0) queueMicrotask(() => el.blur());
    if (performance.now() < suppressClickUntil) return;
    if (!needsHold()) activate();
    else if (!timer) hint();
  });
  d.add(() => {
    stop();
    clearTimeout(hintTimer);
  });
  renderRequire();

  return {
    el,
    get holding() {
      return !!timer;
    },
    get progress() {
      return progress;
    },
    setContent,
    setRequireHold(b) {
      requireHold = b;
      if (!needsHold()) cancelHold(false);
      renderRequire();
    },
    setDisabled(b) {
      el.disabled = !!b;
      if (b) cancelHold(false);
    },
    /** Re-read a function-valued requireHold (e.g. after the lock state changed) for the `needs-hold` class. */
    refresh() {
      renderRequire();
    },
    cancel() {
      cancelHold(false);
    },
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}
