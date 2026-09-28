// setlistStrip(): horizontal setlist with the current song highlighted, a loading state, click-to-jump and
// (unless locked) drag / Alt+←→ reordering (SPEC §13).
import { h, setText, disposer } from './util.js';

/**
 * @param {{onSelect?:(id:string, index:number)=>void, onReorder?:(from:number, to:number)=>void, label?:string,
 *          dragNeedsAlt?:boolean}} o   dragNeedsAlt: mouse-drag reordering only with Alt held (Perform, UX S2)
 * set({ songs:[{id,name,key?}], currentId, currentIndex?, gap?, loadingId?, reorderable? })
 *   gap: index where the current entry was removed (store "setlist gap": Next plays songs[gap]); null = no gap.
 *   While set, no chip is current (not even a reprise of the removed song) and a marker shows the position.
 * One tab stop (the current chip); ←/→ move focus between chips, Enter/Space selects, Alt+←/→ reorders.
 */
export function setlistStrip(o = {}) {
  const d = disposer();
  const list = h('ol.setlist-list');
  const el = h('nav.setlist-strip', { 'aria-label': o.label || 'Setlist' }, list);
  let chips = [];
  let sig = '';
  let state = { songs: [], currentId: null, currentIndex: -1, gap: null, loadingId: null, reorderable: true };
  const gapAt = () => (Number.isInteger(state.gap) && state.gap >= 0 ? state.gap : -1);
  let dragFrom = -1;

  const curIndex = () => {
    const { songs, currentId, currentIndex } = state;
    if (gapAt() >= 0) return -1; // round2-ui #4: never fall back to a reprise of the removed song
    if (Number.isInteger(currentIndex) && currentIndex >= 0 && songs[currentIndex]?.id === currentId) return currentIndex;
    return songs.findIndex((s) => s.id === currentId);
  };

  const build = () => {
    list.replaceChildren();
    chips = state.songs.map((s, i) => {
      const num = h('span.chip-num', { text: String(i + 1) });
      const name = h('span.chip-name', { text: s.name || 'Untitled' });
      const key = h('span.chip-key', { text: s.key || '' });
      const btn = h('button.setlist-chip', { type: 'button', dataset: { id: s.id, index: String(i) }, title: s.name }, num, name, key, h('span.chip-spinner', { 'aria-hidden': 'true' }));
      btn.addEventListener('click', (ev) => {
        if (typeof o.onSelect === 'function') o.onSelect(s.id, i);
        if (ev.detail > 0) queueMicrotask(() => btn.blur());
      });
      btn.addEventListener('keydown', (ev) => {
        if (!ev.altKey && !ev.metaKey && !ev.ctrlKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'Home' || ev.key === 'End')) {
          const j = ev.key === 'Home' ? 0 : ev.key === 'End' ? chips.length - 1 : i + (ev.key === 'ArrowLeft' ? -1 : 1);
          ev.preventDefault();
          ev.stopPropagation(); // arrows move focus inside the strip; they don't switch songs here
          if (chips[j]) {
            for (const c of chips) c.btn.tabIndex = -1;
            chips[j].btn.tabIndex = 0;
            chips[j].btn.focus();
          }
          return;
        }
        if (!ev.altKey || !state.reorderable || typeof o.onReorder !== 'function') return;
        const to = ev.key === 'ArrowLeft' ? i - 1 : ev.key === 'ArrowRight' ? i + 1 : -2;
        if (to < -1 || to < 0 || to >= state.songs.length) return;
        ev.preventDefault();
        ev.stopPropagation();
        o.onReorder(i, to);
        queueMicrotask(() => chips[to]?.btn.focus());
      });
      btn.addEventListener('dragstart', (ev) => {
        if (!state.reorderable || (o.dragNeedsAlt && !ev.altKey)) {
          ev.preventDefault();
          return;
        }
        dragFrom = i;
        btn.classList.add('dragging');
        try {
          ev.dataTransfer.effectAllowed = 'move';
          ev.dataTransfer.setData('text/plain', String(i));
        } catch {
          /* ignore */
        }
      });
      btn.addEventListener('dragend', () => {
        dragFrom = -1;
        btn.classList.remove('dragging');
        for (const c of chips) c.li.classList.remove('drop-before', 'drop-after');
      });
      const li = h('li.setlist-item', {}, btn);
      li.addEventListener('dragover', (ev) => {
        if (dragFrom < 0 || !state.reorderable) return;
        ev.preventDefault();
        const r = li.getBoundingClientRect();
        const after = ev.clientX > r.left + r.width / 2;
        li.classList.toggle('drop-after', after);
        li.classList.toggle('drop-before', !after);
      });
      li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'));
      li.addEventListener('drop', (ev) => {
        if (dragFrom < 0 || !state.reorderable) return;
        ev.preventDefault();
        const r = li.getBoundingClientRect();
        const after = ev.clientX > r.left + r.width / 2;
        let to = i + (after ? 1 : 0);
        if (dragFrom < to) to -= 1;
        li.classList.remove('drop-before', 'drop-after');
        if (to !== dragFrom && typeof o.onReorder === 'function') o.onReorder(dragFrom, to);
        dragFrom = -1;
      });
      list.append(li);
      return { li, btn, name, key };
    });
  };

  const render = (scroll) => {
    const ci = curIndex();
    const gap = gapAt();
    const focusInside = el.contains(document.activeElement);
    chips.forEach((c, i) => {
      const s = state.songs[i];
      const cur = i === ci;
      c.li.classList.toggle('gap-before', gap >= 0 && i === gap);
      c.li.classList.toggle('gap-after', gap >= 0 && gap >= chips.length && i === chips.length - 1);
      c.btn.classList.toggle('current', cur);
      if (cur) c.btn.setAttribute('aria-current', 'true');
      else c.btn.removeAttribute('aria-current');
      c.btn.classList.toggle('loading', !!state.loadingId && s.id === state.loadingId && (cur || ci < 0));
      c.btn.draggable = !!state.reorderable;
      if (!focusInside) c.btn.tabIndex = cur || (ci < 0 && i === 0) ? 0 : -1;
    });
    if (gap >= 0) el.dataset.gap = String(gap);
    else delete el.dataset.gap;
    el.classList.toggle('locked', !state.reorderable);
    if (scroll) scrollToCurrent();
  };
  /** Keep the current chip in the left third so the next two songs stay visible (UX M8). */
  const scrollToCurrent = () => {
    const gap = gapAt();
    const ci = gap >= 0 ? Math.min(gap, chips.length - 1) : curIndex(); // a gap is scrolled to like a current chip
    if (ci < 0 || !chips[ci]) return;
    const li = chips[ci].li;
    const L = li.offsetLeft - list.offsetLeft;
    const target = Math.max(0, Math.min(L - Math.max(8, el.clientWidth * 0.12), el.scrollWidth - el.clientWidth));
    if (Math.abs(el.scrollLeft - target) > 1) el.scrollLeft = target;
  };
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => scrollToCurrent());
    ro.observe(el);
    d.add(() => ro.disconnect());
  }

  d.add(() => list.replaceChildren());
  return {
    el,
    set(v = {}) {
      const prevCur = curIndex();
      const prevGap = gapAt();
      state = { ...state, ...v, songs: v.songs || state.songs };
      const nsig = state.songs.map((s) => `${s.id}\u0001${s.name}\u0001${s.key || ''}`).join('\u0002');
      if (nsig !== sig) {
        // names/keys only → patch in place; different ids/order → rebuild
        const sameIds = chips.length === state.songs.length && state.songs.every((s, i) => chips[i].btn.dataset.id === s.id);
        if (sameIds) {
          state.songs.forEach((s, i) => {
            setText(chips[i].name, s.name || 'Untitled');
            setText(chips[i].key, s.key || '');
            chips[i].btn.title = s.name || '';
          });
        } else build();
        sig = nsig;
      }
      render(prevCur !== curIndex() || prevGap !== gapAt() || v.scroll === true);
    },
    destroy() {
      d.dispose();
      el.remove();
    },
  };
}
