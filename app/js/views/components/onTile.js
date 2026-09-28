// onTile(): the big ON/OFF tile at the top of a Perform strip (and the drone card). The tile IS the mute
// (H-v2 concept §1.2): ON = solid fill in the slot colour, dark text, white LED, soft glow; OFF = grey tile,
// name struck through, hollow LED, "OFF" outlined in grey. Never amber (amber means only "lock").
import { h, setText, disposer, blurAfterPointer } from './util.js';

/**
 * ON/OFF tile (a toggle button, aria-pressed = on).
 * @param {object} o
 * @param {string} o.label              role name, e.g. 'KEYS' or 'DRONE'
 * @param {string} [o.color]            CSS colour for the ON fill (sets --c), e.g. 'var(--slot-0)'
 * @param {boolean} [o.on=true]
 * @param {string} [o.sub]              small text after the label (the drone's "D major")
 * @param {string} [o.title]            tooltip; default "Tap to turn KEYS off"
 * @param {string} [o.className]
 * @param {(on:boolean) => void} [o.onToggle]  called with the NEW state after a tap (the tile flips at once)
 * @returns {{el:HTMLButtonElement, set(on:boolean):void, get():boolean, setLabel(s:string):void, setSub(s:string):void,
 *            setChanged(b:boolean):void, setDisabled(b:boolean):void, destroy():void}}
 */
export function onTile(o = {}) {
  const d = disposer();
  let on = o.on !== false;
  let label = String(o.label ?? '');
  const led = h('span.ot-led', { 'aria-hidden': 'true' });
  const name = h('span.ot-name', { text: label });
  const sub = h('small.ot-sub', { text: o.sub || '', hidden: !o.sub });
  const state = h('span.ot-state', { 'aria-hidden': 'true' });
  const dot = h('em.cd', { title: 'Changed since the song was loaded', hidden: true });
  const el = h(
    'button.ontile',
    { type: 'button', 'data-testid': o.testid },
    led,
    h('span.ot-label', {}, name, sub),
    state,
    dot,
  );
  if (o.color) el.style.setProperty('--c', o.color);
  if (o.className) el.classList.add(...String(o.className).split(/\s+/).filter(Boolean));

  const render = () => {
    el.classList.toggle('off', !on);
    el.setAttribute('aria-pressed', String(on));
    // the accessible name stays the role (+ sub); the state is aria-pressed, so a screen reader says "KEYS, toggle, on"
    el.setAttribute('aria-label', sub.hidden ? label : `${label} ${sub.textContent}`);
    setText(state, on ? 'ON' : 'OFF');
    el.title = o.title || `Tap to turn ${label} ${on ? 'off' : 'on'}`;
  };
  d.listen(el, 'click', () => {
    on = !on;
    render();
    if (typeof o.onToggle === 'function') o.onToggle(on);
  });
  blurAfterPointer(el, d);
  render();
  return {
    el,
    set(v) {
      on = !!v;
      render();
    },
    get: () => on,
    setLabel(s) {
      label = String(s ?? '');
      setText(name, label);
      render();
    },
    setSub(s) {
      const t = String(s ?? '');
      setText(sub, t);
      sub.hidden = !t;
      render();
    },
    setChanged(b) {
      dot.hidden = !b;
    },
    setDisabled(b) {
      el.disabled = !!b;
    },
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}
