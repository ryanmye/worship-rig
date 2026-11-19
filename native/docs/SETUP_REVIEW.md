# 2.0 setup review (critic pass)

Scope: everything the six setup agents wrote on `v2-native` (contract, golden harness, architecture, WebKit audit, C++
core skeleton, JS bridge + Apple shell). Every number below was re-measured here, not copied from a report.
Severity: **BLOCKER** (do not start the affected waves) · **HIGH** · **MEDIUM** · **LOW**. "Fixed" = changed in this
pass. "[Mac]" = only a Mac/iPad can confirm. "[verify]" = a claim neither I nor the author checked against a source.

## 1. Verified numbers

| check | result |
|---|---|
| `native/core` clean configure + build, g++ 13 Release, `ctest` | 13/13 pass (3.1 s); golden.eq = 18/18 `eq-*` exact |
| same, clang 18 Release | 13/13 pass |
| same, ASan + UBSan (RelWithDebInfo) | 13/13 pass, no sanitizer output (re-run after this pass's edits) |
| TSan | not re-run (skeleton report: queues/offline/bridge/realtime clean) |
| `node --test test/unit/engine-bridge/*.test.mjs` | 89/89 pass (after this pass's contract fix and test edit) |
| `test/unit/engine-bridge/boot-smoke.mjs` (Playwright, real UI vs mock) | exit 0; 164 sent / 66 requests / 66 replies / 0 timeouts / 0 validation findings / 0 page errors |
| `node tools/golden/compare.mjs --self-test` | OK: 8 goldens pass vs themselves; 24/24 perturbations detected |
| `node native/contract/tools/build-engine-api.mjs --check` | up to date (63 methods, 10 events, 102 rows, 44 instruments, 14 ops, 9 events) |
| `node test/run-all.mjs --only unit` (existing suite, includes engine-bridge) | PASS: 488 pass, 0 fail, 7 skip, 18.5 s |
| files changed outside `native/ tools/golden/ app/js/engine-bridge/ test/unit/engine-bridge/` since the 1.1 tip (29eb984) | `.gitignore` (+1 line `native/golden/out/`, golden agent, declared) and `.github/workflows/native-core.yml` (core agent, declared). No existing `app/` file touched. |
| lines > 120 in code | 2 in `native/contract/engine-api.spec.mjs` (121, 122), 1 in `boot-smoke.mjs` (121); markdown table rows in the docs (accepted) |

## 2. Fixed in this pass

| id | file(s) | change |
|---|---|---|
| G1 | `native/contract/engine-api.spec.mjs` → regenerated `engine-api.json`; `test/unit/engine-bridge/validation.test.mjs` | `song`, `drone`, `config` ops list `when: 'engine s?'`; the test that pinned the gap now asserts no unlisted fields |
| G2 | same spec | `set` `path`/`value` optional (required unless `batch`) |
| S1 | `native/apple/Sources/Shared/RigHost.swift` | init read `self.scheme`/`self.bridge` before `super.init` (Swift error "self used before super.init"); now built from locals |
| S2 | `RigHost.swift` | two `NSLog("%s", String)` (Swift String through `%s` = garbage/crash) → `%@` |
| S3 | `Sources/Audio/rig_apple_audio.{c,h}`, `rig_apple_midi.c`, `RigMIDI.swift` | `AudioConvertHostTimeToNanos`/`NanosToHostTime` and `<CoreAudio/HostTime.h>`, `<CoreAudio/CoreAudio.h>` are macOS-only: the iPad target could not compile. Added `rig_apple_host_to_ns`/`rig_apple_ns_to_host` (mach_timebase_info, 128-bit multiply), guarded the CoreAudio include with `TARGET_OS_OSX`, dropped `import CoreAudio` from RigMIDI |
| S4 | `RigMIDI.swift` | refCon string was `free`d right after `MIDIPortDisconnectSource` while a receive block may still run on the CoreMIDI thread (use-after-free); strings now live for the process (one per uniqueID) |
| R1 | `native/core/src/api/engine.{h,cpp}` | `awake_` (control thread writes, `rig_render` reads) and `outCh_` (host thread writes, audio thread reads) were plain fields: data races. Now `std::atomic` |
| A9 | `native/core/CMakeLists.txt` | `rig_third_party` built without `-ffp-contract=off` (clang on arm64 fuses FMA by default in pffft/dr_mp3 → x86/arm64 drift on parity paths); added |
| T1 | `tools/golden/compare.mjs` | self-test printed `PASS` on perturbation rows (meaning "detected"); now prints `detected` |
| — | `native/docs/SHELL.md` | G1/G2 marked closed |

All edits re-verified with the commands in section 1. The Swift/C edits are UNBUILT like the rest of `native/apple`.

## 3. Findings (open)

Counts: **BLOCKER 3 · HIGH 9 · MEDIUM 13 · LOW 7** (plus 2 informational: 9, 32).

### 3.1 Build plan (task independence and definition of done)

1. **BLOCKER: the T00 "frozen interfaces" do not exist.** BUILD_PLAN freezes `Command`, `Model` methods,
   `SlotChannel/Reverb/Delay/Chorus/Lofi/MasterChain` construction, `Instrument` virtuals, `BufferCache`, `TestHooks`,
   `runtime/epoch.h`, `runtime/offline_driver.cpp`. The skeleton has none of the classes; `Op` has 12 values; `Graph`
   knows 4 test slots, `Tap` 5 names, `InjectNode` 1. Every wave-1 task would therefore edit `runtime/command.h`,
   `graph/graph.{h,cpp}`, `model/model.{h,cpp}`, `api/engine.cpp`, `tools/common/fixture_runner.cpp` → constant merge
   conflicts. **Change:** insert **T00b interface freeze** (1 agent, serial, S–M) before wave 1:
   (a) `Op` gets one reserved block per task (`T02 = 0x0200…`, `T03 = 0x0300…`, …) or a generic `Op::Unit` with
   `target = unit id, sub = unit op`; (b) `Graph` holds abstract `RenderUnit*` members (4 strips, reverb, delay,
   chorus, lofi, master chain, click, drone, instrument slots) with silent stubs and per-module factory functions
   declared in each module's own header; (c) `Tap`/`InjectNode` = the full name tables of `tools/golden/page.js`,
   returning `UNSUPPORTED` until a unit registers; (d) `fixture_runner` understands every `setup` key the manifest uses
   (`patch, inject, tap, tempo, timeSig, click, drone, key, keyContext, wheel, reverb, params, loopSec, prerollSec,
   seamSec`) and every event type (`noteOn, noteOff, pedal, param, cc, wheel, droneKey, clickStart, clickStop`);
   (e) `epoch.h`; (f) bridge op dispatch → `Model` stub methods one per contract member. **Done:** a dummy module added
   in a scratch dir registers a unit, a tap and an op without editing any file outside that dir.
2. **BLOCKER: ownership holes.** No task owns `src/graph/**`, `src/model/model.*`, `src/model/patch.*`,
   `src/api/engine.*`, `tools/rig_render/`, `tools/common/`. **Change:** T00b owns them; afterwards only the
   orchestrator edits them (from agent reports), like `src/**/*.h`.
3. **BLOCKER: hidden wave-2 dependencies inside wave 1.** `fx.js` builds 5 `OscillatorNode`s (chorus LFO, lofi
   wow/flutter), 1 `AudioBufferSourceNode` (crackle loop) and 1 `ConstantSourceNode`; `metronome.js` plays clicks with
   `AudioBufferSourceNode`. T05 (chorus, lofi) and T07 (click) are wave 1, but oscillator/buffer source belong to T11
   (wave 2). **Change:** move `dsp/oscillator*`, `dsp/periodic_wave*`, `dsp/buffer_source*`, `dsp/constant_source*`
   to a new wave-1 task **T01b sources** (deps T00b, T01 for PRNG phases); T11 keeps voice/synth/allocator/registry.
4. **HIGH:** T09 targets `app/js/engine/native/` but the facade already exists as `app/js/engine-bridge/`
   (`bridge-engine.js` 985 lines, 89 tests, boot smoke). **Change:** T09 owns `app/js/engine-bridge/**` +
   `test/unit/engine-bridge/**` + `native/devhost/`; its scope becomes devhost, WebSocket transport, the JS recorder
   adapter (G10) and G3–G11 below.
5. **MEDIUM:** T02 (filters/strip) is half done (biquad + SlotEq pass 18 `eq-*`) and T10 (shell) has a skeleton;
   restate both as "extend", otherwise an agent may rewrite working code.
6. **MEDIUM: DoDs that are not pass/fail.** T06 "report max diff; target ≤ 1e-4" → "pass if ≤ 1e-4 on ≥ 18/20
   samples; otherwise finding 13's PCM override is mandatory". T11 "→ exact where E" (E undefined) → "every fixture
   with `exactIfPrngPorted` passes the exact tier". T15 "keep audible result of Q11" → name the fixtures and
   tolerance. T16 depends on Ryan's Q7 (freeze) → mark blocked-on-decision. T13 "tests ported from
   test/phase1/engine" → list the files. T04 CPU target "✗ Linux" → add a Linux `rig-bench` ceiling (e.g. 8 % of a
   core here) so the task can fail on this box.
7. **MEDIUM:** the exact-tier promotion pass "after T14" has an owner ("the golden harness task") with no task id.
   **Change:** add **T17 golden promotion + new fixtures** (owns `tools/golden/**`, `native/golden/**`), and make PRNG
   draw-order parity part of each instrument task's DoD instead of a single late pass (40 of 41 statistical fixtures
   are weak tests until promoted; tolerances reach 16.4 dB per band, env-corr 0.73, and env-corr is disabled (-1) for
   `chorus-default-sine`, `drone-freeze-dry/-wet`).
8. **LOW:** critical path is stated as T00 → T01 → T11 → T13 → T14, but T13 depends on T02–T05 including T04 reverb
   (L). Realistic path: T00b → T01 → T04 → T13 → T14, about as long; plan T04 first in wave 1.

### 3.2 Contract completeness

9. **Independent grep** (controller.js `call/optional/droneCall` names, main.js, views/**, components/**, shared/**,
   recorder.js, midi-clock.js, `mini.js` = no engine use): 49 distinct engine members used. All are in
   `engine-api.json` except `_fade` (perform.js:1515 fallback when `getRuntimeState` is missing; listed in
   `notContract`, harmless because the shim implements `getRuntimeState`), `_factorFor` (a comment only, perform.js:90)
   and `slotAnalysers`/`auditionNote` (probed by eq-keyboard, documented as absent). Events: 11 emitted, 10 contracted
   (`stats` unlistened). **No missing member.**
10. **HIGH: recorder (G10).** `recorder.js` connects `engine.recordTap` (an AudioNode) to an AudioWorklet on
    `engine.ctx`. Under the bridge the fake ctx has no worklet, so recording silently disappears. Core side (`rec`, M17,
    T08) exists in the plan; the JS side has no owner. **Change:** T09 writes a `NativeRecorder` facade with the
    `recorder.js` public surface over the `rec` op/events, plus a 1-line selection in recorder.js (an app edit Ryan
    approves, like the main.js import).
11. **MEDIUM: open bridge gaps G3–G9, G11, G12** (SHELL.md) still unassigned. Owners: G3 (sync `clickStart`
    estimate), G5 (`sampleStatus` shape), G6 (idle tick 4 Hz = clock cap 0.25 s: raise idle to ≥ 8 Hz or the cap to
    0.5 s), G7 (`hostLatency` in tick schema), G8 (batch `play:input`; `cache` preload/estimate 11× at boot) → contract
    agent/T08; G4 (`midiClock.port` id) → T07; G9 (`state` before `load{start}` and before the `audio start` reply) →
    T08 conformance test; G11 (`get devices` unused; settings.js/latencyHint.js need an app edit) → T09 + Ryan.
12. **HIGH: golden coverage holes.** Matrix (contract area × fixtures that exercise it):

| contract area | fixtures |
|---|---|
| slot EQ (single band b4/b8, 6 types) | `eq-*` (18) |
| master EQ / glue / limiter / width | `master-eq`, `glue-*` (3), `limiter-*` (3), `width-*` (3) |
| reverb / echo / chorus / lofi | `reverb-*` (6), `echo-*` (6, with `tempo`), `chorus-*` (2), `lofi-*` (2) |
| synth / organ / sampler voices | 16 synth (+ drone-osc via drones), 4 organ, **2 of 23 samplers** |
| noteOn/noteOff | 37 fixtures; `pedal` 4; `cc` 1 and `wheel` 1 (`auto-modwheel-cc`) |
| setParam automation | 9 paths: `slots.i.gain`, `params.cutoff/resonance`, `sends.reverb/delay`, `fx.reverb.returnGain`, `fx.delay.feedback`, `master.volume`, `drone.gain` |
| touch curves | `touch-*` (5) |
| keyContext / scene / songs | `song-*` (3), `scene-glide` |
| drone synth / freeze | `drone-synth-2keys`, `drone-synth-stage`, `drone-freeze-*` (2) |
| click + timeSig + count-in | `click-120-44`, `click-90-68-countin` |
| **never exercised** | pan ≠ 0 (both StereoPanner laws, a §3.1 parity item), octave/transpose, pitchBend (all modes incl. tape), swell, mono/legato, panic/allNotesOff/fadeOutAll, setRouting, eqAudition, multi-band EQ chains + type-change fade + legacy `eq.low/high/mid*` rows, `release`, `pedalHold`, prepare/commit supersede + retire crossfade, sleep/wake, lowResource, drone files/chordFollow, click aux/record, MIDI direct route, meters/RTA, recorder |

55 of 102 PARAMS rows are never set to a non-default value or automated by any fixture. **Change (T17):** add
~10 fixtures: `pan-mono-sampler` and `pan-stereo-synth` (pan ±0.5/±1), `transpose-octave`, `bend-normal` +
`bend-tape`, `swell-8s`, `mono-legato`, `eq-chain-4band` + `eq-type-change` (mid-note), `eq-legacy-rows`,
`release-pedalhold`, `fadeout-panic`, `routing-switch`, 3 more samplers (one stereo, one with velocity layers, one
with release override). Logic-only areas (prepare/commit, sleep, lowResource, MIDI route, meters) go into T08/T13/T14
conformance tests generated from `engine-api.json`.

### 3.3 Architecture

13. **HIGH: sampler exact tier rests on decoder parity that will not hold.** `sampler-*` (exact, 2e-4) decode MP3
    through Chromium's FFmpeg decoder; native uses dr_mp3 (minimp3 lineage). Different float synthesis code, possibly
    different LAME gapless/encoder-delay handling, then +9.3 dB trim. **Change:** T06 dumps Chromium-decoded PCM for
    every sample the fixtures use; `rig-golden` loads those dumps through a test hook (`samples.pcmOverride`) for
    exact fixtures; decoder parity is its own test with its own tolerance.
14. **HIGH [verify]: V8 math assumption.** ARCHITECTURE §6/§8 say V8 `Math.*` = fdlibm `ieee754.cc`; the vendored
    copy is V8 12.4.254, and the core agent's third_party README says current V8 forwards exp/log/sin/cos/pow/tanh to
    LLVM libc (correctly rounded). The goldens come from Chromium 157. If V8 there is correctly rounded, the vendored
    fdlibm is the wrong oracle and any correctly-rounded libm (CORE-MATH, MIT; LLVM libc, Apache-2.0 + LLVM exception,
    GPL-3 compatible) gives identical bits. **Change:** T01's first step dumps those six functions on ~1e6 inputs from
    the golden Chromium and picks the matching implementation; fix §6 and §8.2 accordingly.
15. **HIGH: data races and rate change in the runtime.** `sr_` (plain double) is written by `rig_host_audio_started`
    on the host's thread and read by the audio and control threads; `graph_.setSampleRate` runs on the host thread.
    (`awake_`/`outCh_` fixed, R1.) **Change:** host callbacks only enqueue; the control thread applies a rate change
    while the device is stopped (command to the graph); `sr_` atomic. Add a TSan test that calls
    `rig_host_audio_started` while rendering.
16. **HIGH: engine time is `frames / sr_`.** A device rate change (48 k → 44.1 k) makes `t` jump, backwards when
    the rate rises, breaking contract §6 "never goes backwards". **Change:** `t = t0 + (frames − f0)/sr`, rebased on
    every rate change; specify in ARCHITECTURE §3/§5 what is rebuilt on a rate change (IRs, resampled cache, wavetables,
    coefficients, delay lines) and add it to T08's DoD (test: t monotonic across a switch).
17. **HIGH: pin the Chromium source revision.** The kernel ports (compressor, PeriodicWave and its interpolation,
    Up/DownSampler, AudioParamTimeline, SincResampler, Biquad) must follow the exact Chromium that rendered the goldens
    (157.0.8103.78); ARCHITECTURE names none. Add the tag to §6 and to each ported file header.
18. **MEDIUM: audio→control event ring overflow** (4096) drops `VoiceEnded`, so the Model never frees that voice or
    retiring channel. **Change:** the graph also keeps per-voice/channel "ended" bits the Model scans when the ring
    reports a drop; `Garbage` events must never drop (separate ring sized ≥ attachable objects, or an intrusive list).
19. **MEDIUM: iPad memory arithmetic.** §7 claims reverb units/IR cache 4/4 "≤ 30 MB". Worst case (8 s bucket at
    48 kHz): 4 × 8.1 MB spectra + 4 × 4.1 MB IRs = 48.6 MB, plus the 12 MB kernel-build peak ≈ 61 MB. **Change:**
    cap reverb memory in bytes (LRU by bytes, e.g. 32 MB) or correct the figure. Also [verify]: the iPadOS 17.5 floor
    admits the iPad 6th gen (A10, 2 GB RAM), below the "A12–A14 class" the 450 MB budget assumes: either a 2 GB
    profile (cache ≈ 160 MB) or a stated minimum device.
20. **MEDIUM: cache units.** iPad cache = 320 MB **int16**, but `estimate` is 1.75 MB/sample (float32, JS) and the
    controller's `PIN_BUDGET_MB` is float MB, so the pin window shrinks by half for no reason. **Change:** contract
    §6 `cache estimate` reports `mb` and `capMB` in stored bytes (both storage-adjusted), and §7's pin budget is
    derived from that `capMB`.
21. **MEDIUM: C API gaps.** (a) No memory-pressure entry: §7 says "forward as config {lowResource}-like trim" but no
    such op exists → add `rig_host_memory_pressure(e, level)` (drop unpinned buffers and idle units, emit `warn`).
    (b) `user_manifest`/`pads_dir` are fixed at create, but `reloadManifests` and the Settings pad-folder change need
    them later → add to the `cache`/`drone` op args or a `rig_set_paths()`. (c) `rig_midi_in` hashes the port string
    to a uint16 (collisions; §3.3 says port index) → a port table from `rig_host_midi_ports`. (d) Rate-change
    semantics (finding 16). (e) MIDI-clock out port id (G4).
22. **MEDIUM:** cross-arch parity. Goldens are x86-64 Linux Chromium (pffft SSE, glibc libm); the product is arm64
    (NEON pffft, Apple libm). Fine for 2e-4, but run `ctest -L golden` on the `macos-14` (arm64) CI job too; today the
    workflow builds there but goldens need `native/golden/smoke` + `out/` (out is git-ignored → regenerate or commit
    the exact-tier WAVs the core tests need).
23. **LOW:** §4 says each stage starts at 2·B; stage 1 starts at 128 = B (fine: B = quantum, nothing to spread).
    The rest checks out: UPOLS 3960 partitions → 191.6 M CMAC/s; NUPOLS 15/14/60 partitions → 4.28 M CMAC/s +
    6.1 M MAC/s per channel; 506 880 frames for the 8 s bucket; spectra ≈ 2× taps.
24. **LOW: licences.** yyjson MIT, doctest MIT, dr_libs PD/MIT-0, pffft FFTPACK-style BSD (UCAR, non-endorsement
    clause), V8 BSD-3 + Sun fdlibm notice, miniaudio PD/MIT-0: all GPL-3 compatible. Missing: a
    `third_party/chromium/LICENSE` (BSD-3) and per-file notices before the first Chromium kernel port; `dr_libs` and
    `pffft` are pinned to "master" with no commit hash → record hashes in `third_party/README.md`.

### 3.4 Real-time safety (beyond 15, 16, 18)

25. **MEDIUM:** `rig_host.audio_start` is called on the core's control thread, and `RigAudio.start` does
    `queue.sync` + AUHAL open (hundreds of ms on a device switch) → no ticks, timers or MIDI direct route meanwhile.
    **Change:** `RigAudio.start` uses `queue.async` (completion already goes through `rig_host_audio_started`).
26. **LOW:** the audio thread's only syscall is the semaphore release (`std::counting_semaphore`; on Apple libc++
    that is `__ulock_wake`, non-blocking) [Mac: confirm with Instruments' System Trace]. Allocation trap and FTZ/DAZ
    (x86 MXCSR, arm64 FPCR.FZ) are present in `rt_guard.h`.

### 3.5 Shell (Swift/C, read without a compiler)

27. **HIGH: no `WKNavigationDelegate`.** (a) WebContent process termination (routine on iPad under memory pressure)
    leaves a blank window while the engine keeps playing; (b) external links (docs, update check) navigate the app's
    only web view away from `rig://`. **Change:** `webViewWebContentProcessDidTerminate` → reload (the bridge re-does
    `hello` → `state` → `get state`); `decidePolicyFor` → non-`rig` schemes open in the system browser.
28. **MEDIUM:** `RigBridgeHandler` drops any message `JSONSerialization` rejects (e.g. a NaN/Infinity from JS) without
    replying; a request with `id` then hangs until the link timeout. **Change:** the webkit transport posts
    `JSON.stringify(msg)` and Swift forwards the UTF-8 string as is (also saves the NSDictionary round trip per note).
29. **MEDIUM:** the event pump queues without bound; with WKWebView JS suspended (iPad background) 30 Hz ticks pile up.
    **Change:** coalesce `tick` to the latest while a flush is outstanding or the scene is inactive; cap the queue.
30. **LOW:** RigHost `deinit` → an `on_event` arriving during deinit forms `[weak self]` on a deallocating object
    (runtime trap). App-lifetime object, so low; destroy the engine first behind a flag.
31. **LOW [Mac]:** project.yml links `sdk: CoreAudio.framework` for the iPad target (may not exist on iOS); the iPad
    device list hard-codes 48000 Hz; aux click on iPad not implemented.
32. **Scheme handler routes: complete for the bridge engine.** Served: static `app/**`, `/docs/*.md`, `/api/health`,
    `/api/user-samples`, `/api/user-samples/manifest.json`, `/api/heartbeat`, `/favicon.ico`, byte ranges. Not served:
    `/pads/*`, `/api/pads`, `/user-samples/*` (used only by the web engine; the native engine reads files) and
    server.js's `…/api/…` prefix stripping (no caller). MIME map covers every extension in `app/` (js, css, svg, woff2,
    txt, png, html, md, json, mp3). The `patchMain` needle matches `app/js/main.js:5`.

### 3.6 Lower-priority notes

33. **MEDIUM:** ARCHITECTURE §8.2 states the statistical tier as "bands 1.5 dB, envelope corr .95"; the manifest has
    1.5–16.4 dB and 0.73–0.95 (−1 = off for 3 fixtures). Correct the doc (see finding 7).
34. **LOW:** 3 code lines over 120 characters (section 1).

## 4. Verdict

**Conditional GO.** Start immediately, in parallel, without conflicts: **T00b** (findings 1–3, serial, one agent),
**T01** (time/num; its first step is finding 14), **T06** (samples, decode dumps; finding 13), **T17** new fixtures
(finding 12, only `tools/golden/**` + `native/golden/**`), and shell follow-ups 25, 27–29 (only `native/apple/**`).
**NO-GO** for T02–T05, T07, T08 and every later wave until T00b has landed and BUILD_PLAN has the edits of findings
1–7. HIGH findings 15–17 go into T08's and T01's DoD; they do not block the start.

## 5. Only the Mac / iPad can verify

- Everything in `native/apple/` compiles at all (Swift 5.9, Apple clang C) — including this pass's fixes S1–S4 — and
  `xcodegen` + `scripts/build-core.sh` produce a working `RigCore.xcframework` for arm64 macOS and iPadOS.
- The core under Apple clang with `-Werror` and `ctest` on arm64 (first run of `.github/workflows/native-core.yml`'s
  `macos-14` leg), FPCR.FZ behaviour, NEON pffft parity vs the x86 goldens.
- WKWebView boot on `rig://app/`: `light-dark()`/CSS nesting on macOS 14.5 / iPadOS 17.5, scheme handler MIME/range
  behaviour, the document-start script, `webkit.messageHandlers.rig` throughput per note, `evaluateJavaScript` cost at
  30 Hz, WebContent-termination recovery, localStorage migration from the Electron origin.
- AUHAL at 128 frames, measured latency vs `rig_device_info`, default-device following, hot-plug, 4-channel aux
  click via `ChannelMap`, xruns under load; RemoteIO + AVAudioSession (interruptions, route changes, background audio,
  `setPreferredIOBufferDuration`), whether `CoreAudio.framework` links in the iPad target.
- CoreMIDI: UMP → bytes conversion, timestamp → engine time, jitter, hot-plug, MIDI clock out timing.
- `ExtAudioFile` AAC/M4A/ALAC decode (My Samples, pads), GarageBand-imported content.
- CPU budgets (graph ≤ 25 % of one M1 core, reverb unit ≤ 2 %), iPad memory/jetsam headroom, app size.
