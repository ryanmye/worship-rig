# Native engine build plan (2.0)

How the C++ core, the JS shim and the Apple shell get built by parallel agents. Architecture:
`native/docs/ARCHITECTURE.md` (module ids M1–M17). Behaviour: `native/docs/ENGINE_CONTRACT.md`. API:
`native/core/include/rig/rig_engine.h`. Done = the named golden fixtures pass `node tools/golden/compare.mjs` on WAVs
written by `rig-golden`, plus the task's unit tests, plus `-Wall -Wextra -Werror` clean, plus the allocation trap on.

Rules for every task: edit only the files the task owns (plus new files under its own directories); never reformat
others; interfaces in `src/**/*.h` created by T00 change only through the orchestrator (an agent that needs a change
writes it in its report); no `git commit/checkout/stash/reset`; lines ≤ 120; third-party code only from
ARCHITECTURE §6. Size: S ≤ 1 day-agent, M ≤ 3, L > 3. "Linux ✔" = fully verifiable on this box.

## Wave 0: shared skeleton (one agent, serial, before anything else)

**T00 skeleton** (M, Linux ✔). Owns: `native/core/CMakeLists.txt`, `native/core/cmake/`, `native/core/src/**/*.h`
(every internal interface as declarations + doc comments: `wa::Param`, `wa::Biquad`, …, `Model`, `Graph`, `Command`,
`AudioEvent`, `SlotChannel`, `Reverb`, `BufferCache`, …), `native/core/src/api/rig_engine.cpp` (C API with stub
bodies), `native/core/src/runtime/{spsc,mpsc,seqlock,epoch}.h` (complete; they are small and everything needs them),
`native/core/src/runtime/offline_driver.cpp` (quantum loop of ARCHITECTURE §3.6 over a stub Graph that renders
silence), a trivial `wa::Param` (setValue only) so DSP tasks can link before T01 lands, `native/core/third_party/`
(pffft, yyjson, dr_libs, doctest, V8 ieee754 subset, licences, README), `native/core/tools/rig-golden/` (loads the
manifest and stimuli, turns `fixture.setup/events` into bridge messages with `when`, writes WAVs; renders silence
until modules land), `native/core/tools/gen-params.mjs` → `src/params/params_gen.inc` (+ `--check`),
`native/core/tests/` (doctest main, test helpers: WAV I/O, vector loading, allocation trap), `ctest` labels
`unit`/`golden`/`rt`. Done: `cmake -G Ninja && ninja && ctest -L unit` green on g++ 13 and clang 18; `rig-golden
--only eq-peak-a` writes a (silent) WAV that `compare.mjs` reports as failing (proves the loop end to end).

## Wave 1: independent modules (start together after T00)

| task | owns (dirs under `native/core/src/` unless noted) | implements | done = fixtures / tests | deps | size | Linux ✔ |
|---|---|---|---|---|---|---|
| **T01 time & numerics** | `time/`, `num/`, `tools/golden/vectors/` (new JS dumper) | M4, M5: Param timeline (Chromium formulas), automation helpers incl. 12τ snap and 16-seg equal-power, Timer, Coalescer; PRNG, hashSeed, `String(n)`, ieee754 glue | exact vectors from JS (`automation.js`, `fx.js` helpers, `prng.js`) rendered through an OfflineAudioContext by the new dumper; ≤ 1e-6 | T00 | M | ✔ |
| **T02 filters & strip** | `dsp/biquad*`, `dsp/panner*`, `dsp/gain*`, `dsp/delay_line*`, `mix/slot_channel*`, `mix/slot_eq*`, `mix/width*`, `mix/master_eq*` | M6 (biquad, panner, gain, delay line), M8 strip + SlotEq (resolve, chain crossfade, type-change fade) + master EQ | eq-* (18), width-0/50/150, master-eq (exact) | T00 (T01 for automated cases) | M | ✔ |
| **T03 dynamics & master chain** | `dsp/compressor*`, `dsp/waveshaper*`, `dsp/resampler_updown*`, `mix/master_chain*` | Chromium DynamicsCompressor kernel port, WaveShaper + Up/DownSampler, glue (makeup table, 0.3 s engage, dry/wet), catcher, clipPre, clip curve, mono xfade, fadeGain | glue-50, glue-100, glue-100-bursts, limiter-steps, limiter-steps-hot, limiter-bursts-hot (exact) | T00 | L | ✔ |
| **T04 reverb** | `dsp/convolver*`, `fx/reverb*`, `fx/ir_gen*` | §4 NUPOLS convolver (direct + 3 stages, time-distributed), IR generator (bit-exact), unit pool LRU, retain, predelay 2-line xfade, unit xfade, input filters, IR worker job | reverb-dry (exact), reverb-room/stage/hall/cathedral/wash (statistical → exact once T01 PRNG); IR bit-exact vs JS `irGen` dump; convolver vs direct convolution ≤ 1e-6; `rig-bench` CPU number | T00, T01 (PRNG, ieee754) | L | ✔ (CPU target ✗ Mac) |
| **T05 delay, chorus, lofi** | `fx/delay*`, `fx/chorus*`, `fx/lofi*` | two-line delay (sync, glide ≤ 5 %, switch/flush, ping-pong, tone, panic, no Q split), chorus, lofi (tanh 4x, quantiser, tape, crackle) | echo-* (6, exact), chorus-default-sine, chorus-fast-deep-noise, lofi-crush-sweep (exact), lofi-tape-sine | T00, T03 (WaveShaper) for lofi only | M | ✔ |
| **T06 samples & cache** | `samples/`, `tools/golden/decode-dump/` (new Playwright dumper of `decodeAudioData` output) | M10: dr_mp3/dr_wav, host decode hook, SincResampler port, processSample, BufferCache (LRU/pins/protect/refs/deferred, int16 storage), estimate, manifest + gain-trims registry loading | decoded PCM vs Chromium dumps for 20 factory samples (report max diff; target ≤ 1e-4 after onset trim); cache policy tests ported from the JS engine suites; `estimate` equals JS | T00 | M | ✔ |
| **T07 click & MIDI** | `click/`, `midi/` | M14 click synthesis + grid + pump + aux + record + MIDI clock; M15 parser + port table + direct route | click-120-44, click-90-68-countin (exact); parser vectors from `midi.js`; MIDI-clock pulse times vs `metronome.js` | T00, T01 | M | ✔ |
| **T08 bridge & runtime** | `bridge/`, `runtime/` (except T00's queue headers), `meter/`, `rec/`, `api/rig_engine.cpp` (fill in) | M1–M3, M16, M17: 14 ops/9 events against the Model interface (stub Model in tests), control thread, workers, clock map, render FIFO adapter, tick builder, recorder | bridge conformance tests generated from `engine-api.json` (every op, every error code); TSAN soak 10 min with a fake host thread at 128/256/441-frame blocks; WAV writer round trip | T00 | L | ✔ |
| **T09 web shim & Linux dev host** | `app/js/engine/native/` (new files only), `native/devhost/` (C++ + Node relay) | `NativeEngine`/`NativeMidiAccess`/`NativeRecorder` facades per contract §6.6 (transport: `webkit.messageHandlers.rig` or a WebSocket in dev); `rig-devhost` = core + miniaudio output + WebSocket bridge so the real web UI runs on the native core in Chromium | shim unit tests against a recorded message log; the existing `ui-core` Perform suite runs against `rig-devhost` (opt-in flag) | T00 (T08 for end to end) | M | ✔ |
| **T10 Apple shell** | `native/apple/` | Swift app: WKWebView + `rig://` scheme handler (replaces `server.js`), `rig` message handler, event pump, menu, AUHAL/RemoteIO C++ audio layer, CoreMIDI, AVAudioSession, `ExtAudioFile` decode hook, pads/recordings/backups replacing `window.rig`; Xcode project generated by a checked-in `project.yml` (XcodeGen) | **UNBUILT here**; Mac checklist below | T00 header only | L | ✗ |

## Wave 2: instruments and the Model (start when T01 + T02 have landed; T06 for T12)

| task | owns | implements | done | deps | size | Linux ✔ |
|---|---|---|---|---|---|---|
| **T11 oscillator, voice, synth.js** | `dsp/oscillator*`, `dsp/periodic_wave*`, `dsp/buffer_source*`, `inst/voice*`, `inst/synth*`, `inst/allocator*`, `inst/registry*` | PeriodicWave port, Oscillator, BufferSource (also used by T12/T07), voice.js, synth.js 7 patches incl. drone-osc, allocator, catalogue (`get instruments` = engine-api.json list) | synth-warm-pad, glass-pad, strings, sub-bass, soft-keys, bell (statistical, → exact where E); catalogue equality test | T01, T02 | L | ✔ |
| **T12 sampler** | `inst/sampler*` | layers, velocity layers, repitch, release override, pedalHold path hooks, forced stereo, widthDefault | sampler-salamander-piano, sampler-ep-rhodes, touch-soft/hard/fixed/custom/keyboard (exact) | T06, T11 (BufferSource, allocator) | M | ✔ |
| **T13 Model: song & graph** | `model/engine_model*`, `model/song*`, `model/graph_build*`, `model/stats*` | M12 part 1: graph assembly (slots, sends, sum, FX, master), prepare/commit/tokens/instSeq/retire, setParam dispatch (§2.3 table, coalescing), routing, transpose/tempo/timeSig/keyContext, low-resource, reverb policy (which IR plays), stats, getState | auto-slot-level, auto-reverb-send, auto-delay-send, auto-master-volume; prepare/commit unit tests ported from `test/phase1/engine` | T02–T05, T11 interface | L | ✔ |

## Wave 3: everything that plays (after T11 and T13 land)

| task | owns | implements | done | deps | size | Linux ✔ |
|---|---|---|---|---|---|---|
| **T14 Model: perform** | `model/perform*`, `model/wheels*`, `model/chords*`, `model/sleep*` | notes/pedal/mono/legato/pedalHold, wheels + pickup + macros, bend modes incl. tape, swell, panic, fadeOutAll, chord events, sleep/wake queueing | auto-modwheel-cc, auto-filter-cutoff, scene-glide; song-sunday-pad-piano, song-lofi-rhodes, song-gospel-stab-b3 (with T15/T16) | T13, T12 | L | ✔ |
| **T15 synth-extra + organ** (splittable into T15a/T15b) | `inst/synth_extra*`, `inst/organ*` | 10 synth-extra patches (keep audible result of Q11), organ 4 presets + rotary | synth-supersaw-pad, juno-pad, shimmer-pad, dx-epiano, pluck, poly-stab, analog-brass, square-lead, 808-sub (exact), synth-bass; organ-gospel/soft-pad/full/church | T11 | L | ✔ |
| **T16 drone** | `drone/` | synth layers, voicing, chord-follow, swells/duck/park, width, send gate, native pad streaming (WAV/MP3 here; AAC via host), freeze only if kept | drone-synth-2keys, drone-synth-stage, drone-freeze-dry/-wet (or re-classified if freeze is dropped) | T11, T04, T13 | M | ✔ (AAC pads ✗) |

Critical path: T00 → T01 → T11 → T13 → T14 (≈ 5 serial steps); everything else hangs off it. Promotion pass after
T14: re-render the 36 `exactIfPrngPorted` fixtures, move every passing one to the exact tier in the manifest (owner:
the golden harness task, not the module agents).

## Verified only on the Mac or iPad

- AUHAL/RemoteIO render at 128-frame buffers, measured round-trip latency, xruns under load (Instruments).
- Device selection, hot-plug, default-device following, **aux click on outputs 3–4** of a 4-out interface.
- CoreMIDI timestamps → engine time, jitter with and without `jitterFree`; **WebView round trip per note** (contract
  question 2) and `evaluateJavaScript` cost of 30 Hz ticks.
- WKWebView: `rig://` origin, **localStorage migration** from the Electron origin `127.0.0.1:8438` (import a backup on
  first launch; data-loss risk), file access to `~/Music/Worship Rig`, sandbox/entitlements, code signing.
- AAC/M4A decode through `ExtAudioFile` (My Samples, pads) and real GarageBand-imported content.
- CPU targets on Apple silicon and the oldest supported iPad; NEON paths of pffft and the direct FIR.
- iPad: AVAudioSession interruptions, background audio with the screen off, jetsam headroom (memory warnings), USB
  interfaces with 4 outputs.
- App size (no Electron: expect ≈ 100 MB vs 365 MB today).

## Interfaces the waves meet at (frozen by T00)

`Command` (64-byte POD) and `AudioEvent` layouts; `wa::Param` API; `Graph::renderQuantum`; `Model` public methods
(mirroring contract §1 one to one); `SlotChannel`/`Reverb`/`Delay`/`Chorus`/`Lofi`/`MasterChain` construction from
resolved patch structs; `Instrument` virtuals (`noteOn/noteOff/setParam/setBend/legatoTo/voices/output channels`);
`BufferCache` API; `TestHooks` (tap/inject names = `tools/golden/page.js` TAP/INJECT tables).
