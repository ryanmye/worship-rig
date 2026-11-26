// Sidebar module: Notes (D16; UI6-build-plan U3; mockup mock_v6.py notes_body(), tab "Sidebar · Notes"). The song's
// notes, read only as on today's Perform (views/perform.js notes panel; Edit › Song writes them), with today's
// keyboard scrolling (round2-ui #12: ↑/↓/PgUp/PgDn/Home/End scroll the focused notes and never reach the controller,
// where ↑/↓ are the mod wheel). The mockup's "Chart · coming in 2.1" sits under them, disabled.
import { h, setText, disposer } from '../../components/util.js';
import { say, onVoiceChange } from '../../components/voice.js';
import { button } from '../lib.js';

export default {
  id: 'notes',
  label: 'Notes',
  blurb: 'song notes, chart later',
  icon: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 11h7M9 15h7M9 7h4"/>',
  /**
   * @param {HTMLElement} el
   * @param {object} m  sidebar module ctx (the v6 view context + size)
   * @returns {{destroy():void}}
   */
  mount(el, m) {
    const { store } = m;
    const d = disposer();
    const text = h('div.v6-notes-t.v6-notes-side', { tabindex: '0', 'data-testid': 'v6-notes-text',
      'aria-label': 'Song notes' });
    // UI6-U7b O1 (as U7b F1 for the chart body, views/v6/chart/panel.js): a tap or click on the notes must not leave
    // them focused. Focused notes took Space (the browser scrolled them a page instead of the sustain pedal) and the
    // first Esc only let go of them (no Panic). Tab still reaches them (:focus-visible), and the keys below scroll.
    d.listen(text, 'focus', () => {
      let keyboard = true;
      try {
        keyboard = text.matches(':focus-visible');
      } catch {
        keyboard = true; // an engine without :focus-visible keeps today's focus
      }
      if (!keyboard) queueMicrotask(() => document.activeElement === text && text.blur());
    });
    d.listen(text, 'keydown', (e) => {
      if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const line = 40;
      const page = Math.max(line, text.clientHeight * 0.9);
      const dy = { ArrowUp: -line, ArrowDown: line, PageUp: -page, PageDown: page }[e.key];
      if (dy !== undefined) text.scrollTop += dy;
      else if (e.key === 'Home') text.scrollTop = 0;
      else if (e.key === 'End') text.scrollTop = text.scrollHeight;
      else return;
      e.preventDefault(); // the controller ignores defaultPrevented keys
      e.stopPropagation();
    });
    const chartSub = h('small', { text: 'coming in 2.1' });
    const chart = button(d, '.v6-qb.v6-notes-chart', [h('b', { text: 'Chart' }), chartSub], {
      disabled: true, title: 'Chord charts come in 2.1',
    });
    // U7b: with the hidden chart view on (settings.chartView), this opens the Chart module (or the chart on the stage)
    d.listen(chart, 'click', () => m.openSidebar?.('chart'));
    let chartOn = false;
    const renderChart = () => {
      const on = store.get().settings.chartView === true;
      if (on === chartOn) return;
      chartOn = on;
      chart.disabled = !on;
      setText(chartSub, on ? 'open the chord chart' : 'coming in 2.1');
      chart.title = on ? 'Open this song’s chord chart' : 'Chord charts come in 2.1';
      if (on) chart.dataset.testid = 'v6-notes-chart';
      else delete chart.dataset.testid;
    };
    const root = h('div.v6-notes', { 'data-testid': 'v6-notes-mod' }, text, chart);
    el.append(root);

    let shown = null;
    function render() {
      const notes = store.currentSong()?.notes || '';
      if (notes === shown) return;
      shown = notes;
      text.classList.toggle('empty', !notes);
      setText(text, notes || say('notesEmpty'));
      text.scrollTop = 0;
    }
    d.add(store.subscribe(() => {
      render();
      renderChart();
    }));
    renderChart();
    d.add(onVoiceChange(() => {
      shown = null; // the empty-notes wording follows the voice
      render();
    }));
    render();
    return {
      destroy() {
        d.dispose();
        root.remove();
      },
    };
  },
};
