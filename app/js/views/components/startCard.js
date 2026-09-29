// startCard(): the first-run "Start here" card (onboarding.md "The first 60 seconds"). Perform puts it at the top of the
// Notes panel. It stays until the player closes it (×) or first changes song, and never shows again on this machine
// (localStorage). No README needed: what to play without a keyboard, how to change song and room, how Lock works.
import { h, disposer } from './util.js';

/** localStorage key; the value 'done' means the card was dismissed on this machine. */
export const START_CARD_KEY = 'worship-rig.start-card';

const readDone = () => {
  try {
    return globalThis.localStorage?.getItem(START_CARD_KEY) === 'done';
  } catch {
    return false; // storage blocked: show it for this session
  }
};

/**
 * @param {{onDismiss?:(why:'close'|'next'|'api')=>void}} [o]
 * @returns {{el:HTMLElement, readonly shown:boolean, setMidi(connected:boolean):void, dismiss(why?:string):void,
 *            reset():void, destroy():void}}
 */
export function startCard(o = {}) {
  const d = disposer();
  const b = (t) => h('b', { text: t });
  const kbLine = h('li.sc-kb');
  const close = h('button.sc-x', { type: 'button', 'aria-label': 'Close the start card', title: 'Got it (don’t show again)' }, '×');
  const el = h(
    'section.start-card',
    { 'aria-label': 'Start here', 'data-testid': 'start-card' },
    h('div.sc-head', {}, h('span.sc-title', { text: 'Start here' }), close),
    h(
      'ul.sc-list',
      {},
      kbLine,
      h('li', {}, b('→'), ' or ', b('NEXT'), ' = next song. The ', b('Space'), ' row changes the room.'),
      h('li', {}, 'Before the service tap ', b('Lock'), '. To unlock, hold it until it lets go.'),
    ),
  );
  let shown = !readDone();
  el.hidden = !shown;
  let midi = null;
  const setMidi = (connected) => {
    const c = !!connected;
    if (c === midi) return;
    midi = c;
    if (c) kbLine.replaceChildren('Your keyboard is connected: just play. ', b('Space'), ' on the computer is a sustain pedal too.');
    else {
      kbLine.replaceChildren(
        'No keyboard yet? Play ', b('A S D F G H J K'), ' on your computer (', b('Space'), ' = sustain). ',
        'Plug a USB keyboard in any time: it connects by itself.',
      );
    }
  };
  setMidi(false);
  const dismiss = (why = 'api') => {
    if (!shown) return;
    shown = false;
    el.hidden = true;
    try {
      globalThis.localStorage?.setItem(START_CARD_KEY, 'done');
    } catch {
      /* storage blocked: gone for this session only */
    }
    if (typeof o.onDismiss === 'function') o.onDismiss(why);
  };
  d.listen(close, 'click', () => dismiss('close'));
  return {
    el,
    get shown() {
      return shown;
    },
    setMidi,
    dismiss,
    /** Test hook: forget the dismissal and show the card again. */
    reset() {
      try {
        globalThis.localStorage?.removeItem(START_CARD_KEY);
      } catch {
        /* ignore */
      }
      shown = true;
      el.hidden = false;
    },
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}
