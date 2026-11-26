// UI v6 song bar (D16; UI6-build-plan U1): song name, KEY button ("Sing it in…", as today's KEY ▾) with "you play C"
// while transposed, Transpose − / +, the Space room picker, the folded snapshots chip, the chord readout, Notes and the
// Setlist button (U3: those two open the right sidebar on their module). Under Perform lock the key and transpose need
// a hold, as today (perform.js LOCK).
import { h, setText, disposer } from '../components/util.js';
import { holdButton } from '../components/holdButton.js';
import { keyGrid } from '../components/keys.js';
import { chordReadout } from '../components/readouts.js';
import { keyName } from '../../shared/music.js';
import { transposeSemisOf } from '../../store.js';
import { SPACE_PRESETS, matchPreset } from '../../shared/fx-presets.js';
import { singItInShift, songFxValue } from '../perform.js';
import { button, popover, icon, signed, HOLD_MS, MINUS } from './lib.js';

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
    'aria-pressed': 'false', 'data-testid': 'v6-notes', title: 'Show the song’s notes in the sidebar',
  });
  const setCap = h('small.v6-set-cap', { text: '' });
  const setBtn = button(d, '.v6-setbtn', [h('b', { text: 'Setlist' }), setCap], {
    'aria-pressed': 'false', 'data-testid': 'v6-setlist', title: 'Show the setlist in the sidebar',
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

  // ---- Notes and Setlist live in the right sidebar (U3, views/v6/sidebar/): the buttons open it on that module
  d.listen(notesBtn, 'click', () => v.openSidebar?.('notes'));
  d.listen(setBtn, 'click', () => v.openSidebar?.('setlist'));

  function renderSetlist() {
    const ids = store.navIds();
    const sl = store.currentSetlist();
    const cur = store.currentIndex();
    const pos = cur >= 0 ? `${cur + 1} of ${ids.length}` : `${ids.length} songs`;
    setText(setCap, `${sl && sl.songIds.length ? sl.name : 'Library'} · ${pos}`);
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
    /** U3: the sidebar's state → Notes / Setlist show whether it is open on their module. */
    setSide(s) {
      for (const [b, id] of [[notesBtn, 'notes'], [setBtn, 'setlist']]) {
        const on = !!s && s.open && s.tab === id;
        b.classList.toggle('open', on);
        b.setAttribute('aria-pressed', String(on));
      }
    },
    closePops() {
      for (const p of [keyPop, spacePop]) p?.close();
    },
    destroy() {
      for (const p of [keyPop, spacePop]) p?.close();
      d.dispose();
      for (const c of comps.splice(0)) c.destroy();
      el.remove();
    },
  };
}
