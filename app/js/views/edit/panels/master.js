// Master tab (H-v2 concept §1(1) "Master tab: H's Tape + Master panels" + the Keyboard block as "Wheels & pedal";
// views/edit/CONTRACT.md §1 placement table and §6 "master"). Owner: master agent.
//
// Layout: the master volume on top, then four lib.sections: Tape (fx.lofi.*), Tone (fx.eq.*, only when the PARAMS
// table has it), Glue (fx.comp.amount, ditto) and Wheels & pedal (song.patch.modWheel/expression/volume/bend/swell).
// Every control is bound through lib.createBinder, so store changes update values in place (ui-edit "store → view
// updates in place") and nothing is rebuilt on a song switch. opts.focus ('wheels' | 'tape' | 'tone' | 'glue') opens
// its section, scrolls to it and focuses its first control, on mount and in update() (CONTRACT §2 "focus ids").
import { describe, formatValue } from '../../../shared/params.js';
import { WHEEL_TARGETS, BEND_MODES } from '../../../presets.js';
import {
  h, setText, button, createBinder, section, wordSlider, hasParam, pct, blockOf, changeText, editedSince, changedDot,
  TARGET_LABELS, BEND_LABELS,
} from '../lib.js';

// TARGET_LABELS / BEND_LABELS live in lib.js (hv2-edit-integrate); re-exported for existing importers.
export { TARGET_LABELS, BEND_LABELS };

/** opts.focus → section id. 'wheels' comes from the rig bar link, 'tape' from the Effects footer. */
const FOCUS_SECTIONS = Object.freeze({
  wheels: 'master-wheels', tape: 'master-tape', tone: 'master-eq', eq: 'master-eq', glue: 'master-glue',
});
const FOCUSABLE = ['select', 'input', 'button', 'textarea'].map((t) => `.ev2-sec-body ${t}:not([disabled])`)
  .concat('.ev2-sec-body [tabindex="0"]').join(', ');
const OFF = 0.0001;
const EQ_BANDS = Object.freeze([
  { k: 'low', name: 'Low', ends: ['thinner', 'warmer'] },
  { k: 'mid', name: 'Mid', ends: ['hollow', 'fuller'] },
  { k: 'high', name: 'High', ends: ['darker', 'airier'] },
]);
const LOFI_DETAILS = Object.freeze([
  { k: 'wow', name: 'Wow', ends: ['steady', 'wobbly'] },
  { k: 'flutter', name: 'Flutter', ends: ['steady', 'fluttery'] },
  { k: 'crackle', name: 'Crackle', ends: ['quiet', 'dusty'] },
  { k: 'bits', name: 'Bit crush', ends: ['clean', 'crunchy'] },
  { k: 'tone', name: 'Tone', ends: ['dark', 'bright'] },
  { k: 'saturation', name: 'Saturation', ends: ['clean', 'driven'] },
]);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const shortTarget = (t) => (TARGET_LABELS[t] || t).replace(/\s*\(.*\)$/, '');
const seconds = (v) => `${Number(v).toFixed(Number(v) < 10 ? 1 : 0)} s`;
const semis = (v) => `${v} semitone${Number(v) === 1 ? '' : 's'}`;
const defOf = (addr, fallback) => (hasParam(addr) ? describe(addr).default : fallback);

export default {
  id: 'master',
  icon: 'master',
  /**
   * Mount the Master tab.
   * @param {HTMLElement} el
   * @param {object} ctx   panel ctx (CONTRACT.md §3)
   * @param {{focus?:string}} [opts]
   * @returns {{update(opts:object):void, destroy():void}}
   */
  mount(el, ctx, opts = {}) {
    const binder = createBinder(ctx);
    const valueOf = (addr) => ctx.valueOf(addr);
    const MINUS6 = defOf('master.volume', 0.5011872336272722);
    const bands = EQ_BANDS.filter((b) => hasParam(`fx.eq.${b.k}`));
    const haveGlue = hasParam('fx.comp.amount');

    /** A word slider bound to `addr` (defaults from PARAMS unless given). */
    const ws = (addr, o) => binder.ctl(addr, (onChange) => wordSlider({
      min: hasParam(addr) ? describe(addr).min : 0,
      max: hasParam(addr) ? describe(addr).max : 1,
      default: defOf(addr, o.default),
      ...o,
      onChange,
    }));

    // ---- master volume (taper = params.faderTaper, 2·pos³; double-click → −6 dB)
    const volume = ws('master.volume', {
      label: 'Master volume',
      curve: 'taper',
      min: 0,
      max: 2,
      default: MINUS6,
      word: (v) => formatValue('master.volume', v),
      format: (v) => (Math.abs(v - MINUS6) < 1e-4 ? 'default' : ''),
      ends: ['silent', '+6 dB'],
    });
    volume.el.classList.add('ev2-master-vol');
    const top = h('div.ev2-master-top', {},
      volume.el,
      h('p.ev2-hint.ev2-master-vol-hint', {
        text: 'Everything you hear goes through here last. Double-click the slider to go back to −6 dB.',
      }),
    );

    // ---- Tape (fx.lofi.*)
    const lofiWord = (v) => (v <= OFF ? 'Off' : v < 0.34 ? 'Subtle' : v < 0.67 ? 'Worn' : 'Heavy');
    const tapeAmount = ws('fx.lofi.amount', {
      label: 'Amount', word: lofiWord, format: pct, ends: ['clean', 'old tape'],
    });
    const details = LOFI_DETAILS.map((d) => ws(`fx.lofi.${d.k}`, { label: d.name, format: pct, ends: d.ends }));
    const detailsSec = section('master-tape-details', 'Tape & vinyl details', {
      cls: 'ev2-master-sub',
      binder,
      rels: ['patch.fx.lofi'],
      summary: () => {
        const moved = LOFI_DETAILS.filter((d) =>
          Math.abs(Number(valueOf(`fx.lofi.${d.k}`)) - defOf(`fx.lofi.${d.k}`, 0)) > 0.005);
        return moved.length ? moved.map((d) => `${d.name} ${pct(valueOf(`fx.lofi.${d.k}`))}`).join(' · ') : 'Defaults';
      },
    }, ...details.map((d) => d.el));
    const tapeSummary = () => {
      const v = Number(valueOf('fx.lofi.amount')) || 0;
      return v <= OFF ? 'Off' : pct(v);
    };
    const tapeSec = section('master-tape', 'Tape', {
      binder, rels: ['patch.fx.lofi'], summary: tapeSummary,
    },
    tapeAmount.el,
    h('p.ev2-hint.ev2-master-note', { text: 'Wow, flutter and crackle of an old tape machine, over the whole mix.' }),
    detailsSec,
    );

    // ---- Tone (fx.eq.*), only when the PARAMS table has it (CONTRACT §3.3 "params added later")
    const eqCtl = bands.map((b) => ws(`fx.eq.${b.k}`, {
      label: b.name,
      bipolar: true,
      word: (v) => (Math.abs(v) < 0.05 ? 'Flat' : cap(v > 0 ? b.ends[1] : b.ends[0])),
      format: (v) => formatValue(`fx.eq.${b.k}`, v),
      ends: b.ends,
    }));
    const eqMoved = () => bands.filter((b) => Math.abs(Number(valueOf(`fx.eq.${b.k}`)) || 0) >= 0.05);
    const eqSummary = () => {
      const nz = eqMoved();
      return nz.length ? nz.map((b) => `${b.name} ${formatValue(`fx.eq.${b.k}`, valueOf(`fx.eq.${b.k}`))}`)
        .join(' · ') : 'Flat';
    };
    const eqSec = bands.length ? section('master-eq', 'Tone', {
      binder, rels: ['patch.fx.eq'], summary: eqSummary,
    },
    ...eqCtl.map((c) => c.el),
    h('p.ev2-hint.ev2-master-note', {
      text: 'Whole mix: low = warmth, mid = body, high = air. Double-click a slider to reset.',
    }),
    ) : null;

    // ---- Glue (fx.comp.amount)
    const glueWord = (v) => (v <= OFF ? 'Off' : v < 0.4 ? 'Gentle' : v < 0.75 ? 'Firm' : 'Tight');
    const glue = haveGlue ? ws('fx.comp.amount', {
      label: 'Glue', word: glueWord, format: pct, ends: ['untouched', 'glued'],
    }) : null;
    const glueSummary = () => {
      const v = Number(valueOf('fx.comp.amount')) || 0;
      return v <= OFF ? 'Off' : pct(v);
    };
    const glueSec = glue ? section('master-glue', 'Glue', {
      binder, rels: ['patch.fx.comp'], summary: glueSummary,
    },
    glue.el,
    h('p.ev2-hint.ev2-master-note', { text: 'Gently evens out the whole mix so it sits together. Off = untouched.' }),
    ) : null;

    // ---- Wheels & pedal (edit.js routing section; song.patch.* aliases)
    const C = ctx.C;
    const targetOpts = WHEEL_TARGETS.map((t) => ({ value: t, label: TARGET_LABELS[t] || t }));
    const sel = (label, addr, options) => {
      const c = binder.ctl(addr, (onChange) => C.select({ label, options, onChange }));
      c.el.classList.add('ev2-master-sel');
      return c;
    };
    const range = (who, end, addr, def) => {
      const c = ws(addr, { label: end, min: 0, max: 1, default: def, format: pct });
      c.input.setAttribute('aria-label', `${who} ${end.toLowerCase()}`);
      return c;
    };
    const wheelRow = (who, key) => {
      const target = sel(`${who} controls`, `song.patch.${key}.target`, targetOpts);
      const from = range(who, 'From', `song.patch.${key}.min`, 0);
      const to = range(who, 'To', `song.patch.${key}.max`, 1);
      // From/To mean nothing while the wheel is routed to "Nothing"
      binder.fn([`patch.${key}.target`], (s) => {
        const none = s.patch[key].target === 'none';
        from.setDisabled(none);
        to.setDisabled(none);
      });
      return h('div.ev2-master-row', { dataset: { route: key } }, target.el, from.el, to.el);
    };
    const bendMode = sel('Pitch-bend wheel', 'song.patch.bend.mode',
      BEND_MODES.map((m) => ({ value: m, label: BEND_LABELS[m] || m })));
    const bendRange = binder.ctl('song.patch.bend.range', (onChange) =>
      C.stepper({ label: 'Bend range', min: 0, max: 24, step: 1, format: semis, onChange }));
    bendRange.el.classList.add('ev2-master-step');
    const swell = ws('song.patch.swell.seconds', {
      label: 'Swell time', min: 1, max: 60, curve: 'log', default: 8,
      word: (v) => (v < 3 ? 'Quick' : v < 12 ? 'Medium' : 'Slow'),
      format: seconds,
      ends: ['1 s', '60 s'],
    });
    swell.el.classList.add('ev2-master-swell');
    // patch.swell.seconds is the one DIFF_WATCH path on this tab: its changed dot sits before the label
    const swellDot = changedDot();
    swell.el.querySelector('.ev2-ws-label')?.before(swellDot);
    const wheelsSec = section('master-wheels', 'Wheels & pedal', {
      binder,
      rels: ['patch.modWheel', 'patch.expression', 'patch.volume', 'patch.bend', 'patch.swell'],
      summary: (s) => `Mod wheel: ${shortTarget(s.patch.modWheel.target)}`
        + ` · Pedal: ${shortTarget(s.patch.expression.target)}`
        + ` · Bend: ${BEND_LABELS[s.patch.bend.mode] || s.patch.bend.mode} · Swell ${seconds(s.patch.swell.seconds)}`,
    },
    h('div.ev2-master-route', {},
      wheelRow('Mod wheel', 'modWheel'),
      wheelRow('Expression pedal', 'expression'),
      h('div.ev2-master-row', { dataset: { route: 'volume' } },
        sel('Volume knob controls', 'song.patch.volume.target', targetOpts).el),
      h('div.ev2-master-row', { dataset: { route: 'bend' } }, bendMode.el, bendRange.el, swell.el),
      h('p.ev2-hint.ev2-master-note', {
        text: 'Saved with this song. Swell time is how long the Swell button takes to bring the sound in.',
      }),
    ),
    );

    // ---- footer: the Effects tab link + the change line (CONTRACT §3.6)
    const prefixes = blockOf('master').prefixes;
    const chgText = h('span');
    const chg = h('span.ev2-chg', {}, changedDot(), chgText);
    const foot = h('div.ev2-foot.ev2-master-foot', {},
      button('Space, Echo and Chorus are on the Effects tab', () => ctx.select('effects'), {
        class: 'ev2-linkbtn', dataset: { goto: 'effects' },
      }),
      chg,
    );
    const renderChanges = () => {
      const n = ctx.editState.changeCount(prefixes);
      // tape, glue, EQ and the wheels (the master level is not in these prefixes, so it never reads as "edited")
      const edited = n === 0 && editedSince(ctx.song(), ctx.editState.baseline, prefixes);
      setText(chgText, changeText(n, edited));
      chg.classList.toggle('none', n === 0);
      swellDot.hidden = !ctx.editState.isChanged('patch.swell');
    };

    const main = h('div.ev2-master-main', {}, top, tapeSec, eqSec, glueSec, wheelsSec);
    el.replaceChildren(h('div.ev2-master', {}, main, foot));
    ctx.listen(ctx.editState, 'changes', renderChanges);
    ctx.subscribe(renderChanges); // "Sound edited" follows non-counted writes too (round3-edit m2)
    renderChanges();

    // ---- sentence title: "MASTER is at −6.0 dB, tape off, tone flat, glue off"
    const toneWord = () => {
      const nz = eqMoved();
      if (!nz.length) return 'flat';
      if (nz.length > 1) return 'shaped';
      return `${nz[0].name.toLowerCase()} ${formatValue(`fx.eq.${nz[0].k}`, valueOf(`fx.eq.${nz[0].k}`))}`;
    };
    let titleKey = '';
    const renderTitle = () => {
      const vol = formatValue('master.volume', valueOf('master.volume'));
      const tape = tapeSummary().toLowerCase();
      const tone = eqSec ? toneWord() : null;
      const gl = glueSec ? glueSummary().toLowerCase() : null;
      const key = [vol, tape, tone, gl].join('|');
      if (key === titleKey) return;
      titleKey = key;
      const parts = [{ text: 'MASTER', role: true }, ' is at ',
        { text: vol, control: volume.el, title: 'Master volume' },
        ', tape ', { text: tape, control: tapeAmount.el, title: 'Tape amount' }];
      if (tone) parts.push(', tone ', { text: tone, control: eqCtl[0].el, title: 'Tone (EQ)' });
      if (gl) parts.push(', glue ', { text: gl, control: glue.el, title: 'Glue' });
      ctx.setTitle(parts, {
        icon: 'master',
        sub: 'The whole mix, last stop before the speakers · click an underlined word to jump to its control',
      });
    };
    binder.fn(['patch.fx.master', 'patch.fx.lofi', 'patch.fx.eq', 'patch.fx.comp'], renderTitle);
    // a song switch re-applies every binding; the key cache keeps the title DOM when its words are unchanged

    // ---- focus (on mount and in update)
    let flashTimer = 0;
    let rafId = 0;
    const applyFocus = (o) => {
      const id = o && FOCUS_SECTIONS[o.focus];
      if (!id) return;
      const det = el.querySelector(`details[data-sec="${id}"]`);
      if (!det) return;
      det.open = true;
      const first = det.querySelector(FOCUSABLE);
      if (first) first.focus({ preventScroll: true });
      const scroll = () => det.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      scroll();
      // mount runs before the first layout of a fresh panel: scroll again once it has one
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(scroll);
      for (const x of el.querySelectorAll('.ev2-flash')) x.classList.remove('ev2-flash');
      det.classList.add('ev2-flash');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => det.classList.remove('ev2-flash'), 900);
    };
    applyFocus(opts);

    return {
      update(next) {
        applyFocus(next || {});
      },
      destroy() {
        clearTimeout(flashTimer);
        cancelAnimationFrame(rafId);
        binder.destroy();
        el.replaceChildren();
      },
    };
  },
};
