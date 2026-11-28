// UI v6 Edit › Drone (U5b; native DECISIONS D15 "same module everywhere", D18 "Drone (Key & sound = the sidebar's
// Drone module, My Pads, Behaviour)"; mockup native/docs/design/mockups/edit.html "Drone", mock_edit.py drone_nav).
//
// Key & sound mounts the v6 sidebar's Drone module itself (views/v6/sidebar/drone.js, the same component and writes
// as Perform's sidebar: ON tile, Synth / My Pads, key grid, Major / Minor, Level, Bright, Move) in its wide layout,
// plus today's Width slider. My Pads and Behaviour hold the rest of today's Drone panel (views/edit/panels/drone.js):
// the same store addresses, so the writes are today's (no new params, no engine call).
import { h, setText, wordSlider } from '../../edit/lib.js';
import { formatValue } from '../../../shared/params.js';
import droneModule, { droneKeyLabel } from '../sidebar/drone.js';
import { catPanel, relsDiffer } from './catpanel.js';

/** Lane N0: a shell that rescans a pad folder itself (Electron; the native app once lane N4 adds rig.listPads). */
const shellPads = (rig) => !!(rig
  && (rig.isElectron || (rig.shell === 'native' && typeof rig.listPads === 'function')));

/** The categories (mockup DRONE_CATS). */
export const DRONE_CATS = Object.freeze([
  { id: 'sound', label: 'Key & sound', blurb: 'the same Drone module as Perform’s sidebar' },
  { id: 'pads', label: 'My Pads', blurb: 'your own pad recordings, one per key' },
  { id: 'behave', label: 'Behaviour', blurb: 'how it moves between keys and songs' },
]);
/**
 * What each category's dot compares with the song's start (U5b: all of the category's paths). The drone's Level and
 * its ON tile are live moves, like an instrument's fader and ON tile (today's rule, the Drone panel's footer "never
 * count as changes"): Level is left out and the source counts only as Synth ↔ My Pads (song-diff's drone.mode rule).
 */
const DOT_RELS = Object.freeze({
  sound: ['hearIn', 'playIn', 'minor', 'drone.brightness', 'drone.movement', 'drone.width'],
  pads: ['drone.minorUsesRelativeMajorFile'],
  behave: ['drone.fade', 'drone.continueAcrossSongs', 'drone.chordFollow'],
});
const SOURCE = { synth: 'Synth', files: 'My Pads' };
/** Today's Drone panel words (views/edit/panels/drone.js). */
const widthWord = (v) => (v < 0.1 ? 'Centred' : v < 0.45 ? 'Narrow' : v < 0.8 ? 'Wide' : 'Very wide');
const fadeWord = (v) => (v < 2.5 ? 'Quick' : v < 8 ? 'Smooth' : 'Slow');
const pctText = (v) => `${Math.round(Number(v) * 100)}%`;
const secText = (v) => `${Number(v).toFixed(v < 10 ? 1 : 0)} s`;
const srcChanged = (a, b) => !!a && !!b && a !== 'off' && b !== 'off' && a !== b;

/**
 * The Drone categories whose dot is on (also the rig tab's dot, edit.js).
 * @param {object|null} s  the song
 * @param {object|null} b  its Revert snapshot
 * @returns {Set<string>}
 */
export function droneChanges(s, b) {
  const out = new Set();
  if (!s || !b) return out;
  if (srcChanged(s.drone?.mode, b.drone?.mode)) out.add('sound');
  for (const [id, rels] of Object.entries(DOT_RELS)) if (relsDiffer(s, b, rels)) out.add(id);
  return out;
}

/**
 * Mount the v6 Drone panel.
 * @param {HTMLElement} host
 * @param {object} ctx  the panel ctx
 * @param {{focus?:string}} opts  today's focus ids: 'source' / 'level' / 'sound' → Key & sound, 'options' →
 *   Behaviour
 * @param {{prefs:{get():string, set(id:string):void}, moduleCtx:object}} env  moduleCtx: the sidebar module ctx
 *   (the v6 view context + size), one per Edit mount so the ON tile's remembered source survives a tab switch
 * @returns {{update(o:object):void, destroy():void, _debug:object}}
 */
export function mountDrone(host, ctx, opts, env) {
  const C = ctx.C || {};
  const base = () => ctx.editState.baseline;
  let padsInfo = null;
  const padCount = () => {
    if (padsInfo) return padsInfo;
    try {
      // the controller's one 'pads' event may have come before this mount: the engine's matched files (as the module)
      const n = ctx.engine?.drone?.files?.size;
      return Number.isFinite(n) && n > 0 ? { count: n, total: n } : null;
    } catch {
      return null;
    }
  };
  const padsText = (s) => {
    const p = padCount();
    const folder = ctx.store.get().settings.padFolder;
    if (p && p.total > 0) return `${p.count} key${p.count === 1 ? '' : 's'}`;
    if (folder) return s.drone.mode === 'files' ? 'folder not connected' : 'folder chosen';
    return 'no folder yet';
  };

  function build(id, pane) {
    const { binder } = pane;
    if (id === 'sound') {
      // the sidebar module, wide (styles-v6-sidebar.css container v6sb ≥ 600 px: ON · keys · sound + sliders); its
      // Keep / Follow toggles and pad line are this panel's Behaviour / My Pads (hidden here, styles-v6-edit.css)
      const modHost = h('div.v6e-dmod', { 'data-testid': 'v6e-drone-module' });
      const inst = droneModule.mount(modHost, env.moduleCtx);
      // Perform's sidebar may have its own Drone module mounted (hidden): the same test ids twice in the document
      // (skeptic UI6-U5b F5: the module's root 'v6-drone' would be 'v6e-drone', the panel's own id: 'v6e-dmod-root')
      for (const n of modHost.querySelectorAll('[data-testid^="v6-"]')) {
        n.dataset.testid = n.dataset.testid === 'v6-drone' ? 'v6e-dmod-root' : `v6e-${n.dataset.testid.slice(3)}`;
      }
      pane.offs.push(() => inst?.destroy?.());
      const width = binder.ctl('drone.width', (onChange) => wordSlider({
        label: 'Width', default: 0.7, word: widthWord, format: pctText, ends: ['centred', 'wide'], onChange,
        color: 'var(--drone)',
      }));
      width.el.dataset.testid = 'v6e-drone-width';
      return h('div.v6e-dsound', {}, modHost, h('div.v6e-row.v6e-dwide', {}, width.el));
    }
    if (id === 'pads') {
      const source = binder.ctl('song.drone.mode', (onChange) => C.segmented({
        label: 'Drone sound',
        options: [
          { value: 'synth', label: 'Synth', title: 'The built-in synth drone' },
          { value: 'files', label: 'My Pads', title: 'Pad files from your My Pads folder (Settings)' },
        ],
        onChange,
      }), { read: (own) => { // D26.1: the drone as it plays (a snapshot may hold its sound)
        const s = (ctx.view && ctx.view()) || own;
        return s.drone.mode === 'off' ? null : s.drone.mode;
      } });
      source.el.dataset.testid = 'v6e-drone-source';
      const minorPad = binder.ctl('song.drone.minorUsesRelativeMajorFile', (onChange) => C.toggle({
        label: 'Minor keys use the major pad', title: 'For a minor key with no pad file, use the relative-major pad',
        onChange,
      }));
      minorPad.el.dataset.testid = 'v6e-drone-minorpad';
      const status = h('p.v6e-hint.v6e-padstat', { 'aria-live': 'polite', 'data-testid': 'v6e-drone-padstat' });
      const folderBtn = h('button.btn.v6e-padbtn', { type: 'button', 'data-testid': 'v6e-drone-folder' });
      // the sidebar module's button: Rescan in the Mac app once a folder has pads, else Settings › My Pads
      folderBtn.addEventListener('click', () => {
        const st = ctx.store.get().settings;
        const p = padCount();
        if (p && p.total > 0 && shellPads(ctx.app?.rig) && typeof ctx.controller?.reloadPads === 'function'
          && st.padFolder) {
          ctx.controller.reloadPads().then((r) => {
            if (!r || r.error) return;
            ctx.toast(`Pad folder rescanned: ${r.count} key${r.count === 1 ? '' : 's'} found.`, 'ok');
          });
        } else ctx.openSettings?.({ section: 'pads' });
      });
      const paint = (s) => {
        const p = padCount();
        const folder = ctx.store.get().settings.padFolder;
        const files = s.drone.mode === 'files';
        let t;
        if (p && p.total > 0) t = `Your pad folder has a pad for ${p.count} key${p.count === 1 ? '' : 's'}.`;
        else if (folder) {
          t = files ? 'The pad folder is not connected: the built-in synth drone plays.' : 'A pad folder is chosen.';
        }
        else t = files ? 'No pad folder yet: the built-in synth drone plays.' : 'No pad folder yet.';
        setText(status, t);
        setText(folderBtn, p && p.total > 0 && shellPads(ctx.app?.rig) && folder ? 'Rescan'
          : folder ? 'Pad folder…' : 'Choose folder…');
      };
      binder.fn(['drone'], paint);
      pane.paint = () => {
        const s = ctx.song();
        if (s) paint(s);
      };
      return h('div.v6e-dpads', {},
        h('div.v6e-row', {}, h('span.v6e-cap', { text: 'This song plays' }), source.el),
        status,
        h('div.v6e-row', {}, folderBtn),
        h('p.v6e-hint', { text: 'Put the key in each file name, e.g. “Pad - Eb.mp3” or “Warm Pad F#m.wav”. '
          + 'The folder is this computer’s (Settings › My Pads); each song chooses Synth or My Pads.' }),
        minorPad.el);
    }
    // Behaviour
    const fade = binder.ctl('drone.fade', (onChange) => wordSlider({
      label: 'Key fade', min: 1, max: 20, default: 4, word: fadeWord, format: secText, ends: ['quick', 'slow'],
      color: 'var(--drone)', onChange,
    }));
    fade.el.dataset.testid = 'v6e-drone-fade';
    const cont = binder.ctl('song.drone.continueAcrossSongs', (onChange) => C.toggle({
      label: 'Keep across songs', title: 'Keeps sounding when you move to the next song (it glides to the new key)',
      onChange,
    }));
    cont.el.dataset.testid = 'v6e-drone-keep';
    const follow = binder.ctl('song.drone.chordFollow', (onChange) => C.toggle({
      label: 'Chord follow', title: 'The synth drone follows the chords you play', tag: 'experimental', onChange,
    }));
    follow.el.dataset.testid = 'v6e-drone-follow';
    const note = h('p.v6e-hint', { 'aria-live': 'polite' });
    binder.fn(['drone'], (s) => {
      const files = s.drone.mode === 'files';
      follow.setDisabled?.(files);
      follow.el.classList.toggle('disabled', files);
      setText(note, files ? 'Chord follow only works with the synth drone.'
        : 'Key fade is how long the drone takes to glide to a new key.');
    });
    return h('div.v6e-dbehave', {}, fade.el, h('div.v6e-row', {}, cont.el, follow.el), note);
  }

  const panel = catPanel(host, ctx, {
    kind: 'drone',
    color: 'var(--drone)',
    cats: DRONE_CATS,
    initial: env.prefs.get(),
    remember: (id) => env.prefs.set(id),
    build,
    summary(id, s) {
      const d = s.drone;
      if (id === 'sound') {
        return `${droneKeyLabel(s.hearIn, s.minor)} · ${d.mode === 'off' ? 'off' : SOURCE[d.mode] || 'Synth'}`;
      }
      if (id === 'pads') return padsText(s);
      return `${d.continueAcrossSongs ? 'keeps across songs' : 'stops between songs'} · ${secText(d.fade ?? 4)} fade`;
    },
    changes: () => droneChanges(ctx.song(), base()),
    sentence(s) {
      const d = s.drone;
      const key = droneKeyLabel(s.hearIn, s.minor);
      if (d.mode === 'off') {
        return ['The ', { text: key, cat: 'sound', focus: '.v6-d-keys' }, ' drone is ',
          { text: 'off', cat: 'sound', focus: '.v6-d-on' }, ' for this song.'];
      }
      return ['A ', { text: key, cat: 'sound', focus: '.v6-d-keys' }, ' drone from ',
        { text: d.mode === 'files' ? 'My Pads' : 'the synth', cat: d.mode === 'files' ? 'pads' : 'sound',
          focus: d.mode === 'files' ? '.v6e-padbtn' : '.v6-d-sound' },
        ' at ', { text: formatValue('drone.gain', d.gain), cat: 'sound', focus: '.v6-d-sl' },
        ', ', { text: d.continueAcrossSongs ? 'kept across songs' : 'not kept across songs', cat: 'behave',
          focus: '[data-testid="v6e-drone-keep"]' }, '.'];
    },
  });
  // the pad count arrives with the controller's 'pads' event (a rescan, a folder pick in Settings)
  ctx.listen(ctx.controller, 'pads', (e) => {
    padsInfo = e.detail || null;
    panel.render();
    panel.pane()?.paint?.();
  });

  const FOCUS = { source: 'sound', level: 'sound', sound: 'sound', options: 'behave', pads: 'pads' };
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
      panel.destroy();
    },
    /** Test hooks. */
    _debug: { cat: () => panel.cat(), choose: (id) => panel.choose(id, { persist: true }) },
  };
}
