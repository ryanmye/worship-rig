# native/core: the portable engine core (2.0)

C++20, no platform dependencies. Spec: `native/docs/ARCHITECTURE.md`, plan: `native/docs/BUILD_PLAN.md`, C API:
`include/rig/rig_engine.h`, behaviour: `native/docs/ENGINE_CONTRACT.md`. This tree is the T00 skeleton: real plumbing,
placeholder DSP (see "What is real" below).

```sh
cd native/core
cmake --preset release && cmake --build build/release && (cd build/release && ctest --output-on-failure)
cmake --preset asan    && cmake --build build/asan    && (cd build/asan    && ctest --output-on-failure)   # ASan+UBSan
cmake --preset tsan    && cmake --build build/tsan    && (cd build/tsan && ctest -R "queues|offline|bridge|realtime")
build/release/rig_bench 20 48000            # throughput baseline
build/release/rig_render --manifest ../golden/manifest.json --out out --only eq-peak-a
node ../../tools/golden/compare.mjs eq-peak-a out/eq-peak-a.wav
```

Labels: `unit` (doctest suites + params drift), `golden` (render with `rig_render`, compare with
`tools/golden/compare.mjs`, the only comparator), `rt` (realtime thread test).

## Layout

| path | contents |
|---|---|
| `include/rig/rig_engine.h` | the frozen C API |
| `src/api/` | `rig_engine.cpp` (C wrappers), `engine.{h,cpp}` (control thread, offline driver, render FIFO, event batching) |
| `src/bridge/` | BRIDGE v1 parse/dispatch (yyjson), JSON writer |
| `src/runtime/` | `spsc.h`, `mpsc.h`, `seqlock.h`, `command.h` (64-byte Command, 32-byte AudioEvent), `rt_guard.h` (FTZ/DAZ, allocation-trap flag) |
| `src/time/` | `param.{h,cpp}` (AudioParam timeline), `automation.h` (setNow/rampTo/linearTo), `timer.h` (quantised timers) |
| `src/dsp/` | `biquad.{h,cpp}` (Chromium coefficient formulas), `test_voice.{h,cpp}` |
| `src/mix/` | `slot_eq.*` (resolved EQ spec + chain), `slot_spec.h` |
| `src/graph/` | `graph.{h,cpp}`: audio-thread render graph (command heap, 4 strips, master) |
| `src/model/` | `model.*`, `patch.*`: control-thread state, prepare/commit, `set`, notes |
| `src/params/` | `params.*` + generated `params_gen.inc` (`tools/gen-params.mjs`, `--check` is a ctest) |
| `src/io/wav.*` | WAV reader/writer |
| `tools/` | `rig_render` (= `rig-golden`), `rig_bench`, `gen-params.mjs`, `common/fixture_runner.*` |
| `tests/` | doctest suites, allocation trap, mini fixture `fixtures/test-voice.json` |
| `third_party/` | vendored libraries, see its README |

## What is real, what is a stub

Real: C API incl. struct_size handling, offline and realtime modes, control thread, SPSC command/event queues, MPSC
MIDI queue, seqlock meters, render FIFO for non-128 host blocks, sample-accurate command scheduling (pending heap,
sub-quantum voice starts), BRIDGE v1 envelope + hello/audio/prepare/commit/set/play/get, the AudioParam timeline
(set, linear, exponential, setTarget, cancelAndHold, pinned `rampTo`), quantised timers, Chromium biquad formulas,
slot EQ chain, mono and stereo pan laws, WAV I/O, PARAMS table generated from the contract, FTZ/DAZ, allocation trap.
All 18 `eq-*` golden fixtures pass the exact tier through this path.

Stubs (answer `unsupported` or silence): `cache song drone click midi rec` ops, `play` pedal/wheel/bend/swell/fade/
input, `get instruments|sampleStatus`, `rig_host_midi_ports`, MIDI parsing (bytes are queued and counted), every
instrument except the test voice (`{"instrument":{"type":"test","id":"sine|saw"}}`), width, sends, FX, master chain,
click, recorder, taps other than `out`/`slotN.pan`, injection other than `slot0.strip`.
