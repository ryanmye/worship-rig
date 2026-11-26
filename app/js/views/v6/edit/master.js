// UI v6 Edit › Master (U5b; native DECISIONS D18 "Master (Volume & output, Master EQ, Glue, Wheels & pedal)";
// mockup native/docs/design/mockups/edit.html "Master · Wheels & pedal", "Master · Volume & output", mock_edit.py
// master_nav).
//
// Today's Master tab (views/edit/panels/master.js) in the category list, with its addresses: Volume & output (the
// master volume; the output device and latency are this computer's, in Settings, so they show here read only with a
// link), Tape (fx.lofi.*: the mockup has no Tape row, but today's tab has it and nothing is dropped), Master EQ and
// Glue (only when the PARAMS table has fx.eq.* / fx.comp.amount, as today) and Wheels & pedal (song.patch.modWheel /
// expression / volume / bend / swell). The mockup's "Safety limiter" switch does not exist: the engine's output
// ceiling is always on, so it is a line of text. Its "Pitch wheel" is today's Pitch-bend wheel mode.
import { h, setText, wordSlider, hasParam, pct, TARGET_LABELS, BEND_LABELS } from '../../edit/lib.js';
import { describe, formatValue, SLOT_COUNT, slotGainIndex } from '../../../shared/params.js';
import { WHEEL_TARGETS, BEND_MODES } from '../../../presets.js';
import { catPanel, relsDiffer } from './catpanel.js';

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
const PEDAL_CURVE_OPTS = Object.freeze([
  { value: 'linear', label: 'Linear (even)' },
  { value: 'log', label: 'Log (fine when quiet)' },
]);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const seconds = (v) => `${Number(v).toFixed(Number(v) < 10 ? 1 : 0)} s`;
const semis = (v) => `${v} semitone${Number(v) === 1 ? '' : 's'}`;
const defOf = (addr, fallback) => (hasParam(addr) ? describe(addr).default : fallback);
const lofiWord = (v) => (v <= OFF ? 'Off' : v < 0.34 ? 'Subtle' : v < 0.67 ? 'Worn' : 'Heavy');
const glueWord = (v) => (v <= OFF ? 'Off' : v < 0.4 ? 'Gentle' : v < 0.75 ? 'Firm' : 'Tight');
/**
 * What each category's dot compares. The master volume is a live move (the top bar's fader, like an instrument's
 * fader): today's tab never counts it, so Volume & output has no dot.
 */
const DOT_RELS = Object.freeze({
  vol: [],
  tape: ['patch.fx.lofi'],
  meq: ['patch.fx.eq'],
  glue: ['patch.fx.comp'],
  wheels: ['patch.modWheel', 'patch.expression', 'patch.volume', 'patch.bend', 'patch.swell'],
});

/**
 * The Master categories whose dot is on (also the rig tab's dot, edit.js).
 * @param {object|null} s  the song
 * @param {object|null} b  its Revert snapshot
 * @returns {Set<string>}
 */
export function masterChanges(s, b) {
  const out = new Set();
  if (!s || !b) return out;
  for (const c of masterCats()) if (relsDiffer(s, b, DOT_RELS[c.id])) out.add(c.id);
  return out;
}

/**
 * The categories this build has (Master EQ / Glue only with their PARAMS rows, as today's tab).
 * @returns {Array<{id:string, label:string, blurb:string}>}
 */
export function masterCats() {
  return [
    { id: 'vol', label: 'Volume & output', blurb: 'the whole mix, last stop before the speakers' },
    { id: 'tape', label: 'Tape', blurb: 'wow, flutter and crackle over the whole mix' },
    hasParam('fx.eq.low') ? { id: 'meq', label: 'Master EQ', blurb: 'low = warmth, mid = body, high = air' } : null,
    hasParam('fx.comp.amount') ? { id: 'glue', label: 'Glue', blurb: 'gently evens out the whole mix' } : null,
    { id: 'wheels', label: 'Wheels & pedal', blurb: 'what your keyboard’s wheels and pedals do in this song' },
  ].filter(Boolean);
}

/**
 * Mount the v6 Master panel.
 * @param {HTMLElement} host
 * @param {object} ctx  the panel ctx
 * @param {{focus?:string}} opts  today's focus ids: 'wheels' / 'tape' / 'tone' | 'eq' / 'glue'
 * @param {{prefs:{get():string, set(id:string):void}, names:{name(ref:object):string}}} env
 * @returns {{update(o:object):void, destroy():void, _debug:object}}
 */
export function mountMaster(host, ctx, opts, env) {
  const C = ctx.C || {};
  const valueOf = (addr) => ctx.valueOf(addr);
  const MINUS6 = defOf('master.volume', 0.5011872336272722);
  const bands = EQ_BANDS.filter((b) => hasParam(`fx.eq.${b.k}`));
  const cats = masterCats();
  const ws = (binder, addr, o) => binder.ctl(addr, (onChange) => wordSlider({
    min: hasParam(addr) ? describe(addr).min : 0, max: hasParam(addr) ? describe(addr).max : 1,
    default: defOf(addr, o.default), ...o, onChange,
  }));
  /** UIA: 'slots.4.gain' → "Grand Piano level" (D15: the instrument's name, never Keys / Pad …; U4's wording). */
  const targetName = (t, s) => {
    const i = slotGainIndex(t);
    if (i === null) return TARGET_LABELS[t] || t;
    const slot = s?.patch?.slots?.[i];
    return slot ? `${env.names.name(slot.instrument)} level` : `Instrument ${i + 1} level`;
  };
  const shortTarget = (t, s) => targetName(t, s).replace(/\s*\(.*\)$/, '');
  const tapeSummary = () => {
    const v = Number(valueOf('fx.lofi.amount')) || 0;
    return v <= OFF ? 'off' : pct(v);
  };
  const eqMoved = () => bands.filter((b) => Math.abs(Number(valueOf(`fx.eq.${b.k}`)) || 0) >= 0.05);
  const eqSummary = () => {
    const nz = eqMoved();
    return nz.length ? nz.map((b) => `${b.name} ${formatValue(`fx.eq.${b.k}`, valueOf(`fx.eq.${b.k}`))}`).join(' · ')
      : 'flat';
  };
  const glueSummary = () => glueWord(Number(valueOf('fx.comp.amount')) || 0).toLowerCase();
  const volText = () => formatValue('master.volume', valueOf('master.volume'));

  function buildVol(pane) {
    const { binder } = pane;
    const volume = ws(binder, 'master.volume', {
      label: 'Master volume', curve: 'taper', min: 0, max: 2, default: MINUS6,
      word: (v) => formatValue('master.volume', v), format: (v) => (Math.abs(v - MINUS6) < 1e-4 ? 'default' : ''),
      ends: ['silent', '+6 dB'],
    });
    volume.el.dataset.testid = 'v6e-master-volume';
    const out = h('small.v6e-hint', { 'data-testid': 'v6e-master-out' });
    const paintOut = () => {
      const st = ctx.store.get().settings;
      const ms = Number(ctx.controller?.status?.latencyMs) || 0;
      setText(out, `${!st.outputDeviceId || st.outputDeviceId === 'default' ? 'System default' : 'Chosen in Settings'}`
        + `${ms ? ` · ${Math.round(ms)} ms` : ''}`);
    };
    paintOut();
    if (typeof ctx.controller?.onStatus === 'function') pane.offs.push(ctx.controller.onStatus(paintOut));
    const outBtn = h('button.btn.v6e-outbtn', {
      type: 'button', text: 'Audio output…', 'data-testid': 'v6e-master-outbtn',
      title: 'The audio output and its latency are this computer’s: Settings › Audio',
    });
    outBtn.addEventListener('click', () => ctx.openSettings?.({ section: 'audio' }));
    return h('div.v6e-mvol', {}, volume.el,
      h('p.v6e-hint', {
        text: 'Everything you hear goes through here last. Double-click the slider to go back to −6 dB.',
      }),
      h('div.v6e-row', {}, h('span.v6e-cap', { text: 'Output' }), out, h('span.v6e-sp'), outBtn),
      h('p.v6e-hint.v6e-ceiling', { 'data-testid': 'v6e-master-ceiling',
        text: 'Always on: a soft ceiling just below full scale stops sudden loud peaks from clipping.' }));
  }

  function buildTape(pane) {
    const { binder } = pane;
    const amount = ws(binder, 'fx.lofi.amount', {
      label: 'Amount', word: lofiWord, format: pct, ends: ['clean', 'old tape'],
    });
    return h('div.v6e-mtape', {}, amount.el,
      h('p.v6e-hint', { text: 'Wow, flutter and crackle of an old tape machine, over the whole mix.' }),
      h('div.v6e-h5', { text: 'Tape & vinyl details' }),
      ...LOFI_DETAILS.map((d) => ws(binder, `fx.lofi.${d.k}`, { label: d.name, format: pct, ends: d.ends }).el));
  }

  function buildEq(pane) {
    const { binder } = pane;
    return h('div.v6e-meq', {},
      ...bands.map((b) => ws(binder, `fx.eq.${b.k}`, {
        label: b.name, bipolar: true, word: (v) => (Math.abs(v) < 0.05 ? 'Flat' : cap(v > 0 ? b.ends[1] : b.ends[0])),
        format: (v) => formatValue(`fx.eq.${b.k}`, v), ends: b.ends,
      }).el),
      h('p.v6e-hint', { text: 'Whole mix: low = warmth, mid = body, high = air. Double-click a slider to reset.' }));
  }

  function buildGlue(pane) {
    const { binder } = pane;
    return h('div.v6e-mglue', {},
      ws(binder, 'fx.comp.amount', { label: 'Glue', word: glueWord, format: pct, ends: ['untouched', 'glued'] }).el,
      h('p.v6e-hint', { text: 'Gently evens out the whole mix so it sits together. Off = untouched.' }));
  }

  function buildWheels(pane) {
    const { binder } = pane;
    const s0 = ctx.song();
    // UIA: the song's own instrument levels (named by instrument, D15), then the rest; rebuilt on a slot change (key)
    const n = s0?.patch?.slots?.length || SLOT_COUNT;
    const targetOpts = [
      ...Array.from({ length: n }, (_, i) => `slots.${i}.gain`),
      ...WHEEL_TARGETS.filter((t) => !t.startsWith('slots.')),
    ].map((t) => ({ value: t, label: targetName(t, s0) }));
    const sel = (label, addr, options) => {
      const c = binder.ctl(addr, (onChange) => C.select({ label, options, onChange }));
      c.el.classList.add('v6e-msel');
      return c;
    };
    const range = (who, end, addr, def) => {
      const c = ws(binder, addr, { label: end, min: 0, max: 1, default: def, format: pct });
      c.input.setAttribute('aria-label', `${who} ${end.toLowerCase()}`);
      return c;
    };
    const wheelRow = (who, key, extra = []) => {
      const target = sel(`${who} controls`, `song.patch.${key}.target`, targetOpts);
      target.el.dataset.testid = `v6e-master-${key}-target`;
      const from = range(who, 'From', `song.patch.${key}.min`, 0);
      const to = range(who, 'To', `song.patch.${key}.max`, 1);
      binder.fn([`patch.${key}.target`], (s) => {
        const none = s.patch[key].target === 'none';
        from.setDisabled(none);
        to.setDisabled(none);
        for (const x of extra) x.setDisabled?.(none);
      });
      return h('div.v6e-mroute', { dataset: { route: key } }, target.el, from.el, to.el, ...extra.map((x) => x.el));
    };
    const pedalCurve = binder.ctl('song.patch.expression.curve', (onChange) => C.select({
      label: 'Pedal curve', options: PEDAL_CURVE_OPTS, onChange,
    }), { read: (s) => s.patch.expression.curve || 'linear', rels: ['patch.expression'] });
    pedalCurve.el.classList.add('v6e-msel');
    const pedalSwell = binder.ctl('song.patch.swell.pedal', (onChange) => C.toggle({
      label: 'Sustain pedal also swells the drone',
      title: 'While you hold the sustain pedal, the drone rises toward full level; it sinks back when you let go',
      onChange,
    }), { read: (s) => s.patch.swell.pedal === true, write: (v) => ctx.set('song.patch.swell.pedal', !!v),
      rels: ['patch.swell'] });
    const bendMode = sel('Pitch-bend wheel', 'song.patch.bend.mode',
      BEND_MODES.map((m) => ({ value: m, label: BEND_LABELS[m] || m })));
    bendMode.el.dataset.testid = 'v6e-master-bend';
    const bendRange = binder.ctl('song.patch.bend.range', (onChange) =>
      C.stepper({ label: 'Bend range', min: 0, max: 24, step: 1, format: semis, onChange }));
    const swell = ws(binder, 'song.patch.swell.seconds', {
      label: 'Swell time', min: 1, max: 60, curve: 'log', default: 8,
      word: (v) => (v < 3 ? 'Quick' : v < 12 ? 'Medium' : 'Slow'), format: seconds, ends: ['1 s', '60 s'],
    });
    swell.el.dataset.testid = 'v6e-master-swell';
    return h('div.v6e-mwheels', {},
      wheelRow('Mod wheel', 'modWheel'),
      wheelRow('Expression pedal', 'expression', [pedalCurve]),
      h('div.v6e-mroute', { dataset: { route: 'volume' } }, sel('Volume knob controls', 'song.patch.volume.target',
        targetOpts).el),
      h('div.v6e-mroute', { dataset: { route: 'bend' } }, bendMode.el, bendRange.el),
      swell.el,
      h('div.v6e-row', { dataset: { route: 'pedal' } }, pedalSwell.el),
      h('p.v6e-hint', { text: 'Saved with this song. Swell time is how long the Swell button takes to bring the sound '
        + 'in. Which instruments the sustain pedal holds is each strip’s Sustain button.' }));
  }

  const panel = catPanel(host, ctx, {
    kind: 'master',
    color: 'var(--label, var(--muted))',
    cats,
    initial: env.prefs.get(),
    remember: (id) => env.prefs.set(id),
    key: (id, s) => (id === 'wheels'
      ? (s?.patch?.slots || []).map((sl) => (sl ? sl.instrument.id : '-')).join(',') : ''),
    build(id, pane) {
      if (id === 'vol') return buildVol(pane);
      if (id === 'tape') return buildTape(pane);
      if (id === 'meq') return buildEq(pane);
      if (id === 'glue') return buildGlue(pane);
      return buildWheels(pane);
    },
    summary(id, s) {
      if (id === 'vol') return volText();
      if (id === 'tape') return tapeSummary();
      if (id === 'meq') return eqSummary();
      if (id === 'glue') return glueSummary();
      return `mod wheel → ${shortTarget(s.patch.modWheel.target, s)}`;
    },
    changes: () => masterChanges(ctx.song(), ctx.editState.baseline),
    sentence() {
      const parts = ['Everything comes out at ', { text: volText(), cat: 'vol' },
        ', with tape ', { text: tapeSummary(), cat: 'tape' }];
      if (bands.length) parts.push(', tone ', { text: eqMoved().length ? 'shaped' : 'flat', cat: 'meq' });
      if (cats.some((c) => c.id === 'glue')) parts.push(' and glue ', { text: glueSummary(), cat: 'glue' });
      parts.push('.');
      return parts;
    },
  });

  const FOCUS = { wheels: 'wheels', tape: 'tape', tone: 'meq', eq: 'meq', glue: 'glue', volume: 'vol' };
  const applyFocus = (f) => {
    const id = FOCUS[f];
    if (!id || !cats.some((c) => c.id === id)) return;
    panel.choose(id);
    panel.focusIn(host.querySelector('.v6e-pane')?.firstElementChild);
  };
  applyFocus(opts?.focus);

  return {
    update(next = {}) {
      applyFocus(next.focus);
    },
    destroy() {
      panel.destroy();
    },
    _debug: { cat: () => panel.cat(), choose: (id) => panel.choose(id, { persist: true }) },
  };
}
