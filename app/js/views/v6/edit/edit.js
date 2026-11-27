// UI v6 Edit shell (U5a; native DECISIONS D15, D18, D22; native/docs/lanes/UI6-build-plan.md U5; mockup
// native/docs/design/mockups/edit.html). Mounted by main.js instead of views/edit/shell.js (mountEdit) while
// settings.uiV6 is true; flag off, nothing here is loaded.
//
// Layout: library column (today's setlist module + a Song bank… button; folds to a rail, per device) · song header
// (today's song-header module + time signature + Chart while the chart view is on) · "Your rig" tabs (one per
// instrument, named by the instrument, its position colour and dB, a changed dot; + Add; then Drone / Effects /
// Master) · the panel (views/v6/edit/instrument.js for an instrument; U5b: drone.js / effects.js / master.js in the
// same category-list frame, catpanel.js; today's song panel inside the v6 frame) · U5b: the v6 Perform's bottom row
// (views/v6/bottom.js through ./bottom.js: range-bar keyboard + Revert / Fade out / PANIC / Lock).
//
// It reuses today's Edit core (shell.js createEditCore: store fan-out, Revert baseline + changed set, Esc stack,
// instruments, held notes, per-panel ctx) so every reused panel behaves exactly as in today's Edit; the external
// interface is mountEdit's ({el, editState, destroy, _debug}; main.js setView → editState.select(block, {focus})).
// Module boundaries (CLAUDE.md): writes go through store.set / store helpers / controller.*; the engine is only read.
import { h, setText, createBinder, blockOf } from '../../edit/lib.js';
import { createEditCore, editPanelFrame, editDefaultTab, editFollowSelectedSlot } from '../../edit/shell.js';
import dronePanel from '../../edit/panels/drone.js';
import { formatValue, MAX_SLOTS } from '../../../shared/params.js';
import { changedPaths, hasChange } from '../../../shared/song-diff.js';
import { TIME_SIGS, DEFAULT_TIME_SIG } from '../../../shared/click-math.js';
import { slotMuteState } from '../../perform.js';
import { V6_DIFF_WATCH, loadV6Css } from '../perform.js';
import { slotColor, instrumentNames } from '../lib.js';
import { mountInstrument, CATEGORY_IDS, instCatChanges } from './instrument.js';
import { mountDrone, droneChanges, DRONE_CATS } from './drone.js';
import { mountEffects, effectsChanges, EFFECTS_CATS } from './effects.js';
import { mountMaster, masterChanges, masterCats } from './master.js';
import { editBottom } from './bottom.js';

/** The v6 Edit stylesheet; linked only while the v6 Edit is mounted (removed again by destroy()). */
export const V6_EDIT_CSS_HREF = './styles-v6-edit.css';
/**
 * Per-device Edit layout: {cat: the chosen instrument category, lib: 'folded' | absent, cats: {drone, effects,
 * master}: each shared panel's chosen category (U5b)}. Never in the library.
 */
export const V6_EDIT_KEY = 'worship-rig.v6.edit';
/** iPad portrait (the sidebar's query, views/v6/sidebar/sidebar.js PORTRAIT_MQ). */
const PORTRAIT_MQ = '(orientation: portrait) and (max-width: 1024px)';

/**
 * Link styles-v6-edit.css (once) and wait for it, plus styles-v6.css (the strip's look; U1's loader).
 * @returns {Promise<boolean>}
 */
export function loadV6EditCss() {
  let link = document.querySelector('link[data-v6-edit-css]');
  const own = link && link.sheet ? Promise.resolve(true) : new Promise((res) => {
    if (!link) {
      link = h('link', { rel: 'stylesheet', href: V6_EDIT_CSS_HREF, 'data-v6-edit-css': '' });
      document.head.append(link);
    }
    link.addEventListener('load', () => res(true), { once: true });
    link.addEventListener('error', () => res(false), { once: true });
  });
  return Promise.all([loadV6Css(), own]).then(([a, b]) => a && b);
}

/** @returns {{cat?:string, lib?:string}} */
function readPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(V6_EDIT_KEY) || '{}');
    const out = {};
    if (raw && CATEGORY_IDS.includes(raw.cat)) out.cat = raw.cat;
    if (raw && raw.lib === 'folded') out.lib = 'folded';
    const known = { drone: DRONE_CATS, effects: EFFECTS_CATS, master: masterCats() };
    if (raw && raw.cats && typeof raw.cats === 'object') {
      for (const [k, list] of Object.entries(known)) {
        if (list.some((c) => c.id === raw.cats[k])) (out.cats ||= {})[k] = raw.cats[k];
      }
    }
    return out;
  } catch {
    return {};
  }
}
function writePrefs(p) {
  try {
    localStorage.setItem(V6_EDIT_KEY, JSON.stringify(p));
  } catch {
    /* private mode / full storage: the layout is only this session's */
  }
}
const clone = (x) => JSON.parse(JSON.stringify(x));

/**
 * Mount the v6 Edit view (same interface as views/edit/shell.js mountEdit).
 * @param {HTMLElement} el   main.js's #view-edit
 * @param {object} ctx       the app ctx (store, controller, engine, midi, recorder, toast, openSettings, setView,
 *                           getBaseline)
 * @returns {{el:HTMLElement, editState:object, destroy():void, _debug:object}}
 */
export function mountEditV6(el, ctx) {
  const { store, controller, engine } = ctx;
  // .ev2 too: today's Edit widgets and the reused panels (wordSlider, sentence, setlist, song header, drone…) are
  // styled under .ev2; styles-v6-edit.css undoes the .ev2 grid on this root
  const root = h('div.v6.v6-edit.ev2', { 'data-testid': 'v6-edit' });
  const core = createEditCore(root, ctx);
  const { editState } = core;
  const prefs = readPrefs();
  const names = instrumentNames(engine);
  const isLocked = () => !!store.get().settings.performLock;
  const toast = (msg, kind, o) => ctx.toast?.(msg, kind, o);

  // ---- the v6 changed set: today's watch list + each instrument's range (as v6 Perform: V6_DIFF_WATCH). Memoised
  // on the (frozen) song and baseline objects, so readers in any order see the current set.
  let memo = { song: undefined, base: undefined, set: new Set() };
  const v6Changes = () => {
    const s = core.song;
    const b = editState.baseline;
    if (s !== memo.song || b !== memo.base) {
      memo = { song: s, base: b, set: s && b ? changedPaths(s, b, V6_DIFF_WATCH) : new Set() };
    }
    return memo.set;
  };

  // ---- U5b: the rig tabs' dots = "changed since the song began" over every category of that tab (memoised as above)
  let tabMemo = { song: undefined, base: undefined, ids: new Set() };
  const tabDots = () => {
    const s = core.song;
    const b = editState.baseline;
    if (s === tabMemo.song && b === tabMemo.base) return tabMemo.ids;
    const ids = new Set();
    if (s && b) {
      const n = Math.max(s.patch.slots.length, b.patch?.slots?.length || 0);
      for (let i = 0; i < n; i++) {
        const sl = s.patch.slots[i] || null;
        const meta = sl ? core.findInstrument(sl.instrument) : null;
        if (instCatChanges(sl, b.patch?.slots?.[i] || null, meta, i).size) ids.add(`slot:${i}`);
      }
      if (droneChanges(s, b).size) ids.add('drone');
      if (effectsChanges(s, b).size) ids.add('effects');
      if (masterChanges(s, b).size) ids.add('master');
    }
    tabMemo = { song: s, base: b, ids };
    return ids;
  };

  // ---- the view context strip.js expects (v6 Perform's `v`): the same writes as the v6 Perform's strips
  const liveOf = (song) => (song && controller.scenes ? controller.scenes.view(song) : song);
  const shownId = () => core.songId;
  const sceneLevel = (path, value) => !!(shownId() && controller.scenes?.state().id === shownId()
    && controller.scenes.adjust(path, value));
  const setSlot = (i, field, value) => {
    const id = shownId();
    if (!id || !store.getSong(id)?.patch.slots[i]) return;
    const addr = `songs.${id}.patch.slots.${i}.${field}`;
    // UI6-snap F2: the strip's Space / Echo steps go on top of a snapshot that holds them, as on v6 Perform
    // (views/v6/perform.js setSlot): heard, transient, never written into the song
    if (controller.scenes?.take?.(addr, value)) return;
    store.set(addr, value);
  };
  const stripV = {
    store, controller, engine, ctx, toast, isLocked, host: root,
    snap: () => null,
    sceneLevel,
    liveOf,
    setSlot,
    setSlotGain(i, x) {
      if (!sceneLevel(`slots.${i}.gain`, x)) setSlot(i, 'gain', x);
    },
    setMuted(i, muted) {
      const id = shownId();
      const slot = id ? liveOf(store.getSong(id))?.patch.slots[i] : null;
      if (!slot) return;
      if (slotMuteState(slot).muted !== muted && !sceneLevel(`slots.${i}.muted`, muted)) {
        store.set(`songs.${id}.patch.slots.${i}.muted`, muted);
      }
      cur?.inst?.refresh?.(); // a refused write puts the tile back
    },
    /** D23: the copy goes next to the original (store.insertSlot), and Edit shows it. */
    duplicateSlot(i) {
      const id = shownId();
      const slot = id ? store.getSong(id)?.patch.slots[i] : null;
      if (!slot || isLocked()) return;
      const k = typeof store.insertSlot === 'function' ? store.insertSlot(id, i, clone(slot), { scenesFrom: i })
        : store.addSlot(id, clone(slot));
      if (k < 0) return;
      toast(`Added a copy of ${names.name(slot.instrument)}.`, 'ok', { ms: 2500 });
      queueMicrotask(() => editState.select(`slot:${k}`));
    },
    removeSlot(i) {
      const id = shownId();
      const s = id && store.getSong(id);
      if (!s || isLocked()) return;
      const nm = s.patch.slots[i] ? names.name(s.patch.slots[i].instrument) : 'the empty place';
      if (store.removeSlot(id, i)) toast(`Removed ${nm}.`, 'ok', { ms: 2500 });
      else toast(`Could not remove ${nm}.`, 'error');
    },
    moveSlot(from, to) {
      const id = shownId();
      if (!id || isLocked() || typeof store.moveSlot !== 'function') return false;
      // the selected tab follows the instrument through store.onSlotMap (below); a store without it: by hand
      const ok = store.moveSlot(id, from, to);
      if (ok && typeof store.onSlotMap !== 'function' && editState.selected === `slot:${from}`) {
        queueMicrotask(() => editState.select(`slot:${to}`));
      }
      return ok;
    },
    /**
     * UI6-U5a review R2: the strip's name is a button on every pointer since D24.3 (on Perform it picks the range bar).
     * Edit's strip is the selected instrument's, and its "pick" is the Range category for that instrument.
     */
    pickRange(i) {
      if (!isLocked()) editState.select(`slot:${i}`, { focus: 'range' });
    },
  };

  // ---------------------------------------------------------------- layout
  const libMod = h('div.v6e-libmod');
  const foldBtn = h('button.btn.v6e-fold', {
    type: 'button', 'aria-label': 'Fold the library', title: 'Fold the library', 'data-testid': 'v6e-lib-fold',
  }, '⟨');
  const lib = h('aside.ev2-left.v6e-lib', { 'aria-label': 'Library', 'data-testid': 'v6e-lib' },
    h('div.v6e-lib-h', {}, h('span.v6e-cap', { text: 'Library' }), foldBtn), libMod);
  const unfoldBtn = h('button.btn.v6e-unfold', {
    type: 'button', 'aria-label': 'Show the library', title: 'Show the library', 'data-testid': 'v6e-lib-unfold',
  }, h('span', { 'aria-hidden': 'true', text: '⟩' }), h('span.v6e-rail-lab', { text: 'Library' }));
  const rail = h('div.v6e-librail', { 'data-testid': 'v6e-lib-rail' }, unfoldBtn);
  const headHost = h('header.ev2-head.v6e-head', { 'aria-label': 'Song', 'data-testid': 'v6e-head' });
  // UI6-U5a O3: the tablist holds only the tabs. "+ Add" and the separator sit beside it in the scrolling row; the
  // tablist is display: contents there, so CSS `order` puts Add and the separator between the instruments and
  // Drone / Effects / Master as before (styles-v6-edit.css)
  const tablist = h('div.v6e-rtl', { role: 'tablist', 'aria-label': 'Your rig', 'data-testid': 'v6e-rtablist' });
  const tabs = h('div.v6e-rtabs', { 'data-testid': 'v6e-rtabs' }, tablist);
  // UI6-U5a O5: when the tabs scroll sideways, a ‹ / › at each hidden end says more tabs are there (and scrolls)
  const moreBtn = (side) => {
    const b = h(`button.v6e-rmore.${side}`, {
      type: 'button', tabindex: '-1', 'aria-hidden': 'true', hidden: true, 'data-testid': `v6e-rmore-${side}`,
      title: side === 'l' ? 'More tabs to the left' : 'More tabs to the right',
    }, side === 'l' ? '‹' : '›');
    b.addEventListener('click', () => tabs.scrollBy?.({ left: (side === 'l' ? -0.7 : 0.7) * tabs.clientWidth,
      behavior: 'smooth' }));
    return b;
  };
  const moreL = moreBtn('l');
  const moreR = moreBtn('r');
  const rig = h('section.v6e-rig', { 'data-testid': 'v6e-rig' },
    h('div.v6e-rig-h', {}, h('span.v6e-cap', { text: 'Your rig' }),
      h('small', { text: 'Pick one to shape it. A dot means it changed since the song began.' })),
    h('div.v6e-rtwrap', {}, tabs, moreL, moreR));
  const panelHost = h('div.v6e-panel', { role: 'tabpanel', 'data-testid': 'v6e-panel' });
  const main = h('div.v6e-main', {}, headHost, rig, panelHost);
  const body = h('div.v6e-body', {}, lib, rail, main);
  const bottomHost = h('footer.ev2-bottom.v6e-bottom', { 'aria-label': 'Keyboard and output' });
  root.append(body, bottomHost);
  el.classList.add('ev2-host');
  el.replaceChildren(root);
  el.__rigCtx = ctx;

  // ---- library fold (per device). iPad portrait (mockup "Instrument · iPad portrait") has no library column: the
  // header's ☰ Songs (today's song-header button, editState.drawer) opens it over the view instead.
  const portraitMq = typeof matchMedia === 'function' ? matchMedia(PORTRAIT_MQ) : null;
  const portrait = () => !!portraitMq?.matches;
  function applyFold() {
    const folded = prefs.lib === 'folded' && !portrait();
    root.classList.toggle('portrait', portrait());
    root.classList.toggle('lib-folded', folded);
    lib.hidden = folded;
    rail.hidden = !folded;
  }
  const setFold = (folded) => {
    if (folded) prefs.lib = 'folded';
    else delete prefs.lib;
    writePrefs(prefs);
    applyFold();
    (folded ? unfoldBtn : foldBtn).focus({ preventScroll: true });
  };
  foldBtn.addEventListener('click', () => (portrait() ? editState.setDrawer(false) : setFold(true)));
  core.listen(portraitMq, 'change', () => {
    editState.setDrawer(false);
    applyFold();
  });
  unfoldBtn.addEventListener('click', () => setFold(false));
  applyFold();

  // ---- regions: today's setlist (+ Song bank…), song header (+ time signature, Chart), keyboard row
  const regions = [
    core.mountModule('setlist', libMod, {}),
    core.mountModule('song-header', headHost, { v6: true }), // UI6-snap O1: its snapshot line says “snapshot”
  ];
  // U5b: the v6 Perform's bottom row (views/v6/bottom.js), mounted only while Edit shows, with its own test ids
  const bottom = editBottom(bottomHost, {
    store, controller, engine, editState, names, liveOf, changes: v6Changes, held: () => core.held,
    setView: (view) => ctx.setView?.(view), toast,
  });
  regions.push({ id: 'bottom', pctx: null, destroy: () => bottom.destroy() });
  const own = core.panelCtx({ host: root });
  const ownBinder = createBinder(own.pctx);
  const bankBtn = h('button.ev2-btn.sm.v6e-bank', {
    type: 'button', text: 'Song bank…', 'data-testid': 'v6e-bank',
    // UI6-U7a O4: Song bank… opens the browser over the Perform stage (main.js openBank), not Settings' list
    title: 'Opens the Song bank browser over Perform: songs from your patch packs to try or keep',
  });
  bankBtn.addEventListener('click', () => ctx.openSettings?.({ section: 'bank' }));
  (libMod.querySelector('.ev2-list-add') || libMod).append(bankBtn);
  // UI6-U5a O6: only with Song bank songs in the patch packs (controller.patchPacks, as the sidebar's + Add song)
  const renderBank = () => {
    const p = typeof controller?.patchPacks === 'function' ? controller.patchPacks() : null;
    bankBtn.hidden = !(p && p.enabled && Number(p.bankSongs) > 0);
  };
  renderBank();
  core.listen(controller, 'user-patches', renderBank);
  const sigSel = h('select.v6e-sig', { 'aria-label': 'Time signature', 'data-testid': 'v6e-timesig' },
    ...TIME_SIGS.map((sg) => h('option', { value: sg, text: sg })));
  sigSel.addEventListener('change', () => own.pctx.set('song.timeSig',
    sigSel.value === DEFAULT_TIME_SIG ? null : sigSel.value));
  ownBinder.ctl('song.timeSig', () => ({ el: sigSel, set: (v) => (sigSel.value = v || DEFAULT_TIME_SIG) }), {
    read: (sg) => sg.timeSig || DEFAULT_TIME_SIG,
  });
  const sigBox = h('label.v6e-sigbox', {}, h('span.v6e-cap', { text: 'Time' }), sigSel);
  const chartBtn = h('button.ev2-btn.sm.v6e-chart', {
    type: 'button', text: 'Chart', hidden: true, 'data-testid': 'v6e-chart',
    title: 'Show this song’s chart on Perform',
  });
  chartBtn.addEventListener('click', () => {
    if (!ctx.setView?.('perform')) return;
    // the chart lives on Perform (views/chart, D7); open it there. U7b: on the v6 Perform it is the sidebar's Chart
    // (its rail button opens the sidebar on it, or puts it up on the stage when that is where this device shows it)
    queueMicrotask(() => {
      const t = document.querySelector('#view-perform [data-testid="chart-toggle"]');
      if (t && t.getAttribute('aria-pressed') !== 'true') t.click();
      else if (!t) document.querySelector('#view-perform [data-testid="v6-rb-chart"]')?.click();
    });
  });
  const headRow = headHost.querySelector('.ev2-song-head') || headHost;
  const menuBtn = headRow.querySelector('.ev2-song-menubtn');
  for (const n of [sigBox, chartBtn]) {
    if (menuBtn && menuBtn.parentNode === headRow) headRow.insertBefore(n, menuBtn);
    else headRow.append(n);
  }
  const renderChartBtn = () => {
    chartBtn.hidden = store.get().settings.chartView !== true;
  };
  // polish batch 2 (orchestrator screenshot, 1280 × 800: "Sunday Pad + Pia" with no ellipsis): the song name field
  // shrinks with the header (flex), but today's header module re-checks its ellipsis (`long`, song-header.js fitName)
  // only on a rename or typing, so a name the layout cut stayed clipped mid-glyph. Here it is re-checked whenever the
  // field's size or the name changes (same rule: wider than the field by more than the caret's 1–2 px), and a cut
  // name's full text goes in its title.
  const nameEl = headRow.querySelector('.ev2-song-name');
  if (nameEl) {
    const baseTitle = nameEl.title;
    let nameRaf = 0;
    const fitName = () => {
      nameRaf = 0;
      if (!nameEl.isConnected) return;
      const long = nameEl.scrollWidth > nameEl.clientWidth + 2;
      nameEl.classList.toggle('long', long);
      nameEl.title = long ? `“${nameEl.value}” · click to rename` : baseTitle;
    };
    const fitSoon = () => {
      if (!nameRaf) nameRaf = requestAnimationFrame(fitName);
    };
    ownBinder.fn(['name'], fitSoon);
    core.listen(nameEl, 'input', fitSoon);
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(fitSoon);
      ro.observe(nameEl);
      core.cleanups.push(() => ro.disconnect());
    }
    core.cleanups.push(() => cancelAnimationFrame(nameRaf));
  }

  // ---------------------------------------------------------------- rig tabs
  /** @type {Map<string, {el:HTMLElement, name:HTMLElement, sub:HTMLElement, cd:HTMLElement}>} */
  const tabRecs = new Map();
  const tabId = (id) => `v6e-tab-${id.replace(':', '-')}`;
  function makeTab(id, color, shared) {
    const name = h('b.v6e-rt-name');
    const sub = h('small.v6e-rt-sub');
    const cd = h('span.v6e-rt-cd', { title: 'Changed since the song began', hidden: true });
    const t = h('button.v6e-rt', {
      type: 'button', role: 'tab', id: tabId(id), 'aria-selected': 'false', 'aria-controls': 'v6e-panel',
      tabindex: '-1', class: shared ? 'gl' : '', dataset: { block: id },
      'data-testid': `v6e-tab-${id.replace(':', '-')}`,
      style: color ? { '--c': color } : undefined,
    }, name, sub, cd);
    t.addEventListener('click', () => editState.select(id));
    const r = { el: t, name, sub, cd };
    tabRecs.set(id, r);
    return r;
  }
  const addBtn = h('button.v6e-rt.add', {
    type: 'button', 'data-testid': 'v6e-add', title: 'Add an instrument to this song',
  }, '+ Add');
  addBtn.addEventListener('click', () => {
    const id = core.songId;
    if (!id) return;
    const k = store.addSlot(id);
    if (k < 0) return;
    // after the store's change event (a microtask), so the new tab exists when it is selected
    queueMicrotask(() => editState.select(`slot:${k}`, { focus: 'instrument' }));
  });
  const sep = h('span.v6e-rsep', { 'aria-hidden': 'true' });
  const shared = ['drone', 'effects', 'master'].map((id) => makeTab(id, null, true));
  panelHost.id = 'v6e-panel';
  let slotCount = -1;
  function syncTabs() {
    const n = core.song ? Math.min(MAX_SLOTS, Math.max(1, core.song.patch.slots.length)) : 0;
    if (n === slotCount) return;
    slotCount = n;
    const els = [];
    for (let i = 0; i < n; i++) els.push((tabRecs.get(`slot:${i}`) || makeTab(`slot:${i}`, slotColor(i))).el);
    for (const [id] of tabRecs) {
      const m = /^slot:(\d+)$/.exec(id);
      if (m && Number(m[1]) >= n) tabRecs.delete(id);
    }
    tablist.replaceChildren(...els, ...shared.map((r) => r.el));
    if (addBtn.parentNode !== tabs) tabs.append(addBtn, sep);
    tabs.dataset.slots = String(n);
    const m = /^slot:(\d+)$/.exec(editState.selected);
    if (m && n && Number(m[1]) >= n) editState.select(`slot:${n - 1}`);
  }
  function renderTabs() {
    syncTabs();
    const song = core.song;
    const ch = v6Changes();
    const dots = tabDots();
    const live = liveOf(song);
    for (const [id, r] of tabRecs) {
      let nm = '—';
      let sub = '';
      let off = false;
      let empty = false;
      let changed = false;
      const m = /^slot:(\d+)$/.exec(id);
      if (m && song) {
        const i = Number(m[1]);
        const slot = live.patch.slots[i];
        if (!slot) {
          nm = 'Empty';
          sub = 'choose a sound';
          empty = true;
        } else {
          nm = names.name(slot.instrument);
          const { muted, level } = slotMuteState(slot);
          off = muted;
          sub = muted ? 'off' : formatValue(`slots.${i}.gain`, level);
        }
        changed = hasChange(ch, `patch.slots.${i}`) || dots.has(id);
      } else if (song) {
        const b = blockOf(id);
        const t = id === 'drone' ? dronePanel.tab(song) : editDefaultTab(b, song, core);
        nm = id === 'drone' ? 'Drone' : id === 'effects' ? 'Effects' : 'Master';
        sub = `${t.name}${t.sub ? ` ${t.sub}` : ''}`.replace(/\s·\s/, ' · ');
        off = !!t.off;
        changed = dots.has(id) || editState.isChanged(b.prefixes);
      }
      setText(r.name, nm);
      setText(r.sub, sub);
      r.el.title = `${nm}${sub ? ` · ${sub}` : ''}`;
      r.el.classList.toggle('off', off);
      r.el.classList.toggle('empty', empty);
      r.cd.hidden = !changed;
      const sel = editState.selected === id;
      r.el.classList.toggle('on', sel);
      r.el.setAttribute('aria-selected', String(sel));
    }
    const curTab = tabRecs.get(editState.selected) || tabRecs.get('slot:0');
    for (const r of tabRecs.values()) r.el.tabIndex = r === curTab ? 0 : -1;
    addBtn.disabled = !song || song.patch.slots.length >= MAX_SLOTS;
    renderChartBtn();
    renderMore();
  }
  /**
   * O5: ‹ / › while tabs are out of sight on that side. Read in the next frame, once per frame (a store event's
   * redraw must not pay a forced layout: UI6-U5a P1), and never while Perform shows.
   */
  let moreRaf = 0;
  function renderMore() {
    if (moreRaf || store.get().settings.view !== 'edit') return;
    moreRaf = requestAnimationFrame(() => {
      moreRaf = 0;
      const max = tabs.scrollWidth - tabs.clientWidth;
      moreL.hidden = !(max > 2 && tabs.scrollLeft > 2);
      moreR.hidden = !(max > 2 && tabs.scrollLeft < max - 2);
    });
  }
  core.cleanups.push(() => cancelAnimationFrame(moreRaf));
  core.listen(tabs, 'scroll', () => renderMore(), { passive: true });
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => renderMore());
    ro.observe(tabs);
    core.cleanups.push(() => ro.disconnect());
  }
  tabs.addEventListener('keydown', (e) => {
    const ids = [...tabs.querySelectorAll('.v6e-rt[data-block]')].map((x) => x.dataset.block);
    const k = ids.indexOf(e.target?.dataset?.block);
    if (k < 0) return;
    let n = -1;
    if (e.key === 'ArrowRight') n = (k + 1) % ids.length;
    else if (e.key === 'ArrowLeft') n = (k - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = ids.length - 1;
    if (n < 0) return;
    e.preventDefault();
    e.stopPropagation(); // ←/→ are Prev / Next song elsewhere
    editState.select(ids[n]);
    tabRecs.get(ids[n])?.el.focus();
  });

  // ---------------------------------------------------------------- the panel
  let cur = null; // {kind:'inst'|'panel', id, inst, update(o), destroy()}
  const instPrefs = {
    get cat() {
      return prefs.cat;
    },
    setCat(id) {
      prefs.cat = id;
      writePrefs(prefs);
    },
  };
  function mountInst(opts) {
    const host = h('div.v6e-host');
    panelHost.replaceChildren(host);
    const { pctx, dispose } = core.panelCtx({ host });
    let inst = null;
    try {
      inst = mountInstrument(host, pctx, opts, {
        prefs: instPrefs, changes: v6Changes, stripV, live: liveOf,
        // skeptic UI6-U5b F1: over the body, not the root, so the bottom row's PANIC / Lock / keys stay live
        dialogHost: body,
      });
    } catch (err) {
      console.warn('[v6 edit] instrument panel failed to mount', err);
      host.replaceChildren(h('p.v6e-hint', { text: 'The instrument panel failed to load.' }));
    }
    return {
      kind: 'inst', id: 'slot', inst, pctx,
      update(o) {
        inst?.update(o);
        return !!inst;
      },
      destroy() {
        try {
          inst?.destroy();
        } catch (err) {
          console.warn('[v6 edit] instrument panel destroy failed', err);
        }
        dispose();
        host.remove();
      },
    };
  }
  // U5b: Drone / Effects / Master in the category-list frame (D18). The sidebar Drone module's ctx is one per Edit
  // mount (the ON tile remembers the source it turned off per song across tab switches, as on Perform's sidebar).
  const droneModCtx = {
    ...stripV,
    snap: () => (editState.baseline && core.songId ? { id: core.songId, song: editState.baseline } : null),
    size: 'wide',
  };
  const catPrefs = (kind) => ({
    get: () => prefs.cats?.[kind],
    set(id) {
      prefs.cats = { ...(prefs.cats || {}), [kind]: id };
      writePrefs(prefs);
    },
  });
  const SHARED = {
    drone: (host, pctx, opts) => mountDrone(host, pctx, opts, { prefs: catPrefs('drone'), moduleCtx: droneModCtx }),
    effects: (host, pctx, opts) => mountEffects(host, pctx, opts, { prefs: catPrefs('effects'), names }),
    master: (host, pctx, opts) => mountMaster(host, pctx, opts, { prefs: catPrefs('master'), names }),
  };
  function mountShared(id, opts) {
    const host = h('div.v6e-host', { dataset: { panel: id } });
    panelHost.replaceChildren(host);
    const { pctx, dispose } = core.panelCtx({ host });
    let inst = null;
    try {
      inst = SHARED[id](host, pctx, opts);
    } catch (err) {
      console.warn(`[v6 edit] ${id} panel failed to mount`, err);
      host.replaceChildren(h('p.v6e-hint', { text: `The ${id} panel failed to load.` }));
    }
    return {
      kind: 'shared', id, inst, pctx,
      update(o) {
        inst?.update(o);
        return !!inst;
      },
      destroy() {
        try {
          inst?.destroy();
        } catch (err) {
          console.warn(`[v6 edit] ${id} panel destroy failed`, err);
        }
        dispose();
        host.remove();
      },
    };
  }
  function mountPanel(block, opts) {
    // today's song panel in its own frame (sentence title + body), inside the v6 panel card
    const frame = editPanelFrame(core);
    const wrap = h('section.ev2-rig.v6e-legacy', { dataset: { block: block.id } }, frame.panel);
    wrap.style.setProperty('--c', block.color);
    frame.panel.removeAttribute('id'); // #ev2-panel belongs to today's Edit
    panelHost.replaceChildren(wrap);
    const m = core.mountModule(block.panel, frame.body, opts, frame.setTitle);
    return {
      kind: 'panel', id: block.panel, inst: m.inst, pctx: m.pctx,
      update: (o) => m.update(o),
      destroy() {
        m.destroy();
        frame.dispose();
        wrap.remove();
      },
    };
  }
  function showSelected() {
    const block = blockOf(editState.selected) || blockOf('slot:0');
    const opts = { ...block.opts, ...editState.opts };
    root.dataset.selected = block.id;
    const t = tabRecs.get(block.id);
    if (t) {
      panelHost.setAttribute('aria-labelledby', t.el.id);
      panelHost.removeAttribute('aria-label');
    } else {
      panelHost.removeAttribute('aria-labelledby');
      panelHost.setAttribute('aria-label', block.role);
    }
    const want = block.panel === 'slot' ? 'slot' : block.panel;
    if (cur && cur.id === want && cur.update(opts)) return;
    cur?.destroy();
    cur = want === 'slot' ? mountInst(opts) : SHARED[want] ? mountShared(want, opts) : mountPanel(block, opts);
  }
  core.listen(editState, 'select', () => {
    showSelected();
    renderTabs();
    tabRecs.get(editState.selected)?.el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  });
  core.listen(editState, 'changes', renderTabs);
  // UI6-U5a review R3 (D23 / U-MOVE-store O1): the selected 'slot:<i>' tab follows its instrument through a move,
  // insert or remove of the shown song's slots (the v6 Perform's ⋯ / drag while Edit stays mounted), with today's
  // mountEdit's own function (shell.js), so the two cannot drift. The selected slot itself removed: syncTabs clamps.
  core.cleanups.push(editFollowSelectedSlot(core, store, editState));
  // instruments arrive once the engine starts (a My Samples rescan adds more): the names follow (the core then
  // runs the store hooks, so the tabs re-render)
  core.listen(editState, 'instruments', () => {
    names.refresh();
    tabMemo = { song: undefined, base: undefined, ids: new Set() }; // Sound's dot reads the instrument's sliders
  });
  core.onStoreHooks.push(() => renderTabs());
  // the library as a drawer (iPad portrait; today's ☰ Songs): Esc and an outside tap close it, as in today's Edit
  core.listen(editState, 'drawer', (e) => root.classList.toggle('drawer-open', !!e.detail.open));
  core.escapes.push(() => {
    if (!editState.drawer) return false;
    editState.setDrawer(false);
    return true;
  });
  core.listen(root, 'pointerdown', (e) => {
    if (!editState.drawer || lib.contains(e.target) || e.target.closest?.('[data-drawer-toggle]')) return;
    editState.setDrawer(false);
  });

  renderTabs();
  showSelected();

  return {
    el: root,
    editState,
    destroy() {
      cur?.destroy();
      cur = null;
      ownBinder.destroy();
      own.dispose();
      for (const r of regions.splice(0)) r.destroy();
      core.dispose();
      try {
        controller?.perform?.releaseAll?.();
      } catch {
        /* ignore */
      }
      el.replaceChildren();
      el.classList.remove('ev2-host');
      delete el.__rigCtx;
      document.querySelector('link[data-v6-edit-css]')?.remove();
    },
    /** Test hooks. */
    _debug: {
      v6: true,
      mounted: () => [...regions.map((r) => r.id), cur?.id].filter(Boolean),
      instance: () => cur?.inst || null,
      /** U-EDITRANGE: the bottom row's range keyboard (keyboard.js; null while Edit is not shown). */
      bottomKb: () => bottom.row?.kb || null,
      ctx: (id) => (regions.find((r) => r.id === id) || (cur && cur.id === id ? cur : null))?.pctx || null,
      baseline: () => editState.baseline,
      changes: () => [...v6Changes()],
      prefs: () => ({ ...prefs }),
      setFold,
    },
  };
}
