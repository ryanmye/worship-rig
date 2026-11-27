# Lane NMA (builder): a MIDI keyboard can't play in the native Mac/iPad app

Brief: WKWebView has no Web MIDI, so on the native app midi.js reports "unavailable" and nothing reaches the engine.
Build a JS `NativeMidiAccess` adapter over BRIDGE v1 (`midi listen/send`, `midi` events: ports / msg) installed only
when the native bridge is active and `navigator.requestMIDIAccess` is absent, so midi.js and midi-clock.js run
unchanged; fill any native gap (core, RigMIDI.swift); tests (adapter unit vs MockNative, a browser boot on the bridge
engine with a mock MIDI port: note → noteOn, MIDI Learn, Program Change, MIDI lamp, hot-unplug releases notes); gates.
Worktree /home/claude/wt-nma, branch lane-nma off origin/v2-native (d35b788). Don't push.

## Checklist
- [x] 0. Worktree, read docs/code, verify the facts (below)
- [x] 1. `app/js/engine-bridge/native-midi.js` adapter + install from select.js / boot-mock.js / boot-devhost.js
- [x] 2. MockNative midi emulation (ports appear / disappear, msgs with ts, listen filter, send log)
- [x] 3. Unit tests `test/unit/engine-bridge/native-midi.test.mjs`
- [x] 4. Browser test (app on bridge-mock, Web MIDI removed): note, Learn, Program Change, lamp, hot-unplug
- [x] 5. MIDI clock out port (SHELL.md G4) through the bridge
- [x] 6. Native side: gaps? (core / RigMIDI.swift); ctest g++, clang++-20 -Werror, ASan if native changes
- [x] 7. Docs: CONTRACT_CHANGES, ENGINE_CONTRACT/SHELL/WEBKIT_AUDIT notes, MAC_CHECK steps
- [x] 8. Gates via tools/cloud/gates.mjs
- [x] 9. Final report here

## Facts verified (step 0, by code reading on d35b788)
- WKWebView has no Web MIDI (WEBKIT_AUDIT "Web MIDI [C]"): midi.js init() → 'unavailable'/'unsupported'.
- No JS adapter / `navigator.requestMIDIAccess` polyfill exists in app/js (grep: only midi.js calls it).
- Nothing in app/js sends `midi listen` (grep: no `'midi'` op is sent at all), so the core never calls
  `rig_host.midi_listen` and RigMIDI.apply() connects no CoreMIDI source. Messages could not arrive even with an
  adapter.
- The native core side is complete for v1 (midi_service.cpp): `listen` sets the filter, calls host.midi_listen and
  replies `{ports}`; `rig_host_midi_ports` diffs, releases vanished inputs on the direct path and emits
  `{ev:'midi', type:'ports', ports}`; each channel message → `{type:'msg', port, data, ts (engine s), handled}`;
  `send` → host.midi_send with `when` mapped to host ns. ctest "service: …" covers it.
- RigMIDI publishes ports at init (before the page exists: that first `ports` event is lost), so the adapter must take
  the port list from the `listen` reply.
- MIDI clock out on the bridge: BridgeEngine.setClockSink sends `config {midiClock:{port: fn.portId ?? 'auto'}}`; the
  JS sink is never called; midi-clock.js's sink has no portId → native picks the FIRST output, not the chosen one
  (SHELL.md G4). The core resolves the port by id, then by name (click_service.cpp clockTarget).
- devhost: no MIDI ports (`midi_listen`/`midi_send` NULL); in Chrome it uses Chrome's Web MIDI (adapter not installed).

## Next step
None: handed back. The orchestrator removes this file at merge.

## Findings / decisions
- Listen policy: the adapter listens to exactly the inputs midi.js attached (onmidimessage set / midimessage
  listener / open()), debounced to one `midi listen` per microtask, deduplicated. Not "all + filter in JS": every
  unselected source would cross the WebView bridge (one evaluateJavaScript per batch), CoreMIDI would connect
  virtual ports midi.js deliberately ignores, and the v1.1 direct path (`midi route`) plays every forwarded message,
  so the core's listen set must equal midi.js's selection or unselected ports would sound.

- Step 6: native needs no change (midi_service.cpp listen/ports/msg/send complete; RigMIDI connects listened ids and
  republishes on hot-plug). The adapter was run against the real core in rig-devhost (integration build-int binary,
  2026-11-24): `native-midi-devhost.test.mjs` passes. native/ untouched → ctest / fixtures identical to base.
- Browser suites need PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/rig-pw (tools/cloud/setup.sh mapping 1194→1243).

## Open questions
(none yet)

## Final report (builder, lane NMA)

**What was missing (all confirmed by reading the code on d35b788).** WKWebView has no Web MIDI, so midi.js reported
'unavailable'. app/js had no adapter and no `requestMIDIAccess` polyfill. Nothing sent `midi listen`, so RigMIDI never
connected a CoreMIDI source. MIDI Learn, Program Change, touch fitting and the MIDI lamp all depend on midi.js and
were dead. The clock-out choice was also wrong: `config.midiClock.port` went out as 'auto' (the first output) because
the sink had no `portId` (SHELL.md G4). The native core already did everything v1 needs (midi_service.cpp:
listen / ports / msg / send), and so did RigMIDI.swift (it connects the listened ids and republishes on hot-plug). One
catch: RigMIDI publishes its ports before the page exists, so the adapter has to read them from the `listen` reply.

**What was built.**
- `app/js/engine-bridge/native-midi.js`: `NativeMidiAccess` + `installNativeMidi(engine, {nav})`. It implements the
  MIDIAccess surface that midi.js and midi-clock.js read. The first `midi listen` is a request whose reply is the port
  snapshot. After that, every listen set is exactly the inputs midi.js attached ('first' / 'all' / 'device' and
  hot-plug follow automatically). It sends one listen per microtask, and only when the set changes. A `ports` event is
  diffed: a vanished port goes to 'disconnected' and stays in the map, as in Chrome. A newer `ports` event beats an
  older reply snapshot. `msg.ts` is mapped from engine seconds to performance.now() ms through the last tick; if the
  clock is stale or absent, now() is used. `output.send(data, ts)` becomes `midi send {port, data, when?}`, with Web
  MIDI's errors. Listen policy: only the selected ports, not "all + filter" (reasons under Findings).
- Installed only when the bridge engine runs and `navigator.requestMIDIAccess` is absent: select.js (the shell),
  boot-mock.js and boot-devhost.js. Chrome, Electron and the devhost-in-Chrome are untouched, and the web build never
  loads the file.
- midi.js is unchanged. midi-clock.js has one functional line, `sink.portId = name`, which fixes G4. The core resolves
  the port by id, then by name.
- MockNative now emulates MIDI for the core and shell together: ports and hot-plug, listen filter, msgs with ts, and
  a send log. Its `listen` now matches the core: it replies `{ports}` and emits no event.
- Native: no change (Swift and core untouched). Golden fixtures are untouched.

**Tests.**
- Unit `test/unit/engine-bridge/native-midi.test.mjs` (12 tests, real midi.js and midi-clock.js over MockNative):
  install rules, snapshot, all three selection modes, hot-plug in both directions, timestamps, stale reply, failed
  listen and retry, drops, duplicate listeners, send and its errors, the clock port.
- New suite `native-midi` (`test/phase2/native-midi/run.mjs`, in run-all): the real app on bridge-mock with Web MIDI
  deleted. It checks the lamp, a note giving `play on/off`, the pedal, MIDI Learn → next song, a Program Change cue,
  that hot-unplug releases both held notes and falls back, that a re-plugged keyboard plays, the clock-out name, the
  contract-valid wire and zero console errors. It also checks that a page that has Web MIDI does not get the adapter.
- Opt-in `native-midi-devhost.test.mjs`: the adapter against the real core in rig-devhost (the build-int binary of
  2026-11-24). Passed: listen reply `{ports: []}`, listens and sends accepted, no warn.

**Gates** (tree cfd540f, PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/rig-pw, UI6_PURITY_BASE=origin/v2-native):
- PASS: shell-unit, unit (706), native-midi (9), settings, migration-1x, ui-v6 (flag-off purity included), ui-core.
- engine: FAIL, but not from this lane. 99/99 checks passed; it fails on 1 console error: harness.html → 404
  `/__tests/api/health`. The same failure reproduces on the untouched base d35b788 in a scratch worktree (now
  removed). The cause is a relative `./api/health` fetch (controller.js:2779) from the /__tests/ harness. That is for
  the orchestrator; app/js/engine and controller.js are not changed here.
- Native ctest not rerun: native/ is byte-identical to the base.

**Only a Mac / iPad can verify** (steps added to MAC_CHECK.md part B2 and the iPad note): CoreMIDI input,
timestamps and hot-plug, the latency and evenness of one WebView round trip per note against Chrome, MIDI clock out
to a real receiver, and the iPad's USB keyboard. Bluetooth MIDI shows up only once it is paired in another app.
The macOS CI `mac-check` job (native-core.yml, which triggers on app/**) builds the Swift app and runs the
self-test. No Swift changed and app/ is a folder reference, so the new JS file ships automatically. Build-only
verification after merge: **UNVERIFIED until pushed.**

**Risks.**
- The v1.1 direct path (`midi route on`): forwarded messages flagged `handled` still reach midi.js (exposed as
  `event.handled`), and the controller would play them a second time. The controller must skip handled notes once
  route is turned on. Route is off in v1.
- The iPad in the background: WKWebView JS is suspended, so playing with the screen off needs the direct path
  (ARCHITECTURE).
- A page reload resets the listen set (the first listen has `ids: []`), but it does not reset route / learn on the
  native side (SHELL.md "Needed from the core" 2).
- No Bluetooth pairing view.

**Lane tip:** see `git log -1 lane-nma` (this commit). Not pushed.

## Skeptic (lane NMA review, 2026-11-27)

Brief: strong skeptic for NMA (2.0 blocker, live playing). Rebased onto origin/v2-native (7e92df4, clean). Try to
break surface fidelity, listen policy, stuck notes, timing, clock-out routing, install guard, MockNative fidelity vs
the core; settle the `engine` suite 404. Fix real defects with failing-first tests, one commit each; review doc
native/docs/reviews/NMA.md; gates via tools/cloud/gates.mjs. Commit on lane-nma only.

### Checklist
- [x] S0. Rebase onto origin/v2-native (clean, 11 commits replayed)
- [x] S1. Read adapter, midi.js, midi-clock.js, core midi_service / port_table / parser, bridge hello, RigMIDI.swift
- [ ] S2. Probes: reload stuck-note path, surface edge cases, mock vs core
- [ ] S3. Fixes (tests first), one commit each
- [ ] S4. engine suite 404: base check, harness fix if one-line
- [ ] S5. Gates
- [ ] S6. native/docs/reviews/NMA.md + MAC_CHECK steps; final report

### Findings so far (before fixing)
- F1 (candidate): page reload with notes / pedal held: the core keeps the old page's voices and sustain (only the
  crash path posts `play panic`; Settings › My Samples "Reload" is a plain location.reload()); the new controller
  has empty heldBySrc / pedalDown=false, so key-ups are dropped and a pedal lift sends nothing → notes / sustain stuck.

### Next step
S2 probes.
