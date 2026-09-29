// OWNER: setlist agent (views/edit/CONTRACT.md §6). The setlist column (region 'left'; a drawer at ≤ 1250 px):
// setlist picker (New with inline rename, Rename, Delete), the song listbox (select, ↑/↓, Alt+↑/↓ and drag reorder,
// F2 / double-click rename, Delete → confirm, hover actions), search at ≥ 9 songs, the setlist-gap note + marker,
// "+ New" / Factory… / Library… browsers and the Library file section (export / import).
// Ported from views/edit.js "LEFT: setlists + songs" (lines 457–949); mockup design/H-v2/edit.png `.lib`/`.song-row`.
// Every write goes through the store helpers; song switches through controller.selectSong (CONTRACT.md §3.3).
import { h, setText, icon, iconButton, button, section, firstSentence, download, today, safeName } from '../lib.js';
import { CATEGORIES, CATEGORY_LABELS, factoryByCategory } from '../../../presets.js';
import { keyName } from '../../../shared/music.js';

/** The search box appears when a list has more than 8 songs (ui-edit "song search appears for > 8 songs"). */
export const SEARCH_MIN = 9;
const ROW_TITLE = 'Click to open · drag or Alt+↑/↓ to move · F2 rename · Delete key removes';

/**
 * Index to pass to store.moveSong when dropping row `from` before/after row `j` (drag reorder, before/after halves).
 * @param {number} from
 * @param {number} j
 * @param {boolean} after
 * @returns {number}
 */
export function dropTarget(from, j, after) {
  if (after) return j >= from ? j : j + 1;
  return j > from ? j - 1 : j;
}

/** Store paths that change what the column shows (list, names, key letters, current row, setlists). */
function listPath(p) {
  if (p === 'settings' || p.startsWith('settings.currentS') || p.startsWith('settings.setlist')) return true;
  if (p.startsWith('setlists') || p === 'songOrder' || p === 'setlistOrder' || p === 'songs') return true;
  if (!p.startsWith('songs.')) return false;
  const segs = p.split('.');
  return segs.length === 2 || (segs.length === 3 && ['name', 'category', 'hearIn', 'minor'].includes(segs[2]));
}

export default {
  id: 'setlist',
  region: 'left',
  /**
   * Mount the setlist column.
   * @param {HTMLElement} el   the region host (aside.ev2-left)
   * @param {object} ctx       panel ctx (CONTRACT.md §3)
   * @returns {{destroy():void, _debug:object}}
   */
  mount(el, ctx) {
    const { store, controller, toast, editState } = ctx;
    const btn = (text, on, attrs = {}) =>
      button(text, on, { ...attrs, class: `ev2-btn sm ${attrs.class || ''}`.trim() });
    /** A square icon button (≥ 28 px hit target); `label` is its accessible name and tooltip (lib.iconButton). */
    const iconBtn = (label, g, on, attrs = {}) => iconButton(label, g, on, { ...attrs, class: 'ev2-list-iconbtn' });

    // ---------------------------------------------------------------------------------------------------------
    // setlist picker
    const setSelect = h('select.ev2-list-select', { 'aria-label': 'Setlist' });
    const setNameInput = h('input.ev2-list-setname', {
      type: 'text', 'aria-label': 'Setlist name', hidden: true, maxlength: 120, spellcheck: 'false',
      dataset: { ownEscape: '' },
    });
    const setConfirm = h('div.ev2-list-confirm', { hidden: true, role: 'alertdialog', 'aria-label': 'Delete setlist' });
    const setBtn = (text, title, act, on) =>
      button(text, on, { class: 'ev2-list-setbtn', title, dataset: { setAct: act } });
    const btnSetDelete = setBtn('Delete', 'Delete setlist', 'delete', askDeleteSetlist);
    const sets = h('div.ev2-list-sets', {},
      h('div.ev2-list-sethead', {},
        h('span.ev2-cap', { text: 'Setlist' }), h('span.ev2-sp'),
        // onboarding O12: two "New" buttons did different things; each now says what it makes
        setBtn('+ Setlist', 'New setlist', 'new', newSetlist),
        setBtn('Rename', 'Rename setlist', 'rename', renameSetlist),
        btnSetDelete,
      ),
      h('div.ev2-list-selwrap', {}, setSelect, icon('down', 16), setNameInput),
      setConfirm,
    );

    // ---------------------------------------------------------------------------------------------------------
    // song list
    const searchInput = h('input.ev2-list-search', {
      type: 'search', placeholder: 'Find a song…', 'aria-label': 'Find a song', hidden: true, spellcheck: 'false',
      dataset: { ownEscape: '' },
    });
    const gapNote = h('p.ev2-hint.ev2-list-gapnote', { hidden: true, 'aria-live': 'polite' });
    const songList = h('ol.ev2-list-songs', { role: 'listbox', 'aria-label': 'Songs' });

    // ---------------------------------------------------------------------------------------------------------
    // adding songs
    const browser = (kind, label) => {
      const body = h('div.ev2-list-bbody');
      const box = h('div.ev2-list-browser',
        { hidden: true, role: 'region', 'aria-label': label, dataset: { browser: kind } },
        h('div.ev2-list-bhead', {}, h('span.ev2-cap', { text: label }), h('span.ev2-sp'),
          iconBtn(`Close ${label.toLowerCase()}`, icon('close', 14), () => {
            closePanels();
            (kind === 'factory' ? btnFactory : btnLibrary).focus();
          }, { title: 'Close' })),
        body);
      return { box, body };
    };
    const factory = browser('factory', 'Factory sounds');
    const library = browser('library', 'Library songs');
    const btnFactory = btn('Factory…', () => togglePanel(factory), {
      'aria-expanded': 'false', title: 'Add a factory sound to this setlist', dataset: { add: 'factory' },
    });
    const btnLibrary = btn('Library…', () => togglePanel(library), {
      'aria-expanded': 'false', title: 'Add a song from your library to this setlist', dataset: { add: 'library' },
    });
    const btnNew = btn('+ New song', () => store.addSong(null, { select: true, name: 'New Song' }), {
      title: 'New blank song (piano + pad)', dataset: { add: 'new' },
    });
    const addRow = h('div.ev2-list-add', {}, btnNew, btnFactory, btnLibrary);

    // ---------------------------------------------------------------------------------------------------------
    // library file
    const importInput = h('input', {
      type: 'file', accept: '.json,application/json', hidden: true, 'aria-label': 'Import library or song file',
    });
    const fileSec = section('list-file', 'Library file', { cls: 'ev2-list-file' },
      h('div.ev2-list-filerow', {},
        btn('Export library', exportLibrary, { dataset: { file: 'export' } }),
        btn('Export song', exportSong, { dataset: { file: 'export-song' } }),
        btn('Import…', () => importInput.click(), { dataset: { file: 'import' } }),
        importInput,
      ),
      h('p.ev2-hint', { text: 'Imported songs are added to your library; nothing is overwritten.' }),
    );
    setText(fileSec.querySelector('.ev2-sec-sum'), 'Export / import');

    const root = h('div.ev2-list', {},
      sets, searchInput, gapNote, songList, addRow, factory.box, library.box, fileSec);
    el.replaceChildren(root);

    // ---------------------------------------------------------------------------------------------------------
    // browsers
    function togglePanel(p) {
      const open = p.box.hidden;
      closePanels();
      p.box.hidden = !open;
      (p === factory ? btnFactory : btnLibrary).setAttribute('aria-expanded', String(open));
      if (open && p === library) renderLibraryPanel();
    }
    function closePanels() {
      const was = !factory.box.hidden || !library.box.hidden;
      factory.box.hidden = true;
      library.box.hidden = true;
      btnFactory.setAttribute('aria-expanded', 'false');
      btnLibrary.setAttribute('aria-expanded', 'false');
      return was;
    }
    // factory browser: static content (round2-ui #7: headings are CATEGORY_LABELS, never the raw ids)
    {
      const byCat = factoryByCategory();
      for (const cat of CATEGORIES) {
        const items = byCat[cat] || [];
        if (!items.length) continue;
        factory.body.append(h('h3.ev2-list-bcat', { text: CATEGORY_LABELS[cat] || cat }));
        for (const f of items) {
          factory.body.append(
            h('div.ev2-list-bitem', { dataset: { factoryId: f.id } },
              h('div.ev2-list-btext', {},
                h('div.ev2-list-bname', { text: f.name }),
                h('div.ev2-list-bdesc', { text: firstSentence(f.notes) })),
              btn('Add', () => {
                // select:true → the controller sees currentSongId change and loads it
                if (store.addSong(f, { select: true })) toast(`Added “${f.name}”`);
              }, { 'aria-label': `Add ${f.name}` }),
            ),
          );
        }
      }
    }
    function renderLibraryPanel() {
      const st = store.get();
      const sl = store.currentSetlist();
      library.body.replaceChildren();
      if (!sl) {
        library.body.append(h('p.ev2-hint', { text: 'Choose a setlist first.' }));
        return;
      }
      const inSet = new Set(sl.songIds);
      const rest = st.songOrder.filter((id) => !inSet.has(id));
      if (!rest.length) {
        library.body.append(h('p.ev2-hint', { text: 'Every library song is already in this setlist.' }));
      }
      for (const id of rest) {
        const s = st.songs[id];
        library.body.append(
          h('div.ev2-list-bitem', { dataset: { songId: id } },
            h('div.ev2-list-btext', {}, h('div.ev2-list-bname', { text: s.name })),
            btn('Add', () => {
              store.addToSetlist(sl.id, id);
              renderLibraryPanel();
            }, { 'aria-label': `Add ${s.name} to setlist` }),
          ),
        );
      }
    }

    // ---------------------------------------------------------------------------------------------------------
    // dialogs (inline confirms): body[data-dialog-open] tells the app's Esc→Panic to stand down (ux.md M1)
    let dialogShown = false;
    function syncDialog() {
      const open = rowConfirm !== null || !setConfirm.hidden;
      if (open === dialogShown) return;
      dialogShown = open;
      ctx.markDialog(open, 'setlist');
    }
    ctx.onEscape(() => {
      if (rowConfirm) return cancelRowConfirm();
      if (!setConfirm.hidden) {
        closeSetConfirm();
        btnSetDelete.focus({ preventScroll: true });
        return true;
      }
      return closePanels();
    });

    // ---------------------------------------------------------------------------------------------------------
    // setlist controls
    ctx.listen(setSelect, 'change', () => store.setCurrentSetlist(setSelect.value || null));
    function newSetlist() {
      const id = store.addSetlist('New Setlist', [], { select: true });
      renderList();
      if (id) beginSetRename();
    }
    function renameSetlist() {
      if (store.currentSetlist()) beginSetRename();
    }
    function beginSetRename() {
      const sl = store.currentSetlist();
      if (!sl) return;
      setSelect.hidden = true;
      setNameInput.hidden = false;
      setNameInput.value = sl.name;
      setNameInput.focus();
      setNameInput.select();
    }
    function endSetRename(commit) {
      if (setNameInput.hidden) return;
      const sl = store.currentSetlist();
      const v = setNameInput.value.trim();
      setNameInput.hidden = true;
      setSelect.hidden = false;
      if (commit && sl && v && v !== sl.name) store.set(`setlists.${sl.id}.name`, v);
    }
    ctx.listen(setNameInput, 'keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        endSetRename(true);
      } else if (e.key === 'Escape') {
        e.preventDefault(); // data-own-escape: the shell leaves this Esc to us, and it is never Panic
        endSetRename(false);
      }
    });
    ctx.listen(setNameInput, 'blur', () => endSetRename(true));
    function closeSetConfirm() {
      setConfirm.hidden = true;
      setConfirm.replaceChildren();
      syncDialog();
    }
    function askDeleteSetlist() {
      const sl = store.currentSetlist();
      if (!sl) return;
      setConfirm.hidden = false;
      setConfirm.replaceChildren(
        h('span.ev2-list-q', { text: `Delete the setlist “${sl.name}”? Its songs stay in your library.` }),
        h('span.ev2-list-qbtns', {},
          btn('Delete setlist', () => {
            store.deleteSetlist(sl.id);
            closeSetConfirm();
          }, { class: 'danger', dataset: { confirm: 'delete' } }),
          btn('Cancel', () => {
            closeSetConfirm();
            btnSetDelete.focus({ preventScroll: true });
          }, { dataset: { confirm: 'cancel' } }),
        ),
      );
      syncDialog();
      queueMicrotask(() => setConfirm.querySelector('[data-confirm="cancel"]')?.focus({ preventScroll: true }));
    }

    // ---------------------------------------------------------------------------------------------------------
    // song list
    /** Inline rename / confirm are keyed by row index AND song id: a reorder from elsewhere drops them. */
    let renaming = null; // {i, id, value?}
    let rowConfirm = null; // {i, id, fresh?}: the row's Remove/Delete confirm
    let focusIdx = -1; // an explicit focus target for the next render (after move / confirm / rename)
    let dragFrom = -1;
    let query = '';
    let rebuilding = false; // blur events fired by replaceChildren must not commit or re-render

    function listContext() {
      const st = store.get();
      const sl = store.currentSetlist();
      return { st, sl, ids: sl ? sl.songIds : st.songOrder, setlistId: sl ? sl.id : null };
    }
    function currentRowIndex(ids, st) {
      if (st.settings.setlistGap) return -1; // the current entry was removed from this list
      const cur = st.settings.currentSongId;
      const pos = st.settings.setlistIndex;
      if (Number.isInteger(pos) && pos >= 0 && ids[pos] === cur) return pos;
      return ids.indexOf(cur);
    }
    const matches = (s) => !query || (s && s.name.toLowerCase().includes(query.toLowerCase()));
    const rows = () => [...songList.querySelectorAll('.ev2-list-row:not([hidden])')];

    function renderList() {
      const { st, sl, ids } = listContext();
      // setlist select
      const opts = [h('option', { value: '', text: 'All songs (library)' })];
      for (const id of st.setlistOrder) opts.push(h('option', { value: id, text: st.setlists[id].name }));
      setSelect.replaceChildren(...opts);
      setSelect.value = sl ? sl.id : '';
      btnSetDelete.disabled = !sl;
      sets.querySelector('[data-set-act="rename"]').disabled = !sl;
      songList.setAttribute('aria-label', sl ? `Songs in “${sl.name}”` : 'All songs');
      // search box only for long lists
      const wantSearch = ids.length >= SEARCH_MIN;
      if (!wantSearch && query) query = '';
      searchInput.hidden = !wantSearch;
      if (searchInput.value !== query && document.activeElement !== searchInput) searchInput.value = query;
      // stale inline states (the row moved or vanished under them)
      if (renaming && ids[renaming.i] !== renaming.id) renaming = null;
      if (rowConfirm && ids[rowConfirm.i] !== rowConfirm.id) rowConfirm = null;
      // "gap": the current song was removed from this setlist → Next plays the song that followed it
      const nb = typeof store.neighbors === 'function' ? store.neighbors() : null;
      const gap = !!(sl && st.settings.setlistGap && nb && Number.isInteger(nb.gap));
      gapNote.hidden = !gap;
      if (gap) {
        const next = nb.next ? st.songs[nb.next.id] : null;
        setText(gapNote, next
          ? `The song you were on was removed from this set. Next plays “${next.name}”.`
          : 'The song you were on was removed from the end of this set.');
      }
      // keep keyboard focus (and a half-typed rename) across the rebuild
      const a = document.activeElement;
      let keepId = null;
      let keepIdx = -1;
      let keepSel = null; // a focused button inside the row ([data-confirm=…] / [data-act=…])
      if (a && songList.contains(a)) {
        const r = a.closest('.ev2-list-row');
        if (r && !a.classList.contains('ev2-list-rename')) {
          keepId = r.dataset.id;
          keepIdx = Number(r.dataset.index);
          if (a !== r && a.dataset.confirm) keepSel = `[data-confirm="${a.dataset.confirm}"]`;
          else if (a !== r && a.dataset.act) keepSel = `[data-act="${a.dataset.act}"]`;
        }
      }
      const liveRename = songList.querySelector('.ev2-list-rename');
      if (renaming && liveRename) renaming.value = liveRename.value;
      const curIdx = currentRowIndex(ids, st);
      const out = [];
      let shown = 0;
      const gapRow = (text) => h('li.ev2-list-gap', { 'aria-hidden': 'true', text });
      ids.forEach((id, i) => {
        if (gap && i === nb.gap) out.push(gapRow('removed — Next continues here'));
        const r = songRow(st.songs[id], i, i === curIdx, !!sl);
        const pinned = (renaming && renaming.i === i) || (rowConfirm && rowConfirm.i === i);
        if (!matches(st.songs[id]) && !pinned) r.hidden = true;
        else shown += 1;
        out.push(r);
      });
      if (gap && nb.gap >= ids.length) out.push(gapRow('removed — end of set'));
      const empty = sl ? 'This setlist is empty — add songs below.' : 'No songs yet.';
      if (!ids.length) out.push(h('li.ev2-list-empty', { text: empty }));
      else if (!shown) out.push(h('li.ev2-list-empty', { text: `No songs match “${query}”.` }));
      rebuilding = true;
      try {
        songList.replaceChildren(...out);
      } finally {
        rebuilding = false;
      }
      // focus: an explicit target first, else the row that had focus (by id, then by index)
      let target = null;
      const byIndex = (k) => songList.querySelector(`.ev2-list-row[data-index="${Math.min(k, ids.length - 1)}"]`);
      if (focusIdx >= 0) target = byIndex(focusIdx);
      else if (keepId !== null) {
        target = songList.querySelector(`.ev2-list-row[data-index="${keepIdx}"][data-id="${CSS.escape(keepId)}"]`)
          || songList.querySelector(`.ev2-list-row[data-id="${CSS.escape(keepId)}"]`)
          || byIndex(keepIdx);
      }
      focusIdx = -1;
      if (target && !target.hidden && !(renaming && renaming.i === Number(target.dataset.index))) {
        const inner = keepSel && target.querySelector(keepSel);
        (inner || target).focus({ preventScroll: true });
        target.scrollIntoView({ block: 'nearest' });
      }
      if (!library.box.hidden) renderLibraryPanel();
      syncDialog();
    }
    ctx.listen(searchInput, 'input', () => {
      query = searchInput.value.trim();
      renderList();
    });
    ctx.listen(searchInput, 'keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault(); // data-own-escape: never Panic, never the drawer
        if (searchInput.value) {
          searchInput.value = '';
          query = '';
          renderList();
        } else searchInput.blur();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        rows()[0]?.focus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        rows()[0]?.click();
      }
    });

    function cancelRowConfirm() {
      if (!rowConfirm) return false;
      focusIdx = rowConfirm.i;
      rowConfirm = null;
      renderList();
      return true;
    }
    function pick(s, i, current, inSetlist) {
      if (!current) controller.selectSong(s.id, { index: inSetlist ? i : undefined });
      if (editState.drawer) editState.setDrawer(false); // picking a song closes the ≤ 1250 px drawer
    }
    function startRename(s, i) {
      rowConfirm = null;
      renaming = { i, id: s.id };
      renderList();
    }

    function songRow(s, i, current, inSetlist) {
      if (!s) return h('li.ev2-list-row.missing', { text: '(missing song)', dataset: { index: String(i) } });
      const isConfirm = !!(rowConfirm && rowConfirm.i === i);
      const li = h('li.ev2-list-row', {
        tabindex: 0,
        role: 'option',
        draggable: 'true',
        'aria-selected': current || isConfirm ? 'true' : 'false',
        'aria-current': current ? 'true' : null,
        title: ROW_TITLE,
        dataset: { index: String(i), id: s.id, keepFocus: '' },
      });
      if (current) li.classList.add('on');
      const num = h('small.ev2-list-num', { text: String(i + 1) });
      const key = h('em.ev2-list-key', {
        text: keyName(s.hearIn || 0, !!s.minor), title: `Key of ${keyName(s.hearIn || 0, !!s.minor)}`,
      });
      let name;
      if (renaming && renaming.i === i) {
        li.classList.add('renaming');
        li.draggable = false;
        name = h('input.ev2-list-rename', {
          type: 'text', value: renaming.value ?? s.name, 'aria-label': 'Song name', maxlength: 120,
          spellcheck: 'false', dataset: { ownEscape: '' },
        });
        const done = (commit) => {
          if (rebuilding || !renaming || renaming.i !== i) return;
          renaming = null;
          const v = name.value.trim();
          focusIdx = i;
          // deferred: a blur fired while the list is being replaced must not re-enter renderList
          queueMicrotask(() => {
            if (!(commit && v && v !== s.name && store.set(`songs.${s.id}.name`, v))) renderList();
          });
        };
        name.addEventListener('keydown', (e) => {
          e.stopPropagation(); // the row's own keys (Delete, F2, ↑/↓) and the global ones stay out of typing
          if (e.key === 'Enter') {
            e.preventDefault();
            done(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            done(false);
          }
        });
        name.addEventListener('blur', () => done(true));
        name.addEventListener('click', (e) => e.stopPropagation());
        name.addEventListener('dragstart', (e) => e.preventDefault());
        queueMicrotask(() => {
          if (!name.isConnected) return;
          name.focus();
          if (renaming && renaming.value === undefined) name.select();
          else name.setSelectionRange(name.value.length, name.value.length); // carried-over text: caret at the end
        });
      } else {
        const cat = s.category && CATEGORY_LABELS[s.category];
        name = h('span.ev2-list-name', { text: s.name, title: cat ? `${s.name} · ${cat}` : s.name });
        name.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          startRename(s, i);
        });
      }
      li.append(num, name);
      if (isConfirm) {
        li.classList.add('confirming');
        li.draggable = false;
        li.append(h('span.ev2-list-rowconfirm', { role: 'alertdialog', 'aria-label': `Remove ${s.name}` },
          h('span.ev2-list-q', {
            text: inSetlist
              ? `Remove “${s.name}” from this set, or delete it from your library everywhere?`
              : `Delete “${s.name}” from your library?`,
          }),
          h('span.ev2-list-qbtns', {},
            inSetlist ? btn('Remove from set', (e) => {
              e.stopPropagation();
              rowConfirm = null;
              focusIdx = i;
              store.removeFromSetlist(store.currentSetlist().id, i);
            }, { dataset: { confirm: 'remove' } }) : null,
            btn('Delete song', (e) => {
              e.stopPropagation();
              rowConfirm = null;
              focusIdx = i;
              const nm = s.name;
              if (store.deleteSong(s.id)) toast(`Deleted “${nm}”`);
              else renderList();
            }, { class: 'danger', dataset: { confirm: 'delete' } }),
            btn('Cancel', (e) => {
              e.stopPropagation();
              cancelRowConfirm();
            }, { dataset: { confirm: 'cancel' } }),
          ),
        ));
        if (rowConfirm.fresh) {
          // §5: focus Cancel on open (only then: a later re-render keeps whatever the user focused)
          rowConfirm.fresh = false;
          queueMicrotask(() => {
            if (li.isConnected) li.querySelector('[data-confirm="cancel"]')?.focus({ preventScroll: true });
          });
        }
      } else {
        const act = (label, g, a, on) => iconBtn(label, icon(g, 15), (e) => {
          e.stopPropagation();
          on();
        }, { dataset: { act: a } });
        li.append(key, h('span.ev2-list-acts', {},
          act(`Rename ${s.name}`, 'edit', 'rename', () => startRename(s, i)),
          act(`Duplicate ${s.name}`, 'copy', 'dup', () => {
            if (store.duplicateSong(s.id)) toast(`Duplicated “${s.name}”`);
          }),
          act(inSetlist ? `Remove or delete ${s.name}` : `Delete ${s.name}`, 'close', 'del', () => {
            renaming = null;
            rowConfirm = { i, id: s.id, fresh: true };
            focusIdx = i;
            renderList();
          }),
        ));
      }
      li.addEventListener('click', () => {
        if ((renaming && renaming.i === i) || isConfirm) return;
        pick(s, i, current, inSetlist);
      });
      li.addEventListener('keydown', (e) => onRowKey(e, s, i, current, inSetlist));
      li.addEventListener('dragstart', (e) => {
        dragFrom = i;
        li.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(i));
      });
      li.addEventListener('dragend', () => {
        dragFrom = -1;
        li.classList.remove('dragging');
        for (const r of songList.querySelectorAll('.drop-before,.drop-after')) {
          r.classList.remove('drop-before', 'drop-after');
        }
      });
      const afterHalf = (e) => {
        const r = li.getBoundingClientRect();
        return e.clientY > r.top + r.height / 2;
      };
      li.addEventListener('dragover', (e) => {
        if (dragFrom < 0) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const after = afterHalf(e);
        li.classList.toggle('drop-after', after);
        li.classList.toggle('drop-before', !after);
      });
      li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'));
      li.addEventListener('drop', (e) => {
        if (dragFrom < 0) return;
        e.preventDefault();
        const from = dragFrom;
        dragFrom = -1;
        move(from, dropTarget(from, i, afterHalf(e)));
      });
      return li;
    }

    function move(from, to) {
      const { setlistId, ids } = listContext();
      if (to < 0 || to >= ids.length || from === to) return;
      focusIdx = to;
      if (!store.moveSong(setlistId, from, to)) focusIdx = -1;
    }

    function onRowKey(e, s, i, current, inSetlist) {
      if (e.target !== e.currentTarget) return;
      const focusStep = (d) => {
        const v = rows();
        const t = v[v.indexOf(e.currentTarget) + d];
        if (t) t.focus();
      };
      switch (e.key) {
        case 'ArrowUp':
        case 'ArrowDown': {
          // arrows are global (↑/↓ = mod wheel): the list consumes them (ui-edit "plain ↑ must not nudge the wheel")
          e.preventDefault();
          e.stopPropagation();
          const d = e.key === 'ArrowUp' ? -1 : 1;
          if (e.altKey) move(i, i + d);
          else focusStep(d);
          break;
        }
        case 'Home':
          e.preventDefault();
          rows()[0]?.focus();
          break;
        case 'End':
          e.preventDefault();
          rows().at(-1)?.focus();
          break;
        case 'Enter':
          e.preventDefault();
          pick(s, i, current, inSetlist);
          break;
        case 'F2':
          e.preventDefault();
          startRename(s, i);
          break;
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          renaming = null;
          rowConfirm = { i, id: s.id, fresh: true };
          focusIdx = i;
          renderList();
          break;
        default:
          break;
      }
    }

    // ---------------------------------------------------------------------------------------------------------
    // import / export
    function exportLibrary() {
      download(`Worship Rig library ${today()}.json`, store.exportJSON());
      toast('Library exported');
    }
    function exportSong() {
      const s = store.currentSong();
      if (!s) return;
      download(`${safeName(s.name)}.rig-song.json`, store.exportSong(s.id));
    }
    function importText(text) {
      const r = store.importJSON(text);
      if (r.ok) {
        const n = r.songIds.length;
        const m = r.setlistIds.length;
        toast(`Imported ${n} song${n === 1 ? '' : 's'}${m ? ` and ${m} setlist${m === 1 ? '' : 's'}` : ''}`);
      } else toast(r.error || 'That file could not be imported.', 'error');
      return r;
    }
    ctx.listen(importInput, 'change', async () => {
      const f = importInput.files && importInput.files[0];
      importInput.value = '';
      if (!f) return;
      let text;
      try {
        text = await f.text();
      } catch (err) {
        console.warn('[edit] import read failed', err);
        toast(`Could not open “${f.name}”. Is it a Worship Rig export?`, 'error');
        return;
      }
      importText(text);
    });

    // ---------------------------------------------------------------------------------------------------------
    // store → view
    ctx.subscribe((ev) => {
      if (ev.songChanged || ev.full || ev.paths.some(listPath)) renderList();
    });
    ctx.onLeaveSong(() => {
      dragFrom = -1; // a drag that outlives the song switch never drops into the rebuilt list
    });
    renderList();

    return {
      destroy() {
        rebuilding = true; // blur events during teardown must not write
        renaming = null;
        rowConfirm = null;
      },
      /** Test hooks. */
      _debug: { importText, renderList },
    };
  },
};
