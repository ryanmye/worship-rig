// The "Trying …" banner over the v6 stage (UI v6 U7a, native DECISIONS D17; mockup song-bank.html "Trying a song",
// mock_bank.css .trybar). Shown while controller.trial() is set: a Song bank song plays as a trial and nothing is
// saved. Keep it · add to library = controller.keepTrial() (today's Add to library, then select it), Add to
// setlist ▾ = keepTrial({setlistId}), Back to <previous> = controller.backFromTrial() (the song, its setlist entry
// or its gap, and its Revert snapshot; from a trial begun in an empty library: the empty library again). Perform
// lock: Keep and Add to setlist are frozen (adding songs is); Back stays live (a song change back, like GO).
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
    else if (r && r.error !== 'no-trial' && !r.notified) { // CAP: a 'library-full' refusal is toasted already
      toast((r && r.error) || 'The song could not be added.', 'error');
    }
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
  // Back = controller.backFromTrial(), which also keeps a removed entry's gap (UI6-U7a O2; moved into the controller
  // by polish batch 2 so every Back follows it) and ends a trial begun in an empty library (UI6-U8a O1)
  d.listen(back, 'click', () => run(async () => {
    const r = await controller.backFromTrial();
    if (r && !r.ok && r.error !== 'no-trial') toast(r.error, 'error');
  }));

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
