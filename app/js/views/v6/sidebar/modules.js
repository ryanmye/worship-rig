// The right sidebar's modules, in their default order (D15, D16; UI6-build-plan U3). Each is one self-contained file:
// {id, label, blurb, icon, badge?(state, v) → {live, text, title}|null, mount(el, ctx) → {destroy()}}. To add one
// (Tone), append it here; the sidebar shows it on every device after the ones the player has ordered.
// U-METRO (D23.3): Click (the metronome) came after U3, so a layout saved before it gets it appended, shown.
// C-SHIP (D33): Chart is a late module (sidebar.js LATE_MODULE_IDS). views/v6/perform.js registers
// chartPlaceholder() while chord charts are on, and views/v6/chart/chart.js takes its place once the chart is used.
import { h } from '../../components/util.js';
import drone from './drone.js';
import setlist from './setlist.js';
import notes from './notes.js';
import metronome from './metronome.js';

/** Registry order = the order a device starts with. */
export const SIDEBAR_MODULES = Object.freeze([drone, setlist, notes, metronome]);

/**
 * C-SHIP (D33): the Chart module's face (tab, rail icon, customize row, width), shared by the placeholder below and
 * the real module (views/v6/chart/chart.js), so the sidebar looks the same before and after the chart loads.
 * `width`: the sidebar's width while Chart shows (UI6-U7b, mockup `.side.chartw`: 540 px).
 */
export const CHART_MODULE = Object.freeze({
  id: 'chart',
  label: 'Chart',
  blurb: 'chord chart, follows the key',
  icon: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  width: 540,
});

/** views/chart/core.js CHART_PREFS_KEY (not imported: importing it would load the chart). */
const CHART_PREFS_KEY = 'worship-rig.chart';
/**
 * Where this device shows the chart, from its stored prefs: 'side' only when the player chose ⇥ Sidebar (chart.js
 * CHART_PLACEMENT_DEFAULT is 'stage', UI6-U7b decision a).
 * @returns {'side'|'stage'}
 */
export function storedChartPlacement() {
  try {
    const p = JSON.parse(localStorage.getItem(CHART_PREFS_KEY) || 'null');
    return p && p.placement === 'side' ? 'side' : 'stage';
  } catch {
    return 'stage';
  }
}

/**
 * C-SHIP (D33): the Chart module before views/v6/chart/ is loaded. It shows the same tab and rail icon and loads the
 * chart only when the player asks for it; nothing of the chart is fetched, drawn or listened to before that. The
 * real module then replaces it in place (sidebar.js addModule: `placeholder`).
 * @param {(then?:(view:object) => void) => void} use  main.js: load and mount the chart, then call `then` with it
 * @returns {object} a sidebar module
 */
export function chartPlaceholder(use) {
  return {
    ...CHART_MODULE,
    placeholder: true,
    badge: () => null,
    /** The Chart tab / rail icon: on the stage placement the chart goes up there (chart.js module.take). */
    take() {
      if (storedChartPlacement() !== 'stage') return false;
      use((view) => view.show());
      return true;
    },
    away: () => storedChartPlacement() === 'stage',
    /** The sidebar opened on Chart: load it; the real module is mounted here when it arrives. */
    mount(el) {
      const note = h('p.v6-ch-wait', { 'data-testid': 'v6-chart-loading', role: 'status',
        text: 'Loading the chart…' });
      el.append(note);
      use();
      return { destroy: () => note.remove() };
    },
  };
}
