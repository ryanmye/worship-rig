// OWNER: slot agent (views/edit/CONTRACT.md §6). The H-v2 sound panel for Keys / Pad / Extra / Bass
// (design/H-v2 concept §1(1) + §3, edit.png / edit-1024.png; design/H concept §3 "Edit").
//
// Title: a sentence built by shared/smart-controls.js describeSlot() ("KEYS plays Grand Piano on every key, ● an
// octave up, a little into the Hall, sustain on"); every underlined word jumps to its control; "Change instrument ▾"
// is a grouped menu ending in "Remove this sound…" (confirm → Undo).
// Body: three columns and a footer.
//  - ON STAGE    = the Perform strip: ctx.C.onTile (the mute), vertical fader, Space / Echo / Octave / Sustain
//                  stepChips plus an Edit-only wide Chorus chip, each with setLoaded(baseline) for the white dot.
//  - THE SOUND   = three lib.wordSlider()s from smartSlidersFor(meta), each a view of exactly one PARAMS path.
//  - WHERE IT PLAYS = miniKeyboard range + note fields + Whole keyboard + "Set lowest/highest…" (armed on the next
//                  held note) + Response (velocityCurve) with the curve sparkline.
//  - Advanced    = lib.section('slot<i>-adv'): pan, width (only when hasParam and not already a smart slider),
//                  transpose, voices, pitch bend, sustain pedal, the instrument's own settings (+ Reset), and the
//                  Tone section (lib.section('slot<i>-tone')) hosting ctx.C.eqKeyboard, mounted only while Advanced
//                  and Tone are both open and destroyed on close / rebuild / unmount (hv2-edit-integrate). The
//                  footer line counts this slot's changes since the song was loaded.
//  - Title bar   = ctx.C.eqMiniCurve (hidden while the EQ is flat; a click opens Advanced → Tone) + the menu.
//  Brightness / Warmth on the strip's shelves read and write the EQ's high / low shelf through eq-math shelfWrites.
// Store → view: lib.createBinder refreshes values in place; the body is rebuilt only when the slot's instrument,
// emptiness or availability changes (ui-edit "store → view updates in place"). Views never call the engine (reads
// only: listInstruments via ctx, and engine/audio.js curveVelocity for the sparkline, as views/edit.js does).
import {
  h, setText, icon, getIn, relOf, hasParam, signed, pct, semitones, formatInstrumentParam, BLOCKS, changedDot,
  changeText, createBinder, section, wordSlider,
} from '../lib.js';
import { defaultSlot, describe, formatValue } from '../../../shared/params.js';
import { noteName, parseNoteName } from '../../../shared/music.js';
import { SPACE_PRESETS, matchPreset } from '../../../shared/fx-presets.js';
import { smartSlidersFor, slotPath, wordFor, formatSmart, describeSlot } from '../../../shared/smart-controls.js';
import { readEq, shelfWrites, eqSummary } from '../../../shared/eq-math.js';

/** The engine's own velocity curve (engine/audio.js); a local copy only if that module cannot load (views/edit.js). */
const curveVelocity = await import('../../../engine/audio.js').then(
  (m) => (typeof m.curveVelocity === 'function' ? m.curveVelocity : localCurve),
  () => localCurve,
);
function localCurve(vel127, curve) {
  const v = Math.min(1, Math.max(0, (Number(vel127) || 0) / 127));
  if (curve === 'soft') return Math.pow(v, 0.6);
  if (curve === 'hard') return Math.pow(v, 1.6);
  if (curve === 'fixed') return 100 / 127;
  return v;
}

// ---------------------------------------------------------------------------------------------------------------
// constants (copied from views/edit.js so the old view keeps its exports untouched until it is retired)
/**
 * Menu group order: the engine's group string (listInstruments()[i].group); unknown groups after the known ones
 * (A–Z), 'My Samples' last. Same list as views/edit.js (includes 'Guitar & Plucks').
 */
export const INSTRUMENT_GROUPS = Object.freeze([
  'Piano', 'Electric Piano', 'Organ', 'Synth Pads', 'Synth Keys', 'Brass & Leads', 'Mallets & Bells',
  'Guitar & Plucks', 'Guitar', 'Bass', 'My Samples',
]);
/** Engine-internal patches listInstruments() may expose but a slot should not offer (the drone's own voice). */
const HIDDEN_IN_PICKER = new Set(['synth:drone-osc']);
const ROLE_COLORS = ['#ff8a3d', '#3ddc84', '#4aa8ff', '#b784ff']; // fallbacks for --slot-0..3 (styles.css)
const ROLE_ICONS = ['piano', 'pad', 'extra', 'bass'];
const GROUP_ICONS = {
  Piano: 'piano', 'Electric Piano': 'piano', 'Synth Keys': 'piano', Organ: 'piano', 'Synth Pads': 'pad', Bass: 'bass',
};
const GROUP_NOUNS = {
  Piano: 'piano', 'Electric Piano': 'electric piano', Organ: 'organ', 'Synth Pads': 'pad', 'Synth Keys': 'keys',
  'Brass & Leads': 'lead', 'Mallets & Bells': 'bells', 'Guitar & Plucks': 'pluck', Guitar: 'guitar', Bass: 'bass',
};
const TYPE_WORDS = { sampler: 'sampled', synth: 'synth', organ: 'organ' };
/** Same words as Settings ▸ Velocity (views/edit.js TOUCH_LABELS). The mockup's Soft/Hard were not adopted. */
export const TOUCH_LABELS = Object.freeze({ soft: 'Light', normal: 'Normal', hard: 'Heavy', fixed: 'Fixed' });
const TOUCH_HINTS = {
  soft: 'Light: soft playing still sounds full.',
  normal: 'Normal: volume follows how hard you play.',
  hard: 'Heavy: you have to dig in for full volume.',
  fixed: 'Fixed: every note plays at the same volume.',
};
const VEL_OPTS = ['soft', 'normal', 'hard', 'fixed']
  .map((v) => ({ value: v, label: TOUCH_LABELS[v], title: TOUCH_HINTS[v] }));
const MONO_OPTS = [
  { value: 'off', label: 'Chords' },
  { value: 'lowest', label: 'Single note (lowest)' },
  { value: 'highest', label: 'Single note (highest)' },
];
const VOICE_WORDS = { off: 'All', lowest: 'Lowest', highest: 'Highest' };
const MINUS = '−';
const JUMP_HINT = 'click an underlined word to jump to its control';
const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), textarea, button:not([disabled]), [tabindex]';

// ---------------------------------------------------------------------------------------------------------------
// pure helpers (exported for tests)
/** Picker group: the engine's group; a 'pluck' category without one → 'Guitar & Plucks'; user: → 'My Samples'. */
export function groupOf(it) {
  if (it && typeof it.group === 'string' && it.group.trim()) return it.group.trim();
  if (it && it.category === 'pluck') return 'Guitar & Plucks';
  if (it && it.ref && String(it.ref.id || '').startsWith('user:')) return 'My Samples';
  return 'Other';
}
/** Ordered group names for a list (known order, then unknown A–Z with 'Other' last, then 'My Samples'). */
export function groupOrder(list) {
  const present = new Set(list.map(groupOf));
  const known = INSTRUMENT_GROUPS.filter((g) => g !== 'My Samples' && present.has(g));
  const extra = [...present].filter((g) => !INSTRUMENT_GROUPS.includes(g))
    .sort((a, b) => (a === 'Other') - (b === 'Other') || a.localeCompare(b));
  return [...known, ...extra, ...(present.has('My Samples') ? ['My Samples'] : [])];
}
const refKey = (ref) => (ref ? `${ref.type}:${ref.id}` : '');
/** "C4", "f#2", "Bb3" or a MIDI number → 0..127, else null. */
export function parseKey(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  let n = /^-?\d+$/.test(t) ? Number(t) : NaN;
  if (!Number.isInteger(n)) {
    try {
      n = parseNoteName(t.replace(/^([a-g])/, (c) => c.toUpperCase()));
    } catch {
      n = NaN;
    }
  }
  return Number.isInteger(n) && n >= 0 && n <= 127 ? n : null;
}
const capital = (s) => String(s)[0].toUpperCase() + String(s).slice(1);

// ---------------------------------------------------------------------------------------------------------------
export default {
  id: 'slot',
  icon: 'piano',
  /**
   * @param {HTMLElement} el
   * @param {object} ctx   panel ctx (CONTRACT.md §3)
   * @param {{slot:number, focus?:'instrument'|'range'}} opts
   * @returns {{destroy():void, update(opts:object):void}}
   */
  mount(el, ctx, opts = {}) {
    return mountSlot(el, ctx, opts);
  },
};

/** @returns {{destroy():void, update(opts:object):void}} */
function mountSlot(el, ctx, opts) {
  const C = ctx.C || {};
  let i = slotIndex(opts);
  const role = () => BLOCKS[i].role;
  const ROLE = () => role().toUpperCase();
  const P = (k) => `slots.${i}.${k}`;
  const REL = () => `patch.slots.${i}`;
  const slotOf = (s) => (s && s.patch && Array.isArray(s.patch.slots) ? s.patch.slots[i] || null : null);
  const curSlot = () => slotOf(ctx.song());
  const metaOf = (slot) => (slot ? ctx.findInstrument(slot.instrument) : null);
  const displayName = (slot, meta) => {
    if (!slot) return '';
    if (!meta) return `${slot.instrument.id} (not available)`;
    return typeof C.stageName === 'function' ? C.stageName(meta.name, slot.instrument) : meta.name;
  };
  const slotKey = (slot) => (slot ? `${refKey(slot.instrument)}:${metaOf(slot) ? 1 : 0}` : 'empty');

  // ---- static frame: confirm bar + body host (rebuilt per instrument) --------------------------------------------
  const confirmEl = h('div.ev2-slot-confirm', { role: 'alertdialog', hidden: true, 'aria-label': 'Remove this sound' });
  const bodyHost = h('div.ev2-slot-bodyhost');
  const root = h('div.ev2-slot', {}, confirmEl, bodyHost);
  const paintSlot = () => {
    root.dataset.slot = String(i);
    root.style.setProperty('--c', `var(--slot-${i}, ${ROLE_COLORS[i]})`);
  };
  paintSlot();
  el.replaceChildren(root);

  // ---- "Change instrument ▾" menu (CONTRACT.md §5 menus) --------------------------------------------------------
  const chgLabel = h('span', { text: 'Change instrument' });
  const chgBtn = h('button.ev2-btn.sm.ev2-slot-chg', {
    type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
  }, chgLabel, icon('down', 14));
  const menuEl = h('div.ev2-slot-menu', { role: 'menu', hidden: true, tabindex: '-1' });
  // the EQ sparkline (eq-ui integration step 4): hidden while flat; a click opens Advanced → Tone
  const miniEq = typeof C.eqMiniCurve === 'function'
    ? C.eqMiniCurve({ store: ctx.store, slotIndex: i, onOpen: () => openTone() }) : null;
  if (miniEq) miniEq.el.classList.add('ev2-slot-eqmini');
  const actions = h('div.ev2-slot-actions', {}, miniEq ? miniEq.el : null, chgBtn, menuEl);
  let menuOpen = false;
  const menuItems = () => [...menuEl.querySelectorAll('[role^="menuitem"]:not([disabled])')];
  function buildMenu() {
    const slot = curSlot();
    const cur = slot ? refKey(slot.instrument) : '';
    const list = ctx.instruments().filter((it) => {
      const v = refKey(it.ref);
      return (!HIDDEN_IN_PICKER.has(v) && !it.hidden) || v === cur;
    });
    const nodes = [];
    const item = (value, text, checked, title) => h('button.ev2-slot-mi', {
      type: 'button', role: 'menuitemradio', 'aria-checked': String(checked), tabindex: '-1', title,
      dataset: { value },
    }, h('i.ev2-slot-mi-check', { 'aria-hidden': 'true' }), h('span', { text }));
    if (cur && !list.some((it) => refKey(it.ref) === cur)) {
      nodes.push(h('div.ev2-slot-mg', { role: 'group', 'aria-label': 'This song' },
        item(cur, `${slot.instrument.id} (not available)`, true, 'This instrument is not available on this computer')));
    }
    for (const g of groupOrder(list)) {
      const items = list.filter((it) => groupOf(it) === g).map((it) => item(refKey(it.ref), it.name,
        refKey(it.ref) === cur, it.license ? `${it.name} — ${it.license}` : it.name));
      nodes.push(h('div.ev2-slot-mg', { role: 'group', 'aria-label': g },
        h('div.ev2-slot-mg-head', { 'aria-hidden': 'true', text: g }), ...items));
    }
    if (!list.length) {
      nodes.push(h('p.ev2-hint.ev2-slot-mi-none', { text: 'Instruments appear once sound has started.' }));
    }
    if (slot) {
      nodes.push(h('div.ev2-slot-msep', { role: 'separator' }),
        h('button.ev2-slot-mi.ev2-slot-mi-remove', {
          type: 'button', role: 'menuitem', tabindex: '-1', dataset: { action: 'remove' },
        }, h('i.ev2-slot-mi-check', { 'aria-hidden': 'true' }), h('span', { text: 'Remove this sound…' })));
    }
    menuEl.setAttribute('aria-label', `${role()} instrument`);
    menuEl.replaceChildren(...nodes);
  }
  function openMenu({ focus = true } = {}) {
    cancelConfirm();
    disarm();
    if (!menuOpen) {
      buildMenu();
      menuEl.hidden = false;
      menuOpen = true;
      chgBtn.setAttribute('aria-expanded', 'true');
      chgBtn.classList.add('open');
      ctx.markDialog(true, 'slot-menu');
    }
    if (focus) {
      const items = menuItems();
      const cur = items.find((b) => b.getAttribute('aria-checked') === 'true');
      (cur || items[0])?.focus({ preventScroll: false });
    }
  }
  function closeMenu(refocus = false) {
    if (!menuOpen) return false;
    menuOpen = false;
    menuEl.hidden = true;
    chgBtn.setAttribute('aria-expanded', 'false');
    chgBtn.classList.remove('open');
    ctx.markDialog(false, 'slot-menu');
    if (refocus) chgBtn.focus();
    else if (menuEl.contains(document.activeElement)) document.activeElement.blur();
    return true;
  }
  chgBtn.addEventListener('click', (e) => {
    if (menuOpen) closeMenu(e.detail === 0);
    else openMenu({ focus: true });
  });
  menuEl.addEventListener('keydown', (e) => {
    const items = menuItems();
    const k = items.indexOf(document.activeElement);
    let n = -1;
    if (e.key === 'ArrowDown') n = (k + 1) % items.length;
    else if (e.key === 'ArrowUp') n = (k - 1 + items.length) % items.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = items.length - 1;
    else if (e.key === 'Tab') {
      closeMenu(false);
      return;
    }
    if (n < 0 || !items.length) return;
    e.preventDefault();
    e.stopPropagation(); // ↑/↓ are the mod wheel and ←/→ the songs elsewhere
    items[n].focus();
  });
  menuEl.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.ev2-slot-mi');
    if (!b || !menuEl.contains(b)) return;
    const keyboard = e.detail === 0;
    if (b.dataset.action === 'remove') {
      closeMenu(false);
      askRemove();
      return;
    }
    closeMenu(keyboard);
    pickInstrument(b.dataset.value);
  });

  /** Fill an empty slot (role defaults) or swap the instrument (its params reset in the store). */
  function pickInstrument(value) {
    const s = ctx.song();
    if (!s || !value) return;
    const k = value.indexOf(':');
    const ref = { type: value.slice(0, k), id: value.slice(k + 1) };
    const slot = slotOf(s);
    undo = null;
    if (!slot) ctx.set(`slots.${i}`, defaultSlot(i, ref));
    else if (refKey(slot.instrument) !== value) ctx.set(P('instrument'), ref);
  }

  // ---- Remove this sound… (confirm → Undo; H implementation §4) ----------------------------------------------
  let confirming = false;
  /** @type {{songId:string, i:number, slot:object, name:string}|null} */
  let undo = null;
  function askRemove() {
    const slot = curSlot();
    if (!slot) return;
    const name = displayName(slot, metaOf(slot));
    confirming = true;
    const cancel = h('button.ev2-btn.sm.ev2-slot-cancel', { type: 'button', text: 'Cancel' });
    const yes = h('button.ev2-btn.sm.danger.ev2-slot-remove', { type: 'button', text: 'Remove' });
    cancel.addEventListener('click', () => cancelConfirm(true));
    yes.addEventListener('click', () => doRemove());
    confirmEl.replaceChildren(
      h('span.ev2-slot-confirm-q', {
        text: `Remove ${name} from ${role()}? ${role()} goes silent until you pick a sound.`,
      }),
      h('span.ev2-sp'), yes, cancel);
    confirmEl.hidden = false;
    ctx.markDialog(true, 'slot-confirm');
    cancel.focus();
  }
  function cancelConfirm(refocus = false) {
    if (!confirming) return false;
    confirming = false;
    confirmEl.hidden = true;
    confirmEl.replaceChildren();
    ctx.markDialog(false, 'slot-confirm');
    if (refocus) chgBtn.focus();
    return true;
  }
  function doRemove() {
    const s = ctx.song();
    const slot = slotOf(s);
    cancelConfirm(false);
    if (!slot) return;
    const name = displayName(slot, metaOf(slot));
    const captured = { songId: s.id, i, slot: JSON.parse(JSON.stringify(slot)), name };
    if (!ctx.set(`slots.${i}`, null)) return;
    undo = captured;
    renderEmptyUndo();
    const msg = `${name} removed from ${BLOCKS[captured.i].role}.`;
    ctx.toast(msg, 'info', { ms: 8000, action: { label: 'Undo', run: () => doUndo(captured) } });
  }
  /** Write the captured slot back to the song it was removed from (songs.<id>.patch.slots.<i>). */
  function doUndo(u = undo) {
    if (!u) return false;
    const st = ctx.store.get();
    const song = st.songs[u.songId];
    if (!song) return false;
    if (song.patch.slots[u.i]) {
      ctx.toast(`${BLOCKS[u.i].role} has a sound again, so there is nothing to undo.`, 'info');
      if (undo === u) undo = null;
      renderEmptyUndo();
      return false;
    }
    const ok = ctx.set(`songs.${u.songId}.patch.slots.${u.i}`, u.slot);
    if (undo === u) undo = null;
    renderEmptyUndo();
    return ok;
  }

  // ---- body -------------------------------------------------------------------------------------------------------
  /** Current body: its binder, the rebuild key and the pieces the title / focus / dots reach. */
  let body = null;
  function build() {
    destroyTone();
    if (body) {
      try {
        body.binder.destroy();
      } catch (err) {
        console.warn('[edit] slot body destroy failed', err);
      }
    }
    disarm();
    const slot = curSlot();
    const binder = createBinder(ctx);
    body = { binder, key: slotKey(slot), chips: [], ctl: {} };
    bodyHost.replaceChildren(slot ? buildFilled(slot, binder) : buildEmpty());
    refreshLoaded();
    renderFoot();
    syncTone(); // a Tone section remembered open (lib.section) mounts its editor right away
  }

  function buildEmpty() {
    const choose = h('button.ev2-btn.ev2-slot-choose', { type: 'button' }, 'Choose a sound', icon('down', 14));
    choose.addEventListener('click', () => {
      openMenu({ focus: true });
    });
    const undoLine = h('p.ev2-slot-undo', { hidden: true });
    body.ctl.undoLine = undoLine;
    body.ctl.choose = choose;
    const box = h('div.ev2-slot-empty', { dataset: { empty: '1' } },
      h('p.ev2-slot-empty-q', { text: `Nothing plays on ${role()} yet.` }),
      h('p.ev2-hint', {
        text: 'Pick an instrument and it takes this part of your rig, with the usual settings for it.',
      }),
      choose, undoLine);
    queueMicrotask(renderEmptyUndo);
    return box;
  }
  function renderEmptyUndo() {
    const line = body && body.ctl.undoLine;
    if (!line) return;
    const show = !!(undo && undo.i === i && undo.songId === ctx.songId() && !curSlot());
    line.hidden = !show;
    if (!show) {
      line.replaceChildren();
      return;
    }
    const b = h('button.ev2-linkbtn.ev2-slot-undo-btn', { type: 'button', text: 'Undo' });
    b.addEventListener('click', () => doUndo());
    line.replaceChildren(h('span', { text: `${undo.name} was removed. ` }), b);
  }

  function buildFilled(slot, binder) {
    const color = `var(--slot-${i}, ${ROLE_COLORS[i]})`;
    const meta = metaOf(slot);
    const specs = smartSlidersFor(meta);
    const ctl = body.ctl;
    const rel = REL();
    const read = (f, def) => (s) => {
      const sl = slotOf(s);
      if (!sl) return undefined;
      const v = getIn(sl, f);
      return v === undefined ? def : v;
    };

    // ============ ON STAGE (= the Perform strip) ============
    const os = h('div.ev2-col.ev2-slot-os', { dataset: { sec: `slot${i}-stage` } });
    ctl.tile = binder.ctl(P('muted'), (onChange) => makeTile(C, { label: ROLE(), color, onToggle: onChange }), {
      read: (s) => (slotOf(s) ? !slotOf(s).muted : undefined),
      write: (on) => ctx.set(P('muted'), !on),
    });
    ctl.fader = binder.ctl(P('gain'), (onChange) => C.fader({
      path: P('gain'), label: `${role()} level`, vertical: true, color, onChange,
    }));
    const chip = (f, o) => {
      const c = binder.ctl(P(f), (onChange) => makeChip(C, {
        owner: ROLE(), color, mount: () => os, testid: `ev2-slot-${f.replace('sends.', '')}-${i}`, ...o, onChange,
      }));
      body.chips.push({ chip: c, f });
      return c;
    };
    const amount = { steps: C.AMOUNT_STEPS || AMOUNT_FALLBACK, format: formatAmount, lit: (v) => Number(v) > 0.0005,
      amount: (v) => Number(v) || 0, fine: { min: 0, max: 1, format: (v) => `${Math.round(v * 100)}%` },
      footnote: 'Tap a step: done. Slide for in-between.' };
    ctl.space = chip('sends.reverb', { label: 'Space', ...amount, hint: 'how much goes into the Space' });
    ctl.echo = chip('sends.delay', { label: 'Echo', ...amount, hint: 'how much goes into the Echo' });
    ctl.octave = chip('octave', {
      label: 'Octave', steps: C.OCTAVE_STEPS || OCTAVE_FALLBACK, format: formatOctave, lit: (v) => Number(v) !== 0,
      hint: `shifts only the ${role().toLowerCase()}`,
      footnote: 'Tap one: done. Starts on your next note; held notes keep ringing.',
    });
    ctl.sustain = chip('sustain', {
      label: 'Sustain', steps: C.SUSTAIN_STEPS || SUSTAIN_FALLBACK, format: (v) => (v ? 'Sustain' : 'Sustain off'),
      lit: (v) => v === true, title: 'Does the sustain pedal hold this sound? Tap to switch.',
    });
    ctl.chorus = chip('sends.chorus', {
      label: 'Chorus', ...amount, hint: 'how much goes into the Chorus', className: 'ev2-slot-wide',
    });
    binder.fn(['patch.fx.reverb'], () => {
      const sp = matchPreset(SPACE_PRESETS, ctx.valueOf);
      ctl.space.setHint?.(`how much goes into the Space${sp ? ` (${sp.name})` : ''}`);
    });
    binder.fn([rel], (s) => {
      const sl = slotOf(s);
      if (!sl) return;
      ctl.fader.setMuted?.(!!sl.muted);
      os.classList.toggle('off', !!sl.muted);
    });
    os.append(
      h('span.ev2-cap', { text: 'On stage' }),
      ctl.tile.el,
      h('div.ev2-slot-osb', {},
        h('div.ev2-slot-fz', {}, ctl.fader.el),
        h('div.ev2-slot-mods', {}, ctl.space.el, ctl.echo.el, ctl.octave.el, ctl.sustain.el, ctl.chorus.el)),
      h('p.ev2-slot-same', { text: 'Same switches, same colours as your Perform strip' }),
    );

    // ============ THE SOUND ITSELF ============
    const noun = (meta && GROUP_NOUNS[meta.group]) || 'sound';
    const wsl = h('div.ev2-slot-wsl');
    ctl.smart = specs.map((spec) => {
      const addr = slotPath(spec, i);
      // a shelf spec (eq.high / eq.low) is the EQ's high / low shelf: the legacy row stops acting once the Tone
      // editor has written b1 / b8 rows, so read readEq's shelf and write shelfWrites (eq-ui integration step 5)
      const how = spec.shelf ? {
        read: (s) => {
          const sl = slotOf(s);
          return sl ? shelfDb(sl.eq, spec.shelf) : undefined;
        },
        write: (v) => writeShelf(spec.shelf, v),
        rels: [`${rel}.eq`],
      } : { read: spec.key ? read(`params.${spec.key}`, spec.default) : undefined };
      const c = binder.ctl(addr, (onChange) => slider({
        label: spec.label, min: spec.min, max: spec.max, curve: spec.curve, default: spec.default,
        bipolar: spec.bipolar, ends: spec.ends, word: (v) => wordFor(spec.role, v, spec),
        format: (v) => formatSmart(spec, v), onChange,
      }), how);
      c.el.dataset.smart = spec.role;
      wsl.append(c.el);
      return c;
    });
    const snd = h('div.ev2-col.ev2-slot-snd', { dataset: { sec: `slot${i}-sound` } },
      h('span.ev2-cap', { text: 'The sound itself' }),
      h('span.ev2-col-sub', { text: `Shape the ${noun}. Words first, numbers beside them.` }),
      wsl);

    // ============ WHERE IT PLAYS ============
    const rangeNote = h('em.ev2-slot-rnote');
    const mini = C.miniKeyboard({
      low: slot.lowNote, high: slot.highNote, label: role(), color,
      onRange: (a, b) => {
        const r = a && typeof a === 'object' ? a : { low: a, high: b };
        let lo = Math.round(Number(r.low ?? r.lowNote ?? r[0]));
        let hi = Math.round(Number(r.high ?? r.highNote ?? r[1]));
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
        if (lo > hi) [lo, hi] = [hi, lo];
        ctx.set(P('lowNote'), lo);
        ctx.set(P('highNote'), hi);
      },
    });
    mini.el.dataset.bind = P('split');
    binder.track(mini);
    ctl.mini = mini;
    binder.fn([`${rel}.lowNote`, `${rel}.highNote`], (s) => {
      const sl = slotOf(s);
      if (!sl) return;
      mini.set({ low: sl.lowNote, high: sl.highNote });
      const whole = sl.lowNote <= 0 && sl.highNote >= 127;
      setText(rangeNote, whole ? '· every key' : `· ${noteName(sl.lowNote)} to ${noteName(sl.highNote)}`);
    });
    ctl.low = noteField(binder, 'Lowest', 'lowNote');
    ctl.high = noteField(binder, 'Highest', 'highNote');
    const whole = h('button.ev2-linkbtn.ev2-slot-whole', {
      type: 'button', title: 'Play this sound across the whole keyboard', text: 'Whole keyboard',
    });
    whole.addEventListener('click', () => {
      ctx.set(P('lowNote'), 0);
      ctx.set(P('highNote'), 127);
    });
    const armBtn = (arm) => h('button.ev2-btn.sm.ev2-slot-arm', {
      type: 'button', 'aria-pressed': 'false', dataset: { arm },
    });
    ctl.armLow = armBtn('low');
    ctl.armHigh = armBtn('high');
    ctl.armLow.addEventListener('click', () => toggleArm('low'));
    ctl.armHigh.addEventListener('click', () => toggleArm('high'));
    ctl.armHint = h('small.ev2-slot-rhint', { 'aria-live': 'polite' });
    renderArm();
    const rangeBox = h('div.ev2-slot-row.ev2-slot-range', { dataset: { sec: `slot${i}-range` } },
      h('span.ev2-slot-rh', {}, h('b', { text: 'Keyboard range' }), ' ', rangeNote),
      mini.el,
      h('div.ev2-slot-fields', {}, ctl.low, h('span.ev2-slot-to', { text: 'to' }), ctl.high, h('span.ev2-sp'), whole),
      h('div.ev2-slot-rbtns', {}, ctl.armLow, ctl.armHigh),
      ctl.armHint);
    ctl.rangeBox = rangeBox;

    const spark = curveSpark();
    binder.track(spark);
    ctl.resp = binder.ctl(P('velocityCurve'), (onChange) => C.segmented({
      label: 'Response', options: VEL_OPTS, onChange,
    }));
    binder.fn([`${rel}.velocityCurve`], (s) => {
      const sl = slotOf(s);
      if (sl) spark.draw(sl.velocityCurve || 'normal');
    });
    const play = h('div.ev2-col.ev2-slot-play', {},
      h('span.ev2-cap', { text: 'Where it plays' }),
      h('span.ev2-col-sub', { text: 'Only for this sound.' }),
      rangeBox,
      h('div.ev2-slot-row.ev2-slot-resp', {},
        h('div.ev2-slot-rhead', {},
          h('span.ev2-slot-rh', {},
            h('b', { text: 'Response' }), ' ', h('em', { text: '· how it answers your touch' })),
          spark.el),
        h('div.ev2-slot-respctl', {}, ctl.resp.el)));

    // ============ Advanced ============
    const mapped = new Set(specs.map((s) => s.path.replace('slots.<i>.', '')));
    const strip = h('div.ev2-slot-adv-row');
    const ws = (addr, o) => binder.ctl(addr, (onChange) => slider({ ...o, onChange }));
    ctl.pan = ws(P('pan'), {
      label: 'Pan', min: -1, max: 1, default: 0, bipolar: true, ends: ['left', 'right'],
      word: (v) => (Math.abs(v) < 0.005 ? 'Center' : v < 0 ? 'Left' : 'Right'),
      format: (v) => (Math.abs(v) < 0.005 ? '' : formatValue(P('pan'), v)),
    });
    strip.append(ctl.pan.el);
    const toneNames = [];
    if (hasParam(P('width')) && !mapped.has('width')) {
      ctl.width = ws(P('width'), {
        label: 'Width', min: 0, max: 1.5, default: describe(P('width')).default, ends: ['mono', 'wide'],
        word: (v) => wordFor('width', v), format: (v) => (Number(v) < 0.005 ? 'Mono' : pct(v)),
      });
      strip.append(ctl.width.el);
    }
    // Lows / Highs became the Tone section below (eq-ui integration step 3); the smart sliders move its shelves
    const shelfNames = specs.filter((sp) => sp.shelf).map((sp) => `${sp.label} = the ${sp.shelf} shelf`);
    ctl.transpose = binder.ctl(P('transpose'), (onChange) => C.stepper({
      label: 'Transpose', min: -12, max: 12, step: 1, format: semitones, onChange,
    }));
    ctl.voices = binder.ctl(P('mono'), (onChange) => C.select({ label: 'Voices', options: MONO_OPTS, onChange }));
    ctl.bend = binder.ctl(P('bendEnabled'), (onChange) => C.toggle({
      label: 'Pitch bend', title: 'The pitch-bend wheel bends this sound', onChange,
    }));
    ctl.pedal = binder.ctl(P('sustain'), (onChange) => C.toggle({
      label: 'Sustain pedal', title: 'Notes hold while the sustain pedal is down', onChange,
    }));
    const misc = h('div.ev2-slot-adv-row.ev2-slot-adv-misc', {},
      ctl.transpose.el, ctl.voices.el, ctl.bend.el, ctl.pedal.el);

    // the instrument's own settings (Advanced › engine); the smart-mapped ones live in THE SOUND ITSELF
    const params = (meta && Array.isArray(meta.params) ? meta.params : []).filter((p) => p && p.key);
    const mappedKeys = new Set(specs.filter((s) => s.key).map((s) => s.key));
    const grid = h('div.ev2-slot-params');
    const readParam = (p) => (s) => {
      const sl = slotOf(s);
      if (!sl) return undefined;
      const v = sl.params ? sl.params[p.key] : undefined;
      return v === undefined ? p.default : v;
    };
    for (const p of params) {
      if (mappedKeys.has(p.key)) {
        const sp = specs.find((s) => s.key === p.key);
        toneNames.push(`${p.label || capital(p.key)} → ${sp.label}`);
        continue;
      }
      const addr = P(`params.${p.key}`);
      const label = p.label || capital(p.key);
      let c;
      if (p.unit === 'bool' || typeof p.default === 'boolean') {
        c = binder.ctl(addr, (onChange) => C.toggle({ label, onChange }), { read: readParam(p) });
      } else if (p.unit === 'enum' || Array.isArray(p.enum)) {
        const options = (p.enum || []).map((v) => ({ value: v, label: capital(v) }));
        c = binder.ctl(addr, (onChange) => C.select({ label, options, onChange }), { read: readParam(p) });
      } else {
        const min = Number.isFinite(p.min) ? p.min : 0;
        const max = Number.isFinite(p.max) ? p.max : 1;
        c = binder.ctl(addr, (onChange) => slider({
          label, min, max, curve: p.curve === 'log' && min > 0 ? 'log' : 'lin', step: p.step,
          default: typeof p.default === 'number' ? p.default : min, format: (v) => formatInstrumentParam(p, v),
          onChange,
        }), { read: readParam(p) });
      }
      c.el.dataset.param = p.key;
      grid.append(c.el);
    }
    const instName = meta ? displayName(slot, meta) : slot.instrument.id;
    const instBits = [h('b.ev2-slot-adv-h', { text: `${instName} settings` })];
    if (params.length) {
      const reset = h('button.ev2-btn.sm.ghost.ev2-slot-preset', { type: 'button', text: 'Reset these settings' });
      reset.addEventListener('click', () => {
        // write every default explicitly (removing keys would not reach an older controller; views/edit.js)
        for (const p of params) {
          if (p.default !== undefined && p.default !== null) ctx.set(P(`params.${p.key}`), p.default);
        }
      });
      instBits.push(reset);
    }
    const hint = !meta ? 'Instrument details appear once sound has started.'
      : !params.length ? 'This instrument has no extra settings.' : '';
    const movedNote = toneNames.length
      ? h('p.ev2-hint.ev2-slot-moved', { text: `In The sound itself above: ${toneNames.join(' · ')}.` }) : null;
    const inst = h('div.ev2-slot-inst', {},
      h('div.ev2-slot-inst-head', {}, ...instBits),
      hint ? h('p.ev2-hint.ev2-slot-inst-hint', { text: hint }) : null,
      movedNote,
      grid.childElementCount ? grid : null);
    // Tone: the keyboard EQ (ctx.C.eqKeyboard), lazy — see syncTone()
    let tone = null;
    if (hasParam(P('eq.b1.db'))) {
      const toneHost = h('div.ev2-slot-tone-host');
      tone = section(`slot${i}-tone`, 'Tone', {
        binder, rels: [`${rel}.eq`], cls: 'ev2-slot-tone', summary: (s) => eqSummary(slotOf(s)?.eq),
      }, h('p.ev2-hint.ev2-slot-tone-hint', {
        text: 'Double-tap the curve to add a band, drag it to shape the sound.'
          + (shelfNames.length ? ` ${shelfNames.join(', ')} (The sound itself, above).` : ''),
      }), toneHost);
      tone.addEventListener('toggle', syncTone);
      ctl.tone = tone;
      ctl.toneHost = toneHost;
    }
    const adv = section(`slot${i}-adv`, 'Advanced', {
      binder, rels: [rel], cls: 'ev2-slot-adv', summary: (s) => advSummary(slotOf(s), mapped),
    }, strip, misc, inst, tone);
    ctl.adv = adv;
    adv.addEventListener('toggle', () => {
      syncTone();
      if (adv.open) requestAnimationFrame(() => adv.scrollIntoView?.({ block: 'nearest' }));
    });
    ctl.chg = h('span.ev2-chg.ev2-slot-chgline', {}, changedDot(), h('span.ev2-slot-chgtext'));
    const foot = h('div.ev2-foot.ev2-slot-foot', {}, adv, ctl.chg);

    return h('div.ev2-slot-filled', {},
      h('div.ev2-cols.ev2-slot-cols', {}, os, snd, play),
      foot);
  }

  /** A word slider (lib.wordSlider; its cancelDrag only acts on a running drag since hv2-edit-integrate). */
  function slider(o) {
    return wordSlider(o);
  }

  // ---- the strip EQ's shelves (Brightness / Warmth) and the Tone editor -------------------------------------------
  /** dB of the EQ's highest high shelf / lowest low shelf (0 when there is none). */
  function shelfDb(eq, which) {
    const type = which === 'high' ? 'highshelf' : 'lowshelf';
    const list = readEq(eq).bands.filter((b) => b.type === type);
    const b = which === 'high' ? list[list.length - 1] : list[0];
    return b ? b.db : 0;
  }
  function writeShelf(which, db) {
    const sl = curSlot();
    if (!sl) return;
    for (const [k, v] of shelfWrites(sl.eq, which, db)) ctx.set(P(`eq.${k}`), v);
  }
  /** @type {object|null} the mounted eqKeyboard */
  let toneEq = null;
  const toneStats = { created: 0, destroyed: 0 };
  /** Mount the EQ while Advanced and Tone are both open; destroy it otherwise (and before any rebuild). */
  function syncTone() {
    const c = body && body.ctl;
    const want = !!(c && c.adv && c.tone && c.adv.open && c.tone.open);
    if (want && !toneEq) mountTone(c);
    else if (!want && toneEq) destroyTone();
  }
  function mountTone(c) {
    if (typeof C.eqKeyboard !== 'function') {
      c.toneHost.replaceChildren(h('p.ev2-hint', { text: 'The tone editor needs the full app.' }));
      return;
    }
    try {
      toneEq = C.eqKeyboard({
        store: ctx.store, engine: ctx.engine, controller: ctx.controller, slotIndex: i,
        toast: (msg) => ctx.toast(msg, 'info'),
      });
    } catch (err) {
      console.warn('[edit] tone editor failed to mount', err);
      toneEq = null;
      return;
    }
    toneStats.created += 1;
    c.toneHost.replaceChildren(toneEq.el);
  }
  function destroyTone() {
    const e = toneEq;
    toneEq = null;
    if (!e) return;
    try {
      e.destroy();
    } catch (err) {
      console.warn('[edit] tone editor destroy failed', err);
    }
    toneStats.destroyed += 1;
  }
  /** The mini curve's click / a jump: open Advanced → Tone and bring it into view. */
  function openTone() {
    const c = body && body.ctl;
    if (!c || !c.tone) return;
    c.adv.open = true;
    c.tone.open = true;
    syncTone();
    focusEl(c.tone);
  }

  /** Song-bound note field: "C3", "F#2" or a MIDI number (round2-ui #3: writes the song it was focused on). */
  function noteField(binder, label, f) {
    const addr = P(f);
    const input = h('input.ev2-slot-note', {
      type: 'text', inputmode: 'text', spellcheck: 'false', autocomplete: 'off', size: 4, 'aria-label': `${label} key`,
    });
    const commit = ctx.songField(input, relOf(addr));
    const comp = {
      el: input,
      set: (v) => {
        input.value = noteName(Number(v));
        input.title = `Key ${noteName(Number(v))} (MIDI note ${v})`;
      },
    };
    input.addEventListener('change', () => {
      const raw = input.value.trim();
      const n = parseKey(raw);
      if (n !== null) commit(n);
      else ctx.toast(`“${raw}” is not a key name — try C4 or F#2`, 'warn');
      if (ctx.fieldSongId(input) !== ctx.songId()) return; // written to the song we just left
      const cur = getIn(ctx.song(), relOf(addr));
      if (cur !== undefined) comp.set(cur);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
    });
    binder.ctl(addr, () => comp, { text: true });
    return input;
  }

  /** Tiny velocity-curve graph (x = how hard you play, y = how loud it sounds), drawn in the slot colour. */
  function curveSpark() {
    const cv = h('canvas.ev2-slot-spark', { width: 128, height: 56, role: 'img', 'aria-label': 'Response curve' });
    return {
      el: cv,
      draw(curve) {
        cv.dataset.curve = curve;
        cv.title = `${TOUCH_HINTS[curve] || ''} Left = soft key press, right = hard.`;
        const g = cv.getContext && cv.getContext('2d');
        if (!g) return;
        const W = cv.width;
        const H = cv.height;
        const pad = 5;
        g.clearRect(0, 0, W, H);
        g.strokeStyle = 'rgba(255,255,255,.18)';
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(pad, H - pad);
        g.lineTo(W - pad, pad); // the "Normal" diagonal for reference
        g.stroke();
        g.strokeStyle = (getComputedStyle(root).getPropertyValue('--c') || '').trim() || ROLE_COLORS[i];
        g.lineWidth = 4;
        g.lineJoin = 'round';
        g.beginPath();
        for (let v = 1; v <= 127; v += 2) {
          const x = pad + ((v - 1) / 126) * (W - 2 * pad);
          const y = H - pad - curveVelocity(v, curve) * (H - 2 * pad);
          if (v === 1) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.stroke();
      },
      destroy() {
        cv.remove();
      },
    };
  }

  /** "Pan Center · Width 100% · Highs 0 dB · Transpose 0 · Voices All · Pitch bend Off" (+ "Light touch"). */
  function advSummary(slot, mapped) {
    if (!slot) return '';
    const parts = [];
    const pan = Number(slot.pan) || 0;
    parts.push(`Pan ${Math.abs(pan) < 0.005 ? 'Center' : formatValue(P('pan'), pan)}`);
    if (hasParam(P('width')) && !mapped.has('width')) {
      const w = typeof slot.width === 'number' ? slot.width : describe(P('width')).default;
      parts.push(`Width ${w < 0.005 ? 'Mono' : pct(w)}`);
    }
    if (hasParam(P('eq.b1.db'))) parts.push(`Tone ${eqSummary(slot.eq)}`);
    parts.push(`Transpose ${signed(Math.round(Number(slot.transpose) || 0))}`);
    parts.push(`Voices ${VOICE_WORDS[slot.mono] || 'All'}`);
    parts.push(`Pitch bend ${slot.bendEnabled ? 'On' : 'Off'}`);
    if (slot.velocityCurve && slot.velocityCurve !== 'normal') parts.push(`${TOUCH_LABELS[slot.velocityCurve]} touch`);
    return parts.join(' · ');
  }

  // ---- "Set lowest… / Set highest…": a one-shot on the next held note (editState 'notes') ---------------------
  /** @type {'low'|'high'|null} */
  let armed = null;
  let heldBefore = new Set();
  function renderArm() {
    const c = body && body.ctl;
    if (!c || !c.armLow) return;
    for (const [b, w, text] of [[c.armLow, 'low', 'Set lowest…'], [c.armHigh, 'high', 'Set highest…']]) {
      const on = armed === w;
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('armed', on);
      setText(b, on ? 'Play a key…' : text);
      b.title = on ? 'Play the key on your keyboard now (Esc or a click cancels)'
        : `${text.slice(0, -1)} key: tap, then play it`;
    }
    setText(c.armHint, armed
      ? `Play the ${armed === 'low' ? 'lowest' : 'highest'} key ${role()} should play. Esc cancels.`
      : 'Tap Set, then play the key on your keyboard.');
  }
  function toggleArm(which) {
    if (armed === which) {
      disarm();
      return;
    }
    closeMenu(false);
    armed = which;
    heldBefore = new Set(ctx.held());
    renderArm();
  }
  function disarm() {
    if (!armed) return false;
    armed = null;
    renderArm();
    return true;
  }
  function onNotes(e) {
    const held = (e && e.detail && e.detail.held) || ctx.held();
    if (!armed) {
      heldBefore = new Set(held);
      return;
    }
    const fresh = [...held].filter((n) => !heldBefore.has(n));
    heldBefore = new Set(held);
    if (!fresh.length) return;
    const sl = curSlot();
    const which = armed;
    disarm();
    if (!sl) return;
    if (which === 'low') {
      const n = Math.min(...fresh);
      ctx.set(P('lowNote'), n);
      if (n > sl.highNote) ctx.set(P('highNote'), 127);
    } else {
      const n = Math.max(...fresh);
      ctx.set(P('highNote'), n);
      if (n < sl.lowNote) ctx.set(P('lowNote'), 0);
    }
  }

  // ---- sentence title ----------------------------------------------------------------------------------------------
  let titleKey = '';
  const controlFor = (key) => {
    const c = () => body && body.ctl;
    switch (key) {
      case 'instrument':
        return () => {
          openMenu({ focus: false });
          return menuEl;
        };
      case 'muted':
        return () => c()?.tile?.el;
      case 'range':
        return () => c()?.rangeBox;
      case 'octave':
        return () => c()?.octave?.el;
      case 'reverb':
        return () => c()?.space?.el;
      case 'sustain':
        return () => c()?.sustain?.el;
      default:
        return null;
    }
  };
  function renderTitle(force = false) {
    const s = ctx.song();
    const slot = slotOf(s);
    const meta = metaOf(slot);
    const sp = s ? matchPreset(SPACE_PRESETS, ctx.valueOf) : null;
    const parts = describeSlot(slot, meta, {
      role: role(), name: slot ? displayName(slot, meta) : undefined, spaceName: sp ? sp.name : 'Space',
      isChanged: (f) => ctx.editState.isChanged(`${REL()}.${f}`),
    });
    let sub;
    if (!slot) sub = 'Pick a sound for this part of your rig';
    else if (!meta) {
      sub = `${slot.instrument.id} isn’t available on this computer · ${JUMP_HINT}`;
    }
    else {
      const credit = /\(([^)]+)\)\s*$/.exec(meta.name);
      const type = String(meta.ref?.id || '').startsWith('user:') ? 'your samples' : TYPE_WORDS[meta.ref?.type] || '';
      const shown = displayName(slot, meta);
      const what = `${type}${credit && shown !== meta.name ? ` (${credit[1]})` : ''}`;
      sub = `${[groupOf(meta), what].filter(Boolean).join(' · ')} · ${JUMP_HINT}`;
    }
    const ic = (meta && GROUP_ICONS[meta.group]) || ROLE_ICONS[i] || 'piano';
    setText(chgLabel, slot ? 'Change instrument' : 'Add a sound');
    const key = JSON.stringify([parts, sub, ic, i]);
    if (!force && key === titleKey) return;
    titleKey = key;
    const hadFocus = menuOpen && menuEl.contains(document.activeElement) ? document.activeElement : null;
    ctx.setTitle(parts.map((p) => (p && p.key ? { ...p, control: controlFor(p.key) } : p)), {
      sub, icon: ic, actions: actions,
    });
    hadFocus?.focus({ preventScroll: true }); // re-appending the actions node blurs an open menu's item
  }

  // ---- changed dots + footer ----------------------------------------------------------------------------------------
  function refreshLoaded() {
    if (!body) return;
    const base = ctx.editState.baseline;
    for (const { chip, f } of body.chips) chip.setLoaded?.(getIn(base, `${REL()}.${f}`));
  }
  function renderFoot() {
    const c = body && body.ctl;
    if (!c || !c.chg) return;
    const n = ctx.editState.changeCount([REL()]);
    setText(c.chg.querySelector('.ev2-slot-chgtext'), changeText(n));
    c.chg.classList.toggle('none', n === 0);
  }

  // ---- focus (opts.focus: 'instrument' | 'range') ------------------------------------------------------------------
  let flashTimer = 0;
  function focusEl(target) {
    if (!(target instanceof Element)) return;
    const det = target.closest('details');
    if (det && !det.open) det.open = true;
    target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    const f = target.matches(FOCUSABLE) ? target : target.querySelector(FOCUSABLE);
    f?.focus({ preventScroll: true });
    for (const x of root.querySelectorAll('.ev2-flash')) x.classList.remove('ev2-flash');
    target.classList.add('ev2-flash');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => target.classList.remove('ev2-flash'), 900);
  }
  function applyFocus(focus) {
    if (focus === 'instrument') openMenu({ focus: true });
    else if (focus === 'range') {
      if (body && body.ctl.rangeBox) focusEl(body.ctl.rangeBox);
      else openMenu({ focus: true }); // an empty slot has no range yet: offer the picker
    }
  }

  // ---- wiring ------------------------------------------------------------------------------------------------------
  // registered before any binder, so on a store batch this runs first and a rebuild replaces the binder before the
  // old one's (then empty) subscription runs
  ctx.subscribe((e) => {
    const slot = slotOf(e.song);
    if (slotKey(slot) !== (body && body.key)) build();
    else if (e.songChanged || e.full) refreshLoaded();
    renderEmptyUndo();
    renderTitle();
    renderFoot();
  });
  ctx.listen(ctx.editState, 'changes', () => {
    refreshLoaded();
    renderTitle();
    renderFoot();
  });
  ctx.listen(ctx.editState, 'instruments', () => {
    if (slotKey(curSlot()) !== (body && body.key)) build();
    renderTitle();
    if (menuOpen) buildMenu();
  });
  ctx.listen(ctx.editState, 'notes', onNotes);
  ctx.onLeaveSong(() => {
    closeMenu(false);
    cancelConfirm(false);
    disarm();
  });
  ctx.onEscape(() => {
    if (cancelConfirm(true)) return true;
    if (closeMenu(true)) return true;
    return disarm();
  });
  // an outside pointer closes the menu and disarms "Set lowest/highest" (the on-screen keyboard is not "outside":
  // playing a key there is how the one-shot is answered)
  ctx.listen(document, 'pointerdown', (e) => {
    const t = e.target;
    if (menuOpen && !actions.contains(t)) closeMenu(false);
    if (armed && !(t.closest && (t.closest('.ev2-slot-arm') || t.closest('.ev2-bottom') || t.closest('[data-note]')))) {
      disarm();
    }
  }, true);

  build();
  renderTitle(true);
  applyFocus(opts.focus);

  return {
    update(next = {}) {
      const ni = slotIndex(next);
      if (ni !== i) {
        closeMenu(false);
        cancelConfirm(false);
        disarm();
        i = ni;
        paintSlot();
        miniEq?.setSlot(ni);
        build();
      }
      renderTitle(true);
      renderFoot();
      applyFocus(next.focus);
    },
    destroy() {
      clearTimeout(flashTimer);
      closeMenu(false);
      cancelConfirm(false);
      destroyTone();
      miniEq?.destroy();
      body?.binder.destroy();
      body = null;
      root.remove();
    },
    /** Test hooks. */
    _debug: {
      slot: () => i,
      bodyKey: () => body && body.key,
      undo: () => undo,
      /** the Tone editor: mounted instance (or null) and how many were created / destroyed */
      tone: () => ({ inst: toneEq, mounted: !!toneEq, ...toneStats }),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
/** @param {{slot?:number}} o @returns {number} 0..3 */
function slotIndex(o) {
  const n = Math.round(Number(o && o.slot));
  return Number.isInteger(n) && n >= 0 && n < BLOCKS.length && BLOCKS[n].panel === 'slot' ? n : 0;
}
const formatAmount = (v) => (Number(v) > 0.0005 ? `${Math.round(Number(v) * 100)}%` : 'off');
const formatOctave = (v) => (v > 0 ? `+${v}` : v < 0 ? `${MINUS}${-v}` : 'normal');
const AMOUNT_FALLBACK = [1, 0.75, 0.5, 0.25, 0].map((v) => ({ value: v, label: v ? `${v * 100}%` : 'Off' }));
const OCTAVE_FALLBACK = [2, 1, 0, -1, -2].map((v) => ({ value: v, label: v === 0 ? 'Normal' : `${signed(v)} oct` }));
const SUSTAIN_FALLBACK = [{ value: true, label: 'Sustain' }, { value: false, label: 'Sustain off' }];

/** ctx.C.onTile, or a toggle stand-in when the fallback component set lacks it (CONTRACT.md §3.2). */
function makeTile(C, o) {
  if (typeof C.onTile === 'function') return C.onTile(o);
  const t = C.toggle({ label: o.label, value: true, onChange: o.onToggle });
  t.el.classList.add('ev2-slot-tile-fb');
  return t;
}
/** ctx.C.stepChip, or a cycling button stand-in (fallback components). */
function makeChip(C, o) {
  if (typeof C.stepChip === 'function') return C.stepChip(o);
  let value = o.value;
  const b = h('button.ev2-btn.sm.ev2-slot-chip-fb', { type: 'button' });
  const render = () => setText(b, `${o.label} ${o.format ? o.format(value) : value}`);
  b.addEventListener('click', () => {
    const k = o.steps.findIndex((s) => s.value === value);
    value = o.steps[(k + 1) % o.steps.length].value;
    render();
    o.onChange && o.onChange(value);
  });
  render();
  return {
    el: b,
    set(v) {
      value = v;
      render();
    },
    setLoaded() {},
    setHint() {},
    destroy() {
      b.remove();
    },
  };
}
