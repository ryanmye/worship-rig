// UI v6 left panel (D16–D22; native/docs/lanes/UI6-build-plan.md U4; mockup perform-v6.html "Mac · 5 instruments",
// "Left · Quick open", mock_v6.py wheel()): one narrow column (84 px, 64 px below 1100 px) beside the strips.
//   Quick   opens today's Quick sheet (components/quickSheet.js, the same instance as the top bar's Quick button) as a
//           panel beside this button, over the strips, so nothing reflows while playing (perform.js openQuick).
//   Wheel   today's wheel column (components/readouts.js wheelStrip, as views/perform.js mounts it): the mod-wheel
//           position (relative drag), what it drives, Expr / Vol while those have been seen, ◢ Swell, the pedal lamp
//           ("Pedal held" after 20 s) and the pitch-bend → drone lamp while the song bends the drone.
// Same reads / writes as today's Perform: the wheel → controller.perform.wheel(v), Swell → controller.swell(); the
// values come from engine.wheelValues() and the controller's 'wheel' / 'action' / 'song' events, the bend from MIDI
// 'bend', the pedal from the shell's 150 ms runtime tick (perform.js readRuntime; no second timer). Lock: all of it
// stays live (perform.js LOCK: 'wheel', 'Swell', 'top bar: … Quick').
import { h, disposer, rafCoalesce, blurAfterPointer } from '../components/util.js';
import { wheelStrip } from '../components/readouts.js';
import { wheelTargetLabel } from '../perform.js';

/** perform.js PEDAL_STUCK_MS: after this long down, the lamp says "Pedal held" (a pedal that never came up). */
export const PEDAL_STUCK_MS = 20000;

/** The top bar's Quick icon (index.html #btn-quick), so both buttons read as the same thing. */
function quickIcon() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none',
    stroke: 'currentColor', 'stroke-width': '1.9', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true', class: 'ic' })) s.setAttribute(k, String(v));
  s.innerHTML = '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/>'
    + '<circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>';
  return s;
}

/**
 * What the wheel drives, in D15's words: an instrument level is named by the instrument ("Warm Pad level"), never
 * Keys / Pad / Extra / Bass; the other targets keep today's labels (perform.js wheelTargetLabel).
 * @param {object|null} song
 * @param {{name(ref:object|null):string}} names
 * @returns {string}
 */
export function v6WheelTarget(song, names) {
  if (!song) return '';
  const t = song.patch.modWheel?.target;
  const m = /^slots\.(\d+)\.gain$/.exec(t || '');
  if (!m) return wheelTargetLabel(t);
  const slot = song.patch.slots[Number(m[1])];
  return slot ? `${names.name(slot.instrument)} level` : `Instrument ${Number(m[1]) + 1} level`;
}

/**
 * @param {object} v  the v6 shell's view context (store, controller, engine, ctx.midi)
 * @param {{onQuick:(btn:HTMLElement) => void}} o
 * @returns {{el:HTMLElement, quickBtn:HTMLElement, wheel:object, render(x:{song:object|null, names:object}):void,
 *            renderWheel(w:object):void, setPedal(down:boolean):void, setQuickOpen(open:boolean):void,
 *            destroy():void}}
 */
export function leftPanel(v, o = {}) {
  const { controller, engine } = v;
  const midi = v.ctx?.midi || null;
  const d = disposer();

  const quickBtn = h('button.btn.v6-quick', {
    type: 'button', 'data-testid': 'v6-quick', 'aria-haspopup': 'true', 'aria-expanded': 'false',
    title: 'Quick settings: tempo, swell time, touch, pedal, restart audio',
  }, quickIcon(), h('span', { text: 'Quick' }));
  blurAfterPointer(quickBtn, d);
  d.listen(quickBtn, 'click', () => o.onQuick?.(quickBtn));

  const wheel = wheelStrip({
    label: 'Wheel',
    relative: true,
    onSwell: () => controller.swell(),
    onWheel: (x) => controller.perform.wheel(x),
  });
  d.add(() => wheel.destroy());
  wheel.el.dataset.testid = 'v6-wheel';
  const el = h('aside.v6-left', { 'data-testid': 'v6-left', 'aria-label': 'Quick and wheel' },
    quickBtn, h('section.panel.v6-wheel', {}, wheel.el));

  // ---- the wheel's values (perform.js renderWheel): engine.wheelValues(), Expr / Vol once each has been seen
  const seen = { expr: false, vol: false };
  const wheelNow = () => {
    try {
      return engine?.wheelValues?.() || { mod: 1, expr: 1, vol: 1 };
    } catch {
      return { mod: 1, expr: 1, vol: 1 };
    }
  };
  const renderWheel = (w = wheelNow()) => {
    wheel.set({ value: w.mod, swelling: !!w.swelling, expr: seen.expr ? w.expr : null,
      vol: seen.vol ? w.vol : null });
  };
  const raf = rafCoalesce(() => renderWheel());
  d.add(() => raf.cancel());

  // performance #3a (perform.js): this runs per MIDI CC; the pickup ghost is touched only while it shows or changes
  let pickupShown = false;
  d.listen(controller, 'wheel', (e) => {
    const det = e.detail || {};
    if (det.source === 'mod' || det.source === 'virtual') {
      if (det.pickup) {
        pickupShown = true;
        wheel.set({ pickup: true, hardware: det.hardware });
      } else if (pickupShown) {
        pickupShown = false;
        wheel.set({ pickup: false });
      }
    }
    if (det.source === 'expr') seen.expr = true;
    if (det.source === 'vol') seen.vol = true;
    raf.push();
  });
  let bendValue = 0;
  d.listen(controller, 'action', (e) => {
    const t = e.detail?.type;
    if (t === 'swell') raf.push();
    if (t === 'panic') {
      bendValue = 0;
      wheel.set({ bend: 0 });
      raf.push();
    }
  });
  d.listen(controller, 'song', () => raf.push());
  if (midi) {
    d.listen(midi, 'bend', (e) => {
      const x = Number(e.detail?.value) || 0;
      if (Math.abs(x - bendValue) < 0.02 && x !== 0) return;
      bendValue = x;
      wheel.set({ bend: x });
    });
  }

  // ---- the pedal lamp: set by the shell's runtime tick (and at once on CC64)
  let pedalDown = null;
  let pedalSince = 0;
  let shownTarget = null;
  renderWheel();

  return {
    el,
    quickBtn,
    wheel,
    /** The song's wheel target and bend mode (the shell's render). */
    render({ song, names }) {
      const target = v6WheelTarget(song, names);
      if (target !== shownTarget) {
        shownTarget = target;
        wheel.set({ target });
      }
      wheel.set({ bendMode: song?.patch.bend?.mode });
      renderWheel();
    },
    renderWheel,
    setPedal(down) {
      const t = performance.now();
      if (down !== pedalDown) {
        pedalDown = !!down;
        pedalSince = t;
      }
      wheel.set({ pedal: pedalDown, pedalStuck: pedalDown && t - pedalSince > PEDAL_STUCK_MS });
    },
    setQuickOpen(open) {
      quickBtn.classList.toggle('on', !!open);
      quickBtn.setAttribute('aria-expanded', String(!!open));
    },
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}
