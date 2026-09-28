// H-v2 Edit view shell (design/H-v2 concept §1(1) + §3, implementation §1 "Edit tab row" / "Show wiring").
// mountEdit(el, ctx) → { el, editState, destroy() }: the same signature as views/edit.js, so main.js swaps the
// import.
//
// Layout (edit.png): left = setlist column (region 'setlist'); centre = song header (region 'song-header') over the
// rig card: "Your rig" bar (Wheels & pedal link, Show wiring switch), one row of 7 block tabs (Keys · Pad · Extra ·
// Bass · Drone | Effects · Master), the optional wiring strip, and the panel host (sentence title + the selected
// block's panel module); bottom = keyboard row (region 'bottom').
//
// The shell owns: the layout, the tab row (summaries, LEDs, off state, changed dots, tablist keyboard pattern), the
// wiring strip, the selection model (ctx.editState), the panel registry and the per-panel ctx (store fan-out,
// song-bound fields, Esc stack, dialogs, instruments, held notes, the changed-since-loaded set). Panel modules own
// everything inside their host element. See views/edit/CONTRACT.md.
import { loadComponents, markDialog } from '../_fallback-components.js';
import { describe, formatValue } from '../../shared/params.js';
import { SPACE_PRESETS, ECHO_PRESETS, matchPreset } from '../../shared/fx-presets.js';
import { changedPaths, hasChange } from '../../shared/song-diff.js';
import PANELS from './panels/index.js';
import { h, setText, icon, getIn, relOf, pct, BLOCKS, blockOf, sentence, droneKeyText, chorusWord } from './lib.js';

const C = await loadComponents();

// ---------------------------------------------------------------------------------------------------------------
// registry
/** @type {Map<string, {id:string, region?:'left'|'head'|'bottom', icon?:string, mount:Function, tab?:Function}>} */
const registry = new Map();
/**
 * Register (or replace) a panel module. Block panels ('slot', 'drone', 'effects', 'master', 'song') mount into the
 * panel host when their block is selected; region modules ('setlist' → left, 'song-header' → head, 'bottom' →
 * bottom) mount once. The shell registers panels/index.js at load; tests may register extra ids.
 * @param {string} id
 * @param {{region?:'left'|'head'|'bottom', icon?:string,
 *          mount:(el:HTMLElement, ctx:object, opts:object) => {destroy():void, update?(opts:object):void},
 *          tab?:(song:object, opts:object, helpers:{findInstrument:Function, C:object}) =>
 *                {name:string, sub?:string, off?:boolean, empty?:boolean}}} def
 */
export function registerPanel(id, def) {
  if (!def || typeof def.mount !== 'function') {
    throw new TypeError(`registerPanel(${id}): mount(el, ctx, opts) required`);
  }
  registry.set(id, { ...def, id });
}
/** @returns {string[]} registered panel ids */
export const registeredPanels = () => [...registry.keys()];
for (const p of PANELS) registerPanel(p.id, p);

// ---------------------------------------------------------------------------------------------------------------
/**
 * The Edit view's selection + view-local state (never persisted: concept §1 "Show wiring … view memory only").
 * Events (CustomEvent detail): 'select' {id, opts, prev}, 'wiring' {on}, 'drawer' {open}, 'changes' {paths:Set},
 * 'notes' {held:Set}, 'instruments' {list}.
 */
export class EditState extends EventTarget {
  constructor() {
    super();
    /** @type {string} 'slot:0'..'slot:3' | 'drone' | 'effects' | 'master' | 'song' */
    this.selected = 'slot:0';
    /** @type {object} extra options of the last select() ({focus:'wheels'} …) */
    this.opts = {};
    this.wiring = false;
    this.drawer = false;
    /** @type {Set<string>} song-relative changed paths (song-diff DIFF_WATCH) */
    this.changes = new Set();
    /** @type {() => object|null} */
    this.baselineGetter = () => null;
  }

  /**
   * Select a block. Re-selecting the same block with new opts (e.g. {focus}) re-dispatches.
   * @param {string} id
   * @param {object} [opts]
   * @returns {boolean} false for an unknown block id
   */
  select(id, opts = {}) {
    if (!blockOf(id)) return false;
    const prev = this.selected;
    this.selected = id;
    this.opts = { ...opts };
    this.dispatchEvent(new CustomEvent('select', { detail: { id, opts: this.opts, prev } }));
    return true;
  }

  /** @param {boolean} on */
  setWiring(on) {
    if (this.wiring === !!on) return;
    this.wiring = !!on;
    this.dispatchEvent(new CustomEvent('wiring', { detail: { on: this.wiring } }));
  }

  /** Narrow screens: the setlist column as a drawer ("☰ Songs"). @param {boolean} open */
  setDrawer(open) {
    if (this.drawer === !!open) return;
    this.drawer = !!open;
    this.dispatchEvent(new CustomEvent('drawer', { detail: { open: this.drawer } }));
  }

  /** The Revert snapshot the changed dots compare against (null = none yet). */
  get baseline() {
    return this.baselineGetter();
  }

  /** @param {string|string[]} prefixes song-relative ('patch.slots.0', 'drone') @returns {boolean} */
  isChanged(prefixes) {
    return [].concat(prefixes).some((p) => hasChange(this.changes, p));
  }

  /** @param {string|string[]} [prefixes] @returns {number} changed paths under the prefixes (all when omitted) */
  changeCount(prefixes) {
    if (!prefixes) return this.changes.size;
    const list = [].concat(prefixes);
    let n = 0;
    for (const p of this.changes) if (list.some((x) => p === x || p.startsWith(`${x}.`))) n += 1;
    return n;
  }
}

// ---------------------------------------------------------------------------------------------------------------
const FOCUSABLE = ['input', 'select', 'textarea', 'button'].map((t) => `${t}:not([disabled])`)
  .concat('[tabindex]').join(', ');
const clone = (o) => (o ? JSON.parse(JSON.stringify(o)) : null);

/**
 * The shared core behind both mountEdit and mountSinglePanel: store fan-out, baseline/changes, instruments, held
 * notes, Esc stack, blur-after-pointer, and the per-panel ctx factory.
 */
function createCore(root, appCtx) {
  const { store, controller, engine } = appCtx;
  const editState = new EditState();
  const cleanups = [];
  const listen = (target, type, fn, opts) => {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };
  // opts ({ms, action:{label, run}}) pass through to main.js's toast (the slot panel's "Undo"; hv2-edit-slot request)
  const toast = (msg, kind = 'info', opts) => {
    if (typeof appCtx.toast === 'function') appCtx.toast(msg, kind, opts);
    else if (kind === 'error') console.warn(`[edit] ${msg}`);
  };

  const core = {
    editState,
    song: store.currentSong(),
    songId: null,
    instruments: [],
    held: new Set(),
    /** @type {Set<Set<Function>>} one subscriber set per mounted panel */
    subSets: new Set(),
    /** @type {Array<Function>} Esc handlers, LIFO */
    escapes: [],
    /** @type {Set<Function>} */
    leaveHooks: new Set(),
    /** extra store listeners of the shell itself (tabs, wiring) */
    onStoreHooks: [],
    cleanups,
    listen,
    toast,
  };
  core.songId = core.song ? core.song.id : null;

  // ---- baseline: the app's Revert snapshot when it is for this song (main.js ctx.getBaseline → perform.js
  // savedSnapshot), else our own copy taken on the controller's 'songSelected' (a commit) or when the song changes.
  let ownBase = core.song ? { id: core.song.id, song: clone(core.song) } : null;
  editState.baselineGetter = () => {
    let g = null;
    try {
      g = typeof appCtx.getBaseline === 'function' ? appCtx.getBaseline() : null;
    } catch {
      g = null;
    }
    if (g && g.id === core.songId) return g;
    return ownBase && ownBase.id === core.songId ? ownBase.song : null;
  };
  let changesKey = '';
  core.recomputeChanges = () => {
    const set = changedPaths(core.song, editState.baseline);
    const key = [...set].join('|');
    editState.changes = set;
    if (key === changesKey) return;
    changesKey = key;
    editState.dispatchEvent(new CustomEvent('changes', { detail: { paths: set } }));
  };
  listen(controller, 'songSelected', (e) => {
    const d = e.detail || {};
    if (d.id && d.songSnapshot) ownBase = { id: d.id, song: clone(d.songSnapshot) };
    core.recomputeChanges();
    for (const fn of core.onStoreHooks) fn(null);
  });

  // ---- song-bound text fields (round2-ui #3): write to the song focused on, never "the current song" at commit
  const fieldIds = new WeakMap();
  core.songField = (input, rel) => {
    input.dataset.songField = '1';
    input.addEventListener('focus', () => {
      if (core.songId) fieldIds.set(input, core.songId);
    });
    return (v) => {
      const id = fieldIds.get(input) || core.songId;
      return id ? store.set(`songs.${id}.${rel}`, v) : false;
    };
  };
  core.fieldSongId = (input) => fieldIds.get(input) || core.songId;

  function leaveSong() {
    for (const fn of [...core.leaveHooks]) {
      try {
        fn();
      } catch (err) {
        console.warn('[edit] leave-song hook failed', err);
      }
    }
    const a = document.activeElement;
    if (a && a.dataset?.songField && root.contains(a)) a.blur(); // its change commits to the old song id
  }

  // ---- store fan-out
  core.onStore = (state, paths) => {
    const cur = state.settings.currentSongId;
    const next = cur ? state.songs[cur] || null : null;
    const rels = [];
    let full = false;
    for (const p of paths) {
      if (!p.startsWith('songs.')) continue;
      const segs = p.split('.');
      if (segs[1] !== cur) continue;
      const rest = segs.slice(2).join('.');
      if (!rest) full = true;
      else rels.push(rest);
    }
    const songChanged = (next ? next.id : null) !== core.songId;
    if (songChanged) leaveSong();
    core.song = next;
    core.songId = next ? next.id : null;
    if (songChanged && next && !(ownBase && ownBase.id === next.id)) ownBase = { id: next.id, song: clone(next) };
    core.recomputeChanges();
    const ev = { state, song: next, songId: core.songId, paths, rels, songChanged, full };
    for (const fn of core.onStoreHooks) fn(ev);
    for (const set of [...core.subSets]) {
      for (const fn of [...set]) {
        try {
          fn(ev);
        } catch (err) {
          console.warn('[edit] panel store handler failed', err);
        }
      }
    }
  };
  cleanups.push(store.subscribe(core.onStore));

  // ---- instruments (arrive when the engine starts; change on a My Samples rescan)
  const readInstruments = () => {
    try {
      const l = engine && typeof engine.listInstruments === 'function' ? engine.listInstruments() : [];
      return Array.isArray(l) ? l : [];
    } catch (err) {
      console.warn('[edit] listInstruments failed', err);
      return [];
    }
  };
  core.instruments = readInstruments();
  const onInstruments = () => {
    const l = readInstruments();
    const a = core.instruments;
    const same = (x, k) => x.ref.id === a[k].ref.id && x.ref.type === a[k].ref.type && x.group === a[k].group;
    if (l.length === a.length && l.every(same)) return;
    core.instruments = l;
    editState.dispatchEvent(new CustomEvent('instruments', { detail: { list: l } }));
    for (const fn of core.onStoreHooks) fn(null);
  };
  listen(engine, 'ready', onInstruments);
  listen(engine, 'instruments', onInstruments);
  listen(controller, 'instruments', onInstruments);
  listen(controller, 'user-samples', onInstruments);
  listen(window, 'rig-instruments-changed', onInstruments);
  if (typeof controller?.onStatus === 'function') {
    cleanups.push(controller.onStatus(() => {
      if (!core.instruments.length) onInstruments();
    }));
  }
  core.findInstrument = (ref) =>
    (ref ? core.instruments.find((x) => x.ref.type === ref.type && x.ref.id === ref.id) || null : null);

  // ---- held notes (tab LEDs, keyboard row, "Set lowest…")
  listen(controller, 'notes', (e) => {
    const held = e && e.detail && e.detail.held;
    if (!held) return;
    core.held = new Set(held);
    editState.dispatchEvent(new CustomEvent('notes', { detail: { held: core.held } }));
  });

  // ---- pointer clicks don't leave focus on buttons/selects: Space = sustain and ←/→ = songs work unfocused
  let lastPointer = 0;
  listen(root, 'pointerdown', () => {
    lastPointer = performance.now();
  });
  listen(root, 'click', (e) => {
    const b = e.target && e.target.closest && e.target.closest('button, summary');
    if (b && e.detail > 0 && !b.closest('[data-keep-focus]')) queueMicrotask(() => b.blur());
  });
  listen(root, 'change', (e) => {
    const t = e.target;
    if (t && t.tagName === 'SELECT' && performance.now() - lastPointer < 4000) queueMicrotask(() => t.blur());
  });

  // ---- Esc (ux.md M1): inside Edit, Esc closes the newest open confirm/menu/drawer and never panics. Capture phase
  // on window so it runs before the controller's document-level handler (which ignores defaultPrevented events).
  const visible = () => root.isConnected && !root.closest('[hidden]');
  listen(window, 'keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !visible()) return;
    if (document.querySelector('.st-host.open')) return; // Settings is on top and closes itself
    const t = e.target;
    if (t && t.closest && t.closest('[data-own-escape]')) return; // inputs that handle Esc themselves
    let closed = false;
    for (let k = core.escapes.length - 1; k >= 0 && !closed; k--) {
      try {
        closed = core.escapes[k]() === true;
      } catch (err) {
        console.warn('[edit] Esc handler failed', err);
      }
    }
    e.preventDefault(); // Esc is never Panic in Edit (⌘. still is)
    if (closed) {
      e.stopPropagation();
      markDialog('edit-esc', true); // keep the flag up for any later Esc listener of this same event…
      setTimeout(() => markDialog('edit-esc', false), 0); // …then drop it
    }
  }, true);

  /**
   * The ctx a panel module's mount() receives (CONTRACT.md §3). Everything it registers is released by dispose().
   * @param {{setTitle?:Function, host:HTMLElement}} o
   */
  core.panelCtx = ({ setTitle, host }) => {
    const subs = new Set();
    const own = [];
    core.subSets.add(subs);
    const pctx = {
      // app services
      store, controller, engine, midi: appCtx.midi, recorder: appCtx.recorder, toast,
      openSettings: appCtx.openSettings, app: appCtx,
      /** Component set: components/index.js (ui-core, incl. onTile/stepChip/stepPanel/holdButton) over fallbacks. */
      C,
      editState,
      // song access
      song: () => core.song,
      songId: () => core.songId,
      /** store.set passthrough (§4 grammar, 'song.<field>', entity paths). @returns {boolean} */
      set: (addr, v) => store.set(addr, v),
      /** Current song value for a §4 address / 'song.<field>' (PARAMS default when the song lacks it). */
      valueOf(addr) {
        const v = core.song ? getIn(core.song, relOf(addr)) : undefined;
        return v === undefined ? describe(addr)?.default : v;
      },
      /** Store changes, pre-digested; fn({state, song, songId, paths, rels, songChanged, full}). @returns unsub */
      subscribe(fn) {
        subs.add(fn);
        return () => subs.delete(fn);
      },
      listen(target, type, fn, opts) {
        if (!target || typeof target.addEventListener !== 'function') return () => {};
        target.addEventListener(type, fn, opts);
        const off = () => target.removeEventListener(type, fn, opts);
        own.push(off);
        return off;
      },
      /** Runs before the shown song changes (flush debounced text, cancel drags). @returns unsub */
      onLeaveSong(fn) {
        core.leaveHooks.add(fn);
        const off = () => core.leaveHooks.delete(fn);
        own.push(off);
        return off;
      },
      /** Esc handler: return true when you closed something (newest first). @returns unsub */
      onEscape(fn) {
        core.escapes.push(fn);
        const off = () => {
          const k = core.escapes.lastIndexOf(fn);
          if (k >= 0) core.escapes.splice(k, 1);
        };
        own.push(off);
        return off;
      },
      /** body[data-dialog-open] while an inline confirm/menu of yours is open (ux.md M1). */
      markDialog(open, token = 'panel') {
        const t = `edit-${token}`;
        markDialog(t, !!open);
        if (open) own.push(() => markDialog(t, false));
      },
      /** Arm a song-bound text field; returns commit(v) writing songs.<id focused on>.<rel>. */
      songField: (input, rel) => core.songField(input, rel),
      fieldSongId: (input) => core.fieldSongId(input),
      /** Sentence title of the panel host (block panels; a no-op for regions). */
      setTitle: setTitle || (() => {}),
      instruments: () => core.instruments,
      findInstrument: (ref) => core.findInstrument(ref),
      held: () => core.held,
      select: (id, opts) => editState.select(id, opts),
      /** Extra cleanup run on dispose. */
      cleanup(fn) {
        own.push(fn);
      },
      host,
    };
    return {
      pctx,
      dispose() {
        core.subSets.delete(subs);
        for (const fn of own.splice(0).reverse()) {
          try {
            fn();
          } catch (err) {
            console.warn('[edit] panel cleanup failed', err);
          }
        }
      },
    };
  };

  /** Mount a registered module into `host`; errors render a placeholder instead of breaking the view. */
  core.mountModule = (id, host, opts, setTitle) => {
    const def = registry.get(id);
    const { pctx, dispose } = core.panelCtx({ setTitle, host });
    let inst = null;
    host.dataset.panel = id;
    if (!def) {
      host.replaceChildren(h('p.ev2-missing', { text: `No panel registered for "${id}".` }));
    } else {
      try {
        inst = def.mount(host, pctx, opts || {}) || null;
      } catch (err) {
        console.warn(`[edit] panel ${id} failed to mount`, err);
        host.replaceChildren(h('p.ev2-missing', { text: `The ${id} panel failed to load.` }));
      }
    }
    return {
      id,
      inst,
      pctx,
      update(o) {
        if (inst && typeof inst.update === 'function') {
          inst.update(o || {});
          return true;
        }
        return false;
      },
      destroy() {
        try {
          inst?.destroy?.();
        } catch (err) {
          console.warn(`[edit] panel ${id} destroy failed`, err);
        }
        dispose();
        host.replaceChildren();
        delete host.dataset.panel;
      },
    };
  };

  core.dispose = () => {
    for (const c of cleanups.splice(0)) {
      try {
        c();
      } catch (err) {
        console.warn('[edit] cleanup failed', err);
      }
    }
    markDialog('edit-esc', false);
  };
  return core;
}

// ---------------------------------------------------------------------------------------------------------------
// panel frame: sentence title + body
function panelFrame(core) {
  const tile = h('div.ev2-title-icon');
  const main = h('div.ev2-title-main');
  const actions = h('div.ev2-title-actions');
  const title = h('div.ev2-title', {}, tile, main, h('span.ev2-sp'), actions);
  const body = h('div.ev2-body');
  const panel = h('div.ev2-panel#ev2-panel', { role: 'tabpanel' }, title, body);
  let flashTimer = 0;
  const focusControl = (part) => {
    let c = part.control;
    if (typeof c === 'function') c = c();
    else if (typeof c === 'string') c = body.querySelector(c) || panel.querySelector(c);
    if (!(c instanceof Element)) return;
    const det = c.closest('details');
    if (det && !det.open) det.open = true;
    c.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    const f = c.matches(FOCUSABLE) ? c : c.querySelector(FOCUSABLE);
    if (f) f.focus({ preventScroll: true });
    for (const x of panel.querySelectorAll('.ev2-flash')) x.classList.remove('ev2-flash');
    c.classList.add('ev2-flash');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => c.classList.remove('ev2-flash'), 900);
  };
  /**
   * @param {Array<string|object>} parts  lib.sentence() parts
   * @param {{sub?:string, icon?:string|Node, actions?:Node|Node[]}} [o]
   */
  const setTitle = (parts, o = {}) => {
    tile.replaceChildren(o.icon instanceof Node ? o.icon : icon(o.icon || 'song', 26));
    const sub = o.sub ? h('span.ev2-title-sub', { text: o.sub }) : '';
    main.replaceChildren(sentence(parts, { onToken: focusControl }), sub);
    actions.replaceChildren(...[].concat(o.actions || []));
  };
  const clearTitle = () => {
    tile.replaceChildren();
    main.replaceChildren();
    actions.replaceChildren();
  };
  return { panel, title, body, setTitle, clearTitle, dispose: () => clearTimeout(flashTimer) };
}

// ---------------------------------------------------------------------------------------------------------------
// tab summaries (a panel def's tab() overrides these)
function defaultTab(block, song, core) {
  if (!song) return { name: '—' };
  if (block.panel === 'slot') {
    const slot = song.patch.slots[block.opts.slot];
    if (!slot) return { name: '+ Add a sound', empty: true };
    const meta = core.findInstrument(slot.instrument);
    const nm = meta ? meta.name : slot.instrument.id;
    return { name: typeof C.stageName === 'function' ? C.stageName(nm, slot.instrument) : nm, off: !!slot.muted };
  }
  const val = (addr) => {
    const v = getIn(song, relOf(addr));
    return v === undefined ? describe(addr)?.default : v;
  };
  if (block.id === 'drone') {
    const d = song.drone || {};
    const key = droneKeyText(song); // "C# minor", as the KEY chip and the drone panel spell it
    if (d.mode === 'off') return { name: key, sub: '· off', off: true };
    return { name: key, sub: `· ${d.mode === 'files' ? 'My Pads' : 'Synth'}` };
  }
  if (block.id === 'effects') {
    const sp = matchPreset(SPACE_PRESETS, val);
    const ec = matchPreset(ECHO_PRESETS, val);
    const echo = ec ? (ec.id === 'none' ? 'off' : ec.name.toLowerCase()) : 'own';
    return { name: sp ? sp.name : 'Custom', sub: `· echo: ${echo}` };
  }
  if (block.id === 'master') {
    const lofi = Number(val('fx.lofi.amount')) || 0;
    const tape = lofi > 0.0001 ? pct(lofi) : 'off';
    return { name: formatValue('master.volume', val('master.volume')), sub: `· Tape ${tape}` };
  }
  return { name: block.role };
}

const tabId = (id) => `ev2-tab-${id.replace(':', '-')}`;
const LANES = Object.freeze([
  { unit: 'reverb', name: 'Space', icon: 'room' },
  { unit: 'delay', name: 'Echo', icon: 'echo' },
  { unit: 'chorus', name: 'Chorus', icon: 'chorus' },
]);

// ---------------------------------------------------------------------------------------------------------------
/**
 * Mount the H-v2 Edit view.
 * @param {HTMLElement} el
 * @param {{store, controller, engine, midi?, recorder?, toast?, openSettings?, getBaseline?:() => object|null}} ctx
 *        getBaseline: perform.js's Revert snapshot (`savedSnapshot`); optional (the shell keeps its own otherwise)
 * @returns {{el:HTMLElement, editState:EditState, destroy():void, _debug:object}}
 */
export function mountEdit(el, ctx) {
  const root = h('div.ev2');
  const core = createCore(root, ctx);
  const { editState } = core;

  // ---- regions
  const left = h('aside.ev2-left', { 'aria-label': 'Songs and setlists' });
  const head = h('header.ev2-head', { 'aria-label': 'Song' });
  const bottom = h('footer.ev2-bottom', { 'aria-label': 'Keyboard and output' });

  // ---- rig card: top bar, tabs, wiring, panel
  const wheelsBtn = h('button.ev2-linkbtn.ev2-wheels',
    { type: 'button', title: 'Mod wheel, expression pedal, pitch bend and swell' },
    icon('keyboard', 15), 'Wheels & pedal');
  const wireBtn = h('button.ev2-wiretog', { type: 'button', role: 'switch', 'aria-checked': 'false' },
    h('span.ev2-switch', { 'aria-hidden': 'true' }), 'Show wiring');
  const rigTop = h('div.ev2-rig-top', {},
    h('span.ev2-cap', { text: 'Your rig' }),
    h('span.ev2-rig-hint', {
      text: 'Pick a part to edit it. The dot on a tab means something changed since the song was loaded.',
    }),
    h('span.ev2-sp'), wheelsBtn, wireBtn);
  const tablist = h('div.ev2-tabs', { role: 'tablist', 'aria-label': 'Your rig' });
  const tabs = new Map();
  for (const b of BLOCKS) {
    if (b.id === 'effects') tablist.append(h('span.ev2-tab-gap', { 'aria-hidden': 'true' }));
    const led = h('i.ev2-tab-led');
    const name = h('span.ev2-tab-name-text');
    const sub = h('small.ev2-tab-sub');
    const cd = h('em.ev2-tab-cd', { title: 'Changed since the song was loaded', hidden: true });
    const t = h('button.ev2-tab', {
      type: 'button', role: 'tab', id: tabId(b.id), 'aria-selected': 'false', 'aria-controls': 'ev2-panel',
      tabindex: '-1',
      class: b.shared ? 'fxt' : '', dataset: { block: b.id }, style: { '--tc': b.color },
    }, h('span.ev2-tab-role', {}, led, b.role.toUpperCase()), h('b.ev2-tab-name', {}, name, sub), cd);
    t.addEventListener('click', () => editState.select(b.id));
    tabs.set(b.id, { el: t, led, name, sub, cd, block: b });
    tablist.append(t);
  }
  const wire = h('div.ev2-wire', { hidden: true, 'aria-label': 'Wiring' });
  const frame = panelFrame(core);
  const rig = h('section.ev2-rig', {}, rigTop, tablist, wire, frame.panel);
  root.append(left, head, rig, bottom);
  el.classList.add('ev2-host');
  el.replaceChildren(root);
  el.__rigCtx = ctx; // test/debug handle (the view's own context)

  // ---- tab row rendering
  function renderTabs() {
    const song = core.song;
    for (const [id, t] of tabs) {
      const def = registry.get(t.block.panel);
      let s;
      try {
        const helpers = { findInstrument: core.findInstrument, C };
        const own = def && typeof def.tab === 'function' && song ? def.tab(song, t.block.opts, helpers) : null;
        s = own || defaultTab(t.block, song, core);
      } catch (err) {
        console.warn(`[edit] tab summary ${id} failed`, err);
        s = defaultTab(t.block, song, core);
      }
      setText(t.name, s.name);
      setText(t.sub, s.sub ? ` ${s.sub}` : '');
      t.el.classList.toggle('empty', !!s.empty);
      t.el.classList.toggle('off', !!s.off);
      t.cd.hidden = !editState.isChanged(t.block.prefixes);
      const sel = editState.selected === id;
      t.el.classList.toggle('sel', sel);
      t.el.setAttribute('aria-selected', String(sel));
    }
    // roving tabindex: the selected tab, else the last selected one, else Keys
    const cur = tabs.get(editState.selected) || tabs.get(lastTab) || tabs.get('slot:0');
    for (const t of tabs.values()) t.el.tabIndex = t === cur ? 0 : -1;
    renderLeds();
  }
  let lastTab = 'slot:0';
  function renderLeds() {
    const song = core.song;
    for (const t of tabs.values()) {
      let playing = false;
      if (song && t.block.panel === 'slot') {
        const slot = song.patch.slots[t.block.opts.slot];
        if (slot && !slot.muted) for (const n of core.held) if (n >= slot.lowNote && n <= slot.highNote) playing = true;
      }
      t.el.classList.toggle('playing', playing);
    }
  }
  tablist.addEventListener('keydown', (e) => {
    const ids = BLOCKS.map((b) => b.id);
    const k = ids.indexOf(e.target?.dataset?.block);
    if (k < 0) return;
    let n = -1;
    if (e.key === 'ArrowRight') n = (k + 1) % ids.length;
    else if (e.key === 'ArrowLeft') n = (k - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = ids.length - 1;
    if (n < 0) return;
    e.preventDefault();
    e.stopPropagation(); // ←/→ are Prev/Next song elsewhere
    editState.select(ids[n]);
    tabs.get(ids[n]).el.focus();
  });

  // ---- wiring strip (numbers, not dot sizes; zero = dashed "–"; the drone = "fixed")
  function renderWire() {
    wire.hidden = !editState.wiring;
    rig.classList.toggle('wired', editState.wiring);
    wireBtn.setAttribute('aria-checked', String(editState.wiring));
    wireBtn.classList.toggle('on', editState.wiring);
    if (!editState.wiring) return;
    const song = core.song;
    const grid = h('div.ev2-wire-grid');
    const val = (addr) => {
      const v = song ? getIn(song, relOf(addr)) : undefined;
      return v === undefined ? describe(addr)?.default : v;
    };
    LANES.forEach((lane, r) => {
      const row = r + 1;
      const at = (col) => ({ gridRow: String(row), gridColumn: String(col) });
      grid.append(h('span.ev2-wlane', { style: at('1 / 7'), dataset: { lane: lane.unit } }));
      for (let i = 0; i < 4; i++) {
        const slot = song ? song.patch.slots[i] : null;
        const cell = h('span.ev2-wdrop', { style: { ...at(i + 1), '--c': `var(--slot-${i})` } });
        if (slot) {
          const v = Math.round((Number(slot.sends?.[lane.unit]) || 0) * 100);
          cell.append(h('span.ev2-wv', {
            class: v === 0 ? 'zero' : '',
            text: v === 0 ? '–' : `${v}%`,
            dataset: { lane: lane.unit, slot: String(i), value: String(v) },
          }));
          if (slot.muted) cell.classList.add('dim');
        }
        grid.append(cell);
      }
      const dr = h('span.ev2-wdrop', { style: { ...at(5), '--c': 'var(--drone, #e8d9a8)' } });
      if (r === 0 && song && song.drone?.mode !== 'off') {
        dr.append(h('span.ev2-wv.fixed', { text: 'fixed', dataset: { lane: lane.unit, drone: '1' } }));
      }
      grid.append(dr);
      let what = '';
      if (lane.unit === 'reverb') what = matchPreset(SPACE_PRESETS, val)?.name || 'custom';
      else if (lane.unit === 'delay') what = matchPreset(ECHO_PRESETS, val)?.name || 'song’s own';
      else what = chorusWord(Number(val('fx.chorus.depth')) || 0);
      grid.append(h('span.ev2-wend', { style: at(7) },
        h('button.ev2-wn', { type: 'button', on: { click: () => editState.select('effects', { focus: lane.unit }) } },
          icon(lane.icon, 14), lane.name, h('span', { text: what }))));
    });
    grid.append(h('span.ev2-wout', { style: { gridRow: '1 / 4', gridColumn: '8' } }, h('i.ev2-wout-br'), 'to Master'));
    wire.replaceChildren(
      h('p.ev2-wire-cap', {}, h('b', { text: 'Wiring.' }),
        ' Every sound goes straight to Master. The numbers are how much of each sound also goes into each shared'
        + ' effect.'),
      grid);
  }
  wheelsBtn.addEventListener('click', () => editState.select('master', { focus: 'wheels' }));
  wireBtn.addEventListener('click', () => editState.setWiring(!editState.wiring));

  // ---- panel host
  let cur = null; // mounted block panel
  function showSelected() {
    const block = blockOf(editState.selected);
    const opts = { ...block.opts, ...editState.opts };
    rig.style.setProperty('--c', block.color);
    rig.dataset.selected = block.id;
    if (tabs.has(block.id)) {
      lastTab = block.id;
      frame.panel.setAttribute('aria-labelledby', tabId(block.id));
      frame.panel.removeAttribute('aria-label');
    } else {
      frame.panel.removeAttribute('aria-labelledby');
      frame.panel.setAttribute('aria-label', block.role);
    }
    if (cur && cur.id === block.panel && cur.update(opts)) return;
    cur?.destroy();
    frame.clearTitle();
    cur = core.mountModule(block.panel, frame.body, opts, frame.setTitle);
  }
  core.listen(editState, 'select', () => {
    showSelected();
    renderTabs();
  });
  core.listen(editState, 'wiring', renderWire);
  core.listen(editState, 'changes', renderTabs);
  core.listen(editState, 'notes', renderLeds);
  core.listen(editState, 'drawer', (e) => root.classList.toggle('drawer-open', !!e.detail.open));
  core.onStoreHooks.push(() => {
    renderTabs();
    renderWire();
  });
  // drawer: an outside pointer closes it; Esc too (lowest priority)
  core.escapes.push(() => {
    if (!editState.drawer) return false;
    editState.setDrawer(false);
    return true;
  });
  core.listen(root, 'pointerdown', (e) => {
    if (!editState.drawer || left.contains(e.target) || e.target.closest?.('[data-drawer-toggle]')) return;
    editState.setDrawer(false);
  });

  // ---- regions + first panel
  const regions = [
    core.mountModule('setlist', left, {}),
    core.mountModule('song-header', head, {}),
    core.mountModule('bottom', bottom, {}),
  ];
  renderTabs();
  renderWire();
  showSelected();

  return {
    el: root,
    editState,
    destroy() {
      cur?.destroy();
      cur = null;
      for (const r of regions.splice(0)) r.destroy();
      frame.dispose();
      core.dispose();
      try {
        ctx.controller?.perform?.releaseAll?.();
      } catch {
        /* ignore */
      }
      el.replaceChildren();
      el.classList.remove('ev2-host');
      delete el.__rigCtx;
    },
    /** Test hooks. */
    _debug: {
      registry: registeredPanels,
      mounted: () => [...regions.map((r) => r.id), cur?.id].filter(Boolean),
      instance: (id) => [...regions, cur].find((r) => r && r.id === id)?.inst || null,
      /** the panel ctx a mounted module received (tests: ctx.toast / ctx.set as the panel sees them) */
      ctx: (id) => [...regions, cur].find((r) => r && r.id === id)?.pctx || null,
      components: C.__source,
      baseline: () => editState.baseline,
      changes: () => [...editState.changes],
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
/**
 * Mount ONE registered panel module on its own (test harness, previews). Block panels get a panel frame (sentence
 * title + body); region modules ('setlist', 'song-header', 'bottom') get their bare host. Selecting a block of the
 * same panel (editState.select('slot:2')) re-mounts / updates it.
 * @param {HTMLElement} el
 * @param {object} ctx       the app ctx (store, controller, engine, toast, …)
 * @param {string} id        registered panel id
 * @param {object} [opts]    mount options ({slot: 1}, {focus: 'wheels'}, …)
 * @returns {{el:HTMLElement, editState:EditState, instance:object|null, remount(opts?):void, destroy():void}}
 */
export function mountSinglePanel(el, ctx, id, opts = {}) {
  const def = registry.get(id);
  const region = def && def.region;
  const root = h('div.ev2.ev2-single', { dataset: { single: id } });
  const core = createCore(root, ctx);
  const { editState } = core;
  let frame = null;
  let host;
  if (region) {
    host = h(region === 'left' ? 'aside.ev2-left' : region === 'head' ? 'header.ev2-head' : 'footer.ev2-bottom');
    root.append(host);
  } else {
    frame = panelFrame(core);
    root.append(h('section.ev2-rig', {}, frame.panel));
    host = frame.body;
  }
  el.classList.add('ev2-host');
  el.replaceChildren(root);
  el.__rigCtx = ctx;
  const blockFor = (o) => (id === 'slot' ? `slot:${Number(o.slot) || 0}` : blockOf(id) ? id : null);
  let mounted = null;
  const mount = (o) => {
    mounted?.destroy();
    frame?.clearTitle();
    const b = blockFor(o);
    if (b) {
      editState.selected = b;
      editState.opts = { ...o };
      root.querySelector('.ev2-rig')?.style.setProperty('--c', blockOf(b).color);
    }
    mounted = core.mountModule(id, host, o, frame ? frame.setTitle : undefined);
  };
  core.listen(editState, 'select', (e) => {
    const b = blockOf(e.detail.id);
    if (!b || b.panel !== id) return;
    const o = { ...b.opts, ...e.detail.opts };
    // the block colour follows an update() too (slot:0 → slot:2 keeps the panel; hv2-edit-slot request)
    root.querySelector('.ev2-rig')?.style.setProperty('--c', b.color);
    if (!mounted || !mounted.update(o)) mount(o);
  });
  mount({ ...(blockFor(opts) ? blockOf(blockFor(opts)).opts : {}), ...opts });
  return {
    el: root,
    editState,
    get instance() {
      return mounted ? mounted.inst : null;
    },
    get ctx() {
      return mounted ? mounted.pctx : null;
    },
    remount(o = opts) {
      mount(o);
    },
    destroy() {
      mounted?.destroy();
      mounted = null;
      frame?.dispose();
      core.dispose();
      el.replaceChildren();
      el.classList.remove('ev2-host');
      delete el.__rigCtx;
    },
  };
}

