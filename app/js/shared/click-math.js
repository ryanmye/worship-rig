// Click / metronome grid math (v11-metronome). Pure: no DOM, no Web Audio, no timers.
//
// The click runs on a beat grid in audio-clock seconds: a list of segments, each {t0, beat0, spb, meter, bar0}
// (beat `beat0` sounds at `t0`, one beat lasts `spb` seconds, `bar0` is a downbeat). A tempo change (tap tempo, the
// tempo field) starts a new segment on the next beat that is not scheduled yet, so the grid never lurches mid-beat
// and nothing already handed to Web Audio / Web MIDI has to be taken back. A new song or time signature also starts
// a new bar there (accent). The engine (engine/metronome.js) turns ticks into buffer sources and pulses into MIDI
// clock messages; the tests check the math here without a browser.
//
// Compound meters (6/8, 12/8): the song's BPM counts the dotted quarter (the felt beat, what Tap catches), and the
// click subdivides it into three eighths. MIDI clock is 24 pulses per quarter note, so a dotted-quarter beat is 36.

/** Time signatures the song panel offers (song.timeSig; absent = 4/4). */
export const TIME_SIGS = Object.freeze(['4/4', '3/4', '2/4', '5/4', '6/8', '12/8']);
export const DEFAULT_TIME_SIG = '4/4';
/** Count-in lengths in bars (settings.click.countIn; 0 = off). */
export const COUNT_IN_BARS = Object.freeze([0, 1, 2]);
/** MIDI clock pulses per quarter note (MIDI 1.0 spec). */
export const MIDI_PPQ = 24;
/** MIDI real-time status bytes. */
export const MIDI_CLOCK = 0xf8;
export const MIDI_START = 0xfa;
export const MIDI_STOP = 0xfc;

/**
 * settings.click defaults (the object is optional and absent until someone changes a click setting):
 * level: linear gain of the click bus (0..1; the accent's peak is CLICK_PEAK × level);
 * countIn: bars before the song's first downbeat when the click starts (0 = none);
 * after: 'click' = keep clicking after the count-in, 'quiet' = count in only (MIDI clock keeps running);
 * record: the recorder also captures the click; output: 'main' (with the music) | 'aux' (outputs 3–4).
 */
export const CLICK_DEFAULTS = Object.freeze({ level: 0.6, countIn: 0, after: 'click', record: false, output: 'main' });
export const CLICK_OUTPUTS = Object.freeze(['main', 'aux']);
export const CLICK_AFTER = Object.freeze(['click', 'quiet']);

const EPS = 1e-9;
const mod = (a, n) => ((a % n) + n) % n;

/**
 * A time signature → the click's meter.
 * @param {string} [sig] '3/4', '6/8', …; anything else is 4/4
 * @returns {{sig:string, beats:number, sub:number, ppb:number}} beats per bar, clicks per beat, MIDI pulses per beat
 */
export function meterOf(sig) {
  const s = TIME_SIGS.includes(sig) ? sig : DEFAULT_TIME_SIG;
  const [n, d] = s.split('/').map(Number);
  const compound = d === 8 && n % 3 === 0;
  const beats = compound ? n / 3 : n;
  const sub = compound ? 3 : 1;
  return { sig: s, beats, sub, ppb: compound ? MIDI_PPQ * 1.5 : MIDI_PPQ };
}

/**
 * Validate a song's timeSig (store): a known signature, else undefined (absent = 4/4).
 * @param {*} v
 * @returns {string|undefined}
 */
export function validTimeSig(v) {
  return typeof v === 'string' && TIME_SIGS.includes(v) ? v : undefined;
}

/**
 * Normalise settings.click: known fields clamped / validated, unknown fields kept, absent fields left absent.
 * @param {*} raw
 * @returns {object|null} null when raw is not an object
 */
export function normalizeClick(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = v;
  }
  if ('level' in out) {
    const n = Number(out.level);
    if (Number.isFinite(n)) out.level = Math.min(1, Math.max(0, n));
    else delete out.level;
  }
  if ('countIn' in out) {
    const n = Math.round(Number(out.countIn));
    if (COUNT_IN_BARS.includes(n)) out.countIn = n;
    else delete out.countIn;
  }
  if ('after' in out && !CLICK_AFTER.includes(out.after)) delete out.after;
  if ('record' in out) {
    if (typeof out.record === 'boolean') {
      if (!out.record) delete out.record;
    } else delete out.record;
  }
  if ('output' in out && !CLICK_OUTPUTS.includes(out.output)) delete out.output;
  return out;
}

/**
 * settings.click with the defaults filled in.
 * @param {object} [settings] the store's settings
 * @returns {{level:number, countIn:number, after:string, record:boolean, output:string}}
 */
export function clickSettingsOf(settings) {
  const c = normalizeClick(settings && settings.click) || {};
  return { ...CLICK_DEFAULTS, ...c, record: c.record === true };
}

/**
 * The click's beat grid (see the header). All times are audio-clock seconds.
 */
export class ClickGrid {
  /**
   * @param {{t0:number, bpm:number, sig?:string, countIn?:number}} o
   *   t0: the first click; countIn: bars before the song's first downbeat (beat countIn × beats)
   */
  constructor({ t0, bpm, sig, countIn = 0 }) {
    const meter = meterOf(sig);
    this.segs = [{ t0, beat0: 0, spb: 60 / bpm, meter, bar0: 0 }];
    this.countInBars = COUNT_IN_BARS.includes(countIn) ? countIn : 0;
    /** The song's first downbeat (a beat index); the beats before it are the count-in. */
    this.downbeat = this.countInBars * meter.beats;
  }

  /** The segment that holds beat b. */
  segOfBeat(b) {
    const s = this.segs;
    let i = s.length - 1;
    while (i > 0 && s[i].beat0 > b + EPS) i--;
    return s[i];
  }

  /** The segment that holds audio time t. */
  segOfTime(t) {
    const s = this.segs;
    let i = s.length - 1;
    while (i > 0 && s[i].t0 > t + EPS) i--;
    return s[i];
  }

  /** @returns {number} audio time of beat b (fractional beats allowed) */
  beatTime(b) {
    const g = this.segOfBeat(b);
    return g.t0 + (b - g.beat0) * g.spb;
  }

  /** @returns {number} the (fractional) beat at audio time t; negative before the first click */
  beatAt(t) {
    const g = this.segOfTime(t);
    return g.beat0 + (t - g.t0) / g.spb;
  }

  /** @returns {number} audio time of the song's first downbeat (the end of the count-in) */
  get downbeatTime() {
    return this.beatTime(this.downbeat);
  }

  /** @returns {number} current tempo (BPM) of the last segment */
  get bpm() {
    return 60 / this.segs[this.segs.length - 1].spb;
  }

  /** @returns {object} the last segment's meter */
  get meter() {
    return this.segs[this.segs.length - 1].meter;
  }

  /**
   * Change the tempo and/or meter from the first whole beat at or after `tMin` (the caller passes its scheduling
   * horizon, so no scheduled tick or pulse moves). A later segment that starts at or after that beat is replaced,
   * so several changes in one go (a song switch: tempo + time signature) land on the same beat.
   * @param {number} tMin
   * @param {{bpm?:number, sig?:string, newBar?:boolean}} o  newBar: a downbeat (accent) on that beat; a new meter
   *   always starts a new bar. A count-in still running starts over in the new tempo/meter on a new bar.
   * @returns {{beat:number, t:number}} where the change lands
   */
  retime(tMin, { bpm, sig, newBar = false } = {}) {
    const b = Math.max(Math.ceil(this.beatAt(tMin) - 1e-6), 0);
    const t = this.beatTime(b);
    // a change already pending on that very beat is merged (its new bar / meter / tempo stay unless overridden)
    const base = this.segOfBeat(b);
    const meter = sig === undefined ? base.meter : meterOf(sig);
    const barStart = newBar || meter.sig !== base.meter.sig || (Math.abs(base.beat0 - b) < EPS && base.bar0 === b);
    this.segs = this.segs.filter((g) => g.beat0 < b - EPS);
    this.segs.push({ t0: t, beat0: b, spb: bpm > 0 ? 60 / bpm : base.spb, meter, bar0: barStart ? b : base.bar0 });
    if (barStart && b < this.downbeat) this.downbeat = b + this.countInBars * meter.beats; // the count-in restarts
    return { beat: b, t };
  }

  /**
   * Click ticks with tick times in [tFrom, tTo).
   * @returns {Array<{t:number, beat:number, kind:'accent'|'beat'|'sub', countIn:boolean, beatInBar:number}>}
   */
  ticks(tFrom, tTo) {
    const out = [];
    this._walk(tFrom, tTo, (g) => g.meter.sub, (g, k, t) => {
      const sub = g.meter.sub;
      const beat = g.beat0 + k / sub;
      const whole = k % sub === 0;
      const beatInBar = mod(Math.floor(beat + EPS) - g.bar0, g.meter.beats);
      const kind = !whole ? 'sub' : beatInBar === 0 ? 'accent' : 'beat';
      out.push({ t, beat, kind, countIn: beat < this.downbeat - EPS, beatInBar });
    });
    return out;
  }

  /**
   * MIDI clock pulse times in [tFrom, tTo) (24 per quarter note).
   * @returns {number[]}
   */
  pulses(tFrom, tTo) {
    const out = [];
    this._walk(tFrom, tTo, (g) => g.meter.ppb, (g, k, t) => out.push(t));
    return out;
  }

  /** Visit grid points (n per beat) of every segment with times in [tFrom, tTo). */
  _walk(tFrom, tTo, perBeat, fn) {
    const s = this.segs;
    for (let i = 0; i < s.length; i++) {
      const g = s[i];
      const n = perBeat(g);
      const step = g.spb / n;
      const next = s[i + 1];
      const kEnd = next ? Math.round((next.beat0 - g.beat0) * n) : Infinity; // exclusive
      const tEnd = next ? next.t0 : Infinity;
      if (tEnd <= tFrom + EPS || g.t0 >= tTo) continue;
      let k = Math.max(0, Math.floor((tFrom - g.t0) / step) - 1);
      for (; k < kEnd; k++) {
        const t = g.t0 + k * step;
        if (t >= tTo - EPS) break;
        if (t < tFrom - EPS) continue;
        fn(g, k, t);
      }
    }
  }
}

/**
 * Audio-clock time → performance.now() milliseconds, for Web MIDI timestamps (v11-metronome). Anchored on
 * AudioContext.getOutputTimestamp() (the context time being heard at a performance time), so a MIDI clock pulse
 * leaves when its click is heard. The anchor's offset is smoothed: getOutputTimestamp moves in render quanta and the
 * two clocks drift by parts per million, so a raw re-anchor on every pump would add up to a quantum of jitter. A jump
 * of more than `resetMs` (a device change, a suspend) re-anchors at once.
 */
export class ClockMap {
  /** @param {{alpha?:number, resetMs?:number}} [o] */
  constructor({ alpha = 0.05, resetMs = 15 } = {}) {
    this.alpha = alpha;
    this.resetMs = resetMs;
    this.offsetMs = null;
    this.resets = 0;
  }

  /**
   * Feed one observation: audio time `contextTime` (s) is heard at `performanceTime` (ms).
   * @returns {number} the smoothed offset (ms)
   */
  observe(contextTime, performanceTime) {
    const off = performanceTime - contextTime * 1000;
    if (this.offsetMs === null || Math.abs(off - this.offsetMs) > this.resetMs) {
      this.offsetMs = off;
      this.resets++;
    } else this.offsetMs += this.alpha * (off - this.offsetMs);
    return this.offsetMs;
  }

  /** @returns {number} performance.now() milliseconds for audio time t (s) */
  toPerf(t) {
    return t * 1000 + (this.offsetMs ?? 0);
  }
}
