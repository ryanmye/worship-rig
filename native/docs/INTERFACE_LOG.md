# Frozen-interface change log (2.0 native core)

Every change to a file in BUILD_PLAN's "Frozen interfaces" table, in the order it landed. Each entry is marked in the
source with `// INTERFACE-CHANGE(<task>)` (grep: `grep -rn 'INTERFACE-CHANGE' native/core/src`) or, for the
append-only regions the headers mark ("T05 appends below"), listed under "appends". Created by the wave-1
integrator from the tree at `763ead2` + the integration pass; all entries are **additive** (no existing member,
opcode value, struct layout of `Command`/`AudioEvent`, or method signature changed), and none conflict with
another: they touch disjoint lines, and the integrated tree builds and passes ctest on g++ 13, clang 18 and
g++ ASan+UBSan.

## Marked changes

| # | task | file(s) | change | why |
|---|---|---|---|---|
| 1 | T02 | `src/model/patch.cpp` (`parseEq`) | the slot EQ is resolved by `mix/slot_eq.cpp` (fx.js `resolveSlotEq`, incl. the legacy `eq.low/mid/high` rows and the stored-row bookkeeping later `set`s need); before: b-rows only | `eq-legacy-rows` exact; `set` on legacy rows |
| 2 | T02 | `src/model/model.cpp` (`Model::eqAudition`) | the `StripOp::EqAudition` op is applied at call time (`frame = now`) with `when` carried in `f.b` as the automation time; before: the whole op deferred to `frameFor(when)` | audio.js `eqAudition` runs `SlotEq.set(eq, when)` when called, like every EQ write (`eq-type-change` exact) |
| 3 | T08 | `src/graph/graph.{h,cpp}` | `GarbageQueue` (own SPSC ring, 32768) + a 1024-entry stash retried every quantum (`flushGarbageStash`), `popGarbage`, counters `garbageParked` / `garbageLost`; Garbage never uses the shared event ring | SETUP_REVIEW 18 / WAVE0B V13: `Unit::giveBack` leaked on a full event ring |
| 4 | T08 | `src/graph/graph.{h,cpp}` | lost-`VoiceEnded` bits (`endedLost_`, `takeEndedSlots()`): a VoiceEnded that does not fit the event ring sets its unit-slot bit; the owner rescans on `Dropped` | contract `Dropped` handling ("ended bits scan") |
| 5 | T08 | `src/graph/graph.{h,cpp}` | per-slot level `slotMeter()`: peak / rms of 0.5·(L+R) of the post-pan strip output over 256 frames into `rig_meters.slot_peak/slot_rms` | contract 3.11 `slotLevel` |
| 6 | T11a | `src/dsp/oscillator.h` | additive `process(frame0, sr, out, n, freqMod, detuneMod)` overload for audio-rate inputs connected into frequency / detune (FM); `playing_` state | voice.js FM, Chromium `OscillatorHandler` start-phase semantics |
| 7 | T11a review | `src/dsp/oscillator.h` | `setFrequencyRate` / `setDetuneRate` (`AudioParam.automationRate`, default a-rate) | voice.js sets `detune.automationRate = 'k-rate'` and connects bend / vibrato into it (contract Q6) |
| 8 | T11a | `src/dsp/buffer_source.h` | private Chromium 157 `AudioBufferSourceHandler` state (grain offset/duration, effective loop frames, `playing_`, helpers) | `ended` timing and loop-point parity |
| 9 | T11a | `src/dsp/constant_source.h` | `finished()` accessor + `playing_` / `finished_` | `ended` for ConstantSource users |
| 10 | T07 (integrator) | `src/model/patch.h` (`SongState`), `src/model/model.cpp` (`Model::setTimeSig`) | `bool SongState::newBar` (default false); `setTimeSig(sig, newBar)` sets it around `forEachService(onSongState)` and clears it after, so only that call's services see it. `ClickServiceImpl::onSongState` runs the signature branch when the signature changed **or** `newBar`, and passes it to `Metronome::retime` | T07 review O2: controller.js calls `setTimeSig(sig, {newBar:true})` on every song switch; natively the accent stayed on the old bar grid. Pinned by dump-click cases `songswitch-newbar-{44100,48000}` replayed through the bridge + service |

## Behaviour change in a frozen file (no interface change)

| task | file | change |
|---|---|---|
| T07 review O1 (integrator) | `src/graph/graph.cpp` `renderQuantum` steps 6–7 | The 'main' click is no longer summed into `out` before the sinks. The meter unit and `rig_meters.out_peak` see `out` without the click (the JS analysers sit on `fx.out`); the recorder gets `out + click` only when `click {record:true}`, for main **and** aux (before: always for main, only aux honoured `record`); the device/destination still gets the click (the `out` tap, so goldens are unchanged: `golden.click` bit-exact). Test `unit.click-record`. |

## Comment-only edits to frozen files

- `include/rig/rig_engine.h` (integrator, T08 review item 5): `rig_host` threading note: `audio_start` /
  `audio_stop` run on the core's device thread, one at a time, in issue order, and must return (`rig_destroy`
  joins that thread). No ABI change.
- `src/fx/delay.h` (integrator, T05 review R1): header comment describes the kept JS Q split.

## Appends in the marked regions of frozen module headers

| task | header | appended |
|---|---|---|
| T02 | `src/mix/slot_channel.h` | `StripOp::SetSlotWidth` (f.a = width 0..1.5, f.b = when) |
| T03 | `src/mix/master_chain.h` | `MasterOp::SetMono` (f.a = 1/0, f.b = when; 50 ms crossfade); usage note on `SetGlue` (f.b = when) |
| T04 | `src/fx/reverb.h` | `ReverbOp::Reactivate`, `Release`, `Feed` |
| T05 | `src/fx/delay.h` | `DelayOp::SetFeedback`, `ApplyAll`; every DelayOp carries `when` in f.e |
| T07 | `src/click/click.h` | usage note only (Schedule / ClearAfter sent with `kFrameNow`, times in `f.a`) |

## T00c: scale-out amendment (DECISIONS D1-D3), marked `INTERFACE-CHANGE(T00c)`

All additive at the C API (API 1.1, struct_size-gated) and the bridge (`hello.minor` 1, caps `polyphony`,
`bufferFrames`, `slots16`). Inside the core two frozen VALUES changed (UnitSlot numbers, PatchSpec array size): code
that uses the names / helpers is unaffected; nothing outside the core persisted the numbers.

| # | file(s) | change | why |
|---|---|---|---|
| 11 | `src/inst/instrument.h` | `virtual void setVoiceCap(unsigned cap)` (default no-op), landed first so T11/T12 implement it | D1 |
| 12 | `src/runtime/command.h`, `src/graph/instrument_apply.cpp`, `src/graph/graph.cpp` | `Op::VoiceCap = 24` (target = instrument slot or kAllSlots, aux = cap) decoded into `setVoiceCap`; routed like the other per-instrument core ops (slots + retiring channels) | D1 |
| 13 | `src/model/model.{h,cpp}` | `setPolyphony(unsigned)` / `polyphony()` (32/64/128, default 64); `attachUnit` sends `VoiceCap` right after every instrument `AttachUnit` (same frame, FIFO); `stateJson` gains `slotCount`, `polyphony` | D1 |
| 14 | `src/graph/unit.h` | `UnitSlot` renumbered: Inst0..15 = 0..15, Strip0..15 = 16..31, RetireInst0..31 = 32..63, RetireStrip0..31 = 64..95, Drone 96 … Recorder 104, Count 105 (was 4 + 4 + 16 + 16, Count 49); `kChannels` 16, `kRetiring` 32; `isInstSlot` / `isRetireInstSlot` / `isRetireStripSlot`; static_asserts tie the layout and `RIG_MAX_SLOTS` | D3 |
| 15 | `src/runtime/command.h`, `src/graph/graph.{h,cpp}`, `src/model/model.{h,cpp}` | `Op::MoveUnit = 25` (target = destination, aux = source: the live unit moves, state kept) + `Model::moveUnit(from, to, when)`; `AttachUnit.aux` = origin slot + 1 for a strip attached straight into a retiring channel | D3 retire (T13) + T08 #1 |
| 16 | `src/graph/graph.{h,cpp}` | slot meters for 16 slots; a retiring strip is summed sample-wise into its ORIGIN slot's accumulator before peak / rms (exactly the T08 numbers when nothing retires); `setSlotCount()`; lost-VoiceEnded bits widened to every unit slot (`kEndedWords` = 2, `takeEndedSlots(word)`) | D3, T08 #1 |
| 17 | `include/rig/rig_engine.h` | API 1.1: `RIG_MAX_SLOTS` 16, `RIG_BUFFER_FRAMES_DEFAULT` 128; `rig_host.audio_start_frames` (appended; `RIG_HOST_SIZE_V1`); `rig_meters` appended `slot_count`, `slot_peak_all[16]`, `slot_rms_all[16]`, `slot_retiring[16]` (`RIG_METERS_SIZE_V1` = 80; `rig_get_meters` copies min(struct_size, sizeof)); `slot_peak/slot_rms[4]` mirror slots 0..3 | D2, D3 |
| 18 | `src/model/patch.{h,cpp}` | `kMaxSlots` 16 / `kWebSlots` 4; `PatchSpec.slots[16]` + `slotCount`; a patch with > 16 slots is `bad-request`; `storeRow` takes slots 0..15 | D3 |
| 19 | `src/params/params.cpp` | `findParam`: `slots.<i>` for i = 0..15 (decimal, no leading zero); rows unchanged (`gen-params --check` clean) | D3 |
| 20 | `src/api/registry.h` | comments only: `UnitSpec.channel` / `SetRequest.slot` 0..15 | D3 |
| 21 | `src/dsp/waveshaper.h` | `WaveShaper::reset()` (oversampler history), called by `MasterChain::setSampleRate` | T03 O7 |
| 22 | `src/samples/buffer_cache.h` (T06 module, not frozen; listed for T12) | `Config::hardCapBytes` + `warnMemory`, `capRefused()`, `hardCapBytes()`; `CacheServiceImpl::withinPinBudget` | D3 memory |
| 23 | `src/fx/reverb_service.h` (T04 module, not frozen) | `SlotMirror::stateBytes`, `bytes()` = kernels + slot state, `kernelBytes()`, `releaseSlot()` | T04 finding 1 |

Removed: the builtin `strip` and `master` units (`graph/builtin_units.*`, `builtin_register.cpp`; `SlotEqPayload`
and `inst.test` stay), `mix/master_chain_eq_fallback.cpp` + `mix/master_chain.cmake` (T03 O8).

Contract (`native/contract`): `audio.bufferFrames` 64|128|256|512, `config.polyphony` 32|64|128, `state.bufferFrames`,
`tick.slots` length = max(4, song slots), grammar `slots.([0-9]|1[0-5])`, `params.grammar.slotCount` 16 +
`webSlotCount` 4; `engine-api.json` regenerated (`--check` clean).

Edits in other tasks' finished files (no running task owns them): `mix/slot_channel.cpp` + `slot_channel_register.cpp`
(T02: channel / slot ≤ 15), `meter/meter.{h,cpp}` (T08: subscriptions 0..15), `mix/master_chain.cpp` (T03 O7 call),
`samples/{buffer_cache,cache_service}.*` (T06: cap / pins), `fx/reverb_service.*` (T04 finding 1), tests
`test_bridge_conformance.cpp` (integer-set types), `test_offline.cpp` (API 1.1), `test_reverb_engine.cpp` (12 MB cap:
slot state is counted now), `test_params.cpp` (16 slots); outside the core `app/js/engine-bridge/bridge-engine.js`
(T09: slots 4..15 of the committed song, eqAudition / slotLevel 0..15), `native/devhost` (`--buffer`,
`audio_start_frames`), `native/apple` (buffer request path, UNBUILT).

## Notes for later tasks

- T05 review R1 (closed by the integrator): the `src/fx/delay.h` header comment and ENGINE_CONTRACT §3.5 now
  describe the kept JS Q split (pre-delay Q, d = time − Q), which is what makes the echo fixtures bit-exact.
- D1–D3 (`DECISIONS.md`) landed as T00c (section above).
