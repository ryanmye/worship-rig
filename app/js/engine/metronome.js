// Click track / metronome (v11-metronome; BACKLOG A "Metronome / click track … count-in … MIDI-clock out").
//
// Sample-accurate: every click is an AudioBufferSourceNode started at its grid time (shared/click-math.js ClickGrid),
// scheduled CLICK_LOOKAHEAD_SEC ahead by a pump on the engine's AudioTimer (no setTimeout: offline renders stay
// deterministic, and an audio-clock pump is not throttled in a background window the way timers are). Tempo and
// time-signature changes start on the first beat past the scheduled horizon, so nothing scheduled is ever moved.
//
// Routing (CONTRACT_CHANGES "## v11-metronome"):
//   bus (own level) ─┬─ 'main': ctx.destination, summed after the master chain's ceiling (fx.out), so the music's
//                    │          master volume / fade / catcher compressor never act on it, and fx.recordTap (the
//                    │          recorder's input) never hears it
//                    ├─ 'aux':  outputs 3–4 of a 4+ channel interface (destination switched to 4 discrete
//                    │          channels; the music stays on 1–2) for "click in the in-ears only"
//                    └─ fx.recordTap, only while `record` is on (settings.click.record, default off)
// MIDI clock: the pump hands each window's 24 ppq pulses (+ Start on the song's first downbeat, Stop on stop) to a
// sink as audio-clock times; the controller maps them to performance.now() and sends them (app/js/midi-clock.js).
import { ClickGrid, meterOf, MIDI_CLOCK, MIDI_START, MIDI_STOP, CLICK_DEFAULTS } from '../shared/click-math.js';
import { rampTo } from '../shared/automation.js';

/** How far ahead clicks and MIDI pulses are scheduled (s). Covers a main-thread stall of this length. */
export const CLICK_LOOKAHEAD_SEC = 0.2;
/** Pump period on the audio clock (s). */
export const CLICK_PUMP_SEC = 0.05;
/** First click this long after clickStart() (s), so it is never late. */
export const CLICK_START_LEAD_SEC = 0.06;
/** Accent peak at level 1 (linear). The click sums after the master ceiling (−0.3 dBFS), so it stays well below. */
export const CLICK_PEAK = 0.5;
/** Peak of each tick kind relative to the accent (beat −5.2 dB, subdivision −10.5 dB). */
export const CLICK_KIND_GAIN = Object.freeze({ accent: 1, beat: 0.55, sub: 0.3 });
/** Click pitch per kind (Hz): the accent is a fifth above the beat. */
const KIND_HZ = { accent: 1980, beat: 1320, sub: 1320 };
const CLICK_LEN_SEC = 0.04;
const CLICK_ATTACK_SEC = 0.0003;
const CLICK_DECAY_TC = 0.008;

/**
 * One click sound: a cosine-phase tone (non-zero from the first sample, so the onset is the start time) with a
 * 0.3 ms attack, an 8 ms exponential decay and a 5 ms fade to zero, peak-normalised to `peak`.
 * @param {number} sr
 * @param {number} hz
 * @param {number} peak
 * @returns {Float32Array}
 */
export function clickSamples(sr, hz, peak) {
  const n = Math.round(CLICK_LEN_SEC * sr);
  const att = Math.max(1, Math.round(CLICK_ATTACK_SEC * sr));
  const fade = Math.round(0.005 * sr);
  const out = new Float32Array(n);
  let max = 0;
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, (i + 1) / att) * Math.exp(-i / (CLICK_DECAY_TC * sr)) * Math.min(1, (n - 1 - i) / fade);
    const w = 2 * Math.PI * hz * (i / sr);
    out[i] = env * (Math.cos(w) + 0.25 * Math.cos(2 * w));
    max = Math.max(max, Math.abs(out[i]));
  }
  const k = max > 0 ? peak / max : 0;
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}

export class Metronome {
  /**
   * @param {{ctx:BaseAudioContext, timer:{at:Function}, recordTap?:AudioNode, emit?:Function, warn?:Function}} o
   */
  constructor({ ctx, timer, recordTap = null, emit = () => {}, warn = () => {} }) {
    this.ctx = ctx;
    this.timer = timer;
    this.recordTap = recordTap;
    this._emit = emit;
    this._warn = warn;
    this.bus = new GainNode(ctx, { gain: CLICK_DEFAULTS.level, channelCount: 1, channelCountMode: 'explicit' });
    this.buffers = {};
    for (const kind of Object.keys(CLICK_KIND_GAIN)) {
      const sr = ctx.sampleRate;
      const b = new AudioBuffer({ numberOfChannels: 1, length: Math.round(CLICK_LEN_SEC * sr), sampleRate: sr });
      b.copyToChannel(clickSamples(sr, KIND_HZ[kind], CLICK_PEAK * CLICK_KIND_GAIN[kind]), 0);
      this.buffers[kind] = b;
    }
    this.level = CLICK_DEFAULTS.level;
    this.record = false;
    this.output = 'main';
    this._merger = null;
    this._destSaved = null;
    this._routeMain();
    this.bpm = null;
    this.sig = '4/4';
    this.grid = null;
    this.quietAfter = false;
    this._live = new Set(); // scheduled / sounding sources: {src, t}
    this._horizon = 0;
    this._cancelPump = null;
    this._sink = null;
    this._startSent = false;
    this._counting = false;
    this._disposed = false;
    this.stats = { pumps: 0, pumpMs: 0, ticks: 0, late: 0, pulses: 0, startedAt: null };
  }

  /** @returns {boolean} the click transport is running (clicks and/or MIDI clock) */
  get running() {
    return !!this.grid;
  }

  /** @returns {boolean} still inside the count-in */
  get counting() {
    return !!this.grid && this._counting;
  }

  /** What the routing can do on this output device. @returns {{aux:boolean, channels:number}} */
  outputs() {
    const ch = Number(this.ctx.destination.maxChannelCount) || 2;
    return { aux: ch >= 4, channels: ch };
  }

  /**
   * Click settings (settings.click): level 0..1, record into the recorder, output 'main' | 'aux'.
   * @returns {{output:string, auxAvailable:boolean}}
   */
  configure({ level, record, output } = {}, when) {
    const t = Math.max(Number.isFinite(when) ? when : 0, this.ctx.currentTime);
    if (Number.isFinite(level) && level !== this.level) {
      this.level = Math.min(1, Math.max(0, level));
      rampTo(this.bus.gain, this.level, t, 0.01);
    }
    if (typeof record === 'boolean' && record !== this.record && this.recordTap) {
      this.record = record;
      if (record) this.bus.connect(this.recordTap);
      else {
        try {
          this.bus.disconnect(this.recordTap);
        } catch {}
      }
    }
    if (output !== undefined) this.setOutput(output);
    return { output: this.output, auxAvailable: this.outputs().aux };
  }

  /**
   * 'main' (with the music) or 'aux' (outputs 3–4). 'aux' needs a destination with ≥ 4 channels; without one the
   * click stays on 'main' and warns once.
   * @returns {string} the routing now in effect
   */
  setOutput(output) {
    const want = output === 'aux' ? 'aux' : 'main';
    this._want = want;
    if (want === 'aux' && !this.outputs().aux) {
      this._warn('This output has no outputs 3–4, so the click plays with the music.');
      if (this.output !== 'main') this._routeMain();
      return this.output;
    }
    if (want === this.output && (want === 'main' || this._merger)) return want;
    if (want === 'aux') this._routeAux();
    else this._routeMain();
    return this.output;
  }

  /** Re-apply the wanted routing after an output device change (the channel count may differ). */
  reapplyOutput() {
    const want = this._want || 'main';
    this.output = null;
    this._unroute();
    if (want === 'aux' && this.outputs().aux) this._routeAux();
    else this._routeMain();
  }

  _unroute() {
    try {
      this.bus.disconnect(this.ctx.destination);
    } catch {}
    if (this._merger) {
      try {
        this.bus.disconnect(this._merger);
      } catch {}
      this._merger.disconnect();
      this._merger = null;
    }
    const d = this.ctx.destination;
    if (this._destSaved) {
      try {
        d.channelCount = this._destSaved.channelCount;
        d.channelInterpretation = this._destSaved.channelInterpretation;
      } catch {}
      this._destSaved = null;
    }
  }

  _routeMain() {
    this._unroute();
    this.bus.connect(this.ctx.destination);
    this.output = 'main';
  }

  _routeAux() {
    this._unroute();
    const d = this.ctx.destination;
    // the music (fx.out, stereo) up-mixes 'discrete' into channels 1–2 only; the click goes to 3 and 4
    this._destSaved = { channelCount: d.channelCount, channelInterpretation: d.channelInterpretation };
    try {
      d.channelCount = 4;
      d.channelCountMode = 'explicit';
      d.channelInterpretation = 'discrete';
    } catch (e) {
      this._warn(`Outputs 3–4 could not be opened (${e.message || e}); the click plays with the music.`);
      this._destSaved = null;
      this.bus.connect(d);
      this.output = 'main';
      return;
    }
    this._merger = new ChannelMergerNode(this.ctx, { numberOfInputs: 4 });
    this.bus.connect(this._merger, 0, 2);
    this.bus.connect(this._merger, 0, 3);
    this._merger.connect(d);
    this.output = 'aux';
  }

  /** MIDI clock sink: fn(messages) with messages [{t (audio s), data:[status]}], or null. */
  setClockSink(fn) {
    this._sink = typeof fn === 'function' ? fn : null;
  }

  /**
   * Start the click. countIn bars come first (the song's first downbeat follows them); quietAfter: only the count-in
   * is heard (the transport, and so the MIDI clock, keeps running until stop()).
   * @param {{bpm:number, sig?:string, countIn?:number, quietAfter?:boolean, when?:number}} o
   * @returns {{t0:number, downbeat:number}|null} null without a tempo
   */
  start({ bpm, sig, countIn = 0, quietAfter = false, when } = {}) {
    if (this._disposed) return null;
    if (bpm !== undefined) this.bpm = bpm > 0 ? bpm : null;
    if (sig !== undefined) this.sig = meterOf(sig).sig;
    if (!(this.bpm > 0)) return null;
    if (this.grid) this.stop({ silent: true });
    const now = this.ctx.currentTime;
    const t0 = Math.max(Number.isFinite(when) ? when : 0, now + CLICK_START_LEAD_SEC);
    this.grid = new ClickGrid({ t0, bpm: this.bpm, sig: this.sig, countIn });
    this.quietAfter = !!quietAfter && countIn > 0;
    this._counting = this.grid.downbeat > 0;
    this._startSent = false;
    this._horizon = now;
    this.stats.startedAt = now;
    this._emitState();
    this._pump(now);
    return { t0, downbeat: this.grid.downbeatTime };
  }

  /**
   * Stop at `when` (default now): clicks not yet started are dropped, MIDI Stop is sent.
   * @param {{when?:number, silent?:boolean}} [o] silent: no MIDI Stop / state event (a restart from start())
   */
  stop({ when, silent = false } = {}) {
    if (!this.grid) return false;
    const t = Math.max(Number.isFinite(when) ? when : 0, this.ctx.currentTime);
    for (const e of [...this._live]) {
      if (e.t < t - 1e-6) continue;
      try {
        e.src.disconnect();
      } catch {}
      this._live.delete(e);
    }
    this._cancelPump?.();
    this._cancelPump = null;
    this.grid = null;
    this._counting = false;
    if (!silent) {
      if (this._sink) this._send([{ t, data: [MIDI_STOP] }]);
      this._emitState();
    }
    return true;
  }

  /**
   * Tempo / meter change while running (or the values the next start uses). It lands on the first beat past the
   * scheduled horizon. bpm null stops the click (a song without a tempo).
   * @param {{bpm?:number|null, sig?:string, newBar?:boolean}} o
   */
  retime({ bpm, sig, newBar = false } = {}) {
    if (bpm === null) {
      this.bpm = null;
      if (this.grid) this.stop();
      return null;
    }
    const nb = bpm > 0 ? bpm : undefined;
    const ns = sig === undefined ? undefined : meterOf(sig).sig;
    const changed = (nb !== undefined && nb !== this.bpm) || (ns !== undefined && ns !== this.sig) || newBar;
    if (nb !== undefined) this.bpm = nb;
    if (ns !== undefined) this.sig = ns;
    if (!this.grid || !changed) return null;
    const tMin = Math.max(this._horizon, this.ctx.currentTime + 0.005);
    const r = this.grid.retime(tMin, { bpm: nb, sig: ns, newBar });
    if (this.grid.downbeat > r.beat) this._counting = true; // a new song during the count-in counts in afresh
    this._emitState();
    return r;
  }

  /** @returns {{running:boolean, counting:boolean, bpm:number|null, sig:string, output:string, level:number}} */
  state() {
    return {
      running: this.running,
      counting: this.counting,
      bpm: this.bpm,
      sig: this.sig,
      output: this.output,
      level: this.level,
      record: this.record,
      downbeat: this.grid ? this.grid.downbeatTime : null,
    };
  }

  _emitState() {
    this._emit(this.state());
  }

  _send(msgs) {
    try {
      this._sink(msgs);
    } catch (e) {
      this._warn(`MIDI clock send failed: ${e.message || e}`);
    }
  }

  _pump(now) {
    if (!this.grid || this._disposed) return;
    const p0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const g = this.grid;
    const from = this._horizon;
    const to = now + CLICK_LOOKAHEAD_SEC;
    if (to > from) {
      const downT = g.downbeatTime;
      for (const k of g.ticks(from, to)) {
        if (k.t < now - 0.002) {
          this.stats.late++; // a stalled pump: never play a click late
          continue;
        }
        if (this.quietAfter && !k.countIn) continue;
        const src = new AudioBufferSourceNode(this.ctx, { buffer: this.buffers[k.kind] });
        src.connect(this.bus);
        const e = { src, t: k.t };
        src.onended = () => {
          src.disconnect();
          this._live.delete(e);
        };
        src.start(k.t);
        this._live.add(e);
        this.stats.ticks++;
      }
      if (this._sink) {
        // MIDI Start right before the clock pulse of the song's first downbeat: a receiver starts on the first clock
        // after Start, and the pulses during the count-in let it lock to the tempo first
        const msgs = [];
        for (const t of g.pulses(from, to)) {
          if (!this._startSent && t >= downT - 1e-6) {
            msgs.push({ t, data: [MIDI_START] });
            this._startSent = true;
          }
          msgs.push({ t, data: [MIDI_CLOCK] });
        }
        this.stats.pulses += msgs.length;
        if (msgs.length) this._send(msgs);
      } else if (downT < to) this._startSent = true;
      this._horizon = to;
    }
    if (this._counting && now >= g.downbeatTime - 1e-6) {
      this._counting = false;
      this._emitState();
    }
    this.stats.pumps++;
    if (typeof performance !== 'undefined') this.stats.pumpMs += performance.now() - p0;
    this._cancelPump = this.timer.at(now + CLICK_PUMP_SEC, (t) => this._pump(t));
  }

  /** @returns {number} click sources scheduled or sounding */
  get liveCount() {
    return this._live.size;
  }

  dispose() {
    this.stop({ silent: true });
    this._disposed = true;
    for (const e of this._live) {
      try {
        e.src.disconnect();
      } catch {}
    }
    this._live.clear();
    this._unroute();
    try {
      this.bus.disconnect();
    } catch {}
  }
}
