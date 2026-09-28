// OWNER: song agent (views/edit/CONTRACT.md §6). The Song panel (block 'song', no tab): Easy Transpose, tempo and
// notes. The header's KEY / BPM / Notes chips open it with {focus:'key'|'tempo'|'notes'} (CONTRACT §1 placement).
// Behaviour copied from views/edit.js (keySelect, trSentence, tempo field, Tap, debounced notes) so the ui-edit tests
// "Easy Transpose", "tap tempo", "song name + notes" and "round2-ui #3" port 1:1.
import { keyName, mod12 } from '../../../shared/music.js';
import { transposeSemisOf } from '../../../store.js';
import {
  h, setText, createBinder, bpmFromTaps, semitones, MINUS, SONG_BLOCK, changedDot, changeText,
} from '../lib.js';

/** Song-relative paths of the key (the KEY chip dot and the title's key words). */
export const KEY_RELS = Object.freeze(['hearIn', 'playIn', 'transposeOctave', 'minor']);
/** Notes debounce (edit.js: 500 ms). */
export const NOTES_DEBOUNCE_MS = 500;
const FOCUS_SEC = Object.freeze({ key: 'song-key', tempo: 'song-tempo', notes: 'song-notes' });
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
    // Not `text:true`: a focused field still follows outside writes (Tap, the header, a song switch) until the user
    // types in it; only then is their draft protected (binder.text would freeze it for the whole focus).
    let tempoDirty = false;
    tempoInput.addEventListener('input', () => {
      tempoDirty = true;
    });
    tempoInput.addEventListener('focus', () => {
      tempoDirty = false;
    });
    binder.ctl('song.tempo', () => ({
      el: tempoInput,
      set: (v) => {
        if (tempoDirty && document.activeElement === tempoInput) return;
        tempoInput.value = v === null || v === undefined ? '' : String(Math.round(v));
      },
    }), { read: (s) => (s.tempo === null || s.tempo === undefined ? null : s.tempo) });
    const commitTempo = ctx.songField(tempoInput, 'tempo');
    tempoInput.addEventListener('change', () => {
      tempoDirty = false;
      const raw = tempoInput.value.trim();
      if (raw === '') commitTempo(null);
      else if (Number.isFinite(Number(raw))) commitTempo(Math.round(Number(raw)));
      // show what the store kept (clamped 30–300) unless the field belonged to a song we already left
      if (ctx.fieldSongId(tempoInput) !== ctx.songId()) return;
      const cur = ctx.song();
      tempoInput.value = cur && cur.tempo !== null && cur.tempo !== undefined ? String(Math.round(cur.tempo)) : '';
    });
    tempoInput.addEventListener('keydown', (e) => {
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
    const tempoCol = h('div.ev2-col.ev2-song-col', { dataset: { sec: 'song-tempo' } },
      h('h3.ev2-cap', { text: 'Tempo' }),
      h('p.ev2-col-sub', { text: 'Synced echoes follow it. Tap 2–4 times in time.' }),
      h('div.ev2-song-row.mid', {},
        h('label.ev2-song-tempowrap', {}, tempoInput, h('span.ev2-song-unit', { text: 'BPM' })), tapBtn, clearBtn),
    );

    // ---- Notes (song-notes): song-bound, debounced 500 ms, flushed on blur and before the song changes
    const notesArea = h('textarea.ev2-song-notes', {
      rows: 6, maxlength: 10000, 'aria-label': 'Song notes', placeholder: 'Notes for this song (shown in Perform)',
    });
    binder.ctl('song.notes', () => ({ el: notesArea, set: (v) => (notesArea.value = v ?? '') }), { text: true });
    const commitNotes = ctx.songField(notesArea, 'notes');
    let notesTimer = null;
    const flushNotes = () => {
      clearTimeout(notesTimer);
      notesTimer = null;
      commitNotes(notesArea.value);
    };
    notesArea.addEventListener('input', () => {
      clearTimeout(notesTimer);
      notesTimer = setTimeout(flushNotes, NOTES_DEBOUNCE_MS);
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
      h('div.ev2-cols.ev2-song-cols', {}, keyCol, tempoCol, notesCol),
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
