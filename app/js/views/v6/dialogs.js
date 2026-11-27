// The small v6 dialogs (UI v6 U7c; mockup native/docs/design/mockups/dialogs.html "Save snapshot", mock_dialogs.py
// save_snapshot()): a modal frame over the stage (role=dialog aria-modal, so Esc cancels it and never panics, even
// with "Esc always panics" on: main.js escModalOpen, D24.7), the Save snapshot dialog, and the one-field name dialog
// the song menu's Rename… uses. Writes go through controller.scenes.save / store.set only.
import { h, setText, disposer } from '../components/util.js';
import { openOverlay } from '../components/overlay.js';
import { say } from '../components/voice.js';
import { scenesOf, sceneNameOf, SCENE_NAME_MAX } from '../../shared/scenes.js';
import { gainToDb } from '../../shared/params.js';
import { SPACE_PRESETS, ECHO_PRESETS, matchPreset } from '../../shared/fx-presets.js';
import { keyName } from '../../shared/music.js';
import { slotMuteState } from '../perform.js';
import { button } from './lib.js';

/** Level change (dB, the mean over the instruments that play in both) that makes a suggestion "louder" / "softer". */
export const SUGGEST_DB = 1.5;

const isOn = (slot) => !!slot && !slotMuteState(slot).muted && slotMuteState(slot).level > 0.001;
const db = (g) => gainToDb(Math.max(1e-4, Number(g) || 0));
const levelDb = (slot) => db(slotMuteState(slot).level);

/**
 * D25: a name for a new snapshot, from what plays now against the song's own levels. Kept simple on purpose:
 *   1. the instruments that are on (ON and above silence), by position: "Piano", "Piano + Warm Pad", or
 *      "Piano + Warm Pad + 2 more"; none on = "Drone only" when the drone plays, else "All off";
 *   2. then ", louder" / ", softer" when those instruments are on average more than SUGGEST_DB louder / softer than the
 *      song's own levels, else ", drone up" / ", drone down" when the drone level moved that much (neither word when
 *      no instrument is on);
 *   3. cut to SCENE_NAME_MAX; " 2", " 3" … added when another snapshot of the song has that name.
 * A snapshot holds levels, ON switches, the drone level and the wheel, and (D26.1) the sends, Space / Echo and the
 * drone's ON / sound / key (shared/scenes.js). The words name only levels (never "warmer": tone is not in a
 * snapshot).
 * @param {object} live  the song as it plays now (controller.scenes.view)
 * @param {object} own   the song's own levels (the store's song)
 * @param {{name(ref:object):string}} names  lib.js instrumentNames
 * @param {string[]} [taken]  names the song's snapshots already have
 * @returns {string}
 */
export function suggestSnapshotName(live, own, names, taken = []) {
  if (!live?.patch) return 'Snapshot';
  const slots = live.patch.slots;
  const on = slots.map((s, i) => (isOn(s) ? i : -1)).filter((i) => i >= 0);
  const droneOn = !!live.drone && live.drone.mode !== 'off' && Number(live.drone.gain) > 0.001;
  let base;
  if (!on.length) base = droneOn ? 'Drone only' : 'All off';
  else {
    const nm = on.map((i) => names.name(slots[i].instrument));
    base = nm.length <= 2 ? nm.join(' + ') : `${nm[0]} + ${nm[1]} + ${nm.length - 2} more`;
  }
  const both = on.filter((i) => isOn(own?.patch?.slots[i]));
  let word = '';
  if (both.length) {
    const dd = both.reduce((a, i) => a + levelDb(slots[i]) - levelDb(own.patch.slots[i]), 0) / both.length;
    if (dd > SUGGEST_DB) word = 'louder';
    else if (dd < -SUGGEST_DB) word = 'softer';
  }
  if (!word && on.length && live.drone && own?.drone) {
    const dd = db(live.drone.gain) - db(own.drone.gain);
    if (dd > SUGGEST_DB) word = 'drone up';
    else if (dd < -SUGGEST_DB) word = 'drone down';
  }
  let name = sceneNameOf(word ? `${base}, ${word}` : base) || 'Snapshot';
  const used = new Set(taken.map((t) => String(t).toLowerCase()));
  if (used.has(name.toLowerCase())) {
    for (let k = 2; k < 100; k++) {
      const tail = ` ${k}`;
      const c = `${[...name].slice(0, SCENE_NAME_MAX - tail.length).join('').trimEnd()}${tail}`;
      if (!used.has(c.toLowerCase())) {
        name = c;
        break;
      }
    }
  }
  return name;
}

/**
 * A modal dialog over the v6 stage: a dimmed backdrop (a tap on it cancels), Esc cancels (an overlay; never a panic),
 * focus goes to `o.focus` (else the first field) and back to nothing on close (Space stays the sustain pedal).
 * @param {object} v  the v6 view context (host)
 * A song switch (a footswitch, the setlist) closes it: what it would write belongs to the song it was opened on.
 * @param {{label:string, testid:string, className?:string, build:(body:HTMLElement, pd:object, close:() => void) =>
 *   (HTMLElement|void), onClose?:(reason:string) => void}} o  build returns the element to focus
 * @returns {{el:HTMLElement, close():void}}
 */
export function modalDialog(v, o) {
  const pd = disposer();
  const songId = v.store.get().settings.currentSongId;
  pd.add(v.store.subscribe((state) => {
    if (state.settings.currentSongId !== songId || state.settings.view !== 'perform') queueMicrotask(close);
  }));
  const dlg = h(`div.v6-dlg${o.className ? `.${o.className}` : ''}`, {
    role: 'dialog', 'aria-modal': 'true', 'aria-label': o.label, 'data-testid': o.testid,
  });
  const back = h('div.v6-dlg-back', { 'data-testid': `${o.testid}-back` }, dlg);
  let closeFn = null;
  const close = () => closeFn?.('api');
  const focusEl = o.build(dlg, pd, close);
  v.host.append(back);
  closeFn = openOverlay({
    // no swallow: the backdrop takes the tap that closes it (nothing under it got the press), and an armed swallow
    // would eat the next tap when that press makes no click (its target, the backdrop, is gone by pointerup)
    el: dlg, anchors: [], group: 'v6-dlg',
    onClose: (reason) => {
      closeFn = null;
      pd.dispose();
      back.remove();
      if (dlg.contains(document.activeElement)) document.activeElement.blur?.();
      o.onClose?.(reason);
    },
  });
  // arrows / Home / End inside the dialog are the fields' (never Prev / Next song or the mod wheel outside)
  pd.listen(dlg, 'keydown', (e) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
      e.stopPropagation();
    }
  });
  const f = focusEl || dlg.querySelector('input, button');
  f?.focus({ preventScroll: true });
  if (f instanceof HTMLInputElement) f.select();
  return { el: dlg, close };
}

/** A name field (48 px, the mockup's .namebox) with a caption; Enter runs `onEnter`. */
function nameField(pd, { value, label, caption, maxlength, testid, onEnter }) {
  const input = h('input.v6-dlg-name', { type: 'text', value, maxlength: String(maxlength), 'aria-label': label,
    spellcheck: 'false', autocomplete: 'off', 'data-testid': testid });
  const cap = h('small', { text: caption || '' });
  pd.listen(input, 'keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // IME: Enter confirms the candidate
    if (e.key === 'Enter') {
      e.preventDefault();
      onEnter();
    }
  });
  return { input, cap, el: h('div.v6-dlg-namebox', {}, input, cap) };
}

/**
 * Save snapshot (mockup "Save snapshot"; D25, D26.1): a name (suggested from what changed), what a snapshot keeps
 * (exactly what shared/scenes.js captureScene holds, with what plays now), then Update "<playing>" (when a snapshot
 * plays) / Save as new / Cancel.
 * Update keeps the snapshot's name unless the field was edited; Save as new takes the field (an empty field = no name,
 * "Scene n"). Live under Lock (D24.1).
 * @param {object} v  the v6 view context (store, controller, names, toast, host)
 * @param {{from?:'save'|'new', onClose?:() => void}} [o]
 * @returns {{el:HTMLElement, close():void}|null} null when there is no playing song
 */
export function saveSnapshotDialog(v, o = {}) {
  const { store, controller } = v;
  const sc = controller.scenes?.state();
  const song = store.currentSong();
  if (!sc || !sc.id || !song || sc.id !== song.id) return null;
  const list = scenesOf(song);
  const max = controller.scenes.max ?? 3;
  const live = controller.scenes.view(song);
  const playing = sc.n !== null ? list[sc.n] : null;
  const playingName = playing ? playing.name || say('sceneLabel', { n: sc.n + 1 }) : null;
  const suggested = suggestSnapshotName(live, song, v.names, list.map((x) => x.name).filter(Boolean));
  const wheelRouted = (() => {
    const t = song.patch.modWheel?.target;
    return typeof t === 'string' && t !== '' && t !== 'none';
  })();
  return modalDialog(v, {
    label: 'Save snapshot', testid: 'v6-savesnap', className: 'v6-savesnap', onClose: () => o.onClose?.(),
    build: (body, pd, close) => {
      let touched = false;
      const field = nameField(pd, {
        value: suggested, label: 'Snapshot name', caption: 'Suggested from what changed', maxlength: SCENE_NAME_MAX,
        // Enter = Save as new; with the song full (max snapshots) = Update the one that plays
        testid: 'v6-savesnap-name', onEnter: () => (list.length >= max && playing ? doUpdate() : doNew()),
      });
      pd.listen(field.input, 'input', () => {
        touched = true;
        setText(field.cap, field.input.value.trim() ? '' : 'No name: it shows as “Scene n”');
      });
      const n = live.patch.slots.filter(Boolean).length;
      const fxv = (p) => p.split('.').slice(1).reduce((o, k) => o?.[k], live.patch.fx);
      const space = matchPreset(SPACE_PRESETS, fxv);
      const echo = matchPreset(ECHO_PRESETS, fxv);
      const spaceEcho = `Space: ${space ? space.name : 'Custom'} · Echo: ${echo ? echo.name : 'Custom'}`;
      const dr = live.drone || {};
      const droneNow = dr.mode && dr.mode !== 'off'
        ? `on · ${keyName(live.hearIn, live.minor).replace(/m$/, '')} ${live.minor ? 'minor' : 'major'} · `
          + `${dr.mode === 'files' ? 'My Pads' : 'Synth'}`
        : `off · ${keyName(live.hearIn, live.minor).replace(/m$/, '')} ${live.minor ? 'minor' : 'major'} when on`;
      const names = live.patch.slots.filter(Boolean).map((s) => v.names.name(s.instrument));
      const keepRow = (title, small, on = true, tid = '') => h(`div.v6-keeps-r${on ? '' : '.off'}`,
        tid ? { 'data-testid': tid } : {}, h('span.v6-keeps-ck', { 'aria-hidden': 'true', text: on ? '✓' : '–' }),
        h('span', {}, h('b', { text: title }), h('small', { text: small })));
      const keeps = h('div.v6-keeps', { 'data-testid': 'v6-savesnap-keeps' },
        h('span.v6-cap', { text: 'It keeps' }),
        keepRow(`Each instrument’s level and ON / OFF (${n})`,
          names.length > 4 ? `${names.slice(0, 4).join(', ')} + ${names.length - 4} more` : names.join(', ') || '—',
          true, 'v6-keeps-levels'),
        // D26.1: the sends, the Space room / Echo with their levels, the drone's ON / sound / key (what plays now)
        keepRow('Each instrument’s Space and Echo', 'how much of each goes to the Space and the Echo', true,
          'v6-keeps-sends'),
        keepRow('Space and Echo', `${spaceEcho}, with their levels`, true, 'v6-keeps-fx'),
        keepRow('The drone: ON / OFF, key, sound and level', droneNow, true, 'v6-keeps-drone'),
        wheelRouted ? keepRow('Where the wheel is', 'it moves what the wheel drives in this song', true,
          'v6-keeps-wheel')
          : keepRow('The wheel', 'not kept: the wheel drives nothing in this song', false, 'v6-keeps-wheel'),
        h('p.v6-keeps-not', { 'data-testid': 'v6-savesnap-not', text: 'Not kept: the sounds themselves, octave, '
          + 'sustain, range, tone (EQ), the chorus, lofi and master, and the drone’s brightness and movement. They '
          + 'stay as the song has them.' }));
      const cancel = button(pd, '.ghost.v6-savesnap-cancel', 'Cancel', { 'data-testid': 'v6-savesnap-cancel' });
      pd.listen(cancel, 'click', () => close());
      const update = playing ? button(pd, '.v6-savesnap-update', `Update “${playingName}”`, {
        'data-testid': 'v6-savesnap-update', title: 'Save what you hear now over the snapshot that plays',
      }) : null;
      const saveNew = button(pd, '.plate.v6-savesnap-new', 'Save as new', { 'data-testid': 'v6-savesnap-new',
        disabled: list.length >= max,
        title: list.length >= max ? `${max} snapshots is the most a song keeps for now` : say('sceneSaveTitle',
          { n: list.length + 1 }) });
      const nameNow = () => field.input.value;
      // the playing snapshot changed under the dialog (a footswitch, the bus): Update would name the wrong one
      pd.listen(controller, 'scene', () => {
        const now = controller.scenes.state();
        if (now.id !== sc.id || now.n !== sc.n || now.count !== list.length) close();
      });
      function doUpdate() {
        if (!playing) return;
        const nm = touched ? sceneNameOf(nameNow()) : playing.name || null;
        close();
        if (controller.scenes.save(sc.n, { name: nm })) {
          v.toast(`“${nm || say('sceneLabel', { n: sc.n + 1 })}” updated.`, 'ok', { ms: 2500 });
        }
      }
      function doNew() {
        if (list.length >= max) return;
        const nm = sceneNameOf(nameNow());
        close();
        if (controller.scenes.save(list.length, { name: nm })) {
          v.toast(`Saved “${nm || say('sceneLabel', { n: list.length + 1 })}”. A footswitch or a tap brings it back.`,
            'ok', { ms: 3000 });
        }
      }
      if (update) pd.listen(update, 'click', doUpdate);
      pd.listen(saveNew, 'click', doNew);
      body.append(
        h('div.v6-pop-h', {}, 'Save snapshot ', h('span', { text: 'a sound you can bring back with one tap' })),
        field.el, keeps,
        h('div.v6-dlg-btns', {}, cancel, update, saveNew));
      return field.input;
    },
  });
}

/**
 * A one-field name dialog (the song menu's Rename…). `save(name)` gets the trimmed name; an empty one is refused.
 * @param {object} v
 * @param {{title:string, sub?:string, value:string, maxlength:number, testid:string, action?:string,
 *   save:(name:string) => void}} o
 * @returns {{el:HTMLElement, close():void}}
 */
export function nameDialog(v, o) {
  return modalDialog(v, {
    label: o.title, testid: o.testid, className: 'v6-namedlg',
    build: (body, pd, close) => {
      const go = () => {
        const nm = field.input.value.replace(/\s+/g, ' ').trim();
        if (!nm) {
          setText(field.cap, 'A name is needed.');
          field.input.focus();
          return;
        }
        close();
        o.save(nm);
      };
      const field = nameField(pd, { value: o.value, label: o.title, caption: '', maxlength: o.maxlength,
        testid: `${o.testid}-name`, onEnter: go });
      const cancel = button(pd, '.ghost', 'Cancel', { 'data-testid': `${o.testid}-cancel` });
      pd.listen(cancel, 'click', () => close());
      const ok = button(pd, '.plate', o.action || 'Save', { 'data-testid': `${o.testid}-ok` });
      pd.listen(ok, 'click', go);
      body.append(h('div.v6-pop-h', {}, `${o.title} `, o.sub ? h('span', { text: o.sub }) : null), field.el,
        h('div.v6-dlg-btns', {}, cancel, ok));
      return field.input;
    },
  });
}
