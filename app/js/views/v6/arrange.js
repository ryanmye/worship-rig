// Arrange (UI v6 U7c; native DECISIONS D15 "Cards can be arranged", D23.2; mockup native/docs/design/mockups/
// dialogs.html "Arrange", mock_dialogs.py arrange()). Entered from the snapshots row's Arrange button: a bar under the
// song bar says what to do and has Done; the strips show their ⠿ grip as a big "drag" handle plus ◀ / ▶ (Earlier /
// Later) and ✕ (hold: Remove), and the sidebar shows its customize list (drag ⠿ or ↑ ↓, show / hide) in place of the
// module, with the tabs outlined. No new reorder logic: the strip drag is strips-row.js's (the arrange handle is a
// .v6-grip), ◀ / ▶ / ✕ are the shell's v.moveSlot / v.removeSlot (store.moveSlot / removeSlot), and the sidebar list is
// sidebar.js customizeList (the ⋯ popover's and Settings › Perform layout's).
// Done or Esc leaves (Esc never panics here; with "Esc always panics" on it panics and leaves, D24.7). The lock
// coming on, MIDI Learn starting and leaving Perform leave too. Frozen under Lock (moves are, D23.2).
import { h, disposer } from '../components/util.js';
import { openOverlay } from '../components/overlay.js';
import { button } from './lib.js';

/**
 * @param {object} v  the v6 shell's view context (store, host, toast, isLocked, learn?)
 * @param {{sidebar:{arrange(on:boolean):void}}} o
 * @returns {{el:HTMLElement, enter():boolean, exit():void, readonly active:boolean, destroy():void}}
 */
export function arrangeMode(v, o) {
  const { store } = v;
  const d = disposer();
  const done = button(d, '.v6-arr-done', 'Done', { 'data-testid': 'v6-arrange-done' });
  const el = h('div.v6-learnbar.v6-arrbar', { role: 'status', 'data-testid': 'v6-arrangebar', hidden: true },
    h('b', { text: 'Arrange' }),
    h('small.v6-lhint', { text: 'Drag a strip by ⠿ or use ◀ ▶ · drag the sidebar’s modules, or ↑ ↓ · colours follow '
      + 'the position · ✕ removes (hold)' }), done);
  d.listen(done, 'click', () => exit());
  let on = false;
  let closeEsc = null;

  function enter() {
    if (on) return true;
    if (v.isLocked()) {
      v.toast('Perform lock is on. Unlock to arrange.', 'warn');
      return false;
    }
    v.learn?.exit();
    on = true;
    el.hidden = false;
    v.host.classList.add('arranging');
    o.sidebar.arrange(true);
    closeEsc = openOverlay({
      el, anchors: [], closeOnOutside: false, underModal: true, group: 'v6-arrange',
      onClose: (reason) => {
        closeEsc = null;
        if (reason !== 'api') exit();
      },
    });
    return true;
  }
  function exit() {
    if (!on) return;
    on = false;
    if (closeEsc) closeEsc('api');
    closeEsc = null;
    el.hidden = true;
    v.host.classList.remove('arranging');
    o.sidebar.arrange(false);
  }
  d.add(store.subscribe((state) => {
    if (on && (state.settings.performLock || state.settings.view !== 'perform')) exit();
  }));

  return {
    el,
    enter,
    exit,
    get active() {
      return on;
    },
    destroy() {
      exit();
      d.dispose();
      el.remove();
    },
  };
}
