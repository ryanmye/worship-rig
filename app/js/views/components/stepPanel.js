// stepPanel(): the big-step popover a strip chip opens (H concept §2 / H-v2 perform-step.png). Five big steps
// (100/75/50/25/Off, or +2…−2), tap one = done; the step the song was loaded with is marked "as loaded"; an optional
// fine slider (the relative-drag fader) for in-between values; an optional footnote ("Starts on your next note").
// The panel is only the element + keyboard; stepChip() mounts it and owns open/close.
import { h, setText, disposer } from './util.js';
import { fader } from './fader.js';

const EPS = 0.005;
/** Step value equality: numbers within ½ % (sends are 0..1), everything else strict. */
export const sameStep = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= EPS : a === b);

/**
 * Step panel.
 * @param {object} o
 * @param {string} o.title                 'Space', 'Octave'
 * @param {string} [o.owner]               'KEYS' (small caps line above the title)
 * @param {string} [o.hint]                'how much goes into the Space (Hall)'
 * @param {Array<{value:any,label:string}>} o.steps   in display order (top first)
 * @param {any} [o.value]
 * @param {any} [o.loaded]                 the value when the song was loaded → "as loaded" marker (when not current)
 * @param {string} [o.color]               --c
 * @param {string} [o.footnote]            HTML-free text; **…** is not parsed
 * @param {{min:number,max:number,format?:(v:number)=>string}} [o.fine]  adds a vertical relative-drag slider
 * @param {(value:any, how:{keyboard:boolean}) => void} [o.onPick]  a step was tapped / chosen with Enter or Space
 * @param {(value:number) => void} [o.onFine]  the fine slider moved (continuous; the panel stays open)
 * @param {(how:{keyboard:boolean}) => void} [o.onClose]  the × button
 * @returns {{el:HTMLElement, set(v:any):void, setLoaded(v:any):void, setHint(s:string):void, focusCurrent():void,
 *            destroy():void}}
 */
export function stepPanel(o = {}) {
  const d = disposer();
  const steps = Array.isArray(o.steps) ? o.steps : [];
  let value = o.value;
  let loaded = o.loaded;
  const label = `${o.owner ? `${o.owner} ` : ''}${o.title || ''}`.trim();
  const hint = h('div.sp-hint', { text: o.hint || '', hidden: !o.hint });
  const close = h('button.sp-x', { type: 'button', 'aria-label': 'Close', title: 'Close' }, '×');
  const group = h('div.sp-steps', { role: 'radiogroup', 'aria-label': label || 'Steps' });
  const buttons = steps.map((s) => {
    const b = h(
      'button.sp-step',
      { type: 'button', role: 'radio', 'aria-checked': 'false', dataset: { value: String(s.value) } },
      h('span.sp-step-l', { text: s.label }),
      h('small.sp-was', { text: 'as loaded', hidden: true }),
    );
    b._value = s.value;
    b._label = s.label;
    d.listen(b, 'click', (e) => {
      if (typeof o.onPick === 'function') o.onPick(s.value, { keyboard: e.detail === 0 });
    });
    group.append(b);
    return b;
  });
  let fine = null;
  if (o.fine) {
    fine = fader({
      label: `${label} (fine)`,
      min: o.fine.min,
      max: o.fine.max,
      value: typeof value === 'number' ? value : o.fine.min,
      vertical: true,
      compact: true,
      relative: true,
      resetOnDoubleClick: false,
      format: o.fine.format,
      className: 'sp-fine',
      onChange: (v) => {
        if (typeof o.onFine === 'function') o.onFine(v);
      },
    });
    d.add(() => fine.destroy());
  }
  const el = h(
    'div.step-panel',
    { role: 'group', 'aria-label': label, 'data-perform-overlay': '' },
    h(
      'div.sp-head',
      {},
      h('b.sp-title', {}, o.owner ? h('span.sp-owner', { text: o.owner }) : null, o.title || ''),
      close,
    ),
    hint,
    h(`div.sp-body${fine ? '' : '.nofine'}`, {}, group, fine ? fine.el : null),
    o.footnote ? h('div.sp-foot', { text: o.footnote }) : null,
  );
  if (o.color) el.style.setProperty('--c', o.color);
  d.listen(close, 'click', (e) => {
    if (typeof o.onClose === 'function') o.onClose({ keyboard: e.detail === 0 });
  });

  const current = () => buttons.find((b) => sameStep(b._value, value)) || null;
  const render = () => {
    const cur = current();
    for (const b of buttons) {
      const on = b === cur;
      const was = loaded !== undefined && sameStep(b._value, loaded) && !on;
      b.classList.toggle('on', on);
      b.classList.toggle('was', was);
      b.setAttribute('aria-checked', String(on));
      b.querySelector('.sp-was').hidden = !was;
      b.setAttribute('aria-label', was ? `${b._label} (as loaded)` : b._label);
      b.tabIndex = on || (!cur && b === buttons[0]) ? 0 : -1;
    }
    if (fine && typeof value === 'number') fine.set(value);
  };
  // arrows move focus between steps (choosing closes the panel, so it waits for Enter / Space / a tap)
  d.listen(group, 'keydown', (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    let j = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') j = Math.min(buttons.length - 1, i + 1);
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') j = Math.max(0, i - 1);
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = buttons.length - 1;
    if (j < 0) return;
    e.preventDefault();
    e.stopPropagation(); // arrows never reach song navigation / the mod wheel while the panel has focus
    for (const b of buttons) b.tabIndex = -1;
    buttons[j].tabIndex = 0;
    buttons[j].focus();
  });
  render();
  return {
    el,
    set(v) {
      value = v;
      render();
    },
    setLoaded(v) {
      loaded = v;
      render();
    },
    setHint(s) {
      setText(hint, s || '');
      hint.hidden = !s;
    },
    focusCurrent() {
      (current() || buttons[0])?.focus();
    },
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}
