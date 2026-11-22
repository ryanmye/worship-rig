# Native engine build plan (2.0)

How the C++ core, the JS shim and the Apple shell get built by parallel agents. Architecture:
`native/docs/ARCHITECTURE.md` (modules M1–M17). Behaviour: `native/docs/ENGINE_CONTRACT.md`. C API:
`native/core/include/rig/rig_engine.h`. Findings referenced as "R*n*" are `native/docs/SETUP_REVIEW.md` §3 numbers.
This file was rewritten by T00b (interface freeze), corrected by the wave-0b verifier (`WAVE0B_REVIEW.md`, "V*n*"),
updated by the wave-1 integrator (results, carry-overs, T00c; fixture status in `PARITY.md`, frozen-interface
changes in `INTERFACE_LOG.md`), and is true as of that step; the orchestrator keeps it true.

**Done** for every core task = (1) the listed golden ids pass `node tools/golden/compare.mjs` on WAVs from
`rig_render` (= `rig-golden`), wired as ctest `golden.<task>` by adding `native/core/tests/golden_ids/<task>.ids`;
(2) the listed unit tests (doctest, `TEST_SUITE("<name>")` → ctest `unit.<name>`); (3) clean configure + build +
`ctest` on g++ 13 and clang 18 (Release) and g++ ASan+UBSan, `-Wall -Wextra -Wpedantic -Wshadow -Wconversion
-Werror` (clang has no sanitizer runtime on this box: clang UBSan only as `-DCMAKE_CXX_FLAGS="-fsanitize=undefined
-fsanitize-trap=all"`, clang ASan only on CI/Mac; V4); (4) the allocation trap stays on in the golden path; (5) the
findings named in the task are closed or explicitly handed on in the report. "Linux ✔" = (1)–(4) are fully
checkable on this box.

## Rules (every task)

- **Edit only what the task owns** (globs below). Everything else is read-only; a needed change in a file you do not
  own goes into your report as an exact diff for the orchestrator.
- **Adding a module = adding files.** CMake globs: every `src/**/*.cpp` is compiled into `rig_core` (except paths with
  `/third_party/`); every `src/**/*_register.cpp` is a registration point (`api/registry.h`; the function name is
  `rig_register_<path below src, non-alnum → _>`, e.g. `src/fx/reverb_register.cpp` → `rig_register_fx_reverb`);
  every `src/**/*.cmake` is an include hook run after `rig_core` exists (vendored include dirs as `SYSTEM`, per-file
  flags, vendored sources); every `tests/**/*.cpp` is a test source and each `TEST_SUITE("x")` becomes ctest `unit.x`
  (`realtime` → `rt.realtime`); every `tests/golden_ids/<name>.ids` (one id per line) becomes ctest `golden.<name>`
  (reported **Skipped**, not Passed, when a golden WAV is absent: `native/golden/out/` is git-ignored; V5).
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
  with the BSD-3 notice; the licence text is `third_party/chromium/LICENSE` (V9). Blink C++ that calls `fdlibm::`
  uses `rig::fdlibm`; anything JavaScript computes uses `rig::js` (`src/num/README.md`); never `<cmath>`
  transcendentals on a parity path.
- **Frozen module headers** (table below) are orchestrator-owned even where an owner glob covers them; the
  implementing task may only append in the region the header marks ("T05 appends below") and reports it.
- **Vectors from Chromium**: a task that needs single-node reference vectors adds its own
  `tools/golden/vectors/dump-<module>.mjs` + `tools/golden/vectors/data/<module>*.txt` (shared helpers in
  `tools/golden/vectors/lib.mjs`, frozen) and reads them from its own test.
- **The bridge already dispatches every op** to the `Model` method / service (V1): a module reaches `song`, `click`,
  `drone`, `cache`, `config`, `rec`, `midi`, `get instruments|sampleStatus` by registering its service; nobody edits
  `bridge.cpp` for that. A missing service answers `unsupported`.
- Parity-relevant PRNG use follows the JS draw order exactly (stream names from the manifest `randomness` field);
  each instrument/FX task promotes its own `exactIfPrngPorted` fixtures (R7) instead of a late pass.

## Frozen interfaces (T00b; change only through the orchestrator)

| interface | file | implemented by |
|---|---|---|
| `Command` 64 B / `AudioEvent` 32 B, core `Op` values, **opcode range table**, `kSubOwnedPayload`, `GarbageKind` | `src/runtime/command.h` | core |
| `Unit` (process / apply / param / setSampleRate / liveVoices / giveBack), `Bus`, `UnitIO`, `RenderContext`, `UnitSlot` (105 fixed slots since T00c: 16 inst + 16 strip, 32 + 32 retiring, drone, reverb, delay, chorus, lofi, master, click, meter, recorder), `paramTarget()`, send buses, `Owned` | `src/graph/unit.h` | every unit |
| fixed render topology, lock-free rate hand-off, `TimeBase`, epoch | `src/graph/graph.{h,cpp}`, `src/graph/epoch.h` | core |
| TestHooks TAP (10) / INJECT (7) tables = `tools/golden/page.js` key for key (test `unit.t00b` parses page.js) | `src/graph/test_points.h` | core + MasterChain local points |
| Registry: unit factories by kind, set handlers by row prefix, services by name; `UnitEnv`, `UnitSpec`, `UnitInfo`, `SetRequest` | `src/api/registry.h` | every module |
| `Model` public methods = contract §1 one to one + module helpers (`attachUnit`, `sendUnitOp`, `sendOwned`, `moveParam`, `setParamAt`, `frameFor`, `service<T>()`, `warn`) | `src/model/model.h` | T13/T14 bodies |
| resolved patch structs (`SlotPatch`, `ReverbPatch`, `DelayPatch`, `ChorusPatch`, `LofiPatch`, `MasterPatch`, `DronePatch`, `SongState`), `storeRow` | `src/model/patch.h` | core |
| services `CacheService`, `InstrumentService`, `ReverbService`, `ClickService`, `MidiService`, `DroneService`, `MeterService`, `RecService`; `EnginePaths` | `src/model/services.h` | T06, T11, T04, T07, T07, T16, T08, T08 |
| `BufferCacheApi`, `SampleBuffer` | `src/model/buffer_cache_api.h` | T06 |
| `Instrument` virtuals (noteOn/noteOff/allNotesOff/kill/sustain/setBend/legatoTo/setParam/releaseVoice/outputChannels, `setVoiceCap` since T00c) + core-op decode | `src/inst/instrument.h`, `src/graph/instrument_apply.cpp` | T11, T12, T15 |
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

Kinds the skeleton Model attaches by itself: per channel `inst.<instrument.type>` + `strip` at every commit (channels
0 .. max(song slots, 4) − 1 since T00c); once, at `audio start` / first commit, `reverb delay chorus lofi master click
drone meter rec` when registered (`lofi` skipped with `RIG_FLAG_NO_LOFI`). Builtin (priority 0): `inst.test` (test
voice, 128-voice pool with the D1 cap); T00c removed the builtin `strip` and `master` (T02/T03 are the only ones).
A wave-1 module therefore reaches its golden fixtures through `rig_render` by registering its kind plus its `set`
handler prefix; nothing else.

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
| `src/graph/**` | orchestrator (frozen; the `strip` / `master` builtins were removed by T00c) |
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
| `src/inst/instrument.h` | orchestrator (frozen) |
| `src/inst/**` except `instrument.h`, `sampler*`, `synth_extra*`, `organ*` | T11 |
| `src/inst/sampler*` | T12 |
| `src/inst/{synth_extra,organ}*` | T15 |
| `src/drone/**` | T16 |
| `third_party/**` (incl. `third_party/chromium/LICENSE`) | orchestrator (T01's `src/num/llvm_libc/` is T01's) |
| `tools/common/**`, `tools/rig_render/**` | orchestrator (frozen; knows every manifest setup key and event type) |
| `tests/helpers.h`, `test_main.cpp`, `test_modules_init.cpp`, `alloc_trap.cpp`, `test_t00b_api.cpp`, `test_clock.cpp`, `dummy_module/**`, `fixtures/**`, `test_params.cpp`, `test_third_party.cpp`, `test_voice.cpp`, `test_wav.cpp`, `test_golden.cpp`, `test_click_record.cpp`, `test_offline_midi.cpp` (integrator) | orchestrator |
| `tests/test_param.cpp`, `tests/num_*`, `tests/time_*` (incl. `time_num_tests.cmake`) | T01 (done) |
| `tests/samples_*` | T06 (done) |
| `tests/test_biquad.cpp`, `tests/golden_ids/eq.ids` | T02 |
| `tests/test_bridge.cpp`, `test_offline.cpp`, `test_queues.cpp`, `test_realtime.cpp` | T08 |
| new `tests/test_<module>*.cpp`, `tests/<module>/**`, `tests/golden_ids/<task>.ids` | the task that creates them |
| outside core: `tools/golden/**` except `vectors/**` (T01; new `dump-<module>.mjs` + `data/<module>*` = the task that adds them) and `decode-dump/**` (T06); `native/golden/**` | T17 (done; later fixture edits through the orchestrator) |
| outside core: `app/js/engine-bridge/**`, `test/unit/engine-bridge/**`, `native/devhost/**` (incl. its vendored miniaudio) | T09 |
| outside core: `native/apple/**` | T10 |
| `native/docs/**`, `native/contract/**`, `.github/workflows/native-core.yml` | orchestrator |

## Wave 0b (done): T00b interface freeze, T01, T06, T17, shell follow-ups, verifier

Verifier (`WAVE0B_REVIEW.md`): clean build + ctest 22/22 on g++ 13 / clang 18 Release, g++ ASan+UBSan, clang UBSan
(trap), g++ TSan (runtime suites); 22/108 fixtures pass through `rig_render` (18 `eq-*`, `eq-chain-8band`,
`pan-stereo-src`, and the silent `reverb-dry` / `echo-none`). It closed R1(f) (bridge op dispatch, V1), taught
`fixture_runner` T17's setup keys and events (V2), made missing goldens skip (V5), added
`third_party/chromium/LICENSE` (V9), and fixed the ownership holes (V3) and the fixture names below (V7).


Closed R1, R2, R3 (by creating T11a), R15 (hand-off: atomic rate request, adopted on the audio thread; graph rate is
no longer written by the host thread), R16 (monotonic clock + test), R21a, R21b, R25 (core side: design note in
`Engine::requestAudio`; the shell fix is T10's). Test `unit.dummy-module` (`tests/dummy_module/`) registers a unit
kind, a module opcode, a set handler and a service from its own directory and is rendered, tapped and injected
through the C API.

## Wave 1: independent modules (finished; results below the table)

**Startable now:** T02, T03, T04, T05 (delay part at once; chorus/lofi parity after T11a and T03's WaveShaper), T07
(MIDI part at once; click parity after T11a's BufferSource), T08, T09, T11a. Done: T01, T06, T17, shell follow-ups
(T10: R25, R27–R29 written, unbuilt). Run at most 5 at once on this box; order by critical path (R8): **T04 first**,
then T11a and T03 (they unblock T05/T07), then T02, T08; T05, T07, T09 when a slot frees. No wave-1 done list names
a fixture that needs a wave-2/3 instrument (V8: `pan-mono-src` moved to T15).

| task | owns (see table) | implements (interface) | done = fixtures / tests | deps | size | model | Linux ✔ | closes |
|---|---|---|---|---|---|---|---|---|
| **T01 time & numerics** (done) | `src/num/**`, `src/time/**`, `tests/test_param.cpp`, `tests/num_*`, `tests/time_*`, `tools/golden/vectors/**` | M4/M5 behind `wa::Param`, `TimerQueue`, `hashSeed`, `rngFor`, JS `String(n)`, JS math | done: `unit.num` (17 fns bit-exact vs Chromium; verifier: 0 / 340 k fresh cases), `unit.time` (45 Chromium automation curves bit-exact), `unit.param` | T00b | M | opus | ✔ | R14, R17 (Param header) |
| **T02 filters & strip (extend)** | as table | `SlotChannel` (`strip`, incl. `StripOp::EqAudition`), `MasterEq`, `DelayLine`, panner/gain | **extend** the passing biquad + SlotEq (keep `golden.eq` = 18 `eq-*` exact green at every step); keep `eq-chain-8band`, `pan-stereo-src` green (pass on the builtin strip today); `width-0`, `width-50`, `width-150`, `eq-type-change` (type/band change fade + `eqAudition`; `Model::eqAudition` needs a module strip), `eq-legacy-rows` exact; `MasterEq` unit test against the `master-eq` golden (impulse through `MasterEq` alone; the fixture itself is T03's); StereoPanner mono + stereo law vectors from an OfflineAudioContext (own `dump-panner.mjs`, ≤ 1e-6); JS `filterQButterworth`, `slotWidthEq`, `dualMonoIdentity` ported | T00b, T01 (done) | M | sonnet | ✔ | R5, R12 (EQ/pan rows) |
| **T03 dynamics & master chain** | as table | `MasterChain` (`master`, local taps `fx.eqOut`/`fx.master`, inject `fx.preComp`), set handlers `fx.eq.`, `fx.comp.`, `master.`, `WaveShaper`, mono output (`config {mono}` → a service's `onSongState` → `MasterOp`) | `master-eq` (with T02's `MasterEq`; stub until it lands), `glue-50`, `glue-100`, `glue-100-bursts`, `limiter-steps`, `limiter-steps-hot`, `limiter-bursts-hot` exact; JS `masterEqGlue`, `monoCeilingAndMakeup`, `glueEngageNoDip` ported; WaveShaper curve + 4x latency unit tests vs Chromium vectors (own `dump-waveshaper.mjs`); mono-sum unit test (`fx-row-sweep` is T13's) | T00b, T02 (MasterEq) | L | opus | ✔ | R17 (compressor, Up/DownSampler) |
| **T04 reverb** (start first) | as table | `Reverb` (`reverb`), `ReverbService`, set handler `fx.reverb.` | `reverb-dry` exact (digital silence: passes before any code, so it is not evidence); `reverb-room`, `-stage`, `-hall`, `-cathedral`, `-wash` **exact** (all `exactIfPrngPorted`, T01's PRNG has landed; report each for promotion); `ReverbService::retain` (used by T13's `switch-retire-retain`); IR bit-exact vs a JS `irGen` dump; convolver vs direct convolution ≤ 1e-6; `rig_bench` reverb unit ≤ 8 % of one core on this box at 48 kHz (fails the task above); memory capped in bytes (LRU by bytes, default 32 MB iPad) with a unit test; JS `irRecipe`, `predelayNoWarp`, `reverbDeferWhilePlaying`, `reverbQuietGate`, `reverbRetain` ported (`undampedOptIn` is a sampler test: moved to T12) | T00b, T01 (done) | L | opus | ✔ (Mac CPU ✗) | R6 (bench), R8, R19 |
| **T05 delay, chorus, lofi** | as table | `Delay`, `Chorus`, `Lofi`; set handlers `fx.delay.`, `fx.chorus.`, `fx.lofi.` | `echo-none` (silent golden, not evidence), `echo-slapback`, `echo-quarter`, `echo-dotted`, `echo-ambient-echo`, `echo-dotted-noise` exact; `lofi-crush-sweep` exact; `chorus-default-sine`, `chorus-fast-deep-noise` exact (`exactIfPrngPorted`; `chorus-default-sine` has its envelope check off, so exact is the real test); tempo arrives through the `song` op → `Service::onSongState` (V1); `lofi-tape-sine` statistical (stays); JS `lofiBypassExact`, `delaySync`, `lofiEngageNoClick`, `lofiHeadroom` ported | T00b; T11a (Oscillator, BufferSource, ConstantSource) for chorus/lofi; T03 WaveShaper for lofi | M | sonnet | ✔ | R3 (consumer) |
| **T06 samples & cache** (done) | `src/samples/**`, `tests/samples_*`, `tools/golden/decode-dump/**` | `BufferCacheApi`, `CacheService` (`cache`) | done: raw decode ≤ 1e-4 on 20/20 at 44.1 and 48 kHz, after `processSample` 17/20 at 44.1 kHz ⇒ **`pcmOverride` is mandatory for exact sampler fixtures** (`RIG_SAMPLES_PCM_OVERRIDE` + `tools/golden/pcm.mjs` dumps); `unit.samples_*` | T00b | M | sonnet | ✔ | R6, R13, R20 |
| **T07 click & MIDI** | as table | `Click` (`click`), `ClickService`, `MidiService` | `click-120-44`, `click-90-68-countin` exact; parser vectors from `midi.js`; MIDI-clock pulse times vs `metronome.js`; port table from `rig_host_midi_ports` replaces the uint16 hash (needs T08 to forward port ids); `click`/`midi` ops already reach `ClickService`/`MidiService` (V1); JS `clicksStealsDelay`, `clickDetectorSelfTest` ported | T00b, T01 (done), T11a (BufferSource) for click parity | M | sonnet | ✔ | R11 (G4), R21c, R21e |
| **T08 bridge & runtime** | as table | all 14 ops/9 events over the `Model` methods (dispatch for every op exists since V1; T08 keeps it, adds validation/conformance, and wires `play bend`, `fade`, `input` + `song routing` when T14 lands), control thread, workers, clock map, FIFO, tick builder, `MeterService`, `RecService` | conformance tests generated from `engine-api.json` (every op, every error code); TSan soak 10 min with a fake host at 128/256/441-frame blocks; rate-change test kept + what is rebuilt on a rate change documented and tested (each `Service::onRateChanged`); `Dropped` event handling (ended bits scan, Garbage never dropped: separate ring; today `Unit::giveBack` leaks on a full ring); `audio_start` watchdog (no blocking of the control thread); G3, G5, G6 (idle tick ≥ 8 Hz or cap 0.5 s), G7, G8, G9 conformance; JS `audioSleep`, `idleArm`, `idleDisarm`, `fxIdleSleep`, `slotLevelTap`, `restart`, `irOffMainThread` ported where engine-side | T00b | L | opus | ✔ | R11, R15 (soak), R16 (rebuild list), R18, R21d, R25, R26 |
| **T09 web shim & Linux dev host** | `app/js/engine-bridge/**`, `test/unit/engine-bridge/**`, `native/devhost/**` | devhost (core + miniaudio, vendored by T09 under `native/devhost/third_party/` with its licence, + WebSocket), WebSocket transport, `NativeRecorder` facade over `rec` (G10) + the one-line recorder.js selection Ryan approves | existing 89 bridge tests stay green; recorder facade tests against a recorded log; `ui-core` Perform suite against `rig-devhost` (opt-in flag) | T00b (T08 for end to end) | M | sonnet | ✔ | R4, R10, R11 (G10, G11) |
| **T10 Apple shell (extend)** | `native/apple/**` | the existing skeleton: R25 `queue.async`, R27 `WKNavigationDelegate`, R28 string transport, R29 tick coalescing, R30, R31; calls `rig_host_memory_pressure` / `rig_set_paths` | **UNBUILT here**; Mac checklist below | header only | L | opus | ✗ | R25, R27–R31 |
| **T11a DSP sources** (new) | `src/dsp/{oscillator,periodic_wave,buffer_source,constant_source}*` | `wa::Oscillator`, `wa::PeriodicWave`, `wa::BufferSource`, `wa::ConstantSource` (Chromium 157 ports) | single-node vectors rendered by an OfflineAudioContext (T11a writes `tools/golden/vectors/dump-sources.mjs`; T17 added none): sine/square/saw/triangle + custom PeriodicWave (chorus LFO shape `real=[0,sinφ]`) at 5 frequencies incl. < 20 Hz, ≤ 1e-5; BufferSource repitch 0.5/1/1.5/2.03, sub-sample start, loop points, `ended` timing; ConstantSource with automation | T00b, T01 (done) | M | sonnet | ✔ | R3, R17 (PeriodicWave, BufferSource) |
| **T17 golden promotion + new fixtures** (done) | `tools/golden/**` (minus T01/T06 dirs), `native/golden/**` | 21 new fixtures (108 total), `COVERAGE.md`, `pcm.mjs`, Chromium pin | done: 102/102 PARAMS rows, 23/23 sample sets (verifier recomputed both from `engine-api.json`); `compare.mjs --self-test` green; promotion of `exactIfPrngPorted` fixtures continues per task report (`tools/golden/promote.mjs`, orchestrator runs it) | none | M | sonnet | ✔ | R7, R12, R33 numbers; R22 open (goldens not committed) |

### Wave 1 results (integrator pass, 2026-11-20)

Integrated tree, fresh build dirs `native/core/build-int{,-clang,-asan}` (+ `-tsan` for the runtime suites):
ctest **47/47** on g++ 13 Release, clang 18 Release and g++ ASan+UBSan (no sanitizer report; 243 doctest cases, 267 080
assertions; 0 compiler warnings under `-Werror`), g++ TSan 16/16 runtime suites (`queues offline bridge realtime runtime
soak clock rec meter click midi dummy-module` + the two new ones) with no TSan report, plus a 120 s TSan soak (25 833
renders, 4126/4126 replies, 13 rate changes, 0 events dropped, 0 garbage parked); `node test/run-all.mjs --only unit`
505 pass / 0 fail / 9 skip; `compare.mjs --self-test` OK; engine-api.json up to date. All 108 fixtures through
`rig_render` + `compare.mjs`: **50/108 pass**, all 50 also at the exact tier; g++ and clang renders byte-identical
(per fixture: `PARITY.md`). Frozen-interface changes: `INTERFACE_LOG.md`.

| task | verdict | review | done fixtures (all pass) | open items → carried to |
|---|---|---|---|---|
| T02 filters & strip | **done** (VERIFIED) | [T02](reviews/T02.md) | 18 `eq-*`, `eq-chain-8band`, `eq-legacy-rows`, `eq-type-change` (golden re-rendered by the integrator), `pan-stereo-src`, `width-0/50/150`: max\|diff\| 0 | #2, #4 → T13; #3 → T17 follow-up |
| T03 dynamics & master | **done** (VERIFIED) | [T03](reviews/T03.md) | `master-eq`, `glue-50`, `glue-100`, `glue-100-bursts`, `limiter-steps`, `limiter-steps-hot`, `limiter-bursts-hot` (≤ 2.5e-7) | O1 closed (integrator); O3 → T03 follow-up (only if a 4x fixture needs < 1e-6); O4 → T13 (`fx-row-sweep` promotion); O6, O7 (`WaveShaper::reset`, frozen header), O8 (delete `master_chain_eq_fallback.cpp` + hook) → T00c |
| T04 reverb | **partial** (memory cap) | [T04](reviews/T04.md) | `reverb-dry` (silent golden), `reverb-room/-stage/-hall/-cathedral/-wash` (≤ 3.7e-9, promoted to exact) | finding 1 (byte cap ignores slot state: iPad ≈ 2× the 30 MB budget) → **T00c** (memory budget, with D3); 2 (FTZ/DAZ contract: every render entry inside `rt::RenderScope`) → T09/T10 note; 3 (5th overlapping space hard-cuts a fading unit) → T04 follow-up or T13 commit debounce; 4 (`wa::Param` 64-event capacity vs far-ahead fades) → T13 note; 5 → done (moved to T12) |
| T05 delay/chorus/lofi | **done** (VERIFIED) | [T05](reviews/T05.md) | 6 `echo-*` (`echo-none` silent golden), `lofi-crush-sweep`, `chorus-default-sine` (promoted to exact), `chorus-fast-deep-noise`, `lofi-tape-sine` | R1 closed (integrator: contract §3.5 + `delay.h`); R2: `chorus-fast-deep-noise` → T11a follow-up (bit-exact custom PeriodicWave); R3 → T17 follow-up (`echo-time-switch`, `echo-panic`, `lofi-toggle`); R4, R5 → T05 follow-up; R6 → T14 (re-send `lofiHold` after a rate change) |
| T07 click & MIDI | **done** after the integrator's O1/O2/O3/O5 | [T07](reviews/T07.md) | `click-120-44`, `click-90-68-countin` (bit-exact) | O1, O2, O3, O4, O5 closed (integrator); O6 (`jitterFree` = device buffer + 1 quantum, not + 128) → T07 follow-up, measured on the Mac; O7 (direct-path refcount vs controller's `ui`/`kb` sources) → T14 + contract note; O8 (`{type:'learned'}` event) → T07/contract; O9 (`countIn` 1.5 truncation) → T08 nit; O10 (`ClickUnit::dropped_` unsurfaced) → T07 |
| T08 bridge & runtime | **done** (PARTIAL → closed by integrator's ctest fixes) | [T08](reviews/T08.md) | none (no fixtures); no regression in any `golden.*` | 1 (slot meters omit retiring strips: needs the origin slot at retire) → T13 + orchestrator `graph.cpp`; 2 (dedupe id-less `warn`s) → T08 follow-up; 3 (`rig_destroy` blocks if `audio_start` never returns) → documented in `rig_engine.h`; bounded join → T10; 4 (RTA Chromium vector, `dump-analyser.mjs`) → T08 follow-up; 5 closed (integrator) |
| T09 web shim & devhost | **partial** (ui-core needs T11/T14) | [T09](reviews/T09.md) | none; ui-core Perform via `rig-devhost` **21/76** = baseline (`PARITY.md`) | 1 (late replies reach a replaced page) → T09 + T08 (page epoch in `hello`, contract); 2–6 (`--channels`, `strtoul`, `--log` on the control thread, `hello` whitespace, check the e2e take's peak) → T09 follow-up; 7 (Playwright pins 1194, box has CfT 157 as "1243") → environment, `PARITY.md`; 8 → re-run after T11, T14 |
| T11a DSP sources | **done** (PARTIAL: FM accuracy) | [T11a](reviews/T11a.md) | none (146 single-node Chromium vectors, worst 9.5e-6) | O1 (FM error ∝ depth: exact FM needs RustFFT f32 tables) → T15 only if an exact FM fixture is wanted; O3 (never skip `process()` on a started source) → T11/T13; O4 (rebuild PeriodicWaves on `RateChanged`) → T11/T16; O6 (more `ended` cases) → optional |

Closed by the integrator (tests/files it owns now): `unit.clock` expects the documented 6 ms master look-ahead
(`floor(0.006 · rate)` frames, contract 3.8; the look-ahead stays); `unit.golden-analytic` picks its silent probe
from the manifest (first single-instrument fixture whose instrument is reported unsupported; today
`synth-warm-pad`) instead of `click-120-44`; T07 O1 (click reaches the recorder only with `record:true`, meters
pre-click, destination unchanged; `unit.click-record`), O2 (`SongState.newBar`, INTERFACE-CHANGE(T07); dump-click
cases `songswitch-newbar-*`), O5 (offline `rig_midi_in` drained at the next post / quantum; `unit.offline-midi`);
`eq-type-change` re-rendered and listed in `t02.ids`; the 6 promotions; T05 R1 docs; T08's `rig_engine.h` threading
note. T05's `delay_register.cpp` (clang `-Werror` unused variable) and T07's `click_unit.cpp` compile cleanly from
fresh dirs on both compilers. CI (`.github/workflows/native-core.yml`, review V11 / R22): a `goldens` job renders
the non-committed goldens of every `tests/golden_ids/*.ids` id with Chrome for Testing 157.0.8103.78
(`tools/golden/ci-goldens.mjs`, refuses another Chromium), cached by the manifest + id-list hash, handed to the test
jobs as an artifact; macOS leg on `macos-15`. UNVERIFIED until pushed (YAML parse-checked; `ci-goldens.mjs
--out-dir` run here: 40 rendered, 39 byte-identical to the manifest, `lofi-tape-sine` within Chromium's own repeat
noise).

Plan corrections found by the integrator (applied in the rows below): `touch-*` play `synth:808-sub` (synth-extra,
T15) through the velocity curve → moved from T12 to T14 (with T15); T13's four `auto-*` fixtures play organ /
`synth:pluck` (T15) → they close after T15 unless T17 adds synth.js twins; `song-lofi-rhodes` plays
`synth:soft-keys` (T11), not a sampler; 10 of the 16 `synth-*` ids are synth-extra patches under instrument type
`synth`, so T11's `inst.synth` factory must dispatch those ids to T15 (hook in T11's files) instead of a separate
kind; the 22 instrument goldens on disk do not match their manifest sha256: re-render them before T11/T12/T15
compare (`PARITY.md`).

## T00c: scale-out amendment (DONE 2026-11-20; serial, orchestrator; after the wave-1 integrator, before T13)

Ryan's decisions D1–D3 (`DECISIONS.md`) change frozen interfaces, so one orchestrator step lands them all, logs each
change in `INTERFACE_LOG.md`, and re-runs the integrator's gate (ctest on the three configs + TSan runtime suites,
50/108 fixtures unchanged). What each touches in the core:

| D | contract / engine-api | opcode / C API | model / patch | graph sizing | memory / CPU budget | tests |
|---|---|---|---|---|---|---|
| **D1** polyphony 32/64/128 (default 64) per slot | ENGINE_CONTRACT §2 voice caps (today 16 synth/organ, 32 sampler) → setting `config {polyphony}` (or the Settings row Ryan picks) + `get state` echo; stealing policy unchanged | a core `Op::VoiceCap` (aux = cap) decoded in `graph/instrument_apply.cpp` into a new `Instrument::setVoiceCap(unsigned)` virtual (default no-op), or `UnitSpec::voiceCap` at attach + the op live | `Model` stores the cap, applies it at every instrument attach and on change | none in the graph; instrument pools sized for 128 per slot (no allocation on the audio thread), cap enforced at note-on; `rig_meters.voices` unchanged | 128 × 16 slots × voice state per instrument kind: add to ARCHITECTURE §7; the global ceiling across slots (orchestrator proposal, **needs Ryan's word**) sized from the oldest-iPad CPU measurement (Mac list) | allocator unit test with > 16 notes under the pedal (no web golden exists); goldens unaffected (≤ 16 voices) |
| **D2** buffer 64/128/256/512 (default 128) | `audio` op gains `bufferFrames`; the `state` event reports the granted size; reported latency (`hostLatency`, G7) follows the actual size | `rig_host` (struct_size-gated, additive): the requested buffer frames reach the host, e.g. a `uint32_t buffer_frames` argument through a new `audio_start_frames` callback used when non-null; `rig_device_info.buffer_frames` (exists) reports the grant | Engine/Model keep the request across restarts | none: the engine renders 128-frame quanta; the FIFO (exists) adapts; 64 = two host callbacks per quantum, so the render cost lands on every other callback | measure xruns at 64 on Linux (`rt.realtime`, devhost) and the Mac (Mac list) | FIFO at 64/192/256/441/512-frame blocks in `rt.realtime` + soak; bridge conformance for the new field; devhost `--buffer`, Apple AUHAL `kAudioDevicePropertyBufferFrameSize` / `AVAudioSession.setPreferredIOBufferDuration` (T10) |
| **D3** 1..16 slots | params grammar `slots.<i>` i < 16 (regenerate `src/params/params_gen.inc` with `tools/gen-params.mjs`), engine-api.json, ENGINE_CONTRACT (slot-indexed ops: play routing, `eqAudition`, `slotLevel`, wheels / pedal routing, MIDI learn targets) | `rig_meters.slot_peak/slot_rms` [4] → [16] (struct_size-versioned); bridge validation 0..15; meter tick `slots` length = the song's slot count (`Engine::buildTick` loops 4 today) | `PatchSpec.slots` / `SongState`-adjacent arrays 4 → 16 (song carries 1..16 used slots), `stripSlot/instSlot` helpers, `MeterService` subscriptions | `UnitSlot` table: 16 inst + 16 strip channels, retiring channels sized for 16 (≥ 1 per slot; today 16 for 4), `kChannels` 16, send buses unchanged, test points `slot0/1.pan` unchanged | 16 samplers exceed the iPad budget: `CacheService` cap + pin policy (T06 code); **T04 finding 1 lands here** (count `ConvUnit` slot state in `ReverbPool::bytes()`, evict Idle slots first; test with the iPad profile); 16 × D1 voices → the D1 ceiling | slots 4..15 as copies of the slot-0 path (unit + bridge tests); a native-only 16-slot fixture for CPU and memory (`rig_bench`); the web oracle stays at 4 slots for goldens |

Also in T00c (small frozen-file items already reviewed): T03 O7 `WaveShaper::reset()` hook (frozen `dsp/waveshaper.h`)
and O8 (delete `mix/master_chain_eq_fallback.cpp` + `master_chain.cmake`), T08 #1 origin slot of retiring strips in
the slot meters (`graph.cpp`), and removing the `strip` / `master` builtins now that T02/T03 landed.

### T00c results (2026-11-20)

Landed D1 (per-slot cap, `config {polyphony}`, `Op::VoiceCap` → `Instrument::setVoiceCap`), D2 (`audio
{bufferFrames}`, `rig_host.audio_start_frames`, granted size in `state`, FIFO residue in `latencyMs` / `hostLatency`,
devhost `--buffer`, Apple request path UNBUILT), D3 (16 slots everywhere in the core), T03 O7 / O8, T04 finding 1,
T08 #1, the builtin `strip` / `master` removed; the global voice ceiling is NOT built (open question in
`DECISIONS.md`). Every change: `INTERFACE_LOG.md` 11-23. Gate (snapshot of the tree without the in-progress T11/T12
files, build dirs `build-t00c{,-clang,-asan,-tsan}`): see the T00c report; the 50 passing fixtures render
byte-identical WAVs to the integrator's build. Tests: `unit.t00c` (16-slot prepare/commit, meters, routing copies of
slot 0, bridge validation, polyphony, allocator, retire metering, FIFO, cache hard cap / pin budget, reverb iPad cap,
CPU) and `rt.realtime` (D2 host request, realtime FIFO at 64/192/256/441/512, soak).

**What changed under T13** (read before starting):
- `UnitSlot` numbers: Inst0..15 = 0..15, Strip0..15 = 16..31, RetireInst0..31 = 32..63, RetireStrip0..31 = 64..95,
  Drone 96 … Count 105. Use `instSlot(i)`, `stripSlot(i)`, `retireInstSlot(j)`, `retireStripSlot(j)` and
  `isInstSlot` / `isRetireInstSlot` / `isRetireStripSlot`, never numbers. `kChannels` = 16, `kRetiring` = 32 (two per
  slot: two back-to-back switches of 16-slot songs).
- Retire = MOVE, not re-attach: `Model::moveUnit(instSlot(i), retireInstSlot(j), when)` and
  `moveUnit(stripSlot(i), retireStripSlot(j), when)` (`Op::MoveUnit`; state kept, `attachedKind` and tracked param
  values move with it). A strip moved from `Strip<i>` keeps metering slot i (`rig_meters.slot_*_all[i]`,
  `slot_retiring[i]`; T08 #1 closed). Retiring channels never get `NoteOn` (graph rule); `kAllSlots` ops reach them.
- `PatchSpec.slots[16]` + `slotCount` (entries of `patch.slots`, 0..16; > 16 is rejected at parse). The skeleton
  commit keeps channels 0 .. max(slotCount, 4) − 1 and detaches the rest; T13's policy must keep "4-slot songs
  behave exactly as the web engine" (goldens) and treat slots 4..15 like slot 0.
- `Model::attachUnit` sends `Op::VoiceCap` after every instrument attach: keep using it (or send the cap yourself).
  `Model::setPolyphony` re-caps live instruments with `kAllSlots`.
- `rig_meters.slot_count` is set by the bridge after a commit (`Graph::setSlotCount`); `Engine::buildTick` emits
  max(4, slotCount) slot pairs.
- Memory: sampler slots beyond the hard cap get refused buffers (null `ready`, url marked failed for the retry
  window): T12's sampler must play what it has and report `sampleStatus` failed for those.
- T11/T12: implement `setVoiceCap` (pools of 128, cap at note-on, steal oldest released then oldest held; the test
  voice in `graph/builtin_units.cpp` is the reference) and report your per-voice bytes and µs per quantum
  (ARCHITECTURE 7.1: the test voice's one `wa::Param` is 6.7 KB, 865 KB per 128-voice instrument).

**Wave 2 against T00c.** T11 **can start now**: synth.js patches, voice.js DSP over T11a's sources, PRNG draw order,
`InstrumentService` / `get instruments`, the synth fixtures, and its allocator with pools sized for 128 and a cap
(default 64) held in T11's own code until T00c wires the setting; it also owns the synth-extra dispatch hook. T12
**can start now** on the sampler voice and the `pcmOverride` path (T06), taking the allocator from T11 as soon as
T11 publishes it; its cache-budget work follows T00c (D3). **T13 waits for T00c**: slot count, the `UnitSlot` table,
`PatchSpec` arrays, retiring channels and the params grammar all change under prepare/commit/retire/routing.

## Wave 2: instruments and the Model (DONE 2026-11-21; results and carry-overs in "Wave 2 results" below)

| task | owns | implements | done | deps | size | model | Linux ✔ | closes |
|---|---|---|---|---|---|---|---|---|
| **T11 voice, synth.js** | `src/inst/**` except `instrument.h`, `sampler*`, `synth_extra*`, `organ*` | `Instrument` for `inst.synth` (7 patches incl. hidden drone-osc), voice.js, allocator, `InstrumentService` (`get instruments` = `engine-api.json` list); allocator pools for 128 voices, cap per D1 (T00c wires the setting); the `inst.synth` factory dispatches synth-extra ids to T15 through a hook in T11's files; T11a O3/O4 (never skip `process()` on a started source; rebuild PeriodicWaves on `RateChanged`) | `synth-warm-pad`, `synth-glass-pad`, `synth-strings`, `synth-sub-bass`, `synth-bell` **exact** (every `exactIfPrngPorted` synth.js fixture passes the exact tier; PRNG draw order = JS); `synth-soft-keys` statistical (Q11); catalogue equality test | T01, T02, T11a | L | opus | ✔ | R6, R7 |
| **T12 sampler** | `src/inst/sampler*` | `Instrument` for `inst.sampler` | `sampler-salamander-piano`, `sampler-ep-rhodes` exact (with T06's `pcmOverride` where R13 requires it); T17's `sampler-sweep-1` … `-6` (21 sets, one note each; all `needsPcm`); JS `sampler` suite + `undampedOptIn` ported (the `touch-*` fixtures play `synth:808-sub`: moved to T14) | T06, T11 (allocator), T11a | M | sonnet | ✔ | R13 (consumer) |
| **T13 Model: song & graph** (T00c done: read "What changed under T13") | `src/model/model.cpp` + the T13 globs | prepare/commit/tokens/instSeq, reuse and **retire** (RetireInst/RetireStrip slots), routing, setParam dispatch with 10 ms coalescing, transpose/tempo/timeSig/keyContext, low resource, reverb policy, stats, getState | `auto-slot-level`, `auto-reverb-send`, `auto-delay-send`, `auto-master-volume` exact (`exactIfPrngPorted`; they play organ / `synth:pluck`, so they pass only after T15, unless T17 adds synth.js twins first) + T17's `switch-retire-retain` (mid-render commit + retire + `retainReverb`, with T04) and `fx-row-sweep` (statistical; with T03 mono, T05, T16); JS `supersededPrepare`, `gaplessSwitch`, `paramResetOnReuse`, `freshStripWheel`, `switchHeadroom`, `washAcrossCommit`, `morphAtCommit`, `beforeStartNoThrow`, `lowResource`, `restartKeepsState` ported | **T00c**, T02–T05 landed, T11 interface, T12 (`switch-retire-retain`, `fx-row-sweep` play a sampler); carry-overs: T02 #2 (`endAudition` on reused strips) and #4, T03 O4, T04 findings 3–4, T08 #1 | L | opus | ✔ | R6 (test list), R8, R18 (Model side) |

### T13 results (2026-11-21; builder report, review [VERIFIED](reviews/T13.md))

**Verdict: done for wave 2** (the organ / pluck `auto-*` originals close with T15; `fx-row-sweep` with T16). Files:
`src/model/{model.cpp, song.h, song.cpp, graph_build.h, graph_build.cpp, retire.cpp, stats.cpp}` (T13) and
`src/model/perform.cpp` (T14 from now on: noteOn .. runtimeStateJson + the STOPGAP(T12) overlay moved unchanged, plus
the marked `T13:` deltas). Fixtures (`tests/golden_ids/t13.ids`, ctest `golden.t13`): `switch-retire-retain` 2.46e-7
(manifest tier statistical; passes the exact tier: report for promotion), and four synth.js twins T13 added to
`tools/golden/fixtures.mjs` + the manifest (`auto-slot-level-synth` 3.0e-6, `auto-reverb-send-synth` 1.4e-6,
`auto-delay-send-synth` 7.2e-7, `auto-master-volume-synth` 3.6e-6; rendered with `render.mjs --only`, promoted to exact
with `promote.mjs --only`). The 67 fixtures that passed before render byte-identical WAVs. Tests: `unit.model` (the ten
JS suites, ported where the native core has the parts) and `unit.song` (retire, the command gate, coalescing, 16
slots, 32 retiring channels, eqAudition across a commit, D4 over retiring voices, dynamicRange, T11 O3, prefault, CPU,
a realtime switch loop for TSan). Gate (fresh dirs `build-t13{,-clang,-asan,-tsan,-clang20}`): ctest 60/60 on g++ 13
Release, clang 18 Release, g++ ASan+UBSan and clang 20 Release (-Werror, 0 warnings); TSan 21/21 (runtime suites +
model, song, t00c, voice-limit), no sanitizer report; 328 doctest cases / 342 731 assertions (g++); clang renders of
all 112 fixtures byte-identical to g++; `node test/run-all.mjs --only unit` 510 pass / 0 fail / 9 skip (incl.
`test/unit/engine-bridge`).

Outside T13's globs (each marked in the file): `inst/voice_alloc.h` (T11 O1: the pool's constructor touches the first
16 voice slots, `kPrefaultVoices`; resident +1.9 MB per synth.js instrument, +0.33 MB per sampler: ARCHITECTURE 7.1),
`tests/test_bridge.cpp`, `tests/test_t00c.cpp`, `tests/test_voice_limit.cpp` (expectations that encoded the skeleton
policy: a superseded token committed, set on an empty slot applied, strips on empty slots, a reused instrument
re-capped, role-free slot defaults), `tools/golden/fixtures.mjs` (the four twins).

Frozen-interface changes (INTERFACE_LOG to add): `model.h` INTERFACE-CHANGE(T13): `SongGraph` pimpl + `friend`,
`songGraph()`, `setDynamicRange()` / `dynamicRange()`; `plans_` removed. `patch.cpp` INTERFACE-CHANGE(T13): role
defaults of `params.js defaultSlot` (sends per role, Bass highNote 59 + mono lowest, bendEnabled synth/organ) — the
native parse left them at 0 / 127 / off / false, so every song without explicit sends had no reverb / delay.

What T14 must know:
- Channels: `SongGraph::liveChannel(i)` = JS `this.slots[i]`; a note records the channel **id** and resolves its target
  at note-off / pedal-up with `instUnitOf(id)` (Inst<i> or RetireInst<j>, Count = disposed); `channelById(id)->cfg` is
  the retired channel's own cfg (`sc.cfg`), a live channel's cfg is `model.patch().slots[i]`.
  `performChannelDisposed` / `performForget` (perform.cpp) are the retire / ~Model hooks: keep them when the overlay
  becomes Model state (T12 O5 is closed that way today).
- `Model::send` gates every command (`SongGraph::gate`): a command for a unit slot whose occupant changes at a frame
  ahead of the clock (a commit `when` in the future, an offline render posting the song up front) is moved to that
  frame, so it reaches the unit the Model meant (JS automates that very AudioParam). Note-ons between such a commit
  call and its `when` start at the commit frame (JS plays them silently on the fresh, fader-0 channel).
- Wheels: `SongGraph::wheel()` holds the values (start {1, 1, 1}); `routing()`, `macro()`, `factorFor()`,
  `slotWheelFactor()`, `morphFor()` (bend morph = 0 until T14) and `applyWheels(t, tc)` (strips + morph only) exist;
  setWheel must coalesce on key `wheels` (`SongGraph::coalesce`) and extend applyWheels with the drone / reverb return
  / master wheels, macro.wash (reverb request + delay washFb), `_neutralBend`, `_syncPedalSwell`.
- The prepare-time reverb stage uses the plain size and never defers: wash-adjusted staging and "defer while keys are
  held" need T14's wheels / `quietFor` (install `ReverbPool::setQuietProbe`) and a T04 change (`ReverbPool::onCommit`
  re-stages the plain patch size instead of using the prepare stage). `washAcrossCommit` is therefore not ported.
- `slots.<i>.bendEnabled` true in pitch mode (setBend(bend·range)) and the drone songChanged / pedal swell at commit
  are T14 / T16.

Open after T13 (owners): bridge row `config {dynamicRange}` + engine-api.json + contract (orchestrator / T08; the
Model side exists, T12 O1); BufferCache::protect of an EMPTY key list resets to "no protection" (JS: an empty Set;
T06); ReverbPool deferral / wash (T04 + T14, above); T04 finding 3 (five overlapping spaces) and 4 (`wa::Param`
capacity for commits far ahead) stay notes: the Model commits at `when`, never debounced (as JS); `fx-row-sweep` needs
T16 (renders, fails: no drone); T03 O4 only matters if `fx-row-sweep` is ever promoted (blocker: Chromium does not
repeat it within 1e-5).

### Wave 2 results (integrator pass, 2026-11-21)

Integrated tree (v2-native `14ba75c` + this pass), fresh build dirs, `-j2`, one at a time:

| config | build | ctest |
|---|---|---|
| g++ 13 Release `native/core/build-w2` | 0 warnings (-Werror) | **61/61** |
| clang 18 Release `build-w2-clang` | 0 warnings | **61/61** |
| clang++-20 Release -Werror `build-w2-clang20` (stand-in for Apple clang 21) | 0 warnings | **61/61** |
| g++ ASan+UBSan `build-w2-asan` | 0 warnings | **61/61**, no sanitizer report (`rt.realtime`'s known load flake did not trip) |
| g++ TSan `build-w2-tsan` (runtime + model + song + t00c + voice-limit suites) | 0 warnings | **21/21**, no ThreadSanitizer report |
| `native/devhost` g++ `build-w2` / clang-20 -Werror `build-w2-clang20` | 0 warnings | **5/5** / **5/5** (g++: `probe.null` failed once under `ctest -j2`, "synth sweep has 1 steps" after a p99 spike on the first step, passed alone: load flake) |

Fixtures (`PARITY.md`, regenerated from scratch with the new `tools/golden/parity.mjs`): **73 / 112** at the manifest
tier (108 originals: **69**, wave 1: 50; T13's 4 twins: 4), g++ and clang renders byte-identical for all 112; tiers
78 exact / 34 statistical after promoting `synth-warm-pad`, `-glass-pad`, `-strings`, `-sub-bass`, `-bell` and
`switch-retire-retain` (all pass the exact tier on both compilers). The 39 failures all wait for T14 / T15 / T16
(none is a parity defect). New ctest `golden.integ` (`tests/golden_ids/integ.ids`) guards the four T14 fixtures that
already pass. Frozen-interface changes: `INTERFACE_LOG.md` 32-38.

| task | verdict | review | done fixtures (all pass) | open items → carried to |
|---|---|---|---|---|
| T00c scale-out (D1-D3) | **done** (VERIFIED) | [T00c](reviews/T00c.md) | none of its own; the 50 wave-1 fixtures byte-identical | O1 closed (integrator, markers); O2 (`rig_meters.slot_count` set only by the bridge's `opCommit`) → **T14**; O3 (targeted `NoteOn` to a `RetireInst` slot is applied; make it a graph rule or reword) → **T14** + orchestrator `graph.cpp`; O4 (`rt.realtime` xrun limit under ASan + `-j2` load) → orchestrator (`RUN_SERIAL` or the TSan treatment); O6 (pin estimate double-counts stand-ins, conservative) → note |
| T11 voice + synth.js | **done** (VERIFIED) | [T11](reviews/T11.md) | 6 `synth-*` (5 promoted to exact here; `synth-soft-keys` statistical, Q11) | O1 closed (T13 prefault); O3 closed (T13); **O2** (3-call `FinalValue` compensation lives in T11's `oscProcess`, not in `wa::Oscillator`) → **T15 first step** (re-check T05 `chorus-fast-deep-noise`), before T16 uses oscillators; O4 (`std::exp2f` from the platform libm on parity paths) → orchestrator / T01 port + **Mac** (CI macos-15 goldens); O5 (bounded side tables drop silently) → **T15** (works in `src/inst`); O6 (`WaveBank::trim` unused) → memory-pressure path, **Mac/iPad**; O7 ui-core re-run → T09 after **T14** |
| T12 sampler | **done** (VERIFIED) | [T12](reviews/T12.md) | `sampler-salamander-piano`, `sampler-ep-rhodes`, `sampler-sweep-1..6` (exact) | O1: Model side done (T13); bridge row `config {dynamicRange}` + `engine-api.json` + contract → **UI wave** (orchestrator contract edit first); O2 closed (T13 ramps widthDefault on reused strips); **O3** (voice addressing: re-strike / pedalHold fade one voice; needs a `VoiceStarted` event or a per-note fade op, an interface decision) → **T14** (orchestrator decides the interface before T14 starts); O4 (`user:` sampler params get no `InstParam`) → **T15**; O5 closed (T13: `performForget`), the overlay itself → **T14** |
| T13 Model: song & graph | **done** (VERIFIED, F1 fixed in review) | [T13](reviews/T13.md) | `switch-retire-retain` (promoted to exact here), `auto-slot-level-synth`, `-reverb-send-synth`, `-delay-send-synth`, `-master-volume-synth` (exact); the organ / pluck originals → T15, `fx-row-sweep` → T16 | O1 closed (integrator: explicit null keeps the PARAMS default, test in `unit.model`); O2 (instrument param stored only at the coalesced flush), O3 (reused-channel params outside the catalogue not re-sent), O4 (command gate delays a note-off that resolves to a retiring channel), O7 (`auto-filter-cutoff` passes: promote it) → **T14**; O5 closed (ARCHITECTURE 7.1 prefault row); **O6** (`setLowResource` no longer fans out to every service: the drone freeze has no notification path; `services.h` frozen) → orchestrator decides the hook, then **T16**; ReverbPool deferral / wash staging (`washAcrossCommit` not ported) → **T14** + T04 change (`ReverbPool::onCommit`, `setQuietProbe`); `BufferCache::protect` of an empty key list = "no protection" (JS: empty Set) → orchestrator (T06 files); T04 findings 3-4 stay notes |
| D4 total voice limit | **done** (VERIFIED) | [D4core](reviews/D4core.md) | none (108/108 byte-identical: the default limit never engages) | **R1** (60 % sizing is steady state only: steal fades + voice construction burst to 100-110 % for ~8 quanta) → **Mac** (time a large layered chord) + orchestrator / Ryan (Auto formula); R4 closed (integrator: `hello.minor` 2); R6 (Auto rounds to nearest 16, not down) → when the **Mac/iPad** numbers replace the constants; R7 (`inst.test` not counted) → note; R8 (`kVoiceLimitChoices` unused; tracked `build-d4-clang.log2` and older tracked `build-*.log`: `git rm --cached` them) → orchestrator nit. Mac check #2: warm-pad 4.82 µs / voice, suggestion 256: **`kAutoVoiceLimitDesktop` stays 128** (DECISIONS D4) |
| Settings restructure + 2.0 Sound options | **done** (VERIFIED) | [Settings](reviews/Settings.md) | `test/phase2/settings/run.mjs` 78/78 | 1 (a restart requested during a restart is dropped), 2 (`engine-api.json methods` lacks `setPolyphony` / `setVoiceLimit` / `setBufferFrames`; `surface.test.mjs` allow-lists them), 3 (`mock-native` omits `bufferFrames` in `audio` replies / `state`), 4 (view reads `engine.ctx.sampleRate`) → **UI wave**; 5 (themes coverage timestamps) → nit |
| Mac check kit | **done** (PARTIAL in review → Mac check #2 PASS on the Mac, `MAC_CHECK.md` Results) | [mackit](reviews/mackit.md) | tier 1 ran: tools, core 46/46, probe, apple-mac PASS | O1 (realtime sampler silent without a `cache preload`: `api/engine.cpp` control loop never pumps the cache service) → orchestrator core fix (T08 files) **before Ryan's tier-2 checklist**; O2 closed (integrator: the three dump cases skip in a clean checkout); O3 (signing fallback), `apple-sim` (iOS 26.5 simulator platform not installed; `check.sh` should report CoreSimulator-too-old as SKIPPED) → **Mac**; O4 (no lock against two `check.sh` runs) → orchestrator; O5 (allow-list line) → done (check #2 ran) |

Closed by the integrator: T13 O1 (`patch.cpp`, INTERFACE_LOG 35), D4 R4 (`hello.minor` 2, 36), T00c O1 (markers, 37),
MAC_CHECK gap 2 / mackit O2 (`tests/samples_util.h`, 38), `golden.integ`, the six promotions, PARITY regenerated,
ARCHITECTURE 7.1 (Mac per-voice cost, D2 buffer results, prefault resident cost), DECISIONS D2 / D4 measurement notes,
MAC_CHECK Results. Pruned the reviewed build dirs of waves 0b-2 (the root volume had 32 MB free; 22 GB freed).

### Wave 3: how to start (DONE 2026-11-22: kept for the record; results in "Wave 3 results" below)

**Orchestrator decisions first** (each blocks part of a task; none blocks starting all three):
1. T12 O3 voice addressing for T14 (re-strike / pedalHold fade one voice): a `VoiceStarted {slot, note, id}` audio
   event the Model maps, or a per-instrument module op "fade held voices of note n over f s". Frozen `Instrument` /
   `AudioEvent` side: decide and log in INTERFACE_LOG before T14 reaches `restrike` / `sustainPedalHold`.
2. T13 O6 low-resource hook for the drone freeze (`services.h` frozen): e.g. `DroneService` reads
   `Model::lowResource()` in `onSongState`, or `SongState` carries the flag. Before T16 ports `droneParkGain0`.
3. Ryan: Q7 (`drone-freeze-*`: keep freeze or re-classify); D4 desktop Auto 128 vs 256 (after the Mac burst timing).

**What each task can start with, in launch order** (all three run in parallel on disjoint files; at most 3 agents on
the 2-CPU box, own build dirs, `-j2`):
1. **T14 perform** (L, critical path R8): first move the STOPGAP perform overlay into Model state (`perform.cpp`,
   keep `performChannelDisposed` / `performForget`); take `golden.integ` into `t14.ids` and promote
   `auto-filter-cutoff`; then the four T14-only fixtures (`bend-pitch-sampler`, `bend-tape`, `mono-legato`,
   `panic-fadeout`), wheels / macros (`setWheel` coalescing on key `wheels`, `applyWheels` extensions), reverb
   deferral / wash with T04's `ReverbPool` change; carry-overs T13 O2/O3/O4, T00c O2/O3, T12 O3 (after decision 1),
   T05 R6, T07 O7. `touch-*`, `auto-modwheel-cc`, `song-gospel-stab-b3` close when T15's 808-sub / organ land;
   `song-sunday-pad-piano`, `bend-modes` with T16; `scene-glide`, `swell-pedal-drone` need all three.
2. **T15 synth-extra + organ** (L, most fixtures: 19 wait for T15 alone): first T11 O2 (move the 3-call `FinalValue`
   behaviour into `wa::Oscillator::process`, T11a's files, with the orchestrator reviewing the frozen header if it
   changes; T11's `oscProcess` probe drops its compensation; re-check `chorus-fast-deep-noise`), because T15's and
   T16's oscillators need it. Then `synth-808-sub` (unblocks the five `touch-*` with T14), the four organ presets +
   rotary (also `auto-slot-level`, `auto-reverb-send`, `auto-master-volume`, `pan-mono-src`), `synth-pluck` (also
   `auto-delay-send`), the rest of synth-extra. Register through T11's `inst.synth` dispatch hook (no new kind).
   Carry-overs T11 O5, T12 O4. Measure per-voice cost of every new voice (D4: the costliest voice is perVoice).
3. **T16 drone** (M): `drone-synth-2keys`, `drone-synth-stage` and T13's `fx-row-sweep` first (3 fixtures wait for
   T16 alone), T11a O4 (rebuild PeriodicWaves on `RateChanged`), the drone `songChanged` / pedal swell at commit
   (with T14), the low-resource hook after decision 2; `drone-freeze-*` only after Ryan's Q7. Start its oscillator
   parity work after T15's O2 step lands (or rebase onto it).

Conflict points between the three: `src/dsp/oscillator*` (T15 step 1; T16 rebases), `model/song.cpp` /
`model.cpp` (T13's files, done: T14 owns perform-side edits, T16 asks the orchestrator for drone-at-commit hooks),
`golden_ids` (each task its own file). The wave-3 integrator then re-gates all configs, regenerates PARITY
(`parity.mjs` exits 1 on any failure not on its "waits for" list) and expects 112/112 if Q7 is answered (else 110).

**UI wave** (separate from wave 3; can run in parallel with it, files under `app/**`): D1-D3 store SCHEMA bump
(idempotent migration, 4-slot songs unchanged), 16-slot scrolling Perform / Edit, scenes / wheel / MIDI-learn targets
for 16 slots, the `config {dynamicRange}` bridge row (T12 O1), Settings review items 1-4. The Sound options (D1 / D2 /
D4) and the sidebar Settings already landed (Settings task above).

**Mac** (push agent RUN / Ryan): install the iOS simulator platform and re-run `apple-sim`; time a large layered
chord with the probe (D4 R1); iPad probe build (D4 iPad profile, D2 rounding); read back the CI `mac-check` and
`goldens` results; T07 O6 jitter-free delay; T11 O4 libm check; Ryan's tier-2 checklist after
T14 (and after the realtime cache-pump fix, mackit O1).

## Wave 3: everything that plays (DONE 2026-11-22; results and the UI-wave start below the table)

| task | owns | implements | done | deps | size | model | Linux ✔ | closes |
|---|---|---|---|---|---|---|---|---|
| **T14 Model: perform** | `src/model/{perform,wheels,chords,sleep}*` | notes/pedal/mono/legato/pedalHold, wheels + pickup + macros, bend modes incl. tape, swell, panic, fadeOutAll, chords, sleep/wake queueing | `auto-modwheel-cc`, `auto-filter-cutoff`, `scene-glide` (exact where `exactIfPrngPorted`); `song-sunday-pad-piano`, `song-gospel-stab-b3` with T15/T16; T17's `transpose-octave-range`, `bend-pitch-sampler`, `bend-tape`, `bend-modes` (`setup.live` routing), `swell-pedal-drone` (with T15/T16), `mono-legato`, `release-pedalhold`, `panic-fadeout`; `touch-soft`, `touch-hard`, `touch-fixed`, `touch-custom`, `touch-keyboard` exact (velocity curves; they play `synth:808-sub`, so with T15); carry-overs T05 R6 (re-send `lofiHold` after a rate change), T07 O7; JS `sustainDeferral`, `restrike`, `monoLowest`, `split`, `transposeFFT`, `stuckNoteFuzz`, `bendPitch`, `bendModes`, `chordReadout`, `macrosAndWheel`, `panicAndFade`, `sustainLongCap`, `sustainVariants`, `sustainRelease`, `sustainPedalHold`, `touchCurves`, `exprCurveAndPedalSwell`, `sceneGlide`, `sceneWheelGlide`, `pedalSwellLevelMoves`, `intensityMacroAndBrightness`, `padLikeIntensity`, `tapeBendStream` ported | T13, T12 | L | opus | ✔ | R12 (logic areas) |
| **T15 synth-extra + organ** (T15a/T15b) | `src/inst/{synth_extra,organ}*` | `inst.synth-extra` 10 patches, `inst.organ` 4 presets + rotary | `synth-808-sub` exact; `synth-juno-pad`, `synth-shimmer-pad`, `synth-pluck`, `synth-poly-stab`, `synth-analog-brass`, `synth-square-lead`, `synth-synth-bass`, `organ-gospel`, `organ-soft-pad`, `organ-full`, `organ-church` exact (`exactIfPrngPorted`); `pan-mono-src` (StereoPanner mono law on the church organ; statistical, promote to exact with the organ); `synth-supersaw-pad`, `synth-dx-epiano` stay statistical at the manifest tolerance (Q11: audible result kept, FM compensations); `song-gospel-stab-b3` with T14 | T11 | L | opus | ✔ | R6 (Q11 named), R7 |
| **T16 drone** | `src/drone/**` | `Drone` unit, `DroneService`, set handler `drone.` | `drone-synth-2keys`, `drone-synth-stage` exact (`exactIfPrngPorted`); JS `droneKeyChange`, `droneChordFollow`, `droneSongChangeAndFiles`, `droneInstrumentReuse`, `droneParkGain0`, `droneFiles`, `droneFilesKeyRace`, `droneFilesNoHardCut`, `droneOffNoVoices` ported; **`drone-freeze-dry/-wet` blocked on Ryan's decision Q7** (keep freeze or re-classify) | T11, T04, T13 | M | sonnet | ✔ (AAC pads ✗) | R6 |

Critical path: T00b → T01 → T04 → T00c → T13 → T14 (R8), with T11a → T11 → T13 in parallel; `song-lofi-rhodes`
(statistical for good; it plays `synth:soft-keys`) closes with T14 + T11 + T05.

### Wave 3 results (integrator pass, 2026-11-22)

Integrated tree (v2-native `ee3c18b` = T14, T15, T16 + follow-ups W3A / W3B, all reviewed, + this pass), fresh build
dirs, `-j2`, one at a time on the otherwise idle box:

| config | build | ctest |
|---|---|---|
| g++ 13 Release `native/core/build-w2` | 0 warnings (-Werror) | **78/78** |
| clang 18 Release `build-w2-clang` | 0 warnings | **78/78** |
| clang++-20 Release -Werror `build-w2-clang20` (stand-in for Apple clang 21) | 0 warnings | **78/78** |
| g++ ASan+UBSan `build-w2-asan` | 0 warnings | **78/78**, no sanitizer report (`rt.realtime`, the known ASan load flake T00c O4, did not trip under `-j2`) |
| g++ TSan `build-w2-tsan` (27 suites: queues, offline, offline-midi, bridge, bridge-conformance, realtime, runtime, soak, clock, rec, meter, click-record + model, song, t00c, voice-limit, voice-limit-cpu, sleep, perform, perform_carry, perform_ports, wheels, drone, drone_cpu, drone_files, drone_freeze, drone_vectors) | 0 warnings | **27/27**, no ThreadSanitizer report |
| `native/devhost` g++ `build-w2` / clang-20 -Werror `build-w2-clang20` | 0 warnings | **5/5** / **5/5** on re-run. clang-20: `probe.null` failed under `ctest -j2` and in 2 of 9 runs alone on the idle box ("sampler sweep has 1 steps": a 3.4 ms p99 spike on the first, zero-note sampler step stops the sweep), the VM-jitter flake wave 2 saw on g++ (there on the synth sweep) → orchestrator (stop a sweep only after two over-budget steps, or relax the null-backend check) |

Fixtures (`PARITY.md`, regenerated from scratch): **112 / 112** at the manifest tier on g++ 13, clang 18 and
clang++-20 (wave 2: 73), the three compilers' renders **byte-identical for all 112**, and byte-identical to the
W3A / W3B reviewers' renders from before this pass. 110 pass the exact tier (not `synth-dx-epiano`, Q11, and
`bend-modes`, T14 O3). Tiers **104 exact / 8 statistical** (wave 2: 78 / 34) after promoting 16 that pass the exact
tier on g++ and clang++-20 and whose owner allows it: `synth-juno-pad`, `-shimmer-pad`, `-pluck`, `-poly-stab`,
`-analog-brass`, `-square-lead`, `-synth-bass`, `organ-gospel`, `-soft-pad`, `-full`, `-church`, `pan-mono-src`,
`auto-slot-level`, `auto-reverb-send`, `auto-delay-send`, `auto-master-volume` (`promote.mjs --apply --only <id>`,
then `compare.mjs` again at the exact tier on all three: 112/112). Left statistical on purpose:
`synth-supersaw-pad` (passes the exact tier; the T15 row above keeps it statistical, Q11: owner / orchestrator
decision), `chorus-fast-deep-noise` (1.98e-4 = 99 % of the limit, T05 R2), `song-lofi-rhodes` (Q11),
`synth-soft-keys`, `lofi-tape-sine`, `fx-row-sweep` (Chromium does not repeat them), `synth-dx-epiano` and
`bend-modes` (fail the exact tier). ctest `golden.*`
compares all 112 now (the integrator added the 5 `touch-*` and `bend-modes` to `t14.ids`). Blocked fixtures: none
(`parity.mjs` "waits for" list emptied).

JS (Playwright's Chromium 1194 mapped to the installed 1243 through a scratch `PLAYWRIGHT_BROWSERS_PATH`): @@JS@@

| task | verdict | review | done fixtures (all pass) | open items → carried to |
|---|---|---|---|---|
| T14 perform | **done** (PARTIAL in review; every finding closed by W3A, VERIFIED) | [T14](reviews/T14.md), [W3A](reviews/W3A.md) | 14 T14 fixtures + the 5 `touch-*` (`bend-pitch-sampler`, `bend-tape`, `mono-legato`, `panic-fadeout`, `auto-filter-cutoff`, `release-pedalhold`, `transpose-octave-range`, `auto-modwheel-cc`, `scene-glide`, `song-sunday-pad-piano`, `song-gospel-stab-b3`, `swell-pedal-drone` exact; `song-lofi-rhodes`, `bend-modes` statistical) | closed: F1 (W3A-7), O1 (the ten JS ports, sleep / wake queueing, T00c O2 / O3, T13 O2 / O3 / O4, T07 O7: W3A), O2 (INTERFACE_LOG W3-1..3), the five promotions (W3A). Open: **monoSwitch legato on a stolen voice** (low: JS retriggers when the current voice is not Held; native sends a no-op `LegatoTo`) → **T14 follow-up**; tape realtime lead 20 ms vs JS `min(50 ms, baseLatency + 10 ms)` (nit) → T14; **O3** `bend-modes` exact-tier miss (6.5e-4 at the first morph ramp, inference: warm-pad `filterCS` a-rate biquad) → T11 / T02 note; `release-pedalhold` does not prove the pedalHold fade (its pedal-up is posted up front, so both engines' 5.4 s timer finds the note un-pedaled) → **orchestrator: a T17-style fixture** with the pedal-up as a live event after the pedalHold timer (unit-tested meanwhile in `unit.perform`) |
| T15 synth-extra + organ | **done** (PARTIAL in review; items 1-4 closed by W3B, VERIFIED) | [T15](reviews/T15.md), [W3B](reviews/W3B.md), [O2 landed](reviews/T15-O2-landed.md) | 10 synth-extra, 4 organ, `pan-mono-src`, T13's 4 organ / pluck `auto-*` (16 promoted to exact here; `synth-supersaw-pad`, `synth-dx-epiano` statistical, Q11) | closed: item 1 rotary string (W3B-4) and the reuse half **N1** (integrator W3I-1, test `unit.organ` "W3B review N1"), item 2 morph / release (W3B-5), item 3 drawbars heard (W3B-6), item 4 DelayNodes on a rate change (W3B-7), item 5 = fadeNote (`XHost::fadeNote` covers organ and synth-extra: confirmed, tested), T11 O2 (oscillator, landed first), T12 O4 (`user:` params, W3A-8). Open: **T11 O5** (`pendingEnded_` 32 entries: > 32 evictions in one quantum drop VoiceEnded silently in `synth.cpp`; size it `kVoicePoolSize + kVoiceSpare` or emit at eviction) → **T11 / T15 follow-up**; note 6 (`synth-dx-epiano` bands 2.90 of 2.99 dB, deterministic) → note; note 7 (idle organ rotary 19-42 µs per instrument; an idle skip changes output after the tail) → **orchestrator decision**; note 8 / D4 Auto with the costliest voice now dx-epiano / supersaw-pad at ~14 µs (ARCHITECTURE 7.1) → **Mac** (Ryan keeps desktop Auto 128, DECISIONS D5) |
| T16 drone | **done** (PARTIAL in review; O1-O3, O6 closed by W3B, VERIFIED) | [T16](reviews/T16.md), [W3B](reviews/W3B.md) | `drone-synth-2keys`, `drone-synth-stage`, `drone-freeze-dry`, `drone-freeze-wet` (exact), T13's `fx-row-sweep` (statistical) | closed: O1 runner diff (W3B-1, ids in `t16.ids`), O2 fx-row-sweep root cause (lofi / delay at call time, W3B-8 / -9), O3 rng ctor (W3B-3), O6 promotions (W3B), `hello.minor` 3 + capability `droneFreeze` (W3B-2), **O5** sanitizer guards (integrator: `test_drone_cpu.cpp` and `test_wheels.cpp` also ask `__has_feature`, so clang ASan / TSan report the timings instead of asserting them), the narrower low-resource hook (accepted, INTERFACE_LOG W3-4). Open: **O4** `DroneUnit::later` drops a payload past 64 per quantum (worst constructible ~34; make it a stat or a `static_assert`ed cap) → **T16 follow-up**; W3A R6 (native drone reference has one click-detector hit at 6.78 s, drone content) → note |
| W3A perform follow-ups | **done** (VERIFIED) | [W3A](reviews/W3A.md) | moves no fixture (proved by the reviewer) | **R1** `audio restart` / `output` while asleep: the Model stays asleep until the next perform call (JS starts awake) → **T08 + T14** (`hostAudioStarted` → `Model::wake(0)` or a contract line); R2 (FadeNote / mono NoteOn to a retiring channel between a commit call and its later `when` still gated; unreachable today) → T14 info; R3 (stray `noteOffFrom`) → info; R4 (`MasterChain` evaluates `out_` a-rate always; constant fast path) → T03 nit; R5 (`user:` samplers: a key missing from the new song is not reset) → **T12 / T13** |
| W3B organ + drone follow-ups | **done** (VERIFIED) | [W3B](reviews/W3B.md) | `drone-freeze-dry / -wet` (silence → 2.8e-6 / 3.7e-6), `fx-row-sweep` (1.22e-1 → 3.2e-5) | **N1 closed** (integrator W3I-1). Open: wash `SetFeedback` still sent at `frameOf(t)` while every other `DelayOp` goes at call time (`model/wheels.cpp`; send with `kFrameNow`, keep `f.e = t`) → **T14 follow-up** (low); `LofiUnit` drops a state past 32 applies per quantum silently (unreachable; add a counter) → T05 (low); organ drawbar timer reads params at fire time in JS vs per call native (agree live, no fixture) → note |

Orchestrator notes for this pass, confirmed: O-W3-1 overrides in organ and synth-extra (one `XHost::fadeNote`, used by
both, tests in `unit.organ` / `unit.synth_extra`); T15 review items 1-4 each with a test that fails without the fix
(W3B review); the T16 diffs applied verbatim (W3B review compared them against the saved copies), both freeze ids in
`t16.ids`, `hello.minor` 3 with `droneFreeze`; T14 F1 (W3A-7); W3B N1 fixed here (`unit.organ` "W3B review N1": the
test fails on the old code with the channel reused and 0.35 off a fresh `'off'` build, passes with < 1e-5; `'fast'`
against the stored index `1` still reuses; fixtures byte-identical). The builders' 112/112 and 110 exact reproduce;
their ctest 78/78 reproduces on g++, clang 18 and clang 20; ASan 78/78 here (their 77/78 was the `rt.realtime`
load flake, which did not trip this time); TSan now also covers the perform / sleep / wheels / drone suites (27/27).

Closed by the integrator: W3B N1 (W3I-1), T16 O5 (test guards), `golden.t14` + 6 ids (W3I-3), `parity.mjs` (W3I-2),
the 16 promotions, PARITY regenerated, INTERFACE_LOG "Wave 3 tasks" (W3-1..5) + "Wave-3 integrator" (W3I-1..3),
ARCHITECTURE 7.1 per-voice cost of every instrument kind, CI `sanitizers` TSan step also runs the model / song / t00c /
voice-limit / sleep / perform / wheels / drone suites (`.github/workflows/native-core.yml`; unverified until pushed).

### UI wave: how to start (next; Ryan resumes it)

Everything that plays is in the core; the UI wave is the next step (files under `app/**`, plus the contract / bridge
rows it names). Do not change `native/core` behaviour in it except for the bridge rows listed. Items, each with its
owner:

**UI wave** (one builder + skeptic review, or two on disjoint files: Perform / Edit vs Settings / store):
1. **Store SCHEMA bump** 1 → 2 with an idempotent `migrate()` (4-slot songs unchanged, unknown fields kept), D1-D3.
2. **16-slot scrolling Perform and Edit** (D3: 1..16 slots per song, horizontal scroll beyond 4; the web oracle stays
   at 4 slots).
3. **Scenes, wheel targets and MIDI-learn targets for 16 slots** (`slots.<i>.*` for i < 16).
4. **Settings › Sound › Advanced "Freeze drone to save CPU"** (D5: `settings.droneFreeze`, default on) →
   `config {droneFreeze}` (bridge row, schema and contract row exist: T16).
5. **`config {dynamicRange}` bridge row** + `engine-api.json` + contract row (T12 O1; the Model side exists:
   `Model::setDynamicRange`, INTERFACE_LOG 33). Orchestrator writes the contract row first.
6. **Settings review items 1-4** ([Settings](reviews/Settings.md)): a restart requested during a restart is dropped;
   `engine-api.json methods` lacks `setPolyphony` / `setVoiceLimit` / `setBufferFrames` (`surface.test.mjs`
   allow-lists them); `mock-native` omits `bufferFrames` in `audio` replies / `state`; the view reads
   `engine.ctx.sampleRate`. Item 5 (themes coverage timestamps) stays a nit.
7. **T09 / T11 O7**: re-run `node test/unit/engine-bridge/ui-core-devhost.mjs` (25 / 76 after T11; T14 now provides
   `play input`, fade and bend) and record it in PARITY "UI parity"; `mock-native.js` still answers `hello.minor` 0
   (the shim never reads it).

**Core, before Ryan's hands-on Mac session (tier 2)** (orchestrator, T08 files; not UI work, can run in parallel):
- **mackit O1**: a realtime song opened without `cache preload` plays silent samplers: `api/engine.cpp`
  `controlLoop` never calls the cache service's `pump()` and nobody calls `setWake`. Pump the cache in the control
  loop and set the wake to its semaphore; test: `rig-probe` on the null backend, 16 slots of `ep-rhodes`, 8 notes
  held, no preload → 128 voices (today 0). Still open after wave 3 (checked: no `pump` / `setWake` call in
  `engine.cpp`).
- W3A R1 (audio restart / output while asleep) with it (same files).

**Core follow-ups (non-blocking; a small "core follow-ups" task or the next integrator)**: T14 monoSwitch legato on a
stolen voice, wash `SetFeedback` frame (W3B), tape lead nit; T11 / T15 O5 `pendingEnded_`; T16 O4 `DroneUnit::later`;
T05 `LofiUnit` counter, T05 R4 / R5; T12 / T13 W3A R5 (`user:` sampler defaults); T06 `BufferCache::protect` of an
empty list = "no protection" (JS: empty Set); T11a bit-exact custom PeriodicWave (then promote
`chorus-fast-deep-noise`, T05 R2); orchestrator: T00c O4 (`rt.realtime` ASan load flake: `RUN_SERIAL` or the TSan
treatment), D4 R8 nits (`kVoiceLimitChoices` unused; tracked `build-*.log` files: `git rm --cached`), mackit O4 (lock
against two `check.sh` runs), T15 note 7 (idle organ rotary skip), T17-style fixtures (pedalHold fade with a live
pedal-up, T02 #3, T05 R3 `echo-time-switch` / `echo-panic` / `lofi-toggle`).

**Mac / iPad** (push agent `RUN`, `MAC_CHECK.md`; unchanged unless named): install the iOS simulator platform and
re-run `apple-sim` (and report CoreSimulator-too-old as SKIPPED, mackit O3); time a large layered chord with the
probe (D4 R1) and measure **dx-epiano / supersaw-pad** per voice there (the costliest voices now, ~14 µs on this box);
iPad probe build (D4 iPad profile, D2 rounding); read back the CI `mac-check`, `goldens` and sanitizer results (the
extended TSan regex); T07 O6 jitter-free delay; T11 O4 libm `exp2f`; T11 O6 `WaveBank::trim` under memory pressure;
Ryan's **tier-2 checklist after mackit O1** (T14 has landed).

## Orchestrator-only items (not a task)

R22 / V11 (**addressed** by the integrator: the CI `goldens` job regenerates the non-committed goldens ctest needs and
hands them to the Linux, macOS (`macos-15`) and sanitizer legs; unverified until pushed), R24
(`third_party/chromium/LICENSE`, commit hashes for dr_libs and pffft in `third_party/README.md`), R33 (ARCHITECTURE
§8.2 tolerances: 1.5–16.4 dB, env-corr 0.73–0.95, −1 = off for 3 fixtures), R34 (3 lines > 120 outside core), the
ARCHITECTURE §3/§5 text for the rate-change rebuild list once T08 measures it, removing the builtin units (now in
T00c), T04 finding 2 as an ARCHITECTURE note (every render entry inside `rt::RenderScope`: idle skip and CPU depend on
FTZ/DAZ), and the follow-up fixtures T02 #3 / T05 R3 (T17-style, orchestrator).

## Verified only on the Mac or iPad

- AUHAL/RemoteIO render at 128-frame buffers, measured round-trip latency, xruns under load (Instruments).
- Device selection, hot-plug, default-device following, **aux click on outputs 3–4** of a 4-out interface; a device
  rate change during playback (the clock path is tested on Linux, the device re-open is not).
- D2 buffer sizes 64/128/256/512 on AUHAL / AVAudioSession: granted size, latency, xruns at 64 (two callbacks per
  quantum); the D1 voice ceiling from CPU on the oldest supported iPad.
- CoreMIDI timestamps → engine time, jitter with and without `jitterFree` (T07 O6: delay = device buffer + 1
  quantum); **WebView round trip per note** (contract question 2) and `evaluateJavaScript` cost of 30 Hz ticks.
- WKWebView: `rig://` origin, **localStorage migration** from the Electron origin `127.0.0.1:8438` (import a backup on
  first launch; data-loss risk), file access to `~/Music/Worship Rig`, sandbox/entitlements, code signing.
- AAC/M4A decode through `ExtAudioFile` (My Samples, pads) and real GarageBand-imported content.
- CPU targets on Apple silicon and the oldest supported iPad; NEON paths of pffft and the direct FIR.
- iPad: AVAudioSession interruptions, background audio with the screen off, jetsam headroom (memory warnings →
  `rig_host_memory_pressure`), USB interfaces with 4 outputs.
- App size (no Electron: expect ≈ 100 MB vs 365 MB today).
