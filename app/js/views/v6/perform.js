// UI v6 Perform shell (D16–D22; native/docs/lanes/UI6-build-plan.md U1; mockup native/docs/design/mockups/
// perform-v6.html). Mounted by main.js instead of views/perform.js while settings.uiV6 is true; flag off, nothing here
// is loaded. Rows: song bar · snapshots (foldable) · board (left panel: Quick + wheel, U4; the strips; right sidebar,
// U3) · keyboard with range bars + Revert / Fade out / PANIC / Lock. The top bar (index.html) is today's.
// Module boundaries (CLAUDE.md): writes go through store.set / store helpers and controller.*, never the engine; the
// engine is only read (instrument names, wheel values, pedal / fade state), as perform.js reads it.
// The returned object keeps perform.js's interface for main.js: savedSnapshot (Edit's changed dots, getBaseline),
// toggleQuick / openQuick / closeQuick (the top-bar Quick button), chartMounts (the hidden chart view), destroy.
import { h, disposer, rafCoalesce } from '../components/util.js';
import { quickSheet } from '../components/quickSheet.js';
import { say, onVoiceChange } from '../components/voice.js';
import { changedPaths, DIFF_WATCH } from '../../shared/song-diff.js';
import { SPACE_PRESETS } from '../../shared/fx-presets.js';
import { isValidPath, SLOT_COUNT } from '../../shared/params.js';
import { slotMuteState, slotWheelFactor, changeCount } from '../perform.js';
import { instrumentNames } from './lib.js';
import { songBar } from './songbar.js';
import { snapshotsRow } from './snapshots.js';
import { stripsRow } from './strips-row.js';
import { bottomRow } from './bottom.js';
import { rangeGuard } from './range-guard.js';
import { rightSidebar } from './sidebar/sidebar.js';
import { leftPanel } from './left.js';
import { songBank } from './bank/bank.js';
import { trialBanner } from './bank/banner.js';
import { PORTRAIT_MQ } from './sidebar/sidebar.js';
import { learnMode } from './learn-mode.js';
import { arrangeMode } from './arrange.js';
import { startBand, emptyLibrary } from './start.js';

/** The v6 stylesheet; linked only while the v6 Perform is mounted (removed again by destroy()). */
export const V6_CSS_HREF = './styles-v6.css';

/**
 * Link styles-v6.css (once) and wait for it, so the v6 Perform never paints unstyled.
 * @returns {Promise<boolean>} false when the sheet failed to load
 */
export function loadV6Css() {
  let link = document.querySelector('link[data-v6-css]');
  if (link && link.sheet) return Promise.resolve(true);
  if (!link) {
    link = h('link', { rel: 'stylesheet', href: V6_CSS_HREF, 'data-v6-css': '' });
    document.head.append(link);
  }
  return new Promise((res) => {
    link.addEventListener('load', () => res(true), { once: true });
    link.addEventListener('error', () => res(false), { once: true });
  });
}

/**
 * What carries a "changed" mark on the v6 Perform: today's watch list (shared/song-diff.js DIFF_WATCH) plus each
 * instrument's range (U2: the range bars are a tap-and-drag control on the stage now, so a range edit counts in
 * Revert's "n changed" and marks its bar). Today's Perform / Edit keep DIFF_WATCH unchanged (flag-off purity).
 */
export const V6_DIFF_WATCH = Object.freeze([...DIFF_WATCH, 'patch.slots.<i>.lowNote', 'patch.slots.<i>.highNote']);

/** Song fields Revert restores (perform.js SAVED_FIELDS, controller.revertSong()). */
const SAVED_FIELDS = ['patch', 'drone', 'tempo', 'hearIn', 'playIn', 'transposeOctave', 'minor'];
const savedJSON = (s) => (s ? JSON.stringify(SAVED_FIELDS.map((k) => s[k])) : '');
const clone = (x) => JSON.parse(JSON.stringify(x));

/**
 * Mount the v6 Perform into `root` (main.js's #view-perform).
 * @param {HTMLElement} root
 * @param {{store, controller, engine, midi, toast, openSettings, setView, quickButton?}} ctx
 * @returns {{el:HTMLElement, readonly savedSnapshot:object|null, readonly changedPaths:string[], toggleQuick():void,
 *            openQuick(opts?:object, from?:HTMLElement):void, closeQuick():void, readonly quickOpen:boolean,
 *            chartMounts:object, left:object,
 *            readonly strips:object[], readonly snapshots:object, destroy():void}}
 */
export function mountPerformV6(root, ctx) {
  const { store, controller, engine, midi } = ctx;
  const d = disposer();
  const isLocked = () => !!store.get().settings.performLock;
  const names = instrumentNames(engine);
  let shownId = null;
  let rangePicked = null; // the instrument whose range bar is picked (onRangePick)
  let kbPicked = null; // …when that pick came from the keyboard (Enter / Space on its name: focusPicked)
  // the range bars' write rule and cancel guards (range-guard.js, shared with the v6 Edit's bottom row, D26.2); its
  // song is shownId (both follow the same render)
  const range = rangeGuard({ store, view: 'perform', kb: () => bottom.kb });
  d.add(() => range.destroy());
  let snap = null; // {id, song, json}: the Revert snapshot, as perform.js
  const takeSnapshot = (song) => {
    snap = song ? { id: song.id, song, json: savedJSON(song) } : null;
  };
  // skeptic UI6-small F4 (UI6-U1 review O4): a Perform swapped in by the v6 switch (main.js swapPerform) keeps the
  // one it replaces' Revert snapshot, so a flip from Settings never makes unsaved changes the new baseline
  if (ctx.carrySnapshot) takeSnapshot(ctx.carrySnapshot);
  const liveOf = (song) => (song && controller.scenes ? controller.scenes.view(song) : song);
  /** While a scene plays, level moves are live moves on top of it (perform.js sceneLevel, v11-scenes). */
  const sceneLevel = (path, value) => !!(shownId && controller.scenes?.state().id === shownId
    && controller.scenes.adjust(path, value));
  const setSlot = (i, field, value) => {
    if (!shownId || !store.getSong(shownId)?.patch.slots[i]) return;
    const addr = `songs.${shownId}.patch.slots.${i}.${field}`;
    // D26.1: a send the playing snapshot holds goes on top of it (heard, transient, kept by Save), not into the song
    if (controller.scenes?.take?.(addr, value)) return;
    store.set(addr, value);
  };
  const toast = (msg, kind, o) => ctx.toast?.(msg, kind, o);

  /** The view context every v6 module gets (lib.js / strip.js / … document what they use). */
  const v = {
    store, controller, engine, ctx, toast, isLocked, names,
    snap: () => snap,
    /** U7c (the song menu's Reset): nothing differs from the Revert snapshot. */
    isSaved: () => {
      const s = shownId && store.getSong(shownId);
      return !s || !snap || snap.id !== s.id || savedJSON(s) === snap.json;
    },
    sceneLevel,
    liveOf,
    /** U3: the song bar's Setlist / Notes buttons open the sidebar on that module. */
    openSidebar: (id) => side?.open(id),
    /** U7a: the Song bank browser over the stage (the Setlist module's + Add song › From the Song bank). */
    openBank: (o) => openBank(o),
    setSlot,
    setSlotGain(i, x) {
      if (!sceneLevel(`slots.${i}.gain`, x)) setSlot(i, 'gain', x);
    },
    setMuted(i, muted) {
      if (!shownId) return;
      const slot = liveOf(store.getSong(shownId))?.patch.slots[i];
      if (!slot) return;
      if (slotMuteState(slot).muted !== muted && !sceneLevel(`slots.${i}.muted`, muted)) {
        store.set(`songs.${shownId}.patch.slots.${i}.muted`, muted);
      }
      render(store.get()); // a refused write puts the tile back
    },
    /** Space room (fx-presets.js) → this song's reverb params, as perform.js applyPreset. */
    applySpace(id) {
      const p = SPACE_PRESETS.find((x) => x.id === id);
      if (!p || !shownId) return;
      for (const [path, val] of Object.entries(p.params)) {
        if (!isValidPath(path)) continue;
        const target = path.startsWith('master.') ? `songs.${shownId}.patch.fx.master.${path.slice(7)}`
          : `songs.${shownId}.patch.${path}`;
        if (!controller.scenes?.take?.(target, val)) store.set(target, val); // D26.1: a snapshot's room first
      }
    },
    /** "+ Add instrument": an empty slot at the end, then Edit's instrument picker on it (as Edit's "Slots" menu). */
    addSlot() {
      if (!shownId || isLocked()) return;
      const i = store.addSlot(shownId);
      if (i < 0) return;
      // after the store's change event (a microtask), so Edit's tab for the new slot exists when it is selected
      queueMicrotask(() => ctx.setView?.('edit', { block: `slot:${i}`, focus: 'instrument' }));
    },
    /**
     * ⋯ Duplicate (D23.2): a deep copy right after the original (store.insertSlot), with the original's scene entries
     * (scenesFrom), so the copy follows the snapshots as the original does. Later instruments move one place right.
     */
    duplicateSlot(i) {
      const s = shownId && store.getSong(shownId);
      const slot = s?.patch.slots[i];
      if (!slot || isLocked()) return;
      const k = store.insertSlot(shownId, i, clone(slot), { scenesFrom: i });
      if (k >= 0) toast(`Added a copy of ${names.name(slot.instrument)} next to it.`, 'ok', { ms: 2500 });
    },
    /**
     * ⋯ Earlier / Later and the strip drag (D23.2): the instrument at `from` goes to `to` with everything it has
     * (store.moveSlot: the slot, its scene entries, wheel targets). Frozen under Perform lock, like Add / Remove.
     * @returns {boolean} moved
     */
    moveSlot(from, to) {
      if (!shownId || isLocked()) return false;
      return store.moveSlot(shownId, from, to);
    },
    /** After a keyboard Earlier / Later: the focus follows the instrument (its ⋯ at the new place). */
    focusMore: (i) => row.focusMore(i),
    /** U7c Arrange: after a keyboard ◀ / ▶ the focus follows the instrument. */
    focusArr: (i, which) => row.focusArr(i, which),
    removeSlot(i) {
      const s = shownId && store.getSong(shownId);
      if (!s || isLocked()) return;
      const nm = s.patch.slots[i] ? names.name(s.patch.slots[i].instrument) : 'the empty slot';
      if (store.removeSlot(shownId, i)) toast(`Removed ${nm}.`, 'ok', { ms: 2500 });
      else toast(`Could not remove ${nm}.`, 'error');
    },
    revertSong() {
      if (!snap || !shownId || snap.id !== shownId) return;
      const s = snap.song;
      const cur = store.getSong(shownId);
      if (!cur) return;
      for (const k of SAVED_FIELDS) {
        if (JSON.stringify(cur[k]) !== JSON.stringify(s[k])) store.set(`songs.${shownId}.${k}`, s[k]);
      }
      if (controller.scenes?.state().n !== null) controller.scenes?.go(null);
      toast(`“${s.name}” is back to how it was when you selected it.`, 'ok', { ms: 3000 });
    },
    setFaded: (on) => setFaded(on),
    /** A range bar's end moved (keyboard.js): range-guard.js setRange (the write rule, D24.2, UI6-U2 review O3). */
    setRange: (i, field, note, phase, expect) => range.setRange(i, field, note, phase, expect),
    /** A strip's name was tapped / clicked (every pointer, D24.3): change that instrument's range (again: finish). */
    pickRange(i) {
      const kb = bottom.kb;
      if (isLocked()) return;
      kb.pick(kb.picked === i ? null : i);
    },
    /**
     * UI6-move O2 (U8a): a keyboard pick (Enter / Space on a strip's name) moves the focus to the picked bar's lowest
     * handle, so ←/→ work at once (with pick first, D24.3, the handles were up to 32 Tab presses away).
     * @param {number} i
     */
    focusPicked(i) {
      const kb = bottom.kb;
      if (kb.picked !== i) return;
      const hd = kb.el.querySelector(`.v6-rbar[data-slot="${i}"] [data-end="lo"]`);
      if (!hd) return;
      hd.focus({ preventScroll: true });
      kbPicked = i;
    },
    /**
     * keyboard.js → the strips: outline + "changing range" on the picked one. When the pick ends (Esc, the keys, a
     * song switch) with the focus on one of its handles, the focus goes back to that instrument's name (U8a: a
     * handle that is no longer live must not keep it).
     */
    onRangePick: (i) => {
      const prev = rangePicked;
      const byKeys = kbPicked !== null && kbPicked === prev;
      rangePicked = i;
      if (i !== kbPicked) kbPicked = null;
      row.setPicked(i);
      // the keyboard's own repaint has already dropped the focus from the handle (to <body>) when it says so
      const a = document.activeElement;
      const lost = !a || a === document.body || (!!a.dataset?.end && bottom.kb.el.contains(a));
      if (i === null && byKeys && lost) {
        row.el.querySelector(`[data-testid="v6-who-${prev}"]`)?.focus({ preventScroll: true });
      }
    },
    onCoarse: (c) => {
      el.classList.toggle('coarse', c);
      row.setCoarse(c);
    },
  };

  // ---------------------------------------------------------------- layout
  const el = h('div.v6.v6-perform', { 'data-testid': 'v6-perform' });
  v.host = el; // popovers go here, outside the strips' scroller
  let quickPlaced = null; // the sheet's re-anchoring (placeQuick below), once the sheet exists
  const snaps = snapshotsRow(v, {
    onArrange: () => v.arrange?.enter(), // U7c
    onFold: (f) => {
      el.classList.toggle('snaps-folded', f);
      // skeptic UI6-U4 F1: the board (and the left Quick) moved up or down under an open sheet (not while mounting:
      // snapshotsRow applies the saved fold before the sheet exists)
      if (quickPlaced) quickPlaced.push();
    },
  });
  const bar = songBar(v, el, snaps.chip);
  const row = stripsRow(v);
  // U4: the left panel (views/v6/left.js): a Quick button (the same sheet as the top bar's) + today's wheel column
  const lp = leftPanel(v, { onQuick: (btn) => toggleQuick(btn) });
  d.add(() => lp.destroy());
  const left = lp.el;
  // U3: the right sidebar (views/v6/sidebar/): Drone · Setlist · Notes as tabs, a rail when folded, resizable
  const side = rightSidebar(v, { onChange: (s) => bar.setSide(s) });
  const right = side.el;
  // U8a: an empty library says so where the strips go (start.js emptyLibrary)
  const empty = emptyLibrary(v);
  d.add(() => empty.destroy());
  const board = h('div.v6-board', { 'data-testid': 'v6-board' }, left, row.el, empty.el, right);
  const bottom = bottomRow(v);
  v.onCoarse(bottom.kb.coarse);
  const quick = quickSheet({
    anchor: ctx.quickButton || null,
    onTempo: (bpm) => shownId && store.set(`songs.${shownId}.tempo`, bpm),
    onSwell: (s) => shownId && store.set(`songs.${shownId}.patch.swell.seconds`, s),
    onTouch: (x) => !isLocked() && store.set('settings.velocitySens', x),
    onPedalReversed: (b) => !isLocked() && store.set('settings.pedalInvert', !!b),
    onRestartAudio: () => controller.restartAudio(),
    onSaveScene: (n) => {
      if (controller.scenes?.save(n)) toast(say('sceneSaved', { n: n + 1 }), 'ok', { ms: 3000 });
    },
    onResumeAudio: () => (typeof controller.resumeAudio === 'function' ? controller.resumeAudio()
      : controller.restartAudio()),
    onAllSettings: () => {
      quick.close();
      ctx.openSettings?.();
    },
    // U4: the sheet has two openers (the top bar's Quick and the left panel's); quickSheet keeps the top bar's
    // aria-expanded and Esc focus, this keeps the left one's and hands Esc's focus back to whichever opened it
    onClose: (reason) => {
      const from = quickFrom;
      quickFrom = null;
      lp.setQuickOpen(false);
      if (reason === 'escape' && from === lp.quickBtn && document.activeElement === ctx.quickButton) from.focus();
    },
  });
  let quickFrom = null; // the button that opened the sheet (U4)
  d.add(() => quick.destroy());
  // U7a (D17): the "Trying …" banner under the song bar, and the Song bank browser over the strips + sidebar (made on
  // first use; the left panel, the keyboard row and PANIC stay live beside / under it)
  const banner = trialBanner(v);
  d.add(() => banner.destroy());
  // U7c: MIDI Learn on Perform and Arrange, each a bar under the song bar (learn-mode.js, arrange.js)
  const learn = learnMode(v);
  v.learn = learn;
  d.add(() => learn.destroy());
  const arrange = arrangeMode(v, { sidebar: side });
  v.arrange = arrange;
  d.add(() => arrange.destroy());
  // U8a (edge states): the first-run Start here card, as today's Perform shows it (top of its Notes panel there)
  const start = startBand(v, { onChange: () => quickPlaced?.push() });
  d.add(() => start.destroy());
  let bank = null;
  const placeBank = () => {
    if (!bank || !bank.isOpen) return;
    const portrait = typeof window.matchMedia === 'function' && window.matchMedia(PORTRAIT_MQ).matches;
    const b = board.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(board).columnGap) || 10;
    const l = portrait ? 0 : Math.max(0, Math.round(left.getBoundingClientRect().right - b.left + gap));
    bank.el.style.setProperty('--bank-left', `${l}px`);
  };
  const setBankOpen = (on) => {
    board.classList.toggle('bank-open', on);
    for (const x of [row.el, right]) x.inert = on; // under the browser: not reachable by Tab / screen readers
  };
  function openBank(o = {}) {
    if (!bank) {
      bank = songBank(v, { onClose: () => setBankOpen(false) });
      board.append(bank.el);
    }
    quick.close();
    bank.open(o);
    setBankOpen(true);
    placeBank();
  }
  d.listen(window, 'resize', placeBank);
  el.append(bar.el, snaps.el, banner.el, learn.el, arrange.el, start.el, board, bottom.el, quick.el);
  root.classList.remove('locked');
  root.replaceChildren(el);

  // ---------------------------------------------------------------- reads
  let status = controller.status || {};
  let lastView = store.get().settings.view;
  const wheelNow = () => {
    try {
      return engine?.wheelValues?.() || { mod: 1, expr: 1, vol: 1 };
    } catch {
      return { mod: 1, expr: 1, vol: 1 };
    }
  };

  function render(state) {
    const st = state.settings;
    const song = state.songs[st.currentSongId] || null;
    const newId = song ? song.id : null;
    if (newId !== shownId) {
      // round2-ui #2 (as perform.js): a hand on a fader must not carry its drag into the next song
      row.cancelDrags();
      row.closePanels();
      bar.closePops();
    }
    // a range drag / pick: dropped on a song switch, a slot count change (skeptic UI6-U2 F3: an Add / Remove by any
    // store write moves which instrument sits at each position) and another view (UI6-U2 F4: the hidden keyboard
    // measures 0 px wide); D24.2: the cancel puts the start value back. range-guard.js sync.
    range.sync(state);
    // a strip reorder drag ends too when the view hides it (D23.2)
    if (st.view !== 'perform') row.cancelDrags();
    shownId = newId;
    const locked = !!st.performLock;
    if (!song) snap = null;
    else if (!snap || (st.view === 'perform' && lastView === 'edit')) takeSnapshot(song);
    lastView = st.view;
    if (st.view !== 'perform') quick.close();
    const base = song && snap && snap.id === song.id ? snap.song : null;
    const changed = base ? changedPaths(song, base, V6_DIFF_WATCH) : new Set();
    const live = liveOf(song);
    const w = wheelNow();
    bar.render(state);
    start.render(state);
    empty.render(state);
    board.classList.toggle('no-song', empty.shown);
    side.render(state);
    lp.render({ song: live, names });
    snaps.render(song);
    row.render({
      song: live, base, changed, locked, names,
      playable: typeof controller.engineSlots === 'function' ? controller.engineSlots() : SLOT_COUNT,
      wheel: (i) => slotWheelFactor(live.patch, i, w),
    });
    const same = !song || !snap || snap.id !== song.id || savedJSON(song) === snap.json;
    bottom.render({ song: live, same, count: changeCount(changed), locked, names, changed });
    el.classList.toggle('locked', locked);
    if (quick.isOpen) renderQuick();
  }

  function renderQuick() {
    const state = store.get();
    const st = state.settings;
    const song = state.songs[st.currentSongId] || null;
    const dl = song?.patch.fx?.delay;
    const a = status.audio;
    const sc = controller.scenes?.state();
    quick.set({
      scenes: sc && song && sc.id === song.id ? { count: sc.count, n: sc.n, max: controller.scenes.max } : null,
      songName: song ? song.name : '',
      tempo: song?.tempo ?? null,
      swell: song?.patch.swell?.seconds ?? 8,
      touch: st.velocitySens,
      pedalReversed: !!st.pedalInvert,
      pedal: pedalDown,
      sound: status.instance === 'secondary' ? 'muted' : a === 'suspended' ? 'paused'
        : a === 'stalled' || a === 'restarting' ? a : 'ok',
      latencyMs: Number(status.latencyMs) || null,
      outputDeviceId: st.outputDeviceId || 'default',
      locked: !!st.performLock,
      audio: a,
      echoSynced: !dl || !(Number(dl.returnGain) > 0) ? null : dl.sync && dl.sync !== 'off',
    });
  }
  /**
   * Open the sheet by the button that asked (U4, mockup "Left · Quick open"): from the left panel's Quick it is a
   * panel beside that button, over the strips (.from-left; its arrow points left at the button); from the top bar's
   * it drops under that button (its arrow points up, as today). Either way it floats: nothing reflows while playing.
   * @param {object} [opts]  quickSheet open() options ({focus})
   * @param {HTMLElement} [from]  the opener (default: the top bar's Quick)
   */
  const openQuick = (opts, from = ctx.quickButton || null) => {
    if (quick.isOpen) return;
    renderQuick();
    quickFrom = from;
    placeQuick(from);
    lp.setQuickOpen(true); // both buttons say the one sheet is open (quickSheet marks the top bar's)
    quick.open(opts);
  };
  /**
   * Anchor the sheet to its opener. Also run on a window resize while it is open (skeptic UI6-U4 F1: an iPad
   * rotation or a Mac window resize moved the button, e.g. the column narrows to 64 px below 1100 px, and the sheet
   * stayed where it was: 32 px off the button, its arrow pointing at nothing, over Revert).
   * @param {HTMLElement|null} from
   */
  function placeQuick(from) {
    const p = el.getBoundingClientRect();
    const a = from?.getBoundingClientRect();
    const side = from === lp.quickBtn;
    quick.el.classList.toggle('from-left', side);
    quick.el.classList.toggle('from-top', !side);
    if (a && a.width) {
      if (side) {
        quick.el.style.setProperty('--qleft', `${Math.round(a.right - p.left + 12)}px`);
        quick.el.style.setProperty('--qtop', `${Math.round(a.top - p.top)}px`);
        quick.el.style.setProperty('--qy', `${Math.round(a.height / 2 - 7)}px`);
      } else {
        // 400 px: styles-v6-left.css .v6 .qs width; kept inside the v6 view on the right
        const left = Math.max(14, Math.min(Math.round(a.left - p.left - 14), Math.round(p.width - 414)));
        quick.el.style.setProperty('--qleft', `${left}px`);
        quick.el.style.setProperty('--qtop', '12px');
        quick.el.style.setProperty('--qx', `${Math.max(12, Math.round(a.left + a.width / 2 - p.left - left - 7))}px`);
      }
    }
  }
  const replaceQuick = rafCoalesce(() => {
    if (quick.isOpen && !root.hidden) placeQuick(quickFrom);
  });
  d.add(() => replaceQuick.cancel());
  d.listen(window, 'resize', () => {
    if (quick.isOpen) replaceQuick.push();
  });
  quickPlaced = replaceQuick;
  /** Either Quick button: close the sheet if it is open (whichever opened it), else open it by that button. */
  const toggleQuick = (from) => {
    if (quick.isOpen) quick.close();
    else openQuick(undefined, from);
  };

  // ---------------------------------------------------------------- runtime: pedal, faded (as perform.js readRuntime)
  let faded = false;
  let pedalDown = false;
  function setFaded(on) {
    faded = !!on;
    bottom.setFaded(faded, say('fadedButton'));
  }
  function readRuntime() {
    let p = false;
    let f = faded;
    try {
      p = !!engine?.pedal;
      const rs = typeof engine?.getRuntimeState === 'function' ? engine.getRuntimeState() : null;
      f = rs ? !!rs.faded : !!engine?._fade;
    } catch {
      /* engine not started */
    }
    if (p !== pedalDown) {
      pedalDown = p;
      el.classList.toggle('pedal-down', p);
      if (quick.isOpen) quick.set({ pedal: p });
    }
    lp.setPedal(p); // U4: the wheel column's lamp (it times "Pedal held" itself)
    if (f !== faded) setFaded(f);
  }
  // no polling while Perform is hidden (Edit); 1 Hz under low-resource / a hidden window (perform.js idle-cpu-ui)
  let runtimeTimer = 0;
  const runtimeTick = () => {
    if (!root.hidden) readRuntime();
    const de = document.documentElement;
    const low = de.hasAttribute('data-low-resource') || de.hasAttribute('data-window-hidden');
    runtimeTimer = setTimeout(runtimeTick, low ? 1000 : 150);
  };
  runtimeTimer = setTimeout(runtimeTick, 150);
  d.add(() => clearTimeout(runtimeTimer));

  /** The part a held key sounds on (perform.js partOf): the first unmuted slot whose range holds it. */
  function partOf(n) {
    const song = liveOf(store.currentSong());
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
    const on = store.get().settings.computerKeyboard !== false && !status.midi?.connected;
    bottom.setLetters(on, Number(controller.kbOctave) || 0);
  };
  const wheelRaf = rafCoalesce(() => {
    const song = liveOf(store.currentSong());
    if (!song) return;
    const w = wheelNow();
    row.setWheel(song.patch.slots.map((s, i) => (s ? slotWheelFactor(song.patch, i, w) : null)));
  });
  d.add(() => wheelRaf.cancel());

  // ---------------------------------------------------------------- subscriptions
  d.add(store.subscribe((state) => render(state)));
  // D23 (U-MOVE-store review O1): a move keeps the slot count, so the count-keyed protections above never see it.
  // store.onSlotMap runs synchronously in the write that re-orders the shown song (insert, move, remove, a realigning
  // Revert; here, in Edit or anywhere): ⋯ menus, step panels, fader and reorder drags end at once; a range drag first
  // follows its instrument to its new index (so its restore lands there, or nowhere when it was removed), then is
  // dropped, with the pick, after the store's change notification (a microtask; no store write from inside the
  // store's own call).
  if (typeof store.onSlotMap === 'function') {
    d.add(store.onSlotMap(({ id, order }) => {
      if (id !== shownId) return;
      row.slotMap();
      range.slotMap({ id, order });
    }));
  }
  d.add(store.subscribe((state, paths) => {
    if (!paths || paths.some((p) => p === 'settings' || p === 'settings.computerKeyboard')) renderLetters();
  }));
  d.add(onVoiceChange(() => {
    render(store.get());
    setFaded(faded);
  }));
  d.add(controller.onStatus((s) => {
    status = s;
    start.setMidi(!!s.midi?.connected);
    renderLetters();
    bar.renderSetlist();
    if (quick.isOpen) renderQuick();
  }));
  d.listen(controller, 'kb-octave', renderLetters);
  d.listen(controller, 'songSelected', (e) => {
    const det = e.detail || {};
    const song = det.songSnapshot || store.getSong(det.id);
    if (!song) return;
    takeSnapshot(song);
    quick.close();
    render(store.get());
  });
  d.listen(controller, 'instance', (e) => {
    if (e.detail?.instance !== 'primary') return;
    takeSnapshot(store.currentSong());
    render(store.get());
  });
  d.listen(controller, 'action', (e) => {
    const det = e.detail || {};
    if (det.type === 'panic') {
      bottom.releaseAll();
      readRuntime();
    }
    if (det.type === 'fadeOutAll') setFaded(true);
    if (det.type === 'swell') wheelRaf.push();
    if (det.type === 'importBackup') {
      takeSnapshot(store.currentSong());
      render(store.get());
    }
    if (det.type === 'packSongsUpdated' && snap && Array.isArray(det.ids) && det.ids.includes(snap.id)) {
      takeSnapshot(store.getSong(snap.id));
      render(store.get());
    }
  });
  d.listen(controller, 'scene', () => render(store.get()));
  d.listen(controller, 'wheel', () => wheelRaf.push());
  // the chord readout is live only while ≥ 2 keys are physically held (perform.js polish-2A G1)
  let physHeld = 0;
  let engineChord = null;
  let chordLive = false;
  const refreshChord = () => {
    const live = physHeld >= 2 && !!(engineChord && engineChord.name);
    if (live) bar.setChord(engineChord);
    else if (chordLive) bar.setChord(null);
    chordLive = live;
  };
  d.listen(controller, 'chord', (e) => {
    engineChord = e.detail ? e.detail.chord : null;
    refreshChord();
  });
  d.listen(controller, 'notes', (e) => {
    const held = e.detail ? e.detail.held : [];
    physHeld = held ? (held.size ?? held.length ?? 0) : 0;
    queueMicrotask(refreshChord);
    bottom.setHeld(held, partOf);
    if (faded && held && (held.size || held.length)) queueMicrotask(readRuntime);
  });
  const onInstruments = () => {
    if (names.refresh()) render(store.get());
  };
  for (const [t, ev] of [[controller, 'ready'], [controller, 'instruments'], [controller, 'user-samples'],
    [window, 'rig-instruments-changed']]) d.listen(t, ev, onInstruments);
  if (engine) {
    d.listen(engine, 'ready', onInstruments);
    d.listen(engine, 'instruments', onInstruments);
  }
  if (midi) d.listen(midi, 'cc', (e) => {
    if (e.detail?.cc === 64) queueMicrotask(readRuntime);
  });

  render(store.get());
  start.setMidi(!!status.midi?.connected);
  renderLetters();
  readRuntime();

  return {
    el,
    get savedSnapshot() {
      return snap ? snap.song : null;
    },
    get changedPaths() {
      const song = store.currentSong();
      return song && snap && snap.id === song.id ? [...changedPaths(song, snap.song, V6_DIFF_WATCH)] : [];
    },
    toggleQuick: () => toggleQuick(ctx.quickButton || null),
    /** main.js / tests: open the sheet (by the top bar's Quick unless `from` says otherwise). */
    openQuick: (opts, from) => openQuick(opts, from),
    closeQuick: () => quick.close(),
    get quickOpen() {
      return quick.isOpen;
    },
    /**
     * The hidden chart view (D7): today's toggle goes after Notes and its panel over the board; U7b's v6 chart
     * (views/v6/chart/, main.js mounts it instead while this Perform is on) uses `v6`: the view context, the sidebar
     * (a Chart module), the board and the strips area (the chart on the stage), the instrument names.
     */
    chartMounts: { after: bar.notesBtn, stage: board, v6: { v, side, board, strips: row.el, names } },
    /** Test hooks. */
    get strips() {
      return row.strips;
    },
    /** D23.2: the strip reorder drag in progress ({from, to}) or null. */
    get reorder() {
      return row.reorder;
    },
    /** The keyboard with range bars (picked, dragging, …). */
    get kb() {
      return bottom.kb;
    },
    snapshots: snaps,
    sidebar: side,
    left: lp,
    /** U7a (D17): open the Song bank browser ({mode: 'bank'|'library', focus}); the browser and banner (tests). */
    openBank: (o) => openBank(o),
    get bank() {
      return bank;
    },
    banner,
    /** U8a: the first-run Start here card (components/startCard.js; `card.reset()` shows it again). */
    start,
    /** U7c: MIDI Learn on Perform, Arrange, the song menu. */
    learn,
    arrange,
    get songMenu() {
      return bar.menu;
    },
    destroy() {
      // U7a: a trial is a v6 Perform thing; leaving the v6 Perform (the flag going off) goes back from it
      if (typeof controller.trial === 'function' && controller.trial()) controller.backFromTrial();
      bank?.destroy();
      bank = null;
      d.dispose();
      side.destroy();
      bar.destroy();
      snaps.destroy();
      row.destroy();
      bottom.destroy();
      el.remove();
      root.replaceChildren();
      document.querySelector('link[data-v6-css]')?.remove();
    },
  };
}
