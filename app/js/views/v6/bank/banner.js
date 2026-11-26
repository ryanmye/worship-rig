// The "Trying …" banner over the v6 stage (UI v6 U7a, native DECISIONS D17; mockup song-bank.html "Trying a song",
// mock_bank.css .trybar). Shown while controller.trial() is set: a Song bank song plays as a trial and nothing is
// saved. Keep it · add to library = controller.keepTrial() (today's Add to library, then select it), Add to
// setlist ▾ = keepTrial({setlistId}), Back to <previous> = controller.backFromTrial() (the song, its setlist entry
// and its Revert snapshot). Perform lock: Keep and Add to setlist are frozen (adding songs is); Back stays live (a song
// change back, like GO).
import { h, setText, disposer } from '../../components/util.js';
import { button } from '../lib.js';
import { setlistMenu } from './bank.js';

/**
 * @param {object} v  the v6 view context (store, controller, toast, isLocked, host)
 * @returns {{el:HTMLElement, render():void, readonly shown:boolean, destroy():void}}
 */
export function trialBanner(v) {
  const { store, controller } = v;
  const d = disposer();
  const name = h('b.v6-try-name', { 'data-testid': 'v6-try-name' });
  const meta = h('small.v6-try-meta', { 'data-testid': 'v6-try-meta' });
  const keep = button(d, '.v6-try-keep', 'Keep it · add to library', { 'data-testid': 'v6-try-keep' });
  const addSet = button(d, '.v6-try-set', 'Add to setlist ▾', {
    'data-testid': 'v6-try-addset', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
  });
  const back = button(d, '.ghost.v6-try-back', 'Back', { 'data-testid': 'v6-try-back', 'data-overlay-pass': '' });
  const el = h('div.v6-trybar', { role: 'status', 'data-testid': 'v6-trybar', hidden: true },
    h('span.v6-try-dot', { 'aria-hidden': 'true' }), h('span.v6-try-text', {}, name, meta), keep, addSet, back);
  const toast = (m, kind = 'ok', o) => v.toast(m, kind, o);
  let busy = false;

  async function run(fn) {
    if (busy) return;
    busy = true;
    render();
    try {
      await fn();
    } finally {
      busy = false;
      render();
    }
  }
  const kept = (r, where) => {
    if (r && r.ok) {
      const s = store.getSong(r.id);
      const nm = s ? s.name : 'the song';
      toast(r.existing ? `“${nm}” is already in your library.` : `Added “${nm}” to your library${where}.`);
    } else if (r && r.error === 'perform-locked') toast('Perform lock is on: unlock to keep it.', 'warn');
    else if (r && r.error !== 'no-trial') toast((r && r.error) || 'The song could not be added.', 'error');
  };
  d.listen(keep, 'click', () => run(async () => kept(await controller.keepTrial(), '')));
  let pop = null;
  d.listen(addSet, 'click', () => {
    if (pop) return pop.close();
    if (v.isLocked() || !controller.trial()) return;
    pop = setlistMenu(v, addSet, {
      label: 'Keep it and add it to a setlist',
      pick: (slId) => run(async () => {
        const sl = store.get().setlists[slId];
        kept(await controller.keepTrial({ setlistId: slId }), sl ? ` and to ${sl.name}` : '');
      }),
      onClose: () => {
        pop = null;
      },
    });
  });
  d.listen(back, 'click', () => run(async () => {
    const gap = removedEntry();
    const r = await controller.backFromTrial();
    if (r && !r.ok && r.error !== 'no-trial') toast(r.error, 'error');
    else if (r && r.ok && gap) keepGap(gap);
  }));
  /**
   * UI6-U7a O2: where Back lands when the replaced song's setlist entry was removed during the trial. The rule: the
   * song it replaced plays again, between the entries around the removed one (the store's "gap": no row lit, Next =
   * the entry that followed it, Prev = the one before), exactly as if the entry had been removed while that song
   * played. Before, Back selected the song through selectSongId, which drops the gap: it landed on another copy of
   * the song in the list (a reprise, so Next went on from there), or on the song outside the list (Next = the top).
   * The saved selection already kept the gap (UI6-U7a F1); this reads it before Back and puts it back after.
   * @returns {{id:string, index:number, list:string|null}|null}
   */
  function removedEntry() {
    if (typeof store.trialReturn !== 'function' || typeof store.persisted !== 'function') return null;
    if (!store.trialReturn()) return null; // the trial song is not selected: Back goes to the remembered selection
    const st = store.persisted().settings;
    if (st.setlistGap !== true || !Number.isInteger(st.setlistIndex) || st.setlistIndex < 0) return null;
    return { id: st.currentSongId, index: st.setlistIndex, list: store.get().settings.currentSetlistId ?? null };
  }
  /** @param {{id:string, index:number, list:string|null}} g */
  function keepGap(g) {
    const st = store.get().settings;
    // only when Back went to that song in the same list (a deleted song: Back went on to the next one, no gap)
    if (st.currentSongId !== g.id || (st.currentSetlistId ?? null) !== g.list) return;
    if (g.index > store.navIds().length) return;
    store.set('settings.setlistIndex', g.index);
    store.set('settings.setlistGap', true);
  }

  function render() {
    const t = typeof controller.trial === 'function' ? controller.trial() : null;
    el.hidden = !t;
    if (!t) {
      pop?.close();
      return;
    }
    setText(name, `Trying “${t.title}”`);
    const bits = ['from the Song bank', t.key, t.bpm ? `${t.bpm} bpm` : null, 'nothing saved yet'].filter(Boolean);
    setText(meta, bits.join(' · '));
    setText(back, t.prev ? `Back to ${t.prev.name}` : 'Back');
    const locked = v.isLocked();
    keep.disabled = locked || busy;
    addSet.disabled = locked || busy || !store.get().setlistOrder.length;
    const hint = locked ? 'Perform lock is on: unlock to keep it' : undefined;
    for (const b of [keep, addSet]) {
      if (hint) b.title = hint;
      else b.removeAttribute('title');
    }
    back.disabled = busy;
    if (locked) pop?.close();
  }
  d.listen(controller, 'trial', () => render());
  d.add(store.subscribe(() => {
    if (!el.hidden || (typeof controller.trial === 'function' && controller.trial())) render();
  }));
  render();
  return {
    el,
    render,
    get shown() {
      return !el.hidden;
    },
    destroy() {
      pop?.close();
      d.dispose();
      el.remove();
    },
  };
}
