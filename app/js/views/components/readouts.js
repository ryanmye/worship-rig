// chordReadout() and wheelStrip() — SPEC §13.
import { h, setText, disposer, rafCoalesce, blurAfterPointer, nextId, clamp, relativeDrag } from './util.js';

/**
 * Big chord name. set(chord|null) where chord = {name, root, quality, bass} (engine 'chord' event).
 * With no notes held the last chord stays visible, dimmed.
 * @param {{label?:string}} [o]
 */
export function chordReadout(o = {}) {
  const name = h('span.chord-name', { text: '—' });
  const el = h('div.chord-readout', { role: 'status', 'aria-live': 'off', 'aria-label': o.label || 'Chord' }, h('span.chord-caption', { text: o.label || 'Chord' }), name);
  let last = null;
  return {
    el,
    set(chord) {
      if (chord && chord.name) {
        last = chord.name;
        setText(name, chord.name);
        el.classList.remove('stale');
        el.classList.add('live');
      } else {
        setText(name, last || '—');
        el.classList.toggle('stale', !!last);
        el.classList.remove('live');
      }
    },
    destroy() {
      el.remove();
    },
  };
}

/**
 * Wheel strip: effective mod-wheel value (hardware, on-screen, Swell automation), the Swell button, the wheel
 * target, a pickup ghost when the hardware wheel hasn't caught up, and the drone-swell (bend) indicator.
 * @param {{onSwell?:()=>void, onWheel?:(v:number)=>void, label?:string, relative?:boolean}} [o]
 *   relative (default true): drag movement changes the wheel; a tap never jumps it (UX B2)
 * set({value, swelling, target, pickup, hardware, bendMode, bend, expr, vol, pedal, pedalStuck})
 *   expr / vol: 0..1 shows that row, null hides it; pedal: sustain down; pedalStuck: held unusually long
 */
export function wheelStrip(o = {}) {
  const d = disposer();
  const id = nextId('wheel');
  const input = h('input.wheel-input', { type: 'range', id, min: 0, max: 1000, step: 1, 'aria-label': o.label || 'Mod wheel' });
  const ghost = h('div.wheel-ghost', { hidden: true, 'aria-hidden': 'true' });
  const value = h('output.wheel-value', { for: id, text: '100%' });
  const target = h('div.wheel-target');
  const swellBtn = h('button.swell-btn', { type: 'button', 'aria-pressed': 'false', title: 'Swell: bring the wheel up from 0 over the song’s swell time (Shift+↑). Press again to return.' }, h('span.swell-icon', { 'aria-hidden': 'true', text: '◢' }), h('span', { text: 'Swell' }));
  const droneLamp = h('div.drone-swell', { hidden: true, title: 'Pitch-bend wheel → drone swell (push up to swell the drone, pull down to duck it)' }, h('span.drone-swell-led', { 'aria-hidden': 'true' }), h('span.drone-swell-text', { text: 'Bend → drone' }));
  const exprVal = h('span.wheel-extra-val', { text: '' });
  const volVal = h('span.wheel-extra-val', { text: '' });
  const exprRow = h('div.wheel-extra', { hidden: true, title: 'Expression pedal' }, h('span.wheel-extra-cap', { text: 'Expr' }), exprVal);
  const volRow = h('div.wheel-extra', { hidden: true, title: 'Volume knob' }, h('span.wheel-extra-cap', { text: 'Vol' }), volVal);
  const pedalText = h('span.pedal-text', { text: 'Pedal' });
  const pedalLamp = h('div.pedal-lamp', { role: 'status', 'aria-live': 'off', title: 'Sustain pedal (lights while held)', 'data-testid': 'pedal-lamp' }, h('span.pedal-led', { 'aria-hidden': 'true' }), pedalText);
  const el = h(
    'div.wheel-strip',
    { role: 'group', 'aria-label': 'Mod wheel' },
    h('label.wheel-caption', { for: id, text: o.label || 'Wheel' }),
    h('div.wheel-track', {}, input, ghost),
    value,
    target,
    exprRow,
    volRow,
    swellBtn,
    pedalLamp,
    droneLamp,
  );
  let dragging = false;
  let v = 1;
  let shownIv = -1; // performance #3b: the --pos / text last written (render runs every frame while the wheel moves)
  let shownTxt = '';
  let ghostShown = false;
  const render = (force) => {
    const pos = clamp(v, 0, 1);
    const iv = Math.round(pos * 1000);
    if ((force || !dragging) && Number(input.value) !== iv) input.value = String(iv);
    if (iv === shownIv) return;
    shownIv = iv;
    input.style.setProperty('--pos', `${(iv / 10).toFixed(1)}%`);
    const txt = `${Math.round(pos * 100)}%`;
    if (txt === shownTxt) return;
    shownTxt = txt;
    setText(value, txt);
    input.setAttribute('aria-valuetext', txt);
  };
  const emitter = rafCoalesce((x) => {
    if (typeof o.onWheel === 'function') o.onWheel(x);
  });
  const relative = o.relative !== false;
  d.listen(input, 'input', () => {
    if (relative && dragging) {
      render();
      return;
    }
    v = Number(input.value) / 1000;
    render();
    emitter.push(v);
  });
  d.listen(input, 'change', () => emitter.flush());
  const end = () => {
    if (!dragging) return;
    dragging = false;
    emitter.flush();
  };
  if (relative) {
    relativeDrag(input, {
      vertical: true,
      d,
      getPos: () => clamp(v, 0, 1),
      setPos: (p) => {
        v = p;
        render(true);
        emitter.push(v);
      },
      onStart: () => (dragging = true),
      onEnd: end,
    });
  } else {
    d.listen(input, 'pointerdown', () => (dragging = true));
    d.listen(window, 'pointerup', end);
    d.listen(window, 'pointercancel', end);
  }
  d.listen(input, 'pointerup', () => queueMicrotask(() => input.blur()));
  d.listen(swellBtn, 'click', () => {
    if (typeof o.onSwell === 'function') o.onSwell();
  });
  blurAfterPointer(swellBtn, d);
  render();
  return {
    el,
    set(s = {}) {
      if (Number.isFinite(s.value) && !dragging) {
        v = s.value;
        render();
      }
      if ('swelling' in s && swellBtn.getAttribute('aria-pressed') !== String(!!s.swelling)) {
        // performance #3: renderWheel passes this every frame while the wheel moves; write only a change
        swellBtn.setAttribute('aria-pressed', String(!!s.swelling));
        swellBtn.classList.toggle('on', !!s.swelling);
      }
      if ('target' in s) setText(target, s.target ? `→ ${s.target}` : '');
      if ('pickup' in s) {
        const show = !!s.pickup && Number.isFinite(s.hardware);
        if (show) el.style.setProperty('--ghost', String(clamp(s.hardware, 0, 1)));
        if (show !== ghostShown) {
          ghostShown = show;
          ghost.hidden = !show;
          el.classList.toggle('pickup', show);
        }
      }
      if ('bendMode' in s) droneLamp.hidden = s.bendMode !== 'drone-swell';
      const pct = (x) => `${Math.round(clamp(Number(x) || 0, 0, 1) * 100)}%`;
      if ('expr' in s) {
        if (exprRow.hidden !== !Number.isFinite(s.expr)) exprRow.hidden = !Number.isFinite(s.expr);
        if (Number.isFinite(s.expr)) setText(exprVal, pct(s.expr));
      }
      if ('vol' in s) {
        if (volRow.hidden !== !Number.isFinite(s.vol)) volRow.hidden = !Number.isFinite(s.vol);
        if (Number.isFinite(s.vol)) setText(volVal, pct(s.vol));
      }
      if ('pedal' in s || 'pedalStuck' in s) {
        if ('pedal' in s) pedalLamp.classList.toggle('down', !!s.pedal);
        const stuck = !!s.pedalStuck && pedalLamp.classList.contains('down');
        pedalLamp.classList.toggle('stuck', stuck);
        setText(pedalText, stuck ? 'Pedal held' : 'Pedal');
        // idle-cpu R3: set by the 150 ms runtime tick; only a change is a DOM mutation
        const lab = pedalLamp.classList.contains('down') ? (stuck ? 'Sustain pedal held a long time' : 'Sustain pedal down') : 'Sustain pedal up';
        if (pedalLamp.getAttribute('aria-label') !== lab) pedalLamp.setAttribute('aria-label', lab);
      }
      if ('bend' in s) {
        const b = Number(s.bend) || 0;
        droneLamp.classList.toggle('up', b > 0.05);
        droneLamp.classList.toggle('down', b < -0.05);
        droneLamp.style.setProperty('--bend', String(Math.abs(b)));
      }
    },
    setDisabled(b) {
      input.disabled = !!b;
      swellBtn.disabled = !!b;
    },
    destroy() {
      emitter.cancel();
      d.dispose();
      el.remove();
    },
  };
}
