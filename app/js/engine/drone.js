// Key drone (SPEC §3.6, REVIEW 1.12, 1.21, 3.5, 4.11).
//
// synth layers ─→ HPF 80 ─→ synthMode ─┐
// <audio> ×4 (MediaElementSource) ──→ filesMode ─┴→ width (L/R matrix) → level (drone.gain) → wheel → bend → out → sum (dry)
//                                                                                                      out → sendGate(.4 synth / 0 files) → reverb
// Synth voicing: root + 5th + octave (+ 9th when brightness > .6), no third (unless chord-follow).
// Key change: new layer fades in, old layers fade out, both equal-power over `fade`. Same key → no-op.
// All timing is audio-clock (AudioTimer) so offline renders are exact.
import { rampTo, setNow } from '../shared/automation.js';
import { chordName } from '../shared/chords.js';
import { noteToFreq, relativeMajor, relativeMinor, mod12, keyName } from '../shared/music.js';
import { detectKeyFromName } from '../shared/keydetect.js';
import { equalPowerFade, isOfflineContext, linFrom } from './fx.js';
import {
  renderDroneLoop, FREEZE_LOOP_SEC, FREEZE_SWAP_SEC, FREEZE_THAW_LEAD_SEC, FREEZE_DEBOUNCE_SEC, FREEZE_WET_TOL_DB,
} from './drone-freeze.js';

const DRONE_REF = Object.freeze({ type: 'synth', id: 'drone-osc' });
const FOLLOW_SPLIT = 60; // C4
const POOL_MIN = 4; // <audio> elements created up front
const POOL_MAX = 6; // grown on demand (a loop crossfade holds 2 elements; key changes during fades need more)
const STEAL_FADE = 0.15; // an element taken from a full pool fades out over this before reuse (never a hard cut)
const IDLE_INST = 2; // reusable drone-osc instruments kept between key changes (A/B)
/**
 * idle-cpu #2 (reviews/idle-cpu.md): a drone left at drone.gain 0 this long is parked: its layers fade out and
 * their voices end (a silent synth drone still ran ≈ 5 points of a core of voices on the 2-CPU box: gain 0 does
 * not stop Chromium pulling what feeds it). Raising the gain again restarts it in the same key (with the voice's
 * own attack). Short dips (a fader pulled down for a verse) never park.
 */
export const DRONE_PARK_SEC = 10;
const PARK_RESUME_FADE = 0.05;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const MiB = 1048576;
/** lowres2-critic R5: voice attack (s) for a layer that crossfades in over a song fade shorter than drone-osc's own. */
const XFADE_ATTACK_SEC = 0.05;
/** lowres2-critic R1: thaw voices reach full level this long before their layer's crossfade starts. */
const THAW_SETTLE_SEC = 0.25;

/** Level at time t of an equal-power fade {t, dur, from, to} (see fx.equalPowerFade). */
function fadeLevel(f, t, dflt = 1) {
  if (!f) return dflt;
  if (t >= f.t + f.dur) return f.to;
  if (t <= f.t) return f.from;
  if (f.lin) return f.from + ((f.to - f.from) * (t - f.t)) / f.dur; // lowres2-critic #1: aligned loop swap
  const x = ((t - f.t) / f.dur) * (Math.PI / 2);
  return f.to >= f.from ? f.from + (f.to - f.from) * Math.sin(x) : f.to + (f.from - f.to) * Math.cos(x);
}

/** Static voicing for a key: root in G2..F#3 (above the 80 Hz HPF, below the keys). */
export function staticVoicing(pc, brightness) {
  const root = 43 + mod12(pc - 7);
  const notes = [root, root + 7, root + 12];
  if (brightness > 0.6) notes.push(root + 14);
  return notes;
}

/**
 * Chord-follow voicing (SPEC §3.6): bass = lowest held pc in C2–B2; 3 upper voices in C3–C5 chosen by priority
 * 3rd > 7th > 5th > 9th > root; cost = Σ|Δ| + 6·(intervals < 3 semis below C3) + 3·duplicate pcs; exhaustive.
 * @param {number[]} held MIDI notes (input set)
 * @param {number[]} prevUpper previous 3 upper notes (sorted)
 * @returns {{bass:number, upper:number[]}|null} null when < 2 pitch classes
 */
export function followVoicing(held, prevUpper) {
  const sorted = [...held].sort((a, b) => a - b);
  const pcs = [...new Set(sorted.map((n) => mod12(n)))];
  if (pcs.length < 2) return null;
  const bassPc = mod12(sorted[0]);
  const ch = chordName(pcs, bassPc);
  const root = ch ? ch.root : bassPc;
  const prio = (pc) => {
    const iv = mod12(pc - root);
    if (iv === 3 || iv === 4 || iv === 5) return 0; // 3rd (sus4 stands in for it)
    if (iv === 10 || iv === 11 || iv === 9) return 1; // 7th (6th stands in)
    if (iv === 7 || iv === 6 || iv === 8) return 2; // 5th
    if (iv === 2 || iv === 1) return 3; // 9th
    return 4; // root
  };
  const ranked = pcs.slice().sort((a, b) => prio(a) - prio(b) || a - b);
  const chosen = ranked.slice(0, 3);
  const multisets = [];
  if (chosen.length >= 3) multisets.push(chosen);
  else {
    // 2 pcs: one of them doubled
    for (const d of chosen) multisets.push([...chosen, d]);
  }
  const bass = 36 + bassPc;
  const prev = (prevUpper && prevUpper.length === 3 ? prevUpper : [55, 60, 64]).slice().sort((a, b) => a - b);
  let best = null;
  let bestCost = Infinity;
  const opts = (pc) => {
    const o = [];
    for (let m = 48; m <= 72; m++) if (mod12(m) === pc) o.push(m);
    return o;
  };
  for (const ms of multisets) {
    const [o0, o1, o2] = ms.map(opts);
    for (const a of o0)
      for (const b of o1)
        for (const c of o2) {
          const up = [a, b, c].sort((x, y) => x - y);
          if (up[0] === up[1] || up[1] === up[2]) continue; // no unisons
          let cost = 0;
          for (let i = 0; i < 3; i++) cost += Math.abs(up[i] - prev[i]);
          const all = [bass, ...up];
          for (let i = 0; i < 3; i++) if (all[i] < 48 && all[i + 1] - all[i] < 3) cost += 6;
          cost += 3 * (4 - new Set(all.map(mod12)).size);
          if (cost < bestCost || (cost === bestCost && up[0] + up[1] + up[2] < best.upper.reduce((s, x) => s + x, 0))) {
            bestCost = cost;
            best = { bass, upper: up };
          }
        }
  }
  return best;
}

export class Drone {
  /**
   * @param {object} o {ctx, registry, rng, timer, sum, reverbIn, warn, wake?, seed?, freezeEnv?}
   *   wake (idle-cpu #2): called before a new layer / pad file sounds (the engine's sleeping send effects)
   *   seed, freezeEnv (lowres2): the engine seed and () => {ir, irKey, predelay, wet} of the live reverb, for the
   *   frozen loop (setFrozen); without freezeEnv the drone never freezes
   */
  constructor(o) {
    const { ctx } = o;
    this.ctx = ctx;
    this.o = o;
    this.offline = isOfflineContext(ctx);
    this.synthBus = new GainNode(ctx);
    this.hpf = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 80, Q: 20 * Math.log10(Math.SQRT1_2) }); // Butterworth (Q is dB)
    this.synthMode = new GainNode(ctx, { gain: 1 });
    this.filesBus = new GainNode(ctx);
    this.filesMode = new GainNode(ctx, { gain: 0 });
    this.widthIn = new GainNode(ctx);
    this.split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
    // lowres2-critic R3: 4 channels through level → wheel → bend: [live L, live R, loop L, loop R]. One set of gain
    // automation (drone.gain, wheel, swell) for both, but the reverb send taps channels 0–1 only, so a frozen loop
    // (which carries its own baked reverb) is never fed to the live reverb, not even during a swap.
    this.merge = new ChannelMergerNode(ctx, { numberOfInputs: 4 });
    this.fzIn = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 }); // frozen loops (stereo) → merge inputs 2, 3
    this.post = new ChannelSplitterNode(ctx, { numberOfOutputs: 4 });
    this.mainMerge = new ChannelMergerNode(ctx, { numberOfInputs: 2 }); // live + loop → out
    this.sendMerge = new ChannelMergerNode(ctx, { numberOfInputs: 2 }); // live only → sendGate
    this.wLL = new GainNode(ctx);
    this.wRR = new GainNode(ctx);
    this.wLR = new GainNode(ctx);
    this.wRL = new GainNode(ctx);
    this.level = new GainNode(ctx, { gain: Math.pow(10, -6 / 20) });
    this.wheel = new GainNode(ctx, { gain: 1 });
    this.bendGain = new GainNode(ctx, { gain: 1 });
    this.out = new GainNode(ctx, { gain: 1 });
    this.sendGate = new GainNode(ctx, { gain: 0.4 });
    this.synthBus.connect(this.hpf).connect(this.synthMode).connect(this.widthIn);
    this.filesBus.connect(this.filesMode).connect(this.widthIn);
    this.widthIn.connect(this.split);
    this.split.connect(this.wLL, 0).connect(this.merge, 0, 0);
    this.split.connect(this.wRL, 1).connect(this.merge, 0, 0);
    this.split.connect(this.wRR, 1).connect(this.merge, 0, 1);
    this.split.connect(this.wLR, 0).connect(this.merge, 0, 1);
    this.fzIn.connect(this.merge, 0, 2);
    this.fzIn.connect(this.merge, 1, 3);
    this.merge.connect(this.level).connect(this.wheel).connect(this.bendGain).connect(this.post);
    this.post.connect(this.mainMerge, 0, 0);
    this.post.connect(this.mainMerge, 2, 0);
    this.post.connect(this.mainMerge, 1, 1);
    this.post.connect(this.mainMerge, 3, 1);
    this.mainMerge.connect(this.out);
    this.post.connect(this.sendMerge, 0, 0);
    this.post.connect(this.sendMerge, 1, 1);
    this.out.connect(o.sum);
    this.sendMerge.connect(this.sendGate).connect(o.reverbIn);
    this.p = { gain: Math.pow(10, -6 / 20), brightness: 0.5, movement: 0.3, width: 0.7, fade: 4 };
    this.cfg = { mode: 'off', chordFollow: false, continueAcrossSongs: true, minorUsesRelativeMajorFile: true };
    this.key = null; // {pc, minor}
    this.sounding = false;
    this.parked = false;
    this.layers = [];
    this.files = new Map(); // 'pc|minor' -> {name, url}
    this.pool = null;
    this.activeEls = [];
    this.follow = { voices: [], pending: null, targets: null, lastHeld: [] };
    this.effectiveMode = 'off';
    this._idle = []; // reusable {inst, gain} drone-osc instruments (REVIEW #16)
    // lowres2: frozen loop (setFrozen). frozen = the loop playing now; _fzOut = loops fading out (≤ 1 during a swap)
    this.frozen = null;
    this._fzOut = [];
    this._freezeOn = false;
    this._sendMuted = false; // sendGate held at 0 while a frozen loop (which carries its own reverb) plays
    this._fz = {
      seq: 0, cancel: null, pendingSig: null, rendering: false, immediate: false, renders: 0, lastRenderMs: null,
      loopSec: FREEZE_LOOP_SEC, prerollSec: undefined, debounce: FREEZE_DEBOUNCE_SEC, lastError: null,
      last: null, reused: 0, rerunSeq: null, // lowres2-critic #2: the last rendered loop; a render waiting its turn
      lastStats: null, // lowres2-critic R4: {buildMs, postMs, maxStepMs} of the last render
    };
    this._applyWidth(0);
    this.nodeCount = 21; // lowres2-critic R3: + fzIn, post, mainMerge, sendMerge
  }

  /** gain-trims.json `droneTrim` (dB) on the synth bus (synth drone only; files-mode pads are not trimmed). */
  setTrim(db) {
    const g = Math.pow(10, (Number(db) || 0) / 20);
    this.trimDb = Number(db) || 0;
    setNow(this.synthBus.gain, g, 0);
  }

  /**
   * Reusable drone-osc instruments (REVIEW #16): a key change takes an idle one (A/B alternate) instead of
   * constructing one. When the last idle one is taken, a spare is built in idle time (realtime) so the next key
   * change doesn't construct either.
   */
  warm() {
    if (this._disposed || this._idle.length || this._spareP) return;
    if (this.offline || typeof requestIdleCallback !== 'function') return;
    this._spareP = true;
    requestIdleCallback(
      () => {
        this._spareP = false;
        if (!this._disposed && !this._idle.length) this._idle.push(this._buildInst());
      },
      { timeout: 3000 },
    );
  }
  _buildInst() {
    const inst = this.o.registry.create(this.ctx, this.o.rng.fork(), DRONE_REF, this._instParams());
    const gain = new GainNode(this.ctx, { gain: 0 });
    gain.connect(this.synthBus);
    // idle-cpu #1: inst.output → gain is connected only while the instrument plays a layer (_takeInst connects,
    // _returnInst disconnects). An idle drone-osc (monoBelow inside) is not reliably flagged silent by Chromium, so
    // a waiting instrument kept its bus / HPF / mono-low chain running (see AudioEngine._armSlot, reviews/idle-cpu.md).
    return { inst, gain, armed: false };
  }
  _takeInst(t) {
    const e = this._idle.shift() || this._buildInst();
    if (!e.armed) {
      e.armed = true;
      e.inst.output.connect(e.gain);
    }
    this._applyInstParams(e.inst, t);
    this.warm();
    return e;
  }
  _returnInst(e) {
    const cap = this.cfg.chordFollow ? 4 : IDLE_INST;
    if (!this._disposed && this._idle.length < cap && !e.inst.disposed) {
      // idle-cpu #1: an idle instrument waits disconnected (its layer faded to 0 and its voices ended ≥ 0.25 s ago)
      if (e.armed) {
        e.armed = false;
        try {
          e.inst.output.disconnect(e.gain);
        } catch {}
      }
      this._idle.push(e);
      return;
    }
    try {
      e.inst.dispose();
    } catch {}
    try {
      e.gain.disconnect();
    } catch {}
  }

  // ----- params ---------------------------------------------------------------------------------------------------
  setParam(key, value, when) {
    const t = this._t(when);
    const v = Number(value);
    if (!Number.isFinite(v) || !(key in this.p)) return false;
    const prevBright = this.p.brightness;
    this.p[key] = v;
    if (key === 'gain') {
      rampTo(this.level.gain, clamp(v, 0, 2), t, 0.015);
      this._gainChanged(t);
    }
    else if (key === 'width') this._applyWidth(t);
    else if (key === 'brightness' || key === 'movement') {
      for (const L of this.layers) this._applyInstParams(L.inst, t);
      for (const fv of this.follow.voices) this._applyInstParams(fv.inst, t);
      if (key === 'brightness' && (prevBright > 0.6) !== (v > 0.6)) this._revoice(t);
    }
    return true;
  }
  getParam(key) {
    return this.p[key];
  }
  /** idle-cpu #2: park after DRONE_PARK_SEC at gain 0; resume when the gain comes back (DRONE_PARK_SEC). */
  _gainChanged(t) {
    const seq = (this._parkSeq = (this._parkSeq || 0) + 1); // any gain change cancels a pending park
    if (this.p.gain > 0) {
      if (this.parked) {
        this.parked = false;
        if (this.cfg.mode !== 'off' && this.key) this._start(this.key, PARK_RESUME_FADE, t, true);
      }
      return;
    }
    if (this.parked || !this.sounding) return;
    this.o.timer.at(t + DRONE_PARK_SEC, (tt) => {
      if (seq !== this._parkSeq || this._disposed || this.p.gain > 0) return;
      if (!this.sounding || this.cfg.mode === 'off') return;
      this._fadeOutAll(tt, PARK_RESUME_FADE);
      this.sounding = false;
      this.parked = true;
    });
  }
  _applyWidth(t) {
    // L' = aL + bR, R' = aR + bL; width 1 → a=1,b=0 (full stereo), width 0 → mono
    const w = clamp(this.p.width, 0, 1);
    const a = (1 + w) / 2;
    const b = (1 - w) / 2;
    rampTo(this.wLL.gain, a, t, 0.02);
    rampTo(this.wRR.gain, a, t, 0.02);
    rampTo(this.wLR.gain, b, t, 0.02);
    rampTo(this.wRL.gain, b, t, 0.02);
  }
  /**
   * drone.brightness / drone.movement → the drone-osc instrument. brightness drives morph (filter sweep); movement
   * maps onto drone-osc's drift params when it has them (movement .3 ≈ the spec's ±3¢ walk, 4¢ unison drift,
   * 200¢ LFO), else is passed as 'movement' (fallback synth).
   */
  _instParams() {
    const keys = new Set((this.o.registry.paramsFor(DRONE_REF) || []).map((p) => p.key));
    const m = clamp(this.p.movement, 0, 1);
    const out = {};
    if (keys.has('drift')) out.drift = 1 + 6 * m;
    if (keys.has('unisonDrift')) out.unisonDrift = 1.6 + 8 * m;
    if (keys.has('lfoDepth')) out.lfoDepth = 20 + 600 * m;
    if (keys.has('movement')) out.movement = m;
    if (keys.has('brightness')) out.brightness = this.p.brightness;
    return out;
  }
  /** drone-osc's own attack (s): 2.5 (synth.js) / 2 (fallback). The voice envelope's linear rise. */
  _voiceAttack() {
    if (this._attackDflt === undefined) {
      const p = (this.o.registry.paramsFor(DRONE_REF) || []).find((x) => x.key === 'attack');
      this._attackDflt = p && Number.isFinite(p.default) ? p.default : null;
    }
    return this._attackDflt;
  }
  _applyInstParams(inst, t) {
    const ps = this._instParams();
    for (const [k, v] of Object.entries(ps)) inst.setParam(k, v, t);
    if (!('brightness' in ps)) inst.morph?.(clamp(this.p.brightness, 0, 1), t);
  }
  _t(when) {
    return Number.isFinite(when) && when > this.ctx.currentTime ? when : this.ctx.currentTime;
  }

  /** Controller hands the song's drone settings (mode + flags + params) in one call. */
  configure(d = {}, { when } = {}) {
    const t = this._t(when);
    for (const k of ['chordFollow', 'continueAcrossSongs', 'minorUsesRelativeMajorFile'])
      if (k in d) this.cfg[k] = !!d[k];
    for (const k of Object.keys(this.p)) if (k in d) this.setParam(k, d[k], t);
    if (!this.cfg.chordFollow && this.follow.voices.length) this._endFollow(t);
    if ('mode' in d) this.setMode(d.mode, { when: t });
  }

  /** Song change hook: fades out unless continueAcrossSongs. */
  songChanged({ when } = {}) {
    if (this.cfg.continueAcrossSongs) return;
    const t = this._t(when);
    this._fadeOutAll(t, this.p.fade);
    this.sounding = false;
  }

  // ----- mode / key ----------------------------------------------------------------------------------------------
  setMode(mode, { when } = {}) {
    const t = this._t(when);
    const m = ['off', 'synth', 'files'].includes(mode) ? mode : 'off';
    if (m === this.cfg.mode && (m === 'off' || this.sounding)) return;
    this.cfg.mode = m;
    if (this.parked) {
      // idle-cpu #2: parked at gain 0: remember the mode; the gain coming back starts it (off un-parks)
      if (m === 'off') this.parked = false;
      return;
    }
    if (m === 'off') {
      this._fadeOutAll(t, this.p.fade);
      this.sounding = false;
      return;
    }
    if (this.key) this._start(this.key, this.p.fade, t, true);
  }

  /**
   * @param {number} pc
   * @param {{minor?:boolean, fade?:number, when?:number}} [o]
   */
  setKey(pc, { minor = false, fade, when } = {}) {
    const t = this._t(when);
    const key = { pc: mod12(pc), minor: !!minor };
    const same = this.key && this.key.pc === key.pc && this.key.minor === key.minor;
    this.key = key;
    if (same && this.sounding) return false; // same key → no-op (no restarted crossfade)
    if (this.cfg.mode === 'off' || this.parked) return true; // parked (idle-cpu #2): the new key sounds on resume
    this._start(key, Number.isFinite(fade) ? fade : this.p.fade, t, false);
    return true;
  }

  _start(key, fade, t, modeSwitch) {
    // lowres2-critic R5: something already sounds (a key change / song switch, from the live synth or a frozen loop):
    // the new layer's level is the crossfade itself. With the voices' own 2.5 s attack under a shorter song fade the
    // old key was gone long before the new one had risen (−10 … −17 dB mid-change at a 0.3 s fade), so those voices
    // attack in XFADE_ATTACK_SEC and the equal-power layer fade shapes the onset. A start from silence (or a parked
    // drone resuming) keeps the voice's own attack.
    const hadSound = this.layers.some((L) => !L.dead) || !!this.frozen || this.follow.voices.length > 0 ||
      this.activeEls.length > 0;
    const va = this._voiceAttack();
    const attack = hadSound && va != null && fade < va ? XFADE_ATTACK_SEC : undefined;
    const wantFiles = this.cfg.mode === 'files';
    let file = null;
    if (wantFiles) {
      if (!this._filesSupported()) {
        this._warnOnce('files-unsupported', 'Drone files mode unavailable here (offline or no document); using the synth drone.');
      } else {
        file = this._fileFor(key);
        if (!file) this._warnOnce(`nofile|${key.pc}|${key.minor}`, `No pad file for ${keyName(key.pc, key.minor)}; using the synth drone.`);
      }
    }
    const mode = file ? 'files' : 'synth';
    if (mode !== this.effectiveMode || modeSwitch) {
      const was = this.effectiveMode;
      linFrom(this.synthMode.gain, was === 'files' ? 0 : 1, mode === 'synth' ? 1 : 0, t, 0.05);
      linFrom(this.filesMode.gain, was === 'files' ? 1 : 0, mode === 'files' ? 1 : 0, t, 0.05);
      rampTo(this.sendGate.gain, mode === 'synth' ? 0.4 : 0, t, fade / 4);
    } else if (this._sendMuted && mode === 'synth') {
      rampTo(this.sendGate.gain, 0.4, t, fade / 4); // lowres2: the live synth comes back after a frozen loop
    }
    this._sendMuted = false;
    this._freezeInvalidate(); // lowres2: a render in flight is for the old key / mode
    // everything currently sounding fades out; the new source fades in (equal-power)
    this._fadeOutAll(t, fade);
    this.effectiveMode = mode;
    if (mode === 'files') this._filesTo(file, fade, t);
    else this._synthTo(key, fade, t, attack);
    this.sounding = true;
    if (!(this.p.gain > 0)) this._gainChanged(t); // started at gain 0: park it too (idle-cpu #2)
  }

  _fadeOutAll(t, fade) {
    // lowres2: the frozen loop (and one still waiting to fade) goes like a layer
    for (const fz of [this.frozen, ...this._fzOut]) {
      if (fz && !(fz.fade.to === 0 && fz.fade.t <= t)) this._fadeOutFrozen(fz, t, fade);
    }
    for (const L of this.layers.slice()) this._fadeOutLayer(L, t, fade);
    if (this.follow.voices.length) {
      for (const fv of this.follow.voices.slice()) this._fadeOutLayer(fv, t, fade);
      this.follow.voices = [];
    }
    this.follow.targets = null;
    this.follow.pending = null;
    for (const e of this.activeEls.slice()) this._fadeOutEl(e, t, fade);
  }

  // ----- synth layers --------------------------------------------------------------------------------------------
  /**
   * fadeAt (lowres2 thaw): the voices start at `t`, the layer fades in from `fadeAt` (≥ t). attack (lowres2-critic
   * R5): the voices' envelope attack for this layer (s); undefined = drone-osc's own.
   */
  _newLayer(notes, t, fade, vel = 0.8, fadeAt = t, attack = undefined) {
    // a reused instrument (no construction on the key-change path); its params/morph are re-applied on take
    const pe = this._takeInst(t);
    this.o.wake?.(); // idle-cpu #2: the engine's sleeping send effects (the reverb) wake before the layer sounds
    const { inst, gain } = pe;
    const va = this._voiceAttack();
    const a = Number.isFinite(attack) ? attack : va;
    const setA = va != null && a !== va; // the instrument keeps drone-osc's own attack between layers (and _revoice)
    if (setA) inst.setParam('attack', a, t);
    const L = {
      inst, gain, pe, voices: [], fade: { t: fadeAt, dur: fade, from: 0, to: 1 }, dead: false,
      // lowres2-critic R1: the voices are at full level from voiceT + attack
      voiceT: t, attack: Number.isFinite(a) ? a : 0,
    };
    for (const n of notes) L.voices.push({ note: n, voice: inst.noteOn(n, vel, t) });
    if (setA) inst.setParam('attack', va, t);
    if (fadeAt > t) setNow(gain.gain, 0, t);
    equalPowerFade(gain.gain, 0, 1, fadeAt, fade);
    return L;
  }
  _levelAt(L, t) {
    return fadeLevel(L.fade, t, 1);
  }
  _fadeOutLayer(L, t, fade) {
    if (L.dead) return;
    L.dead = true;
    const from = this._levelAt(L, t);
    L.fade = { t, dur: fade, from, to: 0 };
    equalPowerFade(L.gain.gain, from, 0, t, fade);
    this.o.timer.at(t + fade + 0.02, (tt) => {
      L.inst.allOff(tt, 0.05);
      this.o.timer.at(tt + 0.3, () => {
        this.layers = this.layers.filter((x) => x !== L);
        this._returnInst(L.pe);
      });
    });
  }
  _synthTo(key, fade, t, attack) {
    const L = this._newLayer(staticVoicing(key.pc, this.p.brightness), t, fade, 0.8, t, attack);
    L.key = key;
    this.layers.push(L);
  }
  _revoice(t) {
    const L = this.layers.find((x) => !x.dead && x.key);
    if (!L) return;
    const want = staticVoicing(L.key.pc, this.p.brightness);
    for (const n of want) if (!L.voices.some((v) => v.note === n)) L.voices.push({ note: n, voice: L.inst.noteOn(n, 0.8, t) });
    for (const v of L.voices.slice()) {
      if (!want.includes(v.note)) {
        L.inst.noteOff(v.voice, t);
        L.voices = L.voices.filter((x) => x !== v);
      }
    }
  }

  // ----- chord-follow (experimental, synth mode only) -------------------------------------------------------------
  /** Engine feeds physically held notes on every change. Debounce 150 ms by event time. */
  notesChanged(held, when) {
    if (!this.cfg.chordFollow || this.effectiveMode !== 'synth' || this.cfg.mode !== 'synth' || !this.sounding) return;
    const t = this._t(when);
    const notes = [...held].sort((a, b) => a - b);
    const input = notes.filter((n) => n < FOLLOW_SPLIT);
    if (notes.length && !input.includes(notes[0])) input.unshift(notes[0]);
    // Debounce by EVENT time (works for pre-scheduled offline calls too): a change applies at t + 150 ms unless
    // another change happens in (t, t + 150 ms] (or later at the same instant).
    const seq = (this.follow.seq = (this.follow.seq || 0) + 1);
    const ch = { t, seq, input };
    this.follow.changes = (this.follow.changes || []).filter((c) => c.t > t - 1);
    this.follow.changes.push(ch);
    this.follow.pending = ch;
    this.o.timer.at(t + 0.15, (tt) => {
      const superseded = this.follow.changes.some((c) => c !== ch && (c.t > t ? c.t <= t + 0.15 + 1e-9 : c.t === t && c.seq > seq));
      if (superseded || !this.cfg.chordFollow) return;
      if (this.follow.pending === ch) this.follow.pending = null;
      this._applyFollow(ch.input, tt);
    });
  }
  _applyFollow(input, t) {
    const prevUpper = this.follow.targets ? this.follow.targets.slice(1) : this.key ? staticVoicing(this.key.pc, 0).slice() : null;
    const v = followVoicing(input, prevUpper);
    if (!v) return; // < 2 pcs → hold
    const target = [v.bass, ...v.upper];
    const old = this.follow.voices;
    if (!old.length) {
      // enter follow: static layers out 1.5 s, follow voices in 2 s
      for (const L of this.layers.slice()) this._fadeOutLayer(L, t, 1.5);
      if (this.frozen) {
        // lowres2: chord-follow is never frozen: the loop goes like a static layer and the reverb send reopens
        this._fadeOutFrozen(this.frozen, t, 1.5);
        if (this._sendMuted) equalPowerFade(this.sendGate.gain, 0, 0.4, t, 1.5);
        this._sendMuted = false;
      }
      this.follow.voices = target.map((n) => this._followVoice(n, t, 2));
    } else {
      const next = [];
      target.forEach((n, i) => {
        const fv = old[i];
        const cur = fv.base + fv.bend;
        const d = n - cur;
        if (Math.abs(d) <= 2 && typeof fv.inst.setBend === 'function' && Math.abs(n - fv.base) <= 7) {
          // glide 1.2 s: pre-scheduled bend steps (linear in semitones = exponential in Hz)
          const steps = 24;
          for (let k = 1; k <= steps; k++) fv.inst.setBend(fv.bend + (d * k) / steps, t + (1.2 * k) / steps);
          fv.bend = n - fv.base;
          next.push(fv);
        } else {
          this._fadeOutLayer(fv, t, 1.5);
          next.push(this._followVoice(n, t, 2));
        }
      });
      this.follow.voices = next;
    }
    this.follow.targets = target;
  }
  _followVoice(note, t, fade) {
    const L = this._newLayer([note], t, fade, 0.7);
    L.base = note;
    L.bend = 0;
    return L;
  }
  _endFollow(t) {
    for (const fv of this.follow.voices) this._fadeOutLayer(fv, t, 1.5);
    this.follow.voices = [];
    this.follow.targets = null;
    if (this.key && this.effectiveMode === 'synth' && this.sounding) {
      const L = this._newLayer(staticVoicing(this.key.pc, this.p.brightness), t, 2);
      L.key = this.key;
      this.layers.push(L);
    }
  }
  /** Target frequencies (Hz) of the chord-follow voicing, bass first; null when not following. */
  _debugTargets() {
    return this.follow.targets ? this.follow.targets.map((n) => noteToFreq(n)) : null;
  }

  // ----- frozen loop (low-resource mode; lowres2, drone-freeze.js) -------------------------------------------------
  /**
   * Low-resource mode (engine.setLowResource): while on, a sounding static synth drone is rendered offline into a
   * seamless loop (drone-freeze.js renderDroneLoop) and played from one looping buffer source into the drone's level
   * gain (drone.gain, wheel and swell still apply live, exactly: the chain is linear), with an equal-power crossfade
   * of FREEZE_SWAP_SEC from the live voices; the live layers then end and the send to the reverb closes (the loop
   * carries its own reverb), so the reverb unit goes to sleep (fx idle sleep). The loop is re-rendered (debounced
   * FREEZE_DEBOUNCE_SEC, audio clock) when what it bakes in changes: brightness, movement, width, trim, the reverb IR /
   * predelay, or the reverb return level by more than FREEZE_WET_TOL_DB; then it crossfades to the new loop. A key or
   * mode change goes through the live synth (the key change sounds at once, with the song's fade) and freezes again
   * after the debounce. Off: the live synth starts FREEZE_THAW_LEAD_SEC before the loop fades out. Files mode,
   * chord-follow and a parked drone are never frozen. Realtime only (an offline engine plays the live drone).
   * @param {boolean} on
   * @param {{when?:number}} [o]
   * @returns {boolean} whether freezing is wanted now
   */
  setFrozen(on, { when } = {}) {
    const v = !!on;
    if (v === this._freezeOn) return v;
    this._freezeOn = v;
    this._fz.immediate = v; // the first freeze does not wait for the debounce
    this._freezeUpdate(this._t(when));
    return v;
  }
  /** Test / tuning hook: {loopSec, debounceSec, prerollSec}. */
  _setFreezeOptions({ loopSec, debounceSec, prerollSec } = {}) {
    if (Number.isFinite(loopSec) && loopSec > 0) this._fz.loopSec = loopSec;
    if (Number.isFinite(prerollSec) && prerollSec >= 0) this._fz.prerollSec = prerollSec;
    if (Number.isFinite(debounceSec) && debounceSec >= 0) this._fz.debounce = debounceSec;
  }
  /** Engine poll (every FX_IDLE_POLL_SEC, realtime): notices changes of what the loop bakes in. */
  freezeTick(t) {
    if (this._freezeOn || this.frozen) this._freezeUpdate(this._t(t));
  }
  _freezable() {
    return this._freezeOn && !this.offline && !this._disposed && typeof this.o.freezeEnv === 'function' &&
      this.sounding && !this.parked && this.cfg.mode === 'synth' && this.effectiveMode === 'synth' &&
      !this.cfg.chordFollow && !this.follow.voices.length && !!this.key;
  }
  _freezeSig() {
    const env = this.o.freezeEnv() || {};
    return {
      pc: this.key.pc, minor: this.key.minor, brightness: this.p.brightness, movement: this.p.movement,
      width: this.p.width, trimDb: this.trimDb || 0, irKey: env.irKey ?? null, predelay: env.predelay ?? 0,
      wet: Number.isFinite(env.wet) ? env.wet : 0, ir: env.ir || null,
    };
  }
  _sigSame(a, b) {
    if (!a || !b) return false;
    for (const k of ['pc', 'minor', 'brightness', 'movement', 'width', 'trimDb', 'irKey', 'predelay']) {
      if (a[k] !== b[k]) return false;
    }
    if (a.wet <= 0 || b.wet <= 0) return a.wet <= 0 && b.wet <= 0;
    return Math.abs(20 * Math.log10(a.wet / b.wet)) <= FREEZE_WET_TOL_DB;
  }
  _freezeInvalidate() {
    const S = this._fz;
    S.seq++;
    S.pendingSig = null;
    if (S.cancel) S.cancel();
    S.cancel = null;
  }
  _freezeUpdate(t) {
    const S = this._fz;
    if (!this._freezable()) {
      if (S.pendingSig) this._freezeInvalidate();
      // low-resource ended / chord-follow turned on while frozen: back to the live synth
      if (this.frozen && this.sounding && !this.parked && this.cfg.mode !== 'off') this._thaw(t);
      return;
    }
    const sig = this._freezeSig();
    if (this.frozen && this._sigSame(this.frozen.sig, sig)) {
      if (S.pendingSig) this._freezeInvalidate(); // changed and changed back
      return;
    }
    if (!this.frozen) {
      // lowres2-critic #2: back on before a thaw's crossfade began (the popover opened and closed): keep the loop
      const fz = this._fzOut.find((x) => x.thawAt > t && x.fade.t > t && this._sigSame(x.sig, sig));
      if (fz) {
        this._unthaw(fz, t);
        return;
      }
    }
    if (S.pendingSig && this._sigSame(S.pendingSig, sig)) return; // already waiting / rendering for this
    this._freezeInvalidate();
    S.pendingSig = sig;
    let delay = S.immediate ? 0 : S.debounce;
    if (!this.frozen) {
      // a key change / start / thaw is still fading in: freeze once it has settled (lowres2-critic #2: also for the
      // first freeze, so hiding the window again mid-thaw never swaps a loop in over one still waiting to fade)
      for (const L of this.layers) {
        // lowres2-critic R1: and for the voices' own attack (a 0.3 s song fade still has 2.5 s of voice attack): a
        // loop rendered at full level swapped over voices still rising was a level bump / beat
        if (!L.dead) delay = Math.max(delay, L.fade.t + L.fade.dur - t + 0.25, L.voiceT + L.attack - t + 0.25);
      }
    }
    S.immediate = false;
    const seq = S.seq;
    S.cancel = this.o.timer.at(t + delay, () => {
      S.cancel = null;
      this._freezeRender(seq);
    });
  }
  async _freezeRender(seq) {
    const S = this._fz;
    if (seq !== S.seq || !this._freezable()) return;
    const sig = this._freezeSig();
    S.pendingSig = sig;
    // lowres2-critic #2: the last loop is kept (one buffer), so low-resource off → on with nothing changed (the
    // menu-bar popover opened and closed, the window shown for a moment) swaps it back in without rendering again
    const last = S.last;
    if (last && this._sigSame(last.sig, sig) && last.opts === `${S.loopSec}|${S.prerollSec}`) {
      S.pendingSig = null;
      S.reused++;
      this._freezeSwap(last.res, last.sig, this.ctx.currentTime + 0.02);
      return;
    }
    if (S.rendering) {
      // one render at a time: a toggle storm must not stack offline renders; this request runs when that one ends
      S.rerunSeq = seq;
      return;
    }
    S.rendering = true;
    let res;
    try {
      res = await renderDroneLoop({
        DroneClass: this.constructor,
        registry: this.o.registry,
        seed: this.o.seed ?? 1,
        sampleRate: this.ctx.sampleRate,
        key: { pc: sig.pc, minor: sig.minor },
        params: { brightness: sig.brightness, movement: sig.movement, width: sig.width },
        trimDb: sig.trimDb,
        reverb: sig.ir ? { ir: sig.ir, predelay: sig.predelay, wet: sig.wet } : null,
        loopSec: S.loopSec,
        prerollSec: S.prerollSec,
        waveSource: this.ctx, // lowres2-critic R4
      });
    } catch (e) {
      S.rendering = false;
      S.rerunSeq = null;
      S.lastError = String(e?.message || e);
      // pendingSig stays: no retry until something the loop bakes in changes (never a render loop)
      this._warnOnce(`freeze|${S.lastError}`, `Could not freeze the drone (${S.lastError}); it keeps playing live.`);
      return;
    }
    S.rendering = false;
    if (this._disposed) return;
    // lowres2-critic R4: the render's main-thread cost (graph build, post-processing) and its longest task
    S.lastStats = {
      buildMs: Math.round(res.buildMs * 10) / 10, postMs: Math.round((res.postMs || 0) * 10) / 10,
      maxStepMs: res.maxStepMs ?? null, stepMs: res.stepMs || null,
    };
    // a finished render stays valid for its inputs even when superseded (a toggle storm, a change and back)
    S.last = { sig, res, opts: `${S.loopSec}|${S.prerollSec}` };
    if (S.rerunSeq != null) {
      const rs = S.rerunSeq;
      S.rerunSeq = null;
      if (rs === S.seq) {
        this._freezeRender(rs);
        return;
      }
    }
    if (seq !== S.seq || !this._freezable()) return; // superseded: the newer change renders again
    S.pendingSig = null;
    S.renders++;
    S.lastRenderMs = Math.round(res.renderMs);
    if (!res.seam.ok) {
      this._warnOnce('freeze-seam', `Frozen drone loop seam step ${res.seam.seamDelta} > body ${res.seam.bodyDelta}`);
    }
    this._freezeSwap(res, sig, this.ctx.currentTime + 0.02);
  }
  /** Crossfade to a rendered loop: from the live layers (closing the reverb send) or from the previous loop. */
  _freezeSwap(res, sig, t) {
    const ctx = this.ctx;
    const src = new AudioBufferSourceNode(ctx, { buffer: res.buffer, loop: true });
    const g = new GainNode(ctx, { gain: 0 });
    src.connect(g).connect(this.fzIn); // lowres2-critic R3: joins after the send tap (merge inputs 2, 3)
    // lowres2-critic #1: a re-render of the same voicing (brightness / movement / width / trim / reverb) is the same
    // seeded render with a parameter changed, so the new loop is coherent with the playing one at the same loop
    // position. Started at a random offset, the equal-power sum of the two beat (partials in anti-phase: dips of
    // −3 … −8 dB measured mid-swap); started in step with the old loop and crossfaded linearly, the level holds.
    const prev = this.frozen;
    const aligned = !!prev && prev.sig.pc === sig.pc && prev.sig.minor === sig.minor &&
      prev.sig.brightness > 0.6 === sig.brightness > 0.6 && Math.abs(prev.loopSec - res.loopSec) < 1e-6;
    let offset = 0;
    if (aligned) {
      offset = (t - prev.t0) % prev.loopSec;
      if (offset < 0) offset += prev.loopSec;
      if (!(offset < res.buffer.duration)) offset = 0;
    }
    src.start(t, offset);
    if (aligned) linFrom(g.gain, 0, 1, t, FREEZE_SWAP_SEC);
    else equalPowerFade(g.gain, 0, 1, t, FREEZE_SWAP_SEC);
    const fz = {
      src, g, sig, dead: false, t0: t - offset, fade: { t, dur: FREEZE_SWAP_SEC, from: 0, to: 1, lin: aligned },
      loopSec: res.loopSec, bytes: res.bytes, renderMs: Math.round(res.renderMs), seam: res.seam,
    };
    if (prev) this._fadeOutFrozen(prev, t, FREEZE_SWAP_SEC, aligned);
    else {
      for (const L of this.layers.slice()) this._fadeOutLayer(L, t, FREEZE_SWAP_SEC);
      if (!this._sendMuted) equalPowerFade(this.sendGate.gain, 0.4, 0, t, FREEZE_SWAP_SEC);
      this._sendMuted = true;
    }
    this.frozen = fz;
  }
  _fadeOutFrozen(fz, t, fade, lin = false) {
    const from = fadeLevel(fz.fade, t, 1);
    fz.dead = true;
    fz.thawAt = 0; // _thaw marks its own fade after this call
    fz.fade = { t, dur: fade, from, to: 0, lin };
    if (lin) linFrom(fz.g.gain, from, 0, t, fade);
    else equalPowerFade(fz.g.gain, from, 0, t, fade);
    if (this.frozen === fz) this.frozen = null;
    if (!this._fzOut.includes(fz)) this._fzOut.push(fz);
    const end = t + fade + 0.05;
    fz.end = end;
    this.o.timer.at(end, () => {
      if (fz.end !== end) return; // re-scheduled (an earlier fade replaced this one)
      this._disposeFrozen(fz);
    });
  }
  _disposeFrozen(fz) {
    this._fzOut = this._fzOut.filter((x) => x !== fz);
    try {
      fz.src.stop();
    } catch {}
    try {
      fz.src.disconnect();
      fz.g.disconnect();
    } catch {}
    fz.src.buffer = null; // ≤ one loop + one during a crossfade (plus _fz.last, usually one of them)
  }
  /**
   * lowres2-critic R1: the thaw's live voices start this long before the crossfade: FREEZE_THAW_LEAD_SEC, and at least
   * their own attack + THAW_SETTLE_SEC, so the live layer crossfades in at its full level (it started 1.5 s into a
   * 2.5 s attack: the loop was fading out over voices still rising).
   */
  _thawLead() {
    const va = this._voiceAttack() || 0;
    return Math.max(FREEZE_THAW_LEAD_SEC, va + THAW_SETTLE_SEC);
  }
  /** Frozen loop → live synth: the voices start now, the loop fades _thawLead() later (equal-power). */
  _thaw(t) {
    const fz = this.frozen;
    if (!fz || !this.key) return;
    const at = t + this._thawLead();
    if (!this.follow.voices.length) {
      const L = this._newLayer(staticVoicing(this.key.pc, this.p.brightness), t, FREEZE_SWAP_SEC, 0.8, at);
      L.key = this.key;
      this.layers.push(L);
    }
    const inFull = fadeLevel(fz.fade, t, 1) >= 0.999 && fz.fade.to === 1; // not still fading in
    this._fadeOutFrozen(fz, at, FREEZE_SWAP_SEC);
    fz.thawAt = inFull ? at : 0; // _unthaw may keep it until then (at level 1)
    if (this._sendMuted) {
      setNow(this.sendGate.gain, 0, t);
      equalPowerFade(this.sendGate.gain, 0, 0.4, at, FREEZE_SWAP_SEC);
      this._sendMuted = false;
    }
  }
  /**
   * lowres2-critic #2: low-resource back on while a thaw still waits (FREEZE_THAW_LEAD_SEC) to fade its loop: the loop
   * stays (its fade is cancelled at level 1), the thaw's live layer (still at gain 0) ends and the send closes again,
   * so a popover opened and closed within the lead changes nothing audible and renders nothing.
   */
  _unthaw(fz, t) {
    this._freezeInvalidate();
    this._fz.immediate = false;
    this._fz.reused++;
    this._fzOut = this._fzOut.filter((x) => x !== fz);
    fz.thawAt = 0;
    fz.dead = false;
    fz.end = null; // the pending dispose (fadeOutFrozen's timer) no longer matches
    setNow(fz.g.gain, 1, t);
    fz.fade = { t, dur: 0, from: 1, to: 1 };
    this.frozen = fz;
    for (const L of this.layers.slice()) this._fadeOutLayer(L, t, 0.05);
    setNow(this.sendGate.gain, 0, t);
    this._sendMuted = true;
  }
  /** lowres2 _debugStats: frozen state, loop length, last render time. */
  freezeStats() {
    const fz = this.frozen;
    // loop memory held now: the playing loop + one fading out during a swap
    let bytes = (fz?.bytes || 0) + this._fzOut.reduce((n, x) => n + (x.bytes || 0), 0);
    // lowres2-critic #2: the kept last loop, when it is not one of those
    const kept = this._fz.last?.res;
    if (kept && ![fz, ...this._fzOut].some((x) => x && x.src.buffer === kept.buffer)) bytes += kept.bytes || 0;
    return {
      droneFrozen: !!fz,
      droneLoopSec: fz ? Math.round(fz.loopSec * 1000) / 1000 : null,
      droneRenderMs: this._fz.lastRenderMs,
      droneRenders: this._fz.renders,
      droneFreezeMB: Math.round((bytes / MiB) * 10) / 10,
      droneSeam: fz ? { ...fz.seam } : null,
      droneFreezePending: !!this._fz.pendingSig,
      droneFreezeReused: this._fz.reused, // lowres2-critic #2: swaps of the kept loop (no render)
      droneRenderMaxStepMs: this._fz.lastStats?.maxStepMs ?? null, // lowres2-critic R4: longest main-thread step
    };
  }

  // ----- bend 'drone-swell' ---------------------------------------------------------------------------------------
  bendSwell(x, when) {
    const t = this._t(when);
    const g = Math.max(0.05, this.p.gain);
    let target;
    if (x > 0) target = Math.min(4, 1 + (1 / g - 1) * x); // rises toward drone.gain = 1
    else target = 1 - 0.7 * Math.min(1, -x); // ducks to .3
    const prev = this._bendTarget ?? 1;
    this._bendTarget = target;
    // falling back from a push-up is slow (~3 s); everything else follows the wheel quickly
    const slow = target < prev && prev > 1;
    rampTo(this.bendGain.gain, target, t, slow ? 3 / 4.6 : 0.12);
  }

  // ----- files mode ----------------------------------------------------------------------------------------------
  _filesSupported() {
    return !this.offline && typeof document !== 'undefined' && typeof this.ctx.createMediaElementSource === 'function';
  }
  /** @param {{name:string,url:string}[]} list */
  attachFiles(list = []) {
    this.files.clear();
    let n = 0;
    for (const f of list) {
      const k = detectKeyFromName(f.name || f.url || '');
      if (!k) continue;
      const id = `${k.pc}|${k.minor}`;
      if (!this.files.has(id)) {
        this.files.set(id, { name: f.name, url: f.url });
        n++;
      }
    }
    // files mode fell back to the synth (no pad for the key, or no pads yet): switch to the file now (REVIEW #4)
    if (this.cfg.mode === 'files' && this.effectiveMode !== 'files' && this.sounding && this.key && this._filesSupported() && this._fileFor(this.key)) {
      this._start(this.key, 1.5, this.ctx.currentTime, true);
    }
    return n;
  }
  _fileFor(key) {
    const get = (pc, minor) => this.files.get(`${mod12(pc)}|${minor}`);
    if (key.minor) {
      if (this.cfg.minorUsesRelativeMajorFile) return get(relativeMajor(key.pc), false) || get(key.pc, true) || null;
      return get(key.pc, true) || get(relativeMajor(key.pc), false) || null;
    }
    return get(key.pc, false) || get(relativeMinor(key.pc), true) || null;
  }
  _ensurePool() {
    if (!this.pool) this.pool = [];
    while (this.pool.length < POOL_MIN) this._addEl();
  }
  _addEl() {
    const el = document.createElement('audio');
    el.preload = 'auto';
    const src = this.ctx.createMediaElementSource(el);
    const gain = new GainNode(this.ctx, { gain: 0 });
    src.connect(gain).connect(this.filesBus);
    const e = { el, src, gain, busy: false, seq: 0, fade: null, pending: false };
    this.pool.push(e);
    return e;
  }
  _elLevel(e, t) {
    return e.busy ? fadeLevel(e.fade, t, 0) : 0;
  }
  /**
   * A free pool element; grows the pool up to POOL_MAX. When every element is busy, the quietest one fades out
   * over STEAL_FADE and is reused after it (returns that delay) — never a hard cut of an audible element.
   * @returns {{e:object, delay:number}}
   */
  _grab() {
    this._ensurePool();
    let e = this.pool.find((x) => !x.busy);
    if (e) return { e, delay: 0 };
    if (this.pool.length < POOL_MAX) return { e: this._addEl(), delay: 0 };
    const now = this.ctx.currentTime;
    let best = null;
    let bl = Infinity;
    for (const x of this.pool) {
      if (x.stealing) continue;
      const l = this._elLevel(x, now);
      if (l < bl) {
        bl = l;
        best = x;
      }
    }
    if (!best) return { e: this.pool[0], delay: STEAL_FADE + 0.01 };
    best.seq++; // its own timers/handlers stop acting
    best.stealing = true;
    best.el.onplaying = best.el.onended = best.el.onloadedmetadata = best.el.onerror = null;
    this.activeEls = this.activeEls.filter((x) => x !== best);
    linFrom(best.gain.gain, bl, 0, now, STEAL_FADE);
    best.fade = { t: now, dur: STEAL_FADE, from: bl, to: 0 };
    return { e: best, delay: STEAL_FADE + 0.01 };
  }
  _releaseEl(e) {
    e.seq++;
    try {
      e.el.pause();
    } catch {}
    e.el.onplaying = e.el.onended = e.el.onloadedmetadata = e.el.onerror = null;
    setNow(e.gain.gain, 0, this.ctx.currentTime);
    e.busy = false;
    e.pending = false;
    e.stealing = false;
    e.fade = null;
    this.activeEls = this.activeEls.filter((x) => x !== e);
  }
  _fadeOutEl(e, t, fade) {
    if (e.fadingOut) return;
    if (e.pending) {
      // not playing yet (still loading/seeking) and silent: cancel it outright (REVIEW #2)
      this._releaseEl(e);
      return;
    }
    e.fadingOut = true;
    const seq = e.seq;
    const from = fadeLevel(e.fade, t, 1);
    e.fade = { t, dur: fade, from, to: 0 };
    equalPowerFade(e.gain.gain, from, 0, t, fade);
    this.activeEls = this.activeEls.filter((x) => x !== e);
    this.o.timer.at(t + fade + 0.05, () => {
      if (e.seq === seq) this._releaseEl(e);
    });
  }
  static loopRegion(dur) {
    const xf = 4;
    if (!(dur > 3 * xf)) return { loop: true };
    const ls = Math.min(8, dur * 0.25);
    const le = dur - Math.min(12, dur * 0.25);
    return { ls, le, xf: Math.min(xf, (le - ls) / 3) };
  }
  /**
   * Start `file` on a pool element at `offset` (random in the loop region when null); fade in after `playing`.
   * The element counts as live from here on (`pending` until it plays), so a newer key change cancels it.
   */
  _play(file, fade, t, offset = null, onStarted = null) {
    const { e, delay } = this._grab();
    e.busy = true;
    e.seq++;
    const seq = e.seq;
    e.fadingOut = false;
    e.pending = true;
    e.started = false;
    e.file = file;
    if (!this.activeEls.includes(e)) this.activeEls.push(e);
    const el = e.el;
    const begin = () => {
      const dur = el.duration;
      e.region = Drone.loopRegion(dur);
      el.loop = !!e.region.loop;
      let pos = offset;
      if (pos === null) {
        // random start, far enough from the loop end that no loop crossfade starts during the fade-in
        const r = e.region;
        pos = r.loop ? 0 : r.ls + this.o.rng.next() * Math.max(0, r.le - r.xf - fade - 2 - r.ls);
      }
      try {
        el.currentTime = Math.max(0, pos);
      } catch {}
      el.play().catch((err) => {
        if (e.seq === seq) this._warnOnce(`play|${file.url}`, `Pad file could not play: ${file.name} (${err.message || err})`);
      });
    };
    const go = () => {
      if (e.seq !== seq) return;
      if (e.stealing) {
        try {
          el.pause();
        } catch {}
        e.stealing = false;
      }
      setNow(e.gain.gain, 0, this.ctx.currentTime);
      e.fade = null;
      el.onloadedmetadata = () => {
        if (e.seq === seq) begin();
      };
      el.onplaying = () => {
        if (e.seq !== seq || e.started) return;
        e.started = true;
        e.pending = false;
        const now = this.ctx.currentTime;
        if (onStarted) onStarted(e, now);
        else this._fadeInEl(e, Math.max(now, t), fade);
      };
      el.onended = () => {
        // fallback: the loop crossfade was missed → restart at the loop start right away
        if (e.seq !== seq || !this.activeEls.includes(e)) return;
        this._releaseEl(e);
        this._play(file, 0.3, this.ctx.currentTime, e.region?.ls ?? 0);
      };
      el.onerror = () => {
        if (e.seq === seq) this._warnOnce(`err|${file.url}`, `Pad file failed to load: ${file.name}`);
      };
      el.src = file.url;
      el.load();
    };
    if (delay > 0) this.o.timer.at(this.ctx.currentTime + delay, go);
    else go();
    return e;
  }
  _fadeInEl(e, t, fade) {
    e.pending = false;
    const from = fadeLevel(e.fade, t, 0);
    e.fade = { t, dur: fade, from, to: 1 };
    equalPowerFade(e.gain.gain, from, 1, t, fade);
    if (!this.activeEls.includes(e)) this.activeEls.push(e);
    if (!e.region.loop) this._scheduleLoop(e, t);
  }
  /** Loop crossfade: incoming element pre-rolls 1.5 s at gain 0, then equal-power crossfade over region.xf. */
  _scheduleLoop(e, t) {
    const seq = e.seq;
    const { ls, le, xf } = e.region;
    const remaining = le - xf - e.el.currentTime; // seconds until the crossfade should start
    const xfAt = this.ctx.currentTime + Math.max(0, remaining);
    this.o.timer.at(Math.max(t, xfAt - 1.5), () => {
      if (e.seq !== seq || !this.activeEls.includes(e)) return;
      // resync against the media clock
      const rem = le - xf - e.el.currentTime;
      const startAt = this.ctx.currentTime + Math.max(0, rem);
      if (rem > 2.0) {
        this._scheduleLoop(e, this.ctx.currentTime);
        return;
      }
      this._play(e.file, xf, startAt, Math.max(0, ls - Math.max(0, rem)), (inc, now) => {
        if (e.seq !== seq || !this.activeEls.includes(e)) {
          this._releaseEl(inc);
          return;
        }
        const at = Math.max(now, startAt);
        this._fadeOutEl(e, at, xf);
        this._fadeInEl(inc, at, xf);
      });
    });
  }
  _filesTo(file, fade, t) {
    this.o.wake?.(); // idle-cpu #2 (files mode sends 0 to the reverb today; cheap and future-proof)
    this._play(file, fade, t);
  }

  _warnOnce(key, msg) {
    this._warned = this._warned || new Set();
    if (this._warned.has(key)) return;
    this._warned.add(key);
    this.o.warn(msg);
  }

  liveVoiceCount() {
    let n = 0;
    for (const L of [...this.layers, ...this.follow.voices]) n += L.inst.liveVoiceCount?.() || 0;
    return n;
  }
  liveNodeCount() {
    let n = this.nodeCount + (this.pool ? this.pool.length * 2 : 0);
    for (const L of [...this.layers, ...this.follow.voices]) n += 1 + (L.inst.liveNodeCount?.() || 0);
    n += (this.frozen ? 2 : 0) + 2 * this._fzOut.length; // lowres2: loop source + its gain
    return n;
  }
  getState() {
    return { ...this.cfg, key: this.key ? { ...this.key } : null, params: { ...this.p } };
  }
  dispose() {
    this._disposed = true;
    this._freezeInvalidate();
    this._fz.last = null;
    for (const fz of [this.frozen, ...this._fzOut]) if (fz) this._disposeFrozen(fz);
    this.frozen = null;
    for (const L of [...this.layers, ...this.follow.voices, ...this._idle]) {
      try {
        L.inst.dispose();
        L.gain.disconnect();
      } catch {}
    }
    this.layers = [];
    this.follow.voices = [];
    this._idle = [];
    if (this.pool) for (const e of this.pool) this._releaseEl(e);
    try {
      this.out.disconnect();
      this.sendGate.disconnect(); // lowres2-critic R3: the send has its own tap now
    } catch {}
  }
}
