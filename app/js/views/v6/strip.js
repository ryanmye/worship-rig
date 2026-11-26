// UI v6 instrument strip (D15, D16; UI6-build-plan U1): one component per instrument slot, the same for every kind of
// sound. Name (the instrument's, never a role), ON tile (= the mute), vertical level fader with its meter and dB, the
// 2×2 Space / Echo / Octave / Sustain chips, Change (today's instrument picker, in Edit) and ⋯ (Earlier, Later,
// Duplicate, Open in Edit, Remove with a hold), plus a ⠿ grip to drag it to another place (strips-row.js runs the
// drag). Reads come from the shell's render(); writes go through the shell's helpers (store.set / store.moveSlot /
// controller.scenes.adjust) exactly as views/perform.js's strips do. The strip is reused by position: its colour is the
// position's (D15), so an instrument that moves takes the colour of its new place.
import { h, setText, disposer } from '../components/util.js';
import { fader } from '../components/fader.js';
import { levelMeter } from '../components/levelMeter.js';
import { onTile } from '../components/onTile.js';
import { holdButton } from '../components/holdButton.js';
import {
  stepChip, AMOUNT_STEPS, OCTAVE_STEPS, SUSTAIN_STEPS, formatAmount, formatOctave,
} from '../components/stepChip.js';
import { hasChange } from '../../shared/song-diff.js';
import { MAX_SLOTS } from '../../shared/params.js';
import { slotMuteState, stepPanelNeed, SILENT_NOTE } from '../perform.js';
import { slotColor, button, popover, HOLD_MS } from './lib.js';


/**
 * @param {object} v   the v6 shell's view context (perform.js `v`)
 * @param {number} i   slot index
 * @returns {{el:HTMLElement, render(info:object):void, cancelDrag():void, closePanels():void, destroy():void}}
 */
export function createStrip(v, i) {
  const { store, ctx } = v;
  const d = disposer();
  const comps = [];
  const use = (c) => (comps.push(c), c);
  const color = slotColor(i);
  let name = '';
  let info = null;

  const nm = h('span.v6-nm', { 'data-testid': `v6-name-${i}`, text: '—' });
  const who = h('div.v6-who', { 'data-testid': `v6-who-${i}` }, h('span.v6-ico', { 'aria-hidden': 'true' }), nm);
  // U2 (D18 "On iPad, tap the instrument first"; D24.3: on every pointer): the name picks this instrument's range bar
  // on the keyboard; its strip shows an outline and "changing range" while it is picked
  const pickFlag = h('div.v6-pickflag', { text: 'changing range', hidden: true, 'data-testid': `v6-pickflag-${i}` });
  who.setAttribute('role', 'button');
  who.tabIndex = 0;
  who.setAttribute('aria-pressed', 'false');
  let coarse = false;
  const pickMe = () => {
    if (info?.slot && !info.locked) v.pickRange?.(i);
  };
  // skeptic UI6-U2 F2: a touch / pen tap picks on pointerup, not on click. Chromium drops the click of a tap that
  // lands within ~0.4 s of a quick touch drag (tap suppression after the drag's fling), which is exactly D18's
  // "drag the ends, then tap another instrument to switch": the tap did nothing (13 of 16 taps in a probe; the ui-v6
  // iPad test's flake). pointerdown / pointerup still arrive, so they decide; the click such a tap may still produce
  // is ignored. Mouse and keyboard / AT clicks keep the click path.
  let tap = null; // {id, x, y} of a touch / pen press on the name
  let tapDoneAt = -Infinity;
  d.listen(who, 'pointerdown', (ev) => {
    tap = ev.pointerType === 'mouse' ? null : { id: ev.pointerId, x: ev.clientX, y: ev.clientY };
  });
  d.listen(who, 'pointercancel', () => {
    tap = null; // the row started scrolling under the finger
  });
  d.listen(who, 'pointerup', (ev) => {
    const t = tap;
    tap = null;
    if (!t || t.id !== ev.pointerId || Math.hypot(ev.clientX - t.x, ev.clientY - t.y) > 10) return;
    tapDoneAt = performance.now();
    pickMe();
  });
  d.listen(who, 'click', () => {
    if (performance.now() - tapDoneAt < 1000) return; // that tap was handled on pointerup
    pickMe();
  });
  d.listen(who, 'keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    ev.preventDefault();
    ev.stopPropagation();
    pickMe();
  });
  // the tile's word is ON / OFF; its accessible name is the instrument (D15: no role labels)
  const tile = use(onTile({ label: 'Instrument', color, testid: `v6-on-${i}`, onToggle: (on) => v.setMuted(i, !on) }));
  const f = use(fader({
    path: `slots.${i}.gain`, label: 'Level', vertical: true, relative: true, resetOnDoubleClick: false, color,
    onChange: (x) => v.setSlotGain(i, x),
  }));
  f.el.dataset.testid = `v6-fader-${i}`;
  const lvl = use(levelMeter({ read: () => v.controller.slotLevel?.(i) ?? null, label: 'Level meter' }));
  lvl.el.dataset.testid = `v6-level-${i}`;
  f.el.querySelector('.fader-track')?.append(lvl.el);
  // the steps keep 44 px; a strip without room above the chip opens the panel over the strip below the tile
  const chip = (o) => use(stepChip({ color, placement: 'auto', placementNeed: stepPanelNeed, ...o }));
  const amount = (label, send, hint) => chip({
    label, steps: AMOUNT_STEPS, format: formatAmount, lit: (x) => Number(x) > 0.0005, amount: (x) => Number(x) || 0,
    fine: { min: 0, max: 1, format: (x) => `${Math.round(x * 100)}%` }, hint,
    footnote: 'Tap a step: done. Slide for in-between.', testid: `v6-${label.toLowerCase()}-${i}`,
    onChange: (x) => v.setSlot(i, `sends.${send}`, x),
  });
  const space = amount('Space', 'reverb', 'how much goes into the Space');
  const echo = amount('Echo', 'delay', 'how much goes into the Echo');
  const octave = chip({
    label: 'Octave', steps: OCTAVE_STEPS, format: formatOctave, lit: (x) => Number(x) !== 0,
    hint: 'shifts only this instrument', footnote: 'Tap one: done. Starts on your next note; held notes keep ringing.',
    className: 'x4', testid: `v6-octave-${i}`, onChange: (x) => v.setSlot(i, 'octave', x),
  });
  const sustain = chip({
    label: 'Sustain', steps: SUSTAIN_STEPS, format: (x) => (x ? 'Sustain' : 'Sustain off'), lit: (x) => x === true,
    className: 'x4 sus-chip', title: 'Does the sustain pedal hold this sound? Tap to switch.',
    testid: `v6-sustain-${i}`, onChange: (x) => v.setSlot(i, 'sustain', !!x),
  });
  const chips = [space, echo, octave, sustain];

  // Change: today's instrument picker lives in Edit's slot panel (opened with focus 'instrument', as Perform's
  // empty-slot "+" does)
  const changeBtn = button(d, '.v6-change', 'Change', { 'data-testid': `v6-change-${i}` });
  d.listen(changeBtn, 'click', () => ctx.setView?.('edit', { block: `slot:${i}`, focus: 'instrument' }));
  const moreBtn = button(d, '.v6-more', '⋯', {
    'aria-haspopup': 'true', 'aria-expanded': 'false', 'data-testid': `v6-more-${i}`,
  });
  let menu = null;
  d.listen(moreBtn, 'click', () => (menu ? menu.close() : openMenu()));
  // D23.2: drag the strip by this grip to put the instrument somewhere else (strips-row.js listens on the row and
  // runs the drag); ⋯ Earlier / Later are the keyboard way. Hidden under Lock and with one instrument.
  const grip = h('span.v6-grip', {
    'aria-hidden': 'true', 'data-testid': `v6-grip-${i}`, dataset: { slot: String(i) },
    title: 'Drag to move this instrument (or ⋯ › Earlier / Later)', text: '⠿',
  });

  const el = h(
    'div.panel.slot.strip.v6-strip',
    { dataset: { slot: String(i) }, 'data-testid': `v6-strip-${i}`, style: { '--c': color } },
    who,
    grip,
    pickFlag,
    tile.el,
    h('div.slot-body.v6-body', {}, f.el),
    h('div.slot-mods.v6-mods', {}, ...chips.map((c) => c.el)),
    h('div.v6-btns', {}, changeBtn, moreBtn),
  );

  function openMenu() {
    if (!info) return;
    menu = popover({
      host: v.host,
      anchor: moreBtn,
      beside: el,
      label: `${name} more`,
      className: 'v6-more-pop',
      testid: `v6-menu-${i}`,
      build: (body, pd, close) => {
        const item = (cls, text, attrs, run) => {
          const b = button(pd, `.ghost${cls}`, text, attrs);
          if (run) pd.listen(b, 'click', () => {
            close();
            run();
          });
          return b;
        };
        const locked = v.isLocked();
        // D23.2: one place earlier / later (store.moveSlot: everything of the instrument goes with it). From the
        // keyboard (a click with detail 0) the focus follows the instrument to its new ⋯ button.
        const move = (to) => (ev) => {
          if (v.moveSlot(i, to) && ev && ev.detail === 0) queueMicrotask(() => v.focusMore?.(to));
        };
        const earlier = item('.v6-earlier', '◀ Earlier', {
          'data-testid': `v6-earlier-${i}`, title: 'Move this instrument one place to the left',
          disabled: locked || i <= 0,
        });
        const later = item('.v6-later', 'Later ▶', {
          'data-testid': `v6-later-${i}`, title: 'Move this instrument one place to the right',
          disabled: locked || i >= info.n - 1,
        });
        for (const [b, to] of [[earlier, i - 1], [later, i + 1]]) {
          pd.listen(b, 'click', (ev) => {
            close();
            move(to)(ev);
          });
        }
        // Duplicate = store.insertSlot after this one with a deep copy, scenes copied from it (D23.2): the copy sits
        // next to the original and follows the snapshots like it
        const dup = item('.v6-dup', 'Duplicate', {
          'data-testid': `v6-dup-${i}`, title: 'Add a copy of this instrument next to it',
          disabled: locked || !info.slot || info.n >= MAX_SLOTS,
        }, () => v.duplicateSlot(i));
        const edit = item('.v6-edit', 'Open in Edit', { 'data-testid': `v6-open-edit-${i}`, disabled: locked },
          () => ctx.setView?.('edit', { block: `slot:${i}` }));
        const rm = holdButton({
          label: 'Remove (hold)', ms: HOLD_MS, requireHold: true, className: 'ghost warn v6-remove',
          testid: `v6-remove-${i}`, title: 'Press and hold to remove this instrument from the song',
          onActivate: () => {
            close();
            v.removeSlot(i);
          },
        });
        rm.setDisabled(locked || info.n <= 1);
        pd.add(() => rm.destroy());
        body.append(
          h('div.v6-pop-h', {}, name, h('span', { text: ' more' })),
          h('div.v6-prow', {}, earlier, later),
          h('div.v6-prow', {}, dup, edit),
          h('div.v6-prow', {}, rm.el),
        );
      },
      onClose: () => {
        menu = null;
      },
    });
  }

  /**
   * @param {{slot:object|null, base:object|null, changed:Set<string>, name:string, title:string, silent:boolean,
   *          n:number, locked:boolean, wheel:number|null}} x
   */
  function render(x) {
    info = x;
    const { slot } = x;
    const empty = !slot;
    el.classList.toggle('empty-v6', empty);
    el.classList.toggle('silent', !!x.silent);
    if (x.silent) el.title = SILENT_NOTE;
    else el.removeAttribute('title');
    name = empty ? 'Empty' : x.name;
    setText(nm, name);
    nm.title = empty ? 'No instrument yet: Change picks one' : x.title;
    tile.setLabel(name);
    f.setLabel(`${name} level`);
    f.setDisabled(empty);
    for (const c of chips) c.setDisabled(empty);
    tile.setDisabled(empty);
    setText(changeBtn, empty ? 'Choose' : 'Change');
    changeBtn.disabled = x.locked; // Edit is frozen under Perform lock (LOCK table)
    grip.hidden = x.locked || x.n < 2; // no reorder under Lock (D23.2 task) or with nothing to swap with
    changeBtn.title = x.locked ? 'Perform lock is on: unlock to change the instrument' : 'Choose another instrument';
    if (empty) {
      // skeptic UI6-U1 F1: an empty slot shows no level and no sends. The strip is reused by position, so without
      // this it kept the fader / chips of the instrument that sat here before a Remove shifted the slots down.
      el.classList.remove('muted');
      tile.set(true);
      f.set(0);
      f.setMuted(false);
      f.setIndicator(null);
      for (const [c, x] of [[space, 0], [echo, 0], [octave, 0], [sustain, false]]) {
        c.set(x);
        c.setLoaded(undefined);
        c.setChanged(false);
      }
      return;
    }
    const { muted, level } = slotMuteState(slot);
    f.set(level);
    f.setMuted(muted);
    el.classList.toggle('muted', muted);
    tile.set(!muted);
    f.setIndicator(x.wheel === null || muted ? null : level * x.wheel);
    const P = `patch.slots.${i}`;
    const sends = slot.sends || {};
    const bs = x.base || null;
    space.set(Number(sends.reverb) || 0);
    echo.set(Number(sends.delay) || 0);
    octave.set(Number(slot.octave) || 0);
    sustain.set(slot.sustain !== false);
    space.setLoaded(bs ? Number(bs.sends?.reverb) || 0 : undefined);
    echo.setLoaded(bs ? Number(bs.sends?.delay) || 0 : undefined);
    octave.setLoaded(bs ? Number(bs.octave) || 0 : undefined);
    sustain.setLoaded(bs ? bs.sustain !== false : undefined);
    space.setChanged(hasChange(x.changed, `${P}.sends.reverb`));
    echo.setChanged(hasChange(x.changed, `${P}.sends.delay`));
    octave.setChanged(hasChange(x.changed, `${P}.octave`));
    sustain.setChanged(hasChange(x.changed, `${P}.sustain`));
  }

  return {
    el,
    render,
    /** The fader's wheel indicator only (the wheel moves far more often than the song). */
    setWheel(w) {
      if (!info || !info.slot) return;
      const { muted, level } = slotMuteState(info.slot);
      info = { ...info, wheel: w };
      f.setIndicator(w === null || muted ? null : level * w);
    },
    cancelDrag() {
      f.cancelDrag?.();
    },
    /** The pointer kind: only the name's wording changes (the name picks on every pointer since D24.3). */
    setCoarse(on) {
      coarse = !!on;
      who.title = `${coarse ? 'Tap' : 'Click'} to change which keys play this instrument`;
    },
    /** U2: this instrument's range is being changed (pick mode). */
    setPicked(on) {
      el.classList.toggle('range-picked', !!on);
      pickFlag.hidden = !on;
      who.setAttribute('aria-pressed', String(!!on));
    },
    /** The ⋯ button (focus after a keyboard Earlier / Later). */
    moreBtn,
    closePanels() {
      for (const c of chips) c.close();
      menu?.close();
    },
    destroy() {
      menu?.close();
      d.dispose();
      for (const c of comps.splice(0)) c.destroy();
      el.remove();
    },
  };
}
