// Sidebar module: Drone (D16 "Drone keeps today's key grid, Synth / My Pads and Keep across songs"; UI6-build-plan U3;
// mockup mock_v6.py drone()). Today's Key & drone card (views/perform.js) as a module: the same ON tile, Synth /
// My Pads, the key grid, Major / Minor, Level, Brightness, Movement, Follow chords, Continue across songs ("Keep
// across songs") and the pad-folder line, with the same writes (songs.<id>.drone.*, hearIn / playIn, minor) and the
// same Perform-lock rules (perform.js LOCK): the tile and Level stay live, the key grid and Major / Minor need a
// 600 ms hold, Synth / My Pads, Brightness, Movement and the toggles are frozen. "Sustain" (a drone pedal hold) is not
// in the engine or the store yet: shown disabled, "coming".
import { h, setText, disposer } from '../../components/util.js';
import { fader } from '../../components/fader.js';
import { toggle, segmented } from '../../components/buttons.js';
import { keyGrid } from '../../components/keys.js';
import { onTile } from '../../components/onTile.js';
import { say } from '../../components/voice.js';
import { keyName, transposeSemis, mod12 } from '../../../shared/music.js';
import { droneOnMode } from '../../../shared/song-diff.js';
import { holdGate, brightnessWord, movementWord } from '../../perform.js';
import { button } from '../lib.js';

/** "C major", "F# minor" (perform.js renderDroneReadout's wording). */
export const droneKeyLabel = (pc, minor) => `${keyName(pc, minor).replace(/m$/, '')} ${minor ? 'minor' : 'major'}`;

// skeptic UI6-U3 F2: the Synth / My Pads the ON tile turned off is remembered per song for as long as the sidebar
// lives (keyed by its module ctx), not per mount: today's card is always mounted and keeps it until the song changes,
// while this module is unmounted by every tab switch or fold, which made "off, look at the setlist, on" come back as
// Synth instead of My Pads.
const lastSources = new WeakMap(); // module ctx → {id, source}

export default {
  id: 'drone',
  label: 'Drone',
  blurb: 'key, level, sound',
  icon: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.2"/>',
  /**
   * Tab dot + rail key while the drone is on.
   * @param {object} state  store state
   * @returns {{live:boolean, text:string, title:string}|null}
   */
  badge(state) {
    const s = state.songs[state.settings.currentSongId];
    if (!s) return null;
    const on = s.drone.mode !== 'off';
    return {
      live: on, text: on ? keyName(s.hearIn, s.minor) : '',
      title: on ? `drone on, ${droneKeyLabel(s.hearIn, s.minor)}` : 'drone off',
    };
  },
  /**
   * @param {HTMLElement} el
   * @param {object} m  sidebar module ctx (the v6 view context + size)
   * @returns {{destroy():void}}
   */
  mount(el, m) {
    const { store, controller, engine } = m;
    const d = disposer();
    const comps = [];
    const use = (c) => (comps.push(c), c);
    let shownId = null;
    // Synth / My Pads before the tile turned the drone off (perform.js round-3 fix 5), per song (F2 above)
    if (!lastSources.has(m)) lastSources.set(m, { id: null, source: null });
    const last = lastSources.get(m);
    const lastSourceOf = (s) => (s && last.id === s.id ? last.source : null);
    let padsInfo = null;
    const song = () => store.currentSong();
    // D26.1: the drone as it plays (a snapshot may hold its ON / sound / key); a field the playing snapshot holds goes
    // on top of it (controller.scenes.take / adjust: heard, transient, kept by Save), never into the song
    const heard = (s = song()) => (s ? m.liveOf(s) : s);
    const setSong = (field, value) => {
      const s = song();
      if (!s) return false;
      return !!controller.scenes?.take?.(`songs.${s.id}.${field}`, value) || store.set(`songs.${s.id}.${field}`, value);
    };
    const setMinor = (minor) => {
      const h0 = heard();
      if (h0 && controller.scenes?.adjust?.('drone.key', { pc: h0.hearIn, minor: !!minor })) return true;
      return setSong('minor', !!minor);
    };

    const tile = use(onTile({
      label: 'Drone', color: 'var(--drone)', testid: 'v6-drone-on', title: 'Tap to turn the drone on or off',
      onToggle: (on) => setOn(on),
    }));
    const mode = use(segmented({
      label: 'Drone sound',
      options: [{ value: 'synth', label: 'Synth' }, { value: 'files', label: 'My Pads' }],
      onChange: (val) => {
        if (m.isLocked() || !song()) return render(); // frozen under lock
        setSong('drone.mode', val);
      },
    }));
    mode.el.dataset.testid = 'v6-drone-mode';
    const grid = use(keyGrid({
      label: 'Song key',
      onSelect: (pc) => {
        if (m.isLocked()) {
          if (!gridGate.justHeld()) hint();
          return render();
        }
        setKey(pc);
      },
    }));
    grid.el.dataset.testid = 'v6-drone-keys';
    const quality = use(segmented({
      label: 'Major or minor',
      options: [{ value: false, label: 'Major' }, { value: true, label: 'Minor' }],
      onChange: (val) => {
        if (m.isLocked()) {
          if (!qualityGate.justHeld()) hint();
          return render();
        }
        setMinor(!!val);
      },
    }));
    quality.el.dataset.testid = 'v6-drone-quality';
    const gridGate = holdGate(grid.el, {
      selector: '.key-btn', enabled: m.isLocked, run: (b) => setKey(Number(b.dataset.pc)), onHint: () => hint(), d,
    });
    const qualityGate = holdGate(quality.el, {
      selector: '.seg', enabled: m.isLocked, run: (b) => setMinor(b.dataset.value === 'true'),
      onHint: () => hint(), d,
    });
    const common = { compact: true, color: 'var(--drone)', relative: true, resetOnDoubleClick: false };
    // while a scene plays, the level is a live move on top of it (perform.js sceneLevel, v11-scenes)
    const level = use(fader({
      ...common, path: 'drone.gain', label: 'Level',
      onChange: (x) => m.sceneLevel('drone.gain', x) || setSong('drone.gain', x),
    }));
    level.el.dataset.testid = 'v6-drone-level';
    // D24.6: the word and a percentage, as today's Key & drone card (views/perform.js "Soft · 48%")
    const pct = (word) => (x) => `${word(x)} · ${Math.round(x * 100)}%`;
    const bright = use(fader({
      ...common, path: 'drone.brightness', label: 'Bright', format: pct(brightnessWord),
      onChange: (x) => setSong('drone.brightness', x),
    }));
    bright.el.dataset.testid = 'v6-drone-bright';
    const move = use(fader({
      ...common, path: 'drone.movement', label: 'Move', format: pct(movementWord),
      onChange: (x) => setSong('drone.movement', x),
    }));
    move.el.dataset.testid = 'v6-drone-move';
    const sustain = button(d, '.v6-qb.v6-drone-sus', [h('b', { text: 'Sustain' }), h('small', { text: 'coming' })], {
      disabled: true, 'data-testid': 'v6-drone-sustain',
      title: 'A pedal hold for the drone is not in Worship Rig yet',
    });
    const keep = use(toggle({
      label: 'Keep across songs', className: 'v6-drone-keep',
      title: 'Keep the drone playing when you switch songs (it glides to the new key)',
      onChange: (on) => setSong('drone.continueAcrossSongs', on),
    }));
    keep.el.dataset.testid = 'v6-drone-keep';
    const follow = use(toggle({
      label: 'Follow chords', className: 'v6-drone-follow',
      title: 'The synth drone follows the chords you hold below middle C (experimental)',
      onChange: (on) => setSong('drone.chordFollow', on),
    }));
    follow.el.dataset.testid = 'v6-drone-follow';
    const lockLine = h('div.v6-drone-lockline', {}, h('span.hold-tag', { text: 'HOLD' }),
      h('span', { text: 'a key or Major / Minor to change it while locked' }));
    const padText = h('span.v6-pad-t', { text: '' });
    const padBtn = button(d, '.v6-pad-btn', 'Choose folder…', { 'data-testid': 'v6-drone-pads' });
    d.listen(padBtn, 'click', () => {
      const st = store.get().settings;
      if (padsInfo && padsInfo.total > 0 && m.ctx.rig?.isElectron && typeof controller.reloadPads === 'function'
        && st.padFolder) {
        controller.reloadPads().then((r) => {
          if (r && !r.error) m.toast(`Pad folder rescanned: ${r.count} key${r.count === 1 ? '' : 's'} found.`, 'ok');
        });
      } else m.ctx.openSettings?.({ section: 'pads' });
    });
    const pads = h('div.v6-pads', {}, padText, padBtn);

    const root = h('div.v6-drone.drone-block', { 'data-testid': 'v6-drone', 'aria-label': 'Drone' },
      h('div.v6-d-sound', {}, h('span.v6-cap', { text: 'Sound' }), mode.el),
      h('div.v6-d-on', {}, tile.el, quality.el),
      h('div.v6-d-keys', {}, grid.el),
      h('div.v6-d-sl', {}, level.el, bright.el, move.el),
      h('div.v6-d-tg', {}, sustain, keep.el, follow.el),
      lockLine,
      pads);
    el.append(root);

    let hintTimer = 0;
    function hint() {
      lockLine.classList.remove('hint');
      void lockLine.offsetWidth;
      lockLine.classList.add('hint');
      clearTimeout(hintTimer);
      hintTimer = setTimeout(() => lockLine.classList.remove('hint'), 1600);
    }
    d.add(() => clearTimeout(hintTimer));

    /** ON tile: off ↔ the last source (this song), else the Revert snapshot's source, else Synth (perform.js). */
    function setOn(on) {
      const s = heard();
      if (!s) return;
      if (!on) {
        if (s.drone.mode !== 'off') Object.assign(last, { id: s.id, source: s.drone.mode });
        setSong('drone.mode', 'off');
      } else if (s.drone.mode === 'off') {
        const snap = m.snap();
        setSong('drone.mode', lastSourceOf(s) || droneOnMode(snap && snap.id === s.id ? snap.song : s));
      }
      render();
    }
    /** Key grid: the key the band hears; the transpose amount stays (Play-In moves with it), as perform.js. */
    function setKey(pc) {
      const s = song();
      if (!s || heard(s).hearIn === mod12(pc)) return;
      if (controller.scenes?.adjust?.('drone.key', { pc: mod12(pc) })) return; // D26.1: the playing snapshot's key
      const semis = transposeSemis(s.playIn, s.hearIn);
      store.set(`songs.${s.id}.hearIn`, mod12(pc));
      store.set(`songs.${s.id}.playIn`, mod12(pc - semis));
    }

    function padCount() {
      if (padsInfo) return padsInfo;
      try {
        // mounted after the controller's one 'pads' event (the sidebar opens later): the engine's matched files
        const n = engine?.drone?.files?.size;
        return Number.isFinite(n) && n > 0 ? { count: n, total: n } : null;
      } catch {
        return null;
      }
    }
    function renderPads(st, s) {
      const p = padCount();
      const md = s?.drone.mode;
      if (p && p.total > 0) {
        setText(padText, `My Pads: ${p.count} key${p.count === 1 ? '' : 's'}`);
        setText(padBtn, m.ctx.rig?.isElectron && st.settings.padFolder ? 'Rescan' : 'Change…');
      } else if (st.settings.padFolder) {
        setText(padText, md === 'files' ? 'Pad folder not connected: using the synth' : 'Pad folder chosen');
        setText(padBtn, 'Pad folder…');
      } else {
        setText(padText, md === 'files' ? 'No pad folder: using the synth' : say('padsNone'));
        setText(padBtn, 'Choose folder…');
      }
      pads.classList.toggle('attention', md === 'files' && !(p && p.count > 0));
      // the column is short: the pad-folder line shows while My Pads is the sound (where it matters; tap My Pads to
      // reach "Choose folder…"), and always in the wide panel
      pads.hidden = md !== 'files' && m.size !== 'wide';
      padBtn.disabled = !!st.settings.performLock && !(m.ctx.rig?.isElectron && p && p.total > 0);
    }

    function render() {
      const st = store.get();
      const s = st.songs[st.settings.currentSongId] || null;
      const locked = !!st.settings.performLock;
      if ((s ? s.id : null) !== shownId) {
        // round2-ui #2: a drag must not carry into the next song
        for (const f of [level, bright, move]) f.cancelDrag?.();
        if (s && last.id !== s.id) Object.assign(last, { id: null, source: null }); // another song: forget it
        shownId = s ? s.id : null;
      }
      if (s) {
        const hs = heard(s); // D26.1: the ON tile, sound and key as they play
        const dr = hs.drone;
        const on = dr.mode !== 'off';
        const snap = m.snap();
        tile.set(on);
        tile.setSub(droneKeyLabel(hs.hearIn, hs.minor));
        mode.set(on ? dr.mode : lastSourceOf(s) || droneOnMode(snap && snap.id === s.id ? snap.song : s));
        grid.set({ pc: hs.hearIn, minor: hs.minor });
        quality.set(!!hs.minor);
        level.set(dr.gain);
        bright.set(Number.isFinite(dr.brightness) ? dr.brightness : 0.5);
        move.set(Number.isFinite(dr.movement) ? dr.movement : 0.3);
        follow.set(dr.chordFollow);
        follow.el.hidden = dr.mode !== 'synth';
        keep.set(dr.continueAcrossSongs);
        root.classList.toggle('off', !on);
      }
      tile.setDisabled(!s);
      mode.setDisabled(locked || !s);
      grid.setDisabled(!s);
      quality.setDisabled(!s);
      level.setDisabled(!s);
      bright.setDisabled(locked || !s);
      move.setDisabled(locked || !s);
      follow.setDisabled(locked || !s);
      keep.setDisabled(locked || !s);
      root.classList.toggle('locked', locked);
      renderPads(st, s && heard(s));
    }

    d.add(store.subscribe(() => render()));
    d.listen(controller, 'scene', () => render());
    d.listen(controller, 'pads', (e) => {
      padsInfo = e.detail || null;
      render();
    });
    render();

    return {
      destroy() {
        d.dispose();
        for (const c of comps.splice(0)) c.destroy();
        root.remove();
      },
    };
  },
};
