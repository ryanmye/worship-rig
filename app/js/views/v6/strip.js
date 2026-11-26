// UI v6 instrument strip (D15, D16; UI6-build-plan U1): one component per instrument slot, the same for every kind of
// sound. Name (the instrument's, never a role), ON tile (= the mute), vertical level fader with its meter and dB, the
// 2×2 Space / Echo / Octave / Sustain chips, Change (today's instrument picker, in Edit) and ⋯ (Earlier, Later,
// Duplicate, Open in Edit, Remove with a hold). Reads come from the shell's render(); writes go through the shell's
// helpers (store.set / controller.scenes.adjust) exactly as views/perform.js's strips do.
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

/** ⋯ entries the store cannot do yet (no slot move that carries wheel targets and scenes with it): shown, disabled. */
export const COMING_TITLE = 'Coming: needs a store move that keeps the wheel targets and snapshots with the instrument';

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
  const who = h('div.v6-who', {}, h('span.v6-ico', { 'aria-hidden': 'true' }), nm);
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

  const el = h(
    'div.panel.slot.strip.v6-strip',
    { dataset: { slot: String(i) }, 'data-testid': `v6-strip-${i}`, style: { '--c': color } },
    who,
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
        const coming = (cls, text, id) => item(cls, text, { disabled: true, title: COMING_TITLE, 'data-testid': id });
        const earlier = coming('.v6-earlier', '◀ Earlier', `v6-earlier-${i}`);
        const later = coming('.v6-later', 'Later ▶', `v6-later-${i}`);
        // Duplicate = store.addSlot with a copy: the store appends, so the copy goes last (there is no insert yet)
        const dup = item('.v6-dup', 'Duplicate', {
          'data-testid': `v6-dup-${i}`, title: 'Add a copy of this instrument at the end',
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
    changeBtn.title = x.locked ? 'Perform lock is on: unlock to change the instrument' : 'Choose another instrument';
    if (empty) {
      el.classList.remove('muted');
      tile.set(true);
      f.setIndicator(null);
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
