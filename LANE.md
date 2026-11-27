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
- [ ] 4. Browser test (app on bridge-mock, Web MIDI removed): note, Learn, Program Change, lamp, hot-unplug
- [x] 5. MIDI clock out port (SHELL.md G4) through the bridge
- [ ] 6. Native side: gaps? (core / RigMIDI.swift); ctest g++, clang++-20 -Werror, ASan if native changes
- [ ] 7. Docs: CONTRACT_CHANGES, ENGINE_CONTRACT/SHELL/WEBKIT_AUDIT notes, MAC_CHECK steps
- [ ] 8. Gates via tools/cloud/gates.mjs
- [ ] 9. Final report here

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
Step 4 (browser test), then 6.

## Findings / decisions
- Listen policy: the adapter listens to exactly the inputs midi.js attached (onmidimessage set / midimessage
  listener / open()), debounced to one `midi listen` per microtask, deduplicated. Not "all + filter in JS": every
  unselected source would cross the WebView bridge (one evaluateJavaScript per batch), CoreMIDI would connect
  virtual ports midi.js deliberately ignores, and the v1.1 direct path (`midi route`) plays every forwarded message,
  so the core's listen set must equal midi.js's selection or unselected ports would sound.

## Open questions
(none yet)
