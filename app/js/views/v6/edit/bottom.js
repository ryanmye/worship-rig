// UI v6 Edit › the bottom row (U5b; orchestrator: "v6 Edit uses the v6 Perform bottom row", mockup
// native/docs/design/mockups/edit.html, every frame: m.bottom). The v6 Perform's own component (views/v6/bottom.js
// bottomRow: the keyboard with one range bar per instrument + Revert / Fade out / PANIC / Lock), with the same
// controller / store calls, mounted here instead of today's Edit keyboard row.
//
// Two rows, never in each other's way: this one exists only while Edit shows (as U5a's strip) and has its own test
// ids ('v6e-…'), while the hidden v6 Perform keeps its own row mounted. Its range bars are display only: on the
// Perform size a bar is changed after picking its instrument (D24.3), which is the strip's name on Perform; in Edit
// the strip's name opens Range (UI6-U5a R2), where the instrument's range has its own 88-key editor.
// Revert puts the song back to the Revert snapshot the dots count against (ctx.getBaseline), as Perform's Revert.
// Lock goes back to Perform and locks it: Perform lock freezes Edit (main.js sends a locked Edit back to Perform).
import { say } from '../../components/voice.js';
import { slotMuteState, changeCount } from '../../perform.js';
import { SLOT_COUNT } from '../../../shared/params.js';
import { bottomRow } from '../bottom.js';

/** Song fields Revert restores (views/v6/perform.js SAVED_FIELDS, perform.js, controller.revertSong()). */
const SAVED_FIELDS = ['patch', 'drone', 'tempo', 'hearIn', 'playIn', 'transposeOctave', 'minor'];
const savedJSON = (s) => (s ? JSON.stringify(SAVED_FIELDS.map((k) => s[k])) : '');

/**
 * Mount the Edit bottom row into `host` (it mounts / unmounts itself with the view).
 * @param {HTMLElement} host
 * @param {object} env
 * @param {object} env.store
 * @param {object} env.controller
 * @param {object} [env.engine]
 * @param {object} env.editState   the Edit core's (baseline = the Revert snapshot)
 * @param {{name(ref:object):string}} env.names
 * @param {(song:object) => object} env.liveOf   the song as heard (scenes)
 * @param {() => Set<string>} env.changes        the v6 changed set (V6_DIFF_WATCH)
 * @param {() => Set<number>} env.held           the held notes (Edit core)
 * @param {(view:string) => boolean} env.setView
 * @param {(msg:string, kind?:string, o?:object) => void} env.toast
 * @returns {{render():void, readonly row:object|null, destroy():void}}
 */
export function editBottom(host, env) {
  const { store, controller, engine } = env;
  const offs = [];
  const listen = (t, type, fn) => {
    if (!t || typeof t.addEventListener !== 'function') return;
    t.addEventListener(type, fn);
    offs.push(() => t.removeEventListener(type, fn));
  };
  const isLocked = () => !!store.get().settings.performLock;
  const songId = () => store.get().settings.currentSongId || null;
  let row = null;
  let faded = false;
  let status = controller?.status || {};

  const v = {
    store, controller, isLocked,
    /** As the v6 Perform's setRange (keyboard.js onRange); the bars here are display only, so only a cancel comes. */
    setRange(i, field, note, phase, expect) {
      if (field !== 'lowNote' && field !== 'highNote') return false;
      if (phase !== 'cancel' && isLocked()) return false;
      const id = songId();
      const slot = id && store.getSong(id)?.patch.slots[i];
      if (!slot || !Number.isInteger(note)) return false;
      if (phase === 'cancel' && slot[field] !== expect) return false;
      return store.set(`songs.${id}.patch.slots.${i}.${field}`, note);
    },
    onRangePick: () => {},
    onCoarse: () => {},
    /** Perform's Revert (views/v6/perform.js revertSong) against Edit's baseline, which is Perform's snapshot. */
    revertSong() {
      const id = songId();
      const base = env.editState.baseline;
      const cur = id && store.getSong(id);
      if (!base || !cur || base.id !== id) return;
      for (const k of SAVED_FIELDS) {
        if (JSON.stringify(cur[k]) !== JSON.stringify(base[k])) store.set(`songs.${id}.${k}`, base[k]);
      }
      if (controller.scenes?.state().n !== null) controller.scenes?.go(null);
      env.toast(`“${base.name}” is back to how it was when you selected it.`, 'ok', { ms: 3000 });
    },
    setFaded: (on) => setFaded(on),
    toggleLock() {
      if (isLocked()) {
        store.set('settings.performLock', false);
        return;
      }
      env.setView?.('perform');
      store.set('settings.performLock', true);
    },
  };
  function setFaded(on) {
    faded = !!on;
    row?.setFaded(faded, say('fadedButton'));
  }
  function readFaded() {
    try {
      const rs = typeof engine?.getRuntimeState === 'function' ? engine.getRuntimeState() : null;
      setFaded(rs ? !!rs.faded : !!engine?._fade);
    } catch {
      /* engine not started */
    }
  }
  /** The part a held key sounds on (views/v6/perform.js partOf): the first unmuted slot whose range holds it. */
  function partOf(n) {
    const song = env.liveOf(store.currentSong());
    if (!song) return -1;
    const k = Math.min(song.patch.slots.length, controller.engineSlots?.() ?? SLOT_COUNT);
    for (let i = 0; i < k; i++) {
      const sl = song.patch.slots[i];
      if (!sl || slotMuteState(sl).muted) continue;
      const lo = Number.isFinite(sl.lowNote) ? sl.lowNote : 0;
      const hi = Number.isFinite(sl.highNote) ? sl.highNote : 127;
      if (n >= lo && n <= hi) return i;
    }
    return -1;
  }
  const renderLetters = () => {
    if (!row) return;
    const on = store.get().settings.computerKeyboard !== false && !status.midi?.connected;
    row.setLetters(on, Number(controller.kbOctave) || 0);
  };
  function render() {
    if (!row) return;
    const song = store.currentSong();
    const base = env.editState.baseline;
    const same = !song || !base || base.id !== song.id || savedJSON(song) === savedJSON(base);
    const changed = env.changes();
    row.render({
      song: env.liveOf(song), same, count: changeCount(changed), locked: isLocked(), names: env.names, changed,
    });
  }
  function mount() {
    row = bottomRow(v, { prefix: 'v6e' });
    host.replaceChildren(row.el);
    render();
    renderLetters();
    row.setHeld(env.held(), partOf);
    readFaded();
  }
  function unmount() {
    if (!row) return;
    row.kb.cancelDrag();
    row.releaseAll();
    row.destroy();
    row = null;
    host.replaceChildren();
  }
  const sync = () => {
    const shown = store.get().settings.view === 'edit';
    if (shown && !row) mount();
    else if (!shown && row) unmount();
    else render();
  };

  offs.push(store.subscribe(() => sync()));
  listen(env.editState, 'changes', () => render());
  if (typeof controller?.onStatus === 'function') {
    offs.push(controller.onStatus((s) => {
      status = s;
      renderLetters();
    }));
  }
  listen(controller, 'kb-octave', renderLetters);
  listen(controller, 'songSelected', () => render());
  listen(controller, 'scene', () => render());
  listen(controller, 'notes', (e) => {
    if (!row) return;
    const held = e.detail ? e.detail.held : [];
    row.setHeld(held, partOf);
    if (faded && held && (held.size || held.length)) queueMicrotask(readFaded);
  });
  listen(controller, 'action', (e) => {
    const t = e.detail?.type;
    if (t === 'panic') {
      row?.releaseAll();
      readFaded();
    }
    if (t === 'fadeOutAll') setFaded(true);
  });
  sync();

  return {
    render,
    get row() {
      return row;
    },
    destroy() {
      for (const f of offs.splice(0)) f();
      unmount();
    },
  };
}
