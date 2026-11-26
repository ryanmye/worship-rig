// UI v6 bottom row (D16 "Kept from today"; UI6-build-plan U1, U2): the keyboard with range bars (keyboard.js, 'perform'
// size: today's keys C2–C7, one draggable range bar per instrument, computer-key letters while no MIDI keyboard is
// connected, held notes lit); then Revert (hold), Fade out, PANIC (a tap, or Esc) and Lock (a tap locks, a hold
// unlocks), wired to the same controller / store calls as views/perform.js (D23.1: as today's Perform).
import { h, setText, disposer } from '../components/util.js';
import { holdButton } from '../components/holdButton.js';
import { say } from '../components/voice.js';
import { KEY_MAP } from '../../controller.js';
import { MAX_SLOTS } from '../../shared/params.js';
import { slotMuteState } from '../perform.js';
import { slotColor, button, icon, HOLD_MS } from './lib.js';
import { rangeKeyboard } from './keyboard.js';

const KEY_LABELS = Object.entries(KEY_MAP).map(([code, off]) => [off, code === 'Semicolon' ? ';' : code.slice(3)]);

/**
 * @param {object} v  the v6 shell's view context (uses setRange, onRangePick, onCoarse for the range bars)
 * @param {{prefix?:string, barsReadOnly?:boolean}} [o]  prefix: the test ids' prefix ('v6' on Perform; the v6 Edit
 *   mounts its own row with 'v6e', U5b, so the two rows never share a test id while the hidden Perform keeps its row
 *   mounted); barsReadOnly: the range bars only show (no pick, no handles: the keyboard's locked look for the bars
 *   alone; the keys still play). The v6 Edit's row (skeptic UI6-U5b F4)
 * @returns {{el:HTMLElement, keysEl:HTMLElement, render(x:object):void, setHeld(held:any):void,
 *            setLetters(on:boolean, oct:number):void, setFaded(b:boolean):void, releaseAll():void, kb:object,
 *            destroy():void}}
 */
export function bottomRow(v, o = {}) {
  const { store, controller } = v;
  const pre = o.prefix || 'v6';
  const d = disposer();
  const comps = [];
  const use = (c) => (comps.push(c), c);

  const kb = use(rangeKeyboard({
    size: 'perform',
    testid: `${pre}-kbd`,
    onNoteOn: (n, vel) => controller.perform.noteOn(n, vel),
    onNoteOff: (n) => controller.perform.noteOff(n),
    onRange: (i, field, note, phase, expect) => v.setRange(i, field, note, phase, expect),
    onPick: (i) => v.onRangePick?.(i),
    onCoarse: (c) => v.onCoarse?.(c),
  }));
  kb.keysEl.dataset.testid = `${pre}-piano`;
  const keysEl = h('section.panel.v6-keys', { 'data-testid': `${pre}-keys` }, kb.el);

  const revertCount = h('span.rv-cnt-t', { text: '' });
  const revertBtn = use(holdButton({
    content: [h('span.rv-l', { text: '↺ Revert' }),
      h('span.rv-cnt', {}, h('i.rv-dot', { 'aria-hidden': 'true' }), revertCount)],
    ms: HOLD_MS, requireHold: true, className: 'btn-revert v6-act', testid: `${pre}-revert`,
    title: 'Press and hold: put this song back the way it was when you selected it (levels, key, effects).',
    onActivate: () => v.revertSong(),
  }));
  revertBtn.setDisabled(true);
  const fadeLabel = h('span.fade-label', { text: 'Fade out' });
  const fadeBtn = button(d, '.btn-fade.v6-act', fadeLabel, {
    title: 'Fade everything out over 6 s (⌘⇧F). Play any note to bring the sound back.',
    'data-testid': `${pre}-fade`,
  });
  d.listen(fadeBtn, 'click', () => {
    controller.fadeOutAll();
    v.setFaded(true);
  });
  // D23.1: PANIC is a tap again, as on today's Perform (the mockup's 600 ms hold is dropped: a stuck note must stop at
  // once). Esc and ⌘. are unchanged (main.js / controller).
  const panicBtn = button(d, '.btn-panic.v6-act', [h('span.panic-l', { text: 'PANIC' }),
    h('small.panic-k', { text: 'or Esc' })], {
    'data-testid': `${pre}-panic`, 'aria-label': 'Panic: all notes off (or Esc)',
    title: 'All notes off and the click stops (Esc, ⌘.)',
  });
  d.listen(panicBtn, 'click', () => controller.panic());
  // D23.1: Lock as today's Perform (views/perform.js, UX S1): one tap locks; unlocking needs the 600 ms hold, so a
  // stray tap mid-song never unlocks
  const lockText = h('span.lock-text', { text: 'Lock' });
  const lockSub = h('span.lock-sub', { text: '' });
  const lockBtn = use(holdButton({
    content: [h('span.lock-l', {}, icon('lock', 18), lockText), lockSub],
    ms: HOLD_MS, requireHold: () => v.isLocked(), className: 'lock-toggle v6-act', testid: `${pre}-lock`,
    holdText: 'keep holding… (0.6 s)',
    title: 'Perform lock: playing stays live; the key, transpose and Revert need a hold; Edit, Settings and library '
      + 'changes are frozen. Tap to lock, hold to unlock.',
    // U5b: the v6 Edit's row locks through v.toggleLock (back to Perform first: Perform lock freezes Edit)
    onActivate: () => (v.toggleLock ? v.toggleLock() : store.set('settings.performLock', !v.isLocked())),
  }));
  const el = h('div.v6-bottom', { 'data-testid': `${pre}-bottom` }, keysEl, revertBtn.el, fadeBtn, panicBtn,
    lockBtn.el);

  let lettersKey = '';
  return {
    el,
    keysEl,
    /**
     * @param {{song:object|null, same:boolean, count:number, locked:boolean, names?:object, changed?:Set<string>}} x
     *   same: nothing differs from the Revert snapshot; count: changes with a dot (perform.js changeCount);
     *   names: lib.js instrumentNames (the bars' labels); changed: the shell's changed paths (a bar's dot)
     */
    render(x) {
      const song = x.song;
      const n = song ? Math.min(MAX_SLOTS, song.patch.slots.length) : 0;
      const bars = [];
      for (let i = 0; i < n; i++) {
        const slot = song.patch.slots[i];
        if (!slot) continue; // an empty slot plays nothing: no bar
        bars.push({
          i, name: x.names ? x.names.name(slot.instrument) : `Instrument ${i + 1}`, color: slotColor(i),
          lo: slot.lowNote, hi: slot.highNote, off: slotMuteState(slot).muted,
          changed: !!x.changed && (x.changed.has(`patch.slots.${i}.lowNote`)
            || x.changed.has(`patch.slots.${i}.highNote`)),
        });
      }
      kb.render({ bars, locked: x.locked || !!o.barsReadOnly });
      revertBtn.setDisabled(x.same);
      revertBtn.el.classList.toggle('none', x.count === 0);
      setText(revertCount, x.same ? say('revertNone') : x.count ? `${x.count} changed` : 'levels only');
      revertBtn.el.dataset.count = String(x.same ? 0 : x.count);
      lockBtn.el.classList.toggle('on', x.locked);
      lockBtn.el.setAttribute('aria-pressed', String(x.locked));
      lockBtn.el.setAttribute('aria-label', x.locked ? 'Perform lock is on. Press and hold to unlock.'
        : 'Lock Perform view');
      setText(lockText, x.locked ? 'Locked' : 'Lock');
      setText(lockSub, x.locked ? 'hold to unlock' : '');
      for (const b of [revertBtn, lockBtn]) b.refresh();
    },
    setHeld(held, partOf) {
      kb.setHeld(held, partOf);
    },
    setLetters(on, oct) {
      const key = on ? `on:${oct}` : 'off';
      if (key === lettersKey) return;
      lettersKey = key;
      kb.setKeyLetters(on ? new Map(KEY_LABELS.map(([off, l]) => [60 + 12 * oct + off, l])) : null);
    },
    setFaded(faded, text) {
      fadeBtn.classList.toggle('faded', faded);
      setText(fadeLabel, faded ? text : 'Fade out');
    },
    releaseAll() {
      kb.releaseAll();
    },
    /** The keyboard with range bars (keyboard.js): pick(i) for the coarse-pointer pick mode, test hooks. */
    kb,
    destroy() {
      d.dispose();
      for (const c of comps.splice(0)) c.destroy();
      el.remove();
    },
  };
}
