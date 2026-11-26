// MIDI Learn on Perform (UI v6 U7c; native DECISIONS O-AW-ML, D20; mockup native/docs/design/mockups/dialogs.html
// "MIDI Learn on Perform", mock_dialogs.py learn()). A gold bar under the song bar shows the two steps: "1 · Move a
// knob, fader or pad" (controller.learnCapture takes it; the bar then says "CC 21 moved ✓") and "2 · Tap what it
// should change"; every learnable control on the v6 Perform gets a dashed outline, the learned ones a small badge
// (their CC / note). The tap can come first too: whichever step comes second completes the learn, through
// controller.learn(id, {heard}) (the same mapping, rules, conflicts and lock as every learn: no new learn model).
// Then the bar starts again for the next control; Done or Esc leaves.
// Entered from v6 Settings › MIDI Learn › "Learn on Perform" (learnOnPerform below) and from a right-click (Ctrl-click,
// a Chromium long-press) on a learnable v6 control, which picks that control as the target.
// Rules:
//  - Refused under Perform Lock (controller.learn's rule); the lock coming on leaves learn mode.
//  - A song switch or a re-order of the song's instruments drops the half-made learn (what was heard or tapped) and
//    starts again at step 1; leaving Perform (Edit, the flag off) leaves learn mode.
//  - Esc leaves learn mode and never panics (an overlay, like the range pick). With "Esc always panics" on (D24.7) one
//    Esc panics and leaves learn mode, as it does with any other open overlay on Perform.
//  - While learning, a tap / click / Enter on a learnable control only picks it (its own action does not run: a fader
//    does not move, Fade out does not fade); everything else plays as usual (keys, the wheel, other buttons). PANIC is
//    the exception (skeptic UI6-U7c F1): a tap on it panics and picks it, and the footswitch learned to PANIC is never
//    captured (controller.learnCapture), so a stuck note can always be stopped, learning or not; a panic loses nothing.
//  - A key / pad or a pedal switch heard, then a fader tapped (they cannot go together): the tap stays picked and the
//    capture waits again for a knob (skeptic UI6-U7c F2: no dead end where only Done gets out).
// Targets are found by the v6 controls' test ids (and the top bar's master fader), so no module needed a change.
import { h, setText, disposer, rafCoalesce } from '../components/util.js';
import { openOverlay } from '../components/overlay.js';
import { isLearnable } from '../../shared/params.js';
import { isLearnablePath } from '../../shared/learn.js';
import { button } from './lib.js';

/** A capture waits this long for a knob before learn mode ends by itself. */
export const LEARN_IDLE_MS = 5 * 60 * 1000;

/** Fixed rows that are actions (a key, pad or footswitch can drive them; a knob too, as a press). */
const BUTTON_IDS = new Set(['swell', 'fadeOutAll', 'panic', 'nextSong', 'prevSong', 'nextScene', 'prevScene', 'go',
  'cueNext', 'cuePrev']);
const isButtonId = (id) => BUTTON_IDS.has(id);

/** "CC 21 · ch 1", "Note 36 · any ch". */
export function controlText(m) {
  if (!m) return '';
  const ch = m.channel === null || m.channel === undefined ? 'any ch' : `ch ${m.channel + 1}`;
  return Number.isInteger(m.cc) ? `CC ${m.cc} · ${ch}` : Number.isInteger(m.note) ? `Note ${m.note} · ${ch}` : '';
}
/** The badge on a learned control: "CC21", "N36". */
const badgeText = (m) => (Number.isInteger(m?.cc) ? `CC${m.cc}` : Number.isInteger(m?.note) ? `N${m.note}` : '');

// the mounted learn mode (one v6 Perform at a time), for v6 Settings' "Learn on Perform"
let live = null;
/**
 * Start MIDI Learn on the mounted v6 Perform (v6 Settings › MIDI Learn › Learn on Perform). The caller closes
 * Settings and shows Perform first.
 * @returns {boolean} false when no v6 Perform is mounted or the lock is on
 */
export function learnOnPerform() {
  return live ? live.enter() : false;
}

/**
 * @param {object} v  the v6 shell's view context (store, controller, names, liveOf, host, toast, isLocked, arrange?)
 * @returns {{el:HTMLElement, enter(o?:{target?:string}):boolean, exit(reason?:string):void, readonly active:boolean,
 *            readonly state:object|null, readonly targets:Array<{id:string, label:string}>, destroy():void}}
 */
export function learnMode(v) {
  const { store, controller } = v;
  const d = disposer();
  const step1 = h('span.v6-lstep.on', { 'data-testid': 'v6-learn-step1' });
  const step2 = h('span.v6-lstep', { 'data-testid': 'v6-learn-step2' });
  const done = button(d, '.v6-learn-done', 'Done', { 'data-testid': 'v6-learn-done' });
  const el = h('div.v6-learnbar', { role: 'status', 'aria-live': 'polite', 'data-testid': 'v6-learnbar', hidden: true },
    h('span.v6-ldot', { 'aria-hidden': 'true' }), h('b', { text: 'Learning' }), step1, step2,
    h('small.v6-lhint', { text: 'Dashed = can be learned · CC21 = already learned' }), done);
  d.listen(done, 'click', () => exit('done'));

  /** null while off; else {heard:{cc|note, channel}|null, picked:{id,label}|null, token, busy} */
  let st = null;
  let closeEsc = null;
  let token = 0;
  let capturing = 0; // the token of our capture while controller.learnCapture waits (exit cancels only our own)
  const decorated = new Set();

  // ---------------------------------------------------------------- targets
  /** Every learnable control on screen now: [{el, id, label}] (hidden ones and empty slots left out). */
  function targets() {
    const out = [];
    const host = v.host;
    const shown = (e) => !!e && e.isConnected && !e.closest('[hidden]');
    const add = (e, id, label) => {
      if (shown(e) && (isLearnable(id) || isLearnablePath(id))) out.push({ el: e, id, label });
    };
    const song = v.liveOf(store.currentSong());
    const n = song ? song.patch.slots.length : 0;
    for (let i = 0; i < n; i++) {
      const slot = song.patch.slots[i];
      if (!slot) continue;
      const nm = v.names.name(slot.instrument);
      add(host.querySelector(`[data-testid="v6-fader-${i}"]`), `slots.${i}.gain`, `${nm} level`);
      add(host.querySelector(`[data-testid="v6-space-${i}"]`), `slots.${i}.sends.reverb`, `${nm} Space`);
      add(host.querySelector(`[data-testid="v6-echo-${i}"]`), `slots.${i}.sends.delay`, `${nm} Echo`);
    }
    add(host.querySelector('[data-testid="v6-drone-level"]'), 'drone.gain', 'Drone level');
    add(document.getElementById('master-mount')?.querySelector('.fader') || null, 'master.volume', 'Master volume');
    add(host.querySelector('[data-testid="v6-wheel"] .swell-btn'), 'swell', 'Swell');
    add(host.querySelector('[data-testid="v6-fade"]'), 'fadeOutAll', 'Fade out');
    add(host.querySelector('[data-testid="v6-panic"]'), 'panic', 'PANIC');
    return out;
  }
  /** Can what was heard drive target `id`? (a key / pad or a pedal switch only drives an action) */
  const fits = (heard, id) => !heard || isButtonId(id)
    || (Number.isInteger(heard.cc) && ![64, 66, 67].includes(heard.cc));
  const targetOf = (node) => {
    if (!(node instanceof Element)) return null;
    for (const t of targets()) if (t.el.contains(node)) return t;
    return null;
  };

  function undecorate() {
    for (const e of decorated) {
      e.classList.remove('v6-learnable', 'v6-lpicked', 'v6-lmiss');
      delete e.dataset.v6Learn;
      delete e.dataset.v6Badge;
    }
    decorated.clear();
  }
  /** Outlines (dashed: can be learned; solid: the tapped one), badges (learned), and the two steps' words. */
  function paint() {
    if (!st) return;
    const ml = store.get().settings.midiLearn || {};
    const seen = new Set();
    for (const t of targets()) {
      const e = t.el;
      seen.add(e);
      decorated.add(e);
      e.dataset.v6Learn = t.id;
      e.classList.add('v6-learnable');
      e.classList.toggle('v6-lmiss', !fits(st.heard, t.id));
      e.classList.toggle('v6-lpicked', st.picked?.id === t.id);
      const b = badgeText(ml[t.id]);
      if (b) e.dataset.v6Badge = b;
      else delete e.dataset.v6Badge;
    }
    for (const e of [...decorated]) {
      if (seen.has(e)) continue;
      e.classList.remove('v6-learnable', 'v6-lpicked', 'v6-lmiss');
      delete e.dataset.v6Learn;
      delete e.dataset.v6Badge;
      decorated.delete(e);
    }
    const heard = st.heard;
    setText(step1, heard ? `${controlText(heard).split(' · ')[0]} moved ✓` : '1 · Move a knob, fader or pad');
    step1.classList.toggle('done', !!heard);
    step1.classList.toggle('on', !heard);
    setText(step2, st.picked ? `${st.picked.label} ✓` : '2 · Tap what it should change');
    step2.classList.toggle('done', !!st.picked);
    step2.classList.toggle('on', !!heard && !st.picked);
  }
  const repaint = rafCoalesce(() => paint());
  d.add(() => repaint.cancel());

  // ---------------------------------------------------------------- the learn itself
  /** Wait for the next control (step 1). A stale answer (an older capture, or one cancelled by another learn) is
   *  dropped; a null answer for the current one (the idle timeout, or another learn took MIDI) ends learn mode. */
  async function arm() {
    if (!st) return;
    const my = ++token;
    st.token = my;
    capturing = my;
    let res = null;
    try {
      res = await controller.learnCapture?.({ timeoutMs: LEARN_IDLE_MS });
    } catch (err) {
      console.warn('[v6] learn capture failed', err);
    }
    if (capturing === my) capturing = 0;
    if (!st || st.token !== my) return;
    if (!res) {
      // the idle timeout, or another learn (Settings' table, Edit's menu) took MIDI: that one is left alone
      const other = document.body.classList.contains('settings-open') || store.get().settings.view !== 'perform';
      exit('idle');
      if (!other) v.toast('MIDI Learn ended: nothing was moved for a while.', 'info', { ms: 3000 });
      return;
    }
    if (res.error === 'perform-locked') return exit('lock');
    if (res.error) {
      v.toast(res.error === 'sustain-pedal-reserved' ? 'That’s the sustain pedal: it always sustains. Use another '
        + 'knob, fader or pad.' : 'That control can’t be learned. Try another one.', 'warn');
      return void arm();
    }
    if (st.picked && !fits(res, st.picked.id)) {
      // skeptic UI6-U7c F2: the tapped fader stays picked; the key / pedal switch is not kept, the capture waits again
      v.toast(`${Number.isInteger(res.note) ? 'A key or pad' : 'A pedal switch'} can’t move ${st.picked.label}: move `
        + 'a knob or fader for it.', 'warn', { ms: 3500 });
      return void arm();
    }
    st.heard = res;
    paint();
    if (st.picked) complete();
  }
  /** Both halves are in: store the mapping through controller.learn (its rules), say so, start again. */
  async function complete() {
    if (!st || st.busy || !st.heard || !st.picked) return;
    st.busy = true;
    const { heard, picked } = st;
    const my = st.token;
    let res = null;
    try {
      res = await controller.learn(picked.id, { heard });
    } catch (err) {
      console.warn('[v6] learn failed', err);
    }
    if (!st || st.token !== my) return;
    st.busy = false;
    const ctl = controlText(heard).split(' · ')[0];
    if (res && !res.error) {
      const was = Array.isArray(res.replaced) && res.replaced.length
        ? ` (it was ${res.replaced.map((id) => labelOf(id)).join(', ')})` : '';
      // D20: a knob's move edits the song like a slider; an action runs (Settings › MIDI Learn's rule)
      const tail = isButtonId(picked.id) ? '' : ' · moves stick; Revert undoes them';
      v.toast(`${ctl} → ${picked.label} ✓${tail}${was}`, 'ok', { ms: 4000 });
    } else if (res && res.error === 'perform-locked') return exit('lock');
    else if (res && res.error === 'needs-knob') {
      v.toast(`${Number.isInteger(heard.note) ? 'A key or pad' : 'A pedal switch'} can’t move ${picked.label}: move `
        + 'a knob or fader for it.', 'warn', { ms: 4000 });
    } else if (res && res.error === 'sustain-pedal-reserved') {
      v.toast('That’s the sustain pedal: it always sustains.', 'warn');
    } else v.toast('That didn’t work. Try again.', 'warn');
    restart();
  }
  const labelOf = (id) => targets().find((t) => t.id === id)?.label || ({ nextSong: 'Next song', prevSong:
    'Previous song', nextScene: 'Next snapshot', prevScene: 'Previous snapshot', go: 'Go', cueNext: 'Cue next',
  cuePrev: 'Cue previous', panic: 'PANIC', fadeOutAll: 'Fade out', swell: 'Swell' })[id] || id;
  /** Back to step 1 (after a learn, a song switch, a re-order). */
  function restart() {
    if (!st) return;
    st.heard = null;
    st.picked = null;
    st.busy = false;
    paint();
    arm();
  }
  function pick(t) {
    if (!st || st.busy) return;
    if (st.heard && !fits(st.heard, t.id)) {
      // skeptic UI6-U7c F2: keep the tap, forget the key / pedal and wait for a knob (the capture ended when the key
      // came; without this only an action or Done got out of it)
      v.toast(`${Number.isInteger(st.heard.note) ? 'A key or pad' : 'A pedal switch'} can’t move ${t.label}: move `
        + 'a knob or fader for it now.', 'warn', { ms: 3500 });
      st.heard = null;
      st.picked = { id: t.id, label: t.label };
      paint();
      arm();
      return;
    }
    st.picked = { id: t.id, label: t.label };
    paint();
    if (st.heard) complete();
  }
  /** A press on a target: PANIC still panics while learning (skeptic UI6-U7c F1), then the press picks. */
  function press(t) {
    if (t.id === 'panic') controller.panic?.();
    pick(t);
  }

  // ---------------------------------------------------------------- enter / exit
  /**
   * @param {{target?:string}} [o]  target: a control id picked by the right-click that opened learn mode
   * @returns {boolean}
   */
  function enter(o = {}) {
    if (v.isLocked()) {
      v.toast('Perform lock is on. Unlock to learn MIDI.', 'warn');
      return false;
    }
    if (typeof controller.learnCapture !== 'function') return false;
    v.arrange?.exit();
    if (!st) {
      st = { heard: null, picked: null, token: 0, busy: false };
      el.hidden = false;
      document.body.classList.add('v6-learning');
      v.host.classList.add('learning');
      closeEsc = openOverlay({
        el, anchors: [], closeOnOutside: false, group: 'v6-learn',
        onClose: (reason) => {
          closeEsc = null;
          if (reason !== 'api') exit(reason);
        },
      });
      listen(true);
      arm();
    }
    const t = o.target ? targets().find((x) => x.id === o.target) : null;
    if (t) st.picked = { id: t.id, label: t.label };
    paint();
    return true;
  }
  function exit(reason = 'api') {
    if (!st) return;
    st = null;
    token += 1;
    listen(false);
    if (closeEsc) closeEsc('api');
    closeEsc = null;
    if (capturing) controller.cancelLearn?.(); // our own capture only, never another view's learn
    capturing = 0;
    undecorate();
    el.hidden = true;
    document.body.classList.remove('v6-learning');
    v.host.classList.remove('learning');
    void reason;
  }

  // ---------------------------------------------------------------- input while learning
  // Capture listeners on the document (before any control's own): a press on a learnable control picks it and does
  // nothing else; the click that follows is swallowed.
  let swallowClick = null;
  const onDown = (e) => {
    if (!st || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const t = targetOf(e.target);
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    swallowClick = t.el;
    press(t);
  };
  const onClick = (e) => {
    if (!st) return;
    const t = targetOf(e.target);
    if (!t && !(swallowClick && swallowClick.contains(e.target))) return;
    e.preventDefault();
    e.stopPropagation();
    // a click with no press first (a keyboard / AT activation) picks too
    if (t && swallowClick !== t.el) press(t);
    swallowClick = null;
  };
  const onKey = (e) => {
    if (!st || (e.key !== 'Enter' && e.key !== ' ') || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = targetOf(e.target);
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) press(t);
  };
  let mo = null;
  function listen(on) {
    const f = on ? 'addEventListener' : 'removeEventListener';
    document[f]('pointerdown', onDown, true);
    document[f]('click', onClick, true);
    document[f]('keydown', onKey, true);
    if (on && typeof MutationObserver === 'function') {
      // the drone module mounts with its tab, strips come and go: keep the outlines on what is there
      mo = new MutationObserver(() => repaint.push());
      mo.observe(v.host, { childList: true, subtree: true });
    } else if (!on && mo) {
      mo.disconnect();
      mo = null;
    }
  }
  d.add(() => listen(false));

  // a right-click (Ctrl-click; a long-press where the browser sends contextmenu) on a learnable control opens learn
  // mode with that control picked. Not under Lock (the browser's own menu, as in Edit).
  d.listen(document, 'contextmenu', (e) => {
    if (v.isLocked() || store.get().settings.view !== 'perform') return;
    const t = targetOf(e.target);
    if (!t) return;
    e.preventDefault();
    if (st) pick(t);
    else enter({ target: t.id });
  });

  // ---------------------------------------------------------------- what ends or restarts it
  let songId = store.get().settings.currentSongId;
  d.add(store.subscribe((state) => {
    if (!st) {
      songId = state.settings.currentSongId;
      return;
    }
    if (state.settings.performLock) return exit('lock');
    if (state.settings.view !== 'perform') return exit('view');
    if (state.settings.currentSongId !== songId) {
      songId = state.settings.currentSongId;
      if (st.heard || st.picked) restart();
    }
    repaint.push();
  }));
  if (typeof store.onSlotMap === 'function') {
    d.add(store.onSlotMap(({ id }) => {
      // a picked "strip 2" would now be another instrument's (the mapping is positional, but the words were not)
      if (st && id === store.get().settings.currentSongId && st.picked && /^slots\./.test(st.picked.id)) {
        queueMicrotask(() => restart());
      }
    }));
  }

  const api = {
    el,
    enter,
    exit,
    get active() {
      return !!st;
    },
    /** Test hook: {heard, picked} while learning, else null. */
    get state() {
      return st ? { heard: st.heard, picked: st.picked ? st.picked.id : null } : null;
    },
    /** Test hook: the learnable controls on screen now. */
    get targets() {
      return targets().map(({ id, label }) => ({ id, label }));
    },
    destroy() {
      exit('destroy');
      if (live === api) live = null;
      d.dispose();
      el.remove();
    },
  };
  live = api;
  return api;
}
