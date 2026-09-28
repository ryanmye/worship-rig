// stepChip(): a strip modifier chip (H-v2 concept §1.2 "Chip in use"): Space · Echo · Octave · Sustain.
// At rest = grey outline; in use = a 20 % tint of the slot colour + coloured outline + amount bar (quieter than the
// ON tile). A white inline dot marks "changed since the song was loaded" (setChanged / `loaded`).
// Two steps (Sustain on/off) or `cycle:true`: a tap moves to the next step. More steps: a tap opens stepPanel()
// inside the strip; tap a step = done; Esc or an outside tap closes it (overlay.js).
import { h, setText, disposer, blurAfterPointer } from './util.js';
import { stepPanel, sameStep } from './stepPanel.js';
import { openOverlay } from './overlay.js';

/**
 * Strip chip.
 * @param {object} o
 * @param {string} o.label                         'Space', 'Echo', 'Octave', 'Sustain'
 * @param {Array<{value:any,label:string}>} o.steps  display order (top of the panel first)
 * @param {any} [o.value]
 * @param {(v:any) => void} [o.onChange]
 * @param {string} [o.color]                       --c (the slot colour)
 * @param {string} [o.owner]                       'KEYS' (panel header, accessible name)
 * @param {any} [o.loaded]                         value as loaded → changed dot + "as loaded" step
 * @param {boolean} [o.cycle]                      tap cycles instead of opening a panel (default: steps.length === 2)
 * @param {(v:any) => string} [o.format]           chip value text; default: the matching step label
 * @param {(v:any) => boolean} [o.lit]             "in use" (tinted); default: truthy and not 0
 * @param {(v:any) => number|null} [o.amount]      0..1 → amount bar under the chip (Space/Echo)
 * @param {string} [o.hint]                        panel line under the title
 * @param {string} [o.footnote]                    panel footnote
 * @param {{min:number,max:number,format?:(v:number)=>string}} [o.fine]  fine slider in the panel
 * @param {HTMLElement|(() => HTMLElement)} [o.mount]  where the panel goes (default: closest .strip, else the parent)
 * @param {'up'|'auto'} [o.placement]  'up' (default, Perform's strip): the panel fills the host above the chip.
 *        'auto' (polish-1, hv2-edit-effects request): 'down' (below the chip) when the host has `placementNeed` px
 *        + 10 below it, else 'up' when it has that above, else 'cover' (the whole host). The panel carries
 *        data-dir = up | down | cover.
 * @param {number|(() => number)} [o.placementNeed]  panel height 'auto' needs (default 290; 220 at ≤ 1250 px)
 * @param {string} [o.title]
 * @param {string} [o.className]
 * @returns {{el:HTMLButtonElement, set(v:any):void, get():any, setLoaded(v:any):void, setChanged(b:boolean|null):void,
 *            setHint(s:string):void, setDisabled(b:boolean):void, open(opts?:{focus?:boolean}):void, close():void,
 *            cancelDrag():void, readonly isOpen:boolean, destroy():void}}
 */
/**
 * Where an 'auto' step panel goes (polish-1): 'down' when the host has room below the chip, else 'up' when it has
 * room above, else 'cover'.
 * @param {{top:number, bottom:number}} hr host rect
 * @param {{top:number, bottom:number}} cr chip rect
 * @param {number|(() => number)} [need] panel height needed (default 290; 220 at ≤ 1250 px)
 * @returns {'down'|'up'|'cover'}
 */
export function placementDir(hr, cr, need) {
  let n = typeof need === 'function' ? need() : need;
  if (!Number.isFinite(n)) n = globalThis.matchMedia?.('(max-width: 1250px)').matches ? 220 : 290;
  if (hr.bottom - cr.bottom >= n + 10) return 'down';
  if (cr.top - hr.top >= n + 10) return 'up';
  return 'cover';
}

export function stepChip(o = {}) {
  const d = disposer();
  const steps = Array.isArray(o.steps) ? o.steps : [];
  const cycle = o.cycle ?? steps.length === 2;
  let value = o.value;
  let loaded = o.loaded;
  let changedOverride = null; // setChanged(b) wins over the `loaded` comparison until setChanged(null)
  let hintText = o.hint || '';
  const stepOf = (v) => steps.find((s) => sameStep(s.value, v));
  const format = o.format || ((v) => stepOf(v)?.label ?? String(v));
  const lit = o.lit || ((v) => !!v && v !== 0);

  const dot = h('em.cdi', { title: 'Changed since the song was loaded', hidden: true });
  const name = h('span.mc-label', { text: o.label || '' });
  const val = h('b.mc-value');
  const bar = h('i.mc-bar', { 'aria-hidden': 'true', hidden: true });
  const led = h('em.mc-led', { 'aria-hidden': 'true' });
  const el = cycle
    ? h(
        'button.mchip.cycle',
        { type: 'button', title: o.title, 'data-testid': o.testid },
        led,
        h('span.mc-label', {}, dot, val),
      )
    : h(
        'button.mchip',
        { type: 'button', title: o.title, 'aria-haspopup': 'true', 'aria-expanded': 'false', 'data-testid': o.testid },
        name,
        h('b.mc-value-wrap', {}, dot, val),
        bar,
      );
  if (o.color) el.style.setProperty('--c', o.color);
  if (o.className) el.classList.add(...String(o.className).split(/\s+/).filter(Boolean));

  let panel = null;
  let closeOverlay = null;
  let focusBack = false;

  const isChanged = () =>
    changedOverride !== null ? changedOverride : loaded !== undefined && !sameStep(value, loaded);
  const render = () => {
    const on = !!lit(value);
    const text = format(value);
    el.classList.toggle('on', on);
    setText(val, text);
    dot.hidden = !isChanged();
    const a = typeof o.amount === 'function' ? o.amount(value) : null;
    if (!cycle) {
      bar.hidden = !(a > 0);
      if (a > 0) bar.style.width = `${Math.round(Math.min(1, a) * 100)}%`;
    }
    const owner = o.owner ? `${o.owner} ` : '';
    if (cycle) {
      el.setAttribute('aria-pressed', String(on));
      el.setAttribute('aria-label', `${owner}${o.label || text}${isChanged() ? ' (changed)' : ''}`);
    } else {
      el.setAttribute('aria-label', `${owner}${o.label}: ${text}${isChanged() ? ' (changed)' : ''}`);
    }
    panel?.set(value);
  };

  const emit = (v) => {
    value = v;
    render();
    if (typeof o.onChange === 'function') o.onChange(v);
  };
  const close = () => {
    closeOverlay?.('api');
  };
  const open = ({ focus = false } = {}) => {
    if (cycle || panel || el.disabled) return;
    const host = (typeof o.mount === 'function' ? o.mount() : o.mount) || el.closest('.strip') || el.parentElement;
    if (!host) return;
    panel = stepPanel({
      title: o.label,
      owner: o.owner,
      hint: hintText,
      steps,
      value,
      loaded,
      color: o.color,
      footnote: o.footnote,
      fine: o.fine,
      onPick: (v, how) => {
        if (how?.keyboard) focusBack = true;
        if (!sameStep(v, value)) emit(v);
        close();
      },
      onFine: (v) => emit(v),
      onClose: (how) => {
        if (how?.keyboard) focusBack = true;
        close();
      },
    });
    // place it above the chip, inside the host, its arrow pointing at the chip (mockup .amt, --ax); 'auto' may put it
    // below the chip or over the whole host instead (placementDir)
    const hr = host.getBoundingClientRect();
    const cr = el.getBoundingClientRect();
    const dir = o.placement === 'auto' ? placementDir(hr, cr, o.placementNeed) : 'up';
    panel.el.dataset.dir = dir;
    if (hr.width > 0) {
      panel.el.style.setProperty('--ax', `${(((cr.left + cr.width / 2 - hr.left) / hr.width) * 100).toFixed(1)}%`);
      panel.el.style.setProperty('--sp-bottom', `${Math.max(0, hr.bottom - cr.top + 10).toFixed(0)}px`);
      panel.el.style.setProperty('--sp-top', `${Math.max(0, cr.bottom - hr.top + 10).toFixed(0)}px`);
    }
    host.append(panel.el);
    el.classList.add('open');
    el.setAttribute('aria-expanded', 'true');
    focusBack = focus;
    closeOverlay = openOverlay({
      el: panel.el,
      anchors: [el],
      swallow: true,
      group: 'step-panel',
      onClose: (reason) => {
        // focus returns to the chip only after keyboard use; after a tap nothing stays focused (Space = sustain)
        const hadFocus = focusBack || (reason === 'escape' && panel && panel.el.contains(document.activeElement));
        panel?.destroy();
        panel = null;
        closeOverlay = null;
        el.classList.remove('open');
        el.setAttribute('aria-expanded', 'false');
        if (hadFocus && reason !== 'outside' && reason !== 'replaced') el.focus();
      },
    });
    if (focus) panel.focusCurrent();
  };

  d.listen(el, 'click', (e) => {
    if (cycle) {
      const i = steps.findIndex((s) => sameStep(s.value, value));
      if (steps.length) emit(steps[(i + 1) % steps.length].value);
      return;
    }
    if (panel) close();
    else open({ focus: e.detail === 0 }); // keyboard (detail 0) moves focus into the panel; a tap does not
  });
  // arrows on a focused chip step through the values without opening the panel (never reach song nav / wheel)
  d.listen(el, 'keydown', (e) => {
    if (cycle || !steps.length) return;
    const dir =
      e.key === 'ArrowUp' || e.key === 'ArrowRight' ? -1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? 1 : 0;
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    const i = steps.findIndex((s) => sameStep(s.value, value));
    const j = i < 0 ? offStepTarget(dir) : Math.min(steps.length - 1, Math.max(0, i + dir));
    if (j >= 0 && j !== i) emit(steps[j].value);
  });
  /**
   * An arrow from a value between steps (a fine-slider 30 %) goes to the nearest step in the arrow's direction
   * (↑ → 50 %, ↓ → 25 %), not to an end of the list (hv2-edit-slot request). Non-numeric off-step values keep the
   * old rule (first / last step). @returns {number} step index, or -1 when nothing lies that way
   */
  function offStepTarget(dir) {
    const nums = steps.every((s) => typeof s.value === 'number') && typeof value === 'number' && Number.isFinite(value);
    if (!nums || steps.length < 2) return dir > 0 ? 0 : steps.length - 1;
    // index order ↔ value order: +1 in index moves the value up when the list ascends, down when it descends
    const up = (steps[steps.length - 1].value > steps[0].value ? 1 : -1) * dir > 0;
    let best = -1;
    steps.forEach((s, k) => {
      const beyond = up ? s.value > value : s.value < value;
      if (beyond && (best < 0 || Math.abs(s.value - value) < Math.abs(steps[best].value - value))) best = k;
    });
    return best;
  }
  blurAfterPointer(el, d);
  d.add(() => close());
  render();

  return {
    el,
    set(v) {
      value = v;
      render();
    },
    get: () => value,
    setLoaded(v) {
      loaded = v;
      panel?.setLoaded(v);
      render();
    },
    setChanged(b) {
      changedOverride = b === null || b === undefined ? null : !!b;
      render();
    },
    setHint(s) {
      hintText = s || '';
      panel?.setHint(hintText);
    },
    setDisabled(b) {
      el.disabled = !!b;
      if (b) close();
    },
    open,
    close,
    /**
     * Abandon the panel's fine-slider drag and close the panel (round3-edit M2): the edit binder calls this on every
     * tracked component before a song switch, so no panel writes into the next song.
     */
    cancelDrag() {
      panel?.cancelDrag?.();
      close();
    },
    get isOpen() {
      return !!panel;
    },
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}

/** Step lists used by Perform's strip chips (display order: top of the panel first). */
export const AMOUNT_STEPS = Object.freeze(
  [1, 0.75, 0.5, 0.25, 0].map((v) => Object.freeze({ value: v, label: v ? `${v * 100}%` : 'Off' })),
);
export const OCTAVE_STEPS = Object.freeze(
  [2, 1, 0, -1, -2].map((v) =>
    Object.freeze({
      value: v,
      label: v === 0 ? 'Normal' : `${v > 0 ? '+' : '−'}${Math.abs(v)} oct`,
    }),
  ),
);
export const SUSTAIN_STEPS = Object.freeze([
  Object.freeze({ value: true, label: 'Sustain' }),
  Object.freeze({ value: false, label: 'Sustain off' }),
]);
/** Chip text for a 0..1 send ("25%", "off"). */
export const formatAmount = (v) => (Number(v) > 0.0005 ? `${Math.round(Number(v) * 100)}%` : 'off');
/** Chip text for an octave ("+1", "−2", "normal"). */
export const formatOctave = (v) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : 'normal');
