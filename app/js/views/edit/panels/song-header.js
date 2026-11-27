// OWNER: song agent (views/edit/CONTRACT.md §6). The song header (region 'head'; H-v2 concept §3,
// edit.html .shead):
// ☰ Songs (≤ 1250 px) · LIVE · inline song name · KEY chip · BPM chip + Tap · Notes chip · Loading… · live hint ·
// "⋯ Song" menu (Duplicate, Rename, Export song, Reset to factory…, Delete song…).
//
// The menu and its confirms are fixed-position popovers inside this region: `.ev2-head` clips its overflow (shell
// CSS), and a fixed box escapes that without touching the shell. They follow CONTRACT §5 (role=menu / alertdialog,
// ctx.onEscape, ctx.markDialog, outside click, focus return).
import { keyName } from '../../../shared/music.js';
import { h, setText, icon, createBinder, changedDot, download, safeName, TRIAL_EXPORT_MESSAGE } from '../lib.js';
import { isTrialId } from '../../../store.js';
import { scenesOf } from '../../../shared/scenes.js';
import { say } from '../../components/voice.js';
import { KEY_RELS, octaveWord, createTapper, flashTap } from './song.js';

const LIVE_HINT = 'The song that’s playing. Changes are heard now and saved with it.';
const RESET_Q = 'Put this song’s sound back to the factory version? The key and notes stay.';
let uid = 0; // unique ids for aria-describedby (CONTRACT §4: ids only through a generator)

/** First line of the notes for the Notes chip tooltip. */
const firstLine = (t) => {
  const l = String(t || '').trim().split('\n')[0] || '';
  return l.length > 60 ? `${l.slice(0, 58)}…` : l;
};

export default {
  id: 'song-header',
  region: 'head',
  /**
   * @param {HTMLElement} el
   * @param {object} ctx  the panel ctx
   * @param {{v6?:boolean}} [opts]  v6: mounted by the v6 Edit (views/v6/edit/edit.js): its words ("snapshot", names)
   */
  mount(el, ctx, opts = {}) {
    const { store, editState } = ctx;
    const binder = createBinder(ctx);
    const song = () => ctx.song();

    // ---- ☰ Songs (the setlist drawer at ≤ 1250 px; the shell ignores pointerdowns on [data-drawer-toggle])
    const songsBtn = h('button.ev2-btn.sm.ev2-song-songsbtn', {
      type: 'button', 'aria-label': 'Songs and setlists', 'aria-expanded': String(!!editState.drawer),
      dataset: { drawerToggle: '1' },
    }, h('span', { 'aria-hidden': 'true', text: '☰' }), 'Songs');
    songsBtn.addEventListener('click', () => editState.setDrawer(!editState.drawer));
    ctx.listen(editState, 'drawer', (e) => songsBtn.setAttribute('aria-expanded', String(!!e.detail.open)));

    const live = h('span.ev2-song-live', { title: LIVE_HINT }, // the hint text itself hides < 1341 px (polish-2B)
      h('i', { 'aria-hidden': 'true' }), 'LIVE');

    // ---- song name: inline input, song-bound (round2-ui #3); Enter blurs (commits), empty reverts, Esc cancels
    const nameInput = h('input.ev2-song-name', {
      type: 'text', maxlength: 120, 'aria-label': 'Song name', spellcheck: 'false', autocomplete: 'off',
      dataset: { ownEscape: '1' },
    });
    // field-sizing:content sizes the box to the text but Chromium counts the caret too, so a name that fits
    // overflowed by 1 px and lost its last letters to the ellipsis ("Sunday Pad + Pi…" at 1440; integrator). The
    // ellipsis is on only when the name is really wider than its max-width.
    const fitName = () => nameInput.classList.toggle('long', nameInput.scrollWidth > nameInput.clientWidth + 2);
    binder.ctl('song.name', () => ({
      el: nameInput,
      set: (v) => {
        nameInput.value = v ?? '';
        requestAnimationFrame(fitName);
      },
    }), { text: 'dirty' }); // polish-1: follows a rename from elsewhere until the user types here
    nameInput.addEventListener('input', fitName);
    // onboarding O12: the name is an input with no visible affordance; a pencil after it (and the tooltip) says
    // "click to rename"
    nameInput.title = 'Song name: click to rename';
    const pencil = h('button.ev2-song-pencil', { type: 'button', 'aria-label': 'Rename song', title: 'Rename song',
      tabindex: -1 }, icon('edit', 16));
    pencil.addEventListener('click', () => {
      nameInput.focus();
      nameInput.select();
    });
    ctx.listen(window, 'resize', fitName);
    const commitName = ctx.songField(nameInput, 'name');
    const fieldName = () => store.getSong?.(ctx.fieldSongId(nameInput))?.name ?? song()?.name ?? '';
    nameInput.addEventListener('change', () => {
      const v = nameInput.value.trim();
      if (v) commitName(v);
      else if (ctx.fieldSongId(nameInput) === ctx.songId()) nameInput.value = song()?.name ?? '';
    });
    nameInput.addEventListener('keydown', (e) => {
      // round4-edit-lib m2: Enter / Esc inside an IME composition confirm / cancel the candidate (macOS Chrome sends
      // keydown isComposing, keyCode 229); acting on them committed half-converted text and blurred mid-edit
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        nameInput.blur();
      } else if (e.key === 'Escape') {
        // data-own-escape: the shell leaves this Esc to us; restoring the value first means blur commits nothing
        e.preventDefault();
        e.stopPropagation();
        nameInput.value = fieldName();
        nameInput.blur();
      }
    });

    // ---- KEY chip → the Song panel's Easy Transpose
    const keyDot = changedDot('The key changed since the song was loaded');
    const keyVal = h('b.ev2-song-keyval');
    const keyPlay = h('span.ev2-song-muted');
    const keyChip = h('button.ev2-song-chip.ev2-song-keychip', {
      type: 'button', dataset: { chip: 'key' }, title: 'Easy Transpose: play in one key, hear another',
    }, h('span.ev2-song-chipcap', { text: 'Key' }), keyDot, keyVal, keyPlay, icon('down', 14));
    keyChip.addEventListener('click', () => ctx.select('song', { focus: 'key' }));
    binder.fn(KEY_RELS, (s) => {
      const hear = keyName(s.hearIn, s.minor);
      const play = keyName(s.playIn, s.minor);
      const oct = octaveWord(s);
      setText(keyVal, hear);
      setText(keyPlay, `· you play ${play}${oct}`);
      keyChip.setAttribute('aria-label', `Key ${hear}, you play ${play}${oct}. Open Easy Transpose`);
    });

    // ---- BPM chip: the number opens the tempo field; Tap sets it
    const bpmDot = changedDot('The tempo changed since the song was loaded');
    const bpmVal = h('b.ev2-song-bpmval');
    const bpmNum = h('button.ev2-song-bpmnum', { type: 'button', title: 'Tempo' },
      icon('tempo', 16), bpmDot, bpmVal, h('span.ev2-song-muted', { text: 'BPM' }));
    bpmNum.addEventListener('click', () => ctx.select('song', { focus: 'tempo' }));
    const tapBtn = h('button.ev2-song-tap', {
      type: 'button', title: 'Tap 2–4 times in time', dataset: { tap: 'head' }, text: 'Tap',
    });
    const tapper = createTapper((bpm) => ctx.set('song.tempo', bpm));
    tapBtn.addEventListener('click', () => {
      tapper.tap();
      flashTap(tapBtn);
    });
    ctx.onLeaveSong(() => tapper.reset());
    const bpmChip = h('span.ev2-song-chip.ev2-song-bpmchip', {
      role: 'group', 'aria-label': 'Tempo', dataset: { chip: 'bpm' },
    }, bpmNum, tapBtn);
    binder.fn(['tempo'], (s) => {
      const t = s.tempo === null || s.tempo === undefined ? null : Math.round(s.tempo);
      setText(bpmVal, t === null ? '—' : String(t));
      bpmNum.setAttribute('aria-label',
        t === null ? 'No tempo set. Open the tempo field' : `Tempo ${t} BPM. Open the tempo field`);
    });

    // ---- Notes chip
    const notesChip = h('button.ev2-song-chip.ev2-song-noteschip', { type: 'button', dataset: { chip: 'notes' } },
      icon('notes', 16), 'Notes');
    notesChip.addEventListener('click', () => ctx.select('song', { focus: 'notes' }));
    binder.fn(['notes'], (s) => {
      const l = firstLine(s.notes);
      notesChip.classList.toggle('has', !!l);
      notesChip.title = l ? `Notes: ${l}` : 'No notes yet: add some';
    });

    // ---- changed dots (song-diff; name and notes are never watched)
    const renderDots = () => {
      const k = editState.isChanged(KEY_RELS);
      const t = editState.isChanged('tempo');
      keyDot.hidden = !k;
      bpmDot.hidden = !t;
      keyChip.dataset.changed = String(k);
      bpmChip.dataset.changed = String(t);
    };
    ctx.listen(editState, 'changes', renderDots);
    renderDots();

    // ---- Loading… (controller status)
    const loading = h('span.ev2-song-loading', { hidden: true, role: 'status', text: 'Loading…' });
    if (typeof ctx.controller?.onStatus === 'function') {
      ctx.cleanup(ctx.controller.onStatus((st) => {
        loading.hidden = !(st && st.loading);
      }));
    }

    // ---- ⋯ Song menu + confirms
    const menuBtn = h('button.ev2-btn.sm.ghost.ev2-song-menubtn', {
      type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'Song menu',
      title: 'Song menu: Duplicate, Rename, Export, Reset to factory… (asks first), Delete… (asks first)',
    }, icon('dots', 18), h('span.ev2-song-menutext', { text: 'Song' }));
    const pop = h('div.ev2-song-pop', { hidden: true });
    let mode = null; // null | 'menu' | 'confirm'
    let viaKeys = false; // return focus to the ⋯ button only for keyboard use (pointer clicks blur, CONTRACT §5)

    const place = () => {
      const r = menuBtn.getBoundingClientRect();
      pop.style.top = `${Math.round(r.bottom + 6)}px`;
      pop.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
    };
    const close = (focusBack) => {
      if (!mode) return false;
      const was = mode;
      mode = null;
      pop.hidden = true;
      pop.replaceChildren();
      pop.removeAttribute('role');
      pop.removeAttribute('aria-label');
      pop.removeAttribute('aria-describedby');
      delete pop.dataset.kind;
      menuBtn.setAttribute('aria-expanded', 'false');
      ctx.markDialog(false, `song-${was}`);
      if (focusBack) menuBtn.focus();
      return true;
    };

    const items = () => [...pop.querySelectorAll('[role="menuitem"]')];
    const menuItem = (act, text, fn, cls = '') => {
      const b = h('button.ev2-song-mi', {
        type: 'button', role: 'menuitem', tabindex: '-1', dataset: { act }, class: cls,
      }, text);
      b.addEventListener('click', (e) => {
        viaKeys = e.detail === 0;
        fn();
      });
      return b;
    };
    function openMenu(keys) {
      const s = song();
      if (!s) return;
      close(false);
      viaKeys = keys;
      mode = 'menu';
      pop.setAttribute('role', 'menu');
      pop.setAttribute('aria-label', `Song: ${s.name}`);
      pop.dataset.kind = 'menu';
      pop.replaceChildren(
        menuItem('duplicate', 'Duplicate', () => {
          close(viaKeys);
          const id = store.duplicateSong(s.id);
          if (id) ctx.toast(`Duplicated “${s.name}”`);
        }),
        menuItem('rename', 'Rename', () => {
          close(false);
          nameInput.focus();
          nameInput.select();
        }),
        menuItem('export', 'Export song', () => {
          close(viaKeys);
          // UI6-U7a O3: a Song bank trial song is not in the library (nothing saved): no file with its `trial:` id
          if (isTrialId(s.id)) {
            ctx.toast(TRIAL_EXPORT_MESSAGE, 'warn');
            return;
          }
          const text = store.exportSong(s.id);
          if (text) download(`${safeName(s.name)}.rig-song.json`, text);
        }),
        h('hr.ev2-song-sep', { role: 'separator' }),
        s.factoryId ? menuItem('reset', 'Reset to factory…', () => openConfirm('reset', s)) : null,
        menuItem('delete', 'Delete song…', () => openConfirm('delete', s), 'danger'),
      );
      pop.hidden = false;
      place();
      menuBtn.setAttribute('aria-expanded', 'true');
      ctx.markDialog(true, 'song-menu');
      items()[0]?.focus();
    }
    function openConfirm(kind, s) {
      const keys = viaKeys;
      close(false);
      viaKeys = keys;
      mode = 'confirm';
      const qid = `ev2-song-q-${++uid}`;
      const reset = kind === 'reset';
      const q = h('p.ev2-song-q', {
        id: qid, text: reset ? RESET_Q : `Delete “${s.name}” from your library? It is removed from every setlist.`,
      });
      const go = h('button.ev2-btn.sm.danger.ev2-song-go', { type: 'button', dataset: { act: `${kind}-go` } },
        reset ? 'Reset' : 'Delete song');
      const cancel = h('button.ev2-btn.sm.ev2-song-cancel', { type: 'button', dataset: { act: 'cancel' } }, 'Cancel');
      go.addEventListener('click', () => {
        close(viaKeys);
        if (reset) {
          if (store.resetToFactory(s.id)) ctx.toast(`“${s.name}” reset to factory`);
          else ctx.toast('Already the factory sound');
        } else if (store.deleteSong(s.id)) ctx.toast(`Deleted “${s.name}”`);
        else ctx.toast(`Could not delete “${s.name}”.`, 'error');
      });
      cancel.addEventListener('click', () => close(viaKeys));
      pop.setAttribute('role', 'alertdialog');
      pop.setAttribute('aria-label', reset ? 'Reset to factory' : 'Delete song');
      pop.setAttribute('aria-describedby', qid);
      pop.dataset.kind = kind;
      pop.replaceChildren(q, h('div.ev2-song-qbtns', {}, go, cancel));
      pop.hidden = false;
      place();
      menuBtn.setAttribute('aria-expanded', 'false');
      ctx.markDialog(true, 'song-confirm');
      cancel.focus(); // CONTRACT §5: focus Cancel on open
    }
    menuBtn.addEventListener('click', (e) => {
      if (mode === 'menu') close(e.detail === 0);
      else openMenu(e.detail === 0);
    });
    menuBtn.addEventListener('keydown', (e) => {
      if (mode || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
      e.preventDefault(); // ↑/↓ nudge the mod wheel elsewhere
      e.stopPropagation();
      openMenu(true);
    });
    pop.addEventListener('keydown', (e) => {
      if (mode === 'menu') {
        const list = items();
        const k = list.indexOf(document.activeElement);
        let n = -1;
        if (e.key === 'ArrowDown') n = (k + 1) % list.length;
        else if (e.key === 'ArrowUp') n = (k - 1 + list.length) % list.length;
        else if (e.key === 'Home') n = 0;
        else if (e.key === 'End') n = list.length - 1;
        else if (e.key === 'Tab') {
          close(false);
          return;
        }
        if (n < 0) return;
        e.preventDefault();
        e.stopPropagation(); // arrows are Prev/Next song and the mod wheel outside
        list[n].focus();
      } else if (mode === 'confirm' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.stopPropagation(); // never switch songs from inside the question
        e.preventDefault();
        const bs = [...pop.querySelectorAll('button')];
        const k = bs.indexOf(document.activeElement);
        bs[(k + (e.key === 'ArrowRight' ? 1 : bs.length - 1)) % bs.length]?.focus();
      }
    });
    ctx.onEscape(() => close(true)); // Esc closes the menu / cancels the confirm; never panics (shell)
    ctx.listen(document, 'pointerdown', (e) => {
      if (!mode || pop.contains(e.target) || menuBtn.contains(e.target)) return;
      close(false); // outside click: nothing changes
    }, true);
    ctx.listen(window, 'resize', () => close(false));
    ctx.onLeaveSong(() => close(false)); // the menu and its question belong to the song they were opened on

    const liveHint = h('span.ev2-song-livehint', { text: LIVE_HINT });
    const head = h('div.ev2-song-head', {},
      songsBtn, live, nameInput, pencil, keyChip, bpmChip, notesChip, loading,
      h('span.ev2-sp'),
      liveHint,
      menuBtn, pop,
    );
    el.replaceChildren(head);

    // ---- UI6-snap O1: while a snapshot plays, Edit's Space / Echo / sends / drone controls change it (heard, for now:
    // the next snapshot change drops it), not the song. One line says so, with the snapshot row's Update (save over
    // it, its name kept; Lock never blocks it, D24.1) and Own levels (back to the song's own: then Edit edits the
    // song). Made the first time a snapshot plays, so the header at rest is unchanged (flag-off purity).
    const scenes = ctx.controller?.scenes;
    const v6 = !!opts.v6;
    let snap = null; // {el, sig}
    const playingScene = () => {
      const s = song();
      const st = scenes?.state?.();
      if (!s || !st || st.id !== s.id || st.n === null) return null;
      const sc = scenesOf(s)[st.n];
      // D25: the v6 Edit names it; today's UI still says "Scene n"
      return sc ? { n: st.n, name: (v6 && sc.name) || say('sceneLabel', { n: st.n + 1 }) } : null;
    };
    const noun = v6 ? 'snapshot' : 'scene';
    const doUpdate = () => {
      const st = scenes.state();
      if (!st || st.n === null || !scenes.save(st.n)) return;
      const sn = scenesOf(store.currentSong())[st.n];
      ctx.toast(`“${(v6 && sn?.name) || say('sceneLabel', { n: st.n + 1 })}” updated.`, 'ok', { ms: 2500 });
    };
    const doOwn = () => scenes.go(null);
    const buildSnap = (text) => {
      // the words come from shared/voice.js: the two [..] are the buttons, Update first, then Own levels
      const acts = [['update', doUpdate, say('sceneEditUpdateTitle', { noun })],
        ['own', doOwn, say('sceneEditOwnTitle', { noun })]];
      const parts = [];
      let k = 0;
      for (const [i, piece] of text.split(/\[([^\]]+)\]/).entries()) {
        if (i % 2 === 0) {
          if (piece) parts.push(piece);
          continue;
        }
        const [act, fn, title] = acts[k++] || [];
        if (!act) {
          parts.push(piece);
          continue;
        }
        const b = h('button.ev2-song-snapbtn', { type: 'button', title, dataset: { act: `snap-${act}` },
          'data-testid': `edit-snap-${act}` }, piece);
        b.addEventListener('click', fn);
        parts.push(b);
      }
      return parts;
    };
    const renderSnap = () => {
      const p = scenes ? playingScene() : null;
      if (!p && !snap) return;
      if (!snap) {
        snap = { el: h('span.ev2-song-snap', { role: 'status', 'data-testid': 'edit-snapline' }), sig: '' };
        el.append(snap.el); // a line of its own under the chips row (song-header.css .ev2-snapping)
      }
      snap.el.hidden = !p;
      el.classList.toggle('ev2-snapping', !!p);
      liveHint.hidden = !!p; // "Changes are … saved with it" is not true of these controls meanwhile
      if (!p) return;
      const text = say('sceneEditLine', { noun, name: p.name });
      if (text !== snap.sig) {
        snap.sig = text;
        snap.el.replaceChildren(...buildSnap(text));
      }
    };
    if (scenes) {
      ctx.listen(ctx.controller, 'scene', renderSnap);
      ctx.listen(ctx.controller, 'song', renderSnap);
      binder.fn(['scenes'], renderSnap); // the song shown changed, or its scenes (renamed, removed)
    }

    return {
      destroy() {
        close(false);
        binder.destroy();
        snap?.el.remove(); // the region host outlives this panel
        el.classList.remove('ev2-snapping');
      },
    };
  },
};
