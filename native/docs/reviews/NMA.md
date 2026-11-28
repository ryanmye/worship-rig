# Skeptic review: lane NMA (MIDI in the native Mac / iPad app through NativeMidiAccess)

Reviewer: skeptic, 2026-11-27. Branch `lane-nma`, rebased onto origin/v2-native 030562e (twice: 7e92df4, then
N10's merge; one CONTRACT_CHANGES conflict, both sections kept). Scope: `app/js/engine-bridge/native-midi.js`, its
three install sites, MockNative MIDI, `midi-clock.js` `sink.portId`, the tests, the docs; read against midi.js,
midi-clock.js, controller.js's MIDI handlers, the core (`midi_service.cpp`, `port_table.cpp`, `midi_parser.h`,
`bridge.cpp` hello / `midi`, `click_service.cpp` clockTarget), RigMIDI.swift, rig_apple_midi.c and RigHost.swift.

## Verdict

**PASS after F1** (one real stuck-note defect fixed with a failing-first test), with the open items below and the
Mac / iPad checks in MAC_CHECK.md part B2 a-h. The adapter's surface, listen policy, hot-plug release, install guard
and clock-out routing held up under reading and under a randomized probe; MockNative matches the core where the
adapter can tell. Nothing under `native/` but docs changed, so native ctest was not rerun (sources byte-identical to
origin/v2-native).

## Findings (fixed)

- **F1 (stuck notes / pedal after a page reload; live-playing, fixed in 01f5cea).** The core outlives the page. Only a
  web-content crash makes the shell post `play panic` (RigHost.webContentDidTerminate); an ordinary reload (Settings ›
  My Samples "Reload" is `location.reload()`) leaves the core sounding the old page's notes and holding its sustain.
  The new controller starts with `heldBySrc` empty and `pedalDown = false`, so `noteOffFrom` drops the key-ups and a
  pedal lift (false → false) sends nothing: held notes ring until PANIC and the pedal stays down until a full pedal
  cycle. Before NMA no MIDI reached the native app, so this path is new with the lane. Fix: `installNativeMidi` calls
  `engine.allNotesOff()` right after `hello` (only where the adapter installs). Test: native-midi.test.mjs "reload
  (skeptic NMA F1)" (same MockNative across two pages; failed with `held 2`, `pedal true` before the fix).
- **Engine suite 404 (test harness, fixed in 67a3228).** Pre-existing on untouched origin/v2-native 7e92df4: 99/99
  checks pass, 1 console error `GET /__tests/api/health 404` (harness.html loads the real controller;
  `rescanPatchPacks` fetches the relative `./api/health`). The engine test server now answers that path with no
  features (nothing more is requested). `app/js/engine` untouched.
- Coverage added (no defect found): the browser suite's hot-unplug holds the sustain pedal through the unplug and
  checks `play pedal down:false` and nothing held in the mock.

## Checked and held

- **Surface vs Chrome**: `inputs` / `outputs` are Maps (values/get/size/forEach); `state` 'connected' /
  'disconnected', `connection` 'open' / 'closed' / 'pending'; a vanished port stays in the map, disconnected (Chrome
  keeps it); `statechange` on access and port with `.port`, only on a state change (Chrome also fires on
  open/close churn, which midi.js ignores: `prev === port.state`); `data` a Uint8Array; `timeStamp` own property over
  the prototype getter; `sysexEnabled` false and `{sysex:true}` rejected; `send` throws TypeError / InvalidAccessError
  (SysEx) / InvalidStateError. Ports present at `requestMIDIAccess` resolution fire `statechange` before anyone can
  listen (Chrome fires none): harmless, the access is only reachable through the promise.
- **SysEx and running status**: never delivered. The core's parser (port of `_parseBytes`) frames complete channel
  messages with an explicit status, drops realtime and skips SysEx; rig_apple_midi.c skips UMP SysEx7 / MIDI 2.0
  words. midi.js re-parses the framed bytes harmlessly.
- **Order 'connected' vs first message**: a port's messages can only arrive after its `listen`, which follows its
  'connected' statechange and midi.js's attach.
- **Listen policy**: randomized probe (`.probe/fuzz.mjs`, 2 seeds × 200 runs × 40 steps: plug / unplug / select
  first|all|device / setRemembered / two hot-plug changes in one turn / same-name new id): after every settle the
  core's listen set equals midi.js's `_attached`, every attached port is connected, and a message from every present
  input is delivered iff its port is attached. 0 failures; ~0.23 listens per step (one per changed set, one per
  turn). The core's `listen` swaps the set synchronously, so a kept port has no gap.
- **Stuck notes**: hot-unplug mid-chord (+ pedal) → 'disconnected' → controller `releaseSource` (all channels, pedal)
  — browser suite. Listen change mid-note: midi.js emits 'disconnected' for every detached port first; in-flight
  messages from it are dropped by the adapter (`_wanted()`), after the release. PANIC: the controller clears its
  own state; later key-ups are no-ops, as in Chrome. Reload: F1.
- **Timing / hops**: the note path is synchronous from `__rigNative.receive` to `postMessage(play)`: transport
  deliver → BridgeLink → BridgeEngine `_emit('midi')` → adapter → midi.js → controller → `_send` (no microtask, no
  timer). The controller ignores `timestamp` (plays now), so the ts mapping affects no sound.
- **Clock out (G4)**: `setOutput(name)` tags `sink.portId` before `applyMidiClock` calls `setClockSink(sink)`, so
  `config.midiClock.port` is the name, never 'auto' (the sink is attached only while a name is chosen; null → off).
  The core resolves id, then name among outputs, at every send (`clockTarget`), so a late-plugged device gets it.
- **Install guard**: installs only when `navigator.requestMIDIAccess` is absent or is its own polyfill; select.js
  imports the file only in the WKWebView branch; boot-mock / boot-devhost only under their flags; main.js imports
  `engine/index.js` in the web build. The F1 panic rides the same guard (Chromium bridge-mock pages send none: test).
- **MockNative vs core** (`midi_service.cpp`): listen replies `{ports}` with no event (same); `ports` event = present
  ports only, emitted on every report even when unchanged (same; the adapter diffs); `msg` `{port, data, ts, handled}`
  (same); `send` validation and `{sent}` (same). Differences that cannot change the adapter's results today: before
  any listen the core forwards every message (`listenSet_` false) and the mock none (equivalent because RigMIDI
  connects no source before a listen); an unknown action is `bad-request` in the mock and an empty result in the
  core; the mock does not release direct-path notes on vanish (route is off in v1).

## Open items

- **O1** `timeStamp` is not guaranteed monotonic: each message maps through the latest tick (`perf` is the tick's
  receipt time, so its delivery jitter moves the offset) and is clamped to now; it may also sit early by the output
  latency if the core's clock map is anchored at output time (unverified). No consumer reads it (controller plays
  now). Clamp per port if one ever does.
- **O2** v1.1 direct path (`midi route on`): forwarded messages flagged `handled` still reach midi.js, and the
  controller would play them again. Must skip handled notes / pedal before route ships (builder's risk; route is
  never sent in v1: grep).
- **O3** A failed or timed-out first `listen` (10 s link timeout) leaves midi.js 'failed' for the page's life; the
  adapter allows a retry, but nothing calls `requestMIDIAccess` again. Low risk (the core answers `listen` from the
  control loop), worth a retry on the next `ports` event later.
- **O4** `addEventListener('midimessage', fn, {once|signal})`: the DOM drops the listener, the adapter keeps the
  port listened. midi.js uses `onmidimessage`, so no effect today.
- **O5** SHELL "Needed from the core" 2 is still open: a repeated `hello` does not reset route / learn / listen. F1
  covers notes and pedal from the page side; a shell-side panic on every main-frame navigation (not only on a
  crash) would be the native belt.
- **O6** The opt-in devhost e2e checks shapes only: rig-devhost has no `midi_listen` / `midi_send` and reports no
  ports, so listen / ports / msg semantics against the real core rest on code reading plus ctest "service: …".
- **O7** 1.x carry-over by name (unverified, speculation): RigMIDI names ports by `kMIDIPropertyDisplayName`; the
  1.x choices (`midiInputName`, remembered keyboards, per-keyboard touch curves) match by name, so if Chrome named the
  same endpoint differently they don't carry over. MAC_CHECK B2 g.
- **O8** Port ids are CoreMIDI uniqueIDs (different for a device's source and destination); the core's table holds
  at most 128 ids for the engine's life (never reused). Fine for keyboards; a network-session tool that mints a new
  id per connection could exhaust it over a very long run.

## Only a Mac / iPad can verify (MAC_CHECK.md part B2, each a step)

CoreMIDI input and hot-plug with a real keyboard (B2 a, b), MIDI Learn / Program Change from hardware (c), clock out
to a real receiver by name (d), adapter stats (e), reload with notes and pedal held (f, F1), 1.x names carrying over
(g, O7), the listen set following Settings › MIDI with two keyboards (h), one-round-trip latency and evenness vs
Chrome (a), the iPad with a USB keyboard (iPad note: a-c and f), Bluetooth MIDI only after pairing elsewhere.

## Gates

Tree b840f10 (clean), `node tools/cloud/gates.mjs`, UI6_PURITY_BASE=origin/v2-native,
PLAYWRIGHT_BROWSERS_PATH=/root/.cache/rig-pw. The commit after it adds only this section and LANE.md.

| suite | result | time | note |
|---|---|---|---|
| shell-unit | PASS | 31 s | |
| unit | PASS | 26 s | 720 pass, 0 fail, 13 skip (native-midi.test.mjs: 13) |
| native-midi | PASS | 3 s | 9 pass (hot-unplug now with the pedal held) |
| engine | PASS | 445 s | 99/99, **0 console errors** (was 1 on base: the /__tests/api/health 404) |
| ui-core | PASS | 375 s | |
| ui-v6 | PASS | 278 s | flag-off purity vs origin/v2-native included |
| settings | PASS | 128 s | |
| migration-1x | PASS | 102 s | |
| native ctest | not run | | nothing under native/ but docs changed (sources = origin/v2-native 030562e) |
| opt-in devhost e2e | PASS | | native-midi-devhost.test.mjs against rig-devhost freshly built from this tree (-j1, Release, scratch dir): listen reply, listens / sends and the boot panic accepted, no warn |

0 console.error and no HTTP >= 400 in the browser suites (each asserts it). `app/js/engine` untouched.

## Commits (skeptic)

- 9b94564 LANE.md skeptic section
- 01f5cea F1: boot panic after hello (test first)
- 67a3228 engine test server answers /__tests/api/health; browser hot-unplug with the pedal held
- e308e4b MAC_CHECK B2 f-h; CONTRACT_CHANGES NMA skeptic addendum
- 62d0ea2 this review; ENGINE_CONTRACT 5 note
- b840f10 LANE.md before gates; then the gates-table commit (lane tip)
