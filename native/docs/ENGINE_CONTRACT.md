# Engine contract (2.0 native engine, contract v1.0)

What the native engine must do so that it can replace `app/js/engine/**` behind `app/js/controller.js` without any
audible or behavioural change, plus the JSON bridge (v1) that carries it between the WebView and native code.
The machine-readable form is `native/contract/engine-api.json` (regenerate with
`node native/contract/tools/build-engine-api.mjs`; `--check` fails when `app/js/shared/params.js` or the
instrument catalogue drifted). Where this page and the code disagree, the code wins; fix this page.

File references are relative to `app/js/` (`audio.js:846` = `app/js/engine/audio.js` line 846, `fx.js` =
`engine/fx.js`, `automation.js` = `shared/automation.js`). Line numbers are those of branch `v2-native` at creation.
`[Q]` marks behaviour shaped by a Chromium quirk (section 3.12 lists them all, with what the C++ port must reproduce).

---------------------------------------------------------------------------------------------------------------------

## 0. Ground rules derived from the code

- **One stateful object.** `new AudioEngine(opts)` is built once in `main.js:126`; only `controller.js` drives it
  (calls go through `call()` / `optional()` / `droneCall()`, `controller.js:230-257, 324-334`; a missing method warns
  once, an exception becomes a `warn`). Exceptions where other modules touch the engine directly are listed in 1.6.
- **Clock.** Every time-sensitive call takes `{when}` in *engine seconds* (`ctx.currentTime` domain). `_t(when)`
  (`audio.js:550`): a finite `when` later than now is used as is; absent, NaN or past ⇒ **now**. The live app never
  passes `when` (only `selectSong(id, {when})` forwards one, and no caller sets it); tests, `tools/calibrate.mjs`,
  `tools/audition.mjs` and the golden renderer pass it on an `OfflineAudioContext`.
- **No wall-clock timers in the engine.** Everything delayed runs on `AudioTimer` (`fx.js:106-238`): realtime via a
  `ConstantSourceNode.onended` (callback gets `max(t, currentTime)`), offline via `ctx.suspend()` at the next
  128-frame boundary `k = ceil(t·sr/128 − 1e-6)` (`fx.js:180`). **Offline timer callbacks therefore run on 128-frame
  quantum boundaries; the native offline renderer must quantise its timer callbacks the same way** to match goldens.
  Exceptions: `start()` races `ctx.resume()` against a 1.5 s `setTimeout` (`audio.js:349`); the IR worker watchdog
  (10 s) and `requestIdleCallback` scheduling of convolver builds (`fx.js:543`); drone `warm()`.
- **Coalescing.** `Coalescer(timer, 0.01)` (`fx.js:241`): ≤ 1 apply per key per 10 ms of *event time*, latest value
  wins, trailing flush on the timer. Keys: the param path; `slots.<i>.eq` (whole slot EQ), `fx.delay.time` (time and
  sync), `fx.lofi` (all lofi rows), `wheels`, `bend`. `commit()` drops pending song-state keys (`slots.*`, `fx.*`,
  `master.*`; `audio.js:855`).
- **Smoothing primitives** (`automation.js`): `rampTo` = `cancelAndHold(t)` + `setTargetAtTime(v, t, τ)` +
  `setValueAtTime(v, t + 12τ)` (RAMP_SETTLE_TC 12, `automation.js:40,56`; default τ = 15 ms = `TAU`, `fx.js:14`);
  `glideTo` = exponential ramp from `from` (floor 1e-4, then a set to the real value if < 1e-4) over `dur`
  (`automation.js:100`), linear when either end < 0; `linearTo` = linear ramp from `from` (`automation.js:123`);
  `setNow` = cancelAndHold + set. `linFrom`/`glideFrom` (`fx.js:37,42`) anchor with `setNow(from, t)` first `[Q]`.
  `equalPowerFade` (`fx.js:87`) = **16 linear segments** through sin (in) / cos (out), not a true curve.
  `trackedMove` (`fx.js:69`) records `{from,to,t0,dur|tc}` so a later glide starts where the param really is
  (`moveAt`, `fx.js:58`: exp approach for τ moves, snapped after 12τ).
- **Determinism.** All randomness is `mulberry32` seeded through FNV-1a `hashSeed` (`shared/prng.js:8,29`), per
  subsystem `rngFor(seed, name)` = `createRng(hashSeed(\`${seed>>>0}|${name}\`))` (`fx.js:28`). Names: `drone`,
  `chorus`, `crackle`, `inst|<slot>|<type>|<id>|<instSeq>` (`audio.js:620`; `instSeq` is a lifetime counter
  incremented for **every** instrument created, including prepares later discarded), IR seed
  `hashSeed(\`${seed}|ir|${bucket}|${dampQ}|${sr}\`)` (`fx.js:626`; numbers formatted as JS `String(n)`).
  `hashSeed` hashes UTF-16 code units (`charCodeAt`); all seeds are ASCII.

## 1. The engine object as used (derived from call sites, verified against `audio.js`)

Sync = returns synchronously. Async = returns a Promise. "when" = accepts `{when}` (engine seconds, see 0).
Callers: C = `controller.js`, M = `main.js`, P = `views/perform.js`, S = `views/settings*.js`,
E = `views/components/eq-keyboard.js`, R = `recorder.js`, K = `midi-clock.js`, V = other views, T = tests/tools only.

### 1.1 Lifecycle and device

| member | signature / units | returns | sync | effect, ordering, idempotence | callers |
|---|---|---|---|---|---|
| constructor | `{context?, seed? (uint32 or string→hashSeed), latency? ('interactive' \| seconds), manifestUrl?, manifestUrls? ([factory, ...user]), instrumentModules? (default true), lofi? (default true), glue? (default true), cacheMB? (default 700), sinkId? ('default'), clipOversample? ('none' \| '2x' \| '4x', default 'none')}` | engine | sync | no audio until `start()`. App passes only `{latency}` (`main.js:126`). Tools/tests pass `context` (offline), `seed`, `manifestUrl`, `lofi`, `glue`, `cacheMB`. `audio.js:232` | M, T |
| `start()` | — | `Promise<engine>` | async | idempotent (memoised promise). Creates the context if none, resumes (≤ 1.5 s), builds the FX graph, drone, metronome, loads the registry (manifests, synth/organ modules, `gain-trims.json`), builds the first reverb IR, measures comp makeup and glue table; emits `statechange` then `ready {phase:'start'}`. `audio.js:340-373` | C, T |
| `restart({latency?, sinkId?})` | latency as ctor; sinkId string | `Promise<engine>` | async | new context + graph, **decoded samples survive**; re-applies `getState()` (patch, routing, transpose, tempo, timeSig, keyContext, mono, drone incl. files, runtime wheels/fade); a running click restarts (MIDI Stop sent first); emits `statechange {restarted:true}`. Invalidates any in-flight prepare token (commit then returns false). `audio.js:455-491` | C (restartAudio), S |
| `setSinkId(id)` | device id, '' / 'default' = system | `Promise<true>` | async | `ctx.setSinkId`, metronome re-routes (channel count may change), `statechange`; on failure warns and falls back to `restart({sinkId})`. `audio.js:493` | C |
| `latency` (property, writable) | 'interactive' \| seconds | — | — | read at next context creation; C writes it before start (`controller.js:2360`) | C |
| `latencyMs` (getter) | ms | number | sync | `(baseLatency + outputLatency)·1000` of the context (`audio.js:448`) | C |
| `ctx` (property) | AudioContext | — | — | read for `state` ('running' \| 'suspended' \| 'interrupted' \| 'closed'), `currentTime`, `sampleRate`, `resume()`, `baseLatency`, `outputLatency`, `getOutputTimestamp()`, `audioWorklet` | C (watchdog `controller.js:1601-1640`, resume `:1863`), M (`:832,933,1004`), E (`:199,826`), R, K |
| `sleep({ramp=0.15})` | s | `Promise<boolean>` | async | realtime only, only from `awake` and running: linear ramp of `fx.out` 1→0 starting `now + lead` (lead = clamp(2·baseLatency, .01, .04)), then `ctx.suspend()`; state `sleeping`→`asleep`; emits `sleep {state}`. `audio.js:1508` | C (`sleepCheck`, low-resource mode only) |
| `wake({ramp?})` | s | `Promise<boolean>` | async | idempotent (shared promise): resume, ramp `fx.out` → 1 over 60 ms (5 ms when a noteOn is queued), replays queued `noteOn/noteOff/sustain` at the ramp start in order; emits `sleep {state:'awake', wakeMs, queued}`. Any perform call while not awake queues itself and calls `wake()` (`_sleepHold`, `audio.js:1617`). `audio.js:1549` | C |
| `sleepState` (getter) | 'awake' \| 'sleeping' \| 'asleep' \| 'waking' | string | sync | `audio.js:1468` | C |
| `sleepBlockers()` | — | string[] ⊂ {'voices','click','pedal','drone','no-audio'} | sync | empty = may sleep. `audio.js:1479` | C |
| `setLowResource(on)` | bool | new state | sync | idempotent. On: pins = current song only (old pins remembered), unpinned buffers trimmed, slot level taps released (`slotLevel` → zeros), idle reverb units dropped, no reverb warm-ups, drone frozen to a loop. Off: pins restored + current, wakes audio. Emits `stats`. `audio.js:1430` | C |
| `lowResource` (getter) | bool | | sync | `audio.js:1626` | T |
| `setDynamicRange(range)` | 1..3 (`settings.dynamicRange`, absent = 1) | the range in force | sync | idempotent; `validDynRange` (clamped, 0.01 steps; a non-number = 1); sampled instruments only, from the next note (held notes keep their gain), also for samplers built later. Bridge: `config {dynamicRange}` (UIB, minor 4). `audio.js:1426` | C |
| `setPolyphony(n)` / `setVoiceLimit(v)` / `setBufferFrames(n, {restart})` / `setDroneFreeze(on)` (native only) | 32\|64\|128 / 'auto'\|128\|256\|512\|'off' / 64\|128\|256\|512 / bool | `Promise<audioConfig>` (the first three, never reject) / new state | async / sync | 2.0 Settings › Sound (DECISIONS D1, D4, D2, D5); the web engine has none of them, so the controller sends them only when the engine has the setter. Bridge: `config {polyphony}`, `config {voiceLimit}` ('off' = 0), `audio {bufferFrames}` on the next start / restart, `config {droneFreeze}`. `engine-bridge/bridge-engine.js` | C |

### 1.2 Song switching and memory

| member | signature / units | returns | sync | effect | callers |
|---|---|---|---|---|---|
| `prepare(patch)` | Patch (store `song.patch`, any shape; normalised, see 2.2) | `Promise<token:int>` | async | awaits `start()`. New token supersedes older ones (only the latest can commit). Builds instruments (same `{type,id}` and same effective params ⇒ the playing instance is *reused*), decodes samples, stages the reverb unit for the **effective** size (wash-adjusted) — deferred (IR only, unit built at the next 2 s pause) while keys are held or pedalled. Emits `loading {slot, progress, token}`. A superseded plan is discarded when its build finishes. `audio.js:586-648` | C (`selectSong`, `reprepare`) |
| `commit(token, {when})` | token from prepare | **boolean, synchronous** | sync | false when stale/superseded/already committed (C retries prepare once on false, `controller.js:509,441`). Gains/connections only: old slot channels are *retired* (held and pedal-held voices keep sounding on them; disposed after their voice count has been 0 for 1 s, polled every 0.25 s on the audio clock, `audio.js:1037`), new routing first, then slot configs (fresh strips step, reused strips ramp, every instrument param reset to the song value or default), FX (reverb crossfade 0.8 s to the staged unit), wheels τ 30 ms, `drone.songChanged`, pedal swell sync. Ends any EQ A/B bypass, drops pending coalesced song writes. Emits `stats`. `audio.js:846-898` | C |
| `preload(patches[], {pin})` | pin: 'add' \| 'replace' \| 'none' \| 'auto' (auto = replace for > 2 patches, else add) | `Promise<true>` | async | decodes those songs' sampler samples (6 parallel decodes), pins their cache keys, warms their reverb units after 6 s of quiet (not in low-resource). Never evicts other pinned songs while a song switch is protected; deferred decodes re-warm later. Emits `ready {phase:'preload', decodedMB, pinnedMB, deferred}`. `audio.js:906-946` | C (`controller.js:804,806,877,1023`) |
| `estimatePreloadMB(patches[])` | | `Promise<{mb, exact, samples, capMB}>` | async | decoded size without decoding (exact for keys decoded before, else estimate 1.75 MB/sample `sampler.js:346`). `audio.js:987` | C |
| `retainReverb(patches[])` | | boolean (false before start) | sync | keep built only these songs' reverb spaces (+ current song's); others dropped and not warmed. `audio.js:732` | C (`controller.js:905`) |
| `reloadManifests()` | | `Promise<instrument[]>` | async | re-reads the My Samples manifests; prepared songs keep their instruments; emits `instruments {count}`. `audio.js:574` | C, S |
| `listInstruments()` | | `[{ref:{type,id}, name, group, params:[{key,label,min,max,default,unit,curve,enum?}], license, widthDefault?, calibWindow?}]` | sync | hidden entries (drone-osc) omitted. 43 entries today (23 sampler, 16 synth, 4 organ). `instruments.js:583` | C, P, S, E, V, shared/smart-controls via caller |
| `cache` (property) | BufferCache | | | **direct reach-in**: `main.js:656-668` reads `cache.has(url)`, `cache.entries`, `cache.failed` and `registry.samplers` (defs → layers → samples → url) to compute "Loading n/m" | M |
| `registry` (property) | InstrumentRegistry | | | same reach-in (`main.js:657`) | M |
| `_debugStats()` | | object (1.5) | sync | `audio.js:2447` | C (`updateMemory`: decodedMB, pinnedMB, capMB), S (decodedMB, pinnedMB, voices, nodes, retiring, lowResource, slotLevelTaps), T |

### 1.3 Parameters, routing, song-level state

| member | signature / units | returns | sync | effect | callers |
|---|---|---|---|---|---|
| `setParam(path, value, {when, glide=0})` | path grammar 2.1; value per row; glide s (scenes: `slots.<i>.gain`, `drone.gain` only) | boolean (false = unknown path, warned once; or slot empty) | sync | stores into the engine's patch even before start; smoothing per row (2.3). Never throws. `audio.js:1100-1219` | C (diff, scenes with `{glide: 0.5}` = `SCENE_GLIDE_SEC`, `shared/scenes.js:20`) |
| `getParam(path)` | path grammar 2.1 | the value the engine holds, PARAMS value space (number, boolean, enum name, `'natural'`); `undefined` for an invalid path, an empty slot or an unset optional row (`release`) | sync | CORE2B (minor 5; was not contract, "tests only"): what audio.js reads from its own patch: slot rows from the committed song as `setParam` left them (clamped), slot EQ b-rows resolved (`resolveSlotEq`), instrument params stored or the catalogue default, `drone.*` from the live drone. Bridge: `get {what:'param', path}`; the shim answers synchronously from a mirror (6.6). `audio.js:1221` | tests (`test/phase2/ui-core` `__t.param`) |
| `setTranspose(semis)` | integer −48..48 (rounded, clamped) | — | sync | song transpose; evaluated at the next noteOn (held notes keep their pitch). `audio.js:1681` | C |
| `setRouting(r, {when})` | `{modWheel?, expression?, volume?, bend?, swell?}` (2.2) | — | sync | merges (sub-objects replaced), neutralises the old bend mode on a mode change, wheels τ 30 ms, pedal swell sync. `audio.js:1762` | C |
| `setTempo(bpm)` | > 0 or null | — | sync | delay sync time (`updateTime`), metronome retime from its next free beat; no tempo stops a running click. `audio.js:1685` | C |
| `setTimeSig(sig, {newBar})` | '4/4','3/4','2/4','5/4','6/8','12/8' (else 4/4) | — | sync | click takes it on its next unscheduled beat (as a new bar). `audio.js:1701` | C (optional) |
| `setKeyContext(pc, minor)` | pc 0..11 (mod 12), bool | — | sync | chord spelling preference; re-emits `chord` (forced). `audio.js:1755` | C (optional) |
| `setMono(on)` | bool | — | sync | 50 ms linear crossfade stereo ↔ mono sum (−3 dB) before the catcher; survives restart. `audio.js:509`, `fx.js:2232` | C |
| `eqAudition(slot, mode, {when})` | 0..15 (native; web 0..3), 'bypass' \| 'on' | boolean | sync | A/B: plays the slot with a flat EQ (via SlotEq crossfade); never persisted; a commit ends it. `audio.js:1272` | E (via controller when it has one, else the engine) |
| `getEqResponse(slot, freqs, {perBand})` | Hz array | `Float32Array` dB, or `{total, bands:{lc,b1..b8,hc}}`, null | sync | target magnitude of the stored EQ via `BiquadFilterNode.getFrequencyResponse` at the context's rate (above Nyquist → Nyquist). `audio.js:1255`, `fx.js:1742` | E |
| `getSlotPlayRange(slot)` | | `{lowNote, highNote, sampledLow, sampledHigh, transpose, physLow, physHigh, instrumentRange}` or null | sync | sounding range after octave/transposes, clipped 0..127; sampled range from the sampler manifest. `audio.js:1295` | E, shared/eq-math (via caller) |
| `drone.setKey(pc, {minor, fade?, when})` | | boolean | sync | same key ⇒ no-op; else new layer crossfades in over `fade` (default `drone.fade`). `drone.js:405` | C (`droneCall`) |
| `drone.configure(d, {when})` | song.drone: `{mode:'off'\|'synth'\|'files', chordFollow, continueAcrossSongs, minorUsesRelativeMajorFile, gain, brightness, movement, width, fade}` | — | sync | flags, params (through `setParam`), then `setMode` (same mode while sounding ⇒ no restart). `drone.js:365` | C |
| `drone.attachFiles([{name,url}])` | key read from the name (`shared/keydetect.js`) | count of keyed files | sync | replaces the pad set; a files-mode drone that fell back to the synth switches to the file (1.5 s). `drone.js:981` | C |
| `drone.cfg.mode`, `drone.key`, `drone.files` (properties) | | | | read directly: P (`perform.js:1399-1401,1542`), C (`controller.js:1714-1716`: keeps files across restart?) | P, C |

### 1.4 Perform input

| member | signature / units | returns | sync | effect | callers |
|---|---|---|---|---|---|
| `noteOn(note, vel=100, {when, touch})` | MIDI 0..127 (clamped), vel 1..127 (0 ⇒ noteOff), touch = compiled or `{shape,min,max,top}` curve of the playing keyboard | boolean | sync, when | per slot: split on the *physical* note `[lowNote, highNote]`; sounding note `n + transpose + 12·octave + slot.transpose` (skipped with a warn outside 0..127); velocity curve (2.4); a duplicate noteOn = re-strike; a pedal-held voice of the same sounding note on that slot fades 30 ms first; mono slots go through legato (2.5). Wakes a sleeping engine (queued). Emits `notes`, maybe `chord`. `audio.js:2113` | C (refcounted per source, `controller.js:1096`) |
| `noteOff(note, {when})` | | boolean | sync, when | with pedal down and `slot.sustain` ⇒ pedal-held (optionally timed by `pedalHold`), else release (`slot.release` overrides the instrument's release). `audio.js:2173` | C |
| `sustain(down, {when})` | bool (controller applies `pedalInvert` and ORs sources) | boolean | sync, when | idempotent; up releases every pedal-held voice and mono hold; pedal swell sync. `audio.js:2193` | C |
| `pitchBend(x, {when})` | −1..1 | — | sync, when | coalesced `bend` key; per routing bend mode (2.6). `audio.js:2017` | C |
| `modWheel(v)` / `expression(v)` / `volumeCC(v)` | 0..1 | boolean | sync, when | = `setWheel('mod'\|'expr'\|'vol', v)`; mod has pickup against a virtual owner. `audio.js:1963-1971` | C |
| `setWheel(source, v, {when, glide})` | 'mod'\|'expr'\|'vol'\|'virtual', 0..1, glide s ('virtual' only) | boolean | sync, when | coalesced `wheels`; emits `wheel`. `audio.js:1903` | C (scenes, on-screen wheel) |
| `swell(start?, {when})` | bool or toggle | boolean | sync, when | virtual wheel 0→1 over `routing.swell.seconds` (60 ms dip from the pre-swell value first, 50 ms steps), back to the pre-swell value over 4 s. `audio.js:1978` | C |
| `allNotesOff({when})` | | — | sync, when | panic: every slot voice (incl. retiring) 30 ms fade, sounding/pedal/held cleared, pedal up, swell dropped, bend → 0, delay feedback → 0 for max(0.2 s, longest line + 50 ms). **Drone untouched.** `audio.js:2318` | C |
| `fadeOutAll(seconds=6, {when})` | s, ≥ 0.05 | — | sync, when | exponential glide of `fx.fadeGain` to 0 (drone included), then all voices off; the next noteOn restores the gain (τ 5 ms). `audio.js:2344` | C |
| `noteInput({when})` | | — | sync | marks input for the reverb-build quiet rule (2 s / 6 s). `audio.js:1400` | C (`controller.js:1887`) |
| `wheelValues()` | | `{mod, expr, vol, owner:'hw'\|'virtual', swelling}` | sync | `audio.js:1973` | P (`perform.js:1034`) |
| `getRuntimeState()` / `applyRuntimeState(r, {when})` | `{wheel:{mod,expr,vol}, modOwner, faded}` | | sync | carried across restart; apply re-ramps wheels τ 5 ms, re-mutes a fade. `audio.js:2401-2424` | P (faded), C |
| `pedal` (property) | bool | | | effective sustain as the engine sees it | P (`perform.js:1513`) |
| `_fade` (private) | | | | fallback when `getRuntimeState` is missing (`perform.js:1515`) — **not contract** | P |

### 1.5 Click / metronome, meters, recording

| member | signature | returns | sync | effect | callers |
|---|---|---|---|---|---|
| `clickStart({countIn=0, quietAfter=false, when})` | bars | `{t0, downbeat}` or null (no tempo / before start) | sync, when | first click ≥ 60 ms after `when`; wakes audio. | C (optional) |
| `clickStop({when})` | | boolean (was running) | sync, when | unscheduled clicks dropped; MIDI Stop to the sink. | C (also on panic when running) |
| `setClick({level, record, output}, {when})` | level 0..1 linear (bus gain, τ 10 ms), record bool, output 'main'\|'aux' | `{output, auxAvailable}` or null | sync | survives restart | C |
| `clickState()` | | `{running, counting, bpm, sig, output, level, record, downbeat}` | sync | `metronome.js:296` | C |
| `clickOutputs()` | | `{aux: channels ≥ 4, channels}` | sync | | C |
| `setClockSink(fn)` | `fn([{t (engine s), data:[status]}])` or null | — | sync | 24 ppq clock + Start (on the first downbeat) / Stop while the click runs; the controller maps `t` to `performance.now()` and sends via Web MIDI (`midi-clock.js:70-95`). | K/C |
| `analyserL`, `analyserR` (getters) | `AnalyserNode` (fftSize 2048, smoothing 0.8, −100/−30 dB) on `fx.out` L/R | | | meters read `getFloatTimeDomainData` (peak) per frame; the EQ RTA reads `getFloatFrequencyData` and `frequencyBinCount`, `fftSize`, `context.state` | V (`components/meter.js:31-53`, `_fallback-components.js:545`), E (`:840,996`) |
| `slotLevel(i)` | 0..15 (native; web 0..3) | `{peak, rms}` linear, zeros for empty slot / low-resource, null for bad index or before start | sync | first read creates an AnalyserNode (fftSize 256, smoothing 0, downmix ½(L+R)) on the strip's pan output; released after 2 s without a read. `audio.js:1336` | C (`controller.slotLevel`, read by `components/levelMeter.js` per frame) |
| `recordTap` (getter) | GainNode on `fx.out` (post ceiling, post sleep ramp; the click only when `setClick({record:true})`) | | | `recorder.js:302-482` connects an AudioWorklet (16-bit stereo WAV) | R |

`_debugStats()` fields (`audio.js:2460-2486`): `voices, nodes, retiring, decodedMB, pinnedMB, referencedMB, capMB,
sounding, pedaled, timers, lowResource, slotLevelTaps, reverbUnits, reverbQuietWaiting, fxAsleep[],
droneFrozen, droneLoopSec, droneRenderMs, droneRenders, droneFreezeMB, droneSeam, droneFreezePending,
droneFreezeReused, droneRenderMaxStepMs, audioSleep, click{…state, live, pumps, pumpMs, ticks, late, pulses,
startedAt}, lastWake{ms, queued, ramp, at, leadMs}`. App-read: decodedMB, pinnedMB, capMB, voices, nodes, retiring,
lowResource, slotLevelTaps. `nodes`, `timers`, `fxAsleep`, `reverbUnits` are Web-Audio-shaped: the native engine
reports its own equivalents (nodes → active DSP objects) and tests that compare them must be re-baselined.

### 1.6 Events (`EventTarget`, `CustomEvent.detail`)

| event | detail | emitted | listeners |
|---|---|---|---|
| `statechange` | `{state, latencyMs, restarted?}` | start, every ctx state change, setSinkId, restart (`restarted:true`) | C (`controller.js:2425`: latency, restart recovery), M (`:1044`), E |
| `ready` | `{phase:'start'}` \| `{phase:'preload', decodedMB, pinnedMB, deferred}` | end of start / preload | C (re-emitted), P, V (edit shell), E |
| `loading` | `{slot, progress 0..1, token}` | sampler decode progress in prepare | C (re-emitted), E |
| `instruments` | `{count}` | reloadManifests | P, V, E |
| `wheel` | `{source, value}` or `{source:'mod', value, hardware, pickup:true}` | every wheel write; pickup refusal | C (`onEngineWheel`, re-emitted) |
| `notes` | `{held: Set<physical note>}` | every noteOn/noteOff/panic | C (re-emitted) |
| `chord` | `{chord: {name, root, quality, bass} \| null}` | held chord name changes (2 notes that are not a fifth keep the previous name) | C (re-emitted → `components/readouts.js`) |
| `click` | metronome `state()` | start, stop, retime, configure | C (`onEngineClick`) |
| `sleep` | `{state:'sleeping'\|'asleep'\|'awake', wakeMs?, queued?}` | sleep/wake transitions | C (`onEngineSleep`) |
| `warn` | `{message}` | `_warn` (deduplicated per message by default) | C (re-emitted, `main.js:85-110` maps text to plain copy; regexes match `engine.<name> failed`) |
| `stats` | `_debugStats()` | commit, retire, setLowResource | **no listener** ⇒ not contract |

**Direct reach-ins (the only places outside the controller, `grep -rn "engine" app/js`):** `main.js` (`ctx.state`,
`addEventListener('statechange')`, `cache`/`registry` for "Loading n/m"), `views/perform.js` (`listInstruments`,
`wheelValues`, `pedal`, `getRuntimeState`/`_fade`, `drone.cfg.mode`, `drone.key`, events `ready`/`instruments`),
`views/settings.js` (`_debugStats`, `listInstruments`, `reloadManifests`), `views/settings-import.js`
(→ `reloadManifests` via settings), `views/components/eq-keyboard.js` (`eqAudition`, `getEqResponse`,
`getSlotPlayRange`, `listInstruments`, `ctx.sampleRate/state`, `analyserL/R`, events), `components/meter.js` and
`_fallback-components.js` (`analyserL/R`), `views/edit/shell.js`, `panels/bottom.js`, `panels/slot.js` (pass the
engine to components; `listInstruments`, events), `recorder.js` (`ctx`, `recordTap`), `midi-clock.js` (`ctx` via
the controller's `getCtx`).

### 1.7 Exists but is NOT part of the contract

Test/tool hooks (keep in the native *test* API, not in the bridge): `at(when, cb)` (31 test files; the golden
renderer needs an equivalent: timed script entries), `getState`, `applyState` (restart-internal),
`heldChord`, `activeNotes`, `quietFor`, `slotTapCount`, `offline`, `dispose`, `_setDroneFreezeOptions`,
`_droneFreezeEnv`, `_teardown`, `_slotTouch`, `_sampleJobs`, `_rewarmPins`, `_trimReverbUnits`, `_disposeChannel`,
`_factorFor` (mirrored in `perform.js:90`, not called). Unused by anyone: event `stats`, `swapTo`, `registry` methods
beyond `samplers`/`list`, `drone.getState`. `controller.auditionNote`/`slotAnalysers` are probed by the EQ view but no
engine implements them.

---------------------------------------------------------------------------------------------------------------------

## 2. Parameter surface

### 2.1 Grammar (`shared/params.js:174-187`)

```
path   := slotPath | 'fx.' unit '.' key | 'master.volume' | 'drone.' key
slotPath := 'slots.' i '.' ( 'params.' [A-Za-z_][A-Za-z0-9_]*               (dynamic: instrument param)
                           | row-of-'slots.<i>.…' )                         (incl. 'eq.b<k>.<field>', 'touch.<k>')
i      := [0-9] | '1' [0-5]        (native, DECISIONS D3: 16 slots; the web engine and its PARAMS grammar: [0-3])
```
**Slots (T00c, DECISIONS D3).** A native song has 1..16 slots: `patch.slots` is an array of up to 16 entries (null =
empty slot; more than 16 is `bad-request`). The engine keeps max(entries, 4) slot channels, so a 4-slot song behaves
exactly as the web engine (the golden oracle stays at 4 slots); slots 4..15 are the same path as slot 0 (strip, pan,
sends, EQ, meters). Every slot-indexed surface takes 0..15: `set` paths, `config.eqAudition.slot`,
`config.meters.slots`, `slotLevel`, `tick.slots` (one pair per slot of the song, at least 4), `get state` (`slotCount`).
Wheel / pedal routing and MIDI-learn targets follow the slot index (T14).
`clamp(path, v)` (`params.js:232`): bool ← booleans, numbers ≥ .5, 'true'/'on'/'1'; enum ← member, or a number as
rounded index; numbers ← `Number(v)`, NaN/null/'' ⇒ default, clamped, rounded when `step: 1`; `words` pass through
(`pedalHold: 'natural'`); dynamic rows accept booleans, and the engine clamps numbers to the instrument's own
`min/max` (`audio.js:1167`). Gains are linear 0..2 (UI taper `2·pos³`, `params.js:263`).

### 2.2 Shapes (normalised by `normalizePatch`, `audio.js:102-157`)

- **Patch** `{slots:[Slot|null ×4], fx:{reverb, delay, chorus, lofi, eq, comp, master:{volume}}, modWheel,
  expression, volume, bend, swell}`. Unknown fields dropped; every value clamped through PARAMS.
- **Slot** `{instrument:{type:'sampler'|'synth'|'organ', id}, gain, pan, octave, transpose, lowNote, highNote,
  sustain, mono, velocityCurve, bendEnabled, sends:{reverb,delay,chorus}, params:{}, width, eq:{sparse}, release
  (null = instrument's), pedalHold ('natural' | 2..30 s), touch?:{shape,min,max,top}}`; defaults per role
  (`params.js:385-421`: Keys/Pad/Extra/Bass sends, Bass mono 'lowest', highNote 59). A slot without
  `instrument.type/id` is empty.
- **Routing** (1.1 additions included): `modWheel`/`expression` `{target, min 0..1, max 0..1, curve?: 'linear'|'log'}`
  (curve = v11 pedal taper, expression only is read through it: `pedalCurve(x,'log') = (10^(2x) − 1)/99`,
  `shared/touch-curve.js`); `volume {target}`; `bend {mode:'pitch'|'morph'|'drone-swell'|'tape'|'none', range
  0..24 semis}`; `swell {seconds 0.5..60 (default 8), pedal?: true}` (v11 "hold pedal = sustain + drone swell").
  Targets: `slots.[0-3].gain`, `drone.gain`, `fx.reverb.returnGain`, `master.volume`, `macro.intensity`,
  `macro.wash`, `none` (else the default `slots.1.gain` / `master.volume`).
- **Scenes** (v11-scenes) never reach the engine as such: the controller overlays the playing scene on the song and
  sends level diffs as `setParam(path, v, {glide: 0.5})` and `setWheel('virtual', v, {glide: 0.5})`.
- **Touch curves** (v11-touch): per keyboard (controller → `noteOn(…, {touch})`) and per slot (`slots.<i>.touch.*`).
- **Metronome** (v11): engine-side state only (`setTempo`, `setTimeSig`, `setClick`, `clickStart/Stop`); not PARAMS.

### 2.3 Rows, smoothing and the DSP object driven

Full table (102 PARAMS rows, 72 of them per slot incl. 40 EQ band rows; ranges, defaults, units) is generated into
`engine-api.json`
`params.rows`; this is the behaviour of `engine.setParam` per group. "co" = coalesced (10 ms/key).

| rows | range / default | smoothing in setParam | drives |
|---|---|---|---|
| `slots.<i>.gain` | 0..2, .8 | co; `trackedMove`: glide > 0 ⇒ linear from the tracked value over `glide`; else setTarget τ 15 ms; fresh channel ⇒ set | `Channel.fader.gain` (`fx.js:2006`) |
| `slots.<i>.pan` | −1..1, 0 | co; τ 15 ms | `StereoPannerNode.pan` |
| `slots.<i>.octave/transpose/lowNote/highNote/sustain/mono/velocityCurve` | −2..2 / −12..12 / 0..127 / 0..127 (127; Bass 59) / bool / off\|lowest\|highest / soft\|normal\|hard\|fixed\|custom | none: read at the next noteOn / noteOff | note mapping |
| `slots.<i>.bendEnabled` | bool (synth/organ true) | immediate | false ⇒ `inst.setBend(0)`; true in pitch mode ⇒ `setBend(bend·range)` |
| `slots.<i>.sends.{reverb,delay,chorus}` | 0..1 (role defaults) | co; τ 15 ms | post-pan send gains |
| `slots.<i>.width` | 0..1.5, 1 | co; τ 15 ms on `wNarrow = min(w,1)−1`, `wWide = max(0,w−1)`; effective w = width × instrument `widthDefault`, clamped 0..2.25 | M/S width (3.2) |
| `slots.<i>.eq.*` (legacy `low, high, lowHz, mid1, mid1Hz, mid1Q, mid2, mid2Hz, mid2Q, highHz, cutHz`; bands `b1..b8.{on,type,hz,db,q}`; `hiCutHz`) | see JSON | co on one key `slots.<i>.eq`; `SlotEq.set` diff: Hz exponential glide 15 ms, Q/gain τ 15 ms, peak/shelf type change = 30 ms fade to 0 dB, swap, 30 ms back; set-of-filters change = new chain warmed 50 ms muted then 30 ms linear crossfade (`fx.js:1902`); all biquad params **k-rate** | slot EQ (3.3) |
| `slots.<i>.release` | 0.05..8 s or null | read at release | voice `releaseOverride` (s to −60 dB) |
| `slots.<i>.pedalHold` | 'natural' or 2..30 s | read at key-up under pedal | after `hold` s fade over 0.25·hold |
| `slots.<i>.touch.{shape,min,max,top}` | .25..4 / 0..1 / 0..1 / 20..127 | next noteOn | velocity curve when `velocityCurve: 'custom'` |
| `slots.<i>.params.<key>` | instrument meta (catalogue in JSON) | co; instrument's own smoothing (`inst.setParam(key, v, t)`) | instrument |
| `fx.reverb.size`, `damp` | 0..1, .5 / .5 | `Reverb.request`: 300 ms debounce (event time), IR for the **effective** size bucket off-thread, convolver build in an idle period (≤ 1 s wait), 0.8 s equal-power unit crossfade; same bucket ⇒ nothing | reverb unit |
| `fx.reverb.predelay` | 0..0.2 s, .02 (unit clamps 0..0.5) | co; 0.5 s equal-power crossfade between the unit's two predelay lines (never a delayTime ramp); a crossfade in progress queues the latest value | `Reverb._pdTo` (`fx.js:1021`) |
| `fx.reverb.returnGain` | 0..2, 1 | co; τ 15 ms | `Reverb.ret` |
| `fx.delay.time`, `sync` | .05..1.5 s, .375 / off\|1/4\|1/8d\|1/8 | co key `fx.delay.time`; `updateTime`: change ≤ 5 % ⇒ linear delay glide over max(0.5, 20·|Δ|) s; else switch to the other line (3.5) | delay |
| `fx.delay.feedback` | 0..0.9, .35 | co; τ 15 ms on the 4 feedback gains (wash override) | delay |
| `fx.delay.pingpong`, `tone` | bool / 0..1 (.5) | co; `applyAll` (input matrix τ 15 ms, tone LPF `1200·10^tone` Hz τ 15 ms, feedback, return, time) | delay |
| `fx.delay.returnGain` | 0..2, 1 | co; τ 15 ms | `Delay.ret` |
| `fx.chorus.rate`, `depth` | .05..3 Hz (**engine clamps .15..1.5**), .4 / 0..1, .5 | co; τ 50 ms; voice 2 rate × 1.07; depth = 2 ms × depth | chorus LFOs |
| `fx.chorus.returnGain` | 0..2, 1 | co; τ 15 ms | `Chorus.ret` |
| `fx.lofi.{amount,wow,flutter,crackle,bits,tone,saturation}` | 0..1 (0, .5, .5, .3, .5, .5, .5) | co on one key `fx.lofi`; `Lofi.apply` (3.7) | lofi |
| `fx.eq.{low,mid,high}` | ±12 dB, 0 | co; τ 15 ms | master EQ biquads |
| `fx.comp.amount` | 0..1, 0 | co; `setGlue` (3.8) | glue compressor |
| `master.volume` | 0..2, −6 dB (0.501) | co; τ 15 ms | `fx.master.gain` |
| `drone.gain` | 0..2, −6 dB | not coalesced; `trackedMove` to the swell-adjusted target; parks after 10 s at 0 | `Drone.level` |
| `drone.width` | 0..1, .7 | τ 20 ms on the L/R matrix | drone width |
| `drone.brightness`, `movement` | 0..1, .5 / .3 | drone-osc params: `drift = 1+6m`, `unisonDrift = 1.6+8m`, `lfoDepth = 20+600m`, brightness → morph; crossing .6 re-voices (adds/removes the 9th) | drone voices |
| `drone.fade` | 1..20 s, 4 | state: key/mode change fade | drone |

### 2.4 Velocity (v11-touch, `shared/touch-curve.js`, `audio.js:186-208, 2127-2138`)

`touchAt(c, vel) = c.lo + c.span·x^g`, `x = clamp(vel/top, 0, 1)`, `lo = min(min,max)`, `span = |max−min|`.
Presets: soft g .6; normal g 1; hard g 1.6; fixed lo = hi = 100/127. Slot `velocityCurve`: soft/hard/fixed ⇒ preset;
custom ⇒ `slot.touch`; normal ⇒ the keyboard's curve from `noteOn(…,{touch})`, else linear. The controller sends a
keyboard curve only for MIDI devices that have one in `settings.keyboards`; otherwise it pre-shapes the velocity with
`applyVelocitySens` (`controller.js:1225`).

### 2.5 Mono, sustain, pedal (`audio.js:2193-2315`)

Mono slot: `notes` map physical → {sn, v}; target = lowest/highest held; a held current voice with `legatoTo` glides
(instrument legato), else 30 ms crossfade retrigger. Key-up of the target with others held ⇒ switch; with none and
pedal down + sustain ⇒ held until pedal up (or `pedalHold` timer). Polyphonic: pedal holds a released voice when
`slot.sustain`; `pedalHold` s ⇒ fade over 0.25·hold after hold s (−60 dB at end).

### 2.6 Wheels, macros, bend (`audio.js:1818-2103`)

`factor(target) = Π lerp(min,max,mod)` [mod routed] `· lerp(min,max,pedalCurve(expr,curve))` [expr routed] `· vol`
[vol routed]. Slot i gain × factor(`slots.i.gain`), and slot 1 (Pad) × `lerp(.35, 1, I)` when `macro.intensity` is
routed; drone × factor(`drone.gain`); reverb return × factor(`fx.reverb.returnGain`) × `lerp(.8,1.15,I)` ×
`lerp(1,1.6,W)`; `fx.masterWheel` × factor(`master.volume`). `macro.wash` W: reverb size `lerp(size,.9,W)`
(re-requests the IR bucket), delay feedback `lerp(fb,.75,W)` (τ 50 ms). Pad-like instruments
(`audio.js:45`) get `morph = max(I, |bend| in morph mode)`. All wheel gains τ 15 ms (30 ms on commit/setRouting,
5 ms on applyRuntimeState). Pickup: hardware mod takes over a virtual owner only within ±.03 or after crossing it.
Bend: pitch ⇒ `inst.setBend(x·range)` on bendEnabled slots incl. retiring; morph ⇒ morph; drone-swell ⇒
`drone.bendSwell(x)` (push-up toward full level, duck to .3 below); tape ⇒ lofi tape delay: x<0 delay time grows
linearly to 0.95 s at slope 0.5·|x| (pitch drop), LPF `18000·0.08^|x|`; x>0 resonant LPF `18000·0.04^x`, Q
`.707+5x` (Q in dB `[Q]`); x=0 recover over 1 s.

---------------------------------------------------------------------------------------------------------------------

## 3. The audio graph as built today (formulas and constants for the port)

```
slot: inst.output ─(armed while voices live)→ fader → wheel → width(M/S) → SlotEq → pan ─┬→ sum
                                                                                         ├→ send.reverb → Reverb.input
                                                                                         ├→ send.delay  → Delay.input
                                                                                         └→ send.chorus → Chorus.input
drone: layers → synthBus(trim) → HPF80 → synthMode ┐                                  ┌→ out → sum
       pads (<audio>) → filesBus → filesMode ──────┴→ width matrix → level → wheel → bend ┤
       frozen loop (ch 2-3) ──────────────────────────────────────────────────────────┘ └→ sendGate(.4|0) → Reverb.input
Reverb.out, Delay.out, Chorus.out → sum
sum → Lofi(dry | wet) → master EQ (LS100, PK1k Q.8, HS8k) → glueDry ┬→ master(volume) → masterWheel → fadeGain
                                                    └→ glue comp → glueWet ┘
fadeGain → stereo(1|0) + mono(√2·½(L+R)) → preComp → catcher comp → clipPre(.5/makeup) → clip curve → out(sleep ramp)
out → destination, recordTap, splitter → analyserL / analyserR
click bus (mono, level) → destination (after out) | outputs 3-4 | + recordTap when record
```

### 3.1 Slot channel and strip (`fx.js:1992-2090`)

Created per instrument instance in `prepare` (`audio.js:629`). `inst.output → strip.input` is connected on the
slot's first note (`_armSlot`) and disconnected after 2 s without live voices (polled 0.5 s, realtime only;
offline renders keep it connected) — CPU only, inaudible. Fader starts at 0 and is *set* to the slot gain on commit
(fresh) — so a fresh strip is silent until commit. `wheel` = wheel factor. Sends are **post-pan** and post-EQ.
`StereoPannerNode` equal-power law (Web Audio spec): mono input `x=(p+1)/2`, `L=cos(xπ/2)`, `R=sin(xπ/2)` (−3 dB at
centre); stereo input p ≤ 0: `L = inL + inR·cos((p+1)π/2)`, `R = inR·sin((p+1)π/2)`; p > 0: `L = inL·cos(pπ/2)`,
`R = inR + inL·sin(pπ/2)`. **Channel counts propagate** (gain nodes are `max` mode): a mono instrument output
would pan with the mono law. The sampler and synth-extra force a stereo output on purpose (`sampler.js:892-897`,
`synth-extra.js:325-329`: dual-mono up-mix) so they take the stereo law; the native port must keep each instrument's
output channel count (verify synth.js/organ.js patches per patch with the golden harness) and both pan laws.

### 3.2 Width (`fx.js:1996-2064`)

`M = ½(L+R)` (explicit 1-ch speakers down-mix; mono input: M = x), `S⃗ = x − M` (0 for mono),
`out = x + (min(w,1)−1)·S⃗ + max(w−1,0)·HPF₂(150 Hz, Butterworth)(S⃗)`. w = 1 ⇒ exact identity.

### 3.3 Slot EQ (`fx.js:1614-1990`, DECISION/AMENDMENT in `design/eq/`)

Resolved EQ (`resolveSlotEq`, `fx.js:1671`): 8 bands; a band with any stored `b<k>.*` row takes PARAMS defaults for
the rest; a band without reads legacy rows (b1 ← `low`/`lowHz` low shelf; b2 ← `mid1*` peak, default 400 Hz; b3 ←
`mid2*` peak, 2500 Hz; b8 ← `high`/`highHz` high shelf). Defaults: b1 lowshelf 120 Hz on, b8 highshelf 6 kHz on
(both 0 dB ⇒ identity), b2..b7 off at 210, 370, 640, 1100, 2000, 3400 Hz; `cutHz` 20 (≤ 20.5 ⇒ off), `hiCutHz`
20000 (≥ 19999 ⇒ off). Chain order: `lc → b1..b8 (on and type ≠ off) → hc`. Filter specs (`eqSpec`, `fx.js:1718`):
lc/hc = Butterworth HP/LP (Q −3.01 dB); band `peak`/`notch` use linear `q`; band `lowcut`/`highcut` are HP/LP with
**Q in dB = 20·log10(q)** `[Q]` (Web Audio LP/HP `Q` is resonance in dB: `α = sin ω₀ / (2·10^(Q/20))`, so the
native biquad must use linear `q` directly); shelves ignore q (Web Audio shelves use S = 1:
`α = sin ω₀/2·√2`, `A = 10^(dB/40)`); peaking `α = sin ω₀/(2q)`. Gains of an engaged shelf/peak = band dB; a
disengaged identity-type band stays wired at 0 dB. Biquad params are k-rate (one value per 128-frame quantum)
`[Q]`. Response for the UI = product of the wired filters' magnitudes at the context rate.

### 3.4 Reverb (`fx.js:282-1122`)

Input (stereo; sum of all slot reverb sends + drone send) → HPF 180 Hz Butterworth → LPF 9 kHz Butterworth → active
unit → `ret` (returnGain) → `wheel` (macro factor) → sum. Unit = 2 predelay lines (DelayNode, max .5 s) with gains
`pg[0]=1, pg[1]=0` → ConvolverNode (`disableNormalization: true`, stereo IR: L→L, R→R) → `out` gain → ret.
Pool: LRU of ≤ 10 units keyed `bucket|dampQ|sr` (`REVERB_UNITS_MAX`, `fx.js:557`), IR cache ≤ 12 (`fx.js:541`);
`retain` set from the controller window. Unit switch: equal-power 16-segment crossfade 0.8 s; the outgoing unit is
disconnected `0.85 s` later. Predelay change: idle line set, 0.5 s equal-power crossfade.
Build timing (v11-reverb-quiet): a build needed by the current song while playing waits for 2 s of quiet
(`REVERB_QUIET_SEC`: no key held, pedal up (a pedal down > 30 s stops counting), no input), warm-ups for 6 s
(`REVERB_WARM_QUIET_SEC`); one build per pause. **This exists only because `ConvolverNode.buffer =` blocks the main
thread 14–400 ms `[Q]`; a native engine that builds kernels off the audio thread can drop the waiting, but must keep
the same crossfade and the same "which IR plays" outcome.**

**IR algorithm** (`irGen`, `fx.js:342-387`; worker, chunked and sync paths are bit-identical):
- `bucket = argmin_b |ln(b / (max(.01,size)·9))|` over `IR_BUCKETS = [1.5, 2, 2.8, 3.8, 5, 6.5, 8]` s;
  `dampQ = round(clamp(damp,0,1)·10)/10`.
- `rt[k] = bucket·IR_RT[k]·(1 + (0.5 − dampQ)·0.8·IR_DAMP_W[k])`, bands `[125,250,500,1000,2000,4000,8000]` Hz,
  `IR_RT = [1.2,1.1,1.0,.9,.8,.5,.3]`, `IR_DAMP_W = [0,0,0,.25,.5,.75,1]`; `len = ceil(1.1·max(rt)·sr)`.
- RNG `createRng(hashSeed(\`${seed}|ir|${key}\`))`, consumed in this exact order: channel 0 then 1; per channel, per
  band k (ascending), per sample: `x = 2·next() − 1` → RBJ band-pass (constant 0 dB peak, `q = √2`, `f` clamped to
  `0.45·sr`, coefficients in double, `fx.js:299`) → `out[i] += y·env` with `env *= exp(−6.9/(rt[k]·sr))` per sample.
  **`out` is a Float32Array: every `+=` rounds to float32**; filter state and env are double.
- 30 ms cosine fade-in `out[i] *= .5 − .5·cos(πi/fi)`, `fi = floor(.03·sr)`.
- Early reflections: `eRms = sqrt(Σ_{i<ew} out²/ew)` (`ew = min(len, floor(.08·sr))`, `|| 0.01`);
  `taps = 6 + floor(next()·5)`; each tap: `pos = floor((.007 + next()·.053)·sr)`; then (only if `pos < len`)
  `out[pos] += (next() < .5 ? −1 : 1)·(1 + next()·3)·eRms` (sign drawn before magnitude).
- Low shelf −6 dB at 150 Hz (RBJ S = 1, `fx.js:308-317`) in place, double state, float32 out.
- Normalise both channels together: `g = sqrt(0.35·2 / Σ(both channels) x²)`, `out *= g` (float32).
- Bit-exactness caveat: V8's `Math.exp/sin/cos/pow` are fdlibm ports; glibc/Apple libm may differ in the last ulp.
  Vendoring fdlibm (Sun licence, permissive) for the IR makes the golden IR bit-exact; otherwise compare at ~1e-6.

### 3.5 Delay (`fx.js:1124-1335`)

Two `DelayLine`s (only one fed). Per line: `input → gate → [pre Q = 128/sr] → in-matrix → stereo delay
(time − Q) → tone LPF (Butterworth, 1200·10^tone Hz) → { out → ret ; fb-matrix → delay }`. In-matrix: plain
L→L, R→R; ping-pong `L ← .5L + .5R`, R ← 0. Feedback matrix: plain `fbLL = fbRR = f`; ping-pong `fbLR = fbRL = f`
(`f ≤ 0.9`). Echo k lands at exactly `k·time` `[Q]`: the `Q` split exists only because Chromium runs a feedback
cycle one render quantum late; **native: the same structure (pre-delay Q, d = time − Q, feedback reads the LPF
output one quantum late); echo k lands at exactly k·time** (T05 review R1: this structure is what makes the echo
fixtures bit-exact).
Effective time: sync on and tempo ⇒ `beat·{1/4:1, 1/8d:.75, 1/8:.5}`, else `time`; clamp .02..1.9 s. Change ≤ 5 %
⇒ linear delay-time glide over `max(.5, 20·|Δ|)` s (pitch-shifts the tail ≤ 5 %); larger ⇒ the idle line takes the
new time (gate τ 5 ms in, out set to 1, feedback τ 5 ms), the old line's gate closes τ 5 ms and it rings
`min(8, time·ceil(ln .001/ln fb) + .1)` s, then out/feedback → 0 and it is "flushing" for `time + .1` s; a busy
other line is flushed first (out τ 6 ms, gate τ 3 ms, fb τ 5 ms, wait `time + .06`). Panic: all feedback → 0 (τ 5 ms)
and back (τ 20 ms) after `max(.2, longest time + .05)` s. Fractional delays use linear interpolation `[Q]`
(Chromium `DelayNode`).

### 3.6 Chorus (`fx.js:1337-1370`)

Input explicitly mono (`½(L+R)`). Two voices: DelayNode 7 ms base + sine LFO (PeriodicWave `real=[0,sin φ]`,
`imag=[0,cos φ]`, unnormalised ⇒ `sin(ωt + φ)`; `φ₀ = rng('chorus').next()·2π`, voice 2 `φ₀ + π/2`) × depth gain
`0.002·depth` s added to delayTime (initial 0.001 s); rates `r` and `1.07r`, `r = clamp(rate, .15, 1.5)`; voice 0 →
L, voice 1 → R; 100 % wet → ret → sum. LFO automation τ 50 ms.

### 3.7 Lofi (`fx.js:1372-1563`)

After the sum (so it colours dry, returns and drone). `amount = 0` (and no hold) ⇒ wet chain disconnected, dry gain
exactly 1. Wet: `×.25 (LOFI_PRE) → WaveShaper tanh (oversample 4x [Q]) → WaveShaper quantiser (none) → tape
DelayNode (5 ms + wow LFO .35 Hz depth .002·a·wow s + flutter LFO 5 Hz depth .00003·a·flutter s) → HPF → LPF → ×4
(makeup) → wet`, plus `crackle loop (6 s stereo, rng 'crackle': per channel n = 60 + floor(next·30) impulses at
floor(next·(len−8)), amplitude (.3 + next·.7)·(next < .5 ? −1 : 1), shape a·e^(−.8j), j < 6) → BPF 2500 Hz Q .8 →
gain` into wet. `driveDb = 9·min(1, 2a·sat)` quantised to .25 dB; tanh curve `tanh(g·x)/g` in the ×4 domain (4096
points); `bits = max(10, round(16 − 5·min(1, a·(.5 + bits))))`, 16 ⇒ no quantiser, curve
`round(x·2^(bits−1))/2^(bits−1)`
(32768 points); LPF `18000·(3500/18000)^(a·(.4 + .6(1−tone)))`, HPF `20·6^(a·(.5 + .5(1−tone)))`, both τ 15 ms;
crackle gain `10^((−60 + 22·crackle)/20)·min(1, 1.5a)·4` (τ 50 ms). Engage: 30 ms linear dry→wet crossfade starting
`.0075 + 320/sr` s later (wet latency `[Q]`); disengage: 30 ms back, wet disconnected 40 ms later. WaveShaper
lookup: `v = (n−1)·(x+1)/2`, linear interpolation, clamped ends `[Q]`.

### 3.8 Master EQ, glue, master, catcher, ceiling (`fx.js:2092-2461`)

Master EQ: lowshelf 100 Hz, peaking 1 kHz Q .8, highshelf 8 kHz; gains ±12 dB (τ 15 ms). Glue (`fx.comp.amount a`):
`threshold −24a dB, ratio 1 + 3a, knee 6, attack 10 ms, release 250 ms` (Chromium `DynamicsCompressorNode` `[Q]`);
0 ⇒ disconnected. Engage: params step, compressor connected, after 0.3 s (`GLUE_ENGAGE_DELAY`, detector settle `[Q]`)
a 30 ms linear dry→wet crossfade; wet gain = makeup `10^(−ref(a)/20)` where `ref` = measured total gain on a 1 kHz
sine at amplitude .1 for a = 0, .1, …, 1 (Chromium: `[0, .07, .45, 1.23, 2.23, 3.33, 4.51, 5.75, 7.02, 8.12, 8.44]`
dB), interpolated in dB `[Q]`. Master gain = `master.volume` (τ 15 ms). Then `masterWheel`, `fadeGain` (fadeOutAll),
stereo/mono (mono = `√2·½(L+R)` on both channels, 50 ms linear crossfade), catcher compressor (threshold −3 dB, knee
3, ratio 12, attack 3 ms, release 250 ms) `[Q]`, `clipPre = 0.5/m` (m = the compressor's measured automatic makeup,
≈ +1.10 dB in Chromium) and the clip curve: `y = f(x)` with `x = compOut/m`, `f(x) = sign(x)·(|x| < .5 ? |x| : .5 +
(c − .5)·tanh((|x| − .5)/(c − .5)))`, `c = 10^(−.3/20)`, sampled at 16384 points over x ∈ [−2, 2], oversample none
(`fx.js:1567`). Net: unity below threshold, soft ceiling −0.3 dBFS. Output latency of the music path = compressor
lookahead (Chromium: 264 frames incl. its pre-delay, ≈ 6 ms) `[Q]`; the click (summed after `out`) is not delayed.

### 3.9 Drone (`drone.js`)

Synth mode: one layer per key = drone-osc instrument (synth.js, hidden) playing `staticVoicing(pc, brightness)` =
`root = 43 + mod12(pc − 7)` (G2..F♯3), `[root, root+7, root+12]` + `root+14` when brightness > .6, velocity .8;
layer gain equal-power fade over `fade` (key change: old layers out, new in; voice attack 50 ms instead of 2.5 s when
something already sounds and the fade is shorter than the voice attack). Synth bus trim = `droneTrim` dB
(`gain-trims.json`); HPF 80 Hz Butterworth. Files mode: pad file for the key (`_fileFor`: major ⇒ key, else relative
minor; minor ⇒ relative major first when `minorUsesRelativeMajorFile`, else minor first) streamed through a pool of
4–6 `<audio>` elements, random start inside the loop region (`ls = min(8, .25·dur)`, `le = dur − min(12, .25·dur)`,
crossfade `min(4, (le−ls)/3)`), loop by equal-power crossfade of two elements, mode switch 50 ms linear; files are
not offline-renderable (warn → synth). Width matrix `L' = aL + bR`, `a = (1+w)/2`, `b = (1−w)/2` (τ 20 ms). Level =
`drone.gain` (tracked), raised by swells toward 1 (`_levelTarget`: `min(4g, g + (1−g)·up)` when g < 1; pedal swell τ
.55 s up / .65 s down; bend swell τ .12 s, fall .65 s; duck `1 − .7·|x|`). Reverb send `sendGate` .4 (synth), 0
(files, frozen loop). Chord-follow (synth only): 150 ms event-time debounce; `followVoicing` (`drone.js:67`, cost
function in its doc comment) with 1.2 s bend glides (24 steps) or 1.5/2 s layer swaps. Park after 10 s at gain 0;
resume 50 ms. Frozen loop (low-resource): the static drone + its reverb rendered offline into a 20 s seamless loop
(preroll 4 s, seam 1.5 s, swap 1.5 s, debounce 2 s, ≤ 12 MB; `drone-freeze.js`) — a CPU workaround for the Web Audio
cost; kept natively (DECISIONS D5): rendered on a worker thread, gated by `config {droneFreeze}` (default true) and
`SongState.lowResource` (O-W3-2). Native pads (T16): decoded to the engine rate on a worker and played from memory
(WAV / MP3 in the core, AAC / M4A through `host.decode_file`), so files mode also renders offline and the loop
crossfade is sample-exact.

### 3.10 Click (`metronome.js`)

`clickSamples(sr, hz, peak)`: 40 ms, `env = min(1,(i+1)/att)·exp(−i/(.008 sr))·min(1,(n−1−i)/(.005 sr))`,
`att = max(1, round(.0003 sr))`, tone `cos(ω) + .25 cos(2ω)`, peak-normalised; accent 1980 Hz peak .5, beat 1320 Hz
.5·.55, sub 1320 Hz .5·.3. Grid from `shared/click-math.js` `ClickGrid`; pump every 50 ms (audio clock), lookahead
0.3 s, first click ≥ 60 ms after start. Bus mono, gain = level (default .6, τ 10 ms). Routing: 'main' → destination
(after the ceiling, so master volume/fade/compressor/sleep never act on it); 'aux' → destination switched to 4
discrete channels, click on 3–4, music on 1–2; record ⇒ also into `recordTap`. MIDI clock 24 ppq (6/8: 36 per
dotted beat) + Start (first downbeat) / Stop to the sink with engine times.

### 3.11 Meters, taps, recording

- `analyserL/R`: fftSize 2048 on `out` (post ceiling). UI: `components/meter.js` reads the time-domain peak of the
  last 2048 frames once per display frame (shared `meterClock`, rAF; paused while hidden / low-resource; ballistics in
  the view: fast attack, ~20 dB/s release, 1.2 s peak hold, clip at > −0.5 dBFS). EQ RTA (`eq-keyboard.js:996`) reads
  `getFloatFrequencyData` (Blackman, smoothing .8 applied per read `[Q]`) of L and R, max per bin, per draw.
- `slotLevel(i)`: fftSize 256 analyser on the strip's pan output (post fader/wheel/width/EQ/pan; mono down-mix
  ½(L+R)), `{peak, rms}` over the last 256 frames per read; reads per display frame via `controller.slotLevel`.
- FX idle taps (internal): analysers on the send inputs, polled every .25 s; an effect sleeps after 1 s below
  −100 dBFS (+ the delay's loop period) — a Web Audio CPU workaround, inaudible (matches a never-sleeping engine to
  the sample).
- `recordTap` = `out` (post ceiling, post sleep ramp, click only with record) → AudioWorklet → 16-bit stereo WAV at
  the context rate (`recorder.js`, `worklets/recorder-processor.js`).

### 3.12 Chromium-shaped behaviour: what the native engine reproduces

| # | quirk (where) | today's result | native must reproduce |
|---|---|---|---|
| Q1 | input summing in hash-set order (any node with ≥ 3 inputs) | ~1e-6 run-to-run noise | nothing; compare goldens at ~1e-5 |
| Q2 | `setTargetAtTime` never ends (`automation.js:56`) | engine adds a set at `t + 12τ` (step of e⁻¹² ≈ 6e-6 of the move) | exponential approach + the snap at 12τ (golden parity); a cheaper "settled" flag is fine |
| Q3 | `cancelAndHoldAtTime` doesn't anchor (`fx.js:33`, CONTRACT_CHANGES top) | every ramp is anchored with an explicit `from` (`linFrom`, `trackedMove`) | ramps from the recorded `from`, i.e. the audible intent; no quirk to copy |
| Q4 | `equalPowerFade` as 16 linear segments (no `setValueCurveAtTime`) | piecewise-linear sin/cos | the same 16-segment polyline (it is audible-identical, but goldens see it) |
| Q5 | BiquadFilter LP/HP `Q` in dB; shelves ignore Q; LP at f ≥ Nyquist = exact bypass | engine converts (`BUTTER2_Q`, `20·log10(q)`) | Web Audio spec coefficient formulas with the dB→linear conversion folded in; keep the Nyquist bypass (sampler tone = 1) |
| Q6 | k-rate biquad params (slot EQ, oscillator detune) | coefficients change once per 128 frames | 128-frame quanta for those params (golden parity) |
| Q7 | `ConvolverNode` (normalisation disabled; FFT partitioning on the main thread) | exact convolution, no scale; builds block the UI thread → quiet-gated builds | plain zero-latency partitioned convolution, L→L/R→R; build off the audio thread; keep crossfades; quiet gating optional |
| Q8 | `DynamicsCompressorNode` (catcher, glue): Chromium/WebKit kernel incl. knee curve, adaptive release, ~6 ms lookahead, automatic makeup `(1/fullRangeGain)^0.6`; detector over-reduces for 100–200 ms after connect | makeup measured at start and cancelled; glue engages 0.3 s late | port the WebKit/Chromium kernel (BSD-licensed, `dynamics_compressor_kernel.cc`) and keep the makeup cancellation, so the audible curve, latency and unity gain match; the 0.3 s engage delay can stay (cheap) |
| Q9 | DelayNode feedback cycle runs one quantum late | `Q = 128/sr` split | delay = `time` exactly, no split (echoes at k·time) |
| Q10 | WaveShaper `4x` oversampler latency (lofi sat, 192 frames) | lofi engage delayed `.0075 + 320/sr` | any oversampler; set the engage delay to its real latency |
| Q11 | FM / oscillator: a-rate frequency input integrated with a half-sample lag; phase advances through unstarted frames of the first quantum (CONTRACT_CHANGES "Chromium FM findings") | instruments compensate (modulator advance `π f/fs`, cosine-phase modulators, FM starts on block boundaries) | the **audible** result (no DC, no start skew); remove compensations the native oscillator doesn't need, or DC returns |
| Q12 | `OscillatorNode` band-limited wavetables; `AudioBufferSourceNode` linear interpolation on repitch (`sampler.js:889`) | the sound of every synth and repitched sample | band-limited oscillators and linear-interpolation resampling for parity (owner question 3) |
| Q13 | `decodeAudioData`: MP3 decode (encoder delay/padding) and resample to the context rate | `processSample` trims the onset at −50 dBFS − 1 ms, so start offsets mostly vanish | decode (minimp3/dr_mp3, AAC via the platform) + a good resampler; tolerance in goldens |
| Q14 | AnalyserNode: time-domain window = last fftSize frames at read time; frequency smoothing per read | meter peaks can miss short peaks between frames; RTA smoothing depends on frame rate | stream peak-since-last-tick (never misses) and smooth the RTA at the stream rate; the view's ballistics stay in JS |
| Q15 | idle CPU workarounds (slot arm/disarm, FX idle sleep, drone park, frozen drone, reverb quiet builds, slot tap release) | inaudible | not required; keep only what the native CPU profile needs; keep `_debugStats` fields with honest values |
| Q16 | `MediaElementSource` pads (streaming, media-clock resync) | loops resynced against `el.currentTime` | sample-accurate native streaming; same loop region and crossfade maths |
| Q17 | timer callbacks realtime late by ≥ one main-thread turn; offline at 128-frame boundaries | | audio-thread timing in realtime; 128-frame quantised in offline parity mode |

---------------------------------------------------------------------------------------------------------------------

## 4. Lifecycle and resources

- **init/start**: lazily on the first `start()`, `prepare()`, `preload()` or `estimatePreloadMB()`. The controller
  starts it from its own `start()` (`controller.js:1855`, after the user gesture / start overlay) and on every audio
  resume; a secondary window (Web Lock `rig-instance` held elsewhere) never starts the engine.
- **suspend/resume**: the watchdog (`controller.js:1601`, every ~1 s) calls `ctx.resume()` while `suspended` or
  `interrupted`; a `running` context whose `currentTime` did not advance for 2 ticks is *stalled* → auto restart
  (≥ 10 s apart). `asleep`/`waking` are excluded.
- **sleep** (lowres2): only in low-resource mode; controller conditions: `audioSleepSec` of no input, not recording,
  `sleepBlockers()` empty.
- **Song switch** (gapless rule): `prepare` while the old song plays; `commit` never decodes, builds or blocks;
  held/pedalled notes continue on retired channels; new note-ons go to the new instruments. Order after commit
  (`controller.js:307`): `setTranspose`, `setRouting`, drone (`setKeyContext`, `drone.setKey`, `drone.configure` or
  `drone.*` setParams), `setTempo`, `setTimeSig`, then catch-up diffs and neighbour preloads.
- **Samples**: factory manifest `app/samples/manifest.json` (23 instruments, 1999 MP3 files, ~80 MB; layers by
  velocity, notes by name, `gainTrim` dB, `release` τ, `widthDefault`, `decodeOpts {maxSec, maxMonoLossDb}`); My
  Samples: server-merged `/api/user-samples/manifest.json` (ids `user:<id>`, group 'My Samples', MP3/M4A(AAC)/WAV from
  `tools/exs/importer.mjs`), loaded only when `/api/health` says `userSamples: true`. Decode (`processSample`,
  `sampler.js:184`): onset at the first |x| > −50 dBFS minus 1 ms; length cap `maxSec` (piano/EP long variants up to
  30 s, else legacy 10 s above C4 / 16 s at or below) with a 1 s fade-out when capped; 2 ms raised-cosine fade-in;
  dual-mono collapse when |L−R| ≤ max(1e-3·peak, 2⁻¹²); optional M/S fix. Cache keys `url` or `url#max=<s>`.
- **Memory policy** (morning-prep, v11-memory): engine cache cap 700 MB (`cacheMB`), low-water 85 %; LRU evicts
  unpinned first; during a switch `protect` = playing + incoming song (pinned buffers of other songs give way, LRU);
  referenced buffers (live or retiring instruments) are never evicted. Controller: `PIN_BUDGET_MB` 600; no setlist ⇒
  current ± 1; setlist ⇒ whole set if it fits, else current ± 2 within the budget (`LARGE_SET_PIN_RADIUS`); unpinned
  warming stops at 80 % of the cap; `status.memory = {mode, decodedMB, pinnedMB, capMB, budgetMB, setMB, windowMB,
  pinnedSongs, note}`. **Native additions (T00c, D3: 16 sampler slots can reference > 2 GB of float32 samples):** a
  hard cap on stored bytes (iPad = the 320 MB cap, desktop 1.5 × 700 MB): a decode that would pass it once nothing
  else can be evicted is refused (the url is marked failed for the retry window; one `warn {code:'memory'}` until a
  later load fits; `stats.capRefused`); pins are limited to 85 % of the hard cap in request order (the rest stay
  unpinned; `warn memory`, `stats.pinsDropped`). The reverb pool's byte cap covers kernels and the running state of
  every render slot (T04 finding 1; `stats.reverbMB`). Budgets per profile: ARCHITECTURE 7.
- **Polyphony (native, T00c / DECISIONS D1)**: per slot, `config {polyphony}` 32 | 64 | 128 (default 64; `get
  state.polyphony`), for every instrument kind (1.x: 16 synth/organ, 32 sampler). At the cap a note-on steals the
  oldest released voice, else the oldest held one (1.x policy, 20 ms fade in the instruments); a free voice is taken
  first. A lower cap does not cut sounding voices: it is enforced at note-on. Voice pools are sized for 128.
- **Total voice limit (native, DECISIONS D4)**: `config {voiceLimit}` 'auto' | 128 | 256 | 512 | 0 (= off; default
  'auto'), echoed with the number in force by the reply and `get state` (`voiceLimit`, `voiceLimitEffective`, 0 =
  off). It counts the held + released voices of every slot and retiring channel (fading steal victims do not
  count). A note-on first applies its slot's cap (above); if the total is then over the limit, the globally
  earliest-released voice (each instrument's own release rule, as for its cap), else the globally oldest held one,
  in any slot or retiring channel, is faded out like a steal (20 ms); at most 4 such steals per note-on, so lowering
  the limit live converges over later note-ons (net 3 voices per note-on) instead of cutting a burst. A change
  applies from the next note-on;
  sounding voices are never cut by the change itself. 'auto' = desktop 128, iPad 64 (`RIG_PROFILE_IPAD`):
  PROVISIONAL numbers sized for <= ~60 % of the 128-frame quantum with every voice held (ARCHITECTURE 7.1 "D4").
  `get stats.voiceLimitSteals` counts its steals. The web engine (1.x) has no such limit.
- **Low-resource mode**: 1.1 above (pins current-only, no warm-ups, no slot taps, idle reverb units dropped, frozen
  drone, audio sleep allowed).
- **Output device**: `settings.outputDeviceId` → `setSinkId` (fallback restart); device list from
  `navigator.mediaDevices.enumerateDevices()` (`views/settings.js:320`, `latencyHint.js:53`,
  `controller.js:2003`) — in a WKWebView this list does not exist, so the bridge must supply it (6.4 `get devices`).
  `settings.latency` → 'interactive' | .01 | .025 s (`LATENCY_MAP`, `controller.js:54`) → restart.
- **Latency reporting**: `latencyMs` = base + output latency; `statechange.latencyMs` → `controller.status.latencyMs`
  (shown in Settings and the latency hint). Native (T00c, D2): `latencyMs` = `tick.hostLatency` = the host's
  `output_latency_sec` (which includes the device buffer it granted) + the frames the 128-frame FIFO holds back for
  that block at most, `128 − gcd(b, 128)` (64 / 192 → 64 frames, 441 → 127, 128/256/512 → 0). `audio
  {bufferFrames}` asks the host for 64 | 128 | 256 | 512 frames (`rig_host.audio_start_frames`, 0 until the UI asks: the host's own
  default, 128 on Apple; a 1.0 host gets `latency_sec = frames / rate`); `state.bufferFrames` reports what the OS
  granted (iPad may round), else the request (default 128).
- **Status**: the engine has no status object; `controller.status` (`controller.js:259-297`) is fed by engine
  events: `audio` ('running'|'suspended'|'stalled'|'restarting'|'asleep'), `latencyMs`, `loading`, `ready`,
  `memory`, `lowResource`, `click{on,counting,available,output,midiClock,midiClockConnected}`, `pedal`.
  Errors: engine `warn` events (deduplicated) and rejected promises of prepare/preload/restart.

## 5. MIDI

**Today** (`midi.js`, Web MIDI; `controller.js:1096-1300`):
- `midi.js` (no audio): `requestMIDIAccess` (with a soft timeout → `pending`), input ranking (`classifyInput`: virtual
  name/manufacturer regexes, vendor and generic-hardware heuristics, remembered keyboards rank 10), selection modes
  'first' (sticky best hardware; all ports + hint when none), 'all', 'device' (by id then name; stand-in while
  absent; `rebind`/`switched`), hot-plug (`disconnected` releases that input's notes and pedal), parsing (running
  status, note-on vel 0 → noteoff, 14-bit bend → −1..1, CC value01, program; aftertouch/clock/active sensing
  ignored; `input` wake signal before parsing), `activity`, learn state machine (`learn(id, {accept, motion,
  timeoutMs})`; CC64 reserved; 120–127 ignored).
- Controller: per-source refcount (`inputId:channel`), learned controls first (buttons with CC retrigger 150 ms,
  faders with pickup ±.02 on the taper position), velocity: keyboard touch curve or `velocitySens`, CC64 with
  `pedalInvert` OR'ed across sources, CC1/11/7 wheels, bend, CC120/123 per source, program change → setlist song,
  touch capture for keyboard calibration, activity → audio wake. MIDI clock out via `midi-clock.js` (Web MIDI send
  with timestamps from the engine clock map).

**WKWebView has no Web MIDI**, so MIDI I/O must be native. Split:

| moves native (CoreMIDI now, WinMM/WinRT later; parsing in the portable core) | stays in JS |
|---|---|
| port enumeration, hot-plug notifications, raw input with host timestamps, the byte parser (port of `_parseBytes`/`_dispatch`), the `input` wake signal, MIDI clock **output** (metronome pump → CoreMIDI with host timestamps; replaces `midi-clock.js`), and in bridge v1.1 the optional **direct perform path** (`midi route`): note on/off with per-source refcount, CC64 + pedalInvert, CC1/11/7, bend, CC120/123, per-keyboard touch curve / velocitySens, learned-control diversion | device ranking and selection policy (`classifyInput`, remembered, sticky/stand-in/rebind), learn state machine, learned-control actions (buttons → controller actions; faders with pickup → `store.set`), program change → song, touch capture, keyboard settings UI, all status/toasts |

v1 default: native forwards parsed messages to JS (`midi` event); a JS `NativeMidiAccess` adapter makes `midi.js`
run unchanged; perform calls come back as `play` messages (one WebView round trip per note: measure on the Mac; open
question 2). The adapter (lane NMA, `app/js/engine-bridge/native-midi.js`): installed only when the bridge engine
runs on a page without `navigator.requestMIDIAccess`; its first `midi listen` is a request whose reply `{ports}` is
the port snapshot (the shell publishes its ports before the page exists); after that it sends `midi listen` with
exactly the inputs midi.js attached (fire-and-forget, one per microtask, only on change), so CoreMIDI connects only
the selected sources and the v1.1 direct path never plays an unselected port; a port missing from a `ports` event
goes 'disconnected' (kept in the map, as Chrome does); `msg.ts` (engine s) maps to page ms through the last tick;
`output.send(data, ts)` → `midi send {port, data, when?}`; installing it also sends one `play {e:'panic'}` right
after `hello` (skeptic NMA F1: the core outlives a page reload, whose new controller cannot release the old page's
notes or pedal). MIDI clock out stays native: `config.midiClock.port`
carries the chosen output's name (midi-clock.js `sink.portId`). The direct path removes the round trip without moving policy: JS pushes the routing table, native plays,
and still forwards each message flagged `handled` so the UI, learn and activity keep working.

---------------------------------------------------------------------------------------------------------------------

## 6. BRIDGE v1

### 6.1 Transport and envelope

- JS → native: `window.webkit.messageHandlers.rig.postMessage(msg)` (Apple), `window.chrome.webview.postMessage`
  (Windows later). `msg` is a plain JSON object (no stringify needed on Apple).
- native → JS: `window.__rigNative.receive(batch)` via `evaluateJavaScript` (Apple) / `PostWebMessageAsJson`
  (Windows); `batch` is one message or an array of messages delivered in order (native batches everything queued in
  one main-thread turn).
- Envelope, both directions: `{v: 1, ...}`. Requests/commands: `{v, op, id?, ...args}`. A message **with** `id`
  gets exactly one reply `{v, re: id, ok: true, result}` or `{v, re: id, ok: false, error: {code, message,
  detail?}}`; **without** `id` it is fire-and-forget (errors surface as a `warn` event, deduplicated). Any op may be
  sent either way; the shim uses ids where `audio.js` returns a value the caller awaits. Events: `{v, ev, ...data}`.
- Ids: positive integers, unique per page load; replies can arrive out of order (a long `prepare` vs a quick `get`).
- Ordering: native processes JS messages strictly FIFO on one control queue; async work (decode, IR, device open)
  starts in order and completes later without blocking the queue — the same semantics as the JS engine's promises.
  `play` and `set` after a `commit` (in queue order) apply to the committed song.
- Binary payloads: none, except the optional RTA spectrum (base64, 6.5), justified by size (1024 bins × 2 ch at
  30 Hz as JSON numbers ≈ 0.5 MB/s vs 41 kB/s). Audio, sample data and IRs never cross the bridge; pad files and My
  Samples are referenced by path/URL and read natively.

### 6.2 Versioning and errors

`hello` must be the first message; native replies `{protocol: 1, minor, engine: 'worship-rig-core <semver>', caps:
[...], sampleRate, seed}`. Rules: unknown fields are ignored both ways; additive changes bump `minor` and add a
capability string (minor 1 = T00c `polyphony` / `bufferFrames` / `slots16`, 2 = `voiceLimit`, 3 = `droneFreeze`,
4 = `dynamicRange`, 5 = `getParam`: `get {what:'param'}`, CORE2B; a minor-5 core also has CORE2A's timing, no
shape change: `cache preload` answered without blocking the control loop, a realtime `prepare` answered once its
samples are decoded; and CORE3's: a realtime `prepare` builds its synth / organ units off the control loop and is
answered once they are built too, a pinned `cache preload` of at most 5 songs prebuilds their synth / organ units in
the background so a switch to one builds nothing; and lane F1's: the core sends the 6.5 `load {phase:'samples'}`
event after a preload's decodes, once a prepare's samples settle (before either reply) and after a pin re-warm pass,
already in v1, no shape change; the shim keeps `get sampleStatus` as a fallback; and lane F2's: the same event, at
most once per control tick, for the already-reported samplers whose state an eviction, a memory-pressure / low-resource
trim or a rate change changed, naming those ids only); a breaking change bumps `v`; a native that receives another `v` replies `{ok:false, error:{code:
'protocol'}}` and ignores the message; the JS shim refuses a major mismatch (the app shows the engine as
unavailable). Error codes: `protocol`, `bad-request` (schema), `unknown-op`, `unknown-param`, `not-started`,
`stale-token`, `superseded`, `decode` (sample/pad file), `device` (audio device open/route), `unsupported` (cap
missing, e.g. aux click on a 2-ch device), `busy` (restart in progress), `internal`. Warnings keep the JS engine's
texts where `main.js` matches them (`engine.<name> failed`, `No pad file for <key>; using the synth drone.`, …).

### 6.3 Timing model

- **Engine time `t`** (seconds, double) = frames rendered by the engine core / sample rate, counted from engine
  creation, monotonic for the life of the native engine. It keeps running across device restarts and output changes
  (a sample-rate change continues from the current `t`); it pauses while asleep (like a suspended AudioContext).
- **`when`** in any message is engine time. Absent, null, or ≤ the engine's current render position ⇒ *now* = the
  first frame of the next block the audio thread renders after dequeuing the message. Later ⇒ sample-accurate at
  `round(when·sr)` (the core splits blocks at event frames). Internal timers (the JS `AudioTimer` callbacks) run on
  128-frame quanta, so offline goldens line up with `fx.js:180`.
- **How JS learns `currentTime`**: every `tick` carries `t` (engine time of the last rendered frame when the tick was
  produced) and `hostLatency`; the shim keeps `currentTime = t_tick + (performance.now() − perfAtReceive)/1000`,
  capped at `t_tick + 0.25 s` so a stalled engine looks stalled to the watchdog (it compares successive reads), and
  never decreasing. `ctx.getOutputTimestamp()` returns `{contextTime: t_tick − outputLatency, performanceTime}`.
- **Latency budget**: JS → native postMessage + control queue → next audio block. Hot-path inputs from JS carry no
  timestamp (as today) and play at the next block. The native MIDI direct path stamps notes with the CoreMIDI host
  time mapped to frames (+ one block of fixed delay, jitter-free) — option `route.jitterFree`.
- Golden renders use the **same message vocabulary** with explicit `when` (an ordered JSON-lines script fed to the
  core's offline renderer), so tests, goldens and the live bridge share one contract.

### 6.4 Messages: JS → native (14 ops)

| op | args | reply `result` | replaces |
|---|---|---|---|
| `hello` | `{protocol:1, app, caps?}` | `{protocol, minor, engine, caps, sampleRate, seed}` | — |
| `audio` | `{action:'start'\|'restart'\|'output'\|'sleep'\|'wake', latency?, deviceId?, ramp?, bufferFrames?: 64\|128\|256\|512}` (T00c, D2: host buffer size, default 128, kept across restarts) | `{state, sleep, latencyMs, sampleRate, deviceId, channels, bufferFrames}` (granted size); sleep/wake: `{done: bool}` | `start`, `restart`, `setSinkId`, `latency=`, `sleep`, `wake` |
| `prepare` | `{patch}` | `{token}` | `prepare` |
| `commit` | `{token, when?}` | `{committed: bool}` | `commit` |
| `cache` | `{action:'preload'\|'estimate'\|'retainReverb', patches, pin?}` | preload `{decodedMB, pinnedMB, deferred}`; estimate `{mb, exact, samples, capMB}`; retain `{ok}` | `preload`, `estimatePreloadMB`, `retainReverb` |
| `set` | `{path, value, glide?, when?}` or `{batch:[[path, value, glide?], …], when?}` | `{applied: bool}` (or bool[]) | `setParam` |
| `song` | `{transpose?, routing?, tempo? (null = none), timeSig?, newBar?, key?:{pc, minor}}` | `{}` | `setTranspose`, `setRouting`, `setTempo`, `setTimeSig`, `setKeyContext` (applied in that field order) |
| `drone` | `{key?:{pc, minor, fade?}, config?:{song.drone}, files?:[{name, path}]}` | `{files?: count, changed?: bool}` | `drone.setKey`, `drone.configure`, `drone.attachFiles` (applied key → files → config) |
| `play` | `{e:'on', n, vel, touch?}` \| `{e:'off', n}` \| `{e:'pedal', down}` \| `{e:'wheel', src:'mod'\|'expr'\|'vol'\|'virtual', value, glide?}` \| `{e:'bend', x}` \| `{e:'swell', start?}` \| `{e:'panic'}` \| `{e:'fade', seconds?}` \| `{e:'input'}` — each with optional `when` | `{ok: bool}` | `noteOn/noteOff/sustain/modWheel/expression/volumeCC/setWheel/pitchBend/swell/allNotesOff/fadeOutAll/noteInput` |
| `click` | `{action:'start'\|'stop'\|'config', countIn?, quietAfter?, level?, record?, output?, when?}` | start `{t0, downbeat}\|null`; stop `{wasRunning}`; config `{output, auxAvailable}` | `clickStart`, `clickStop`, `setClick` |
| `config` | `{mono?, lowResource?, eqAudition?:{slot, mode}, meters?:{rate?, slots?:[i…], rta?: bool}, midiClock?:{port: id\|null}, polyphony?: 32\|64\|128, voiceLimit?: 'auto'\|128\|256\|512\|0, droneFreeze?: bool, dynamicRange?: number}` (T00c, D1: voices per slot, default 64; D4: total voices, 0 = off, default 'auto'; D5 / T16: `droneFreeze` true (default) = the drone plays a frozen loop while `lowResource` is on, as 1.x; false = always the live drone; T12 O1 / UIB, minor 4, capability `dynamicRange`: `settings.dynamicRange` 1..3, default 1, clamped and rounded to 0.01 like `validDynRange` (a non-finite number = 1, a non-number = `bad-request`), kept for samplers built later) | `{lowResource?, eqAudition?: bool, polyphony?, voiceLimit?, voiceLimitEffective?, droneFreeze?, dynamicRange?}` | `setMono`, `setLowResource`, `eqAudition`, meter/slot-tap/RTA subscriptions, `setClockSink`, `setDynamicRange`, the native-only Sound setters |
| `get` | `{what:'instruments', reload?: bool}` \| `{what:'stats'}` \| `{what:'devices'}` \| `{what:'sampleStatus', patches}` \| `{what:'state'}` \| `{what:'param', path}` (CORE2B, minor 5) | instruments `[entry + range?]`; stats `_debugStats`; devices `[{id, name, channels, default, sampleRates}]`; sampleStatus `{loaded: bool[], failed: bool[]}`; state `{patch, routing, transpose, tempo, timeSig, keyContext, drone, mono, runtime, click, sleep}` (+ native `polyphony`, `voiceLimit`, `voiceLimitEffective`: D1, D4; `dynamicRange`); param `{path, value?}` (`value` absent = undefined; a path outside the grammar = `unknown-param`, no `path` = `bad-request`) | `listInstruments`, `reloadManifests`, `_debugStats`, `enumerateDevices`, `cache`/`registry` reach-in, `getState`, `getParam` |
| `midi` | `{action:'listen', ids:[…]}` \| `{action:'route', on, learn:{…}, pedalInvert, velocitySens, touch:{deviceName: spec}, jitterFree?}` \| `{action:'send', port, data, when?}` | `{ports?}` | Web MIDI access (`midi.js` adapter), the direct perform path |
| `rec` | `{action:'start', dir?, filename?, bits?: 16}` \| `{action:'stop'}` | start `{path}`; stop `{path, seconds, bytes}` | `recordTap` + `recorder.js` worklet/sinks |

### 6.5 Messages: native → JS (9 events + replies)

| ev | data | replaces / feeds |
|---|---|---|
| `state` | `{state:'running'\|'suspended'\|'interrupted'\|'closed', sleep:'awake'\|'sleeping'\|'asleep'\|'waking', latencyMs, sampleRate, deviceId, channels, bufferFrames, restarted?, wakeMs?, queued?}` (`bufferFrames`: the host block the device granted, else the request; T00c D2) | `statechange`, `sleep`, `ctx.state`, `latencyMs`, `sleepState`, `clickOutputs` |
| `tick` | `{t, frames, out:[peakL, peakR], slots?:[[peak, rms] × max(4, song slots) ≤ 16], rta?: base64(Uint8 1024·2, 0.5 dB steps down from 0 dBFS), blockers:[…], pedal, held:n, runtime:{wheel, modOwner, faded, swelling}, cpu, stats? (every 1 s)}` at `config.meters.rate` (default 30 Hz; 4 Hz when no meter is subscribed; none while asleep) | `currentTime`, `analyserL/R` peaks, `slotLevel`, RTA, `sleepBlockers`, `pedal`, `wheelValues`, `getRuntimeState`, `_debugStats` |
| `notes` | `{held:[n…], chord?: {name, root, quality, bass}\|null}` (`chord` key present only when it changed) | `notes`, `chord` |
| `wheel` | `{source, value, hardware?, pickup?}` | `wheel` |
| `load` | `{phase:'slot', slot, progress, token}` \| `{phase:'start'}` \| `{phase:'preload', decodedMB, pinnedMB, deferred}` \| `{phase:'instruments', count}` \| `{phase:'samples', loaded:{id: bool}}` | `loading`, `ready`, `instruments`, "Loading n/m" |
| `click` | metronome state `{running, counting, bpm, sig, output, level, record, downbeat}` | `click`, `clickState` |
| `warn` | `{message, code?, op?}` | `warn` |
| `midi` | `{type:'ports', ports:[{id, name, manufacturer, state, kind}]}` \| `{type:'msg', port, data:[bytes], ts, handled?}` \| `{type:'learned', id, value\|pressed}` | Web MIDI `MIDIAccess` inputs/statechange/onmidimessage (adapter), direct-path diversions |
| `rec` | `{state:'recording'\|'stopped'\|'error', path?, level?:{peakL, peakR}, message?}` | recorder `state`/`level`/`warn` |

Reply: `{v, re, ok, result | error}` (not an event).

### 6.6 What the JS shim answers locally (no message)

`getEqResponse` (`shared/eq-math.js` `eqResponseDb` at the engine's `sampleRate`; same Web Audio formulas — open
question 5), `getSlotPlayRange` (patch + `transpose` + the instrument entry's `range`), `commit()`'s boolean (the shim
knows the latest token and whether it was committed; the native engine never discards a plan on its own, so the
synchronous answer is exact; the reply is a cross-check), `listInstruments` (cached from `get instruments`, refreshed
on `load {phase:'instruments'}`), `wheelValues`/`getRuntimeState`/`pedal`/`sleepBlockers`/`_debugStats`/
`slotLevel`/`clickState` (latest `tick`/events), `analyserL/R` facades (`getFloatTimeDomainData` writes the tick
peak at index 0 and zeros elsewhere — enough for `meter.js`; `getFloatFrequencyData` decodes the RTA, subscribing on
the first read and unsubscribing after 2 s without one), `ctx` facade (`state`, `currentTime` per 6.3, `sampleRate`,
`baseLatency`/`outputLatency` from `latencyMs`, `resume()` → `audio start|wake`), `applyRuntimeState` (no-op: native
state survives device restarts), `drone.cfg/key/files` (mirrors of what was sent), `getParam` (CORE2B: a mirror;
per path, the core's last `get param` answer unless a later `setParam` of that path or a `commit` overtook it,
else the shim's own PARAMS-clamped `setParam` value since the last commit, else the committed patch
(`engine-bridge/param-read.js`); a read that is not a core answer sends one `get param`, queued behind the pending
`set`s, so the next read returns the core's value; `drone.configure` drops the `drone.*` entries).

---------------------------------------------------------------------------------------------------------------------

## 7. Ambiguities resolved by reading code

1. *Who passes `{when}`?* Nobody in the live app (grep `when` in `controller.js`): realtime calls are "now"; `when`
   matters for offline renders only. The bridge keeps it for goldens and future scheduling.
2. *Is `commit` sync?* Yes; the controller tests `=== false` synchronously (`controller.js:441,509`). Resolved in the
   shim (6.6), not by a blocking bridge call.
3. *`stats` event*: emitted, never listened to ⇒ dropped from the contract (stats ride on `tick`).
4. *`restart` semantics*: Web Audio restart = new context; state is re-applied, so `applyRuntimeState` and
   pad-file re-attachment exist only for that. Native device restarts keep engine state ⇒ these become no-ops; the
   controller's recovery path still runs harmlessly (`statechange {restarted:true}` is still sent).
5. *Drone files*: URLs today (`/pads/<token>/…` served by `server.js`); natively they are file paths ⇒ `drone.files`
   takes `{name, path}`; the shim maps the server URL back to the path (the native shell owns the pad folder).
6. *Chorus rate range*: PARAMS allows .05..3 Hz, the DSP clamps .15..1.5 (`fx.js:1364`) — contract = the DSP clamp.
7. *Width range*: PARAMS 0..1.5; strip clamps the product with `widthDefault` to 0..2.25 (`fx.js:2053`).
8. *Legacy EQ rows*: still honoured, but only for a band without b-rows (`fx.js:1650-1693`).
9. *Velocity 0*: `noteOn(n, 0)` is a noteOff (`audio.js:2117`); `midi.js` already turns it into `noteoff`.
10. *Song transpose range*: ±48 in the engine (`audio.js:1682`) though the UI offers less.
11. *Instrument channel count*: the strip keeps whatever the instrument outputs; sampler and synth-extra force
    stereo so a centred slot is not −3 dB (`sampler.js:892`, `synth-extra.js:325`) ⇒ pan law depends on it.
12. *`main.js` "Loading n/m"* reads `engine.cache`/`registry` internals ⇒ replaced by `load {phase:'samples'}`
    (native pushes per-instrument loaded flags) / `get sampleStatus`.
13. *Device list*: comes from `navigator.mediaDevices`, not the engine ⇒ new `get devices` (+ `state` on change).
14. *Recording*: tied to `recordTap` + AudioWorklet ⇒ native `rec` op; WAV 16-bit stereo at the device rate, the
    Electron file naming `Rig YYYY-MM-DD HHmm.wav` in `~/Music/Worship Rig/`.
15. *Instrument RNG seeds* depend on a lifetime instrument counter (`audio.js:620`) ⇒ goldens must replay the same
    prepare history; the native engine keeps the same counter.

## 8. Open questions for the owner

1. **Bootstrap switch**: `main.js:5,126-128` constructs `AudioEngine`, `MidiInput` and `Recorder` directly; the native
   build needs `NativeEngine`/`NativeMidiAccess`/`NativeRecorder` there (or `engine/index.js` exporting the native
   class when `window.webkit.messageHandlers.rig` exists). One small edit to an app file — OK, and which file?
2. **MIDI latency path**: accept one WebView round trip per note in v1 (measure on the Mac first), or ship the native
   direct path (`midi route`) from day one? It needs a small controller change (skip engine calls for `handled`
   messages).
3. **Parity target for oscillators and sample repitching**: Chromium-exact (band-limited wavetables, linear
   interpolation) so goldens match tightly, or better-quality (polyBLEP/minBLEP, cubic/sinc) with goldens compared
   spectrally? Affects every synth and sampler test.
4. **Compressors**: port the WebKit/Chromium DynamicsCompressor kernel (BSD) for an exact catcher/glue match (my
   recommendation), or design a cleaner limiter and re-calibrate levels?
5. **EQ response for the editor**: compute in the shim with `shared/eq-math.js` (no round trip; must equal the native
   biquads), or add `get eqResponse` (async; the editor currently expects a sync answer)?
6. **Sample rate**: run the core at the device rate (44.1/48 kHz, as Web Audio does) or fixed 48 kHz with
   resampling at the device? Goldens are produced at 44.1 and 48 kHz today.
7. **Low-resource workarounds**: keep the frozen drone, FX idle sleep, slot disarm and reverb quiet gating natively,
   or drop them (native cost profile differs; they are inaudible)? `_debugStats` fields and tests depend on them.
8. **Pad files**: native streaming of MP3/M4A/WAV pads from the pad folder (AVAudioFile on Apple) — OK to drop the
   `<audio>` pool semantics (random start, resync) as long as the loop region and crossfades match?
9. **Recording format**: keep 16-bit WAV, or take the chance to record 24-bit/float natively?
10. **Meter stream rate**: 30 Hz default (UI draws at the display rate and interpolates) — or 60 Hz on ProMotion?

## 9. Size estimate per engine module

JS lines (`wc -l`, total 12 113 lines / 513 KB in `app/js/engine/*.js` + the shared modules they import). DSP
complexity of the port: S = straightforward, M = careful, L = large or parity-critical.

| module | lines | DSP | port notes |
|---|---|---|---|
| `audio.js` (engine orchestration) | 2488 | S (logic L) | patch normalisation, prepare/commit/retire, wheels/macros/swell/bend/tape, notes/pedal/mono, sleep, click glue, stats |
| `fx.js` (graph, reverb, delay, chorus, lofi, slot EQ, width, glue, catcher, clip, timers, coalescer) | 2463 | L | partitioned convolution + IR generator (bit-exact goal), WebKit compressor kernel, biquads per Web Audio spec, crossfading EQ chains |
| `drone.js` | 1241 | M | layers, voicing, chord-follow, files streaming + loop xfade, swells, park |
| `synth-extra.js` (10 patches) | 1095 | L | supersaw, FM e-piano, plucks, brass; ceiling; Chromium oscillator compensation (Q11) |
| `sampler.js` (instrument + BufferCache + decode) | 963 | M | decode/trim/caps/dual-mono, LRU with pins/protect/refs, repitch (Q12), release |
| `voice.js` (shared voice architecture) | 886 | M | envelopes, oscillator banks, filters, mono-below, tracked params |
| `synth.js` (7 patches incl. drone-osc) | 763 | M | pads, FM soft-keys/bell |
| `instruments.js` (registry, fallback synth, allocator) | 650 | S | manifest loading, catalogue, voice stealing (1.x: 16 voices, sampler 32; native: 32/64/128 per slot, T00c) |
| `metronome.js` | 390 | S | click synthesis, grid pump, aux routing, MIDI clock |
| `organ.js` (4 presets) | 365 | M | drawbars, percussion, rotary speaker, clip |
| `drone-freeze.js` | 290 | S | offline loop render (may be dropped, question 7) |
| `index.js` | 14 | — | exports |
| shared used by the engine: `automation.js` 200, `params.js` 421, `touch-curve.js` 191, `prng.js` 101 (bit-exact), `click-math.js` 267, `chords.js` 101, `music.js` 170, `keydetect.js` 114 | 1565 | S | pure; `params.js`/`touch-curve.js` also stay in JS |
| outside the engine, moving native: `worklets/recorder-processor.js` 84 + recorder sinks, `midi-clock.js` 141, `midi.js` parsing (~150 of 583) | ~375 | S | |
