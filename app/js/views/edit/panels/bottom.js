// OWNER: drone+bottom agent (views/edit/CONTRACT.md §6). The keyboard row (region 'bottom'), design/H-v2
// edit.html `.kbrow`: legend (one row per filled slot) · 61 keys with display-only range bars · output meter ·
// Fade out · PANIC.
// Ported from views/edit.js "BOTTOM: keyboard + meter"; the keyboard plays through controller.perform (source 'ui').
import { noteName } from '../../../shared/music.js';
import { h, setText, BLOCKS } from '../lib.js';

const FROM = 36; // C2
const TO = 96; // C7 (61 keys, like the Perform keyboard)

const isBlack = (n) => [1, 3, 6, 8, 10].includes(((n % 12) + 12) % 12);
const WHITES = (() => {
  let c = 0;
  for (let n = FROM; n <= TO; n++) if (!isBlack(n)) c += 1;
  return c;
})();
/** White keys in [FROM, n). */
const whitesBefore = (n) => {
  let c = 0;
  for (let k = FROM; k < n; k++) if (!isBlack(k)) c += 1;
  return c;
};
/**
 * Left/right edge (%) of key `n` on the FROM..TO keyboard, the same geometry as components/keys.js keyLayout (black
 * keys are 0.62 of a white key, centred on the white-key boundary).
 * @param {number} n
 * @returns {[number, number]}
 */
export function keyEdges(n) {
  const ww = 100 / WHITES;
  const x = whitesBefore(n) * ww;
  if (!isBlack(n)) return [x, x + ww];
  return [x - ww * 0.31, x + ww * 0.31];
}

/**
 * Range bar geometry for a slot: left/width in % of the keyboard, open ends when the range runs past the keys shown
 * (always the case for lowNote 0 / highNote 127).
 * @param {number} low
 * @param {number} high
 * @returns {{left:number, width:number, openL:boolean, openR:boolean}}
 */
export function barGeometry(low, high) {
  const lo = Number.isFinite(low) ? low : 0;
  const hi = Number.isFinite(high) ? high : 127;
  const openL = lo < FROM;
  const openR = hi > TO;
  const l = openL ? 0 : keyEdges(Math.min(lo, TO))[0];
  const r = openR ? 100 : keyEdges(Math.max(hi, FROM))[1];
  return { left: l, width: Math.max(0.5, r - l), openL, openR };
}

/**
 * Legend text for a range: "all", "to B3", "from C4", "C3 to C5".
 * @param {number} low
 * @param {number} high
 * @returns {string}
 */
export function rangeText(low, high) {
  const lo = Number.isFinite(low) ? low : 0;
  const hi = Number.isFinite(high) ? high : 127;
  if (lo <= 0 && hi >= 127) return 'all';
  if (lo <= 0) return `to ${noteName(hi)}`;
  if (hi >= 127) return `from ${noteName(lo)}`;
  return `${noteName(lo)} to ${noteName(hi)}`;
}

/** Filled slots of a song: [{i, role, color, low, high, muted}]. */
function filledSlots(song) {
  const slots = (song && song.patch && song.patch.slots) || [];
  const out = [];
  slots.forEach((s, i) => {
    if (!s) return;
    const b = BLOCKS[i];
    out.push({
      i, role: b ? b.role : `Slot ${i + 1}`, color: b ? b.color : `var(--slot-${i})`,
      low: Number.isFinite(s.lowNote) ? s.lowNote : 0, high: Number.isFinite(s.highNote) ? s.highNote : 127,
      muted: !!s.muted,
    });
  });
  return out;
}

export default {
  id: 'bottom',
  region: 'bottom',
  /**
   * @param {HTMLElement} el   the region host (footer.ev2-bottom)
   * @param {object} ctx       panel ctx (CONTRACT.md §3)
   */
  mount(el, ctx) {
    const { C, controller, engine, editState } = ctx;
    const perform = controller && controller.perform;
    const comps = [];

    // ---- legend + range bars (display only; rebuilt only when what they show changes)
    const legend = h('div.ev2-kb-leg', { 'aria-label': 'Sounds and their key ranges' });
    const bars = h('div.ev2-kb-bars', { 'aria-hidden': 'true' });
    let sig = '';
    const renderRanges = (song) => {
      const list = filledSlots(song);
      const next = JSON.stringify(list);
      if (next === sig) return;
      sig = next;
      legend.replaceChildren(...list.map((x) => h('div.ev2-kb-lrow', {
        class: x.muted ? 'muted' : '',
        style: { '--c': x.color },
        dataset: { slot: String(x.i) },
        title: x.muted ? `${x.role} is off` : `${x.role} plays ${rangeText(x.low, x.high) === 'all'
          ? 'every key' : rangeText(x.low, x.high)}`,
      }, h('i'), h('b.ev2-kb-role', { text: x.role }), h('span.ev2-kb-rng', { text: rangeText(x.low, x.high) }))));
      bars.style.setProperty('--rows', String(list.length));
      bars.replaceChildren(...list.map((x, row) => {
        const g = barGeometry(x.low, x.high);
        return h('div.ev2-kb-bar', {
          class: [x.muted ? 'muted' : '', g.openL ? 'open-l' : '', g.openR ? 'open-r' : ''].join(' '),
          dataset: { slot: String(x.i), low: String(x.low), high: String(x.high) },
          style: {
            '--c': x.color, '--row': String(row), left: `${g.left.toFixed(3)}%`, width: `${g.width.toFixed(3)}%`,
          },
        });
      }));
      renderSelected();
    };
    // Mockup: while a sound tab is selected, the other sounds' rows and bars step back (dim, not muted-grey).
    const renderSelected = () => {
      const m = /^slot:(\d+)$/.exec(editState.selected || '');
      for (const x of el.querySelectorAll('.ev2-kb-lrow, .ev2-kb-bar')) {
        x.classList.toggle('dim', !!m && x.dataset.slot !== m[1]);
      }
    };

    // ---- keyboard (plays through controller.perform, source 'ui'; views never call the engine)
    const piano = C.pianoKeyboard({
      from: FROM,
      to: TO,
      label: 'On-screen keyboard',
      onNoteOn: (n, v) => perform && perform.noteOn(n, Number.isFinite(v) ? v : 100),
      onNoteOff: (n) => perform && perform.noteOff(n),
    });
    comps.push(piano);
    piano.set(ctx.held());
    ctx.listen(editState, 'notes', (e) => {
      const held = e && e.detail && e.detail.held;
      if (held) piano.set(held);
    });

    // ---- output meter
    const meter = C.meter({ engine, label: 'Output level' });
    comps.push(meter);

    // ---- Fade out / PANIC
    const fade = h('button.ev2-kb-big.ev2-kb-fade', {
      type: 'button', title: 'Fade every sound out over a few seconds', dataset: { action: 'fade-out' },
      on: { click: () => controller && controller.fadeOutAll() },
    }, 'Fade out');
    const panic = h('button.ev2-kb-big.ev2-kb-panic', {
      type: 'button', 'aria-label': 'Panic: stop all sound (⌘ .)', title: 'Stop all sound now (⌘ . or Ctrl + .)',
      dataset: { action: 'panic' }, on: { click: () => controller && controller.panic() },
    }, 'PANIC', h('small', { text: '⌘ .' }));

    const row = h('div.ev2-kb', {},
      legend,
      h('div.ev2-kb-kbd', {}, bars, h('div.ev2-kb-keys', {}, piano.el)),
      h('div.ev2-kb-meter', {}, h('span.ev2-cap', { text: 'Output' }), meter.el),
      fade,
      panic,
    );
    el.replaceChildren(row);

    renderRanges(ctx.song());
    ctx.subscribe((e) => {
      if (e.songChanged || e.full || e.rels.some((r) => r === 'patch' || r.startsWith('patch.slots'))) {
        renderRanges(e.song);
      }
    });
    ctx.listen(editState, 'select', renderSelected);

    return {
      destroy() {
        // Keys held with the pointer must not ring on after the row goes (edit.js tore the piano down the same way).
        try {
          piano.releaseAll?.();
          perform?.releaseAll?.();
        } catch (err) {
          console.warn('[edit] keyboard release failed', err);
        }
        for (const c of comps.splice(0)) {
          try {
            c.destroy?.();
          } catch (err) {
            console.warn('[edit] keyboard row teardown failed', err);
          }
        }
        setText(legend, '');
      },
    };
  },
};
