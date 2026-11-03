// MIDI clock out (v11-metronome; BACKLOG A "… and a MIDI-clock out option"). Off by default.
//
// The engine's click (engine/metronome.js) hands this module 24 ppq clock pulses, Start and Stop as audio-clock times,
// CLICK_LOOKAHEAD_SEC ahead. They are sent to the chosen Web MIDI output with timestamps, mapped from the audio clock
// to performance.now() through AudioContext.getOutputTimestamp() (shared/click-math.js ClockMap), so each pulse
// leaves when the click it belongs to is heard, and the browser (not this thread) times the send. The output is
// chosen by name (settings.midiClockOut): Web MIDI port ids change when a device is re-plugged.
import { ClockMap, MIDI_CLOCK } from './shared/click-math.js';

/** Timestamps kept for the jitter readout (Settings › Diagnostics, tests). */
export const CLOCK_LOG_MAX = 512;

/**
 * Interval statistics of a list of clock timestamps (ms): how far each gap is from the median gap.
 * @param {number[]} ts ascending timestamps of consecutive clock pulses at one tempo
 * @returns {{n:number, meanMs:number, maxDevMs:number, rmsDevMs:number}|null}
 */
export function clockJitter(ts) {
  if (!Array.isArray(ts) || ts.length < 3) return null;
  const gaps = [];
  for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  let max = 0;
  let ss = 0;
  for (const g of gaps) {
    const d = g - med;
    max = Math.max(max, Math.abs(d));
    ss += d * d;
  }
  const meanMs = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  return { n: gaps.length, meanMs, maxDevMs: max, rmsDevMs: Math.sqrt(ss / gaps.length) };
}

/**
 * @param {{getAccess:() => any, getCtx:() => BaseAudioContext|null, perfNow?:() => number, warn?:(m:string) => void}} o
 *   getAccess: the MIDIAccess (midi.js MidiInput.access) or null; getCtx: the engine's AudioContext
 */
export function createMidiClock({ getAccess, getCtx, perfNow, warn = () => {} }) {
  const pnow = perfNow || (() => (globalThis.performance ? performance.now() : Date.now()));
  let name = null;
  let port = null;
  let map = new ClockMap();
  let mapCtx = null;
  const stats = { sent: 0, late: 0, maxLateMs: 0, minLeadMs: Infinity, resets: 0 };
  let log = [];

  function outputs() {
    const a = getAccess();
    if (!a || !a.outputs) return [];
    return [...a.outputs.values()].map((p) => ({ id: p.id, name: p.name || 'MIDI output', state: p.state }));
  }

  function resolve() {
    const a = getAccess();
    port = null;
    if (!name || !a || !a.outputs) return false;
    for (const p of a.outputs.values()) {
      if ((p.name || 'MIDI output') === name && p.state !== 'disconnected') {
        port = p;
        break;
      }
    }
    return !!port;
  }

  /** Feed the audio→performance anchor once per batch. */
  function anchor(ctx) {
    if (ctx !== mapCtx) {
      map = new ClockMap(); // a restarted engine has a new clock
      mapCtx = ctx;
    }
    const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
    if (ts && ts.performanceTime > 0 && ts.contextTime > 0) map.observe(ts.contextTime, ts.performanceTime);
    else {
      // no output timestamp yet (just started / suspended): now, minus the output latency, is what is being heard
      const lat = (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
      map.observe(ctx.currentTime - lat, pnow());
    }
    stats.resets = map.resets;
  }

  /**
   * The engine's clock sink (engine.setClockSink): [{t (audio s), data:[status]}].
   * @param {Array<{t:number, data:number[]}>} msgs
   */
  function sink(msgs) {
    if (!port || !msgs || !msgs.length) return;
    const ctx = getCtx();
    if (!ctx) return;
    anchor(ctx);
    const n = pnow();
    for (const m of msgs) {
      const ts = map.toPerf(m.t);
      const lead = ts - n;
      if (lead < 0) {
        stats.late++;
        stats.maxLateMs = Math.max(stats.maxLateMs, -lead);
      } else stats.minLeadMs = Math.min(stats.minLeadMs, lead);
      try {
        port.send(m.data, Math.max(ts, n));
        stats.sent++;
      } catch (e) {
        warn(`MIDI clock: could not send to ${name} (${(e && e.message) || e})`);
        port = null;
        return;
      }
      if (m.data[0] === MIDI_CLOCK) {
        log.push(ts);
        if (log.length > CLOCK_LOG_MAX) log = log.slice(-CLOCK_LOG_MAX / 2);
      } else log = []; // Start / Stop: a new run
    }
  }

  return {
    sink,
    outputs,
    /** Re-find the named port (MIDI devices changed). @returns {boolean} connected */
    resolve,
    /** Choose the output by name; null = off. @returns {boolean} the port is there now */
    setOutput(n) {
      name = typeof n === 'string' && n ? n : null;
      return resolve();
    },
    get name() {
      return name;
    },
    get connected() {
      return !!port;
    },
    /** @returns {object} send counts, late sends and the jitter of the last run's clock timestamps */
    stats() {
      const minLeadMs = Number.isFinite(stats.minLeadMs) ? stats.minLeadMs : null;
      return { ...stats, minLeadMs, jitter: clockJitter(log) };
    },
    /** @returns {number[]} the last run's clock timestamps (ms, performance.now() clock) */
    timestamps() {
      return [...log];
    },
  };
}
