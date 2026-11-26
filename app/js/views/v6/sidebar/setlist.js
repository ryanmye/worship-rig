// Sidebar module: Setlist (D16; D6 "Cue, then Go"; UI6-build-plan U3; mockup mock_v6.py setlist_body(), tab
// "Sidebar · Setlist"). U1's song-bar setlist popover, moved here: the list with now / cued markers (a tap cues, a tap
// on the cued one clears it, GO plays it; controller.cueSong / clearCue / go, unchanged), Prev, GO with the cued (or
// next) song's name, plus "+ Add song": From my library (Edit's Library… flow: store.addToSetlist), From the Song bank
// (today's bank list in Settings › Sounds & Samples until U7's browser), New song (store.addSong at the end; it is
// not selected, so the sound playing never changes from here). Perform lock (perform.js LOCK): the list, Prev and GO
// stay live (they cue); adding songs is frozen, as Edit is.
import { h, setText, disposer } from '../../components/util.js';
import { say } from '../../components/voice.js';
import { keyName } from '../../../shared/music.js';
import { button, popover } from '../lib.js';

const LOAD_TEXT = { ready: 'ready', loading: 'loading…', cold: 'not loaded', playing: 'playing' };

export default {
  id: 'setlist',
  label: 'Setlist',
  blurb: 'songs, cue and go',
  icon: '<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  /**
   * @param {HTMLElement} el
   * @param {object} m  sidebar module ctx (the v6 view context + size)
   * @returns {{destroy():void}}
   */
  mount(el, m) {
    const { store, controller } = m;
    const d = disposer();

    const title = h('b.v6-sl-title', { text: '' });
    const addBtn = button(d, '.v6-sl-add', '+ Add song', {
      'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-testid': 'v6-sl-add',
    });
    const list = h('div.v6-slist', { role: 'list', 'data-testid': 'v6-slist' });
    const prev = button(d, '.v6-prev', '◀ Prev', { 'data-testid': 'v6-prev', 'data-overlay-pass': '' });
    const goCap = h('small', { text: '' });
    const goName = h('b', { text: '' });
    const go = button(d, '.v6-go', [goCap, goName], { 'data-testid': 'v6-go', 'data-overlay-pass': '' });
    const root = h('div.v6-setlist', { 'data-testid': 'v6-setlist-mod' },
      h('div.v6-sl-head', {}, title, addBtn), list, h('div.v6-prow', {}, prev, go));
    el.append(root);

    const tapEntry = (id, index) => {
      if (typeof controller.cueSong !== 'function') return controller.selectSong(id, { index });
      if (controller.songState(id, index)?.cued) return controller.clearCue();
      return controller.cueSong(id, { index });
    };
    d.listen(list, 'click', (e) => {
      const b = e.target.closest('button[data-id]');
      if (b) tapEntry(b.dataset.id, Number(b.dataset.index));
    });
    d.listen(prev, 'click', () => controller.prevSong());
    d.listen(go, 'click', () => (controller.go ? controller.go() : controller.nextSong()));

    let sig = '';
    function render() {
      const st = store.get();
      const ids = store.navIds();
      const sl = store.currentSetlist();
      setText(title, sl && sl.songIds.length ? sl.name : 'Library');
      const cur = store.currentIndex();
      const states = ids.map((id, i) => (typeof controller.songState === 'function'
        ? controller.songState(id, i) : null));
      // rebuilt only when something it shows changed: a status tick between a pointer-down and its click must not
      // replace the row being tapped (U1)
      const next = JSON.stringify([cur, ids, ids.map((id) => [st.songs[id]?.name, st.songs[id]?.hearIn,
        st.songs[id]?.minor]), states]);
      if (next !== sig) {
        sig = next;
        list.replaceChildren(...ids.map((id, i) => {
          const s = st.songs[id];
          const ss = states[i];
          const now = i === cur;
          return h('button.btn.v6-sl', {
            type: 'button', role: 'listitem', 'data-id': id, 'data-index': String(i), 'data-testid': `v6-sl-${i}`,
            class: now ? 'now' : ss?.cued ? 'cued' : '',
          }, h('span.n', { text: String(i + 1) }), h('b', { text: s ? s.name : '?' }),
          h('span.k', { text: s ? keyName(s.hearIn, s.minor) : '' }),
          h('small', { text: now ? 'playing' : ss?.cued ? `cued · ${LOAD_TEXT[ss.load] || ''}` : '' }));
        }));
        list.querySelector('.now')?.scrollIntoView?.({ block: 'nearest' });
      }
      prev.disabled = !store.neighbors().prev;
      const t = typeof controller.goTarget === 'function' ? controller.goTarget() : null;
      const ts = t ? st.songs[t.id] : null;
      go.disabled = !ts;
      go.classList.toggle('cued', !!t?.cued);
      const ld = t?.cued && typeof controller.songState === 'function'
        ? controller.songState(t.id, t.index)?.load : null;
      const load = ld ? ` · ${LOAD_TEXT[ld] || ld}` : ''; // mockup "GO · ready"
      setText(goCap, t?.cued ? `GO${load}` : say('nextCap'));
      setText(goName, ts ? `${ts.name} · ${keyName(ts.hearIn, ts.minor)}` : 'End of set');
      const locked = !!st.settings.performLock;
      addBtn.disabled = locked;
      addBtn.title = locked ? 'Perform lock is on: unlock to add songs' : 'Add a song to this setlist';
      if (locked) addPop?.close();
      addPop?.render();
    }

    // ---- + Add song
    let addPop = null;
    d.listen(addBtn, 'click', () => {
      if (addPop) return addPop.close();
      if (m.isLocked()) return;
      addPop = popover({
        host: m.host, anchor: addBtn, label: 'Add song', className: 'v6-addsong', testid: 'v6-addsong', align: 'end',
        build: (pb, pd, close) => buildAdd(pb, pd, close),
        onClose: () => {
          addPop = null;
        },
      });
      addPop.render();
    });

    function buildAdd(pb, pd, close) {
      const menu = h('div.v6-add-menu');
      const libBox = h('div.v6-add-lib', { hidden: true });
      const fromLib = button(pd, '.v6-add-it', [h('b', { text: 'From my library' }), h('small', { text: '' })], {
        'data-testid': 'v6-add-library',
      });
      const fromBank = button(pd, '.v6-add-it', [h('b', { text: 'From the Song bank' }), h('small', { text: '' })], {
        'data-testid': 'v6-add-bank',
      });
      const blank = button(pd, '.v6-add-it', [h('b', { text: 'New song' }),
        h('small', { text: 'blank piano + pad, at the end' })], { 'data-testid': 'v6-add-new' });
      menu.append(fromLib, fromBank, blank);
      pb.append(h('div.v6-pop-h', { text: 'Add song' }), menu, libBox);
      let libOpen = false;
      let libSig = '';
      pd.listen(fromLib, 'click', () => {
        libOpen = true;
        renderAdd();
      });
      pd.listen(fromBank, 'click', () => {
        close();
        m.ctx.openSettings?.({ section: 'bank' });
      });
      pd.listen(blank, 'click', () => {
        if (m.isLocked()) return;
        const id = store.addSong(null, { name: 'New Song' });
        close();
        if (!id) return;
        const s = store.getSong(id);
        m.toast(`Added “${s ? s.name : 'New Song'}” at the end. Tap it to cue it.`, 'ok', {
          ms: 5000,
          action: {
            label: 'Edit it',
            run: () => {
              const i = store.navIds().lastIndexOf(id);
              controller.selectSong(id, i >= 0 ? { index: i } : {});
              m.ctx.setView?.('edit');
            },
          },
        });
      });
      function renderAdd() {
        const st = store.get();
        const sl = store.currentSetlist();
        const p = typeof controller.patchPacks === 'function' ? controller.patchPacks() : null;
        const bankN = p && p.enabled ? Number(p.bankSongs) || 0 : 0;
        fromLib.disabled = !sl;
        setText(fromLib.lastChild, sl ? `add one to “${sl.name}”` : 'you are playing the whole library');
        fromBank.disabled = !bankN;
        setText(fromBank.lastChild, bankN ? `${bankN} song${bankN === 1 ? '' : 's'}, in Settings for now`
          : 'no Song bank packs');
        menu.hidden = libOpen;
        libBox.hidden = !libOpen;
        if (!libOpen) {
          libSig = '';
          return;
        }
        const inSet = new Set(sl ? sl.songIds : []);
        const rest = sl ? st.songOrder.filter((id) => !inSet.has(id)) : [];
        // rebuilt only when the list it shows changed (every store change re-renders an open popover)
        const next = JSON.stringify(rest.map((id) => [id, st.songs[id]?.name, st.songs[id]?.hearIn,
          st.songs[id]?.minor]));
        if (next === libSig) return;
        libSig = next;
        const back = button(pd, '.v6-add-back', '◀ Back', { 'data-testid': 'v6-add-back' });
        pd.listen(back, 'click', () => {
          libOpen = false;
          renderAdd();
        });
        const rows = rest.map((id) => {
          const s = st.songs[id];
          const b = button(pd, '.v6-add-row', [h('b', { text: s.name }),
            h('span.k', { text: keyName(s.hearIn, s.minor) }), h('small', { text: 'Add' })],
          { 'data-id': id, 'data-testid': `v6-add-lib-${id}`, 'aria-label': `Add ${s.name} to the setlist` });
          pd.listen(b, 'click', () => {
            if (m.isLocked() || !store.currentSetlist()) return;
            if (store.addToSetlist(store.currentSetlist().id, id)) m.toast(`Added “${s.name}”.`, 'ok', { ms: 2000 });
            renderAdd();
          });
          return b;
        });
        if (!rows.length) rows.push(h('p.v6-pop-p', { text: 'Every library song is already in this setlist.' }));
        libBox.replaceChildren(h('div.v6-add-libh', {}, back, h('span', { text: 'Library songs' })),
          h('div.v6-add-rows', {}, ...rows));
      }
      return renderAdd;
    }

    d.add(store.subscribe(() => render()));
    d.add(controller.onStatus(() => render()));
    d.listen(controller, 'songSelected', () => render());
    render();

    return {
      destroy() {
        addPop?.close();
        d.dispose();
        root.remove();
      },
    };
  },
};
