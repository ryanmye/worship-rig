// Sidebar module: Click (the metronome; native DECISIONS D23.3, UI6-build-plan "U-METRO"). Today's Click chip
// (views/perform.js song block, v11-metronome) as a module: the same on / off (controller.toggleClick(), with the
// count-in from Edit › Song), its "Count-in" / "Click on" state from controller.status.click, and the song's tempo as
// today's Quick sheet sets it (songs.<id>.tempo; TAP with the Quick sheet's tapBpm rule: a gap > 2 s starts over, the
// last ≤ 4 taps count, 30–300 BPM written rounded), plus − / + (1 BPM a press; held, it repeats). Lock (perform.js
// LOCK): the click and Quick › This song are live, so the tile, − / + and Tap stay live; "Count-in & level…" opens
// Edit, which is frozen. The click's own setup (count-in, after the count-in, level, time signature, output) is shown
// read only: it lives in Edit › Song and Settings › Sound, as today.
import { h, setText, disposer } from '../../components/util.js';
import { onTile } from '../../components/onTile.js';
import { tapBpm } from '../../components/quickSheet.js';
import { say, onVoiceChange } from '../../components/voice.js';
import { clickSettingsOf } from '../../../shared/click-math.js';
import { button, MINUS } from '../lib.js';

/** Tempo range the store keeps (store.js song.tempo 30..300) and the Quick sheet's TAP writes. */
export const TEMPO_MIN = 30;
export const TEMPO_MAX = 300;
/** − / + held: the first repeat after REPEAT_WAIT ms, then one step every REPEAT_MS. */
const REPEAT_WAIT = 450;
const REPEAT_MS = 70;
/** Today's chip icon (views/perform.js ICONS.click). */
const ICON = '<path d="M6.5 21 10 3h4l3.5 18z"/><path d="M12 16.5l6.5-10"/><path d="M7.4 17h9.2"/>';

/**
 * The tap rule of the Quick sheet (quickSheet.js tap): a gap > 2 s starts over, the last ≤ 4 taps count; a BPM
 * inside 30..300 is returned rounded, anything else null (nothing is written).
 * @param {(bpm:number) => void} write
 * @param {() => number} [now]
 * @returns {{tap():number|null, reset():void}}
 */
export function tapper(write, now = () => performance.now()) {
  let taps = [];
  return {
    tap() {
      const t = now();
      if (taps.length && t - taps[taps.length - 1] > 2000) taps = [];
      taps.push(t);
      taps = taps.slice(-4);
      const b = tapBpm(taps);
      if (b === null || b < TEMPO_MIN || b > TEMPO_MAX) return null;
      const r = Math.round(b);
      write(r);
      return r;
    },
    reset() {
      taps = [];
    },
  };
}

/** "1 bar" / "2 bars" / "none". */
const countInText = (n) => (n > 0 ? `${n} bar${n === 1 ? '' : 's'}` : 'none');

export default {
  id: 'metronome',
  label: 'Click',
  blurb: 'metronome: on / off, tempo, tap',
  icon: ICON,
  /**
   * Tab dot + rail border while the click runs (controller.status.click.on).
   * @param {object} state  store state
   * @param {object} v      the v6 view context
   * @returns {{live:boolean, text:string, title:string}|null}
   */
  badge(state, v) {
    const c = v?.controller?.status?.click || {};
    const bpm = state.songs[state.settings.currentSongId]?.tempo;
    if (!c.on) return { live: false, text: '', title: 'click off' };
    const what = c.counting ? 'counting in' : 'click on';
    return { live: true, text: '', title: `${what}${bpm ? `, ${Math.round(bpm)} BPM` : ''}` };
  },
  /**
   * @param {HTMLElement} el
   * @param {object} m  sidebar module ctx (the v6 view context + size)
   * @returns {{destroy():void}}
   */
  mount(el, m) {
    const { store, controller } = m;
    const d = disposer();
    let click = (controller.status && controller.status.click) || {};
    const song = () => store.currentSong();
    const setTempo = (bpm) => {
      const s = song();
      if (!s) return false;
      return store.set(`songs.${s.id}.tempo`, Math.max(TEMPO_MIN, Math.min(TEMPO_MAX, Math.round(bpm))));
    };

    const tile = onTile({
      label: 'Click', color: 'var(--accent)', testid: 'v6-click-on', on: false,
      title: say('clickTitle'),
      onToggle: () => {
        controller.toggleClick();
        render(); // the tile follows the click's real state (status.click), not the tap
      },
    });
    const bpmNum = h('b.v6-mt-n', { 'data-testid': 'v6-click-bpm', text: '—' });
    const bpmBox = h('span.v6-mt-bpm', { role: 'status', 'aria-live': 'off' }, bpmNum, h('small', { text: 'BPM' }));
    const dec = button(d, '.v6-mt-step', MINUS, { 'aria-label': 'Tempo down 1 BPM', 'data-testid': 'v6-click-down',
      title: 'Slower: 1 BPM (hold to keep going)' });
    const inc = button(d, '.v6-mt-step', '+', { 'aria-label': 'Tempo up 1 BPM', 'data-testid': 'v6-click-up',
      title: 'Faster: 1 BPM (hold to keep going)' });
    const tapBtn = button(d, '.v6-mt-tap', 'Tap', { 'data-testid': 'v6-click-tap', title: 'Tap along 4 times' });
    const hint = h('p.v6-mt-hint', { 'data-testid': 'v6-click-hint' });
    const setup = h('p.v6-mt-setup', { 'data-testid': 'v6-click-setup' });
    const edit = button(d, '.v6-qb.v6-mt-edit', [h('b', { text: 'Count-in & level…' }),
      h('small', { text: 'Edit › Song' })], { 'data-testid': 'v6-click-edit',
      title: 'The click’s count-in, level and time signature (Edit › Song)' });
    const root = h('div.v6-metro', { 'data-testid': 'v6-metro', 'aria-label': 'Click' },
      h('div.v6-mt-on', {}, tile.el),
      h('div.v6-mt-tempo', { role: 'group', 'aria-label': 'Tempo' }, dec, bpmBox, inc),
      tapBtn, hint, setup, edit);
    el.append(root);

    // − / +: a press steps 1 BPM; held, it repeats. A pointer press steps on pointerdown, so its click (detail ≥ 1)
    // is skipped; Enter / Space (a click with detail 0: keyboard, assistive tech) step once. skeptic UI6-small F2:
    // the repeat also stops when the window loses focus (⌘-Tab mid-hold sends no pointerup) and when the song
    // changes (a held + never runs on into the next song's tempo); a press slid off the button no longer swallows
    // the next keyboard step.
    const stops = new Set();
    const stopAll = () => {
      for (const s of stops) s();
    };
    const stepper = (b, dir) => {
      let t = 0;
      const stop = () => {
        clearTimeout(t);
        t = 0;
      };
      stops.add(stop);
      const bump = () => {
        const s = song();
        if (!s || !(Number(s.tempo) > 0)) return stop();
        const next = Math.round(s.tempo) + dir;
        if (next < TEMPO_MIN || next > TEMPO_MAX) return stop();
        setTempo(next);
      };
      d.listen(b, 'pointerdown', (e) => {
        if (b.disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
        bump();
        const rep = (ms) => {
          t = setTimeout(() => {
            bump();
            if (t) rep(REPEAT_MS);
          }, ms);
        };
        stop();
        rep(REPEAT_WAIT);
      });
      for (const type of ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture']) d.listen(b, type, stop);
      d.listen(b, 'click', (e) => {
        if (e.detail === 0) bump();
      });
    };
    d.listen(window, 'blur', stopAll);
    d.add(stopAll);
    stepper(dec, -1);
    stepper(inc, 1);
    const taps = tapper((bpm) => setTempo(bpm));
    d.listen(tapBtn, 'click', () => {
      tapBtn.classList.remove('flash');
      void tapBtn.offsetWidth;
      tapBtn.classList.add('flash');
      taps.tap();
    });
    d.listen(edit, 'click', () => {
      if (m.isLocked()) return;
      m.ctx.setView?.('edit', { block: 'song', focus: 'click' });
    });

    let shownId = null;
    function render() {
      const st = store.get();
      const s = st.songs[st.settings.currentSongId] || null;
      if ((s ? s.id : null) !== shownId) {
        shownId = s ? s.id : null;
        taps.reset(); // a tap run never carries into the next song
        stopAll(); // nor does a held − / + (F2)
      }
      const bpm = s && Number(s.tempo) > 0 ? Math.round(s.tempo) : null;
      const on = !!click.on;
      tile.set(on);
      tile.setSub(click.counting ? say('clickCounting') : bpm ? `${bpm} BPM` : 'no tempo');
      tile.setDisabled(!s || (!on && !bpm));
      tile.el.classList.toggle('counting', !!click.counting);
      tile.el.title = bpm || on ? say('clickTitle') : 'Set a tempo first (Tap, or Edit › Song)';
      setText(bpmNum, bpm ? String(bpm) : '—');
      dec.disabled = !bpm || bpm <= TEMPO_MIN;
      inc.disabled = !bpm || bpm >= TEMPO_MAX;
      tapBtn.disabled = !s;
      // the Quick sheet's tempo hint (quickSheet.js render): whether the song's echo follows the tempo
      const dl = s?.patch.fx?.delay;
      const synced = !dl || !(Number(dl.returnGain) > 0) ? null : dl.sync && dl.sync !== 'off';
      setText(hint, `${bpm ? 'Tap along 4× to change it.' : 'Tap along 4× to set a tempo.'}${synced === true
        ? ' The echo follows the tempo.' : synced === false ? ' This song’s echo keeps its own time.' : ''}`);
      const c = clickSettingsOf(st.settings);
      const out = (click.output || c.output) === 'aux' ? 'outputs 3–4' : 'with the music';
      setText(setup, `${s?.timeSig || '4/4'} · count-in ${countInText(c.countIn)}${c.countIn > 0
        ? (c.after === 'quiet' ? ', then quiet' : ', then clicking') : ''} · ${c.level > 0.0005 ? out : 'level off'}`);
      edit.disabled = !!st.settings.performLock || !s;
      edit.title = st.settings.performLock ? 'Perform lock is on: unlock it to edit'
        : 'The click’s count-in, level and time signature (Edit › Song)';
      root.classList.toggle('on', on);
    }

    d.add(store.subscribe(() => render()));
    d.add(controller.onStatus((s) => {
      const next = (s && s.click) || {};
      const changed = next.on !== click.on || next.counting !== click.counting || next.output !== click.output;
      click = next;
      if (changed) render();
    }));
    d.add(onVoiceChange(() => render()));
    render();

    return {
      destroy() {
        d.dispose();
        tile.destroy();
        root.remove();
      },
    };
  },
};
