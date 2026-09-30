// Web MIDI input (SPEC §6, REVIEW 1.16, 2.4, 6.5). Pure parsing + device management; no audio.
// Events (CustomEvent detail):
//   'noteon'  {note, velocity, channel, inputId, timestamp}         (velocity 1..127)
//   'noteoff' {note, velocity, channel, inputId, timestamp}         (note-on with velocity 0 arrives here)
//   'cc'      {cc, value, value01, channel, inputId, timestamp}
//   'bend'    {value /* -1..1 */, raw /* 0..16383 */, channel, inputId, timestamp}
//   'program' {program /* 0..127 */, channel, inputId, timestamp}
//   'disconnected' {inputId, name}   — release that input's notes + pedal (hot-plug)
//   'devices' {inputs:[{id, name, manufacturer, state, kind:'hardware'|'virtual', rank, virtual, selected}], selected,
//              available, mode:'first'|'all'|'device', activeId, activeName, fallback, standIn, hint}
//   'switched' {inputId, name, previousId, previousName, standIn} — a hot-plug moved the listening port (toast)
//   'rebind'  {inputId, previousId, name} — the explicitly chosen device came back under a new id (matched by name)
//   'unavailable' {reason:'unsupported'|'denied'|'failed', message}
//   'activity' {inputId, type}
//   'input'   {inputId, kind:'message'|'hotplug'} — lowres2: emitted BEFORE a message is parsed (any message but the
//             realtime ones: clock / active sensing are not a player's input) and when a port connects, so a listener
//             can wake sleeping audio before the note event
// Channel pressure / poly aftertouch / clock / active sensing are ignored.
// MIDI Learn (M2): learn(id, {accept, motion}) — 'fader' takes only a continuous CC, never CC64/66/67 or notes
// (with motion > 0 the CC must also travel that far first — off by default: one message learns, as the UI expects); 'button' takes a note-on or a switch CC press (value ≥ 64); CC64 (sustain) is never learnable
// and resolves {error:'sustain-pedal-reserved'} (the pedal message still sustains). Channel-mode CCs 120–127 are
// ignored. Messages that don't complete a learn are delivered normally.
// 'first' input selection is sticky (L8): once resolved it stays on that port while it is connected.
// midi-default: 'first' = best-ranked HARDWARE port (classifyInput); with none connected it listens to all ports and
// devices.hint = NO_KEYBOARD_HINT (never a virtual port alone, silently). An explicit choice is matched by id, then by
// name (re-plugged device with a new id → 'rebind'); while it is absent the best hardware port stands in
// ('switched').

/** CCs never accepted by learn(). */
export const LEARN_IGNORED_CCS = Object.freeze([120, 121, 122, 123, 124, 125, 126, 127]);
/** Switch-type pedal CCs (sustain, sostenuto, soft): never a fader. */
export const PEDAL_CCS = Object.freeze([64, 66, 67]);
/** Suggested CC travel for learn(…, {motion}) to filter pot jitter (default motion is 0). */
export const LEARN_MOTION = 8;

// midi-default: virtual/software ports (DAW buses, IAC, network sessions…) are never picked automatically. Web MIDI
// exposes only id, name and manufacturer, so classification is by name + manufacturer heuristics.
const VIRTUAL_RE = new RegExp(
  [
    'virtual', '\\bIAC\\b', 'GarageBand', '\\bLogic\\b', 'MainStage', '\\bNetwork\\b', 'Bluetooth MIDI Connect',
    'loopMIDI', '\\bSession\\s*\\d', '\\bThrough\\b', 'RtMidi', '\\bBus\\s*\\d',
  ].join('|'),
  'i',
);
/** Manufacturer strings of software ports (CoreMIDI reports "Apple Inc." for IAC / network / GarageBand ports). */
const VIRTUAL_MFR_RE = /^Apple\b/i;
const VENDOR_RE = new RegExp(
  [
    'Akai', 'Arturia', 'Nektar', 'Novation', 'Roland', 'Yamaha', 'Korg', 'M-?Audio', 'Native Instruments', 'Alesis',
    'Casio', 'Kawai', 'Nord', 'Studiologic', 'Keystation', 'Launchkey', 'MPK', 'Impact', 'Oxygen', 'Mini\\s?Lab', 'Key\\s?Lab',
    'Komplete Kontrol',
  ].map((v) => `\\b${v}`).join('|'),
  'i',
);
const GENERIC_HW_RE = /USB|Keyboard|Piano/i;
/** Status hint while no hardware keyboard is connected and every port is listened to. */
export const NO_KEYBOARD_HINT = 'No keyboard found — listening to all MIDI ports';

const DATA_LEN = { 0x80: 2, 0x90: 2, 0xa0: 2, 0xb0: 2, 0xc0: 1, 0xd0: 1, 0xe0: 2 };

/**
 * 14-bit pitch-bend value → −1..1 (REVIEW 1.16): (v−8192)/(v<8192 ? 8192 : 8191).
 * @param {number} lsb 0..127
 * @param {number} msb 0..127
 */
export function bendValue(lsb, msb) {
  const v = ((msb & 0x7f) << 7) | (lsb & 0x7f);
  return (v - 8192) / (v < 8192 ? 8192 : 8191);
}

/** @param {string} name */
export function isVirtualPortName(name) {
  return VIRTUAL_RE.test(String(name || ''));
}

/**
 * Classify a MIDI input (midi-default). kind 'virtual' = software/DAW/IAC/network port (rank 0); 'hardware' ranks
 * 1 (unknown device) + 1 (name says USB/Keyboard/Piano) + 2 (known controller vendor/model in name or manufacturer).
 * @param {{name?:string, manufacturer?:string}} input
 * @returns {{kind:'hardware'|'virtual', rank:number}}
 */
export function classifyInput(input) {
  const name = String((input && input.name) || '');
  const mfr = String((input && input.manufacturer) || '');
  if (VIRTUAL_RE.test(name) || VIRTUAL_MFR_RE.test(mfr)) return { kind: 'virtual', rank: 0 };
  const text = `${name} ${mfr}`;
  return { kind: 'hardware', rank: 1 + (GENERIC_HW_RE.test(text) ? 1 : 0) + (VENDOR_RE.test(text) ? 2 : 0) };
}

export class MidiInput extends EventTarget {
  /**
   * @param {object} [opts]
   * @param {Navigator} [opts.nav]
   * @param {() => number} [opts.now]
   * @param {(msg:string)=>void} [opts.warn]
   */
  constructor(opts = {}) {
    super();
    this._nav = opts.nav !== undefined ? opts.nav : globalThis.navigator;
    this._now = opts.now || (() => (globalThis.performance ? performance.now() : Date.now()));
    this._warn = opts.warn || ((m) => console.warn(`[midi] ${m}`));
    this.access = null;
    this.available = false;
    this.unavailableReason = null;
    this._selection = 'first';
    /** @type {Map<string, any>} ports we listen to */
    this._attached = new Map();
    /** @type {Map<string, string>} last known state per port id */
    this._known = new Map();
    /** running status + sysex state per input */
    this._parse = new Map();
    this._learn = null;
    this._firstId = null; // sticky 'first' resolution (L8)
    this._selName = null; // name of the explicitly chosen device (matched when its id changes)
    /** effective resolution of the last _reattach (for 'switched' diffing) */
    this._active = { id: null, name: null, fallback: false, standIn: false };
    this._onState = (e) => this._handleStateChange(e);
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /**
   * Request MIDI access (no sysex). Never throws; emits 'unavailable' on failure.
   * @returns {Promise<boolean>}
   */
  async init() {
    const nav = this._nav;
    if (!nav || typeof nav.requestMIDIAccess !== 'function') {
      this._unavailable('unsupported', 'Web MIDI is not supported in this browser');
      return false;
    }
    try {
      this.access = await nav.requestMIDIAccess({ sysex: false });
    } catch (err) {
      const name = err && err.name;
      const reason = name === 'SecurityError' || name === 'NotAllowedError' ? 'denied' : 'failed';
      this._unavailable(reason, (err && err.message) || String(err));
      return false;
    }
    this.available = true;
    this.unavailableReason = null;
    if (typeof this.access.addEventListener === 'function') this.access.addEventListener('statechange', this._onState);
    else this.access.onstatechange = this._onState;
    for (const p of this._allInputs()) this._known.set(p.id, p.state);
    this._reattach('init');
    return true;
  }

  _unavailable(reason, message) {
    this.available = false;
    this.unavailableReason = reason;
    this._warn(`MIDI unavailable (${reason}): ${message}`);
    this._emit('unavailable', { reason, message });
    this._emitDevices();
  }

  _allInputs() {
    if (!this.access || !this.access.inputs) return [];
    return [...this.access.inputs.values()];
  }

  /** @returns {Array<{id, name, manufacturer, state, kind:'hardware'|'virtual', rank:number, virtual, selected}>} */
  get inputs() {
    return this._allInputs().map((p) => {
      const c = classifyInput(p);
      return {
        id: p.id,
        name: p.name || 'MIDI input',
        manufacturer: p.manufacturer || '',
        state: p.state,
        kind: c.kind,
        rank: c.rank,
        virtual: c.kind === 'virtual',
        selected: this._attached.has(p.id),
      };
    });
  }

  /**
   * Classify an input (see classifyInput): {kind:'hardware'|'virtual', rank}.
   * @param {{name?:string, manufacturer?:string}} input
   */
  classify(input) {
    return classifyInput(input);
  }

  /** Effective resolution: {id, name} of the single port listened to (null in 'all'/fallback), fallback, standIn. */
  get active() {
    return { ...this._active };
  }

  /** Current selection: 'first' | 'all' | <input id>. */
  get selection() {
    return this._selection;
  }

  /**
   * Choose which input(s) to listen to. Notes of inputs that are dropped are released ('disconnected').
   * @param {'first'|'all'|string} sel  'first' = best hardware keyboard (automatic), 'all', or a device id
   * @param {string|null} [name] the device's name for an id (settings.midiInputName): matched when the id changes
   */
  select(sel = 'first', name) {
    const next = typeof sel === 'string' && sel ? sel : 'first';
    const same = next === this._selection;
    if (!same) this._firstId = null;
    this._selection = next;
    if (next === 'first' || next === 'all') this._selName = null;
    else if (typeof name === 'string' && name) this._selName = name;
    else {
      const hit = this._allInputs().find((p) => p.id === next);
      this._selName = hit && hit.name ? hit.name : same ? this._selName : null;
    }
    this._reattach('select');
  }

  /** Best-ranked connected hardware port; the sticky one (L8) wins while connected. Stable on ties. */
  _bestHardware(connected) {
    const isHw = (p) => classifyInput(p).kind === 'hardware';
    const sticky = this._firstId && connected.find((p) => p.id === this._firstId && isHw(p));
    if (sticky) return sticky;
    let pick = null;
    let best = 0;
    for (const p of connected) {
      const c = classifyInput(p);
      if (c.kind === 'hardware' && c.rank > best) {
        pick = p;
        best = c.rank;
      }
    }
    this._firstId = pick ? pick.id : null;
    return pick;
  }

  /** @returns {{ports:any[], active:any, fallback:boolean, standIn:boolean, rebind:any}} */
  _resolve() {
    const connected = this._allInputs().filter((p) => p.state !== 'disconnected');
    const out = { ports: connected, active: null, fallback: false, standIn: false, rebind: null };
    if (this._selection === 'all') return out;
    if (this._selection !== 'first') {
      const sel = this._selection;
      const name = this._selName;
      const named = name ? connected.filter((p) => p.name === name) : [];
      const chosen =
        connected.find((p) => p.id === sel) || named.find((p) => classifyInput(p).kind === 'hardware') || named[0] || null;
      if (chosen) {
        if (chosen.id !== sel) out.rebind = chosen;
        return { ...out, ports: [chosen], active: chosen };
      }
      out.standIn = true; // the chosen device is absent: the best hardware keyboard plays meanwhile
    }
    const pick = this._bestHardware(connected);
    if (pick) return { ...out, ports: [pick], active: pick };
    return { ...out, fallback: true, standIn: false }; // no keyboard: listen to every port (with a status hint)
  }

  /** @param {'init'|'select'|'hotplug'} [cause] */
  _reattach(cause = 'select') {
    const r = this._resolve();
    const want = r.ports;
    const prev = this._active;
    this._active = {
      id: r.active ? r.active.id : null,
      name: r.active ? r.active.name || '' : null,
      fallback: r.fallback,
      standIn: r.standIn,
    };
    if (r.rebind) {
      const previousId = this._selection;
      this._selection = r.rebind.id; // keep matching by id from now on; the controller persists it
      this._emit('rebind', { inputId: r.rebind.id, previousId, name: r.rebind.name || '' });
    }
    const wantIds = new Set(want.map((p) => p.id));
    for (const [id, port] of this._attached) {
      if (!wantIds.has(id)) {
        this._detach(port);
        this._emit('disconnected', { inputId: id, name: port.name || '' });
      }
    }
    for (const p of want) this._attach(p); // always re-assign: object identity is not reliable (REVIEW 2.4)
    this._emitDevices();
    // midi-default (4): a hot-plug that moves us onto another port is announced; select()/init() are not
    if (cause === 'hotplug' && this._active.id && this._active.id !== prev.id) {
      this._emit('switched', {
        inputId: this._active.id,
        name: this._active.name,
        previousId: prev.id,
        previousName: prev.name,
        standIn: this._active.standIn,
      });
    }
  }

  _attach(port) {
    const handler = (e) => this._onMessage(e, port.id);
    port.onmidimessage = handler;
    this._attached.set(port.id, port);
  }

  _detach(port) {
    try {
      port.onmidimessage = null;
    } catch {
      /* ignore */
    }
    this._attached.delete(port.id);
    this._parse.delete(port.id);
  }

  _handleStateChange(e) {
    const port = e && e.port;
    if (!port || port.type !== 'input') {
      this._emitDevices();
      return;
    }
    const prev = this._known.get(port.id);
    this._known.set(port.id, port.state);
    if (prev === port.state) return; // connection open/close churn only
    if (port.state === 'connected') this._emit('input', { inputId: port.id, kind: 'hotplug' }); // lowres2
    if (port.state === 'disconnected') {
      const was = this._attached.get(port.id);
      if (was) {
        this._detach(was);
        this._emit('disconnected', { inputId: port.id, name: port.name || '' });
      }
    }
    this._reattach('hotplug');
  }

  _emitDevices() {
    const inputs = this.inputs;
    const a = this._active;
    const listening = inputs.filter((i) => i.selected);
    this._emit('devices', {
      inputs,
      selected: listening.map((i) => i.id),
      available: this.available,
      mode: this._selection === 'first' || this._selection === 'all' ? this._selection : 'device',
      activeId: a.id,
      activeName: a.name,
      fallback: a.fallback,
      standIn: a.standIn,
      hint: a.fallback && listening.length > 0 ? NO_KEYBOARD_HINT : null,
    });
  }

  _onMessage(e, inputId) {
    const ts = typeof e.timeStamp === 'number' && e.timeStamp > 0 ? e.timeStamp : this._now();
    this._parseBytes(e.data, ts, inputId);
  }

  /** lowres2: 'input' before the message is handled (not for realtime-only messages: clock, active sensing). */
  _noteInput(bytes, inputId) {
    if (!bytes) return;
    for (let i = 0; i < bytes.length; i++) {
      if ((bytes[i] & 0xff) < 0xf8) {
        this._emit('input', { inputId, kind: 'message' });
        return;
      }
    }
  }

  /**
   * Test hook: feed raw bytes as if they arrived from an input.
   * @param {ArrayLike<number>} bytes
   * @param {number} [timestamp]
   * @param {string} [inputId='test']
   */
  _inject(bytes, timestamp, inputId = 'test') {
    this._parseBytes(bytes, timestamp ?? this._now(), inputId);
  }

  _parseBytes(bytes, ts, inputId) {
    if (!bytes) return;
    this._noteInput(bytes, inputId);
    let st = this._parse.get(inputId);
    if (!st) {
      st = { running: 0, data: [], sysex: false };
      this._parse.set(inputId, st);
    }
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i] & 0xff;
      if (b >= 0xf8) continue; // realtime: clock, active sensing… (doesn't affect running status)
      if (st.sysex) {
        if (b === 0xf7) {
          st.sysex = false;
          continue;
        }
        if (b < 0x80) continue;
        st.sysex = false; // a new status byte aborts the sysex; handle it below
      }
      if (b >= 0x80) {
        if (b === 0xf0) {
          st.sysex = true;
          st.running = 0;
          continue;
        }
        if (b >= 0xf0) {
          st.running = 0; // system common cancels running status
          st.data.length = 0;
          continue;
        }
        st.running = b;
        st.data.length = 0;
        continue;
      }
      if (!st.running) continue; // stray data byte
      st.data.push(b);
      const need = DATA_LEN[st.running & 0xf0];
      if (st.data.length >= need) {
        this._dispatch(st.running, st.data[0], st.data[1], ts, inputId);
        st.data.length = 0;
      }
    }
  }

  _dispatch(status, d1, d2, timestamp, inputId) {
    const type = status & 0xf0;
    const channel = status & 0x0f;
    if (type === 0xa0 || type === 0xd0) return; // aftertouch ignored
    if (this._learn && this._learnCheck(type, channel, d1, d2, inputId)) return; // the learning gesture is swallowed
    let ev;
    switch (type) {
      case 0x90:
        if (d2 > 0) ev = ['noteon', { note: d1, velocity: d2, channel, inputId, timestamp }];
        else ev = ['noteoff', { note: d1, velocity: 0, channel, inputId, timestamp }];
        break;
      case 0x80:
        ev = ['noteoff', { note: d1, velocity: d2, channel, inputId, timestamp }];
        break;
      case 0xb0:
        ev = ['cc', { cc: d1, value: d2, value01: d2 / 127, channel, inputId, timestamp }];
        break;
      case 0xe0:
        ev = ['bend', { value: bendValue(d1, d2), raw: (d2 << 7) | d1, channel, inputId, timestamp }];
        break;
      case 0xc0:
        ev = ['program', { program: d1, channel, inputId, timestamp }];
        break;
      default:
        return;
    }
    this._emit(ev[0], ev[1]);
    this._emit('activity', { inputId, type: ev[0] });
  }

  _finishLearn(result) {
    const l = this._learn;
    this._learn = null;
    clearTimeout(l.timer);
    l.resolve({ ...result, controlId: l.controlId });
  }

  /** @returns {boolean} true = message consumed by learn (swallowed) */
  _learnCheck(type, channel, d1, d2, inputId) {
    const l = this._learn;
    if (type === 0x90 && d2 > 0) {
      if (l.accept === 'fader') return false; // a fader can't be a key: play it normally
      this._finishLearn({ note: d1, channel, inputId });
      return true;
    }
    if (type !== 0xb0) return false;
    if (d1 === 64) {
      this._finishLearn({ error: 'sustain-pedal-reserved', cc: 64, channel, inputId });
      return false; // the pedal keeps sustaining
    }
    if (LEARN_IGNORED_CCS.includes(d1)) return false;
    if (l.accept === 'button') {
      if (d2 < 64) return false; // switch release / low knob value: wait for a press
      this._finishLearn({ cc: d1, channel, inputId });
      return true;
    }
    if (l.accept === 'fader' && PEDAL_CCS.includes(d1)) return false;
    if (l.accept === 'any') {
      this._finishLearn({ cc: d1, channel, inputId });
      return true;
    }
    // fader: optionally require real motion on one control
    if (l.motion > 0) {
      const k = `${inputId}|${channel}|${d1}`;
      if (!l.seen.has(k)) {
        l.seen.set(k, d2);
        return false;
      }
      if (Math.abs(d2 - l.seen.get(k)) < l.motion) return false;
    }
    this._finishLearn({ cc: d1, channel, inputId });
    return true;
  }

  /**
   * MIDI Learn: resolves with the next matching control ({cc|note, channel, inputId, controlId}),
   * {error:'sustain-pedal-reserved', …} when CC64 arrives, or null after the timeout / cancelLearn().
   * The gesture that completes learning is not forwarded as a normal event.
   * @param {string} controlId
   * @param {{timeoutMs?:number, accept?:'fader'|'button'|'any', motion?:number}} [o]  fader: continuous CC only
   *        (motion > 0: it must travel that far within the learn first);
   *        button: note-on or CC press ≥ 64; any: first note-on or CC (CC64/120–127 still excluded)
   * @returns {Promise<{cc?:number, note?:number, channel:number, inputId:string, controlId:string, error?:string}|null>}
   */
  learn(controlId, { timeoutMs = 10000, accept = 'any', motion = 0 } = {}) {
    this.cancelLearn();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this._learn && this._learn.timer === timer) {
          this._learn = null;
          resolve(null);
        }
      }, timeoutMs);
      this._learn = { controlId, resolve, timer, accept: ['fader', 'button', 'any'].includes(accept) ? accept : 'any', motion: Number(motion) > 0 ? Number(motion) : 0, seen: new Map() };
    });
  }

  /** Abort a pending learn (resolves it with null). */
  cancelLearn() {
    if (!this._learn) return;
    const l = this._learn;
    this._learn = null;
    clearTimeout(l.timer);
    l.resolve(null);
  }

  get learning() {
    return this._learn ? this._learn.controlId : null;
  }

  dispose() {
    this.cancelLearn();
    for (const p of [...this._attached.values()]) this._detach(p);
    if (this.access) {
      if (typeof this.access.removeEventListener === 'function') this.access.removeEventListener('statechange', this._onState);
      else this.access.onstatechange = null;
    }
  }
}

/** Convenience factory. */
export function createMidi(opts) {
  return new MidiInput(opts);
}
