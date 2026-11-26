// UI v6 chart (D7 hidden 2.1 feature, D12, D16 "Chart placement is the player's choice" + "Chart text size is one tap
// away, in percent"; native/docs/lanes/UI6-build-plan.md U7b; mockup native/docs/design/mockups/chart.html).
// main.js imports this instead of views/chart/index.js while BOTH settings.chartView and settings.uiV6 are on (on the
// v6 Perform); with either off nothing here is loaded. It mounts:
//   - a Chart module in the right sidebar (sidebar.js addModule; a tab, the sidebar wider while it shows), and
//   - the chart on the stage: the strips give way to live mini faders (minis.js) beside the chart, the sidebar folds
//     to its rail with Chart lit; iPad portrait = "music stand" (mini faders in a row above the chart).
// The player chooses per device (⇥ Sidebar / ⤢ Stage in the chart's header). One chart shows at a time: on the stage
// its sidebar tab only brings it back up there (the module's take() / away()).
// Per-device preferences live in today's key (localStorage 'worship-rig.chart', views/chart/core.js), shared with
// today's view (mode, speed) and kept beside its fields: `placement` ('side' | 'stage'), `stage` (up on the stage),
// `pct` (stage text size, %), `sidePct` (sidebar, %). Today's px index (`font`) becomes `pct` once (logic pctFromPx).
// Orchestrator decision (UI6-U7b review, tier 2): a device that never chose shows the chart on the STAGE (D16 "give
// the user the choice"; `placement` is stored only when the player picks ⇥ Sidebar / ⤢ Stage).
import { h, disposer } from '../../components/util.js';
import { readStoredPrefs, writeStoredPrefs } from '../../chart/core.js';
import {
  CHART_FONT_STEPS, CHART_SPEED_STEPS, CHART_SPEED_DEFAULT, CHART_MODES, CHART_PCT_DEFAULT, CHART_SIDE_PCT,
  pctFromPx, validPct,
} from '../../chart/logic.js';
import { PORTRAIT_MQ } from '../sidebar/sidebar.js';
import { chartPanel } from './panel.js';
import { miniFaders } from './minis.js';

export const V6_CHART_CSS_HREF = './styles-v6-chart.css';
/** The sheet's look (chord / lyric / heading classes) is today's chart stylesheet. */
const CHART_CSS_HREF = './styles-chart.css';
/** Where the chart shows on a device that never chose (UI6-U7b review, orchestrator decision a). */
export const CHART_PLACEMENT_DEFAULT = 'stage';
/** The sidebar's width while the Chart tab shows, until the player drags it (mockup .side.chartw: 540 px). */
export const CHART_SIDE_WIDTH = 540;
const PLACEMENTS = ['side', 'stage'];

/**
 * This device's chart preferences for the v6 chart, migrating today's px index to a percent the first time.
 * @returns {{placement:'side'|'stage', stage:boolean, pct:number, sidePct:number, mode:string, speed:number}}
 *   (placement: CHART_PLACEMENT_DEFAULT when this device never chose)
 */
export function readV6Prefs() {
  const p = readStoredPrefs();
  const out = {
    placement: PLACEMENTS.includes(p.placement) ? p.placement : CHART_PLACEMENT_DEFAULT,
    stage: p.stage === true,
    pct: validPct(p.pct, NaN),
    sidePct: validPct(p.sidePct, CHART_SIDE_PCT),
    mode: CHART_MODES.includes(p.mode) ? p.mode : 'hear',
    speed: Number.isInteger(p.speed) && p.speed >= 0 && p.speed < CHART_SPEED_STEPS.length ? p.speed
      : CHART_SPEED_DEFAULT,
  };
  if (Number.isNaN(out.pct)) {
    // D16 implementation note: today's view stores a px index (CHART_FONT_STEPS); its nearest percent, once (the
    // `pct` written now wins from here on; today's view keeps reading its own `font`)
    const idx = p.font;
    out.pct = Number.isInteger(idx) && idx >= 0 && idx < CHART_FONT_STEPS.length ? pctFromPx(CHART_FONT_STEPS[idx])
      : CHART_PCT_DEFAULT;
    writeStoredPrefs({ pct: out.pct });
  }
  return out;
}

/**
 * Link a stylesheet once (by a data attribute) and say whether this call added it.
 * @param {string} href
 * @param {string} attr
 * @returns {{link:HTMLLinkElement, own:boolean}}
 */
function linkCss(href, attr) {
  let link = document.querySelector(`link[${attr}]`);
  if (link) return { link, own: false };
  link = h('link', { rel: 'stylesheet', href, [attr]: '' });
  document.head.append(link);
  return { link, own: true };
}

/**
 * Mount the v6 chart (main.js applyChartView while the v6 Perform is on).
 * @param {{store:object, controller:object, toast?:Function}} ctx  main.js ctx
 * @param {{v6:{v:object, side:object, board:HTMLElement, strips:HTMLElement, names:object}}} mounts
 *   views/v6/perform.js `chartMounts`
 * @returns {{destroy():void, state():object, show():void, setPlacement(p:string):void, closeStage():void,
 *   openEdit():Promise<object|null>, readonly panel:object|null, readonly editor:object|null}}
 */
export function mountChartV6(ctx, mounts) {
  const { store } = ctx;
  const { v, side, board, strips, names } = mounts.v6;
  const d = disposer();
  const prefs = readV6Prefs();
  const css = [linkCss(CHART_CSS_HREF, 'data-chart-css'), linkCss(V6_CHART_CSS_HREF, 'data-v6-chart-css')];
  const locked = () => !!store.get().settings.performLock;
  const mq = typeof window.matchMedia === 'function' ? window.matchMedia(PORTRAIT_MQ) : null;
  let destroyed = false;
  let editor = null;
  let stage = null; // {host, minis, panel, vertical} while the chart is on the stage
  let sidePanel = null; // the panel in the sidebar module, while mounted

  /** The controller every panel gets (panel.js). */
  const c = {
    store,
    prefs,
    // `placement` is not here: it is the player's choice, written by setPlacement only (decision a: absent = stage)
    save: () => writeStoredPrefs({ stage: prefs.stage, pct: prefs.pct, sidePct: prefs.sidePct, mode: prefs.mode,
      speed: prefs.speed }),
    locked,
    pct: (where) => (where === 'side' ? prefs.sidePct : prefs.pct),
    setPct(where, p) {
      prefs[where === 'side' ? 'sidePct' : 'pct'] = validPct(p);
      c.save();
    },
    setPlacement,
    closeStage,
    openEdit,
  };
  // Heard / Hands and the speed are one setting for both places: the other panel (if any) follows on its next render

  // ---------------------------------------------------------------- the stage
  function buildStage() {
    if (stage) return;
    const vertical = !mq?.matches;
    const minis = miniFaders(v, names, { vertical, onStrips: () => closeStage() });
    const panel = chartPanel(c, 'stage');
    const host = h('div.v6-chstage', { 'data-testid': 'v6-chart-stage-host' }, minis.el, panel.el);
    strips.after(host);
    board.classList.add('v6-chart-on');
    stage = { host, minis, panel, vertical };
  }
  function dropStage() {
    if (!stage) return;
    const s = stage;
    stage = null;
    s.panel.destroy();
    s.minis.destroy();
    s.host.remove();
    board.classList.remove('v6-chart-on');
  }
  /** Put the chart up on the stage (placement 'stage'); `fold`: the sidebar folds to its rail (D16). */
  function showStage(fold = true) {
    prefs.stage = true;
    c.save();
    buildStage();
    if (fold) side.collapse();
    side.refreshBadges();
  }
  /** ▤ Strips: the strips come back; the chart stays a tap away (the rail's Chart). */
  function closeStage() {
    prefs.stage = false;
    c.save();
    dropStage();
    side.refreshBadges();
  }
  function setPlacement(p) {
    if (!PLACEMENTS.includes(p)) return;
    // UI6-U7b O2: the panel that takes over keeps the line being read and a running auto-scroll (each place has its
    // own panel; the player had to press ▶ again)
    const was = (stage?.panel || sidePanel)?.place() ?? null;
    prefs.placement = p;
    writeStoredPrefs({ placement: p });
    if (p === 'side') {
      prefs.stage = false;
      c.save();
      dropStage();
      side.refreshBadges();
      side.open('chart');
      sidePanel?.resume(was);
    } else {
      showStage(true);
      stage?.panel.resume(was);
    }
  }
  /** Show the chart where it lives: up on the stage, or the sidebar open on Chart. */
  function show() {
    if (prefs.placement === 'stage') showStage(true);
    else side.open('chart');
  }

  // ---------------------------------------------------------------- the sidebar module (D15 module API, U3)
  const module = {
    id: 'chart',
    label: 'Chart',
    blurb: 'chord chart, follows the key',
    icon: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
    width: CHART_SIDE_WIDTH,
    badge: () => (prefs.placement === 'stage' && stage ? { live: true, text: '', title: 'on the stage' } : null),
    /** The player asked for Chart (tab, rail icon): with the stage placement it goes up there instead. */
    take() {
      if (prefs.placement !== 'stage') return false;
      showStage(true);
      return true;
    },
    away: () => prefs.placement === 'stage',
    mount(el) {
      if (prefs.placement === 'stage') {
        // reached only by the tablist's arrows mid-change; the chart lives on the stage
        const b = h('button.btn.ghost', { type: 'button', text: '⤢ Show it on the stage' });
        b.addEventListener('click', () => showStage(true));
        const note = h('div.v6-ch-note', { 'data-testid': 'v6-chart-side-note' },
          h('p', { text: 'The chart is on the stage on this device.' }), b);
        el.append(note);
        return { destroy: () => note.remove() };
      }
      const panel = chartPanel(c, 'side');
      el.append(panel.el);
      sidePanel = panel;
      return {
        destroy() {
          if (sidePanel === panel) sidePanel = null;
          panel.destroy();
        },
      };
    },
  };

  // ---------------------------------------------------------------- Edit chart (dialog, loaded on first use)
  let editPending = null;
  async function openEdit(opener = null) {
    const s = store.currentSong();
    if (!s || locked() || editor || destroyed) return editor;
    editPending ||= import('./edit.js');
    const { openChartEditor } = await editPending;
    // the view may have gone (flag off), the song switched or Lock come on while the module loaded (chart-view V3)
    if (editor || destroyed || locked() || store.currentSong()?.id !== s.id) return editor;
    editor = openChartEditor(ctx, s.id, {
      host: v.host, mode: () => prefs.mode, opener, onClose: () => (editor = null),
    });
    return editor;
  }

  // ---------------------------------------------------------------- store: the song, Lock; the mini faders
  let lastSongId = store.get().settings.currentSongId;
  d.add(store.subscribe((state) => {
    const id = state.settings.currentSongId;
    if (id !== lastSongId) {
      lastSongId = id;
      editor?.close(); // the dialog belongs to the song it was opened for
      stage?.minis.cancelDrags();
    }
    if (state.settings.performLock) editor?.close(); // chart-view V4: Lock freezes editing, even mid-dialog
    stage?.minis.render();
  }));
  // a move / insert / remove of instruments (D23): a fader drag held by position would move another instrument now
  if (typeof store.onSlotMap === 'function') d.add(store.onSlotMap(() => stage?.minis.cancelDrags()));
  const reMinis = () => stage?.minis.render();
  d.listen(ctx.controller, 'scene', reMinis); // a snapshot's levels are live levels (liveOf)
  for (const ev of ['ready', 'instruments', 'user-samples']) d.listen(ctx.controller, ev, reMinis);
  // ⌘+ / ⌘− / ⌘0 on the shown chart (D16): only on Perform, with Settings and every dialog closed, not while typing
  d.listen(window, 'keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.repeat || e.defaultPrevented) return;
    const k = e.key;
    const dir = k === '+' || k === '=' || e.code === 'NumpadAdd' ? 1 : k === '-' || k === '_'
      || e.code === 'NumpadSubtract' ? -1 : k === '0' || e.code === 'Numpad0' ? 0 : null;
    if (dir === null) return;
    const panel = stage?.panel || sidePanel;
    if (!panel || !panel.el.isConnected || panel.el.offsetParent === null) return;
    if (store.get().settings.view !== 'perform' || document.body.classList.contains('settings-open')) return;
    const t = document.activeElement;
    if (t && (t.tagName === 'TEXTAREA' || t.isContentEditable || (t.tagName === 'INPUT'
      && !['range', 'checkbox', 'radio', 'button'].includes(t.type)))) return;
    for (const m of document.querySelectorAll('[role="dialog"][aria-modal="true"]')) {
      if (!m.closest('[hidden]') && m.getClientRects().length > 0) return; // a dialog on screen keeps its keys
    }
    e.preventDefault(); // no page zoom in Chrome
    if (dir === 0) panel.reset('key');
    else panel.step(dir, 'key');
  });
  // iPad rotation: the mini faders turn between columns (landscape) and a row (portrait)
  if (mq && typeof mq.addEventListener === 'function') {
    const onMq = () => {
      if (!stage || stage.vertical === !mq.matches) return;
      const was = stage.panel.place(); // UI6-U7b O2: the rebuilt panel goes on where this one was
      dropStage();
      buildStage();
      stage?.panel.resume(was);
    };
    mq.addEventListener('change', onMq);
    d.add(() => mq.removeEventListener('change', onMq));
  }

  side.addModule(module);
  if (prefs.placement === 'stage' && prefs.stage) showStage(false);

  return {
    show,
    setPlacement,
    closeStage,
    openEdit: () => openEdit(),
    get panel() {
      return stage?.panel || sidePanel;
    },
    get editor() {
      return editor;
    },
    /** Test / debug: where the chart is and what it shows. */
    state() {
      const p = stage?.panel || sidePanel;
      return {
        v6: true, placement: prefs.placement, onStage: !!stage, inSidebar: !!sidePanel, pct: prefs.pct,
        sidePct: prefs.sidePct, minis: stage ? stage.minis.count : 0, editing: !!editor, ...(p ? p.state() : {}),
      };
    },
    destroy() {
      destroyed = true;
      editor?.close();
      d.dispose();
      dropStage();
      side.removeModule('chart');
      for (const x of css) if (x.own) x.link.remove();
    },
  };
}
