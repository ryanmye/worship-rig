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

## Appends in the marked regions of frozen module headers

| task | header | appended |
|---|---|---|
| T02 | `src/mix/slot_channel.h` | `StripOp::SetSlotWidth` (f.a = width 0..1.5, f.b = when) |
| T03 | `src/mix/master_chain.h` | `MasterOp::SetMono` (f.a = 1/0, f.b = when; 50 ms crossfade); usage note on `SetGlue` (f.b = when) |
| T04 | `src/fx/reverb.h` | `ReverbOp::Reactivate`, `Release`, `Feed` |
| T05 | `src/fx/delay.h` | `DelayOp::SetFeedback`, `ApplyAll`; every DelayOp carries `when` in f.e |
| T07 | `src/click/click.h` | usage note only (Schedule / ClearAfter sent with `kFrameNow`, times in `f.a`) |

## Notes for later tasks

- T05 review R1 (closed by the integrator): the `src/fx/delay.h` header comment and ENGINE_CONTRACT §3.5 now
  describe the kept JS Q split (pre-delay Q, d = time − Q), which is what makes the echo fixtures bit-exact.
- D1–D3 (`DECISIONS.md`) are the next frozen-interface changes; they land as T00c, logged here.
