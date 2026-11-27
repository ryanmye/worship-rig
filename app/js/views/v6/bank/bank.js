// Song bank browser (UI v6 U7a, native DECISIONS D17; mockup native/docs/design/mockups/song-bank.html, generator
// mock_bank.py / mock_bank.css). Opens over the v6 stage's strips and sidebar (perform.js openBank); the left panel,
// the keyboard row, Revert / Fade out / PANIC / Lock stay live. Header (title, count, Song bank | My library, ×),
// filters (search: searchBank's rules; Key; Tempo; Feel tags; Packs), list, detail, actions.
//  - Song bank: Try it = controller.tryBankSong (a trial: nothing saved; perform.js shows the banner), Add to library
//    = controller.addFromBank (today's Settings add), Add to setlist ▾ = add to library, then store.addToSetlist.
//  - My library: the player's songs; Try it = switch to that song (controller.selectSong), Add to setlist ▾.
// Perform lock (perform.js LOCK: song changes from Edit / Settings and adding songs are frozen): browsing stays, the
// actions are disabled. An overlay (overlay.js): Esc closes it; taps outside (keys, PANIC) do not.
import { h, setText, disposer, rafCoalesce } from '../../components/util.js';
import { openOverlay } from '../../components/overlay.js';
import { keyName } from '../../../shared/music.js';
import { button, popover, slotColor, instrumentNames } from '../lib.js';
import {
  TEMPO_BANDS, alsoIn, instrumentsOf, bankRow, libraryRow, keyOptions, tagOptions, packOptions, filterRows,
} from './model.js';

const LOCK_HINT = 'Perform lock is on: unlock to try or add songs';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * @param {object} v  the v6 view context (store, controller, engine, toast, isLocked, host)
 * @param {{onClose?:(reason:string) => void}} [o]
 * @returns {{el:HTMLElement, open(o?:{mode?:'bank'|'library', focus?:boolean}):void, close(reason?:string):void,
 *   readonly isOpen:boolean, readonly mode:string, readonly rows:object[], readonly selected:string|null,
 *   select(id:string):void, setFilter(f:object):void, destroy():void}}
 */
export function songBank(v, o = {}) {
  const { store, controller } = v;
  const d = disposer();
  const names = instrumentNames(v.engine);
  let mode = 'bank';
  let isOpen = false;
  let closeOverlay = null;
  let selected = null;
  const f = { q: '', key: 'any', tempo: 'any', tags: new Set(), packsOff: new Set() };
  let rowsAll = [];
  let rows = [];
  const previews = new Map(); // packId → the song as the library would take it (dropped on 'user-patches')

  // ---------------------------------------------------------------- DOM
  const title = h('h2.v6-bank-t', { text: 'Song bank', id: 'v6-bank-title' });
  const count = h('small.v6-bank-n', { 'data-testid': 'v6-bank-count' });
  const tBank = button(d, '.v6-bank-mode', 'Song bank', { 'aria-pressed': 'true', 'data-testid': 'v6-bank-mode-bank' });
  const tLib = button(d, '.v6-bank-mode', 'My library', { 'aria-pressed': 'false', 'data-testid': 'v6-bank-mode-lib' });
  const closeBtn = button(d, '.v6-bank-x', '×', {
    'aria-label': 'Close the Song bank', 'data-testid': 'v6-bank-close',
  });
  const head = h('div.v6-bank-h', {}, title, count,
    h('div.v6-bank-modes', { role: 'group', 'aria-label': 'Browse' }, tBank, tLib), closeBtn);

  const search = h('input.v6-bank-q', {
    type: 'search', placeholder: 'Search title or artist', 'aria-label': 'Search the Song bank',
    'data-testid': 'v6-bank-search', autocomplete: 'off', spellcheck: 'false',
  });
  const keys = h('div.v6-bank-keys', { role: 'group', 'aria-label': 'Key' });
  const tempos = h('div.v6-bank-tempo', { role: 'group', 'aria-label': 'Tempo' });
  const feel = h('div.v6-bank-feel', { role: 'group', 'aria-label': 'Feel' });
  const packs = h('div.v6-bank-packs', { role: 'group', 'aria-label': 'Packs' });
  const grp = (label, body, cls) => h(`div.v6-bank-grp.${cls}`, {}, h('span.v6-cap', { text: label }), body);
  const gKey = grp('Key', keys, 'g-key');
  const gTempo = grp('Tempo', tempos, 'g-tempo');
  const gFeel = grp('Feel', feel, 'g-feel');
  const gPacks = grp('Packs', packs, 'g-packs');
  const filters = h('div.v6-bank-fil', { 'data-testid': 'v6-bank-filters' },
    h('label.v6-bank-search', {}, h('span', { text: '⌕', 'aria-hidden': 'true' }), search),
    gKey, gTempo, gFeel, gPacks);

  const listHead = h('div.v6-bank-lh', { 'aria-hidden': 'true' }, h('span', { text: 'Song' }), h('span'),
    h('span', { text: 'Key' }), h('span', { text: 'BPM' }));
  const list = h('div.v6-bank-rows', { role: 'listbox', 'aria-label': 'Songs', 'data-testid': 'v6-bank-list' });
  const listBox = h('div.v6-bank-list', {}, listHead, list);

  const detail = h('div.v6-bank-det', { 'data-testid': 'v6-bank-detail', 'aria-live': 'polite' });
  const body = h('div.v6-bank-b', {}, filters, listBox, detail);
  const el = h('div.v6-bank', {
    role: 'dialog', 'aria-labelledby': 'v6-bank-title', 'data-testid': 'v6-bank', 'data-perform-overlay': '',
    hidden: true,
  }, head, body);

  // ---------------------------------------------------------------- data
  const patchPacks = () => {
    try {
      return typeof controller.patchPacks === 'function' ? controller.patchPacks() : null;
    } catch {
      return null;
    }
  };
  const preview = (packId) => {
    if (!previews.has(packId)) {
      previews.set(packId, typeof controller.bankSong === 'function' ? controller.bankSong(packId) : null);
    }
    return previews.get(packId);
  };
  function buildRows() {
    if (mode === 'bank') {
      const p = patchPacks();
      const list0 = p && p.enabled && Array.isArray(p.bank) ? p.bank : [];
      const packNames = {};
      for (const pk of (p && p.packList) || []) if (pk && pk.slug) packNames[pk.slug] = pk.name || pk.slug;
      return list0.map((it) => bankRow(it, preview(it.packId), packNames));
    }
    const st = store.get();
    const p = patchPacks();
    const items = new Map(((p && p.bank) || []).map((it) => [it.packId, it]));
    return st.songOrder.map((id) => st.songs[id]).filter(Boolean).map((s) => {
      const packId = typeof store.packIdOf === 'function' ? store.packIdOf(s.id) : null;
      return libraryRow(s, { packId, item: packId ? items.get(packId) : null });
    });
  }

  // ---------------------------------------------------------------- render
  const pressed = (b, on) => b.setAttribute('aria-pressed', String(!!on));
  function renderFilters() {
    const kopts = keyOptions(rowsAll);
    if (f.key !== 'any' && !kopts.includes(f.key)) f.key = 'any';
    keys.replaceChildren(...['any', ...kopts].map((k) => {
      const b = button(d, '.v6-bank-k', k === 'any' ? 'Any' : k, { 'data-key': k, 'data-testid': `v6-bank-key-${k}` });
      pressed(b, f.key === k);
      return b;
    }));
    tempos.replaceChildren(...[{ id: 'any', label: 'Any' }, ...TEMPO_BANDS].map((t) => {
      const b = button(d, '.v6-bank-sp', t.label, {
        'data-tempo': t.id, 'data-testid': `v6-bank-tempo-${t.id}`,
        title: t.id === 'any' ? 'Any tempo' : `${t.min}${t.max === Infinity ? '+' : `–${t.max - 1}`} BPM`,
      });
      pressed(b, f.tempo === t.id);
      return b;
    }));
    const topts = tagOptions(rowsAll);
    for (const t of [...f.tags]) if (!topts.some((x) => x.tag === t)) f.tags.delete(t);
    feel.replaceChildren(...topts.map(({ tag }) => {
      const b = button(d, '.chip.v6-bank-tag', tag, { 'data-tag': tag, 'data-testid': `v6-bank-tag-${tag}` });
      pressed(b, f.tags.has(tag));
      return b;
    }));
    gFeel.hidden = !topts.length;
    const popts = mode === 'bank' ? packOptions(rowsAll) : [];
    packs.replaceChildren(...popts.map((pk) => {
      const cb = h('input', { type: 'checkbox', 'data-pack': pk.slug, 'data-testid': `v6-bank-pack-${pk.slug}` });
      cb.checked = !f.packsOff.has(pk.slug);
      return h('label.v6-bank-pk', {}, cb, h('span', { text: pk.name }), h('small', { text: String(pk.n) }));
    }));
    gPacks.hidden = popts.length < 1;
  }
  function renderHead() {
    setText(title, mode === 'bank' ? 'Song bank' : 'My library');
    pressed(tBank, mode === 'bank');
    pressed(tLib, mode === 'library');
    tBank.classList.toggle('on', mode === 'bank');
    tLib.classList.toggle('on', mode === 'library');
    search.setAttribute('aria-label', mode === 'bank' ? 'Search the Song bank' : 'Search your library');
    if (mode === 'bank') {
      const n = new Set(rowsAll.map((r) => r.pack)).size;
      setText(count, rowsAll.length ? `${plural(rowsAll.length, 'song')} from ${plural(n, 'pack')} in My Samples`
        : 'no bank packs in My Samples');
    } else setText(count, `${plural(rowsAll.length, 'song')} in your library`);
  }
  function renderList() {
    rows = filterRows(rowsAll, f);
    if (!rows.some((r) => r.id === selected)) selected = rows[0] ? rows[0].id : null;
    const cur = store.get().settings.currentSongId;
    const items = rows.map((r) => {
      const badge = r.kind === 'bank' && r.inLibrary ? h('span.v6-bank-badge', { text: 'In library' })
        : r.kind === 'lib' && r.id === cur ? h('span.v6-bank-badge', { text: 'Playing' }) : null;
      const inst = instrumentsOf(r.song, names.name);
      return h('button.v6-bank-row', {
        type: 'button', role: 'option', 'data-id': r.id, 'data-testid': `v6-bank-row-${r.id}`,
        'aria-selected': String(r.id === selected), class: r.id === selected ? 'sel' : '',
      }, h('span.v6-bank-rt', {}, h('b', {}, r.title, badge), h('small', { text: r.artist || '' })),
      h('span.v6-bank-dots', { title: plural(inst.length, 'instrument') },
        ...inst.map((x) => h('i', { style: { background: slotColor(x.i) } }))),
      h('span.v6-bank-key', { text: r.key || '' }), h('span.v6-bank-bpm', { text: r.bpm ?? '' }));
    });
    if (!items.length) {
      const empty = !rowsAll.length;
      const msg = mode === 'bank' && empty
        ? 'No Song bank songs yet. A patch pack set to “bank” in My Samples adds them (docs: patch packs).'
        : empty ? 'Your library is empty.' : 'No song matches.';
      const clear = !empty ? button(d, '.ghost.v6-bank-clear', 'Clear filters', { 'data-testid': 'v6-bank-clear' })
        : null;
      items.push(h('div.v6-bank-none', { 'data-testid': 'v6-bank-none' }, h('p', { text: msg }), clear));
    }
    list.replaceChildren(...items);
    renderDetail();
  }
  function markSelected() {
    for (const b of list.querySelectorAll('.v6-bank-row')) {
      const on = b.dataset.id === selected;
      b.classList.toggle('sel', on);
      b.setAttribute('aria-selected', String(on));
    }
    renderDetail();
  }
  let detailRender = null;
  function renderDetail() {
    detailRender = null;
    const r = rows.find((x) => x.id === selected);
    if (!r) {
      detail.replaceChildren();
      return;
    }
    const locked = v.isLocked();
    const song = r.song;
    const inst = instrumentsOf(song, names.name);
    const by = r.kind === 'bank'
      ? [r.artist, h('span', {}, 'from ', h('b', { text: r.pack ? packLabel(r) : 'the Song bank' }))]
      : [r.artist, setlistsOf(r.id)];
    const fact = (label, value, small) => h('span.v6-bank-fact', {}, h('small', { text: label }),
      h('b', { text: value }), small ? h('em', { text: small }) : null);
    const orig = r.originalKey && r.originalKey !== r.key ? `original ${r.originalKey}` : '';
    const scenes = song && Array.isArray(song.scenes) ? song.scenes.length : 0;
    const also = alsoIn(song);
    const tryBtn = button(d, '.v6-bank-try', [h('b', { text: '▶ Try it' }),
      h('small', { text: r.kind === 'bank' ? 'play it now; nothing is saved' : 'switch to this song now' })], {
      'data-testid': 'v6-bank-try',
      disabled: locked || (r.kind === 'lib' && r.id === store.get().settings.currentSongId),
      title: locked ? LOCK_HINT : undefined,
    });
    const acts = [tryBtn];
    if (r.kind === 'bank') {
      acts.push(button(d, '.v6-bank-add', r.inLibrary ? 'In library' : 'Add to library', {
        'data-testid': 'v6-bank-addlib', disabled: locked || !!r.inLibrary,
        'aria-label': r.inLibrary ? `${r.title}: in library` : `Add ${r.title} to library`,
        title: locked ? LOCK_HINT : undefined,
      }));
    }
    const setBtn = button(d, '.v6-bank-set', 'Add to setlist ▾', {
      'data-testid': 'v6-bank-addset', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
      disabled: locked || !store.get().setlistOrder.length,
      title: locked ? LOCK_HINT : !store.get().setlistOrder.length ? 'No setlists yet: make one in Edit' : undefined,
    });
    acts.push(setBtn);
    // the facts scroll; the actions stay at the bottom (a short window must never push Try it out of sight)
    const info = h('div.v6-bank-dinfo', {},
      h('h3.v6-bank-dt', { text: r.title }),
      h('p.v6-bank-by', {}, ...by.filter(Boolean).flatMap((x, i) => (i ? [' · ', x] : [x]))),
      h('div.v6-bank-facts', {}, fact('Key', r.key || '—', orig), fact('Tempo', r.bpm ? String(r.bpm) : '—'),
        fact('Time', r.timeSig || '4/4'), fact('Snapshots', String(scenes))),
      h('span.v6-cap', { text: 'Instruments' }),
      h('div.v6-bank-insts', { 'data-testid': 'v6-bank-insts' }, ...inst.map((x) => h('div.v6-bank-inst', {
        style: { '--c': slotColor(x.i) },
      }, h('i'), h('span', { text: x.name })))),
      also.length ? h('span.v6-cap', { text: 'Also in this song' }) : null,
      also.length ? h('p.v6-bank-also', { 'data-testid': 'v6-bank-also', text: also.join(' · ') }) : null,
      r.tags.length ? h('div.v6-bank-tags', {}, ...r.tags.map((t) => h('span.v6-bank-tg', { text: t }))) : null,
      locked ? h('p.v6-bank-lock', { text: 'Perform lock is on: browse only. Hold Lock to unlock.' }) : null);
    detail.replaceChildren(info, h('div.v6-bank-acts', { class: r.kind === 'lib' ? 'lib' : '' }, ...acts));
    detailRender = r;
  }
  const packLabel = (r) => r.packName || r.pack;
  /** "in My Set, Christmas" for a library song (or nothing). */
  function setlistsOf(id) {
    const st = store.get();
    const inSets = st.setlistOrder.map((k) => st.setlists[k]).filter((sl) => sl && sl.songIds.includes(id))
      .map((sl) => sl.name);
    return inSets.length ? `in ${inSets.join(', ')}` : 'in no setlist';
  }
  function renderAll() {
    rowsAll = buildRows();
    renderHead();
    renderFilters();
    renderList();
  }

  // ---------------------------------------------------------------- actions
  const toast = (m, kind = 'ok', opts) => v.toast(m, kind, opts);
  const cur = () => rows.find((x) => x.id === selected) || null;
  async function tryIt() {
    const r = cur();
    if (!r || v.isLocked()) return;
    if (r.kind === 'lib') {
      const ids = store.navIds();
      const i = ids.indexOf(r.id);
      close('try');
      await controller.selectSong(r.id, i >= 0 ? { index: i } : {});
      return;
    }
    const res = await controller.tryBankSong(r.id);
    if (res && res.ok) close('try');
    else if (res && res.error === 'perform-locked') toast(LOCK_HINT, 'warn');
    else toast((res && res.error) || 'The song could not be loaded.', 'error');
  }
  function addToLibrary() {
    const r = cur();
    if (!r || r.kind !== 'bank' || v.isLocked()) return null;
    const res = controller.addFromBank(r.id);
    if (res && res.ok) {
      const s = store.getSong(res.id);
      toast(res.existing ? 'That song is already in your library.'
        : `Added “${s ? s.name : r.title}” to your library.`);
    } else if (!(res && res.notified)) toast((res && res.error) || 'The song could not be added.', 'error'); // CAP
    return res && res.ok ? res.id : null;
  }
  let setPop = null;
  function openSetlists(anchor) {
    if (setPop) return setPop.close();
    const r = cur();
    if (!r || v.isLocked()) return;
    setPop = setlistMenu(v, anchor, {
      label: `Add “${r.title}” to a setlist`,
      pick: (slId) => {
        const id = r.kind === 'bank' ? addToLibrary() : r.id;
        if (!id) return;
        const sl = store.get().setlists[slId];
        const nm = store.getSong(id)?.name || r.title;
        if (store.addToSetlist(slId, id)) toast(`Added “${nm}” to ${sl ? sl.name : 'the setlist'}.`);
      },
      onClose: () => {
        setPop = null;
      },
    });
  }
  d.listen(detail, 'click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.matches('.v6-bank-try')) tryIt();
    else if (b.matches('.v6-bank-add')) {
      addToLibrary();
      refresh();
    } else if (b.matches('.v6-bank-set')) openSetlists(b);
  });
  d.listen(list, 'click', (e) => {
    const b = e.target.closest('.v6-bank-row');
    if (b) {
      selected = b.dataset.id;
      markSelected();
      return;
    }
    if (e.target.closest('.v6-bank-clear')) {
      Object.assign(f, { q: '', key: 'any', tempo: 'any' });
      f.tags.clear();
      f.packsOff.clear();
      search.value = '';
      renderFilters();
      renderList();
    }
  });
  // ↑ / ↓ move the selection (kept from the controller's own arrow keys)
  d.listen(list, 'keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const i = rows.findIndex((x) => x.id === selected);
    const j = Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    if (!rows[j]) return;
    e.preventDefault();
    e.stopPropagation();
    selected = rows[j].id;
    markSelected();
    list.querySelector(`[data-id="${CSS.escape(selected)}"]`)?.focus();
  });
  d.listen(keys, 'click', (e) => {
    const b = e.target.closest('[data-key]');
    if (!b) return;
    f.key = b.dataset.key;
    for (const x of keys.children) pressed(x, x.dataset.key === f.key);
    renderList();
  });
  d.listen(tempos, 'click', (e) => {
    const b = e.target.closest('[data-tempo]');
    if (!b) return;
    f.tempo = b.dataset.tempo;
    for (const x of tempos.children) pressed(x, x.dataset.tempo === f.tempo);
    renderList();
  });
  d.listen(feel, 'click', (e) => {
    const b = e.target.closest('[data-tag]');
    if (!b) return;
    const t = b.dataset.tag;
    if (f.tags.has(t)) f.tags.delete(t);
    else f.tags.add(t);
    pressed(b, f.tags.has(t));
    renderList();
  });
  d.listen(packs, 'change', (e) => {
    const cb = e.target.closest('[data-pack]');
    if (!cb) return;
    if (cb.checked) f.packsOff.delete(cb.dataset.pack);
    else f.packsOff.add(cb.dataset.pack);
    renderList();
  });
  d.listen(search, 'input', () => {
    f.q = search.value;
    renderList();
  });
  const setMode = (m) => {
    if (m === mode) return;
    mode = m;
    selected = null;
    f.key = 'any';
    f.tags.clear();
    renderAll();
  };
  d.listen(tBank, 'click', () => setMode('bank'));
  d.listen(tLib, 'click', () => setMode('library'));
  d.listen(closeBtn, 'click', () => close('x'));

  // ---------------------------------------------------------------- live updates (only while open)
  let sig = '';
  const liveSig = () => {
    const st = store.get();
    const base = [st.settings.performLock, st.settings.currentSongId, st.setlistOrder.map((k) => [k,
      st.setlists[k]?.name, st.setlists[k]?.songIds.length])];
    if (mode === 'bank') return JSON.stringify([base, typeof store.packSongs === 'function' ? store.packSongs() : 0]);
    return JSON.stringify([base, st.songOrder.map((id) => {
      const s = st.songs[id];
      return s ? [id, s.name, s.hearIn, s.minor, s.tempo, s.timeSig, s.patch.slots.map((x) => (x ? x.instrument : 0)),
        (s.scenes || []).length] : id;
    })]);
  };
  const refreshLater = rafCoalesce(() => refresh());
  d.add(() => refreshLater.cancel());
  function refresh(force = false) {
    if (!isOpen) return;
    const next = liveSig();
    if (!force && next === sig) return;
    sig = next;
    rowsAll = buildRows();
    renderHead();
    renderFilters();
    renderList();
  }
  d.add(store.subscribe(() => isOpen && refreshLater.push()));
  d.listen(controller, 'user-patches', () => {
    previews.clear();
    if (isOpen) refresh(true);
  });

  // ---------------------------------------------------------------- open / close
  /**
   * UI6-U7a O1: Esc typed in the search box with text in it clears the search (as Settings' search), and the browser
   * stays open; the next Esc closes it. Before, one Esc closed the browser and the filter text stayed for next time.
   * @returns {boolean} the Esc was used here
   */
  function escInSearch() {
    if (document.activeElement !== search || !search.value) return false;
    search.value = '';
    f.q = '';
    renderList();
    return true;
  }
  function open(opt = {}) {
    if (opt.mode === 'library' || opt.mode === 'bank') mode = opt.mode;
    else if (!isOpen) {
      const p = patchPacks();
      mode = p && p.enabled && p.bankSongs > 0 ? 'bank' : mode;
    }
    names.refresh();
    if (!isOpen) {
      isOpen = true;
      el.hidden = false;
      // skeptic UI6-polish1 F1: underModal (U7c F3) as learn mode / Arrange: Settings can open over the browser
      // (⌘, / the gear), and the Esc that closes it then gave the focus back to the search box, where onEscape
      // cleared the player's search (before polish 1 it closed the browser). That Esc is Settings' alone.
      closeOverlay = openOverlay({
        el, closeOnOutside: false, group: 'v6-bank', underModal: true, onEscape: escInSearch,
        onClose: (reason) => {
          closeOverlay = null;
          if (isOpen) close(reason);
        },
      });
    }
    sig = liveSig();
    renderAll();
    if (opt.focus) search.focus({ preventScroll: true });
  }
  function close(reason = 'api') {
    if (!isOpen) return;
    isOpen = false;
    setPop?.close();
    el.hidden = true;
    const c = closeOverlay;
    closeOverlay = null;
    c?.(reason);
    if (el.contains(document.activeElement)) document.activeElement.blur?.();
    o.onClose?.(reason);
  }

  return {
    el,
    open,
    close,
    get isOpen() {
      return isOpen;
    },
    get mode() {
      return mode;
    },
    /** Test hooks: the rows shown (filtered), the selected id, the filter state. */
    get rows() {
      return rows.map((r) => ({ ...r, song: undefined }));
    },
    get selected() {
      return selected;
    },
    get shownDetail() {
      return detailRender ? detailRender.id : null;
    },
    select(id) {
      selected = id;
      markSelected();
    },
    setFilter(nf) {
      Object.assign(f, nf);
      if (nf.tags) f.tags = new Set(nf.tags);
      if (nf.packsOff) f.packsOff = new Set(nf.packsOff);
      search.value = f.q || '';
      renderFilters();
      renderList();
    },
    destroy() {
      close('destroy');
      d.dispose();
      el.remove();
    },
  };
}

/**
 * "Add to setlist ▾": one row per setlist (the current one marked), in a v6 popover under `anchor`. Shared by the
 * browser and the trying banner.
 * @param {object} v  the v6 view context
 * @param {HTMLElement} anchor
 * @param {{label:string, pick:(setlistId:string) => void, onClose?:() => void}} o
 * @returns {{el:HTMLElement, close():void, render():void}}
 */
export function setlistMenu(v, anchor, o) {
  const { store } = v;
  return popover({
    host: v.host, anchor, label: o.label, className: 'v6-bank-setpop', testid: 'v6-bank-setpop', align: 'end',
    build: (pb, pd, close) => {
      const st = store.get();
      const cur = st.settings.currentSetlistId;
      const rows = st.setlistOrder.map((k) => st.setlists[k]).filter(Boolean).map((sl) => {
        const b = button(pd, '.v6-add-it', [h('b', { text: sl.name }),
          h('small', { text: `${plural(sl.songIds.length, 'song')}${sl.id === cur ? ' · playing now' : ''}` })], {
          'data-setlist': sl.id, 'data-testid': `v6-bank-setlist-${sl.id}`,
        });
        pd.listen(b, 'click', () => {
          close();
          if (!v.isLocked()) o.pick(sl.id);
        });
        return b;
      });
      if (!rows.length) rows.push(h('p.v6-pop-p', { text: 'No setlists yet: make one in Edit.' }));
      pb.append(h('div.v6-pop-h', { text: 'Add to setlist' }), h('div.v6-add-menu', {}, ...rows));
    },
    onClose: () => o.onClose?.(),
  });
}

/** Key name for a song (exported for the banner). @param {object} s @returns {string} */
export const songKey = (s) => (s ? keyName(s.hearIn, s.minor) : '');
