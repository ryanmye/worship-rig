// The range bars' write rule and cancel guards (UI6-U2 F3 / F4, UI6-U2 review O3, U-MOVE-store O1, D24.2), shared by
// every screen with the bottom keyboard (D18 "Same for every screen with the bottom keyboard"; D26.2 "Range bars are
// draggable in Edit too, with Perform's guards ported"). Factored out of views/v6/perform.js (U-EDITRANGE)
// without changing what Perform does: the same checks, in the same order, at the same points of its render.
//   setRange   keyboard.js onRange → slots.<i>.lowNote / highNote of the song shown (never the one selected meanwhile)
//   sync       on every store change: a song switch, a slot count change or the view going away drops a drag (its
//              start value back) and the pick
//   slotMap    store.onSlotMap: a drag follows its instrument to its new index, then drag and pick are dropped
//   blur       (opt-in) the window losing focus drops a drag; Perform does not opt in (its behaviour is unchanged)
// Lock is the keyboard's own: render({locked}) drops a drag and the pick, and setRange refuses all but a restore.

/**
 * @param {object} o
 * @param {object} o.store
 * @param {() => object|null} o.kb   the rangeKeyboard (keyboard.js) to guard; null while it is not mounted
 * @param {string} o.view           the view that shows it ('perform' | 'edit'): any other one drops a drag / pick
 * @param {boolean} [o.blur=false]  a window blur drops a drag in progress (the pick stays)
 * @returns {{setRange(i:number, field:string, note:number, phase:string, expect?:number):boolean,
 *   sync(state:object):void, slotMap(e:{id:string, order:number[]}):void, readonly songId:string|null,
 *   destroy():void}}
 */
export function rangeGuard(o) {
  const { store } = o;
  const isLocked = () => !!store.get().settings.performLock;
  let shown = null; // the song the bars show (and every write goes to)
  let sig = ''; // song id + slot count (skeptic UI6-U2 F3)
  const drop = () => {
    const kb = o.kb();
    if (!kb) return;
    kb.cancelDrag();
    kb.pick(null);
  };
  const onBlur = () => o.kb()?.cancelDrag();
  if (o.blur && typeof window !== 'undefined') window.addEventListener('blur', onBlur);

  return {
    /**
     * A range bar's end moved (keyboard.js): the same slot fields today's Edit writes for the lowest / highest note
     * (slot.js miniKeyboard → slots.<i>.lowNote / highNote), so the changed dots, Revert and the store → engine diff
     * treat it like any edit. D24.2: written live while dragging ('live', ≤ 1 per 50 ms), then 'end' on release;
     * ←/→ are 'key'. Frozen under Perform lock (D18; LOCK table), except 'cancel': a dropped drag putting back
     * its start value, which is allowed under Lock (Lock is one of the things that drops it) but only while the slot
     * still holds `expect`, the value the drag last wrote: a write that moved instruments without a slot map (a
     * positional whole-array write) must not restore into the instrument that now sits there (UI6-U2 review O3).
     * @returns {boolean} written
     */
    setRange(i, field, note, phase, expect) {
      if (field !== 'lowNote' && field !== 'highNote') return false;
      if (phase !== 'cancel' && isLocked()) return false;
      const slot = shown && store.getSong(shown)?.patch.slots[i];
      if (!slot || !Number.isInteger(note)) return false;
      if (phase === 'cancel' && slot[field] !== expect) return false;
      return store.set(`songs.${shown}.patch.slots.${i}.${field}`, note);
    },
    /**
     * Call on every store change, before the bars are rendered. Drops a drag and the pick when the song changes
     * (round2-ui #2: a hand must not carry its drag into the next song; the restore goes to the song it wrote), when
     * the slot count moves (skeptic UI6-U2 F3: an Add / Remove by any store write changes which instrument sits at
     * each index) and when the view is not this one (skeptic UI6-U2 F4: the hidden keyboard measures 0 px wide).
     * @param {object} state
     */
    sync(state) {
      const st = state.settings;
      const song = state.songs[st.currentSongId] || null;
      const id = song ? song.id : null;
      if (id !== shown) drop();
      const s = song ? `${song.id}:${song.patch.slots.length}` : '';
      if (s !== sig) {
        if (sig && id === shown) drop();
        sig = s;
      }
      if (st.view !== o.view) drop();
      shown = id;
    },
    /**
     * store.onSlotMap (runs synchronously in the write that re-orders the shown song: insert, move, remove, a
     * realigning Revert): a range drag first follows its instrument to its new index (so its restore lands there, or
     * nowhere when it was removed), then is dropped, with the pick, after the store's change notification (a
     * microtask; no store write from inside the store's own call). U-MOVE-store O1.
     * @param {{id:string, order:number[]}} e
     */
    slotMap({ id, order }) {
      if (id !== shown) return;
      o.kb()?.remapDrag(order);
      queueMicrotask(drop);
    },
    get songId() {
      return shown;
    },
    destroy() {
      if (o.blur && typeof window !== 'undefined') window.removeEventListener('blur', onBlur);
    },
  };
}
