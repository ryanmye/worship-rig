// Browser side of the offline tools: builds a seeded AudioEngine on an OfflineAudioContext, applies a job
// (patch, routing wheels, drone, transpose, timed note/pedal events), renders, and returns base64 Float32 channels.
//
// Gain trims for synth/organ instruments and the drone (app/js/engine/gain-trims.json) are applied here by a shim
// until the engine registry loads that file itself (see CONTRACT_CHANGES.md "## audition"). As soon as the
// registry exposes `registry.gainTrims` (an object), the shim steps aside and the engine's own wiring is used.
import { AudioEngine } from '/js/engine/index.js';

function b64(f32) {
  const u8 = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}

const dbToLin = (d) => Math.pow(10, (Number(d) || 0) / 20);

/** Insert a trim GainNode after instrument.output for synth/organ refs (same place the registry wiring will go). */
function installTrimShim(engine, trims) {
  const reg = engine.registry;
  if (reg.gainTrims && typeof reg.gainTrims === 'object') return 'native';
  if (!trims) return 'none';
  const orig = reg.create.bind(reg);
  reg.create = (ctx, prng, ref, params, opts) => {
    const inst = orig(ctx, prng, ref, params, opts);
    const dB = ref && (ref.type === 'synth' || ref.type === 'organ') ? trims[ref.type]?.[ref.id] : undefined;
    if (inst && inst.output && Number.isFinite(dB) && dB !== 0) {
      const g = new GainNode(ctx, { gain: dbToLin(dB) });
      inst.output.connect(g);
      inst._untrimmedOutput = inst.output;
      inst.output = g; // callers connect `inst.output` after create(); dispose() disconnects this node
    }
    return inst;
  };
  if (Number.isFinite(trims.droneTrim) && trims.droneTrim !== 0) {
    // drone.synthBus is a static unity GainNode (no automation) that only the synth drone layers feed
    // (files-mode pads have their own level and are not trimmed)
    engine.drone.synthBus.gain.value = dbToLin(trims.droneTrim);
  }
  return 'shim';
}

// Factory manifest only: no "My Samples" (user folders are not calibrated/auditioned, and this server has no /api/).
const MANIFESTS = ['./samples/manifest.json'];

export async function listInstruments() {
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: 128, sampleRate: 48000 });
  const e = new AudioEngine({ context: ctx, seed: 1, manifestUrls: MANIFESTS });
  await e.start();
  const list = e.listInstruments().map((x) => ({
    ref: x.ref,
    name: x.name,
    group: x.group,
    params: x.params,
    calibWindow: x.calibWindow || null,
    widthDefault: x.widthDefault ?? 1,
    // which module builds it: synth-extra.js folds its calibration into the instrument (gain-trims entry stays 0)
    module: x.ref.type === 'synth' ? e.registry.synth?.defs.get(x.ref.id)?._module || null : null,
  }));
  const native = !!(e.registry.gainTrims && typeof e.registry.gainTrims === 'object');
  e.dispose();
  return { list, nativeTrims: native };
}

/**
 * @param {object} job {sr, seconds, seed, patch, transpose, keyContext, tempo, drone:{...song.drone, key}, wheel:{mod,expr},
 *                      mono, events:[{t, on, vel}|{t, off}|{t, sustain}], trims}
 */
export async function renderJob(job) {
  const t0 = performance.now();
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(job.seconds * job.sr), sampleRate: job.sr });
  const engine = new AudioEngine({ context: ctx, seed: job.seed ?? 1, manifestUrls: MANIFESTS });
  const warnings = [];
  engine.addEventListener('warn', (ev) => warnings.push(ev.detail?.message));
  await engine.start();
  const trimMode = installTrimShim(engine, job.trims);

  const tok = await engine.prepare(job.patch);
  if (!engine.commit(tok, { when: 0 })) throw new Error('commit refused');
  engine.setTranspose(job.transpose || 0);
  if (job.keyContext) engine.setKeyContext(job.keyContext.pc, job.keyContext.minor);
  if (job.drone && job.drone.mode && job.drone.mode !== 'off') {
    const { key, ...cfg } = job.drone;
    engine.drone.setKey(key?.pc ?? 0, { minor: !!key?.minor, when: 0 });
    engine.drone.configure(cfg, { when: 0 });
  }
  if (job.tempo) engine.setTempo(job.tempo);
  if (job.mono) engine.setMono(true);
  if (job.wheel) {
    if (Number.isFinite(job.wheel.mod)) engine.setWheel('mod', job.wheel.mod, { when: 0 });
    if (Number.isFinite(job.wheel.expr)) engine.setWheel('expr', job.wheel.expr, { when: 0 });
  }
  // events must be issued in time order: the engine's note/pedal bookkeeping is JS-side, audio is scheduled at `when`
  const evs = [...(job.events || [])].sort((a, b) => a.t - b.t);
  for (const ev of evs) {
    if ('on' in ev) engine.noteOn(ev.on, ev.vel ?? 96, { when: ev.t });
    else if ('off' in ev) engine.noteOff(ev.off, { when: ev.t });
    else if ('sustain' in ev) engine.sustain(!!ev.sustain, { when: ev.t });
  }
  const buf = await ctx.startRendering();
  const stats = engine._debugStats();
  const slotsInfo = engine.slots.map((sc) => (sc ? { ref: sc.ref, fallback: !!sc.inst.isFallback } : null));
  engine.dispose();
  return {
    sr: buf.sampleRate,
    L: b64(buf.getChannelData(0)),
    R: b64(buf.getChannelData(1)),
    warnings,
    stats,
    slots: slotsInfo,
    trimMode,
    ms: Math.round(performance.now() - t0),
  };
}
