# Native engine architecture (Worship Rig 2.0, route B)

Scope: the C++20 engine core that replaces `app/js/engine/**` behind the existing web UI, the C API that every shell
uses, the platform layers, and how parity with the web engine (the reference oracle) is proven. The behaviour to
reproduce is `native/docs/ENGINE_CONTRACT.md` (cited as "contract §n"); the bridge is BRIDGE v1 (contract §6); the
golden fixtures are `native/golden/manifest.json` (87 fixtures, 46 `exact`, 41 `statistical`, 36 of those flagged
`exactIfPrngPorted`). The task split is `native/docs/BUILD_PLAN.md`; the C API is
`native/core/include/rig/rig_engine.h`.

Marked **(verify)**: statements about Chromium/Apple internals I have not checked against their source in this repo.

---------------------------------------------------------------------------------------------------------------------

## 1. Shape of the system

```
 WKWebView (app/ unchanged + app/js/engine/native/ shim)          Swift shell (native/apple, UNBUILT here)
 controller.js ──► NativeEngine facade ──postMessage(JSON)──►  RigBridge.swift ──rig_post()──────────┐
               ◄── window.__rigNative.receive(batch) ◄──evaluateJavaScript◄── on_event (control thr) │
                                                                                                    ▼
 CoreMIDI thread ─ rig_midi_in() ─► [MPSC] ─────────────────────────────────►┌──────────────────────────────┐
                                                                             │ control thread: Model         │
 workers (decode ×1-2, IR ×1) ◄── jobs ── Model ── results ──►               │ (port of audio.js/fx.js/drone │
                                                                             │  logic, timers, coalescer)    │
 AUHAL / RemoteIO IO thread ─ rig_render() ─► Render graph ◄─[SPSC cmds]─────┤                               │
                                            ─[SPSC events, seqlock meters]──►└──────────────────────────────┘
```

Two halves, mirroring how Web Audio splits the JS engine today:

- **Model** (control thread, non-real-time): owns every piece of engine *state and policy*: the patch, prepare/commit
  plans and tokens, retiring channels, voice allocation, notes/pedal/mono/legato, wheels/macros/bend, coalescer,
  reverb pool policy, drone state machine, click grid, sleep, stats. It is a near line-by-line port of `audio.js`,
  the logic half of `fx.js`, `drone.js`, `metronome.js` and `instruments.js`. Its output is a stream of timestamped
  **render commands** (param automation events, voice start/stop, enable/route switches, object attach/detach).
- **Render graph** (audio thread, real-time): fixed C++ DSP objects with Web-Audio-compatible semantics (AudioParam
  timelines, biquads, delays, panners, wave shapers, compressor, convolver, oscillators, buffer sources). It executes
  commands, renders 128-frame quanta and reports back voice-ended, timer-due and meter data.

Why this split (and not a redesign): the JS engine expresses its sound as *automation scheduled ahead on an audio
clock*. Porting the logic onto a substrate with the same semantics (timeline params, 128-frame quanta, timers on
quantum boundaries) is the shortest path to golden parity and keeps the 12k lines of tuned behaviour reviewable
against their JS source. The substrate is not a general node graph: every composite (voice, strip, reverb unit) is a
C++ class with fixed members and a hand-written `process()`; "connect/disconnect" become enable flags and pointer
swaps. Summation order is fixed, so Q1 (hash-order summing) disappears: native renders are bit-repeatable.

---------------------------------------------------------------------------------------------------------------------

## 2. Module map

Source tree `native/core/` (C++20, CMake + Ninja, `-Wall -Wextra -Werror`, no exceptions on the audio path, no RTTI
requirement). Namespaces in brackets. "RT" = runs on the audio thread. "Fixtures" = golden ids that define done
(compared by `node tools/golden/compare.mjs <dir>` on WAVs written by `rig-golden`, see §8), plus unit tests (doctest).

| # | module (dir) | responsibilities | RT? | fixtures / tests |
|---|---|---|---|---|
| M1 | **api** `src/api/` `[rig]` | C API (`rig_engine.cpp`), `Engine` facade owning Model + Graph + runtime; config/profile resolution | entry only | API smoke, ABI struct_size tests |
| M2 | **bridge** `src/bridge/` | BRIDGE v1: parse (yyjson), envelope/`id`/reply, schema checks, 14 ops → Model calls, 9 events + batching, error codes, `hello` caps | no | conformance tests generated from `engine-api.json` `messages` |
| M3 | **runtime** `src/runtime/` | control thread loop, worker pool, SPSC/MPSC queues, seqlock, epoch garbage, host vtable plumbing, host↔engine clock map, realtime FIFO adapter (host block ≠ 128), offline driver | adapter RT | TSAN soak (Linux), offline determinism test (two renders bit-equal) |
| M4 | **time** `src/time/` `[rig::wa]` | `Param` = port of Chromium `AudioParamTimeline` (set, linear, exponential, setTarget, valueCurve, cancelAndHold; a-rate/k-rate), automation helpers (`rampTo` incl. 12τ snap Q2, `glideTo`, `linearTo`, `setNow`, `linFrom`/`glideFrom`, 16-segment `equalPowerFade` Q4, `trackedMove`/`moveAt`), `Timer` (quantised `k = ceil(t·sr/128 − 1e-6)`), `Coalescer(0.01)` | Param RT | vectors dumped from the JS helpers on an OfflineAudioContext (new `tools/golden/vectors/`), all `auto-*` fixtures indirectly |
| M5 | **num** `src/num/` | `hashSeed` (FNV-1a over UTF-16 units), `mulberry32`, `rngFor`, JS `String(number)` formatting for seed strings, V8 `ieee754` math (exp/log/sin/cos/pow) for bit-exact generators, constants | yes (PRNG) | exact vectors vs `shared/prng.js`; seed strings vs JS |
| M6 | **dsp** `src/dsp/` `[rig::wa]` | Biquad (Web Audio formulas, LP/HP Q in dB, shelves S=1, Nyquist bypass Q5, k-rate Q6), Gain, StereoPanner (both laws, contract §3.1), DelayLine (linear interp), WaveShaper + Chromium Up/DownSampler (2x/4x), DynamicsCompressor (Chromium kernel port, Q8), Oscillator + PeriodicWave (Chromium band-limited tables, Q12), BufferSource (linear-interp repitch, sub-sample start, loop), SincResampler (Chromium port), Convolver (§4), Analyser-equivalents (peak/RMS/RTA) | yes | per node: eq-*, width-*, master-eq, glue-*, limiter-*; unit tests vs Chromium-rendered single-node vectors |
| M7 | **params** `src/params/` | generated PARAMS table (`params_gen.inc` from `engine-api.json`: 102 rows, path grammar, clamp, enums, coalesce keys, smoothing rule ids), `normalizePatch`, path parser, dynamic `slots.<i>.params.<key>` | no | exact clamp/normalise vectors vs `params.js`; `--check`-style drift test |
| M8 | **mix** `src/mix/` | SlotChannel (inst output gate → fader → wheel → width M/S → SlotEq → pan → sends), SlotEq (resolve legacy/b-rows, chain crossfade 50 ms warm + 30 ms, type-change fade), sum bus, master chain (lofi slot, master EQ, glue dry/wet, master, masterWheel, fadeGain, mono xfade, preComp, catcher, clipPre, clip curve, out), click bus, taps for tests | yes | eq-* (18), width-* (3), master-eq, glue-* (3), limiter-* (3) |
| M9 | **fx** `src/fx/` | Reverb (bucket/dampQ, IR generator bit-exact, unit pool LRU ≤ N, retain set, 0.8 s unit xfade, predelay 2-line 0.5 s xfade, input HPF180/LPF9k), Delay (2 lines, sync, glide ≤ 5 %, line switch/flush, ping-pong, tone, panic; **no Q split**, Q9), Chorus (mono in, 2 voices, rng phase), Lofi (tanh 4x, quantiser, tape wow/flutter, crackle loop, engage latency = real oversampler latency, Q10) | yes | reverb-* (6), echo-* (6), chorus-* (2), lofi-* (2); IR bit-exact test vs JS `irGen` dump |
| M10 | **samples** `src/samples/` | decode (dr_mp3, dr_wav, host `decode_file` for AAC/ALAC), resample to engine rate (SincResampler, as `decodeAudioData`), `processSample` (onset −50 dBFS − 1 ms, maxSec cap + 1 s fade, 2 ms fade-in, dual-mono collapse, M/S fix), `BufferCache` (cap, low-water 85 %, LRU, pins add/replace/auto, protect during switch, refs never evicted, deferred), estimate (1.75 MB/sample), registry/manifest loading (factory + My Samples, `gain-trims.json`) | no (workers + control) | decode vs Chromium PCM dumps; cache policy unit tests ported from the JS engine tests; `estimate` vs JS |
| M11 | **inst** `src/inst/` | registry + catalogue (`get instruments` = `engine-api.json` list), allocator (16 voices, sampler 32, steal policy), `voice.js` port (envelopes, osc banks, filters, mono-below, tracked params), synth.js 7 patches incl. hidden drone-osc, synth-extra 10 patches (Q11: keep audible result), organ 4 presets + rotary (Leslie), sampler (layers, velocity, release, repitch, `widthDefault`, forced stereo out) | voices RT, logic control | synth-* (16), organ-* (4), sampler-* (2), touch-* (5) |
| M12 | **model** `src/model/` | `audio.js` port: prepare/commit/tokens/instSeq, retire (voice count 0 for 1 s, polled 0.25 s), setParam dispatch (§2.3 table), routing/wheels/macros/bend/tape, notes/pedal/mono/legato/sustain/pedalHold, swell, panic, fadeOutAll, transpose/tempo/timeSig/keyContext, chord naming (`chords.js`), sleep/wake queueing, low-resource, stats, `getState` | no | auto-* (6), scene-glide, touch-*, song-* (3) |
| M13 | **drone** `src/drone/` | synth layers (drone-osc), static/follow voicing, chord-follow debounce, files mode (native streaming of pad files, loop region + equal-power loop xfade, random start from rng), swells/duck/park, width matrix, send gate, optional freeze (§9 Q7) | voices RT | drone-* (4) |
| M14 | **click** `src/click/` | click synthesis, `ClickGrid` port (`click-math.js`), 50 ms pump / 0.3 s lookahead, aux routing (out 3-4), record flag, MIDI clock 24 ppq + Start/Stop scheduled with host timestamps | buffers RT | click-120-44, click-90-68-countin; MIDI clock pulse-time vectors |
| M15 | **midi** `src/midi/` | byte parser (port of `midi.js` `_parseBytes`/`_dispatch`: running status, vel-0, 14-bit bend, CC01, program, ignore clock/AS), port table, hot-plug release, direct route (refcount per source, CC64 + pedalInvert, CC1/11/7, bend, CC120/123, touch curves, learned-control diversion, `jitterFree`) | no | parser vectors vs `midi.js`; route unit tests |
| M16 | **meter** `src/meter/` | per-quantum out peaks (peak-since-last-read, Q14), slot peak/RMS over 256 frames (taps only when subscribed), RTA (Blackman 2048, smoothing .8 at the stream rate, 0.5 dB Uint8 → base64), tick builder (30 Hz default, 4 Hz idle, stats every 1 s) | taps RT | unit tests (peak never missed; RTA of a sine) |
| M17 | **rec** `src/rec/` | `rec` op: SPSC float ring from `out` (+ click when `record`), writer thread, WAV 16-bit (same conversion as `worklets/recorder-processor.js`), header refresh every 1 s, file naming `Rig YYYY-MM-DD HHmm.wav` | tap RT | WAV round-trip test; overflow accounting |

Public interface sketches (internal C++; the frozen surface is only the C API):

```cpp
namespace rig::wa {
struct Param {                       // Chromium AudioParamTimeline semantics, fixed-capacity event list (64)
  void setValueAtTime(float v, double t); void linearRampToValueAtTime(float v, double t);
  void exponentialRampToValueAtTime(float v, double t); void setTargetAtTime(float v, double t, double tau);
  void cancelAndHoldAtTime(double t); void setValueCurveAtTime(const float*, uint32_t n, double t, double dur);
  const float* processARate(const Quantum&);  float processKRate(const Quantum&);   // RT
};
}
namespace rig {
class Model {                        // control thread only
 public:
  Token prepare(const Patch&, PrepareCb); bool commit(Token, When);
  bool setParam(std::string_view path, const Value&, When, double glide);
  bool noteOn(int n, int vel, When, const TouchCurve*); bool noteOff(int n, When); bool sustain(bool, When);
  /* … one method per contract §1 member; signatures mirror the JS ones … */
  void onAudioEvent(const AudioEvent&);   // voice ended, timer due, meter snapshot
  void runTimers(double now);              // AudioTimer semantics
};
class Graph {                        // audio thread only
 public:
  void apply(const Command&);  void renderQuantum(float* const* out, uint32_t ch);   // 128 frames
};
}
```

### 2.1 Real-time constraints per module

- **Audio thread** runs M3's adapter, M6 primitives inside M8/M9/M11/M13/M14 objects, M4 `Param` evaluation, M16
  taps and M17's ring write. Everything it touches is preallocated by the control side; capacities are fixed per
  object (param events 64, voices 128 per instrument with a 32/64/128 cap (T00c, D1), pending command heap 8192,
  16 slot channels + 32 retiring channels (T00c, D3)).
- **Overflows never allocate**: a full param timeline drops the oldest *past* events first (they are folded into the
  current value), then rejects with a counted `warn`; a full voice pool steals (same policy as `instruments.js`).
- **Budgets (realtime, 48 kHz, M1 performance core):** whole graph ≤ 25 % of one core with 4 busy slots, drone,
  2 reverb units in crossfade and lofi on; one reverb unit ≤ 2 %; no quantum above 50 % of its 2.67 ms period.
  iPad (A12–A14 class) ≤ 2× those numbers. Measured by `rig-bench` (Linux numbers are indicative only).

---------------------------------------------------------------------------------------------------------------------

## 3. Threading and real-time safety

### 3.1 Threads

| thread | count | owns | priority |
|---|---|---|---|
| audio IO (platform's) | 1 | Graph, adapter FIFO, recorder ring producer, meter seqlock writer | real-time (OS) |
| control | 1 | Model, bridge, timers, event batching, garbage freeing, MIDI parsing | user-interactive QoS |
| decode workers | 1–2 (iPad 1) | file read + decode + resample + processSample | utility QoS |
| IR worker | 1 | reverb IR generation + kernel FFT partitioning, drone-freeze render | utility QoS |
| rec writer | 0–1 (while recording) | WAV file I/O | utility QoS |
| CoreMIDI receive (platform's) | 1 | calls `rig_midi_in` only | high |

### 3.2 Audio-thread rules (enforced, not just documented)

- No `new`/`delete`/`malloc`, no locks (no `std::mutex`, no `shared_ptr` copies: atomic refcount decrements could
  free), no file or network I/O, no logging (log entries go into an SPSC ring), no Objective-C/Swift messaging.
- One allowed syscall: a non-blocking wake of the control thread (`semaphore_signal` / futex wake), at most once per
  quantum and only when a timer, voice-ended or recorder threshold is pending.
- Debug builds install an allocation trap: a thread-local "in render" flag checked by a replaced global
  `operator new`/`malloc` hook that aborts (Linux tests run all goldens with it on; the Apple build uses the same hook).
- FTZ/DAZ set on entry of every `rig_render`/`rig_offline_render` (MXCSR on x86-64, FPCR.FZ on arm64) and restored
  on exit; Chromium flushes denormals on its audio thread too (verify), so parity is unaffected.

### 3.3 Queues

- **Control → audio: SPSC command ring** (capacity 16384 POD commands of 64 bytes, lock-free, cache-line padded).
  Each command carries `int64 frame` (engine frame; `NOW` sentinel = first frame of the next quantum dequeued). The
  audio thread drains the ring at the start of each quantum into a preallocated min-heap keyed by (frame, seq) and
  applies everything due *within* the quantum; DSP objects take the sub-quantum offset themselves (buffer-source
  start frames, param event times), which is how Web Audio behaves, so the graph is never split mid-quantum. Param
  events are inserted into their `Param` timeline immediately (the timeline handles future times).
- **Audio → control: SPSC event ring** (4096 entries): voice ended (instrument handle, voice id, frame), timer due
  (earliest due timer passed), garbage (object pointer released by the graph), xrun, log lines.
- **Meters**: seqlock struct written once per quantum (`rig_get_meters` and the tick builder read it).
- **MIDI in → control: MPSC ring** (4096 entries of ≤ 32 bytes + port index + host time); `rig_midi_in` is lock-free.
- **JS → control**: `rig_post` copies the JSON into a mutex-protected deque (non-RT callers only) and signals.

### 3.4 Object lifetime ("attach, detach, return")

All DSP objects and sample buffers are allocated on the control thread or a worker. The control thread hands a
pointer to the graph with an `Attach` command; the graph links it into intrusive lists (no allocation). Removal is
`Detach`; the graph unlinks it and pushes the pointer onto the audio→control ring; the control thread frees it (or
returns it to a pool). Immutable shared data (decoded `SampleBuffer`s, reverb kernels, wavetables) is reference
counted **on the control side only**; the graph holds raw pointers. A buffer is freed when its control refcount is
0 *and* the graph has acknowledged an epoch (incremented per quantum) later than the detach of its last user
(epoch-based reclamation). This removes every free from the audio thread and every lock from the swap path.

Worker results (decoded buffers, built reverb units, frozen drone loops) arrive in the control mailbox; the Model
decides (as the JS engine does when its promise resolves) and swaps them in with an `Attach` + crossfade commands.
Prepare tokens, superseded plans and the `instSeq` lifetime counter (contract §7.15) live in the Model, so seeds
match the JS engine's prepare history.

### 3.5 Timers and "now"

The Model's `now` = last rendered engine time (atomic) + one quantum, exactly the staleness Web Audio's main thread
sees. A Model timer at engine time t is due in quantum `k = ceil(t·sr/128 − 1e-6)`; realtime: the graph raises
"timer due" when it passes that quantum (callback runs late by the control-thread wake, ≈ Q17); offline: the driver
stops at that quantum boundary, runs the callbacks, then renders (identical to `OfflineAudioContext.suspend`).

### 3.6 Offline render mode (parity tests)

`RIG_MODE_OFFLINE` builds the same Model and Graph with **no threads**: `rig_post` runs the bridge and Model inline;
decode and IR jobs run inline when submitted; worker callbacks are delivered before `rig_post` returns. The driver
loop per quantum: (1) deliver audio→control events, (2) run due timers, (3) drain commands, (4) render, (5) emit
events. This is the `OfflineAudioContext` model, so goldens that issue every event up front with `{when}` produce the
same Model decisions as the JS engine (same call order, same "now" = 0). The realtime path differs only in *when*
commands arrive, never in what the graph computes for a given command timing.

---------------------------------------------------------------------------------------------------------------------

## 4. Reverb convolution: algorithm choice

IR lengths (contract §3.4): `len = ceil(1.1 · max(rt) · sr)`; the longest bucket (8 s, 125 Hz band unaffected by
damp) gives `1.1 · 9.6 s` = 10.56 s = **506 880 frames per channel at 48 kHz**, stereo (L→L, R→R), no normalisation.

- **Uniform partitioned (UPOLS), B = 128**: 3960 partitions; per channel 3960 × 129 complex MACs per quantum ≈
  190 M CMAC/s ≈ 1.5 GFLOP/s per channel. Rejected (≈ 20–30 % of a core per unit, and two units crossfade).
- **Chosen: non-uniform partitioned, zero latency, time-distributed on the audio thread**:

| stage | partition B | covers taps | partitions (8 s bucket, 48 kHz) | work per quantum (per channel) |
|---|---|---|---|---|
| 0 direct FIR | — | [0, 128) | — | 128 MAC/frame (NEON/SSE) |
| 1 | 128 (FFT 256) | [128, 2048) | 15 | 1 fwd + 1 inv FFT256, 15×129 CMAC |
| 2 | 1024 (FFT 2048) | [2048, 16384) | 14 | spread over 8 quanta |
| 3 | 8192 (FFT 16384) | [16384, len) | ≤ 60 | spread over 64 quanta |

  Stage s with partition B_s starts at offset 2·B_s, which lets its FFTs and MACs be spread evenly over the B_s/128
  quanta after its input block fills (Garcia/Wefers style time distribution); stage phases are staggered so the large
  FFTs never land in the same quantum. Total ≈ 4.3 M CMAC/s + 6 M MAC/s + FFTs ≈ 55 MFLOP/s per channel ⇒
  **≈ 110 MFLOP/s per stereo unit (target ≤ 2 % of an M1 core, ≤ 5 % on the oldest supported iPad)**. Latency 0
  (the direct stage), matching `ConvolverNode`.
- **Why on the audio thread and not a background thread** (Chromium runs its large stages on a background thread,
  verify): determinism. The same code path runs offline and realtime, so a realtime capture equals the offline
  render; there is no deadline-miss failure mode; the per-quantum work is bounded and even.
- **Kernel build** (IR generation + partition FFTs, ~12 MB peak for the 8 s bucket) runs on the IR worker; the unit
  is swapped in by the Model with the contract's 0.8 s equal-power crossfade. The "2 s quiet" gating (Q7) becomes
  unnecessary for glitch-freedom; the Model keeps the *decision* rules (which IR plays when) for parity and keeps the
  warm-up quiet rule only as a battery/CPU policy (profile-dependent).
- **Memory per unit**: kernel spectra ≈ 2× time-domain ⇒ ≈ 8 MB (8 s bucket) to 1.5 MB (1.5 s); pool of 10 ≈ ≤ 60 MB
  typical. FFT: pffft (§6), real transforms, 16-byte aligned buffers.

---------------------------------------------------------------------------------------------------------------------

## 5. Platform layers

### 5.1 Apple (macOS + iPadOS), `native/apple/` (UNBUILT on Linux)

- **Shell (Swift)**: `NSApplication`/`UIApplication`, one window with a `WKWebView` loading `app/index.html` through a
  `WKURLSchemeHandler` (`rig://app/…`, replaces `server.js` for files, pads, My Samples manifests and `/docs`), the
  menu bar (Electron menu actions → bridge-free JS calls via `evaluateJavaScript`), `WKScriptMessageHandler` named
  `rig` → `rig_post`, the event callback → main queue → one `evaluateJavaScript("__rigNative.receive(…)")` per batch.
  Backups/pad folder/recordings/My Samples importer replace the Electron IPC (`window.rig`): same JS API, Swift
  implementation (a separate shell task; the importer can run as a bundled `node`-free Swift port later).
- **Audio output: AudioUnit directly (C++ in `native/apple/audio/`), not AVAudioEngine, not miniaudio.**
  - macOS: `kAudioUnitSubType_HALOutput` (AUHAL) on the chosen `AudioDeviceID`
    (`kAudioOutputUnitProperty_CurrentDevice`),
    float32 non-interleaved, `kAudioDevicePropertyBufferFrameSize` = 128 for "interactive" (else latency·sr rounded
    to a multiple of 128), stream format at the device's nominal rate; **aux click**: open 4 channels and set
    `kAudioOutputUnitProperty_ChannelMap` so engine channels 3–4 land on the device's outputs 3–4; hot-plug and
    default-device changes via `AudioObjectAddPropertyListenerBlock`, reported with `rig_host_devices_changed` /
    re-open + `rig_host_audio_started`.
  - iPadOS: `kAudioUnitSubType_RemoteIO` + `AVAudioSession` (category `.playback`, mode `.default`,
    `setPreferredIOBufferDuration(128/sr)`, `setPreferredSampleRate` not forced); USB interfaces with ≥ 4 outputs via
    `AVAudioSession.currentRoute` + channel map; interruptions → `RIG_DEVICE_INTERRUPTED`, route changes → re-open.
  - Render callback (C, no Swift/ObjC in it) calls `rig_render(e, bufs, ch, frames, hostTimeNs + outputLatency)`.
  - **Why not AVAudioEngine**: an extra graph with its own latency and format negotiation for a single source node,
    weaker control of buffer size and channel maps. **Why not miniaudio on Apple**: it hides the channel map and the
    iOS session/interruption details we must handle anyway, and adds a 90k-line header for a platform we target
    directly; AUHAL/RemoteIO share ~80 % of the code (≈ 600 lines).
- **MIDI**: CoreMIDI client in Swift for port enumeration/hot-plug (`rig_host_midi_ports`) and `midi listen`; the
  input port is created with `MIDIInputPortCreateWithProtocol(._1_0)` whose receive block converts UMP MIDI-1.0
  words back to bytes and calls `rig_midi_in(portUniqueID, bytes, len, hostTimeNs)` (no allocation in the block).
  MIDI clock out: `host.midi_send` → `MIDISendEventList` with the given timestamp.
- **Decoding**: AAC/M4A/ALAC (My Samples, pads) via `ExtAudioFile` in `host.decode_file`.
- **Latency reporting**: `kAudioDevicePropertyLatency + SafetyOffset + stream latency + buffer` (mac),
  `outputLatency + ioBufferDuration` (iPad) → `rig_device_info.output_latency_sec`.

### 5.2 Windows later (`native/windows/`, not in 2.0)

WebView2 (`PostWebMessageAsJson` / `WebMessageReceived`), WASAPI output (shared mode event-driven by default,
exclusive optional for 128-frame buffers; `IAudioClient3::InitializeSharedAudioStream` for low-latency shared),
4-channel aux via a channel mask, MMDevice notifications for hot-plug, WinRT `Windows.Devices.Midi` or WinMM for MIDI,
Media Foundation for AAC. **Recommendation: use miniaudio's WASAPI backend** there (it covers device enumeration,
exclusive/shared, notifications), behind the same `rig_host` vtable. miniaudio is also vendored for the **Linux dev
host** (`native/devhost/`, ALSA/PulseAudio/null), so the realtime path (adapter, threads, TSAN) is exercised on Linux.

---------------------------------------------------------------------------------------------------------------------

## 6. Dependencies (all vendored under `native/core/third_party/` with their licence files)

| need | choice | licence | why |
|---|---|---|---|
| FFT | **pffft** (marton78 fork) | BSD-like (FFTPACK) | SIMD (SSE/NEON), small (2 files), real FFT at power-of-2 sizes; Chromium's non-Mac `FFTFrame` uses pffft (verify), helps PeriodicWave/convolver parity. vDSP not used: core stays portable |
| MP3 / WAV decode | **dr_mp3**, **dr_wav** (dr_libs) | public domain / MIT-0 | single headers; all 1999 factory samples are MP3; WAV for My Samples/pads |
| AAC/M4A/ALAC | platform (`host.decode_file`) | — | no small GPL-compatible portable AAC decoder (fdk-aac licence is GPL-incompatible; faad2 is GPL-2+ but large) |
| resampling | **Chromium `SincResampler` port** | BSD-3 | what `decodeAudioData` uses (verify) ⇒ sample parity |
| Web Audio kernels | ports of Chromium `Biquad`, `DynamicsCompressorKernel`, `PeriodicWave`/`OscillatorNode` tables, `UpSampler`/`DownSampler`, `AudioParamTimeline` formulas | BSD-3 | parity (Q5, Q6, Q8, Q10, Q12, Q2) |
| bit-exact math (JS `Math.*`) | **LLVM libc** `shared/math` subset (sin cos tan exp log log2 log10 expm1 cbrt atan atan2), ports of glibc 2.39 `__pow_fma` (= ARM optimized-routines pow) and `__tanh_fma`/`__expm1_fma` (fdlibm), V8 15.7 sinh (`src/num/`, T01) | Apache-2.0 WITH LLVM-exception; MIT (Arm); Sun fdlibm notice; BSD-3 | measured, not assumed (WAVE0B_REVIEW V10, `src/num/README.md`): Chromium 157 / V8 15.7 runs these, not fdlibm; 0 mismatches on 340 k fresh Chromium cases |
| bit-exact math (Blink C++ `fdlibm::`) | **V8 12.4 `ieee754.cc`** = Chromium `third_party/fdlibm` (`rig::fdlibm`) | BSD-3 + Sun fdlibm notice | AudioParam exponential ramps (`fdlibm::pow`) and setTarget (`fdlibm::exp`); kernel ports use it wherever their Chromium source calls `fdlibm::` |
| Chromium ports | `third_party/chromium/LICENSE` (tag 157.0.8103.78) | BSD-3 | every ported file names the tag and source path in its header (R17) |
| JSON | **yyjson** | MIT | fast C, 2 files, mutable writer for replies/events; control thread only |
| tests | **doctest** | MIT | single header, fast compile |
| desktop device I/O (dev host, Windows later) | **miniaudio** | public domain / MIT-0 | one header; not linked into the Apple app |

GPL-3 compatible throughout (BSD-3, MIT, MIT-0, Apache-2.0 WITH LLVM-exception, public domain, Sun permissive).
No JUCE, no FFmpeg, no Boost.
`third_party/README.md` records upstream URL, commit and local modifications per library.

---------------------------------------------------------------------------------------------------------------------

## 7. iPad profile (`RIG_PROFILE_IPAD`)

| resource | desktop | iPad | why |
|---|---|---|---|
| decoded-sample cache cap | 700 MB float32 | **320 MB int16** (≈ 640 MB float-equivalent) | jetsam; int16 storage halves memory for MP3-sourced data (quantisation ≈ −96 dBFS) |
| controller pin budget | 600 MB | **≈ 0.85 × capMB** (needs `controller.js` to derive `PIN_BUDGET_MB` from `capMB`; open item) | same policy, scaled |
| pin window | current ±1 / set or ±2 | current ±1 always (set: ±1 when over budget) | |
| neighbour preload | after commit | only after 6 s quiet, one decode thread | CPU/battery while playing |
| reverb units / IR cache | 10 / 12 | **4 / 4** | ≤ 30 MB; IR lengths unchanged (they are audible) |
| decode threads | 2 | 1 | thermal |
| meters | 30 Hz | 30 Hz foreground, off in background | |
| low-resource defaults | off | FX idle-sleep and slot disarm on (cheap natively, kept), frozen drone off | |

### 7.1 Budgets with 16 slots (T00c, DECISIONS D1-D3)

Measured on the Linux box (2 vCPU, g++ 13 -O3, offline render, 48 kHz) unless marked; "est." = computed, not measured.

| resource | desktop | iPad | how it is held |
|---|---|---|---|
| sample cache, soft cap (LRU target, low water 85 %) | 700 MB float32 | 320 MB int16 | unchanged (T06) |
| sample cache, **hard cap** (decodes refused above it) | 1050 MB (1.5 × cap) | **320 MB** (= cap) | `BufferCache::Config::hardCapBytes`; refused url marked failed for the retry window, one `warn memory`, `stats.capRefused` |
| engine **pin budget** | 892 MB (85 % of hard; the controller's 600 MB binds first) | **272 MB** | `CacheServiceImpl::withinPinBudget`: request order, rest unpinned, `stats.pinsDropped` |
| 16 sampler slots, worst case (est.) | 16 largest instruments = 1410 samples × 1.75 MB ≈ **2.47 GB** | ≈ **1.23 GB** int16 | above the hard cap: the later slots' samples are refused (silent notes + `warn memory`); 1.75 MB = T06's measured mean, the 30 s piano variants are larger (Mac/iPad: measure) |
| 4 sampler slots, worst case (est.) | ≈ 620 MB | ≈ 310 MB | fits both profiles (1.x behaviour) |
| reverb, kernels **+ slot state** (T04 finding 1) | 160 MB cap | **32 MB** cap; measured worst after hall/cathedral/wash switches: **27.7 MB** (19.0 MB kernels, ≤ 13.2 MB slot state) | `ReverbPool::bytes()` counts `ConvUnit::bytes()` of every occupied slot; over the cap, Idle slots are released (LRU) before kernels |
| graph (fixed, all 105 unit slots, rings) | 1.63 MB (`sizeof(Graph)`) | same | command heap 512 KB, garbage ring 1 MB; slot accumulators 8 KB |
| voice pools (D1: 128 per slot) | 16 slots × 128 voices × voice size; retiring channels add up to 32 more instruments | same | T11/T12: keep per-voice state small. The test voice (one `wa::Param`, 6.7 KB with its 64-event buffer) is 865 KB per instrument = 13.8 MB for 16 slots; a real voice with several 6.7 KB params would be tens of MB |
| CPU: 4 slots, idle strips | 67-70 µs per 128-frame quantum (2.6 % of 2667 µs) | Mac/iPad list | |
| CPU: 16 slots, idle strips | 90-100 µs (3.6 %) | Mac/iPad list | +2 µs per extra idle strip |
| CPU: 16 slots × 8 test voices | 420-480 µs (17 %) | Mac/iPad list | test voice ≈ 2.2 µs per voice per quantum (sine + a-rate envelope) |
| CPU: 16 slots × 64 test voices | **2430 µs (91 %)** | Mac/iPad list | real synth/sampler voices cost several test voices (T11/T12 bench): 16 × 64 cannot run on one core, hence the global ceiling question (DECISIONS D1, open) |
| host buffer (D2) | 64 / 128 / 256 / 512 frames | same, OS may round | FIFO residue (128 − b mod 128) mod 128 frames added to the reported latency; at 64 every other callback renders a quantum (worst `rig_render` at 64 here: 450 µs of a 1333 µs callback under the test) |

Engine resident target on a 4 GB iPad stays ≤ 450 MB: 320 MB samples (hard) + 32 MB reverb + voice pools + graph +
code; the voice pools are the open term (T11/T12 report their per-voice size).

- Memory pressure: the shell forwards `didReceiveMemoryWarning` as `config {lowResource:true}`-like trim (drop
  unpinned buffers, idle reverb units); `os_proc_available_memory()` is reported in `stats` so the controller can
  shrink its window. Budget target: engine resident ≤ 450 MB on 4 GB iPads (verify on device).
- **Background audio**: `UIBackgroundModes = audio`, session stays active while the engine is awake; WKWebView JS is
  suspended in the background, so (a) the native MIDI direct path (`midi route`) must be on for playing with the
  screen off, (b) ticks stop, (c) the Model never depends on JS for anything time-critical. Sleep (`audio sleep`)
  deactivates the session after the ramp so iPadOS can suspend the app.
- Interruptions (call, Siri, another app taking the session): `state interrupted`, panic-free resume when the
  interruption ends with `shouldResume`.

---------------------------------------------------------------------------------------------------------------------

## 8. Numerics and parity strategy

### 8.1 Number formats

- Audio samples, gains, DSP state of gain/pan/delay: **float32** (Chromium is float32 throughout).
- **double**: engine time and every event time; Param timeline time maths (Chromium computes times in double);
  biquad coefficients and state (Chromium `Biquad` keeps double state, verify); IR generator filter state and
  envelopes (contract §3.4); compressor detector maths where the Chromium kernel uses double (follow the port).
- Denormals: FTZ/DAZ on the audio thread and in offline renders (§3.2).
- No `-ffast-math`; `-ffp-contract=off` for the parity targets (FMA contraction changes the last bits between x86 and
  arm64); `-fno-finite-math-only`.

### 8.2 What must be bit-close vs perceptually matched

**Bit-exact or ≤ 1e-6 (unit tests, exact vectors dumped from JS):** `hashSeed`/`mulberry32`/`rngFor` streams and
seed-string formatting; `instSeq`-dependent seeds; IR generator output (bit-exact with `rig::js` math, T01; ≤ 1e-6
otherwise); click sample tables; clip and tanh/quantiser curves; `normalizePatch`/`clamp`; velocity/touch curves;
chord names, key detection; `ClickGrid` beat and MIDI-clock times; Param timeline values (rel. 1e-6); biquad
coefficients; delay-sync times; `getEqResponse` (must equal `shared/eq-math.js` exactly, the shim computes it).

**Golden "exact" tier (maxAbsDiff 2e-4; 62 of 108 fixtures after T17):** eq-* (18), width-* (3), master-eq,
glue-* (3), limiter-* (3), echo-* (6), lofi-crush-sweep, reverb-dry, click-* (2), touch-* (5), sampler-* (2),
synth-808-sub, plus 16 T17 fixtures (manifest `addedBy: 'T17'`; 13 of them need Chromium PCM, `needsPcm`).
`reverb-dry` and `echo-none` render digital silence (return gain 0), so they pass before anything is implemented.

**Golden "statistical" tier (46 fixtures; per-fixture tolerances in the manifest: bands 1.5–16.4 dB, envelope
corr 0.73–0.95, envelope check off (−1) for `chorus-default-sine`, `drone-freeze-dry/-wet`; R33), promoted to exact
where `exactIfPrngPorted` (41) by the owning task once its PRNG draw order matches:** synths and organs with
random phase/detune, reverb-room..wash, chorus, drone, auto-*, scene-glide, songs. Stay perceptual for good:
lofi-tape-sine (oversampler choice), synth-soft-keys and synth-dx-epiano (FM compensations Q11), song-lofi-rhodes,
anything decoded from AAC, drone files (Q16, not offline-renderable in JS).

### 8.3 Porting the Web Audio semantics that matter

| JS/Chromium behaviour | native implementation |
|---|---|
| PRNG `mulberry32` + FNV-1a `hashSeed`, `Math.imul`, `>>> 0` | uint32 arithmetic, identical streams; seed strings built with a JS-compatible `String(n)` (`std::to_chars` shortest + JS exponent rules) |
| AudioParam automation (Q2, Q3) | `wa::Param` port of Chromium `AudioParamTimeline` per-sample formulas (setTarget as `v += (target − v)·(1 − e^(−1/(τ·sr)))` per sample, verify against Chromium; exponential ramps multiplicative), a-rate vs k-rate per param exactly as the JS graph uses them; 12τ snap events come from the ported helpers |
| BiquadFilterNode (Q5, Q6) | Web Audio spec / Chromium `Biquad` coefficient formulas: LP/HP `Q` in dB (`α = sin ω0 / (2·10^(Q/20))`), peaking `α = sin ω0/(2Q)`, shelves S = 1, LP at f ≥ Nyquist ⇒ pass-through, HP at 0 ⇒ pass-through; coefficients recomputed once per quantum (k-rate); the JS engine's dB conversions (`20·log10(q)`) stay in the ported caller code so values are identical |
| DynamicsCompressorNode (Q8) | port `dynamics_compressor.cc` + `dynamics_compressor_kernel.cc` (knee curve, adaptive release zones, pre-delay/lookahead 6 ms, metering gain, automatic makeup `(1/fullRangeGain)^0.6`), then the contract's makeup cancellation and `clipPre`; the 0.3 s glue engage delay stays |
| StereoPannerNode | contract §3.1 equal-power formulas for mono and stereo inputs; channel count per instrument preserved (sampler and synth-extra stereo, others per patch, verified by fixture) |
| WaveShaperNode (Q10) | curve lookup `v = (n−1)(x+1)/2` linear interp, clamped ends; `4x` via ported Chromium Up/DownSampler (latency 192 frames at 4x, verify) so the lofi engage delay `.0075 + 320/sr` stays as is |
| ConvolverNode (Q7) | §4; `disableNormalization: true` ⇒ no scaling; stereo IR L→L, R→R |
| DelayNode (Q9) | linear-interpolated fractional read; feedback loop without the 128-frame split (echo k at exactly k·time) |
| OscillatorNode / PeriodicWave (Q11, Q12) | port Chromium's band-limited table generation (per-range partial culling) and its interpolation (verify the current interpolation order, Chromium added higher-order interpolation for low frequencies); keep the instruments' audible results, drop compensations the native oscillator doesn't need |
| AudioBufferSourceNode | linear interpolation repitch, `playbackRate` × buffer-rate/engine-rate, sub-sample start offset, loop points, `onended` → voice-ended event delivered before the next quantum's timers |
| AnalyserNode (Q14) | peak-since-last-read and RTA smoothing at the stream rate; the JS view keeps its ballistics |
| decodeAudioData (Q13) | dr_mp3 + SincResampler + `processSample`; MP3 decoder differences vs FFmpeg are measured per sample (Chromium PCM dumps) before trusting the sampler goldens |

### 8.4 Golden harness

`native/core/tools/rig-golden` (C++): reads `native/golden/manifest.json`, builds an offline engine per fixture
(seed, sample rate, flags), replays `fixture.setup` and `fixture.events` as **bridge messages with `when`**
(`prepare`/`commit`, `set`, `play`, `drone`, `click`, `song`), applies `tap`/`inject` through the test hooks, renders
`seconds`, writes `<out>/<id>.wav` (float32 stereo). Then `node tools/golden/compare.mjs <out>` applies the manifest
tolerances (existing tool, no new comparator). `ctest -L golden` wraps both. Fixtures are rendered at 44.1 kHz today;
48 kHz goldens are a re-render of the same manifest (`tools/golden/render.mjs --sr 48000`).

---------------------------------------------------------------------------------------------------------------------

## 9. Decisions taken here, and what stays open for Ryan

Proposed defaults (the build proceeds on these until Ryan decides otherwise; contract §8 question numbers): run the
core at the **device sample rate** (no extra SRC, goldens at 44.1/48 kHz; question 6); **port** the Chromium
compressor (question 4) and **Chromium-exact** oscillators/repitch first, with higher-quality variants possible later
behind a patch flag (question 3); keep FX idle sleep and slot disarm only if `rig-bench` shows they pay (they are cheap
to keep as "skip work when silent" flags), **drop drone freeze** unless iPad CPU needs it (question 7); RTA/EQ
response computed in the shim (question 5); 30 Hz ticks (question 10); 16-bit WAV kept as default with `bits: 24`
accepted (question 9).

Still Ryan's: bootstrap file (question 1), MIDI direct path from day one (question 2, strongly recommended on iPad),
pad-file streaming semantics (question 8), and the controller pin-budget change for the iPad profile (§7).
