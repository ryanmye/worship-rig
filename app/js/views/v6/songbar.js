// UI v6 song bar (D16; UI6-build-plan U1): song name, KEY button ("Sing it in…", as today's KEY ▾) with "you play C"
// while transposed, Transpose − / +, the Space room picker, the folded snapshots chip, the chord readout, Notes and the
// Setlist button. Under Perform lock the key and transpose need a hold, as today (perform.js LOCK).
import { h, setText, disposer } from '../components/util.js';
import { holdButton } from '../components/holdButton.js';
import { keyGrid } from '../components/keys.js';
import { chordReadout } from '../components/readouts.js';
import { say } from '../components/voice.js';
import { keyName } from '../../shared/music.js';
import { transposeSemisOf } from '../../store.js';
import { SPACE_PRESETS, matchPreset } from '../../shared/fx-presets.js';
import { singItInShift, songFxValue } from '../perform.js';
import { button, popover, icon, signed, HOLD_MS, MINUS } from './lib.js';

const LOAD_TEXT = { ready: 'ready', loading: 'loading…', cold: 'not loaded', playing: 'playing' };

/**
 * @param {object} v  the v6 shell's view context
 * @param {HTMLElement} host  positioned ancestor for the popovers (the v6 root)
 * @param {HTMLElement} snapChip  the snapshots row's folded chip (snapshots.js), placed after Space
 * @returns {{el:HTMLElement, notesBtn:HTMLElement, render(state:object):void, renderSetlist():void,
 *            setChord(chord:object|null, live:boolean):void, closePops():void, destroy():void}}
 */
export function songBar(v, host, snapChip) {
  const { store, controller } = v;
  const d = disposer();
  const comps = [];
  const use = (c) => (comps.push(c), c);
  const lockedHold = () => v.isLocked();

  const songName = h('b.v6-song', { 'data-testid': 'v6-song-name', text: '—', 'aria-live': 'polite' });
  const keyText = h('b.v6-key-t', { text: '' });
  const keyBtn = use(holdButton({
    content: [keyText, icon('down', 16)], ms: HOLD_MS, requireHold: lockedHold, className: 'v6-keybtn',
    title: 'Sing it in a different key: the band hears the new key, your hands stay where they are',
    ariaLabel: 'Key: sing it in a different key', testid: 'v6-key', onActivate: () => toggleKeyPop(),
  }));
  keyBtn.el.setAttribute('aria-haspopup', 'true');
  keyBtn.el.setAttribute('aria-expanded', 'false');
  const playIn = h('span.v6-playin', { hidden: true, 'data-testid': 'v6-playin' });
  const tDown = use(holdButton({
    label: MINUS, ms: HOLD_MS, requireHold: lockedHold, className: 'v6-sq', ariaLabel: 'Transpose down a semitone',
    testid: 'v6-transpose-down', onActivate: () => controller.transposeDown(),
  }));
  const tUp = use(holdButton({
    label: '+', ms: HOLD_MS, requireHold: lockedHold, className: 'v6-sq', ariaLabel: 'Transpose up a semitone',
    testid: 'v6-transpose-up', onActivate: () => controller.transposeUp(),
  }));
  const tVal = h('b.v6-tval', { 'data-testid': 'v6-transpose-val', text: '0' });
  const spaceText = h('b.v6-space-t', { text: '' });
  const spaceBtn = button(d, '.v6-spc', [h('span.v6-cap', { text: 'Space' }), spaceText, icon('down', 14)], {
    'aria-haspopup': 'true', 'aria-expanded': 'false', 'data-testid': 'v6-space',
    title: 'The room every sound plays in',
  });
  const chord = use(chordReadout({ label: 'Chord' }));
  chord.el.classList.add('v6-chord');
  const notesBtn = button(d, '.v6-notes-btn', [icon('note', 16), 'Notes'], {
    'aria-haspopup': 'true', 'aria-expanded': 'false', 'data-testid': 'v6-notes',
  });
  const setCap = h('small.v6-set-cap', { text: '' });
  const setBtn = button(d, '.v6-setbtn', [h('b', { text: 'Setlist' }), setCap], {
    'aria-haspopup': 'true', 'aria-expanded': 'false', 'data-testid': 'v6-setlist',
  });
  const el = h('section.v6-songbar', { 'data-testid': 'v6-songbar', 'aria-label': 'Current song' },
    songName,
    h('span.v6-cap', { text: 'Key' }), keyBtn.el, playIn,
    h('div.v6-trn', { role: 'group', 'aria-label': 'Transpose' }, h('span.v6-cap', { text: 'Transpose' }), tDown.el,
      tVal, tUp.el),
    spaceBtn, snapChip, h('span.v6-gap'), chord.el, notesBtn, setBtn);

  // ---- "Sing it in…" (as perform.js toggleKeyPop): the band hears the tapped key, the hands stay in Play-In
  let keyPop = null;
  function singOctave(s) {
    const snap = v.snap();
    const base = snap && snap.id === s.id ? snap.song : null;
    return 12 * (Number(base?.transposeOctave) || 0);
  }
  function singItIn(pc) {
    const s = store.currentSong();
    if (!s) return;
    const delta = singItInShift(s.playIn, pc) + singOctave(s) - transposeSemisOf(s);
    if (delta) controller.transposeBy(delta);
  }
  function toggleKeyPop() {
    if (keyPop) return keyPop.close();
    if (!store.currentSong()) return;
    keyPop = popover({
      host, anchor: keyBtn.el, label: 'Sing it in', className: 'v6-keypop', testid: 'v6-sing',
      build: (body, pd) => {
        const sing = keyGrid({ label: 'The key the band hears', onSelect: (pc) => singItIn(pc) });
        pd.add(() => sing.destroy());
        const hears = h('b');
        const plays = h('span');
        const back = button(pd, '.v6-sing-back', '', { 'data-testid': 'v6-sing-back' });
        pd.listen(back, 'click', () => {
          const s = store.currentSong();
          if (s) singItIn(s.playIn);
        });
        body.append(h('div.v6-pop-h', { text: 'Sing it in…' }),
          h('p.v6-pop-p', { text: 'Tap the key the band will sing in. Your hands stay where they are.' }),
          sing.el, h('div.v6-pop-foot', {}, 'Band hears ', hears, ' · ', plays, back));
        return () => {
          const s = store.currentSong();
          if (!s) return;
          sing.set({ pc: s.hearIn, minor: s.minor });
          setText(hears, keyName(s.hearIn, s.minor));
          setText(plays, `you play ${keyName(s.playIn, s.minor)}`);
          setText(back, `Back to ${keyName(s.playIn, s.minor)}`);
          back.disabled = transposeSemisOf(s) === singOctave(s);
        };
      },
      onClose: () => {
        keyPop = null;
      },
    });
    keyPop.render();
  }

  // ---- Space room picker: a tap applies an fx-presets.js room to this song (as perform.js pickFx)
  let spacePop = null;
  d.listen(spaceBtn, 'click', () => {
    if (spacePop) return spacePop.close();
    if (!store.currentSong()) return;
    spacePop = popover({
      host, anchor: spaceBtn, label: 'Space', className: 'v6-spacepop', testid: 'v6-space-pop',
      build: (body, pd, close) => {
        const rows = SPACE_PRESETS.map((p) => {
          const b = button(pd, '.v6-room', [h('b', { text: p.name }), h('small', { text: p.blurb })], {
            'data-id': p.id, 'data-testid': `v6-room-${p.id}`, 'aria-pressed': 'false',
          });
          pd.listen(b, 'click', () => {
            v.applySpace(p.id);
            close();
          });
          return b;
        });
        body.append(h('div.v6-pop-h', { text: 'Space' }), h('div.v6-rooms', {}, ...rows));
        return () => {
          const cur = currentRoom(store.currentSong());
          for (const b of rows) {
            b.classList.toggle('on', b.dataset.id === cur?.id);
            b.setAttribute('aria-pressed', String(b.dataset.id === cur?.id));
          }
        };
      },
      onClose: () => {
        spacePop = null;
      },
    });
    spacePop.render();
  });
  const currentRoom = (song) => (song ? matchPreset(SPACE_PRESETS, (p) => songFxValue(song, p)) : null);

  // ---- Notes: the song's notes, read only (Edit writes them)
  let notesPop = null;
  d.listen(notesBtn, 'click', () => {
    if (notesPop) return notesPop.close();
    notesPop = popover({
      host, anchor: notesBtn, label: 'Song notes', className: 'v6-notespop', testid: 'v6-notes-pop', align: 'end',
      build: (body) => {
        const t = h('div.v6-notes-t', { tabindex: '0' });
        body.append(h('div.v6-pop-h', { text: 'Notes' }), t);
        return () => {
          const notes = store.currentSong()?.notes || '';
          t.classList.toggle('empty', !notes);
          setText(t, notes || say('notesEmpty'));
        };
      },
      onClose: () => {
        notesPop = null;
      },
    });
    notesPop.render();
  });

  // ---- Setlist: today's cue-then-Go (D6) in a list: a tap cues (tap the cued one again to clear), GO plays it
  let setPop = null;
  const tapEntry = (id, index) => {
    if (typeof controller.cueSong !== 'function') return controller.selectSong(id, { index });
    if (controller.songState(id, index)?.cued) return controller.clearCue();
    return controller.cueSong(id, { index });
  };
  d.listen(setBtn, 'click', () => {
    if (setPop) return setPop.close();
    setPop = popover({
      host, anchor: setBtn, label: 'Setlist', className: 'v6-setpop', testid: 'v6-setlist-pop', align: 'end',
      build: (body, pd) => {
        const title = h('div.v6-pop-h', { text: 'Setlist' });
        const list = h('div.v6-slist', { role: 'list' });
        pd.listen(list, 'click', (e) => {
          const b = e.target.closest('button[data-id]');
          if (b) tapEntry(b.dataset.id, Number(b.dataset.index));
        });
        const prev = button(pd, '.v6-prev', '◀ Prev', { 'data-testid': 'v6-prev', 'data-overlay-pass': '' });
        pd.listen(prev, 'click', () => controller.prevSong());
        const goCap = h('small', { text: '' });
        const goName = h('b', { text: '' });
        const go = button(pd, '.v6-go', [goCap, goName], { 'data-testid': 'v6-go', 'data-overlay-pass': '' });
        pd.listen(go, 'click', () => (controller.go ? controller.go() : controller.nextSong()));
        body.append(title, list, h('div.v6-prow', {}, prev, go));
        let sig = '';
        return () => {
          const st = store.get();
          const ids = store.navIds();
          const sl = store.currentSetlist();
          setText(title, sl && sl.songIds.length ? sl.name : 'Library');
          const cur = store.currentIndex();
          const states = ids.map((id, i) => (typeof controller.songState === 'function'
            ? controller.songState(id, i) : null));
          // rebuilt only when something it shows changed: a status tick between a pointer-down and its click must
          // not replace the row being tapped
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
          }
          prev.disabled = !store.neighbors().prev;
          const t = typeof controller.goTarget === 'function' ? controller.goTarget() : null;
          const ts = t ? st.songs[t.id] : null;
          go.disabled = !ts;
          go.classList.toggle('cued', !!t?.cued);
          setText(goCap, t?.cued ? 'GO' : say('nextCap'));
          setText(goName, ts ? `${ts.name} · ${keyName(ts.hearIn, ts.minor)}` : 'End of set');
        };
      },
      onClose: () => {
        setPop = null;
      },
    });
    setPop.render();
  });

  function renderSetlist() {
    const ids = store.navIds();
    const sl = store.currentSetlist();
    const cur = store.currentIndex();
    const pos = cur >= 0 ? `${cur + 1} of ${ids.length}` : `${ids.length} songs`;
    setText(setCap, `${sl && sl.songIds.length ? sl.name : 'Library'} · ${pos}`);
    setPop?.render();
  }

  function render(state) {
    const song = state.songs[state.settings.currentSongId] || null;
    const nameText = song ? song.name : 'No song';
    if (songName.textContent !== nameText) setText(songName, nameText);
    songName.title = nameText;
    if (song) {
      setText(keyText, keyName(song.hearIn, song.minor));
      const semis = transposeSemisOf(song);
      playIn.hidden = semis === 0;
      const oct = song.transposeOctave ? ` · oct ${signed(song.transposeOctave)}` : '';
      setText(playIn, `you play ${keyName(song.playIn, song.minor)}${oct}`);
      setText(tVal, signed(semis));
      tVal.classList.toggle('shift', semis !== 0);
      const room = currentRoom(song);
      setText(spaceText, room ? room.name : 'Song’s own'); // a room that is no preset (perform.js SPACE_OWN)
    } else {
      setText(keyText, '');
      playIn.hidden = true;
      setText(tVal, '0');
      setText(spaceText, '—');
    }
    keyBtn.setDisabled(!song);
    tDown.setDisabled(!song);
    tUp.setDisabled(!song);
    for (const b of [keyBtn, tDown, tUp]) b.refresh();
    spaceBtn.disabled = !song;
    notesBtn.classList.toggle('has-notes', !!song?.notes);
    keyPop?.render();
    spacePop?.render();
    notesPop?.render();
    renderSetlist();
  }

  return {
    el,
    notesBtn,
    render,
    renderSetlist,
    setChord(c) {
      chord.set(c);
    },
    chordEl: chord.el,
    closePops() {
      for (const p of [keyPop, spacePop, notesPop, setPop]) p?.close();
    },
    destroy() {
      for (const p of [keyPop, spacePop, notesPop, setPop]) p?.close();
      d.dispose();
      for (const c of comps.splice(0)) c.destroy();
      el.remove();
    },
  };
}
