
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
  - `node test/phase2/edit-v2/run.mjs`: **9/9 files, 25/25 tests** (shell 9; 2 per panel file × 8), 1 min 43 s.
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
