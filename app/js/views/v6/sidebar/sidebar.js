// UI v6 right sidebar (D15; D16 "Right sidebar" + "The right sidebar is resizable"; UI6-build-plan U3; mockup
// native/docs/design/mockups/perform-v6.html tabs "Sidebar …", "Everything folded", "iPad portrait"; mock_v6.py
// sidebar() / RESIZE_JS). One module at a time as tabs; ⟩ folds it to an icon rail, ⟨ or a rail icon opens it again.
// Its left edge is a grip (role="separator", ←/→ too): SIDEBAR_MIN px … 62 % of the board; narrower than the minimum
// folds it. ⋯ chooses and orders the modules and how it starts. Everything about it is per device
// (localStorage SIDEBAR_KEY), never in the library. iPad portrait (PORTRAIT_MQ): a wide panel under the strips, no
// grip.
// Modules (D15) are self-contained: {id, label, blurb, icon, badge?(state), mount(el, ctx) → {destroy()}}; adding one
// (Tone) is a row in modules.js, nothing here or in the other modules changes. Only the shown module is mounted;
// folding the sidebar or switching tabs destroys it (its listeners go with it).
// U7b: a module that is loaded with its own flag (Chart, settings.chartView) is added after the sidebar mounts
// (addModule) and taken away with the flag (removeModule); its place in a saved layout is kept meanwhile
// (LATE_MODULE_IDS). Such a module may also show itself elsewhere (the chart on the stage): take() / away().
import { h, setText, disposer, nextId } from '../../components/util.js';
import { say, onVoiceChange } from '../../components/voice.js';
import { button, popover } from '../lib.js';
import { SIDEBAR_MODULES } from './modules.js';

/** localStorage key of the per-device sidebar layout (never exported with the library). */
export const SIDEBAR_KEY = 'worship-rig.v6.sidebar';
/**
 * Modules added after the sidebar mounts (U7b: 'chart', loaded only while settings.chartView is on). A saved layout
 * keeps their place, hidden state and tab while they are absent; they are never added to a layout that never had them
 * until they are registered.
 */
export const LATE_MODULE_IDS = Object.freeze(['chart']);
/** Narrowest open sidebar (D16); a drag below it folds the sidebar to the rail. */
export const SIDEBAR_MIN = 200;
/** Widest sidebar, as a share of the board (D16: "62 % of the stage"). */
export const SIDEBAR_MAX_FRAC = 0.62;
/** Width before the player has dragged it: the mockup's 280 px; 220 px up to 1240 px wide windows (U1's column). */
export const sidebarDefaultWidth = () => (typeof window !== 'undefined' && window.innerWidth <= 1240 ? 220 : 280);
/**
 * Small-window fit (UI6-U3 review O1, orchestrator tier 2): in a window this wide or narrower the sidebar starts
 * folded, unless the player has opened it in a window this small before (per device: `smallOpen` in the prefs).
 */
export const SMALL_WINDOW = 1100;
const isSmallWindow = () => typeof window !== 'undefined' && window.innerWidth <= SMALL_WINDOW;
/** iPad portrait: the sidebar becomes a wide panel under the strips. styles-v6-sidebar.css uses the same query. */
export const PORTRAIT_MQ = '(orientation: portrait) and (max-width: 1024px)';
/** ←/→ on the grip: px per press (Shift: BIG_STEP). */
const STEP = 16;
const BIG_STEP = 64;

/**
 * The layout a device starts with: open on the first module, every module shown in the registry's order.
 * @param {string[]} ids  module ids in registry order
 * @returns {{open:boolean, starts:'open'|'collapsed', width:number|null, tab:string, order:string[], hidden:string[]}}
 */
export function defaultPrefs(ids) {
  return { open: true, starts: 'open', width: null, tab: ids[0], order: [...ids], hidden: [] };
}

/**
 * Stored prefs → valid prefs for these modules: unknown ids dropped, new modules appended (shown), at least one module
 * shown, the tab a shown module, a width ≥ SIDEBAR_MIN or null (default); `smallOpen: true` (opened in a small
 * window before) kept, absent otherwise. U7b: ids in `late` (registered later, LATE_MODULE_IDS) keep their place in
 * the order, their hidden state and the tab when the stored layout has them, but are not added, and never count as the
 * shown module the sidebar keeps.
 * @param {unknown} raw  parsed localStorage value (anything)
 * @param {string[]} ids  the registered modules
 * @param {ReadonlyArray<string>} [late]  modules that may be registered later
 * @returns {ReturnType<typeof defaultPrefs>}
 */
export function normalizePrefs(raw, ids, late = []) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const known = new Set([...ids, ...late]);
  const uniq = (a) => (Array.isArray(a) ? a.filter((x, i) => known.has(x) && a.indexOf(x) === i) : []);
  const order = uniq(o.order);
  for (const id of ids) if (!order.includes(id)) order.push(id); // a module added in a later version goes last
  let hidden = uniq(o.hidden);
  if (ids.every((x) => hidden.includes(x))) hidden = hidden.filter((x) => !ids.includes(x)); // never an empty sidebar
  const shown = order.filter((x) => !hidden.includes(x));
  const reg = shown.filter((x) => ids.includes(x));
  const out = {
    open: typeof o.open === 'boolean' ? o.open : true,
    starts: o.starts === 'collapsed' ? 'collapsed' : 'open',
    width: Number.isFinite(o.width) && o.width >= SIDEBAR_MIN ? Math.round(o.width) : null,
    tab: shown.includes(o.tab) ? o.tab : reg[0],
    order,
    hidden,
  };
  if (o.smallOpen === true) out.smallOpen = true;
  // U7b: a module's own width (a module with `width`, e.g. Chart), kept only once the player has dragged it
  if (o.widths && typeof o.widths === 'object' && !Array.isArray(o.widths)) {
    const w = Object.fromEntries(Object.entries(o.widths)
      .filter(([k, x]) => known.has(k) && Number.isFinite(x) && x >= SIDEBAR_MIN).map(([k, x]) => [k, Math.round(x)]));
    if (Object.keys(w).length) out.widths = w;
  }
  return out;
}

/**
 * A sidebar width that fits: SIDEBAR_MIN … SIDEBAR_MAX_FRAC of the board (never below the minimum, however narrow).
 * @param {number} w      wanted width, px
 * @param {number} stage  the board's width, px
 * @returns {number}
 */
export function clampWidth(w, stage) {
  const max = Math.max(SIDEBAR_MIN, Math.floor(stage * SIDEBAR_MAX_FRAC));
  return Math.round(Math.min(max, Math.max(SIDEBAR_MIN, Number(w) || SIDEBAR_MIN)));
}

function loadPrefs(ids) {
  try {
    return normalizePrefs(JSON.parse(localStorage.getItem(SIDEBAR_KEY) || 'null'), ids, LATE_MODULE_IDS);
  } catch {
    return defaultPrefs(ids);
  }
}
function savePrefs(prefs) {
  try {
    localStorage.setItem(SIDEBAR_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode / quota: the layout still works for this session */
  }
}

/**
 * `prefs` with module `id` shown or hidden; null when refused (the last shown module stays). Hiding the open tab moves
 * it to the first shown module.
 * @param {ReturnType<typeof defaultPrefs>} prefs
 * @param {string} id
 * @param {boolean} on
 * @param {string[]} [ids]  the registered modules (U7b: a late module absent now never counts as the one shown);
 *   default: every id in the order
 * @returns {ReturnType<typeof defaultPrefs>|null}
 */
export function prefsWithShown(prefs, id, on, ids = prefs.order) {
  const hidden = prefs.hidden.filter((x) => x !== id);
  if (!on) hidden.push(id);
  const reg = prefs.order.filter((x) => ids.includes(x) && !hidden.includes(x));
  if (!reg.length) return null;
  const next = { ...prefs, hidden };
  if (!on && next.tab === id) next.tab = reg[0];
  return next;
}

// U6 (Settings › Perform layout): the mounted sidebar, so a change made in Settings reaches it at once (it keeps its
// prefs in memory); with no v6 Perform mounted, Settings reads and writes SIDEBAR_KEY directly
let live = null;

/**
 * The sidebar's layout for Settings › Perform layout (U6): the same prefs and rules the ⋯ popover uses.
 * @param {object[]} [mods]  the module registry (default SIDEBAR_MODULES)
 * @returns {{mods:object[], prefs():object, commit(next:object):void, readonly live:boolean}}
 */
export function sidebarLayout(mods = SIDEBAR_MODULES) {
  const ids = mods.map((m) => m.id);
  return {
    /** The live sidebar's modules (U7b: incl. a late one such as Chart), else `mods`. */
    get mods() {
      return live ? live.mods() : mods;
    },
    prefs: () => (live ? live.prefs() : loadPrefs(ids)),
    commit: (next) => (live ? live.commit(next) : savePrefs(normalizePrefs(next, ids, LATE_MODULE_IDS))),
    get live() {
      return !!live;
    },
  };
}

/**
 * The customize list: per module a show / hide switch, ↑ ↓ and a ⠿ drag to reorder, then Starts: Open / Collapsed.
 * One builder for the sidebar's ⋯ popover and Settings › Perform layout (U6), so both follow the same rules.
 * @param {HTMLElement} pb  container (filled here)
 * @param {ReturnType<import('../../components/util.js').disposer>} pd  owns the listeners
 * @param {{mods:object[], prefs:() => object, commit:(next:object) => void, heading?:boolean}} api
 *   `prefs()` the current prefs, `commit(next)` stores and applies new ones; `heading: false` leaves out the popover's
 *   title line
 * @returns {() => void} render: re-reads api.prefs()
 */
export function customizeList(pb, pd, api) {
  const byId = new Map(api.mods.map((m) => [m.id, m]));
  const ids = api.mods.map((m) => m.id);
  const P = () => api.prefs();
  // U7b: the order may hold a late module that is absent now (LATE_MODULE_IDS); the list shows the modules there are,
  // and a reorder keeps the absent one where it was
  const listed = (order) => order.filter((x) => byId.has(x));
  const merged = (visible) => {
    const order = P().order.slice();
    let k = 0;
    return order.map((x) => (byId.has(x) ? visible[k++] : x));
  };
  const list = h('div.v6-cz-list', { role: 'list', 'aria-label': 'Modules, in order' });
  const startOpen = button(pd, '.v6-cz-start', 'Open', { 'data-value': 'open', 'data-testid': 'v6-sb-starts-open' });
  const startCol = button(pd, '.v6-cz-start', 'Collapsed', {
    'data-value': 'collapsed', 'data-testid': 'v6-sb-starts-collapsed',
  });
  if (api.heading !== false) {
    pb.append(h('div.v6-pop-h', {}, 'Sidebar ', h('span', { text: 'drag ⠿ or use ↑ ↓ to reorder' })));
  }
  pb.append(
    list,
    h('div.v6-cz-starts', { role: 'group', 'aria-label': 'When the app starts, the sidebar is' },
      h('span.v6-cap', { text: 'Starts' }), startOpen, startCol),
  );
  for (const b of [startOpen, startCol]) {
    pd.listen(b, 'click', () => {
      api.commit({ ...P(), starts: b.dataset.value });
      renderCz();
    });
  }
  const commit = (order) => {
    api.commit({ ...P(), order });
    renderCz();
  };
  const move = (id, by) => {
    const order = listed(P().order);
    const i = order.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= order.length) return;
    order.splice(i, 1);
    order.splice(j, 0, id);
    commit(merged(order));
    list.querySelector(`[data-id="${id}"] .v6-cz-${by < 0 ? 'up' : 'dn'}:not(:disabled)`)?.focus();
  };
  const setShown = (id, on) => {
    const next = prefsWithShown(P(), id, on, ids);
    if (!next) return; // the last shown module stays
    api.commit(next);
    renderCz();
  };
  const rows = new Map();
  let dragStop = null;
  pd.add(() => dragStop?.()); // closing the popover mid-drag drops the drag
  for (const id of ids) {
    const m = byId.get(id);
    const gripEl = h('span.v6-cz-grip', { text: '⠿', 'aria-hidden': 'true', title: 'Drag to reorder' });
    const up = button(pd, '.v6-cz-mv.v6-cz-up', '↑', {
      'aria-label': `Move ${m.label} up`, 'data-testid': `v6-cz-up-${id}`,
    });
    const dn = button(pd, '.v6-cz-mv.v6-cz-dn', '↓', {
      'aria-label': `Move ${m.label} down`, 'data-testid': `v6-cz-dn-${id}`,
    });
    const sw = button(pd, '.v6-sw', h('span.v6-sw-k'), {
      role: 'switch', 'aria-checked': 'true', 'aria-label': `Show ${m.label}`, 'data-testid': `v6-cz-show-${id}`,
    });
    const row = h('div.v6-cz', { role: 'listitem', 'data-id': id, 'data-testid': `v6-cz-${id}` },
      gripEl, h('span.v6-cz-t', {}, h('b', { text: m.label }), h('small', { text: m.blurb || '' })), up, dn, sw);
    pd.listen(up, 'click', () => move(id, -1));
    pd.listen(dn, 'click', () => move(id, 1));
    pd.listen(sw, 'click', () => setShown(id, sw.getAttribute('aria-checked') !== 'true'));
    // drag the ⠿ to reorder: the row follows the pointer between its neighbours, the order is saved on release.
    // The moves are followed on the document, not by pointer capture: moving the row in the DOM releases a capture.
    pd.listen(gripEl, 'pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      const pid = e.pointerId;
      row.classList.add('dragging');
      const onMove = (ev) => {
        if (ev.pointerId !== pid) return;
        const others = [...list.children].filter((r) => r !== row);
        const after = others.find((r) => {
          const b = r.getBoundingClientRect();
          return ev.clientY < b.top + b.height / 2;
        });
        if (after) {
          if (row.nextElementSibling !== after) list.insertBefore(row, after);
        } else if (list.lastElementChild !== row) list.append(row);
      };
      const stop = () => {
        document.removeEventListener('pointermove', onMove, true);
        document.removeEventListener('pointerup', onUp, true);
        document.removeEventListener('pointercancel', onUp, true);
        dragStop = null;
      };
      const onUp = (ev) => {
        if (ev.pointerId !== pid) return;
        stop();
        row.classList.remove('dragging');
        const order = [...list.children].map((r) => r.dataset.id);
        if (order.join() !== listed(P().order).join()) commit(merged(order));
      };
      dragStop?.();
      dragStop = stop;
      document.addEventListener('pointermove', onMove, true);
      document.addEventListener('pointerup', onUp, true);
      document.addEventListener('pointercancel', onUp, true);
    });
    rows.set(id, { row, up, dn, sw });
  }
  function renderCz() {
    const prefs = P();
    const order = listed(prefs.order);
    const n = order.length;
    const vis = order.filter((x) => !prefs.hidden.includes(x));
    list.replaceChildren(...order.map((id) => rows.get(id).row));
    order.forEach((id, i) => {
      const r = rows.get(id);
      r.up.disabled = i === 0;
      r.dn.disabled = i === n - 1;
      const on = vis.includes(id);
      r.sw.setAttribute('aria-checked', String(on));
      r.sw.classList.toggle('on', on);
      r.sw.disabled = on && vis.length === 1; // the last shown module stays
      r.sw.title = r.sw.disabled ? 'The sidebar keeps at least one module'
        : on ? 'Shown: tap to hide' : 'Hidden: tap to show';
      r.row.classList.toggle('off', !on);
    });
    for (const b of [startOpen, startCol]) {
      const on = b.dataset.value === prefs.starts;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }
  renderCz();
  return renderCz;
}

/**
 * Inline stroke icon from a module's own markup (static strings in the module files, never user data).
 * @param {string} markup
 * @param {number} [size]
 * @returns {SVGElement}
 */
export function moduleIcon(markup, size = 20) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const attrs = {
    class: 'ic', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.9', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
  };
  for (const [k, val] of Object.entries(attrs)) s.setAttribute(k, String(val));
  s.innerHTML = markup || '';
  return s;
}

// "Starts: Open / Collapsed" applies when the app starts (a page load); a later remount in the same page (the v6
// switch off and on) keeps the state the player left it in.
let startedThisPage = false;

/**
 * Mount the right sidebar. Append `el` to the board; call render(state) from the view's render.
 * @param {object} v  the v6 shell's view context (store, controller, engine, ctx, toast, isLocked, snap, sceneLevel,
 *   liveOf, host)
 * @param {{modules?:object[], onChange?:(s:{open:boolean, tab:string, portrait:boolean}) => void}} [o]
 * @returns {{el:HTMLElement, render(state:object):void, open(id?:string):void, collapse(tab?:string):void,
 *            addModule(m:object):void, removeModule(id:string):void, refreshBadges():void,
 *            readonly prefs:object, readonly mounted:string|null, readonly portrait:boolean, destroy():void}}
 */
export function rightSidebar(v, o = {}) {
  const mods = (o.modules || SIDEBAR_MODULES).slice(); // U7b: addModule / removeModule change it
  const byId = new Map(mods.map((m) => [m.id, m]));
  const ids = () => mods.map((m) => m.id);
  const d = disposer();
  let prefs = loadPrefs(ids());
  const mq = typeof window.matchMedia === 'function' ? window.matchMedia(PORTRAIT_MQ) : null;
  let portrait = !!mq?.matches;
  if (!startedThisPage) {
    startedThisPage = true;
    // small-window fit: ≤ SMALL_WINDOW px wide starts folded (4 instruments then fit 1024 × 700 without the pills)
    // until the player opens it at that size once; iPad portrait puts the panel under the strips, so not there
    prefs.open = prefs.starts === 'open' && (portrait || !isSmallWindow() || !!prefs.smallOpen);
  }
  let lastState = v.store.get();

  const save = () => savePrefs(prefs);
  // U7b: only registered modules show (a late one keeps its place in prefs.order while it is absent)
  const shown = () => prefs.order.filter((id) => byId.has(id) && !prefs.hidden.includes(id));
  /** A module showing itself elsewhere (U7b: the chart on the stage), so the sidebar does not land on it. */
  const isAway = (id) => {
    try {
      return !!byId.get(id)?.away?.();
    } catch {
      return false;
    }
  };
  /** The module the sidebar shows: the chosen tab while it is there and not away, else the first that is. */
  const tabNow = () => {
    const list = shown();
    if (list.includes(prefs.tab) && !isAway(prefs.tab)) return prefs.tab;
    return list.find((id) => !isAway(id)) || list[0];
  };
  /**
   * The player asked for module `id` (a tab, a rail icon, the song bar): a module that shows itself elsewhere does so
   * (U7b: the chart on the stage) and the sidebar is left as it is.
   */
  const taken = (id) => {
    try {
      return !!byId.get(id)?.take?.();
    } catch (err) {
      console.warn('[ui] sidebar module take failed', err);
      return false;
    }
  };
  /**
   * New prefs from the customize list (the ⋯ popover or Settings › Perform layout, U6): stored, then the tabs / rail
   * rebuilt and the layout applied when the order or the shown modules changed (Starts only applies at the next start).
   */
  function commitPrefs(next) {
    const heads = next.order.join() !== prefs.order.join() || next.hidden.join() !== prefs.hidden.join()
      || next.tab !== prefs.tab;
    prefs = { ...next };
    save();
    if (!heads) return;
    buildHeads();
    renderBadges(lastState);
    applyLayout();
  }
  const me = { prefs: () => prefs, commit: commitPrefs, mods: () => mods.slice() };
  live = me;

  // ---------------------------------------------------------------- DOM
  const el = h('aside.v6-right.v6-side', { 'data-testid': 'v6-right', 'aria-label': 'Sidebar' });
  const grip = h('div.v6-sb-grip', {
    role: 'separator', 'aria-orientation': 'vertical', tabindex: '0', 'data-testid': 'v6-sb-grip',
    'aria-label': 'Sidebar width', 'aria-valuemin': String(SIDEBAR_MIN),
    title: 'Drag to resize; drag it narrow to fold it (← / → too)',
  });
  const tabs = h('div.v6-sb-tabs', { role: 'tablist', 'aria-label': 'Sidebar modules' });
  const czBtn = button(d, '.v6-sb-c', '⋯', {
    'aria-label': 'Customize sidebar', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
    'data-testid': 'v6-sb-customize', title: 'Choose and order the sidebar’s modules',
  });
  const xBtn = button(d, '.v6-sb-x', '⟩', {
    'aria-label': 'Collapse sidebar', 'data-testid': 'v6-sb-collapse', title: 'Fold the sidebar to a rail',
  });
  const panelId = nextId('v6-sb-panel');
  const body = h('div.v6-sb-body', { role: 'tabpanel', id: panelId, 'data-testid': 'v6-sb-body' });
  const railOpen = button(d, '.v6-rb.v6-rb-open', '⟨', {
    'aria-label': 'Open sidebar', 'data-testid': 'v6-sb-open', title: 'Open the sidebar',
  });
  const railList = h('div.v6-rail-list', { role: 'group', 'aria-label': 'Sidebar modules' });
  // U-METRO (D23.3): the song's load state at the top of the sidebar, a spinner on the rail while folded
  const loadLine = h('div.v6-sb-load', { role: 'status', 'data-testid': 'v6-sb-load', hidden: true },
    h('span.v6-spin', { 'aria-hidden': 'true' }), h('span.v6-sb-load-t'));
  const railLoad = h('span.v6-rail-load', { 'data-testid': 'v6-rail-load', hidden: true, role: 'img' },
    h('span.v6-spin', { 'aria-hidden': 'true' }));
  const rail = h('div.v6-sb-rail', { 'data-testid': 'v6-sb-rail' }, railLoad, railOpen, railList);
  // the load line sits in the header: beside ⋯ ⟩ when the tabs have their own row (the default 280 px with four
  // modules), so it never pushes the module down; above the tabs when they share a row with ⋯ ⟩
  const head = h('div.v6-sb-h', {}, tabs, loadLine, czBtn, xBtn);
  el.append(grip, head, body, rail);

  // ---------------------------------------------------------------- tabs + rail (rebuilt when the shown list changes)
  let tabBtns = new Map();
  let railBtns = new Map();
  let builtFor = '';
  function buildHeads() {
    const list = shown();
    const sig = list.join(',');
    if (sig === builtFor) return;
    builtFor = sig;
    head.dataset.tabs = String(list.length); // styles-v6-sidebar.css gives 4+ tabs their own row when narrow
    tabBtns = new Map();
    railBtns = new Map();
    tabs.replaceChildren(...list.map((id) => {
      const m = byId.get(id);
      const b = h('button.btn.v6-sb-tab', {
        type: 'button', role: 'tab', 'data-id': id, 'data-testid': `v6-sb-tab-${id}`, 'aria-controls': panelId,
        'aria-selected': 'false', tabindex: '-1',
      }, h('span', { text: m.label }), h('i.v6-live', { hidden: true, 'aria-hidden': 'true' }));
      tabBtns.set(id, b);
      return b;
    }));
    railList.replaceChildren(...list.map((id) => {
      const m = byId.get(id);
      const b = h('button.btn.v6-rb', {
        type: 'button', 'data-id': id, 'data-testid': `v6-rb-${id}`, 'aria-label': `Open ${m.label}`,
        title: `Open the sidebar on ${m.label}`,
      }, moduleIcon(m.icon, 20), h('span.v6-rb-t', { text: m.label }), h('em.v6-rb-k', { hidden: true }));
      railBtns.set(id, b);
      return b;
    }));
  }
  d.listen(tabs, 'click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (b) selectTab(b.dataset.id);
  });
  // tablist arrows (WAI-ARIA tabs): ←/→ move and select; they never reach the controller (mod wheel / octave)
  d.listen(tabs, 'keydown', (e) => {
    const list = shown();
    const i = list.indexOf(e.target.closest('button[data-id]')?.dataset.id);
    const j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: list.length - 1 }[e.key];
    if (i < 0 || j === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    const id = list[(j + list.length) % list.length];
    selectTab(id);
    tabBtns.get(id)?.focus();
  });
  // skeptic UI6-U3 F1: ⟩, ⟨ and the rail icons hide themselves, so a keyboard press on them dropped the focus to the
  // page (the player had to Tab in from the top again). Pressed from the keyboard (a click with detail 0), the focus
  // goes on to ⟨ / the open tab, as → on the grip already does. A pointer click leaves it alone: Chrome then drops it
  // to the page, where Space stays the sustain pedal (a focused ⟨ would take Space and reopen the sidebar).
  const byKeys = (e) => e.detail === 0;
  const focusTab = () => tabBtns.get(tabNow())?.focus({ preventScroll: true });
  d.listen(railList, 'click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    open(b.dataset.id);
    if (byKeys(e)) focusTab();
  });
  d.listen(railOpen, 'click', (e) => {
    open();
    if (byKeys(e)) focusTab();
  });
  d.listen(xBtn, 'click', (e) => {
    collapse();
    if (byKeys(e)) railOpen.focus({ preventScroll: true });
  });

  // ---------------------------------------------------------------- the shown module
  let cur = null; // {id, inst}
  const mctx = {
    ...v,
    /** 'side' (the column) or 'wide' (iPad portrait panel); the modules' CSS also uses container queries. */
    get size() {
      return portrait ? 'wide' : 'side';
    },
  };
  function unmount() {
    if (!cur) return;
    try {
      cur.inst?.destroy?.();
    } finally {
      cur = null;
      body.replaceChildren();
      delete body.dataset.module;
    }
  }
  function mount(id) {
    if (cur?.id === id) return;
    unmount();
    const m = byId.get(id);
    if (!m) return;
    body.dataset.module = id;
    body.setAttribute('aria-label', m.label);
    cur = { id, inst: m.mount(body, mctx) || null };
  }

  // ---------------------------------------------------------------- layout: open / rail / width / portrait
  const stageWidth = () => el.parentElement?.clientWidth || window.innerWidth;
  // U7b (mockup chart.html "Chart in the sidebar": the sidebar widens while Chart is the open tab): a module with a
  // `width` (px) gets its own width while it shows, the player's drag on it is kept for it (prefs.widths[id])
  const ownWidth = () => {
    const m = prefs.open ? byId.get(tabNow()) : null;
    return m && Number.isFinite(m.width) ? m : null;
  };
  const wantWidth = () => {
    const m = ownWidth();
    if (m) return prefs.widths?.[m.id] ?? m.width;
    return prefs.width ?? sidebarDefaultWidth();
  };
  const setWidth = (px) => {
    const m = ownWidth();
    if (m) prefs.widths = { ...prefs.widths, [m.id]: px };
    else prefs.width = px;
  };
  function applyLayout() {
    el.classList.toggle('rail', !prefs.open);
    el.classList.toggle('wide', portrait);
    grip.hidden = portrait || !prefs.open;
    if (portrait || !prefs.open) {
      el.style.removeProperty('width');
    } else {
      const sw = stageWidth();
      const w = clampWidth(wantWidth(), sw);
      el.style.width = `${w}px`;
      grip.setAttribute('aria-valuenow', String(w));
      grip.setAttribute('aria-valuemax', String(clampWidth(Infinity, sw)));
      grip.setAttribute('aria-valuetext', `${w} px wide`);
    }
    const tab = tabNow();
    if (prefs.open) mount(tab);
    else unmount();
    for (const [id, b] of tabBtns) {
      const on = id === tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    for (const [id, b] of railBtns) b.classList.toggle('act', id === tab);
    o.onChange?.({ open: prefs.open, tab, portrait });
  }
  function selectTab(id) {
    if (!shown().includes(id) || taken(id)) return;
    prefs.tab = id;
    save();
    applyLayout();
  }
  /** Open the sidebar (on module `id`, shown again if the player had hidden it). */
  function open(id) {
    if (id && byId.has(id)) {
      if (taken(id)) return;
      if (prefs.hidden.includes(id)) {
        prefs.hidden = prefs.hidden.filter((x) => x !== id);
        buildHeads();
        renderBadges(lastState);
      }
      prefs.tab = id;
    }
    prefs.open = true;
    if (!portrait && isSmallWindow()) prefs.smallOpen = true; // the player wants it open in a small window too
    save();
    applyLayout();
  }
  /** Fold to the rail; `tab` (U7b) also makes that module the one ⟨ opens. */
  function collapse(tab) {
    czPop?.close();
    if (tab && byId.has(tab)) prefs.tab = tab;
    prefs.open = false;
    save();
    applyLayout();
  }

  // grip: drag (pointer capture) and keys; the width is saved on release, a drag under the minimum folds it and
  // keeps the width it had before, so ⟨ brings that back
  let drag = null;
  d.listen(grip, 'pointerdown', (e) => {
    if (portrait || !prefs.open || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault(); // no focus / text selection; Space stays the pedal
    try {
      grip.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events */
    }
    const w0 = el.getBoundingClientRect().width;
    drag = { id: e.pointerId, x0: e.clientX, w0, w: w0, fold: false };
    el.classList.add('resizing');
  });
  d.listen(grip, 'pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const raw = drag.w0 - (e.clientX - drag.x0);
    drag.fold = raw < SIDEBAR_MIN;
    el.classList.toggle('will-fold', drag.fold);
    drag.w = clampWidth(raw, stageWidth());
    el.style.width = `${drag.w}px`;
  });
  const endDrag = (commit) => {
    if (!drag) return;
    const g = drag;
    drag = null;
    el.classList.remove('resizing', 'will-fold');
    if (commit && g.fold) {
      setWidth(Math.max(SIDEBAR_MIN, Math.round(g.w0)));
      collapse();
      return;
    }
    if (commit && Math.abs(g.w - g.w0) >= 1) {
      setWidth(g.w);
      save();
    }
    applyLayout();
  };
  d.listen(grip, 'pointerup', () => endDrag(true));
  d.listen(grip, 'pointercancel', () => endDrag(false));
  d.listen(grip, 'lostpointercapture', () => endDrag(true));
  d.listen(grip, 'keydown', (e) => {
    if (portrait || !prefs.open || e.altKey || e.metaKey || e.ctrlKey) return;
    const sw = stageWidth();
    const w = clampWidth(wantWidth(), sw);
    const step = e.shiftKey ? BIG_STEP : STEP;
    let next = null;
    if (e.key === 'ArrowLeft') next = w + step;
    else if (e.key === 'ArrowRight') next = w - step;
    else if (e.key === 'Home') next = SIDEBAR_MIN;
    else if (e.key === 'End') next = clampWidth(Infinity, sw);
    else return;
    e.preventDefault(); // the controller ignores handled keys (no mod wheel / octave change)
    e.stopPropagation();
    if (e.key === 'ArrowRight' && w <= SIDEBAR_MIN) {
      collapse(); // narrower than the minimum folds, as a drag does
      railOpen.focus();
      return;
    }
    setWidth(clampWidth(next, sw));
    save();
    applyLayout();
  });

  const onResize = () => {
    if (!drag && prefs.open && !portrait) applyLayout();
  };
  d.listen(window, 'resize', onResize);
  if (mq) {
    const onMq = () => {
      portrait = mq.matches;
      endDrag(false);
      applyLayout();
    };
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onMq);
      d.add(() => mq.removeEventListener('change', onMq));
    }
  }

  // ---------------------------------------------------------------- ⋯ customize: show / hide, order, Starts
  let czPop = null;
  d.listen(czBtn, 'click', () => {
    if (czPop) return czPop.close();
    czPop = popover({
      host: v.host, anchor: czBtn, label: 'Customize sidebar', className: 'v6-czpop', testid: 'v6-sb-cz',
      align: 'end',
      build: (pb, pd) => buildCustomize(pb, pd),
      onClose: () => {
        czPop = null;
      },
    });
    czPop.render();
  });

  // U6: one builder for this popover and Settings › Perform layout (customizeList below)
  function buildCustomize(pb, pd) {
    return customizeList(pb, pd, { mods, prefs: () => prefs, commit: commitPrefs });
  }

  // ---------------------------------------------------------------- badges (the drone's live dot + key)
  function renderBadges(state) {
    for (const id of shown()) {
      const m = byId.get(id);
      let b = null;
      try {
        b = m.badge ? m.badge(state, v) : null;
      } catch {
        b = null;
      }
      const tab = tabBtns.get(id);
      const rb = railBtns.get(id);
      if (tab) tab.querySelector('.v6-live').hidden = !b?.live;
      if (rb) {
        rb.classList.toggle('live', !!b?.live);
        const k = rb.querySelector('.v6-rb-k');
        k.hidden = !b?.text;
        if (k.textContent !== (b?.text || '')) setText(k, b?.text || '');
        rb.setAttribute('aria-label', `Open ${m.label}${b?.title ? ` (${b.title})` : ''}`);
      }
    }
  }

  // ---------------------------------------------------------------- load state (U-METRO, D23.3)
  // Today's words: "Loading…" while the current song is being prepared (perform.js song block, onboarding O2), else
  // "Preparing n of m" while the rest of the set loads behind it (main.js renderReady, say('loading'), counted with
  // controller.songReady as main.js songsLoaded does). The count has no event of its own: main.js polls it every
  // 500 ms while not ready, and so does this, only while it shows.
  let status = v.controller.status || {};
  let loadTimer = 0;
  function setCount() {
    const ids = v.store.navIds();
    if (typeof v.controller.songReady !== 'function') return null;
    let done = 0;
    for (const id of ids) {
      const r = v.controller.songReady(id);
      if (r === null) return null;
      if (r) done += 1;
    }
    return { done, total: ids.length };
  }
  function renderLoad() {
    clearTimeout(loadTimer);
    loadTimer = 0;
    let text = '';
    let title = '';
    if (status.instance !== 'secondary') {
      if (status.loading) {
        text = 'Loading…';
        title = 'Loading this song’s sounds. It plays as soon as this goes.';
      } else if (!status.ready) {
        const c = setCount();
        text = say('loading', c && c.total ? { done: Math.min(c.done, c.total), total: c.total } : {});
        title = c && c.total
          ? `Loading the songs in the set (${Math.min(c.done, c.total)} of ${c.total} ready). You can play now.`
          : 'Loading sounds.';
        loadTimer = setTimeout(renderLoad, 500);
      }
    }
    loadLine.hidden = !text;
    railLoad.hidden = !text;
    el.classList.toggle('loading', !!text);
    if (loadLine.lastChild.textContent !== text) setText(loadLine.lastChild, text);
    loadLine.title = title;
    railLoad.setAttribute('aria-label', text || 'Loaded');
    railLoad.title = text ? `${text} ${title}` : '';
  }
  d.add(() => clearTimeout(loadTimer));
  d.add(v.controller.onStatus((s) => {
    const was = `${status.loading}|${status.ready}|${status.instance}|${status.click?.on}|${status.click?.counting}`;
    status = s || {};
    if (was === `${status.loading}|${status.ready}|${status.instance}|${status.click?.on}|${status.click?.counting}`) {
      return;
    }
    renderLoad();
    renderBadges(lastState); // the Click module's dot follows the click (controller status, not the store)
  }));
  d.add(onVoiceChange(() => renderLoad()));

  buildHeads();
  applyLayout();
  renderBadges(lastState);
  renderLoad();
  save();
  // the width is clamped against the board, which holds `el` only after the view has put it there
  let destroyed = false;
  queueMicrotask(() => {
    if (!destroyed && prefs.open && !portrait) applyLayout();
  });

  /**
   * U7b: register a module after mounting (one loaded with its own flag). A layout that had it gets it back in its
   * place; one that never had it gets it at the end, shown.
   * @param {object} m  a module ({id, label, …, mount}); ignored when one with that id is there
   */
  function addModule(m) {
    if (!m || !m.id || byId.has(m.id) || destroyed) return;
    mods.push(m);
    byId.set(m.id, m);
    prefs = normalizePrefs(prefs, ids(), LATE_MODULE_IDS);
    save();
    buildHeads();
    renderBadges(lastState);
    applyLayout();
  }
  /** U7b: take a module away (its flag went off); its place in the layout is kept for when it comes back. */
  function removeModule(id) {
    if (!byId.has(id) || destroyed) return;
    if (mods.length <= 1) return;
    if (cur?.id === id) unmount();
    mods.splice(mods.findIndex((m) => m.id === id), 1);
    byId.delete(id);
    buildHeads();
    renderBadges(lastState);
    applyLayout();
  }

  return {
    el,
    render(state) {
      lastState = state;
      renderBadges(state);
      el.classList.toggle('locked', !!state.settings.performLock);
    },
    open,
    collapse,
    addModule,
    removeModule,
    /** U7b: a module's badge changed outside the store (the chart moved to / from the stage). */
    refreshBadges: () => renderBadges(lastState),
    /** The module the sidebar shows (or would show when opened). */
    get tab() {
      return tabNow();
    },
    /** The registered module ids, in registry order. */
    get modules() {
      return ids();
    },
    get prefs() {
      return JSON.parse(JSON.stringify(prefs));
    },
    get mounted() {
      return cur ? cur.id : null;
    },
    get portrait() {
      return portrait;
    },
    destroy() {
      destroyed = true;
      if (live === me) live = null;
      czPop?.close();
      endDrag(false);
      unmount();
      d.dispose();
      el.remove();
    },
  };
}
