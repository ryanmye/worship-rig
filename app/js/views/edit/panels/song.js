// OWNER: song agent (views/edit/CONTRACT.md §6). The Song panel (block 'song', no tab): Easy Transpose, tempo (+ the
// song's scenes, v11-scenes) and notes. The header's KEY / BPM / Notes chips open it with {focus:'key'|'tempo'|'notes'} (CONTRACT §1 placement).
// Behaviour copied from views/edit.js (keySelect, trSentence, tempo field, Tap, debounced notes) so the ui-edit tests
// "Easy Transpose", "tap tempo", "song name + notes" and "round2-ui #3" port 1:1.
import { keyName, mod12 } from '../../../shared/music.js';
import { transposeSemisOf } from '../../../store.js';
import { TIME_SIGS, DEFAULT_TIME_SIG, clickSettingsOf } from '../../../shared/click-math.js';
import {
  h, setText, createBinder, bpmFromTaps, semitones, MINUS, SONG_BLOCK, changedDot, changeText,
} from '../lib.js';
import { say } from '../../components/voice.js';
import { scenesOf } from '../../../shared/scenes.js';

/** Song-relative paths of the key (the KEY chip dot and the title's key words). */
export const KEY_RELS = Object.freeze(['hearIn', 'playIn', 'transposeOctave', 'minor']);
/** Notes debounce (edit.js: 500 ms). */
export const NOTES_DEBOUNCE_MS = 500;
const FOCUS_SEC = Object.freeze({ key: 'song-key', tempo: 'song-tempo', click: 'song-click', notes: 'song-notes' });
const TITLE_SUB = 'Easy Transpose, tempo and notes for this song · click an underlined word to jump to it';
const FOCUSABLE = 'select:not([disabled]), input:not([disabled]), textarea:not([disabled]), button:not([disabled])';

/**
 * The Easy Transpose readout (edit.js trSentence).
 * @param {object} s song
 * @returns {string} "No transpose — you hear what you play (D)." / "Play in C, sounds in D (+2 semitones)."
 */
export function transposeText(s) {
  const semis = transposeSemisOf(s);
  return semis === 0
    ? `No transpose — you hear what you play (${keyName(s.hearIn, s.minor)}).`
    : `Play in ${keyName(s.playIn, s.minor)}, sounds in ${keyName(s.hearIn, s.minor)} (${semitones(semis)}).`;
}

/** "+1 oct" / "−1 oct" / '' for the header chip. @param {object} s */
export const octaveWord = (s) => {
  const o = Math.round(Number(s && s.transposeOctave) || 0);
  return o > 0 ? ` +${o} oct` : o < 0 ? ` ${MINUS}${-o} oct` : '';
};

/**
 * Tap tempo (edit.js tapBtn): a gap > 2 s starts over, the last ≤ 4 taps count, 30–300 BPM is written rounded.
 * @param {(bpm:number) => void} write
 * @param {() => number} [now]
 * @returns {{tap():number|null, reset():void}} tap() returns the raw BPM (null with < 2 taps)
 */
export function createTapper(write, now = () => performance.now()) {
  let taps = [];
  return {
    tap() {
      const t = now();
      if (taps.length && t - taps[taps.length - 1] > 2000) taps = [];
      taps.push(t);
      taps = taps.slice(-4);
      const bpm = bpmFromTaps(taps);
      if (bpm !== null && bpm >= 30 && bpm <= 300) write(Math.round(bpm));
      return bpm;
    },
    reset() {
      taps = [];
    },
  };
}

/** Restart the Tap button's flash animation. @param {HTMLElement} b */
export function flashTap(b) {
  b.classList.remove('ev2-song-flash');
  void b.offsetWidth; // restart the CSS animation
  b.classList.add('ev2-song-flash');
}

/**
 * v11-metronome: the click level as words for the level slider (0 = off).
 * @param {number} v linear 0..1
 * @returns {string}
 */
export const clickLevelText = (v) => (v > 0.0005 ? `${Math.round(20 * Math.log10(v))} dB` : 'off');

/** A labelled field: caption over the control. */
const field = (label, node, cls = '') =>
  h('div.ev2-song-field', { class: cls }, h('span.ev2-song-flabel', { text: label }), node);

export default {
  id: 'song',
  icon: 'song',
  mount(el, ctx, opts) {
    const { C } = ctx;
    const binder = createBinder(ctx);

    // ---- Easy Transpose (song-key)
    const keySelect = (addr, label) => {
      const s = h('select.ev2-song-select', { 'aria-label': label });
      for (let pc = 0; pc < 12; pc++) s.append(h('option', { value: String(pc) }));
      s.addEventListener('change', () => ctx.set(addr, Number(s.value)));
      binder.ctl(addr, () => ({ el: s, set: (v) => (s.value = String(mod12(v))) }));
      // relabel when minor flips: "C#m" / "Bbm" (ui-edit "Easy Transpose")
      binder.fn(['minor'], (sg) => [...s.options].forEach((o, pc) => setText(o, keyName(pc, !!sg.minor))));
      return field(label, s);
    };
    const octave = binder.ctl('song.transposeOctave', (onChange) => C.segmented({
      label: 'Octave',
      options: [{ value: -1, label: `${MINUS}1` }, { value: 0, label: '0' }, { value: 1, label: '+1' }],
      onChange,
      className: 'ev2-song-seg',
    }));
    const minor = binder.ctl('song.minor', (onChange) => C.toggle({ label: 'Minor', onChange }), {
      read: (s) => !!s.minor,
    });
    const readout = h('p.ev2-song-readout', { 'aria-live': 'polite' });
    binder.fn(KEY_RELS, (s) => setText(readout, transposeText(s)));
    const keyCol = h('div.ev2-col.ev2-song-col', { dataset: { sec: 'song-key' } },
      h('h3.ev2-cap', { text: 'Easy Transpose' }),
      h('p.ev2-col-sub', { text: 'Play in a key that’s easy for your hands; the rig moves it to the song’s key.' }),
      h('div.ev2-song-row', {}, keySelect('song.playIn', 'Play In'), keySelect('song.hearIn', 'Hear In')),
      h('div.ev2-song-row', {}, field('Octave', octave.el), field('Key', minor.el)),
      readout,
    );

    // ---- Tempo (song-tempo): number field (song-bound), Tap, Clear
    const tempoInput = h('input.ev2-song-tempo', {
      type: 'number', min: 30, max: 300, step: 1, placeholder: '—', 'aria-label': 'Tempo (beats per minute)',
    });
    // text:'dirty' (polish-1): a focused field still follows outside writes (Tap, the header, a song switch) until the
    // user types in it; only then is their draft protected (text:true would freeze it for the whole focus).
    binder.ctl('song.tempo', () => ({
      el: tempoInput,
      set: (v) => {
        tempoInput.value = v === null || v === undefined ? '' : String(Math.round(v));
      },
    }), { read: (s) => (s.tempo === null || s.tempo === undefined ? null : s.tempo), text: 'dirty' });
    const commitTempo = ctx.songField(tempoInput, 'tempo');
    tempoInput.addEventListener('change', () => {
      // round4-edit-lib m3: a number input with bad input ("1e", "-") reads value '', which would clear the tempo.
      // Show the stored tempo again instead; '' means Clear only when the field really is empty.
      if (tempoInput.validity?.badInput) {
        const cur = ctx.fieldSongId(tempoInput) === ctx.songId() ? ctx.song() : null;
        tempoInput.value = cur && cur.tempo !== null && cur.tempo !== undefined ? String(Math.round(cur.tempo)) : '';
        return;
      }
      const raw = tempoInput.value.trim();
      if (raw === '') commitTempo(null);
      else if (Number.isFinite(Number(raw))) commitTempo(Math.round(Number(raw)));
      // show what the store kept (clamped 30–300) unless the field belonged to a song we already left
      if (ctx.fieldSongId(tempoInput) !== ctx.songId()) return;
      const cur = ctx.song();
      tempoInput.value = cur && cur.tempo !== null && cur.tempo !== undefined ? String(Math.round(cur.tempo)) : '';
    });
    tempoInput.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return; // round4-edit-lib m2: the IME's own Enter / Esc
      if (e.key === 'Enter') tempoInput.blur(); // blur commits (change)
    });
    const tapBtn = h('button.ev2-btn.ev2-song-tap', {
      type: 'button', title: 'Tap 2–4 times in time', dataset: { tap: 'panel' }, text: 'Tap',
    });
    const tapper = createTapper((bpm) => ctx.set('song.tempo', bpm));
    tapBtn.addEventListener('click', () => {
      tapper.tap();
      flashTap(tapBtn);
    });
    const clearBtn = h('button.ev2-btn.sm.ghost.ev2-song-clear', {
      type: 'button', title: 'Remove the tempo from this song', text: 'Clear',
    });
    clearBtn.addEventListener('click', () => ctx.set('song.tempo', null));
    binder.fn(['tempo'], (s) => {
      clearBtn.disabled = s.tempo === null || s.tempo === undefined;
    });
    // ---- Click (v11-metronome): the time signature belongs to this song (song.timeSig, absent = 4/4); count-in, what
    // follows it and the level are for every song (settings.click, store.setClick). Perform's Click chip starts it.
    const sigSel = h('select.ev2-song-select.ev2-song-sig', { 'aria-label': 'Time signature' });
    for (const sg of TIME_SIGS) sigSel.append(h('option', { value: sg, text: sg }));
    // 4/4 is the default, so choosing it removes the optional field again
    sigSel.addEventListener('change', () => {
      ctx.set('song.timeSig', sigSel.value === DEFAULT_TIME_SIG ? null : sigSel.value);
    });
    binder.ctl('song.timeSig', () => ({ el: sigSel, set: (v) => (sigSel.value = v || DEFAULT_TIME_SIG) }), {
      read: (sg) => sg.timeSig || DEFAULT_TIME_SIG,
    });
    const clickCfg = () => clickSettingsOf(ctx.store.get().settings);
    const countIn = C.segmented({
      label: 'Count-in',
      options: [{ value: 0, label: 'Off' }, { value: 1, label: '1 bar' }, { value: 2, label: '2 bars' }],
      onChange: (v) => ctx.store.setClick({ countIn: Number(v) }),
      className: 'ev2-song-seg',
    });
    countIn.el.dataset.bind = 'settings.click.countIn';
    const after = C.segmented({
      label: 'After the count-in',
      options: [{ value: 'click', label: 'Keep clicking' }, { value: 'quiet', label: 'Go quiet' }],
      onChange: (v) => ctx.store.setClick({ after: v === 'quiet' ? 'quiet' : null }),
      className: 'ev2-song-seg',
    });
    after.el.dataset.bind = 'settings.click.after';
    const level = C.fader({
      label: '', min: 0, max: 1, unit: 'lin', default: 0.6, format: clickLevelText,
      onChange: (v) => ctx.store.setClick({ level: Math.round(v * 1000) / 1000 }),
    });
    level.el.dataset.bind = 'settings.click.level';
    level.el.classList.add('ev2-song-clicklevel');
    const renderClickCfg = () => {
      const c = clickCfg();
      countIn.set(c.countIn);
      after.set(c.after);
      after.setDisabled?.(c.countIn === 0);
      level.set(c.level);
    };
    renderClickCfg();
    ctx.subscribe((ev) => {
      if (ev.paths.some((p) => p === 'settings' || p === 'settings.click')) renderClickCfg();
    });
    ctx.cleanup(() => {
      for (const c of [countIn, after, level]) c.destroy?.();
    });
    const clickCol = h('div.ev2-col.ev2-song-col.ev2-song-click', { dataset: { sec: 'song-click' } },
      h('h3.ev2-cap', { text: 'Click' }),
      h('p.ev2-col-sub', {
        text: 'Start it with Click on Perform. The time is this song’s; the rest is for every song.',
      }),
      h('div.ev2-song-row', {}, field('Time', sigSel), field('Count-in', countIn.el)),
      h('div.ev2-song-row', {}, field('After the count-in', after.el)),
      field('Level', level.el, 'ev2-song-clicklevel'),
    );
    // ---- Scenes (v11-scenes): saved levels to step through live. Actions go through controller.scenes (it captures
    // what plays, wheel included); the list is the song's `scenes` field. Under the tempo (the column with room left),
    // so the panel keeps its 3 columns; one compact row per scene.
    const scenesList = h('div.ev2-song-scenes', { 'data-testid': 'edit-scenes' });
    const scenesHint = h('p.ev2-col-sub.ev2-song-sceneshint');
    const scenesSec = h('div.ev2-song-scenesec', { dataset: { sec: 'song-scenes' } },
      h('h3.ev2-cap', { text: 'Scenes' }), scenesHint, scenesList);
    const sc = ctx.controller && ctx.controller.scenes;
    const renderScenes = () => {
      const s = ctx.song();
      const list = scenesOf(s);
      const st = sc ? sc.state() : { id: null, n: null };
      const playing = s && st.id === s.id ? st.n : null;
      const live = !!(sc && s && st.id === s.id); // the song that plays (one still loading has no scenes yet)
      setText(scenesHint, say('sceneEditSub'));
      scenesHint.title = say('sceneEditHint');
      const rows = list.map((_, n) => {
        const on = playing === n;
        const btn = (cls, text, title, run) => {
          const b = h(`button.ev2-btn.sm.ghost.${cls}`, { type: 'button', text, title, disabled: !live });
          b.addEventListener('click', run);
          return b;
        };
        // the playing one: accent label + Stop (no extra word: the column is narrow)
        return h('div.ev2-song-scene', { class: on ? 'on' : '', dataset: { n: String(n) },
          title: on ? `${say('sceneLabel', { n: n + 1 })} · ${say('scenePlaying')}` : '' },
          h('b', { text: say('sceneLabel', { n: n + 1 }) }),
          btn('ev2-song-sceneplay', on ? 'Stop' : 'Play', on ? say('sceneBack') : 'Play this scene now (it glides)',
            () => sc.go(on ? null : n)),
          btn('ev2-song-scenesave', 'Save', say('sceneSaveTitle', { n: n + 1 }), () => sc.save(n)),
          btn('ev2-song-scenedel', '×', `Delete scene ${n + 1}`, () => sc.remove(n)));
      });
      const max = sc ? sc.max : 3;
      if (list.length < max) {
        const add = h('button.ev2-btn.sm.ev2-song-sceneadd', {
          type: 'button', disabled: !live, text: `${say('sceneSaveCap')} ${list.length + 1}`,
          title: say('sceneSaveTitle', { n: list.length + 1 }),
        });
        add.addEventListener('click', () => sc.save(list.length));
        rows.push(add);
      }
      if (!list.length) rows.unshift(h('span.ev2-song-scenesnone', { text: say('sceneNone') }));
      scenesList.replaceChildren(...rows);
    };
    binder.fn(['scenes'], renderScenes);
    if (sc) ctx.listen(ctx.controller, 'scene', renderScenes);
    if (ctx.controller) ctx.listen(ctx.controller, 'song', renderScenes);
    const tempoCol = h('div.ev2-col.ev2-song-col', { dataset: { sec: 'song-tempo' } },
      h('h3.ev2-cap', { text: 'Tempo' }),
      h('p.ev2-col-sub', { text: 'Synced echoes and the click follow it. Tap 2–4 times in time.' }),
      h('div.ev2-song-row.mid', {},
        h('label.ev2-song-tempowrap', {}, tempoInput, h('span.ev2-song-unit', { text: 'BPM' })), tapBtn, clearBtn),
      scenesSec,
    );

    // ---- Notes (song-notes): song-bound, debounced 500 ms, flushed on blur and before the song changes
    const notesArea = h('textarea.ev2-song-notes', {
      rows: 6, maxlength: 10000, 'aria-label': 'Song notes', placeholder: 'Notes for this song (shown in Perform)',
    });
    binder.ctl('song.notes', () => ({ el: notesArea, set: (v) => (notesArea.value = v ?? '') }), { text: 'dirty' });
    const commitNotes = ctx.songField(notesArea, 'notes');
    let notesTimer = null;
    const flushNotes = () => {
      clearTimeout(notesTimer);
      notesTimer = null;
      commitNotes(notesArea.value);
    };
    const armNotes = () => {
      clearTimeout(notesTimer);
      notesTimer = setTimeout(flushNotes, NOTES_DEBOUNCE_MS);
    };
    notesArea.addEventListener('input', (e) => {
      // round4-edit-lib M1: Chromium keeps one undo stack per frame, so ⌘Z anywhere (Perform included, via Edit ▸
      // Undo) can apply an undo/redo to this textarea while it is not focused, after the binder painted another
      // song's notes into it. Such an edit is never the user's typing here: show the store's text, commit nothing.
      if (document.activeElement !== notesArea) {
        clearTimeout(notesTimer);
        notesTimer = null;
        notesArea.value = ctx.song()?.notes ?? '';
        return;
      }
      // m2 (optional part): no commits of half-converted IME text; compositionend arms the debounce instead
      if (e.isComposing) return;
      armNotes();
    });
    notesArea.addEventListener('compositionend', () => {
      if (document.activeElement === notesArea) armNotes();
    });
    notesArea.addEventListener('blur', () => {
      if (notesTimer) flushNotes();
    });
    // round2-ui #3: the pending text belongs to the song it was typed in (commitNotes uses the focused song id)
    ctx.onLeaveSong(() => {
      if (notesTimer) flushNotes();
      tapper.reset();
    });
    const notesCol = h('div.ev2-col.ev2-song-col.ev2-song-notescol', { dataset: { sec: 'song-notes' } },
      h('h3.ev2-cap', { text: 'Notes' }),
      h('p.ev2-col-sub', { text: 'Shown in Perform under the song name.' }),
      notesArea,
    );

    // ---- footer: change line (only the key and tempo are watched; name/notes never get a dot, concept §2)
    const chg = h('span.ev2-chg', {}, changedDot(), h('span'));
    const renderChg = () => {
      const n = ctx.editState.changeCount(SONG_BLOCK.prefixes);
      chg.classList.toggle('none', n === 0);
      setText(chg.lastChild, changeText(n));
    };
    const foot = h('div.ev2-foot', {},
      h('span.ev2-song-foothint', { text: 'The name and notes save as you type.' }), chg);

    el.replaceChildren(
      h('div.ev2-cols.ev2-song-cols', {}, keyCol, tempoCol, clickCol, notesCol),
      foot,
    );

    // ---- sentence title: "This song is in D, you play in C, at 72 BPM"
    const renderTitle = () => {
      const s = ctx.song();
      if (!s) return;
      const es = ctx.editState;
      const oct = Math.round(Number(s.transposeOctave) || 0);
      ctx.setTitle([
        'This song is in ',
        {
          text: keyName(s.hearIn, s.minor), control: '[data-bind="song.hearIn"]',
          changed: es.isChanged(['hearIn', 'minor']),
        },
        ', you play in ',
        { text: keyName(s.playIn, s.minor), control: '[data-bind="song.playIn"]', changed: es.isChanged('playIn') },
        oct ? ', ' : '',
        oct ? {
          text: oct > 0 ? 'an octave up' : 'an octave down', control: '[data-bind="song.transposeOctave"]',
          changed: es.isChanged('transposeOctave'),
        } : '',
        ', at ',
        {
          text: s.tempo ? `${Math.round(s.tempo)} BPM` : 'no set tempo', control: '[data-bind="song.tempo"]',
          changed: es.isChanged('tempo'),
        },
      ], { icon: 'song', sub: TITLE_SUB });
    };
    binder.fn([...KEY_RELS, 'tempo'], renderTitle);
    ctx.listen(ctx.editState, 'changes', () => {
      renderTitle();
      renderChg();
    });
    renderChg();

    // ---- opts.focus: open, scroll to and focus the section's first control, and flash it
    let flashTimer = 0;
    ctx.cleanup(() => clearTimeout(flashTimer));
    const focusSec = (focus) => {
      const id = FOCUS_SEC[focus];
      if (!id) return;
      const sec = el.querySelector(`[data-sec="${id}"]`);
      if (!sec) return;
      sec.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      const f = sec.querySelector(FOCUSABLE);
      if (f) f.focus({ preventScroll: true });
      for (const x of el.querySelectorAll('.ev2-flash')) x.classList.remove('ev2-flash');
      sec.classList.add('ev2-flash');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => sec.classList.remove('ev2-flash'), 900);
    };
    focusSec(opts && opts.focus);

    return {
      update(next) {
        focusSec(next && next.focus);
      },
      destroy() {
        if (notesTimer) flushNotes(); // a tab switch mid-debounce keeps the text
        binder.destroy();
      },
    };
  },
};
