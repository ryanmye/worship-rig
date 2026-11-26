// The first-run "Start here" card on the v6 Perform (UI v6 U8a edge states; onboarding.md "The first 60 seconds").
// Today's Perform shows components/startCard.js at the top of its Notes panel; the v6 Notes is a sidebar tab that is
// not open on a first run, so the same card (same localStorage key, same three lines, the v6 words for where NEXT and
// Space are) sits under the song bar instead, where the trial / learn / arrange bars go. Same rules as today: it stays
// until the player closes it (×) or first changes song after it was on screen, then never shows on this machine again;
// its keyboard line follows MIDI (connected: "just play"; else the computer keys). Nothing is stored in the library.
import { h, disposer } from '../components/util.js';
import { startCard } from '../components/startCard.js';
import { button } from './lib.js';

/**
 * @param {object} v  the v6 view context (store, controller)
 * @param {{onChange?:() => void}} [o]  after the card goes (the board grows: the Quick sheet re-anchors)
 * @returns {{el:HTMLElement, readonly shown:boolean, render(state:object):void, setMidi(connected:boolean):void,
 *            card:object, destroy():void}}
 */
export function startBand(v, o = {}) {
  const { store } = v;
  const d = disposer();
  const card = startCard({ songBar: true, onDismiss: () => o.onChange?.() });
  d.add(() => card.destroy());
  card.el.classList.add('v6-start');
  // FR-1 (as perform.js): the first song change ends the card only once it was on screen (the v6 Perform shown, not
  // Edit / a flag flip behind Settings)
  let seen = false;
  let cardSong = store.get().settings.currentSongId;
  return {
    el: card.el,
    get shown() {
      return card.shown;
    },
    card,
    /** From the shell's render: song change → dismiss (once seen). */
    render(state) {
      const st = state.settings;
      if (st.view === 'perform' && card.shown) seen = true;
      const id = st.currentSongId;
      if (id === cardSong) return;
      if (cardSong && card.shown && seen) card.dismiss('next');
      cardSong = id;
    },
    setMidi: (c) => card.setMidi(c),
    destroy: () => d.dispose(),
  };
}

/**
 * The empty library on the v6 stage (U8a edge state). Today's Perform shows "No song" over four empty "add a sound"
 * slots; the v6 board had nothing at all. With no song to play, the strips area says so and offers the ways back:
 * New song (store.addSong, then it plays: there is nothing else to play), the Song bank when packs have songs, and
 * Settings › Library & Backup (import a backup or an export). Frozen under Perform lock like every library change.
 * @param {object} v  the v6 view context (store, controller, ctx, toast, isLocked, openBank)
 * @returns {{el:HTMLElement, render(state:object):void, readonly shown:boolean, destroy():void}}
 */
export function emptyLibrary(v) {
  const { store, controller } = v;
  const d = disposer();
  const add = button(d, '.v6-empty-new', 'New song', { 'data-testid': 'v6-empty-new' });
  const bank = button(d, '.v6-empty-bank', 'Song bank…', { 'data-testid': 'v6-empty-bank' });
  const restore = button(d, '.v6-empty-restore', 'Restore a backup…', { 'data-testid': 'v6-empty-restore' });
  const lockLine = h('p.v6-empty-lock', { text: 'Perform lock is on: unlock to add a song.', hidden: true });
  const el = h('section.v6-empty', { 'data-testid': 'v6-empty', 'aria-label': 'No songs', hidden: true },
    h('b.v6-empty-t', { text: 'No songs in your library' }),
    h('p.v6-empty-p', { text: 'Make a new one, or bring your songs back from a backup or an exported file.' }),
    h('div.v6-empty-row', {}, add, bank, restore), lockLine);
  let shown = false;
  d.listen(add, 'click', () => {
    if (v.isLocked()) return;
    const id = store.addSong(null, { name: 'New Song' });
    if (id) controller.selectSong(id);
  });
  d.listen(bank, 'click', () => v.openBank?.({ mode: 'bank' }));
  d.listen(restore, 'click', () => v.ctx.openSettings?.({ section: 'backups' }));
  return {
    el,
    get shown() {
      return shown;
    },
    render(state) {
      shown = !state.songs[state.settings.currentSongId];
      el.hidden = !shown;
      if (!shown) return;
      const locked = !!state.settings.performLock;
      add.disabled = locked;
      lockLine.hidden = !locked;
      const p = typeof controller.patchPacks === 'function' ? controller.patchPacks() : null;
      bank.hidden = !(p && p.enabled && Number(p.bankSongs) > 0);
    },
    destroy: () => d.dispose(),
  };
}
