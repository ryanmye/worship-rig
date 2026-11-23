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

## D4: engine-wide voice limit (DECISIONS D4), marked `INTERFACE-CHANGE(D4)`

All additive. Bridge: `config {voiceLimit: 'auto'|128|256|512|0}` (0 = off, default 'auto'); the config reply and
`get state` echo `voiceLimit` (the mode) and `voiceLimitEffective` (the number enforced, 0 = off); `get stats` gains
`voiceLimitSteals` and `voiceLimit`; `hello.caps` gains `voiceLimit`. `hello.minor` stays 1: bumping it to 2 (the
contract README rule) breaks `test_t00c.cpp`'s `"minor":1` check, a file outside D4; the orchestrator decides (open
item). No C API change.

Design: the instruments keep their voices (VoicePool: a running Held + Released count, O(1)); after each note-on the
Graph sums `playingVoices()` over the 48 instrument slots (16 + 32 retiring) and, while over the limit, picks the
globally earliest-released, else the globally oldest playing voice from each instrument's `oldestVoice()` and steals
it with the existing `releaseVoice(id, frame, kStealFade)`. Enforcing AFTER the note-on keeps the per-slot cap first
(it runs inside noteOn) and makes a note the instrument ignored (out of range, no sample) steal nothing. The limit
reaches the graph as a lock-free atomic adopted at the start of each quantum (no new `Op`: the core range is frozen),
so a change applies live from the next note-on. At most `kMaxLimitStealsPerNote` (4) steals per note-on: a live
lowering converges over a few note-ons instead of a burst of fades, and the audio thread's work stays bounded
(≤ 48 virtual counts + 4 x (2 x 48) candidate scans of 160 pool slots). No allocation, no locks. A per-quantum
counter in the graph was not needed: the pools already hold the count.

| # | file(s) | change | why |
|---|---|---|---|
| 24 | `src/graph/unit.h` | `class Instrument;` + `virtual Instrument *Unit::asInstrument()` (null; `Instrument` overrides it `final`): the graph reaches the instrument virtuals without RTTI | D4 |
| 25 | `src/inst/instrument.h` | `virtual unsigned playingVoices() const` (0) and `virtual bool oldestVoice(bool released, int64 frame, double &at, VoiceId &id)` (false); defaults = not counted, never stolen from | D4 |
| 26 | `src/inst/voice_alloc.h` | `playing()` is a running count (same values); `oldestReleased(when)` / `oldestPlaying()` (the two halves of `makeRoom`'s victim choice, now shared by it); `kAutoVoiceLimitDesktop` 128, `kAutoVoiceLimitIpad` 64 (PROVISIONAL), `autoVoiceLimit(ipad)`, `kVoiceLimitChoices`, `kMaxLimitStealsPerNote` 4 | D4 |
| 27 | `src/inst/synth.{h,cpp}`, `src/inst/sampler.{h,cpp}` | `playingVoices()` (synth: the existing method now `override`) and `oldestVoice()` over the pool, at the time their own noteOn would use | D4 |
| 28 | `src/graph/graph.{h,cpp}` | `setVoiceLimit(total)` (any thread, atomic; 0 = off, the bare Graph's default), `voiceLimitRequested()`; `GraphStats::limitSteals`; `limitVoices()` after every NoteOn (targeted or kAllSlots) | D4 |
| 29 | `src/model/model.{h,cpp}` | `CommandSink::setVoiceLimit(total)` (default no-op; `Engine` forwards to the graph); `Model::setVoiceLimit(int)` (`kVoiceLimitAuto` = -1, 0, 128, 256, 512), `voiceLimit()`, `voiceLimitEffective()` (auto from `env().config->profile`), `voiceLimitJson(JsonOut &)`; `stateJson` gains the two fields | D4 |
| 30 | `src/api/engine.{h,cpp}` | `Engine::setVoiceLimit` override; the constructor sets the Model's default (auto) on the graph; `statsJson` + `voiceLimitSteals`, `voiceLimit` | D4 |
| 31 | `src/bridge/bridge.cpp`, `src/bridge/schema.cpp` (T08 files, smallest edit) | `opConfig` parses `voiceLimit`; hello cap; schema row `voiceLimit` Enum `auto|128|256|512|0`, and an Enum now also matches an integral NUMBER whose decimal form is a member (a numeric STRING never matches: "128" is refused; \|n\| ≥ 1e9 is refused before the cast, D4 review R2) | D4 |

Contract (`native/contract`): `config.voiceLimit` `'auto'|128|256|512|0?`, reply `voiceLimit?`, `voiceLimitEffective?`,
get state note; `engine-api.json` regenerated (`--check` clean). `app/js/engine-bridge/mock-native.js` answers
`config {polyphony, voiceLimit}` and `get state` like the core (`AUTO_VOICE_LIMIT` per `profile` option).

## T13: Model song & graph, marked `INTERFACE-CHANGE(T13)` (reviewed: `reviews/T13.md`, VERIFIED)

Logged by the wave-2 integrator from the T13 report + review. No C API, bridge, opcode, `Command` / `AudioEvent` or
`UnitSlot` change.

| # | file(s) | change | why |
|---|---|---|---|
| 32 | `src/model/model.h`, `model.cpp` | `class SongGraph;` forward + `std::unique_ptr<SongGraph> sg_` (declared last, destroyed first, before the services), `friend class SongGraph`, `songGraph()` (const and non-const); `plans_` removed (the plan lives in `SongGraph`) | T13's song / graph policy (prepare, commit, retire, routing, the command gate, coalescing) lives in T13's own `model/song.{h,cpp}`; services (T11 O3: the instrument in a retiring channel) and T14 (note targets via `liveChannel(i)` / `instUnitOf(id)`) read it |
| 33 | `src/model/model.h`, `model.cpp` | `setDynamicRange(double)` (1..3, invalid -> 1; returns the range used) / `dynamicRange()`: stored, sent to every live sampler (slots + retiring) and after every `inst.sampler` attach | T12 review O1 (`settings.dynamicRange`). The bridge row (`config {dynamicRange}`) + `engine-api.json` + contract row are still missing: owner orchestrator / T08 |
| 34 | `src/model/patch.cpp` (`applyRoleDefaults`, called at the end of `parsePatch`) | an ABSENT slot row takes its ROLE default (params.js `defaultSlot`: sends per role, Bass `highNote` 59 + `mono` 'lowest', `bendEnabled` for synth / organ); slots 4..15 use the Keys role | before, the native parse left them at the PARAMS row defaults (0 / 127 / off / false), so every song without explicit sends had no reverb / delay. No passing fixture changed (their patches set every send they use); three T13 twins pass because of it |
| 35 | `src/model/patch.cpp` (same function; wave-2 integrator) | an explicit JSON `null` is no longer treated as absent: it keeps the PARAMS row default, as JS (`{...base, ...s}` keeps the null, `clampParam(null)` = the PARAMS default; sends merge one level deeper). Test `unit.model` "role defaults: an absent row takes the role value, an explicit null the PARAMS default" (values checked against `engine/audio.js normalizePatch` in node) | T13 review O1. The store never writes null today, so no song changes; renders of all 112 fixtures byte-identical before / after |

Outside the frozen table but noted for later tasks: `src/inst/voice_alloc.h` (T11's file) `kPrefaultVoices` = 16:
`VoicePool`'s constructor touches the first 16 voice slots on the control thread (T11 review O1; +1.9 MB resident per
synth.js instrument, +0.33 MB per sampler; ARCHITECTURE 7.1). T13 also edited `tests/test_bridge.cpp`,
`test_t00c.cpp`, `test_voice_limit.cpp` (expectations that encoded the skeleton policy) and added four fixtures to
`tools/golden/fixtures.mjs` + the manifest (`auto-*-synth`).

## Wave-2 integrator (2026-11-21)

| # | file(s) | change | why |
|---|---|---|---|
| 36 | `src/bridge/bridge.cpp` (`opHello`), `tests/test_t00c.cpp` | `hello.minor` 1 -> **2** (marked `INTERFACE-CHANGE(D4)`); the T00c test now accepts any minor >= 1 | contract README rule (additive change = bump minor + capability); D4 review R4. The JS shim never reads `minor`; `mock-native.js` still answers 0 (unchanged, as before) |
| 37 | `include/rig/rig_engine.h`, `src/api/registry.h` | comment-only: the T00c lines carry the literal `INTERFACE-CHANGE(T00c)` marker | T00c review O1 |
| 38 | `tests/samples_util.h` (T06 test helper) | `Dump::ok()` also requires `decode-dump/data/raw44100` and `raw48000` (git-ignored) | MAC_CHECK known gap 2 / mackit O2: in a clean checkout (CI `build-test`, `check.sh`) the three `unit.samples_*` dump cases now skip with a MESSAGE instead of failing |

## W3B: organ + drone follow-ups (wave 3), marked `INTERFACE-CHANGE(W3B)` where the file is frozen

Numbered W3B-n (the orchestrator renumbers when it merges with W3A). Renders of all 112 fixtures: byte-identical
before / after except the three meant to move (`drone-freeze-dry`, `drone-freeze-wet`: silence -> the loop;
`fx-row-sweep`: 1.22e-1 -> 3.2e-5); g++ 13 and clang++-20 renders byte-identical for all 112.

| # | file(s) | change | why |
|---|---|---|---|
| W3B-1 | `tools/common/fixture_runner.cpp` (frozen, orchestrator) | the T16 runner diff: kind `drone-freeze` posts `drone {config: {__freezeTest: <setup>}}` (test API) and taps `fx.sum`; no longer skipped as silence | T16 review O1 (D5); `drone-freeze-dry` / `-wet` in `golden_ids/t16.ids` |
| W3B-2 | `src/bridge/bridge.cpp` (`opHello`, T08), `tests/test_t00c.cpp` | `hello.minor` 2 -> **3**, capability `"droneFreeze"` (config `{droneFreeze}`, D5 / T16); the T00c test checks minor >= 3 and the capability | contract README rule (additive change = minor + capability). `mock-native.js` unchanged (still 0, as before) |
| W3B-3 | `src/inst/synth.{h,cpp}` (T11; header not frozen) | T16's additive constructor `SynthInstrument(const PatchDef &, double sr, Rng parent, std::string_view params, double release)` (forks `parent`, as InstrumentBase asRng); the old one delegates to it. `drone/drone_osc.cpp` `makeDroneOsc` uses it; `rngNameFor` (the FNV-1a preimage search, ~768 KB / ~1 ms per tried tag) is deleted | T16 review O3. The four drone fixtures render byte-identical before / after |
| W3B-4 | `src/model/model.cpp` (`Model::set`, dynamic `slots.<i>.params.` branch; T13 file) | a STRING value becomes `inst::instEnumIndex(slot, key, s)` (new, `inst/organ.h`): organ `rotary` slow / fast / off, an unlisted name = the preset's default (voice.js coerceParam); -1 (not an enum row of the slot's instrument) = not applied | T15 review item 1 (HIGH): the Edit view sends `rotary = 'fast'`, which arrived as 0 = slow. NOTE: the review text said "dropped" for an invalid name; JS applies the default, so native does too. A string for a NUMERIC row is dropped (JS: `Number(s)`), unchanged in practice (the UI sends numbers) |
| W3B-5 | `src/model/song.cpp` (`sendRelease`, `applyFresh`, `applyWheels`; T13 file) | `kKindOrgan` -> `OrganOp::ReleaseOverride` / `OrganOp::Morph` | T15 review item 2 (HIGH): `macro.intensity` / bend morph and a run-time `slots.<i>.release` never reached an organ |
| W3B-6 | `src/inst/instrument_service.cpp` (`setInstrumentParam`, T11 file) | after the `Op::InstParam` of an organ `drawbar*` key: `inst::organDrawbarsChanged(m, slot, when)` (new, `inst/organ.h`) | T15 review item 3 (MEDIUM): organ.js `_scheduleWave`. The "t15-tables" service (now `inst/synth_extra_tables.{h,cpp}`, class `T15TablesService`, same registry name) arms one 30 ms timer per slot, then sends `T15Op::SetTables` with only `drawbars` (built on the control thread from the slot's current params) |
| W3B-7 | `src/inst/synth_extra_dsp.h` (T15) | `XTablesPayload::sampleRate` (0 = keep the DelayNodes); `XDelay::sampleRate()` | T15 review items 3 / 4: a drawbars-only payload is applied only at the unit's rate; a rate-change payload re-attaches the organ horn and synth-extra chorus DelayNodes (`attachFitting`, same buffers) |
| W3B-8 | `src/fx/lofi_register.cpp`, `src/fx/lofi_unit.h`, `src/fx/lofi.cpp` (comment) (T05 files) | the lofi service sends `LofiOp::Apply` NOW (command frame) with `s->when` = the call's time (`LofiUnit::apply` schedules ramps / engage there); the unit's garbage buffer 8 -> 32 | fx-row-sweep root cause (below). fx.js `Lofi.apply(when)` runs at call time: `_updateCurves` assigns the WaveShaper curves at once. Test `unit.lofi-calltime` |
| W3B-9 | `src/fx/delay_register.cpp` (`sendOp`, T05 file) | every `DelayOp` is sent NOW with `f.e` = the call's time (`DelayUnit::apply` already schedules at `f.e`) | fx-row-sweep 4.5-7.5 s residual (5.3e-4 -> 3.2e-5): fx.js `updateTime` / `_switchTo` / `setFeedback` run at call time, so the feedback row at 4.5 s acts on the line that is active at CALL time and the switch retry timer reads the latest `p.feedback` |

**fx-row-sweep root cause.** The golden page issues every event up front (`dispatch` before `startRendering`), and
fx.js applies part of a call at CALL time: `Lofi.apply` swaps `sat.curve` / `quant.curve` (not AudioParams) at once,
so the curves of the LAST lofi rows (saturation .9 at 7.0 s, amount .7 at 7.2 s: drive 9 dB, 11 bits) shape the
whole golden from t = 0. That made the golden 1.7-2.3 dB quieter in 0-3 s, and 11-bit quantisation rounds the
-100 dB drone fade-in before the 0.1 s note to exact zeros (frames 4000-4400). The native lofi service sent its state
at `when`, so its curves changed at 7 s. Found by rendering the fixture without its param rows (web = native to
3e-5), then each row alone (only `fx.lofi.saturation` / `fx.lofi.amount` move the first second). The same pattern in
the delay (time 3.0 + sync 4.0 + feedback 4.5 together) left 5.3e-4 in 4.5-7.5 s. Live use is unaffected (the
controller calls with when = now). No tolerance changed.

## Notes for later tasks

- T05 review R1 (closed by the integrator): the `src/fx/delay.h` header comment and ENGINE_CONTRACT §3.5 now
  describe the kept JS Q split (pre-delay Q, d = time − Q), which is what makes the echo fixtures bit-exact.
- D1–D3 (`DECISIONS.md`) landed as T00c (section above).

## W3A: T14 follow-ups (perform review F1 / O1, sleep, carry-overs), marked `INTERFACE-CHANGE(W3A)`

Builder W3A (2026-11-21). No C API, bridge op / event shape, opcode, `Command` / `AudioEvent` or `UnitSlot` change.
Numbered W3A-n so they do not collide with the W3B builder's rows of the same wave.

| # | file(s) | change | why |
|---|---|---|---|
| W3A-1 | `src/model/model.h` (`CommandSink`) | three virtuals with no-op defaults: `sleepChanged(bool render, double wakeMs, int queued)` (the Model's sleep state changed: suspend / resume rendering + the engine's `state` event), `outputLatency()` (s; the sleep / wake ramp lead `clamp(2x, 10, 40 ms)` = audio.js `_rampLead`), `setSlotCount(n)` (rig_meters.slot_count) | audio sleep moved into the Model (`model/sleep.{h,cpp}`, T14-owned); T00c review O2 |
| W3A-2 | `src/model/model.h` (comments), `model.cpp` | `sleep` / `wake` / `sleepState` / `sleepBlockersJson` bodies moved from the T13 stub in `model.cpp` to `model/sleep.cpp` (same signatures); `setLowResource(false)` and `clickStart` call `wake(NaN)` (audio.js lowres2: leaving low-resource and the click wake the audio; no-op when awake); `Model::commit` calls `sink_.setSlotCount(slotCount)`; `Model::set` stores `slots.<i>.params.<key>` before coalescing the send (T13 O2) | contract 1.1 sleep / wake rows, audio.js `_sleepHold`; T00c O2; T13 O2 |
| W3A-3 | `src/api/engine.{h,cpp}` (T08) | `Engine` overrides the three virtuals (`awake_ = render`, `state` event with `sleep: Model::sleepState()`, after a wake `wakeMs` + the real `queued`; `outputLatency()` = `latencySec_`; `setSlotCount` -> `Graph::setSlotCount`). `sleepAudio` = realtime + started check, then `Model::sleep`; `wakeAudio` = `Model::wake` (NaN ramp = the Model's 60 / 5 ms default). The engine's own `sleepState_` is gone (its two readers use `model_.sleepState()`) | one state machine (the Model's), so a `play` while asleep queues, wakes and is replayed (it used to play into a suspended engine, `queued` was always 0) |
| W3A-4 | `src/mix/master_chain.{h,cpp}` (T03; frozen header) | `MasterParam::kMasterOut = 9`: fx.js `out` after the clip curve (before the click, meter and recorder taps), an a-rate `wa::Param` at 1 multiplied in place | the sleep / wake ramp (`audio.js linFrom(fx.out.gain, …)`); `x * 1.0f` is exact, so every render is byte-identical while no sleep runs |
| W3A-5 | `src/bridge/bridge.cpp` (T08) | `opCommit` no longer calls `Graph::setSlotCount` (Model::commit does, W3A-2) | T00c review O2 |
| W3A-6 | `src/graph/graph.cpp` (frozen) | comment only: the rule that a TARGETED `NoteOn` reaches its unit also on a `RetireInst` slot (the Model's mono line of a retiring channel, audio.js `_monoOff -> _monoSwitch`); `kAllSlots` NoteOns still skip retiring channels | T00c review O3 (option "make it a graph rule"); test `unit.perform` "graph rule (T00c O3)" |
| W3A-7 | `src/fx/delay_register.cpp` (T05) | `applyAll` and the `fx.delay.feedback` row send `m.perform().delayFeedback()` (= fx.js `Delay.effectiveFb()`: `clamp(washFb ?? feedback, 0, .9)`) instead of the raw `p.feedback`; includes `model/perform.h` | T14 review F1 (the exact two-line diff). Preconditions checked: `SongGraph::commit` sets `routing_` before the services' `onCommit`; `perf_` exists before any `applyAll` (only `onCommit` / `onSet` call it, never service construction). Test `unit.wheels` "a song switch with a wash wheel up keeps the washed delay feedback" (before: 21 dB lower echo tail) |
| W3A-8 | `src/inst/instrument_service.{h,cpp}` (T11) | `resolveInstrumentParam(sp, key, v)` (the catalogue index / `user:` sampler index and clamp, factored out of `setInstrumentParam`, which is unchanged in effect) and `storeInstrumentParam(m, slot, path, v)` | T13 review O2 (store at call time); T13 O3 (the reused-channel loop needs the index of non-catalogue keys) |
| W3A-9 | `src/model/song.{h,cpp}` (T13) | `SongGraph::occupantFrame(UnitSlot)` (read-only view of the gate's `slotFrame_`); `applyReused` second loop: `cfg.params` keys with no catalogue meta that differ from the previous song's are sent (audio.js `_applySlotCfg`) | T13 O4 (below), T13 O3 |
| W3A-10 | `src/drone/drone_service.{h,cpp}` (T16) | `DroneServiceImpl::wake()` override (DroneHost) = `Model::wake(NaN)` | audio.js drone env `wake`: a drone layer that starts wakes the audio (lowres2) |
| W3A-11 | `src/midi/midi_service.cpp` (T07) | the direct path's note-on / note-off go to `Perform::noteOnFrom / noteOffFrom(kSrcDirect, …)`; `Model::noteOn / noteOff` (bridge `play`) use `kSrcApp` | T07 review O7: one count per pitch across the two paths, as controller.js `heldCount` across its sources (a pitch held by both starts once and ends when the last holder lets go); one path alone is unchanged (a repeated `play on` is still a re-strike) |

T14-owned (no marker needed, listed for the reviewer): `model/perform.h` gains `noteOnTouch`, `noteOnFrom`,
`noteOffFrom`, `NoteSrc`, `sleeper()`, `sendOff` (private; T13 O4: a note-off posted between a commit call and its
future `when` goes to `Inst<slot>` at its own frame, past the gate, instead of waiting for the move to `RetireInst<j>`);
`model/sleep.{h,cpp}` (new). `_debugStats` gains `audioSleep` and `lastWake` (audio.js names);
`sleepBlockersJson` answers `["no-audio"]` on an offline engine (was `[]`), as audio.js.

## Wave 3 tasks T14 / T15 / T16 (markers `INTERFACE-CHANGE(T14)` / `(T16)`), logged by the wave-3 integrator

The builders marked these in the source but did not log them (T14 review O2). All additive; renders of the 112
fixtures are covered by the reviews (T14, T15, T16, W3A, W3B) and by the integrator's g++ / clang re-render below.

| # | task | file(s) | change | why |
|---|---|---|---|---|
| W3-1 | T14 | `src/runtime/command.h`, `src/inst/instrument.h`, `src/inst/voice_alloc.h`, `src/graph/graph.cpp`, `src/graph/instrument_apply.cpp` | O-W3-1: `Op::FadeNote = 26` (target = instrument slot, `aux` = note, `f.a` = seconds), `Instrument::fadeNote(int note, int64_t frame, double seconds)` (default no-op; DECISIONS said `float`, `Command::f` is double), `VoicePool::fadeNote` (one pass, no allocation); decoded in `graph.cpp`, routed in `instrument_apply.cpp`. Overrides: `SynthInstrument`, `SamplerInstrument`, and `XHost` (`inst/synth_extra_host.h`), which hosts both synth-extra and the organ (tests: `unit.organ` "cap, fadeNote, ...", `unit.synth_extra`) | T12 review O3 (re-strike / pedalHold / mono retrigger fade exactly the voice JS fades) |
| W3-2 | T14 | `src/model/model.h`, `model.cpp` | `class Perform` forward, `friend class Perform`, `std::unique_ptr<Perform> perf_` built after the services (installs the reverb quiet probe), destroyed before `sg_`; `commit` / `setRouting` / `onRateChanged` hooks into Perform | the STOPGAP(T12) perform overlay became Model state (`model/perform.{h,cpp}`, T14-owned) |
| W3-3 | T14 | `src/model/song.cpp`, `src/model/stats.cpp` (T13), `src/fx/reverb_service.cpp` (T04), `src/fx/delay_node.{h,cpp}`, `src/fx/lofi.cpp` (T05), `tests/golden_ids/integ.ids` (deleted) | `performBendMorph` in `morphFor`; the effective / deferred reverb stage in `prepare`; `bendEnabled` -> `perform().bendEnabled`; `runtime` in `stateJson`, `sounding` / `pedaled` in `statsJson`; `ReverbPool::onCommit` stages the effective size, deferred while playing (realtime); per-channel `DelayNodeKernel::process` (delayTime evaluated per channel, as Chromium's one `DelayDSPKernel` per channel); `integ.ids` ids moved to `t14.ids` | T14 review O2 (edits outside T14's globs, all read and found correct by the reviewer) |
| W3-4 | T16 | `src/model/patch.h` (`SongState`), `src/model/model.cpp` (`setLowResource`), `src/drone/drone_service.cpp` | O-W3-2: `SongState.lowResource` (additive); `Model::setLowResource` sets it and offers `onSongState` to the **drone service only** (O-W3-2 said "before `forEachService`") | D5 drone freeze. Integrator: the narrower call is accepted (no other service reads the flag; `setFrozen` is idempotent, so the drone's extra `onSongState` calls on tempo / key changes are harmless; T16 review note) |
| W3-5 | T15 | `src/dsp/oscillator.cpp` (T11a; no header change) | T11 O2: `wa::Oscillator::process` makes Chromium 157's three frequency / detune `FinalValue()` pairs per quantum on the k-rate path; T11's `oscProcess` compensation removed | `reviews/T15-O2-landed.md`; T11's 6 synth fixtures, T05 chorus / lofi, T13 twins byte-identical |

## Wave-3 integrator (2026-11-22)

| # | file(s) | change | why |
|---|---|---|---|
| W3I-1 | `src/model/song.cpp` (T13; not frozen) | `instParamValue(sp, CatalogueParam)`: the reuse path's value of a catalogue param. An ENUM row (organ `rotary`; the catalogue gives it no min / max, so min == max == 0) is its index: a name through `inst::instEnumIndex`, a number rounded (the Model stores the index since W3B-4), out of range or absent = the preset default; every other row clamped as before. Used by `paramsMatch` and the first loop of `applyReused` | W3B review N1 (MEDIUM): every rotary value clamped into [0, 0] and compared equal, so a switch between two songs on the same organ preset that differ only in rotary reused the channel and kept the first song's rotary (audio.js:617 compares `'fast' !== 'off'` and builds fresh). Test `unit.organ` "W3B review N1" (fails without the fix: channel reused, 0.35 off a fresh 'off' build; with it < 1e-5, and `'fast'` vs the stored index `1` still reuses). All 112 renders byte-identical before / after (no fixture switches between two organ songs) |
| W3I-2 | `tools/golden/parity.mjs` | the "waits for" list is empty after wave 3: any failing fixture is UNEXPECTED (exit 1) | every task the wave-2 list named is done |
| W3I-3 | `tests/golden_ids/t14.ids` | + `touch-soft`, `-hard`, `-fixed`, `-custom`, `-keyboard`, `bend-modes` (the six fixtures no list compared) | ctest `golden.*` now compares all 112 fixtures |

## UIB: Settings and bridge items of the UI wave (BUILD_PLAN "UI wave: how to start" items 4-7), marked `INTERFACE-CHANGE(UIB)`

Builder UIB (2026-11-22). No C API, opcode, `Command` / `AudioEvent`, `UnitSlot` or frozen-header change; one
additive bridge field (minor 4). All 112 fixtures render byte-identical to the wave-3 integrator's g++ renders.

| # | file(s) | change | why |
|---|---|---|---|
| UIB-1 | `src/bridge/schema.cpp`, `src/bridge/bridge.cpp` (T08) | `config {dynamicRange: number}` → `Model::setDynamicRange` (clamped 1..3, 0.01 steps, non-finite = 1), the reply echoes `dynamicRange` (the range in force); a non-number is `bad-request` (schema). `hello` **minor 4** + capability `dynamicRange` | T12 O1 / UI wave item 5: the Model side existed (INTERFACE_LOG 33) with no bridge row. Test `unit.bridge_dynrange` (new `tests/test_bridge_dynrange.cpp`: hello, echo + clamp + type check + `get state`, ep-rhodes vel 40 at range 3 is 20.9 dB quieter whether the range is sent before the song or to the live sampler) |
| UIB-2 | `native/contract/engine-api.spec.mjs` → `engine-api.json` | `config.args.dynamicRange: 'number?'`, reply `dynamicRange?`; `methods` + `setDynamicRange` (web engine `audio.js:1426`) and the native-only (`nativeOnly: true`) `setPolyphony`, `setVoiceLimit`, `setBufferFrames`, `setDroneFreeze` (63 → 68 entries) | Settings review item 2: the three Sound setters were allow-listed in `surface.test.mjs` instead of contracted; D5 `setDroneFreeze` is the shim's new member |
| UIB-3 | `app/js/engine-bridge/bridge-engine.js` (T09) | `setDynamicRange(range)` (validDynRange, else 1; `config {dynamicRange}`), `setDroneFreeze(on)` (`config {droneFreeze}`; absent = true); `audioconfig` / `_audioCfg` carry `sampleRate` | items 4, 5; Settings review item 4 |
| UIB-4 | `app/js/engine-bridge/mock-native.js` (T09) | `hello` answers `minor` 4 (`MOCK_MINOR`) and the core's capability list (`MOCK_CAPS` + 'mock'); `audio` replies and `state` events carry `bufferFrames` (the request, kept across restarts; `grantFrames` stands in for a rounding device); `config {droneFreeze, dynamicRange}` echoed like the core; `get state.dynamicRange` | T11 O7 / item 7 (the mock answered minor 0); Settings review item 3 |
| UIB-5 | `app/js/controller.js` (UIA's file in this wave; minimal) | `restartAudio`: a request during a restart sets `restartAgain` and runs once more after a successful restart (cleared on failure); `status.audioConfig.sampleRate`; `settings.droneFreeze` → `optional('setDroneFreeze', …)` on change and at start-up when stored false (the web engine has no setter: nothing sent) | Settings review item 1 (exactly the review's change, plus clearing the flag after a failed restart so a stale flag cannot chain into the next unrelated restart), item 4, D5. UIB skeptic: the queued request now resolves with the follow-up run's result (was `false` at once, so Settings › "Restart audio" pressed during a restart toasted "Audio restart failed" while it was queued) and carries its own `opts` (auto or not); a failed restart resolves the queued ones `false`. Test: the item-1 test in `sound2.mjs` (fails on the builder's version) |
| UIB-6 | `app/js/store.js` (UIA's file; key lines only) | `settings.droneFreeze`: optional boolean, absent = on; a non-boolean is dropped on load and refused on set, `null` resets; device-local (not exported, kept on replace-import) | D5 |

The minor is 4, not the 3 the UI-wave item text names: that text predates the dynamicRange row, and the contract rule
(README "additive = minor + capability") makes `config {dynamicRange}` minor 4. The mock answers exactly what the core
answers (`sound-settings.test.mjs` reads `bridge.cpp` and fails if the two disagree).

## UIA: 1..16 slots per song in the UI and the store (BUILD_PLAN "UI wave: how to start" items 1-3, DECISIONS D3), marked `INTERFACE-CHANGE(UIA)`

Builder UIA (2026-11-22). JS only (`app/**` outside `app/js/engine` and `app/js/engine-bridge`); no native, bridge-op,
`engine-api.json` or contract change. The web engine (`app/js/engine`, the 1.x oracle) is unchanged and still gets 4
slots; the bridge engine gets all of them (T00c already takes 16). Details: `CONTRACT_CHANGES.md` "## UIA".

| # | file(s) | change | why |
|---|---|---|---|
| UIA-1 | `app/js/shared/params.js` | `MAX_SLOTS = 16` (new); `parsePath(path, slotCount = SLOT_COUNT)`, `isValidPath(path, slotCount = SLOT_COUNT)`, `expandPaths(slotCount = SLOT_COUNT)` take the slot bound (default 4: what `app/js/engine`, `bridge-engine.js` and `mock-native.js` read, unchanged; `test/unit/engine-bridge/engine.test.mjs` pins `slots.9.gain` before a commit = invalid); `describe` / `clamp` / `formatValue` accept `slots.0..15` (the rows are the same for every slot; the engine only calls them with i < 4); index form `0` or `[1-9]\d?` (no `01`); `slotRole(i)` / `slotName(i)` ('Keys' … 'Bass', then 'Sound 5' … 'Sound 16' with Extra's defaults), `defaultSlot` takes roles 0..15 (was 0..3, RangeError past 15); `slotGainIndex(id, n)`, `learnTargets(n)`; `isLearnable` also takes `slots.<i>.gain` i < 16 (`LEARNABLE`, the Settings rows, unchanged) and `isLearnButton` uses the 16-slot grammar | D3: the grammar goes to 16 while the web oracle stays at 4 |
| UIA-2 | `app/js/store.js` | `SCHEMA = 2`; `migrate()`: schema 1 (and a state without `schema`) keeps exactly 4 slots per song as 1.x did (`legacy`), schema 2 keeps 1..16 (`slotCountOf`); `normalizePatch(raw, {legacy})`, `normalizeSong(raw, id, {legacy})`; slot paths address i < the song's own count; wheel / pedal / knob targets: `isWheelTarget(t, n)` (presets.WHEEL_TARGETS without its slot levels + `slots.<i>.gain` i < n; = WHEEL_TARGETS at n = 4); a `slots` array write of another length writes the whole patch; `addSlot(id, slot?)` / `removeSlot(id, i?)` (later slots move down; targets and scenes follow); loading a schema-1 library with songs first writes its text to a `rig.v1.backup-<ts>` key (`loadInfo.migratedFrom`, `migrationBackupKey`); a song file's own `schema` decides its slot count on import | D3 store SCHEMA bump with an idempotent migration |
| UIA-3 | `app/js/shared/scenes.js` | `normalizeScene(raw, slotCount)` / `normalizeScenes(raw, slotCount)`: one entry per slot, at least 4 (default 4 = 1.x); `captureScene`, `tweakScene`, `sceneMatches` follow the song's count | scenes for 16 slots |
| UIA-4 | `app/js/controller.js` | `engineSlots()` (16 when the engine has the 2.0 setters or says `maxSlots`, else 4; exported on the controller); `call('setParam', 'slots.<i>…')` with i ≥ engineSlots() is dropped; `prepare` / `preload` / `estimatePreloadMB` / `retainReverb` / `setRouting` get the first engineSlots() slots and a wheel target past them as `'none'` (a song the engine plays whole is passed through as the same object); `structuralChange` / `applyParamDiff` look at those slots only; scene levels and learned faders take `slots.0..15` | never route slots ≥ 4 to the web engine; send all 16 to the bridge |
| UIA-5 | `app/js/views/edit/lib.js`, `shell.js` | `blocksFor(n)`, `slotBlock(i)`, `blockOf('slot:0'..'slot:15')`; `BLOCKS` = the 4-slot list (unchanged); the tab row is rebuilt per slot count (`.ev2-slottabs`, scrolling past 4); "Slots n" in the rig bar; wiring strip one column per slot | Edit for 16 slots |

## UIC: UI-wave review follow-ups (UIA O1 / O2, UIB O1 / O2 / O4)

Builder UIC (2026-11-22). JS and docs only. No native, bridge-op or `engine-api.json` change, and the web engine is
unchanged. Details and tests: `CONTRACT_CHANGES.md` "## UIC"; the UI parity count is in `PARITY.md` "UI parity".

| # | file(s) | change | why |
|---|---|---|---|
| UIC-1 | `app/js/views/settings.js` | `learnRowsFor(slotCount, midiLearn)` and `learnName(id)` (exported). The Learn table has one level row per slot of the current song, plus mapped levels past the count. It is rebuilt on song, count or mapping changes. 4 slots or fewer: the 1.x 14 rows (`LEARN_ROWS` unchanged) | UIA review O1 |
| UIC-2 | `app/js/engine-bridge/mock-native.js` (T09) | `set` / `param` validate with `isValidPath(path, MAX_SLOTS)`. `tick.slots` has max(4, song slots) ≤ 16 pairs | UIA review O2; contract tick row |
| UIC-3 | `app/js/controller.js` | `restartAudio`: `restarting` is cleared after `resumeRecording(part)` (`try/finally`), so a request in that window is queued (`restartAgain`); a failed restart clears it before reporting 'stalled' | UIB review O4 |
| UIC-4 | `app/js/engine-bridge/bridge-engine.js` (T09) | An optimistic mirror (`OPTIMISTIC_MS` 400, `_optimistic` / `_reconcile` / `_runtimeNow` / `_wheelNow`) of `pedal` and the tick `runtime` fields (`wheel.*`, `modOwner`, `swelling`, `faded`). It is set by `sustain`, the wheel setters, `swell`, `fadeOutAll`, `noteOn` and `allNotesOff` without `{when}`, and handed back to the tick when one agrees or after 400 ms. `clickStop()` clears `running` / `counting` in `clickState()` at the call. No public member added | UIB review O1 (shim side): audio.js answers these at the call |
| UIC-5 | `test/phase2/ui-core/run.mjs` | Bridge-aware in-page helpers (`window.__t`: `isBridge`, `param`, `transposeNow`, `slotTaps`, `droneMode`, `clickTicks`, `clickRunning`, `pedaled`, `sounding`, `holds`, `soundingHas`, `freshStats`), `waitSong` via `getSlotPlayRange`, the sound check via `slotLevel`, cleanup hooks and `reattachMainPage()`. Web-engine reads unchanged | UIB review O1 (suite side) |

## CORE2B: tick pedal / held / swelling and param read-back (PARITY "UI parity" rows 1-3; UIC S1, O1, O2, O4), marked `INTERFACE-CHANGE(CORE2B)` where the file is frozen

Builder CORE2B (2026-11-22). One additive bridge change (`get {what:'param', path}`, `hello` **minor 5**, capability
`getParam`); no C API signature, opcode, `Command` / `AudioEvent`, `UnitSlot` or `rig_meters` layout change. Details,
tests and numbers: root `CONTRACT_CHANGES.md` "## CORE2B".

| # | file(s) | change | why |
|---|---|---|---|
| CORE2B-1 | `src/graph/graph.{h,cpp}` (frozen) | `Graph::setPerformMeters(pedal, held)`: one relaxed atomic word `[held:16 \| pedal:1]` (`perfMeters_`), written by the control thread, read once per quantum by the snapshot fill into `rig_meters.pedal` / `held` (both were never set: always 0) | UIC S1: `rig_get_meters` documents "the same values the tick carries"; wait-free on the audio thread |
| CORE2B-2 | `src/api/engine.cpp` (T08; not frozen) | `buildTick` writes `pedal` / `held` from `Perform::pedal()` / `held().size()` on the control thread (was the never-filled snapshot: every tick said `pedal:false, held:0`) and `runtime` from `Perform::tickRuntimeJson()` (+ `swelling`); `publishPerformMeters` feeds CORE2B-1 once per control-loop pass (realtime) and before each offline quantum; `rig_test_query("getParam:<path>")` answers like `get param` (`null` = undefined) | PARITY rows 2, 3: the Perform pedal lamp / strip pedal lights went dark 0.4 s after pedal down; the tick row 6.5 lists `swelling` |
| CORE2B-3 | `src/model/perform.{h,cpp}` (T14; not frozen) | `Perform::tickRuntimeJson()`: `runtimeStateJson()` + `swelling` (`swellActive_ != 0`, the `wheelValuesJson` rule). `get state`'s `runtime` keeps the audio.js `getRuntimeState()` shape (no `swelling`) | contract 6.5 tick `runtime:{wheel, modOwner, faded, swelling}` |
| CORE2B-4 | `src/model/param_read.{h,cpp}` (new) | `readParam(Model&, path)` -> `{known, defined, json}`: audio.js `getParam` over the Model's resolved patch (PARAMS value space: enum names, booleans, `'natural'`; slot EQ b-rows resolved, legacy rows stored or default; instrument params stored, else the catalogue's `default` literal, organ `rotary` index -> name, a boolean row's stored 0/1 -> boolean; `drone.*` from the live `DroneCore`, else the patch) | PARITY row 1 / UIC O4: no contracted read-back |
| CORE2B-5 | `src/bridge/schema.cpp`, `src/bridge/bridge.cpp` (T08) | `get`: `what` gains `'param'`, new optional arg `path` (String) + variant `get param` needs `path` (else `bad-request`); `opGet` replies `{path, value?}` (`value` absent = undefined) or `unknown-param`; `hello` minor 4 -> **5** + capability `getParam` | additive = minor + capability (contract README) |
| CORE2B-6 | `native/contract/engine-api.spec.mjs` -> `engine-api.json`, `README.md`; `native/docs/ENGINE_CONTRACT.md` | `getParam` moves from `notContract` to `methods` (68 -> 69; `bridge: {op:'get', what:'param', local:'mirror reconciled by get param'}`); `get` op args/reply/maps; tick data names the `runtime` members; ENGINE_CONTRACT 1.x row, 1.7, 6.2 (minor 5), 6.4 `get`, 6.6 (the shim's mirror) | contract the read-back |
| CORE2B-7 | `app/js/engine-bridge/bridge-engine.js` (T09) | `getParam(path)` (sync): mirror per path = the core's last `get param` answer unless overtaken (per-path generation bumped by `setParam`, epoch bumped by `commit`), else the shim's PARAMS-clamped `setParam` value, else the committed patch (`patchParam`); every unconfirmed read sends one `get param` (one in flight per path, FIFO behind the pending `set`s; skipped when `hello.minor` < 5); `drone.configure` drops `drone.*` | the UI tests read `engine.getParam` synchronously (`__t.param`) |
| CORE2B-8 | `app/js/engine-bridge/param-read.js` (new), `mock-native.js` (T09) | `patchParam(patch, path, catalogue)` (pure); the mock answers `get param` (latest `set` clamped, else the committed patch; `unknown-param`, `bad-request`), clears its set map on commit, `MOCK_MINOR` 5 + `getParam` | the mock answers what the core answers (`sound-settings.test.mjs` compares them) |
| CORE2B-9 | `tests/test_t00c.cpp`, `test/unit/engine-bridge/{sound-settings,surface}.test.mjs` | accept minor 5 / `getParam`; the contract's method count 69 | |

## CORE2A: asynchronous sample loading on the realtime control loop (PARITY "UI parity" rows "every factory song" and the polish-2A / v11-metronome / v11-decisions timing row)

Builder CORE2A (2026-11-22). No frozen file changed (no `INTERFACE-CHANGE` marker), no op, argument or reply shape
changed, so no `hello` minor of its own. One behaviour change on the wire (CORE2A-2: the realtime `prepare` reply
now comes when the new song's samples are decoded, which is what contract 1.2 `prepare` and `audio.js` already say).
Details and numbers: root `CONTRACT_CHANGES.md` "## CORE2A".

| # | file(s) | change | why |
|---|---|---|---|
| CORE2A-1 | `src/bridge/bridge.cpp` (T08) | `cache preload` goes through `CacheServiceImpl::preloadAsync`; the reply (same `{decodedMB, pinnedMB, deferred}`) is sent from the control loop's `pump()` when the op's decodes are done. Offline the decodes run inline and the reply goes out before `handle` returns, as before. `Model::preload` (frozen, synchronous) is unchanged and no longer used by the bridge when the cache service exists | PARITY row 1: `CacheServiceImpl::preload` pumped in a loop on the control thread, so no tick and no `play` for 0.5-3.1 s per cold song |
| CORE2A-2 | `src/bridge/bridge.cpp`, `bridge.h` (T08) | realtime `prepare`: the `{token}` reply waits until none of the samples the new sampler units requested is still decoding (`CacheServiceImpl::samplerLoadKeys` before `Model::prepare`, `whenSettled` after). A newer `prepare` sends the replies still waiting at once (`Bridge::pendingPrepares_`: superseded tokens). Offline and without samplers in flight: at once, as before | `audio.js` prepare awaits `inst.ready`; the controller commits only then, so the old song plays on and notes in the window sound on it. Before, the shim committed at once and the new sampler played its partial (often empty) table until the decodes landed |
| CORE2A-3 | `src/samples/decode_pool.{h,cpp}` (T06) | `ThreadPool`: lowest priority first and, within a priority, the **newest** job first; workers lower their own priority (Apple `QOS_CLASS_UTILITY`, Linux nice 10) | supersede: the newest song switch is decoded first (a `prepare` posts all its jobs at once). Two preloads interleave instead (CORE2A skeptic: a preload keeps at most 6 decodes queued and each follow-up is the newest job; measured 4.40 vs 4.53 s), which 1.x does not order either; ARCHITECTURE section 3 "decode workers: utility QoS" |
| CORE2A-4 | `src/samples/buffer_cache.{h,cpp}` (T06) | a request that joins a key whose job no worker has started re-posts that job at its own priority (`queued_`, a shared `claimed` flag: the first copy a worker takes decodes, the others return); `whenSettled(keys, done)` | a song switch must not wait behind a preload (priority 1) or a superseded switch that queued the same key first |
| CORE2A-5 | `src/samples/cache_service.{h,cpp}` (T06) | `samplerLoadKeys(patch)` (the keys `SamplerService::build` requests), `whenSettled(keys, done)` | CORE2A-2 |
| CORE2A-6 | `src/inst/sampler_service.{h,cpp}` (T12) | a load that finishes before its unit is attached (prepared, not yet committed: units attach at commit) keeps its final table and sends it at the next commit, at the commit's `when`, after its `AttachUnit`; a load of a superseded prepare is refused by instSeq as before | latent race made systematic by CORE2A-2: the table went to the old unit in that slot, was refused, and the new sampler kept its partial table for good (`unit.runtime_cache` mackit O1 then counted 0 of 128 voices) |
| CORE2A-7 | `tests/test_runtime_preload.cpp` (new, `unit.runtime_preload`), `tests/test_runtime_cache.cpp` | 4 realtime cases over a slowed synthetic decoder (tick gaps, `play` latency, prepare waits, supersede of prepare and preload); the mackit O1 teardown case no longer waits for the prepare reply (it would now come after the decodes it means to interrupt) | |

## CORE3: synth / organ units built off the control thread, neighbour prebuilds (CORE2A O2; BUILD_PLAN "UI wave + CORE1 / CORE2 results", T11 / T15 / T13)

Builder CORE3 (2026-11-22). No frozen file changed (no `INTERFACE-CHANGE` marker: `song.h`, `song.cpp`,
`graph_build.cpp`, `engine.cpp`, `bridge.{h,cpp}` are not in BUILD_PLAN "Frozen interfaces"), no op, argument or reply
shape changed, so no `hello` minor of its own (the minor-5 comment in `opHello` and ENGINE_CONTRACT 6.2 name the
timing, as for CORE2A). Offline nothing changes (every unit built inline at prepare; no worker thread exists):
renders unchanged. Details and numbers: root `CONTRACT_CHANGES.md` "## CORE3".

| # | file(s) | change | why |
|---|---|---|---|
| CORE3-1 | `src/model/build_worker.{h,cpp}` (new, T13) | `BuildWorker`: one thread at utility priority (Apple QoS utility, Linux nice 10), priority 0 (song switch) before 1 (prebuild), FIFO within (superseded by CORE3-9: two lanes); `BuildJob`: a registry factory + private copies of the slot patch / `UnitEnv` / `SongState`, claimed once by compare-exchange (worker, or the control thread at a commit: `finish` builds inline if unstarted, else waits); unwanted jobs are skipped, their units freed with the last reference (never attached) | CORE2A O2: an organ is 60-70 ms (8 drawbar PeriodicWaves), a first wavetable family 80-300 ms, a 16-slot song 240-290 ms, all on the control thread |
| CORE3-2 | `src/model/song.{h,cpp}`, `graph_build.cpp` (T13) | realtime `SongGraph::prepare`: fresh `synth` / `organ` slots become jobs (instSeq assigned at prepare as before), strips are built inline (< 1 ms); `commit` takes every job's unit first (`takeBuilt`); `whenBuilt(token, fn)` / `planBuilt()` / `pumpBuilds()`; a superseded plan's jobs join the prebuilt set (demoted to priority 1); `onRateChanged` re-posts pending jobs at the new rate and drops the prebuilt set; new `_debugStats` members `buildsOffThread`, `buildsAtCommit`, `prebuildHits`, `prebuildPosted`, `prebuildEvicted`, `prebuilt`, `prebuiltMB`, `prebuiltDone`, `buildsPending` | the old song plays on and the control loop keeps handling input, scenes and ticks while the new one is built |
| CORE3-3 | `src/model/song.{h,cpp}`, `graph_build.cpp` (T13) | `SongGraph::prebuild(patches)`: the synth / organ slots of the patches (minus slots the playing song would reuse) are built at priority 1 and kept, keyed by slot + type + id + params text + release + rate, LRU, capped at 64 MB (iPad 32 MB) charged 6 MB per organ and 2.7 MB per synth (measured RSS 5.8 / 2.1-2.6 MB); `startFresh` adopts a match (promoted to priority 0 if still queued); `dropPrebuilt()`. A prebuilt unit's instSeq is taken when it is prebuilt (contract 7.15: still one per instrument built, unique; its rng stream name differs from the one an inline build at the switch would have had: realtime only, no golden reads it) | Ryan: "load neighbouring songs ahead of time": a Next / Prev switch to a neighbour adopts its units and builds nothing |
| CORE3-4 | `src/bridge/bridge.{h,cpp}` (T08) | realtime `prepare`: the reply waits for the samples (CORE2A) **and** `whenBuilt` (`PendingReply::waits`); `cache preload` with `pin` other than `none` and at most 5 patches calls `SongGraph::prebuild` before the decodes are posted | 1.x `prepare` resolves after building; the controller commits after the reply. Pinned preloads are controller.js `pinWindow` (current +-1 library, +-2 large set, `replace`) and `preloadNeighbors` (`add`); `none` warms a large set's rest, > 5 songs is a whole setlist |
| CORE3-5 | `src/api/engine.cpp` (T08) | the control loop calls `songGraph().pumpBuilds()` after `pumpCache()`; the build worker wakes the loop through the CORE2A `WakeLink` (created for realtime even without a cache service); `memoryPressure` drops the prebuilt set first | prompt prepare replies; teardown safety as CORE2A |
| CORE3-6 | `tests/test_core3.cpp` (new, `unit.core3`) | 5 cases: switch to a 16-organ song during live play (tick gap, `play` mid-switch, reply after the build, commit), prebuilt neighbour switch with no build, supersede with prebuilt and unbuilt songs (+ switch back adopts the superseded units, newest built first), commit before the reply, offline unchanged | |
| CORE3-7 | `native/docs/ENGINE_CONTRACT.md` 6.2 | the minor-5 timing sentence names CORE3's timing (no shape change) | |
| CORE3-8 | `native/core/CMakeLists.txt`, `.github/workflows/native-core.yml` | `unit.core3` runs `RUN_SERIAL` (its 50 ms tick-gap bound is not meant to hold next to the CPU benchmark suites under `ctest -j2`: 72 ms seen there at load 5); `core3` joins the CI TSan regex | |
| CORE3-9 (finish pass) | `src/model/build_worker.{h,cpp}`, `graph_build.cpp`, `song.{h,cpp}` (T13) | `BuildWorker` has two lanes: lane 0 (song switches) at the default thread priority, lane 1 (prebuilds) at utility priority; `promote(job)`: a prebuilt job still queued moves to lane 0, one the prebuild lane is building is not waited for (`startFresh` builds its own copy in lane 0 and keeps the other prebuilt; stat `prebuildBusy`); superseded switch jobs still queued move to lane 1. Test hook `BuildWorker::testPrebuildDelayMs` (tests only) | handoff: is a `prepare` queued behind a prebuild? Yes: one utility-priority thread served both, so a switch waited for the prebuild in progress, and on a busy box its own builds starved (16 organs 13-14 s instead of 1.1 s next to two busy threads; `unit.core3` "prebuild in flight": 5.2 s before, 0.3 s after) |
| CORE3-10 (finish pass) | `src/inst/synth_dsp.cpp` (T11), `src/inst/synth_extra_dsp.cpp` (T15) | `WaveBank::get` / `XWaveBank::get` build a missing bank outside the bank mutex (two threads that miss at once may both build: same tables; the cache keeps the larger) | the prebuild lane building a cold bank (80-300 ms, longer when starved) held the mutex a switch build or a rate change on the control thread then waited for |
| CORE3-11 (finish pass) | `src/bridge/bridge.cpp` (T08) | a superseding `prepare` sends the replies still waiting also when it has no `id` | the superseded plan's `whenBuilt` callback dies with the plan, so before this the older `prepare` was never answered |
| CORE3-12 (finish pass) | `tests/test_core3.cpp` | flake fixed (the supersede bound is measured from the newer `prepare`'s post; the switch tick-gap bound is 50 ms or 1.3 x the idle loop's own largest gap on a loaded box); new cases: prebuild in flight, no-id supersede, cap / LRU / memory pressure (64 / 32 MB) | macOS CI `145.8 < 80` (test_core3.cpp:344) and the old session's 3 of 6 local failures |

## MACFIX: Mac check #3 `unit.synth` / `unit.synth-extra` (test-order bug, not a link bug)

Builder MACFIX (2026-11-22). No frozen file changed, so there is no `INTERFACE-CHANGE` marker. No op, reply, C API or
registry change. One behaviour change in a T11 module interface (MACFIX-1). Root cause and evidence:
`MAC_CHECK.md` "Mac check #3". In short, nothing registers from a static initializer.
`ensureModulesRegistered()` (frozen `api/registry.cpp`) calls every generated `rig_register_*` by name, and
`rig_create` calls it. Two tests read or overrode the T15 hook before the first `rig_create` of their ctest process.
That only happens when `native/golden/out` is absent, because the golden-fixture cases that normally create the
first engine skip.

| # | file(s) | change | why |
|---|---|---|---|
| MACFIX-1 | `src/inst/synth_dispatch.{h,cpp}` (T11) | `synthExtraFactory()` and `makeSynthExtra()` call `ensureModulesRegistered()` before they read the hook (once per process; afterwards one atomic check). Header comments: an override must follow the registration; never read the hook from a `rig_register_*` function (`std::call_once` is not reentrant; none does). | A read before any engine existed saw nullptr (`test_synth_extra.cpp:86`). An override made then was replaced by the next `rig_create`'s registration (`test_synth.cpp:260-261`). |
| MACFIX-2 | `tests/test_synth.cpp` | The T15-absent case calls `rig::ensureModulesRegistered()` and `REQUIRE`s a non-null hook before it saves and overrides the hook. | Makes the order explicit. |
| MACFIX-3 | `tests/test_registry_link.cpp` (new, `unit.registry-link`) | Two cases, no golden files needed. (a) After one `rig_create`, the registry holds every unit kind (13), service (15) and set-handler prefix (11) of the core, and the T15 hook is set. (b) Through the bridge alone, the 10 synth-extra ids, `warm-pad` and `organ-gospel` commit without `unsupported` and sound (RMS > 1e-4). | Fails when `rig_create` skips the registration (mutation: 38 assertions in (a)), or when T15's `registerSynthExtra` call is removed (mutation: 32 assertions, both cases). Passes in any test order, because it is its own ctest process. |
| MACFIX-4 | `tools/mac/check.sh` | `core` stage: the golden note gives the number of `golden.*` tests not run (`ctest -N -L golden`) and says that the golden-WAV cases inside `unit.*` skip too. | Mac 70 vs Linux 82 is the 12 `golden.*` tests, excluded by design when `native/golden/out` is absent. No suite was missing. |
| MACFIX-5 (skeptic) | `tests/test_synth_extra.cpp` | New first case of `unit.synth-extra`: "the synth-extra hook is set when read before any engine exists" (one `CHECK`). | MACFIX-3 passes with the b9a0c27 hook code, and on Linux the golden case of this suite creates an engine first, so nothing in the Linux gate caught a revert of MACFIX-1. This case does (mutation: fails with `native/golden/out` present). `reviews/MACFIX.md`. |
