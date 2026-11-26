// UI v6 strips row (D16; UI6-build-plan U1): one strip per instrument plus "+ Add instrument". Up to five share the
// row; with more, the strips keep the five-across width and the row scrolls sideways, and a row of name pills above it
// shows every instrument (lit = fully on screen) and scrolls to one on a tap.
import { h, setText, disposer, rafCoalesce } from '../components/util.js';
import { MAX_SLOTS } from '../../shared/params.js';
import { createStrip } from './strip.js';
import { slotColor, button, icon, STRIPS_ACROSS } from './lib.js';

/**
 * @param {object} v  the v6 shell's view context
 * @returns {{el:HTMLElement, render(x:object):void, setWheel(fs:Array<number|null>):void, cancelDrags():void,
 *            closePanels():void, readonly strips:object[], destroy():void}}
 */
export function stripsRow(v) {
  const d = disposer();
  const strips = [];
  const pills = [];
  const addLabel = [h('span.v6-add-plus', {}, icon('plus', 22)), h('span.v6-add-t', { text: 'Add instrument' })];
  const addBtn = button(d, '.v6-add', addLabel, {
    'data-testid': 'v6-add', 'aria-label': 'Add instrument',
  });
  d.listen(addBtn, 'click', () => v.addSlot());
  const row = h('div.v6-strips', { 'data-testid': 'v6-strips', role: 'group', 'aria-label': 'Instruments' }, addBtn);
  const pillsEl = h('div.v6-pills', { hidden: true, 'data-testid': 'v6-pills', role: 'group',
    'aria-label': 'All instruments; tap one to scroll to it' });
  const pillsHint = h('span.v6-pills-h', { text: '' });
  pillsEl.append(pillsHint);
  const el = h('div.v6-stripsarea', {}, pillsEl, h('div.v6-sfade', {}, row));
  let n = 0;
  let shownFor = null;
  let slotsSig = '';
  let picked = null; // U2: the strip whose range is being changed (coarse pointers)
  let coarse = false;

  function ensure(k) {
    while (strips.length < Math.min(MAX_SLOTS, k)) {
      const i = strips.length;
      const s = createStrip(v, i);
      strips.push(s);
      s.setCoarse(coarse);
      s.setPicked(picked === i);
      row.insertBefore(s.el, addBtn);
      // a 44 px button around the 28 px pill (DESIGN_PHILOSOPHY: targets ≥ 44 px)
      const p = h('button.v6-pill', { type: 'button', 'data-testid': `v6-pill-${i}`, style: { '--c': slotColor(i) } },
        h('span.v6-pill-t'));
      d.listen(p, 'click', () => scrollTo(i));
      pills.push(p);
      pillsEl.insertBefore(p, pillsHint);
    }
  }
  function scrollTo(i) {
    const s = strips[i];
    if (!s) return;
    const left = s.el.offsetLeft - row.offsetLeft - (i ? 10 : 0);
    row.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
  }
  // which strips are fully on screen (pills lit), and whether the row can still scroll right (the soft edge)
  const visible = rafCoalesce(() => {
    const a = row.scrollLeft;
    const b = a + row.clientWidth;
    for (let i = 0; i < n; i++) {
      const s = strips[i].el;
      const x = s.offsetLeft - row.offsetLeft;
      const on = x >= a - 4 && x + s.offsetWidth <= b + 4;
      if (pills[i].classList.contains('vis') !== on) pills[i].classList.toggle('vis', on);
      pills[i].setAttribute('aria-pressed', String(on));
    }
    el.classList.toggle('atend', b >= row.scrollWidth - 4);
  });
  d.add(() => visible.cancel());
  d.listen(row, 'scroll', () => visible.push(), { passive: true });
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => visible.push());
    ro.observe(row);
    d.add(() => ro.disconnect());
  }

  /**
   * @param {{song:object|null, base:object|null, changed:Set<string>, locked:boolean, names:object,
   *          playable:number, wheel:(i:number) => number|null}} x
   */
  function render(x) {
    const song = x.song;
    n = song ? Math.min(MAX_SLOTS, song.patch.slots.length) : 0;
    // skeptic UI6-U1 F2: an Add / Remove / Duplicate (here, in Edit, or by any store write) moves which instrument
    // sits at each position. A ⋯ menu or step panel opened on the old one would act on its neighbour (or on a hidden
    // strip), so they close whenever the song's slot count changes.
    const sig = song ? `${song.id}:${n}` : '';
    if (sig !== slotsSig) {
      if (slotsSig) for (const S of strips) S.closePanels();
      slotsSig = sig;
    }
    ensure(n);
    const scroll = n > STRIPS_ACROSS;
    el.classList.toggle('scroll', scroll);
    el.classList.toggle('few', n < 4);
    el.dataset.n = String(n);
    pillsEl.hidden = !scroll;
    for (let i = 0; i < strips.length; i++) {
      const S = strips[i];
      const on = i < n;
      S.el.hidden = !on;
      pills[i].hidden = !on;
      if (!on) continue;
      const slot = song.patch.slots[i];
      const nm = slot ? x.names.name(slot.instrument) : 'Empty';
      S.render({
        slot,
        base: x.base?.patch.slots[i] || null,
        changed: x.changed,
        name: nm,
        title: slot ? x.names.full(slot.instrument) : '',
        silent: i >= x.playable,
        n,
        locked: x.locked,
        wheel: slot ? x.wheel(i) : null,
      });
      setText(pills[i].firstChild, nm);
      pills[i].title = `Scroll to ${nm}`;
    }
    setText(pillsHint, scroll ? `${n} instruments · scroll ⟷` : '');
    addBtn.hidden = !song;
    addBtn.disabled = x.locked || n >= MAX_SLOTS;
    addBtn.title = x.locked ? 'Perform lock is on: unlock to add an instrument'
      : n >= MAX_SLOTS ? `${MAX_SLOTS} is the most a song can have` : 'Add an instrument, then pick its sound';
    addBtn.classList.toggle('slim', n >= STRIPS_ACROSS);
    const key = song ? song.id : null;
    if (key !== shownFor) {
      shownFor = key;
      if (row.scrollLeft) row.scrollLeft = 0; // a song switch starts the row at its first instrument
    }
    visible.push();
  }

  return {
    el,
    render,
    get strips() {
      return strips.slice(0, n);
    },
    setWheel(fs) {
      for (let i = 0; i < n; i++) strips[i].setWheel(fs[i] ?? null);
    },
    cancelDrags() {
      for (const s of strips) s.cancelDrag();
    },
    /** U2: the strip whose range the coarse pointer is changing (null: none). */
    setPicked(i) {
      picked = i;
      strips.forEach((s, k) => s.setPicked(k === i));
      // a bar tapped on the keyboard can pick a strip scrolled out of view
      if (i !== null && i < n) {
        const x = strips[i].el.offsetLeft - row.offsetLeft;
        if (x < row.scrollLeft || x + strips[i].el.offsetWidth > row.scrollLeft + row.clientWidth) scrollTo(i);
      }
    },
    /** U2: names become pick buttons on a coarse pointer. */
    setCoarse(c) {
      coarse = !!c;
      for (const s of strips) s.setCoarse(coarse);
    },
    closePanels() {
      for (const s of strips) s.closePanels();
    },
    destroy() {
      d.dispose();
      for (const s of strips.splice(0)) s.destroy();
      el.remove();
    },
  };
}
