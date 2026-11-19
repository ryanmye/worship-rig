# Native engine build plan (2.0)

How the C++ core, the JS shim and the Apple shell get built by parallel agents. Architecture:
`native/docs/ARCHITECTURE.md` (modules M1–M17). Behaviour: `native/docs/ENGINE_CONTRACT.md`. C API:
`native/core/include/rig/rig_engine.h`. Findings referenced as "R*n*" are `native/docs/SETUP_REVIEW.md` §3 numbers.
This file was rewritten by T00b (interface freeze) and is true as of that step; the orchestrator keeps it true.

**Done** for every core task = (1) the listed golden ids pass `node tools/golden/compare.mjs` on WAVs from
`rig_render` (= `rig-golden`), wired as ctest `golden.<task>` by adding `native/core/tests/golden_ids/<task>.ids`;
(2) the listed unit tests (doctest, `TEST_SUITE("<name>")` → ctest `unit.<name>`); (3) clean configure + build +
`ctest` on g++ 13 and clang 18 (Release) and g++ ASan+UBSan, `-Wall -Wextra -Wpedantic -Wshadow -Wconversion
-Werror`; (4) the allocation trap stays on in the golden path; (5) the findings named in the task are closed or
explicitly handed on in the report. "Linux ✔" = (1)–(4) are fully checkable on this box.

## Rules (every task)

- **Edit only what the task owns** (globs below). Everything else is read-only; a needed change in a file you do not
  own goes into your report as an exact diff for the orchestrator.
- **Adding a module = adding files.** CMake globs: every `src/**/*.cpp` is compiled into `rig_core` (except paths with
  `/third_party/`); every `src/**/*_register.cpp` is a registration point (`api/registry.h`; the function name is
  `rig_register_<path below src, non-alnum → _>`, e.g. `src/fx/reverb_register.cpp` → `rig_register_fx_reverb`);
  every `src/**/*.cmake` is an include hook run after `rig_core` exists (vendored include dirs as `SYSTEM`, per-file
  flags, vendored sources); every `tests/**/*.cpp` is a test source and each `TEST_SUITE("x")` becomes ctest `unit.x`
  (`realtime` → `rt.realtime`); every `tests/golden_ids/<name>.ids` (one id per line) becomes ctest `golden.<name>`.
  Nobody edits `CMakeLists.txt` to add a module. Re-run `cmake` after adding files only if ninja did not.
- **Own build directory** `native/core/build-<task id>` (never `build/`), `-j2` at most (2 CPUs, up to 5 agents).
  The orchestrator may pass `-DRIG_SOURCE_EXCLUDE=<regex>` to isolate another task's unfinished files.
- No `git commit/checkout/stash/reset/clean`, no `pkill` of shared processes, no `playwright install`, lines ≤ 120,
  third-party code only from ARCHITECTURE §6 (vendored with licence; under the module's own `src/<dir>/third_party/`
  plus a `.cmake` hook, or `third_party/` through the orchestrator).
- **Opcodes**: never add lines to `enum class Op`. Use your task's range from `runtime/command.h` in your own
  header (`enum class ReverbOp : uint16_t { X = kOpBaseT04, … }`, sent with `opOf()`); the graph routes it to the unit
  in `Command::target`. Payload pointers derive from `rig::Owned` and travel with `sub = kSubOwnedPayload`.
- Chromium ports name the revision that rendered the goldens, **Chromium 157.0.8103.78**, in the file header (R17),
  with the BSD-3 notice; the first task to port Chromium code asks the orchestrator for `third_party/chromium/LICENSE`.
- Parity-relevant PRNG use follows the JS draw order exactly (stream names from the manifest `randomness` field);
  each instrument/FX task promotes its own `exactIfPrngPorted` fixtures (R7) instead of a late pass.

## Frozen interfaces (T00b; change only through the orchestrator)

| interface | file | implemented by |
|---|---|---|
| `Command` 64 B / `AudioEvent` 32 B, core `Op` values, **opcode range table**, `kSubOwnedPayload`, `GarbageKind` | `src/runtime/command.h` | core |
| `Unit` (process / apply / param / setSampleRate / liveVoices / giveBack), `Bus`, `UnitIO`, `RenderContext`, `UnitSlot` (49 fixed slots incl. 16 retiring channels, drone, reverb, delay, chorus, lofi, master, click, meter, recorder), `paramTarget()`, send buses, `Owned` | `src/graph/unit.h` | every unit |
| fixed render topology, lock-free rate hand-off, `TimeBase`, epoch | `src/graph/graph.{h,cpp}`, `src/graph/epoch.h` | core |
| TestHooks TAP (10) / INJECT (7) tables = `tools/golden/page.js` key for key (test `unit.t00b` parses page.js) | `src/graph/test_points.h` | core + MasterChain local points |
| Registry: unit factories by kind, set handlers by row prefix, services by name; `UnitEnv`, `UnitSpec`, `UnitInfo`, `SetRequest` | `src/api/registry.h` | every module |
| `Model` public methods = contract §1 one to one + module helpers (`attachUnit`, `sendUnitOp`, `sendOwned`, `moveParam`, `setParamAt`, `frameFor`, `service<T>()`, `warn`) | `src/model/model.h` | T13/T14 bodies |
| resolved patch structs (`SlotPatch`, `ReverbPatch`, `DelayPatch`, `ChorusPatch`, `LofiPatch`, `MasterPatch`, `DronePatch`, `SongState`), `storeRow` | `src/model/patch.h` | core |
| services `CacheService`, `InstrumentService`, `ReverbService`, `ClickService`, `MidiService`, `DroneService`, `MeterService`, `RecService`; `EnginePaths` | `src/model/services.h` | T06, T11, T04, T07, T07, T16, T08, T08 |
| `BufferCacheApi`, `SampleBuffer` | `src/model/buffer_cache_api.h` | T06 |
| `Instrument` virtuals (noteOn/noteOff/allNotesOff/kill/sustain/setBend/legatoTo/setParam/releaseVoice/outputChannels) + core-op decode | `src/inst/instrument.h`, `src/graph/instrument_apply.cpp` | T11, T12, T15 |
| `SlotChannel` (kind `strip`), `StripParam`, `StripOp` | `src/mix/slot_channel.h` | T02 |
| `MasterEq` | `src/mix/master_eq.h` | T02 |
| `MasterChain` (kind `master`), `MasterParam`, `MasterOp`, local test points | `src/mix/master_chain.h` | T03 |
| `Reverb` (kind `reverb`), `ReverbParam`, `ReverbOp` | `src/fx/reverb.h` | T04 |
| `Delay` / `Chorus` / `Lofi` (kinds `delay`, `chorus`, `lofi`) | `src/fx/{delay,chorus,lofi}.h` | T05 |
| `Click` (kind `click`), `ClickOp`; `Op::ClickRoute` | `src/click/click.h` | T07 |
| `Drone` (kind `drone`), `DroneParam` | `src/drone/drone.h` | T16 |
| `wa::Oscillator`, `wa::PeriodicWave`, `wa::BufferSource`, `wa::ConstantSource` | `src/dsp/{oscillator,periodic_wave,buffer_source,constant_source}.h` | T11a |
| `wa::WaveShaper` | `src/dsp/waveshaper.h` | T03 |
| `wa::DelayLine` | `src/dsp/delay_line.h` | T02 |
| `wa::Param` (unchanged API) | `src/time/param.h` | T01 |
| C API (+ `rig_host_memory_pressure`, `rig_set_paths`, added by T00b, R21a/b) | `include/rig/rig_engine.h` | T08 |

Kinds the skeleton Model attaches by itself: per channel `inst.<instrument.type>` + `strip` at every commit; once,
at `audio start` / first commit, `reverb delay chorus lofi master click drone meter rec` when registered (`lofi`
skipped with `RIG_FLAG_NO_LOFI`). Builtins (priority 0, replaced by any module of the same kind): `strip` (fader →
SlotEq → pan), `inst.test` (test voice), `master` (volume only). A wave-1 module therefore reaches its golden
fixtures through `rig_render` by registering its kind plus its `set` handler prefix; nothing else.

Clock (R15, R16): engine time = time-grid frame / rate. `rig_host_audio_started` stores the new rate atomically (any
thread); the audio thread adopts it between quanta: frame' = ceil(frame·new/old) (time continues, never backwards,
+< 1 sample), pending command frames rescaled, `Unit::setSampleRate` on every unit, `RateChanged` event to the
control side, which (T08 + each module's service) rebuilds IRs, wavetables, resampled buffers and re-attaches.
Tests: `unit.clock` (offline switch 48k→96k/32k with a pending note, realtime switch from another thread while
rendering; TSan-clean under g++).

## Ownership (every file under `native/core`)

| path | owner |
|---|---|
| `CMakeLists.txt`, `CMakePresets.json`, `cmake/**`, `.clang-format`, `.gitignore`, `README.md` | orchestrator (frozen) |
| `include/rig/rig_engine.h` | orchestrator (T08 proposes additions) |
| `src/runtime/command.h`, `spsc.h`, `mpsc.h`, `seqlock.h` | orchestrator (frozen) |
| `src/runtime/**` other (`rt_guard.h`, new control-loop / worker / clock-map / offline-driver files) | T08 |
| `src/graph/**` | orchestrator (frozen; builtins removed by the orchestrator once T02/T03 land) |
| `src/api/registry.{h,cpp}` | orchestrator (frozen) |
| `src/api/engine.{h,cpp}`, `src/api/rig_engine.cpp`, `src/bridge/**` | T08 |
| `src/model/model.h`, `patch.h`, `services.h`, `buffer_cache_api.h`, `patch.cpp` | orchestrator (frozen) |
| `src/model/model.cpp` | orchestrator until wave 2, then T13 (T13's first step moves the perform bodies, `noteOn` … `runtimeStateJson`, unchanged into `model/perform.cpp`, which T14 owns) |
| `src/model/{engine_model,song,graph_build,stats,retire}*` | T13 |
| `src/model/{perform,wheels,chords,sleep}*` | T14 |
| `src/mix/slot_spec.h`, `src/dsp/test_voice.*`, `src/io/**`, `src/params/**`, `tools/gen-params.mjs` | orchestrator (frozen / generated from the contract) |
| `src/num/**`, `src/time/**` (except the `param.h` API) | T01 |
| `src/dsp/{biquad,panner,gain,delay_line}*`, `src/mix/{slot_channel,slot_eq,width,master_eq}*` | T02 |
| `src/dsp/{compressor,waveshaper,resampler_updown}*`, `src/mix/master_chain*` | T03 |
| `src/fx/{reverb,ir_gen}*`, `src/dsp/convolver*`, `tools/rig_bench/**` | T04 |
| `src/fx/{delay,chorus,lofi}*` | T05 |
| `src/samples/**` | T06 |
| `src/click/**`, `src/midi/**` | T07 |
| `src/meter/**`, `src/rec/**` | T08 |
| `src/dsp/{oscillator,periodic_wave,buffer_source,constant_source}*` | T11a |
| `src/inst/**` except `instrument.h`, `sampler*`, `synth_extra*`, `organ*` | T11 |
| `src/inst/sampler*` | T12 |
| `src/inst/{synth_extra,organ}*` | T15 |
| `src/drone/**` | T16 |
| `third_party/**` | orchestrator (T01's `src/num/llvm_libc/` is T01's) |
| `tools/common/**`, `tools/rig_render/**` | orchestrator (frozen; knows every manifest setup key and event type) |
| `tests/helpers.h`, `test_main.cpp`, `test_modules_init.cpp`, `alloc_trap.cpp`, `test_t00b_api.cpp`, `test_clock.cpp`, `dummy_module/**`, `fixtures/**`, `test_params.cpp`, `test_third_party.cpp`, `test_voice.cpp`, `test_wav.cpp`, `test_golden.cpp` | orchestrator |
| `tests/test_param.cpp` | T01 |
| `tests/test_biquad.cpp`, `tests/golden_ids/eq.ids` | T02 |
| `tests/test_bridge.cpp`, `test_offline.cpp`, `test_queues.cpp`, `test_realtime.cpp` | T08 |
| new `tests/test_<module>*.cpp`, `tests/<module>/**`, `tests/golden_ids/<task>.ids` | the task that creates them |
| outside core: `tools/golden/**` except `vectors/**` (T01) and `decode-dump/**` (T06); `native/golden/**` | T17 |
| outside core: `app/js/engine-bridge/**`, `test/unit/engine-bridge/**`, `native/devhost/**` | T09 |
| outside core: `native/apple/**` | T10 |
| `native/docs/**`, `native/contract/**`, `.github/workflows/native-core.yml` | orchestrator |

## Wave 0b (done): T00b interface freeze

Closed R1, R2, R3 (by creating T11a), R15 (hand-off: atomic rate request, adopted on the audio thread; graph rate is
no longer written by the host thread), R16 (monotonic clock + test), R21a, R21b, R25 (core side: design note in
`Engine::requestAudio`; the shell fix is T10's). Test `unit.dummy-module` (`tests/dummy_module/`) registers a unit
kind, a module opcode, a set handler and a service from its own directory and is rendered, tapped and injected
through the C API.

## Wave 1: independent modules

**Startable immediately after T00b:** T02, T03, T04, T05 (delay part at once; chorus/lofi parity after T11a and T03's
WaveShaper), T07 (MIDI part at once; click parity after T11a's BufferSource), T08, T09, T11a. Already running: T01,
T06, T17, shell follow-ups (T10: R25, R27–R29). Run at most 5 at once on this box; order by critical path (R8):
**T04 first**, then T11a and T03 (they unblock T05/T07), then T02, T08, T05, T07, T09.

| task | owns (see table) | implements (interface) | done = fixtures / tests | deps | size | model | Linux ✔ | closes |
|---|---|---|---|---|---|---|---|---|
| **T01 time & numerics** (running) | `src/num/**`, `src/time/**`, `tests/test_param.cpp`, `tools/golden/vectors/**` | M4/M5 behind `wa::Param`, `TimerQueue`, `hashSeed`, `rngFor`, JS `String(n)`, JS math | first step R14: dump exp/log/sin/cos/pow/tanh from the golden Chromium on ~1e6 inputs, pick the matching libm; Param timeline vectors from an OfflineAudioContext ≤ 1e-6 rel; PRNG/seed strings bit-exact; `src/num/num.cmake` hook for its `-isystem` | T00b | M | opus | ✔ | R14, R17 (Param header) |
| **T02 filters & strip (extend)** | as table | `SlotChannel` (`strip`), `MasterEq`, `DelayLine`, panner/gain | **extend** the passing biquad + SlotEq (keep `golden.eq` = 18 `eq-*` exact green at every step); `width-0`, `width-50`, `width-150`, `master-eq` exact; T17's new `eq-chain-4band`, `eq-type-change`, `eq-legacy-rows`, `pan-mono-sampler`*, `pan-stereo-synth`* once published (*rendered through the test instrument until T11/T12); JS `filterQButterworth`, `slotWidthEq`, `dualMonoIdentity` ported | T00b, T01 (automation) | M | sonnet | ✔ | R5, R12 (EQ/pan rows) |
| **T03 dynamics & master chain** | as table | `MasterChain` (`master`, local taps `fx.eqOut`/`fx.master`, inject `fx.preComp`), `WaveShaper` | `glue-50`, `glue-100`, `glue-100-bursts`, `limiter-steps`, `limiter-steps-hot`, `limiter-bursts-hot` exact; `master-eq` jointly with T02; JS `masterEqGlue`, `monoCeilingAndMakeup`, `glueEngageNoDip` ported; WaveShaper curve + 4x latency unit tests vs Chromium vectors | T00b, T02 (MasterEq; stub until then) | L | opus | ✔ | R17 (compressor, Up/DownSampler) |
| **T04 reverb** (start first) | as table | `Reverb` (`reverb`), `ReverbService`, set handler `fx.reverb.` | `reverb-dry` exact; `reverb-room`, `-stage`, `-hall`, `-cathedral`, `-wash` statistical now, **exact** once T01's PRNG lands (all `exactIfPrngPorted`); IR bit-exact vs a JS `irGen` dump; convolver vs direct convolution ≤ 1e-6; `rig_bench` reverb unit ≤ 8 % of one core on this box at 48 kHz (fails the task above); memory capped in bytes (LRU by bytes, default 32 MB iPad) with a unit test; JS `irRecipe`, `predelayNoWarp`, `reverbDeferWhilePlaying`, `reverbQuietGate`, `undampedOptIn`, `reverbRetain` ported | T00b, T01 (PRNG, math) | L | opus | ✔ (Mac CPU ✗) | R6 (bench), R8, R19 |
| **T05 delay, chorus, lofi** | as table | `Delay`, `Chorus`, `Lofi`; set handlers `fx.delay.`, `fx.chorus.`, `fx.lofi.` | `echo-none`, `echo-slapback`, `echo-quarter`, `echo-dotted`, `echo-ambient-echo`, `echo-dotted-noise` exact; `lofi-crush-sweep` exact; `chorus-default-sine`, `chorus-fast-deep-noise` exact (`exactIfPrngPorted`); `lofi-tape-sine` statistical (stays); JS `lofiBypassExact`, `delaySync`, `lofiEngageNoClick`, `lofiHeadroom` ported | T00b; T11a (Oscillator, BufferSource, ConstantSource) for chorus/lofi; T03 WaveShaper for lofi | M | sonnet | ✔ | R3 (consumer) |
| **T06 samples & cache** (running) | `src/samples/**`, `tools/golden/decode-dump/**` | `BufferCacheApi`, `CacheService` (`cache`) | decoded PCM vs Chromium dumps: **pass if ≤ 1e-4 after onset trim on ≥ 18 of 20 factory samples, otherwise the `samples.pcmOverride` test hook (Chromium PCM loaded for exact fixtures) is mandatory**; `estimate` equals JS and reports stored bytes (`mb`, `capMB`); JS `preloadAndLRU`, `pinsUnion`, `pinsLimitedEvict`, `sampleRetry`, `userManifests`, `userManifestGuards`, `gainTrimsAndRegistry` ported; `rig_set_paths` re-reads the user manifest | T00b | M | sonnet | ✔ | R6, R13, R20 |
| **T07 click & MIDI** | as table | `Click` (`click`), `ClickService`, `MidiService` | `click-120-44`, `click-90-68-countin` exact; parser vectors from `midi.js`; MIDI-clock pulse times vs `metronome.js`; port table from `rig_host_midi_ports` replaces the uint16 hash (needs T08 to forward port ids); JS `clicksStealsDelay`, `clickDetectorSelfTest` ported | T00b, T01, T11a (BufferSource) | M | sonnet | ✔ | R11 (G4), R21c, R21e |
| **T08 bridge & runtime** | as table | all 14 ops/9 events over the `Model` methods, control thread, workers, clock map, FIFO, tick builder, `MeterService`, `RecService` | conformance tests generated from `engine-api.json` (every op, every error code); TSan soak 10 min with a fake host at 128/256/441-frame blocks; rate-change test kept + what is rebuilt on a rate change documented and tested (each `Service::onRateChanged`); `Dropped` event handling (ended bits scan, Garbage never dropped: separate ring); `audio_start` watchdog (no blocking of the control thread); G3, G5, G6 (idle tick ≥ 8 Hz or cap 0.5 s), G7, G8, G9 conformance; JS `audioSleep`, `idleArm`, `idleDisarm`, `fxIdleSleep`, `slotLevelTap`, `restart`, `irOffMainThread` ported where engine-side | T00b | L | opus | ✔ | R11, R15 (soak), R16 (rebuild list), R18, R21d, R25, R26 |
| **T09 web shim & Linux dev host** | `app/js/engine-bridge/**`, `test/unit/engine-bridge/**`, `native/devhost/**` | devhost (core + miniaudio + WebSocket), WebSocket transport, `NativeRecorder` facade over `rec` (G10) + the one-line recorder.js selection Ryan approves | existing 89 bridge tests stay green; recorder facade tests against a recorded log; `ui-core` Perform suite against `rig-devhost` (opt-in flag) | T00b (T08 for end to end) | M | sonnet | ✔ | R4, R10, R11 (G10, G11) |
| **T10 Apple shell (extend)** | `native/apple/**` | the existing skeleton: R25 `queue.async`, R27 `WKNavigationDelegate`, R28 string transport, R29 tick coalescing, R30, R31; calls `rig_host_memory_pressure` / `rig_set_paths` | **UNBUILT here**; Mac checklist below | header only | L | opus | ✗ | R25, R27–R31 |
| **T11a DSP sources** (new) | `src/dsp/{oscillator,periodic_wave,buffer_source,constant_source}*` | `wa::Oscillator`, `wa::PeriodicWave`, `wa::BufferSource`, `wa::ConstantSource` (Chromium 157 ports) | single-node vectors rendered by an OfflineAudioContext (new dumper cases via T17): sine/square/saw/triangle + custom PeriodicWave (chorus LFO shape `real=[0,sinφ]`) at 5 frequencies incl. < 20 Hz, ≤ 1e-5; BufferSource repitch 0.5/1/1.5/2.03, sub-sample start, loop points, `ended` timing; ConstantSource with automation | T00b, T01 (Param) | M | sonnet | ✔ | R3, R17 (PeriodicWave, BufferSource) |
| **T17 golden promotion + new fixtures** (running) | `tools/golden/**` (minus T01/T06 dirs), `native/golden/**` | new fixtures + promotion pass | ~10 new fixtures of R12 rendered and committed in the manifest: `pan-mono-sampler`, `pan-stereo-synth`, `transpose-octave`, `bend-normal`, `bend-tape`, `swell-8s`, `mono-legato`, `eq-chain-4band`, `eq-type-change`, `eq-legacy-rows`, `release-pedalhold`, `fadeout-panic`, `routing-switch`, 3 samplers (stereo, velocity layers, release override); dumper cases for T01/T11a vectors; `compare.mjs --self-test` green; promotion: each task's passing `exactIfPrngPorted` fixture moves to the exact tier when that task reports it | none | M | sonnet | ✔ | R7, R12, R22 (commit the exact-tier WAVs or a regen step), R33 numbers |

## Wave 2: instruments and the Model (start when T01, T02, T11a have landed; T06 for T12)

| task | owns | implements | done | deps | size | model | Linux ✔ | closes |
|---|---|---|---|---|---|---|---|---|
| **T11 voice, synth.js** | `src/inst/**` except `instrument.h`, `sampler*`, `synth_extra*`, `organ*` | `Instrument` for `inst.synth` (7 patches incl. hidden drone-osc), voice.js, allocator, `InstrumentService` (`get instruments` = `engine-api.json` list) | `synth-warm-pad`, `synth-glass-pad`, `synth-strings`, `synth-sub-bass`, `synth-bell` **exact** (every `exactIfPrngPorted` synth.js fixture passes the exact tier; PRNG draw order = JS); `synth-soft-keys` statistical (Q11); catalogue equality test | T01, T02, T11a | L | opus | ✔ | R6, R7 |
| **T12 sampler** | `src/inst/sampler*` | `Instrument` for `inst.sampler` | `sampler-salamander-piano`, `sampler-ep-rhodes`, `touch-soft`, `touch-hard`, `touch-fixed`, `touch-custom`, `touch-keyboard` exact (with T06's `pcmOverride` where R13 requires it); T17's 3 new sampler fixtures + `pan-mono-sampler`; JS `sampler` suite ported | T06, T11 (allocator), T11a | M | sonnet | ✔ | R13 (consumer) |
| **T13 Model: song & graph** | `src/model/model.cpp` + the T13 globs | prepare/commit/tokens/instSeq, reuse and **retire** (RetireInst/RetireStrip slots), routing, setParam dispatch with 10 ms coalescing, transpose/tempo/timeSig/keyContext, low resource, reverb policy, stats, getState | `auto-slot-level`, `auto-reverb-send`, `auto-delay-send`, `auto-master-volume` exact (`exactIfPrngPorted`) + T17's `routing-switch`; JS `supersededPrepare`, `gaplessSwitch`, `paramResetOnReuse`, `freshStripWheel`, `switchHeadroom`, `washAcrossCommit`, `morphAtCommit`, `beforeStartNoThrow`, `lowResource`, `restartKeepsState` ported | T02–T05 landed, T11 interface | L | opus | ✔ | R6 (test list), R8, R18 (Model side) |

## Wave 3: everything that plays (after T11, T12, T13)

| task | owns | implements | done | deps | size | model | Linux ✔ | closes |
|---|---|---|---|---|---|---|---|---|
| **T14 Model: perform** | `src/model/{perform,wheels,chords,sleep}*` | notes/pedal/mono/legato/pedalHold, wheels + pickup + macros, bend modes incl. tape, swell, panic, fadeOutAll, chords, sleep/wake queueing | `auto-modwheel-cc`, `auto-filter-cutoff`, `scene-glide` (exact where `exactIfPrngPorted`); `song-sunday-pad-piano`, `song-gospel-stab-b3` with T15/T16; T17's `transpose-octave`, `bend-normal`, `bend-tape`, `swell-8s`, `mono-legato`, `release-pedalhold`, `fadeout-panic`; JS `sustainDeferral`, `restrike`, `monoLowest`, `split`, `transposeFFT`, `stuckNoteFuzz`, `bendPitch`, `bendModes`, `chordReadout`, `macrosAndWheel`, `panicAndFade`, `sustainLongCap`, `sustainVariants`, `sustainRelease`, `sustainPedalHold`, `touchCurves`, `exprCurveAndPedalSwell`, `sceneGlide`, `sceneWheelGlide`, `pedalSwellLevelMoves`, `intensityMacroAndBrightness`, `padLikeIntensity`, `tapeBendStream` ported | T13, T12 | L | opus | ✔ | R12 (logic areas) |
| **T15 synth-extra + organ** (T15a/T15b) | `src/inst/{synth_extra,organ}*` | `inst.synth-extra` 10 patches, `inst.organ` 4 presets + rotary | `synth-808-sub` exact; `synth-juno-pad`, `synth-shimmer-pad`, `synth-pluck`, `synth-poly-stab`, `synth-analog-brass`, `synth-square-lead`, `synth-synth-bass`, `organ-gospel`, `organ-soft-pad`, `organ-full`, `organ-church` exact (`exactIfPrngPorted`); `synth-supersaw-pad`, `synth-dx-epiano` stay statistical at the manifest tolerance (Q11: audible result kept, FM compensations); `song-gospel-stab-b3` with T14 | T11 | L | opus | ✔ | R6 (Q11 named), R7 |
| **T16 drone** | `src/drone/**` | `Drone` unit, `DroneService`, set handler `drone.` | `drone-synth-2keys`, `drone-synth-stage` exact (`exactIfPrngPorted`); JS `droneKeyChange`, `droneChordFollow`, `droneSongChangeAndFiles`, `droneInstrumentReuse`, `droneParkGain0`, `droneFiles`, `droneFilesKeyRace`, `droneFilesNoHardCut`, `droneOffNoVoices` ported; **`drone-freeze-dry/-wet` blocked on Ryan's decision Q7** (keep freeze or re-classify) | T11, T04, T13 | M | sonnet | ✔ (AAC pads ✗) | R6 |

Critical path: T00b → T01 → T04 → T13 → T14 (R8), with T11a → T11 → T13 in parallel; `song-lofi-rhodes`
(statistical for good) closes with T14 + T12 + T05.

## Orchestrator-only items (not a task)

R22 (run `ctest -L golden` on the macos-14 CI leg; needs T17's decision on committed exact-tier WAVs), R24
(`third_party/chromium/LICENSE`, commit hashes for dr_libs and pffft in `third_party/README.md`), R33 (ARCHITECTURE
§8.2 tolerances: 1.5–16.4 dB, env-corr 0.73–0.95, −1 = off for 3 fixtures), R34 (3 lines > 120 outside core), the
ARCHITECTURE §3/§5 text for the rate-change rebuild list once T08 measures it, and removing the builtin units when
T02/T03 land.

## Verified only on the Mac or iPad

- AUHAL/RemoteIO render at 128-frame buffers, measured round-trip latency, xruns under load (Instruments).
- Device selection, hot-plug, default-device following, **aux click on outputs 3–4** of a 4-out interface; a device
  rate change during playback (the clock path is tested on Linux, the device re-open is not).
- CoreMIDI timestamps → engine time, jitter with and without `jitterFree`; **WebView round trip per note** (contract
  question 2) and `evaluateJavaScript` cost of 30 Hz ticks.
- WKWebView: `rig://` origin, **localStorage migration** from the Electron origin `127.0.0.1:8438` (import a backup on
  first launch; data-loss risk), file access to `~/Music/Worship Rig`, sandbox/entitlements, code signing.
- AAC/M4A decode through `ExtAudioFile` (My Samples, pads) and real GarageBand-imported content.
- CPU targets on Apple silicon and the oldest supported iPad; NEON paths of pffft and the direct FIR.
- iPad: AVAudioSession interruptions, background audio with the screen off, jetsam headroom (memory warnings →
  `rig_host_memory_pressure`), USB interfaces with 4 outputs.
- App size (no Electron: expect ≈ 100 MB vs 365 MB today).
