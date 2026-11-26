// UI v6 Settings (U6; native DECISIONS D21 "easy to navigate and use"; mockup native/docs/design/mockups/settings.html,
// mock_settings.py / mock_settings.css). Loaded by views/settings.js only while settings.uiV6 is on, and applied to
// today's Settings dialog in place: the same nodes, the same controls and the same writes (D15 "one module"), restyled
// under .v6-st (styles-v6-settings.css) with these additions:
//   - each category's current state under its name, live (settings-summary.js);
//   - a search box: filters categories and rows by their label and hint, Enter jumps to the next match, Esc clears;
//   - two categories: MIDI Learn (today's MIDI Learn section moves here, under a list of the learned controls with
//     Forget and the D20 rule) and Perform layout (the right sidebar's customize list, the same builder and storage as
//     its ⋯ popover, and the snapshots row's fold);
//   - Sounds & Samples starts with "Open Song bank…" (today's list, U7 builds the browser); Look's theme cards get a
//     preview of each theme;
//   - a narrow dialog (iPad portrait) drills in: the category list, then one category with a back button.
// Everything done here is journalled and undone by destroy() (the flag turned off, live too), which leaves today's
// Settings exactly as it was. The .v6-st scope (not .v6): styles-v6.css's `.v6` rule lays out the v6 Perform's root.
import { h, setText, disposer, rafCoalesce } from '../components/util.js';
import { byId as themeById, resolveThemeId, lightSiblings, LIGHT_AUTO_KEY } from '../../shared/themes.js';
import { customizeList, sidebarLayout } from './sidebar/sidebar.js';
import { snapsFolded, setSnapsFolded } from './snapshots.js';
import {
  soundSummary, keyboardsSummary, learnSummary, samplesSummary, layoutSummary, lookSummary, librarySummary, macSummary,
  aboutSummary,
} from './settings-summary.js';

/** The stylesheet, resolved from this module (the app's index and the settings test fixture sit in other folders). */
export const V6_SETTINGS_CSS_HREF = new URL('../../../styles-v6-settings.css', import.meta.url).href;
/** The v6 category order (mockup CATS). `added`: categories only the v6 Settings has. `mac`: the Mac app only. */
export const V6_CATEGORIES = Object.freeze([
  { id: 'sound', label: 'Sound' },
  { id: 'keyboards', label: 'Keyboards & MIDI' },
  { id: 'midilearn', label: 'MIDI Learn', added: true },
  { id: 'samples', label: 'Sounds & Samples' },
  { id: 'layout', label: 'Perform layout', added: true },
  { id: 'look', label: 'Look' },
  { id: 'library', label: 'Library & Backup' },
  { id: 'mac', label: 'Mac', mac: true },
  { id: 'about', label: 'About' },
]);
/** Where a v6-only category falls back to when the v6 Settings goes away while it is on show. */
const FALLBACK = { midilearn: 'keyboards', layout: 'look' };
/** Dialog width (px) at or below which the categories drill in (styles-settings.css turns the list into a strip). */
export const DRILL_WIDTH = 780;
/** The D20 rule, spelled out in MIDI Learn. */
export const LEARN_RULE = 'A learned knob or fader changes the song just as moving it on screen does: the change is '
  + 'marked, and Revert puts the song back. Buttons and pads run their action (Next song, Panic …). The sustain pedal '
  + 'always sustains.';

/** Search text: lower case, no accents. */
export const fold = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Does every word of `query` start a word of `text` ("ped" finds "Sustain pedal"; "ember" finds Ember, not
 * "remember")?
 * @param {string} text  already folded
 * @param {string} query
 * @returns {boolean}
 */
export function matches(text, query) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => new RegExp(`(^|[^a-z0-9])${esc(w)}`).test(text));
}

/**
 * Link styles-v6-settings.css (once) and wait for it, so the v6 Settings never paints unstyled.
 * @returns {Promise<boolean>}
 */
export function loadSettingsCss() {
  let link = document.querySelector('link[data-v6-settings-css]');
  if (link && link.sheet) return Promise.resolve(true);
  if (!link) {
    link = h('link', { rel: 'stylesheet', href: V6_SETTINGS_CSS_HREF, 'data-v6-settings-css': '' });
    document.head.append(link);
  }
  return new Promise((res) => {
    link.addEventListener('load', () => res(true), { once: true });
    link.addEventListener('error', () => res(false), { once: true });
  });
}
/** Remove the stylesheet (the flag went off before the v6 Settings was applied). */
export function unloadSettingsCss() {
  document.querySelector('link[data-v6-settings-css]')?.remove();
}

/**
 * Apply the v6 Settings to today's mounted Settings (views/settings.js passes its internals).
 * @param {object} api  views/settings.js `v6Api`: el, dialog, nav, body, closeBtn, tabs, panels, advs, cats, C, store,
 *   controller, midi, engine, rig, isElectron, ctx, toast, showCategory, revealSection, resolveSection, isOpen(),
 *   current(), nodes {learnSection, perfSection, appearance, themeCards, themeGrid, lightRow, bankBox, outputSelect},
 *   renderPacks, learnName, mappingText, velLabel, latencyLabel, about(), manualBackupAt()
 * @returns {{destroy():void, shown(cat:string, o:object):void, opened(linked:boolean):void, refresh():void,
 *   search(q:string):number, readonly query:string, readonly hits:{cat:string, el:Element}[],
 *   readonly drill:string|null,
 *   back():void, summaries():Record<string,string>}}
 */
export function enhanceSettings(api) {
  const d = disposer(); // the undo journal: dispose() runs it backwards
  try {
    return enhance(api, d);
  } catch (err) {
    d.dispose(); // a half-applied v6 Settings is put back: today's Settings stays whole
    throw err;
  }
}

function enhance(api, d) {
  const { dialog, nav, body, tabs, panels, store, controller, midi, nodes } = api;
  const isElectron = !!api.isElectron;
  const S = () => store.get().settings;

  // ---------------------------------------------------------------- journalled DOM changes
  const addClass = (e, ...cls) => {
    const added = cls.filter((c) => !e.classList.contains(c));
    e.classList.add(...added);
    d.add(() => e.classList.remove(...added));
  };
  const insert = (node, parent, before = null) => {
    parent.insertBefore(node, before);
    d.add(() => node.remove());
    return node;
  };
  const move = (node, parent, before = null) => {
    const from = node.parentNode;
    const next = node.nextSibling;
    parent.insertBefore(node, before);
    d.add(() => {
      if (from) from.insertBefore(node, next && next.parentNode === from ? next : null);
    });
  };
  const listen = (t, type, fn, o) => d.listen(t, type, fn, o);

  // the stylesheet (loadSettingsCss linked it before this ran) goes with the v6 Settings
  d.add(unloadSettingsCss);
  addClass(dialog, 'v6-st');
  dialog.dataset.testid = 'settings-dialog';
  d.add(() => delete dialog.dataset.testid);

  // ---------------------------------------------------------------- header: back (drill-in), search
  const head = dialog.querySelector('.st-head');
  const title = head.querySelector('.st-title');
  const back = h('button.ed-btn.v6-st-back', { type: 'button', 'data-testid': 'settings-back', hidden: true,
    'aria-label': 'Back to the categories' }, '‹ Settings');
  insert(back, head, title);
  const crumb = h('b.v6-st-crumb', { hidden: true, 'aria-hidden': 'true', 'data-testid': 'settings-crumb' });
  insert(crumb, head, title);
  const input = h('input.v6-st-q', { type: 'search', placeholder: 'Search settings', 'aria-label': 'Search settings',
    'data-testid': 'settings-search', autocomplete: 'off', spellcheck: 'false' });
  const count = h('span.v6-st-count', { 'aria-live': 'polite', 'data-testid': 'settings-search-count' });
  const search = h('div.v6-st-search', { role: 'search' }, h('span.v6-st-mag', { 'aria-hidden': 'true', text: '⌕' }),
    input, count);
  insert(search, head, api.closeBtn);

  // ---------------------------------------------------------------- categories: two new ones, the v6 order
  const uid = (tabs.get('sound')?.id || 'st-tab-sound-x').replace(/^st-tab-sound-/, '');
  const order0 = { tabs: [...tabs], panels: [...panels] };
  const v6cats = V6_CATEGORIES.filter((c) => !c.mac || tabs.has(c.id));
  for (const c of v6cats.filter((x) => x.added)) {
    const tab = h('button.st-tab', {
      type: 'button', role: 'tab', id: `st-tab-${c.id}-${uid}`, 'aria-selected': 'false',
      'aria-controls': `st-panel-${c.id}-${uid}`, tabindex: -1, 'data-cat': c.id, 'data-testid': `settings-tab-${c.id}`,
    }, c.label);
    listen(tab, 'click', () => api.showCategory(c.id, { remember: true }));
    const panel = h('div.st-panel', { role: 'tabpanel', id: `st-panel-${c.id}-${uid}`, 'aria-labelledby': tab.id,
      'data-cat': c.id, 'data-testid': `settings-panel-${c.id}`, hidden: true });
    tabs.set(c.id, tab);
    panels.set(c.id, panel);
    d.add(() => {
      tabs.delete(c.id);
      panels.delete(c.id);
    });
  }
  // nav and body in the v6 order, the maps too (the arrow keys follow the maps' order)
  const ids = v6cats.map((c) => c.id);
  for (const id of ids) {
    if (v6cats.find((c) => c.id === id).added) {
      insert(tabs.get(id), nav, null);
      insert(panels.get(id), body, null);
    } else {
      move(tabs.get(id), nav, null);
      move(panels.get(id), body, null);
    }
  }
  const reorder = (map, entries) => {
    map.clear();
    for (const [k, v] of entries) map.set(k, v);
  };
  reorder(tabs, ids.map((id) => [id, tabs.get(id)]));
  reorder(panels, ids.map((id) => [id, panels.get(id)]));
  d.add(() => {
    reorder(tabs, order0.tabs);
    reorder(panels, order0.panels);
  });
  // the summaries under each name
  const sums = new Map();
  for (const id of ids) {
    const s = h('span.v6-st-sum', { 'data-testid': `settings-sum-${id}` });
    const n = h('span.v6-st-n', { hidden: true, 'aria-hidden': 'true' });
    insert(s, tabs.get(id));
    insert(n, tabs.get(id));
    sums.set(id, { s, n });
  }

  // a plain row in today's markup, so it looks and searches like the others
  const row = (label, control, hint) => h('div.st-row', {}, h('div.st-label', {}, h('span', { text: label }),
    hint ? h('span.st-hint', { text: hint }) : null), h('div.st-control', {}, control));
  const button = (text, on, attrs = {}) => {
    const b = h('button.ed-btn', { type: 'button', ...attrs }, text);
    listen(b, 'click', on);
    return b;
  };

  // ---------------------------------------------------------------- MIDI Learn
  const learnPanel = panels.get('midilearn');
  const lrnList = h('div.v6-st-lrn-list', { role: 'list', 'aria-label': 'Learned controls',
    'data-testid': 'settings-learned' });
  const learnFirst = button('Learn…', () => {
    const b = nodes.learnSection.querySelector('.st-learn:not(:disabled)');
    nodes.learnSection.scrollIntoView({ block: 'start' });
    b?.focus({ preventScroll: true });
  }, { class: 'v6-st-learnbtn', 'data-testid': 'settings-learn-new' });
  const learned = h('section.st-section.v6-st-learned', { 'aria-label': 'Learned controls',
    'data-section': 'learned' },
  h('h2.st-h2', { text: 'Learned controls' }),
  h('p.st-hint.v6-st-rule', { 'data-testid': 'settings-learn-rule', text: LEARN_RULE }),
  lrnList,
  h('div.v6-st-learnbox', {},
    h('b', { text: 'Learn a new control' }),
    h('small', { text: 'Press Learn beside what it should move (the list below), then move a knob, fader or pedal, '
      + 'or press a key or pad. Any slider in Edit: right-click it.' }),
    learnFirst));
  insert(learned, learnPanel);
  move(nodes.learnSection, learnPanel, null);
  const learnRowOf = (id) => [...nodes.learnSection.querySelectorAll('tr[data-control]')]
    .find((tr) => tr.dataset.control === id) || null;
  function renderLearned(ml = S().midiLearn || {}) {
    const ids2 = Object.keys(ml).filter((k) => ml[k]);
    const rows = ids2.map((id) => {
      const clear = learnRowOf(id)?.querySelector('.st-clear');
      const name = api.learnName(id);
      // Forget = that row's own Clear / Remove (one code path)
      const forget = clear ? button('Forget', () => clear.click(), { class: 'v6-st-forget',
        'aria-label': `Forget ${name}`, 'data-control': id }) : null;
      return h('div.v6-st-lrn', { role: 'listitem', 'data-control': id },
        h('span.v6-st-ctl', { text: api.mappingText(ml[id]) }),
        h('span.v6-st-arr', { 'aria-hidden': 'true', text: '→' }),
        h('b', { text: name }), forget);
    });
    if (!rows.length) rows.push(h('p.st-hint.v6-st-none', { text: 'Nothing learned yet.' }));
    lrnList.replaceChildren(...rows);
  }
  renderLearned();

  // ---------------------------------------------------------------- Perform layout
  const layoutPanel = panels.get('layout');
  const sb = sidebarLayout();
  const czBox = h('div.v6-st-cz', { 'data-testid': 'settings-sidebar-modules' });
  const czD = disposer();
  d.add(() => czD.dispose());
  const renderCz = customizeList(czBox, czD, { mods: sb.mods, prefs: sb.prefs, heading: false,
    commit: (next) => {
      sb.commit(next);
      refresh();
    } });
  const snapSeg = api.C.segmented({
    label: 'Snapshots row',
    options: [{ value: 'shown', label: 'Shown' }, { value: 'folded', label: 'Folded' }],
    onChange: (v) => {
      setSnapsFolded(v === 'folded');
      refresh();
    },
  });
  snapSeg.el.dataset.testid = 'setting-snapshots-row';
  d.add(() => snapSeg.destroy?.());
  insert(h('section.st-section', { 'aria-label': 'Right sidebar', 'data-section': 'sidebar' },
    h('h2.st-h2', {}, 'Right sidebar', h('small.v6-st-h2note', { text: 'the same as ⋯ on the sidebar' })),
    czBox), layoutPanel);
  insert(h('section.st-section', { 'aria-label': 'Perform', 'data-section': 'perform-layout' },
    h('h2.st-h2', { text: 'Perform' }),
    row('Snapshots row', snapSeg.el, 'Folded: one Snapshot chip in the song bar instead.')), layoutPanel);
  const renderLayout = () => {
    renderCz();
    snapSeg.set(snapsFolded() ? 'folded' : 'shown');
  };
  renderLayout();

  // ---------------------------------------------------------------- Sounds & Samples: the Song bank entry
  const bankBtn = button('Open Song bank…', () => api.revealSection('bank'), { class: 'v6-st-bankbtn',
    'data-testid': 'settings-open-bank' });
  const bankLine = h('span.st-hint.v6-st-banknote', { 'data-testid': 'settings-bank-note' });
  insert(h('section.st-section.v6-st-bank', { 'aria-label': 'Song bank', 'data-section': 'songbank' },
    h('h2.st-h2', { text: 'Song bank' }),
    h('div.st-inline', {}, bankBtn, bankLine)),
  panels.get('samples'), panels.get('samples').firstChild);
  const packsOf = () => {
    try {
      return typeof controller.patchPacks === 'function' ? controller.patchPacks() : null;
    } catch {
      return null;
    }
  };
  function renderBankEntry() {
    const p = packsOf();
    const n = p && p.enabled ? p.bankSongs || 0 : 0;
    bankBtn.disabled = !n || nodes.bankBox.hidden;
    setText(bankLine, n ? `${n} ready-made song${n === 1 ? '' : 's'} from your packs`
      : 'None yet: a patch pack set to “bank” in My Samples adds them.');
  }
  renderBankEntry();

  // ---------------------------------------------------------------- Look: a preview on each theme card
  for (const card of nodes.themeCards) {
    const t = themeById(card.dataset.themeId);
    if (!t) continue;
    const pv = h('span.v6-tprev', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('em', { text: 'Aa' }));
    for (const [k, v] of Object.entries({ '--tb': t.swatch.bg, '--tp': t.swatch.panel, '--tt': t.swatch.text,
      '--ta': t.swatch.accent })) pv.style.setProperty(k, v);
    insert(pv, card, card.firstChild);
  }

  // ---------------------------------------------------------------- summaries (live, coalesced to a frame)
  function outputLabel() {
    const sel = nodes.outputSelect;
    const o = sel && sel.selectedOptions && sel.selectedOptions[0];
    return o ? o.textContent : 'System default';
  }
  const lightOf = (s) => {
    if (!lightSiblings(s.theme)) return null;
    let auto = false;
    try {
      auto = localStorage.getItem(LIGHT_AUTO_KEY) === 'auto';
    } catch {
      auto = false;
    }
    return auto ? 'auto' : themeById(resolveThemeId(s.theme))?.mode === 'light' ? 'day' : 'stage';
  };
  const sampleCount = () => {
    try {
      const l = api.engine && typeof api.engine.listInstruments === 'function' ? api.engine.listInstruments() : [];
      return (Array.isArray(l) ? l : []).filter((x) => x && (x.group === 'My Samples'
        || String(x.ref && x.ref.id).startsWith('user:'))).length;
    } catch {
      return 0;
    }
  };
  /** @returns {Record<string, string>} category id → its one-line state */
  function summaries() {
    const state = store.get();
    const s = state.settings;
    const st = controller.status || {};
    const t = themeById(resolveThemeId(s.theme));
    const lastAt = Math.max(Number(controller.lastBackupAt?.()) || 0, Number(api.manualBackupAt()) || 0);
    return {
      sound: soundSummary({ output: outputLabel(), latencyMs: st.latencyMs,
        latencyLabel: api.latencyLabel(s.latency) }),
      keyboards: keyboardsSummary({ midi: st.midi, touch: api.velLabel(s.velocitySens),
        computerKeys: s.computerKeyboard !== false }),
      midilearn: learnSummary(s.midiLearn),
      samples: samplesSummary({ packs: packsOf(), samples: sampleCount(), padFolder: !!s.padFolder }),
      layout: layoutSummary({ sidebarOpen: sb.prefs().open, snapsFolded: snapsFolded() }),
      look: lookSummary({ name: t?.name, mode: t?.mode, light: lightOf(s) }),
      library: librarySummary({ electron: isElectron, lastBackupAt: lastAt || null,
        songs: (state.songOrder || []).length }),
      mac: macSummary({ menuBarMode: !!s.menuBarMode, updateCheck: s.updateCheck }),
      about: aboutSummary({ version: api.about()?.version || null, electron: isElectron }),
    };
  }
  function renderSums() {
    const all = summaries();
    for (const [id, { s }] of sums) setText(s, all[id] || '');
  }
  const sumsLater = rafCoalesce(() => renderSums());
  d.add(() => sumsLater.cancel());
  function refresh() {
    renderSums();
    renderBankEntry();
  }
  d.add(store.subscribe((state, paths) => {
    if (paths.some((p) => p === 'settings' || p.startsWith('settings.midiLearn'))) {
      renderLearned(state.settings.midiLearn);
    }
    if (api.isOpen()) sumsLater.push();
  }));
  if (typeof controller.onStatus === 'function') d.add(controller.onStatus(() => api.isOpen() && sumsLater.push()));
  listen(midi, 'devices', () => api.isOpen() && sumsLater.push());
  listen(controller, 'user-patches', () => api.isOpen() && (renderBankEntry(), sumsLater.push()));
  listen(document, 'rig-theme-light', () => api.isOpen() && sumsLater.push());
  // the output list fills in asynchronously (enumerateDevices) and the About info arrives after open
  listen(nodes.outputSelect, 'change', () => sumsLater.push());
  renderSums();

  // ---------------------------------------------------------------- search
  let query = '';
  let hits = [];
  let at = -1;
  const opened = new Set(); // <details> the search opened (closed again when it clears)
  const UNIT = '.st-row, tr[data-control], .v6-cz, .v6-st-lrn, .st-pedal, .st-kbs, .st-about';
  const HEAD = 'h2, summary, thead, .st-learn-group';
  const unitsOf = (panel) => {
    const list = [...panel.querySelectorAll(UNIT)].filter((u) => !u.parentElement.closest(UNIT));
    // a section without rows (About, Diagnostics, the GarageBand how-to) is searched as a whole
    for (const sec of panel.querySelectorAll('.st-section, details')) {
      if (!list.some((u) => sec.contains(u)) && !sec.parentElement.closest('.st-section, details')) list.push(sec);
    }
    return list;
  };
  /** Text of an element with its pieces apart ("Aa" "Ember" "dark", not "AaEmberdark"). */
  const words = (e) => {
    if (!e) return '';
    const out = [];
    const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n.data);
    return out.join(' ');
  };
  const textOf = (u, panel, cat) => {
    // a row: its label and hint, and its control's own words (theme names, Day / Stage / Auto, Balanced …)
    const lab = u.matches('.st-row') ? `${words(u.querySelector('.st-label'))} ${words(u.querySelector('.st-control'))}`
      : words(u);
    const sec = u.closest('.st-section, details');
    const secHead = sec && sec !== u ? words(sec.querySelector(HEAD)) || sec.getAttribute('aria-label') : '';
    return fold(`${lab || ''} ${secHead || ''} ${cat.label}`);
  };
  function clearMarks() {
    for (const e of dialog.querySelectorAll('.v6-st-miss, .v6-st-hit, .v6-st-cur, .v6-st-nohit')) {
      e.classList.remove('v6-st-miss', 'v6-st-hit', 'v6-st-cur', 'v6-st-nohit');
    }
    for (const { n } of sums.values()) n.hidden = true;
    for (const det of opened) det.open = false;
    opened.clear();
  }
  /** Hide what does not lead to a hit: walk down from the panel, keeping headings of kept sections. */
  function filterPanel(panel, hitSet) {
    const keep = new Set();
    for (const u of hitSet) {
      for (let e = u; e && e !== panel; e = e.parentElement) keep.add(e);
    }
    const walk = (parent) => {
      for (const c of parent.children) {
        if (hitSet.has(c)) continue;
        if (keep.has(c)) walk(c);
        else if (!c.matches(HEAD)) c.classList.add('v6-st-miss');
      }
    };
    walk(panel);
  }
  function runSearch(q) {
    clearMarks();
    query = q;
    hits = [];
    at = -1;
    const html = document.documentElement;
    if (q) html.setAttribute('data-settings-search', '');
    else html.removeAttribute('data-settings-search');
    dialog.classList.toggle('v6-st-searching', !!q);
    if (!q.trim()) {
      setText(count, '');
      return 0;
    }
    const found = v6cats.map((c) => {
      const panel = panels.get(c.id);
      return { c, panel, set: new Set(unitsOf(panel).filter((u) => matches(textOf(u, panel, c), q))) };
    });
    const any = found.some((f) => f.set.size);
    for (const { c, panel, set } of found) {
      const { n } = sums.get(c.id);
      if (!set.size) {
        if (any) tabs.get(c.id).classList.add('v6-st-nohit'); // no match anywhere: the list stays whole
        continue;
      }
      setText(n, String(set.size));
      n.hidden = false;
      // reading order inside the panel
      const inOrder = [...set].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
        ? -1 : 1));
      for (const u of inOrder) {
        u.classList.add('v6-st-hit');
        for (let det = u.closest('details'); det; det = det.parentElement?.closest('details')) {
          if (!det.open) {
            det.open = true;
            opened.add(det);
          }
        }
        hits.push({ cat: c.id, el: u });
      }
      filterPanel(panel, set);
    }
    setText(count, hits.length ? `${hits.length} found` : 'No match');
    if (hits.length) {
      const cur = api.current();
      const first = hits.findIndex((x) => x.cat === cur);
      jump(first >= 0 ? first : 0);
    }
    return hits.length;
  }
  function jump(i) {
    if (!hits.length) return;
    at = (i + hits.length) % hits.length;
    for (const e of dialog.querySelectorAll('.v6-st-cur')) e.classList.remove('v6-st-cur');
    const x = hits[at];
    api.showCategory(x.cat);
    setDrill('detail');
    x.el.classList.add('v6-st-cur');
    x.el.scrollIntoView({ block: 'nearest' });
    setText(count, `${at + 1} of ${hits.length}`);
  }
  listen(input, 'input', () => runSearch(input.value));
  listen(input, 'keydown', (e) => {
    if (e.key === 'Enter' && hits.length) {
      e.preventDefault();
      jump(at + (e.shiftKey ? -1 : 1));
    }
  });
  // Esc clears the search first (main.js and settings.js stand down while data-settings-search is set)
  listen(window, 'keydown', (e) => {
    const html = document.documentElement;
    if (!api.isOpen() || e.key !== 'Escape' || !query || html.hasAttribute('data-hotkey-capture')
      || html.hasAttribute('data-gb-import')) return;
    e.preventDefault();
    e.stopPropagation();
    input.value = '';
    runSearch('');
    input.focus({ preventScroll: true });
  }, true);
  d.add(() => {
    clearMarks();
    document.documentElement.removeAttribute('data-settings-search');
    dialog.classList.remove('v6-st-searching');
  });

  // ---------------------------------------------------------------- drill-in (narrow dialog)
  let drill = null;
  function setDrill(mode) {
    const narrow = dialog.clientWidth > 0 && dialog.clientWidth <= DRILL_WIDTH;
    drill = narrow ? mode || drill || 'list' : null;
    if (drill) dialog.dataset.v6Drill = drill;
    else delete dialog.dataset.v6Drill;
    back.hidden = drill !== 'detail';
    crumb.hidden = back.hidden;
    api.syncOrientation?.(); // the list is vertical again while it drills in
    if (!crumb.hidden) setText(crumb, v6cats.find((c) => c.id === api.current())?.label || '');
  }
  d.add(() => {
    delete dialog.dataset.v6Drill;
  });
  listen(back, 'click', () => {
    setDrill('list');
    tabs.get(api.current())?.focus({ preventScroll: true });
  });
  listen(window, 'resize', () => api.isOpen() && setDrill(drill));

  // ---------------------------------------------------------------- open / close
  listen(api.el, 'settings-close', () => {
    if (query) {
      input.value = '';
      runSearch('');
    }
  });
  const inst = {
    /** views/settings.js showCategory → here: a click (remember, no focus) on the narrow list drills in. */
    shown(cat, o = {}) {
      if (o.remember && !o.focus) setDrill('detail');
      else if (drill === 'detail') setDrill('detail'); // the crumb follows a deep link or a search jump
    },
    /** views/settings.js open() → here: a deep link opens its category; otherwise the narrow list shows first. */
    opened(linked) {
      if (query) {
        input.value = '';
        runSearch('');
      }
      setDrill(linked ? 'detail' : 'list');
      renderLayout();
      renderLearned();
      refresh();
      // the About info and the output names arrive a moment after open
      setTimeout(() => api.isOpen() && sumsLater.push(), 300);
    },
    refresh,
    summaries,
    search(q) {
      input.value = q;
      return runSearch(q);
    },
    get query() {
      return query;
    },
    get hits() {
      return hits.map((x) => ({ cat: x.cat, el: x.el }));
    },
    get drill() {
      return drill;
    },
    back() {
      back.click();
    },
    destroy() {
      const cur = api.current();
      d.dispose();
      if (FALLBACK[cur]) api.showCategory(FALLBACK[cur]);
    },
  };
  if (api.isOpen()) inst.opened(false);
  return inst;
}
