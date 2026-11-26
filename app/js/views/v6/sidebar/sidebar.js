// UI v6 right sidebar (D15; D16 "Right sidebar" + "The right sidebar is resizable"; UI6-build-plan U3; mockup
// native/docs/design/mockups/perform-v6.html tabs "Sidebar …", "Everything folded", "iPad portrait"; mock_v6.py
// sidebar() / RESIZE_JS). One module at a time as tabs; ⟩ folds it to an icon rail, ⟨ or a rail icon opens it again.
// Its left edge is a grip (role="separator", ←/→ too): SIDEBAR_MIN px … 62 % of the board; narrower than the minimum
// folds it. ⋯ chooses and orders the modules and how it starts. Everything about it is per device
// (localStorage SIDEBAR_KEY), never in the library. iPad portrait (PORTRAIT_MQ): a wide panel under the strips, no
// grip.
// Modules (D15) are self-contained: {id, label, blurb, icon, badge?(state), mount(el, ctx) → {destroy()}}; adding one
// (Chart in 2.1, Tone) is a row in modules.js, nothing here or in the other modules changes. Only the shown module is
// mounted; folding the sidebar or switching tabs destroys it (its listeners go with it).
import { h, setText, disposer, nextId } from '../../components/util.js';
import { button, popover } from '../lib.js';
import { SIDEBAR_MODULES } from './modules.js';

/** localStorage key of the per-device sidebar layout (never exported with the library). */
export const SIDEBAR_KEY = 'worship-rig.v6.sidebar';
/** Narrowest open sidebar (D16); a drag below it folds the sidebar to the rail. */
export const SIDEBAR_MIN = 200;
/** Widest sidebar, as a share of the board (D16: "62 % of the stage"). */
export const SIDEBAR_MAX_FRAC = 0.62;
/** Width before the player has dragged it: the mockup's 280 px; 220 px up to 1240 px wide windows (U1's column). */
export const sidebarDefaultWidth = () => (typeof window !== 'undefined' && window.innerWidth <= 1240 ? 220 : 280);
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
 * shown, the tab a shown module, a width ≥ SIDEBAR_MIN or null (default).
 * @param {unknown} raw  parsed localStorage value (anything)
 * @param {string[]} ids
 * @returns {ReturnType<typeof defaultPrefs>}
 */
export function normalizePrefs(raw, ids) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const known = new Set(ids);
  const uniq = (a) => (Array.isArray(a) ? a.filter((x, i) => known.has(x) && a.indexOf(x) === i) : []);
  const order = uniq(o.order);
  for (const id of ids) if (!order.includes(id)) order.push(id); // a module added in a later version goes last
  let hidden = uniq(o.hidden);
  if (hidden.length >= order.length) hidden = []; // never an empty sidebar
  const shown = order.filter((x) => !hidden.includes(x));
  return {
    open: typeof o.open === 'boolean' ? o.open : true,
    starts: o.starts === 'collapsed' ? 'collapsed' : 'open',
    width: Number.isFinite(o.width) && o.width >= SIDEBAR_MIN ? Math.round(o.width) : null,
    tab: shown.includes(o.tab) ? o.tab : shown[0],
    order,
    hidden,
  };
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
    return normalizePrefs(JSON.parse(localStorage.getItem(SIDEBAR_KEY) || 'null'), ids);
  } catch {
    return defaultPrefs(ids);
  }
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
 * @returns {{el:HTMLElement, render(state:object):void, open(id?:string):void, collapse():void,
 *            readonly prefs:object, readonly mounted:string|null, readonly portrait:boolean, destroy():void}}
 */
export function rightSidebar(v, o = {}) {
  const mods = o.modules || SIDEBAR_MODULES;
  const byId = new Map(mods.map((m) => [m.id, m]));
  const ids = mods.map((m) => m.id);
  const d = disposer();
  let prefs = loadPrefs(ids);
  if (!startedThisPage) {
    startedThisPage = true;
    prefs.open = prefs.starts === 'open';
  }
  const mq = typeof window.matchMedia === 'function' ? window.matchMedia(PORTRAIT_MQ) : null;
  let portrait = !!mq?.matches;
  let lastState = v.store.get();

  const save = () => {
    try {
      localStorage.setItem(SIDEBAR_KEY, JSON.stringify(prefs));
    } catch {
      /* private mode / quota: the layout still works for this session */
    }
  };
  const shown = () => prefs.order.filter((id) => !prefs.hidden.includes(id));

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
  const rail = h('div.v6-sb-rail', { 'data-testid': 'v6-sb-rail' }, railOpen, railList);
  el.append(grip, h('div.v6-sb-h', {}, tabs, czBtn, xBtn), body, rail);

  // ---------------------------------------------------------------- tabs + rail (rebuilt when the shown list changes)
  let tabBtns = new Map();
  let railBtns = new Map();
  let builtFor = '';
  function buildHeads() {
    const list = shown();
    const sig = list.join(',');
    if (sig === builtFor) return;
    builtFor = sig;
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
  const focusTab = () => tabBtns.get(prefs.tab)?.focus({ preventScroll: true });
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
  function applyLayout() {
    el.classList.toggle('rail', !prefs.open);
    el.classList.toggle('wide', portrait);
    grip.hidden = portrait || !prefs.open;
    if (portrait || !prefs.open) {
      el.style.removeProperty('width');
    } else {
      const sw = stageWidth();
      const w = clampWidth(prefs.width ?? sidebarDefaultWidth(), sw);
      el.style.width = `${w}px`;
      grip.setAttribute('aria-valuenow', String(w));
      grip.setAttribute('aria-valuemax', String(clampWidth(Infinity, sw)));
      grip.setAttribute('aria-valuetext', `${w} px wide`);
    }
    if (prefs.open) mount(prefs.tab);
    else unmount();
    for (const [id, b] of tabBtns) {
      const on = id === prefs.tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    for (const [id, b] of railBtns) b.classList.toggle('act', id === prefs.tab);
    o.onChange?.({ open: prefs.open, tab: prefs.tab, portrait });
  }
  function selectTab(id) {
    if (!shown().includes(id)) return;
    prefs.tab = id;
    save();
    applyLayout();
  }
  /** Open the sidebar (on module `id`, shown again if the player had hidden it). */
  function open(id) {
    if (id && byId.has(id)) {
      if (prefs.hidden.includes(id)) {
        prefs.hidden = prefs.hidden.filter((x) => x !== id);
        buildHeads();
        renderBadges(lastState);
      }
      prefs.tab = id;
    }
    prefs.open = true;
    save();
    applyLayout();
  }
  function collapse() {
    czPop?.close();
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
      prefs.width = Math.max(SIDEBAR_MIN, Math.round(g.w0));
      collapse();
      return;
    }
    if (commit && Math.abs(g.w - g.w0) >= 1) {
      prefs.width = g.w;
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
    const w = clampWidth(prefs.width ?? sidebarDefaultWidth(), sw);
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
    prefs.width = clampWidth(next, sw);
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

  function buildCustomize(pb, pd) {
    const list = h('div.v6-cz-list', { role: 'list', 'aria-label': 'Modules, in order' });
    const startOpen = button(pd, '.v6-cz-start', 'Open', { 'data-value': 'open', 'data-testid': 'v6-sb-starts-open' });
    const startCol = button(pd, '.v6-cz-start', 'Collapsed', {
      'data-value': 'collapsed', 'data-testid': 'v6-sb-starts-collapsed',
    });
    pb.append(
      h('div.v6-pop-h', {}, 'Sidebar ', h('span', { text: 'drag ⠿ or use ↑ ↓ to reorder' })),
      list,
      h('div.v6-cz-starts', { role: 'group', 'aria-label': 'When the app starts, the sidebar is' },
        h('span.v6-cap', { text: 'Starts' }), startOpen, startCol),
    );
    for (const b of [startOpen, startCol]) {
      pd.listen(b, 'click', () => {
        prefs.starts = b.dataset.value;
        save();
        renderCz();
      });
    }
    const commit = (order) => {
      prefs.order = order;
      save();
      buildHeads();
      renderBadges(lastState);
      applyLayout();
      renderCz();
    };
    const move = (id, by) => {
      const order = prefs.order.slice();
      const i = order.indexOf(id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= order.length) return;
      order.splice(i, 1);
      order.splice(j, 0, id);
      commit(order);
      list.querySelector(`[data-id="${id}"] .v6-cz-${by < 0 ? 'up' : 'dn'}:not(:disabled)`)?.focus();
    };
    const setShown = (id, on) => {
      const hidden = prefs.hidden.filter((x) => x !== id);
      if (!on) hidden.push(id);
      if (hidden.length >= prefs.order.length) return; // the last shown module stays
      prefs.hidden = hidden;
      if (!on && prefs.tab === id) prefs.tab = shown()[0];
      save();
      buildHeads();
      renderBadges(lastState);
      applyLayout();
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
          if (order.join() !== prefs.order.join()) commit(order);
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
      const n = prefs.order.length;
      const vis = shown();
      list.replaceChildren(...prefs.order.map((id) => rows.get(id).row));
      prefs.order.forEach((id, i) => {
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

  buildHeads();
  applyLayout();
  renderBadges(lastState);
  save();
  // the width is clamped against the board, which holds `el` only after the view has put it there
  let destroyed = false;
  queueMicrotask(() => {
    if (!destroyed && prefs.open && !portrait) applyLayout();
  });

  return {
    el,
    render(state) {
      lastState = state;
      renderBadges(state);
      el.classList.toggle('locked', !!state.settings.performLock);
    },
    open,
    collapse,
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
      czPop?.close();
      endDrag(false);
      unmount();
      d.dispose();
      el.remove();
    },
  };
}
