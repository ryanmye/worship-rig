// UI v6 Edit › the category-list frame for Drone, Effects and Master (U5b; native DECISIONS D18 "Drone, Effects and
// Master use the same category list"; mockup native/docs/design/mockups/edit.html "Effects · Space", "Drone",
// "Master · …", mock_edit.py nav_panel). The same shell as the instrument panel (views/v6/edit/instrument.js): the
// plain-English sentence with jump words over a category list (each row's state in words and a dot when it changed
// since the song began) and the chosen category in the middle. The class names are the instrument panel's, so
// styles-v6-edit.css lays both out alike; the instrument panel keeps its own copy (U5a, skeptic-verified).
//
// A panel module (drone.js / effects.js / master.js) gives the categories, what each one shows (build), its state in
// words (summary), its dot (changed) and the sentence. Controls are bound with lib.js createBinder through the panel
// ctx, so they write what today's panels write (ctx.set → store.set).
import { h, setText, getIn, createBinder, sentence } from '../../edit/lib.js';
import { describe } from '../../../shared/params.js';
import { sameValue } from '../../../shared/song-diff.js';

/** iPad portrait, where the category list is a row of tabs (styles-v6-edit.css; instrument.js PORTRAIT_MQ). */
const PORTRAIT_MQ = '(orientation: portrait) and (max-width: 1024px)';
const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), textarea, button:not([disabled]), [tabindex]';
let mountSeq = 0;

/**
 * Song-relative path → the §4 address whose PARAMS row gives its default ('patch.fx.reverb.size' →
 * 'fx.reverb.size', 'patch.fx.master.volume' → 'master.volume', 'drone.fade' as is).
 * @param {string} rel
 * @returns {string}
 */
export function addrOfRel(rel) {
  if (rel === 'patch.fx.master.volume') return 'master.volume';
  return rel.startsWith('patch.') ? rel.slice(6) : rel;
}

/**
 * A song value with its PARAMS default when absent (optional fields stay absent until set, CLAUDE.md "Store schema":
 * an absent slot width and one set back to its default are the same sound, so neither dots).
 * @param {object} song
 * @param {string} rel  song-relative path
 * @returns {*}
 */
export function relValue(song, rel) {
  const v = getIn(song, rel);
  if (v !== undefined) return v;
  const d = describe(addrOfRel(rel));
  return d && !d.dynamic ? d.default : undefined;
}

/**
 * "Changed since the song began" (U5b, orchestrator: every category dot compares all of its paths with the Revert
 * snapshot, ctx.getBaseline): true when any of `rels` differs between the song and its baseline (song-diff
 * sameValue: numeric tolerance, absent = undefined; leaves fall back to their PARAMS default).
 * @param {object|null} song
 * @param {object|null} base
 * @param {string[]} rels  song-relative paths
 * @returns {boolean}
 */
export function relsDiffer(song, base, rels) {
  if (!song || !base) return false;
  return rels.some((r) => !sameWithDefaults(getIn(song, r), getIn(base, r), addrOfRel(r)));
}

const plainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** A leaf's PARAMS default when it is absent (a container, a dynamic or an unknown address: as it is). */
function orDefault(v, addr) {
  if (v !== undefined) return v;
  const d = describe(addr);
  return d && !d.dynamic ? d.default : undefined;
}
/**
 * song-diff sameValue, key by key with each absent leaf at its PARAMS default (skeptic UI6-U5b F3): an optional
 * object the song began without (fx.eq, fx.comp, a slot's touch) and the same object set back to its defaults
 * ({low: 0}) are the same sound, so neither dots. Before, the whole object was compared with `undefined` and the dot
 * stayed after a double-click reset.
 * @param {*} a
 * @param {*} b
 * @param {string} addr  the §4 address of a / b ('fx.eq', 'slots.0.touch', 'fx.reverb.size')
 * @returns {boolean}
 */
export function sameWithDefaults(a, b, addr) {
  const x = orDefault(a, addr);
  const y = orDefault(b, addr);
  if ((plainObj(x) || x === undefined) && (plainObj(y) || y === undefined) && (plainObj(x) || plainObj(y))) {
    const keys = new Set([...Object.keys(x || {}), ...Object.keys(y || {})]);
    for (const k of keys) if (!sameWithDefaults(x?.[k], y?.[k], `${addr}.${k}`)) return false;
    return true;
  }
  return sameValue(x, y);
}

/**
 * Mount a category-list panel.
 * @param {HTMLElement} host
 * @param {object} ctx  the panel ctx (views/edit/CONTRACT.md §3)
 * @param {object} o
 * @param {string} o.kind                 'drone' | 'effects' | 'master' (test ids `v6e-<kind>-…`)
 * @param {string} o.color                the panel's colour (--c)
 * @param {Array<{id:string, label:string, blurb:string}>} o.cats
 * @param {string} [o.initial]            the remembered category (unknown → the first)
 * @param {(id:string) => void} [o.remember]  a category the player chose (per device; not a focus jump)
 * @param {(id:string, pane:object) => HTMLElement} o.build  the chosen category's content; pane = {binder, offs,
 *                                         ctl} (offs run when the pane is rebuilt or the panel unmounts)
 * @param {(id:string, song:object) => string} o.summary  the row's state in words
 * @param {() => Set<string>} o.changes  the categories whose row has a dot
 * @param {(song:object) => Array<string|object>} o.sentence  lib.js sentence parts; a word {text, cat, focus?, run?}
 *                                         jumps to its category (and the `focus` selector in it) or runs `run`
 * @param {(id:string, song:object) => string} [o.key]  the pane is rebuilt when this changes (e.g. the slot list)
 * @param {HTMLElement[]} [o.actions]     the head's right side (Effects' Vibe menu)
 * @param {HTMLElement} [o.navFoot]       under the category list (a link to another panel)
 * @param {() => void} [o.onRender]       after every redraw (store / baseline change while Edit shows)
 * @returns {{el:HTMLElement, choose(id:string, o?:object):void, cat():string, pane():object|null, focusIn(el):void,
 *            render():void, destroy():void}}
 */
export function catPanel(host, ctx, o) {
  const uid = `v6e-${o.kind}-${(mountSeq += 1)}`;
  const ids = o.cats.map((c) => c.id);
  const bar = h('span.v6e-ibar', { 'aria-hidden': 'true' });
  const sentHost = h('div.v6e-sent', { 'data-testid': `v6e-${o.kind}-sentence` });
  const head = h('div.v6e-ihead', {}, bar, sentHost, ...(o.actions || []));
  const contId = `${uid}-pane`;
  const portraitMq = typeof matchMedia === 'function' ? matchMedia(PORTRAIT_MQ) : null;
  const nav = h('nav.v6e-cnav', {
    role: 'tablist', 'aria-label': 'What to edit', 'aria-orientation': 'vertical', 'data-testid': `v6e-${o.kind}-cnav`,
  });
  const navRecs = new Map();
  for (const c of o.cats) {
    const dot = h('span.v6e-cd', { title: 'Changed since the song began', hidden: true });
    const sum = h('small.v6e-cn-sum');
    const b = h('button.v6e-cn', {
      type: 'button', role: 'tab', id: `${uid}-cat-${c.id}`, 'aria-controls': contId, 'aria-selected': 'false',
      tabindex: '-1', dataset: { cat: c.id }, 'data-testid': `v6e-${o.kind}-cat-${c.id}`,
    }, h('b', {}, h('span', { text: c.label }), dot), sum);
    b.addEventListener('click', () => choose(c.id, { persist: true }));
    nav.append(b);
    navRecs.set(c.id, { el: b, dot, sum });
  }
  const navCol = o.navFoot ? h('div.v6e-navcol', {}, nav, o.navFoot) : nav;
  const paneTitle = h('h4.v6e-h4');
  const paneHost = h('div.v6e-pane');
  const cont = h('section.v6e-ccont', { role: 'tabpanel', id: contId, 'data-testid': `v6e-${o.kind}-ccont` },
    paneTitle, paneHost);
  const cols = h('div.v6e-ncols.noright', {}, navCol, cont);
  const root = h('div.v6e-inst.v6e-shared', { 'data-testid': `v6e-${o.kind}`, dataset: { kind: o.kind },
    style: { '--c': o.color } }, head, cols);
  host.replaceChildren(root);

  const navIsRow = () => !!portraitMq?.matches;
  nav.addEventListener('keydown', (e) => {
    const k = ids.indexOf(e.target?.dataset?.cat);
    if (k < 0) return;
    const row = navIsRow();
    let n = -1;
    if (e.key === (row ? 'ArrowRight' : 'ArrowDown')) n = (k + 1) % ids.length;
    else if (e.key === (row ? 'ArrowLeft' : 'ArrowUp')) n = (k - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = ids.length - 1;
    if (n < 0) return;
    e.preventDefault();
    e.stopPropagation(); // ←/→ are Prev / Next song and ↑/↓ the mod wheel elsewhere
    choose(ids[n], { persist: true });
    navRecs.get(ids[n]).el.focus();
  });

  let cat = ids.includes(o.initial) ? o.initial : ids[0];
  let pane = null;
  let paneKey = '';
  const keyOf = () => `${cat}|${o.key ? o.key(cat, ctx.song()) : ''}`;
  function destroyPane() {
    if (!pane) return;
    for (const fn of pane.offs.splice(0).reverse()) {
      try {
        fn();
      } catch (err) {
        console.warn(`[v6 edit] ${o.kind} pane cleanup failed`, err);
      }
    }
    try {
      pane.binder.destroy();
    } catch (err) {
      console.warn(`[v6 edit] ${o.kind} pane binder destroy failed`, err);
    }
    pane = null;
  }
  function buildPane() {
    destroyPane();
    pane = { binder: createBinder(ctx), offs: [], ctl: {}, cat };
    paneKey = keyOf();
    const c = o.cats.find((x) => x.id === cat);
    paneTitle.replaceChildren(c.label, c.blurb ? h('small', { text: c.blurb }) : '');
    cont.dataset.cat = cat;
    cont.setAttribute('aria-labelledby', navRecs.get(cat).el.id);
    let body;
    try {
      body = o.build(cat, pane);
    } catch (err) {
      console.warn(`[v6 edit] ${o.kind} › ${cat} failed to build`, err);
      body = h('p.v6e-hint', { text: 'This part failed to load.' });
    }
    paneHost.replaceChildren(body);
    paneHost.dataset.cat = cat;
  }
  function choose(id, { persist = false } = {}) {
    if (!ids.includes(id)) return;
    if (persist) o.remember?.(id);
    if (id === cat && pane) return;
    cat = id;
    buildPane();
    renderNav();
    revealCat();
  }

  let sentKey = '';
  function renderSentence() {
    const s = ctx.song();
    const parts = s ? o.sentence(s) : [];
    const key = JSON.stringify(parts);
    if (key === sentKey) return;
    sentKey = key;
    sentHost.replaceChildren(sentence(parts.map((p) => (p && typeof p === 'object' && (p.cat || p.run)
      ? { ...p, control: () => null } : p)), { onToken }));
  }
  function onToken(part) {
    if (part.run) {
      part.run();
      return;
    }
    choose(part.cat);
    const t = part.focus ? paneHost.querySelector(part.focus) : paneHost.firstElementChild;
    focusIn(t);
  }
  let flashTimer = 0;
  function focusIn(el) {
    if (!(el instanceof Element)) return;
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    const f = el.matches(FOCUSABLE) ? el : el.querySelector(FOCUSABLE);
    f?.focus({ preventScroll: true });
    for (const x of root.querySelectorAll('.v6e-flash')) x.classList.remove('v6e-flash');
    el.classList.add('v6e-flash');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove('v6e-flash'), 900);
  }
  function renderNav() {
    const s = ctx.song();
    const dots = s ? o.changes() : new Set();
    for (const c of o.cats) {
      const r = navRecs.get(c.id);
      const sel = c.id === cat;
      r.el.setAttribute('aria-selected', String(sel));
      r.el.classList.toggle('on', sel);
      r.el.tabIndex = sel ? 0 : -1;
      setText(r.sum, s ? o.summary(c.id, s) : '');
      r.dot.hidden = !dots.has(c.id);
    }
    const orient = navIsRow() ? 'horizontal' : 'vertical';
    if (nav.getAttribute('aria-orientation') !== orient) nav.setAttribute('aria-orientation', orient);
  }
  /** The chosen row stays in sight (skeptic UI6-U5a F2, as the instrument panel): scrolls the list only. */
  function revealCat() {
    const el = navRecs.get(cat)?.el;
    if (!el || !nav.clientHeight || navIsRow()) return;
    const top = el.getBoundingClientRect().top - nav.getBoundingClientRect().top + nav.scrollTop;
    if (top < nav.scrollTop) nav.scrollTop = top;
    else if (top + el.offsetHeight > nav.scrollTop + nav.clientHeight) {
      nav.scrollTop = top + el.offsetHeight - nav.clientHeight;
    }
  }
  function render() {
    if (keyOf() !== paneKey) buildPane();
    renderSentence();
    renderNav();
    o.onRender?.();
  }

  // As the instrument panel: while Perform shows nothing is drawn; the first event with the view back on Edit (the
  // 'settings.view' write itself) redraws it all. Registered before the pane's binder, so a rebuild comes first.
  const editShown = () => ctx.store.get()?.settings?.view === 'edit';
  let stale = false;
  ctx.subscribe(() => {
    if (!editShown()) {
      stale = true;
      return;
    }
    if (stale) {
      stale = false;
      sentKey = '';
      queueMicrotask(revealCat);
    }
    render();
  });
  ctx.listen(ctx.editState, 'changes', () => {
    if (!editShown()) {
      stale = true;
      return;
    }
    renderSentence();
    renderNav();
  });
  // a new baseline (the Revert snapshot): the dots, and the pane's baseline reads ("Song's own")
  ctx.listen(ctx.controller, 'songSelected', () => {
    pane?.binder.refresh(null);
    if (editShown()) renderNav();
  });

  buildPane();
  renderSentence();
  renderNav();
  queueMicrotask(revealCat);

  return {
    el: root,
    choose,
    cat: () => cat,
    pane: () => pane,
    focusIn,
    render,
    destroy() {
      clearTimeout(flashTimer);
      destroyPane();
      root.remove();
    },
  };
}

/**
 * One row of a per-instrument table (Effects › Sends / Chorus): the instrument's colour and name, then its controls.
 * @param {{color:string, name:string, empty?:boolean, testid?:string}} r
 * @param {...HTMLElement} cells
 * @returns {HTMLElement}
 */
export function instrumentRow(r, ...cells) {
  return h('div.v6e-sendrow', { style: { '--c': r.color }, class: r.empty ? 'empty' : '', 'data-testid': r.testid },
    h('span.v6e-sname', { title: r.name }, h('i', { 'aria-hidden': 'true' }), h('span', { text: r.name })),
    ...cells);
}
