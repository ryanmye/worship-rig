// OWNER: drone+bottom agent (views/edit/CONTRACT.md §6). The Drone panel (block 'drone').
// Ported from views/edit.js "---- drone" (the Key drone card) into the H-v2 layout: a sentence title, an ON STAGE
// column (the same ON tile, source and level as the Perform drone card), THE SOUND ITSELF (word sliders) and OPTIONS
// (switches + the explanatory note), then the change line.
import { keyName } from '../../../shared/music.js';
import { droneOnMode } from '../../../shared/song-diff.js';
import { h, setText, createBinder, wordSlider, changedDot, changeText, editedSince, droneKeyText } from '../lib.js';

const PREFIXES = ['drone'];
const SOURCE_LABEL = { synth: 'Synth', files: 'My Pads' };

// droneKeyText lives in lib.js (hv2-edit-integrate: the shell's default drone tab uses it too); re-exported.
export { droneKeyText };

// Words for the character sliders. Brightness / Movement copy perform.js (brightnessWord / movementWord) so a word
// means the same on both pages; Width and Key fade are Edit-only.
const brightnessWord = (v) => (v < 0.25 ? 'Dark' : v < 0.55 ? 'Soft' : v < 0.8 ? 'Clear' : 'Bright');
const movementWord = (v) => (v < 0.1 ? 'Still' : v < 0.45 ? 'Gentle' : v < 0.75 ? 'Moving' : 'Restless');
const widthWord = (v) => (v < 0.1 ? 'Centred' : v < 0.45 ? 'Narrow' : v < 0.8 ? 'Wide' : 'Very wide');
const fadeWord = (v) => (v < 2.5 ? 'Quick' : v < 8 ? 'Smooth' : 'Slow');
const pctText = (v) => `${Math.round(Number(v) * 100)}%`;
const secText = (v) => `${Number(v).toFixed(v < 10 ? 1 : 0)} s`;

/** The three notes (edit.js droneNote): off / My Pads / synth. */
function noteText(s) {
  const m = s.drone?.mode;
  if (m === 'off') return 'The drone is off for this song.';
  if (m === 'files') {
    return 'Plays the pad file for this key from your My Pads folder (Settings). Chord follow only works with the '
      + 'synth drone.';
  }
  return `Synth drone in ${keyName(s.hearIn, s.minor)}: root, fifth and octave (plus a ninth when bright).`;
}

export default {
  id: 'drone',
  icon: 'drone',
  /**
   * @param {HTMLElement} el
   * @param {object} ctx  panel ctx (CONTRACT.md §3)
   * @param {{focus?:string}} [opts]
   */
  mount(el, ctx, opts = {}) {
    const { C, editState } = ctx;
    const binder = createBinder(ctx);
    const color = 'var(--drone, #e8d9a8)';
    // Last source the ON tile turned off (perform.js lastDroneSource, round-3 fix 5): OFF → ON brings back what was
    // playing, else the Revert snapshot's source (droneOnMode), else Synth. Kept by the shell (ctx.lastDroneSource)
    // so a tab switch does not forget it (round3-edit m4); the per-mount map is the fallback for older shells.
    const local = new Map();
    const lastSource = ctx.lastDroneSource || {
      get: () => local.get(ctx.songId()) || null,
      set: (mode) => local.set(ctx.songId(), mode),
    };

    // ---- ON STAGE: ON tile, source, level
    const setOn = (on) => {
      const s = ctx.song();
      if (!s) return;
      if (!on) {
        if (s.drone.mode !== 'off') lastSource.set(s.drone.mode);
        ctx.set('song.drone.mode', 'off');
      } else if (s.drone.mode === 'off') {
        ctx.set('song.drone.mode', lastSource.get() || droneOnMode(editState.baseline));
      }
      binder.refresh(['drone.mode']); // a refused write puts the tile back
    };
    let tile;
    if (typeof C.onTile === 'function') {
      tile = binder.track(C.onTile({
        label: 'DRONE', color, title: 'Tap to turn the drone on or off', onToggle: (on) => setOn(on),
      }));
    } else {
      // fallback component set (no onTile): a plain toggle with the same meaning
      tile = binder.track(C.toggle({ label: 'DRONE', title: 'Tap to turn the drone on or off', onChange: setOn }));
    }
    tile.el.classList.add('ev2-drone-tile');
    tile.el.dataset.droneOn = '';
    binder.fn(['drone.mode', 'hearIn', 'minor'], (s) => {
      tile.set(s.drone.mode !== 'off');
      tile.setSub?.(droneKeyText(s));
    });

    // Source: Synth / My Pads (no 'off' option: the ON tile is the off switch). While off nothing is pressed, and
    // picking a source turns the drone on with it.
    const source = binder.ctl('song.drone.mode', (onChange) => C.segmented({
      label: 'Drone sound',
      options: [
        { value: 'synth', label: 'Synth', title: 'The built-in synth drone' },
        { value: 'files', label: 'My Pads', title: 'Pad files from your My Pads folder (Settings)' },
      ],
      onChange,
    }), { read: (s) => (s.drone.mode === 'off' ? null : s.drone.mode) });
    source.el.classList.add('ev2-drone-src');
    const srcDot = changedDot('Source changed since the song was loaded');

    const level = binder.ctl('drone.gain', (onChange) => C.fader({
      path: 'drone.gain', label: 'Level', color, onChange,
    }));
    level.el.classList.add('ev2-drone-level');

    // ---- THE SOUND ITSELF
    const ws = (addr, o) => binder.ctl(addr, (onChange) => wordSlider({ color, ...o, onChange }));
    const sliders = [
      ws('drone.brightness', {
        label: 'Brightness', default: 0.5, word: brightnessWord, format: pctText, ends: ['darker', 'brighter'],
      }),
      ws('drone.movement', {
        label: 'Movement', default: 0.3, word: movementWord, format: pctText, ends: ['still', 'restless'],
      }),
      ws('drone.width', { label: 'Width', default: 0.7, word: widthWord, format: pctText, ends: ['centred', 'wide'] }),
      ws('drone.fade', {
        label: 'Key fade', min: 1, max: 20, default: 4, word: fadeWord, format: secText, ends: ['quick', 'slow'],
      }),
    ];

    // ---- OPTIONS: switches (each with its own changed dot) + the note
    const sw = (addr, label, title, extra = {}) => {
      const t = binder.ctl(addr, (onChange) => C.toggle({ label, title, onChange, ...extra }));
      const dot = changedDot();
      const row = h('div.ev2-drone-opt', {}, dot, t.el);
      return { t, dot, row, rel: addr.slice(5) };
    };
    const follow = sw('song.drone.chordFollow', 'Chord follow', 'The synth drone follows the chords you play',
      { tag: 'experimental' });
    const cont = sw('song.drone.continueAcrossSongs', 'Continues across songs',
      'Keeps sounding when you move to the next song');
    const minorPad = sw('song.drone.minorUsesRelativeMajorFile', 'Minor keys use the major pad',
      'For a minor key with no pad file, use the relative-major pad');
    const note = h('p.ev2-hint.ev2-drone-note', { 'aria-live': 'polite' });

    binder.fn(['drone', 'hearIn', 'minor'], (s) => {
      const files = s.drone.mode === 'files';
      follow.t.setDisabled?.(files);
      follow.t.el.classList.toggle('disabled', files);
      follow.t.el.title = files
        ? 'Chord follow only works with the synth drone'
        : 'The synth drone follows the chords you play';
      setText(note, noteText(s));
    });

    // ---- footer
    const chg = h('span.ev2-chg', {}, changedDot(), h('span.ev2-drone-chgtext'));
    const foot = h('div.ev2-foot.ev2-drone-foot', {},
      h('span.ev2-drone-foothint', { text: 'The ON tile and Level are live moves; they never count as changes.' }),
      chg);

    const col = (cap, sub, focus, ...kids) => h('div.ev2-col', { dataset: { focus } },
      h('div.ev2-cap', { text: cap }), sub ? h('p.ev2-col-sub', { text: sub }) : null, ...kids);
    const root = h('div.ev2-drone', {},
      h('div.ev2-cols.ev2-drone-cols', {},
        col('On stage', 'Same switch and level as the drone on your Perform page.', 'level',
          tile.el,
          h('div.ev2-drone-row', { dataset: { focus: 'source' } },
            h('span.ev2-drone-lbl', {}, srcDot, 'Sound'), source.el),
          level.el),
        col('The sound itself', 'A held chord in the song key under everything you play.', 'sound',
          h('div.ev2-drone-sliders', {}, ...sliders.map((x) => x.el))),
        col('Options', null, 'options', follow.row, cont.row, minorPad.row, note)),
      foot);
    el.replaceChildren(root);
    // OFF: the sound controls stay editable (you can shape it before turning it on) but read as resting
    binder.fn(['drone.mode'], (s) => {
      root.classList.toggle('off', s.drone.mode === 'off');
      level.setMuted?.(s.drone.mode === 'off'); // the Perform strip's muted fader look
    });

    // ---- changed dots, change line, title
    const renderChanges = () => {
      srcDot.hidden = !editState.isChanged('drone.mode');
      // switch-row dots keep their space when hidden, so the three switches stay aligned
      for (const x of [follow, cont, minorPad]) x.dot.classList.toggle('ev2-drone-nodot', !editState.isChanged(x.rel));
      const n = editState.changeCount(PREFIXES);
      // the drone's level and its ON tile (mode ↔ 'off') are playing moves, like a slot's fader and mute
      const edited = n === 0 && editedSince(ctx.song(), editState.baseline, ['drone'], ['gain', 'mode']);
      setText(chg.lastChild, changeText(n, edited));
      chg.classList.toggle('none', n === 0);
    };
    const renderTitle = (s) => {
      if (!s) return;
      const keyTok = {
        text: droneKeyText(s),
        title: 'Change the song key',
        // the key belongs to the song block: a function control that selects it and returns no element (the shell
        // then skips its focus/flash step)
        control: () => {
          ctx.select('song', { focus: 'key' });
          return null;
        },
      };
      const off = s.drone.mode === 'off';
      const srcTok = off
        ? { text: 'off', control: () => tile.el, title: 'Turn the drone on' }
        : {
          text: SOURCE_LABEL[s.drone.mode] || s.drone.mode,
          control: () => source.el,
          changed: editState.isChanged('drone.mode'),
          title: 'Go to the drone sound',
        };
      ctx.setTitle([{ text: 'DRONE', role: true }, ' holds ', keyTok, ' · ', srcTok], {
        icon: 'drone',
        sub: 'The key drone · click an underlined word to jump to its control',
      });
    };
    binder.fn(['drone', 'hearIn', 'minor'], renderTitle);
    ctx.listen(editState, 'changes', () => {
      renderChanges();
      renderTitle(ctx.song());
    });
    renderChanges();

    // ---- focus (no focus ids are sent to the drone today; 'source' / 'level' / 'sound' / 'options' are accepted)
    const focus = (o) => {
      const id = o && o.focus;
      if (!id) return;
      const target = root.querySelector(`[data-focus="${id}"]`);
      if (!target) return;
      target.scrollIntoView?.({ block: 'nearest' });
      const f = target.querySelector('button:not([disabled]), input:not([disabled]), select');
      f?.focus({ preventScroll: true });
    };
    focus(opts);

    return {
      update(next) {
        focus(next || {});
      },
      destroy() {
        binder.destroy();
      },
    };
  },
  /**
   * Tab text: the same key spelling as the title ("C# minor", not "Db minor"). The shell's default differs only
   * there.
   * @param {object} song
   * @returns {{name:string, sub:string, off:boolean}}
   */
  tab(song) {
    const off = song.drone?.mode === 'off';
    return { name: droneKeyText(song), sub: off ? '· off' : `· ${SOURCE_LABEL[song.drone?.mode] || 'Synth'}`, off };
  },
};
