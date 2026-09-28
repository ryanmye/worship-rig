// OWNER: effects agent (views/edit/CONTRACT.md §6 "effects"). The Effects tab (design/H-v2 concept §1(1),
// implementation.md "Effects panel", mockup edit-effects.png): three plain-words lines (Space / Echo / Chorus), each
// with its choices, a Fine-tune section and "How much of each sound goes in" (the same step chips as Perform), a
// "Vibe" menu in the title bar and a "Tape & finish" footer link to the Master tab.
// Logic copied from views/edit.js (presetPicker, the delay sync note, fxSec) so the old view keeps working untouched.
import {
  h, icon, setText, sentence, createBinder, section, wordSlider, getIn, relOf, hasParam, pct, BLOCKS, changedDot,
  changeText, sameVal, chorusWord,
} from '../lib.js';
import { SPACE_PRESETS, ECHO_PRESETS, VIBE_PRESETS, matchPreset, applyPreset } from '../../../shared/fx-presets.js';
import { describe, formatValue, SLOT_COUNT } from '../../../shared/params.js';

// ---------------------------------------------------------------------------------------------------------------
// copy (concept §5 4a: a word + a small hint; ms only appear in Edit)
const SYNC_OPTS = [
  { value: 'off', label: 'Free time' },
  { value: '1/4', label: 'Quarter notes' },
  { value: '1/8d', label: 'Dotted eighths' },
  { value: '1/8', label: 'Eighth notes' },
];
const SYNC_NAMES = { '1/4': 'Quarter notes', '1/8d': 'Dotted eighths', '1/8': 'Eighth notes' };
const SYNC_SHORT = { '1/4': 'quarters', '1/8d': 'dotted 8ths', '1/8': 'eighths' };
const SYNC_BEATS = { '1/4': 1, '1/8d': 0.75, '1/8': 0.5 };
const SPACE_HINTS = { dry: 'none', room: 'small', stage: 'medium', hall: 'big', cathedral: 'huge', wash: 'pad-only' };
/** Echo chips in mockup order; `id` = ECHO_PRESETS id. "Song's own" is appended separately. */
const ECHO_CHIPS = [
  { id: 'none', name: 'Off', hint: 'no echo', words: ['', 'off'] },
  { id: 'slapback', name: 'Slapback', hint: '1 repeat', words: ['a ', 'slapback'] },
  { id: 'quarter', name: 'Quarter', hint: 'on the beat', words: ['', 'quarter notes'] },
  { id: 'dotted', name: 'Dotted 8th', hint: 'worship echo', words: ['', 'dotted 8ths'] },
  { id: 'ambient-echo', name: 'Trails', hint: 'long, dark', words: ['', 'long trails'] },
];
const OWN = 'the song’s own';
const DELAY_KEYS = ['time', 'feedback', 'pingpong', 'tone', 'sync', 'returnGain'];
const UNITS = [
  { unit: 'reverb', name: 'Space', icon: 'room', sec: 'fx-reverb' },
  { unit: 'delay', name: 'Echo', icon: 'echo', sec: 'fx-delay' },
  { unit: 'chorus', name: 'Chorus', icon: 'chorus', sec: 'fx-chorus' },
];
const FX_PREFIXES = ['patch.fx.reverb', 'patch.fx.delay', 'patch.fx.chorus'];
const FALLBACK_STEPS = [1, 0.75, 0.5, 0.25, 0].map((v) => ({ value: v, label: v ? `${v * 100}%` : 'Off' }));
const SUB = 'Three effects every sound shares. Each sound’s Space / Echo / Chorus chip decides how much of it goes in.';

// word scales (same thresholds as the shell's wiring lane for chorus, so "gentle" means the same everywhere)
const band = (v, cuts, words) => {
  const n = Number(v) || 0;
  for (let k = 0; k < cuts.length; k++) if (n < cuts[k]) return words[k];
  return words[words.length - 1];
};
const sizeWord = (v) => band(v, [0.25, 0.5, 0.75], ['Small', 'Medium', 'Large', 'Huge']);
const darkWord = (v) => band(v, [0.35, 0.6], ['Bright', 'Medium', 'Dark']);
const preWord = (v) => band(v, [0.012, 0.04], ['Tight', 'Short', 'Long']);
const repeatsWord = (v) => band(v, [0.15, 0.35, 0.6], ['One', 'Few', 'Several', 'Many']);
const toneWord = (v) => band(v, [0.35, 0.6], ['Dark', 'Medium', 'Bright']);
const timeWord = (v) => band(v, [0.15, 0.5], ['Short', 'Medium', 'Long']);
const speedWord = (v) => band(v, [0.6, 1.5], ['Slow', 'Medium', 'Fast']);
const levelWord = (v) => (Number(v) <= 0.0001 ? 'Off' : band(v, [0.5, 1.2], ['Low', 'Normal', 'Loud']));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const article = (name) => (/^[aeiou]/i.test(name) ? 'an ' : 'a ');
const ms = (s) => `${Math.round(Number(s) * 1000)} ms`;
const fmtAmount = (v) => (Number(v) > 0.0005 ? `${Math.round(Number(v) * 100)}%` : 'off');

/**
 * A minimal amount chip for the fallback component set (no ui-core stepChip): a tap steps 100 → 75 → … → Off.
 * @returns {{el:HTMLButtonElement, set(v:number):void, setLoaded():void, setHint():void, setDisabled(b:boolean):void,
 *            destroy():void}}
 */
function plainChip(o) {
  let v = 0;
  const val = h('b');
  const el = h('button.ev2-fx-plainchip', { type: 'button' }, h('span', { text: o.label }), val);
  const render = () => {
    setText(val, fmtAmount(v));
    el.setAttribute('aria-label', `${o.owner} ${o.label}: ${fmtAmount(v)}`);
  };
  el.addEventListener('click', () => {
    const k = FALLBACK_STEPS.findIndex((s) => Math.abs(s.value - v) < 0.005);
    v = FALLBACK_STEPS[(k + 1) % FALLBACK_STEPS.length].value;
    render();
    o.onChange(v);
  });
  render();
  return {
    el,
    set(x) {
      v = Number(x) || 0;
      render();
    },
    setLoaded() {},
    setHint() {},
    setDisabled(b) {
      el.disabled = !!b;
    },
    destroy() {
      el.remove();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
export default {
  id: 'effects',
  icon: 'room',
  /**
   * Mount the Effects tab.
   * @param {HTMLElement} el
   * @param {object} ctx   panel ctx (CONTRACT.md §3)
   * @param {{focus?:'reverb'|'delay'|'chorus'}} opts
   * @returns {{update(opts:object):void, destroy():void}}
   */
  mount(el, ctx, opts = {}) {
    const C = ctx.C || {};
    const { editState } = ctx;
    const binder = createBinder(ctx);
    const val = (addr) => ctx.valueOf(addr);
    const set = (path, v) => ctx.set(path, v);
    let dead = false;
    let flashTimer = 0;

    // in-body token / focus helper (same behaviour as the shell's title tokens: open, scroll, focus, flash)
    const focusEl = (target, { flash = target } = {}) => {
      if (!(target instanceof Element)) return;
      const det = target.closest('details');
      if (det && !det.open) det.open = true;
      target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      const f = target.matches('button, input, select, [tabindex]')
        ? target
        : target.querySelector('button:not(:disabled), input:not(:disabled), select, [tabindex]');
      if (f) f.focus({ preventScroll: true });
      for (const x of el.querySelectorAll('.ev2-flash')) x.classList.remove('ev2-flash');
      flash.classList.add('ev2-flash');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => flash.classList.remove('ev2-flash'), 900);
    };
    const resolve = (c) => (typeof c === 'function' ? c() : typeof c === 'string' ? el.querySelector(c) : c);
    const onToken = (part) => focusEl(resolve(part.control));

    // ---- step-panel host: an overlay over the "who goes in" column of all three lines, so a chip's step panel
    // opens inside that column (implementation §2: "the step panel stays inside its column at 1024").
    const sphost = h('div.ev2-fx-sphost', { dataset: { dir: 'up' } });
    const placePanel = (chip) => {
      const hr = sphost.getBoundingClientRect();
      const cr = chip.el.getBoundingClientRect();
      const need = globalThis.matchMedia?.('(max-width: 1250px)').matches ? 220 : 290;
      const below = hr.bottom - cr.bottom;
      const above = cr.top - hr.top;
      sphost.dataset.dir = below >= need + 10 ? 'down' : above >= need + 10 ? 'up' : 'cover';
      sphost.style.setProperty('--ev2-fx-sp-top', `${Math.round(cr.bottom - hr.top + 10)}px`);
      return sphost;
    };

    // ---- "How much of each sound goes in": the Perform strip's Space/Echo/Chorus chip, one per slot
    const who = { reverb: [], delay: [], chorus: [] };
    const makeChip = (o) => (typeof C.stepChip === 'function'
      ? C.stepChip({
        steps: C.AMOUNT_STEPS || FALLBACK_STEPS,
        format: C.formatAmount || fmtAmount,
        lit: (v) => Number(v) > 0.0005,
        amount: (v) => Number(v) || 0,
        fine: { min: 0, max: 1, format: (v) => `${Math.round(v * 100)}%` },
        footnote: 'Tap a step: done. Slide for in-between.',
        ...o,
      })
      : plainChip(o));
    const whoCol = (u) => {
      const mods = h('div.ev2-fx-mods', {
        role: 'group', 'aria-label': `How much of each sound goes into the ${u.name}`,
      });
      for (let i = 0; i < SLOT_COUNT; i++) {
        const role = BLOCKS[i].role;
        const rel = `patch.slots.${i}.sends.${u.unit}`;
        let chip = null;
        chip = binder.ctl(`slots.${i}.sends.${u.unit}`, (onChange) => makeChip({
          label: role,
          owner: u.name,
          color: `var(--slot-${i})`,
          hint: `how much of the ${role} goes into the ${u.name}`,
          testid: `fx-${u.unit}-${i}`,
          onChange,
          mount: () => placePanel(chip),
        }), { read: (s) => (s.patch.slots[i] ? Number(getIn(s, rel)) || 0 : 0) });
        chip.el.classList.add('ev2-fx-mod');
        chip.el.dataset.slot = String(i);
        who[u.unit].push(chip);
        mods.append(chip.el);
      }
      return h('div.ev2-fx-who', {}, h('span.ev2-cap.ev2-fx-who-cap', {},
        'How much ', h('span.ev2-fx-who-x', { text: 'of each sound ' }), 'goes in'), mods);
    };

    // ---- preset chips (Space / Echo); the Vibe menu is in the title bar
    const chipRow = (kind, label, items) => {
      const row = h('div.ev2-fx-pchips', {
        role: 'group', 'aria-label': `${label} presets`, dataset: { preset: kind },
      });
      const btns = new Map();
      for (const it of items) {
        const b = h('button.ev2-fx-pc', {
          type: 'button', 'aria-pressed': 'false', title: it.title || '', dataset: { id: it.id },
        }, h('span.ev2-fx-pc-name', { text: it.name }), h('small.ev2-fx-pc-hint', { text: it.hint }));
        b.addEventListener('click', it.apply);
        btns.set(it.id, b);
        row.append(b);
      }
      return {
        row,
        btns,
        mark(id) {
          for (const [k, b] of btns) b.setAttribute('aria-pressed', String(k === id));
        },
        current: () => [...btns.values()].find((b) => b.getAttribute('aria-pressed') === 'true') || null,
      };
    };
    const space = chipRow('space', 'Space', SPACE_PRESETS.map((p) => ({
      id: p.id, name: p.name, hint: SPACE_HINTS[p.id] || '', title: p.blurb, apply: () => applyPreset(p, set),
    })));
    const baseDelay = (k) => {
      const b = editState.baseline;
      if (!b) return undefined;
      const v = getIn(b, relOf(`fx.delay.${k}`));
      return v === undefined ? describe(`fx.delay.${k}`)?.default : v;
    };
    // "Song's own" writes back only the baseline's fx.delay.* (CONTRACT §6 effects)
    const applyOwn = () => {
      if (!editState.baseline) return;
      for (const k of DELAY_KEYS) set(`fx.delay.${k}`, baseDelay(k));
    };
    const echo = chipRow('echo', 'Echo', [
      ...ECHO_CHIPS.map((c) => {
        const p = ECHO_PRESETS.find((x) => x.id === c.id);
        return { id: c.id, name: c.name, hint: c.hint, title: p.blurb, apply: () => applyPreset(p, set) };
      }),
      { id: 'own', name: 'Song’s own', hint: 'as saved', title: 'The echo this song was saved with', apply: applyOwn },
    ]);
    const ownBtn = echo.btns.get('own');

    // ---- Fine-tune sections (word sliders + the few non-slider controls)
    const ws = (addr, o) => binder.ctl(addr, (onChange) => wordSlider({
      min: describe(addr).min, max: describe(addr).max, default: describe(addr).default, onChange, ...o,
    }));
    const lvl = (addr) => ws(addr, {
      label: 'Level', curve: 'taper', word: levelWord, format: (v) => formatValue(addr, v), ends: ['off', 'loud'],
    });
    const fine = (id, rels, summary, ...kids) =>
      section(id, 'Fine-tune', { rels, binder, summary, cls: 'ev2-fx-fine' }, ...kids);
    const lvlSum = (addr) => (Number(val(addr)) <= 0.0001 ? 'level off' : `level ${formatValue(addr, val(addr))}`);

    const revSec = fine('fx-reverb', ['patch.fx.reverb'],
      () => `size ${sizeWord(val('fx.reverb.size'))} · darkness ${darkWord(val('fx.reverb.damp'))} · pre-delay ${
        preWord(val('fx.reverb.predelay'))} · ${lvlSum('fx.reverb.returnGain')}`,
      ws('fx.reverb.size', { label: 'Size', word: sizeWord, format: pct, ends: ['small', 'huge'] }).el,
      ws('fx.reverb.damp', { label: 'Darkness', word: darkWord, format: pct, ends: ['bright', 'dark'] }).el,
      ws('fx.reverb.predelay', { label: 'Pre-delay', word: preWord, format: ms, ends: ['tight', 'late'] }).el,
      lvl('fx.reverb.returnGain').el,
    );

    const timing = binder.ctl('fx.delay.sync',
      (onChange) => C.select({ label: 'Timing', options: SYNC_OPTS, onChange }));
    timing.el.classList.add('ev2-fx-timing');
    const delayTime = ws('fx.delay.time', {
      label: 'Time', curve: 'log', word: timeWord, ends: ['short', 'long'],
      format: (v) => formatValue('fx.delay.time', v),
    });
    const tempoLink = h('button.ev2-fx-link', { type: 'button', text: 'set one' });
    tempoLink.addEventListener('click', () => ctx.select('song', { focus: 'tempo' }));
    const noteText = h('span');
    const delayNote = h('p.ev2-hint.ev2-fx-delay-note', { 'aria-live': 'polite' }, noteText);
    const pingpong = binder.ctl('fx.delay.pingpong',
      (onChange) => C.toggle({ label: 'Ping-pong (left/right)', onChange }));
    const delSec = fine('fx-delay', ['patch.fx.delay', 'tempo'], () => {
      const sync = val('fx.delay.sync');
      const t = sync && sync !== 'off' ? `timing ${SYNC_NAMES[sync] || sync}` : `time ${ms(val('fx.delay.time'))}`;
      return `${t} · repeats ${repeatsWord(val('fx.delay.feedback'))} · tone ${toneWord(val('fx.delay.tone'))} · ${
        lvlSum('fx.delay.returnGain')}${val('fx.delay.pingpong') ? ' · ping-pong' : ''}`;
    },
    h('div.ev2-fx-timecol', {}, timing.el, delayNote),
    delayTime.el,
    ws('fx.delay.feedback', { label: 'Repeats', word: repeatsWord, format: pct, ends: ['one', 'many'] }).el,
    ws('fx.delay.tone', { label: 'Tone', word: toneWord, format: pct, ends: ['dark', 'bright'] }).el,
    lvl('fx.delay.returnGain').el,
    pingpong.el,
    );

    const depth = ws('fx.chorus.depth', {
      label: 'Depth', word: (v) => cap(chorusWord(v)), format: pct, ends: ['subtle', 'deep'],
    });
    const speed = ws('fx.chorus.rate', {
      label: 'Speed', curve: 'log', word: speedWord, ends: ['slow', 'fast'],
      format: (v) => formatValue('fx.chorus.rate', v),
    });
    const choSec = fine('fx-chorus', ['patch.fx.chorus'], () => lvlSum('fx.chorus.returnGain'),
      lvl('fx.chorus.returnGain').el);

    // ---- the three lines
    const line = (u, choices) => {
      const title = h('div.ev2-fx-lt-title');
      const blurb = h('p.ev2-fx-blurb');
      const node = h('section.ev2-fx-line', { dataset: { line: u.unit }, 'aria-label': u.name },
        h('div.ev2-fx-lt', {}, icon(u.icon, 22), h('div.ev2-fx-lt-text', {}, title, blurb)),
        h('div.ev2-fx-choices', {}, ...choices),
        whoCol(u),
      );
      let key = '';
      return {
        node,
        blurb,
        setTitle(parts) {
          const k = JSON.stringify(parts.map((p) => (typeof p === 'string' ? p : [p.text, !!p.changed])));
          if (k === key) return;
          key = k;
          title.replaceChildren(sentence(parts, { onToken }));
        },
      };
    };
    const lines = {
      reverb: line(UNITS[0], [space.row, revSec]),
      delay: line(UNITS[1], [echo.row, delSec]),
      chorus: line(UNITS[2], [h('div.ev2-fx-sl2', {}, depth.el, speed.el), choSec]),
    };
    const linesEl = h('div.ev2-fx-lines', {}, lines.reverb.node, lines.delay.node, lines.chorus.node, sphost);

    // ---- Vibe menu (title bar action; CONTRACT §5 menus)
    const vibeLabel = h('span.ev2-fx-vibe-label', { text: 'Vibe: Custom' });
    const vibeBtn = h('button.ev2-btn.sm.ev2-fx-vibe-btn', {
      type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', dataset: { vibe: '' },
    }, icon('dots', 16), vibeLabel);
    const vibeMenu = h('div.ev2-fx-vibe-menu', { role: 'menu', 'aria-label': 'Vibe presets', hidden: true });
    const vibeItems = VIBE_PRESETS.map((p) => {
      const b = h('button.ev2-fx-vibe-item', {
        type: 'button', role: 'menuitem', tabindex: '-1', dataset: { id: p.id },
      },
        h('b', { text: p.name }), h('small', { text: p.blurb }));
      b.addEventListener('click', (e) => {
        applyPreset(p, set);
        closeMenu(e.detail === 0);
      });
      vibeMenu.append(b);
      return b;
    });
    const vibeWrap = h('div.ev2-fx-vibe', {}, vibeBtn, vibeMenu);
    let offEsc = null;
    let offOutside = null;
    function closeMenu(refocus) {
      if (vibeMenu.hidden) return;
      vibeMenu.hidden = true;
      vibeBtn.setAttribute('aria-expanded', 'false');
      ctx.markDialog(false, 'fx-vibe');
      offEsc?.();
      offOutside?.();
      offEsc = offOutside = null;
      if (refocus) vibeBtn.focus();
    }
    function openMenu() {
      if (!vibeMenu.hidden) return;
      vibeMenu.hidden = false;
      vibeBtn.setAttribute('aria-expanded', 'true');
      ctx.markDialog(true, 'fx-vibe');
      offEsc = ctx.onEscape(() => {
        closeMenu(true);
        return true;
      });
      offOutside = ctx.listen(document, 'pointerdown', (e) => {
        if (!vibeWrap.contains(e.target)) closeMenu(false);
      }, true);
      (vibeItems.find((b) => b.classList.contains('on')) || vibeItems[0])?.focus();
    }
    vibeBtn.addEventListener('click', () => (vibeMenu.hidden ? openMenu() : closeMenu(false)));
    vibeMenu.addEventListener('keydown', (e) => {
      const i = vibeItems.indexOf(document.activeElement);
      let j = -1;
      if (e.key === 'ArrowDown') j = Math.min(vibeItems.length - 1, i + 1);
      else if (e.key === 'ArrowUp') j = Math.max(0, i - 1);
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = vibeItems.length - 1;
      else if (e.key === 'Tab') closeMenu(false);
      if (j < 0) return;
      e.preventDefault();
      e.stopPropagation(); // arrows never reach song navigation / the mod wheel (CONTRACT §5)
      vibeItems[j].focus();
    });

    // ---- footer: Tape & finish (Master tab) + change line
    const tapeSum = h('span.ev2-fx-tape-sum');
    const tapeBtn = h('button.ev2-fx-tape', { type: 'button', title: 'Open the Master tab' },
      icon('right', 16), h('b', { text: 'Tape & finish' }), tapeSum);
    tapeBtn.addEventListener('click', () => ctx.select('master', { focus: 'tape' }));
    const chgText = h('span');
    const chg = h('span.ev2-chg', {}, changedDot(), chgText);
    const foot = h('div.ev2-foot.ev2-fx-foot', {}, tapeBtn, chg);
    const renderChanges = () => {
      const n = editState.changeCount(FX_PREFIXES);
      setText(chgText, changeText(n));
      chg.classList.toggle('none', n === 0);
    };

    el.replaceChildren(h('div.ev2-fx', {}, linesEl, foot));

    // ---- render: everything derived from the fx values, the slots and the baseline
    const isOwnDelay = () => {
      if (!editState.baseline) return false;
      return DELAY_KEYS.every((k) => {
        const a = val(`fx.delay.${k}`);
        const b = baseDelay(k);
        return typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6 : sameVal(a, b);
      });
    };
    const baseEchoCustom = () => !!editState.baseline && !matchPreset(ECHO_PRESETS, (p) => baseDelay(p.split('.')[2]));
    let headKey = '';
    const render = () => {
      const s = ctx.song();
      if (!s || dead) return;
      const sp = matchPreset(SPACE_PRESETS, val);
      const ec = matchPreset(ECHO_PRESETS, val);
      const vibe = matchPreset(VIBE_PRESETS, val);
      const echoChip = ec ? ECHO_CHIPS.find((c) => c.id === ec.id) : null;
      const own = !ec && isOwnDelay();
      const sync = val('fx.delay.sync');
      const synced = !!sync && sync !== 'off';
      const chorusOn = Number(val('fx.chorus.returnGain')) > 0.0001;
      const cword = chorusWord(val('fx.chorus.depth'));
      const revChanged = editState.isChanged('patch.fx.reverb');
      const delChanged = editState.isChanged('patch.fx.delay');

      // Space line
      space.mark(sp ? sp.id : null);
      const roomWords = sp ? (sp.id === 'dry' ? ['', 'dry'] : [article(sp.name), sp.name]) : ['', OWN];
      lines.reverb.setTitle(['The room is ', roomWords[0],
        { text: roomWords[1], control: revSec, changed: revChanged }]);
      setText(lines.reverb.blurb, sp ? sp.blurb : 'A room saved with this song. Pick one above, or fine-tune it.');

      // Echo line ("Song's own" only when the baseline's echo matches no preset; concept §5 5b/5c)
      const showOwn = baseEchoCustom();
      ownBtn.hidden = !showOwn;
      if (showOwn) {
        const bs = baseDelay('sync');
        setText(ownBtn.querySelector('.ev2-fx-pc-hint'),
          bs && bs !== 'off' ? SYNC_SHORT[bs] || bs : ms(baseDelay('time')));
      }
      echo.mark(ec ? ec.id : own && showOwn ? 'own' : null);
      const echoWords = echoChip ? echoChip.words : ['', OWN];
      lines.delay.setTitle(['The echo is ', echoWords[0],
        { text: echoWords[1], control: delSec, changed: delChanged }]);
      let eb;
      if (ec) eb = ec.blurb;
      else if (synced) eb = `${SYNC_NAMES[sync] || sync} saved with this song, so it follows the tempo.`;
      else eb = `A fixed ${ms(val('fx.delay.time'))} echo saved with this song, so it doesn’t follow the tempo.`;
      setText(lines.delay.blurb, eb);
      delayTime.setDisabled(synced);
      tempoLink.remove();
      if (!synced) {
        setText(noteText, '');
        delayNote.hidden = true;
      } else if (!s.tempo) {
        delayNote.hidden = false;
        setText(noteText, `${SYNC_NAMES[sync]} need the song’s tempo — `);
        delayNote.append(tempoLink);
      } else {
        delayNote.hidden = false;
        const t = Math.round(s.tempo);
        const at = Math.round((60 / s.tempo) * SYNC_BEATS[sync] * 1000);
        setText(noteText, `${SYNC_NAMES[sync]} at ${t} BPM = ${at} ms`);
      }

      // Chorus line
      lines.chorus.setTitle(['The chorus is ', { text: chorusOn ? cword : 'off', control: choSec }]);
      const rate = Number(val('fx.chorus.rate')) || 0;
      setText(lines.chorus.blurb, chorusOn
        ? `${rate < 0.6 ? 'A slow shimmer' : rate < 1.5 ? 'A steady shimmer' : 'A fast wobble'}. `
          + 'Mostly for pads and electric piano.'
        : 'Off for this song. Raise its level in Fine-tune to use it.');

      // who-goes-in chips: empty slots show a disabled "off"; the Space hint names the room (concept §5 4b)
      const b = editState.baseline;
      for (const u of UNITS) {
        who[u.unit].forEach((chip, i) => {
          const filled = !!s.patch.slots[i];
          chip.setDisabled(!filled);
          chip.el.classList.toggle('ev2-fx-empty', !filled);
          chip.el.title = filled ? '' : 'No sound in this slot';
          const bs = b && b.patch && b.patch.slots ? b.patch.slots[i] : null;
          chip.setLoaded(bs ? Number(getIn(bs, `sends.${u.unit}`)) || 0 : undefined);
          if (u.unit === 'reverb') {
            chip.setHint(`how much of the ${BLOCKS[i].role} goes into the Space${sp ? ` (${sp.name})` : ''}`);
          }
        });
      }

      // Vibe + header sentence
      setText(vibeLabel, `Vibe: ${vibe ? vibe.name : 'Custom'}`);
      for (const it of vibeItems) {
        const on = !!vibe && it.dataset.id === vibe.id;
        it.classList.toggle('on', on);
        if (on) it.setAttribute('aria-current', 'true');
        else it.removeAttribute('aria-current');
      }
      const senders = [];
      for (let i = 0; i < SLOT_COUNT; i++) {
        if (s.patch.slots[i] && Number(getIn(s, `patch.slots.${i}.sends.chorus`)) > 0.0005) senders.push(i);
      }
      const parts = [
        'The room is ', roomWords[0],
        { text: roomWords[1], control: () => space.current() || space.row, changed: revChanged },
        ', the echo is ', echoWords[0],
        { text: echoWords[1], control: () => echo.current() || echo.row, changed: delChanged },
      ];
      if (!chorusOn || !senders.length) {
        parts.push(', and no ', { text: 'chorus', control: () => depth.el });
      } else {
        const names = senders.map((i) => BLOCKS[i].role).join(' + ');
        parts.push(', and ', senders.length === 1 ? 'the ' : '', {
          text: names,
          control: () => who.chorus[senders[0]].el,
          changed: senders.some((i) => editState.isChanged(`patch.slots.${i}.sends.chorus`)),
        }, ` ${senders.length === 1 ? 'has' : 'have'} a ${cword} `, { text: 'chorus', control: () => depth.el });
      }
      const k = JSON.stringify([parts.map((p) => (typeof p === 'string' ? p : [p.text, !!p.changed]))]);
      if (k !== headKey) {
        headKey = k;
        ctx.setTitle(parts, { icon: 'room', sub: SUB, actions: vibeWrap });
      }

      // footer: Tape & finish summary (these live on the Master tab) + change count
      const lofi = Number(val('fx.lofi.amount')) || 0;
      const bits = [`Tape ${lofi > 0.0001 ? pct(lofi) : 'off'}`];
      const eq = ['low', 'mid', 'high'].filter((x) => hasParam(`fx.eq.${x}`));
      const shaped = eq.some((x) => Math.abs(Number(val(`fx.eq.${x}`)) || 0) >= 0.05);
      if (eq.length) bits.push(`Tone ${shaped ? 'shaped' : 'flat'}`);
      if (hasParam('fx.comp.amount')) {
        const g = Number(val('fx.comp.amount')) || 0;
        bits.push(`Glue ${g > 0.0001 ? pct(g) : 'off'}`);
      }
      setText(tapeSum, `${bits.join(' · ')} · these live on the Master tab`);
      renderChanges();
    };
    binder.fn(['patch.fx', 'patch.slots', 'tempo'], render); // the binder also re-runs it on a song switch / full
    ctx.listen(editState, 'changes', render);
    ctx.listen(ctx.controller, 'songSelected', render); // a new baseline (Revert snapshot) → loaded marks, Song's own
    ctx.onLeaveSong(() => {
      closeMenu(false);
      for (const u of UNITS) for (const c of who[u.unit]) c.close?.();
    });

    // ---- focus (wiring lanes send {focus:'reverb'|'delay'|'chorus'})
    const focusLine = (f) => {
      const l = lines[f];
      if (!l) return;
      const target = f === 'reverb' ? space.current() || space.row
        : f === 'delay' ? echo.current() || echo.row
          : depth.el;
      focusEl(target, { flash: l.node });
      l.node.scrollIntoView?.({ block: 'nearest' });
    };
    if (opts.focus) requestAnimationFrame(() => !dead && focusLine(opts.focus));

    return {
      update(o = {}) {
        if (o.focus) focusLine(o.focus);
      },
      destroy() {
        dead = true;
        clearTimeout(flashTimer);
        closeMenu(false);
        binder.destroy();
      },
    };
  },
};
