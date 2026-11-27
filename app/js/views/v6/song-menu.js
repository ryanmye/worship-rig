// The song menu (UI v6 U7c; mockup native/docs/design/mockups/dialogs.html "Song menu (⋯)", mock_dialogs.py
// song_menu()): ⋯ next to the song name in the v6 song bar. Rename…, Duplicate, Add to setlist ▸, Export this song…,
// Reset to as saved (= Revert, hold), Delete (hold). Each is one of today's operations (Edit's song header menu,
// views/edit/panels/song-header.js, and the setlist): store.set(name), store.duplicateSong, store.addToSetlist (the
// Song bank's setlist picker), store.exportSong + download, the v6 shell's Revert, store.deleteSong.
// Lock: like Edit's menu, everything that changes the library is frozen (Edit is, under Perform lock); Reset to as
// saved stays a hold, as Revert is. A trial song (U7a Try it): Rename / Duplicate / Export / Delete say "Keep it first"
// (the trial is not in the library; closes UI6-U7a review O3 for this menu), Add to setlist keeps it first (as the
// Trying banner's Add to setlist does).
// Delete: today's delete keeps no copy of its own. In the Mac app a backup of the whole library is written first
// (controller.backupNow, the automatic backups Settings › Library › Import latest backup… restores); if it cannot be
// written nothing is deleted. In Chrome there are no automatic backups, and the menu says so.
import { h, setText } from '../components/util.js';
import { holdButton } from '../components/holdButton.js';
import { download, safeName } from '../edit/lib.js';
import { button, popover, HOLD_MS } from './lib.js';
import { setlistMenu } from './bank/bank.js';
import { nameDialog } from './dialogs.js';

const LOCK_HINT = 'Perform lock is on: unlock to change the library';
const KEEP_HINT = 'Keep it first';

/**
 * @param {object} v  the v6 view context (store, controller, ctx, toast, isLocked, host, revertSong, isSaved)
 * @returns {{open(anchor:HTMLElement):void, close():void, readonly isOpen:boolean, destroy():void}}
 */
export function songMenu(v) {
  const { store, controller } = v;
  let pop = null;
  let sub = null; // Add to setlist ▸
  let dlg = null; // Rename…
  const hasBackups = () => !!v.ctx?.rig && typeof v.ctx.rig.backupNow === 'function'
    && typeof controller.backupNow === 'function';
  const isTrial = (s) => !!s && typeof controller.trial === 'function' && controller.trial()?.id === s.id;

  function item(pd, cls, title, small, attrs, run) {
    const smallEl = h('small', { text: small || '' });
    const b = button(pd, `.ghost.v6-mi${cls}`, [h('b', { text: title }), smallEl], { role: 'menuitem', ...attrs });
    if (run) pd.listen(b, 'click', (e) => run(e, b));
    return { b, smallEl };
  }
  function holdItem(pd, cls, title, small, testid, run) {
    const smallEl = h('small', { text: small });
    const hb = holdButton({
      content: [h('b', { text: title }), smallEl], ms: HOLD_MS, requireHold: true,
      className: `ghost v6-mi ${cls.split('.').filter(Boolean).join(' ')}`,
      testid, onActivate: run,
    });
    hb.el.setAttribute('role', 'menuitem');
    pd.add(() => hb.destroy());
    return { hb, smallEl };
  }

  function open(anchor) {
    if (pop) return close();
    const s = store.currentSong();
    if (!s) return;
    const id = s.id;
    pop = popover({
      host: v.host, anchor, label: `Song: ${s.name}`, className: 'v6-songmenu', testid: 'v6-songmenu',
      build: (body, pd, closePop) => {
        const locked = v.isLocked();
        const trial = isTrial(s);
        const refuse = (b, why) => {
          b.disabled = true;
          b.title = why;
        };
        const rename = item(pd, '.v6-mi-rename', 'Rename…', '', { 'data-testid': 'v6-sm-rename' }, () => {
          closePop();
          dlg = nameDialog(v, {
            title: 'Rename song', value: s.name, maxlength: 120, testid: 'v6-rename', action: 'Rename',
            save: (nm) => {
              if (v.isLocked() || !store.getSong(id) || isTrial(store.getSong(id))) return;
              if (nm !== store.getSong(id).name && store.set(`songs.${id}.name`, nm)) v.toast(`Renamed to “${nm}”.`);
            },
          });
        });
        const dup = item(pd, '.v6-mi-dup', 'Duplicate', 'a copy to change freely', { 'data-testid': 'v6-sm-dup' },
          () => {
            closePop();
            const nid = !v.isLocked() && store.duplicateSong(id);
            if (nid) v.toast(`Duplicated “${s.name}”. The copy is next to it in the list.`);
            // C-SHIP (chart-view O4): a full library is refused by the store, whose notice is the toast
            else if (v.isLocked() || trial || !store.getSong(id)) {
              v.toast(`Could not duplicate “${s.name}”.`, 'error');
            }
          });
        const st = store.get();
        const setNames = st.setlistOrder.map((k) => st.setlists[k]?.name).filter(Boolean);
        const inSets = st.setlistOrder.map((k) => st.setlists[k]).filter((sl) => sl && sl.songIds.includes(id))
          .map((sl) => sl.name);
        const addSet = item(pd, '.v6-mi-set', 'Add to setlist ▸',
          trial ? 'keeps it in your library first' : inSets.length ? `in ${inSets.join(', ')}`
            : setNames.slice(0, 2).join(', '), { 'data-testid': 'v6-sm-set', 'aria-haspopup': 'dialog' },
          (e, b) => openSets(b, s, trial));
        const exp = item(pd, '.v6-mi-export', 'Export this song…', 'one file, to share or keep',
          { 'data-testid': 'v6-sm-export' }, () => {
            closePop();
            const text = !v.isLocked() && store.exportSong(id);
            if (text) {
              download(`${safeName(s.name)}.rig-song.json`, text);
              v.toast(`Exported “${s.name}”.`);
            }
          });
        const reset = holdItem(pd, '.v6-mi-reset', 'Reset to as saved (hold)', 'same as Revert', 'v6-sm-reset', () => {
          closePop();
          v.revertSong();
        });
        if (v.isSaved?.()) {
          reset.hb.setDisabled(true);
          reset.hb.el.title = 'Nothing changed since you selected it';
          setText(reset.smallEl, 'nothing changed: same as Revert');
        }
        const backups = hasBackups();
        const del = holdItem(pd, '.v6-mi-del.warn2', 'Delete (hold)', backups ? 'a backup of the library is made first'
          : 'no automatic backup in Chrome: Export it first to keep a copy', 'v6-sm-delete', () => {
          closePop();
          deleteSong(id);
        });
        if (locked) {
          for (const x of [rename, dup, addSet, exp]) refuse(x.b, LOCK_HINT);
          del.hb.setDisabled(true);
          del.hb.el.title = LOCK_HINT;
        } else if (trial) {
          for (const x of [rename, dup, exp]) {
            refuse(x.b, `Trying a Song bank song: ${KEEP_HINT.toLowerCase()} (Keep it · add to library)`);
            setText(x.smallEl, KEEP_HINT);
          }
          del.hb.setDisabled(true);
          del.hb.el.title = 'Trying a Song bank song: nothing to delete (Back ends the trial)';
          setText(del.smallEl, KEEP_HINT);
        }
        if (!locked && !st.setlistOrder.length) refuse(addSet.b, 'No setlists yet: make one in Edit');
        body.append(h('div.v6-pop-h', {}, s.name, h('span', { text: trial ? ' trying' : ' song' })),
          h('div.v6-mlist', { role: 'menu', 'aria-label': `Song ${s.name}` },
            rename.b, dup.b, addSet.b, exp.b, reset.hb.el, del.hb.el));
      },
      onClose: () => {
        pop = null;
        sub?.close();
      },
    });
  }

  function openSets(anchor, s, trial) {
    if (sub) return sub.close();
    sub = setlistMenu(v, anchor, {
      label: trial ? 'Keep it and add it to a setlist' : `Add “${s.name}” to a setlist`,
      pick: async (slId) => {
        close();
        const sl = store.get().setlists[slId];
        const nm = sl ? sl.name : 'the setlist';
        if (trial) {
          const r = await controller.keepTrial({ setlistId: slId });
          if (r && r.ok) v.toast(r.existing ? `“${s.name}” is already in your library; added to ${nm}.`
            : `Kept “${s.name}” and added it to ${nm}.`);
          else if (r && r.error === 'perform-locked') v.toast(LOCK_HINT, 'warn');
          else if (r && r.error !== 'no-trial') v.toast(r.error || 'The song could not be added.', 'error');
        } else if (store.addToSetlist(slId, s.id)) v.toast(`Added “${s.name}” to ${nm}.`);
        else v.toast(`Could not add “${s.name}” to ${nm}.`, 'error');
      },
      onClose: () => {
        sub = null;
      },
    });
  }

  async function deleteSong(id) {
    const s = store.getSong(id);
    if (!s || v.isLocked() || isTrial(s)) return;
    const backup = hasBackups() && !store.pristine; // a pristine library holds only factory songs: none is written
    if (backup) {
      // the Mac app: a backup of the library as it is now, so Import latest backup… brings this song back
      let r = null;
      try {
        r = await controller.backupNow();
      } catch {
        r = null;
      }
      if (!r || r.error) {
        v.toast(`Could not make a backup first, so “${s.name}” was not deleted. Try again, or Export it first.`,
          'error', { ms: 5000 });
        return;
      }
      if (!store.getSong(id) || v.isLocked()) return;
    }
    if (store.deleteSong(id)) {
      v.toast(backup
        ? `Deleted “${s.name}”. A backup from just before is in Settings › Library › Import latest backup….`
        : `Deleted “${s.name}”.`, 'ok', { ms: 5000 });
    } else v.toast(`Could not delete “${s.name}”.`, 'error');
  }

  function close() {
    sub?.close();
    pop?.close();
  }
  return {
    open,
    close,
    get isOpen() {
      return !!pop;
    },
    destroy() {
      close();
      dlg?.close();
    },
  };
}
