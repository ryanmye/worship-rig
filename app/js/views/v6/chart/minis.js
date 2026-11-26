// UI v6 mini faders (D16 "Chart placement": on the stage the instruments become live mini faders; UI6-build-plan U7b;
// mockup chart.html mini_strips(), "iPad portrait (music stand)"). One per instrument: ON tile, level fader with its
// dB, name; the same writes as the strip (views/v6/strip.js through the v6 Perform's view context: v.setMuted →
// slots.<i>.muted, v.setSlotGain → slots.<i>.gain, both through controller.scenes.adjust while a snapshot plays), and
// live under Lock as the strip's are. Vertical columns beside the chart (landscape), a row above it (portrait).
import { h, setText, disposer } from '../../components/util.js';
import { fader } from '../../components/fader.js';
import { onTile } from '../../components/onTile.js';
import { MAX_SLOTS } from '../../../shared/params.js';
import { slotMuteState } from '../../perform.js';
import { slotColor, button } from '../lib.js';

/**
 * @param {object} v  the v6 Perform's view context (store, liveOf, setMuted, setSlotGain)
 * @param {{name(ref:object|null):string, full(ref:object|null):string}} names  instrument names (perform.js)
 * @param {{vertical:boolean, onStrips:() => void}} o  vertical faders (landscape) or across (portrait); ▤ Strips
 * @returns {{el:HTMLElement, render():void, cancelDrags():void, readonly count:number, destroy():void}}
 */
export function miniFaders(v, names, o) {
  const d = disposer();
  const minis = [];
  const list = h('div.v6-minis-list', { role: 'group', 'aria-label': 'Instrument levels' });
  const stripsBtn = button(d, '.v6-minis-back', '▤ Strips', {
    'data-testid': 'v6-chart-strips', title: 'Back to the instrument strips (the chart stays a tap away)',
  });
  d.listen(stripsBtn, 'click', () => o.onStrips());
  const el = h(`div.v6-minis${o.vertical ? '.cols' : '.row'}`, { 'data-testid': 'v6-minis' }, list, stripsBtn);
  let n = 0;

  function make(i) {
    const color = slotColor(i);
    const tile = onTile({ label: 'Instrument', color, testid: `v6-mini-on-${i}`, className: 'v6-mini-on',
      onToggle: (on) => v.setMuted(i, !on) });
    const f = fader({
      path: `slots.${i}.gain`, label: 'Level', vertical: o.vertical, relative: true, resetOnDoubleClick: false, color,
      onChange: (x) => v.setSlotGain(i, x),
    });
    f.el.dataset.testid = `v6-mini-fader-${i}`;
    const nm = h('span.v6-mini-nm', { 'data-testid': `v6-mini-name-${i}` });
    const m = h('div.v6-mini', { 'data-testid': `v6-mini-${i}`, dataset: { slot: String(i) }, style: { '--c': color } },
      tile.el, f.el, nm);
    return { el: m, tile, f, nm, destroy: () => (tile.destroy?.(), f.destroy()) };
  }

  function render() {
    const song = v.liveOf(v.store.currentSong());
    n = song ? Math.min(MAX_SLOTS, song.patch.slots.length) : 0;
    while (minis.length < n) {
      const m = make(minis.length);
      minis.push(m);
      list.append(m.el);
    }
    minis.forEach((m, i) => {
      m.el.hidden = i >= n;
      if (i >= n) return;
      const slot = song.patch.slots[i];
      const name = slot ? names.name(slot.instrument) : 'Empty';
      setText(m.nm, name);
      m.nm.title = slot ? names.full(slot.instrument) : 'No instrument yet';
      m.tile.setLabel(name);
      m.f.setLabel(`${name} level`);
      m.el.classList.toggle('empty', !slot);
      m.tile.setDisabled?.(!slot);
      m.f.setDisabled(!slot);
      if (!slot) {
        m.tile.set(true);
        m.f.set(0);
        m.f.setMuted(false);
        m.el.classList.remove('muted');
        return;
      }
      const { muted, level } = slotMuteState(slot);
      m.f.set(level);
      m.f.setMuted(muted);
      m.tile.set(!muted);
      m.el.classList.toggle('muted', muted);
    });
    el.dataset.n = String(n);
  }

  render();
  return {
    el,
    render,
    /** A song switch must not carry a hand on a fader into the next song (perform.js round2-ui #2). */
    cancelDrags() {
      for (const m of minis) m.f.cancelDrag?.();
    },
    get count() {
      return n;
    },
    destroy() {
      d.dispose();
      for (const m of minis.splice(0)) m.destroy();
      el.remove();
    },
  };
}
