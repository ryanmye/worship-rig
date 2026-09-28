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

const DRONE_REF = Object.freeze({ type: 'synth', id: 'drone-osc' });
const FOLLOW_SPLIT = 60; // C4
const POOL_MIN = 4; // <audio> elements created up front
const POOL_MAX = 6; // grown on demand (a loop crossfade holds 2 elements; key changes during fades need more)
const STEAL_FADE = 0.15; // an element taken from a full pool fades out over this before reuse (never a hard cut)
const IDLE_INST = 2; // reusable drone-osc instruments kept between key changes (A/B)
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Level at time t of an equal-power fade {t, dur, from, to} (see fx.equalPowerFade). */
function fadeLevel(f, t, dflt = 1) {
  if (!f) return dflt;
  if (t >= f.t + f.dur) return f.to;
  if (t <= f.t) return f.from;
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
   * @param {object} o {ctx, registry, rng, timer, sum, reverbIn, warn}
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
    this.merge = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
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
    this.merge.connect(this.level).connect(this.wheel).connect(this.bendGain).connect(this.out);
    this.out.connect(o.sum);
    this.out.connect(this.sendGate).connect(o.reverbIn);
    this.p = { gain: Math.pow(10, -6 / 20), brightness: 0.5, movement: 0.3, width: 0.7, fade: 4 };
    this.cfg = { mode: 'off', chordFollow: false, continueAcrossSongs: true, minorUsesRelativeMajorFile: true };
    this.key = null; // {pc, minor}
    this.sounding = false;
    this.layers = [];
    this.files = new Map(); // 'pc|minor' -> {name, url}
    this.pool = null;
    this.activeEls = [];
    this.follow = { voices: [], pending: null, targets: null, lastHeld: [] };
    this.effectiveMode = 'off';
    this._idle = []; // reusable {inst, gain} drone-osc instruments (REVIEW #16)
    this._applyWidth(0);
    this.nodeCount = 17;
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
    inst.output.connect(gain).connect(this.synthBus);
    return { inst, gain };
  }
  _takeInst(t) {
    const e = this._idle.shift() || this._buildInst();
    this._applyInstParams(e.inst, t);
    this.warm();
    return e;
  }
  _returnInst(e) {
    const cap = this.cfg.chordFollow ? 4 : IDLE_INST;
    if (!this._disposed && this._idle.length < cap && !e.inst.disposed) {
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
    if (key === 'gain') rampTo(this.level.gain, clamp(v, 0, 2), t, 0.015);
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
    if (this.cfg.mode === 'off') return true;
    this._start(key, Number.isFinite(fade) ? fade : this.p.fade, t, false);
    return true;
  }

  _start(key, fade, t, modeSwitch) {
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
    }
    // everything currently sounding fades out; the new source fades in (equal-power)
    this._fadeOutAll(t, fade);
    this.effectiveMode = mode;
    if (mode === 'files') this._filesTo(file, fade, t);
    else this._synthTo(key, fade, t);
    this.sounding = true;
  }

  _fadeOutAll(t, fade) {
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
  _newLayer(notes, t, fade, vel = 0.8) {
    // a reused instrument (no construction on the key-change path); its params/morph are re-applied on take
    const pe = this._takeInst(t);
    const { inst, gain } = pe;
    const L = { inst, gain, pe, voices: [], fade: { t, dur: fade, from: 0, to: 1 }, dead: false };
    for (const n of notes) L.voices.push({ note: n, voice: inst.noteOn(n, vel, t) });
    equalPowerFade(gain.gain, 0, 1, t, fade);
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
  _synthTo(key, fade, t) {
    const L = this._newLayer(staticVoicing(key.pc, this.p.brightness), t, fade);
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
    return n;
  }
  getState() {
    return { ...this.cfg, key: this.key ? { ...this.key } : null, params: { ...this.p } };
  }
  dispose() {
    this._disposed = true;
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
    } catch {}
  }
}
