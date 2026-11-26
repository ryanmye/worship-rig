// UI v6 snapshots row (D16; UI6-build-plan U1). Shows the song's existing scenes (shared/scenes.js, controller.scenes:
// up to 3 saved sets of levels / ON switches / drone level / wheel) as chips: "Own levels" (the song itself) and each
// scene by its name (D25, U7c: the optional scene `name`; "Scene n" without one). A tap plays that one; "+ Save" opens
// the Save snapshot dialog (dialogs.js: a name, what it keeps, Update / Save as new). While a scene plays and the
// levels moved since, "edited · Update · Save as new" appears (Update saves at once and keeps the name; Save as new
// opens the dialog). Arrange (U7c, arrange.js) puts the strips and the sidebar in arrange mode. ⌃ folds the row into
// one chip in the song bar (gold dot when edited), ▾ brings it back; the fold is remembered on this device.
import { h, setText, disposer } from '../components/util.js';
import { scenesOf, sceneMatches } from '../../shared/scenes.js';
import { say } from '../components/voice.js';
import { button, SNAPS_FOLD_KEY } from './lib.js';
import { saveSnapshotDialog } from './dialogs.js';

const readFold = () => {
  try {
    return globalThis.localStorage?.getItem(SNAPS_FOLD_KEY) === 'folded';
  } catch {
    return false;
  }
};
const writeFold = (on) => {
  try {
    if (on) localStorage.setItem(SNAPS_FOLD_KEY, 'folded');
    else localStorage.removeItem(SNAPS_FOLD_KEY);
  } catch {
    /* storage blocked: the fold lasts this session */
  }
};

// U6 (Settings › Perform layout › Snapshots row): the mounted row, so Settings folds it at once; with no v6 Perform
// mounted, Settings reads and writes SNAPS_FOLD_KEY directly
let liveRow = null;
/** @returns {boolean} whether the snapshots row is folded on this device (the mounted row's state, else stored) */
export function snapsFolded() {
  return liveRow ? liveRow.folded : readFold();
}
/**
 * Fold or show the snapshots row (Settings › Perform layout, U6): the mounted row's setFolded, else the stored fold.
 * @param {boolean} on
 */
export function setSnapsFolded(on) {
  if (liveRow) liveRow.setFolded(!!on);
  else writeFold(!!on);
}

/**
 * @param {object} v  the v6 shell's view context
 * @param {{onFold?:(folded:boolean) => void, onArrange?:() => void}} [o]
 * @returns {{el:HTMLElement, chip:HTMLElement, render(song:object|null):void, readonly folded:boolean,
 *            setFolded(b:boolean):void, destroy():void}}
 */
export function snapshotsRow(v, o = {}) {
  const { controller } = v;
  const d = disposer();
  const own = button(d, '.chip.v6-snap', 'Own levels', {
    'data-testid': 'v6-snap-own', title: 'The song’s own levels, as saved', 'aria-pressed': 'false',
  });
  d.listen(own, 'click', () => controller.scenes?.go(null));
  const list = h('span.v6-snap-list', { role: 'group', 'aria-label': 'Snapshots' });
  d.listen(list, 'click', (e) => {
    const b = e.target.closest('button[data-n]');
    if (b) controller.scenes?.go(Number(b.dataset.n));
  });
  // U7c: + Save and Save as new open the Save snapshot dialog (a name, what it keeps, Update / Save as new)
  let dlg = null;
  const openSave = (from) => {
    if (dlg) return;
    dlg = saveSnapshotDialog(v, { from, onClose: () => {
      dlg = null;
    } });
  };
  d.add(() => dlg?.close());
  const save = button(d, '.chip.dash.v6-snap-save', '+ Save', { 'data-testid': 'v6-snap-save' });
  d.listen(save, 'click', () => openSave('save'));
  const update = button(d, '.link.v6-snap-update', 'Update', { 'data-testid': 'v6-snap-update' });
  d.listen(update, 'click', () => {
    const sc = controller.scenes?.state();
    if (sc && sc.n !== null && controller.scenes.save(sc.n)) {
      const sn = scenesOf(v.store.currentSong())[sc.n];
      v.toast(`“${sn?.name || say('sceneLabel', { n: sc.n + 1 })}” updated.`, 'ok', { ms: 2500 });
    }
  });
  const saveNew = button(d, '.link.v6-snap-new', 'Save as new', { 'data-testid': 'v6-snap-new' });
  d.listen(saveNew, 'click', () => openSave('new'));
  // U7c: Arrange (the strips' handles and the sidebar's order), left out by U1
  const arrange = button(d, '.chip.v6-arrange', 'Arrange', { 'data-testid': 'v6-arrange',
    title: 'Move the instruments and the sidebar’s modules around' });
  d.listen(arrange, 'click', () => o.onArrange?.());
  const dirty = h('span.v6-dirty', { hidden: true, 'data-testid': 'v6-snap-dirty' },
    'edited · ', update, ' · ', saveNew);
  const fold = button(d, '.v6-fold', '⌃', {
    'data-testid': 'v6-snap-fold', 'aria-label': 'Fold snapshots into the song bar', title: 'Fold into the song bar',
  });
  const el = h('section.v6-snaps', { 'data-testid': 'v6-snaps', 'aria-label': 'Snapshots' },
    h('span.v6-cap', { text: 'Snapshots' }), own, list, save, dirty, arrange, fold);

  // the folded row's chip, shown in the song bar
  const chipName = h('b.v6-snapchip-n', { text: 'Own levels' });
  const chipDot = h('span.v6-edot', { hidden: true, title: 'edited since saved' });
  const chip = button(d, '.v6-snapchip', [h('span.v6-cap', { text: 'Snapshot' }), chipName, chipDot, '▾'], {
    hidden: true, 'data-testid': 'v6-snap-chip', 'aria-label': 'Snapshots: show the row',
  });
  let folded = readFold();
  const applyFold = () => {
    el.hidden = folded;
    chip.hidden = !folded;
    o.onFold?.(folded);
  };
  d.listen(fold, 'click', () => {
    folded = true;
    writeFold(true);
    applyFold();
  });
  d.listen(chip, 'click', () => {
    folded = false;
    writeFold(false);
    applyFold();
  });

  function render(song) {
    const sc = controller.scenes?.state() || { id: null, n: null, count: 0 };
    const mine = !!song && sc.id === song.id;
    const count = mine ? sc.count : 0;
    const n = mine ? sc.n : null;
    const scenes = mine ? scenesOf(song) : [];
    const label = (k) => scenes[k]?.name || say('sceneLabel', { n: k + 1 }); // D25: the name, else "Scene n"
    const sig = Array.from({ length: count }, (_, k) => label(k)).join('\u0001');
    if (list.childElementCount !== count || list.dataset.sig !== sig) {
      list.dataset.sig = sig;
      list.replaceChildren(...Array.from({ length: count }, (_, k) => h('button.btn.chip.v6-snap', {
        type: 'button', 'data-n': String(k), 'data-testid': `v6-snap-${k + 1}`, text: label(k),
      })));
    }
    own.classList.toggle('plate', n === null);
    own.setAttribute('aria-pressed', String(n === null));
    for (const b of list.children) {
      const on = Number(b.dataset.n) === n;
      b.classList.toggle('plate', on);
      b.setAttribute('aria-pressed', String(on));
      b.title = on ? 'Playing' : `Play ${b.textContent}`;
    }
    const max = controller.scenes?.max ?? 3;
    // U7c: at the most a song keeps, + Save still opens the dialog while one plays (Update it, or rename it)
    save.disabled = !mine || (count >= max && n === null);
    save.title = count >= max ? `${max} snapshots is the most a song keeps for now${n !== null
      ? ': update the one that plays' : ''}` : say('sceneSaveTitle', { n: count + 1 });
    const scene = n !== null ? scenes[n] : null;
    const edited = !!scene && !sceneMatches(scene, controller.scenes.view(song));
    dirty.hidden = !edited;
    saveNew.title = count >= max ? `${max} snapshots is the most a song keeps for now: update this one` : '';
    own.disabled = !song;
    setText(chipName, n === null ? 'Own levels' : label(n));
    arrange.disabled = !song || !!v.isLocked();
    arrange.title = v.isLocked() ? 'Perform lock is on: unlock to arrange'
      : 'Move the instruments and the sidebar’s modules around';
    chipDot.hidden = !edited;
  }
  applyFold();

  const api = {
    el,
    chip,
    render,
    get folded() {
      return folded;
    },
    setFolded(b) {
      folded = !!b;
      writeFold(folded);
      applyFold();
    },
    destroy() {
      if (liveRow === api) liveRow = null;
      d.dispose();
      el.remove();
      chip.remove();
    },
  };
  liveRow = api;
  return api;
}
