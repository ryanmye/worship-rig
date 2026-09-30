
## engine-instruments (synth.js / organ.js / voice.js)

These are additions only. None of them breaks §3.2.
- `Voice.fadeOut(when, fadeSec=0.02)` stops a voice without a click. It does an exponential fade of the voice's
  final gain to −60 dB over `fadeSec`, then stops. The allocator uses it for steals, and the engine can use it for
  §3.2 re-strike (30 ms) and panic. `instrument.fadeOutVoice(voice, when, fadeSec=0.03)` is the same thing through
  the instrument. `Voice.kill(when)` stays a hard stop.
- Also exposed: `Voice.state` ('held'|'released'|'killed'|'dead'), `Voice.liveNodes`, `Voice.onDead(cb)`,
  `instrument.liveNodeCount()` (for `_debugStats().nodes`), `instrument.getParam(key)` and
  `instrument.alloc.steals`.
- `setParam` returns `false` and calls `console.warn` for an unknown key. It never throws.

**shared/automation.js issue (needs an owner).** Verified in Chromium 1194 offline. `cancelAndHoldAtTime(t)`
inserts no hold event when no automation event spans `t`, so a ramp scheduled afterwards starts at the
*previous* event:
  - `glideTo`/`linearTo` on a param with no events → the ramp runs from time 0. A glide at 1.5 s is already
    25 % of the way at 0.5 s.
  - A `setValueAtTime` at t0 < t, then `glideTo(…, t)` → the ramp runs from t0.
  - A `setTargetAtTime` earlier, then `glideTo`/`linearTo` at t → the value drops to **0** at t and ramps up
    from there. This is an audible click.
  - `rampTo` (setTarget) is unaffected. So is `setNow(v, t)` followed by `glideTo`/`linearTo` at the same `t`,
    which works correctly.
  The instruments work around it with `TrackedParam` in voice.js: an explicit `setNow(value-at-t, t)` before
  every glide. engine-core's own uses of `glideTo`/`linearTo` (drone glides, fades) probably need the same
  anchor. One possible fix inside automation.js is to take an explicit `from` value.

**Determinism tolerance.** Chromium sums a node's inputs in hash-set order. Any node with 3 or more inputs
therefore renders about 1e-6 differently from run to run, even with the same seed (measured max |Δ| 5e-6).
"Sample-exact" comparisons in §11, such as lofi 0 ≡ never-created, need a tolerance of about 1e-5.

**§11 click detector.** "|Δx| > 6× local median" alone does not work on dense pads. A mix of 16 saw voices
already scores 5–8 with no event at all, and a hard kill of one voice in that mix scores the same. The
instrument tests isolate the transient first: steal render minus a reference render with the same seed. They
then compare energy above 8 kHz. See test/phase1/instruments/harness.js `steal`.

## shell (server.js / main.js / preload.js / store.js / controller.js / midi.js / recorder.js / presets.js)

**1. Electron MIDI permission must allow `midiSysex` (§7 says "'midi' only (not sysex)").** Verified on Electron
44.4.5. `navigator.requestMIDIAccess({sysex:false})` reaches `setPermissionRequestHandler` as **`midiSysex`**,
because Chromium now gates all Web MIDI behind the sysex permission. If only `midi` is allowed, MIDI is denied
outright (`reason: denied`). main.js therefore allows `midi` and `midiSysex`, and only for our own origin
(`http://127.0.0.1:<port>`). The renderer still requests `{sysex:false}`. Also allowed: `speaker-selection`
(setSinkId), `fullscreen`, `clipboard-sanitized-write`, plus a *check-only* `media` (audio) permission so that
`enumerateDevices()` returns output-device labels. Nothing ever starts a capture. Set `RIG_DEBUG_PERMS=1` to log
every request.

**2. Drone calls follow engine-core's implementation, not the §6 wording.** The controller calls
`engine.drone.setKey(pc, {minor})` (an options object, not `(pc, minor)`) and then
`engine.drone.configure(song.drone)`, which covers mode, options and params in one call. For param-only edits it
calls `engine.setParam('drone.<k>')`. It also calls `engine.drone.attachFiles([{name,url}])` for pad folders
(before the first song, and again after `engine.restart()`, which rebuilds the drone), and the optional
`engine.setKeyContext(hearIn, minor)`. Order on a song switch: prepare → commit → setTranspose → setRouting →
setKeyContext → drone.setKey → drone.configure → setTempo → preload(prev,next).

**3. `window.rig` additions (additive only).**
- `streamOpen(p)` also accepts a **bare file name**, which saves to `~/Music/Worship Rig/` with no dialog (so REC on
  stage never prompts). An absolute path is accepted only if `saveFileDialog` returned it or it is inside the
  recordings folder. Anything else gives `{error:'path not allowed…'}`. Returns `{id, path}`.
- `choosePadFolder()` returns `{path, baseUrl}`. main.js remembers the folder (`userData/rig-shell.json`) and
  restores it at launch, so the renderer never needs to re-send a path.
- `listPads()` items are `{name, path /*relative*/, url}`, or `{error:'missing'}` if the folder is gone.
  `/api/pads` returns the same thing, with 404 for missing.
- New: `getInfo()` → `{version, electron, platform, userData, port, reusedServer, padsRoot, recordingsDir,
  backupsDir}`; `openFolder('recordings'|'backups'|'pads')`; `revealFile(path)`.
- `onMenu(cb)` returns an unsubscribe function. Menu ids: `panic fadeOutAll nextSong prevSong toggleView record
  restartAudio openSettings`. ⌘←/⌘→ are shown in the menu with `registerAccelerator:false`, so text fields keep
  ⌘-arrow and the renderer (controller) handles them when focus isn't in a control.
- The pads URL token rotates on every `setPadsRoot`, so old URLs 404 and the HTTP cache can never mix folders.

**4. `params.LEARNABLE` is missing `swell`** (§4 lists it). The controller accepts `swell` as a learnable button
anyway (`controller.BUTTON_CONTROLS`). phase0 should add it to `LEARNABLE` so the UI's Learn table shows it.

**5. Store shape and additions** (the shape was unspecified): `{schema:1, songs:{[id]:Song}, songOrder:[id],
setlists:{[id]:Setlist}, setlistOrder:[id], settings, meta:{factorySeeded, factoryVersion}}`.
`settings.setlistIndex` records the position in the current setlist, which disambiguates a song that appears twice
(a reprise). Songs carry `category` and `factoryId`. `set()` changedPaths are always canonical entity paths
(`songs.<id>.patch.slots.1.gain`, `songs.<id>.patch.fx.master.volume`, `songs.<id>.drone.gain`). MIDI-learn ids
contain dots, so use `store.setMidiLearn(controlId, {cc|note, channel}|null)`. Mappings may be `{note, channel}`
(pads and buttons) as well as `{cc, channel}`.

**6. Velocity unit.** The controller passes MIDI velocities 1..127 to `engine.noteOn(note, vel)`, which matches
engine-core's `vel = 100` default.

**7. electron-builder needs `directories.app: "."`.** Without it, `app/package.json` makes electron-builder
treat `app/` as the application directory (the "two package.json" layout), and the build fails with "Please
specify 'name' in app/package.json". The `files` list also includes `LICENSES.md`. A Linux `dir` build here
confirmed that the asar holds main/preload/server/app/** and that server.js serves from inside `app.asar` with
206/Content-Range.

**8. Observed while driving the real engine** (scratch smoke test: store + controller + recorder + real
AudioEngine in Chromium, all 11 factory songs select, play and record, 0 console errors): engine-instruments
logs `[synth] unknown patch "[object Object]", using warm-pad` and `[organ] unknown preset "[object Object]"` for
every synth/organ slot. engine-core appears to pass the `{type,id}` ref (or def object) where synth.js/organ.js
expect the id string, so every synth slot currently sounds as warm-pad and every organ as gospel. This is for
engine-core/engine-instruments/integration to fix. The shell passes `song.patch` unchanged.

## engine-core (audio.js / fx.js / sampler.js / drone.js / instruments.js / index.js)

**1. Master soft-clip oversampling defaults to `'none'` (§3.1 says 4x).** Measured in Chromium 1194 at 44.1 kHz:
WaveShaper `'4x'` adds 192 frames (4.4 ms) and `'2x'` adds 128 frames to *every* note. The catcher compressor's
lookahead adds another 264 frames (6.0 ms), and that one can't be avoided. The clip curve is exactly linear below
−6 dBFS (a tanh knee above that, asymptote −0.3 dBFS), so with the −6 dB master gain staging it's transparent in
normal use. Only overs get shaped, and those alias slightly. Pass `new AudioEngine({clipOversample:'4x'})` to get the
spec behavior. The measured engine output latency (sum → out) is 6.0 ms. The lofi saturation stage still uses
4x, but it's only in the path while lofi is engaged.

**2. shared/automation.js: `linearTo`/`glideTo` don't anchor** (engine-instruments also reported this). Independently
reproduced: a bare `linearTo` on a fresh param ramps from t=0, after a completed ramp it ramps from that ramp's end,
and after a `setTarget` it drops to 0. engine-core never uses them bare. `fx.js` exports `linFrom(param, from, to,
when, dur)`/`glideFrom(...)` (`setNow(from, when)` first), and `equalPowerFade` anchors the same way. Voice kills and
steals use `rampTo` (τ = fade/6.9, stop at 1.3 × fade). **For engine-instruments:** `synth.js:351`
`linearTo(vibG.gain, p.vibDepth, t + p.vibDelay, 0.4)` on a fresh GainNode ramps from time 0, so the strings'
delayed vibrato isn't delayed. Anchor it with `setNow(vibG.gain, 0, t + p.vibDelay)`.

**3. Panic delay flush.** "Feedback → 0 for 200 ms" doesn't flush a line longer than 200 ms: the echoes already in
the buffer re-enter the loop when feedback comes back. Feedback is held at 0 for max(200 ms, longest delay time +
50 ms). It's still pure automation, with no timer.

**4. Instrument construction (registry).** `new SynthInstrument(ctx, prng, patchId, params)` /
`new OrganInstrument(ctx, prng, presetId, params)`. The *id string* is passed, matching engine-instruments'
implementation, not a `def` object. This fixes the `[synth] unknown patch "[object Object]"` the shell observed.
`prng` is a callable `createRng` object (seeded per slot and instrument). Metadata comes from the exported
`PATCHES`/`PRESETS`. If either module fails to import, every synth id (and each organ) falls back to a built-in
2-oscillator synth, with a `warn`. engine-core uses the optional `instrument.fadeOutVoice(voice, when, sec)`
(re-strike 30 ms), `legatoTo(voice, note, when)` (mono slots; otherwise a 30 ms crossfade retrigger),
`liveNodeCount()` and `_sharedNodes` (stats).

**5. Drone API** (the controller already follows it, per shell #2): `engine.drone.configure({mode, chordFollow,
continueAcrossSongs, minorUsesRelativeMajorFile, gain, brightness, movement, width, fade}, {when})`,
`setKey(pc, {minor, fade, when})` (returns false for a same-key no-op), `setMode(mode, {when})`,
`attachFiles([{name,url}])` (returns the count of files whose key was detected), `_debugTargets()`.
`songChanged({when})` is called by `commit()` itself: it fades the drone out unless continueAcrossSongs. A
following `setKey` (even to the same key) then fades a fresh drone in. drone-osc has no brightness/movement
params, so brightness drives `morph()` (filter) and movement maps onto `drift`/`unisonDrift`/`lfoDepth`
(movement .3 ≈ the spec's ±3¢). Files-mode loop region for short files: `[min(8, .25·dur), dur − min(12, .25·dur)]`,
with a crossfade of min(4 s, region/3). Files shorter than 12 s just loop. A missing key file falls back to the
synth (warn once per key). A major key with no file uses its relative-minor file.

**6. Other engine additions.** Options: `new AudioEngine({context, seed, latency, manifestUrl, sinkId, instrumentModules
(false = built-in fallback only, used by tests), lofi (false = graph built without the lofi chain),
cacheMB (700), clipOversample})`. Also `engine.setKeyContext(pc, minor)` (chord spelling), `engine.at(when, cb)`
(audio-clock callback; offline via `suspend()`), `engine.wheelValues()`. `engine.swell()` with no argument
toggles. Exports `defaultPatch()`, `normalizePatch()`, `curveVelocity()`. All events are `CustomEvent`s with
`detail`: notes `{held:Set}`, chord `{chord}`, loading `{slot, progress, token}`, ready `{phase:'start'|'preload'}`,
warn `{message}`, statechange `{state, latencyMs}`, stats (the `_debugStats()` object), wheel `{source, value,
hardware?, pickup?}`. `_debugStats()` also returns `sounding`, `pedaled` and `timers`.

**7. Semantics chosen where the spec is silent.**
- Velocity curves: soft v^0.6, normal v, hard v^1.6, fixed 100/127.
- Velocity 0 → noteOff.
- The CC7 volume target factor is linear (value).
- A duplicate note-on on a held key re-strikes it.
- Swell starts from 0 (60 ms dip) and ramps to 1 over `swell.seconds`. Pressing again returns to the
  pre-swell value over 4 s.
- Wheel pickup: after a virtual/swell write, a hardware CC takes over only once it comes within .03 of the value
  or crosses it. Before any virtual write, hardware takes over immediately (lastWheel 1.0 initially).
- macro.intensity applies to slot 1 (the Pad role) gain and to `morph()` of pad-like synth slots (warm-pad,
  glass-pad, strings).
- The tape bend engages the lofi wet chain temporarily (a delay-time ramp gives the pitch drop).
- fadeOutAll: master glides to 0 (drone included). When the fade ends, instrument voices are cut (30 ms), so pedaled
  pads don't return later. The drone keeps running silently until the next noteOn restores the master.
- A slot's channel strip belongs to its instrument instance. A retiring (MainStage-held) instrument keeps its old
  gain, pan and sends, and its wheel value is frozen.
- Retired instruments are polled every 250 ms of audio time and disposed after 1 s at 0 live voices.
- Reverb IR swaps crossfade over 0.8 s (equal power). A commit that arrives while the other convolver is still
  fading defers the swap until that convolver is idle, and never blocks `prepare`.

**8. Sampler / manifest.** Reads the samples agent's format `{instruments:[{id, name, category, ext, layers:[{vel:[lo,hi],
dir, notes}], release, gainTrim, license, …}]}`. The sample URL is `<manifest dir>/<dir>/<note>.<ext>`.
- `gainTrim` is **dB**. `release` is **τ seconds** (§3.5 "τ .12"), and it's the sampler's `release` param.
  Sampler params are `release` (τ) and `tone` (LPF, 1 = open).
- Category → group: piano → Piano, ep → Electric Piano, mallet → Mallets & Bells, guitar → Guitar.
- Onset trim, the 2 ms fade-in and the length cap (with its 1 s fade) are baked into the cached buffer at decode.
- Polyphony follows §3.2 (16 per instrument). That's tight for pedaled piano. Consider 32 for the sampler.

**9. Tests.** A 404 always logs a browser console error, so the runner whitelists exactly one deliberate 404 (the
missing-sample fixture). The lofi "sample-exact" check uses ≤ 2e-6, because identical renders differ by about 1e-6
(see engine-instruments' note), and it also checks structurally that the wet chain is detached. The click
detector is first-difference > 6 × local median **and** > 4.5 × local RMS, with a positive control. On raw saw
material (real drone-osc), the test compares flag rates across the event against the steady state.

## fixups (automation.js / params.js / synth.js / sampler.js)

**1. shared/automation.js: `glideTo`/`linearTo` now anchor at `when`** (fixes engine-instruments' and engine-core #2's
report). New signatures are `glideTo(param, value, when, duration, {from}?)` and
`linearTo(param, value, when, duration, {from}?)`. After cancel-and-hold, both always write
`setValueAtTime(from, when)` and then ramp. So the ramp starts exactly at `when` from `from`: on a fresh param, after
a completed ramp, after an earlier `setValueAtTime`, and after a `setTargetAtTime` (no more drop-to-0 click).
- `from` defaults to `param.value`. That is the value at the context's **current** render time, so it's exact only
  when `when` ≈ now. **Engine code that schedules ahead (offline, lookahead, or interrupting a scheduled ramp) must
  pass `{from}` with the value it tracks.** A non-finite `from` is ignored.
- Watch out for `setNow(x, t); linearTo(…, t)` **without** `{from}`. The ramp now re-anchors at `param.value`, which
  overrides `x`. Every engine site that used this idiom now passes `{from}`: `fx.linFrom`, `fx.glideFrom`,
  `fx.equalPowerFade` (each segment gets `{from: previous segment end}`), `voice.makeEnv` and `instruments.js`
  attack (`{from: 0}`), `TrackedParam.glide` (`{from: cur}`), the organ percussion (`{from: 0}`) and the strings
  vibrato. The workarounds (`linFrom`/`glideFrom`/`TrackedParam`/`setNow` anchors) are kept. Their extra `setNow`
  writes the same value at the same time, so nothing double-anchors to a different value.
- glideTo: a start value ≤ 1e-4 is lifted to 1e-4, and a negative start or target falls back to linearTo (with the
  same `from`). `rampTo`/`setNow`/`holdAndFade` are unchanged.
- Verified in Chromium (Playwright, OfflineAudioContext). Before: a glide at 1.5 s was already at 1.19 (of 1→2) at
  0.5 s, and a linear after setTarget read 0.02 at t+10 ms. After: 1.00 until 1.5 s, and 0.51 at t+10 ms (from 0.5).
- test/unit/shared/automation.test.mjs: the fake AudioParam now models Chromium's cancelAndHoldAtTime. A hold is
  inserted only for a ramp spanning or ending at t, or for a set exactly at t. Otherwise nothing is inserted, and after
  a setTarget a following ramp starts from 0 at t. Each bug is reproduced with the raw primitives and then asserted
  fixed. 7 of the 22 tests fail against the old module.

**2. shared/params.js: `'swell'` added to `LEARNABLE`**, as a button: `isLearnable('swell')` and
`isLearnButton('swell')` are both true. This resolves shell #4.

**3. synth.js strings vibrato.** Depth is anchored at 0 at `t + vibDelay` (`setNow`), then
`linearTo(…, 0.4, {from: 0})`. New instruments check `vibratoOnset`: strings with detune 0, instantaneous frequency
of the 4th harmonic from 50 ms windows. Measured peak-to-peak is 0.01¢ at 0.05–0.45 s after noteOn and 15.5¢ at
1–2 s (±8¢). With the old automation.js and a bare `linearTo` it measures 5.0¢ early, so the check catches the bug.

**4. sampler.js polyphony is 32** (`SAMPLER_MAX_VOICES`, for pedalled piano). The steal policy is unchanged
(BasicAllocator: oldest-released, then oldest-held, 20 ms fade). Synth, organ and fallback instruments stay at
16. `offline.sampler` now also checks that 32 pedalled notes allocate without a steal and that 40 notes give
exactly 8 steals with 32 playing. The fuzz node-count check is unaffected (0 voices at the end).

## audition (tools/calibrate.mjs / tools/audition.mjs / tools/lib/** / gain-trims.json / manifest gainTrim)

**1. `app/js/engine/gain-trims.json` is not loaded by the engine yet. A follow-up needs to wire it.**
instruments.js has no trim hook for synth or organ. Until someone wires it, those instruments play at their built-in
`trim` (synth.js `impl.trim`, organ.js `PRESET_TRIM`), and the drone plays without `droneTrim`. Sampler trims already
work, because sampler.js reads `gainTrim` (dB) from the manifest. The file looks like this:
`{ _doc, reference:{…measurement conditions…}, synth:{<id>: dB}, organ:{<id>: dB}, droneTrim: dB }`.
Here is how to apply it. `tools/lib/render-page.js` `installTrimShim()` already does exactly this, so the calibration
and audition numbers describe the wired behaviour.
- `InstrumentRegistry.init()` also fetches `new URL('./gain-trims.json', import.meta.url)` and stores it as
  **`this.gainTrims = {synth:{}, organ:{}, droneTrim:0}`**. A fetch or parse failure should `warn` and fall back to
  zeros. The file ships with the app, so the fetch never 404s. The tools look for `registry.gainTrims`, and when it's
  an object they turn their shim off by themselves.
- `create()`: when it builds a **real** synth.js/organ.js instance (not `FallbackSynth`) and
  `dB = gainTrims[ref.type][ref.id]` is finite and ≠ 0, do
  `const g = new GainNode(ctx, {gain: 10 ** (dB/20)}); inst.output.connect(g); inst.output = g;`.
  Callers connect `inst.output` after `create()`. That covers both `audio.js` prepare and `drone.js` `_newLayer`, so
  drone-osc layers get their `synth['drone-osc']` trim too. `InstrumentBase.dispose()` disconnects `this.output`,
  which is now the trim node. Folding the factor into the instrument's own output gain is equivalent.
- **droneTrim** goes on `drone.synthBus.gain` (a static unity GainNode fed only by synth-drone layers, so files-mode
  pads are not trimmed): `setNow(drone.synthBus.gain, 10 ** (droneTrim/20), 0)`. It stacks on top of drone-osc's own
  trim. The Drone is built in `_build()`, which runs *before* `await registry.init()` in `AudioEngine._start()`, so
  the engine should apply it right after `init()` resolves, and again after `restart()`, which goes through the same
  path.

**2. The calibration method deviates from the §12 wording.** I iterated after the first audition failed. Defaults are
below. `node tools/calibrate.mjs --spec-literal` reproduces the literal spec.
- **Measurement window 0–3 s instead of 0.5–3.0 s.** Skipping the attack trims decaying instruments ~3.5 dB hotter than
  pads (piano +10.3 vs +6.8 dB). In the first audition the piano then sat 5–6 dB over the warm pad at identical slot
  settings.
- **Target −18 dBFS at master 1.0 instead of −20.** −18 dBFS at master 1.0 is −24 dBFS at the default −6 dB master.
  With −20, every single-instrument clip at the default master landed at about −26…−28 dBFS, at or below the audition
  floor (−26..−16). 8 clips failed low on RMS: the pad songs and the pad, sub-bass and drone-osc clips. The drone target follows at target − 6 = −24, keeping the spec's 6 dB
  relationship (−26 vs −20).
- **Clamp: synth/organ ±12 dB. Samplers ±30 dB. droneTrim ±18 dB.** The MusyngKite files peak at −19…−26 dBFS,
  and ep-wurli, vibes, celesta, music-box and nylon-guitar need +22…+30 dB. With ±12 they stay 10–16 dB too quiet.
  The fix belongs at the source: normalize those files and remove their DC (see reviews/audition-findings.md). After
  that, re-running calibrate brings the trims back inside ±12. droneTrim needs −12.3 dB: at drone.gain 1.0 the drone
  is 4 voices plus its own reverb send, stacked on drone-osc's +2.8 dB trim.
- **Bass-group instruments (sub-bass) are measured on a single C2 in 40 Hz–5 kHz.** The spec says C3-E3-G3 in
  100 Hz–5 kHz, but a mono bass never plays a triad at C3, and the 100 Hz edge removes its fundamental. Under the
  literal method the sub-bass ended up 6 dB too quiet in use.
- Trims are relative (`new = current + target − measured`). Passes repeat until everything is within ±0.25 dB, and a
  final pass verifies the written values. Only the `gainTrim` field of manifest.json is rewritten. The file stays in
  its existing `JSON.stringify(…, null, 2)` form, and the tool refuses to write if it isn't.

**3. Audition conventions** (`tools/audition.mjs`, 44.1 kHz, 16-bit, 12 s):
- Chords: I–V–vi–IV in the Hear-In key. The left-hand root is in C3–B3, or C2–B2 when the song has a Bass slot. The
  right-hand close triad is in C4–C5, velocity 96. Keys lift at +1.9 s. The pedal lifts at each change and is
  re-pressed 50 ms after the new chord. Minor songs play their relative major's I–V–vi–IV.
- Events go through the controller's order: prepare → commit → setTranspose(play→hear) → setKeyContext →
  drone.setKey → drone.configure → setTempo. The mod wheel is set to 0.7 when `modWheel.target === 'slots.1.gain'`.
  Otherwise it's left at the engine's 1.0.
- Instrument clips use `defaultSlot(role)` (gain 0.8, role sends), default FX and the −6 dB master. The role comes
  from the group: Synth Pads → Pad, Bass → Bass (roots only, C2 range), everything else → Keys. Samplers are
  auditioned too.
- Hard checks follow §12. The RMS window is 0.5–8 s (the played part). Mono-sum loss is stereo RMS minus
  RMS((L+R)/2). The `.mono.wav` is the engine's own mono mode, rendered separately.
- Soft checks cover clicks, drop-outs, mono-render peak, layer balance and preset lint. The click detector is an
  HF-burst detector: 4th-order HPF at 7 kHz, 2 ms RMS envelope, flag when > 18 dB over the ±120 ms median and >
  −66 dBFS, onsets −5…+80 ms excluded because the engine adds ~10 ms of output latency and hammer/tine attacks are
  legitimate bursts. It self-tests before each run: a clean sine and a dense naive-saw pad give 0 events, and a single
  phase jump gives 1. It is skipped for lofi songs with crackle.
- Chromium's hash-order input summing makes renders differ by ~1e-6 run to run (engine-instruments note). The
  reported numbers are stable to 0.1 dB.

## shell fixes (reviews/shell.md, ui-core/ui-edit findings, audition presets)

**1. Store (additive API, stricter writes).**
- `loadInfo` gains `backupError, persistFailures, readOnly, readOnlyReason`. New: `store.onInfo(fn)` (loadInfo changed:
  save failed/recovered, read-only), `store.setReadOnly(on, reason)`, `store.allowOverwrite()`, `store.unreadableRaw()`,
  `store.reload()` (re-read storage; used when a second window takes over).
- H1: a corrupt/future-schema library whose localStorage backup can't be written is **never overwritten**:
  `readOnly:true, readOnlyReason:'backup-failed'`, edits stay in memory until `allowOverwrite()` (the controller calls it
  in Electron after `rig.backupNow(raw, 'unreadable')` succeeded). Backup keys `rig.v1.backup-<ts>` are capped at 3; on a
  quota error the oldest are pruned and the write retried once.
- M7: a failed save is retried after 1 s, 5 s, 30 s, then every 30 s, with no further edits needed; saves also flush on
  `pagehide` and on `visibilitychange → hidden`.
- L1: numeric §4 params (slot leaves, sends, fx, master, drone, dynamic instrument params) accept only finite numbers
  (then clamp); NaN/Infinity/strings/null/objects/arrays → `set()` returns false + warn. Bool/enum coercion is unchanged.
  `modWheel/expression.min|max`, `bend.range`, `swell.seconds` also require numbers.
- L2: any path segment that is `__proto__/constructor/prototype` or an `Object.prototype` key is rejected (no throw);
  such ids are skipped on import/migrate; array imports with duplicate/missing ids get unique ids (`<id>~2`).
- M4: `settings.setlistIndex` follows the current entry through `moveSong/addToSetlist/removeFromSetlist/duplicateSong/
  deleteSong`. New setting **`settings.setlistGap:boolean`**: the current entry was removed from the list → `currentIndex()`
  is −1 and `neighbors()` returns `{index:-1, gap:pos, prev: pos−1, next: pos}` (Next = the song that followed it). Any
  `selectSongId` clears it. `duplicateSong` of the current song inserts right after the *current* entry.
- **Slot mute is first-class**: `Slot.muted:true` + `Slot.gainBeforeMute` (both absent when unmuted; gain is 0 while
  muted, the engine only sees gain). ui-core's `mutedGain` convention is accepted and mirrored (`mutedGain ===
  gainBeforeMute` while muted); old data with `gain 0 + mutedGain` loads as muted; writing gain > 0 unmutes.
  Writes to `…slots.<i>.gain|muted|mutedGain` that change mute state are reported as the slot path
  (`songs.<id>.patch.slots.<i>`), plain gain writes stay leaf paths.
- Aliases (ui-edit #2): `slots.<i>`, `slots.<i>.instrument`, `slots.<i>.muted`, `slots.<i>.mutedGain` resolve to the
  current song's patch.
- `setMidiLearn(id, {cc:64})` is refused (sustain pedal reserved).

**2. Controller.**
- H2: `start()` takes Web Lock **`rig-instance`** (`{ifAvailable:true}`). Not granted → `status.instance:'secondary'`,
  `status.instanceMessage` ("Another Worship Rig window is open — this one is read-only and muted…", also emitted as a
  `warn` and an `'instance'` event), store read-only, engine/MIDI not started, all engine calls muted, `resumeAudio()`
  refuses. It waits for the lock; when granted: `store.reload()`, read-only off, normal start, `instance:'primary'`.
  Options `locks` (null disables), `heartbeat` (Chrome: `GET /api/heartbeat` every 15 s), `indexedDB`.
- M1: after any restart (restartAudio, watchdog, or the engine's own `statechange {restarted:true}` / `{reason:'restart'}`)
  the controller re-sends the held pedal, re-attaches pads unless `engine.drone.files` is non-empty (then re-applies a
  files drone), and — only if the engine has no `applyRuntimeState` — re-sends mod/expr/vol and the virtual-wheel owner
  (tracked from its own calls and the engine's `'wheel'` events). A running take is split: part 1 is finalised,
  recording continues in a new file (Chrome: OPFS, downloaded at stop), with a `warn` naming both files.
- M2: `learn(id)` passes `accept:'fader'|'button'`; resolves `{error:'sustain-pedal-reserved'}` on CC64 (nothing saved;
  the pedal still sustains). Existing CC64 mappings are ignored. M3: notes are refcounted per `inputId:channel`
  (disconnect releases all channels; CC120/123 is per channel). L9: toggling `pedalInvert` recomputes the MIDI pedals
  from their raw CC64 state, but may only *release* sustain (never starts a stuck sustain).
- M4: a failed load reverts with `selectSongId(appliedId, appliedIndex)`.
- ui-core #1 `toggleView()` is a no-op (stays/returns 'perform') while `performLock`. ui-core #7 `perform.noteOn` applies
  `settings.velocitySens`; `perform.wheel` now emits `'wheel'` (N4). ui-edit #1: a removed `slots.i.params.<key>` sends the
  default from `engine.listInstruments()`; when no default is known the song is re-prepared.
- ui-edit #5: Chrome pad folder auto-restore at start when `settings.padFolder.kind==='fsa'` and the IndexedDB handle
  (`worship-rig-ui`/`handles`/`padFolder`, same schema as settings.js) has `queryPermission()==='granted'` (no prompt);
  emits `'pads'` and `'pads-restored'`. settings.js's own "attached this session" flag doesn't know about it (UI owner).
- New status fields `library {readOnly, readOnlyReason, persistError}` (one `warn` per failure streak) and `otherLibrary`.
  New methods `backupNow()`, `importLatestBackup({replace=true})` (backs up the current library first), `restoreChromePads()`;
  menu id `importLatestBackup`. Electron backups are prefixed with `"origin":"http://127.0.0.1:<port>"`.
  `globalThis.__rigShell = {recording(), library()}` (Electron only) is read by main.js before a window closes.

**3. MIDI.** `learn(id, {accept:'fader'|'button'|'any', motion=0})`: fader = continuous CC only (never notes or
CC64/66/67); button = note-on or CC press ≥ 64 (CC66/67 OK); CC64 → `{error:'sustain-pedal-reserved'}`; CC120–127
ignored; non-matching messages pass through normally. `motion>0` additionally requires that much CC travel (off by
default because the UI learns from a single message). L8: `'first'` sticks to the resolved port while it is connected.

**4. Recorder.** `ElectronSink.close()` always requests the final header even after a write error (M6); `_errored` is reset
per take; the memory sink stops itself at `memoryMaxSec` (default 3600) with a warn (L5).

**5. Server / serve.mjs / main / preload.**
- server.js: HTML gets `Content-Security-Policy` (same policy as index.html's meta, plus `frame-ancestors 'none'`) and
  `X-Frame-Options: DENY`; `test/…` HTML under appDir is exempt (fixtures use inline scripts); all files get
  `Cross-Origin-Resource-Policy: same-origin`. Pads: served files must `realpath` inside the pad folder; the listing skips
  escaping symlinks, visits each real dir once, caps 5000 dirs, and is cached until a visited dir's mtime changes.
  `/api/heartbeat`; `/api/health` adds `clientSeenMsAgo`. `listen()` option `reuse:false` (returns `busyWithRig`),
  `csp:false`; exports `walkPads, probeHealth, CSP`.
- serve.mjs: when the server is reused and a window pinged within 45 s, Chrome is not opened again (message instead);
  if no window is alive it opens one. Exports `shouldOpenWindow`, runs `main()` only as a script.
- main.js (M5): Electron never reuses a server (`reuse:false, portTries:20`); on a port ≠ 8438 a dialog offers the newest
  backup. `getInfo()` adds `preferredPort, portChanged, otherLibrary` (`reusedServer` is always false). Every window close
  writes a library backup. New IPC `rig:latestBackup` → `{path, origin, savedAt, text}`; `backupNow(json, 'unreadable')`
  writes `rig-unreadable-*.json` outside the rotation (newest 5 kept). Menu: Rig → Import Latest Backup….
  M6: streams are finished on main-frame `did-start-navigation`, `destroyed` and crash; `closeStream` always fixes sizes
  from the file. L3: 3 crashes in 60 s → Reload / Open Backups / Quit dialog. L4: non-dialog paths open with `'wx+'` and
  " 2", " 3"… L10: close/quit while recording asks (`win 'close'` + `will-prevent-unload`, which also stops Electron from
  silently refusing to close when the page's beforeunload blocks).
- Launcher checks Node ≥ 18 (N1).

**6. Presets (audition P1/P3/P4/P5).** Felt Piano `velocityCurve:'normal'`, `tone .25` (SPEC §8 said "soft velocity";
the soft curve selected the brightest layer, −14 dBFS). `drone.gain` 1.2 / 0.9 / 0.9 in Sunday Pad + Piano / Prayer Wash /
Sub + Shimmer (≈ 9 dB under the mix with droneTrim wired). Organ Swell pad 0.45 → 1.13 (+8 dB). Sub + Shimmer glass pad
`lowNote: 48`. Dusty Piano (P2, 'soft' curve) was not in scope and is unchanged.

## engine-core fixes (reviews/engine-core.md, audition C1/C2, ui-edit #3; audio.js / fx.js / sampler.js / drone.js / instruments.js / index.js)

Regression tests for every item are in test/phase1/engine/suites.mjs (offline: `paramResetOnReuse`,
`monoCeilingAndMakeup`, `predelayNoWarp`, `lofiEngageNoClick`, `tapeBendStream`, `freshStripWheel`, `pinsUnion`,
`beforeStartNoThrow`, `lofiHeadroom`, `droneInstrumentReuse`, `sampleRetry`, `gainTrimsAndRegistry`, `morphAtCommit`;
realtime: `irOffMainThread`, `droneFilesKeyRace`, `droneFilesNoHardCut`, `restartKeepsState`). All of them fail
against the pre-fix engine and pass now.

**1. Instrument reuse (#1).** prepare() keeps the current instance only when `{type,id}` *and* every effective
param (`inst.getParam(k)`, else cfg, else default) equal the new song's `params ?? default`; otherwise it builds a fresh
instance (MainStage switch, and any expensive rebuild such as organ drawbar waves happens in prepare). commit() on a
reused instance still re-applies every param to `params[k] ?? default` (covers live edits between prepare and commit).
`getParam('slots.i.params.k')` now always matches the instance.

**2. Slot morph (instruments contract).** Slot channels start with `sc.morph = 0`; commit sends the current morph
(macro.intensity / bend 'morph', usually 0) to every fresh instance: `inst.morph(m, t)`.

**3. Fresh strips (#11).** commit() updates routing state first and `setNow`s each fresh strip's wheel gain to its
effective wheel/expression/volume factor (no ramp from 1 → no first-note blip). Retiring strips are untouched.

**4. Reverb (#6, #7).** New structure: `input → HPF → LPF → unit`, one *unit* per IR key (bucket|damp|sampleRate):
`[predelay A → gain A, predelay B → gain B] → ConvolverNode → out → ret`. Units are pooled (LRU, 10 units; IR
AudioBuffer cache 12 entries, survives restart) so every factory IR (8 keys) stays resident.
- IR math runs in a module Worker: fx.js is loaded as its own worker (`new Worker(new URL(import.meta.url), {type:
  'module'})`), bit-identical to the synchronous `buildIR` (same generator). Fallback when a worker can't start or is
  silent for 10 s: the same generator on the main thread in ≤ 4 ms slices. Offline contexts build synchronously
  (deterministic renders). `irStats` counts where IRs were built.
- `reverb.stage(size, damp)` is async; `prepare()` awaits it together with the instruments and resolves only when the
  unit exists. `commit` → `reverb.commitTo(stage, predelay, when)`: gains/connections only, never an IR or a buffer.
- `engine.preload()` warms units (worker IR, then `convolver.buffer =` in an idle period ≥ 40 ms, max 5 s wait). Live
  size/damp/wash edits (`request`) use the worker and an idle period (≤ 1 s wait).
- Remaining main-thread cost: Chromium's `ConvolverNode.buffer` setter (it FFT-partitions the IR synchronously):
  7–38 ms per unit unloaded, 10–110 ms in this loaded 2-CPU container. It happens only in idle periods (preload/live
  edits) or inside `prepare()` for a size nobody preloaded — never in commit or on a warmed switch.
- Predelay: never a `delayTime` ramp on a live line. Same IR → the unit's idle predelay line is set while its gain is 0
  and the two lines crossfade (equal power, 0.5 s; a newer value waits for the running crossfade). New IR → the
  incoming unit's predelay is set while it is disconnected and rides the 0.8 s IR crossfade. Live knob edits go the
  same way (`reverb.setPredelay`). `fx.reverb.predelay` (the single DelayNode) no longer exists.

**5. Master (#5, #14).** `master → masterWheel → fadeGain → [stereo | mono(1-ch, ×√2 = sum −3 dB)] → preComp → comp →
clipPre → clip → out`: mono is summed *before* the catcher and ceiling, so mono output peaks ≤ −0.3 dBFS (loud centred
chord: −0.78 dBFS; was +2.39). The compressor's automatic makeup (+1.10 dB in Chromium) is measured once per page
(`measureCompMakeup()`, 0.5 s offline render) and cancelled in `clipPre` (`0.5 / makeup`): unity below threshold
(−23.01 dBFS in → −23.01 out; was −21.9). `fx.compMakeup` holds the factor.

**6. Lofi (#8, #15).** Engage: the dry→wet crossfade starts after the wet path's latency (`lofi.engageDelay` =
7.5 ms + 320 frames ≈ 14.8 ms at 44.1 kHz), and both directions anchor on the dry gain's actual value at the ramp start
(tracked segment), so engage, engage→bypass after 12 ms or 40 ms show no second-difference spike (max 0.00019–0.00038
vs a 0.00019 steady state; was 0.026). Headroom: the wet chain runs at −12 dB (`wetIn` 0.25, curves drawn for ±4,
`makeup` ×4), so the WaveShapers no longer clamp a hot sum at ±1 (+6 dBFS in → 0.50 out at master .25; was 0.25-0.30).
Curves are cached and computed in prepare (`lofi.warmCurves`), not in commit.

**7. Tape bend (#9).** The delay-time timeline is tracked analytically (`engine._tapeSegs`, evaluated exactly like the
AudioParam timeline), events are monotonic in time (a coalescer flush can't land before a message applied with a
lookahead), identical bend values are skipped, and in realtime tape events are scheduled `baseLatency + 10 ms` ahead so
the anchor is never in the audio thread's past. Push-up holds the delay where it is (no pitch jump). A 3 ms stream of
varying bend messages landing 3 ms late: 0 spikes (was 441 at 12 ms spacing).

**8. Drone (#2, #3, #4, #16).**
- Files mode: an element is registered in `activeEls` at `_play` (`pending` until `playing`), so a newer key change
  cancels it (silent, hard release is fine). Fades track their level (`{t,dur,from,to}`), so a fade-out starts from the
  real level. The pool starts at 4 `<audio>` elements and grows to 6; when all 6 are busy the quietest one fades out over
  150 ms and is reused after it — never a hard cut. The random start offset stays ≥ fade + 2 s before the loop crossfade.
- `attachFiles()` switches a files-mode drone that fell back to the synth over to its file (1.5 s crossfade).
- `restart()` copies `drone.files` into the new Drone before re-applying state (files mode comes back as files).
- Synth drone: drone-osc instruments are reused (idle pool of 2, a spare built in idle time; one is pre-built in idle
  time after start). setKey 1–2 ms (was 5–77 ms). `drone.setTrim(dB)`, `drone.warm()`.

**9. Restart / runtime state (#10).** `engine.getRuntimeState()` → `{wheel:{mod,expr,vol}, modOwner, faded}`;
`engine.applyRuntimeState(r, {when})` restores it (a virtual owner keeps pickup, hardware ownership stays hardware;
`faded` → fadeGain 0 until the next noteOn). `getState()` includes `runtime`; `applyState()` applies it before the patch.
The controller's M1 logic already skips its own wheel re-send when `applyRuntimeState` exists.

**10. Samples (#12, #17).** `BufferCache.pin(urls)` adds (union); new `setPins(urls)` (replace) and `unpin(urls)`.
`engine.preload(patches, {pin})`: `'add'`, `'replace'`, `'none'`, default `'auto'` = replace for > 2 songs (setlist),
add for ≤ 2 (neighbours). **Controller (shell):** please pass `{pin:'replace'}` from preloadSetlist and `{pin:'add'}`
from preloadNeighbors explicitly (a 1–2-song setlist is otherwise treated as neighbours). Fetch: 10 s timeout
(`AbortController`), network/timeout/5xx/408/429 retried twice (0.4 s, 0.8 s), then skipped and retried by a later
acquire after 30 s; 404/410/decode errors are permanent (one warn).

**11. Before start() (#13).** setWheel/modWheel/expression/volumeCC/pitchBend store their value; setParam (fx/master)
stores into the patch (applied by start()); setTempo stores; slot params return false; swell, drone.* and at() warn and
no-op; getParam('drone.*') → undefined. Nothing throws.

**12. Registry (audition C1, ui-edit #3).** `registry.gainTrims = {synth, organ, droneTrim}` from `./gain-trims.json`
(fetch failure → warn, zeros). Real synth/organ/synth-extra instances get a trim GainNode after their output
(`inst.output` is the trim node, `inst._untrimmedOutput`, `inst.trimDb`); FallbackSynth is not trimmed. `droneTrim` goes
on `drone.synthBus` when synth.js loaded (not for the fallback drone). tools/lib/render-page.js sees `registry.gainTrims`
and switches its shim off. Sampler `gainTrim` stays dB (verified: `gainTrim: 6` → output gain 1.995). synth-extra.js is
imported (optional) and its `PATCHES` merged into the synth registry with their own class (`SynthExtraInstrument`) and
group names. `list()` omits `hidden: true` entries (drone-osc is always hidden); `paramsFor`/`create` still see them.

**13. Smaller.** Delay: a ≤ 5 % time change glides linearly over max(0.5 s, 20·Δ) (≤ 5 % echo pitch shift; #20). Mono
slot noteOn is exception-safe (#19). Pedaled entries whose voice died are pruned at noteOn. index.js also exports
`buildIRChannels`, `buildIRChannelsAsync`, `irStats`, `measureCompMakeup`, `BufferCache`.

Not done: #18 (commit refused after a restart during an in-flight prepare; controller-side), `processSample` still runs
on the main thread per decoded file (only while a sampler is being prepared), sampler `tone = 1` is not a bypass (nit).

## instruments fixes (reviews/instruments.md M1–M3, m1–m9, audition E1; synth.js / organ.js / voice.js)

All numbers are seeded OfflineAudioContext renders in headless Chromium, 44.1 kHz unless stated. "Was" = the pre-fix
code, measured with the same probe. Regression checks for every item are in `node test/phase1/instruments/run.mjs`
(143/143). This box is loaded (load ≈ 9 on 2 cores), so perf numbers are interleaved A/B medians.

**Contract-visible changes (additive).**
- `inst.output` is now a static **soft ceiling** (m8) after the instrument's trim. The old output GainNode (trim) is
  `inst.trimNode`, and `inst.ceiling` is the WaveShaper. It is linear below −4 dBFS (a C-E-G at vel 96 on every patch
  and preset differs by at most 2.4e-7), bends smoothly (tanh knee) to an asymptote of −1 dBFS, and uses oversample
  'none': no latency and no gain riding, so nothing pumps. The engine's gain-trims node still goes after it.
- `PATCHES` drone-osc has `hidden: true`.
- organ `morph(x)` now depends on the `rotary` param (M2). With 'fast' or 'slow', x < .5 gives the param's own speed and
  x ≥ .5 gives the other speed. With 'off', morph does nothing. `setParam('rotary', …)` takes the current morph into
  account. morph(0) is therefore neutral for every patch.
- New exports, all additive; existing exports are unchanged. From voice.js: `qDb`, `BUTTER2_Q`, `BUTTER4_Q`, `FM_EDGE`,
  `FM_MARGIN`, `fmIndexCap`, `FmDepth`, `sineWaves`, `triangleWaves`, `monoBelow`, `softCeilingCurve`,
  `addOutputCeiling`. From synth.js: `glassWaves`. From organ.js: `drawbarWaves`, `WAVE_ROTATIONS`, with `drawbarWave`
  kept (rotation 0). Also `organ.xover` ([lo, hi]).

**M2 organ morph.** Engine render: gospel committed, one note. The dominant AM was **1.6 Hz** (the first morph(0)
switched the rotor to slow) and is now **5.96 Hz**, with the rotor 'fast' and morph 0. Instrument level: gospel morph 0
6.82 Hz, morph 1 0.84 Hz (slow); slow preset + morph 1 6.82 Hz.

**M1 organ percussion.** There is now one shared envelope per instrument, with trigger time `_percT`.
- A note-on with no key down re-arms the envelope. A key counts as down if it is held or pedal-held, i.e. the voice is
  not yet released at `t`.
- Every note starting while the envelope decays gets the 3rd harmonic at 0.9·e^{−(t−t0)/0.2}. Below 2e-3 no oscillator
  is built.
- The percussion sine uses rotation 6·r of the tonewheel's rotation r (2⅔′ = harmonic 6 of f/2), so it stays phase-locked.
- 3f level with / without percussion, C4-E4-A4 at the same `when`: was −29.5 / −80.5 / −82.1 dB, **now −29.8 / −29.9 /
  −30.7 dB** (no-percussion floor −79…−86). A 5 ms roll gives the same result.
- Re-arm check: a note added 1.95 s into a held key gets level 0. After all keys are up, the next note gets 0.90.
- Pedal-held voices keep it disarmed, as on a Hammond with the keys held. Organ slots defaulting to `sustain:false` is
  still the shell/engine's call.

**M3 / m6 / m9 FM Nyquist guard.** The index is capped per note so that f + extra + (I + 1.5)·fm ≤ 0.45·sr (`fmIndexCap`).
- Carson's I + 1 still folded E6–G6 at morph 1 to −26…−29 dB, so the guard uses I + 1.5.
- The cap depends on f and fm, which makes it a keytracked and ratio-tracked index limit.
- `FmDepth` schedules index(t)·fm exactly. It holds at the cap until the decay crosses it, and `retune(fm, cap, t, dur)`
  keeps the in-flight index when fm moves.
- Alias energy (off the |f + k·fm| grid, < 20 kHz, re total):

  | bell case | was | now |
  |---|---|---|
  | C7 morph 1 | −6.8 dB (review −7.5) | **−52.2 dB** |
  | A6 morph 1 | −14.8 | −45.8 |
  | G6 morph 1 | — | −38.5 |
  | E6 morph 1 | −27.0 | −40.0 |
  | C6 morph 1 | — | −41.3 |
  | C6 index 6 | −14.2 | −37.3 |
  | C5 index 6, ratio 8 | — | −33.1 |

- m6: upper sideband re carrier for a moved note vs a fresh note at the same target:
  - bell legato +12: was −9.1 vs −1.5 dB, **now −1.5 vs −1.5**
  - bell morph 0→1: was −6.4 vs −2.0, **now −2.0 vs −2.0**
  - soft-keys legato: was −15.2 vs −10.6, **now −10.8 vs −10.7**
- m9: soft-keys tine index is capped above the 1:1 pair's own bandwidth, and the tine is skipped if the cap is < .02.
  Loudest alias peak re f0: F6 tine 2 was −41.9 and is **−87.3 dB**; C6 was −48.8 and is **−86.1 dB**.

**E1 soft-keys DC.** There is now a 20 Hz 2-pole Butterworth HPF on the bus before the drive and tanh (one per
instrument). On a C3-E3-G3 chord at vel 96, the mean over 0.05–2.5 s was **−1.5e-2** and is **4.7e-4**. The worst
100 ms window was 4.9e-2 and is 5.2e-3, which is the HPF's own onset transient.

**m1 Q in dB.** lowpass/highpass `Q` is dB in Web Audio. `getFrequencyResponse` of the real nodes:
- lpfPair (−5.33 / +2.32 dB): at fc, was +1.8 dB with a +3.8 dB bump at 1.39 kHz; **now −3.01 dB with a peak of
  0.00 dB**.
- warm-pad resonance knob: now `2.32 + res·14.93` dB. At res 1 the peak was +7.5 dB and is **+12.0 dB**.
- Single 2-pole filters (sub-bass LPF, bus HPFs, soft-keys DC blocker, organ crossover): −3.01 dB, i.e. −3.01 dB at fc.
- Glass LPF: linear .6 → −4.44 dB.
- Organ crossover: each branch is −3.01 dB at 800 Hz, and |LP|² + |HP|² = 0.00 dB.
- Rotating measurement (noise into the rotary, long-term band power re dry, expected = the rotors' AM mean power,
  −1.11 dB at 800 Hz):
  - 800 Hz: slow −0.82, fast −1.13 dB, which is **within ±0.3 dB**.
  - 630 Hz: +0.4 dB re dry, down from +3.7 dB. That is still +1.4 dB over expected. The horn's 1 ms base delay makes the
    two rotor paths partly coherent (J0 of the Doppler phase swing).
  - Also tried: drum-path delay alignment, HP inversion, LR2/LR4, and a 1st-order complementary pair. None held ±0.5 dB
    over 630–1000 Hz while rotating. The 1st-order pair came closest (±0.7) but doubled the mid-register AM depth
    (C5 fast 4.3 → 8.7 dB p-p), so the plain Butterworth pair ships.
- **For engine-core:** the same linear-Q-as-dB mistake is in `fx.js` (reverb-send HPF180/LPF9k, delay tone LPF, lofi
  tilt LPF/HPF; review lines 338–339, 516–517, 765–766) and `sampler.js` (tone/velocity LPF, lines 227, 309). Convert
  with `qDb(q)` (voice.js) or use −3.01 dB for Butterworth.

**m2 WaveShaper latency.** Note onset, in frames at 44.1 kHz:

| instrument | was | now |
|---|---|---|
| soft-keys | 179 | **1** ('none'; it measured the same as 4x) |
| sub-bass | 131 | **3** ('none'; it measured the same as 2x) |
| organ gospel / full, drive ≤ .5 | 193 | **1** |
| organ drive > .5 | 193 (4x) | **129** (2x; full at drive 1 aliases −69 dB, vs −29 with 'none') |

The organ oversample follows `drive` lazily: `_syncOversample()` runs on setParam('drive') and at noteOn, and only
switches while `alloc.size === 0`, so the switch can't click.

**m5 rotary Doppler.** Convention: + means the pitch peak leads the loudness peak. `hornDelayDepth` is now −0.35 ms, so
the delay is shortest where the AM peaks (the horn points at the mic). With a 5 kHz probe through the fast horn,
pitch-minus-AM phase was **−91°** and is **+89°**: pitch peaks while the horn approaches, and loudness peaks ≈ 90°
later. Rotor 6.80 Hz, ±75 Hz.

**m3 glass H3.** `sin[3] = −0.2`, keeping the triangle's sign. One oscillator, zero-padded FFT: H2 −6.01 dB and H3 was
−21.7 dB, **now −13.97 dB**. Also n7: glassWaves is cached per context.

**m4 soft-keys tremolo.** The equal-power StereoPanner is replaced by linear antiphase gains:
gL = 1 − d(1+lfo)/2, gR = 1 − d(1−lfo)/2. A norm gain keeps the per-side RMS at the old 1/√2 for any depth, so
calibration is unchanged. At full depth (morph 1) the mono fold-down's AM at 4.5/9 Hz was **2.4 dB p-p** (3.3 by the
review's detector) and is **0.0 dB**. Each side is 19.4 dB p-p. The mono level drops statically by 1.2 dB at full depth.

**m7 mono lows (warm-pad, drone-osc).** `monoBelow()` is a bus stage: out = M ± HPF₄(S). It leaves the mid (and so the
mono sum) untouched. The side 4-pole HPF corner is **200 Hz**, because a 150 Hz corner still leaves the side at −3 dB
at 150 Hz (−15 dB below 150 on C2). Side re mid below 150 Hz:
- warm-pad C2: was −6.5 dB, **now −23.9 dB**
- drone-osc D2: was −14.7 dB, **now −27.1 dB**
- warm-pad G2: −33 dB

**m8 headroom.** Start phases are now random from 8 cached rotations, for bell carrier and modulator, sub-bass
sine/tri/H2 (H2 uses rotation 2r, so it stays phase-locked and the tanh still makes no DC) and organ tonewheels.
Glass already had random phases. Random phase alone barely moved the peaks (bell 16 voices +6.3 → +6.0 dBFS), because
16 sines sum to about −3 dBFS RMS at the onset. The output ceiling does the work. Peak of 16 voices (C2…A5) at vel 1:

| instrument | was (dBFS) | now (dBFS) |
|---|---|---|
| bell | +6.3 | **−1.0** |
| church | +3.3 | −1.0 |
| warm-pad (res 1) | +2.4 | −1.1 |
| strings | +1.9 | −1.4 |
| warm-pad | +1.7 | −1.5 |
| drone-osc | +1.7 | −1.3 |
| soft-pad | +0.8 | −1.6 |
| every other patch | | ≤ −2.6 |

**CPU.** The per-voice static HPFs (warm-pad 120, glass 120, strings 150, drone 80) are now one stereo biquad on the
bus. Interleaved A/B medians, 16 voices × 4 s:
- warm-pad 1070 → 921 ms (−14 %), strings 1211 → 1001 ms (−17 %), drone-osc about −10 % (noisy). The new mono-low stage
  and ceiling are included in the "after" numbers.
- Not bit-identical: the HPF now follows the envelope and the k-rate LFO filter, so the moved graph is not LTI-equivalent.
  Measured against a per-voice-HPF variant of the same code, the difference is −48.6 dB (warm-pad) and −51.4 dB (strings)
  re signal, max |Δ| 1.2e-2 during attacks.
- Voice nodes per warm-pad voice: 18 → 17.

**Levels moved: re-run `tools/calibrate.mjs` after the engine-core Q fixes land.** Band RMS (100 Hz–5 kHz, C3-E3-G3
vel 96, 48 kHz, 4 seeds), new minus old, at unchanged built-in trims:

| instrument | Δ dB | cause |
|---|---|---|
| warm-pad | −2.46 | Butterworth LPF pair |
| glass-pad | −2.42 | H3 fix changes the PeriodicWave normalisation |
| strings | −2.27 | |
| drone-osc | −1.84 | |
| organ full | −1.82 | rotary crossover bump removed |
| organ soft-pad | −0.84 | |
| organ gospel | −0.64 | |
| sub-bass | −0.37 | |
| soft-keys, bell, church | ±0.05 | |

The built-in trims were deliberately left alone, so the ceiling stays inert at calibrated level: calibrate's
gain-trims node sits after it. A `--dry` calibrate run also shows about −1 dB common to every instrument, including
unchanged ones (bell −1.1, church −1.1). That offset comes from outside these three files.

**Test-suite changes** (test/phase1/instruments/**):
- 32 fix checks were added. The organ-morph check through the real engine uses `fixtures/manifest.json` (empty) so no
  404 is logged.
- Steal renders tap `inst.trimNode`, before the ceiling. That test relies on linear superposition, and 17 bell voices
  engage the soft clip.
- release-in-attack sets detune 0: unison beating was ±1.5 dB in its 40 ms windows. Its windows are now aligned on the
  noteOff.
- The sub-bass morph metric is H2/H1 (morph = drive). Its centroid moved only +4.5 % once the LPF became Butterworth.
- The hard-kill positive control dropped warm-pad and drone-osc. Without the per-voice HPF, a hard kill there measures
  HF(D) ≈ HF(voice) at −73/−80 dB re the voice's energy (was +24.5/+25.3 dB), so it is no longer a click to control
  against. Bell, gospel, soft-pad and church still flag it.

## synth-extra (app/js/engine/synth-extra.js, test/phase1/synth-extra/**)

Ten more synth patches for genre coverage. The registry already loads the file (`load('synth-extra.js', ['PATCHES'],
['SynthExtraInstrument'], …, {optional:true})` in instruments.js) and merges the defs as **type `'synth'`**. Tests:
`node test/phase1/synth-extra/run.mjs` gives 153/153. `--calibrate [--write]` re-measures and rewrites `gainTrim`.

| id | group | sound / morph |
|---|---|---|
| `supersaw-pad` | Synth Pads | 7 saws ±25¢ (random phases), M/S width, HPF 100, LPF 3 k keytracked, sine sub / morph: +2400¢ filter, +.4 width |
| `juno-pad` | Synth Pads | saw − delayed saw = true PWM (shared LFO), square sub, shared 2-voice chorus / morph: chorus + 1200¢ |
| `shimmer-pad` | Synth Pads | glassy tri+partials, centre + detuned sides, octave-up fading in over 3 s, stereo tremolo / morph: octave-up level |
| `dx-epiano` | Synth Keys | 3 FM stacks (two 1:1 body stacks, 14:1 tine), velocity drives the index, shared chorus / morph: FM index |
| `pluck` | Synth Keys | saw+square, filter follows the decay, decay .4–1.2 s keytracked (T20) / morph: decay ×2.5 |
| `poly-stab` | Synth Keys | 2 saws + square, filter env on the biquad detune / morph: env amount + resonance |
| `analog-brass` | Brass & Leads | 3 saws, 80 ms filter-env attack, vibrato onset .4 s / morph: filter env amount |
| `square-lead` | Brass & Leads | PWM pulse + square sub, 60 ms portamento via legatoTo, delayed vibrato / morph: pulse width + brightness |
| `808-sub` | Bass | sine −2 st glide over 60 ms, long decay, shared tanh drive / morph: drive |
| `synth-bass` | Bass | saw+square (phase-locked), fast filter env / morph: cutoff |

**Import expectations for instruments.js** (the current code meets all of them):
- Exports: `PATCHES`, `SynthExtraInstrument`, and default. The constructor is `new SynthExtraInstrument(ctx, prng,
  patchId, initialParams)` with the patch **id string**. `prng` may be a createRng object, a callable, or a seed. An
  unknown id warns and builds supersaw-pad.
- The instance API is the same as SynthInstrument: `output`, `ready`, `noteOn`, `noteOff`, `allOff`, `setParam`
  (returns false and warns on an unknown key), `getParam`, `morph`, `setBend`, `legatoTo`, `liveVoiceCount`,
  `liveNodeCount`, `fadeOutVoice`, `dispose`, `alloc.steals`, `_sharedNodes`. It also has `trimNode`, which comes
  before `ceiling` (WaveShaper, linear below −3 dBFS, tanh knee to −1 dBFS).
- Ids must not collide with synth.js ids. The registry keeps synth.js's def on a collision, and none exists today.
- **`gainTrim` (dB) in PATCHES is applied INSIDE the instrument, like synth.js's built-in trim. The registry must not
  apply it again.** The calibration is folded into the internal levels, so every value is currently 0.0.
  gain-trims.json `synth[<id>]`, if ever written, stacks on top.
- `PATCHES[i].calibWindow` is optional, in seconds. Only `pluck` sets it, to `[0, 1]`: its sound is over after about
  1 s. Measured over 0–3 s, the mean includes 2 s of silence and would trim it +4.8 dB hot. At that level every 3-note
  chord's attack would sit about 2 dB into the output ceiling. **tools/calibrate.mjs does not know this field yet.**
  `registry.list()` does not pass it through either (it copies ref/name/group/params/license). A non-dry calibrate
  run will therefore write `synth.pluck ≈ +7 dB`. Integration: pass `calibWindow` through `list()` and use it in
  calibrate, or exclude `pluck`.
- The group `'Brass & Leads'` is new. The registry passes any group string through, but `views/edit.js`
  `INSTRUMENT_GROUPS` maps unknown groups to 'Synth Pads'. The UI owner should add 'Brass & Leads' (between
  'Synth Keys' and 'Mallets & Bells').
- Mono patches (808-sub, synth-bass, square-lead, pluck) have a **stereo (dual-mono) output**
  (`output.channelCountMode = 'explicit'`, 2 channels). The engine's per-slot StereoPannerNode pans a mono input
  with the equal-power law, which gives −3 dB per side at centre, and passes stereo through at unity. Without this,
  mono instruments measure 3 dB under their stand-alone calibration inside the engine. synth.js's sub-bass carries
  its +4.5 dB gain-trims entry partly for this reason.
- Suggested for engine-core: `PAD_LIKE` (macro.intensity → morph) could include `supersaw-pad`, `juno-pad` and
  `shimmer-pad`. Mono-slot candidates (Bass role / legato) are `808-sub`, `synth-bass` and `square-lead`.

**Measured** (seeded offline Chromium; calibration at 48 kHz, everything else at 44.1 kHz):
- Level. Band RMS is −18.0 ±0.05 dBFS at unity for every patch with the tools/calibrate.mjs method (pluck: over 0–1 s).
  Through the real engine, `calibrate.mjs --dry` reads −17.9…−18.3 for 7 patches, and 808 −19.2, dx −18.8, pluck
  (0–3 s) −25.1.
  - The low engine readings for decaying patches are a **calibrate.mjs artifact**. It plays its notes at t = 0, the
    same instant as `commit()`. Played 0.5 s after the commit, the same renders read 808 −18.21 and dx −18.23.
  - Every decaying instrument (piano, bell, church…) is therefore measured about 0.5–2 dB low and trimmed hot. This
    probably explains the "≈ −1 dB common offset" in the instruments fixes note.
  - Suggested fix: start the calibration events about 0.5 s after the commit and shift the window by the same amount.
- Peaks. The output never exceeds −1 dBFS: the ceiling holds 8 voices at velocity 127 to −1.0…−5.3 dBFS.
  - Raw peaks at 8 × vel 127, before the ceiling: synth-bass +7.1, dx +5.2, pluck +4.0, stab +2.8, pads +0.5…+2.6,
    brass 0.0, lead −2.6, 808 −5.3 dBFS.
  - The 3-note vel-96 calibration chord stays under the −3 dBFS knee except supersaw (−1.9) and dx (+0.4: an onset
    transient, about 2 dB of shaping for a few ms).
- Hygiene. |DC| ≤ 4.4e-4 (808; ≤ 8.4e-5 elsewhere). Mono-sum loss ≤ 0.83 dB, and 1.42 dB for supersaw at morph 1
  (widest). No steal click (HF(D) ≤ HF(voice) +0.8 dB). Kill, dispose and allOff leave 0 live nodes.
- CPU at 16 voices × 4 s offline, ×realtime on this loaded box: 808 104, pluck 22, synth-bass 17, lead 16, juno 12,
  dx 9.6, stab 9.0, shimmer 8.4, brass 8.0, supersaw 6.3. Relative to synth.js warm-pad rendered interleaved:
  supersaw 1.37×, everything else 0.06–0.89×.

**Chromium FM findings (these also apply to synth.js soft-keys/bell).**
1. With f_c = f_m (1:1), sine-phase FM puts J1(I)·cos(I) at 0 Hz, which measured 6 % DC. Cosine-phase modulators
   remove it.
2. The a-rate frequency input is integrated with a **half-sample lag**. The 1:1 DC term vanishes exactly at a
   modulator advance of π·f/fs, measured at 44.1 and 48 kHz from 130 Hz to 1 kHz. Without it: 1.2 % DC at C3, 10 % at C6.
3. An oscillator whose frequency has an a-rate input **advances its phase through the not-yet-started frames of its
   first render quantum**. A start mid-block therefore skews a carrier against its modulator by up to 2.9 ms (measured
   up to 56 % DC). FM stacks must start on a block boundary.
4. A decaying sine-phase modulator on a carrier leaves a permanent phase offset of about its index (14:1 tine: 0.28 rad
   → 15 % DC on a shared 1:1 carrier).

Measured on the current synth.js (48 kHz, vel .75, 3 s mean): soft-keys C3-E3-G3 |DC| 1.0e-3 at t = 0 and 6.6e-4
mid-block, at RMS 0.11 (≈ 1 %); C5 1.1e-4; bell 4e-7. That is small but borderline against a 1e-3 criterion. Most
of the effect is probably held down by the post chain, but I haven't confirmed that.

## shell-3 (server.js / serve.mjs / main.js / preload.js / store.js / controller.js / presets.js / docs / CLAUDE.md)

Tests: `node test/phase1/shell/run.mjs` gives unit 114/114, browser 12/12 and Electron 14/14. The new file is
`test/phase1/shell/shell3.test.mjs` (18 tests). The Electron boot and Playwright suites cover My Samples end to end.

**1. My Samples (user sample packs).** `createServer({userSamples})` accepts `true`, which uses
`defaultUserSampleRoots()`, or an explicit array of roots. The default is off. main.js and serve.mjs pass `true`.
serve.mjs also accepts `--user-samples a:b`.
- Roots, in priority order:
  1. `<repo>/user-samples`, skipped when running inside `app.asar`.
  2. `~/Music/Worship Rig/Samples`.

  `RIG_USER_SAMPLES` (a path-delimiter list) replaces both. `userSamplesHome()` is the folder to open: the first
  override, else the ~/Music one. It is also the importer's default output.
- `/api/health` adds `userSamples: bool` and `features: ['user-samples']`. The engine registry requests the optional
  manifest only when these are set, which avoids a console 404.
- `GET /api/user-samples/manifest.json` always returns 200, also when the folders are missing or empty, and also when
  the feature is off. The body is `{app, kind:'user-samples', instruments, roots, packs:[{slug,count}], errors}`.
  - Every `<root>/<slug>/manifest.json` is merged. The input is `{instruments:[…]}` or a top-level array.
  - Ids are **not** namespaced; the engine adds `user:`. Each instrument gets `pack: <slug>`.
  - Each layer's `dir` (default `inst.dir ?? inst.id`) is rewritten to the absolute path
    `/user-samples/<token>/<encoded slug>/<encoded dir>`. `files` values are rewritten the same way.
  - Relative paths with `..`, absolute paths and URLs are dropped. An instrument left with no layers is skipped.
  - When two roots have the same slug, or two packs have the same id, the first wins and an `errors` entry is added.
  - Dot-folders are skipped, and so are pack symlinks that resolve outside their root.
  - The manifest is re-scanned on every request. `/user-samples/…` re-scans lazily when it sees an unknown slug.
- `GET /user-samples/<token>/<slug>/<file>` serves audio only: `.mp3 .wav .m4a .aac .caf .aif .aiff .flac .ogg .oga
  .opus .webm`. It supports Range. The file must realpath inside the pack. The token is random per server process and
  stays stable across rescans, so URLs the engine has cached keep working.
- `GET /api/user-samples` returns `{enabled, dir, path, roots, count, packs, errors}` for Settings in Chrome, which
  already fetches it.
- The API routes (`/api/health`, `heartbeat`, `pads`, `user-samples[/manifest.json]`) also answer under a path prefix,
  for example `/app/api/health`. ui-edit's fixture mode serves the repo root with the page at `/app/`. The engine
  derives `./api/health` from its optional manifest URL, so before this change it logged a console 404 there (the
  ui-edit "zero console.error" failure).
- `GET /docs/<name>.md` serves `<repo>/docs` as `text/plain`. Settings links `docs/garageband-import.md`, which is
  outside `app/`. package.json `build.files` adds `docs/**/*.md`.
- Server exports `scanUserSamples(roots, token)`, `defaultUserSampleRoots({repoRoot, env, home})`, `userSamplesHome()`
  and `USER_SAMPLE_EXTS`. Methods `rescanUserSamples()` → `{count, instruments, roots, packs:[{slug,dir,count}],
  errors}`, and `userSampleRoots` / `userSamplesEnabled`.
- `window.rig` additions:
  - `userSamplesDir()` → `{path, exists, roots}`.
  - `openUserSamplesFolder()` → `{ok, path}`. It runs `mkdir -p`, writes a `README.txt` when it creates the folder,
    then calls `shell.openPath`.
  - `rescanUserSamples()` → `{count, instruments:[{id,name,pack}], packs, roots, errors}`. This is a server re-scan
    only.
  - `openDoc(name)` opens `docs/<name>.md` (or `'readme'`) in the default app.
  - `openFolder('userSamples')`.
  - `getInfo()` adds `userSamplesDir` and `userSampleRoots`.
- Menus: Rig → **Open My Samples Folder** (main-side) and **Rescan My Samples** (sends the new menu id
  `rescanUserSamples`). Help → **Importing GarageBand Sounds**.
- `controller.rescanUserSamples()` → `{count, reloaded, errors}`. It calls `rig.rescanUserSamples()` in Electron, or
  fetches the manifest in Chrome. Then it calls `engine.reloadManifests()` **if the engine has it**. If not, it emits
  a `warn` asking for a restart. It also emits `'user-samples'`.
  - **For engine-3:** `reloadManifests()` should re-run the registry's manifest load (factory plus optional) and
    re-emit whatever makes the UI re-list instruments.
  - **For UI:** settings.js `rescanSamples` treats any controller result as "reloaded". Check `res.reloaded` and keep
    the Reload button when it is false.
- `.gitignore` gains `user-samples/`, `audition/*.wav` (instead of the whole `audition/`) and `test/logs/`.
  electron-builder `files` gains `!**/user-samples/**` and `!app/samples/**/*.trim.wav` (integration #4).

**2. Controller.**
- Preload pins: `preloadSetlist()` → `engine.preload(patches, {pin:'replace'})`, and `preloadNeighbors()` →
  `{pin:'add'}` (engine-core fixes #10).
- engine-core #18: when `commit()` returns `false` (a stale token after a restart during the prepare), selectSong
  prepares and commits **once** more. A second refusal emits a warn, puts `status.songId` and the store selection back
  on the song the engine is playing, and returns false. reprepare does the same, with one retry.
- `status.pedal` (boolean) is the effective sustain: MIDI CC64 after `pedalInvert`, Space, or on-screen. It is updated
  on every change and on panic.
- `controller.on(type, cb)` → unsubscribe; `cb` receives the event detail. A new event, **`'songSelected'`
  `{id, patchSnapshot, songSnapshot}`**, fires after each successful selectSong commit. The snapshots are plain deep
  copies.
- `controller.revertSong()` restores the snapshot through the store. It covers `patch`, `drone`, `tempo`, `playIn`,
  `hearIn`, `transposeOctave` and `minor`, and keeps name, notes and category. It returns true when something changed.
  The engine follows through the normal store→engine diff.
- The store→engine slot diff is now PARAMS-driven. Every non-dynamic `slots.<i>.*` row is included (`width`,
  `eq.low`, `eq.high`, and any future ones). A row removed from a slot sends the table default. fx units were already
  generic, so `fx.eq.*` and `fx.comp.amount` flow as soon as they are set.
- New menu id `rescanUserSamples`.

**3. Electron self-test (integration #2).** `installSelftest` hooks `session.webRequest.onCompleted`. Any response
≥ 400 for our origin counts as a console error, is added to `console` as `HTTP <status> <method> <url>`, and is listed
in the report's new `httpErrors` field.
- The boot fixture makes one deliberate `/__selftest-404.json` request. The test asserts that it is the **only**
  error, which proves 404s are now visible.
- test/README.md's "Electron … a 404 does not show up there" note is outdated for main.js (integration owns that
  file).

**4. Presets.**
- Dusty Piano uses `velocityCurve:'normal'` (audition P2).
- There are now 19 factory songs. The 8 new ones use the new instruments. Their space and echo blocks are the
  `fx-presets.js` presets spread in unchanged, so `matchPreset` names them:

  | song | category | space / echo |
  |---|---|---|
  | Anthem | worship | Stage + Dotted (= vibe "Full Set") |
  | Gospel Stab + B3 | worship | Room + Slapback |
  | Upright + Pad | worship | Stage + No Echo |
  | Clav Funk | keys | Room + Slapback, reverb return .5 |
  | Music Box Lullaby | ambient | Cathedral + No Echo |
  | Dream Juno | ambient | vibe Ambient |
  | 80s Ballad | synth | Hall + No Echo, chorus .6/.65/1.25 |
  | Synthwave | synth | Stage + Quarter |

  Wheel routing:
  - Anthem and Dream Juno: `macro.intensity`.
  - Synthwave: `macro.wash`.
  - The others: the slot-1 level.
  - Songs with a synced echo have a tempo.
- New `CATEGORIES` value: `'synth'`. New export `CATEGORY_LABELS` (includes `user`). **For UI:** edit.js has its own
  `CATEGORY_LABELS` without `synth`, so the factory browser shows "synth". Import it from presets.js.
- `FACTORY_VERSION = 2` and `FACTORY_SINCE` {id → version}. The helper field `since` never reaches the Song objects.

**5. Store.**
- **Factory top-up:** `seedFactory()` on a library whose `meta.factoryVersion` is below 2 appends the factory songs
  added since (by `FACTORY_SINCE`) to the library order. They are not added to setlists, and the current song doesn't
  change. It skips any `factoryId` already present, then sets `factoryVersion = 2`. This runs once, so a v1 song the
  user deleted is not restored, and the v2 songs aren't re-added after the user deletes them. A fresh seed writes
  `factoryVersion: 2`.
- Optional table params (slot `width`, `eq.low/high`; `fx.eq.*`, `fx.comp.amount`, and any future
  `slots.<i>.*`/`fx.*` rows) are clamped by `normalizeSong` **when present** and stay absent otherwise, so the schema
  is unchanged. `set()` already routed them through `isValidPath` and `strictParam`. The new test drives every PARAMS
  row dynamically through `set()` (valid, NaN, string, over-range) and a reload.
- Category is not validated; unknown strings are kept. `SONG_CATEGORIES` = CATEGORIES + `'user'` is exported for the
  UI.

**6. Docs.**
- README: the 19 songs by category, a Sounds section (instruments by group and by style), Space/Echo/Vibe, My Samples
  (folders, rescan, GarageBand pointer), a corrected licenses paragraph (Musyng Kite is CC BY-SA 3.0, VSCO is CC0),
  and For developers (layout, tests, docs index).
- New files: `docs/architecture.md` (as built) and `CLAUDE.md` (conventions, commands, trim locations, caveats; file
  ownership no longer applies).

## ui-core-2 (reviews/ux.md; index.html / styles.css / main.js / views/perform.js / views/components/**)

**Components (additive; defaults keep the old behaviour, so Edit is unchanged).**
- `fader({ relative?, resetOnDoubleClick? })`: `relative:true` = pointer-down never moves the value, movement maps to
  a delta (1 track length = full range, Shift = ¼), pointer capture; a native touch jump during the drag is undone.
  `resetOnDoubleClick:false` disables the dblclick reset. Perform uses both (slot faders, drone Level, Master).
- `wheelStrip`: relative drag by default (`relative:false` restores jump-to-click); `set({ expr, vol })` shows an
  Expr / Vol row (number 0..1, `null` hides), `set({ pedal, pedalStuck })` drives the sustain lamp.
- `setlistStrip({ dragNeedsAlt })`: mouse-drag reordering only with Alt (Perform). One tab stop (roving tabindex),
  ←/→/Home/End move focus inside the strip. The current chip is kept in the left third on every change and resize.
- `chordReadout` adds class `live` while a chord is held (muted colour otherwise).
- `util.h()` sets `style: {'--x': …}` custom properties via `setProperty` (UX M4). New `relativeDrag(input, …)`.
- New `components/instrument-groups.js` (exported from `components/index.js`): `INSTRUMENT_GROUPS` =
  Piano, Electric Piano, Organ, Synth Pads, Synth Keys, **Brass & Leads**, Mallets & Bells, Guitar, Bass, **My Samples**;
  `groupOf(item)` (`user:` ids without a group → My Samples), `groupInstruments(list)` (unknown groups after the known
  ones, never lumped into Synth Pads), `stageName(name, ref)` (drops library credits "(Salamander)", "(MusyngKite)",
  "(VSCO)"; "Drone Oscillator" → "Sub Drone"). **ui-edit:** `edit.js INSTRUMENT_GROUPS` can import these.

**Shell UI (main.js / index.html).**
- `#banners` (in flow under the top bar): `#audio-banner` (role=alert) with the 48 px `#btn-restart-audio` while
  `status.audio` is `stalled`/`restarting` (the top-bar button and the error toast are gone); persistent banners for
  `status.instance === 'secondary'`, `status.library` (readOnly / persistError) and `status.otherLibrary` (calls
  `controller.importLatestBackup()`; "Not now" dismisses for the session). `--banner-h` tracks their height; toasts
  moved top-right under it. Controller `warn`s for the second window / newer library are not toasted twice.
- Esc: a document keydown listener registered before `controller.start()` calls `preventDefault()` unless the view is
  Perform, no dialog/confirm/Settings is visible, and nothing is focused (a focused control is blurred instead).
  ⌘. is unchanged. `beforeunload` is armed in Chrome once audio has run; Electron keeps the recording-only guard
  (its will-prevent-unload dialog is recording-specific).
- Ready: `#ready-text` shows "Loading n/N" (songs whose sampler URLs are in `engine.cache`) → "Ready".
- Copy: controller/recorder warnings go through `plainMessage()` (wake lock → one info toast; AudioContext wording →
  "Audio stopped — click Restart sound"; CC64/CC7/CC11 → pedal/knob names; `engine.*` failures → one plain line).
  `window.__rig.ui = { setBanner, plainMessage, toast }` (test handle).

**Perform.**
- Perform lock also disables the key grid, Major/Minor, drone mode, Follow chords / Continue, transpose, the Space/Vibe
  pickers and Revert. Faders, mute, wheel, Swell, drone Level, Fade out and Panic stay live. Unlock = 600 ms hold.
- Mute writes `songs.<id>.patch.slots.<i>.muted` (first-class); falls back to the gain 0 + `mutedGain` convention
  when the store refuses `muted`. `slotMuteState(slot)` is exported.
- "↺ Revert song": restores `patch, drone, hearIn, playIn, transposeOctave, minor` from a snapshot taken when the song
  was selected (and again when Edit is left, and after `importBackup`). Only differing fields are written.
- Space / Vibe selects apply `SPACE_PRESETS` / `VIBE_PRESETS` through `store.set('songs.<id>.patch.fx.…')`, skipping
  paths `isValidPath()` doesn't know; "Custom" when `matchPreset` finds none.
- Lamps: sustain pedal (polls `engine.pedal` every 150 ms + immediate on MIDI CC64; "Pedal held" after 20 s), drone
  readout from `engine.drone.cfg/key` ("Eb major · −9.1 dB" / "Drone off"; key grid outlined when off), "Faded — play
  to resume" from `engine.getRuntimeState().faded` (covers the idle chord panel; Fade button turns amber).
- Next button: "Next ▶" + "<name> · <key>" / "End of set".

**Measured (test/phase2/ui-core/run.mjs, 25/25).** Contrast: `--faint` #8a93a0 5.73 on panel / 5.26 on panel-2;
LED off #6b7380 3.89 on the top bar; fader track edge #666f7d 3.5; muted fader #707a88 4.09; REC idle dot #c4474a 3.38;
PANIC #ffc9ca on #5a0d10 9.64. All Perform/top-bar hit targets ≥ 44 px (Restart 48). Tap at a fader's end: < 2 %
position change; a 20 % drag = −0.20 ± 0.03; Shift-drag 20 % = 0.05 ± 0.02.

## ui-edit-2 (views/edit.js, views/settings.js, views/_fallback-components.js, styles-edit.css)

- **Dialog flag (ux M1).** `markDialog(token, open)` (exported from `views/_fallback-components.js`) keeps
  `document.body.dataset.dialogOpen = '1'` while any Edit inline confirm (song remove/delete, setlist delete, reset to
  factory) or the Settings modal is open. Edit also has a window capture `keydown` handler: while `#view-edit` is
  visible and Settings is closed, Esc closes the open confirm/panel and is always `preventDefault`ed (never Panic);
  ⌘./Ctrl+. still panics. main.js's `popupOpen()` may use the flag instead of its selector list.
- **Edit section state** is per-viewer UI state in `localStorage['worship-rig.edit.sections']` =
  `{<sectionId>: boolean}` (ids: `notes`, `transpose`, `routing`, `drone`, `library-file`, `slot<i>-more`,
  `slot<i>-inst`, `fx-reverb|delay|chorus|lofi|eq|comp|master`). Everything is closed by default.
- **Instrument list refresh.** Edit re-reads `engine.listInstruments()` on engine `ready`/`instruments`, controller
  `instruments`/`user-samples`, and the window event `rig-instruments-changed` (dispatched by Settings after a
  rescan that reloaded live). Picker groups come from `listInstruments()[i].group`; order is `INSTRUMENT_GROUPS`
  (… Synth Keys, **Brass & Leads**, Mallets & Bells, Guitar & Plucks, Guitar, Bass), unknown groups A–Z, then
  **My Samples** last. `category: 'pluck'` without a group → 'Guitar & Plucks'.
- New strip/master controls (slot Width, Lows/Highs, master EQ, Glue) render only when `params.describe(path)` exists.
- `settings.setlistGap` is navigation state set by the store, **not** a preference, so Settings has no toggle for it;
  Edit's song list shows the gap instead ("Next plays “X”" + a marker row).

## midi-default (app/js/midi.js, controller.js MIDI-input paths, store.js settings, test/phase1/shell/midi-default.test.mjs)

Why: on the Mac the automatic ('first') input picked **GarageBand Virtual Out** (a software port GarageBand registers)
instead of the USB keyboard. The old `isVirtualPortName` regex did not know GarageBand/Logic/MainStage, and with no
match the first enumerated port won. Refines L8 (sticky 'first').

- `classifyInput(input)` / `midi.classify(input)` → `{kind:'hardware'|'virtual', rank}`. Web MIDI gives only id, name,
  manufacturer, so it is a heuristic: **virtual** = name matches virtual|IAC|GarageBand|Logic|MainStage|Network|
  Bluetooth MIDI Connect|loopMIDI|Session N|Through|RtMidi|Bus N, or manufacturer starts with "Apple" (CoreMIDI's
  software ports) → rank 0. **hardware** rank = 1, +1 if name/manufacturer has USB|Keyboard|Piano, +2 for a known
  controller vendor/model (Akai, Arturia, Nektar, Novation, Roland, Yamaha, Korg, M-Audio, Native Instruments, Alesis,
  Casio, Kawai, Nord, Studiologic, Keystation, Launchkey, MPK, Impact, Oxygen, MiniLab, KeyLab, Komplete Kontrol) → 1–4.
  `isVirtualPortName(name)` stays exported (name-only).
- `'first'` (automatic) = highest-ranked connected **hardware** port; ties keep enumeration order; still sticky (L8).
  With no hardware connected it listens to **all** ports and `devices.hint = NO_KEYBOARD_HINT`
  ('No keyboard found — listening to all MIDI ports'); a lone virtual port is never picked silently. Zero ports → no
  hint (main.js's own "No MIDI keyboard found" toast covers it). An explicit `'all'` is not a fallback (no hint).
- Explicit device: `midi.select(id, name?)`. Matched by id, else by exact name (hardware first) → the new id becomes
  the selection and `'rebind' {inputId, previousId, name}` fires; the controller persists `settings.midiInputId`.
  While the chosen device is absent the best hardware port **stands in** (not persisted); with none, all ports + hint.
  When it returns it is used again.
- Hot-plug (`statechange` only; never init/select) that moves the single listening port to a different port emits
  `'switched' {inputId, name, previousId, previousName, standIn}`; the controller warns `Now using <name>` (toast).
  Covers: sticky 'first' keyboard unplugged → other keyboard; fallback → a keyboard plugged in; stand-in ↔ chosen.
- `'devices'` payload: inputs gain `kind`, `rank` (`virtual` kept = kind==='virtual', Settings' "(virtual)" tag);
  plus `mode:'first'|'all'|'device'`, `activeId`, `activeName`, `fallback`, `standIn`, `hint`. `midi.active` getter.
- Store: new setting `midiInputName` (null | non-empty string; default null), device-local (`DEVICE_LOCAL_SETTINGS`).
  The Settings view still writes only `midiInputId`; the controller fills `midiInputName` from `midi.inputs` on every
  `midiInputId` change/start (null for 'first'/'all'). Secondary windows (H2) never write.
- Controller `status.midi` gains `hint`, `fallback`, `standIn`; `name` = the active port's name when there is one.
  The hint is also warned (toast) once each time the fallback begins.
- Tests: `test/phase1/shell/midi-default.test.mjs` (8): classify table; GarageBand Virtual Out + Arturia KeyLab 61 →
  KeyLab (payload kind/rank); rank order + ties; only-virtual → all + hint, keyboard plugged → switched; by-name rebind
  (MidiInput); controller: explicit choice survives id change + restart (beats a higher-ranked piano), 'first' clears
  the name; hot-swap stand-in with `Now using …` toasts and return; 'first' sticky → other keyboard announced.
  `node test/phase1/shell/run.mjs`: unit 9 files, browser, electron all PASS.

## engine-3 (audio.js / fx.js / sampler.js / drone.js / instruments.js / index.js / params.js rows / tools / trims)

Every item has a regression test in test/phase1/engine/suites.mjs: `filterQButterworth`, `slotWidthEq`,
`masterEqGlue`, `fxPresets`, `userManifests`, `padLikeIntensity`. `node test/phase1/engine/run.mjs` gives 53/53 and
0 console errors. All numbers come from seeded offline renders in headless Chromium at 44.1 kHz, except calibration,
which runs at 48 kHz.

**1. Lowpass/highpass Q is in dB: every engine filter is now Butterworth.**
- `fx.BUTTER2_Q` = −3.01 dB and `fx.BUTTER4_Q` = [−5.33, +2.32] dB are exported, also through index.js.
- Fixed filters:
  - reverb-send HPF 180 Hz and LPF 9 kHz
  - delay tone LPF (it sits inside the feedback loop, so a peak there would build up on every repeat)
  - lofi tilt LPF and HPF
  - sampler tone LPF and per-voice velocity LPF (both were Q 0.5 "dB", about +1 dB of resonance)
  - FallbackSynth LPF (0.6)
  - drone bus HPF 80 Hz (0.707)
- `getFrequencyResponse` of the live nodes gives −3.01 dB at fc and a peak of 0.000 dB for every one of them.
- Sampler `tone = 1` with morph 0 now puts the corner at Nyquist, where Chromium's lowpass is an exact bypass
  (0.0000 dB at 10 kHz). This fixes the review nit that `tone 1` was not "open".

**2. Slot width and slot EQ (new PARAMS rows `slots.<i>.width` 0..1.5, default 1; `slots.<i>.eq.low|high` in dB,
−12..+12, default 0; new unit `'dB'`).**
- Strip order: fader → wheel → **width → EQ (low shelf 120 Hz, high shelf 6 kHz)** → pan → dry + sends.
- Width is channel-count agnostic. With M = the speakers down-mix and S⃗ = x − M:
  `out = x + (min(w,1) − 1)·S⃗ + max(w − 1, 0)·HPF₂(150 Hz)(S⃗)`.
  - w ≤ 1 scales the whole side, and 0 gives mono.
  - w > 1 widens only the side above 150 Hz. At 60 Hz the side stays ×0.97, so the lows are never widened.
  - The side HPF is 2-pole on purpose. A 4-pole filter has 180° of phase at fc, so widening would have *cut* the side
    around 150–250 Hz.
  - A mono instrument stays 1-channel (S⃗ = 0), so the StereoPanner keeps its equal-power mono law. Width has no
    effect on it: max |Δ| 0 vs width 1.
- Width 1 and EQ 0 are **bit-exact** to the old strip: max |Δ| = 0 against the same engine rewired wheel → pan.
- Measured on an L-only input (L′, R′ relative to the input):

  | width | 1 kHz | 60 Hz |
  |---|---|---|
  | 0 | .50 / .50 | .50 / .50 |
  | 0.5 | .75 / .25 | .75 / .25 |
  | 1.5 | 1.245 / .25 | .967 / .039 |

  Shelves at +6/−6 dB: +5.97 dB at 30 Hz, +3.00 at 120 Hz, −3.00 at 6 kHz, −5.99 at 16 kHz.
- **Effective width = slot width × the instrument's `widthDefault`**. The default comes from the manifest (item 8)
  and is 1 for everything that isn't a sampler. The slot param therefore stays "1 = as shipped". `strip.width` holds
  the effective value.
- **Pushback: width alone cannot bring Salamander C5 under 3 dB of mono loss at width 0.7.**
  - With side gain w, the loss is 10·log10(1 + w²·S²/M²). The C5 file (v9) has S²/M² ≈ 5.2.
  - Measured: w 1 → **7.89 dB**, 0.7 → **5.47**, 0.4 → 2.61, 0 → 0. The loss only drops below 3 dB at w ≲ 0.43.
  - What does fix it is a decode-time, per-file limiter. It is opt-in per instrument with the manifest field
    **`maxMonoLossDb`**, and salamander-piano is set to 3.
    - `processSample` measures M² and S² per file. If the loss is over the cap, it scales S down to exactly the
      cap and raises M so that M² + S² (the stereo RMS) is unchanged. Loudness in stereo stays the same, and the note
      no longer leaves a hole on a mono PA.
    - It is baked into the cached buffer, so it costs nothing at note time. `buffer._monoFix` records the change.
      C5: loss 8.06 dB, mid ×1.79, side ×0.77.
  - Result on the real C5 file:
    - width 1 → **2.90 dB**
    - width 0.7 → **1.66 dB**
    - shipped (slot 1 × widthDefault 0.8) → 2.06 dB
    - stereo level −30.04 → −29.97 dB
  - Files already under 3 dB are untouched (most Salamander notes are 0.6–2.5 dB). The mechanism is exported as
    `limitMonoLoss(L, R, capDb)`.
  - `BufferCache.acquire(url, ctx, midi, owner, opts)` and `preload()` pass the def's `decodeOpts`.
- `engine.getParam('slots.i.eq.low')` returns the value, or 0 when unset. normalizePatch fills `width` and
  `eq {low, high}`.

**3. Master EQ and glue compressor (PARAMS `fx.eq.low|mid|high` in dB, −12..+12; `fx.comp.amount` 0..1, default
0).**
- Chain: sum → lofi → **EQ (low shelf 100 Hz, peaking 1 kHz Q .8, high shelf 8 kHz) → glue** → master gain →
  masterWheel → fade → [stereo | mono] → catcher → clip.
- The EQ nodes are always in the path. At 0 dB they are identity biquads. Measured at +6/−4/+3 dB: +5.94 dB at 30 Hz,
  −4.00 at 1 kHz, +2.97 at 16 kHz.
- **Glue settings.** For amount a: threshold −24·a dB, ratio 1 + 3a, knee 6, attack 10 ms, release 250 ms.
- **Glue bypass.**
  - `amount 0` is a true bypass. The compressor is disconnected after a 30 ms crossfade back to the dry path
    (`fx.glueDry`), so it is never in the graph.
  - Engaging it crossfades dry → compressed (30 ms, linear) after the compressor's lookahead (256 + 128 frames), the
    same approach as the lofi engage.
  - Measured:
    - amount 0 vs an engine built with `{glue: false}`: max |Δ| **1.2e-6** (float noise, the same as lofi).
    - After engaging at 0.6 s and bypassing at 1.2 s, the output from 1.3 s on matches never-engaged to 8.3e-7, and
      the compressor is detached.
    - 0 clicks at either switch.
- **Glue makeup.**
  - `measureGlueRef()` (once per page, an 11-channel 0.8 s offline render) measures the compressor's total gain on the
    reference tone for a = 0, .1, …, 1: `[0, .07, .45, 1.23, 2.23, 3.33, 4.51, 5.75, 7.02, 8.12, 8.44]` dB.
    That is Chromium's automatic makeup minus the knee reduction.
  - The reference tone is a 1 kHz sine at amplitude .1 (−23.01 dBFS RMS), the same one used for the catcher-makeup
    test.
  - The inverse is applied on `fx.glueWet`, interpolated in dB. The reference tone comes out at **−23.011 / −23.010 /
    −23.028 dBFS** at a = 1 / .5 / .35.
- **Pushback: the glue does not lower the crest factor.** The spec asked for "amount 1 reduces the crest factor of a
  piano chord". Measured on real Salamander chords C3 C4 E4 G4 C5, played loud/soft/loud/soft (vel 110/45/100/40):

  | amount | sample-peak crest | loudness range (50 ms RMS, P95−P10) | loud−soft chord gap | RMS |
  |---|---|---|---|---|
  | 0 | 13.04 dB | 19.2 dB | 8.0 dB | −13.9 dB |
  | 1 | **14.72 dB** | **9.0 dB** | **4.1 dB** | −23.5 dB |

  The sample-peak crest goes **up**. The 10 ms attack lets each hammer transient through while the body is compressed.
  What the glue does reduce is the dynamic range, and that is what the test asserts: loudness range −5 dB or more, and
  loud/soft gap −3 dB or more.
- **For the product owner: the gain reduction is heavy.** The makeup is anchored at −23 dBFS, and a calibrated mix at
  the sum sits around −18…−11 dBFS. Amount 1 therefore takes 5–10 dB off normal playing: the loud chords above drop
  about 10 dB. If amount 1 should sound "glued" rather than "turned down", anchor the makeup nearer −16 dBFS or lower
  the threshold range. That is a one-constant change: `GLUE.refAmp`.
- **Latency.** While the glue is engaged, the output is delayed by its lookahead of about 5.8 ms, on top of the
  catcher's 6.0 ms.
- Constructor option `new AudioEngine({glue:false})` builds no compressor (tests). New exports: `measureGlueRef`,
  `glueSettings`, `GLUE`.

**4. FX presets (app/js/shared/fx-presets.js). No engine change was needed.**
- Every path in SPACE, ECHO and VIBE is a valid §4 address with an in-range value.
- Every preset applies through `engine.setParam` and reads back: `matchPreset` at 1e-9 finds it.
- RT60 (Schroeder T20 × 3, impulse into the reverb after the IR swap): room **1.32 s**, stage **3.26 s**, cathedral
  **6.99 s**.
- 'dotted' at 120 bpm: the ping-pong echoes land at **375.06 / 750.14 / 1125.22 / 1500.29 ms** (L R L R), latency
  corrected. The ≈ 0.07 ms per pass is the tone LPF's group delay.
- **Delay timing bug found and fixed.**
  - Chromium renders a DelayNode feedback cycle **one render quantum (128 frames = 2.9 ms) late per pass**.
  - With the old crossing dL/dR loops, the extra quantum fell on only *some* edges. Plain mode drifted 2.9 ms per
    repeat (echo 4 at 1508.8 ms). In ping-pong, R2 was late while L3 was 2.9 ms early.
  - A DelayLine is now one stereo DelayNode in one cycle (d → tone LPF → split → 4 feedback gains → merge → d) with
    `delayTime = time − Q`, behind a fixed Q (128-frame) pre-delay. Echo 1 lands at Q + (time − Q), and every later
    pass at (time − Q) + Q.
  - The line has 17 nodes (was 15). The external API (`time`, `setFeedback`, `setPingpong`, `setTone`, `glideTime`)
    is unchanged. `lpL`/`lpR`/`dL`/`dR` are now `lp`/`d`.

**5. My Samples (secondary manifests).**
- New option `manifestUrls` (array: factory first, then optional ones). The default is
  `DEFAULT_MANIFEST_URLS = ['./samples/manifest.json', './api/user-samples/manifest.json']`, resolved against the app
  root. A lone `manifestUrl` (used by the tests) still means just that one.
- **A failed fetch always logs a console error.** Verified headless: `fetch()` GET and HEAD of a 404 both log
  "Failed to load resource … 404". So a manifest under `/api/` is requested only when that server's `/api/health`
  says `userSamples: true` (or `features` includes `'user-samples'`). shell-3's server.js does exactly that.
  - No flag, or no health route: no request is made, and the test checks this with `performance` resource entries.
  - A 404 or error on an allowed manifest is silent (`console.info`).
- Secondary entries:
  - Ids are `user:<id>`, so a user `test-keys` coexists with the factory one.
  - The group is `'My Samples'` unless the entry has its own `group`.
  - Layer dirs resolve against that manifest's final URL, so server-rewritten absolute dirs work.
  - `release` defaults to **0.15** (τ), `widthDefault` is honoured, and `gainTrim` is dB as usual.
- New `engine.reloadManifests()` → `listInstruments()`. It re-reads the health flag and the optional manifests,
  replaces the `user:` entries (instances already built keep playing), and emits `'instruments' {count}`. The factory
  manifest is not re-fetched because it is static in the app bundle.
- tools/lib/render-page.js passes `manifestUrls: ['./samples/manifest.json']`, so calibration and audition never see
  user packs.

**6. macro.intensity pad list.** `PAD_LIKE` is now keyed `type:id`: warm-pad, glass-pad, strings, **supersaw-pad,
juno-pad, shimmer-pad** and **organ:soft-pad**. For organ soft-pad, morph ≥ .5 switches the rotary to its other
speed (instruments M2). Test: all five get morph 0.6 at wheel 0.6, and bell gets 0.

**7. Calibration tooling (tools/calibrate.mjs).**
- **Pre-roll.** Notes start 0.5 s after the commit (`--pre-roll`), and the window moves with them.
- **calibWindow.** A patch's `calibWindow` is honoured: `registry.list()` now passes `calibWindow` through, and so
  does render-page, which also passes `module` and `widthDefault`.
- **synth-extra.** synth-extra patches are measured and reported but never trimmed, and their gain-trims entries are
  written as 0.
- **Drone.** `droneTrim` is measured and written only with `--drone`.
- **--only.** `--only` accepts `id` or `type:id`.
- **Report.** `audition/calibration.json` is written only with `--write-report`.
- Full run: 4 passes + verify, every instrument within ±0.1 dB of −18 (marimba −17.9). The drone was re-measured on
  purpose with `--drone --only none`. It read −27.8 dB, 3.8 dB under target, after the instruments/drone HPF changes.
  `droneTrim` went from −12.3 to **−8.5**. That restores the level the P3 preset drone gains were tuned against.

| instrument | before (old trim) | old trim | new trim | after | peak |
|---|---|---|---|---|---|
| salamander-piano | −18.7 | 8.3 | **9.3** | −18.0 | −1.4 |
| upright-piano | −17.4 | 8.4 | 7.3 | −18.0 | −1.7 |
| bright-piano | −17.5 | 2.8 | 2.2 | −18.0 | −2.2 |
| honky-tonk | −17.4 | 10.2 | 9.1 | −18.0 | −1.3 |
| harpsichord | −17.6 | 4.0 | 3.6 | −18.0 | −2.1 |
| ep-rhodes | −18.7 | −3.9 | −3.2 | −18.0 | −3.4 |
| ep-wurli | −18.6 | 0.2 | 0.8 | −18.0 | −2.4 |
| electric-grand | −17.5 | 3.3 | 2.8 | −18.0 | −1.9 |
| clavinet | −17.5 | 6.5 | 5.7 | −18.0 | −1.7 |
| vibes | −18.3 | 7.4 | 7.8 | −18.0 | −1.5 |
| celesta | −18.5 | 5.6 | 6.1 | −18.0 | −1.8 |
| music-box | −17.8 | 15.6 | 15.3 | −18.0 | −0.9 |
| marimba | −17.2 | 10.4 | 8.7 | −17.9 | −1.8 |
| xylophone | −17.5 | 4.0 | 3.4 | −18.0 | −2.2 |
| glockenspiel | −17.7 | 14.4 | 14.0 | −18.0 | −0.9 |
| tubular-bells | −17.5 | 1.7 | 1.2 | −18.0 | −2.1 |
| steel-drums | −17.5 | 9.1 | 8.1 | −18.0 | −1.6 |
| nylon-guitar | −18.2 | 2.8 | 3.1 | −18.0 | −1.6 |
| steel-guitar | −17.4 | 6.9 | 6.1 | −18.0 | −1.9 |
| clean-guitar | −17.8 | 4.7 | 4.5 | −18.0 | −2.0 |
| harp | −17.5 | 8.3 | 7.6 | −18.0 | −1.7 |
| dulcimer | −17.5 | 11.7 | 10.9 | −18.0 | −1.2 |
| kalimba | −17.7 | 24.4 | 23.6 | −18.0 | −0.6 |
| synth warm-pad | −21.7 | −0.2 | **3.5** | −18.0 | −3.3 |
| synth glass-pad | −21.6 | −0.3 | **3.3** | −18.0 | −6.8 |
| synth strings | −21.5 | −0.1 | **3.4** | −18.0 | −2.7 |
| synth sub-bass (C2) | −19.3 | 4.5 | 5.8 | −18.0 | −14.8 |
| synth soft-keys | −18.7 | 0.6 | 1.3 | −18.0 | −7.7 |
| synth bell | −18.7 | 2.1 | 2.8 | −18.0 | −4.7 |
| synth-extra ×10 | −17.8…−18.3 | 0 | 0 (not trimmed) | same | −2.3…−10.5 |
| organ gospel | −19.2 | 3.2 | 4.4 | −18.0 | −6.6 |
| organ soft-pad | −19.8 | 1.8 | 3.6 | −18.0 | −7.5 |
| organ full | −20.8 | −0.5 | 2.3 | −18.0 | −5.1 |
| organ church | −19.0 | 5.1 | 6.1 | −18.0 | −4.7 |
| drone (key C, gain 1) | −27.8 | −12.3 | **−8.5** | −24.0 | −10.1 |

- The synth pads moved +3.4…+3.7 dB. That is the instruments-fixes Butterworth pair and the H3 changes (−2.3…−2.5 dB),
  plus about 1 dB that also shows up in their `--dry` note.
- The samplers moved −1.7…+1.0 dB. I did not measure the causes separately. The likely mix:
  - The pre-roll pulls decaying sounds down: the old method trimmed them hot.
  - The now-flat velocity LPF of single-layer sets needs a few tenths more: ep-rhodes, wurli, vibes, celesta and nylon
    went up.
  - Salamander went +1.0 dB: its 0.8 width lowers stereo RMS. The mono fix keeps stereo RMS.
- synth-extra reads −17.8…−18.3 through the engine with the pre-roll, pluck included (0–1 s window). That confirms their
  internal calibration and the pre-roll diagnosis.

**8. Sampler manifest fields.**
- `release` is τ. It defaults to 0.12 in the factory manifest (SPEC §3.5) and **0.15 in secondary manifests**. A
  non-positive or missing value falls back to the default.
- New optional `widthDefault` (0..1.5, clamped). It becomes `inst.widthDefault` and is also passed through `list()`
  (only when ≠ 1).
- New optional `maxMonoLossDb` (see #2).
- app/samples/manifest.json: salamander-piano has `widthDefault: 0.8` and `maxMonoLossDb: 3`. Everything else in the
  file is unchanged apart from the recalibrated `gainTrim` values.

**Audition** (`node tools/audition.mjs`, 19 songs and 43 instruments):
**62 clips: 60 PASS, 0 WARN, 2 FAIL**, 190.8 MB.
- The 8 new factory songs are anthem, gospel-stab-b3, upright-pad, clav-funk, music-box-lullaby, dream-juno,
  80s-ballad and synthwave. They all PASS: RMS −17.8…−23.3 dBFS, peak ≤ −1.42 dBFS, mono-sum loss ≤ 2.18 dB.
- Salamander mono-sum loss, then → now:

  | clip | then (dB) | now (dB) |
  |---|---|---|
  | grand-piano | 3.06 FAIL | **1.68** |
  | felt-piano | 3.18 FAIL | **1.83** |
  | dusty-piano | 3.49 FAIL | **1.65** |
  | sampler-salamander-piano | 2.88 | **1.51** |

- The two FAILs are not engine causes. **synth-dx-epiano** measures −26.6 dBFS and **synth-pluck** −27.3 dBFS, both
  under the −26 floor. They play at slot gain 0.8, with Keys sends, at the −6 dB master.
  - Both are synth-extra patches, and their internal calibration is confirmed at −18.2/−18.3 through the engine.
  - Their fast, keytracked decays lose more level in the right-hand C4–C5 register than in calibration's
    C3-E3-G3, so in the progression they sit about 1–2 dB under the other decaying patches (soft-keys −24.9,
    bell −25.6).
  - pluck is already judged over its calibWindow of each chord; see Tools below.
  - **For synth-extra:** raise their internal gainTrim by about +1.5 dB (dx-epiano) and +2 dB (pluck), or accept them
    as "decays fast".
- Soft layer-balance notes for presets (none is under −15 dB): gospel-stab-b3 poly-stab −12.6 dB, synthwave
  square-lead −13.5 dB, clav-funk ep-wurli −10.2 dB under the mix.
- Tools:
  - tools/lib/server.mjs sends `connection: close` and has no keep-alive/header/request timeouts. A render keeps the page
    busy for minutes, and a reused idle socket got Node's 408 and a reset. In the first full run, organ-swell logged
    "gain-trims.json unavailable (HTTP 408)".
  - The registry's JSON fetches (manifests, gain-trims) now retry twice (0.3/0.6 s) on a network error or
    408/429/5xx, so a single reset socket no longer leaves every instrument untrimmed for a session.
  - audition.mjs judges an instrument that has a `calibWindow` over that window of each chord, and skips its drop-out
    check.
  - The size budget is now 300 MB.

**For other owners.**
- **UI:**
  - New rows to surface: `slots.<i>.width` (formatValue gives "80%"), `slots.<i>.eq.low|high`, `fx.eq.low|mid|high`
    and `fx.comp.amount`.
  - The new unit `'dB'` is formatted as "+3.0 dB". Its value is the dB number itself, not a fader taper.
  - Width is relative to the instrument's own default, so 100% means "as shipped".
- **UI/controller:** re-list instruments on the engine's `'instruments'` event, or after
  `controller.rescanUserSamples()` resolves with `reloaded: true`.
- **samples:**
  - Other stereo multi-sample sets may have anti-phase files too. Only Salamander was measured. `maxMonoLossDb: 3` is
    the one-line opt-in.
  - S1–S3 (MusyngKite level/DC/dead keys) are outside this change.
- **presets/product:** the glue gain reduction at amount 1 is heavy (see #3). The drone is back at its calibrated
  level (`droneTrim` −8.5), so the P3 drone gains sound as they did when they were tuned.

## round2-ui (reviews/round2-ui.md; index.html / styles.css / main.js / views/** / components/**)

Tests: `node test/phase2/ui-core/run.mjs` 33/33 (8 new `round2-ui #n` tests), `node test/phase2/ui-edit/run.mjs`
94/94 (3 new per mode). Each new test was also run against a copy with the fix reverted and fails there.

**Component interface additions (backwards compatible).**
- `fader()` / `knob()` (ui-core and fallback): `cancelDrag()` abandons a pointer drag: the pending rAF write is
  dropped, later movement of that pointer is ignored until it goes up, and the fader shows the value `set()` gave it
  during the drag. ui-core faders also expose `dragging`. At drag end a stashed `set()` value is now applied when the
  drag had nothing left to write (#2b: the fader used to keep showing the dragged level).
- `relativeDrag()` returns `cancel()` as well as `active`. `rafCoalesce().flush()` returns true when it ran a call.
- `setlistStrip.set({ gap })`: the store's setlist-gap index (`store.neighbors().gap`). While it is set, no chip is
  current (the `findIndex(currentId)` fallback is skipped, so a reprise of the removed song is no longer highlighted),
  the item at `gap` gets `.gap-before` (`.gap-after` on the last item when the gap is at the end), a dashed `--warn`
  marker, and the strip gets `data-gap`.
- `meter()` runs its rAF loop only while an IntersectionObserver reports it on screen; `running` getter (test hook).

**Behaviour.**
- #1 Settings focus. `settings.close()` no longer restores focus when `ctx.closeSettings` exists (i.e. under main.js
  or the ui-edit fixture); main.js decides. main.js records at open whether the opener was `:focus-visible`: keyboard
  openers get focus back, pointer users get nothing focused (Space = sustain, arrows = songs, one-press Esc Panic).
- #2 Perform (slot faders, drone Level), main.js (Master) and Edit (every fader/knob) call `cancelDrag()` when the
  shown song id changes.
- #3 Edit song-bound text fields (name, notes, tempo, key-range note fields) write `songs.<id>.…` with the id
  captured on focus, not the `song.*` alias. Before switching, `showSong()` flushes pending notes and blurs a focused
  song field (its `change` commits to the old id), so the field then shows the new song.
- #5 Lock button: the Enter/Space key that started a keyboard hold owns the button until keyup; its auto-repeats are
  `preventDefault`ed, so they no longer re-lock after the unlock (was: unlocked at 645 ms, re-locked at 1229 ms).
- #6 Perform re-reads instrument names on engine `ready`/`instruments`, controller `ready`/`instruments`/
  `user-samples` and window `rig-instruments-changed` (Edit's list).
- #7 edit.js imports `CATEGORY_LABELS` from presets.js (factory browser heading "Synth"). Its `INSTRUMENT_GROUPS`
  stays local: its order intentionally differs (it has "Guitar & Plucks", see ui-edit-2).
- #8 Perform's Revert snapshot is taken on controller `'songSelected'` (a commit), on leaving Edit, on
  `importBackup`, and on controller `'instance'` → primary (after `store.reload()`), no longer on every store
  `currentSongId` change. Revert is disabled while the snapshot belongs to another song. `SAVED_FIELDS` gains
  `tempo` (same fields as `controller.revertSong()`). The local copy is kept on purpose: its baseline moves when Edit
  is left, `controller.revertSong()`'s does not.
- #9 main.js `popupOpen()` drops the Edit-only selectors (unreachable: Esc returns early outside Perform). It
  deliberately does not read `body.dataset.dialogOpen`: an Edit confirm left open in the hidden view would keep the
  flag up and disarm Esc = Panic in Perform. `markDialog` stays as an observable flag (ui-edit tests use it). Perform's
  `mutedGain` write fallback is gone (shell fixes §1); `slotMuteState` still reads old data.
- #10 Perform's 150 ms runtime poll skips while `#view-perform` is hidden. Measured: analyser reads per frame 1.00 in
  Perform (was 2.00, the hidden Edit meter), 2.00 in Edit; runtime polls in 800 ms of Edit: 0 (Perform: 5–6).
- #11 `#view-settings` loses `role`/`aria-modal`/`aria-label` once `mountSettings` succeeds (they stay for the
  placeholder), so screen readers see one modal dialog.
- #12 Perform's focusable notes panel handles ↑/↓/PageUp/PageDown/Home/End itself (scroll + `preventDefault` +
  `stopPropagation`), so they no longer reach the controller (↑/↓ nudged the mod wheel: 1 → 0.8 before the fix).

## round2-engine (reviews/round2-engine.md M1–M3, m1–m5; sampler.js / instruments.js / audio.js / fx.js / tools/audition.mjs)

Regression tests: test/phase1/engine/suites.mjs `undampedOptIn`, `washAcrossCommit`, `glueEngageNoDip`,
`userManifestGuards` (offline) and `washSurvivesRestart` (realtime). Each one fails against the pre-fix code (numbers
below) and passes now. Engine 58/58, instruments 143/143, synth-extra 153/153, unit 239/239.

**M1. Undamped top keys are opt-in per manifest entry.** New manifest field **`undampedFrom`** (MIDI note; notes at or
above it ignore note-off; `null`/`false` = off). If the field is absent, factory entries with `category: 'piano'` get
90 (`PIANO_UNDAMPED_FROM`), and everything else gets `null`: other categories, and **every** secondary (`user:`)
entry. So a sustaining My Samples pack (strings, choir, pad, organ) is damped on every key. `def.undampedFrom` is on
the normalized def. `normalizeManifest(..., {secondary})` defaults to `!!idPrefix`.
- Level from 0.6 s to 0.9 s after note-off, relative to the held level. The G6 note is sustained (−6 dB/s), and the
  note-off comes at 1.0 s.
  - factory piano: −5.3 dB (undamped, unchanged)
  - factory strings, user piano, user strings: **−54.8 dB**. They were −5.3 dB.
  - user entry with `undampedFrom: 90`: −5.3 dB
- Factory behaviour changes only for non-piano factory entries at MIDI ≥ 90 (ep, mallets, guitars, harp, dulcimer,
  kalimba). They are now damped there.

**M2. The macro.wash reverb size survives a song switch and restart().**
- `prepare()` stages the *effective* size: `lerp(size, .9, wash)`, computed under the new song's routing with the
  current wheels. commit therefore lands on the washed IR directly, with no second crossfade.
- `_applyWheels` now compares the wanted IR key with `reverb.targetKey` (the key the reverb is at or heading to, which
  `commitTo` and `request` set), not with the removed `_lastWashBucket`.
- `commitTo(stage)` also bumps the request sequence, so a wash request still in its 300 ms debounce from the previous
  song cannot land after the commit.
- The engine start builds its first IR at the effective size.
- Wheel on macro.wash at 1: song A (size .3), then song B (size .5):

  | check | after the fix | before the fix |
  |---|---|---|
  | staged | 8\|0.5 | 5\|0.5 |
  | active after the commit | 8\|0.5 | 5\|0.5 |
  | after the wheel moves to .99 | 8\|0.5 | 5\|0.5 |
  | realtime restart() | 8\|0.5 | 2.8\|0.5 |
  | switch after the restart | 8\|0.5 | 5\|0.5 |

**M3. The glue engages without a level dip.**
- `fx.glueDelay` = `GLUE_ENGAGE_DELAY` = **0.3 s** between connecting the compressor and the dry→wet crossfade. It was
  384 frames. The detector settles first, including one that went stale while it was detached.
- Test: 1 kHz reference tone at −23.01 dBFS, amount 1 engaged at 2.5 s, 50 ms windows from 2.5 to 3.2 s:
  - fresh engage: min −3.26 dB before the fix, **0.00** now
  - after an earlier hot engage and a bypass: −4.09 dB before, **0.00** now
- The longer pre-roll exposed a latent bug. An amount change *before* the crossfade (the "busy" branch) ramped the wet
  in while the dry path was still at 1, a **+4.75 dB** bump (measured with the delay alone). The wet now keeps its
  crossfade start (`linFrom(..., X.t0, X.dur)`), and the 'retarget' case measures 0.00 dB.
- Behaviour: the first 0.3 s after the glue engages is uncompressed. masterEqGlue's dynamics chords now start 0.4 s
  after the commit, and their numbers are unchanged: loudness range 18.4 → 8.9 dB, loud/soft gap 7.3 → 4.1 dB.

**m1. A failed My Samples reload keeps the user instruments.**
- `_fetchManifest` distinguishes "not served" from "failed":
  - not served (returns `null`): health flag off, 404/410, or an empty list
  - failed (returns `{failed, error}`): network error, 5xx/408/429, or unreadable JSON. The health check itself
    failing (network, 5xx) counts as failed too.
- `reloadSecondary()` keeps the previous `user:` defs on failure, warns "My Samples reload failed (…); keeping the N
  instrument(s) already loaded", and returns N.
- `_optionalAllowed()` still returns a boolean, because the shell test calls it. The new tri-state is
  `_optionalStatus()`.
- Measured, with a synthetic 503 and with health unreachable: `user:harp,user:test-keys` stays loaded in both cases.
  Preparing `user:test-keys` afterwards builds the sampler, not the fallback. Before the fix the list was empty and
  the slot got the fallback synth. The health flag turned off still removes the user entries.

**m2. A successful reload refreshes the sample cache for user URLs.**
- New method `BufferCache.invalidate(urls)`. It clears the failure marks and drops unreferenced decoded buffers.
  Referenced buffers keep playing, and pins are untouched.
- `reloadSecondary()` calls it with every old and new user sample URL.
- Test: the user failure mark and the unreferenced user buffer are cleared, the referenced user buffer is kept, and
  the factory mark and buffer are kept.

**m3. Clamping.** `release` is clamped to `RELEASE_RANGE` [0.02, 1.5] (the param range) and `gainTrim` to ±30 dB
(`GAIN_TRIM_MAX_DB`), for every manifest. Secondary manifests warn when a value is clamped. Test: `release: 3,
gainTrim: 40` gives release 1.5 (the param default is 1.5 too), 30 dB, and 2 warnings. No factory value is affected
(maximum release 1.2, maximum trim 23.6).

**m4. Instruments steal test.** The `preDiff` tolerance goes from 1e-4 to 1e-3 (−60 dB), and the detail line now
prints the pre-steal Δ. This run measured 1.1e-4 on soft-keys, which would have failed under the old tolerance. An
early fade or kill shows up at ≥ 1e-2.

**m5. Audition floor for instrument clips.**
- The floor is now the clip's nominal level minus 2 dB: `CAL_TARGET_DB` (−18) + slot gain + master volume, never above
  −26. The Keys role gives **−27.9**, and `metrics.rmsLo` is reported per clip.
- `node tools/audition.mjs --only synth-dx-epiano,synth-pluck,synth-soft-keys`: dx-epiano −26.6 and pluck −27.3 now
  PASS. They FAILed at −26. Their synth-extra `gainTrim`s are unchanged, as the review advises. The optional +1 dB on
  dx was not done, because it needs a listening check.

Not done: the review's "not reproduced" restart/commit race, which was dropped as unreproducible.

**Requests for other owners.**
- **samples (app/samples/manifest.json):**
  - harpsichord is `category: 'piano'`, so it keeps the undamped top keys by default. A real harpsichord damps every
    key, so please add `"undampedFrom": null` to it.
  - harp and dulcimer can opt in with `"undampedFrom": 90` if they should ring past note-off at the top.
- **shell/controller:** a failed `engine.reloadManifests()` now resolves with the *old* list and emits a `'warn'`
  plus `'instruments' {count: old}`. It does not reject. `rescanUserSamples()` may want to show that warning rather
  than reporting a clean reload.
- **tools/import-garageband.mjs:** user packs are damped on every key by default. A piano import can write
  `"undampedFrom": 90` into its manifest entry.

## round2-shell (reviews/round2-shell.md; server.js / store.js / controller.js / shell tests)

Tests: `node test/phase1/shell/run.mjs` gives unit 130/130, browser 12/12, Electron 14/14. The new file is
`test/phase1/shell/round2.test.mjs` (8 tests). Each new test except the store-only #2 test was run against a copy with
its fix reverted and fails there (7/8 fail; the store test needs the new store field).

- **#1 realpath bypass through `x.wav/index.html`.** `/user-samples/…` and `/pads/…` now serve the file's **realpath**
  (no check/open gap) and require it to be a regular file. `sendFile(…, {dirIndex, typePath})`: `dirIndex:false` on
  those two routes, so only the app route resolves a directory's `index.html`. The Content-Type follows the requested
  name (`typePath`), so an in-pack link to an extensionless blob is still `audio/wav`. Measured: the review's
  `evil.wav → ~/secret` and pads `C.wav/index.html` cases were 200 "SECRET"; now 404. A non-link `plain.wav/index.html`
  is 404 too.
- **#5 manifest forms.** A pack `manifest.json` may also be the object map `{instruments:{id:{…}}}` (the
  `app/samples/manifest.json` form that `normalizeManifest` accepts). A manifest with no instrument list adds an
  `errors` entry ("no instrument list"); an empty list adds "the instrument list is empty". Measured: `mapform` was
  `count:0, errors:[]`, now `count:1`.
- **#6 out-of-root pack links.** Still skipped (a pack link to `/` would otherwise let `/user-samples` serve any audio
  file on disk), but now reported: `errors` gets "`<root>/<slug>`: is a link to a folder outside My Samples (…);
  skipped. Move the folder here instead." shell3's assertion that this was silent was updated.
- **#2 pristine library backups (M5).** New persisted field `meta.edited`: `false` is written only when
  `seedFactory()` seeds an empty library; the first change to songs, setlists, the orders or a non-navigation,
  non-device-local setting sets it `true` (it is bookkeeping: persisted with that change, **not** in `changedPaths`).
  Absent (every library from before this change) counts as edited. `importJSON({replace:true})` sets it `true`.
  New getters: `store.pristine` (`meta.edited === false`). The controller's `backupNow()` returns `null` and
  `__rigShell.library()` returns `null` while pristine, so neither the scheduled nor the close backup writes an
  untouched fallback-port seed, and it can no longer become the "newer library from :8439" offer. Settings' manual
  "Back up now" is unchanged (no origin prefix, never offered). `controller.test` and `fixes.test` M5 now edit the
  library before expecting a backup.
- **#3 revert snapshot vs import.** New `store.generation`: incremented before the notify whenever the whole library
  is replaced (`importJSON` replace, `reload()`). The controller's store subscription re-snapshots `selected` (the
  `revertSong()` baseline) from the store when it changes, or clears it if the song is gone. Measured (review E1):
  after an import setting gain .123 / tempo 111, `revertSong()` returned true and wrote back .8 / null; now false.
- **#4 snapshot at commit.** `selected`, `songSelected.patchSnapshot` and `songSnapshot` are the song as committed
  (`store.getSong(id)` after commit + `catchUp`), not as requested. Measured (review E2): a fader moved to .31 during
  the prepare was snapshotted as .7; now .31, and Revert no longer undoes it.
- **#10.** A double refusal when nothing is applied yet leaves `status.songId` on the requested song (the store keeps
  it selected), with `loading:false`. Was `null`.
- Not changed: #7 (docs `openPath` fallback: macOS-only, not testable here), #8 (preset gains: need an audition
  re-run), #9 (Clav Funk "Custom" space: deliberate in shell-3).

## integration-2 (test/integration/build-lint.mjs / test/README.md / README.md)

Full `node test/run-all.mjs --soak-minutes 10` after all round-2 fixers: 10/11 PASS on the first run; build-lint
failed once and passed on re-run (details below). No app code changed.

- **build-lint flake: exit 5.** The packaged app printed a good self-test report (timeout as expected, correct URL,
  zero console errors), but the process exit code was 5, not 2. 5 is not an app code: it is `xvfb-run`'s own
  "problem while cleaning up temporary directory" (`rm -r` of its `/tmp/xvfb-run.*` failed after the app exited).
  Re-run: 26/26; 5 direct boots of the kept packaged binary: 5/5 exit 2. Classified as an environment flake. The
  check's detail now includes the `xvfb-run`/`rm:` stderr lines whenever the exit code isn't 2, so the next one
  explains itself.
  That path in `xvfb-run` exits before it kills its Xvfb, which leaked (an orphan `Xvfb :99` from 04:20 was
  found and stopped). build-lint now sends SIGTERM to the boot's process group after it closes.
- **build-lint in a fresh clone.** Electron 44's npm package has no postinstall; `node_modules/electron/dist` is
  only fetched on the first `require('electron')` (or `npx electron`). build-lint passed that path to
  electron-builder as `electronDist` without triggering the fetch, so `--only build-lint` on a fresh `npm ci` would
  fail. It now `require`s the package first (a no-op when the binary is present).
- **Docs.** test/README.md: the "Electron self-test can't see 404s" caveat is replaced by what main.js does since
  shell-3 #3 (`webRequest.onCompleted`, `httpErrors`). Node minimum in README.md and test/README.md is 22.12
  (Electron 44's `engines`), not 20; test/README notes the lazy Electron download.
- **Fresh-clone check.** Repo copied without `node_modules`, `dist`, `audition/*.wav`, `test/logs`, screenshots and
  `user-samples`; `npm ci` then `npm test -- --fast` and an `npm start` smoke under xvfb. Results in STATUS.md.

## morning-prep (controller.js / engine audio.js + sampler.js / presets.js / views/settings.js 1 line / soak / tests)

Tests: `node test/phase1/shell/run.mjs` gives unit 140/140, browser 12/12, Electron 14/14 (new file
`test/phase1/shell/memory.test.mjs`, 9 tests, all 9 fail against the previous controller; a presets test).
`node test/phase1/engine/run.mjs` 59/59 (new `offline.pinsLimitedEvict`). ui-edit 94/94 (its Settings diagnostics
regex allows the new text).

**1. Decoded-sample memory policy (integration-2 round 2 #3).** Before: `preloadSetlist()` pinned
`store.navIds()` with `{pin:'replace'}`. Note that the seeded library selects **"My Set", which holds all 19
factory songs**, so the soak's 1023.6 MB was that whole-setlist pin. It did not come from a library fallback. The
controller now decides what stays pinned:
- **No setlist, or an empty one:** only the current song and its library neighbours are pinned (≤ 3 songs,
  `LIBRARY_PIN_RADIUS = 1`), both at start and after every switch. This deviates from the requested `{pin:'add'}`
  and uses `{pin:'replace'}` on that window. With `'add'`, every song visited stays pinned (a walk through the library
  pins all of it again, which is the same 1 GB), and the ≤ 3-song cap can't hold without an unpin, which is what
  replace does.
- **Setlist whose decoded size is ≤ `PIN_BUDGET_MB` (600):** pinned whole with `{pin:'replace'}`, as before.
  Neighbours still use `{pin:'add'}` (engine-core #10). The size comes from the new `engine.estimatePreloadMB()`
  before preloading. It is re-checked with exact sizes after the preload; if it is then over budget, the set
  downgrades to the large-set policy.
- **Larger setlist:** the current song ±2 is pinned (`LARGE_SET_PIN_RADIUS`, `{pin:'replace'}`). The window moves
  with every switch. The rest of the set is warmed with `{pin:'none'}`, nearest first, until the estimate reaches 80 %
  of the cache cap, so the LRU doesn't throw away what was just warmed.
  - `status.memory.note = 'Large set: loading songs as you go'` (`LARGE_SET_NOTE`).
  - A `'memory'` event `{mode, note, setMB}` fires once when a set enters this mode.
- An engine without `estimatePreloadMB` keeps the old behaviour (the setlist is pinned whole).
- Stale pins: `engine.preload` re-applies its pins after decoding. So an older replace that finishes after a newer
  one (for example a slow neighbour window after the whole-set pin) would win. The controller now re-applies the
  newest replace set when that happens.
- **`status.memory`** = `{mode: 'library'|'setlist'|'large-set'|null, decodedMB, pinnedMB, capMB, setMB, note}`.
  It is refreshed after every preload and on the 1 s watchdog tick. The MB values come from `engine._debugStats()`
  and are null without it. Exports: `PIN_BUDGET_MB`, `LIBRARY_PIN_RADIUS`, `LARGE_SET_PIN_RADIUS`, `LARGE_SET_NOTE`.

**Engine.**
- `_debugStats()` adds `pinnedMB` (decoded bytes held by pinned URLs) and `capMB`. The preload `'ready'` event adds
  `pinnedMB`.
- `engine.estimatePreloadMB(patches)` returns `{mb, exact, samples, capMB}`; samples shared between songs are
  counted once.
- `BufferCache` changes:
  - It remembers each URL's decoded size (`sizes`, kept after eviction and cleared by `invalidate`).
  - New `estimateBytes(urls)` returns `{bytes, unknown, count}`. A URL that was never decoded is priced at the mean
    of the known sizes in its folder (an instrument layer), else at `DEFAULT_SAMPLE_BYTES` = 1.75 MB (1023.6 MB / 591
    factory-song samples).
  - New `pinnedBytes` / `pinnedMB`.
  - Eviction, once over `capBytes`, now goes down to `lowWaterBytes` (85 % of the cap) instead of stopping exactly at
    the cap. This is hysteresis, so a library walk doesn't evict on every acquire.
- `preload()` is unchanged apart from moving URL collection into `_sampleJobs()`.

**Settings (one line).** The diagnostics line reads `Decoded samples: 617.2 MB (332.9 MB kept loaded) · <note> ·
Voices…`.

**For UI:** Perform doesn't show `status.memory.note` yet. Suggestions:
- A quiet info toast on the controller's `'memory'` event.
- Or a hint next to the Ready LED while `status.memory.mode === 'large-set'`.
- `renderReady`'s "Loading x/y" counts every song of the nav list as loaded or not. In large-set mode some songs
  are deliberately not resident, so after `ready` it says "Ready". That is correct, but don't turn it back into x/y
  there.

**Soak (2 min, `node test/integration/soak.mjs --minutes 2 --sample-sec 20`).** There is a new
`--no-setlist` flag (deselects My Set before the warm-up), `pinnedMB`/`capMB`/`memMode` columns, a `warmup` row, and a
check "decoded samples stay under the engine cache cap" (`decodedMB ≤ capMB` in every row). Both runs were 12/12.

| run | after warm-up (19 songs) | during play / final | pinned | before |
|---|---|---|---|---|
| `--no-setlist` (library, ≤ 3 pinned) | 606.5 MB | 617.2 MB, flat | 332.9 MB (Salamander, the reference song's window) | — |
| default (My Set = 19 songs → large-set) | 686.1 MB | 667.7–689.8 MB | 332.9–417.1 MB | 1023.6 MB, all pinned |

The cache fills up to its cap and then evicts LRU down to 595 MB, so decodedMB is bounded by 700 MB rather than far
below it. For a lower steady state, lower `cacheMB` (AudioEngine option, default 700).

**2. Preset levels (round2-shell #8).** Measured with `node tools/audition.mjs --only gospel-stab-b3,synthwave`
(solo RMS of each slot over 0.5–8 s; Gospel Stab plays with mod wheel 0.7 → slot 1, as in the audition):

| song | slot | gain | solo RMS | vs loudest slot | vs mix |
|---|---|---|---|---|---|
| Gospel Stab + B3 | poly-stab | 0.5 → **0.85** | −34.8 → −30.2 dBFS | −10.1 → **−5.5 dB** (organ −24.7) | −12.6 → −8.4 |
| Synthwave | square-lead | 0.6 → **1.2** | −36.8 → −30.8 dBFS | −11.2 → **−5.2 dB** (808 sub −25.6) | −13.5 → −7.9 |

- Mix before → after: Gospel Stab RMS −22.2 → −21.8, peak −9.3 → −8.28 dBFS (mono −6.52). Synthwave RMS −23.3 →
  −22.9, peak −10.98 → −10.54 (mono −8.24). Both PASS with no soft warnings, and the peaks stay well under −1 dBFS.
- At full mod wheel the stab is 3.1 dB louder than in the audition, which puts it 2.4 dB under the organ: "stabs
  for hits".
- 1.2 is inside `slots.<i>.gain` 0..2 (+1.6 dB on the fader).
- `presets.test.mjs` pins both gains to the measured rise (4.6 and 6.0 dB) and checks the range and that the store
  keeps the value. The two audition clips were re-rendered and merged into `audition/report.json`.

## hv2-edit-setup (app/js/views/edit/**, test/phase2/edit-v2/**; nothing existing edited)

This is the scaffolding for building the H-v2 Edit (design/H-v2) with six parallel panel agents. The app still
mounts `views/edit.js`. `index.html`, `main.js`, `edit.js`, `settings.js`, `components/*`, `styles.css` and
`perform.js` are untouched. The contract, ownership table and per-panel behaviour checklists are in
`app/js/views/edit/CONTRACT.md`.

**Module map.**
- `views/edit/shell.js`:
  - `mountEdit(el, ctx)` has the same signature as edit.js. It builds the three-area layout (setlist | song header
    over the rig card | keyboard row), the rig bar ("Wheels & pedal" link, "Show wiring" switch), and one row of 7
    tabs (Keys · Pad · Extra · Bass · Drone | Effects · Master) with summaries, playing LEDs, off/empty states and
    song-diff changed dots. It also builds the wiring strip and the panel host (sentence title + body).
  - `mountSinglePanel(el, ctx, id, opts)`, `registerPanel(id, def)`, `registeredPanels()`.
  - `EditState` (an EventTarget): selected block, `select/setWiring/setDrawer`, baseline, changes.
- `views/edit/lib.js` has the shared helpers: `h`, `icon`, `sentence`, `createBinder` (edit.js's targeted-refresh
  bindings, per panel), `section` (per-viewer open state in `localStorage['worship-rig.edit2.sections']`, a new key),
  `wordSlider` (a native range 0..1000, lin/log/taper, bipolar, double-click reset), `BLOCKS`, `blockOf`, `relOf`,
  `hasParam`, the formatters, `bpmFromTaps`, `download`.
- `views/edit/panels/{slot,drone,effects,master,song,song-header,setlist,bottom}.js` are stubs (placeholder +
  sentence title + store follow). `panels/index.js` is the registered list. There is one `panels/<x>.css` per owner.
- `views/edit/styles-edit-v2.css` holds the tokens, layout, tabs, wiring, panel frame, sections and word slider,
  and `@import`s the panel CSS. It is **not linked from index.html yet**. The integrator adds
  `<link rel="stylesheet" href="./js/views/edit/styles-edit-v2.css">` after `styles-edit.css`.

**Interface decisions.**
- Master tab = master volume + Tape + Tone EQ + Glue + **Wheels & pedal** (the link selects `master {focus:'wheels'}`).
- A tab-less **`song` block** (Easy Transpose, tempo, notes) is opened by the header's KEY / BPM / Notes chips.
- The changed-dot baseline = `ctx.getBaseline()`, a new optional ctx field main.js will pass (perform.js
  `savedSnapshot`), when it belongs to the current song. Otherwise the shell uses its own copy from the controller's
  `songSelected` / song change.
- Esc in Edit: the shell runs panels' `ctx.onEscape` handlers newest first and always `preventDefault`s (never
  Panic). Dialog tokens are now `edit-<token>`.
- Show wiring is view-local, never persisted. Lane values are `Math.round(sends.<unit> × 100)`, zero is "–" and the
  drone is "fixed".

**Tests.**
- `test/phase2/edit-v2/harness.mjs` provides `mountPanelForTest(id, opts)`, `smoke(t)` and `shutdown()`: server.js
  on a free port, a shared Chromium, a fresh context per mount, and `harness.html`.
- `run.mjs` runs `shell.test.mjs`, `panels/*.test.mjs` and `integration*.test.mjs` sequentially (`--only`,
  `--list`).
- Results:
  - `node test/phase2/edit-v2/run.mjs`: **9/9 files, 25/25 tests** (shell 9; 2 per panel file × 8). It took 1 min
    43 s on an idle box and about 8 min with other suites running (load average about 4 on 2 CPUs).
  - One loaded run had a Chromium page close mid-boot and one file hang. The harness now retries a boot once,
    relaunches a dead browser, and puts a timeout on every page wait. `run.mjs` uses `--test-timeout` and kills a
    file's whole process group after 8 minutes.
  - `node test/phase2/ui-edit/run.mjs`: **94/94**, unchanged.

## hv2-perform (views/perform.js, main.js, index.html, styles.css, views/settings.js 1 section; ui-core tests)

H-v2 steps 2–3 (design/H-v2/implementation.md): the Perform half of H-v2, built on the step-1 components. Store
schema, PARAMS and the controller API are unchanged; `edit.js` is untouched. The lock-scope change is the one
behaviour change, OK'd by Ryan (OPTIONS.md decision 2), with the five round-3 fixes folded in.

**Layout (perform.png / perform-1024.png).** Rows 112 · 54 · 1fr · 94 px at 1440×900; 94 · 50 · 1fr · 74 at ≤ 1250 px.
- Header: song name, **KEY ▾** (holdButton) → "Sing it in…" popover, "you play D · 72 BPM" (a "you play D" pill when
  transposed), Transpose −/+ (holdButtons), **Space / Echo header chip rows** (`headerChipRow`; pills at ≤ 1250 px),
  Chord (long names step down to 30 / 22 px via `data-len`, the column is 116 px).
- Setlist row: Prev, strip, Next as a button (name · key, chevron). Prev/Next carry `data-overlay-pass`.
- Stage: Wheel (white pedal LED, "Bend" lamp) · four strips · Key & drone · Notes (shares the drone column ≤ 1340 px).
  - Strip: `onTile` (= the mute, `slots.<i>.muted`), group icon + name, tag line (wheel %, Chorus badge; with 2 chips
    also "Oct ±n" / "Sus. off" badges), relative-drag fader, `stepChip`s **Space · Echo · Octave · Sustain** →
    `slots.<i>.sends.reverb` / `.sends.delay` / `.octave` / `.sustain`. An empty slot collapses to a dashed 60 px
    (44 px) column with "+" → Edit.
  - Key & drone (title kept, fix 1): drone `onTile` (off ↔ source), Synth / My Pads, 12-key grid, Major/Minor, Level,
    **Brightness / Movement** (`drone.brightness` / `drone.movement`, existing PARAMS rows; words Dark/Soft/Clear/Bright,
    Still/Gentle/Moving/Restless are display only), Follow chords, Continue across songs, pad folder (hidden ≤ 1250 px,
    as in the mockup; Settings › My Pads has it). Selections in the card are outline-only; the tile is the only fill.
- Bottom: keyboard with **range bars** (per slot, from `lowNote/highNote`, grey when OFF; display only) · **Revert**
  (hold) · Fade out · **PANIC** (solid `--panic` #d9363a, "Esc") · **Lock** (holdButton).
- Top bar: `#btn-quick` (Perform only; `ctx.quickButton`) toggles the **Quick sheet** (`quickSheet`), which sits
  exactly over the header + setlist rows (178 / 154 px) and never over a strip (tested). Tempo TAP →
  `songs.<id>.tempo`, Swell time → `patch.swell.seconds`, Touch → `settings.velocitySens`, Reversed →
  `settings.pedalInvert`, Restart → `controller.restartAudio()`, All settings → `ctx.openSettings()`. It closes on ×,
  Esc, the Quick button, a song commit (`songSelected`) or leaving Perform.
- At ≤ 1250 px the top bar shows the MIDI device name and the latency only when they warn (`.off` / `.warn`).

**Lock rule (`LOCK` export in perform.js).**

| While locked | Controls |
|---|---|
| live | slot faders, ON tiles, drone ON tile + Level, wheel, Swell, strip chips, header Space/Echo (incl. Song's own), Quick › This song + restart, Prev/Next/setlist tap, Fade out, PANIC |
| hold 600 ms | KEY ▾ (opens Sing it in…), Transpose −/+, drone key grid, Major/Minor (`holdGate` in perform.js: capture-phase pointer/Enter/Space hold, `--hold` progress, a tap flashes "HOLD a key or Major/Minor…"), Revert |
| frozen | Edit, ⚙, drone Synth/My Pads, Brightness, Movement, Follow chords, Continue, pad folder (as before), setlist reorder, Quick › This Mac |

- `setSong()` no longer refuses writes while locked; each control enforces its own rule (disabled, hold, or live).
- **Revert always needs the hold**, locked or not (fix 2). The Lock button is a `holdButton` (`requireHold: locked`):
  one press locks, a 600 ms hold unlocks; round2-ui #5 (key auto-repeat) is handled inside `holdButton`.

**Changed dots and the Revert count.** `changedPaths(song, snap.song)` (shared/song-diff.js) against the existing
snapshot drives the white dots on strip chips, header chips and the 2-chip Octave badge; step panels mark "as loaded".
The count is `changeCount(paths)` (exported): the key paths `hearIn/playIn/transposeOctave` count once, so a key-grid
tap is "1 changed". Faders and mutes are not counted (fix 2); with only those changed the button reads "levels only"
and is still enabled (it restores them). Dots show in Perform only (fix 3). `mountPerform()` also returns
`changedPaths`, `toggleQuick/openQuick/closeQuick`, `quickOpen` (tests / main.js).

**Song's own.** Echo always has it; Space gets it only when the song was loaded with a room that matches no preset
(the chip is built once and hidden, so a song switch never rebuilds the row). A tap writes the snapshot's
`patch.fx.delay` / `patch.fx.reverb` object back (one `store.set`); nothing else changes. The old Vibe picker's presets
are behind Space "…" (with Ambient Wash) as `vibe:<id>` chips, applied as before (`isValidPath` filter kept).

**Sing it in….** `singItInShift(playIn, pc)` (exported) = the nearest shift in −6…+5; perform.js calls the existing
`controller.transposeBy(delta)`, so no `transposeTo` wrapper was added (controller API unchanged). D → G = +5,
D → B = −3; "Back to D" = shift 0.

**Drone ON tile source (fix 5).** Off stores `'off'`; on restores the source the tile switched off in this session,
else the snapshot's source (`droneOnMode`), else Synth. After a reload a song saved with the drone off comes back as
Synth (no new field).

**Esc.** Unchanged main.js rule; overlays (step panels, Sing it in…, "…", Quick) register with `openOverlay`, so Esc
closes the top one without panicking and Esc with nothing open panics (tested for all three).

**Two chips per strip.** `settings.performChips` (4 | 2, unset = 4). The store keeps unknown settings, so no store
change; Settings › Perform view has a 4 chips / 2 chips switch (`data-testid=setting-perform-chips`).

**Selectors / test ids.** `slot-mute-<i>` → `slot-on-<i>` (aria-pressed = ON, i.e. inverted); `space-preset` /
`vibe-preset` selects → `space-row` / `echo-row`; drone mode "Off" → `drone-on`; new `key-button`, `sing-it-in`,
`sing-grid`, `sing-back`, `slot-space|echo|octave|sustain-<i>`, `slot-add-<i>`, `drone-brightness`,
`drone-movement`, `range-bars`, `quick-button`, `song-bpm`. `song-playin` now reads "you play C".

**Deviations from the mockup.** Song title 32 px at 1024 (mockup 30; the old test demanded 40, now ≥ 32) and the KEY
letter 32 px at 1440 (mockup 28; boot test ≥ 32). The drone card title "Key & drone" sits above the tile (fix 1). Quick
sheet controls are 44 px at 1440 and 38 px at 1024 (mockup 42 / 34). Revert shows "nothing changed" / "levels only"
instead of a bare count when the count is 0.

**Measured.** Fader throw (input height) at 1440×900: **257 px with 4 chips, 309 px with 2** (mockup 250 / 302); at
1024×700: 141 px (mockup 143). Contrast: PANIC white on #d9363a 4.63. All Perform hit targets at 1440 ≥ 44 px (new:
ON tiles 46, chips 46, header chips 44, KEY 44, Transpose 48, Quick 44).
Tests: `node test/phase2/ui-core/run.mjs` 39/39 (33 kept and updated + 6 new H-v2 tests: ON tile + colour
contract, strip chips + swallowed outside tap + fine slider, Sing it in…, Quick sheet, 2 chips, screenshots; the lock,
Revert, Esc, header-chip and responsive tests were rewritten for the new rules). `node test/phase2/ui-edit/run.mjs`
94/94.

## eq-engine (shared/params.js rows / engine fx.js + audio.js EQ / store.js 1 loop / engine + unit tests)

Slot EQ per design/eq/AMENDMENT.md (WING-style, overrides DECISION.md §2–3 where they differ).

**PARAMS rows (added; nothing removed).** For k = 1..8 (`EQ_BAND_COUNT`), exported with `EQ_BAND_TYPES`:

| Path | Range | Default | Unit / curve |
|---|---|---|---|
| `slots.<i>.eq.b<k>.on` | bool | **true for b1, b8**; false for b2..b7 | bool |
| `slots.<i>.eq.b<k>.type` | `off lowshelf peak highshelf notch lowcut highcut` | b1 `lowshelf`, b8 `highshelf`, else `peak` | enum |
| `slots.<i>.eq.b<k>.hz` | 20…20000 | 120, 210, 370, 640, 1100, 2000, 3400, 6000 | Hz / log |
| `slots.<i>.eq.b<k>.db` | −15…15 | 0 | dB / lin |
| `slots.<i>.eq.b<k>.q` | 0.1…10 | 1 (linear Q; cut types convert to dB) | lin / log |
| `slots.<i>.eq.hiCutHz` | 200…20000 | 20000 (= off, ≥ 19999) | Hz / log |

`slots.<i>.eq.cutHz` (20…400, 20 = off, ≤ 20.5) and DECISION's `lowHz / mid1* / mid2* / highHz` rows were already in
the table and stay. Unused bands are absent from songs; the defaults reproduce today's strip, so no migration.

**Effective EQ** (`fx.resolveSlotEq(slot.eq)`, exported): a band with **any** stored b-row takes PARAMS defaults for
its missing fields (same rule as shared/eq-math.js `readEq`). A band with none reads the legacy rows over its
defaults: b1 ← `eq.low` / `eq.lowHz`, b8 ← `eq.high` / `eq.highHz`, and (DECISION rows) b2 ← `mid1/mid1Hz/mid1Q`,
b3 ← `mid2*`. So `{low: 4, high: −3}` renders bit-identically to `b1 {lowshelf 120 +4}` + `b8 {highshelf 6k −3}`.
Engaged = `on && type ≠ 'off'`; cuts engaged when `cutHz > 20.5` / `hiCutHz < 19999`. Web Audio mapping: peak →
peaking (linear Q), notch (linear Q), lowcut/highcut → highpass/lowpass with Q = 20·log10(q) dB, shelves ignore Q
(S = 1); dedicated cuts are 2nd-order Butterworth (`BUTTER2_Q`). Chain order: low cut → b1…b8 → high cut.

**Engine (fx.js `SlotEq`, owned by `Channel` as `strip.eq`).** Only engaged filters are wired
(`wOut → [lc] → [bands] → [hc] → chainGain → pan`). Measured first: a dry/wet pair per band costs ≈ 30 GainNodes per
slot (≈ 4 ms each / 30 s / 4 slots, vs ≈ 27 ms per static biquad), and 8 always-wired biquads would be 1.5× DECISION's
5-biquad number, so neither was used.
- In place (no graph change): Hz `glideTo(…, TAU, {from})`, Q and gain `rampTo(TAU)`. **Every EQ biquad param is
  k-rate** (frequency, Q, gain, detune). A peak/shelf band switched off (or to `'off'`) ramps to 0 dB and **stays
  wired as identity**; a peak ↔ low shelf ↔ high shelf type change fades the band to 0 dB over 30 ms, swaps the type at
  identity (`engine.at`, no setTimeout), fades back in 30 ms (`EQ_TYPE_FADE`).
- Chain switch (the wired set changes: band added, cut engaged/bypassed, switch to/from notch/lowcut/highcut): a
  second chain with the new set is wired beside the live one, muted for `EQ_WARM` = 50 ms (fresh biquad state), then a
  linear `EQ_XFADE` = 30 ms crossfade (correlated signals) and the old chain is detached. This is DECISION's cut
  "dry/wet crossfade bypass" generalised; identity leftovers are dropped at the next switch. Changes arriving
  mid-switch apply to both chains and are re-checked when it ends. Graph edits only touch muted paths.
- Fresh channels (`_applySlotCfg` fresh / `step`) build the target chain directly.
- `Channel.setEq(eqObject, when, step)`; the engine-3 form `setEq(lowDb, highDb, when, step)` still works (merges
  `low`/`high`). `strip.eqLow` / `strip.eqHigh` are getters for the live b1 / b8 biquads. `Channel.nodeCount` is a
  getter: 17 at the defaults (was 16: +1 chain gain), + 1 per engaged filter, both chains while switching.
- audio.js: `normalizePatch` keeps every present `eq.*` key that has a PARAMS row, band objects field by field (it
  used to rebuild `{low, high}` and drop the rest). `setParam('slots.i.eq.<key>' | 'slots.i.eq.b<k>.<field>')`
  updates `cfg.eq` and coalesces **one key per slot** (`slots.i.eq`) → `strip.setEq(cfg.eq)`. `getParam` of a b-row or
  a cut returns the **effective** value (so `eq.b1.db` reads `eq.low` while b1 has no rows); other eq rows return
  stored ?? PARAMS default (was `?? 0`, wrong for Hz rows).

**New engine API** (for the editor; views reach it through `controller.*` — pass-throughs not added, see eq-build):
- `engine.getEqResponse(slotIndex, freqs, {perBand = false} = {})` → `Float32Array` of summed magnitude in dB at
  `freqs` (Hz), or with `perBand` `{total: Float32Array, bands: {lc?, b1…b8?, hc?: Float32Array}}` (wired filters
  only). Computed from the **stored target** (`this._patch.slots[i].eq`, not the possibly ramping live nodes) with
  `BiquadFilterNode.getFrequencyResponse` on per-slot cached unconnected "shadow" biquads, at `ctx.sampleRate`;
  freqs above Nyquist are evaluated at Nyquist. `null` for an empty slot or before `start()`.
- `engine.getSlotPlayRange(slotIndex)` → `{lowNote, highNote, sampledLow, sampledHigh, transpose, physLow, physHigh,
  instrumentRange}` or `null` (empty slot). `transpose` = song transpose + 12·octave + slot transpose (as noteOn);
  `lowNote..highNote` = the split shifted and clipped to 0..127 (null when nothing sounds); `sampledLow..sampledHigh`
  = that ∩ the sampler's manifest notes (all layers), i.e. outside it but inside lowNote..highNote is a "stretched"
  sample (DECISION §5); synth/organ/drone: `instrumentRange: null`, sampled = sounding.
- Exported from fx.js: `SlotEq`, `resolveSlotEq`, `slotEqMembers`, `slotEqResponse`, `EQ_CUT_OFF_HZ` (20.5),
  `EQ_HICUT_OFF_HZ` (19999), `EQ_TYPE_FADE`, `EQ_WARM`, `EQ_XFADE`.

**store.js (one loop, pass-through).** `normalizeSlot` nested only one level (`out.eq = {…, b1: <value>}`), so a
3-segment row was written as `eq.b1 = <last field>` on every load. It now copies containers at any depth. With that,
store `SLOT_EXTRA` and controller `SLOT_PARAMS` pick the 42 new rows up unchanged: shell3's "every PARAMS entry passes
through, clamps, persists" and "slot strip params reach the engine" pass (`node test/phase1/shell/run.mjs --only unit`).

**Measured** (`node test/phase1/engine/run.mjs offline.eq`, 6 suites, all green; full engine run 65/65):
- `eqIdentity`: defaults / 0 dB + off + `'off'` bands / two bands added live at 0 dB vs the strip with the EQ section
  removed: max |diff| 2.4e-7 / 2.4e-7 / 4.8e-7 (≤ 2e-6). Legacy `{low 4, high −3}` vs the same b-rows: 0. Every
  `slots.0.eq.*` row round-trips `setParam → getParam` (clamped). k-rate on every live EQ param.
- `eqBandResponse`: multi-sine (12 probes 50 Hz–11 kHz) rendered through the slot vs `getEqResponse`: worst 0.0001 dB
  for peak, low/high shelf, notch, band lowcut/highcut, dedicated cuts, legacy rows, DECISION mid1, and all 8 bands +
  both cuts together (both the song-load and the live-setParam paths).
- `eqSwitchClicks`: low cut in/glide/out, high cut in/out, band added, dragged, peak→lowshelf→highshelf→peak (in place),
  →notch→lowcut→peak (switches), removed, b1 `'off'` and back, over a chord + 4 sines: 0 clicks (house detector);
  exactly 8 chain switches. Positive control (raw peak +12 → notch swap): detected.
- `eqDragZipper`: gain ±12 dB, 150 Hz → 2 kHz, Q 0.5→3.5 and the high shelf, written every 10 ms for 1.5 s: 0 clicks.
- `eqPlayRange`: test-keys (C4–A4) split 48–72, octave −1, transpose +2, song +3 → sounds 41–65, sampled 60–65.
- `eqCpu` (DECISION's method, 4 slots, 48 kHz, per 30 s of audio, fastest of 5 interleaved rounds on this loaded
  2-CPU box): EQ section's own cost at the defaults ≈ 220 ms (**0.8 %** of a core; DECISION "today" 219), 5 static
  filters ≈ 540 ms (**1.8 %**; DECISION 536), 5 ramping k-rate ≈ 700 ms (**2.3–2.6 %**; DECISION 764), each within
  0.87–1.19× the same number of plain biquads in the same run. All 10 filters engaged in all 4 slots: **3.4–3.6 %**,
  over AMENDMENT's 2.5 % budget (which holds up to ≈ 6 engaged filters per slot).

Not done here (DECISION §3 extras, not in this task): `slotAnalysers`, `auditionNote`, `eqAudition`, and
`listInstruments()` `range` (getSlotPlayRange covers the greying). Nobody has listened on speakers yet (DECISION §7).

## eq-build

Requests from eq-engine for other owners:
- **controller.js**: pass-throughs so views can reach the new engine calls (views never call the engine):
  `controller.getEqResponse(i, freqs, opts)` and `controller.getSlotPlayRange(i)` (null-safe when the engine lacks them).
- **store.js**: changed by eq-engine (one loop in `normalizeSlot`, see "## eq-engine"); please keep it depth-generic.
- **shared/eq-math.js** `readEq` ignores `eq.lowHz` / `eq.highHz` / `mid1*` / `mid2*`; the engine honours them for a
  band without b-rows (every PARAMS row must do something). Either read them too, or drop those DECISION rows from
  PARAMS in one change with the engine's `EQ_LEGACY` table (fx.js).
- **Edit (Warmth / Brightness sliders)**: they write `eq.low` / `eq.high`, which only act while b1 / b8 have no
  b-rows. Once the Tone editor has migrated a slot (writesFor), the sliders must write `eq.b1.db` / `eq.b8.db`.
- `hiCutHz` range is 200…20000 (eq-math's fallback says 20…20000; it reads the row, so nothing to change).

Replies and requests from eq-ui:
- Done: `shared/eq-math.js` `readEq` now reads `lowHz`/`highHz`/`mid1*`/`mid2*` as b1/b8/b2/b3 for a band with no
  b-rows, matching fx.js `EQ_LEGACY`. The first edit migrates them and zeroes their gains. Its fallback ranges now
  match the rows (`cutHz` 20–400, `hiCutHz` 200–20000).
- Done: `eqKeyboard` prefers `controller.getEqResponse` / `getSlotPlayRange` / `slotAnalysers` / `eqAudition` /
  `auditionNote` over the engine's, so the controller pass-throughs are picked up as soon as they exist.
- Warmth/Brightness: use `shelfWrites(slot.eq, 'low'|'high', db)` from eq-math. It picks the right shelf, migrates a
  legacy slot, and re-adds a removed shelf.
- **engine / controller**: `eqAudition(i, 'bypass'|'on')` (DECISION §3). Until it exists, A/B falls back to store
  writes that are restored on A, edit, slot change and destroy.
- **engine / controller**: `slotAnalysers(i)` → `{pre, post, release}`. Until it exists, the RTA is the master
  analyser.
- **components/index.js**, **index.html**, **edit panels/slot.js**, **test/run-all.mjs**: the integration steps are
  in "## eq-ui".

## eq-ui (views/components/eq-keyboard.js + .css, shared/eq-math.js, test/phase2/eq/**, test/unit/shared/eq-math.test.mjs)

The keyboard EQ from design/eq ("curve" prototype), rebuilt as WING-Q-style variable bands per AMENDMENT.md. No
existing file was edited. `components/index.js`, `index.html` and the Edit panels are the integrator's; the steps are
below.

**API**
- `eqKeyboard({ store, engine, slotIndex, onChange?, controller?, compact?, toast?, rta? })` returns
  `{ el, update(), setSlot(i), destroy(), debug() }`.
  - `onChange({slotIndex, writes:[key, value][], why})` fires after every committed edit. `why` is one of
    `drag`, `cell:hz`, `preset:Warm`, `paste`, `add`, `remove`, and so on.
  - `compact` forces the compact layout. It also switches on by itself when the component is under 1180 px wide.
  - `rta: false` turns off the analyser behind the curve. It defaults to on.
  - `toast(msg)` sends status lines to the app's toast. Without it the component shows its own. Hover and graph hints
    always stay inside the component.
  - `update()` re-reads the store and the engine. The component already follows `store.subscribe` and the engine's
    `ready`, `instruments`, `loading` and `statechange` events on its own.
  - `setSlot(i)` switches slots. It leaves B first.
  - `destroy()` removes every listener, the store subscription, the rAF loop and `el`, and restores B. It is
    idempotent.
- `eqMiniCurve({ store, slotIndex, onOpen?, width=120, height=28 })` returns `{ el, update(), setSlot(i), destroy() }`.
  - This is the Sound-panel header sparkline (DECISION §4).
  - `el` is a `<button>` and is `hidden` while the EQ is flat.
  - It is computed locally and never calls the engine.
- `shared/eq-math.js` is pure and rewritten for the AMENDMENT model. The DECISION-era version that was here had no
  users.
  - Model: `readEq(eq)` returns `{bands:[{k,on,type,hz,db,q,legacy}], cutHz, hiCutHz, legacy}` (visible bands only).
    `writesFor(eq, target)` returns the minimal `[relKey, value]` writes. Also `bypassWrites(eq)`,
    `shelfWrites(eq, 'high'|'low', db)`, `freeBand`, `eqSummary`, `activeBands` and `EQ_PRESETS` (Flat, Warm, Air,
    Cut mud, Wing channel).
  - Filters: `rbjCoeffs`, `magDb`, `bandFilter`, `cutFilters`, `eqResponseDb`, `bwOfQ`/`qOfBw` (digital relation),
    `soundingRange`/`zoneOf`, `bandReach`/`actsOn`.
  - Text: the parsers, `snapF`, `formatEqText`, `parseForeign`.
  - Ranges and defaults come from the PARAMS rows through `eqRow()`, falling back to AMENDMENT §4.

**Writes** (all through `store.set('slots.<i>.eq.<key>', v)`, keys `b<k>.on|type|hz|db|q`, `cutHz`, `hiCutHz`)
- Adding a band takes the lowest free k. It gets all five fields, `peak`, 0 dB, Q 1, at the tapped key (snapped; ⌥
  keeps the exact Hz).
- Removing a band writes `b<k>.on=false` and `b<k>.type='off'`. `off` is the "unused slot" marker, and the row and
  node disappear. `on=false` with a real type means "switched off": the node is dashed and the row is dimmed.
- Legacy handling matches fx.js `resolveSlotEq`, per band. A band with no stored b-row is shown from the legacy rows:
  `low`/`lowHz` → b1, `high`/`highHz` → b8 (both always shown), and `mid1*`/`mid2*` → b2/b3 when stored.
  - The first edit of any kind writes full rows for every legacy band on screen.
  - It also zeroes the legacy gains that were set, so `eq.low`/`eq.high` never double up.
- The type menu offers PEQ, Low shelf, High shelf, Notch, Low cut and High cut.
  - Switching to a cut sets Q 0.71 (Butterworth, since the engine takes band-cut Q as 20·log10(q) dB).
  - Switching to a notch with Q < 2 sets Q 8.
  - The dB cell is disabled for notch and cuts, and the Q cell for shelves (Web Audio ignores shelf Q).
- The dedicated cuts are the LC/HC nodes on the −10 dB row, and the side cells. Drag a node in from its edge to
  engage it. A double-click, or dragging it back to ≤ 21 Hz / ≥ 19.5 kHz, turns it off (`cutHz` 20, `hiCutHz` 20000).
  The row ranges clamp them to 20–400 Hz and 200 Hz–20 kHz.
- Presets and paste **replace** the whole EQ, cuts included.
  - Paste numbers the bands this way: the first low shelf → b1, the first high shelf → b8, then the rest by
    frequency.
  - The first plain HP/LP → `cutHz`/`hiCutHz`. HPQ/LPQ, or a second HP/LP, becomes a band cut.
  - A 9th band, AP/BP, a non-12 dB shelf and preamp are listed as skipped, never approximated.
  - The "Wing channel" preset (L shelf 120, PEQs at 200/600/1.5k/3k, H shelf 6k, all 0 dB) uses our own frequencies.
    They are not the console's factory values.

**Interaction** (WING-Q + the prototype)
- Nodes are drawn at r 17 (r 15 in compact), and the hit radius is 22 px (a 44 px target). Nodes are numbered by k
  and carry a small type glyph.
- The selected PEQ or notch shows Q wings (half-gain / −3 dB points).
- Drag sets Hz × dB with a 4 px deadzone per axis: a vertical drag never re-snaps a typed Hz.
  - Frequency snaps to a key, or to ISO thirds in the sub/air zones.
  - Gain moves in 0.5 dB steps.
  - ⌥ turns snapping off (0.1 dB). ⇧ is fine control (×0.2, no snap).
- Dragging below the plot by more than 14 px shows "release to remove" and removes the band on release.
- A long press (≥ 550 ms without moving) toggles on/off. So does the row switch.
  - It is decided on release, from input timestamps, so a busy main thread can't turn a quick drag into a toggle.
  - At 550 ms the node's ring turns white and a toast says "Release to switch band k off".
- Double-click a node for 0 dB. Double-tap empty graph space to add a band. When all 8 are in use it refuses, with a
  message.
  - A double tap is two pointerdowns within 400 ms (input `timeStamp`) and 16 px. The native `dblclick` is a
    fallback for a long double-click setting, and it stands down when the pointer path already acted.
- The wheel changes Q **only over a node or with ctrl/alt/meta** (ctrl = trackpad pinch). This differs from the
  prototype so that the Edit drawer can still scroll. Two-finger pinch also changes Q.
- Keys:
  - `1`–`8` select a band.
  - ←/→ move one semitone (⇧ = 10 cents; ISO thirds outside the keys). ↑/↓ change gain by 0.5 dB (⇧ = 0.1).
  - `[`/`]` change Q, `0` sets 0 dB, `o` switches on/off.
  - Del/Backspace removes, Insert/`+`/`n` adds, `B` toggles A/B.
  - The table cells are in Tab order. Enter on an unchanged cell doesn't re-parse. Esc reverts.

**Engine and controller use** (all feature-detected; views otherwise only call `store.set`)
- `engine.getEqResponse(i, freqs)` draws the curve, so the curve is what you hear. It falls back to eq-math when
  missing or null.
  - The drawing is local-first. The store reaches the engine a hop later (store notify → controller →
    `setParam`), so right after an edit the engine still answers with the old EQ.
  - So the local RBJ curve (the target) is drawn, and the engine is polled every frame until it agrees within
    0.5 dB, for up to 3 s. After that the engine's curve wins, with one `console.warn`.
  - Measured with every band type and both cuts engaged: **max 3.3e-4 dB** apart.
- `engine.getSlotPlayRange(i)` drives the greying. The component clamps to the 88-key controller, shifted, itself
  (DECISION §5 `ctrl`). `instrumentRange` marks the "stretched" keys with a light hatch. Without it, the component
  uses the slot's split, octave and transpose plus `store.transposeSemisOf(song)`.
- `engine.slotAnalysers(i)` → `{pre, post, release?}` or `[pre, post]` would give the pre/post RTA. It is not there
  yet, so the RTA behind the curve is the **master** `engine.analyserL/R`: every slot plus effects. It is drawn only
  while `engine.ctx.state === 'running'`.
- `controller.eqAudition(i, 'bypass'|'on')`, else `engine.eqAudition`, is the A/B. **Neither exists yet**, so A/B
  falls back to a store compare:
  - B writes `on:false` for the audible bands, opens the cuts, and zeroes legacy gains.
  - The exact prior values are restored on A, on any edit (edits always leave B first), on `setSlot`, and on
    `destroy`. If the song changed meanwhile, the restore goes to that song through `songs.<id>.patch…`.
  - Risk: while in B the bypassed state is in the store and can be autosaved, so a crash in B leaves those bands off.
    `eqAudition` (DECISION §3) removes the risk and is picked up with no component change.
- `controller.auditionNote` / `engine.auditionNote(i, midi)` plays a note when a lit key is clicked. Without it, the
  click only toasts the note, its Hz and the EQ at that note.
- The views-never-touch-the-engine rule: each of `getEqResponse`, `getSlotPlayRange`, `slotAnalysers`,
  `eqAudition` and `auditionNote` is called on `controller` when it has that method, and on `engine` otherwise.
  - So the pass-throughs eq-engine asked for in "## eq-build" are picked up as soon as they exist.
  - Only `engine.ctx` (for the sample rate and running state) and `engine.analyserL/R` are still read directly.

**Integration steps** (not done here; the files are owned elsewhere)
1. `app/js/views/components/index.js`: `export { eqKeyboard, eqMiniCurve } from './eq-keyboard.js';`
2. `app/index.html`, after the Edit stylesheets:
   `<link rel="stylesheet" href="./js/views/components/eq-keyboard.css">`. It uses the `styles.css` tokens, with
   fallbacks.
3. H-v2 Edit `panels/slot.js`, Advanced: the "Lows"/"Highs" rows become one **Tone** row, with the summary
   `eqSummary(slot.eq)` ("Flat" / "Custom · 3 bands").
   - Opening it mounts `eqKeyboard({ store: ctx.store, engine: ctx.engine, controller: ctx.controller, slotIndex: i,
     toast: ctx.toast })` across the full panel width.
   - Call `setSlot(i)` on tab change and `destroy()` on close or unmount.
   - At 1024×700 (compact) it measures **613 × 992 px** with 8 bands and the paste box open. Put it in the drawer's
     scroll area.
4. The Sound panel header: `eqMiniCurve({ store: ctx.store, slotIndex: i, onOpen: () => /* open Advanced → Tone */ })`
   goes next to the sentence. On the H-v2 tab row, use a tone dot only (DECISION §4).
5. The Brightness/Warmth word sliders in "The sound itself":
   - Read the value from `readEq(slot.eq)` (the highest high shelf / the lowest low shelf).
   - Write with `shelfWrites(slot.eq, 'high'|'low', db)` → `store.set('slots.<i>.eq.' + key, v)`.
   - Writing `eq.high`/`eq.low` directly **stops working once b8/b1 have rows**, because the engine reads legacy rows
     per band only while that band has none.
6. The edit `slotSummary` "Tone EQ": use `activeBands(slot.eq) > 0` instead of `low`/`high`.
7. `test/run-all.mjs`: add `test/phase2/eq/run.mjs` as the suite `eq`. The unit file is already picked up by
   `npm run test:unit`.

**Tests**
- `node test/phase2/eq/run.mjs`: **22/22**, about 21–27 s on a quiet box and 40–65 s at load 22–32. That is 1 unit file with 18 node:tests, plus 21
  Playwright tests on `fixture.html` (the real store, engine and controller; server.js on a free port). The browser
  tests cover:
  - greying for the C3 split and for Bass
  - double-tap add (b2, then b3)
  - Delete, the row ✕, and drag-off removal
  - notch type
  - drag and snap
  - typed 250 Hz
  - keyboard control, the wheel and the wings
  - 0 dB, long-press, and the cuts
  - the paste line from the brief
  - Warm, Wing and Copy
  - A/B
  - engine-vs-local curve agreement
  - the analyser
  - the 8-band cap
  - the 1024×700 fit and the ≥ 40 px target
  - `eqMiniCurve`
  - `destroy()` listener, subscription and rAF accounting
  - zero console errors and no HTTP ≥ 400
- Pixel checks mount with `rta: false`, because the song's drone paints the RTA under the sample points.
- Tests that build on an earlier one re-create their precondition, so one failure doesn't cascade.
- An unexpected navigation is reported as an error, and screenshots can't fail a test.
- Hardening history, found at load average 11–32 on the 2-CPU box:
  - `import()` inside `page.evaluate` intermittently died with "Execution context was destroyed", on the same page
    with no navigation (checked with `timeOrigin`). The fixture now exposes the modules on `window.__eq`.
  - Geometry was read before the first frame. `debug()` now measures on demand.
  - Pointer timing was judged by handling time. It now uses input timestamps, as described above.
  - The curve was stale while the engine lagged. It is now local-first.
  - After these fixes: 3 of 3 full runs green at load 22–32, and 5 of 5 before that.
- Screenshots are in `test/phase2/eq/screenshots/`.
- Not covered: real touch pinch (Playwright mouse only), and listening. The component adds no audio path.

## hv2-edit-setlist (views/edit/panels/setlist.js + setlist.css, test/phase2/edit-v2/panels/setlist.test.mjs)

Requests for the integrator (nothing outside the three owned files was edited):
- `lib.ICON_PATHS`: add `edit` (pencil) and `copy` (two sheets). setlist.js keeps a private `LOCAL_ICONS` + `glyph()`
  copy for the row actions until then.
- `lib.button(text, onClick, attrs)` takes no child nodes, so icon-only buttons need `h('button', …, icon)`.
  setlist.js has a private `iconBtn(label, node, onClick, attrs)`; a shared `lib.iconButton` would serve the header
  menus too.
- The setlist column exports `dropTarget(from, j, after)` and `SEARCH_MIN = 9` (the old edit.js keeps its own).
- The instance returns `_debug: {importText, renderList}` (ui-edit used `view._debug.importText`).

## hv2-edit-song (views/edit/panels/song-header.js + song.js + song-header.css, test/phase2/edit-v2/panels/song*.test.mjs)

Requests for the integrator (worked around locally; nothing outside the song files was edited):
- **`.ev2-head` clips overflow** (`overflow: hidden`), so the "⋯ Song" menu and its confirms can't drop below the
  header. song-header.js renders them as `position: fixed` popovers placed from the button's rect (closed on resize).
  A shared popover layer (or `overflow: visible` on the head) would let them be ordinary absolute boxes.
- **CSS order:** `styles-edit-v2.css` `@import`s the panel files first, so every shared `.ev2 .ev2-btn…` rule wins
  ties against a panel rule of equal specificity. song-header.css out-ranks them with `.ev2 .ev2-song-head
  .ev2-btn.ev2-song-…` (0,4,0). Wrapping the shared rules in `@layer ev2-base` would remove the need.
- **`binder.ctl(…, {text:true})` freezes a focused field for the whole focus**, even when the user hasn't typed. The
  tempo field uses a local "dirty since focus" flag instead (a focused, untouched field follows Tap / header writes).
  A `text:'dirty'` option in lib.createBinder would do the same for every panel.
- **run.mjs timeouts:** `--test-timeout=240000` also bounds the *file* (node:test treats the file as a test). With
  4–6 mounts per file on the loaded 2-CPU box (20–45 s per boot) the song file was cancelled at 240 s. Both song
  files now share one mount (resized to 1024 for the compact test, `view.remount({focus})` for focus-on-mount).
  Consider a larger per-file budget or documenting "one mount per file" in CONTRACT §7.
- **integration.test.mjs** (needs the full view): the header's KEY / BPM / Notes chips should open the Song panel
  with the right control focused, and a rename in the header should update the setlist row (ui-edit "song name +
  notes edit"); single-panel mounts can only assert `editState.selected/opts` and the store.
- Exports for reuse: song.js `transposeText(song)`, `createTapper(write, now?)`, `flashTap(btn)`, `octaveWord(song)`,
  `KEY_RELS`, `NOTES_DEBOUNCE_MS`.

## hv2-edit-effects (views/edit/panels/effects.js + effects.css, test/phase2/edit-v2/panels/effects.test.mjs)

Requests for the integrator (worked around locally; nothing outside the three effects files was edited):
- **ui-core fine slider in a step panel:** `.fader.compact .fader-input { height: 44px }` sets the height and
  `.step-panel .sp-fine .fader-input` only sets the width, so the vertical fine slider renders 44 px tall with a
  44 px thumb over the × button (Perform's Space/Echo step panels get it too). effects.css fixes it under `.ev2 .ev2-fx-sphost`
  (`.sp-body { grid-template-rows: minmax(0, 1fr) }`, `.sp-fine { --thumb-w: 26px; --thumb-l: 24px }`,
  `.fader-input { height: 100%; min-height: 0 }`). Belongs in styles.css `.step-panel .sp-fine`.
- **stepChip placement:** the panel always opens above the chip (`top: 5px; bottom: --sp-bottom`), which needs a
  tall host. The Effects tab passes `mount: () => placePanel(chip)`, a host covering the who-goes-in column of all
  three lines, and sets `data-dir` = `down` / `up` / `cover` from the room below/above the chip (need ≥ 290 px, 220 at
  ≤ 1250). A `stepChip({placement})` option would make that reusable.
- **`chorusWord`** (gentle < .34 ≤ medium < .67 ≤ deep) is private in shell.js; effects.js copies it so the title,
  the Chorus line and the wiring lane use the same word. Export it from lib.js.
- **Title actions are re-parented on every `setTitle`** (`actions.replaceChildren`), which blurs a focused menu item.
  effects.js calls `setTitle` only when the sentence changes (the Vibe label is updated in place).
- **run.mjs timing:** `--test-timeout=240000` also bounds the whole file under `node --test`. With load average
  25–35 (six agents), `controller.start()` hit its 45 s limit twice per mount, so a file with more than two mounts
  cannot finish. effects.test.mjs uses two mounts (a shared 1440 mount for four tests + one 1024 mount).
- integration.test.mjs: the Effects who-goes-in chips carry `data-bind="slots.<i>.sends.<unit>"` (same writes as the
  Perform strip chip); the wiring lanes' `{focus}` lands on the line's selected chip (reverb/delay) or Depth (chorus).

## hv2-edit-drone (views/edit/panels/drone.js + drone.css, bottom.js + bottom.css, test/phase2/edit-v2/panels/{drone,bottom}.test.mjs)

Requests for the integrator (nothing outside the six owned files was edited):
- **run.mjs file budget.** Under node 22, `--test-timeout=240000` also applies to the file-level test, so a whole file
  is killed at 240 s ("test timed out after 240000ms" at drone.test.mjs:1:1 with 6 mounts under load 7–30). Both
  files now share mounts (2 per file). Either raise the per-file budget or state the 2-mount rule in CONTRACT.md §7.
- **Drone key spelling.** The shell's default drone tab uses `PC_NAMES_MAJOR` for minor keys ("Db minor"); the panel
  title and `drone.tab()` use `keyName` ("C# minor", as the KEY chip). `droneKeyText(song)` is exported from
  panels/drone.js; lift it into lib.js and use it in `defaultTab`, or keep the panel's `tab()`.
- **ui-core toggle ON LED is `--accent` (amber)**, which H-v2 keeps for "lock". drone.css overrides it under
  `.ev2-drone-opt`; consider `var(--c, var(--accent))` in styles.css `.toggle.on .toggle-led` (mockup `.tog.on i`).
- Flake seen twice in ~7 runs: `page.evaluate: Execution context was destroyed` on an evaluate doing a dynamic
  `import()` (bottom legend test). The test no longer imports; harness `readParam` still does. Keep an eye on it.

## hv2-edit-integrate (index.html / main.js / views/edit/** / components/index.js + stepChip.js / styles.css 1 rule / perform.js 1 line / shared/smart-controls.js / tests / docs)

The H-v2 Edit replaces `views/edit.js` in the app. Store schema, PARAMS and the controller API are unchanged.

**Wiring.**
- `app/index.html` links `js/views/edit/styles-edit-v2.css` and `js/views/components/eq-keyboard.css` after
  `styles-edit.css`. `styles-edit.css` stays linked: Settings uses its `.st-*`, the fallback components their `.fc-*`,
  and settings.js still uses `.ed-btn/.ed-danger/.ed-select`. Its other `.ed-*` rules are dead and left for a prune
  pass with the settings screenshots as the check (a header comment says so).
- `main.js` loads `./views/edit/shell.js` (`mountEdit`). The ctx gains `getBaseline()` (perform.js `savedSnapshot`,
  TDZ-safe). `setView(name, {block, focus})` selects an Edit block; Perform's empty-slot "+" now opens Edit on that
  slot with the instrument menu open (`{block:'slot:<i>', focus:'instrument'}`; perform.js, one line).
- `components/index.js` exports `eqKeyboard`, `eqMiniCurve`.
- `panels/slot.js`:
  - Advanced's Lows/Highs sliders became a **Tone** section (`lib.section('slot<i>-tone')`, summary `eqSummary`).
    Its `eqKeyboard({store, engine, controller, slotIndex, toast})` mounts only while Advanced **and** Tone are open.
    It is destroyed on close, before every body rebuild (instrument / emptiness / slot change) and on unmount.
    `_debug.tone()` → `{inst, mounted, created, destroyed}`. The Advanced summary says "Tone Flat" / "Tone Custom ·
    N bands" instead of "Highs 0 dB".
  - `eqMiniCurve` sits in the title actions before "Change instrument" (hidden while flat); a click opens
    Advanced › Tone.
  - Brightness (when it falls back to `eq.high`) and Warmth read the EQ's highest high shelf / lowest low shelf
    (`readEq`) and write `shelfWrites` → `slots.<i>.eq.<key>`, refreshing on any `patch.slots.<i>.eq` change. The
    legacy `eq.low`/`eq.high` rows stop acting once b1/b8 have rows (eq-build), so writing them directly would go
    silent after the first Tone edit. `smart-controls.js` marks those specs `shelf: 'high'|'low'`; `path` stays the
    legacy row (the data-bind hook and the one-valid-path rule).
  - The private `slider()` wrapper (the cancelDrag workaround) is gone, and the Undo toast goes through `ctx.toast`.
- The Effects "goes in" rows got **no** mini curve: a per-slot EQ sparkline there is not trivial to place and says
  nothing about the send it sits next to.
- `panels/_stub.js` deleted.

**Retired.** `app/js/views/edit.js` (1748 lines) and `test/phase2/ui-edit/` (run.mjs, fixture.html, screenshots)
are deleted; nothing imported them. The 11 `settings:` tests moved to **`test/phase2/settings/run.mjs`** (modes `app`
= the real app, switched to the new Edit first; `fixture` = a settings-only page on the fallback components) with
the boot and zero-console-error checks: 26/26. ui-core's `SIBLING_FILES` now names `edit/styles-edit-v2.css` and
`edit/shell.js`.

**Where each old ui-edit test went** (edit-v2 file: test):
- boot → shell "regions + 7 tabs", integration "boots the H-v2 Edit".
- instrument picker by group / picker group order / instrument change / empty a slot and fill it → slot "Change
  instrument menu…".
- slot fader / M4 colours / mute toggle → slot "ON STAGE".
- pan · octave · transpose · sustain · mono, sends + instrument params, new strip/master params by describe → slot
  "Advanced" (+ "ON STAGE" for the sends); master "title sentence, volume taper…" for the master half.
- split note fields + mini keyboard, velocity sparkline + summary → slot "WHERE IT PLAYS".
- FX reverb/delay/chorus/lofi/master → effects "FX … reach the engine" + master.
- routing + drone controls → drone "routing + drone controls" + master "Wheels & pedal".
- Easy Transpose → song "Easy Transpose".
- tap tempo → song-header "tap tempo".
- song name + notes edit → song-header "song name", song "notes", and integration "a rename in the header updates the
  setlist row".
- store → view updates in place → slot "ON STAGE … in place", drone "song switch updates in place", master "values
  update in place".
- round2-ui #3 → song-header "song name … round2-ui #3", song "notes … round2-ui #3", slot "round2-ui #3".
- round2-ui #2 → slot "round2-ui #2".
- round2-ui #7, add from factory → setlist "add song from the factory browser".
- M1 Esc → setlist "M1", shell "Esc in Edit never panics".
- presets Space/Echo/Vibe → effects "presets".
- song search, setlist gap, reorder, rename/duplicate/delete, setlist new/select/delete, export/import → the setlist
  tests of the same names.
- reset to factory → song-header "reset to factory".
- on-screen keyboard → bottom "on-screen keyboard".
- screenshots + no horizontal overflow → shell "layout fits", slot "full view", integration "1440 and 1024 fit".
- destroy()/remount → shell "destroy() cleans up".
- zero console.error → every edit-v2 test (`assertNoConsoleErrors`) and integration (console + HTTP ≥ 400).
- **Gap found and ported:** "collapsed by default; section open state persists" had no edit-v2 test. It is now in
  integration ("sections are collapsed by default and their open state survives a reload").

**Shared-lib fixes (the panel agents' requests).**
- `lib.wordSlider`: `cancelDrag()` only acts while a drag is running. The release is watched on `window` (it can land
  outside the input) and clears "dead" after that release's own input/change events. Before, a cancel with no drag
  left the slider ignoring keyboard and programmatic input until the next click on it.
- `lib.createBinder`: `destroy()` drops its `ctx.subscribe` subscription and `onLeaveSong` hook (idempotent). Before,
  every slot body rebuild leaked one subscriber. New `ctl(…, {rels})` option (the shelf sliders).
- ctx `toast(msg, kind, opts)` passes `opts` (`{ms, action}`) through. The harness page's toast takes opts too.
- `lib.ICON_PATHS` gains `edit`, `copy`; new `lib.iconButton(label, icon, onClick, attrs)`. setlist.js uses both
  (its private `LOCAL_ICONS`/`glyph` are gone).
- `lib.droneKeyText` (from drone.js, re-exported there) is used by the shell's default drone tab: "C# minor", not
  "Db minor". `lib.chorusWord` (shell + effects), `lib.TARGET_LABELS` / `lib.BEND_LABELS` (from master.js, re-exported
  there).
- CSS: the shared rules moved from `styles-edit-v2.css` to **`views/edit/base.css`**. `styles-edit-v2.css` is now
  only `@import`s, base first, so panel rules win ties by order. `@layer` was rejected: every unlayered
  `styles.css` rule (e.g. on `button`) would then beat the shared rules. `.ev2 > .ev2-head` no longer clips
  (`overflow: visible`, `z-index: 5`).
- `mountSinglePanel` sets `--c` on `update()` as well as on a remount.
- `components/stepChip.js`: an arrow from an off-step numeric value (a fine-slider 30 %) goes to the nearest step in
  that direction (↑ 50 %, ↓ 25 %). Before, it jumped to an end of the list.
- `styles.css`: `.toggle.on .toggle-led` uses `var(--c, var(--accent))`. Perform's toggles without a `--c` keep
  amber; the drone card already had its own rule.
- `shell._debug.ctx(id)` gives a mounted module's panel ctx (tests).

**Visual fix found in the screenshots.** At 1440 the header song name read "Sunday Pad + Pi…". `field-sizing:
content` sizes the input to its text, but Chromium's scroll width counts the caret, so a name that fits overflows by
1 px and `text-overflow: ellipsis` ate the last letters. The ellipsis now applies only when the name is really
capped (`.long`, set from scrollWidth > clientWidth + 2). The live hint also gives up its width first
(`flex-shrink: 100`).

**Harness and runner** (CONTRACT §7).
- Budget: under `node --test`, `--test-timeout` also bounds the *file*. node:test runs each file as one test, as the
  panel agents reported. Checked on node 22.22: with `--test --test-timeout=2000`, two 1.5 s tests fail as
  "tt.test.mjs timed out"; without `--test` the flag is ignored. So `run.mjs` now passes
  `--test-timeout=900000` = the per-file budget of **900 s** (`EDITV2_FILE_BUDGET_MS`), with the outer
  process-group kill at 960 s. Single tests are bounded by the harness waits.
- The harness `within()` never cleared its 45 s timer, so every file's process stayed alive about 40 s after its last
  test. This is why files took 45–110 s for about 6 s of tests.
- The harness now also accepts "audio running + song loaded" as started. `controller.start()` also awaits MIDI init,
  which headless Chromium sometimes stalls on; that cost a 45 s timeout plus a retry in 2 of 9 baseline files.
- Before: 9 files, 9m 42s on an idle box (bottom 98 s, master 109 s with a retry). After: 10 files (+ integration),
  3m 18s in run-all.
- The harness page exposes `lib` and `C` (no `import()` inside `page.evaluate`).
- `test/run-all.mjs`: `ui-edit` is gone; `edit-v2` (30 min), `settings` (10 min) and `eq` (10 min) were added,
  all in group `phase2`.

**New tests.**
- shell: "integrator fixes" covers the wordSlider cancel (idle / during a drag / after release), binder destroy
  (subscription and hook counts back to 0), the panel-ctx toast opts, the stepChip off-step arrows (0.3 → 0.5 / 0.25),
  droneKeyText, and `--c` on update. The song-switch test checks the header name and the current setlist row (it
  used to wait on the stubs' `data-song-id`, which is vacuous without stubs).
- slot: Warmth writes b1 (`lowshelf`, +6 dB in the engine, the legacy `eq.low` not doubled). Advanced has no
  Highs slider, and the Tone section is lazy (mount on open, destroy on close).
- unit (smart-controls): the `shelf` markers.
- **integration.test.mjs** (11 tests, real app; own server with appDir = app/):
  - boot at 1440 and 1024 with no overflow, zero console errors and zero HTTP ≥ 400; Edit's baseline is Perform's
    snapshot
  - the KEY / BPM / Notes chips focus a select / input / textarea in song-key / song-tempo / song-notes
  - a header rename updates the setlist row and Perform
  - a held C4 still sounds after visiting all 7 tabs
  - Show wiring: values = round(sends × 100), a lane button → Effects {focus}, the store is untouched
  - Tone: lazy mount; two double-taps write b2 and b3 with all 5 rows, b1 migrated to lowshelf; 12 × ↑ → b3
    +6 dB; `getEqResponse` at b3's Hz is within 0.5 dB of +6; the sparkline appears; Warmth then moves b1
  - 4 song switches with Tone open: 4 created / 4 destroyed, 1 live editor, store subscriptions unchanged, and
    closing Advanced unsubscribes
  - Perform ⇄ Edit: the changed-path sets are equal at every step (1, then 2 changes, then 0 after leaving Edit);
    Revert shows 1 and then 0
  - Perform's "+" opens Edit on that slot with the menu open
  - sections are closed by default and their open state survives a reload
  - "nothing lost": the 53 PARAMS addresses the factory songs use (slot fields, fx, master, drone, wheels/bend/swell,
    key fields) are all bound within 2 clicks; none are missing and none need 3 clicks. Slot `eq.*` rows are
    allowed unbound because the Tone editor has no data-bind; no factory song uses them today.

**Results.**
- `node test/phase2/edit-v2/run.mjs`: 10/10 files, 75 tests.
- `node test/phase2/settings/run.mjs`: 26/26.
- `node test/phase2/eq/run.mjs`: 22/22.
- `node test/run-all.mjs --skip soak`: 10/12. Both failures are flaky tests owned elsewhere; neither passed or failed
  because of this change:
  - engine `offline.masterEqGlue`: `neverDiff` 2.26e-6 against a 2e-6 limit. Chromium sums in hash order, so run to
    run the diff moves by about 1e-6 (CLAUDE.md). Re-runs: FAIL, PASS, PASS. The limit should be about 1e-5.
  - ui-core "Quick sheet: TAP": 4 Playwright clicks 500 ms apart gave 106 BPM (limit 120 ± 12). The whole-suite
    re-run gave 39/39, and 3 isolated runs gave 2 passes and 1 fail. It measured the same without the Edit view: a
    tempo write costs a median 5.3 ms with Edit mounted and 5.7 ms without it, and the only rAF loop in Perform is
    the top-bar meter. Playwright's per-click actionability overhead is what the interval absorbs.

**Left open.**
- Prune the dead `.ed-*` rules from `styles-edit.css`.
- The effects request to fix `.step-panel .sp-fine` in styles.css (the vertical fine slider is 44 px tall in a
  step panel, Perform included). effects.css works around it under `.ev2-fx-sphost`. Not done: it changes Perform.
- The effects request for a `stepChip({placement})` option. Not done.
- The song request for `createBinder` `text:'dirty'` (song.js keeps its local flag). Not done.
- The wiring lane button ellipsizes "Echo song's o…" at 1440; the mockup fits "song's own".
- The slot fader has no level meter beside it; the mockup has one.

## flaky-tolerances (orchestrator)
- engine `offline.masterEqGlue`: identity/bypass diff limits 2e-6 → 1e-5 (Chromium run-to-run noise; CLAUDE.md caveat).
- ui-core Quick sheet TAP: tolerance ±12 → ±20 BPM (Playwright click overhead under load measured 106 BPM for 500 ms taps).

## round3-edit (reviews/round3-edit.md M1–M3, m1–m4; views/edit/** / components/{overlay,stepChip,stepPanel}.js / edit-v2 + ui-core component tests)

**Fixed.**
- **M1** `components/overlay.js`: `onKey` / `onPointerDown` first close (reason `'hidden'`) every entry whose element
  is disconnected or inside a `[hidden]` ancestor, then act only on a visible top entry; nothing invisible eats Esc
  (= Panic) or a tap. New export `closeOverlaysWithin(root, reason='hidden')` (not re-exported from
  `components/index.js`; the shell imports overlay.js directly). `shell.js` watches `settings.view` leaving `'edit'`,
  runs the new `ctx.onLeaveView(fn)` hooks and closes every overlay inside the view. slot.js closes its chips there.
- **M2** `slot.js` `onLeaveSong` closes its step chips. `stepPanel.cancelDrag()` (forwards to the fine fader) and
  `stepChip.cancelDrag()` (cancels the fine drag, then closes the panel) exist, so `binder.cancelDrags()` covers
  every tracked chip on a song switch.
- **M3** `effects.js`: Space gets a **Song’s own** chip (hint = the saved room's size word), shown when the
  baseline's room matches no preset. Space and Echo "Song’s own" now write the baseline's whole `patch.fx.<unit>`
  as one store change (per key only when the baseline lacks the object).
- **m1** `slot.js` `shelfDb` reads 0 dB for a shelf the Tone editor switched off; the Tone hint says moving
  Brightness/Warmth switches its shelf back on.
- **m2** `lib.changeText(n, edited)`: `0` → "No switch changes since the song was loaded", or "Sound edited (no
  switch changes)" when `lib.editedSince(song, baseline, prefixes, omit)` finds a non-counted edit (slot: levels and
  mutes omitted; drone: gain and the ON tile's mode omitted). Slot, Effects, Drone and Master use it (Master now also
  re-renders its line on store changes). The rig hint reads "…means a switch changed since the song was loaded."
- **m3** `slot.js`: an instrument change shows an 8 s "Keys is now <name>." toast with Undo, restoring the captured
  `instrument` + `params` through `songs.<id>.patch.slots.<i>` (refuses when the slot has moved on).
- **m4** The shell core keeps the drone's last-off source (`ctx.lastDroneSource.get()/set(mode)`), cleared on a song
  change; drone.js uses it (a per-mount map remains as a fallback), so a tab switch no longer forgets it.

**Requests (outside this scope).**
- eq-ui (`shared/eq-math.js`): one `shelfTarget(eq, which)` shared by read and write. `shelfWrites` still targets an
  off shelf and silently sets `on:true`; Edit now displays it as 0 dB and says so in the Tone hint.
- perform.js: `lastDroneSource` is still Perform's own; Edit's lives in the shell core. Sharing one memory needs a
  controller field or a main.js ctx hook both views read (m4's second half).
- perform.js (optional): close its chips/key popover when `settings.view` leaves `'perform'`; overlay.js's hidden
  pruning already makes a left-open panel harmless. Perform's Space own-chip visibility already follows the
  snapshot re-taken on leaving Edit (`renderSong` → `renderPresets`), so no change is needed there.

**Tests.** edit-v2: `integration` (Edit chip open → Ctrl+E → first Esc panics, first Perform tap opens; the reverse
direction; `[hidden]` pruning), `slot` (fine drag across `selectSong`; off-shelf 0 dB; "Sound edited"; instrument
Undo), `effects` (Space own: one write, restores {.62, .5, .025, 1}, echo untouched; shown iff the baseline room is
custom), `drone` (source kept across a remount, forgotten on a song change), `master` (copy). ui-core
`components.hv2.mjs`: hidden-overlay Esc/tap + `closeOverlaysWithin`; `stepChip.cancelDrag()`.

## round3-eq (reviews/round3-eq.md M1–M2, m1–m5; engine fx.js + audio.js EQ / shared/eq-math.js / components/eq-keyboard.js / eq tests)

**Engine.**
- M1: `fx.Coalescer.cancelAll(pred?)` drops pending (unflushed) writes; their armed timer callbacks find no entry.
  `engine.commit()` calls it for song-state keys (`slots.*`, `fx.*`, `master.*`; `wheels`/`bend` read live state and
  stay) before the slot loop, so `applyState`/`restart` are covered too; `_teardown()` drops everything. The slot EQ
  closure also resolves the slot's cfg and channel when it fires, not when it was queued. Test `offline.eqCoalesceSongSwitch`
  (two quick writes each to `eq.b2.*` and `gain`, then a same-instrument prepare+commit before the flush): the live
  b2 is off and the fader is at 0.8, matching cfg and the store. Without the commit cancel, the fader stays at 0.05.
- m4: `_teardown()` clears `_eqShadow`, so restart/dispose release the old context's shadow biquads and their sample
  rate. Test `offline.eqShadowTeardown`.
- m5 (engine half): **new `engine.eqAudition(slotIndex, 'bypass'|'on', {when}?) → boolean`** (DECISION §3). Bypass
  plays the slot through a flat EQ (`strip.setEq({})`, click-free through SlotEq's crossfade). It is engine state
  only and never persisted. EQ writes while bypassed update cfg but stay unheard, and `commit()` ends every bypass.
  An invalid slot returns `false`. `eqKeyboard` feature-detects it, so A/B now runs in `'engine'` mode and the store
  fallback (with its autosave risk) is no longer used with the real engine. Test `offline.eqAuditionBypass` renders
  on +11.0 dB, bypass 0.0 dB (flat reference 0.0), back on +5.6 dB after a +6 write while bypassed. It detects 0
  clicks, the stored value stays 6, and a commit ends the bypass.

**eq-keyboard.**
- M2: the editor tracks the song it shows (`debug().songId`). When `store.currentSong().id` changes (seen in
  `refresh()`, which follows the store), it cancels the drag, pinch and double-tap, reverts and blurs a focused cell
  (its change event is ignored), runs `leaveAB()` (restoring to the old song), and resets the selection and the rows.
  `commit()` also refuses a write when the current song is not the one shown, which catches a write that lands
  before the store's microtask notify. No host change is needed. `update()` still works as a nudge.
- m1: plot keydown ignores Ctrl/⌘ chords (the browser and app keep zoom reset, ⌘O and so on). While the plot has
  focus it always `preventDefault`s the arrows, including with no bands or with a cut selected (↑/↓ on a cut do
  nothing). After a row ✕, focus moves to the neighbour's ✕, or to the plot if there is none.
- m2: the frame loop stops while the editor is detached or has no size (`raf = 0`), and `resize()` from the
  ResizeObserver restarts it through `kick()`, as does `update()`. With no ResizeObserver, it polls as before.
  `debug()` adds `resizes`.

**eq-math `parseForeign` (m3).**
- Decimal commas become points (`63,5 Hz`, `Q 4,32`) unless the line already uses points. `1,000 Hz` and
  `12,500 Hz` are read as thousands separators. Either reading adds a note to the line.
- REW "Filter Settings file" header lines are dropped silently, and `Filter n: ON None` is recognised after the
  on/off strip.
- A skipped extra band gives its own rank ("a 9th band", "a 10th band").
- A band needs a filter keyword, `Fc`, or a line that starts with its frequency. Prose that only mentions Hz or dB
  is not a band. Non-filter lines collapse into one "not a filter line (and n more like it)" row.
- Unit test: `paste (round3-eq m3)`.

**Tests.** The eq suite has 3 new browser tests:
- Same-instrument switch mid-drag on b8, mid-typing and in B. Song B is untouched, and A keeps its value from the
  switch. Without the fix, "song B untouched by the drag" fails.
- Plot keys.
- Hidden editor.

Each of these fails with its fix removed. Results: `node test/phase2/eq/run.mjs` 25/25, `npm run test:unit` 276/276,
`node test/phase1/shell/run.mjs --only unit` all passed. In `node test/phase1/engine/run.mjs` at load average 11 on
2 CPUs, 67/68 passed. The failure was `eqCpu`, a timing test: its plain-biquad reference was noisy, 550 against 510
with none. It failed once more in isolation, then passed at load 13 (EQ with all ten filters 3.6 %). The fixes don't
touch that path.

**Requests for other owners.**
- **controller.js** (m5, repeats eq-build): add null-safe pass-throughs `getEqResponse(i, freqs, opts)`,
  `getSlotPlayRange(i)` and `eqAudition(i, mode)`, which calls `engine.eqAudition` when present. `eqKeyboard` picks
  them up with no change, and then no view calls the engine for EQ except `engine.ctx` and `analyserL/R`.
- **views/edit/panels/slot.js** (M2): optional. `ctx.onLeaveSong(() => toneEq?.update())` is harmless, but it isn't
  needed, because the component is song-aware now.
- **test/phase2/edit-v2/integration.test.mjs** (M2): add the real-app case with the same instrument in both songs,
  Tone open, and `selectSong` mid-drag, then assert song B is unchanged. The eq suite covers the component with the
  real store and controller.

## l3 (controller.js: start() no longer waits for Web MIDI; reviews/local-findings.md L-3)
- **Why.** `startPrimary()` ended with `await midiReady`, and `MidiInput.init()` awaits `navigator.requestMIDIAccess`
  with no timeout. So `controller.start()`, and with it `window.__rig.ready`, never settled while Chrome's MIDI
  permission prompt was unanswered, or when the first request stuck on a Mac with CoreMIDI inputs and a `midi-sysex`
  grant (local measured 30 s+ pending while `status.ready` was already true).
- **start() / `window.__rig.ready`** now resolve once audio and the current song are up: the same steps as before,
  minus the final MIDI await. main.js is unchanged: `__rig.ready` is still the `controller.start()` promise, so it
  picks up the new meaning. MIDI init still starts in the same place, before the pads and song load, and runs
  concurrently.
- **MIDI reports through `status.midi` and the `'status'` event.**
  - New field `status.midi.pending` (boolean, default false).
  - After `midiInitTimeoutMs` (new controller option, default 5000; `0` disables it) without an answer:
    `{available:false, connected:false, reason:'pending', pending:true}`. The request is not cancelled.
  - A late grant: `MidiInput.init()` attaches ports, and the controller then runs `midi.select(settings.midiInputId,
    name)` exactly as before. The `'devices'` handler now clears `reason` (→ null) and `pending` whenever
    `available` is true. Previously a successful init carried the old `reason` forward.
  - A late denial: `'unavailable'` sets `reason` to 'denied', 'failed' or 'unsupported' and `pending:false`.
- **New `controller.midiReady()`** returns `Promise<boolean>`: it settles when the current init has an answer
  (true = access granted and the input selected). It can stay pending indefinitely, so bound any wait on it.
- **dispose()** drops the soft timer and bumps a generation counter. A late answer to a disposed start no longer
  calls `select()` and never reaches status or the engine; the controller's MIDI listeners were already removed.
  `MidiInput.init()` itself still attaches its default ('first') pick on the MidiInput object.
- **UI follow-up (cloud-owned files, not changed here).** Measured in the real app with a `requestMIDIAccess` that
  never answers:
  - `main.js` status handler (~line 548): `'pending'` falls into the else branch and toasts "MIDI could not start.
    Unplug and replug the keyboard, then reload." at t≈6.4 s. It also sets `midiHintShown`, which suppresses a later
    'denied' toast.
  - `views/settings.js` (~line 910) shows "MIDI isn't available — allow MIDI in the address bar (or plug the keyboard
    in), then reload." In Chrome the user only has to answer the prompt. A reload is wrong advice.
  - Suggested fix: treat `m.pending` like "starting". In main.js, skip the toast and don't set `midiHintShown`
    (optionally toast "Waiting for MIDI permission — click Allow in Chrome's prompt"). In settings.js, map `pending`
    to "Waiting for MIDI…". The Electron app (which grants midiSysex itself) is unaffected unless CoreMIDI stalls.
- **Tests.**
  - `test/phase1/shell/midi-l3.test.mjs` (8 tests, node, fake navigator/timers): start() < 1 s with a
    never-answering request; a single 5 s soft timer → pending; a late answer after the timeout selects the
    explicitly chosen port (not the higher-ranked one), wires `onmidimessage` and a note reaches `engine.noteOn`; a
    late answer before the timeout never shows pending; `_inject` plays while pending; pending → denied; unsupported;
    dispose while pending; real timers at 40 ms.
  - `browser.pw.mjs`, last test: the real app in Chromium with a never-answering `requestMIDIAccess`.
    `__rig.ready` resolved after 14.3 s (song load on this 2-CPU box), status went `'pending'`, and a late fake
    access with one port gave `connected:true`, `reason:null`, a wired `onmidimessage` and `midi-activity` from
    `kb`.
  - Shell: unit 148/148, browser 13/13, electron 14/14.

## l3-l4-merge (tests: L-4 bounded waits + midi-only grants; local L-1/L-2 pulled into the cloud tree)
- **L-4.** `test/integration/lib.mjs` gains two exports:
  - `MIDI_PERMISSIONS = ['midi']`.
  - `waitRigReady(page, {timeout = 30000, what})`: waits for `window.__rig` and then `__rig.ready` within the bound,
    plus a Node-side guard against a hung renderer. It throws `"<what> did not resolve within N ms;
    controller.status.midi={…} audio=… ready=… songId=…"`. Verified against a never-resolving page: it threw after
    1507 ms (timeout 1500).

  Suites that use them:
  - `edit-v2/harness.mjs`: grants `midi` only. The 45 s race of `__rig.ready` against "song loaded" (a workaround
    that hid a stuck start()) is replaced by `waitRigReady(30 s)`, and the unused `within()` helper is removed.
  - `settings/run.mjs` and `eq/run.mjs`: grant `midi` only (eq keeps the clipboard grants) and use
    `waitRigReady(30 s)`.
  - `integration/electron-full.mjs`: the in-page probe bounds `__rig.ready` and `viewsReady` to 30 s each, and the
    error carries `status.midi`.

  Why sysex is not granted is documented in test/README.md ("Web MIDI in the browser suites"). Not changed here (other
  owners): `edit-v2/integration.test.mjs:96` still grants `midi-sysex`; `soak.mjs:333` and
  `smoke-chrome-fallback.mjs:88` still await `__rig.ready` without a bound.
- **L-1 / L-2, from the public repo @ main (local commits db41087 and 7e2439d).**
  - Each file was diffed against the cloud copy and patched hunk by hunk. The result is byte-identical to the local
    versions of `lib.mjs` (`electronEnv()`), `electron-full.mjs`, `build-lint.mjs` (`--mac dir` on darwin, asar
    under `<productName>.app/Contents/Resources`, `electronEnv()` for the build and the packaged boot) and
    `phase1/shell/electron.boot.mjs`.
  - The cloud integrator's earlier build-lint change was already on main, so the only differences were the L-1/L-2
    hunks and nothing was lost.
  - `test/README.md`: only the build-lint row. The ui-edit rows on main are stale; the cloud's edit-v2, settings and
    eq rows stay.
- **Linux results after the merge** (2 CPUs, load average 9–15 from a concurrent workflow):
  - `node test/phase1/shell/run.mjs`: PASS. Unit 148, browser 13, electron 14.
  - `ELECTRON_RUN_AS_NODE=1 node test/run-all.mjs --only build-lint,electron-full`: PASS 2/2. build-lint 26/26,
    electron-full 28/28.
  - After the probe bound was added, electron-full failed once at 26/28: "recording is not silent" (RMS −47.9 dBFS)
    and "take ≈1 s" (1.779 s), at load average 14.9. It re-ran at 28/28. That is a timing flake under load, not the
    change.
  - `node test/run-all.mjs --only settings,eq,edit-v2`: PASS 3/3. edit-v2 79/0 (468 s), settings 26/26, eq 25/25.

## polish-1 (hv2-edit-integrate leftovers; engine audio.js slotLevel / controller.js 1 pass-through / components levelMeter + stepChip / styles.css / styles-edit.css / views/edit/** / main.js + settings.js MIDI pending / tests)

Store schema and PARAMS are unchanged. There are two new read-only APIs: `engine.slotLevel` and `controller.slotLevel`.

**1. Wiring label.** The lane buttons now span the Effects and Master columns (`grid-column: 7 / 9`). "to Master"
has a fixed width (`--ev2-wout-w: 88px`, `justify-self: end`), and the button is padded clear of it. Before,
"Echo song’s own" got 141 px against the 145 px it needed at 1440, and at 1280 or narrower all three labels were
ellipsized. Now none of them is clipped at 1440, 1280, 1100 or 1024. The integration "Show wiring" test asserts
no ellipsis and no overlap with "to Master" at 1440 and 1024.

**2. Per-slot level meters.**
- New `engine.slotLevel(i)`, returning `{peak, rms}` (linear) for a slot. It returns zeros for an empty slot, and
  null for a bad index or before start().
  - The tap is one `AnalyserNode` per slot (fftSize 256, smoothing 0, stereo downmixed to mono), created on the
    first read and fed from the strip's `pan` output (post fader/wheel/width/EQ/pan: what the slot sends to Master).
  - A new strip (song switch) is tapped on its next read. An outgoing strip stays tapped until its dispose()
    disconnects it.
  - The tap is disconnected `SLOT_TAP_IDLE_SEC` = 2 s after the last read. The release runs on the engine's
    `AudioTimer`, so there is no setTimeout.
  - `_teardown()` drops the taps.
  - `engine.slotTapCount()` is a test hook.
  - A just-connected analyser reads zeros until it has run once, so a meter shows the level one frame later.
- New `controller.slotLevel(i)` pass-through. It is null-safe and silent (no warning; it is read every frame).
- New `components/levelMeter.js` `levelMeter({read, label})`: a 4 px bar placed in a vertical fader's `.fader-track`
  (absolute, `pointer-events: none`), so the fader throw and hit area are unchanged.
  - It uses a fast attack and about 20 dB/s release, as the top-bar meter does, and `.hot` above −3 dBFS.
  - One shared rAF loop runs only the meters an IntersectionObserver reports as on screen, and it makes no DOM
    writes while the level is steady.
- Perform strips (`slot-level-<i>`) and Edit's ON STAGE fader (`ev2-slot-level-<i>`, at the right edge of the
  64 px column, as the mockup's `.act`) read `controller.slotLevel(i)`.
- **CPU:** hidden Perform strips (Edit or Settings showing), empty strips and unmounted Edit panels are never read,
  so their taps are disconnected within 2 s.
  - Measured in ui-core: 1 read per frame per filled strip in Perform, and 0 in Edit on Effects.
  - `slotTapCount()` goes from ≥ 2 to 0 within 2 s, then back to ≥ 1 on return.
- Tests:
  - engine `offline.slotLevelTap`: lazy creation, no tap for an empty slot, a gain 0.1 slot reads 0.023 against 0.229,
    released 2 s after the last read (not the first), a new strip tapped after a commit, taps cleared by teardown.
  - ui-core "polish-1: strip level meters…" (geometry, reads per frame, idle release).
  - edit-v2 slot "polish-1 — a level meter…" (in the column, it moves on a note, only the shown slot is read,
    slot 1's tap idles out).

**3. Dead `.ed-*` CSS.**
- `styles-edit.css` went from 371 to 134 lines. 237 selectors were removed: every selector naming a class that no
  app JS/HTML produces (the bare `.ed` and every `.ed-*` except `.ed-btn/.ed-danger/.ed-select`, which settings.js
  uses), including the `:where(.ed …)` mini-keyboard rules and `@keyframes ed-flash`. Mixed selector lists kept
  their live halves (`.ed-h2, .st-h2` → `.st-h2`).
- `var(--ed-faint)` → `var(--faint)` (the same #8a93a0).
- DOM audit over the real app, run before the prune:
  - What was exercised: Perform + Quick + a step panel; Edit with every block, every `<details>` open and wiring on;
    Settings with everything open at 1440 and 1024.
  - What matched: only `.ed-btn`, `.ed-btn:hover/:active`, `.ed-select`, `.ed-select:focus`,
    `.st-inline .ed-select` and `.st-learn-btns .ed-btn`. All of them are kept, and none of the removed selectors
    matched.
  - The unmatched `.st-*` rules (conditional: pedal test, learn, restore) and the `.fc-*` rules (fallback components)
    stay.
- Settings screenshots were checked. The settings suite asserts that the sheet names exactly those three `.ed-*`
  classes and that a Settings `.ed-btn` keeps its styling.

**4. Step-panel fine slider** (styles.css):
- Rules: `.step-panel .sp-body { grid-template-rows: minmax(0, 1fr) }`,
  `.sp-fine { --thumb-w: 26px; --thumb-l: 16px; height: 100%; overflow: hidden }` and
  `.sp-fine .fader-input { height: 100% }`.
- The thumb is 26 × 16, as in the mockup (perform-step `.fine`). The drag is relative, so the whole column is the
  hit area.
- Before, `.fader.compact .fader-input { height: 44px }` won, and the slider rendered 44 px tall with a 44 × 32
  thumb.
- Measured on the Perform Echo panel: 290 px at 1440 and 202 px at 1024, filling `.sp-body`. The chips stay 46 px
  at 1440 and 44 px at 1024.
- effects.css's `.ev2-fx-sphost` workaround is removed.
- Tests: ui-core strip-chip test (spans the body, starts below the ×, chip ≥ 44 px) and components.hv2.

**5. `stepChip({placement:'auto', placementNeed?})`.**
- The panel opens `down` (below the chip, arrow on top, `--sp-top`) when the host has need + 10 px below the chip.
  Otherwise it opens `up` when there is that much room above, else `cover`.
- need defaults to 290 px, or 220 px at ≤ 1250 px.
- The panel carries `data-dir`, and the CSS is in styles.css. The default placement is unchanged (`up`, Perform).
- The decision logic is exported as `placementDir(hostRect, chipRect, need)`.
- effects.js passes `mount: sphost, placement: 'auto'`; its `placePanel()` and the `[data-dir]` rules in
  effects.css are gone.
- Tests:
  - components.hv2 "stepChip placement:auto": down, up and cover in hosts of 420 and 260 px; the legacy chip
    stays `up`.
  - The effects step-panel test asserts the panel is below or above its chip (never over it) or covers the column.

**6. `createBinder` `text:'dirty'`.**
- Behaviour: a focused field follows outside writes until an `input` event. The draft is then kept until `change`
  or `focusout`; a `focusout` with a held-back write re-applies the store value.
- The listeners are capture-phase, so the panel's own change handler (commit) already sees a clean field. They are
  removed by `destroy()`.
- Used by Song › tempo (song.js's private `tempoDirty` flag is gone), Song › notes, and the header song name. All
  three were `text:true` or the local flag before.
- `CONTRACT.md` §3.4 documents it.
- Tests:
  - song "polish-1 text:"dirty"": tempo follows 88 while focused, keeps a typed "13" over an outside 99, and Enter
    commits 132; notes follow while focused and the draft stays.
  - song-header: the name follows an outside rename, keeps "…!" over another, and Esc gives the stored name.

**7. Local findings.**
- `reviews/local-findings.md` (the Mac run): L-1, L-2 and L-4 are already merged, and the L-3 fix is in "## l3".
  Its UI follow-up was the only small UI item and is done here:
  - main.js: `status.midi.pending` (or `reason:'pending'`) shows an amber lamp and "Waiting…", with the title
    "Waiting for MIDI permission" and one info toast (Chrome: "…click Allow in Chrome’s prompt…"; Electron: "MIDI is
    taking a while to start…").
  - main.js: there is no "could not start… reload" toast, and `midiHintShown` is not consumed, so a later denial
    still toasts.
  - Settings › MIDI now reads "Waiting for MIDI permission — if Chrome shows a prompt, click Allow." (no reload).
  - Tests: ui-core "polish-1 (local L-3)" and settings "MIDI pending" (both modes).
- `edit-v2/integration.test.mjs` grants `MIDI_PERMISSIONS` ('midi' only, L-4); it granted `midi-sysex` before.
  `reviews/local-findings-cloud-response.md` has an "Update (polish-1)" section.
- Also fixed: a garbled comment in `components/index.js` (the eqKeyboard line had swallowed the openOverlay line).

**Results** (2 CPUs, load average 0.2–4):

| Suite | Result |
|---|---|
| `node test/phase1/engine/run.mjs` | 69/69, 0 soft warnings, 0 console errors |
| `node test/phase2/edit-v2/run.mjs` | 10/10 files, 82 tests (integration re-run 12/12 after the grant change) |
| `node test/phase2/ui-core/run.mjs` | 41/41 |
| `node --test test/phase2/ui-core/components.hv2.mjs` | all pass |
| `node test/phase2/settings/run.mjs` | 29/29 |
| `npm run test:unit` | 276/276 |
| shell | unit + browser pass |

Also `node test/phase2/eq/run.mjs`: 25/25. Not run: Electron, soak.

## l8 (controller.js pin window; reviews/local-findings.md L-8)
- **Why.** The Mac soak (tree 3a69692, `large-set` for the whole run) pinned 754.2 MB on `gospel-stab-b3` and
  939.4 MB on `upright-pad` against the 700 MB cap. Pinned buffers can't be evicted, so decoded was 100 % pinned.
  - The ±2 window was a song count. Around the two heavy sampled songs it summed past the budget: 754 = anthem
    (Salamander) + upright, and 939 = that + clav-funk + music-box.
  - The other suspect, an old window left pinned during a switch, doesn't hold. `engine.preload(…, {pin:'replace'})`
    is already one `BufferCache.setPins` before and after the decode, and the stale-replace re-apply (morning-prep)
    covers out-of-order completion. The byte budget is the fix. The atomicity is now pinned by a test.
- **Window = byte budget** (`planWindow` / `pinWindow`, library ±1 and large-set ±2; `LIBRARY_PIN_RADIUS` and
  `LARGE_SET_PIN_RADIUS` stay as count limits):
  - Candidates are the current song, then neighbours by distance: +1, −1, +2, −2 (next before previous).
  - The current song is always pinned.
  - A neighbour joins only while `engine.estimatePreloadMB([...chosen, id]).mb ≤ PIN_BUDGET_MB` (600). Shared
    samples are counted once. A neighbour that doesn't fit is skipped, and a farther, lighter one may still join.
  - One `{pin:'replace'}` per switch applies the plan, so the old window is unpinned in the same `setPins` call.
- **Guessed sizes.** A neighbour never decoded before is priced by `BufferCache.estimateBytes` at a folder mean or
  1.75 MB per sample, so the estimate can be low.
  - The first plan (`onlyExact`) pins the current song plus the neighbours whose size is exact. Songs with no
    sampler are exact at 0 MB.
  - The guessed neighbours are decoded with `{pin:'none'}`, and the window is planned again with exact sizes, then
    replaced.
  - So an under-estimate can't pin past the budget. `winSeq` drops an older plan once a newer switch has started.
- **The current song alone over the budget.** It is pinned alone with a replace, which unpins everything else.
  - `status.memory.note = songAloneNote(mb)` = `"This song alone is X MB"` (exported). It takes precedence over
    `LARGE_SET_NOTE`.
  - One `'memory'` event per song fires: `{mode, note, songMB}`.
- **Cap assert.**
  - `updateMemory()` runs after every preload and on the 1 s tick.
  - It warns (the `'warn'` event plus `console.warn`, never a throw) when `_debugStats().pinnedMB > capMB`:
    `pinned samples X MB exceed the 700 MB cache cap (<mode>, N songs pinned[; This song alone…]; L-8)`.
  - It warns once per crossing, not every tick.
- **Other changes.**
  - Large-set warming now skips the songs actually pinned (`pinPlan.ids`) instead of the whole ±2 range. A heavy
    neighbour left out of the window is warmed unpinned, nearest first, while the 80 % cap share allows.
  - Setlist mode (a set ≤ 600 MB pinned whole, neighbours `'add'`) is unchanged. So is start()'s first neighbour
    `'add'` from before `preloadSetlist()` picks the policy: `controller.test.mjs` pins it, and the replace that
    follows drops it.
- **`status.memory`** = `{mode, decodedMB, pinnedMB, capMB, budgetMB, setMB, windowMB, pinnedSongs, note}`.
  - `budgetMB` = `PIN_BUDGET_MB`.
  - `windowMB` is the plan's estimate. `pinnedSongs` is the window's song count. Both are null in setlist mode and
    with no estimate.
  - Engine without `estimatePreloadMB`: the pre-L-8 count window, as before.
- **Engine/sampler.** No change. `setPins`/`pin`/`unpin` and `estimatePreloadMB` were enough.
- **Soak** (`test/integration/soak.mjs`):
  - New `budgetMB` column; the row also carries `memNote`.
  - The check "decoded samples stay under the engine cache cap (pins limited)" now also requires
    `pinnedMB ≤ budgetMB` in every row, unless the note says "alone". Its detail names the max pinned MB and the
    song.
- **Tests.** `test/phase1/shell/memory.test.mjs` goes from 9 to 14 tests.
  - Fake engine `instrEngine`, priced per sampler instrument from the soak's numbers: Salamander 333, upright 421,
    Rhodes 93, clav 48, Wurli 47, music box 45, celesta 45 MB.
  - A 44-switch walk (bouncing through the 19-song My Set) in large-set and in library mode:
    - pinned ≤ 600 at every step, and in every intermediate engine pin state;
    - the current song is always pinned, and nothing outside ±radius is;
    - no `'add'`;
    - gospel-stab and upright-pad each pin 516 MB (upright + clav-funk; Salamander and music-box are left out).
  - Against the previous controller the walk fails at "pinned 754 MB > 600" in both modes. That reproduces L-8.
  - A jump sequence: every pin state during a switch is a subset of the new window.
  - An oversized song (upright at 812 MB) is pinned alone, with the note, one 'memory' event and exactly one
    cap warn. Moving away drops it from the pins, restores `LARGE_SET_NOTE` and doesn't warn again.
  - Warm-then-pin order for never-decoded neighbours: clav-funk pins 185 MB, and upright is left out.
  - Existing tests: the fake's `exact` is now true once a song was preloaded. The status deepEqual has the new
    fields. The large-set warm-order test ignores the window's guessed-neighbour warm. The slow-replace race test
    accepts that a superseded plan never reaches `engine.preload`.
- **Results (Linux, 2 CPUs).**

  | run | result |
  |---|---|
  | `node test/phase1/shell/run.mjs --only unit` | 153/153 |
  | `node test/phase1/engine/run.mjs pins` | 2/2 (`offline.pinsUnion`, `offline.pinsLimitedEvict`) |
  | `node test/integration/soak.mjs --minutes 3 --sample-sec 15` | 12/12 |

  - In the soak, the max pinned was 568.9 MB, on anthem. On Linux, Salamander decodes to 332.9 MB.
  - Decoded was ≤ 696.3 MB against the 700 MB cap. Every row had pinned ≤ 600.
  - Here the anthem window was Salamander + upright, so upright decodes to ≈ 236 MB on Linux. The Mac numbers imply
    ≈ 421 MB (754 − 333), but that is not verified: it may be a different context rate or a different sample set.
    The fix doesn't depend on the sizes. The Mac soak is the real check.

## polish-2B (reviews/ux-round2.md #4, #5, L1, §5 Edit rows; views/edit/** / components/eq-keyboard.{js,css} / edit-v2 + eq tests)

Store schema, PARAMS and the controller API are unchanged. New exports: `lib.spaceNoun(sp)`,
`eq-keyboard.COMPACT_BELOW_PX` (1080) and `toneSummary(eq)`, and an `eqKeyboard({compactBelowHeight})` option.
`debug().airLabels` is a test hook.

**1. Effects preset chips (#4).**
- `.ev2-fx-pc` is `flex: 1 0 auto`, so a chip never shrinks below its words. The row wraps instead of ellipsizing.
  "Song’s own" keeps its natural width (`flex-grow: 0`), so on its own row it stays a chip, not a banner.
- At 1251–1480 px the columns narrow: title 262 → 214, who-goes-in 250 → 228, gap 24 → 18. Chip padding is 8 px.
- At 1251–1480 px × ≤ 820 px tall, chips are 40 px (Edit is desk use).
- effects.js passes `placementNeed` to the who-goes-in stepChips: 290 at ≤ 1250 px, else 340. The measured panel
  minimum is 38 head + 5 × 44 steps + gaps + padding = 287 at 1024. With stepChip's default of 220, the chorus panel
  opened 'down' into 224 px at 1024×700 and its last two steps hung out of the panel. That was latent: it showed up
  once the bottom-bar change below gave the body 3 px more.

| Size | Before (the review; measured) | After |
|---|---|---|
| 1024×700 | 3-column grid, fine | 3 rows (Space) / 2 rows (Echo), whole words |
| 1280×800 | every chip ellipsized (Dry 24>14 … Ambient Wash 97>52, Song’s own 78>42) | 2 rows in 472 px, whole words, narrowest chip 51 px |
| 1366×768 | 13 chips ellipsized (Room 40>30, Song’s own 78>60 …) | 1 row in 558 px |
| 1440×860 | 4 ellipsized (Room 40>38, Cathedral 65>62, Ambient Wash 97>93, Song’s own 78>75) | 1 row in 632 px |
| 1512×900 | fit | 1 row in 622 px |

**2. One vocabulary (#5).** The effect is **Space**, and a room that matches no preset is **the song’s own**.

| Where | Before | After |
|---|---|---|
| Effects tab summary | Custom · echo: own | Song’s own · echo: song’s own |
| Wiring lane | Space custom | Space song’s own |
| Vibe button (no match) | Vibe: Custom | Vibe: your own mix (the mockup's words) |
| Effects sentence and Space line | The room is … | The Space is … |
| Space blurb | A room saved with this song… | The Space this song was saved with… |
| Slot sentence, custom room | a little into the Space | a little into the song’s own Space |
| Slot sentence, Dry | a little into the Dry | a little into the dry Space |
| Space chip / step-panel hint | goes into the Space (Hall) | goes into the Hall / the song’s own Space |
| Master footer link | Room, echo and chorus are on the Effects tab | Space, Echo and Chorus are on the Effects tab |
| Wheels & pedal targets | Reverb level; Intensity (… reverb …); Wash (reverb size …) | Space level; Intensity (… Space …); Wash (Space size …) |
| Tone summary (slot Advanced, EQ header, mini-curve label) | Custom · n bands | Shaped · n bands |

- `lib.spaceNoun(sp)` builds the Space word used after "into the": the preset name, "dry Space", or "song’s own
  Space".
- "Custom · n bands" comes from `eq-math.eqSummary`. slot.js and `eq-keyboard.toneSummary` map it to "Shaped", and
  eq-math itself is unchanged (see the requests below).
- Audit: a grep over my files, plus a DOM audit of every visible string in `#view-edit` (text, `<option>`, `title`,
  `aria-label`, `placeholder`). The audit covers every tab with every section open (Tone mounted, a shaped EQ), a
  tweaked room, the Vibe menu, a Space step panel, wiring, and Master › Wheels & pedal.
- "Room" remains only as the Space preset's name.

**3. Intermediate widths (L1).** Measured on every tab (8 blocks) plus wiring, the Tone EQ and the chip rows.

| Size | Before: ellipsized / clipped (examples) | After |
|---|---|---|
| 1280×800 | tab "Custom · echo: own" 129>97; "−6.0 dB · Tape off" 113>97; Effects sentence 880>739; header hint 4 lines in 56 px (114>56); "Response · how it answers …" 247>191; Fine-tune summaries | 0 |
| 1366×768 | tabs 129>109 and 113>109; sentence 880>825; Response hint | 0 |
| 1440×860 | tab 129>119; Response hint | 0 |
| 1512×900 | Response hint | 0 |
| 1024×700 | 0 | 0 |

The fixes:
- **Tab summaries.** A tab whose name and sub don't fit on one line drops the sub (`.nosub`), and its `title` keeps
  the full text. The shell's `fitTabs()` runs once per frame, only after a text change or a tablist resize (a
  ResizeObserver), never per store event.
  - Measured: Effects and Master drop the sub at 1280 and 1366; Effects alone at 1440 and 1512.
- **Header live hint.** Hidden below 1341 px. The LIVE pill's title carries the same text.
- **Sentence title.** It now wraps, clamped at 2 lines, instead of ellipsizing.
  - Sizes: 21 px default, 19 px at 1341–1480 px, 17.5 px at 1251–1340 px.
  - Every slot, drone and master sentence is 1 line at every size. The Effects sentence is 2 lines at 1280–1366.
- **Wrapping text.** The Response hint and the Effects Fine-tune summaries wrap.
- **Short desktop windows** (≥ 1251 px wide, ≤ 820 px tall) get the rows the 1024 layout also trims:
  - head 52 px, bottom 88 px, tabs 52 px, title 58 px;
  - `.ev2-cols` padding 10/8;
  - column subs hidden.

Body scroll height / visible height after the fixes (equal means no scrolling):

| Size | Slots, drone, master, song | Effects |
|---|---|---|
| 1024×700 | 364/364 | 437/364 (unchanged) |
| 1280×800 | 392–408, fits | 443/392 |
| 1366×768 | 376/376 (before: Keys 390/321) | 394/360 |
| 1440×860 | 422/422 | 422/422 (before: 432/413) |
| 1512×900 | 462/462 | 462/462 |

Effects still scrolls at 1280 and 1366. That is by design (body `overflow: auto`), and nothing is clipped.

**4. Contrast and hit targets (§5).** Measured with the review's method:

| Item | Before | After |
|---|---|---|
| Edit PANIC "⌘ ." | 11 px at opacity .75, 3.19:1 | 13 px full white, 4.63:1 |
| Legend "all" (dimmed rows) | 2.17:1 | ≥ 4.63:1 |
| Legend "Pad" (dimmed rows) | 4.19:1 | ≥ 4.63:1 |
| On-screen keys at 1024 | 41 px tall | 44 px tall |

- The legend rows dim the colour bar and grey the name instead of fading the whole row. Muted rows no longer fade
  either (grey bar and struck name).
- The keys gained their 3 px from `.ev2-kb` padding at ≤ 1250 px: 5/7 → 4/5.
- The lowest text run in the tabs and bottom bar is 4.63:1 at every size, with a muted Pad next to the selected
  Keys.

Fade out / PANIC and tabs, measured:

| Size | Fade out | PANIC | Tabs | White keys |
|---|---|---|---|---|
| 1024×700 | 84×55 | 92×55 | 48 | 44 |
| 1280×800, 1366×768 | 104×67 | 112×67 | 52 | 46 |
| 1440×860, 1512×900 | 104×87 | 112×87 | 60 | 66 |

**5. The EQ component.** No table or graph overflow before or after, at any width.

The Edit Tone editor at each size:

| Size | Width | Layout | Plot |
|---|---|---|---|
| 1024×700 | 944 | compact | 176 |
| 1280×800 | 928 | compact | 176 |
| 1366×768 | 1014 | compact | 176 |
| 1440×860 | 1088 | compact | 176 |
| 1512×900 | 1160 | compact | 176 |
| 1920×1080 | 1568 | full | 230 |

- **Re-tuned threshold.** Compact now applies when `width < COMPACT_BELOW_PX = 1080` (was 1180). The number comes
  from the column sums: 624 fixed + 260 side + 14 gap + 30 padding = 928, plus ≥ 150 for "Acts on" = 1078.
- **Height rule.** Compact also applies when `window.innerHeight < compactBelowHeight`. slot.js passes 1000, so on a
  laptop the band table stays in view under the graph. The component follows window resizes, and that listener is
  added only with the option. As a result, Edit's layout is unchanged at ≤ 1512×900, and a 1920×1080 window gets the
  full layout.
- In the fixture (1100 → 1512 wide), the card is compact at 1066 and 1078 and full from 1090 up. Nothing is outside
  the card at any of those widths.
- **Key-strip captions.** The key strip's air-zone caption "overtones · 4.2–20 kHz" was wider than the zone at every
  Edit width and was drawn under the keys ("ertones…", e29/e30). Each line now takes the longest wording that fits
  (`measureText`): "4.2–20 kHz" at ≤ 1512, the full wording at 1920.

**6. SUSPECTED minors.** round3-edit has none. round3-eq's only one is m4 ("shadow cache answers at the old rate
after a restart onto another device rate"). It lives in engine/audio.js, outside these files, and the round3-eq fix
(`_teardown()` clears `_eqShadow`) already removes the cache it suspected. No action.

**Tests.**
- **New file: `test/phase2/edit-v2/integration-widths.test.mjs`** (real app, 5 tests, about 50 s):
  - every tab plus wiring at 1024 / 1280 / 1366 / 1440×860 / 1512: no overflow, ellipsis or clipped text; tabs fit;
    the live hint rule;
  - the chip rows keep whole words, with ≤ 3 rows, 1 row at ≥ 1366, and a chorus step panel that holds its steps at
    every size;
  - naming: no visible string matches `/\bCustom\b|Reverb level|the Space\b/`;
  - contrast of the tabs and bottom bar ≥ AA; Fade out / PANIC / tabs / white keys ≥ 44 px;
  - the Tone EQ at 6 sizes: nothing outside the card, no sideways scroll, no cut cells, the compact rule, the
    captions.
  - Screenshots: `screenshots/widths-<w>-{slot0,effects,tone-eq}.png`, `widths-1280-{wiring,effects-chips}.png`,
    `widths-{1280,1366}-keys-pad-off.png`.
- **eq suite:** a new test, "compact threshold 1080 px, compactBelowHeight; no overflow around it and at
  1280–1512". Screenshots `eq-1112x900.png` and `eq-1280x900.png`.
- **Updated strings:** effects.test (The Space is…, Vibe: your own mix, "goes into the Stage"), slot.test and
  integration.test (Shaped · n bands), eq run.mjs (mini-curve label "Shaped · 1 band").

**Results** (2 CPUs, load average 2–3):

| Suite | Result |
|---|---|
| `node test/phase2/edit-v2/run.mjs` | 11/11 files, 87 tests (integration-widths 64 s) |
| `node test/phase2/eq/run.mjs` | 26/26 |

**Requests for other owners (polish-2B).**
- **views/settings.js** (MIDI learn row names):
  - `LEARN_NAMES['fx.reverb.returnGain']: 'Reverb level'` → `'Space level'`. This is the exact label Edit's
    Wheels & pedal now uses (`lib.TARGET_LABELS`).
  - If a hint is wanted, use `title: 'Space (reverb) level'`, never the label.
  - Nothing else in settings.js says Reverb or Custom.
- **shared/params.js** (optional): the row label `'Reverb level'` → `'Space level'`. Edit never shows it (audited),
  but any view that prints `describe().label` would.
- **shared/eq-math.js** (optional): `eqSummary` → "Shaped · n bands" instead of "Custom · n bands". The unit test
  `eq-math.test.mjs:159-160` would change with it. The view-side mapping (`toneSummary`, slot.js) then becomes a
  no-op and can stay.
- **components/stepChip.js**: the `placementDir` defaults (220 at ≤ 1250, 290 above) are below a real panel's
  minimum (287 at 1024: 38 head + 5 × 44 steps + gaps + padding; about 335 above, with hint and foot). effects.js
  now passes its own `placementNeed`. Raising the defaults to 290 / 340 would cover any other `'auto'` user.

## polish-2A (reviews/ux-round2.md #1–#3, #6–#9, L-6, "## l3" UI follow-up; styles.css / perform.js / main.js / settings.js MIDI copy / ui-core + settings tests)

Store schema, PARAMS, the controller and the engine are unchanged. New exports: `perform.js` `stepPanelNeed()`,
`settings.js` `midiStatusText(midi, electron)`. `index.html` is untouched.

**1. Fluid Perform, 1024–1512+ wide, 700–900+ tall (ux-round2 L1 / #1).**
- Rows come from `:root` variables on the height left under the top bar and any banner
  (`--avail-h = 100vh − --banner-h`): `--p-head-h` clamp(102, 12.45 %, 112), `--p-nav-h` clamp(48, 6 %, 54),
  `--p-bot-h` clamp(76, 10.45 %, 94), `--p-gap` / `--p-pad-b`. 900 px tall gives the mockup's 112 · 54 · 94 exactly;
  ≤ 1250 px wide sets 94 · 50 · 74 as before. The old `max-height: 820px` override is gone.
- Head columns: song `1fr` · Transpose clamp(156, 11.67vw, 168) · shared effects clamp(520, 100vw − 800, 640) · Chord
  clamp(100, 8.06vw, 116). `.p-fx` is a container: under 600 px the row captions go icon-only and the chips tighten
  (nothing ellipsizes). The chip rows keep 44 px at a 102 px header (padding/gap give way). The song name is
  clamp(28, head − 64, 40) px and `fitName` (perform.js, ResizeObserver) steps a long name down to 70 % before it
  ellipsizes; KEY letter clamp(26, 2.23vw, 32).
- Stage: wheel clamp(76, 6.4vw, 92), drone clamp(360, 27.8vw, 400) (≤ 1340: clamp(340, 29.7vw, 380), notes share it),
  notes clamp(240, 18.75vw, 270). `.p-main` is a size container (`pmain`): ≤ 500 px tall the strips use 44 px tiles/chips
  and 5 px gaps and the drone toggles go one row (EXPERIMENTAL tag hidden on stage); ≤ 450 / ≤ 410 px the key grid,
  sliders and pad-folder row compact. `.p-drone` (inline container) ≤ 390 px tightens the drone tile. `.slot` (inline
  container) ≤ 165 / 145 px: compact tile type, "↻ 100%" (the word "wheel" is its own span, `.wb-word`), Sustain LED
  stacked over its label.
- Top bar: ≤ 1500 px the meter is 72 px and the view switch 72 px; ≤ 1400 px the brand name goes (logo stays);
  ≤ 1250 px tighter gaps and a 110 px master. Only the MIDI lamp may shrink (a connected device's name ellipsizes;
  the state words never do).
- Measured (Linux Chromium, factory "Sunday Pad + Piano", ui-core `polish-2A responsive`):

  | Viewport | Fader throw before → now | Title | Clipped before (ux-round2) → now |
  |---|---|---|---|
  | 1280×800 | 189 → **203.8** | 38 px, whole | title, 4 chips, drone card 36 px, "Sound OK"/latency → none |
  | 1366×768 | 157 → **177.4** | 38 px, whole | title, chips, drone 68 px, "Bl…" → none |
  | 1440×860 | 217 → **244.7** | 40 px | drone 8 px → none |
  | 1440×900 | 257 → **256.7** | 40 px | none |
  | 1512×900 | 257 → **256.7** | 40 px | none |
  | 1024×700 | 141 → **140.8** | 32 px | top-bar lamps 16 px over → none |

  Also with four filled strips (no factory song has four) at 1366×768, 1440×900 and 1024×700: nothing clips
  except an instrument name may ellipsize (full name in its tooltip).

**2. Banners (#2, L2).** The persistent banners (second window, library not saving / retrying, newer library) share
one `div.bstrip` (`data-testid=banner-strip`) that is exactly 32 px in the layout: the most urgent message (danger →
warn → info) on one line with its buttons (26 px), "+N" for the others, and a chevron (`banner-expand`) that unfolds
every message in full with 44 px buttons **over** the stage (absolute; the layout stays 32 px). Esc / an outside tap
folds it (`openOverlay`, group `banners`), so that Esc never panics. `setBanner(id, {text, short?, kind, actions})`
gains `short` (the folded wording; the full text is the tooltip). The stalled-sound banner keeps its full-width
48 px Restart. With a banner up at ≤ 1250 px the setlist/bottom rows and gaps give the height back
(`:root:has(#banners > :not([hidden]))`: 46 / 66 / 8 / 8). Fader throw with a banner: 1024×700 83 → **132.8**,
1280×800 131 → **177.4**, 1440×900 191 → **235.8**.

**3. Toasts (#3, L3).** `#toasts` is bottom-right, `bottom: --p-bot-h + --p-pad-b + 10px`, `width: min(400px, 34vw)`,
newest at the bottom; `pointer-events: none` kept. Tested at 1440 and 1024: no toast over `.p-head`/`.p-nav` or the
bottom row, ≤ 24 px above the bottom row, a tap on a toast reaches what is under it. In Edit they sit over the
footer line (not a control).

**4. MIDI 'pending' / 'denied' / 'failed' copy ("## l3").** main.js: pending → lamp "Starting…" (amber), title and one
**info** toast "MIDI starting… answer the browser’s permission prompt if it appears." (Electron keeps "MIDI is taking a
while to start…"), no reload advice, `midiHintShown` untouched. denied → toast/title "MIDI was blocked — allow it in the
browser’s site settings." (Electron: "MIDI access was denied."). failed → unchanged unplug/replug toast; title "MIDI
could not start — unplug and replug the keyboard". settings.js › MIDI uses `midiStatusText()`: pending → the same
sentence; denied → the site-settings sentence; unsupported → "use Chrome or the Worship Rig app"; failed → "unplug and
replug the keyboard, then reload".

**5. L-6.** `.audio-text { min-width: 8.5ch; flex-shrink: 0 }`, `.latency`, the ready text, the MIDI state word, lamps
and captions don't shrink; `.tb-item { flex-shrink: 0 }` except `#midi-status`. With a 37-character connected
device name injected: "Sound OK" → latency gap **7 px** at 1280, 1366 and 1440 (5 px at 1024), "Sound OK" unclipped.

**6. Contrast and hit targets (#6, #7).** Restart sound on `--panic` #d9363a: 3.27 → **4.63:1** (hover #c42f33).
PANIC "Esc" full white 12 px/800: 3.72 → **4.63:1** (hover now darkens to #c42f33, so it never drops under 4.5).
At 1024: Swell 62×38 → **62×44**, KEY ▾ 67×38 → **67×44** (song block padding 6 px), Space/Echo pills 244×36 → side by
side **119×80**, step-panel steps 37 → **48**. Step panels in a Perform strip open below the ON tile
(`top: 57px` / 55 px compact), so the tile stays a one-tap mute; strips pass `placement:'auto'` and
`placementNeed: stepPanelNeed` (351 px), so a strip without room above its chips (1024×700, 1366×768, 1280×800,
banners) opens the panel over the strip below the tile ('cover') instead of shrinking the steps. A short panel
(`@container sp`, ≤ 360 px) drops its hint and footnote first.
**Not mine (request below):** the Edit bottom bar's "⌘ ." (3.19:1) lives in `views/edit/panels/bottom.css`.

**7. OFF strips (#9).** The chips on an OFF strip stay live, so they keep full opacity in grey (slot colour removed,
`.mchip.on` #23272e / #555e6c); name and tag line at 70 % grey; what dims is the fader track (opacity 0.32) over a
hatched body, with the dB value struck through. Measured on the Pad strip OFF: every text ≥ **4.43:1** (was 1.82–3.26),
chips opacity 1, track 0.32.

**8. Chord readout (#8, G1).** perform.js keeps the engine's last chord and the physically-held count from `'notes'`
(the engine's `held`, which excludes pedal-held notes). The readout is live only with ≥ 2 keys held; below that it
idles, dimmed, on the last chord it showed live, so a lone key never shows. D2-D4-F#4-A4 released one by one:
`D* D* D* D D` (was "A" left over); a lone A afterwards stays "D"; E-G-B under the pedal, keys released: "Em" dimmed.
Note: the engine names only on a change, so a lone D followed by D major is one "D" event; perform.js re-reads the
kept chord after each `'notes'` (microtask), since the engine sends `'chord'` right after `'notes'`.

**Tests** (2 CPUs, load 3–8 from the parallel agent): `node test/phase2/ui-core/run.mjs` **46/46** (41 kept; the
L-3 test and the no-layout-shift test updated; 5 new: responsive 6 viewports + 4 strips, banners, toasts,
contrast/targets/OFF strip/step panels at 1024, chord readout). One earlier run failed "polish-1: strip level
meters… reads once a frame (0.00)" at load 7.6 and passed on the re-run. `node --test
test/phase2/ui-core/components.hv2.mjs` 18/18. `node test/phase2/settings/run.mjs` **29/29** (MIDI test now covers
pending / denied / failed). Screenshots: `test/phase2/ui-core/screenshots/responsive-*.png`,
`responsive-4strips-*.png`, `banner-strip-{1440,1024,open-1024}.png`, `toasts-{1440,1024}.png`,
`perform-off-strip.png`, `perform-step-1024.png`.

## polish-2-polish-2A (requests from polish-2A to the other polish-2 agent)
- `views/edit/panels/bottom.css` / `bottom.js`: the Edit PANIC "⌘ ." sub-label is 11 px at opacity .75 on #d9363a,
  **3.19:1** (ux-round2 #6). Full white (no opacity) at ≥ 12 px gives 4.63:1; keep the hover darker (#c42f33), not
  lighter, as Perform now does.
- FYI: toasts now sit bottom-right above a `--p-bot-h + --p-pad-b + 10px` offset in every view. In Edit at 1440 they
  cover the footer line ("No switch changes since…") while shown; nothing interactive. If Edit wants them elsewhere,
  override `#toasts { bottom }` under `body[data-view="edit"]` in an Edit stylesheet.

## l9 (views/edit/lib.js createBinder text:'dirty'; song + song-header tests; reviews/local-findings.md L-9)
- **Root cause of the Mac failure (2/2): the test, not a binder append.** `song.test.mjs:215` pressed
  `Control+A` before typing `13`. Playwright on macOS sends its `macEditingCommands` with every key, and
  `Control+KeyA` is `moveToBeginningOfParagraph:` (`playwright-core/lib/server/macEditingCommands.js:58`), so the
  caret went to 0 and `13` landed in front of `88` = `1388`. The outside `99` write was correctly held back (the
  field would read `99` otherwise). Linux Chromium has no Emacs bindings, so `Control+A` selected all there.
- **Reproduced on Linux**: a CDP `Input.dispatchKeyEvent` Control+A carrying `commands:['moveToBeginningOfParagraph']`
  (what Playwright sends on the Mac) gives `"1388"` on the song panel, 1/1; the same key with no commands, or with
  `['selectAll']` (Meta+A), gives `"13"`.
- **Binder hardening (real bugs the storm test found on Linux, independent of the Mac key):**
  - Before the first keystroke an outside write into the focused field used a plain `value =`, which drops a
    whole-field selection and leaves the caret at the end, so the next key appended (`61` + `132` = `61132`;
    name `Storm B, longer` + `Kept name`). `setClean` now keeps a whole-field selection across the write, and a
    number field (no selection API) is always re-selected: the first key replaces, never appends.
  - The draft flag is set on `beforeinput` / `compositionstart` as well as `input`, so it is up before the DOM
    changes (IME compositions only fire `input` at their end).
  - `focusout` re-applies the store value **forced**. While dirty, `b.last` is not updated (held-back writes, the
    panel's own debounced commit), so a store that came back to `b.last` (draft committed by the 500 ms notes
    debounce, then outside writes `Y` and the old value) compared equal and the field kept the stale draft.
- **Tests** (edit-v2):
  - `song.test.mjs` polish-1 dirty test: `ControlOrMeta+A` (Meta+A = `selectAll:` on the Mac).
  - New `song: L-9 — …storm…`: `store.set` every 20 ms (tempo 61/88/99/147/203; notes 3 strings), select-all,
    60 ms of writes before the first key, then keys 25 ms apart. Asserts the field equals exactly `132` / `Typed under
    fire`, the storm ran (> 10 writes), Enter commits 132, a debounced notes commit mid-storm does not come back on
    blur (the field shows the store), and the debounced-commit-then-store-returns case above.
  - New `song-header: L-9 — …rename storm…`: the same for the name (`Kept name`, Enter commits it).
  - Mutation checks on Linux: plain `comp.set` instead of `setClean` fails both storm tests (`'61132'`,
    `'Storm B, longerKept name'`); an unforced `focusout` fails the notes storm test (`'Typed under fire'` vs the
    store's `'Storm two, longer.'`).
- **Also verified here (polish-2 requests, already in the tree):** Edit PANIC "⌘ ." 13 px full white on `#d9363a`
  = 4.63:1, hover `#c42f33` = 5.52:1 (bottom test "PANIC ≥ 4.5:1 at rest and on hover, at 1440 and 1024");
  settings `LEARN_NAMES['fx.reverb.returnGain']` = `'Space level'` (settings run.mjs asserts it and that
  "Reverb level" is gone from the learn table). `shared/params.js` still labels the row 'Reverb level' (frozen).
- **Runs (Linux, one at a time, no re-runs needed):** `node test/phase2/edit-v2/run.mjs` 11/11 files, 90 tests,
  0 fail; `node test/phase2/settings/run.mjs` 29/29; `node test/phase2/ui-core/run.mjs` 46/46.

## menubar-A (C7: shared/bus.js, controller modes / low-resource / publish, engine low-resource, store settings)
Implements the CLOUD A half of `docs/menubar-mode.md` (contract v1). Message shapes are exactly the contract's.
- **`app/js/shared/bus.js` (new, pure).** `createBus({role:'main'|'mini', rig?, BroadcastChannel?, timers?, now?,
  hello?, warn?, throttleMs?})` → `{role, transport, publish(state), flush(), onCommand(cb), subscribe(cb),
  command(cmd), lastState, sent, close()}`. Transport per direction, each preload method feature-detected on its
  own: main `rig.busPublish(json)` / `rig.onBusCommand(cb)`, mini `rig.miniSubscribe(cb)` / `rig.miniCommand(json)`,
  else `BroadcastChannel('rig-bus')` (`transport` reports `'rig' | 'broadcast' | 'none'` per direction). The rig
  transport sends JSON strings (contract `json`) and accepts strings or objects back; BroadcastChannel carries plain
  objects. On one channel a command is told from a state by its `type` field (states have none).
  - Validation: `stateError(m)` / `commandError(m)` (→ null or the first problem), `isValidState` / `isValidCommand`,
    `COMMAND_TYPES` (12), `AUDIO_STATES`. Invalid messages are dropped with `console.warn` in both directions; main
    refuses to publish an invalid state, mini refuses to send an invalid command (`command()` fills in `v:1`).
    Nullable by design: `current` (no song), `masterDb` (master 0 = −∞ dB, not JSON-able), `memoryMB` (unknown),
    `midi.name`. Payload rules: `selectMode.id` non-empty string, `master.value` 0..2 (out of range is dropped, not
    clamped), `droneKey.pc` integer 0..11, `lowResource.on` / `record.on` boolean.
  - Throttle: ≤ 1 send per `BUS_THROTTLE_MS` = 250 ms (≤ 4/s), leading + trailing edge (the newest state always goes
    out). Measured: 10 publishes in 100 ms → 2 sends (first + newest); 200 publishes over 2 s → ≤ 9.
  - `hello`: main answers at once with `lastState` (bypasses the throttle, folds a pending trailing send into it) and
    still passes the command to `onCommand`. A mini's first `subscribe()` sends `hello` itself (`hello:false` opts out;
    a second hello from mini.js is harmless).
- **controller** (additive; section "menu-bar mode" + small hooks in `preloadSetlist` / `preloadNeighbors` /
  `startPrimary` and two `status` fields):
  - `controller.modes = {list(), current(), select(id), next(), prev()}`. Mode = `{id, name, key, index}` (key =
    `keyName(hearIn, minor)`). Set = `settings.menuBarSetlistId`'s songs, repeats dropped, ≤ `MENU_BAR_MAX_MODES` = 6;
    unset **or empty** → first `MENU_BAR_FALLBACK_MODES` = 3 of `store.navIds()` (current setlist, else library
    order). `next`/`prev` wrap; from a song outside the set `next` → first, `prev` → last. `select` of the song that
    is already playing resolves false (no re-prepare). All return `Promise<boolean>`.
  - `controller.setLowResource(on)` persists `settings.lowResource` and returns the effective state.
    `controller.setWindowVisible(true|false|null)` overrides document visibility (null = follow
    `document.visibilityState`). Effective low-resource = `settings.lowResource || (settings.menuBarMode &&
    !windowVisible)`. **Deviation from the brief:** the automatic part is gated on `settings.menuBarMode` — a hidden
    Chrome tab or a minimized window outside menu-bar mode keeps the normal policy, so a MIDI song switch while
    another app is in front never waits on a decode the neighbour preload would have done.
  - Low-resource on → `engine.setLowResource(true)` (optional call), `status.memory.mode = 'current-only'`, every
    preload is `preload([current], {pin:'replace'})` (setlist and neighbour preloads skipped), event
    `'lowResource' {on, auto}`. Off → `engine.setLowResource(false)` and `preloadSetlist()` (the normal policy; the
    songs are usually still decoded, so it is quick). A persisted `lowResource` applies before the first song/preload.
    New `status.lowResource`, `status.windowVisible` (status.memory is unchanged apart from the new mode value).
  - `controller.menuBarState()` → the contract `state`; `controller.publishState({force?, immediate?})` publishes it
    (unchanged JSON is skipped unless `force`). Published at start and on every `status` event, store change and
    visibility change (song, master, drone, key, audio/MIDI/latency, recording, memory, modes, low-resource).
    `audio` maps `restarting` → `'stalled'`; `memoryMB` = `performance.memory.usedJSHeapSize` (Chromium) + decoded
    sample MB, rounded (renderer-side; Electron main can add process RSS for the Tray if it wants).
  - `controller.handleCommand(cmd)` → boolean; every contract type: `hello` (immediate state), `selectMode`,
    `nextMode`, `prevMode`, `panic`, `fadeOutAll`, `master` (writes the current song's `patch.fx.master.volume`, as
    Perform's fader does), `droneToggle` (off ↔ the mode it had, else the song's committed mode, else synth — Perform's
    ON tile rule), `droneKey` (the key the band hears; the transpose amount is kept — Perform's key grid),
    `lowResource`, `record` (toggles only when `on` differs from the recorder's state; no user gesture here, so
    Chrome records via its fallback sink), `openMain` (renderer no-op: emits `'openMain'`). Every handled command
    also emits `'bus-command'`. `controller.bus` = the bus (null in tests/headless).
  - The bus: `o.bus` if given (the caller owns and closes it), else created only in a real page
    (`doc === globalThis.document`) with a rig bus method or BroadcastChannel; a secondary (muted) window never
    starts it. `dispose()` closes a bus it created.
- **engine** (`audio.js`, additive): `engine.setLowResource(on)` → boolean, `engine.lowResource` getter. On: pins =
  the current (committed) patch's sampler URLs only (the pin set held before is remembered), `preload()` pins
  current-only and does no idle reverb warming, every `commit` re-pins the new song, `slotLevel()` taps are
  disconnected at once and reads return `{peak:0, rms:0}` without tapping, idle reverb units (not active / fading /
  staged) are disconnected and their IRs dropped from the IR cache. Off: remembered pins ∪ current song's come back;
  warming and taps work again. `_debugStats()` gains `lowResource`, `slotLevelTaps` (= `slotTapCount()`),
  `reverbUnits`. Survives `restart()`. sampler.js unchanged (BufferCache `setPins` / `pinned` suffice).
- **store**: `settings.menuBarSetlistId` (null | existing setlist id; a dangling id normalizes to null; deleting that
  setlist sets it null), `settings.lowResource` (bool, false), `settings.menuBarMode` (bool, false). `menuBarMode`
  and `lowResource` joined `DEVICE_LOCAL_SETTINGS` (machine behaviour: kept across a replace-import, not an edit).
- **Tests.** `test/phase1/shell/menubar.test.mjs` (19): bus validation, throttle, hello, invalid drops, Electron
  relay transport + per-method detection, a real Node BroadcastChannel round trip; store settings; modes (fallback,
  chosen set ≤ 6, empty set, wrap, outside-the-set); every command (fake engine + fake recorder); commands over a
  mini bus; state validity; controller publish throttling (41 fader changes in 1 s → 2–6 sends, newest last); hello
  before any change; low-resource pins / memory.mode / neighbour skip / restore; persisted low-resource before the
  first preload; auto low-resource and setWindowVisible. Engine `realtime.lowResource` (38 s on this box): pins =
  current only (5 setlist pins → song A's), taps 2 → 0 at once and 0 after 2 s and over the whole 30 s window
  (119 reads), 0 IR builds and 0 unit builds with neighbour preloads on two new reverb sizes, reverb units 3 → 1, a
  commit moves the pins to song B, off restores setlist ∪ B pins, 1 tap on the next read, warming builds 1 IR.
- **Runs (Linux):** `node test/phase1/shell/run.mjs --only unit` 13/13 files PASS; engine `lowResource`,
  `slotLevelTap`, `irOffMainThread`, `preloadAndLRU`, `pinsUnion`, `pinsLimitedEvict` PASS, 0 console errors. Real app
  smoke (server.js + Chromium, a second page with a mini bus): hello → state (3 modes, audio running), `nextMode`
  switched the song, `lowResource` → engine stats `lowResource:true, slotLevelTaps:0, reverbUnits:1`,
  memory.mode `current-only`, 0 console errors.

## menubar-B (C7: app/mini.html + mini.css + views/mini.js, Settings "Menu bar", renderer low-resource, mini suite)
Implements the CLOUD B half of `docs/menubar-mode.md` (contract v1) on top of menubar-A's `shared/bus.js` and
controller. Message shapes are exactly the contract's; the popover never talks to the engine or the store.
- **`app/mini.html` + `app/mini.css` + `app/js/views/mini.js` (new).** A separate renderer, no audio, CSP as
  index.html minus blob/media. `mini.js` imports `createBus` statically (`role:'mini', hello:false`) and exports
  `mountMini(el, {bus:{send, onState}, helloMs?})` (plus pure helpers `keyToPc`, `taper`/`untaper`, `formatDb`,
  `statusLine`); the page self-mounts on `#mini` and sets `globalThis.__mini = {state, sent, bus, destroy}` (test
  handle). Layout for 320×440, no scroll, every target ≥ 44 px (sheet "Done" 36 px): header `‹ name / Key X · n of N
  ›` (Prev/Next = `prevMode`/`nextMode`) · 2–6 mode buttons (number, name, key; current highlighted +
  `aria-pressed`; 1 column for 2–4, 2 columns at 5–6; flex-filled, ≥ 44 px) · master fader · `Drone ● key` pill
  (`droneToggle`) + ▾ opens a 12-key sheet over the mode area (`droneKey {pc}`; the current drone key is lit; Esc /
  Done close it) · Fade (`fadeOutAll`) · PANIC (hold 600 ms, progress fill; a short press says "keep holding";
  Enter/Space hold works too) · Open Worship Rig (`openMain`) · Rec (`record {on:!recording}`) · Eco switch
  (`lowResource {on:!lowResource}`) · status line `Sound OK · 42 ms · Keystation 49es` with an LED (ok / warn ≥ 40 ms /
  bad = stalled). Keys `1`–`6` select a mode. System fonts only; warm-neutral dark palette; the only animation (Rec
  pulse) stops in low-resource and under reduced motion.
  - Waiting: "Waiting for Worship Rig…" (+ Open Worship Rig) until the first valid `state`; `hello` is sent on load
    and every 2 s until then, never after.
  - Master: relative drag (a tap never jumps, as the top-bar fader, UX S7/B2), position = the app's dB-display taper
    (`2·p³`, `shared/params.js` faderTaper, inlined to keep the popover light), sent ≤ 20/s with a final send on
    release; while dragging and for 400 ms after its own send the mini ignores `state.master` (no echo jitter),
    otherwise the app is the source of truth. Arrow keys ±0.02 position (Shift ±0.005). Label `−6.0 dB` / `−∞ dB`.
- **Settings "Menu bar" section** (`views/settings.js`, additive block + `settings-open`/`settings-close` listeners;
  existing classes only, so the styles-edit prune test still holds): *Menu-bar mode* switch (`settings.menuBarMode`);
  *Modes from* select (`''` = "Current setlist (first 3 songs)", else each setlist with its capped count →
  `settings.menuBarSetlistId`, rebuilt when setlists / song names change) + a `Modes: A · B · C` line from
  `controller.modes.list()` (fallback: the contract rule computed locally); *Low-resource* switch
  (`controller.setLowResource`, else `store.set`); *Open at login* switch only when `window.rig.setLoginItem` exists
  (initial value from `rig.getLoginItem()` or `rig.getMenuBarState()` → `{openAtLogin}` / boolean; an `{error}`
  reverts the switch), else the hint "Open at login is available in the Mac app."; Chrome only: *Open mini panel*
  (`window.open('mini.html', 'worship-rig-mini', 'popup,width=320,height=440')`); a live resource line every 1 s
  while Settings is open: `Low-resource: on · current song kept loaded · 41.2 MB kept loaded · level taps 0 ·
  voices 0` (engine `_debugStats()` + `controller.status.memory.mode`).
- **Renderer `main.js`** (additive section "menu-bar mode" at the end):
  - **No second bus.** The brief said main.js creates the main bus; menubar-A's controller already creates it
    (`defaultBus()`, closed on dispose), so main.js does not open another one (two `role:'main'` endpoints would
    answer every hello twice).
  - `visibilitychange` → `controller.setWindowVisible(visible)`. Electron runs with `backgroundThrottling:false`, so
    a hidden window may never fire it: **rig menu ids `windowShown` → `setWindowVisible(true)`, `windowHidden` →
    `false`, `windowFollowDocument` → `null`** (sent by Electron main over the existing `rig:menu` channel; the
    controller re-emits unknown ids as `'menu'`). **LOCAL: please send these from the window's show/hide.**
  - `status.lowResource` → `<html data-low-resource>`; `styles.css` (appended rule) sets `.meter` and `.lvl-meter`
    to `display:none` under it, which takes them out of their IntersectionObservers and stops their rAF loops (the
    top-bar mount keeps its width; nothing moves). Measured (mini suite, loaded box): analyser reads 1.00/frame +
    `controller.slotLevel` 2.00/frame normally → 0 / 0 in low-resource (the page kept animating: 50 frames/s of our
    own tick), `slotLevelTaps` 0.
  - `settings.menuBarMode` → `rig.setMenuBarMode(bool)` at start and on change (when the preload has it).
  - `controller` `'openMain'` in a browser → `window.focus()` (best effort; Electron main handles it there).
- **Not done / requests.**
  - `views/perform.js`: no change. Perform has no meter loop of its own (its strip meters are `levelMeter`s, stopped
    by the CSS rule above); the one loop left is the 150 ms `runtimeTimer` (pedal / faded lamps). Request for the
    perform owner: skip `readRuntime()` while `document.documentElement.hasAttribute('data-low-resource') &&
    !controller.status.windowVisible` (a one-line guard, but it changes lamp behaviour in a visible window if keyed
    on low-resource alone, so it was left out).
  - Contract §Definitions says auto low-resource applies "while the main window is hidden **and the popover is
    closed**"; the controller ignores the popover. Harmless for meters (the popover has none) but a mode switch from
    the open popover decodes on demand. If that matters, LOCAL can send `windowShown` while the popover is open.
  - The popover shows at most 6 modes; the contract `modes` array is already capped by the controller.
- **Tests.**
  - `test/phase2/mini/run.mjs` (new; also `mini` in `test/run-all.mjs`, group phase2): two pages in one context,
    same origin (page B = mini.html at 320×440 opened FIRST, page A = the real app). 14 tests: waiting + hello every
    2 s (≥ 2 in 2.3 s, transport `broadcast`) → live with the controller's modes (names equal, no hellos after);
    click mode 2 → app `currentSongId` + mini highlight/name/key; keys 1–3; Prev/Next; master (tap = no change, 50 px
    drag = taper-exact within 0.02, engine param follows, dB label ±0.1, app → mini sync, → key nudges); panic (200 ms
    press = 0 panics + note still held + "keep holding"; 750 ms hold = exactly 1 panic, held note released); drone
    sheet key → `hearIn`, lit key, Esc closes; pill toggles `drone.mode` both ways; Eco → `status.lowResource`,
    `_debugStats().lowResource`, `settings.lowResource`, `data-low-resource`, taps 0, 0 meter reads/frame, and back;
    status line format; 320×440 layout (nothing outside the viewport, no overflow, targets ≥ 44); 6-mode setlist →
    2 columns, still fits, click 5 / key 6 select; Fade → `fadeOutAll`; zero console.error on both pages.
    Screenshots: `test/phase2/mini/screenshots/{mini-waiting,mini,mini-6-modes,mini-drone-keys}.png`.
  - `test/phase2/settings/run.mjs` (+1 test per mode): Menu bar section — menu-bar mode on/off, a new setlist appears
    in the picker, choosing it sets `menuBarSetlistId` and the `Modes:` line equals `controller.modes.list()` (4),
    back to `''` → null; Low-resource → controller + engine + resource line (`level taps 0`) + `data-low-resource`
    (app) and back; login hint without `rig.setLoginItem`; app mode: Open mini panel → popup `/mini.html` goes live.
    Screenshot `test/phase2/settings/screenshots/{app,fixture}-menubar.png`.
- **Runs (Linux, load 5–13 from the parallel agents):** `node test/phase2/mini/run.mjs` 14/14 (first run: boot hit
  the 30 s `waitRigReady` bound at load 5.7 → raised to 90 s; 14/14 on the next two runs). `node
  test/phase2/settings/run.mjs` fixture 15/15; app 15/16 at load 12.8 (the pre-existing 30 s `waitRigReady` bound in
  boot) → re-run `SETTINGS_MODES=app` 16/16.
  `node test/phase2/ui-core/run.mjs` (main.js / styles.css touched) at load 17–34: 36/46 then 40/46, different tests
  each run, all timing (boot `waitForFunction` 90 s, 30 s waits, TAP BPM, panic level fall); the meter tests
  (round2-ui #10, polish-1 strip meters) failed on run 1 by one stray read each and passed on run 2. A probe in Edit
  confirmed `data-low-resource` is absent and both `.meter`s display normally outside low-resource. Needs a quiet-box
  re-run before sign-off.

## round4-controller (reviews/round4-controller.md C1–C9, C13; controller.js / store.js / shell tests)
- **C1 (major), restart + switch overlap.** `afterRestart()` (restartAudio and engine-initiated restarts) now re-sends
  the applied song's level: `setTranspose`, `setRouting`, `setTempo`, and the drone key + configure (`lastDroneKey`
  reset). If `restorePads()` already re-applied a files-mode drone (it now returns `true` then), the drone is not sent
  twice (the M1 order `off → files` is kept). Cause: `engine.restart()` → `applyState()` runs its routing /
  transpose / tempo / key / drone tail even when its commit is refused as stale. **Engine owner (frozen, report
  only):** applyState should skip that tail when `commit(tok) === false`.
  `applySongLevel(song, prev, force, {drone = true})` gained the option.
- **C2 (major), setlist pinned whole on a guess.** `preloadSetlist()`: a setlist whose estimate is ≤ `PIN_BUDGET_MB`
  but `exact === false` is sized first (`probeSetlist`): the large-set exact-only window, then the rest warmed
  unpinned while the running estimate stays ≤ `PIN_BUDGET_MB` (≤ cap, so nothing warmed is evicted). Then, if the
  estimate is exact and ≤ budget, the whole set is pinned (`{pin:'replace'}`) and the mode is `'setlist'`;
  otherwise the large-set policy, with its one `'memory'` event. While sizing, `status.memory.mode` reads
  `'setlist'` and `note` is null (internally the large-set window policy applies, so a switch meanwhile replaces a
  budgeted window, never `'add'`s guessed neighbours). An estimate without `exact` (older engines) keeps the old
  path. `warmRest(my, ids, limitMB)` is the large-set warm loop, factored out.
  E1d (the reviewer's launch set [Grand Piano, Prayer Wash, Upright Pad, Building Swell], Mac sizes): max pinned
  754 → 333 MB, ends large-set with `setMB` 754.
- **C3 (major), window planned around a loading song.** `planWindow({onlyExact:true})` treats an inexact current
  song like a guessed neighbour: it is pinned alone and every neighbour goes to `guessed`. The phase-2 re-plan
  also runs with `onlyExact`. `selectSong()` bumps `winSeq` first, so an older window stops re-planning while the
  switch loads (the song still playing stays pinned). E1a 606 → ≤ 600, E1b 849 → ≤ 600, E1c 849 → ≤ 600 MB.
- **C4 (major), H1 lock.** `store.setReadOnly(true, reason)` returns false and keeps `'backup-failed'` when that
  lock is on, so the takeover's `setReadOnly(false)` can't clear it. `allowOverwrite()` still unlocks it.
- **C5 (minor), cap crossing off the toast path.** `updateMemory()` no longer emits `'warn'` (main.js toasts those
  verbatim). Once per crossing it logs the L-8 text with `console.warn('[controller] pinned samples …')` and emits
  `'memory'` `{mode, overCap:true, pinnedMB, capMB, note: OVER_CAP_NOTE}`. New export `OVER_CAP_NOTE` =
  "This set is using a lot of memory; songs load as you go." No UI reads it yet (nothing is toasted).
  The soak reads `status.memory` only, so it is unaffected.
- **C6 (minor), takeover into a half-started controller.** In the secondary → primary path: `store.reload()`, then
  `store.flush()` **before** `startPrimary()` subscribes, so views get the reload diff and the controller doesn't
  (no `restart()` while `engine.start()` is pending, no second `selectSong`). The engine never started in that
  window, so `engine.latency` is set from the reloaded settings before `start()` (the field `_newContext()` reads).
  Sink, mono, MIDI input and the menu-bar settings are already applied by `startPrimary()` itself.
- **C7 (minor).** Leaving secondary resets `applied`, `appliedId`, `targetId` and `lastDroneKey`, so the fresh
  engine gets the song's drone key even when a song was tapped in the muted window.
- **C8 (minor).** `panic()` clears `swellActive` (the engine's allNotesOff drops the swell), so the next toggle
  starts one.
- **C9 (minor), learned CC buttons.** `ccButton()`: a value ≥ 64 while already pressed counts as a new press once
  `CC_RETRIGGER_MS` (150 ms) has passed since the last press, so press-only ("trigger") footswitches that send
  127 on every press work; contact bounce and a held momentary switch stay one press; < 64 is a release. Swell
  stays level-triggered. Not fixed: a **toggle-mode** switch (127 / 0 on alternate presses) still acts on every
  other press; it can't be told apart from a momentary one by its values. Set such a pedal to momentary.
- **C13 (nit).** A controller disposed while secondary releases the instance lock when it is granted.
- **Not done:** C10 (pads walked before the first song; SUSPECTED), C11 (revertSong during a switch; SUSPECTED),
  C12 (large-set warm loop not restarted on a switch; nit).
- **Tests.**
  - New `test/phase1/shell/round4-controller.test.mjs` (12 tests, ported from the reviewer's E1/E2/E4/E5/E6):
    C1 (token model of restart/applyState), C2 ×2 (the E1d set ends large-set with max pin ≤ 600; a Rhodes set that
    really fits is pinned whole and never reports large-set), C3 ×3 (E1a + "playing song stays pinned", E1b, E1c),
    C4, C6, C7, C13, C8, C9. Mutation check: reverting each fix alone fails its test (C1, C2, C3 winSeq, C3
    planWindow, C4, C6, C7, C8, C9, C13).
  - `memory.test.mjs`: `instrEngine`'s prepare now decodes the song (like the real engine, whose sampler loads
    through the same BufferCache), so a committed current song is exact. "an estimate that turns out low …" now
    asserts the set is **never** pinned whole on the guess (was: pinned whole first, then downgraded), with one
    large-set event. "a song that alone passes the budget …" counts the `overCap` 'memory' event instead of a warn.
  - `fixes.test.mjs` M1 unchanged and green (the drone is re-applied once, `off → files`).
- **Runs (Linux, 2 CPUs, load 15–34 from parallel agents):** `node test/phase1/shell/run.mjs`: unit 184/184,
  electron 14/14; browser 12/13 twice at load 27–34 (the L-3 real-app test's 30 s `__rig.ready` bound; the same
  test fails identically on a scratch copy with this section's boot-path changes reverted, so it is load), then
  13/13 at load 17 (`__rig.ready` after 26.7 s; the reviewer's baseline run had 9.4 s). The reviewer's experiments
  E1a–d, E2, E4, E5a–b, E6 all pass now (they all failed before).

## round4-perform (reviews/round4-perform.md P1–P13; styles.css / perform.js / main.js (renderer) / components/quickSheet.js / ui-core tests)

All thirteen findings are addressed. P2 uses a larger line box than the review proposed, and P10 uses a different
octave rule, because the review's numbers and rule failed when measured (both explained below). The runs are at
the end.

- **P1 (major), bottom-row hold captions.** `.perform .p-bottom .hold-btn .hb-cap { bottom: auto; top: -30px }`.
  Revert's "press and hold (0.6 s)" and the locked Lock's hint now sit above their buttons, over the stage's
  bottom edge. Before, they were 5–7 px visible below the window. Header captions (KEY, Transpose) are unchanged.
- **P2 (major, local L-20), song-name line box.**
  - `.song-name` line-height 1.05 → **1.25**, not the 1.12 the review proposed. With Carlito forced at 1.12 the
    ui-core check still read 44/43 at 1280×800. Carlito's ascent + descent is ≈ 1.22 em, SF ≈ 1.19 and DejaVu
    Sans ≈ 1.16, so 1.25 holds all three with no slack.
  - `.song-block` padding `clamp(2px, (head − 102px) / 2, 6px)` (was `clamp(4px, (head − 92px) / 2, 10px)`).
    `.song-sub` margin-top 4 → 2 px. At ≤ 1250 px, `.song-block` padding is 2px 14px.
  - Budget (inside the borders):

    | Head row | Padding + name + gap + KEY row + padding | Available |
    |---|---|---|
    | 102 | 2 + 47.5 + 2 + 44 + 2 = 97.5 | 100 |
    | 112 | 6 + 50 + 2 + 44 + 6 = 108 | 110 |
    | 94 (≤ 1250) | 2 + 40 + 2 + 44 + 2 = 90 | 92 |

  - Font sizes are unchanged.
  - **Measured** as `.song-name` scrollHeight/clientHeight:
    - Carlito: 1280×800 48/48, 1440×900 50/50, 1024×700 40/40, 1366×700 48/48.
    - DejaVu Sans: 1280×800 48/48, 1440×900 46/46, 1024×700 40/40.
    - The KEY row ends inside the song block at each size.
- **P3 (major), Quick sheet sound state.**
  - perform.js `renderQuick` passes `sound`: `'muted'` when `status.instance === 'secondary'`, `'paused'` for
    `audio: 'suspended'`, `'stalled'` / `'restarting'` as before, otherwise `'ok'`.
  - quickSheet renders "Sound paused" and "Muted (another window is open)" with a warn LED. `.qs-ok` carries
    `data-sound`.
  - Paused gets the one-click button labelled "Resume sound". It calls the new optional `o.onResumeAudio` and falls
    back to `onRestartAudio`. Perform wires that to `controller.resumeAudio()`.
  - Muted keeps the 1 s hold, since there is nothing to restart in a muted window.
- **P4 (minor), banner strip over Settings.** `openSettings()` folds the strip first (`setBstripOpen(false)`), so
  every "Open Settings" path does. The open list's z-index is 60 → 45 and the chevron's 61 → 46, both under
  `.settings-modal` (50). Toasts (80) are unaffected.
- **P5 (minor), "Sing it in…" leak.** The popover's Back listeners (`click`, `blurAfterPointer`) now sit on a
  per-popover `disposer()`, disposed in the overlay's `onClose`.
  - Measured over 40 open/close cycles (in-page clicks + Esc, two frames apart), after GC: **Δnodes −4 / 0,
    Δlisteners 0 / 2**. The unfixed perform.js gave **+2076 / +1041** on the same probe.
  - Driving the cycles with Playwright's `page.click` + `waitForSelector` shows ≈ +34 nodes per cycle even with the
    fix: Playwright's injected script keeps references of its own. The regression test therefore cycles in-page.
- **P6 (minor), lock gaps.**
  - Under Perform lock the newer-library offer shows only "Not now". "Use that library" is withheld like "Open
    Settings".
  - main.js re-renders the status banners on a lock change (queued as a microtask, because the first
    `onSettings` call runs before `lastStatus` is declared). The lock-gated actions follow the lock at once
    instead of on the next 1 s tick.
  - `LOCK` table:
    - `live` gains `'pad folder Rescan (Mac app, pads loaded)'` (behaviour unchanged: a rescan re-reads the pads and
      changes no song), `'Notes toggle'`, `'top bar: master volume / REC / Quick'` and
      `'banner: Restart sound / Not now'`.
    - `frozen` gains `'banner: Open Settings / Use that library'`, and `'pad folder'` is renamed
      `'pad folder choose / change'`.
  - `lockBtn.title` mentions master volume, REC, Quick and library changes.
- **P7 (minor), MIDI toasts.**
  - Once `status.midi` is no longer pending, main.js dismisses the pending toast (Chrome or Electron text; new
    const `MIDI_PENDING_TEXT_ELECTRON`).
  - `firstRunHints()` sets `midiPromptHintShown` when Chrome's permission state is `'prompt'`. The Chrome pending
    toast is then skipped, so the advice isn't shown twice.
- **P8 (minor), toast eviction.** Each toast entry records its `kind`. Trimming to 2 drops the oldest toast of the
  lowest severity: info/ok, then warn, then error. So error + info + info keeps error + the newest info.
- **P9 (minor), short and wide windows.**
  - `@media (max-height: 740px) and (min-width: 1251px) { --p-bot-h: 72px; --p-gap: 8px; --p-pad-b: 8px }`. The
    header stays 102 px, so the shared-effect chips keep 44 px: the review's 94 px header would have made them 40 px.
  - `@container pmain (max-height: 410px)` compacts the strip the way the 1024 layout does: `.slot` padding
    7px 6px and gap 5, `.slot-who` 18, `.slot-tag` 17, `.slot-mods` gap 4.
  - Throw, px:

    | Window | Before | After |
    |---|---|---|
    | 1366×700 | 115.8 | **144.7** |
    | 1280×720 | 135.5 | **164.7** |
    | 1024×700 | 140.8 | 140.8 |
    | 1440×900 | 256.7 | 256.7 |
    | 1280×800 | 203.8 | 203.8 |

  - ui-core `VIEWPORTS` gains [1366, 700] and [1280, 720], held to the ≥ 140 rule.
- **P10 (minor), octave in "Sing it in…".**
  - The octave kept is the **Revert snapshot's** `transposeOctave` (`singOctave(s)`, in semitones). The target is
    `singItInShift(playIn, pc) + singOctave`, and Back is disabled at `semis === singOctave`.
  - The review's "keep the current octave" would have broken the ordinary path. Transpose +7 stores
    `transposeOctave: 1` (hear −5 plus one octave), so Back would have gone to +12 instead of 0.
  - Tested both ways: a song saved at +12 keeps +12 through G (+17) and Back; +7 then Back gives 0 with nothing to
    revert.
- **P11 (minor), Quick sheet height.** `.perform .qs { height: calc(var(--p-head-h) + var(--p-gap) + var(--p-nav-h)) }`
  at every width, replacing the fixed 178 / 154 px. Its bottom now meets the strips' top at 1280×800, 1366×768,
  1366×700, 1440×900 and 1024×700.
- **P12 (minor), wheel caption.** `wheelTargetLabel('fx.reverb.returnGain')` is `'Space level'` (polish-2B's name).
- **P13 (optional), name re-fit.** `renderSong` re-fits the name only when its text changes. The ResizeObserver
  still covers resizes and the Edit → Perform return. Measured: 0 `getComputedStyle(.song-name)` calls over 20
  fader writes.
- **Tests**: `test/phase2/ui-core/run.mjs` has 9 new tests, `round4-perform P1` … `P11 / P12 / P13`, plus the two
  viewports.
  - P2 forces Carlito and DejaVu Sans at 4 sizes with no +1 slack.
  - P3 dispatches each status and reads it in the same task, so the 1 s tick can't overwrite it.
  - P5 uses CDP `HeapProfiler.collectGarbage` + `Memory.getDOMCounters`.
  - P6 checks the table and that the top-bar items really stay live under lock.

## idle-cpu-mac (ground truth from the Mac, 2026-09-28 23:57Z; full report: reviews/idle-cpu-mac.md)
Measured on the built app (M2 Pro, 120 Hz ProMotion, screen locked), Perform, *Sunday Pad + Piano*, no notes played.
Renderer 44.4 % of one core = Web Audio render thread **21 %** + two reverb convolution background threads **~8 %** +
main thread 9 % + compositor 6 %; GPU process 13 %. Page JS is ~1 % of a core; `(program)` (rAF dispatch/style/paint)
is 86 % of the busy main thread. Drone on→off: renderer −9 pts, GPU −11 pts (only ~4 pts of that is DSP; the rest is
the meters + "· −9.1 dB" readout re-laying out 6×/s and rastering at 120 Hz). Sampler-only song (Grand Piano) 19 %,
synth-only (Glass Ocean) 24 %, Sunday Pad drone-off 35 %. `meter.js`/`levelMeter.js` re-arm rAF every frame at level 0
(121 style recalcs/s in every config); `html[data-low-resource]` is inert (nothing reads it); `main.js` sets
`backgroundThrottling:false` so a hidden window probably keeps the full load (unmeasured: screen was locked).
Implications for the fixers: **engine side (this workflow)** — silent-graph cost is the biggest lever: convolvers on
silence (~8 pts), idle synth/FX graph on the audio thread (17 pts with the drone off, 9 pts sampler-only), drone voices
(~4 pts). **UI side (next workflow, `idle-cpu-ui`)** — stop the meter rAF loops when peak stays 0 and cap at 30 fps
otherwise; make the 150 ms `readRuntime`/`renderDroneReadout` tick write text without layout (fixed-width number cell);
actually honour `data-low-resource` (no rAF, no analyser reads). **LOCAL** — decide `backgroundThrottling` (probably
keep it off for audio but call `controller.setWindowVisible(false)` from the hide path so low-resource kicks in).
- **Runs** (Linux, 2 CPUs; load 8–34 from parallel agents): `node test/phase2/ui-core/run.mjs`, 55 tests.

  | Run | Passed | Failed |
  |---|---|---|
  | 1 | 52/55 | boots, next/prev, fader drag |
  | 3 | 51/55 | boots, next/prev, fader drag, Quick TAP |
  | 4 | **53/55** | next/prev, Quick TAP |

  Run 2 was cut off by my own 590 s timeout. The failures are load timeouts, as follows:
  - The 9 round4-perform tests and the polish-2A responsive test (with the 2 new viewports) passed in every
    completed run.
  - **Quick TAP** got 49–71 BPM. Its clicks land 500 ms + Playwright overhead apart under load, so the ±20
    tolerance fails.
  - **`next / prev`** failed in all 4 runs, at its first `waitSong`, which has a 30 s bound. **It is not from this
    section.** It reproduces with perform.js, main.js, styles.css and quickSheet.js reverted, on a symlinked copy
    of `app/`. After walking all 19 factory songs (the large-set window), selecting song 0 again keeps
    `status.loading` true for **≈ 58 s** at load 18. It then settles, with `memory.mode` `large-set`. The
    reviewer's baseline passed at load 1–4, before `## round4-controller` landed. This is for the controller
    owner, whether it is load or the C2/C3 window.

## round4-edit-lib (reviews/round4-edit-lib.md M1, m1–m3, n1–n3; views/edit/shell.js, panels/{song,song-header,slot}.js, edit-v2 tests)
- **M1 (major), ⌘Z after a song switch wrote the shown song's notes into the previous song.** Two guards:
  - `shell.js` `core.songField`: the focused song id is forgotten on `focusout` (Chromium: change → blur → focusout,
    so the change commit and song.js's blur flush still use the focused id; afterwards `commit()` falls back to
    `core.songId`). `core.fieldSongId()` therefore reads the shown song once focus has left.
  - `song.js` notes `input`: when the textarea is not `document.activeElement` (a frame-level undo/redo from
    Perform, Edit ▸ Undo, or another field), the store's notes are painted back and nothing is committed.
  - Measured (reviewer's E6c/E6d, rerun): A stays "Song A notes. Typed in A" (was B's notes) with focus in B's tempo,
    with nothing focused, and in the real app from Perform (Ctrl+Z). Undo while typing in the notes still commits
    (E6a). Same-song undo from the visible Edit view (E6b) still moves focus to the notes and reverts, as before.
- **m1, slot Lowest/Highest note fields** are `text:'dirty'` (was `true`): a focused, untouched field follows an
  outside write (Set lowest… answered by a MIDI key; a mini-keyboard drag keeps focus in the field) and the forced
  focusout re-apply fixes a held-back one. E2a: field D3 (was C2) for lowNote 50; E2b: B2 for 47 (was C2).
- **m2, IME.** Enter / Esc keydowns with `isComposing || keyCode === 229` are ignored in the song name, tempo and
  note fields (the candidate-confirm Enter blurred and committed "Prayer Wash さんび" mid-edit). Notes: `input`
  during a composition no longer arms the 500 ms debounce; `compositionend` arms it. Setlist rename (outside scope)
  still lacks the guard.
- **m3, tempo bad input.** `validity.badInput` ("1e", "-") paints the stored tempo back and commits nothing (was
  `commitTempo(null)`, clearing the tempo). An empty field + Enter still clears.
- **n1.** `pctx.listen / onLeaveSong / onLeaveView / onEscape` return an unsub that also drops its entry from the
  panel ctx's `own` list (`keep()`), so each slot rebuild no longer leaves one closure (holding the destroyed binder)
  until unmount. New test hook `pctx._ownCount()`.
- **n2.** slot.js sets `leavingSong` in its leave-song hook (cleared in a microtask; the shell blurs the song field
  in the same task), and a note field's `change` with an unparsable name then reverts without the warn toast.
- **n3 (was SUSPECTED; confirmed by the new test: the old item is detached).** `buildMenu()` re-focuses the item with
  the same `data-value` / `data-action` (else the checked one, else the first) when focus was inside the menu.
- **Tests (edit-v2):**
  - `song.test.mjs`: "round4-edit-lib M1" (E6c, focus in tempo and nothing focused; asserts the undo really reached the
    field as `input:historyUndo`, A and B unchanged, field repainted; E6a still commits) and "m3/m2" (1e / - keep 88;
    empty clears; CDP IME composition commits nothing for 800 ms, then `insertText` commits "Base. 賛美").
  - `song-header.test.mjs`: "round4-edit-lib m2" (CDP composition + keyCode-229 Enter keeps focus and the name;
    the real Enter then commits the composed name).
  - `slot.test.mjs`: "round4-edit-lib m1" (E2a, E2b, typed draft still protected) and "n1/n2/n3/m2" (no toast on the
    switch, H9 + Enter still toasts, IME Enter, menu focus kept across an `'instruments'` rebuild, `_ownCount`
    stable over 4 rebuilds).
  - `integration.test.mjs`: "round4-edit-lib M1" (E6d, real app, Ctrl+Z in Perform after a switch).
  - Mutation check (song/song-header on a prayer-wash copy of the files): M1, m2 and m3 reverted → the three new
    tests fail (M1: "A keeps its own notes"; m3: tempo null; m2: "still editing").
- **Runs (Linux, 2 CPUs, load 5–37 from other agents):** each file passed in some run: song 10/10, song-header
  11/11, shell 10/10, slot 14/14, integration 13/13, setlist 13/13, effects 5/5, bottom 5/5; drone 5/6 twice (a
  different test each time, both `__rig.ready` 30 s boot timeouts); master 2/4, 1/4, 2/4 (every test passed in one
  of the runs; the rest were boot timeouts); integration-widths 0/5 in 4 runs, every failure its own 30 s
  `__rig.ready` bound (TO DO: re-run on a quiet box). Measured on the harness at load 11: `__rig.ready` resolves 26–34 s after load on the
  default song (Sunday Pad + Piano), right at the 30 s bound.
- **Not a round4 finding, unverified:** in headless Linux Chromium, an `a[download]` blob name with non-ASCII
  characters ("Café.rig-song.json") arrives as `download`. Asked LOCAL to check an Export song on the Mac
  (reviews/for-local.md).

## l20-l21 (local L-20 song name, L-21 EQ note cells; SF Pro on the Mac; eq-keyboard.css / .js comment, styles.css `.song-name`, ui-core + eq tests)

Both failures are font-metric findings: the Linux suites render with Liberation Sans (Arial metrics), and SF Pro is wider
and has its own ascent/descent. `reviews/local-findings.md` is not in the cloud tree; the details come from
`reviews/round4-perform.md` and `reviews/for-local.md`. Neither fix can be run on macOS from here; they were proven with an
`@font-face` stand-in (below).

- **L-20 (song name 42 > 40 at 1280×800).** The line-height fix (1.05 → 1.25, "## round4-perform" P2) was already in the tree.
  This adds a pin: `.song-name { height: 1.25em; max-height: 1.25em }` in styles.css (additive, after the `.song-name`
  rule). It is the same value as the natural one-line box, so nothing moves on Linux, but a fallback font with a taller
  content area (CJK, emoji) can no longer grow the row. Test: the P2 test now also runs `SFsim` (FreeSans widths, SF
  ascent .95 + descent .24 = 1.19 em) and `SFstress` (1.23 em, just inside the 1.25 em box), and asserts the box equals the
  computed line-height × 1 line (±1 px) instead of a font-specific height. The exact `scrollHeight ≤ clientHeight`
  assertion stays: at 1.25 em it holds for every font up to that content height, which is the contract.
- **L-21 (EQ note cells overflow at 1100 px).** Cause: the note cell ("≈Db6 −49¢ · 1.08 kHz", the widest proportional-font
  text in a fixed column) had 124 px (full) / 64 px (compact) of room. Measured worst labels: Arial-like 12.5 px compact 55–63 px,
  full 108–133 px. Under a 105–112 % wide stand-in the old columns overflow (full at ≥ 1124 px, compact at 1100 px with 112 %). Even
  on Linux the full layout overflowed for "above C8 · 12.5 kHz" (126 > 124), which the test's bands never showed.
  - `col.c-note` 150 → 172 px (full), 84 → 100 px (compact). Compact dB 58 → 62 and Q 54 → 58 (the mono "−12.5" had 0.5 px to spare).
  - `.eqk-bands input.eqk-note`: `font-variant-numeric: tabular-nums`, `min-width: 0`, `text-overflow: ellipsis`. Selects get
    `min-width: 0` + ellipsis, and `.eqk-acts` tabular-nums.
  - The extra width comes from "Acts on", which is flexible and already ellipsizes: full 152 → 130 px at the 1080 px threshold. `COMPACT_BELOW_PX`
    stays 1080 (comment recomputed: 950 + ≥ 130). The compact table now needs 750 + acts.
  - Tests (eq): the "compact threshold" test tolerates `scrollWidth ≤ clientWidth + 2` (was +1; Retina rounding). New test "L-21: worst-case
    note labels fit their cells under emulated SF Pro metrics" mounts eight worst-case bands at 1100 (compact) and 1124 / 1280 /
    1440 (full) under 105 % and 112 % stand-ins and canvas-measures every cell's text against its content box.
- **Suites (Linux, box load 12–38, serial):** eq 27/27 (26 + the new one; several runs died at the 30 s `waitRigReady` bound
  before any test, and the pass came on a re-run). ui-core: the last three full runs were 52–54/55 with the failures in
  unrelated timing tests (setlist next/prev `waitSong`, Quick tap-tempo, hold-Enter lock, boot; the first two also fail
  on the untouched tree at load 25). "polish-2A responsive" and "round4-perform P2" pass in each of those runs. No fully green
  ui-core run was obtained on this box.
- **Mac, please verify after the drop:** `node test/run-all.mjs --only ui-core,eq`, and report the note-cell text widths if eq still fails
  (`L21_MAC pass/fail card=<w> compact=<y/n>`). Not verifiable here: SF Pro's real advance widths (the stand-in is FreeSans × 1.05–1.12).

## idle-cpu (engine audio.js + drone.js: instruments connected only while they play; tools/idle-cpu.mjs; reviews/idle-cpu.md)
- **Cause.** An idle `warm-pad` (and the drone's `drone-osc`, same `voice.js` `monoBelow` stage) was never flagged
  silent by Chromium, whether it had never been played or had been played and released. Its strip, EQ, sends, the
  reverb convolver (+ its background thread), chorus and delay then processed zeros for as long as the song stayed
  loaded. Reproduced in plain Web Audio (a GainNode with no inputs → highpass → the monoBelow topology →
  ConvolverNode keeps the convolver busy). Of the 19 synth/organ patches and the first 5 samplers, only warm-pad
  leaks. The Chromium mechanism itself is unverified.
- **Engine change (additive; no param or schema change).**
  - `prepare()` no longer connects a fresh instrument to its strip. `_armSlot(sc)` connects `inst.output →
    strip.input` just before a note (`noteOn` poly path and `_monoSwitch`).
  - In realtime only, `_pollIdleSlots` (AudioTimer, every 0.5 s while any slot is armed) disconnects an instrument
    that has had no live voice (`liveVoiceCount() === 0`, no mono voice) for `SLOT_IDLE_DISARM_SEC` = 2 s (new
    export). An instrument without `liveVoiceCount` is never disarmed. Offline renders keep the old timing apart from
    the connect-on-first-note.
  - Slot channels gain `armed` and `idleSince`. A reused instance keeps its connection.
  - `drone.js`: a drone-osc instrument's output is connected to its layer gain when `_takeInst` takes it and
    disconnected when `_returnInst` puts it back in the idle pool (its layer had faded to 0 and its voices ended).
- **Numbers (2-CPU Linux box, renderer % of one core, `tools/idle-cpu.mjs`).** *Sunday Pad + Piano*, drone off:
  31.3 → 15.6. The audio thread went 18.4 → 8.3 and the reverb thread 6.2 → 0. After one note: 30.2 → 14.2. With the
  drone on the saving is the pad chain only (≈ 3–4 points, inside noise). Glass Ocean 16.4 → 15.0, Grand Piano
  17.1 → 15.9. In-app bisect after the fix: after a note 8.2 audio / 0 reverb, drone on→off→on→off back to 8.8 / 0.
  The Mac's drone-off row (35.1 %, reviews/idle-cpu-mac.md (b)) is this leak.
- **Tests.** Engine `offline.idleArm`:
  - not armed after commit;
  - the split poly note arms slot 0 only, and the mono note arms slot 1;
  - a same-song re-prepare reuses the armed instance;
  - both notes sound.

  Engine `realtime.idleDisarm`:
  - a held note stays connected;
  - disarmed 2.0–3.0 s after the last voice ended (measured 2.4 s);
  - the next note re-arms, and the slot meter reads > 0.01.

  Full engine suite at load 20–30: 68/72. The 4 failures were load:
  - `stuckNoteFuzz` and `realInstrumentsSmoke` timed out at 120 s. Alone, both pass; `stuckNoteFuzz` takes 36.1 s
    against 38.2 s on a pre-fix copy.
  - `droneFiles` passes at load 3.
  - `eqCpu` gives its soft load warning.
- **Tool.** `tools/idle-cpu.mjs` (LOCAL-owned dir, new file, written by this workflow). It profiles configurations A
  … K: per-thread renderer CPU from /proc, CDP metrics, rAF / timer / analyser / DOM-mutation rates with call sites,
  running animations, live sources, reverb units, an offline DSP estimate, and `--emulate-prefix`. On Linux only for
  the per-thread numbers.
- **Requests (UI side; details and the evidence are in reviews/idle-cpu.md).**
  - **R1 meters:** `meter.js` writes only on change, and moves the hold with `transform`, not `left` (layout). Both
    `meter.js` and `levelMeter.js` cap at 30 fps and stop re-arming rAF while the level stays 0. Worth ≈ 8–10 main
    + 3–4 compositor points here, and up to 11 GPU points on the Mac with the drone on.
  - **R2 spinner (styles.css, one rule):** `.song-loading-spin` animates only under `.song-block.loading`. Today it
    spins forever at `opacity: 0`, the only running animation in Perform. Compositor 1.6 → 0 and GPU 0.9 → 0 with
    the meters still.
  - **R3** `perform.js` `readRuntime`: don't rewrite an unchanged `.pedal-lamp` `aria-label` (6.6 mutations/s), and
    give the drone dB readout a fixed-width cell.
  - **R4 hidden window:** pause the meter loops on `status.windowVisible === false` even outside menu-bar mode.
    Measured: `setWindowVisible(false)` without menu-bar mode changes nothing. LOCAL should send `windowHidden` /
    `windowShown`.
- **Engine fixer (idle-cpu #2–#4; details, numbers and the Chromium measurements in reviews/idle-cpu.md "Engine
  fixer").** Additive; no param, schema or store change. Offline renders are unchanged except #3's pin.
  - **#2 send-effect idle sleep (realtime only).** fx.js: `FX_IDLE_POLL_SEC` = 0.25, `FX_IDLE_HOLD_SEC` = 1,
    `FX_IDLE_THRESHOLD` = 1e-5 (exports); `FxGraph.enableIdleSleep()` (no-op offline), `idleTick(busy)`,
    `wakeAll()`, getter `fxAsleep` (names); `Reverb.sleep() / wake() / asleep`; `Delay.canSleep() / loopPeriod()`.
    audio.js `_pollFx` calls `idleTick` every 0.25 s for the engine's life (one AudioTimer node per poll; `timers` in
    stats is now ≥ 1); `_armSlot` calls `fx.wakeAll()` before every note; `_debugStats()` gains `fxAsleep`. Drone
    takes an optional `wake` callback (called before a new layer / pad file). A sleeping reverb has its active unit
    unfed (tail rings out); a sleeping delay / chorus has its return disconnected from the FX sum (not processed).
    Sleep needs: no armed slot (incl. retiring), the effect's tap < −100 dBFS for 1 s (delay: + loop period).
    Reverb / echo onsets after a wake match a never-sleeping engine to the sample.
  - **#3 `rampTo` pins its target** (shared/automation.js, new export `RAMP_SETTLE_TC` = 12):
    `setValueAtTime(value, when + 12 τ)` after the setTargetAtTime. Chromium never ends a SetTarget: converged
    biquads stayed on the per-sample path (+60 % cost; k-rate did not help) and a GainNode ramped to 0 was never
    flagged silent (a convolver behind it ran forever). Later helper calls cancel a pending pin (cancel-and-hold).
  - **#4 drone parked at gain 0** (drone.js export `DRONE_PARK_SEC` = 10, field `parked`): 10 s at drone.gain 0 →
    layers fade out, voices end; setKey / setMode while parked are remembered; gain > 0 restarts in the latest key.
  - **Numbers** (2-CPU box, renderer % of a core, back to back pre/post engine, same UI): Sunday drone off 7.8 → 5.1
    (audio thread 7.4 → 4.1), Glass Ocean 9.2 → 6.5, Grand Piano 7.6 → 4.3, Sunday drone on 34.3 → 33.0 (noise;
    its DSP is the sounding drone: ≈ 5.5 points of voices + ≈ 15 of reverb on the drone send, see the review).
    **Target "A ≤ 15 %" is not reachable without changing the sound.**
  - **Tests:** engine `realtime.fxIdleSleep`, `realtime.droneOffNoVoices`, `offline.droneParkGain0`;
    `realtime.lowResource` race fixed (it waited on nothing for the start-up unit's 0.85 s fade; failed 2/3 on the
    pre-change engine too); `test/unit/shared/automation.test.mjs` updated for the pin (+1 test). Engine suite
    73/75 at load ≈ 7 (lowResource race, since fixed; eqCpu soft); at load 40–100 only runner timeouts, each passing
    alone (stuckNoteFuzz with a longer bound, same time as the pre-change engine); unit shared 225/225; instruments
    140/143 vs 139/143 pre-change at the same load (perf × realtime on both). The phase-2 eq suite never booted
    within its 30 s bound at load ≈ 45 (the pre-change tree took 189 s to ready); not validated.
- **UI requests, refreshed after R1 / R3 landed (measured on the 2-CPU box, Sunday, drone on, Perform).** The meter
  still costs main ≈ 5.9 + compositor ≈ 2.7 points while the drone sounds (A vs low-resource D: 5.9 → 0.8, 2.7 → 0),
  with 50 rAF callbacks/s of which 24 only return (30 fps cap), 53 DOM mutations/s and 4 layouts/s.
  - **R1b (meter.js:72):** the peak hold still writes `style.left` / `bottom` (4.7 writes/s → the 4 layouts/s): move it
    with `transform: translateX()/translateY()` like the fill.
  - **R1c (meter.js:90):** a frame skipped by `MIN_FRAME_MS` still costs a BeginMainFrame + rAF dispatch (24/s here,
    ≈ 90/s at 120 Hz ProMotion). Request the next frame from a `setTimeout(MIN_FRAME_MS − elapsed)` (then rAF), so
    only ≈ 30 frames/s are produced.
  - **R2 (styles.css:665)** still reads `animation: spin .8s linear infinite` unconditionally; one run (23:12) still
    counted 1 running animation in Perform with the drone off, a later one 0. Please confirm it only runs under
    `.song-block.loading`.
  - **R4** unchanged (LOCAL: `windowHidden` / `windowShown`; pause meters while hidden outside menu-bar mode).
  - The 150 ms `readRuntime` tick now writes nothing at idle (0 mutations/s with the drone off): R3 is done.

## security (C6 critics: reviews/security.md S2, S3; app/js/store.js, test/phase1/shell/security.test.mjs)
- **S2: imports are bounded.**
  - `store.importJSON` refuses input nested deeper than `IMPORT_MAX_DEPTH` = 64 (exported). The check is an iterative
    walk, run before any clone. The deepest real path is about 8.
  - It also refuses an import whose resulting library is over `LIBRARY_MAX_CHARS` = 2,000,000 compact JSON characters
    (exported). A merge counts the current library too. Text over 4 × the cap is refused unparsed.
  - All of these return `{ok:false, error}` and never throw.
  - Before: a song nested 5,000 deep threw `RangeError` out of importJSON (unhandled in Settings › Import). A 6 MB
    song imported, and then every save failed with `QuotaExceededError`: Chromium localStorage is about 5,234,375
    characters per origin (measured).
- **S3: `exportJSON` omits `DEVICE_LOCAL_SETTINGS`** (padFolder, with its `/Users/<account>/…` path; outputDeviceId;
  midiInputId; midiInputName; menuBarMode; lowResource). Nothing read them back: a replace-import keeps this machine's
  values, and a merge ignores settings. The Electron auto-backups use the same export, so they no longer carry them
  either. `midiLearn` is still exported.
- **Tests:** `security.test.mjs` has 4 tests: S1 prototype keys, S2 depth, S2 size, S3 export. S2 and S3 fail on the
  previous store.js. The shell unit suite is 188/188.
- Server, main, preload and tools findings (S1 public Apple `.exs`, S4–S8) are requested in `reviews/for-local.md`.

## small-fixes
- **Task B: `shared/params.js` label `Reverb level` → `Space level`** (row `fx.reverb.returnGain`; also the raw-engine
  harness label in `engine/test.html`). Edit, Settings and Perform already said "Space level"; only `describe().label`
  consumers see the change. Key/path unchanged.
  - Why no key rename or `migrate()` entry: the MIDI-learn map is keyed by controlId (`settings.midiLearn[controlId]`),
    and stores `{cc|note, channel}` only, never a label, so a label rename cannot invalidate a stored map. The key
    `fx.reverb.returnGain` is also the data-model path of every song (`patch.fx.reverb.returnGain`), wheel targets and
    fx-presets; renaming it needs a song migration and is out of scope (BACKLOG item closed by the label change).
  - Unit: shell `--only unit` 188/188.
- **Task C: L-14 test gap (hide-on-close), test-only.**
  - New test in `test/phase1/shell/electron.boot.mjs`: `window.close()` with menu-bar mode on must hide (not destroy)
    the window and send `windowHidden` over `rig:menu`. The page step `hideOnClose` is in
    `test/phase1/shell/fixtures/app/electron-selftest.js` and runs last.
  - The hooks it needs are not in `main.js`/`preload.js` yet (LOCAL-owned; the SELFTEST branch of `win.on('close')`
    also bypasses any hide). The exact request (`rig.getMenuBarState()` payload with `windowVisible` /
    `windowDestroyed`, `rig.setMenuBarMode`, no SELFTEST bypass while `menuBarMode`) is in `reviews/for-local.md`
    "## L-14". Until then the test skips: "L-14 hook absent: window.rig.getMenuBarState / setMenuBarMode absent…".
  - No production code changed.
- **Task A: CI flake in `song: L-9` ("the storm ran"), test-only** (`test/phase2/edit-v2/panels/song.test.mjs`). The
  storm was a 20 ms `setInterval` stopped after a wall-clock window and asserted `count > 10`; on the macos-14 runner
  (suite ~3x slower) too few ticks fired. It is now a promise loop that drives a fixed number of `store.set` writes,
  each awaiting a >= 20 ms tick (30 for tempo, 70 for notes), and asserts `count === n`. The drafts-unchanged
  assertions are untouched. `--only song` 10/10 green. No production code changed.

## themes-setup (Ryan 2026-09-28: every warmth direction ships as a selectable theme; app/themes/README.md)
- **Registry** `app/js/shared/themes.js` (pure). `THEMES` is a list of `{id, name, mode:'light'|'dark', css, family,
  swatch:{bg,panel,text,accent}, body?:{theme,mode}, coming?}`. It also exports `DEFAULT_THEME_ID = 'sanctuary'`,
  `THEME_MIRROR_KEY = 'worship-rig.theme'`, `byId()`, `isValidId()`, `resolveThemeId()`, `pickableThemes()` and
  `themeAttrs()`.
  - The themes: `classic` (no file), `sanctuary` (sanctuary-v2, default), `sanctuary-day` (sanctuary-v2, light,
    **coming**: hidden until its light-dark() sibling lands), `daylight-stage` / `daylight-day` (daylight-v2, dusk /
    day), `studio`, `ember`, `nave` (sanctuary v1).
  - Entries are keyed by css path, so renaming a folder changes one string here and one in boot.js.
  - `body` is a transition shim: the legacy `<body>` attributes today's files still guard on.
- **Store**: `settings.theme` is optional. When absent, the default applies. `store.set('settings.theme', unknown)`
  stores the default and never throws. A loaded library with an unknown or non-string id gets the default. Nested
  writes (`settings.theme.x`) are refused.
  - There is no SCHEMA bump.
  - A theme change doesn't flip `meta.edited` (new `LOOK_SETTINGS`). It is not device-local, so it is exported with
    the library.
- **Boot** `app/themes/boot.js` is a classic script with no imports, so it runs synchronously in `<head>`.
  `index.html` and `mini.html` include it twice: first in `<head>` (after the CSP meta), and again as the last element
  of `<head>`.
  - The first include reads the mirror and validates it against its own copy of the id → `{css, mode, body}` map. It
    sets `html[data-theme|data-mode]` and `html.style.colorScheme`, preloads the sheet, and writes
    `body[data-theme|data-mode]` from a MutationObserver as soon as `<body>` exists.
  - The second include appends `<link rel=stylesheet id=theme-css blocking=render>`. It must come after the app's CSS
    because theme rules win on source order, and a script can only add render-blocking sheets before `<body>` exists.
  - With a single include, the sheet is linked at DOMContentLoaded instead.
  - `window.__rigThemeBoot = {key, def, map, id, link}` is exposed for tests.
- **Runtime**: `applyTheme(id)` in `app/js/main.js` is driven by a store subscription on `settings.theme`. At boot it
  reconciles the store against the mirror, and the store wins.
  - It writes the mirror, then loads the new sheet at the end of `<head>` with `media="not all"`. It adds that sheet's
    `@font-face` files to `document.fonts` and waits up to 1.5 s for them. Then, in one task, it enables the new sheet,
    removes the old one and flips html/body attributes.
  - Siblings in the same file only flip attributes. A newer switch cancels an older one.
  - `globalThis.__rig.theme = {apply, current, pending}` is exposed for tests.
  - `mini.html` follows the mirror through its own boot.js. The bus doesn't carry the theme yet.
- **Picker**: Settings › Appearance › Theme (`settings.js`) is a radiogroup of swatch cards
  (`[data-testid=setting-theme]`, `theme-card-<id>`) with a roving tabindex. Arrow keys, Home and End select, and
  `coming` themes are hidden. It sits before "Perform view". The CSS is at the end of `styles-edit.css` (`.st-theme*`).
  - `settingsView.open({section})` now scrolls to `[data-section=<name>]` and focuses its checked radio or first
    control. Only `appearance` has a data-section today.
- **Quick › This Mac**: the caption row has a compact `Theme: <name> ▸` button (`[data-testid=quick-theme]`,
  `.qs-theme` CSS at the end of `styles.css`). It is not an extra row, because the sheet height is fixed; the first
  try as a row overflowed it.
  - The button closes the sheet and dispatches `document` event `rig-open-settings` `{section:'appearance'}`, which
    main.js answers with `openSettings`. `o.onTheme` overrides this. The button is frozen under Lock like the rest of
    This Mac.
- **One mark**: `app/themes/sanctuary-v2/mark.svg` → `app/assets/mark.svg`. It is used by `.tb-logo`, the start
  overlay, the mini "waiting" logo and both favicons, and replaces `icons/icon.svg` in those places. The packaged app
  icon (`build/`) is unchanged.
  - Themes still override it with `content: url(...)` today. Their agents remove that; README rule 8.
- **Fonts**: the 7 woff2 files and 7 OFL texts moved from `app/themes/*/fonts/` to `app/fonts/`. Files with the same
  name were byte-identical (sha256), so there are 7 unique fonts. Total 274 KB of woff2 (280,248 B), plus 30 KB of
  OFL text.
  - Each theme.css `@font-face src` now points at `/fonts/…`; that is the only edit made in the theme files.
  - The fonts are listed in LICENSES.md "Theme fonts".
- **Per-theme size** (folder plus the /fonts it names; the limit is 250 KB, unit-tested): Sanctuary 119, Daylight v2
  165, Studio 90, Ember 98 and Nave 122 KB. boot.js is 3.7 KB.
- **Tests**
  - `test/unit/shared/themes.test.mjs` (9, in the `unit` suite): registry shape; boot.js map ↔ registry sync (runs
    boot.js in a vm); boot behaviour; both HTML heads; store validation; `meta.edited`; the size budget and `/fonts`.
  - `test/phase2/themes/run.mjs` (new `themes` suite in run-all, phase2 / fast tier; `--only`, `--theme`).
    - Per theme: boot with the link inserted while `readyState=loading`, before `<body>`, `blocking=render`, and loaded
      before first-paint; attributes; 0 console errors and 0 HTTP ≥ 400.
    - Store-wins and unknown-id fallback.
    - A runtime switch with per-frame sheet/attribute consistency, the UA-default background never showing, and a
      one-frame screenshot.
    - The picker, Quick, and mini.
    - Selector coverage (`css-selectors.mjs`) → `coverage-<id>.json`.
  - `tools/themes/shoot.mjs --theme <id> [--out] [--only] [--size]` takes perform, quick, edit and edit-tone-eq
    screenshots plus the contrast audit JSON. It applies the theme the app's way, and is moved and generalised from
    `design/warmth/daylight-v2/shoot.mjs`, which was deleted; Today-sheet mocking was dropped.
    - Checked on daylight-stage: 0 contrast fails in all 4 shots (lowest 5.17, PANIC) and 0 errors.
- **Coverage as found today**, before the theme agents' fixes. The walk covers 21 states: Perform idle / held (incl.
  black keys and pedal) / toast / info banner / low-resource / muted Pad / Sing-it-in / step panel / faded / Quick /
  locked, Edit held + all 7 block tabs + Advanced › Tone EQ, and Settings. **All 5 files FAIL**:

  | theme(s) | selectors | unmatched | % | dead-class selectors |
  |---|---|---|---|---|
  | sanctuary (sanctuary-v2) | 274 | 61 | 22.3 | 31 (`.sanct-before*`, `.sanct-breath`, `.sb-*`) |
  | daylight-stage + daylight-day | 340 | 85 | 25.0 | 43 (`.dl-today*`, `.dl-ic`, …) |
  | studio | 345 | 52 | 15.1 | 27 (`.studio-session`, `.ss-*`) |
  | ember | 219 | 41 | 18.7 | 24 (`.ember-welcome`, `.ew-*`) |
  | nave (sanctuary v1) | 276 | 61 | 22.1 | 31 (`.sanct-before*`, `.sanct-breath`, `.sb-*`) |

  The dead ones are the start-screen mock hooks, and they count as unmatched too. Without them the rates are Sanctuary 12.3 %,
  Daylight 14.1 %, Studio 7.9 %, Ember 8.7 % and Nave 12.2 %. The rest is mostly states the walk can't reach cheaply: `.rec-btn.recording`, `.led.flash`,
  `.swell-btn.on`, `.drone-swell.up`, `.bstrip.open`, `.settings-placeholder`, `.meter.vertical` and the Edit wheel
  lanes.
- **Also run**: settings 31/31; mini 14/14 (a first run failed low-resource "frames still run (4)" at load avg 10;
  the rerun was green); shell unit green.
- **Default flip vs existing suites.** ui-core (run once, load avg ~10) gave 47 pass / 8 fail.
  - At least 3 failures come from the new default look, because they assert Classic tokens and metrics:
    - #4: `--muted-fader` expected `#707a88`, got Sanctuary `#8a8594`;
    - #33: the OFF tile background;
    - #46: the Carlito `.song-name` line box versus Alegreya.
  - #40 (responsive clipping) is likely the same cause.
  - #6, #30 and #36 (TAP BPM got 69) look like load or timing.
  - I did not edit ui-core: other sessions were modifying it at the time.
  - The new `pinTheme(context, 'classic')` helper in `test/integration/lib.mjs` pins a theme for a whole Playwright
    context. It writes the mirror and `settings.theme` in the library before any page script runs, and was verified:
    Classic with no theme link, 19 factory songs seeded.
  - To keep asserting the base look, call it right after `newContext` in ui-core, and likely in edit-v2 and eq.

## menubar-electron (LOCAL, merged into main e553aa5 on 2026-09-29; recorded here by the cloud from local's status lines)
- Electron 44: a page-level `window.close()` destroys the window WITHOUT a `BrowserWindow 'close'` event, so hide-on-close
  and backup-on-close never ran from that path. preload now routes `window.close()` through IPC `rig:closeWindow` →
  `win.close()` in main (c0d64c2). This is the real fix for L-14; the cloud's Electron test (`hideOnClose` step) now
  has its hooks: `rig.getMenuBarState()` returns `{menuBarMode, windowVisible, windowDestroyed}`; `rig.setMenuBarMode(on)`.
- `rig:window-visible` (IPC → DOM CustomEvent `{detail:{visible}}`) is sent on every main-window visibility change
  (show/hide incl. ⌘H, focus, minimize/restore, hide-on-close, openMain, dock), regardless of menuBarMode, deduped.
  `backgroundThrottling` stays false; the renderer does its own throttling (C9).
- Tray icons: `build/trayTemplate.png` and `@2x` are in `build.files`; build-lint allows exactly those two in the asar and
  checks they are packaged (e553aa5). App size 379 MB (du 366 M) — under the 500 MB rule.
- `app/mini.html` add/add on merge → the cloud version; local's `drivePlaceholder` stays inert without the placeholder meta.
- Notes from local: `main.js:568` comment about `build/` not shipping is stale (icons ship now; embedded fallback kept) —
  LOCAL to fix in its own file. The two `themes/boot.js` script tags in index.html/mini.html are **intentional**, not a
  dupe: the first run (top of `<head>`) sets `html[data-theme]`/`[data-mode]` before anything paints; the second run
  (last element of `<head>`) appends the render-blocking `<link id=theme-css>` AFTER the app's stylesheets, because theme
  rules win only by source order and a script can't wait for `<body>` while still adding a render-blocking sheet
  (`boot.js` line 19: `if (w.__rigThemeBoot) { // second include`). Documented in app/themes/README.md.

## critics-fix (C6: reviews/onboarding.md, performance.md, security.md; renderer only — app/js/**, app/styles.css, edit panel CSS)
Every S item of the three critics reviews that lives in renderer code, plus the M items that are clear bugs (O1 was
S) and the first-run card onboarding.md asks for. LOCAL items (README R1–R6, server/main/preload/tools S1, S4–S8)
stay in `reviews/for-local.md`; engine items (performance #1, #4, #5a/c/d) stay frozen/report-only.

**Onboarding (reviews/onboarding.md)**
- **O1 (bug), hold-to-unlock re-locked after a long hold.** `components/holdButton.js`: a completed *pointer* hold
  sets `swallowClick`; the one click that ends that press is swallowed, however long it lasted. The flag clears on
  that click, the next `pointerdown` or the next Enter/Space `keydown` (so a keyboard hold never leaves a click
  swallowed). Replaces the 600 ms `suppressClickUntil` window (1.3 s / 2 s holds re-locked; measured by the reviewer).
- **O2, "Loading…" over the title.** `songLoading` moved from the absolutely positioned `.song-flags` (deleted) into
  the KEY row (`.song-sub`) as a flex item that shrinks and ellipsizes; it takes `.song-bpm`'s place while shown
  (`.song-block.loading .song-bpm {display:none}`). It is `display:none` when not loading, so the spinner no longer
  animates at opacity 0 forever (idle-cpu R2).
- **O3.** `#ready-status` title while loading: "Loading the songs in the set (n of N ready). You can play now." (the
  "Loading n/N" text itself is unchanged: the top bar has no room, L-6). Ready restores the old title.
- **O5.** Settings › MIDI, no keyboard: "No keyboard connected — plug one in (it connects by itself), or play the
  computer keys A–;." Settings › Computer keyboard lists the whole `KEY_MAP` (`… K O L P ;`, from middle C, plus ←/→).
- **O7.** Wake-lock toast: "The screen may dim or sleep during long songs. For the service, set the display to stay on."
- **O8.** Quick: "Under Lock: This song still works, This Mac can’t be changed"; pedal row "press it: the light comes
  on" (+ tooltip); "This song’s echo keeps its own time." (was "is fixed").
- **O9.** Settings › My Samples: the raw folder path (`.st-samples-path`) sits inside the GarageBand disclosure with
  the Terminal steps; outside it only a plain "isn’t turned on here" line (`.st-samples-note`) when unsupported.
  Menu bar: "Modes from" → **Menu-bar songs** with "The songs (“modes”) the menu-bar icon lets you switch between, up to
  6."; the live resource line (`setting-mb-resource`) moved into **Diagnostics**.
- **O11.** REC stopping: `#rec-time` shows "Saving…" (`.saving`, 12 px so it fits the 6ch cell) until the file is done.
- **O12.** Edit setlist: **+ Setlist** (was "New"; title "New setlist" unchanged) and **+ New song** (was "+ New");
  a pencil button after the song name (`.ev2-song-pencil`, "Rename song": focuses and selects the name); name
  tooltip "Song name: click to rename"; Perform Revert's tooltip says changes are saved with the song and where Reset
  to factory is.
- **O13.** Under Perform lock a tap on the disabled Edit tab or ⚙ toasts "Perform lock is on — hold Lock to unlock,
  then edit." (document capture `pointerdown`: Chromium sends pointer events, not clicks, to disabled buttons).
- **O14 (bug).** The top-bar lamp said "Sound OK" under "Click anywhere to start audio": the controller's status
  starts `audio:'running'` and corrects itself only on its 1 s tick. `main.js renderAudioStatus()` lets the context's
  own state win (`running` + ctx not running → Paused; no ctx yet → "Sound"), and re-renders on the engine's
  `statechange` and when the overlay shows.
- **"First 60 seconds" (M).** New `components/startCard.js`: a one-time **Start here** card at the top of Perform's
  Notes panel (no overlay: at ≤ 1340 px it is inside the Notes pop-over). Lines: no keyboard → A S D F G H J K on the
  computer (Space = sustain), plug in any time (switches to "Your keyboard is connected" when MIDI connects); → / NEXT
  = next song, Space row = room; Lock / hold to unlock. It closes on × or on the first song change and never comes
  back (`localStorage['worship-rig.start-card'] = 'done'`; storage blocked → this session only). Perform view:
  `get startCard` (test hook: `reset()`, `dismiss()`, `shown`).
  - Key letters: `pianoKeyboard().setKeyLetters(Map<note,label>|null)` (keys.js). Perform shows `KEY_MAP`'s letters on
    C4…E5 (following Z/X octaves, controller `'kb-octave'`) while no MIDI keyboard is connected and
    `settings.computerKeyboard` is on; the C4/C5 label gives way on lettered keys.
- Not done here: O4 (named Space/Echo on the first 11 factory songs: a sound change, needs a listen), O10 per-file
  pad key picker (M feature; the README fix is LOCAL's), O6/R1–R6 (README, LOCAL).

**Hardware pass (LOCAL, 2026-09-29, reviews/hardware-checklist.md)** — L-23 (lock hint clipped) is round4-perform P1,
already in this tree. Pedal wording: Settings › Test my pedal shows "Plug in the pedal and the keyboard with your foot
off the pedal: many keyboards read its direction then", and a reversed result adds the unplug/replug advice.

**Performance (reviews/performance.md #2, #3, #5b; reviews/idle-cpu.md R1–R4)**
- **#2 / R1 meters.** `meter.js`: ≤ ~30 updates/s (`MIN_FRAME_MS` 30, release scaled by real frame time), writes only
  on change (fill in 0.1 %, hold in 0.5 % steps, `clip`/`hot` flips, `aria-valuenow`), and after `IDLE_MS` (1 s) at the
  floor it stops its rAF loop and polls the analysers every 250 ms (`IDLE_POLL_MS`) until something is above −60 dB.
  `running` stays true while polling; new `animating`. `levelMeter.js`: the shared loop is ≤ ~30/s; a strip silent for
  1 s sleeps (not read at all, so the engine can drop its tap) until `wakeLevelMeters()`, which main.js calls on every
  controller `'notes'` event. New test hook `levelMeterStats()`. The hold still moves with `left` (themes paint
  `.meter-hold`'s background, so a full-width transformed box would repaint the bar).
- **R4 hidden window.** `setWindowVisible(false)` sets `html[data-window-hidden]`; styles.css hides `.meter`/
  `.lvl-meter` there as under low-resource. Fed by the menu ids and by LOCAL's `window` event `'rig:window-visible'`.
- **R3.** The pedal lamp's `aria-label` is written only when it changes (was 6.6 mutations/s from the 150 ms tick).
- **#3 wheel path.** perform.js calls `wheel.set({pickup})` only while the ghost shows or when it changes (was per
  CC); `wheelStrip.render` skips `--pos`/text/`aria-valuetext` when the value is unchanged, and `set()` guards
  `aria-pressed`/`hidden`; `fader.setIndicator` returns early when unchanged and writes `--ind` on the indicator itself
  (the rule reads it there), not on the fader root; `setWheelBadge` guards `hidden`; `util.setText` changes a lone Text
  node's `data` in place instead of replacing the node.
- **#5b.** Edit shell: while `#view-edit` is hidden, controller `'notes'` only records the held set; one catch-up
  `'notes'` goes out when the view becomes 'edit' (`core.catchUpNotes`).
- **Measured** (`tools/profile.mjs` copied with an app-dir override: `PROF_APP=<pre-fix copy>` then this tree; 20 s
  loops, `--no-profiler`, load 6–10 from other agents, so lag/noteOn are noise here):

  | song | main-thread task ms/s | layout ms/s | style ms/s | layouts / style recalcs per loop |
  |---|---|---|---|---|
  | sunday-pad-piano | 198.5 → **120.4** | 48.4 → **23.1** | 10.4 → **4.9** | 655 / 1482 → 495 / 1011 |
  | building-swell (wheel → slot fader) | 157.9 → **138.2** | 34.3 → **23.3** | 7.1 → **3.8** | 564 / 1189 → 526 / 861 |
  | grand-piano | 132.6 → **92.0** | 15.6 → **12.0** | 7.7 → **2.9** | 580 / 1300 → 461 / 675 |

  Silent Perform: 0 meter frame callbacks/s (was one per display frame: 60 here, 120 on ProMotion) and 0 meter DOM
  writes (ui-core test). Not re-measured on the Mac (requested: `IDLE_CPU_MAC3`, `HIDDEN_RAF`).
- Engine items left frozen (report only): #1 (processSample copies, warm throttling), #4 (convolver builds), #5a/c/d.

**Security (reviews/security.md)** — nothing renderer-side was open: S2/S3 were fixed in `## security`, S10 found no
injection sink. S1, S4–S8 are LOCAL (for-local.md). S11 (Trusted Types) is optional hardening, not done.

**L-10 (COORDINATION: "CLOUD documents")** — the 700 MB decoded cap is soft during a switch: `BufferCache` never
evicts a referenced buffer, so while the previous song's instruments retire (`retiring > 0`) decoded can exceed the cap
by up to that song's pinned set (754 MB once in 44 soak rows), and falls under the 595 MB low-water mark when they are
released. The soak checks the cap only in rows with `retiring === 0`. docs/ is LOCAL's: asked to add this to
docs/architecture.md.

**Tests**
- ui-core: 7 new tests (`critics-fix O1` 1.3 s / 2 s mouse holds + 2 s Enter, `O2` at 1440/1280/1024, `O3/O14/O11/O13`,
  "first 60 seconds" card + key letters, meters (#2/R1/R4: silent = 0 frames and 0 writes, a note wakes both kinds,
  ≤ 36 fill writes/s, hidden window), wheel (#3: a still wheel = 0 DOM writes, text changes in place, `--ind` on the
  indicator)); the no-autoplay test now asserts no "Sound OK" under the overlay; the polish-1 meter test allows ~30
  reads/s and a sleeping silent strip; components.hv2 quick-sheet hint text.
- settings: 1 new (`critics-fix O5/O9`: MIDI line, full key map, path in the disclosure, resource line in
  Diagnostics, "modes" defined, pedal tip).
- edit-v2: shell `critics-fix (#5b)` (hidden → 0 fan-outs, show → 1 catch-up with the held notes, LED follows);
  song-header `critics-fix (O12)` pencil; setlist `+ New song` / `+ Setlist` labels.
- **Runs** (2-CPU box at load 20–100 from the theme agents; details in STATUS.md): ui-core full run 57/61 (next/prev,
  Quick TAP = load flakes; polish-1 meter and no-autoplay checks fixed afterwards, verified by direct scripts);
  settings 25/33 and 27/33 (new test ✓ in both modes both times; boot / latency-restart / MIDI Learn app died on load
  bounds both times); edit-v2 blocked by the 30 s mount bound (changed behaviours verified in the real app by script);
  eq not run (untouched).

## mini-theme (Ryan 2026-09-29, tested the tray on his Mac: "the menu-bar popover must inherit the theme chosen in Settings")
- **`app/mini.css` is tokens only.** Every colour reads an app token (`--bg --panel --panel-2 --panel-3 --line-2 --text
  --muted --faint --accent --accent-ink --ok --warn --danger --danger-ink --panic --rec-idle --thumb --focus`, plus
  `--font`) through mini-private `--m-*` tokens declared on `.mini-frame`, not `:root`: Ember declares its tokens on
  `body`, and a custom property resolves where it is declared. The fallbacks are the popover's old Classic values
  (mini.html loads no styles.css, so under Classic every fallback applies). Derived colours use `color-mix()`
  (accent tint 16 %, Rec tint 16 %, Eco tint 30 %: equal to the old rgba literals; Panic hover/fired: mixes toward
  black, within ~2/255 of the old literals). Theme hooks: `--accent-text` (interim fallback: Daylight's
  `--dl-accent-text`), `--mini-shadow`. On the accent tint, light themes pull accent text 30 % toward `--text`
  (`light-dark()`; Classic and dark themes unchanged).
- **The card paints itself** (the Electron window is transparent): `<main id="mini" class="mini mini-frame">` →
  background `--bg`, `border-radius: 12px`, `overflow: hidden`, a 1 px `--line-2` hairline as an inset shadow (no layout
  shift) plus an outer soft shadow. html/body are transparent; `body.mini-body` (0,1,1) beats a theme's `body` desk
  background (0,0,1) and turns off `body::before/::after` (Sanctuary's full-screen vault layer would square the
  corners). Caveat: the window is exactly 320×440 and the card fills it, so the outer shadow only shows in the
  corner cut-outs (alpha ≈ 2). The visible edge is the hairline, and macOS draws the window's own shadow if
  `hasShadow` is on (LOCAL). Not verified on a Mac: that `color-scheme: dark` leaves the transparent window see-through
  at the corners (Chromium keeps a transparent base background as far as I know).
- `.panic-sub` loses its `.9` opacity. Themes pick `--panic` for white at ≥ 4.5:1, and the opacity took Daylight
  Day to 4.08:1. This is the only Classic change inside the card: 98 px (0.07 %).
- **Live re-theme** (`app/js/views/mini.js` `createThemeFollower`, exported). It follows `window 'storage'` on
  `worship-rig.theme`. The main window's `applyTheme` writes the mirror first, so the popover starts its switch at
  once. It also re-reads the mirror on `visibilitychange`/`focus` (a hidden popover that missed the event), and
  follows an optional `state.theme` on the bus.
  - The switch mirrors main.js `applyTheme`: preload the sheet with `media="not all"`, warm its `@font-face` files
    (≤ 1.5 s), then in one task enable it, drop the old one and flip html/body attributes and `color-scheme`. Classic
    and same-file siblings only flip attributes, and a newer switch cancels an older one.
  - It never writes the mirror: the popover is a follower. `__mini.theme = {follow, apply, current, wanted, pending}`
    is exposed for tests. It uses `shared/themes.js` (`resolveThemeId`, `themeAttrs`, `THEME_MIRROR_KEY`), as main.js
    does.
- **Bus (`shared/bus.js`, additive; `v` stays 1)**: `state.theme` is optional. When present it must be a non-empty
  string, else the state is dropped (`stateError` → `'theme'`). An unknown id is valid on the wire; the popover
  resolves it to `DEFAULT_THEME_ID`. Nothing publishes it yet. controller.js is untouched (the publisher may add it
  later). Documented in `docs/menubar-mode.md`.
- **Theme coverage** (`test/phase2/themes/run.mjs`, small additive edit): `collect(label, on = page)`, and
  `walkStates` ends with `walkMini(...)` from `test/phase2/mini/theme-lib.mjs`. The popover gets its own context with
  the mirror set to the theme and a fake bus state, and is walked in 4 states: `mini-waiting`, `mini`, `mini-6-flags`
  (6 modes, Rec/Eco/low-resource on, stalled) and `mini-drone-keys`. Checked on studio: the 4 states were walked with
  0 errors. That run's edit tabs timed out at load ~55, so I restored the agent's own `coverage-studio.json` (0.4 %).
- **Shoot**: `tools/themes/shoot.mjs --only mini` (also in the default set) opens mini.html at 320×440 in the app's
  context, live on the real bus state, and writes `mini.png`, `mini-drone-keys.png` and `audit-mini*-320.json`.
  Audits after the fixes: daylight-day 0 fails (it was 4: accent text 1.44–1.57:1, "hold" 4.08:1), sanctuary-day 0
  (it was 2: key on the accent tint 4.07:1), studio 0 (it was 1: "hold" 4.48:1), sanctuary 0. classic has 2
  pre-existing fails (the `.m-num` badges "2"/"3", `--faint` on `--panel`, 3.49:1, 11 px). I kept them for pixel
  equality; that's Ryan's/Classic's call. Not shot (the box was at load 55–70 and each shoot boots the whole app):
  daylight-stage, ember, nave.
- **README** `app/themes/README.md` has a new "Popover" section: tokens only; don't target `.mini-*` except for
  contrast; the critic shoots `--only mini`.
- **Tests** `test/phase2/mini/theme.mjs` (14; `run.mjs` spawns it after its own 14, `--only base` skips it):
  - bus optional field.
  - Classic pixel-equal against `fixtures/mini-before.css`, the old mini.css served in place of the new one on the
    same DOM, in 3 states: waiting, live, and 6 modes + flags + key sheet. Inside the card: 0 px in waiting, 98 px
    (0.07 %) in live/flags (the "hold" opacity). The whole popover differs by 1.145–1.21 %, all within the new frame
    ring and corners (1,668 px).
  - Mirror `daylight-day` → light card `rgb(243, 239, 231)` (L 0.86), the card equals the theme's `--bg`, and an
    `omitBackground` screenshot has 0 see-through interior pixels.
  - A bus `theme:'studio'` → `'daylight-day'`, with no bad frames; a state without theme leaves it alone; an unknown
    id falls back to the default.
  - All 8 registered themes: opaque card, the right sheet, light/dark luminance, 4 and 6 modes with no overflow,
    screenshots `test/phase2/mini/screenshots/mini-theme-<id>.png`.
  - 0 console errors.
  - live: page B = popover (pinned Classic), page A = the real app. It waits for `__rig.store`/`__rig.theme` only,
    not `__rig.ready`, because at load ~50 the song load alone passed 120 s. `store.set('settings.theme', …)` in A →
    B re-themes with no reload, and every rAF frame has an opaque card and exactly the sheet of `html[data-theme]`.
    - daylight-day took 586 / 800 ms; daylight-stage 1–2 ms (attributes only); studio 540 / 668 ms; back to
      classic 19–58 ms. Load was 37–50.
    - An earlier version of this test ran inside run.mjs, on its booted app, and measured 670 ms. A run at load ~58
      took 2,112 ms and failed the 1 s bound.
- **Runs (load 37–70 from the parallel agents):**
  - `theme.mjs` passed 14/14.
  - The base `run.mjs` was run 4 times, with 10/15, 11/15, 9/15 and 12/14 after the change (the first three include
    the since-removed inline theme test).
    - Every original test passed in at least one run except "app boots": `waitRigReady` hit its 90 s bound in
      every run whose head I logged (starved renderer: 0–5 frames/s; `ready=false`, audio running).
    - Other failures were timing, in different tests each run: panic hold, 6-modes song-load 30 s, low-resource
      frame counts, master.
    - None of these touch mini.css or the theme path (the layout, status, drone and 6-mode layout checks pass on the
      new CSS). **Needs a quiet-box re-run for 14/14.**
  - `run-all`'s `mini` entry has a 6-minute timeout; it now also covers `theme.mjs` (~1–3 min including one app
    boot). Request for the run-all owner: raise it to 10 min.

## hardware-fixes (C9: reviews/hardware-checklist.md results log, BACKLOG B first bullet; views/components/{holdButton,quickSheet,latencyHint}.js, views/settings.js, views/perform.js (3 lines), styles.css, settings + ui-core tests)
- **L-23 (lock hint clipped at the window bottom).** round4-perform P1 already moved the bottom row's captions above the
  button (`top: -30px`), which covers the vertical clip Ryan saw in the older built app. Measuring the tree found the
  other half: the caption is centred on the button, and Lock is the rightmost one, so "press and hold (0.6 s)" (140 px)
  ran 8 px past the right edge at 1024×700 (1020–1032 vs 1024). SF Pro is wider than the Linux faces, so 1280 was
  1 px from clipping on the Mac.
  - `holdButton` now measures the caption once each time it is shown (the hint after a short press, and "keep
    holding…"). This is one forced layout per press, never per frame. The caption:
    - flips `data-place="above"` when the space below runs out, and `"below"` when above runs out;
    - slides sideways (`--cap-dx`) to stay 4 px inside the window;
    - gets `max-width` = the room it has, and wraps instead of clipping.
  - New option `capBounds` (selector) keeps a caption inside an ancestor too. Transpose −/+ pass `'.transpose'`.
  - CSS: `.hb-cap` now uses `top: calc(100% + 8px)`, and "above" uses `bottom: calc(100% + 8px)`. This matches the
    old ±30 px for one line and grows the right way for two. The cap also has `width: max-content;
    white-space: normal` and `transform: translateX(calc(-50% + var(--cap-dx, 0px)))`.
  - Measured (Linux, lock hint at the right edge): 1280×720 1134–1274 / 612–634; 1440×900 1294–1434; 1024×700
    880–1020 (was 892–1032); 1366×768 1220–1360. All are above the button. Transpose hints sit inside their panel,
    for example 485–625 inside 471–627.
  - The task text said "lockLine". `lockLine` in perform.js is the drone column's in-flow "HOLD a key or Major/Minor"
    line, which can't leave the window. The hint Ryan saw is Lock's `.hb-cap`.
- **2b transpose row (Mac ui-core at 1366×768: `div.transpose-row` 140 > 137).** The cause is not the hold caption.
  The probe's label is `textContent`, which includes the hidden captions' text left over from an earlier hold.
  `.transpose-val { min-width: 2.2ch }` is 44 px in SF Pro Display Heavy (digits ≈ 0.67 em), and
  44 + 4 + 44 + 4 + 44 = 140, which is exactly the reported width.
  - The value now takes whatever the buttons leave (`flex: 1 1 0; min-width: 0`). `data-len` (set in perform.js
    renderSong) steps the size down: 2 glyphs are 27 px (24 at ≤ 1250), and 3 glyphs ("−18"; the range is −18…+17)
    are 20 px (17). "−18" at 30 px never fit, even on Linux.
  - The captions have their own overflow rule (panel-bounded `max-width`, wrapping) through `capBounds` above.
  - Test: DejaVu Sans Bold (digits 0.70 em, wider than SF) as `--font-display` reproduces the Mac overflow with the
    old CSS. The row and the ± buttons are held to +1 px. Only the value (overflow visible, 4 px gaps each side) may
    spill ≤ 3 px. Linux, 1366×768: row 137/137 for 0 / +5 / −18.
  - Themes that set their own `.transpose-val` font-size (sanctuary 32 px, sanctuary-v2) outrank the `data-len`
    rules. Their "−18" can still overflow; the theme owner should add a `[data-len="3"]` size.
- **Pedal test (two states).** The critics-fix copy is kept word for word, with "(pedal UP)" added: "Plug in the pedal
  and the keyboard with your foot off the pedal (pedal UP): many keyboards read its direction then." The reversed
  result still gives the unplug/replug advice.
  - Flow: "Press your sustain pedal now and keep it down…" (`.st-pedal-prompt[data-step=press]`). The step settles
    300 ms after the last CC64, so a continuous pedal's ramp counts at its resting value. Then "Now let go of the
    pedal…" (`data-step=release`), which ignores values on the pressed side of 64. Then the verdict.
  - A quick tap inside the press step asks again ("…keep it down until “Now let go” appears"). A tap is a switch
    pedal's 0/127 flipping once, or any pedal crossing 64 twice.
  - New export `inferPedalPolarity(down, up)` → `true` (reversed) / `false` / `null` (both on one side: no verdict,
    no Invert button). `inferPedalInvert` stays exported.
  - Invert / Turn invert off is offered only after both states, and only when it differs from the setting. The
    Reversed setting is unchanged. "Test again" has the class `.st-pedal-again`. 15 s per step, then the "No pedal
    message received…" line.
- **Bluetooth latency hint.** New `components/latencyHint.js`, which never calls the engine:
  - `LATENCY_WARN_MS = 60`, `latencyWarnText(ms)` = "Bluetooth output adds ~N ms — use the headphone jack or a dock
    for live playing", `outputDeviceName(id)`, and `latencyHint({className, testid, onChange})` →
    `{el, set({latencyMs, deviceId}), shown, device, dismiss(), destroy()}`.
  - It shows while `status.latencyMs > 60`. It is dismissed per output device NAME: the `enumerateDevices` label with
    "Default - " stripped, or `device:<id>` while labels are hidden. Names are kept in
    `localStorage['worship-rig.latency-hint.dismissed']` (last 20; memory-only if storage is blocked), and every
    instance on the page follows a dismissal. The name is looked up only when over the threshold and on `devicechange`.
  - Settings › Audio: under the Latency row (`[data-testid=settings-latency-hint]`). The column is narrower than the
    sentence, so it wraps to 2 lines. It also follows `settings.outputDeviceId`.
  - Quick: in the header, in the subtitle's place (`[data-testid=quick-latency-hint]`). Every section is full at the
    sheet's fixed height (This Mac 145/145 px at 1440×900, 121/121 at 1024×700), so a row in This Mac would push the
    sheet onto the strips. The header shows the whole line (498 px) from 1280 up. At ≤ 1250, unlocked, the "Under
    Lock: …" note gives it room; locked, it ellipsizes with the full text in the tooltip.
  - `quickSheet.set()` takes `outputDeviceId`, and perform.js renderQuick passes it.

## theme-ember (app/themes/ember/theme.css; registry `ember` body shim dropped; design/warmth/ship/ember/)
Ember is the lowest scorer (6.17), but Ryan wants it shipped as an option. This entry brings it to the theme contract
(app/themes/README.md) and applies the CSS-only fixes from its warmth, stage and build critics (warmth journal). It is
dark only, with no light sibling.
- **Contract**
  - Every rule sits in one `:where(html[data-theme="ember"])` block. The `body:not([data-theme])` branch is deleted.
  - Tokens are declared on `& body` (0,0,1), not on the guard itself. styles.css declares them on `:root` (0,1,0),
    which would beat a zero-specificity html rule. **Other theme agents moving to the html guard will hit the same
    thing.**
  - The room background sits on `& body` too. That fixes the v1 bug where the hearth glow, vignette and grain never
    rendered, because the theme's (0,0,0) background lost to styles.css `body { background }`.
  - Low-resource is `&[data-low-resource] body`.
  - No `@keyframes`, no `@media`, no `backdrop-filter`, no `content: url()`.
  - Fonts load from `/fonts/NunitoSans-var.woff2` and `/fonts/YoungSerif-Regular.woff2`, with 0 HTTP ≥ 400 in every
    run.
  - Registry: `body: {theme:'ember', mode:'dark'}` is removed from `themes.js` and from the boot.js map. The
    themes.test sync check passes 9/9.
- **One mark.** The `.tb-logo` and `.overlay-card img` `content: url(/themes/ember/mark.svg)` overrides are deleted,
  and so is `app/themes/ember/mark.svg`.
  - The wordmark keeps its text. Only its font changes, to Young Serif, as README rule 8 allows.
  - `design/warmth/ember/shoot.mjs`, the old design mock, still names that svg and `.ember-welcome`. No suite runs it.
- **Deleted**
  - The "Light the room" start screen hooks (`.ember-welcome`, `.ew-*`: 24 dead selectors).
  - The infinite drone "breathing" animation (`ember-breathe`, plus its reduced-motion and low-resource branches). The
    drone is now a static lamp with the same tight halo as the others.
  - The level-glow column (`.lvl-cover::after { height: 5000% }` and 2 mask layers). It cost one 209 × 11460 px
    compositor layer per sounding strip (+75 % layer area, build critic), and it was invisible at 1.5 m (stage
    critic).
  - The CSS case-flip on `.fx-lab span` / `.fxpill-l` (lowercase + `::first-letter`). It turned acronyms into "Eq".
    The strings now show as the JS writes them.
  - There was no `font-size:0` + `::after` copy bridge in Ember. The base `.drone-swell-text::after` ("Bend") is
    styles.css's own and is untouched.
- **Critics' CSS fixes applied**
  - *Numbers (stage BLOCKER, warmth).* `--font-display` is now Nunito Sans, so chord, transpose, wheel % and dB use
    lining sans digits. `font-variant-numeric: lining-nums tabular-nums` is set on `.chord-name`, `.transpose-val`,
    `.wheel-value`, `.tb-val` and `.rec-time`. Young Serif (old-style figures) is opted in only for `.song-name`,
    `.ev2-song-name`, `.overlay-title`, the `.song-key` letter and the `.tb-name` wordmark. The chord is back at
    Classic's family weight (800) and size.
  - *Amber has one meaning.*
    - `.segmented .seg.on` is lit ivory (`#ece2d4` with ink). Only the Perform/Edit switch (`.tb-views .seg.on`)
      stays amber.
    - `.midi-name.off` ("Blocked") is in text colour; its lamp carries the warning.
    - `--warn` moves from `#f5a33a` to `#ff8830`: accent vs warn ΔE×100 goes from 4.7 to 10.4.
  - *Held keys.* The bone key goes to `--key-white #b3a796`, and a held key is `--key-held #ffc43a` with a 3 px ink top
    bar. Held vs unheld is ΔE 17.6 (Classic 17.4; v1 Ember 10.7). The key label becomes `#463830` (4.75:1 on the
    key).
  - *Level meter.* The per-strip bar keeps one level ramp that is never a slot colour (`#7cc98a → #f2b24a → #e95145`,
    the master meter's), at Classic's geometry.
  - *Lamp halos.* Cut from 22 px at 34 % to 10 px at 20 %, so ON tiles keep crisp edges. OFF tiles have no halo
    (`box-shadow: inset` only, `background-image: none`).
  - *Wheel.* A brass sheen gradient under a track cover, instead of a flat tan slab.
  - *Empty slot.* A solid, recessed socket (same 1.5 px border) instead of a dashed placeholder.
  - *Coverage gaps.*
    - Settings `.st-h2` / `.st-h3` are sentence case, and `.st-theme.on` uses the accent.
    - In Edit › Tone, `.eqk` gets `--eqk-bg` / `--eqk-ink` warm, plus `.eqk-onoff` and its knob and the legend
      swatches.
    - `.banner.info` becomes a warm neutral.
  - *Lock.* Under Lock, the drone character faders were dimmed twice (`.drone-char` .45 × `.fader.disabled` .45 = .20,
    1.5–1.8:1 in Classic too). Ember uses .8 × .8 with `--text` labels: frozen still reads as frozen, and the values
    are 7.6:1.
- **Deferred (JS or copy; not done here)**
  1. The welcome / "Light the room" / Today / "last time" session log and the lamps-warming dots. They need their own
     first-launch-of-the-day trigger: Electron autoplays, so `#overlay-start` never shows (OPTIONS §3 point 3).
  2. The 10 voice strings in concept §5.
  3. Dropping `headerChipRow.js` `.toUpperCase()` if Space/Echo should be sentence case.
  4. The EQ plot canvas: `eq-keyboard.js` paints fixed slate (`#0f1216`, `#1f242b`…) and should read tokens.
  5. Nothing for mini: since `## mini-theme`, mini.css reads the app tokens that Ember declares on `body`.
  6. The empty-slot "+ add a sound" label.
  7. Pressed keys in the colour of the part that sounded, which needs per-key slot data.
  8. Chord auto-fit to the card width.
  9. The Edit sentence in the display face at a larger size. That is a layout change, so it was not done.
  10. "Banked embers" is **cut**, not deferred: stage hazard (stage and build critics).
- **Coverage** (`test/phase2/themes/run.mjs --only coverage --theme ember`): 219 selectors → **180**, 41 unmatched
  (18.7 %) → **3 (1.7 %)**, 24 dead-class selectors → **0**, 0 invalid.
  - The 3 left are live classes in states the walk doesn't reach: `.fx-more` (the More FX popover), `.swell-btn.on`
    and `.bstrip.open .bstrip-list`.
  - Rules for other unreached states whose Classic look is acceptable were dropped, to stay ≤ 2 %: `.led.flash`,
    `.rec-btn.recording`, `.drone-swell.up` LED, `.meter.vertical` (unused), `.fx-chiprow.fx-open > .fxrow` (<1250 px),
    `.bstrip.open .banner.info`, `.settings-placeholder`, the Edit wheel lanes (`.ev2-wlane`, `.ev2-wout-br`,
    `.ev2-wn`) and `.ev2-slot-mi` hover.
- **Contrast** (`tools/themes/shoot.mjs --theme ember --out design/warmth/ship/ember/`, 1440×900): perform 185 runs,
  quick 167, edit 166, edit-tone-eq 158, mini 23, mini-drone-keys 28 (320×440). **0 fails**. The lowest is 4.69 (PANIC "Esc"/label on
  `--panic`); next come the key labels at 4.75.
  - Glare on perform: mean luminance .070, bright share .062.
  - The first full run's eq shot timed out (screenshot 120 s at load ~50), so eq was re-shot with `--only eq`.
    Mini was shot separately (`--only mini`), so `summary.json` holds only eq. The per-shot `audit-*.json` files
    are all current.
- **Stage states** (scratch probe, copied to `design/warmth/ship/ember/states/`: `probe.mjs`, `boxdiff.py`, `st-*.png`,
  `audit-st-*.json`, `probe-{1440,1280}.json`, `classic-probe-*.json`):

  | state | 1440×900 runs / fails | 1280×720 runs / fails | Classic fails (1440) |
  |---|---|---|---|
  | held chord | 185 / 0 | 159 / 0 | 0 |
  | Pad OFF | 185 / 0 | 159 / 0 | 3 (wheel badge 4.44) |
  | Faded | 184 / 0 | 158 / 0 | 0 |
  | Locked + held | 191 / 0 | 165 / 0 | 4 (drone-char 1.46–1.84) |

  - Lamps, as the rendered median luminance with text hidden: Keys ON .378, Pad ON .630, Drone ON .714, Pad OFF .019.
    - Pad ON/OFF is **9.8:1**, and Keys ON vs an OFF tile is 6.2:1. The darkest lamp, plum (flat colours), vs the OFF
      tile is 4.70:1.
    - The OFF ring (5 px outside the tile) is .0084, against .0094 around ON tiles, so an OFF lamp does not glow.
    - Lamps are the same under Lock.
- **Layout vs Classic** (getBoundingClientRect, idle and held, at 1440×900 and 1280×720): `.song-name`,
  `.chord-readout`, `.chord-name`, every `.perform .slot`, `.ontile`, `.fader-track`, `.drone-readout`, `.p-drone`,
  `.setlist-strip`, `.topbar`, `.btn-fade` and `.btn-panic` are all **0.0 px** apart.
  - Only text-intrinsic widths differ: `.song-key` x −7.3 / −7.6 px (the "Key" caption is sentence case, so
    narrower), `.transpose-val` w +2.9, `.wheel-value` w +3.7 to +8.6 (Nunito digits).
  - Font sizes equal Classic's: title 40 / 38 px, chord 22 px (xl bucket, "Cmaj7" held), transpose 30, drone readout
    15, lamp names 15.
- **Size**: folder 38 KB (theme.css 20.9 KB + grain.png 17.9 KB), plus 57 KB of /fonts = 95 KB (limit 250).
- **Suites**: see the numbers under "Runs" below.
- **Runs** (2 CPUs shared with the other theme agents; load average 25–100 throughout, so every boot-timing number here
  is noisy):
  - `node --test test/unit/shared/themes.test.mjs`: 9/9 (registry ↔ boot.js sync without the ember body shim, size
    budget, /fonts).
  - `test/phase2/themes/run.mjs --theme ember`, best run 8/11.
    - Passed: boot ember (link before DCL, render-blocking, attrs, 0 errors / 404s), the unknown-id fallback,
      switch → ember and → classic (one consistent sheet every frame), the picker, Quick › Theme, mini, and coverage.
    - Not ember defects:
      - "first boot … default" timed out on `__rig.ready` at 120 s under load. It is the default theme, not Ember.
      - "store wins over a stale mirror" needs two css themes. With `--theme ember` alone its `b` is undefined, and the
        paired run (`--theme ember,nave --only boot`) timed out at load 50.
      - "Classic card after another theme" drives Sanctuary ("sanctuary changes the look (0 diffs)"): that is
        Sanctuary's file mid-migration.
    - The coverage walk also skips states under load. Of 5 coverage runs, 2 walked every state (3 unmatched), 2
      skipped 2–3 states (3 and 6 unmatched) and 1 skipped 12 (26). The committed `coverage-ember.json` is from a run
      at 3 unmatched (1.7 %).
  - `test/phase2/ui-core/run.mjs`, one full run each at comparable load, back to back: **Classic 50/61, Ember 46/61.**
    - Ember with the unchanged suite: RIG_THEME is not a suite switch. The run uses a preload,
      `node --import <scratch>/pin-theme.mjs`, which re-applies `pinTheme(context, 'ember')` after the suite's own
      `pinTheme(context, 'classic')`.
    - Both fail #1, #2, #17, #30, #36 and #40 (boot, tap and meter timing under load). Classic alone fails #31.
    - Ember alone fails:
      - **#4 and #33: Classic-token assertions**, as themes-setup predicted for any theme. #4 expects
        `--muted-fader #707a88` and gets Ember's `#82746d`. #33 expects the OFF tile at `rgb(39,43,50)` and gets
        `rgb(45,36,32)`.
      - #3, #16, #19, #24, #34, #58 and #59: page.click / waitForFunction timeouts. Re-run in isolation
        (`--test-name-pattern`), #3, #16, #19, #24 and #59 pass. #34 (Revert is a 780 ms hold), #36 (TAP BPM) and #58
        (meter loop at 0 frames/s) stay flaky under load.
    - Nothing asserts on layout or behaviour that Ember changes: element boxes are equal to Classic's (above).
    - A second full Ember run at load ~50 was stopped after its first 5 tests timed out.
- **Second pass (2026-09-29 evening, load 4–13; everything above re-run against the current tree)**
  - *Hearth.* The body wash does render now (gutters: R 42–54 beside the keyboard row vs R 20 under the top bar), but
    it barely shows through the 93 % panels. `.panel.p-keys` now carries its own static radial glow from the bottom
    edge (the warmth critic's fallback). Contrast unchanged. 181 selectors.
  - *Coverage* (`--only coverage --theme ember`): 181 selectors, **3 unmatched (1.7 %)**, **0 dead classes**, 0
    invalid. The 3 are the same live-but-unreached states (`.fx-more`, `.swell-btn.on`, `.bstrip.open .bstrip-list`).
  - *Contrast* (`tools/themes/shoot.mjs --theme ember --out design/warmth/ship/ember/`, one full run, 0 errors / 404s):
    perform 185, quick 167, edit 166, edit-tone-eq 158, mini 23, mini-drone-keys 28 runs, **0 fails**, lowest 4.69
    (PANIC). States probe (`states/probe.mjs`): held / Pad OFF / Faded / Locked+held at 1440×900 = 185 / 185 / 184 /
    191 runs and at 1280×720 = 159 / 159 / 158 / 165 runs, **0 fails**. Classic at 1440 still has 3 (Pad OFF) and 4
    (Locked). Lamps: Pad ON L .630 vs OFF .019 (**9.8:1**), and the OFF ring is .0084 vs .0091–.0095 around ON tiles.
  - *Boxes vs Classic* (`states/boxdiff.py`, Classic re-probed now): `.song-name`, `.chord-name`, every
    `.perform .slot`, `.ontile`, `.fader-track`, `.drone-readout`, `.topbar`, `.btn-fade`, `.btn-panic` are 0.0 px
    apart at both sizes. Text-intrinsic only: `.song-key` x −7.3 / −7.6 px, `.wheel-value` w +3.2 to +3.7. Sizes are
    Classic's: title 40 / 38 px, chord 22, transpose 30, drone readout 15, lamp names 15.
  - *Suites.* `themes.test` 9/9. `themes --theme ember` **10/11**: the one failure is "store wins over a stale
    mirror", which now pairs `sanctuary` with `sanctuary-day` (the first two css themes since `coming` was dropped).
    It fails the same way with `--only boot`, and it does not involve Ember. ui-core, back to back: **Classic 59/67,
    Ember 62/67** (`node --import <scratch>/pin-theme.mjs`, RIG_THEME=ember). Ember-only: #4 (`--muted-fader`
    `#707a88` expected) and #33 (OFF tile `rgb(39,43,50)` expected) assert Classic tokens. #34 timed out, then passed
    alone. #40 and #47 fail on both. Classic-only: #27, #30, #31, #35, #36, #37 (timing under load).
  - Screenshots: `design/warmth/ship/ember/{perform,quick,edit,edit-tone-eq,mini,mini-drone-keys}.png` + `audit-*.json`
    + `summary.json`; `states/st-{held,pad-off,faded,locked-held}.png` + `audit-st-*-{1440,1280}.json`,
    `probe-{1440,1280}.json`, `classic-probe-{1440,1280}.json`.

## lowres2 (low-resource part 2: frozen drone + audio sleep; engine/drone-freeze.js (new), audio.js, drone.js, controller.js, midi.js, store.js, shared/bus.js, Settings › Audio + Quick one-liners, docs/menubar-mode.md)
Ryan's two decisions after reviews/idle-cpu-mac.md (hidden drone-on ≈ 30 Energy Impact: live drone synth ≈ 21, convolvers
≈ 9.5; drone-off idle 7.6 %).
- **(1) Frozen drone** (`engine.setLowResource(true)` → `drone.setFrozen(true)`; realtime only, offline renders keep
  the live drone).
  - A sounding static **synth** drone is rendered OFFLINE once (`drone-freeze.js renderDroneLoop`: a Drone of the same
    class at unit level + the live reverb's chain HPF 180 → LPF 9 k → predelay → the live IR → return × wheel;
    seeded `rngFor(seed, 'drone-freeze|pc|minor')`, everything at `{when: 0}`) into a loop of `FREEZE_LOOP_SEC` = 20 s
    (preroll 4 s dropped, then loopLen + 1.5 s; the 1.5 s after the loop end is equal-power crossfaded into its head,
    so the wrap plays the rendered continuation). Seam check (`seamCheck`): max |Δ| across the wrap ≤ max |Δ| in the
    body, warned if not.
  - Played from one looping `AudioBufferSourceNode` → its gain → `drone.level` (so drone.gain, wheel and swell stay
    live and exact: the chain is linear, hence **a level change never re-renders** — stricter than the brief's ±1 dB
    rule; only the reverb return level is baked, and it re-renders beyond ±1 dB, `FREEZE_WET_TOL_DB`). Equal-power
    1.5 s crossfade from the live layers, which then end (voices stopped, drone-osc back in the idle pool,
    disconnected); `sendGate` fades to 0, so the reverb is unfed and the existing FX idle sleep puts it to sleep
    (verified: `fxAsleep` includes 'reverb' as soon as the freeze completes).
  - Re-render (debounced `FREEZE_DEBOUNCE_SEC` = 2 s on the audio clock via AudioTimer, no setTimeout) on
    brightness / movement / width / trim / IR / predelay / wet > 1 dB; crossfade loop → loop. **A key or mode change
    goes through the live synth at once** (the key change must sound now, with the song's fade) and re-freezes after
    the debounce. Chord-follow, files mode and a parked drone are never frozen.
  - Low-resource off: the live synth starts, the loop fades `FREEZE_THAW_LEAD_SEC` = 1.5 s later (1.5 s equal-power),
    the send reopens.
  - Memory: ≤ one loop + one during a crossfade; `buffer = null` on dispose. 20 s = 6.7 MB @44.1 k / 7.3 MB @48 k;
    hard cap `FREEZE_MAX_BYTES` 12 MB (30 s @96 k clamps to 12.0 MB).
  - `_debugStats()`: `droneFrozen`, `droneLoopSec`, `droneRenderMs`, plus `droneRenders`, `droneFreezeMB`,
    `droneSeam`, `droneFreezePending`. Test hook `engine._setDroneFreezeOptions({loopSec, prerollSec, debounceSec})`.
- **(2) Audio sleep** (`settings.audioSleepSec`, optional, absent = 30; number rounded, clamped 0 … `AUDIO_SLEEP_MAX_SEC`;
  0 = never; anything else refused; invalid stored value dropped on load; device-local across a replace-import).
  - Engine: `sleep({ramp})` (fx.out linear ramp to 0 over `SLEEP_RAMP_SEC` 150 ms via `linFrom`, then
    `ctx.suspend()`), `wake({ramp})` (`ctx.resume()`, then ramp back over `WAKE_RAMP_SEC` 60 ms; 5 ms
    `WAKE_NOTE_RAMP_SEC` when notes are queued — the output is silent at sleep by construction, so a 60 ms fade would
    only blunt the note's attack), `sleepState` ('awake' | 'sleeping' | 'asleep' | 'waking'), `sleepBlockers()`
    (['voices'] / ['drone'] / ['no-audio']; a frozen drone at drone.gain 0 does not block), event `'sleep'`
    {state, wakeMs?, queued?}. noteOn / noteOff / sustain arriving while not awake are queued and played at the wake
    ramp's start (never lost); a drone that starts wakes it; an external resume finishes the wake.
  - Controller: input-activity clock `controller.noteActivity(kind)` — MIDI 'input' (every message except realtime
    clock / active sensing, and hot-plug 'connected'), 'midi-switched', document-level CAPTURE listeners for keydown /
    pointerdown / wheel (installed by the controller; main.js needed no change), every bus command (popover `hello`
    included), every note from any source, `resumeAudio()`. The watchdog tick sleeps when no blockers, not recording,
    ctx running and idle ≥ audioSleepSec; any wake keeps it up ≥ audioSleepSec. `status.audio = 'asleep'` (not a
    stall: the tick never resumes or restarts it). `_sleepDebug()` for tests.
  - `midi.js`: event `'input'` {inputId, kind: 'message'|'hotplug'} emitted BEFORE the message's own event.
  - Bus: `AUDIO_STATES` gains `'asleep'`; contract stays v 1 (docs/menubar-mode.md updated).
  - UI: Settings › Audio "Sleep audio after: 30 s / 2 min / Never" + "Audio asleep — play a note or press a key to
    wake" line; quickSheet This Mac caption shows the same line when given `audio: 'asleep'`.
- **Numbers (this 2-CPU Linux box, headless Chromium, 44.1 kHz).**
  - 30 s loop render (35.5 s of audio incl. preroll + seam, real drone-osc + 1.5 s IR): **3.1–4.5 s idle**
    (graph build on the main thread 48–81 ms, the rest on the offline render thread); **59 s at load 20+** (build
    3.3 s). Loop 10.09 MB. Seam 0.0013 vs body 0.024. Determinism: same inputs → max diff 2.7e-6. The default 20 s
    loop renders in ≈ 2.7 s idle.
  - Freeze (4 s test loop): live −19.54 dB vs frozen −20.0 … −20.1 dB power → **RMS match −0.46 … −0.59 dB**; frozen
    ≈ 2.2–3.5 s after setLowResource(true) (render 0.4–1.6 s + 1.5 s fade); seam 0.0079 vs body 0.050; no click at
    the realtime wrap; live drone voices 0, reverb asleep; key change re-freezes 2.5–3.9 s later; thaw 3.07 s.
  - Wake: MIDI noteOn while asleep → resume 5–9 ms → note scheduled at +20 ms lead: **27–30 ms added**, message →
    sound 34–37 ms vs 7 ms awake (≤ 80 ms target). keydown wake 20–58 ms (poll granularity), no note queued; popover hello wakes (20 ms).
  - Sleep/wake ramps on a drone peaking at −6.9 dBFS (master scaled up): **max |Δsample| 0.0121 across sleep →
    suspend → resume → wake** vs 0.0127 in the steady drone (≤ 0.02), 0 clicks, 0 capture gaps.
- **Tests.** Engine `realtime.droneFreeze` (above; click checks on a gap-free AudioWorklet capture at the loop wraps
  plus the loop buffer tiled twice), `realtime.droneFreezeRender` (30 s render, 12 MB cap, determinism),
  `realtime.audioSleep` (real controller + MidiInput + document + mini bus: sleep after 2 s, MIDI wake + onset,
  keydown wake without a note, recording blocks sleep, hello wakes, ramps click-free). Shell `lowres2.test.mjs`
  (store validation, bus 'asleep', controller sleep/wake per input kind, blockers, recording, 0 = never, midi
  'input'). `engine/run.mjs` honours per-suite `timeouts`. Engine suite **78/78**; shell unit + browser green.
- **Requests for other owners.**
  - **C9 (perform.js)**: in `renderQuick()` add `audio: a,` to `quick.set({...})` — Quick › This Mac shows the
    asleep line only once it is passed (quickSheet.js already handles it).
  - **C9 (main.js `renderAudioStatus`)**: map `asleep: 'Asleep'` (LED 'ok', not 'warn'); today 'asleep' falls back
    to "Sound" with a warn LED.
  - **menubar-B (views/mini.js status line)**: add `asleep: 'Audio asleep'` to the audio text map (today "Sound…").
  - LOCAL: re-measure hidden drone-on Energy Impact with low-resource on (expect the ≈ 21 synth + ≈ 9.5 convolver to
    become one buffer source) and idle with audio asleep (AudioContext suspended: the audio thread should drop to ~0).

## theme-daylight (app/themes/daylight-v2/theme.css; registry `daylight-stage` / `daylight-day` body shims dropped; design/warmth/ship/daylight/)
- **One file, two ids, html guard.** Every rule sits in one `:where(html:is([data-theme="daylight-stage"],
  [data-theme="daylight-day"]))` block. The old `body[data-mode="day"|"dusk"]` keys and the unguarded
  `body:not([data-theme])` branch (§3.1 #8) are deleted, and so are the `body` shims for both ids in `themes.js` and
  `boot.js` (unit sync test 9/9).
  - Day and Stage: every colour token is `light-dark(day, stage)` on `&:root`. `color-scheme` is `dark` on the root
    and `light` under `&:root[data-mode="light"]`, driven by boot.js / applyTheme. There is no OS media query.
    Siblings switch by attribute flip only.
  - Swatches in `themes.js` are unchanged: they already equal the two branches (`#1b1611 / #261f19 / #f5ede0 /
    #f6c35a` and `#f3efe7 / #fdfbf7 / #27211b / #f4b73f`).
  - New token `--accent-text: var(--dl-accent-text)` is the README popover hook. mini.css already fell back to
    `--dl-accent-text`, so the value is unchanged.
- **One mark.** `.tb-logo` / `.overlay-card img` `content: url(...)` are removed. `daylight-v2/mark.svg`, `sun.svg`,
  `moon.svg` and `today.svg` are deleted, so the folder is `theme.css` only. The wordmark keeps its Fraunces face.
- **Fonts** come from `/fonts/` (`InstrumentSans-var.woff2` twice: `Instrument Sans` and a chord-only
  `Instrument Sans Chord` face whose ascent and descent overrides fit the 1.1 line box; `Fraunces-soft.woff2`). Boot
  showed 0 × 404 for both ids. The size is 162 KB: 46 KB of CSS + 61 + 55 KB of fonts, against a 250 KB limit.
- **Critics' must-fixes (OPTIONS.md §3.1), CSS part**
  - **#1 Stage slot chroma.** The dusk branch is Keys `#e9833d`, Pad `#66cf7e`, Extra `#139be5` and Bass `#e398fe`,
    at OKLCH C 0.150 / 0.151 / 0.151 / 0.160 with hues 52 / 149 / 241 / 317 (the same four hues).
    - Pairwise OKLab ΔE×100 is Keys–Pad 23.4, Keys–Extra 30.4, Keys–Bass 24.3, Pad–Extra 24.5, Pad–Bass 31.0 and
      Extra–Bass 23.0, so every pair is ≥ 20. Before: 14.0–24.1.
    - Pad vs Extra ΔL is 0.112, against the ≥ 0.08 target. Lamp ink is ≥ 5.8:1.
    - The Day pastels are unchanged.
  - **#2 Chord.** `.chord-name` is Instrument Sans at weight 800 (the vendored axis tops out at 700, which is what
    renders), with `lining-nums tabular-nums`. It keeps the app's own sizes: 46 px idle "Em", and 22 px for "Cmaj7"
    through the app's data-len rule.
    - Idle is `--faint`. The idle → live step is 2.21:1 on Stage and 2.82:1 on Day (before: 1.49:1). Idle on bg
      is 7.0 and 4.9:1.
  - **#6 Copy bridge deleted.** There is no `font-size: 0` and no `::after` string swap, and Sound is no longer hidden
    while healthy. The app's strings show as they are, so screen readers hear each once.
  - **#8** The unguarded branch is gone (above).
    - The leftover dashed drone key is `styles.css:896 .drone-block.off .key-btn.on { border-style: dashed }`, which
      is not my file. The theme overrides it: solid, `--led-off` edge, transparent. The drone-off audit state renders
      `solid`.
    - The Today card and sheet selectors (`.dl-today*`, `.dl-ic`) are deleted.
  - **Stage critic, lamps.** ON is always the more visible state. OFF is a hollow `--led-off` ring. By day, ON is a
    dark fill (the slot colour mixed with ≥ 60 % `--text`, or the drone ink), and on Stage it is the lamp colour with a
    glow.
  - **Lock.** styles.css dims the drone character faders twice (.45 × .45), which put "Soft · 40%" at 1.4–1.6:1
    (Classic too). Under Daylight the words stay at full strength and only the slider track fades to .4.
- **Deferred (JS or layout, not theme work)**
  - #3 Today card (hide under Lock / after song 2, one-line collapse) and #5 the Day · Stage · Auto switch plus the
    Today sheet's own first-launch trigger: `today.js` stays in `design/warmth/daylight-v2/`.
  - #4 Lock forcing Stage for as long as it is locked.
  - The #6 strings in JS: calm top bar (one lamp + one phrase), "Keyboard not allowed yet", "As saved",
    "Start of set", "Using built-in pads", "Just as you saved it", plus the 4 tests that assert the old strings.
  - #7 `fonts.ready → fitName` is done by setup.
  - #8 "collapse the empty Extra/Bass wells into one narrow well": this is a layout change, and themes must keep
    Classic's boxes.
  - The warmth critic's retheming of the EQ canvas from tokens (`eq-keyboard.js`). Today it is framed as a dark
    display with a walnut bezel.
- **Coverage** (`themes/run.mjs`, 50 states: 25 per id incl. mini): **250 selectors, 4 unmatched (1.6 %), 0 dead
  classes, 0 invalid.** Before: 340 / 85 unmatched (25 %) / 43 dead.
  - The 4 unmatched selectors are live classes in states the walk does not reach: `.rec-btn.recording`,
    `.drone-block.off .key-btn.on` (checked in the states audit), `.ev2 .ev2-wv` (Show wiring), and
    `.ev2-song-mi.danger` / `.ev2-slot-mi-remove` (open menus).
- **Contrast** (`tools/themes/shoot.mjs`, 1440×900, 0 console errors):

  | id | perform | quick | edit | eq | mini | mini-drone-keys | lowest |
  |---|---|---|---|---|---|---|---|
  | daylight-stage | 185 / 0 fails | 167 / 0 | 166 / 0 | 159 / 0 | 23 / 0 | 28 / 0 | 4.92 "ON" (Quick), PANIC 5.17 |
  | daylight-day | 185 / 0 | 167 / 0 | 166 / 0 | 159 / 0 | 23 / 0 | 28 / 0 | 4.67 PANIC |

- **States audit** (`design/warmth/ship/daylight/audit-states.mjs` → `states.json`): the checks shoot.mjs does not make.
  - Text in the states idle, held chord (live), Pad OFF, drone OFF, Faded and Lock: 182–189 runs each, **0 fails**
    for both ids. The lowest is 5.13 on Stage and 4.67 by day (PANIC).
  - ON vs OFF of the same lamp, sampled at the centre pixel, must be ≥ 3:1. On Stage: pedal 4.18, slot-tile LED 14.4,
    drone toggles 12.0 / 9.4, the stepChip cycle LED 6.0, the drone tile 14.4. By day: 4.75 / 14.1 / 6.7 / 5.6 / 6.8 /
    14.1. All pass, and ON is always the more visible state.
  - Layout parity against Classic at 1280×720 and 1440×900: `.song-name`, `.chord-name`, the drone readout and all 4
    `.perform .slot` boxes are Δ 0 px on x / y / w / h for both ids.
    - Stage sizes are unchanged: title 38 / 40 px, chord 46 px, slot names 17 px.
    - The only non-zero delta is the text run width of `.slot-inst` (3 px, a different face), not a layout box.
- **Screenshots**
  - `design/warmth/ship/daylight/{stage,day}/`: `perform.png`, `quick.png`, `edit.png`, `edit-tone-eq.png`,
    `mini.png`, `mini-drone-keys.png`, plus `audit-*.json` and `summary.json`.
  - `design/warmth/ship/daylight/state-daylight-{stage,day}-{held,pad-off,drone-off,faded,locked}.png`.
- **Suites**
  - `node --test test/unit/shared/themes.test.mjs`: 9/9.
  - `test/phase2/themes/run.mjs --theme daylight-stage,daylight-day`: 11/13.
    - Passed: first boot, boot of both ids (link before DCL, render-blocking, attributes, 0 errors / 404s), the
      unknown-id fallback, switch → stage / day / classic (one consistent sheet every frame), the picker, Quick ›
      Theme, mini, and coverage.
    - Both failures are Sanctuary's, not Daylight's:
      - "store wins over a stale mirror" always pairs the first two css themes (sanctuary / sanctuary-day) and got
        `'sanctuary'` ≠ `'sanctuary-day'`.
      - "Classic card after another theme" drives Sanctuary ("sanctuary changes the look (1 diffs)").
  - `test/phase2/ui-core/run.mjs` uses a preload (`node --import pin-theme.mjs`, as in theme-ember), because RIG_THEME
    is not a suite switch.
    - Classic (same box, back to back) **65/67**. It fails #40 (1280×800 `div.meter-bar` 80 > 72) and #47 (DejaVu
      −18 transpose value 45 > 41 + 3).
    - Daylight Day **61/67**. It fails #40 and #47 exactly as Classic does, and adds:
      - #4, #18 and #33: Classic-token assertions. #4 is `--muted-fader #707a88`. #18 is `accentPanel`: `--accent`
        as text on `--panel` is 1.74, but Daylight's `--accent` is a highlighter *fill*, and amber text uses
        `--dl-accent-text` (6.1:1; shoot.mjs finds 0 rendered fails). #33 is the OFF tile `rgb(39,43,50)`.
      - #34 is a cascade of #33. #33 fails on its Classic OFF-tile colour *after* muting Keys and never unmutes, so
        #34's "ON tile through an open panel" tap unmutes and its wait for `muted === true` times out. Evidence:
        #34 alone (`--test-name-pattern`) passes, and a scripted run of #33's remaining steps passes on both ids
        (the tap mutes, `.rbar.off`, 0 `--warn` colours in the strips).
    - Daylight Stage **62/67**: #4, #33 (tokens), #34 (the #33 cascade), and #40 / #47 as on Classic. An earlier run
      at load ~12 collapsed to 48/67 on click timeouts after a hidden view. It is not counted.
    - No Daylight failure is a layout or behaviour change. All of them are Classic-token assertions or shared with
      Classic.

## theme-sanctuary (app/themes/sanctuary-v2/theme.css; registry `sanctuary` + `sanctuary-day`; design/warmth/ship/sanctuary/)
Sanctuary is Ryan's final default (the flip of `DEFAULT_THEME_ID` / boot.js `DEF` from the TEMP `'classic'` is left to
themes-final, as both files say). This entry brings the file to the theme contract (app/themes/README.md), lands the
light sibling, and applies the CSS-only items from the v2 warmth / stage / build critics (warmth journal) and OPTIONS
§ Option 2.
- **Contract**
  - One `:where(html:is([data-theme="sanctuary"], [data-theme="sanctuary-day"]))` block holds every rule. The
    `body:not([data-theme])` / `body:is(...)` (0,1,1) branch is gone. That wrapper caused the build critic's three
    bugs: the OFF lamp glowed, the OFF badge lost its ring, and the 1024 `.ot-name` tracking step was lost. The app's
    state and media rules now win on specificity again (1024: `.ot-name` .91 px = Classic).
  - Tokens sit on `&:root` (0,1,0, same as styles.css's `:root`, wins on source order). Day overrides sit on
    `&:root[data-mode="light"]` (0,2,0).
  - No `backdrop-filter`, no infinite animation, and no `will-change` (the full-screen `body::after` layer). The only
    `@keyframes` is `sanct-fade`, a finite opacity fade-in of 140–160 ms, off under reduced motion. No `@media` on the
    OS appearance.
  - Assets are root-absolute (`/themes/sanctuary-v2/triplet.svg`). Fonts load from `/fonts/Alegreya-wght.woff2` and
    `/fonts/Figtree-wght.woff2` with `font-display: swap` (was `block`, build critic). Every run had 200s on both and 0
    HTTP ≥ 400.
  - Registry: `themes.js` and boot.js have no `body` shim for either id. `sanctuary-day` has real swatches
    (`#efe9de / #f9f5ee / #32162b / #875806`) and `coming` removed. The `sanctuary` swatch is the night branch
    (`#160913 / #21111c / #f5ecd8 / #e6ba65`). `themes.test.mjs` is 9/9.
- **One mark.** No `content: url()` on `.tb-logo` / `.overlay-card img` and no wordmark swap. `.tb-name` keeps its
  text, and only its face changes. `mark.svg` and the start screen's `window-{glass,light,lead}.svg` are deleted from
  the folder. Nothing references them.
- **Deleted**
  - The "Before you play" start screen: `.sanct-before*`, `.sanct-breath`, `.sb-*` (31 dead selectors).
  - The breathing drone window (an infinite 8 s animation whenever the drone sounds, build critic). The window is now
    static: lit (opacity 1) while the drone is on, unlit (.3) when it is off, with a .6 s transition.
  - Grain was already gone in v2. There was no `font-size:0` + `::after` copy bridge in this file.
- **Light sibling `sanctuary-day`** ("chapel morning") is the same file.
  - Every colour token is `light-dark(DAY, NIGHT)`. `color-scheme` is `dark` on `&:root` and `light` under
    `&:root[data-mode="light"]`, so html[data-mode] (boot / applyTheme) picks the branch.
  - Day palette: stone paper (bg `#efe9de`, panel `#f9f5ee`), plum-ink text `#32162b`, deep brass `#875806`, and
    deeper lamp glass with cream ink (`#a63d02 / #006e46 / #02648c / #7847a6`). Lamp gradient .02/.05 with an 18 % halo.
  - **Exception: slot and drone colours are plain values per mode**, not `light-dark()`. `edit/panels/slot.js:858`
    reads `--c` back with `getPropertyValue` for the response-curve canvas, and a canvas rejects a `light-dark()`
    string (checked in Chromium 141: `strokeStyle` stays unchanged). Resolved `--c` is now `#f78955` (night) /
    `#a63d02` (day), and `.ev2 --drone` is `#edd9a6` / `#755002`.
- **Critics' CSS fixes**
  - *Warm neutrals (warmth critic, OPTIONS §4).* Night neutrals rotated from hue 297 to 338 at the same OKLCH L, with
    chroma ×0.8 (bg `#160913`, panel `#21111c`, panel-2 `#2a1a25`, panel-3 `#352530`). The plum-and-gold identity
    stays: brass accent, cream text, the book face, lit glass.
  - *OFF lamp (build + stage).* `.ontile.off` is stated in full: an unlit pane with no halo, no lit LED and a ringed
    badge. See Stage states below for the numbers.
  - *Held keys (stage).* Night ivory is dimmed (`#a39a88 → #958c7b`) and held is `#f2c35e`.
  - *Fade out vs Faded (stage).* At rest, Fade out is a neutral lit plane with a `--line-2` rim. Faded is
    `color-mix(--warn 36 %, panel-2)` and keeps the app's 2 px amber border, so it flips both hue and lightness.
  - *`--ok`* is `#9ccf66`, a yellower status green, so READY no longer reads as the Pad lamp (dE 2.4 before).
  - *Glass colours (stage).* `triplet.svg` is recoloured to amber, honey, cream and wine only, with no slot hues.
  - *Other*
    - The empty slot is a solid recessed niche, not dashed (warmth).
    - The drone-character labels set weight only, so the app's 11.5 px step at 1024 applies ("Movement" 59/59 px, not
      "Movem…").
    - Under Lock the drone-character faders are .8 × .8 instead of .45 × .45, with `--text` labels (Classic's Lock
      fails at 1.46).
    - Edit › Tone `.eqk` re-reads the theme's slot colour and well.
    - Rubrics are true small caps with `line-height: 14px`, which keeps Classic's 12 px caps line box.
  - *Chord overflow (found here, ui-core #40 / #47).* Alegreya's content area (1.361 em) overflowed the clipped
    `.chord-name` inside its `46px/1.1` line box: scrollHeight 56 > 51 at 1280×800 and 1366×768, 46 > 42 at 1024.
    - New `@font-face 'Sanctuary Chord'` points at the same URL (no second fetch) with `ascent-override 88.55 %` and
      `descent-override 21.45 %`. That puts the baseline exactly where it sat before, and now 51/51, 33/33, 46/46
      (xl) and 42/42 (1024).
    - It is used by `.chord-name` only. Other book text keeps Alegreya's own metrics, so Notes' line boxes are
      unchanged.
- **Deferred (JS or copy; not done here)**
  1. The daily hook: "Before you play" / "Before the service" and the `worship-rig.lastSession` record ("On Sunday you
     ended on…"). It needs its own first-launch-of-the-day trigger: Electron autoplays, so `#overlay-start` never
     shows (OPTIONS §3 point 3).
  2. The voice strings (concept §6.3: *Preparing n of N*, *All N ready*, *Faded out. Play to bring it back.*,
     *Up next*) and *That's the set. Thank you for serving.*
  3. The EQ plot canvas: `eq-keyboard.js` paints fixed slate in every theme and should read tokens.
  4. `slot.js` response-curve spark: its reference diagonal is a hard-coded `rgba(255,255,255,.18)`, which is invisible
     on Sanctuary Day's paper.
  5. The window lights on `drone.mode !== 'off'`, not on audibility (Faded or −∞ still shows it lit). That needs a class
     from perform.js.
  6. Not done, as design calls: a per-strip warm spill behind the fader, and a 44–48 px window (warmth critic). The
     title row has no room without a layout change.
  7. Test harness items (not mine to edit):
     - `test/phase2/themes/run.mjs` "store wins over a stale mirror" picks the first two css themes. Those are now the
       siblings sanctuary / sanctuary-day, and a sibling switch only flips attributes, synchronously, before
       DOMContentLoaded, so `__themeDcl.html` is already the store's id.
       - Fix: `const b = list.find((t) => t.css !== list[0].css).id`.
       - With that one-line change (a scratch copy), boot is 5/5.
     - "Classic card after another theme" is flaky (1 pass, 1 fail at "sanctuary changes the look (1 diffs)",
       1 `#toasts` height diff, under load 5–9). It passed in the final run.
- **Coverage** (`test/phase2/themes/run.mjs --theme sanctuary,sanctuary-day`, both ids walked, 50 states): 274
  selectors → **206**, 61 unmatched (22.3 %) → **3 (1.5 %)**, 31 dead-class → **0**, 0 invalid.
  - The 3 left are live classes in states the walk doesn't open: `.bstrip.open .bstrip-list`,
    `.bstrip.open .banner.info` and `.fx-more`.
  - `states.mjs` opens them and audits them: the banner strip is 9.85 minimum, and the fx-more popover 6.19 at night /
    5.85 by day.
- **Contrast** (`tools/themes/shoot.mjs`, 1440×900; `design/warmth/ship/sanctuary/` and `…/day/`):

  | id | perform | quick | edit | edit-tone-eq | mini | mini-drone-keys | lowest |
  |---|---|---|---|---|---|---|---|
  | sanctuary | 185 / 0 | 166 / 0 | 166 / 0 | 158 / 0 | 23 / 0 | 28 / 0 | 4.63 PANIC |
  | sanctuary-day | 185 / 0 | 166 / 0 | 166 / 0 | 158 / 0 | 23 / 0 | 28 / 0 | 4.55 `.song-key` "C" (≥ 24 px bold) |

  Cells are text runs / fails. There are 0 errors in both runs.
- **Stage states** (`design/warmth/ship/sanctuary/states.mjs`, 1440×900 and 1280×720 for classic, sanctuary and
  sanctuary-day).
  - Text audits (runs / fails at 1440; same at 1280):

    | state | Classic | Sanctuary | Day |
    |---|---|---|---|
    | OFF lamps | 169 / 3 (wheel badge 4.44) | 169 / 0 | 169 / 0 |
    | held chord | 184 / 1 (key letter 1.53) | 184 / 0 | 184 / 0 |
    | Faded | 27 / 0 | 27 / 0 | 27 / 0 |
    | Lock | 190 / 4 (drone-char 1.46) | 190 / 0 | 190 / 0 |
    | step panel | 10 / 0 | 10 / 0 | 10 / 0 |
    | key popover | 27 / 0 | 27 / 0 | 27 / 0 |
    | fx-more | 14 / 0 | 14 / 0 | 14 / 0 |
    | banner strip | 4 / 0 | 4 / 0 | 4 / 0 |

  - **Lamps, ON vs OFF** (median tile luminance ratio, text hidden):

    | | Keys | Pad | Drone | OFF LED ring vs tile (flat ≤ 1.1) |
    |---|---|---|---|---|
    | Sanctuary | 7.39 | 8.20 | 12.3 | 1.03–1.04 |
    | Day | 4.98 | 4.93 | 5.46 | 1.05 |
    | Classic | 6.06 | 7.96 | 10.1 | 1.00 |

    The OFF lamp no longer glows.
  - **Keybed, held vs unheld** (luminance ratio):

    | | white keys | black keys |
    |---|---|---|
    | v2 as reviewed | 1.11 (stage critic) | |
    | Sanctuary | **3.6** | 8.47 |
    | Day | 2.4 | 5.2 |
    | Classic | 2.35 | 8.78 |

  - **Fade out at rest vs Faded:** Sanctuary **2.06**, Day 1.63, Classic 1.05.
  - **Warmth** (OKLab ×100 over the room pixels, L < 0.35, `sanctuary-v2/warmth.py` method):

    | shot | a | b | room L |
    |---|---|---|---|
    | v2 as reviewed | +1.84 | **−3.18** | 0.215 |
    | Sanctuary, idle | +2.95 | **−0.79** | 0.222 |
    | Sanctuary, `perform.png` | +2.96 | −0.79 | 0.221 |
    | Sanctuary at 1280 | +2.92 | −0.80 | 0.225 |
    | Classic, same run | −0.18 | −0.91 | 0.211 |
    | Classic, OPTIONS probe | | −1.00 | |

    Sanctuary now meets the b ≥ −1.0 bar and is redder than Classic. Day is paper (87 % of pixels at L ≥ .8), so its
    room figure doesn't apply: its paper is b +1.53, against Daylight Day's +1.05.
- **Layout vs Classic** (getBoundingClientRect at 1440×900 and 1280×720, both ids).
  - Within 2 px:
    - `.song-block`, `.song-name`, `.song-sub`, `.chord-readout`, `.p-head`, `.p-main`, `.p-drone`, `.drone-readout`,
      `.p-bottom`, `.p-notes` and the wheel strip;
    - every `.slot` and every `.slot .ontile`;
    - `.chord-name` at y −1.1 px.
  - Beyond 2 px, only text-intrinsic widths:
    - the setlist chips are 6–9 px narrower each (Alegreya 18 px is narrower than the system sans at 15 px), so later
      chips sit up to 48 px further left;
    - `.slot-inst` w −5.1 / −2.8;
    - the drone ON tile w +3.3.
  - Stage sizes equal Classic's: song title 40 / 38, chord 46, slot names 17, lamp names 15, drone lamp 15.
- **Size**: 115 KB, against the 250 KB limit. That is theme.css 37.5 KB, triplet.svg 3.1 KB and the /fonts files
  Alegreya 52.5 + Figtree 19.3 KB.
- **Runs** (2 CPUs shared, load 4–9):
  - `themes.test.mjs` 9/9.
  - `test/phase2/themes/run.mjs --theme sanctuary,sanctuary-day` **12/13**. The one failure is the sibling-pair
    artifact in deferred item 7: boot, switch ×3, picker, Classic restore, Quick, mini and coverage all pass.
  - `test/phase2/ui-core/run.mjs`, back to back:

    | run | pass |
    |---|---|
    | Classic | **65/67** |
    | Sanctuary (unchanged suite plus the `pin-theme.mjs` preload, as in theme-ember / theme-daylight) | **62/67** |

    - Both fail #40 and #47 on the top-bar `div.meter-bar` X overflow (live meter content). Classic also fails #47's
      DejaVu `−18` check.
    - The Sanctuary-only chord-name Y overflow in #40 / #47 is fixed (above).
    - Sanctuary alone fails:
      - #4: `--muted-fader` expected `#707a88`, got the theme token;
      - #33: OFF tile expected `rgb(39,43,50)`, got `rgb(37,23,32)`;
      - #34: the #33 cascade, since slot 0 is left muted. It passes in isolation (`--test-name-pattern`).
    - No Sanctuary failure is a layout or behaviour change.
- **Screenshots**
  - `design/warmth/ship/sanctuary/`: `{perform,quick,edit,edit-tone-eq,mini,mini-drone-keys}.png` and
    `audit-*.json`, `summary.json`. `day/` holds the same set for sanctuary-day.
  - `states-{classic,sanctuary,sanctuary-day}-{1440,1280}-{idle,lamps-off,held,faded,locked,bstrip}.png` and
    `states.json`, from `states.mjs`.

## themes-critic (Sanctuary + Daylight; reviews/themes-critic.md; design/warmth/ship/critic/)
- **Re-measured** (this box, serial): coverage `sanctuary+sanctuary-day` 206 selectors / 3 unmatched (1.5 %) / 0 dead /
  0 invalid; `daylight-stage+daylight-day` 251 / 4 (1.6 %) / 0 / 0. `shoot.mjs` 1440×900, 0 contrast fails in all 24
  shots, 0 console / HTTP errors. Lowest: sanctuary 4.63 PANIC, sanctuary-day 4.55 `.song-key` "C" (large),
  daylight-stage 4.92 "ON" (Quick), daylight-day 4.67 PANIC. Screens match the options Ryan saw
  (`design/warmth/{sanctuary-v2/perform.png, daylight-v2/perform{,-dusk}.png}`) minus the deferred JS hooks.
- **Contract spot-checks**: both files are `@font-face` + one `:where(html:is(…))` block + `@keyframes` only (no
  unguarded rule); no `content: url()`, no mark or wordmark swap (shared lancet in every shot); no `backdrop-filter`
  (Daylight's one mention is `none`), no infinite animation; no OS `prefers-color-scheme`: dark ids render dark on a
  light-OS context and vice versa (`color-scheme` comes from `html[data-mode]`).
- **Fix: Daylight slot colours as plain values per mode.** `--slot-0..3` were `light-dark()`. `edit/panels/slot.js:858`
  reads `--c` (= `var(--slot-N)`) back for the Keys/Pad/Extra/Bass response-curve canvas; a canvas ignores a
  `light-dark()` string, so the curve drew in the leftover `rgba(255,255,255,.18)` reference stroke: grey on Stage,
  invisible on Day. Now Stage values on `&:root`, Day values on `&:root[data-mode="light"]` (same colours as before,
  so every contrast number is unchanged; Sanctuary already did this). Re-shot Edit on both ids: curve in the slot
  colour, 0 fails.
- **Runtime-switch residue probe** (`design/warmth/ship/critic/residue.mjs`, chain classic → sanctuary →
  sanctuary-day → daylight-stage → daylight-day → sanctuary → daylight-day → sanctuary-day → classic →
  daylight-stage at 1280×800, each step vs a fresh reload): attributes, `#theme-css` (exactly one, no
  `data-theme-next` left), preloads and the computed style/box of 13 Perform elements are identical at every step.
  **One residue, not fixable in a theme file (T1):** `main.js warmThemeFonts` copies only weight/style/stretch into
  its FontFace copies, dropping the chord faces' `ascent-/descent-override`, and the copy wins. After a runtime switch
  `.chord-name` is 56/51 (Sanctuary) and 53/51 (Daylight) instead of 51/51, until the next launch. Fix proposed in
  reviews/themes-critic.md.
- **Suites**: `themes.test.mjs` 9/9; `test/phase2/themes/run.mjs --theme sanctuary,sanctuary-day,daylight-stage,
  daylight-day` 17/18 (the one failure is the harness's "store wins" sibling pairing, T5).

## lowres2-critic (reviews/lowres2-critic.md; engine drone.js + audio.js, tests suites.mjs + critic-lowres2.mjs)
- **#4 `engine.sleepBlockers()` gains `'pedal'`** (sustain pedal down, no notes needed). Before, a held pedal slept
  after `audioSleepSec`; its release then landed on a sleeping context. Now it stays awake; the release (a MIDI
  message) restarts the clock: asleep 2.29 s later with audioSleepSec 2.
- **#1 Same-voicing re-render swaps in step.** `_freezeSwap`: when the new loop has the playing loop's key, mode,
  voicing (brightness on the same side of 0.6) and length, it starts at the old loop's position (`start(t, offset)`,
  `fz.t0 = t − offset`) and both fade linearly (`fade.lin`, `fadeLevel` knows it). The random-offset equal-power swap
  of two coherent loops dipped −3.4 … −8.0 dB mid-swap; aligned, worst −1.8 dB over 12 swaps.
- **#2 Kept loop, one render at a time, un-thaw.** `_fz.last` keeps the last rendered loop (one buffer, counted in
  `droneFreezeMB` when it is not playing); a freeze whose inputs match it swaps it in without rendering
  (`droneFreezeReused` in `_debugStats`). A render finished after being superseded is still kept. While a render runs,
  a new request waits for it (never two at once). Low-resource back on before a thaw's `FREEZE_THAW_LEAD_SEC` ends
  keeps the loop (`_unthaw`: fade cancelled at 1, the silent thaw layer ended, send closed). The first freeze now also
  waits for a live layer still fading in (key change / thaw). Numbers: on/off 5× in 3 s → 1 render (was 5, 2 at once),
  a second storm 0; 300 ms off/on ×4 → 4 un-thaws, level within ±1.5 dB of the steady loop.
- **Verified unchanged** (critic cases, shared 2-CPU box): song switch while frozen (new key / off / files / no
  continue); note 1 ms after sleep 6.9 / 29.8–50.1 / 42.8–50.6 ms (ramp / suspend pending / asleep); popover record
  wakes in 20 ms and holds; hot-plug wakes in 20 ms, silent; a 20 s re-render with a pad chord held adds no skipped
  render quanta (2–11 per 20 s with vs 13–44 without); 20 re-renders: `droneFreezeMB` 6.7 → 6.7, renderer RSS
  147.4 → 147.3 MB. Frozen vs live level +0.59 / −0.08 dB (4 s / 20 s loop).
- **Tests.** Engine `realtime.droneFreezeReuse` (new), `realtime.audioSleep` step 5b (pedal). Engine suite **79/79**;
  shell unit + browser + electron green. Adversarial cases: `node test/phase1/engine/critic-run.mjs [case]`.
- **Open** (reviews/lowres2-critic.md R1–R5): live ↔ frozen swaps can beat (thaw up to −16 dB); the popover counts as
  a visible window (thaw on every open); the send taps the drone after the loop joins (reverb of reverb during swaps);
  one ≈ 74 ms main-thread task per render.

## theme-studio (app/themes/studio/theme.css; registry `studio` body shim dropped; design/warmth/ship/studio/)
Studio ("the rig as a small analog console", best non-finalist: warmth 7 · stage 6 · build 7) brought to the theme
contract (app/themes/README.md), with the CSS-only fixes from its warmth, stage and build critics (OPTIONS.md Option 3
and the warmth journal). Dark only; no light sibling.
- **Contract**
  - One `:where(html[data-theme="studio"])` block. The `:where(body[data-theme="studio"], body:not([data-theme]))`
    guard and its unguarded branch are gone. Tokens sit on `&:root` (0,1,0, ties styles.css `:root` and wins on order);
    the room paint on `& body`, which is what finally renders the desk-lamp pool and grain (build critic: "body
    background never renders"). Low-resource: `&[data-low-resource] body` / `.panel` (no grain, no wash).
  - Registry: `body: {theme:'studio', …}` removed from `themes.js` and `boot.js`; swatch = the new tokens
    (`#181613 / #221f1c / #f4f0e6 / #f7c367`). `themes.test.mjs` 9/9.
  - No `@keyframes`, no `animation`, no `transition` (the `studio-lamp-on` flash fired on every strip rebuild, build and
    stage critics; the 120 ms tile colour fade also made a tile report its old colour mid-toggle, ui-core #33).
    `backdrop-filter` appears once, as `none`, cancelling styles.css's `.overlay-start` blur. Assets root-absolute;
    Rubik from `/fonts/Rubik-var.woff2` (0 × HTTP ≥ 400 in every boot/shoot run).
- **One mark.** `.tb-logo` / `.overlay-card img` `content: url(/themes/studio/mark.svg)` deleted, and the file too.
  The wordmark keeps its text (Rubik 700).
- **Deleted**: the session sheet / line check mock (`.studio-session`, `.ss-*`, ~60 lines: deferred hook); the
  `.fx-lab span` / `.fxpill-l` lowercase + `::first-letter` case flip ("EQ" → "Eq"). There was no `font-size:0` +
  `::after` copy bridge; none added.
- **Stage critic (the weakest lens), CSS part**
  - Current setlist song is the one lit amber cap again (was beige tape); tape only on the Perform title (drawn by
    `::first-line`, so `.song-name`'s box and fitSongName's measurement are Classic's) and the Edit title.
  - Tape dimmed `#d0cabb → #aea796` (Y .39, ΔE 16 from the Drone lamp), ink `#1a1512` 7.6:1; the −0.5° tilt is gone
    (soft 40 px title at 1×).
  - Strip instrument: ivory 700 with a 2 px tape underline (no tape block); a muted strip loses the underline and
    drops to `--muted` (× the app's .7 = 5.8:1), so OFF goes quiet top to bottom.
  - Desk −0.03 L: bg `#201e1b → #181613`, panel `#2a2723 → #221f1c`, bridge `#1a1815 → #13110f`. Glare (perform, 1440,
    2 slots): mean luminance .0802, share > .45 7.5 % (first cut .086 / 8.6 %; Classic .073 / 7.9 %, concept §1.3).
  - Keys `#f2955a → #f47e4f` (hue ~40; vs warn ΔE×100 6.0 → 10.7), Pad `#80cd8b → #6fd183` (+15 % chroma). Fader tracks
    and the strip level bar keep Classic's widths and place (the 6 px bar moved the meter; ui-core polish-1).
  - Top-bar ladder no longer "lies": one fill colour (green; yellow on `.hot`; the app's red `.clip` inset), the LED
    gaps are a static overlay above the fill and under a 3 px ivory peak-hold that is never masked.
  - Lamps: OFF tiles have no halo; OFF lenses (toggle, step-chip cycle, pedal, top-bar) are dark glass in a
    `--led-off` rim (was a filled `--led-off` disc: ON/OFF only 3.15–3.67:1). Drone off: the key it would play is an
    unlit dashed outline (the theme's tint + glow stayed on; ui-core #17).
  - Lock: styles.css dims the drone character group twice (.45 × .45, "Soft · 40%" 1.6:1, Classic too); Studio uses
    .8 × .8 with ivory words.
- **Warmth critic, CSS part**: caps only where hands go (header FX chips, drone key row and setlist are flat printed
  legends; setlist chips opaque `#1d1b18`); Notes is a warmer track sheet with ruled lines at 2× opacity; an empty slot
  is a parked channel (solid recessed well + fader slot, Classic's 1.5 px border) instead of a dashed wireframe;
  walnut meter bridge 3 → 5 px (keybed cheeks stay 8 px, inside the app's 10 px padding); `font-kerning: normal`.
- **Box fixes this round**: `.drone-title` / `.notes-head` `.section-title` `line-height: 16px` (Rubik's line box
  pushed the drone lamp down 2.2 px); the `.ontile` / current-chip gradients carry a trailing colour so
  `background-color` is the lamp / accent colour.
- **Deferred (JS / copy / markup; not theme work)**
  1. Session sheet + 20 s line check + "Last session" + "That's a wrap" (concept §5): needs its own first-launch-of-
     the-day trigger (Electron autoplays, `#overlay-start` never shows, OPTIONS §3 point 3) and a session-log field.
  2. The engineer-voice copy table (concept §4, 13 strings in index.html / perform.js / edit panels / quickSheet.js).
  3. A one-shot lamp flash gated by a JS `.lit-now` class on a real off → on in onTile (the CSS one is cut).
  4. "LIVE" / "TAP" / "PEDAL DOWN" are upper case in the markup; "Extra · add a sound" on the empty-slot well.
  5. Promoting the ~60 literal overrides to styles.css tokens (`--key-white`, `--toast-bg`, …) and the EQ canvas
     reading tokens (`eq-keyboard.js` paints fixed slate), shared with the other themes.
  6. Paint profile on the M-series Mac with a 4-slot chord held (grain tile + ladder masks), unverified here.
- **Coverage** (`themes/run.mjs --only coverage --theme studio`, 25 states incl. mini): 345 selectors / 52 unmatched
  (15.1 %) / 27 dead → **288 / 1 (0.3 %) / 0 dead / 0 invalid**. The one is `.drone-block.off .key-btn.on` (a state
  the walk doesn't reach; ui-core #17 exercises it and passes on Studio).
- **Contrast** (`tools/themes/shoot.mjs --theme studio --out design/warmth/ship/studio/`, 1440×900; mini 320×440):
  perform 185 runs / 0 fails, quick 167 / 0, edit 166 / 0, edit-tone-eq 158 / 0, mini 23 / 0, mini-drone-keys 28 / 0,
  0 console / HTTP errors. Lowest 4.96 ("Echo" / "Space" on a tinted step chip), PANIC 5.11.
- **States / lamps / boxes** (`design/warmth/ship/studio/states.mjs` → `states.json`, `audit-state-*.json`):
  - Text, 1440×900: held chord 184 / 0 fails, Keys + Drone OFF 182 / 0, Faded 183 / 0, Lock with a chord held 190 / 0
    (6 disabled-exempt runs: the app's .45 disabled Edit / Prev / Revert / Choose folder, as Classic).
  - ON vs OFF (median luminance, text hidden): Keys tile 4.88:1, Keys lens 11.1, Drone tile 8.55, Drone lens 11.1,
    toggle LEDs 8.59 (min ON vs max OFF), step-chip cycle LEDs 8.18, pedal lamp 9.53. ON is always the brighter state.
  - Boxes vs Classic (getBoundingClientRect, 1440×900 and 1280×720): `.song-name`, `.chord-readout`, `.perform .slot`,
    `.perform .slot .ontile`, `.transpose-val`, `.p-keys`, `.piano`, `.topbar`, `.p-notes`, `.btn-panic` **0 px**;
    `.chord-name` 0.7, `.slot-inst` 1.9 (text run, Rubik), drone `.ot-sub` (the visible drone readout; `.drone-readout`
    is SR-only) 1.6. Text-intrinsic only, > 2 px: `.song-key` x −3.2/−3.4 (sentence-case "Key" caption is
    narrower), `.setlist-chip.current` w +3.4 and `.drone-head .ontile` w −2.7 (Rubik wider than the Linux fallback in
    the chip names / the Synth·My Pads segments; container boxes unchanged). Sizes = Classic's: title 40 / 38 px,
    chord 46 px idle (22 px "Cmaj7" via the app's data-len rule), slot names 17 px, drone readout 14 px, transpose 30.
- **Size**: folder 50.0 KB (theme.css 37.8, grain.png 11.7, tape masks 0.4) + Rubik 35.4 KB = 85.4 KB (limit 250).
- **Suites** (2 CPUs, serial, load 3–8)
  - `test/phase2/themes/run.mjs --theme studio`: **10/11**. The one failure, "store wins over a stale mirror", always
    pairs the first two css themes (sanctuary / sanctuary-day) whatever `--theme` says (themes-critic T5).
  - `test/phase2/ui-core/run.mjs`, Studio via the preload `node --import pin-theme.mjs` (RIG_THEME is not a suite
    switch; the suite pins Classic itself): **Studio 61/68**, Classic back to back **65/68** (fails #40, #47, #66).
    - Studio fails #40 and #47 as Classic does, plus: #4 (`--muted-fader` Classic token) and #33 (OFF tile
      `rgb(39,43,50)`, Studio `rgb(41,38,31)`): Classic-token assertions, as for every theme; #34 is #33's cascade
      (passes alone). #30 / #31 are the meter-clock cadence checks (#31's 4 px geometry passes): #31 passes alone, #30
      fails alone on Classic too (1.0/frame). #66 (new mid-run) passed on Studio.
    - Earlier Studio run, fixed since: #31 (6 px meter), #18 (translucent chip read as white), #17 (drone-off key
      glow).
- **Screenshots** (`design/warmth/ship/studio/`): `perform.png`, `quick.png`, `edit.png`, `edit-tone-eq.png`,
  `mini.png`, `mini-drone-keys.png`, `state-{held,muted,faded,locked}.png`, `perform-{classic,studio}-{1440x900,
  1280x720}.png`, with `audit-*.json`, `summary.json`, `states.json`.

## idle-cpu-ui (reviews/idle-cpu-mac.md UI side, idle-cpu R1–R4, lowres2 UI requests, L-24; views/components/{meterClock (new),meter,levelMeter,util,holdButton,readouts,eq-keyboard,index}.js, views/{perform,mini}.js, views/edit/panels/song-header.css, main.js (renderer), styles.css, controller.js (additive), tools/idle-cpu.mjs)
Builds on critics-fix #2 / R1 / R4 (per-meter ≤ 30 fps loops with a 250 ms idle poll): verified with the harness, then
replaced by one shared scheduler.
- **`components/meterClock.js` (new): one frame loop for every meter.** `meter.js` (top bar, Edit › Master) and
  `levelMeter.js` (Perform strips, Edit slot panels) register with `addMeter({tick, probe?, kind})` →
  `{setVisible, wake, remove, awake, visible}`; exports `wakeMeters()`, `meterClockStats()` (test hook, also
  `__rig.meters`), `meterBlocked()`, `FRAME_MS` (1000/30), `SILENT_MS` 500, `SILENT_AMP` (−90 dBFS), `PROBE_MS` 1000.
  - ≤ 30 frames/s on any display: after a frame the next rAF is requested from a `setTimeout(FRAME_MS − 2 ms −
    elapsed)` (idle-cpu R1c: a frame skipped by timestamp still costs a BeginMainFrame, ~90/s at 120 Hz).
  - A meter whose input stays < −90 dBFS with its bar, hold and clip light at rest for 500 ms sleeps; with every
    visible meter asleep the loop is **stopped** (0 rAF). Restart: `controller.onActivity(cb)` (new, additive; event
    `'activity'` {kind}, throttled to one per 50 ms) fired by every input the lowres2 clock sees (note-on from any
    source, keys, pointer, wheel, MIDI incl. CC, popover bus commands, hot-plug), a song applied, an edit of the current
    song (drone, levels, key), recording on/off and an audio wake; main.js → `wakeMeters()` (+ `'notes'` as fallback).
    Safety net: while asleep the stereo meters' master analysers are probed once a second by a timer (no rAF).
  - Blocked (no rAF, no analyser / slotLevel reads, no probe) under `<html data-low-resource>`,
    `<html data-window-hidden>` or `document.visibilityState === 'hidden'`; a MutationObserver on those attributes
    and `visibilitychange` restart it, no reload. The meters are also `display:none` there (menubar-B rule), which
    takes them out of their IntersectionObservers.
  - Writes: transform / class / `aria-valuenow` (≤ 2/s) only on change; nothing reads layout in a tick. The peak hold
    moves with its track's `transform` (R1b: `left` gave the drone's 4–6 layouts/s). The track is one bar long and
    starts one bar-length **before** the bar (left / above), with the hold at its far edge, so no translate ever pushes
    past the bar's end (the first version, `inset:0` + `translateX(p%)`, grew the bar's scrollWidth to 72 + p·72 and
    failed polish-2A's clip check in every theme agent's run). Horizontal hold now ends at the peak; vertical unchanged.
  - Shared analyser reads: the top-bar and Edit › Master meters read the same `engine.analyserL/R` once per clock
    frame (a WeakMap keyed by the frame's `now`), so Edit costs 60 reads/s, not 120.
- **`eq-keyboard.js`** (Advanced › Tone, only while open): under low-resource / a hidden window (no live spectrum) an
  editor with nothing to redraw for 500 ms leaves its display loop and checks its dirty flags on a 250 ms timer; an
  edit or clearing the attribute restarts it (measured: 0 rAF in 1 s idle, edit → loop in 268 ms, resume 62 ms).
- **perform.js.** `renderDroneReadout` compares a signature of its inputs and returns without building strings or
  touching the DOM when nothing changed; the readout cell is `contain: strict; font-variant-numeric: tabular-nums`.
  The 150 ms runtime tick (pedal / wheel / faded lamps) runs at 1 Hz under data-low-resource or data-window-hidden
  (period re-read every tick; the CC64 listener still lights the pedal lamp at once) and not at all while Perform is
  hidden. `readouts.js`: class writes only on change. The chord readout is event-driven (no poll); `setText` writes
  only a changed Text node. **lowres2 request:** `renderQuick()` passes `audio: status.audio`, so Quick › This Mac
  says "Audio asleep — play a note or press a key to wake".
- **main.js (renderer).** `renderAudioStatus`: `asleep` → "Asleep" with an **ok** LED (not warn).
  **Hidden-window hook (R4, LOCAL 04:38Z: ⌘H with menu-bar mode off was ignored):**
  `window` CustomEvent **`'rig:window-visible'` `{detail:{visible:boolean}}`** — LOCAL's preload dispatches it on
  every show / hide / minimize in **every** mode — and `document` `visibilitychange` (`visibilityState !== 'hidden'`)
  both call `setWindowVisible(v)`: `<html data-window-hidden>` on/off + `controller.setWindowVisible(v)`, regardless
  of `settings.menuBarMode`. The `rig:menu` ids `windowShown` / `windowHidden` / `windowFollowDocument` still work.
  **L-24:** `util.js guardKeyActivation(document, window)` (installed once): a Space keyup activates a button only if
  its keydown landed on that same control in the same focus session (a window blur, focusout or hidden document in
  between cancels it), and Space/Enter auto-repeat never re-activates. `holdButton.js` and perform.js's key-grid
  `holdGate` abandon a pointer hold on window `blur` / hidden document (never commit it). Diagnostics:
  `__rig.diag.drone` logs every in-song change of `drone.mode` with the last input kind, focus / visibility / hidden
  state, the last 3 bus commands and the `store.set` call site (≤ 20 entries).
- **mini.js** (lowres2 request): `statusLine` maps `asleep` → "Audio asleep" with an ok LED.
- **Tools.** `tools/idle-cpu.mjs` gains UI columns (`raf` rAF callbacks/s, `rcs` / `lay` CDP RecalcStyleCount /
  LayoutCount deltas per s, `an` all analyser reads/s, `man` reads of engine.analyserL/R, `slot` slotLevel reads/s),
  config **W** (A + `rig:window-visible {visible:false}`, menuBarMode off) and `--app <dir>` (A/B another app tree).
- **Numbers** (this 2-CPU box, headless Chromium = 60 Hz, load ≈ 1–4; `node tools/idle-cpu.mjs --only
  A,B,D,E,G2,W --measure 10 --settle 8 --no-offline`; "before" = `--app` a copy of today's tree with the views,
  main.js and styles.css from just before this work, i.e. critics-fix's per-meter loops; engine / controller the same):

  | config | rAF/s | style recalcs/s | layouts/s | master-analyser reads/s | DOM mutations/s | timers/s | main + comp % |
  |---|---|---|---|---|---|---|---|
  | A Sunday, drone on | 60 → **29.8** | 29 → 29 | 4 → **0** | 60 → 59.6 | 60.1 → 61 | 7.8 → 37.5 | 6.3 → 5.9 |
  | B drone off (silent) | 0 → 0 | 0 → 0 | 0 → 0 | 8 → **2** | 0 → 0 | 11.8 → 8.8 | 0.7 → 0.6 |
  | D low-resource | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 7.7 → **2** | 0.5 → 0.5 |
  | E Edit, drone on | 120.2 → **29.9** | 29 → 29 | 4 → **0** | 120.4 → **59.8** | 117.9 → 118.2 | 7.9 → 37.6 | 7.0 → 5.3 |
  | W hidden (event, menu-bar off) | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 0 → 0 | 7.8 → **2.1** | 0.4 → 0.2 |
  | G2 Grand Piano (silent) | 0 → 0 | 0 → 0 | 0 → 0 | 8 → 2 | 0 → 0 | 11.8 → 8.7 | 0.4 → 0.3 |

  - At 120 Hz ProMotion the "before" loops request one rAF per display frame while animating (≈ 120/s per loop;
    the Mac's pre-critics-fix baseline was 121 rAF/s and 121 recalcs/s in every configuration); "after" is 30/s in
    total while something sounds, 0 when silent, hidden or low-resource, whatever the refresh rate. The extra timers
    in A/E are the R1c pre-frame timeouts (30/s, cheaper than 90 skipped BeginMainFrames). Renderer totals are
    dominated by the audio thread here (A ≈ 11 of 22.7 %); UI main + compositor are the last column.
  - ui-core (real app): silent → rAF 0/s, 0 style recalcs and 0 layouts in 3 s, master reads 2/s (1 Hz probe);
    note-on → first meter frame 6.3 ms; drone on 30 rAF/s, 60 reads/s; low-resource or `data-low-resource="1"` with
    the drone on → 0 rAF, 0 reads, 2 runtime polls in 2.5 s; attribute removed → 27–30 frames/s again; hidden
    (event / visibilitychange) → 0 / 0.
  - L-24 on the pre-change tree: a window blur/focus pair alone does **not** toggle the focused drone tile; a Space
    press straddling it does (synth → off: keyup after refocus clicks), and Enter auto-repeat toggles once per repeat.
    Both are guarded now. The Mac's run had no key event, so the root cause is **still unconfirmed**: LOCAL, please
    read `__rig.diag.drone` after a repro (it names the `store.set` call site and the bus commands around it).
- **Other fixes.** Edit header live hint hidden below 1401 px (was 1341): since critics-fix O12's rename pencil it
  wrapped to five lines in the 50 px header at 1366×768 (integration-widths); `integration-widths` expects it hidden at
  1366 now. Removed `test/phase2/ui-core/_idle_tmp.mjs` (a stray copy of the suite).
- **Tests.**
  - ui-core: `idle-cpu-ui` (silent / wake ≤ 100 ms / drone ≤ 35 rAF/s / low-resource + bare attribute 0 rAF 0 reads,
    1 Hz lamps / no reload; + hold geometry: horizontal hold ends at the peak, vertical at the peak, 0 px overflow),
    `idle-cpu-ui R4` (rig:window-visible and visibilitychange with menu-bar mode off), `L-24` (window blur/focus,
    real focus loss, Space held across a blur, element blur, Enter auto-repeat; Lock / key grid / transpose holds
    abandoned on blur / hidden), `lowres2 requests` (top bar "Asleep" + ok LED, Quick › This Mac line).
    **Updated for the refresh-independent cadence:** `round2-ui #10` (reads per clock frame and per second: Perform
    1.00/frame ≤ 35/s, Edit 1 shared read/frame with both meters awake, ≤ 35/s; runtime polls 0 while hidden) and
    `polish-1` strip meters (≤ 1 read per clock frame per strip or asleep, ≤ 35/s, 0 when hidden); `critics-fix
    performance #2` kept.
  - mini: status line `asleep` → "Audio asleep · 12 ms · …" with an ok LED (pure helper + a mounted popover).
  - eq: `idle-cpu-ui: low-resource → an idle open editor makes 0 rAF/s; an edit redraws; clearing it resumes`.
- **Runs** (load 1–6, other agents running): ui-core **67/68** (the one failure, `hardware-fixes 2b` "DejaVu Sans
  1366×768 −18: value 45 > 41 + 3", fails the same way in every theme agent's run since 20:34 and is not in this
  change); edit-v2 `--only integration`: integration 13/13, integration-widths 5/5 (after the live-hint fix; 4/5
  before, deterministic); mini 14/14 + mini-theme 14/14; eq 28/28; `tools/idle-cpu.mjs` 0 console errors.

## themes-critic-2 (Studio + Ember; reviews/themes-critic.md "round 2"; design/warmth/ship/critic/{studio,ember,se}/)
- **Re-measured** on this box (serial, load 3–5):
  - Coverage: `studio` 288 selectors, 1 unmatched (0.3 %), 0 dead, 0 invalid. `ember` 182 selectors, 3 unmatched
    (1.6 %), 0 dead, 0 invalid.
  - `themes --theme studio,ember`: 13/14. The one failure is the known T5 sanctuary-sibling pairing.
  - `themes.test`: 9/9.
- **Contrast** (`shoot.mjs`, 1440×900; mini 320×440): 0 fails in all 12 shots and 0 console / HTTP errors.
  - Run counts are the same for both themes: perform 185, quick 167, edit 166, eq 158, mini 23, mini-drone-keys 28.
  - Lowest: Studio 4.96 (step-chip "Echo"/"Space"), PANIC 5.11. Ember 4.69 (PANIC).
- **Option fidelity:** both match `design/warmth/{studio,ember}/perform.png` apart from the deferred JS/copy hooks. The
  shared lancet shows in every shot.
- **Contract spot-checks** (both files):
  - Structure: `@font-face` plus one `:where(html[data-theme="<id>"])` block, and no rule outside it.
  - Not present: `content: url()`, a mark swap, `@keyframes`, `animation`, `transition`, `light-dark()`, `prefers-*`.
  - `backdrop-filter` appears only in Studio, as `none`.
  - Studio's one `@media` is `max-width: 1250px` layout.
  - Swatches match the tokens.
- **Fix: Studio title tape (S1).** `.song-name::first-line` painted the tape behind the glyphs only, so the title read as
  selected text.
  - The tape is now the `.song-name` box: `width: fit-content; max-width: calc(100% + 10px); margin-left: -10px;
    padding: 0 12px`, with the Edit title's torn-end masks.
  - `::first-line` keeps only `color: var(--tape-ink)`, so the `.loading` state stays legible on the tape. Without it
    the name turns `--muted`, 2.3:1 on the tape.
  - Box vs Classic: dy/dh 0 at 1440×900, 1280×720, 1366×768 and 1024×700; dx −10; dw −3 to −103 (text-intrinsic).
  - `.song-block` is unchanged, so ui-core's "no layout shift" and L-20 checks (height = line box) are unaffected.
  - fitSongName still steps a long name down and ellipsizes it inside the tape.
  - Glare on perform: mean luminance .0808, bright share 7.53 %. Before it was .0802 and 7.5 %.
- **Fix: Ember record counter (E3).** `.rec-time` kept styles.css's `--mono`; it now uses `var(--font)` (Nunito,
  tabular). Box: `.rec-time` w +2.2, and the top-bar items after it move ≤ 4 px in x, with 0 in y.
- **Box diff vs Classic** (`se/boxdiff.mjs`, 38–44 boxes, idle, fresh boot): every dy and dh is 0.0. Everything above
  2 px is text-intrinsic:
  - Studio: `.tb-name` w −4.5 (and `.tb-views` x), `.song-key` x −3.3, `.setlist-chip.current` w +3.4,
    `.drone-head .ontile` w −2.7, `.wheel-value` w +6.7, plus the tape above.
  - Ember: `.tb-name` w +5.5, `.song-key` x −7.4 / −7.6, `.setlist-chip.current` w −4.6, `.wheel-value` w +3.7,
    `.rec-time` w +2.2.
- **Runtime-switch residue** (`critic/residue.mjs`, 12-step chain through classic / studio / ember / sanctuary /
  daylight-day / nave): Studio, Ember and Classic steps show 0 diffs from a fresh reload. That covers attributes,
  color-scheme, one theme link, and the computed style and box of 13 elements. The only diffs are T1 on Sanctuary and
  Daylight.
- **Left for others** (reviews/themes-critic.md):
  - E1: Ember `.chord-name` is 56/51 and `.song-name` 50/48 as line boxes. No ink is clipped (`se/chordclip.mjs`), but
    ui-core #40's probe flags both. The fix is override faces, after T1.
  - E2/S2: `headerChipRow.js` uppercases the FX captions.

## lowres2-scope (Ryan 2026-09-30: lowres2 ships in v1 only inside low-resource mode; engine drone.js + drone-freeze.js + audio.js + voice.js + synth.js, controller.js (additive), views/settings.js (1 row out), store.js (comment), shared/bus.js (comment), docs/menubar-mode.md, tests suites.mjs + critic-lowres2.mjs + shell lowres2.test.mjs)
- **Scope.** The drone freezes and the audio sleeps only while low-resource is on (`settings.lowResource`, or auto while
  hidden in menu-bar mode). In normal play the context never sleeps and the drone is never frozen (the drone part was
  already gated by `engine.setLowResource`).
  - Controller `sleepCheck()` returns unless `lowResEff`. The idle window is `settings.audioSleepSec` (default 30,
    kept in the store, no UI) counted from `max(lastInput, low-resource on)`, so hiding the window after a long idle
    does not sleep at once. `_sleepDebug()` adds `lowResource`, `lowResSince`.
  - Leaving low-resource wakes a sleeping or ramping-down engine at once: the controller's `applyLowResource` calls
    `engine.wake()`, and `engine.setLowResource(false)` does too (60 ms `WAKE_RAMP_SEC`, click-free; a 150 ms sleep
    ramp in progress is cancelled from where it is). Measured (real controller): awake 20 ms after
    `settings.lowResource` → false, then 3 s idle with no sleep.
  - Settings › Audio "Sleep audio after" row removed (the "Audio asleep" hint stays). The Quick / top-bar asleep
    states are unchanged.
- **R2: the popover does not end low-resource.** A bus `hello` (the popover opening or asking for state) is no longer
  input. It still gets the immediate state, but it does not wake the audio, restart the idle clock or emit
  'activity'. Every other bus command still wakes the audio. New rig menu ids `popoverShown` / `popoverHidden` set
  `status.popoverOpen` and never touch low-resource. **Request for LOCAL (Electron main.js):** report the tray popover
  with those ids, not with `windowShown` or `rig:window-visible` (critic R2 traced the thaw-on-open to that path).
  The cloud cannot see LOCAL main.js, so the thaw-on-open is fixed here only for `hello`.
- **R1: live ↔ frozen level.**
  - Thaw: the live voices now start `max(FREEZE_THAW_LEAD_SEC, drone-osc attack + 0.25 s)` before the crossfade
    (2.75 s for synth.js, 2.25 s for the fallback). Before, a 1.5 s lead crossfaded the loop out over voices that
    were still in their 2–2.5 s attack.
  - Live → frozen: the first swap also waits for the live voices' own attack (`L.voiceT + L.attack`), not only for
    the layer fade.
  - Measured with `critic-run.mjs r1Swap`: 4 cycles per instrument, 100 ms windows, each against a control of the
    same statistic on a steady stretch with no action.
    - Real drone-osc (synth.js, what the app plays): live→frozen worst −3.62 dB and thaw −3.57 dB, against the
      drone's own spread of −3.63 dB (live) and −3.41 dB (frozen). The swap adds 0.0 dB beyond the control.
    - Fallback drone-osc (only used when synth.js fails to load): thaw −0.54 … −1.12 dB (control −0.88; the critic
      saw −16.1 dB). Live→frozen is still −1.3 … −8.7 dB (control −0.25). That is phase beating between the
      fallback's two oscillators per voice and the loop: a coherent sum that no gain law fixes. **Open**, fallback only.
    - The critic's −16.1 dB came from `frozenEngine`, which uses `instrumentModules: false`, i.e. the fallback.
- **R3: the reverb is fed from one path at a time.**
  - The drone's gain chain runs 4 channels: [live L, live R, loop L, loop R] → level → wheel → bend. drone.gain, the
    wheel and the swell still have one set of automation.
  - `post` (splitter) → `mainMerge` → out gets live + loop. `sendMerge` → sendGate → reverb gets channels 0–1 only.
  - A frozen loop, which carries its own baked reverb, enters at merge inputs 2–3 (`fzIn`), so it never reaches the
    live reverb, not even mid-swap.
  - Nodes: +4 (`nodeCount` 21). `dispose()` also disconnects `sendGate`.
  - Not changed: after a live→frozen swap the live reverb's tail still decays over the baked one. It was fed only by
    the live path, as it should be.
- **R4: render stall.**
  - `renderDroneLoop` yields between steps, with a MessageChannel turn so queued MIDI / key tasks run first.
    `scheduler.yield()` is not used, because its continuation jumps the queue. The steps are:
    1. context + reverb chain;
    2. Drone + configure / setKey;
    3. the drone-osc instrument, built into `_idle` with the same rng order;
    4. voices + `startRendering`;
    5. after the render, one seam crossfade per channel, one `copyToChannel` per channel, and `seamCheck` in slices of
       256 k frames.
  - `voice.js shareWaveCache(from, to)`: the offline context reuses the live context's PeriodicWaves (8 saws × 512
    harmonics were rebuilt per render, ≈ 8–10 ms). Checked: a wave from another context renders with max diff 0.
  - `synth.js randomWalkBuffer`: the same per-sample arithmetic, one segment at a time (bit-identical, checked on 3
    seeds).
  - `_debugStats().droneRenderMaxStepMs`, `_fz.lastStats {buildMs, postMs, maxStepMs, stepMs}`.
  - Measured with `r4Stall` and a Chrome trace of RunTask CPU (`tdur`), 4 renders per instrument on the shared 2-CPU
    box. Load ran 2.6–10 during the runs, so wall times inflate.
    - Longest render step (wall): real 8.1–21 ms (one outlier at 29.5) and fallback 4.9–13.6 ms at load 2.5–3;
      15–60 ms at load 5–10.
    - Traced CPU of the render's own tasks: ≤ 16.4 ms (real), ≤ 7.1 ms (fallback). The critic measured one 74 ms task.
    - No long task (≥ 50 ms) during renders at load ≈ 3.
    - Left over: 1–2 Chromium-internal tasks after each render, 14–24 ms CPU, with no JS. They are the GC / Oilpan
      sweep of the offline graph and its 12 MB render buffer. Not ours to split.
- **R5: key change with a short song fade.** When something already sounds and the fade is shorter than drone-osc's
  attack, the new layer's voices attack in `XFADE_ATTACK_SEC` = 0.05 s and the equal-power layer fade shapes the
  onset. The instrument's attack is restored after the noteOns, so `_revoice` / later layers keep 2.5 s. A start from
  silence and a parked drone resuming keep the voice attack. Measured with `keyDuringCrossfade` (fade 0.3 s):
  - live: −2.26 dB (the critic measured −10.6 … −11.6);
  - with the loop in play: live→frozen −3.49, frozen→frozen −5.21, thaw −1.26, render in flight −1.69 dB (the critic
    measured −7.4 … −16.6).
  - All 0 clicks, 0 stale swaps.
- **Tests.**
  - Shell `lowres2.test.mjs`: new tests for no sleep in normal play (600 s idle), the window counting from
    low-resource on, leaving it (and showing the window in menu-bar mode) waking at once, and hello / popoverShown not
    waking. Low-resource-on tests keep the old assertions; the "popover hello" input became a real command.
  - Engine `realtime.audioSleep`:
    - step 0: normal play never sleeps;
    - low-resource on, then the old steps;
    - step 5: hello leaves it asleep and still gets the state, and `record {on:false}` wakes it;
    - step 5c: leaving low-resource wakes it in 20 ms and it stays awake.
  - New critic cases `r1Swap` and `r4Stall`, with `frozenEngine({modules})`.
  - Engine **79/79**, shell unit 199/199 + browser 13/13, settings 37/37.
- **Hardware fixes untouched** (## hardware-fixes).

## idle-cpu-ui-critic (reviews/idle-cpu-ui-critic.md; views/components/meterClock.js, ui-core + mini tests)
- **Verified** the "## idle-cpu-ui" claims: `tools/idle-cpu.mjs --only A,B,D,E,G2,W --measure 10 --settle 8
  --no-offline` at load 7–9 → A 26.2 rAF/s, 25 recalcs/s, 0 layouts, 52.4 master reads/s; E 24.4 / 24 / 0 / 48.8
  (one shared read per frame); B and G2 0 rAF, 2 reads/s (probe); D and W 0 rAF, 0 reads, 2.1 timers/s. Wake paths
  checked in the real app: song switch that starts a drone, popover `droneToggle`, raw MIDI CC, Edit › Keys slot meter,
  Perform strips, `rig:window-visible` false → true. 0 console errors.
- **Fixed (meterClock):** a tick's `dt` is now the meter's own gap (`now − e.last`, ≤ 5 s), not the loop's
  (`min(100, now − lastRun)`, `FRAME_MS` after a stop). A meter back from low-resource / a hidden window / an off-screen
  view no longer replays its old bar at 20 dB/s (drone stopped during low-resource: top bar showed 0.72 falling for
  ~2 s while the output was at 0.47); it releases to the current level on its first frame. Test: ui-core
  `idle-cpu-ui critic: a meter back from low-resource shows the current level at once` (old clock: 0.876, new: 0).
- **mini** `low-resource` test: the "normal" window waits for ≥ 20 display frames (≤ 6 s), since at load ≈ 10 the page
  got 3 frames in 1 s and `reads > 5` failed on the box.
- **Runs:** ui-core 67/69 (`hardware-fixes 2b` as before; `H-v2 Quick sheet` TAP tempo 81 BPM at load 10, passes
  alone); edit-v2 `--only integration` 2/2 files; mini 14/14 + mini-theme 14/14.
- Open items (EQ editor at display rate while open, Perform's runtime timer while Edit shows, recording clock while
  hidden, engine fx idle taps ≈ 12 reads/s, L-24): reviews/idle-cpu-ui-critic.md.

## theme-classic (registry `classic` = styles.css alone, no theme file; base-look suites pinned; design/warmth/ship/classic/)
- **No theme file, nothing to strip.** Classic has no folder, no `body` shim, no mark override, no fonts, so checklist
  items 1–5 and 7 (guard, one mark, must-fixes, copy bridge, coverage, light sibling) do not apply. Coverage: n/a.
- **Pixel identity** (scratch `diff.mjs`: two copies of today's `app/`, A as shipped, B with both `boot.js` tags
  deleted from index.html + mini.html and html/body `data-theme|mode` + inline color-scheme stripped; meters, canvas
  and `#ready-status` hidden, transitions off; a second A run gives the noise floor). Differing pixels, A vs B / A vs A:
  | shot | 1440×900 | 1280×720 |
  |---|---|---|
  | perform idle | **0** / 222 | 31 / 31 (same box, x 846–1265 y 46–213: live) |
  | perform, chord held | **0** / 196 | 2 / 207 |
  | Quick open | **0** / 72 | 9 / 58 |
  | locked, Settings › Appearance, Edit, Edit › Tone EQ | **0** / 0 | **0** / 0 |
  Element boxes: 132 compared per state; the only deltas are the live meter fills/holds (both A runs differ as much).
  0 console errors, 0 HTTP ≥ 400 in both. So the theme infrastructure leaves Classic pixel-identical.
- **styles.css tail** (themes-setup): `.qs-theme` only (Quick › This Mac "Theme: Classic ▸"); nothing keyed
  on `data-theme`, and no `data-theme` selector anywhere in `app/*.css`. `.st-theme*` (styles-edit.css) styles the
  new picker only. boot.js on Classic: attrs + `color-scheme: dark` (same as the page's meta), no preload, no link.
  The Quick button is new content, not a restyle: measured by the first theme-classic run (qprobe, 09-29 01:40), This
  Song's section already overflowed its 156/176 px sheet body by 27/5 px without it; the caption row grows 17 → 24 px,
  overflow 33/13 px. Not mine (styles.css); for whoever owns Quick next.
- **Base-look pins** (`pinTheme(context, 'classic')` from test/integration/lib.mjs, right after `newContext`):
  ui-core, edit-v2 harness + integration + integration-widths, settings, eq (the eq fixture links styles.css only, so
  its pin is belt-and-braces). All present; this round added no new pin lines.
- **themes suite** (test/phase2/themes/run.mjs):
  - "Classic card after another theme restores the base look exactly" (`--only classic` or `picker`): every visible
    element's computed look (15 props) and all `:root` tokens after Classic → <first css theme> → Classic equal a
    fresh Classic; no theme stylesheet left. Hardened this round: `pick()` now waits for `theme.current === id`
    before awaiting `theme.pending` (the store notifies after the write, so it awaited the previous switch: the
    "sanctuary changes the look (1 diffs)" flake), then for `html[data-theme]`; `#toasts` itself is skipped (its
    height follows the toast); the "no theme link" check counts `rel=stylesheet` only (boot.js's `rel=preload` of the
    boot-time default stays in `<head>`, which failed it with the default at sanctuary).
  - "store wins over a stale mirror" (themes-critic T5, deferred by 4 theme agents): `b` is now the first css theme
    whose file differs from `a`'s (siblings flip attributes synchronously before DOMContentLoaded).
- **Runs** (2 CPUs, serial, load 7–15). "cls" = a repo copy as shipped (default `classic`); "san" = the same copy with
  `DEFAULT_THEME_ID` and boot.js `DEF` set to `sanctuary` (the mirror/default the pins must beat):
  - themes (whole suite, cls, before the fixes): 27/28 (store-wins only); every coverage file ≤ 5 %, 0 dead.
    After: cls `--only boot,switch,picker,classic,quick,mini` **23/23**; san `--only boot,picker,classic` **13/13**.
  - ui-core: cls **66/68**, san **66/68**, same two fails (#36 TAP ≈ 93 BPM under load; #47 DejaVu Sans 1366×768
    "−18" 45 > 41 + 3, a Linux-font Classic fail). Contrast readings identical in both (e.g. mutedFader 4.09,
    ledOffTopbar 3.89); #4 / #33 / #40, which failed unpinned under Sanctuary (themes-setup), pass.
  - eq: cls **28/28**, san **28/28**.
- **Contrast** (`tools/themes/shoot.mjs --theme classic --out design/warmth/ship/classic/`, 1440×900; plus `--size
  1280x720 --only perform,quick` → `1280/`; plus a scratch copy of shoot.mjs with a `states` pass → `states/`,
  `1280/states/`: Keys OFF, Locked, Faded). Runs / fails / lowest:
  - perform 185/0/4.63 (PANIC); edit 166/0/4.63; edit-tone-eq 158/0/4.63; mini-drone-keys 28/0/5.31; perform 1280
    158/0/4.63; Keys OFF 185/0/4.58 (struck "KEYS"); Faded 184/0/4.63 (chip shown).
  - **Classic base-look failures, not fixable here** (all in files this brief may not touch; identical before
    themes-setup, per the pixel diff):
    1. Quick open: the ON pill (`.ontile .ot-state`, 12.5 px, #0d0f12 on #ff8a3d + 18 % ink) falls under the sheet's
       `box-shadow: 0 22px 60px #000c` (styles.css `.qs`): 4.14 at 1440 (Keys), 3.35 / 4.16 (Keys / Pad) and
       "KEYS" 4.44 at 1280. By CSS alone the pill is 5.08–7.45. Fix (styles.css owner): a shorter shadow
       (`0 12px 28px #0009`) or a darker pill tint.
    2. Mini popover under Classic: `.m-num` "2"/"3" (11 px, #7d756b on #25221e) 3.49; mini.css fallbacks (mini-theme
       owner): `--m-faint` ≥ #9a9185.
    3. Locked: the drone Brightness / Movement faders are frozen at opacity .45 × .45 (label 1.84, value 1.46). They
       are inactive controls (WCAG exempt) but carry no `disabled` / `aria-disabled`, so audits count them; add
       `aria-disabled="true"` on frozen wrappers (perform.js owner).
  - ON/OFF lamps (styles.css tokens): ON LED #fff vs OFF ring `--led-off` #6b7380 4.78; ON tile vs `--off-tile`
    #272b32: Keys 6.06, Pad 7.96, Extra 5.64, Bass 5.25. All ≥ 3.
- **Stage safety**: Classic is the reference, so its box diff is 0 by definition (the A/B diff above: 0 px at
  1440×900). Sizes: song title 40 px (1440×900) / 38 px (1280×720), box 410×50 at (35, 76); chord 46 px (800),
  box 82×51; slot names 15 px / 800 caps on the tiles; drone "DRONE C major" 14.5 px (the `.drone-readout` node is
  the screen-reader copy, 1×1 clipped).
- **Screenshots**: design/warmth/ship/classic/{perform,quick,edit,edit-tone-eq,mini,mini-drone-keys}.png,
  `1280/{perform,quick}.png`, `states/` and `1280/states/` `{perform-keys-off,perform-locked,perform-faded}.png`, each
  with its `audit-*.json` and `summary.json`; test/phase2/themes/screenshots/classic-restored.png.
- **Deferred (not CSS / not this brief's files)**: the three contrast items above; Quick's This Song overflow;
  the themes suite's first test title still says "(Sanctuary)" while `DEFAULT_THEME_ID` is `classic` (TEMP).

## theme-nave (app/themes/sanctuary/theme.css; registry `nave`; design/warmth/ship/nave/)
Nave is the v1 Sanctuary (ink-navy vault, lancet light, grain), kept as its own dark option next to `sanctuary`
(sanctuary-v2, plum). Dark only, no light sibling. This entry brings it to the theme contract (app/themes/README.md) and
applies the CSS-only fixes from its three round-1 critics (warmth journal: warmth 6.5, stage 7.5, build 7).
- **Contract**
  - Every rule sits in one `:where(html[data-theme="nave"])` block; the v1 `body:is([data-theme=sanctuary],
    :not([data-theme]))` guard (0,1,1) and its unguarded branch are gone. Tokens and the vault are on `& body`
    (styles.css' `:root` tokens are (0,1,0)); low-resource is `&[data-low-resource] body::after { display: none }`.
  - The zero-specificity guard is what fixes the **OFF-lamp glow**: v1's (0,1,1) `.ontile .ot-led` / halo beat
    styles.css `.ontile.off …`. OFF now restates no halo, no highlight, a hollow LED; `.p-drone.off::before` is
    opacity 0 (v1 kept the window at .35 with the drone off, stage critic).
  - No infinite animation (the drone-window breathing is deleted; the window fades in once, .6 s, when the drone
    sounds), no `backdrop-filter`, no `will-change` (build critic: ~20 MB full-viewport layer). One finite
    `nave-fade` (.16 s) on the Quick sheet; `prefers-reduced-motion` turns both off.
  - Assets root-absolute (`/themes/sanctuary/grain.png`); fonts from `/fonts/` (Alegreya, Figtree, and Instrument Sans
    for two code points, below): 0 HTTP ≥ 400 in every run.
  - Registry: `nave` has no `body` shim in `themes.js` or boot.js (themes.test 9/9). Swatch unchanged.
- **One mark.** The `.tb-logo` / `.overlay-card img` `content: url()` overrides and `app/themes/sanctuary/mark.svg`
  are deleted; the wordmark keeps its text in the book face (README rule 8). No CSS copy bridge (`font-size:0` +
  `::after`) existed or exists; `.drone-swell-text::after` is styles.css' own "Bend".
- **Deleted:** the 31 dead start-screen selectors (`.sanct-before*`, `.sanct-breath`, `.sb-*`), the breathing
  keyframes, the Edit-drone breathing. `lancet-{glass,lead,light}.svg` (3.4 KB) stay in the folder, unreferenced by the
  theme, for the deferred start screen; only the old mock `design/warmth/sanctuary/shoot.mjs` names them (and mark.svg).
- **Critics' CSS fixes applied**
  - *Warmth:* a static candle pool behind the title card + the brass glow under the keyboard on the vault; panels lit
    from above (2-stop fill, brass top edge 18 %); Fade out is an ink pane with a brass rim (was the blue-violet slab);
    lamp tiles are lit glass (top highlight, inner rim, same-hue halo); **Pad `#6ed889` → `#5fc98a`** (emerald, ink
    9.3:1); wheel = low-chroma candle cream (stage critic: brass only means "where you are"); MIDI / READY / MASTER /
    PEDAL / BEND back in the bold sans, serif small caps only on section rubrics; the drone window masked to the card's
    top-right corner so no glass shows between the key-grid buttons or across Edit › Drone's Options column.
  - *Stage:* keybed ivory dimmed (`#aea48f → #a39a86`), held `#f5c451` (ΔE ≈ 17, luminance ratio ≈ 1.6; v1 1.02); Keys
    `--slot-0 #f7775f` off the lock amber (ΔE 6.9 → 11.4); Next name 20 px (18 in Classic), chips 18 px (19+ pushed
    chip 6 under Next at 1440).
  - *Build:* guard → `:where()`; literals promoted to tokens (`--line-3`, `--lead`, `--chg-glow`, `--hairline-lit`);
    "Movement" fits at ≤ 1250 px (12.5 px); **the minus**: Figtree's U+2212 is 380/620 units, thin and low, so
    "−1.9 dB" and the Transpose/Swell − read as a hyphen. A second `Sanctuary Sans` @font-face maps U+2212 and U+002B to
    `/fonts/InstrumentSans-var.woff2` (411 wide, centred on the figures), with Figtree's metrics as overrides. It must
    carry the *same* weight range as the Figtree face (300 900): with 400 700 Chromium made it a separate face and never
    loaded it (verified with CDP `CSS.getPlatformFontsForNode`: now "Instrument Sans" 1 glyph + Figtree 6 on
    `.fader-value`).
  - *EQ (Advanced › Tone):* `.eqk *` re-reads `--eqk-c` from the slot panel's `--c` (eq-keyboard.js writes Classic's
    `#ff8a3d` inline, so "Keys", "A · EQ on" and the band rings were Classic orange), `--eqk-ink` = ink-on-lamp, the
    graph/band/side wells on the rig ink, the on/off switch on theme tokens.
  - *Alegreya line box (found by ui-core):* its content area is 1.361 em, so inside Classic's tight line boxes
    (`.chord-name` 1.1, `.nav-next-name` 1.15) it spilled and ui-core's clip probe failed #40 (1280×800: chord 56 > 51,
    Next 25 > 23) and #47 (1366×768). The Alegreya @font-face now has `ascent-override: 88%; descent-override: 24%`
    (baseline at line-height 1.1 moves 0.885 → 0.87 em; ink clipping unchanged). Both tests pass on Nave.
- **Not applied (on purpose):** moving the neutrals to plum hue 290–300 (warmth critic): that *is* sanctuary-v2; Nave
  keeps the ink-navy vault, which is what makes it a separate option. `@layer theme` for all themes (app-wide).
- **Deferred (JS / copy / other files):** (1) "Before the service" start screen — needs its own first-launch-of-the-day
  trigger (Electron autoplays, `#overlay-start` never shows, OPTIONS §3 point 3), day-aware copy, a last-session
  record, and the lancet redrawn as irregular leaded quarries; (2) the 12 voice strings (concept §5: main.js,
  perform.js, edit/lib.js, edit/shell.js, store.js); (3) the EQ canvas (plot curve, grid and key strip are painted in
  Classic slate/orange by eq-keyboard.js); (4) eq-keyboard.css slate literals in unreached states (`.eqk-readout`,
  `.eqk-toast`, `.eqk-pill.over/.none`, `tr.sel`) — left Classic to keep coverage ≤ 2 %; (5) "That's the set" after
  the last Fade out.
- **Coverage** (`test/phase2/themes/run.mjs --only coverage --theme nave`): 276 selectors / 61 unmatched (22.1 %) /
  31 dead → **209 / 2 (1.0 %) / 0 dead**, 0 invalid. The 2 are live classes in states the walk doesn't open:
  `.fx-more`, `.bstrip.open .bstrip-list`.
- **Contrast** (`tools/themes/shoot.mjs --theme nave --out design/warmth/ship/nave/`, 1440×900, 0 console errors /
  404s): perform 185 runs, quick 166, edit 166, edit-tone-eq 158, mini 23, mini-drone-keys 28 — **0 fails**. Lowest
  4.63 PANIC/Esc (unchanged from Classic); next 5.11 (lamp "ON" badge), 5.37 (Edit list numbers), 5.81 (key labels).
  Glare (perform): mean luminance .066, bright share .059.
- **Stage states** (`design/warmth/ship/nave/states.mjs`, pinned like the app, idle / held chord / every lamp OFF /
  Faded / Locked with a chord held; `boxdiff.py` vs a Classic run of the same script):

  | state | 1440×900 runs / fails | 1280×720 runs / fails | Classic (1440 / 1280) |
  |---|---|---|---|
  | idle | 184 / 0 | 158 / 0 | 0 / 0 |
  | held chord | 184 / 0 | 158 / 0 | 0 / 0 |
  | all OFF | 182 / 0 | 157 / 0 | 3 / 3 (wheel badge 4.44) |
  | Faded | 183 / 0 | 157 / 0 | 0 / 0 |
  | Locked + held | 190 / 0 | 164 / 0 | 0 / 0 |

  - Lamps (rendered median fill, text hidden): ON Keys .338, Pad .460, Drone .704; OFF .0111 for all three →
    **ON/OFF ≥ 6.35:1** (Keys), 8.35 (Pad), 12.3 (Drone). OFF has no halo (box-shadow none) and the drone window is
    off (opacity 0) with the drone OFF. Lamps read the same under Lock.
  - Boxes vs Classic at both sizes, every state: `.song-name`, `.chord-name`, every `.perform .slot`,
    `.drone-readout`, `.p-drone`, `.topbar`, `.btn-fade`, `.btn-panic` ≤ **0.1 px**. Text-intrinsic only: `.song-key`
    x −3.8/−4.0 px, `.slot-inst` w −2.8…−5.2, setlist chips narrower (serif; the strip scrolls), `.nav-next-name`
    20 px vs 18 (h 23 vs 20.7, inside the fixed Next button).
  - Sizes ≥ Classic everywhere: title 40 / 38 px, chord 46 idle / 22 held ("Cmaj7", xl bucket), transpose 32, lamp
    names 15 px 800, drone readout 15.
- **Size:** folder 51 KB (theme.css 30 KB, grain 18 KB, lancets 3.4 KB) + /fonts Alegreya 52 + Figtree 19 +
  Instrument Sans 61 = **184 KB** (limit 250; unit test green).
- **Suites** (load 7–12):
  - `node --test test/unit/shared/themes.test.mjs` 9/9.
  - `node test/phase2/themes/run.mjs --theme nave` **11/11** (an earlier run failed "store wins over a stale mirror",
    which pairs sanctuary/sanctuary-day, not nave; green on rerun).
  - `test/phase2/ui-core/run.mjs`, back to back: **Classic 68/69** (#47 "−18" 45 > 41+3 in DejaVu Sans), **Nave 66/69**
    (`RIG_THEME=nave node --import <scratch>/pin-theme.mjs …`, the preload theme-ember used). Nave-only: #4
    (`--muted-fader` expects Classic `#707a88`) and #33 (OFF tile expects Classic `rgb(39,43,50)`) assert Classic
    tokens; #34 times out only because #33 fails with slot 0 still muted (its own click then *un*mutes) — passes
    alone. Nave passes #40 and #47.
- Screenshots: `design/warmth/ship/nave/{perform,quick,edit,edit-tone-eq,mini,mini-drone-keys}.png` + `audit-*.json` +
  `summary.json`; `states-{1440,1280}/state-{idle,held,off,faded,locked}.png` + `check-nave-*.json`.

## themes-critic-3 (Nave + Classic; reviews/themes-critic.md "round 3"; design/warmth/ship/critic/{nave,classic,nc}/)
- **Re-measured** (serial, load < 3):
  - Coverage `nave`: 209 selectors / 3 unmatched (1.4 %) / 0 dead / 0 invalid (`.fx-more`, `.bstrip.open .bstrip-list`,
    `.qs-pedal.on i`: live, state not reached by this walk). `themes --theme nave` 11/11; `themes.test` 9/9.
  - `shoot.mjs` 1440×900, runs / fails / lowest: **nave** perform 185/0, quick 166/0, edit 166/0, eq 158/0, mini 23/0,
    mini-drone-keys 28/0, lowest 4.63 PANIC everywhere, 0 console / HTTP errors. **classic** perform 185/0, quick
    167/**1** (4.14 "ON" under the `.qs` shadow), edit 166/0, eq 158/0, mini 23/**2** (3.49 `.m-num`),
    mini-drone-keys 28/0; all three are the known base-look items (styles.css / mini.css owners; review C1).
  - Box diff Nave vs Classic (fresh boot, 1280×800, 11 elements): dy/dh ≤ 0.1 px everywhere; text-intrinsic only
    (`.slot-inst` dx +2.6 dw −5.2, `.setlist-chip` dw −16.7).
  - Option fidelity: Nave matches `design/warmth/sanctuary/perform.png` plus the critics' fixes; shared mark in every
    shot; no rule outside the `:where(html[data-theme="nave"])` block, no `content: url()`, no `backdrop-filter`, no
    infinite animation, no OS `prefers-color-scheme`. Both ids boot dark on a light-OS context (`nc/lightos.mjs`).
- **Fix N1 (`app/themes/sanctuary/theme.css`, fonts only):** families `Sanctuary Book/Sans` → `Nave Book/Sans`, and
  the Instrument Sans minus/plus face now precedes the Figtree face, which gets the complementary unicode-range. Why:
  `warmThemeFonts` (main.js, T1) copies faces without `unicode-range`, the last copy wins, and copies are never removed
  (T2), so a runtime switch into Nave set the whole sans in Instrument Sans — in Nave and, via the shared names, in
  Sanctuary afterwards (CDP: `.slot-inst` "Instrument Sans:11", +7 px). After: Sanctuary steps clean except its own T1;
  Nave keeps Figtree after a switch (minus falls back to Figtree's until relaunch). Fresh boot unchanged: fader value
  Instrument Sans 1 + Figtree 6 glyphs, mini shots pixel-identical, 0 contrast fails. Two lines wrapped to ≤ 120.
- **Residue** (`nc/residue-nc.mjs`, chain classic → nave → sanctuary → nave → classic → nave → sanctuary → classic):
  Classic 0 diffs at every step; Nave only T1 (`.chord-name` 56/51, `.song-name` 49/48 vs fresh 51/51, 48/48) and the
  Figtree minus. Both need T1's main.js fix (copy `unicodeRange` + overrides).
- Registry unchanged (no id or path renamed); swatch matches the tokens (`#0a0c1e` / `#f5ecd8`).

## themes-final (default flip; reviews/themes-critic.md T1/T2/T5/N1/E1; hardware-fixes 2b; popover; app/js/shared/themes.js, app/themes/boot.js, views/components/themeFonts.js (new), main.js, views/mini.js, mini.css, styles.css, ember + studio theme.css, themes + ui-core tests, edit-v2 harness.html)
- **Default → Sanctuary** (Ryan's decision): `DEFAULT_THEME_ID = 'sanctuary'` (shared/themes.js) and boot.js
  `DEF = 'sanctuary'`; `themes.test.mjs` asserts it; the TEMP comments are gone. A library without `settings.theme`
  (and a blocked / empty / unknown mirror) boots into Sanctuary. Base-look pins verified, none added:
  `pinTheme(context, 'classic')` is in ui-core, edit-v2 (harness, integration, integration-widths), settings and eq
  (and mini's pixel test). themes suite, first test (a new context: no mirror, no library): Sanctuary's sheet is in
  the document while `readyState=loading`, before `<body>`, `blocking=render`, linked once, loaded before first paint,
  html/body attributes set at DOMContentLoaded (the per-theme boot checks, now a shared `assertBootLinked`).
- **T1 + T2 (runtime switch fonts).** `warmThemeFonts` moved to `views/components/themeFonts.js`, shared by main.js
  `applyTheme` and mini.js `createThemeFollower` (the popover had the same copy):
  - `warmThemeFonts(sheet, doc)` copies every descriptor the `@font-face` rule has (`FONT_FACE_DESCRIPTORS`: weight,
    style, stretch, unicode-range, feature-/variation-settings, display, ascent-/descent-/line-gap-override,
    size-adjust) and returns the faces. No more `family|url` dedupe set: each switch warms its own copies.
  - `releaseWarmedFonts(faces, doc)`, awaited after the one-task enable (so `theme.pending` resolves after it): waits
    until the enabled sheet's own faces show up in `document.fonts` (Chromium lists a just-enabled sheet's faces only
    from the next task, not after a forced style/layout: measured), `load()`s them (memory cache), then deletes the
    copies. The copies (now metric-exact) keep rendering until then, so there is still no fallback/blank frame. An
    overtaken or failed switch deletes its copies too.
  - Measured (1280×800, chain sanctuary → nave → daylight-day → classic → sanctuary → ember → sanctuary):
    `.chord-name` 51/51 at every step (critic: 56/51 Sanctuary, 53/51 Daylight, 56/51 Nave); every `delete` happened
    with the CSS face of the same family already `loaded`; `document.fonts` after a switch back to Sanctuary equals a
    fresh boot (3 faces, `Sanctuary Chord` 88.55 %). Nave's ranged minus face keeps its `unicode-range`, so N1's
    remainder (Figtree minus until relaunch) is gone too.
  - themes suite, every `switch → <id>` (all 8): after the switch settles, `.chord-name` scrollHeight ≤ clientHeight
    and no two `document.fonts` entries share family + all descriptors.
- **E1 (chord half) + Studio.** That assertion also caught two fresh-boot overflows, not T1: Ember 56/51 (Nunito
  Sans, ascent + descent 1.364 em in the 1.1 line box) and Studio 52/51 (Rubik, 1.185 em). New chord-only faces on
  the same files (no second download), as Sanctuary's: `'Ember Chord'` ascent 88 % / descent 22 %, `'Studio Chord'`
  89 % / 21 % (sum 1.1 em; baselines within 0.1 px of before: .879 → .88 em, .8925 → .89 em; the ink, b/d .744 and
  .786, g/y −.193 and −.22 em, stays inside). Both themes now 51/51. Ember's `.song-name` 50/48 (title half of E1)
  is left (BACKLOG A).
- **T5** was already fixed by theme-classic (`b` = the first css theme on a different file); verified: themes suite
  28/28, "store wins over a stale mirror" green with the Sanctuary default.
- **hardware-fixes 2b ("DejaVu Sans 1366×768 −18: value 45 > 41 + 3").** Measured, Classic pinned, room = space
  between the ± buttons, old CSS (4 px row gap):

  | viewport | value box | room | "−18" DejaVu Sans Bold @20 | Liberation @20 | SFsim / SFstress @20 | app font |
  |---|---|---|---|---|---|---|
  | 1366×768 | 40.8 | 48.8 | 44.6 | 33.9 | 36.0 / 37.0 | 33.9 |
  | 1440×900 | 38.0 | 46.0 | 44.6 | 33.9 | 36.0 / 37.0 | 33.9 |
  | 1280×720 | 46.0 | 54.0 | 44.6 | 33.9 | 36.0 / 37.0 | 33.9 |
  | 1024×700 (@17) | 32.0 | 40.0 | 37.9 | 28.8 | 31.0 / 33.0 | 28.8 |

  - Root cause: not the size step and not a real clip. The value is centred between the buttons either way; the row's
    4 px gaps only made its *box* 8 px narrower than the room, so the test compared the text with a box it never
    needed to fit. DejaVu's minus is 0.84 em (digits 0.70), wider than SF's, so "−18" is a worst case: 44.6 px. The
    tightest room is **1440×900**, not 1366 (side padding `clamp(…, 14px)` grows faster than the column); the
    old test stopped at its first viewport.
  - Fix (styles.css): `.transpose-row { gap: 0 }`. Nothing moves on screen (same centring); the value box is now the
    room (49 / 46 / 54 / 40 px). Every theme measured at all four sizes (app fonts): "−18" 25–41 px, "+5"
    23–34 px, all inside the box with no spill. Theme `.transpose-val` sizes (Sanctuary / Nave 32 px) never win over
    the `[data-len]` steps (0,2,0 vs 0,1,0), so hardware-fixes' "theme owner should add a data-len size" is moot.
  - Test (ui-core 2b): values 0 / +5 / −18 / **+17**, DejaVu Sans + Liberation Sans, 4 viewports; the value's
    scrollWidth ≤ clientWidth + 1 (rounding only; no gap to hide a spill in any more) and the text box never reaches
    a button (logged clearance: DejaVu "−18" at 1440×900 0.7 px each side, "+5" 2.3 px; SFsim / SFstress, from the
    table above, ≥ 3.5 px).
- **Popover.** Status line verified end to end (real app + real mini.html on the bus, drone off, `audioSleepSec` 2,
  low-resource on): "Audio asleep · 42 ms · No MIDI keyboard" with an ok LED 5.5 s later; leaving low-resource →
  "Sound OK …" (plus the existing mini-suite asleep test). Daylight v2 sets the `--accent-text` hook, so mini.css
  now reads `var(--accent-text, var(--m-accent))`: the interim `--dl-accent-text` fallback is gone (README updated).
- **edit-v2 harness** (`harness.html`): wires `controller.onActivity` / `'notes'` → `wakeMeters()` as main.js does.
  Since idle-cpu-ui's shared meter clock, a silent meter sleeps until woken, and the harness has no main.js, so
  `slot: polish-1 — a level meter beside the fader follows the slot` timed out deterministically (15 s,
  `slot.test.mjs:491`); it passes now.
- **Runs** (this box, 2 CPUs, serial, load 0.2–3). `node test/run-all.mjs --fast`, final run:

  | suite | result | time | detail |
  |---|---|---|---|
  | unit | PASS | 10.1 s | 286 pass, 0 fail |
  | engine | PASS | 5m19s | 79/79, 0 soft warnings, 0 console errors |
  | instruments | PASS | 33.9 s | 143/143 |
  | synth-extra | PASS | 1m01s | 153/153 |
  | shell | PASS | 23.9 s | 212 pass (unit + browser; electron skipped by --fast) |
  | ui-core | PASS | 3m47s | 69 pass, 0 fail (2b green) |
  | edit-v2 | PASS | 3m56s | 98 pass, 11/11 files |
  | settings | PASS | 37.7 s | 37/37 |
  | eq | PASS | 29.6 s | 28/28 |
  | mini | PASS | 29.4 s | 14/14 + mini-theme 14/14 |
  | themes | PASS | 2m45s | 28/28 (all 8 ids) |
  | chrome-fallback | PASS | 11.5 s | 17/17 |

  12/12, 19m44s. The first run of the day was 11/12 (edit-v2 slot meter test, fixed above). `xvfb-run node
  test/phase1/shell/run.mjs --only electron`: PASS, 14 pass, 1 skipped (L-14 menu-bar hooks: LOCAL's).

## sustain (Ryan: pedal-held Grand Piano notes fade too early; engine sampler.js + audio.js + voice.js + instruments.js, shared/params.js 2 rows, store.js, manifest.json, views/edit/panels/slot.{js,css} + lib.js, tests, docs)
- **Root cause (confirmed).** `processSample` capped every sample at 16 s (MIDI ≤ 60) / 10 s (above) with a 1 s fade,
  so a pedal-held low note died at the cap. The bundled files themselves are ≤ 20 s: `tools/samples/download-
  salamander.mjs` and `download-vsco-upright.mjs` cut at `-t 20` (tail below −60 dBFS trimmed after 8 s, 0.5 s fade).
  The 20–30 s the originals ring is therefore not in the app; a longer engine cap gets the full 20 s, no more.
  Measured by decoding every file (ffmpeg, same onset trim as processSample), length after the onset trim per
  octave, and in brackets the last sample above −60 dBFS; "cut" = files the old cap truncated:

  | octave | Salamander (90 files) | cut | VSCO upright (69 files) | cut |
  |---|---|---|---|---|
  | 0 (A0–B0) | 20.0 s (19.8) | 3/3 | 14.2–20.0 s (19.8) | 2/3 |
  | 1 | 18.9–20.0 s (19.9) | 12/12 | 9.2–20.0 s (19.8) | 4/9 |
  | 2 | 15.7–20.0 s (19.8) | 9/12 | 14.4–20.0 s (19.9) | 6/9 |
  | 3 | 14.4–15.4 s (15.0) | 0/12 | 8.6–17.1 s (16.9) | 2/9 |
  | 4 (C4 = 60 has the 16 s cap) | 8.7–15.5 s (15.0) | 7/12 | 8.4–16.9 s (16.2) | 4/9 |
  | 5 | 6.9–10.9 s (10.5) | 2/12 | 7.3–14.1 s (13.7) | 4/9 |
  | 6 | 5.4–6.8 s | 0/12 | 4.9–12.7 s (10.8) | 2/9 |
  | 7–8 | 2.8–4.8 s | 0/15 | 1.4–5.4 s | 0/12 |

  The 21 Musyng Kite sets are all ≤ 3.1 s: no cap ever touched them.
- **Decoded MB** (channels × frames × 4; every file of the set):

  | cap | Salamander 44.1 kHz | 48 kHz | upright 44.1 kHz | 48 kHz |
  |---|---|---|---|---|
  | 10 / 16 s (before) | 332.9 | 362.4 | 235.9 | 256.8 |
  | 20 s | 370.0 | 402.8 | 256.7 | 279.4 |
  | 30 s (now: `maxSec` 30) | 370.0 | 402.8 | 256.7 | 279.4 |
  | uncapped | 370.0 | 402.8 | 256.7 | 279.4 |

  Salamander +37.1 MB (+11 %), upright +20.8 MB (+9 %) at 44.1 kHz. 44.1 kHz matches the l8 soak's 332.9 MB.
- **Pinned MB, measured in the real engine** (Chromium OfflineAudioContext, real manifest, factory songs):
  - *Sunday Pad + Piano* (Salamander + warm-pad synth): 332.9 → **370.0 MB** at 44.1 kHz, 362.4 → **402.8 MB** at
    48 kHz. Same for Grand Piano / Felt / Dusty / Anthem. Upright Pad 235.9 → 256.7 (256.8 → 279.4).
  - No song alone comes near the 600 MB budget. Windows do: all-long pricing would push gospel-stab-b3's library
    window (Anthem + Upright neighbours) to 627 MB and drop a neighbour. So, as asked, **neighbour-preload copies stay
    at the old cap and only the current song's instruments use the long cap** (below). With that, gospel-stab's
    window stays 568.9 MB (both neighbours pinned, as before), Upright Pad current + Anthem 589.6 MB.
  - One window still changes: Anthem current in large-set mode (radius 2) = Salamander long 370.0 + Upright legacy
    235.9 = 606 MB > 600, so upright-pad (2 away) is left out of the pins and warmed unpinned (l8). Before: 569 MB,
    pinned. At 48 kHz that window was already over (619 MB) before this change.
- **Engine API (sampler.js).**
  - Manifest field **`maxSec`** per instrument (s, clamped to `MAX_SEC_RANGE` [1, 60]; null/false = the legacy rule).
    Absent: factory `piano` / `ep` / `keys` categories get `KEYS_MAX_SEC` = 30, everything else and every My Samples
    entry the legacy 10 / 16 s. `manifest.json` sets `"maxSec": 30` on salamander-piano and upright-piano. The def
    carries `maxSec` and `decodeOpts.maxSec`. New export `legacyCapSec(midi)`.
  - `processSample(buf, midi, {maxSec})`: the cap is `maxSec` when given. The 1 s fade-out still runs only when the
    sample is truncated (unchanged). The buffer gets `_natural` (frames after the onset trim) and `_capped`.
  - **`BufferCache` variants**: entries, `inflight`, `pinned` and `sizes` are keyed by **cache key**
    (`keyOf(url, midi, maxSec)`: the URL for the legacy cap, `<url>#max=<s>` for a long one). Once a URL is decoded,
    `meta` holds its natural length, and a long key whose buffer would equal the legacy one collapses to the URL. So
    only the 33 + 24 truncated samples are ever held twice. `estimateBytes(keys)` is exact for any variant of a
    decoded URL, without decoding it. New: `has(key)`, `drop(key, owner)`, export `urlOfKey`. `failed` stays per URL,
    and `invalidate(urls)` drops every variant.
  - `SamplerInstrument`: a sample whose long variant isn't decoded but whose legacy copy is (a neighbour preload)
    starts on that copy, so the switch is as quick as before (measured 9 ms prepare + commit for Sunday). Then
    `inst.upgraded` (a Promise) decodes the long variants one at a time and swaps them in. Notes already playing keep
    their buffer. `inst.upgrades` = how many were swapped: 33 for Salamander, 3.2 s on this box. The legacy copies stay
    decoded but unpinned and unreferenced until the LRU needs the room (+159.6 MB decoded at 44.1 kHz, never pinned).
  - `AudioEngine._sampleJobs` (preload, `estimatePreloadMB`, pins, low-resource `_pinCurrentOnly`): an instrument the
    committed song uses is keyed at its long cap, and every other one at the legacy cap. `preload` recomputes its pin
    keys after decoding (collapsed keys). The controller needs no change: the l8 planner prices exactly what gets
    pinned.
- **Params** (`shared/params.js`, two rows; the store, controller and UI pick them up from the table):
  - `slots.<i>.release`: 0.05–8 s, log, **default null** = the instrument's own release; new row flag `optional`.
    It is the time to −60 dB after the key lifts (pedal up), for samplers, synths and organ alike.
  - `slots.<i>.pedalHold`: **'natural'** (default) or 2–30 s, log; new row flag `words: ['natural']`.
  - `params.clamp` passes a row's `words` through, and an optional row's null / NaN gives its null default.
    `formatValue`: 'Natural', 'Default'.
  - Store (`strictParam`): the words pass, a string otherwise is refused, and null / undefined on an optional row
    removes the field. `normalizeSlot` clamps a present value and drops a null one. SCHEMA stays 1, no migration
    step; absent = today's sound. The controller's table diff sends the default when a field is removed (null /
    'natural').
  - Not MIDI-learnable: `LEARNABLE` is a fixed list (slot gains and actions), so learn isn't free for any slot row.
- **Engine behaviour** (`audio.js`; `{when}` everywhere, AudioTimer only):
  - `_release(sc, inst, voice, t)` is every poly and mono note-off path (key up, pedal up, mono last-note).
    `cfg.release`, when set, goes on `voice.releaseOverride` just before `inst.noteOff`.
  - `BasicVoice.releaseAt` (sampler + fallback synth) uses the override instead of `release`. `voice.js
    Voice.releaseAt` runs the instrument's `onRelease` hook with `env.release` forced to the override, so hook side
    effects (bloom freeze, filter settle) stay. A voice without an envelope fades `out` instead. Undamped piano notes
    (≥ 90) still ignore note-off.
  - `_pedalHold(e, t)`: a key lifted under the pedal joins `pedaled`. With a numeric `pedalHold`, an AudioTimer at
    key-up + hold fades the voice (`fadeOut`, −60 dB over 25 % of the hold) and takes it out of `pedaled`. The count
    starts when the pedal takes the note over. Mono slots do the same for their held note. Timers are cancelled on
    pedal up, re-strike, panic, fade-out-all and channel disposal (`_unpedal` / `_unpedalAll`). 'natural' = unchanged
    (samples ring to their end, synths until the pedal lifts).
- **UI** (Edit › slot › Advanced; no new screens or modes):
  - The EQ keyboard sits straight in Advanced (Ryan 2026-09-30). The 'Tone' `lib.section` is gone and replaced by a
    plain `div.ev2-slot-tone[data-sec="slot<i>-tone"]`: heading "Tone", the eqSummary, the hint and
    `.ev2-slot-tone-host`. `syncTone` mounts the editor while Advanced is open and destroys it on close, rebuild and
    unmount. The title-bar mini curve opens Advanced and scrolls to it. `lib.forgetSections(ids)` (new export) drops
    stored `slot<i>-tone` flags from `worship-rig.edit2.sections` at mount; other flags stay.
  - Below the EQ is the **Sustain** row (`div.ev2-slot-sustain[data-sec="slot<i>-sustain"]`). It has two
    `wordSlider`s:
    - "Release (pedal up)": shows the instrument's own release while absent (a sampler's τ × 6.9). Double-click
      removes the field.
    - "Pedal hold": the top of the track = Natural (the field is removed); otherwise whole or half seconds.
  - One sentence under the sliders: "Rings 0.8 s after you lift the pedal (the instrument’s own). With the pedal down
    it rings to its natural end." (synth/organ: "keeps sounding until you lift it"; numeric: "fades after 9.0 s (over
    2.3 s)").
  - The Advanced summary adds "Release …" / "Pedal hold …" only when set. Screenshot:
    `test/phase2/edit-v2/screenshots/slot-sustain.png`.
  - Overlap to know: THE SOUND ITSELF's "Ring-out" slider is the instrument's own `params.release`. While
    `slots.<i>.release` is set it replaces that at key-up; Release (pedal up) displays Ring-out's value until then.
- **Tests.**
  - Engine `offline.sustainLongCap`: real Salamander v9 A1 (a 20.0 s file), vel 127, CC64 at 0.5 s, key up at 1 s.
    The buffer is 20.0 s (`_capped` false) against 16 s before. At 18 s it is **−40.6 dBFS** (stereo RMS); the legacy
    cap is −∞ over 16.5–17.5 s; 14 s is identical (−42.1). The assertion is > −50 dBFS: the brief's "> −40" misses
    by 0.6 dB at this sample's real level (the loudest low sample at 18 s; the others are −50 to −60 dBFS in the
    file). The suite also checks the variants: neighbour preload at legacy keys; the current song starts on the
    16 s copy and upgrades to 20 s (1 upgrade), and drops its legacy reference; C7 collapses to its URL; the long-key
    estimate is exact.
  - Engine `offline.sustainRelease` (decay to −60 dB after key-up): Church Organ (voice.js) own 1.51 s, release 0.3
    → 0.30 s, 4 → 3.94 s, reset to null → 1.51 s. Fallback warm-pad (BasicVoice) own 3.03 s, 0.3 → 0.31 s, 1 →
    1.01 s.
  - Engine `offline.sustainPedalHold` (warm-pad, key up at 0.5 s under the pedal): natural −20.0 dB at 5 s; hold 4 s
    −49.2 dB at 5 s (≥ 12 dB down), −96.5 at 5.8 s, the same at 3 s (−17.7); a mono slot −49.2 at 5 s.
  - Shell (`shell3.test.mjs`, +2): store validation (clamps, words, refusals, null / undefined removal, normalize of
    junk, reload); the controller sends both rows and the table default on removal.
  - Unit `params.test.mjs`: table well-formedness allows an optional null / words default, the grammar list has both
    rows, and +1 test.
  - edit-v2 `slot.test.mjs`: the Advanced test now checks the EQ mounts on Advanced alone (destroyed on close, one
    new editor on reopen, no `details[data-sec="slot0-tone"]`), plus a new Sustain test (below the EQ, two sliders,
    sentence, store → engine both ways, removal, synth wording, section-flag migration).
  - `integration.test.mjs` and `integration-widths.test.mjs` open Advanced only. The themes walk (`walkStates`
    'edit-tone-eq', name kept for the coverage files) and `tools/themes/shoot.mjs` also open Advanced only (not run
    here). The eq suite never opened 'Tone' (fixture page), so it is unchanged.
- **Runs** (2 CPUs, serial):

  | run | result |
  |---|---|
  | `node test/phase1/engine/run.mjs` | 82/82 |
  | `node test/phase1/shell/run.mjs --only unit` | 201/201 |
  | `node test/phase2/edit-v2/run.mjs --only slot` | 15/15 |
  | `node test/phase2/edit-v2/run.mjs --only integration` | 13/13 + widths 5/5 |
  | `test/unit/shared/*.test.mjs` | all pass (params 26/26) |
- **Not done / follow-ups.**
  - The tails past 20 s need new files: re-run the two download scripts with `-t 30`. That grows the bundle, by an
    estimated ≈ 5–8 MB at 160 kbps (not measured). The engine side is already there: `maxSec` 30.
  - Mac check: the Mac context rate decides the 44.1 vs 48 kHz rows. The Mac soak's `budgetMB` column should show
    the Anthem large-set window without upright-pad.
- (added 2026-09-30 from local 7071b23) Electron main sends rig menu ids `popoverShown` / `popoverHidden` on popover
  show/hide, so `status.popoverOpen` works (lowres2-scope R2: a merely-open popover must not thaw the frozen drone).

## sustain-critic (reviews/sustain-critic.md; engine sampler.js, engine suites.mjs)
- **Checked against the pre-sustain snapshot** (same server and scripts, real app, 44.1 kHz): Sunday Pad + Piano
  pinned 332.9 → 370.0 MB, decoded 417.1 → 454.3; Grand Piano window 417.1 → 454.3 pinned; gospel-stab-b3 568.9
  both; Anthem large-set 568.9 → 370.0 (upright-pad warmed unpinned); Upright Pad 421.2 → 442.0 (not 589.6: Anthem
  is never in its window). 10-song switch loop, both modes: pinned ≤ 568.9 in every 50 ms sample, settled decoded
  ≤ 678.5, peak during a switch 754 → 812 MB (reviews R1; L-10's "while retiring" wording doesn't match: the peaks
  have `retiring === 0` before and after). Pedalled low chord: −49.0 dBFS at 18 s, silent at 21 s; no click at the
  sample ends (≤ 3.1 dB over the neighbourhood at −93 dBFS). Identity: 19 factory songs, fields absent or explicit
  defaults, ≤ 6.8e-6 (16 songs) or inside the song's own pre-vs-pre floor (3 lofi/chorus songs, ≤ 5.4e-5).
- **`limitMonoLoss(L, R, capDb, {statsLen, fadeLen})`** (new optional arg): `processSample` measures the mid/side
  factors on what the legacy 10 / 16 s cap keeps (its 1 s fade weighed in when the buffer is longer), so a long
  variant is the legacy buffer plus a tail. The whole-buffer stats moved every current-song Salamander note by up
  to 3.4e-5 (−89 dB) from its first sample. Legacy variants: unchanged bit for bit.
- **`SamplerInstrument._upgrade`**: an instrument disposed while a long-variant decode was in flight now releases the
  reference `acquire()` added after `dispose()` (one unevictable buffer, 4–8 MB, per switch-away during an upgrade).
- **Test** `offline.sustainVariants`: the 11 truncated Salamander v9 samples are identical up to the legacy fade
  (max |diff| 0), and a dispose during the upgrade leaves 0 references (1 without the fix).
- **Runs** (serial): engine 83/83; shell unit 201/201; unit shared 226/226; edit-v2 11/11 files (99 tests, slot
  15/15, integration 13/13, widths 5/5); eq 28/28; themes `--only coverage --theme ember` 2/2 (walks
  `edit-tone-eq`); `tools/themes/shoot.mjs --theme classic --only edit,eq` writes the EQ shot, 0 errors.

## mac-findings (Mac run of the cloud's green tree, 2026-09-30: macOS 26, SF Pro, 120 Hz, real Electron; six failures Linux did not show + the Sanctuary paint cost; styles.css, views/mini.js, views/components/{quickSheet,eq-keyboard}.js + eq-keyboard.css, themes sanctuary-v2 + sanctuary theme.css, tools/idle-cpu.mjs, ui-core / edit-v2 integration / eq / mini / themes tests)
None of this could run on macOS here. Each item was reproduced with an SF stand-in (an `@font-face` over
`local("FreeSans")` / `local("FreeSans Bold")`, `size-adjust` 105 % and 112 %, SF's ascent .95 / descent .24 divided
by the size-adjust) or by reading the code against the platform difference. Calibration: at 1024 × 700 the Mac
measured "Minor" 55 and "Movement" 61 px; the stand-in gives 56 / 59 px at 105 % and 59 / 63 px at 112 %, so SF Pro
Text sits between 105 % and ~109 % of FreeSans at these sizes.
- **Stand-in caveat found on the way.** `chromium-headless-shell` on Linux (the eq, mini and themes suites' default
  launch) hints `local()` web fonts to whole-pixel advances, so the stand-in is not linear there: "≈Db6 −50¢ · 1.08 kHz"
  measured 138 px at every size-adjust from 100 to 106 % and 142 px from 108 to 114 % (true 112 %: 143.9 px). Full
  Chromium (`channel: 'chromium'`, ui-core) is linear. The eq suite now launches with `--font-render-hinting=none`
  (system faces keep their advances; no effect on macOS).
- **L-26 (ui-core "polish-2A responsive" at 1024 × 700: `button.seg "Minor" 55 > 53`, `label.fader-label "Movement"
  61 > 54`).** Cause: the drone faders are `compact`, and `.fader.compact .fader-value { font-size: 14px }` (0,3,0)
  outranked `.drone-char .fader-value` (0,2,0), so the value rendered at 14 px, not the mockup's 12 px (10.5 px at
  1024; design/H-v2/perform.html `.drone .char small`), and squeezed the label; Major/Minor sat in a shrinkable
  `.segmented` beside a level fader whose value ("+1.6 dB") was wider than its 6ch min. Fix (layout, no copy):
  `.drone-char .fader.compact .fader-value` restores 12 / 10.5 px; `.drone-row .segmented` and `.drone-level
  .fader-value` are `flex: none` (the track gives way); at ≤ 1250 the head's Synth/My Pads pad 6 px and the ON tile 5 /
  7 px so "DRONE C major ON" stays whole, the Next column is 212 px, the wheel strip pads 4 px, and the drone toggles
  pad 6 px so "Follow chords" / "Continue across songs" stay one line (they wrapped from ~108 %). Verified: all eight
  windows clean at 100 % and 105 %; 1024 × 700 clean at 109 % and 112 %; the new stand-in pass in the test (FreeSans
  only; the Mac runs its real SF in the main loop) asserts that plus one-line toggles and ≥ 140 px throw.
  Residual: at 1280 × 800 / 1280 × 720 with ≥ 109 % the "Dotted 8th / worship echo" chip (80 > 78) and "Building
  Swell · C" in Next (165 > 163) still clip; the Mac's own run passed those windows in real SF, so SF is below that.
- **Bluetooth hint (ui-core "hardware-fixes: Quick shows…" at 1280 × 720: "the whole line shows").** Cause: 518 px of
  text (SF ≈ 105 %) no longer fit beside "Under Lock: …" (flex: none) and ellipsized; the title, All settings and ×
  also shrank (× 44 → 41 px at 112 %). Fix: in the Quick header the hint wraps to ≤ 2 lines (`-webkit-line-clamp: 2`,
  line-height 1.2, `text-wrap: balance`; 2 × 15 px inside the 44 px header), and h2 / All settings / × are
  `flex: none`. In Liberation Sans it is one line at every window, as before. Test: text box measured (scrollWidth
  and scrollHeight vs client) at 1440 / 1366 / 1280 / 1024 under SFsim 105 / 112 % (FreeSans only): whole, ≤ 2 lines
  (2 at 1280, 1 elsewhere), header not overflowing, × keeps 44 px (36 at ≤ 1250).
- **L-27 (edit-v2 integration "round4-edit-lib M1": expected `['historyUndo']`, got `[]`).** Cause: the test pressed
  `Control+z`, which is no editing command on macOS; the app was never asked to undo. Fix (test only; the app's M1
  guard in panels/song.js is unchanged): `ControlOrMeta+z` (Meta on macOS; Playwright then sends Chromium's `undo`
  editing command, macEditingCommands, i.e. the frame-level undo Electron's Edit ▸ Undo runs), and if no
  `historyUndo` arrives within 300 ms, `document.execCommand('undo')` (the same frame-level command). The invariant is
  asserted in full: the event reached the hidden field, the field still shows the shown song's notes, A keeps its
  notes, B is unchanged. Verified here both ways: the key path, and the fallback forced (the key press removed):
  2/2 each.
- **L-21b (eq "1124 @112 %: every cell's text fits" over Helvetica Neue).** Cause: the 112 % margin was calibrated on
  FreeSans (Helvetica widths); on the Mac the stand-in fell back to Helvetica Neue, itself 1.01–1.07 × FreeSans by the
  Mac's own pass/fail (105 % passed, 112 % failed at 145 px of room), so it measured a face ~15 % wider than FreeSans,
  not SF. It also scaled a Regular face for a weight-600 label (synthetic bold keeps regular advances, ~3 % narrower
  than Bold). Fix: the cases are now `system` (no stand-in: on the Mac that is SF Pro itself, the real requirement),
  105 % everywhere, and 112 % only over FreeSans, with FreeSans Bold for 600+; and the full note column is 172 → 180 px
  (154 px of room; "≈Db6 −50¢ · 1.08 kHz" is 132.6 / 139.1 / 148.4 / 153.8 px at 100 / 105 / 112 / 116 % Bold). The
  8 px come from "Acts on", which ellipsizes anyway (≥ 122 px at the 1080 px compact threshold; `COMPACT_BELOW_PX`
  unchanged); the compact layout (1100 px, note 100 px, worst 70.2 / 80 at 112 %) does not change. Residual: real SF
  Semibold's advance widths are not known here; the `system` case is what proves it on the Mac.
- **L-28 (mini "master: relative drag…", recurring on the Mac only).** Cause (reproduced): mini.js ignored
  `state.master` for 400 ms after its own last send (`MASTER_ECHO_MS`), and the app publishes state only on change.
  A real change in the app inside that window (the test's reset right after the drag: on the fast Mac it always landed
  inside) was dropped for good, and the popover showed a stale master; the next drag then started from it (a Mac-speed
  loop here: 6 of 8 drags ended at 2.0 instead of 1.534). A second, test-side race: at 120 Hz the moves come faster than
  the 50 ms send throttle, so "> before + 0.05" could be met by an intermediate batch. Fix: the echo guard is by value,
  not time — every state's master is kept; while our newest sent value is outstanding, an older value of ours coming
  back is an echo (thumb stays), our newest means in sync, anything else is an app change and wins; synced on
  pointerup too. The press engages only after 3 px of travel (a trackpad tap-to-click that wobbles is still a tap), and
  once engaged the whole travel from the press point counts (a 50 px drag is exactly 50 px). No timers in the gesture;
  the 50 ms send throttle stays and always flushes on pointerup. Test: waits for the value the mini sent last, a 2 px
  wobble tap sends nothing, and two quick app-side changes right after the drag must both reach the popover within
  3 s. The Mac-speed loop: 0 of 8 wrong after the fix. Residual: if the app silently rejected our last value (no song)
  and never published again, the thumb keeps our value until the next state.
- **L-29 (themes "switch → classic: .chord-name scrollHeight 52 > clientHeight 51").** Cause (reproduced with SF's
  metric overrides on a fresh boot too: 52/51; 54/51 with a deeper 1.00/.26 face): Classic's chord uses the system
  face, and SF Pro Display's content area (1.19 em) is taller than the 1.1 em line box, so its descent reached ~.045 em
  below the clip; the runtime switch only happens to be where the suite looks. The web-font themes already pin their
  chord faces to 1.1 em. Fix: `.chord-name { padding-bottom: calc(.05em + 1px); margin-bottom: calc(-.05em - 1px) }`
  — the clip box reaches lower, the negative margin gives the space back, so the text and the boxes around it stay
  put. Verified: 54/54 in Liberation, SF (.95/.24) and the 1.00/.26 stress face at 1440 and 1024 (and the 30 / 26 px
  steps); the header is pixel-identical on Linux in every theme but for ≤ 15 px of compositing noise at a card edge.
- **Sanctuary paint cost (Mac 05:32Z: renderer 45–47 % under Sanctuary vs 38.9 % under Classic, GPU +2; drone on,
  window visible).** Cause (LayerTree dump): Sanctuary's and Nave's vault is a full-viewport `body::after` with
  `position: fixed`. The document is a scroll container (`overflow: hidden`), so Chromium composites fixed elements
  (as it does #toasts), and at z-index −1 that put everything painted over it on overlap layers: 15 layers drawing
  content (Classic: 7), four of them 1440 × 900 (the vault, html, .perform, .p-main) plus .song-name, .transpose,
  .chord-readout, the setlist item, a strip, …, all updated and drawn with every meter frame. Second, in every theme a
  meter frame repainted the root layer (the fill's transform was not composited: per frame style → paint → layerize →
  raster of the bar's rect, re-rastering whatever the theme paints under it: gradients, halos, the vault). Fix: the
  vault is `position: absolute` (the initial containing block is the viewport and nothing scrolls: same picture), and
  `.meter-fill, .meter-hold-track, .lvl-cover { will-change: transform }` (72 × 7 and 4 × 225 px layers; a meter frame
  is now a compositor transform: no Paint events, no raster tasks in a 3 s trace). A theme can no longer change what a
  meter frame costs. Test: themes `layers` group (no composited layer ≥ 25 % of the viewport but the document, ≤ Classic
  + 4 layers, meter parts keep will-change; fails on the old fixed vault).
  - `tools/idle-cpu.mjs`: `--theme <id>`, `--themes a,b,… [--rounds N]` (config A per theme, runtime switch,
    interleaved), `--channel chromium`, `--headed`, `--chrome-args "…"`, `--inject-css "…"` (the "before" rows below are
    the tree with the two changes reverted by injection).
  - Measured (xvfb, 1440 × 900, Sunday Pad + Piano, drone on, 2 interleaved rounds of 12 s; % of one core; UI = renderer
    main + compositor + pool threads, i.e. without the theme-independent audio and reverb threads):

    | theme | sw before: renderer / UI / gpu | sw after | GPU raster before: renderer / gpu / frames/s | GPU raster after |
    |---|---|---|---|---|
    | classic | 23.0 / 6.8 / 1.9 | 23.2 / 6.5 / 2.2 | 21.5 / 138.4 / 23.9 | 21.5 / 139.2 / 23.1 |
    | sanctuary | 23.2 / 7.6 / 2.1 | 23.4 / 6.9 / 2.2 | 20.0 / 153.8 / 13.1 | 21.6 / 141.1 / 23.1 |
    | daylight-stage | 23.4 / 6.8 / 2.0 | 23.8 / 6.8 / 2.2 | 17.5 / 155.2 / 5.7 | 21.3 / 136.2 / 25.6 |
    | studio | 24.9 / 7.8 / 2.0 | 23.2 / 6.8 / 2.2 | 17.5 / 157.6 / 3.9 | 20.6 / 137.6 / 25.6 |
    | ember | 23.7 / 7.3 / 1.9 | 23.0 / 6.6 / 2.2 | 17.1 / 159.3 / 4.8 | 20.9 / 137.3 / 25.7 |
    | nave | 25.3 / 8.4 / 2.2 | 23.0 / 6.5 / 2.2 | 19.8 / 153.2 / 14.0 | 21.6 / 138.6 / 25.4 |

    "sw" = software compositing (Linux's default): after the fix every theme's renderer is within +0.6 / −0.2 of
    Classic (before: up to +2.2, Nave). "GPU raster" = `--enable-gpu-rasterization --use-angle=swiftshader`, the
    closest stand-in for the Mac's GPU pipeline; SwiftShader saturates the 2-CPU box, so the cost shows as frames the
    themes could not produce: before, the textured themes managed 4–14 meter frames/s against Classic's 24 at a higher
    GPU load (per frame 2–6 × Classic's); after, all hold 23–26 frames/s at Classic's GPU load, renderers within
    −0.9 / +0.1 of Classic.
  - Look: `tools/themes/shoot.mjs --only perform` before/after for all eight themes: contrast audit unchanged (0 fails,
    same lowest run everywhere). Pixel diff at 1440 × 900 with grayscale text AA (the Mac's mode): ≤ 0.034 % of pixels
    differ by > 8 levels in every theme (meters / clock), ≤ 1.4 % by any amount (gradient dithering). With Linux's LCD
    text AA the Sanctuary family differs by 2.8–2.9 %: its text was grayscale-AA before because it sat on
    non-opaque overlap layers, and is LCD-AA now, as in Classic and every other theme; nothing else moved.
  - Residual: measured on Linux; the Mac numbers (Metal raster, 120 Hz, Retina) need the Mac:
    `node tools/idle-cpu.mjs --only X --themes classic,sanctuary,daylight-stage,studio,ember,nave --rounds 2
    --no-offline` (the /proc columns are Linux-only; on the Mac read Activity Monitor per theme, or the CDP columns).
- **Runs** (Linux, 2 CPUs, serial, `node test/run-all.mjs --fast --only ui-core,edit-v2,eq,mini,themes`, first try, no
  load-timeout re-runs): ui-core 69/69 (4m02s), edit-v2 99/99 (4m24s), eq 28/28, mini 14/14 + mini-theme 14/14, themes
  36/36 (incl. the 8 new `layers` rows); total 12m31s. Side check: settings PASS.

## tray-hidden (L-30: macOS notch MacBook, full menu bar → the tray icon has no slot)
When the menu bar is full, macOS gives a new status item no slot: the tray exists but is invisible. Renderer half; the
Electron main half is LOCAL.
- **Rig menu ids (exact names, sent by Electron main over the existing `rig:menu` channel → `rig.onMenu` →
  `controller.onMenu(id)`, re-emitted by the controller as `'menu'`):**
  - `trayHidden`: send once when `tray.getBounds().y >= display height` (the icon was placed off-screen).
  - `trayShown`: send when the icon becomes visible again (bounds back inside the display).
  - No payload. Both are idempotent; the renderer tolerates repeats and either order.
- **`app/js/main.js` (menu-bar section):** `trayHidden` → sets `<html data-tray-hidden>` and shows ONE info toast per
  session (`ms` 15000, with a "Dismiss" button; toasts are click-through, so the button is the dismiss control):
  "The menu-bar icon is hidden — your Mac’s menu bar is full. Hide a few items in System Settings › Control Center, or
  use the Rig menu › Show Worship Rig." A later `trayHidden` in the same session shows no second toast. `trayShown`
  removes the attribute (no toast).
- **`app/js/views/settings.js` › Menu bar:** a one-line `p.st-hint` (`data-testid=menubar-tray-hidden`) in the same
  words, `hidden` while the tray is visible. It follows `<html data-tray-hidden>` on build and the two ids live.
  LOCAL: "Rig menu › Show Worship Rig" must exist (it is the escape hatch the text names).
- **Test:** `test/phase2/ui-core/run.mjs` "L-30: rig menu ids trayHidden / trayShown …": drives `controller.onMenu(id)`
  (the function preload's `rig.onMenu` callback is), asserts the exact toast text/kind/dismiss button once, no repeat
  after dismiss, the Settings note shown/hidden, reopen-while-hidden, and (via the suite's final check) no console errors.
