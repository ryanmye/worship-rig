// 2.x step 5 (FX-gap-analysis "MIDI learn", DECISIONS O-AW-ML): "Learn MIDI" on any Edit slider whose store
// address is a continuous PARAMS path. A right-click (Ctrl-click on a Mac trackpad, a long-press on touch: Chromium
// fires contextmenu for all three) on a [data-bind] control opens a small menu: Learn (then move a knob) and Forget.
// Provisional UI: one delegated listener on the Edit root, so every panel's sliders, faders and chips get it with no
// panel change. Writes go through controller.learn / controller.clearLearn only (views never touch MIDI or the engine).
// A control can opt out with data-no-learn (the slot strip's shelf sliders: their legacy row stops acting once the EQ
// has bands, so a knob on it would move nothing).
import { isLearnablePath, learnLabel } from '../../shared/learn.js';
import { h, setText } from './lib.js';

/** A replaced mapping's name: the fixed rows' own words ('nextSong' → 'Next song'), else the param label. */
const BUTTON_WORDS = Object.freeze({ nextSong: 'Next song', prevSong: 'Previous song', panic: 'Panic',
  fadeOutAll: 'Fade out all', swell: 'Swell', nextScene: 'Next scene', prevScene: 'Previous scene', go: 'Go',
  cueNext: 'Cue next', cuePrev: 'Cue previous' });
const targetName = (id) => BUTTON_WORDS[id] || (isLearnablePath(id) ? learnLabel(id) : id);

/** Plain text for a mapping ('CC 21 · ch 1'); Settings' mappingText has the note / range forms. */
const ccText = (m) => (m && Number.isInteger(m.cc)
  ? `CC ${m.cc} · ${m.channel === null || m.channel === undefined ? 'any ch' : `ch ${m.channel + 1}`}` : '');

/**
 * Attach the learn menu to an Edit root (shell.js createCore; the full view and mountSinglePanel alike).
 * @param {object} core   the shell core (listen, escapes, viewHooks, cleanups, toast)
 * @param {HTMLElement} root  the .ev2 root
 * @param {{store:object, controller:object}} appCtx
 * @returns {{open(el:HTMLElement, addr:string, x?:number, y?:number):boolean, close():void, readonly isOpen:boolean}}
 */
export function attachLearnMenu(core, root, appCtx) {
  const { store, controller } = appCtx;
  const locked = () => !!store.get?.()?.settings?.performLock;
  const canLearn = () => !!controller && typeof controller.learn === 'function';
  let pop = null;
  let learning = null; // the address a pending learn is for

  function close() {
    if (learning && typeof controller?.cancelLearn === 'function') controller.cancelLearn();
    learning = null;
    pop?.remove();
    pop = null;
  }

  function place(x, y) {
    const w = pop.offsetWidth || 260;
    const hgt = pop.offsetHeight || 120;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    pop.style.left = `${Math.max(8, Math.min(x, vw - w - 8))}px`;
    pop.style.top = `${Math.max(8, Math.min(y, vh - hgt - 8))}px`;
  }

  /**
   * Open the menu for `addr` at (x, y). @returns {boolean} false when the address is not learnable or the lock is on
   */
  function open(el, addr, x, y) {
    close();
    if (!isLearnablePath(addr) || locked()) return false;
    const r = el?.getBoundingClientRect?.();
    const px = Number.isFinite(x) ? x : r ? r.left : 40;
    const py = Number.isFinite(y) ? y : r ? r.bottom : 40;
    const m = (store.get().settings.midiLearn || {})[addr];
    const name = learnLabel(addr);
    const status = h('small.ev2-learn-status', { text: m ? `Knob: ${ccText(m)}` : 'No knob yet' });
    const learnBtn = h('button.ev2-slots-mi', { type: 'button', role: 'menuitem', dataset: { act: 'learn' },
      disabled: !canLearn() }, h('span', { text: m ? 'Learn a different knob' : 'Learn MIDI knob' }),
    h('small', { text: 'then move a knob, fader or pedal' }));
    const forgetBtn = m ? h('button.ev2-slots-mi.danger', { type: 'button', role: 'menuitem',
      dataset: { act: 'forget' } }, h('span', { text: `Forget ${ccText(m)}` })) : null;
    pop = h('div.ev2-slots-pop.ev2-learn-pop', { role: 'menu', 'aria-label': `MIDI learn: ${name}`,
      dataset: { testid: 'ev2-learn-menu', addr } },
    h('div.ev2-learn-head', {}, h('b', { text: name }), status), learnBtn, forgetBtn);
    root.append(pop);
    place(px, py);
    const me = pop;
    learnBtn.addEventListener('click', async () => {
      if (learning) return close(); // the button reads Cancel while learning
      learning = addr;
      setText(learnBtn.firstChild, 'Cancel');
      setText(learnBtn.lastChild, 'move a knob, fader or pedal now…');
      learnBtn.classList.add('on');
      let res = null;
      try {
        res = await controller.learn(addr);
      } catch (err) {
        console.warn('[edit] learn failed', err);
      }
      if (learning !== addr || pop !== me) return; // cancelled / closed meanwhile
      learning = null;
      if (res && res.error) {
        core.toast(res.error === 'perform-locked' ? 'Perform Lock is on. Unlock to learn MIDI.'
          : res.error === 'sustain-pedal-reserved' ? 'That’s the sustain pedal: it always sustains. Use another knob.'
            : 'That control can’t be used here. Try a different one.', 'warn');
      } else if (res) {
        // skeptic midi-learn-any C1: a button on that knob (a footswitch's Next song…) was cleared, so say so
        const took = Array.isArray(res.replaced) && res.replaced.length
          ? ` (was ${res.replaced.map(targetName).join(', ')})` : '';
        core.toast(`${name} → ${ccText(res)}${took}`, 'ok');
      }
      else core.toast('Nothing was received. Try Learn again.', 'warn');
      close();
    });
    forgetBtn?.addEventListener('click', () => {
      if (typeof controller?.clearLearn === 'function') controller.clearLearn(addr);
      else store.setMidiLearn(addr, null);
      core.toast(`${name}: knob forgotten`, 'ok');
      close();
    });
    learnBtn.focus?.({ preventScroll: true });
    return true;
  }

  core.listen(root, 'contextmenu', (e) => {
    const el = e.target?.closest?.('[data-bind]');
    if (!el || !root.contains(el) || el.closest('[data-no-learn]')) return;
    const addr = el.dataset.bind;
    if (!isLearnablePath(addr) || locked()) return; // the browser's own menu, as before
    e.preventDefault();
    open(el, addr, e.clientX, e.clientY);
  });
  core.listen(document, 'pointerdown', (e) => {
    if (pop && !pop.contains(e.target)) close();
  }, true);
  core.escapes.push(() => {
    if (!pop) return false;
    close();
    return true;
  });
  core.viewHooks.add(close); // leaving Edit (⌘E) closes it
  // the lock turning on (from Perform) closes the menu and its pending learn (the controller cancels the learn too)
  core.cleanups.push(store.subscribe((state) => {
    if (pop && state.settings.performLock) close();
  }));
  core.cleanups.push(close);
  return {
    open,
    close,
    get isOpen() {
      return !!pop;
    },
  };
}
