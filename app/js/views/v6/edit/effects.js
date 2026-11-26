// UI v6 Edit › Effects (U5b; native DECISIONS D18 "Effects (Space, Echo, Sends table)"; mockup
// native/docs/design/mockups/edit.html "Effects · Space", "Effects · Sends", mock_edit.py fx_nav).
//
// Today's Effects tab (views/edit/panels/effects.js) in the category list: Space (the room choices + Song's own and
// the fine-tune sliders), Echo (the echo choices + Song's own, timing, time, repeats, tone, level, ping-pong),
// Chorus (today's chorus line and its per-instrument amounts: the mockup has no Chorus row, but today's tab has it and
// nothing is dropped) and Sends (one row per instrument with its Space and Echo amount: the strip chips' paths,
// slots.<i>.sends.reverb / delay). The Vibe menu sits in the head. Same addresses, preset writes (fx-presets.js
// applyPreset) and "Song's own" whole-object write as today's tab; no engine call.
import { h, setText, wordSlider, getIn, relOf, sameVal, chorusWord, pct } from '../../edit/lib.js';
import { SPACE_PRESETS, ECHO_PRESETS, VIBE_PRESETS, matchPreset, applyPreset } from '../../../shared/fx-presets.js';
import { describe, formatValue, MAX_SLOTS } from '../../../shared/params.js';
import { slotColor } from '../lib.js';
import { catPanel, relsDiffer, instrumentRow } from './catpanel.js';

export const EFFECTS_CATS = Object.freeze([
  { id: 'space', label: 'Space', blurb: 'the room everything plays in' },
  { id: 'echo', label: 'Echo', blurb: 'repeats every instrument can send into' },
  { id: 'chorus', label: 'Chorus', blurb: 'a shimmer, mostly for pads and electric piano' },
  { id: 'sends', label: 'Sends', blurb: 'how much of each instrument goes into Space and Echo' },
]);

// ---- today's words and choices (views/edit/panels/effects.js)
const SYNC_OPTS = [
  { value: 'off', label: 'Free time' },
  { value: '1/4', label: 'Quarter notes' },
  { value: '1/8d', label: 'Dotted eighths' },
  { value: '1/8', label: 'Eighth notes' },
];
const SYNC_NAMES = { '1/4': 'Quarter notes', '1/8d': 'Dotted eighths', '1/8': 'Eighth notes' };
const SYNC_SHORT = { '1/4': 'quarters', '1/8d': 'dotted 8ths', '1/8': 'eighths' };
const SYNC_BEATS = { '1/4': 1, '1/8d': 0.75, '1/8': 0.5 };
const SPACE_HINTS = { dry: 'no room', room: 'small, close', stage: 'medium', hall: 'big, warm', cathedral: 'huge, long',
  wash: 'pad-only' };
const ECHO_CHIPS = [
  { id: 'none', name: 'Off', hint: 'no echo', words: 'no echo' },
  { id: 'slapback', name: 'Slapback', hint: '1 repeat', words: 'a slapback echo' },
  { id: 'quarter', name: 'Quarter', hint: 'on the beat', words: 'a quarter-note echo' },
  { id: 'dotted', name: 'Dotted 8th', hint: 'worship echo', words: 'a dotted-8th echo' },
  { id: 'ambient-echo', name: 'Trails', hint: 'long, dark', words: 'long echo trails' },
];
const OWN_MIX = 'your own mix';
const DELAY_KEYS = ['time', 'feedback', 'pingpong', 'tone', 'sync', 'returnGain'];
const REVERB_KEYS = ['size', 'damp', 'predelay', 'returnGain'];
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
const amount = (v) => (Number(v) > 0.0005 ? pct(v) : 'off');
const slotsOf = (s) => (s && Array.isArray(s.patch?.slots) ? s.patch.slots.slice(0, MAX_SLOTS) : []);

/**
 * The Effects categories whose dot is on (also the rig tab's dot, edit.js): Space / Echo / Chorus = the shared
 * effect's whole object (Chorus also each instrument's chorus amount), Sends = each instrument's Space and Echo.
 * @param {object|null} s  the song
 * @param {object|null} b  its Revert snapshot
 * @returns {Set<string>}
 */
export function effectsChanges(s, b) {
  const out = new Set();
  if (!s || !b) return out;
  const n = Math.max(slotsOf(s).length, slotsOf(b).length);
  const sends = (unit) => Array.from({ length: n }, (_, i) => `patch.slots.${i}.sends.${unit}`);
  const rels = {
    space: ['patch.fx.reverb'], echo: ['patch.fx.delay'], chorus: ['patch.fx.chorus', ...sends('chorus')],
    sends: [...sends('reverb'), ...sends('delay')],
  };
  for (const [id, r] of Object.entries(rels)) if (relsDiffer(s, b, r)) out.add(id);
  return out;
}

/**
 * Mount the v6 Effects panel.
 * @param {HTMLElement} host
 * @param {object} ctx  the panel ctx
 * @param {{focus?:'reverb'|'delay'|'chorus'}} opts  today's focus ids → Space / Echo / Chorus
 * @param {{prefs:{get():string, set(id:string):void}, names:{name(ref:object):string}}} env
 * @returns {{update(o:object):void, destroy():void, _debug:object}}
 */
export function mountEffects(host, ctx, opts, env) {
  const C = ctx.C || {};
  const { editState } = ctx;
  const val = (addr) => ctx.valueOf(addr);
  const set = (path, v) => ctx.set(path, v);
  const base = () => editState.baseline;

  // ---- "Song's own" (today's: the baseline's fx.<unit> as one whole-object write, else per key)
  const baseFxv = (unit, k) => {
    const b = base();
    if (!b) return undefined;
    const v = getIn(b, relOf(`fx.${unit}.${k}`));
    return v === undefined ? describe(`fx.${unit}.${k}`)?.default : v;
  };
  const applyOwnUnit = (unit, keys) => {
    const b = base();
    if (!b) return;
    const own = b.patch?.fx?.[unit];
    const id = ctx.songId();
    if (own && typeof own === 'object' && id) set(`songs.${id}.patch.fx.${unit}`, JSON.parse(JSON.stringify(own)));
    else for (const k of keys) set(`fx.${unit}.${k}`, baseFxv(unit, k));
  };
  const sameUnit = (unit, keys) => !!base() && keys.every((k) => {
    const a = val(`fx.${unit}.${k}`);
    const b = baseFxv(unit, k);
    return typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6 : sameVal(a, b);
  });
  const baseRoomCustom = () => !!base() && !matchPreset(SPACE_PRESETS, (p) => baseFxv('reverb', p.split('.')[2]));
  const baseEchoCustom = () => !!base() && !matchPreset(ECHO_PRESETS, (p) => baseFxv('delay', p.split('.')[2]));

  /** Choice tiles (the mockup's .room): one row of pressed-state buttons. */
  const choices = (kind, items) => {
    const row = h('div.v6e-rooms', { role: 'group', 'aria-label': `${kind} choices`, dataset: { preset: kind } });
    const btns = new Map();
    for (const it of items) {
      const b = h('button.v6e-room', {
        type: 'button', 'aria-pressed': 'false', title: it.title || '', dataset: { id: it.id },
        'data-testid': `v6e-fx-${kind.toLowerCase()}-${it.id}`,
      }, h('b', { text: it.name }), h('small', { text: it.hint }));
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
    };
  };
  const ws = (binder, addr, o) => binder.ctl(addr, (onChange) => wordSlider({
    min: describe(addr).min, max: describe(addr).max, default: describe(addr).default, onChange, ...o,
  }));
  const lvl = (binder, addr) => ws(binder, addr, {
    label: 'Level', curve: 'taper', word: levelWord, format: (v) => formatValue(addr, v), ends: ['off', 'loud'],
  });
  const nameOf = (slot, i) => (slot ? env.names.name(slot.instrument) : `Empty place ${i + 1}`);
  /** A send slider for one instrument (the strip chip's path), in a table row. */
  const sendCell = (binder, i, unit, label, slot) => {
    const c = binder.ctl(`slots.${i}.sends.${unit}`, (onChange) => wordSlider({
      label: `${nameOf(slot, i)} ${label}`, min: 0, max: 1, default: 0, format: amount, onChange,
    }), { read: (s) => (s.patch.slots[i] ? Number(getIn(s, `patch.slots.${i}.sends.${unit}`)) || 0 : 0) });
    c.el.classList.add('v6e-sendcell');
    c.el.dataset.testid = `v6e-fx-send-${unit}-${i}`;
    if (!slot) c.setDisabled(true);
    return c.el;
  };
  const rows = (binder, units) => {
    const s = ctx.song();
    return slotsOf(s).map((slot, i) => instrumentRow({
      color: slotColor(i), name: nameOf(slot, i), empty: !slot, testid: `v6e-fx-row-${i}`,
    }, ...units.map(([u, label]) => sendCell(binder, i, u, label, slot))));
  };

  // ---------------------------------------------------------------- the categories
  function buildSpace(pane) {
    const { binder } = pane;
    const room = choices('Space', [
      ...SPACE_PRESETS.map((p) => ({
        id: p.id, name: p.name, hint: SPACE_HINTS[p.id] || '', title: p.blurb, apply: () => applyPreset(p, set),
      })),
      { id: 'own', name: 'Song’s own', hint: 'as saved', title: 'The Space (reverb) this song was saved with',
        apply: () => applyOwnUnit('reverb', REVERB_KEYS) },
    ]);
    const blurb = h('p.v6e-hint');
    binder.fn(['patch.fx.reverb'], () => {
      const sp = matchPreset(SPACE_PRESETS, val);
      const own = baseRoomCustom();
      const ob = room.btns.get('own');
      ob.hidden = !own;
      if (own) setText(ob.lastChild, sizeWord(baseFxv('reverb', 'size')).toLowerCase());
      room.mark(sp ? sp.id : own && sameUnit('reverb', REVERB_KEYS) ? 'own' : null);
      setText(blurb, sp ? sp.blurb : 'The Space this song was saved with. Pick one above, or fine-tune it.');
    });
    pane.ctl.room = room;
    return h('div.v6e-fxspace', {}, room.row, blurb,
      ws(binder, 'fx.reverb.size', { label: 'Size', word: sizeWord, format: pct, ends: ['small', 'huge'] }).el,
      ws(binder, 'fx.reverb.damp', { label: 'Darkness', word: darkWord, format: pct, ends: ['bright', 'dark'] }).el,
      ws(binder, 'fx.reverb.predelay', { label: 'Pre-delay', word: preWord, format: ms, ends: ['tight', 'late'] }).el,
      lvl(binder, 'fx.reverb.returnGain').el);
  }

  function buildEcho(pane) {
    const { binder } = pane;
    const echo = choices('Echo', [
      ...ECHO_CHIPS.map((c) => {
        const p = ECHO_PRESETS.find((x) => x.id === c.id);
        return { id: c.id, name: c.name, hint: c.hint, title: p.blurb, apply: () => applyPreset(p, set) };
      }),
      { id: 'own', name: 'Song’s own', hint: 'as saved', title: 'The echo this song was saved with',
        apply: () => applyOwnUnit('delay', DELAY_KEYS) },
    ]);
    const blurb = h('p.v6e-hint');
    const timing = binder.ctl('fx.delay.sync', (onChange) => C.select({
      label: 'Timing', options: SYNC_OPTS, onChange,
    }));
    timing.el.dataset.testid = 'v6e-fx-sync';
    const noteText = h('span');
    const tempoLink = h('button.btn.ghost.v6e-link', { type: 'button', text: 'set one' });
    tempoLink.addEventListener('click', () => ctx.select('song', { focus: 'tempo' }));
    const delayNote = h('p.v6e-hint', { 'aria-live': 'polite', 'data-testid': 'v6e-fx-syncnote' }, noteText);
    const delayTime = ws(binder, 'fx.delay.time', {
      label: 'Time', curve: 'log', word: timeWord, ends: ['short', 'long'],
      format: (v) => formatValue('fx.delay.time', v),
    });
    const pingpong = binder.ctl('fx.delay.pingpong', (onChange) => C.toggle({
      label: 'Ping-pong (left/right)', onChange,
    }));
    binder.fn(['patch.fx.delay', 'tempo'], (s) => {
      const ec = matchPreset(ECHO_PRESETS, val);
      const own = baseEchoCustom();
      const ob = echo.btns.get('own');
      ob.hidden = !own;
      if (own) {
        const bs = baseFxv('delay', 'sync');
        setText(ob.lastChild, bs && bs !== 'off' ? SYNC_SHORT[bs] || bs : ms(baseFxv('delay', 'time')));
      }
      echo.mark(ec ? ec.id : own && sameUnit('delay', DELAY_KEYS) ? 'own' : null);
      const sync = val('fx.delay.sync');
      const synced = !!sync && sync !== 'off';
      let eb = ec ? ec.blurb : '';
      if (!ec) {
        eb = synced ? `${SYNC_NAMES[sync] || sync} saved with this song, so it follows the tempo.`
          : `A fixed ${ms(val('fx.delay.time'))} echo saved with this song, so it doesn’t follow the tempo.`;
      }
      setText(blurb, eb);
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
        const at = Math.round((60 / s.tempo) * SYNC_BEATS[sync] * 1000);
        setText(noteText, `${SYNC_NAMES[sync]} at ${Math.round(s.tempo)} BPM = ${at} ms`);
      }
    });
    pane.ctl.echo = echo;
    return h('div.v6e-fxecho', {}, echo.row, blurb,
      h('div.v6e-row', {}, timing.el, delayNote),
      delayTime.el,
      ws(binder, 'fx.delay.feedback', { label: 'Repeats', word: repeatsWord, format: pct, ends: ['one', 'many'] }).el,
      ws(binder, 'fx.delay.tone', { label: 'Tone', word: toneWord, format: pct, ends: ['dark', 'bright'] }).el,
      lvl(binder, 'fx.delay.returnGain').el,
      h('div.v6e-row', {}, pingpong.el));
  }

  function buildChorus(pane) {
    const { binder } = pane;
    const depth = ws(binder, 'fx.chorus.depth', {
      label: 'Depth', word: (v) => cap(chorusWord(v)), format: pct, ends: ['subtle', 'deep'],
    });
    const speed = ws(binder, 'fx.chorus.rate', {
      label: 'Speed', curve: 'log', word: speedWord, ends: ['slow', 'fast'],
      format: (v) => formatValue('fx.chorus.rate', v),
    });
    const blurb = h('p.v6e-hint');
    binder.fn(['patch.fx.chorus'], () => {
      const on = Number(val('fx.chorus.returnGain')) > 0.0001;
      const rate = Number(val('fx.chorus.rate')) || 0;
      setText(blurb, on ? `${rate < 0.6 ? 'A slow shimmer' : rate < 1.5 ? 'A steady shimmer' : 'A fast wobble'}.`
        : 'Off for this song: raise its Level to use it.');
    });
    return h('div.v6e-fxchorus', {}, blurb, depth.el, speed.el, lvl(binder, 'fx.chorus.returnGain').el,
      h('div.v6e-sends', {},
        h('div.v6e-sendhead.one', {}, h('span'), h('span', { text: 'Chorus' })),
        ...rows(binder, [['chorus', 'Chorus']])));
  }

  function buildSends(pane) {
    const { binder } = pane;
    const room = h('span');
    binder.fn(['patch.fx.reverb', 'patch.fx.delay'], () => {
      const sp = matchPreset(SPACE_PRESETS, val);
      const ec = matchPreset(ECHO_PRESETS, val);
      setText(room, `Space: ${sp ? sp.name : 'the song’s own'} · Echo: ${ec ? (ec.id === 'none' ? 'off' : ec.name)
        : 'the song’s own'}. `);
    });
    return h('div.v6e-sends', { 'data-testid': 'v6e-fx-sends' },
      h('div.v6e-sendhead', {}, h('span'), h('span', { text: 'Space' }), h('span', { text: 'Echo' })),
      ...rows(binder, [['reverb', 'Space'], ['delay', 'Echo']]),
      h('p.v6e-hint', {}, room, 'The same Space and Echo buttons as each strip on Perform.'));
  }

  // ---------------------------------------------------------------- Vibe (today's title-bar menu)
  const vibeLabel = h('span', { text: `Vibe: ${OWN_MIX}` });
  const vibeBtn = h('button.btn.v6e-vibe-btn', {
    type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-testid': 'v6e-fx-vibe',
  }, vibeLabel, ' ▾');
  const vibeMenu = h('div.v6e-imenu.v6e-vibe-menu', { role: 'menu', 'aria-label': 'Vibe presets', hidden: true,
    'data-testid': 'v6e-fx-vibemenu' });
  const vibeItems = VIBE_PRESETS.map((p) => {
    const b = h('button.v6e-mi.v6e-vibe-item', {
      type: 'button', role: 'menuitemradio', 'aria-checked': 'false', tabindex: '-1', dataset: { id: p.id },
    }, h('i.v6e-mi-check', { 'aria-hidden': 'true' }),
    h('span', {}, h('b', { text: p.name }), h('small', { text: p.blurb })));
    b.addEventListener('click', (e) => {
      applyPreset(p, set);
      closeVibe(e.detail === 0);
    });
    vibeMenu.append(b);
    return b;
  });
  const vibeWrap = h('div.v6e-iact', {}, vibeBtn, vibeMenu);
  let offEsc = null;
  let offOutside = null;
  function closeVibe(refocus) {
    if (vibeMenu.hidden) return;
    vibeMenu.hidden = true;
    vibeBtn.setAttribute('aria-expanded', 'false');
    ctx.markDialog(false, 'v6-fx-vibe');
    offEsc?.();
    offOutside?.();
    offEsc = offOutside = null;
    if (refocus) vibeBtn.focus();
  }
  function openVibe() {
    if (!vibeMenu.hidden) return;
    vibeMenu.hidden = false;
    vibeBtn.setAttribute('aria-expanded', 'true');
    ctx.markDialog(true, 'v6-fx-vibe');
    offEsc = ctx.onEscape(() => {
      closeVibe(true);
      return true;
    });
    offOutside = ctx.listen(document, 'pointerdown', (e) => {
      if (!vibeWrap.contains(e.target)) closeVibe(false);
    }, true);
    (vibeItems.find((b) => b.getAttribute('aria-checked') === 'true') || vibeItems[0])?.focus();
  }
  vibeBtn.addEventListener('click', () => (vibeMenu.hidden ? openVibe() : closeVibe(false)));
  vibeMenu.addEventListener('keydown', (e) => {
    const k = vibeItems.indexOf(document.activeElement);
    let j = -1;
    if (e.key === 'ArrowDown') j = Math.min(vibeItems.length - 1, k + 1);
    else if (e.key === 'ArrowUp') j = Math.max(0, k - 1);
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = vibeItems.length - 1;
    else if (e.key === 'Tab') closeVibe(false);
    if (j < 0) return;
    e.preventDefault();
    e.stopPropagation();
    vibeItems[j].focus();
  });
  const renderVibe = () => {
    const vibe = matchPreset(VIBE_PRESETS, val);
    setText(vibeLabel, `Vibe: ${vibe ? vibe.name : OWN_MIX}`);
    for (const it of vibeItems) {
      const on = !!vibe && it.dataset.id === vibe.id;
      it.setAttribute('aria-checked', String(on));
    }
  };

  // ---- Tape & finish live on Master (today's footer link)
  const tapeLink = h('button.btn.ghost.v6e-link.v6e-navlink', { type: 'button', 'data-testid': 'v6e-fx-tape' },
    'Tape & finish ', h('small', { text: 'on Master ▸' }));
  tapeLink.addEventListener('click', () => ctx.select('master', { focus: 'tape' }));

  const roomWords = (sp) => (sp ? (sp.id === 'dry' ? 'no Space (dry)' : `${article(sp.name)}${sp.name}`)
    : 'the song’s own Space');

  const panel = catPanel(host, ctx, {
    kind: 'effects',
    color: 'var(--fx, var(--accent))',
    cats: EFFECTS_CATS,
    initial: env.prefs.get(),
    remember: (id) => env.prefs.set(id),
    actions: [vibeWrap],
    navFoot: tapeLink,
    // the per-instrument rows follow the song's slots and their instruments
    key: (id, s) => (id === 'sends' || id === 'chorus'
      ? slotsOf(s).map((sl) => (sl ? `${sl.instrument.type}:${sl.instrument.id}` : '-')).join(',') : ''),
    build(id, pane) {
      if (id === 'space') return buildSpace(pane);
      if (id === 'echo') return buildEcho(pane);
      if (id === 'chorus') return buildChorus(pane);
      return buildSends(pane);
    },
    summary(id, s) {
      if (id === 'space') {
        const sp = matchPreset(SPACE_PRESETS, val);
        return sp ? `${sp.name} · ${SPACE_HINTS[sp.id] || ''}`.replace(/ · $/, '') : 'the song’s own';
      }
      if (id === 'echo') {
        const ec = matchPreset(ECHO_PRESETS, val);
        const sync = val('fx.delay.sync');
        const t = sync && sync !== 'off' && s.tempo ? ` · ${Math.round(s.tempo)} bpm` : '';
        return `${ec ? (ec.id === 'none' ? 'Off' : ECHO_CHIPS.find((c) => c.id === ec.id)?.name || ec.name)
          : 'the song’s own'}${ec && ec.id === 'none' ? '' : t}`;
      }
      if (id === 'chorus') {
        const on = Number(val('fx.chorus.returnGain')) > 0.0001;
        return on ? `${cap(chorusWord(val('fx.chorus.depth')))} · level ${formatValue('fx.chorus.returnGain',
          val('fx.chorus.returnGain'))}` : 'off';
      }
      const filled = slotsOf(s).filter(Boolean);
      const into = filled.filter((sl) => Number(sl.sends?.reverb) > 0.0005).length;
      return `${into} of ${filled.length} in the Space`;
    },
    changes: () => effectsChanges(ctx.song(), base()),
    sentence(s) {
      const sp = matchPreset(SPACE_PRESETS, val);
      const ec = matchPreset(ECHO_PRESETS, val);
      const chip = ec ? ECHO_CHIPS.find((c) => c.id === ec.id) : null;
      const sync = val('fx.delay.sync');
      const parts = ['Everything plays into ', { text: roomWords(sp), cat: 'space', focus: '.v6e-rooms' },
        ' with ', { text: chip ? chip.words : 'the song’s own echo', cat: 'echo', focus: '.v6e-rooms' }];
      if ((!ec || ec.id !== 'none') && sync && sync !== 'off' && s.tempo) {
        parts.push(' synced to ', {
          text: `${Math.round(s.tempo)} bpm`, run: () => ctx.select('song', { focus: 'tempo' }),
        });
      }
      if (Number(val('fx.chorus.returnGain')) > 0.0001) {
        parts.push(', and ', { text: `a ${chorusWord(val('fx.chorus.depth'))} chorus`, cat: 'chorus' });
      }
      parts.push('.');
      return parts;
    },
    onRender: renderVibe,
  });
  renderVibe();
  ctx.onLeaveSong(() => closeVibe(false));
  ctx.onLeaveView?.(() => closeVibe(false));

  const FOCUS = { reverb: 'space', delay: 'echo', chorus: 'chorus', sends: 'sends' };
  const applyFocus = (f) => {
    const id = FOCUS[f];
    if (!id) return;
    panel.choose(id);
    panel.focusIn(host.querySelector('.v6e-pane')?.firstElementChild);
  };
  applyFocus(opts?.focus);

  return {
    update(next = {}) {
      applyFocus(next.focus);
    },
    destroy() {
      closeVibe(false);
      panel.destroy();
    },
    _debug: { cat: () => panel.cat(), choose: (id) => panel.choose(id, { persist: true }) },
  };
}
