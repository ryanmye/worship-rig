// UI v6 bottom row (D16 "Kept from today"; UI6-build-plan U1): today's on-screen keyboard (C2–C7, components/keys.js)
// with one range bar per instrument (display only, from lowNote / highNote; U2 makes them draggable), computer-key
// letters while no MIDI keyboard is connected, held notes lit; then Revert (hold), Fade out, PANIC (hold, or Esc) and
// Lock (hold), wired to the same controller / store calls as views/perform.js.
import { h, setText, disposer } from '../components/util.js';
import { pianoKeyboard, keyLayout } from '../components/keys.js';
import { holdButton } from '../components/holdButton.js';
import { say } from '../components/voice.js';
import { KEY_MAP } from '../../controller.js';
import { MAX_SLOTS } from '../../shared/params.js';
import { slotMuteState } from '../perform.js';
import { slotColor, button, icon, HOLD_MS } from './lib.js';

const PIANO_FROM = 36;
const PIANO_TO = 96;
const KEY_LABELS = Object.entries(KEY_MAP).map(([code, off]) => [off, code === 'Semicolon' ? ';' : code.slice(3)]);

/**
 * @param {object} v  the v6 shell's view context
 * @returns {{el:HTMLElement, keysEl:HTMLElement, render(x:object):void, setHeld(held:any):void,
 *            setLetters(on:boolean, oct:number):void, setFaded(b:boolean):void, releaseAll():void, destroy():void}}
 */
export function bottomRow(v) {
  const { store, controller } = v;
  const d = disposer();
  const comps = [];
  const use = (c) => (comps.push(c), c);

  const piano = use(pianoKeyboard({
    from: PIANO_FROM, to: PIANO_TO, label: 'On-screen keyboard (C2–C7)',
    onNoteOn: (n, vel) => controller.perform.noteOn(n, vel),
    onNoteOff: (n) => controller.perform.noteOff(n),
  }));
  piano.el.dataset.testid = 'v6-piano';
  const layout = new Map(keyLayout(PIANO_FROM, PIANO_TO).map((k) => [k.note, k]));
  const bars = [];
  const rbars = h('div.rbars.v6-rbars', { 'aria-hidden': 'true', 'data-testid': 'v6-range-bars' });
  const keysEl = h('section.panel.v6-keys', { 'data-testid': 'v6-keys' }, rbars, piano.el);

  const revertCount = h('span.rv-cnt-t', { text: '' });
  const revertBtn = use(holdButton({
    content: [h('span.rv-l', { text: '↺ Revert' }),
      h('span.rv-cnt', {}, h('i.rv-dot', { 'aria-hidden': 'true' }), revertCount)],
    ms: HOLD_MS, requireHold: true, className: 'btn-revert v6-act', testid: 'v6-revert',
    title: 'Press and hold: put this song back the way it was when you selected it (levels, key, effects).',
    onActivate: () => v.revertSong(),
  }));
  revertBtn.setDisabled(true);
  const fadeLabel = h('span.fade-label', { text: 'Fade out' });
  const fadeBtn = button(d, '.btn-fade.v6-act', fadeLabel, {
    title: 'Fade everything out over 6 s (⌘⇧F). Play any note to bring the sound back.', 'data-testid': 'v6-fade',
  });
  d.listen(fadeBtn, 'click', () => {
    controller.fadeOutAll();
    v.setFaded(true);
  });
  // PANIC needs a hold here (D16 mockup "hold · or Esc"; DESIGN_PHILOSOPHY: dangerous controls hard to hit by
  // accident). Esc and ⌘. still panic at once (main.js / controller).
  const panicBtn = use(holdButton({
    content: [h('span.panic-l', { text: 'PANIC' }), h('small.panic-k', { text: 'hold · or Esc' })],
    ms: HOLD_MS, requireHold: true, className: 'btn-panic v6-act', testid: 'v6-panic',
    ariaLabel: 'Panic: all notes off (press and hold, or Esc)',
    title: 'All notes off and the click stops (hold; Esc, ⌘.)',
    onActivate: () => controller.panic(),
  }));
  const lockText = h('span.lock-text', { text: 'Lock' });
  const lockSub = h('span.lock-sub', { text: '' });
  const lockBtn = use(holdButton({
    content: [h('span.lock-l', {}, icon('lock', 18), lockText), lockSub],
    ms: HOLD_MS, requireHold: true, className: 'lock-toggle v6-act', testid: 'v6-lock',
    title: 'Perform lock: playing stays live; the key, transpose and Revert need a hold; Edit, Settings and library '
      + 'changes are frozen. Hold to lock, hold to unlock.',
    onActivate: () => store.set('settings.performLock', !v.isLocked()),
  }));
  const el = h('div.v6-bottom', { 'data-testid': 'v6-bottom' }, keysEl, revertBtn.el, fadeBtn, panicBtn.el, lockBtn.el);

  let lettersKey = '';
  return {
    el,
    keysEl,
    /**
     * @param {{song:object|null, same:boolean, count:number, locked:boolean}} x
     *   same: nothing differs from the Revert snapshot; count: changes with a dot (perform.js changeCount)
     */
    render(x) {
      const song = x.song;
      const n = song ? Math.min(MAX_SLOTS, song.patch.slots.length) : 0;
      while (bars.length < n) {
        const k = bars.length;
        const b = h('i.rbar', { hidden: true, style: { '--c': slotColor(k) }, dataset: { slot: String(k) } });
        bars.push(b);
        rbars.append(b);
      }
      let row = 0;
      for (let i = 0; i < bars.length; i++) {
        const rb = bars[i];
        const slot = i < n ? song.patch.slots[i] : null;
        if (!slot) {
          rb.hidden = true;
          continue;
        }
        const lo = Math.max(PIANO_FROM, Number.isFinite(slot.lowNote) ? slot.lowNote : 0);
        const hi = Math.min(PIANO_TO, Number.isFinite(slot.highNote) ? slot.highNote : 127);
        const a = layout.get(lo);
        const b = layout.get(hi);
        rb.hidden = !(a && b && hi >= lo);
        if (rb.hidden) continue;
        rb.style.left = `${a.left.toFixed(2)}%`;
        rb.style.width = `${(b.left + b.width - a.left).toFixed(2)}%`;
        rb.style.setProperty('--row', String(row));
        rb.classList.toggle('off', slotMuteState(slot).muted);
        rb.classList.toggle('open-l', (slot.lowNote ?? 0) < PIANO_FROM);
        rb.classList.toggle('open-r', (slot.highNote ?? 127) > PIANO_TO);
        row += 1;
      }
      rbars.classList.toggle('dense', row > 4);
      if (row > 4) rbars.style.setProperty('--rstep', `${(23 / row).toFixed(2)}px`);
      else rbars.style.removeProperty('--rstep');
      revertBtn.setDisabled(x.same);
      revertBtn.el.classList.toggle('none', x.count === 0);
      setText(revertCount, x.same ? say('revertNone') : x.count ? `${x.count} changed` : 'levels only');
      revertBtn.el.dataset.count = String(x.same ? 0 : x.count);
      lockBtn.el.classList.toggle('on', x.locked);
      lockBtn.el.setAttribute('aria-pressed', String(x.locked));
      lockBtn.el.setAttribute('aria-label', x.locked ? 'Perform lock is on. Press and hold to unlock.'
        : 'Lock Perform view (press and hold)');
      setText(lockText, x.locked ? 'Locked' : 'Lock');
      setText(lockSub, x.locked ? 'hold to unlock' : 'hold to lock');
      for (const b of [revertBtn, panicBtn, lockBtn]) b.refresh();
    },
    setHeld(held, partOf) {
      piano.set(held, partOf);
    },
    setLetters(on, oct) {
      const key = on ? `on:${oct}` : 'off';
      if (key === lettersKey) return;
      lettersKey = key;
      piano.setKeyLetters(on ? new Map(KEY_LABELS.map(([off, l]) => [60 + 12 * oct + off, l])) : null);
    },
    setFaded(faded, text) {
      fadeBtn.classList.toggle('faded', faded);
      setText(fadeLabel, faded ? text : 'Fade out');
    },
    releaseAll() {
      piano.releaseAll();
    },
    destroy() {
      d.dispose();
      for (const c of comps.splice(0)) c.destroy();
      el.remove();
    },
  };
}
