# Worship Rig SPEC v2: Adversarial Review

Severity: **B** = blocker (won't work as written, or will fail on stage). **M** = major. **m** = minor.
**(verify)** = I'm reasoning from memory of Chromium/Electron internals and haven't checked it against the pinned version. Turn each one into a Phase-1 spike check. Don't take it as fact.

---

## 1. Correctness / feasibility

**1.1 [B] A release scheduled during an attack ramp doesn't release.**
The pads use a linear-ramp attack (warm-pad is 1.2 s). If noteOff lands before the ramp ends, `setTargetAtTime(0,t,τ)` gets inserted *before* the pending ramp-end event on the timeline. The ramp then pulls the gain back up to 1 and holds it there, and the scheduled `stop()` cuts the voice off. Every short tap on a pad gives a hanging swell plus a click. The same class of bug hits `linear/exponentialRampToValueAtTime`: a ramp starts from the *previous event's* time and value, not from "now", so there's an instant jump if nothing anchors it (drone glide, faders, mod wheel).
*Fix:* one mandatory helper in `engine/audio.js`, and nobody calls the automation primitives directly:
```js
export const rampTo  = (p,v,t,tc)  => { p.cancelAndHoldAtTime(t); p.setTargetAtTime(v,t,tc); };
export const glideTo = (p,v,t,dur) => { p.cancelAndHoldAtTime(t); p.exponentialRampToValueAtTime(Math.max(v,1e-4),t+dur); };
```
Define "release" as the time to reach −60 dB, so τ = release/6.9, and `stop(t + release*1.3)`.

**1.2 [B] "Old voices get noteOff+release" on commit contradicts "never gap", and the §11 gapless test.**
Say the player is holding a chord (or the pedal) when Next fires. Commit releases the old patch's held voices, and the new patch has nothing sounding until the next keystroke. For piano (0.35 s release) that falls far below −60 dBFS within the 20 ms window, so the test fails by construction.
*Fix:* use MainStage semantics. On commit, old-instrument voices that are physically held or pedal-held keep sounding until their own note-off or pedal-up. Only *new* note-ons go to the new instrument. Old instruments move to a `retiring` list and get `dispose()`d only after their live voice count has been 0 for 1 s. Rewrite the test to match: held notes must stay above threshold until key-up.

**1.3 [B] Stuck notes when transpose, octave, or split changes while notes are held.**
`noteOff(note)` recomputes the sounding pitch using the *current* transpose, slot octave and transpose, and range. Easy Transpose, a ±1 button or a song switch between the on and the off means the off misses its voice.
*Fix:* at noteOn, the engine records `sounding: Map<physicalNote, {slot,voice}[]>`. noteOff and pedal-up release exactly those voices. Evaluate split ranges once, on the physical (Play-In) note, at noteOn.

**1.4 [B] A MediaElementSource fed from `pads://` inside an `app://` page outputs silence.**
A different scheme makes the media cross-origin. Chromium feeds zeros into `MediaElementAudioSourceNode` for cross-origin media unless the element has `crossOrigin='anonymous'` *and* the response carries `Access-Control-Allow-Origin`. The `corsEnabled` privilege doesn't add that header. Nothing throws, so the drone just never sounds.
*Fix:* serve pads same-origin (see 1.5). Failing that, set `audio.crossOrigin='anonymous'` and put ACAO on every pads response, 206s included. The test must measure RMS *through* the node, not just check that `currentTime` advances.

**1.5 [M] Replace both custom protocols with a localhost server inside Electron main.**
Two privileged schemes, hand-rolled Range handling in `protocol.handle`, and module/worklet fetches under a custom scheme make up the riskiest part of the shell. Those are the areas where Electron has regressed before: exact MIME needed for module scripts, `audioWorklet.addModule` under custom schemes, `net.fetch(file://)` not honoring Range (verify). Also, `app://./index.html` on a *standard* scheme puts `.` in the host.
*Fix:* Electron main runs a node `http` static server on `127.0.0.1:8438` (fixed port) serving `app/` and `/pads/<token>/<relpath>`. Range comes from `fs.createReadStream({start,end})` returning 206 with Content-Range and Accept-Ranges. The window loads `http://127.0.0.1:8438/index.html`. That's a secure context, pads are same-origin, worklets and modules load normally, and the Chrome path becomes byte-identical. The port must stay fixed because localStorage and IndexedDB are per-origin: a random port means an empty song library on every launch. If you keep the protocols anyway, use `app://rig/…`, implement Range by hand, and test worklet loading inside Electron in Phase 1.

**1.6 [M] Worklet loading needs a fallback, and the recorder has none.**
The bitcrusher→WaveShaper fallback does nothing for `recorder-processor.js`.
*Fix:* the loader tries `addModule(url)`. On failure it fetches the source text and calls `addModule(URL.createObjectURL(new Blob([src],{type:'text/javascript'})))`. CSP must allow `script-src 'self' blob:`. If the recorder worklet still fails, show a visible "Recording unavailable" state.

**1.7 [B] Injecting an OfflineAudioContext can't drive the engine as specified.**
(a) The public `noteOn(note,vel)` has no time argument, so offline tests and the §12 audition pack can't schedule a progression. (b) Main-thread timers don't advance with offline rendering: the 150 ms chord-follow debounce, mono glide, the file-loop crossfade, deferred dispose. (c) `createMediaElementSource` doesn't exist on OfflineAudioContext. (d) `resume()` on an un-started offline context rejects.
*Fix:* every public engine method takes an optional `when` (ctx seconds, defaulting to `ctx.currentTime`). All internal timing derives from event times, never `setTimeout`: debounce by comparing timestamps, dispose via source `onended`. `start()` detects `OfflineAudioContext`, skips resume, and disables files mode with a warning. Tests render the buffer, then analyze it in JS.

**1.8 [M] Recorder correctness.**
- An `AudioWorkletNode` whose output isn't connected may not get pulled (verify). Use `{numberOfInputs:1, numberOfOutputs:0}`, or connect output → `Gain(0)` → destination.
- Header: `ctx.sampleRate` (usually 48000 on a Mac, not 44100). Clamp to ±1 before Int16, because the limiter isn't a brickwall (1.9).
- Crash safety: write a provisional header at open and re-patch it every ~10 s (`fs.write(fd,hdr,0,44,0)`, which needs `fs.open` in `'w+'`; a `createWriteStream` can't seek). An Electron crash mid-set then still leaves a playable file.
- Chrome's FSA writable writes to a `.crswap` file and only produces the real file on `close()`, so a tab crash loses the recording. Document that. Auto-stop on `pagehide`.
- `streamOpen` must return a Promise because IPC is async. Transfer the buffers: `port.postMessage(buf,[buf])`.

**1.9 [M] DynamicsCompressor is neither a brickwall nor free.**
Chromium's compressor has a fixed lookahead of about 256 frames (~5 ms) and applies automatic makeup gain (verify). With threshold −1 and ratio 20, transients overshoot, *every* note gets ~5 ms of added latency, and knee 0 pumps on loud sustained pads.
*Fix:* gain-stage so the limiter rarely engages (3.4, plus a master default of −6 dB). Set the compressor to threshold −3, knee 3, ratio 12, release 0.25 as a catcher, then add a `WaveShaper` tanh soft-clip (`oversample:'4x'`, ceiling ≈ −0.3 dBFS) as the real ceiling.

**1.10 [M] The transpose formula is contradictory.**
The §2 comment argues with itself. "Signed shortest path" is ambiguous at 6 semitones, and `transposeOctave` isn't in the Song schema.
*Fix:* `semis = ((hear - play + 18) % 12) - 6` gives −6..+5. Add `Song.transposeOctave ∈ {-1,0,1}`, total = `semis + 12*oct`. Clamp sounding notes to 0..127 and to the instrument's range (skip, warn once).

**1.11 [M] Sustain edge cases are undefined.**
(a) Re-striking a pedaled note stacks identical voices: +6 dB and comb filtering. *Fix:* fade the previous same-note voice on that slot over 30 ms, then start the new one. (b) Pedal polarity: many footswitches read inverted, and Web MIDI can't read the state until the pedal moves. *Fix:* `Settings.pedalInvert` plus a "press your pedal" step on first run. (c) Half-pedal: threshold at ≥ 64. (d) `mono:'lowest'` picks the lowest *physically held* key, and the pedal only defers the final release. (e) Pedal state is engine-global and carries across song commits.

**1.12 [M] The chord-follow algorithm is ill-posed.**
It says "up to 4 pitches", but the drone voicing has 5 voices. It doesn't say whether the bass voice counts toward the 4, or which pitch classes win when more than 4 are held. Right-hand melody notes make the drone chase the melody. And "minimize total movement" on its own collapses voices into clusters (a semitone at C2 is mud). A 1.2 s exponential glide across a third sounds like a siren.
*Fix:* input = held notes below `followSplit` (default C4, i.e. the left hand) ∪ the lowest held note; fewer than 2 pitch classes → hold the last chord. Voices: a bass voice (lowest pc, C2–B2) plus 3 upper voices in C3–C5, choosing pcs by priority 3rd > 7th > 5th > 9th > root. Cost = Σ|movement| + 6·(intervals < 3 semitones below C3) + 3·(duplicate pitches), enumerated exhaustively (tiny). Glide only when |Δ| ≤ 2 semitones. Otherwise crossfade: old out over 1.5 s, new in over 2 s. (Recommended cut for v1 anyway, see 5.1.)

**1.13 [M] The `detectKeyFromName` rules contradict their own test table.**
Case-insensitive matching makes `m` (minor) the same as `M` (major), and makes the article "A" ("A Mighty Fortress Pad in D") or a stray "e" match as keys. In JS regex `\b`, `_` is a word character and `#` is not, so `\bF#m\b` fails on `Ambient_Pad_-_F#m.mp3`.
*Fix:* tokenize first: `base.split(/[\s_\-().,\[\]]+/)`. Per-token grammar, case-sensitive for the letter and `m`/`M`: `^([A-G])(#|♯|b|♭|sharp|flat)?(m|min|minor|maj|major|M)?$`, plus two-token forms (`E flat`, `F minor`, `Key of X`, `in X`). Scoring: "key of"/"in" > token with an accidental or quality > bare capital letter. A bare `A` counts only if it's the last candidate. Tied candidates for different keys → `null`. Map Cb, Fb, E# and B#. Add table cases: `"A Mighty Fortress Pad in D"`→D, `"Emin"`→E minor, `"CM7 Pad"`→C, `"Pad_Bb_minor"`→Bb minor, `"Deep Ambient"`→null, `"Pad C3"`→C.

**1.14 [M] Delay line bugs.**
`ctx.createDelay()` defaults to a *1.0 s* maximum, but the spec asks for 1.5 s (a quarter note at 40 bpm), so it gets clamped silently. Ramping `delayTime` with feedback also pitch-warps the tails on every song switch where the tempo differs.
*Fix:* `createDelay(2)`. Clamp feedback to ≤ 0.9 with the tone LPF inside the loop. Use two delay lines and crossfade (like the IR) whenever time changes by more than 5 %.

**1.15 [M] The reverb crossfade needs a state machine, and its main-thread cost.**
Setting `convolver.buffer` preprocesses the IR synchronously on the main thread: tens of ms for a 9 s stereo IR (verify). If that happens at commit, MIDI stalls mid-switch. Moving the size knob fast re-sets the buffer on the convolver that's still fading out, truncating its tail. And `normalize=true` makes loudness differ between size buckets.
*Fix:* set `buffer` on the idle convolver during *prepare*. Debounce size changes by 300 ms. Never touch a convolver whose output gain hasn't sat at 0 for the whole fade. Use `normalize=false` with your own energy normalization. Disconnect the idle convolver's input after the fade to halve CPU.

**1.16 [M] MIDI input foot-guns: Program Change, 'all' inputs, permissions.**
Many keyboards send Program Change at power-up or when a panel button is touched, and each one jumps the song mid-service. Merging `'all'` inputs double-triggers when a keyboard exposes 2 ports, or when an IAC/DAW port echoes it.
*Fix:* Program Change off by default (Settings toggle, 1-based display). Default input = first non-virtual device, with 'all' as an option. Refcount per note so a duplicate note-on doesn't add a voice. Handle note-on with velocity 0 as note-off, and 14-bit bend as `(v-8192)/(v<8192?8192:8191)`. In Electron, install *both* `setPermissionRequestHandler` and `setPermissionCheckHandler`. Don't request sysex, which triggers the scarier prompt. Chrome now prompts even for plain MIDI (verify), so the first-run hint must say "click Allow".

**1.17 [M] Electron menu accelerators on bare ← → steal the arrow keys window-wide.**
Text fields and range inputs stop responding to arrows. In the renderer path, ← on a focused fader moves the fader *and* changes the song.
*Fix:* no bare-key accelerators (use ⌘←/⌘→, or none). The renderer handles song keys only when `activeElement` isn't input/textarea/select/range. Computer-keyboard notes ignore `e.repeat` and input focus. Space works as sustain only when no button has focus; blur buttons after click.

**1.18 [M] Module format: the preload and the node tests pull in opposite directions.**
A root `"type":"module"` makes `preload.js` ESM, which sandboxed preloads can't load. Without it, `node --test` can't import the ESM files under `app/js/**`.
*Fix:* root package stays CommonJS (main.js, preload.js). Add `app/package.json` = `{"type":"module"}`. Pure modules (keys, transpose, chords, voicing, WAV header, store) must have no top-level DOM or Web Audio imports.

**1.19 [M] `identity:null` probably does not ad-hoc sign (verify).**
arm64 macOS needs at least an ad-hoc signature, and electron-builder skips signing when identity is null. Bundle modifications can then leave a broken seal: "damaged" or a crash on launch.
*Fix:* `mac.identity: '-'`, or a post-build `codesign --force --deep -s - "Worship Rig.app"`. Target `dir` only (drop dmg; hdiutil is one more failure point). README fallback: `xattr -cr`.

**1.20 [M] The Python launcher isn't guaranteed to work on a Mac.**
Without Command Line Tools, `/usr/bin/python3` is a stub that pops an installer dialog. Closing Terminal kills the server, so samples not yet fetched 404 mid-service. A second launch hits EADDRINUSE.
*Fix:* `node serve.mjs` (Node is already needed for the build). It detects and reuses an existing server, and the page preloads the whole setlist at load. Launch Chrome with a dedicated profile:
`open -na "Google Chrome" --args --user-data-dir="$HOME/Library/Application Support/Worship Rig Chrome" --app=http://127.0.0.1:8437/ --autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding`.
That removes click-to-start, extension scripts injected into the page, Memory Saver tab discarding, and shared permission state (verify the flag names on current Chrome).

**1.21 [m] MediaElement looping details.**
Commercial pad files usually fade in and fade out, so looping end→start dips. `duration` on a VBR MP3 without a Xing header is an estimate. `play()` takes 50–300 ms. A linear crossfade of uncorrelated material dips 3 dB. Two elements per key × 12 keys = 24 media players, which risks idle-suspend and decoder limits.
*Fix:* loop region `[8 s, duration−12 s]` (configurable). Start the incoming element ~1.5 s early at gain 0, and ramp only after its `playing` event. Equal-power curves via `setValueCurveAtTime`. A pool of 4 elements reassigned by `src`. Start a new key at a random offset inside the loop region. `ended` as a fallback. Files shorter than 3× the crossfade loop without crossfading.

**1.22 [m] chordName is ambiguous.**
`2`, `sus2` and `add9` overlap (worship "C2" means sus2). Am7 and C6 have the same pitch classes.
*Fix:* return `{name,root,quality,bass}`. Tie-break: root == bass wins, then fewer non-triad tones, then table order. Use physically held notes only (pedaled notes make stale chords). 1 note → note name. 2 notes → a power chord if it's a 5th, otherwise keep the previous readout.

---

## 2. Live-performance failure modes

**2.1 [B] Mod wheel → pad gain starts silent.**
Web MIDI can't read the wheel's physical position. The "pad swell 0..slot gain" default starts at 0, so there's no pad until the wheel moves. After a song switch the new target starts at an arbitrary value. The UI fader and the wheel also both write the same gain.
*Fix:* the engine keeps `lastWheel` (initially 1.0, meaning no effect until the first CC arrives) and applies it to the new target on commit. Effective gain = `fader × lerp(min,max,wheel)`: multiply, never overwrite. Show the wheel position on the slot. MIDI-learned hardware faders use pickup (ignore the CC until it crosses the stored value).

**2.2 [B] No recovery path when audio dies.**
Unplugging an interface or AirPods, HDMI, sleep/wake, or a stalled context gives silence, and the only fix is a reload (in Chrome: click-to-start plus a re-decode).
*Fix:* `engine.restart({latency,sinkId})` builds a new AudioContext and graph and reapplies the current state. Decoded AudioBuffers aren't tied to a context, so the cache survives. Watchdog every 1 s: `ctx.state` plus `currentTime` advancing. On `suspended`, try `resume()`. Show a big "Audio stopped: Restart audio" button. Listen for `navigator.mediaDevices.ondevicechange`. Latency changes go through `restart` too.

**2.3 [M] Keep the Mac awake.**
A sleeping display leads to system sleep mid-service. Electron: `powerSaveBlocker.start('prevent-display-sleep')`. Chrome: `navigator.wakeLock.request('screen')`, re-acquired on `visibilitychange`.

**2.4 [M] MIDI hot-plug with notes held.**
A USB bump while holding a chord leaves stuck notes and a stuck pedal.
*Fix:* on the `disconnected` statechange, release that input's notes and pedal. Re-attach `onmidimessage` on every `connected` event; don't rely on object identity. The MIDI LED reflects the state.

**2.5 [M] Decoded-sample memory and GC.**
Salamander at 4 layers × ~30 notes is ~120 buffers. At 48 kHz stereo float with ~12 s average tails, that's ~4.6 MB each, ~550 MB for the piano alone: most of the 600 MB cap (estimate; measure it). Decoding during a song creates large external allocations and can trigger main-thread GC pauses of tens of ms. Those show up as MIDI latency.
*Fix:* hard-cap sample length with a 1 s fade (≤ 10 s above C4, ≤ 16 s below). Use 3 layers. Decode the whole setlist at load behind a "Getting ready…" bar. Pin setlist instruments so the LRU only evicts others. Never decode while playing unless the user asked. Show decoded MB in Settings.

**2.6 [M] Sample onset latency.**
MP3 carries encoder/decoder delay (~25–50 ms) plus any leading silence in the source. `decodeAudioData` may not trim it (verify), so the sampled piano feels late next to the synths.
*Fix:* at decode, find the onset (first sample > −50 dBFS) and store `offset = max(0, onset − 1 ms)`. Play with `source.start(t, offset)` and a 2 ms fade-in. No listening needed.

**2.7 [M] Latency budget.**
Interactive output (~10–20 ms on a Mac) + compressor lookahead (~5 ms) + lofi's 20 ms base delay (applied to all instruments) + MP3 onset (~30 ms) comes to more than 60 ms. That's an unplayable piano.
*Fix:* 1.9, 2.6 and 3.9 (5 ms lofi base). Show `ctx.baseLatency + ctx.outputLatency` in Settings, and warn above 40 ms (Bluetooth).

**2.8 [M] Voice and node leaks over a 2-hour set.**
Stolen voices, per-voice LFOs, retired instruments and faded-out drone voices that never get `stop()` and `disconnect()` pile up. CPU creeps until it crackles late in the service.
*Fix:* each voice owns a list of its nodes, with a single `kill(t)` path that stops every source (LFOs included) and disconnects on the last `onended`. Add `engine._debugStats()` → `{voices, nodes, retiring}`. Soak test in 6.12.

**2.9 [M] Main-thread work at the moment of commit.**
Convolver `buffer=`, PeriodicWave creation, IR generation, a full Edit-view re-render, or a JSON autosave at switch time all delay MIDI.
*Fix:* all expensive work happens in `prepare`; `commit` only schedules gains. Views patch the DOM in targeted spots. Autosave runs in `requestIdleCallback`.

**2.10 [M] Song-switch races.**
Double-tapping Next while a prepare is pending gives out-of-order commits, or commits a patch that isn't ready. The spec doesn't say what plays during a 2 s decode.
*Fix:* `applyPatch` returns a token and only the latest token may commit. The old patch keeps playing until the new one is ready, and the song name shows "loading". After each commit, preload the next and previous setlist songs automatically.

**2.11 [M] Panic semantics are wrong for live use.**
"Drone hard-mute 50 ms then restore" is itself a glitch. It also leaves the most common runaway, delay feedback, untouched.
*Fix:* panic = 30 ms fade on all voices, clear the pedal and `sounding` map, reset bend to 0, delay feedback → 0 for 200 ms and then restore. Leave the drone alone. Add a separate "Fade out all" (5.2).

**2.12 [m] Timers in a hidden or silent Chrome window, and AudioParam spam.**
Non-audible pages get timers throttled to 1 Hz, and harder after 5 min (audible pages are exempt; verify). MIDI mod wheel and faders send 100+ events/s.
*Fix:* drive engine timers from the audio clock: schedule a `ConstantSourceNode` start/stop and use its `onended`. Coalesce continuous controls to ≤ 1 update per 10 ms with `rampTo` (τ ≈ 15 ms). Chromium flushes denormals for native nodes (verify on ARM64); any future worklet with an IIR adds 1e-20 DC.

---

## 3. Sound quality (robust recipes for an implementer who can't listen)

**3.1 [M] Master-insert FX is the wrong topology for a keys rig.**
Chorus, delay and reverb as master inserts put reverb and chorus on the bass/sub and the piano: mud in the low end, detuned piano. "mix" also turns the dry signal down.
*Fix:* a dry bus plus sends. Per-slot `sends:{reverb,delay}` (0..1). Chorus per slot, or as a send for Pad/Extra only. Reverb input HPF at 180 Hz and LPF at 9 kHz. Bass slot sends default to 0. Master = lofi (optional) → master gain → catcher/clip. The Slot schema is shell-owned, so this has to go into the contract now.

**3.2 [M] Reverb IR recipe.**
One exponential envelope over broadband noise, plus regularly spaced early taps, sounds grainy and metallic, with an unnaturally bright tail.
*Fix (works blind):* 6–8 octave bands of independent noise per channel (L and R independent, seeded PRNG). Each band gets its own RT60 = size × [125 Hz: 1.2, 500 Hz: 1.0, 2 kHz: 0.8, 4 kHz: 0.5, 8 kHz: 0.3]. A 20–40 ms cosine fade-in. No regular early taps: either none, or 6–10 random taps between 7 and 60 ms with random L/R gains. Low shelf −6 dB below 150 Hz. IR length = 1.1 × the longest RT. Normalize to equal energy. Buckets: 1.5, 2, 2.8, 3.8, 5, 6.5, 8 s.

**3.3 [M] Saw pad construction.**
Native `OscillatorNode` saws are already band-limited, so aliasing isn't the risk here. The real risks: every oscillator starts at phase 0, so each note gets the same comb-filtered attack; 3 saws at ±7¢ is thin and mono; and two Q=0.707 biquads in series aren't a Butterworth 4-pole.
*Fix:* warm-pad = 5 saws at 0, ±9 and ±17¢, panned across ±0.6. Random phase: pre-build 8 phase-rotated sawtooth `PeriodicWave`s at start and pick one at random per oscillator. HPF 12 dB at ~120 Hz. LPF from two biquads with Q 0.54 and 1.31 at 1.8 kHz, 50 % keytracking and ±30 % from velocity. LFO on the filter's `detune` (±300¢). Voice gain −3 dB/octave above C4.

**3.4 [M] Loudness normalization.**
Untuned presets will span ±15 dB, which on stage means a volume jump at every song change.
*Fix:* a calibration script (offline render in Playwright). For each instrument, render a C-E-G chord at velocity 96 for 3 s, measure band-limited RMS (100 Hz–5 kHz), and write `gainTrim` so everything sits at −20 dBFS RMS. Commit the table to the manifest and presets. Calibrate the synth drone against typical pad files the same way.

**3.5 [M] The drone voicing should drop the third.**
Commercial key drones are root + 5th + octave (+ 9th for brightness) precisely so they sit under IV, V(sus), bVII and relative-minor passages. A major third clashes.
*Fix:* no third by default (only with chord-follow). HPF the drone at ~80 Hz so it doesn't fight the bass player. Per-voice ±3¢ random-walk drift.

**3.6 [M] Organ implementation.**
Nine sines per voice × 16 voices = 144 oscillators. Drawbar steps are logarithmic (≈ 3 dB per step), not linear, so linear gains sound wrong. One modulated delay alone is a vibrato, not a Leslie.
*Fix:*
- Tone: one `OscillatorNode` per voice at f/2 with a `PeriodicWave` (`disableNormalization:true`). Harmonics: 1 (16′), 3 (5⅓′), 2 (8′), 4 (4′), 6 (2⅔′), 8 (2′), 10 (1⅗′), 12 (1⅓′), 16 (1′). Amplitude `d ? 10**(-3*(8-d)/20) : 0`. Pre-build one wave per preset.
- Click: a 4 ms burst of noise band-passed at 2–4 kHz.
- Percussion: 3rd harmonic, 0.2 s decay, single-trigger (fires only when no other key is held).
- Overdrive: `WaveShaper` with `4x` oversampling, before the rotary.
- Rotary: 800 Hz crossover. Horn: delay modulated ±0.35 ms plus 3 dB AM. Drum: 2 dB AM. Speeds: horn 0.8→6.8 Hz, drum 0.7→5.9 Hz. Acceleration via `setTargetAtTime` on the LFO frequency: horn τ ≈ 0.3 s, drum ≈ 1.5 s. L/R mics are the same LFOs 90° apart.
- Drop the scanner vibrato from v1.

**3.7 [M] EP recipe.**
"2-op FM-ish" is too vague, and generic FM comes out harsh.
*Fix:* 1:1 modulator with index `0.3 + 1.5·vel/127`, decaying to 0.2 with τ 0.4 s. Tine transient: a second modulator at 14:1, index 0.8, τ 30 ms. Keytracked amplitude decay (τ 3 s at C3 → 0.8 s at C6). Stereo tremolo 4.5 Hz. Soft saturation at 4x. Make `lofi-keys` a *preset* (soft-keys + lofi FX), not a separate patch.

**3.8 [M] choir-pad will sound robotic.**
A saw through bandpasses with no vibrato or ensemble sounds like a vocoder buzz.
*Fix or defer:* 2 saws at ±6¢ plus pink noise at −30 dB. Three parallel BPFs ("ah": 700/1220/2600 Hz, gains 0/−6/−12 dB, Q 6/8/10). Per-voice vibrato at 5–5.5 Hz, ±12¢, random rate, 0.3 s onset. Then chorus. I recommend deferring it (5.1).

**3.9 [M] Lofi chain order and ranges.**
Lofi *before* reverb gives clean hi-fi tails over a crushed source, which isn't the genre, and the reverb smears the crackle into a wash. A 20 ms wow base delay adds 20 ms of latency to everything.
*Fix:*
- Order: chorus → delay → reverb → lofi → master, with crackle added after lofi.
- Wow/flutter base delay 5 ms: wow at 0.35 Hz ±2 ms (≈ 0.45 % pitch), flutter at 5 Hz ±0.03 ms.
- Macro mapping: LPF 18 k→3.5 kHz, HPF 20→120 Hz, bits 16→11 (never below 10), saturation 0→+9 dB at `4x`, crackle −60→−38 dBFS.
- Engage and bypass with a 30 ms dry/wet crossfade.

**3.10 [M] Sampler dynamics and release.**
Layered samples already carry their dynamics, so an extra velocity→gain curve double-counts. A linear 0.35 s release sounds chopped.
*Fix:* velocity gain span −10 dB for multi-layer instruments. For single-layer MusyngKite, −24 dB plus an LPF sweeping 2k→12k with velocity. Release: exponential, τ 0.12 s for piano. Notes above F6 (MIDI 90) ignore release, like real undamped strings.

**3.11 [M] Mono compatibility.**
Many churches take one mono DI. Detuned saws panned wide, decorrelated reverb, ping-pong delay and chorus can comb-filter or vanish when summed.
*Fix:* a "Mono output" setting (sum at master, −3 dB). Keep pads mono below 150 Hz. The audition pack adds mono renders and checks mono-vs-stereo loss < 3 dB.

**3.12 [m] Smaller sound fixes.**
- The glass-pad "+12 voice" isn't shimmer; label it "Octave bloom" (real shimmer, a pitch-shifter in the reverb feedback, is v1.1).
- sub-bass needs a 2nd harmonic (mild WaveShaper, LPF 250 Hz) or it disappears on small PAs.
- strings: delayed vibrato (0.5 s onset), LPF 4 kHz, HPF 150 Hz.
- Pitch bend on a sampled piano sounds fake: `pitch` mode applies only to synth slots by default (per-slot `bendEnabled`).

---

## 4. Contract gaps that will produce incompatible code

**4.1 [B] Nobody owns song switching or store→engine sync.**
Selecting a song means applyPatch(prepare) → commit → setTranspose → drone.setKey → setTempo → preload neighbors. No agent owns that sequence, and views write both the store and the engine, so the two will diverge.
*Fix:* add `app/js/controller.js` (owned by shell or the orchestrator) with one `selectSong(id)`. It subscribes to the store and diffs `song.patch` into engine setters. Views call only `store.set` (persisted state) or `controller.perform.*` (transient: notes, bend, wheel, sustain). `engine.getState/applyState` become test/audition-only.

**4.2 [B] No parameter address grammar and no units.**
`'slot1.gain'`, `setSlot(i,'params.cutoff')`, `setFx(path)`, MIDI-learn controlIds and `store.set(path)` all use different shapes. Gain could be linear or dB, cutoff Hz or 0..1; lofi `bits`, chorus `depth` and drone `movement` are undefined.
*Fix:* one grammar used everywhere: `slots.<i>.<key>`, `fx.<unit>.<key>`, `drone.<key>`, `master.<key>`. A `PARAMS` table in a shared pure module: `{path,min,max,default,unit,curve:'lin'|'log'|'db'}`. Gains are stored linear. Faders use a cubic audio taper (`gain = 2·pos³`, so the top is ≈ +6 dB) and display dB.

**4.3 [M] Instrument params are undeclared.**
The UI's "per-instrument params" and the presets both need them, and neither can know them.
*Fix:* `listInstruments()` → `[{ref,name,group,params:[{key,label,min,max,default,unit}]}]`, merging manifest, synth and organ entries. Make `InstrumentRef` uniformly `{type,id}` (it currently mixes `patch`, `id` and `preset`).

**4.4 [M] The engine has no events.**
The UI needs load progress, errors for toasts, held notes, chord changes and voice counts.
*Fix:* the engine extends `EventTarget` with `notes`, `chord`, `loading{slot,progress}`, `ready`, `warn{message}` and `statechange`.

**4.5 [M] String keys with canonical flats create an enharmonic mess.**
Gb vs F#, C#m, and the §6 run-on spelling rule.
*Fix:* keys are pitch-class ints 0..11 plus `minor`. One `keyName(pc,minor)`: major C Db D Eb E F F# G Ab A Bb B; minor Cm C#m Dm Ebm Em Fm F#m Gm G#m Am Bbm Bm. Chord spelling follows the song key's accidental preference. `detectKeyFromName` returns `{pc,minor}`.

**4.6 [M] Phase-1 cross-agent import.**
store.js (shell) imports `engine/chords.js` (engine) while both are being written in parallel.
*Fix:* before Phase 1, the orchestrator writes `app/js/shared/music.js` (KEYS, keyName, transpose math, PARAMS). Both agents import it.

**4.7 [M] Mod wheel and bend routing ownership.**
The mapping lives in Patch (store), but "the engine holds the mapping". The `bend.morph` enum (filter-sweep, lofi-warp, rotary, shimmer) mixes FX macros with the per-instrument `morph()`.
*Fix:* the controller passes `patch.modWheel` and `patch.bend` on commit, and the engine combines them as in 2.1. Either morph = each slot instrument's `morph(x)` with FX morphs as a separate `fxMorph` target, or cut bend-morph from v1 (5.1).

**4.8 [M] Latency naming mismatch.**
Settings say `'lowest'|'balanced'|'safe'`, the engine says `'interactive'|'balanced'|'playback'`, and `'playback'` means 80+ ms.
*Fix:* map lowest→`'interactive'`, balanced→`0.010`, safe→`0.025` (seconds). A change goes through `engine.restart()`.

**4.9 [M] The store API is underspecified.**
Missing:
- the `set(path)` format (by index or by id?)
- the `subscribe(fn)` arguments (`(state, changedPaths)`?)
- `currentSetlistId` and the current position in the setlist
- first-run seeding of factory songs
- stable factory ids, so preset updates don't clobber user copies

Migration appears in both store.js and presets.js (pick store). localStorage needs an injectable adapter for node tests. Chrome and Electron have separate libraries (different origins); say so in the README and export/import.

**4.10 [m] Undefined defaults and shapes.**
- Per-role slot defaults (Bass: `mono:'lowest'`, `highNote:59`, sends 0; Pad: `sustain:true`).
- `velocityCurve` type (enum soft/normal/hard/fixed).
- `window.rig` methods should all return Promises with an `{error}` shape. `listPadFolder` on an unmounted drive → `{error:'missing'}`.
- Recorder ownership: recorder.js calls `engine.ctx.audioWorklet.addModule` lazily, and the engine only exposes `recordTap`.
- The Help→README target isn't in electron-builder `files`.

**4.11 [m] Drone across a song switch.**
- Same key → no-op (don't restart the crossfade).
- Next song's drone is `off` → fade out over `fade`.
- `files` with no folder → synth fallback plus a toast.
- `setTranspose` must never touch the drone; the key comes only from `drone.setKey(hearIn)`, contradicting §3.
- Add a global "drone continues through song changes" toggle.
- Files mode: option to map a minor song to its relative major's file.

---

## 5. Scope

**5.1 Cut or defer from v1:**
- Electron custom protocols (→ 1.5), the dmg target, the PWA manifest.
- The `bend:'morph'` mode (keep pitch/none).
- The **chord-follow drone** (riskiest musical feature; ship a static root-5th drone).
- choir-pad, organ scanner vibrato and the `church` preset.
- The bitcrusher worklet (WaveShaper quantize only, so the engine needs zero worklets).
- MIDI Program Change.
- Factory songs 15 → 8: Sunday Pad+Piano, Building Swell, Organ Swell, Grand Piano, Rhodes, Lofi Rhodes, Glass Ocean, Sub+Shimmer.
- MusyngKite 10 → 5: rhodes, wurli, vibes, nylon, celesta.
- Salamander 4 layers → 3.

**5.2 Add (cheap, and what a volunteer keys player actually needs on a Sunday):**
- **Output device picker** (`AudioContext.setSinkId`): the feed goes to an interface/DI, not the headphone jack. Plus a **Mono output** toggle (3.11).
- **Transpose −/+ buttons on Perform** ("take it up a step" in rehearsal).
- **Fade out all** (6 s): pad ring-out at the end of the service or after prayer.
- **Preload the whole setlist** with a "Ready" light.
- **Restart audio** plus watchdog (2.2), and **keep the Mac awake** (2.3).
- **Expression pedal CC11** routed to Pad gain by default (with pickup).
- Pedal-polarity invert, and global velocity sensitivity (soft/normal/hard/fixed).
- **Perform lock**, so no stray edits during the service.
- Auto-backup: Electron writes JSON to `userData` on save and keeps the last 10.
- Latency readout with a Bluetooth warning.
- README: "map a footswitch to Next Song" as the headline use of MIDI Learn.

---

## 6. Test plan holes

**6.1 [B] The gapless test can't be done by polling an analyser.**
Headless timers jitter, so you can't observe every 20 ms window. *Replace with* a sample-exact capture (the recorder worklet as a test tap), or an offline render with `when`-scheduled events. Then compute 10 ms RMS windows on the buffer.

**6.2 [B] The audition pack needs `when` scheduling (1.7).**
Render 12 s (2 s per chord plus a tail), not 6 s.

**6.3 [M] The files-mode drone test.**
MediaElementSource doesn't exist offline, so this is real-time only. It depends on MP3 support in Playwright's Chromium build (verify; fall back to Ogg/WAV). An 8 s file is shorter than 2× crossfade plus the skip regions, so generate a 20 s file. Measure through the tap, not `currentTime`.

**6.4 [M] Browser build.**
Recent Playwright may default headless runs to `chromium-headless-shell` (verify). Use full Chromium in new-headless mode. Assert that `ctx.state==='running'` and that `currentTime` advances; otherwise switch to offline for the engine suite.

**6.5 [M] MIDI in CI.**
There are no devices. midi.js exposes `_inject(bytes, ts)`, and permission comes from `context.grantPermissions(['midi'])`. Test: running status, velocity-0 note-offs, 14-bit bend, the CC64 threshold, and disconnect → notes released.

**6.6 [M] FSA pickers can't be automated.**
Exercise the writable-stream recorder code against OPFS (`navigator.storage.getDirectory()` → `getFileHandle` → `createWritable`), plus the in-memory fallback and a mock `window.rig`.

**6.7 [M] Electron under xvfb in a Linux container.**
There's no audio device and no MIDI. The app must degrade with `console.warn`, never `console.error`, or the "zero errors" check fails. Assert boot, `fetch(url,{headers:{Range:'bytes=0-99'}})` → a 206 with 100 bytes, and a successful worklet addModule. Mac-only behavior stays untested, so add a 5-minute **manual Mac checklist** to the README: build, launch, MIDI LED, pedal, every song, switch while holding a chord, record 30 s, unplug and replug the keyboard, change the output device, sleep/wake.

**6.8 [M] "lofi 0 ≡ bypass sample-exact" needs determinism.**
Seed the PRNG: `new AudioEngine({context, seed})` covers noise IRs, oscillator phases and crackle. Compare against a render where the lofi node was never created.

**6.9 [m] Smaller test fixes.**
- "Zero console errors": add a `<link rel=icon>`, because the server 404s `/favicon.ico` and that logs an error.
- Transpose FFT: sine at A3, fftSize 32768, parabolic peak interpolation, 0.5 % tolerance. Include tritone and octave-boundary cases.
- Chord-follow: `_debugFreqs()` returns *target* frequencies (deterministic).
- "Migrate from schema 0" has no schema-0 fixture to test against. Replace with: idempotent migrate, unknown fields preserved, a future schema refused without data loss, corrupt localStorage → factory reset with the raw string backed up.

**6.10 [M] Add a stuck-note fuzz test.**
2,000 random events offline (noteOn/Off, pedal, transpose change, song switch, panic). After everything is released plus the maximum release time: live voices == 0 and output < −90 dBFS.

**6.11 [M] Add a click detector.**
On buffers rendered around switches, note-offs, steals and FX changes, flag first-difference spikes > 6× the local median, or bursts of high-passed energy above 8 kHz.

**6.12 [M] Add a soak test.**
20 minutes of real-time random playing in headless. `_debugStats()` returns to baseline, and JS heap growth stays under 20 MB.

**6.13 [M] Add a "robot listener" to the audition pack.**
Per clip: RMS, peak, DC, spectral centroid, mono-sum loss, NaN/silence. Fail if peak > −0.3 dBFS, RMS falls outside −26..−16 dBFS, or |DC| > 0.001. Put the numbers in `audition/index.html` next to the players.

---

## If you only fix 10 things

1. Mandate the `rampTo`/`glideTo` helpers (`cancelAndHoldAtTime` before every envelope change) (1.1).
2. Track voices in a `sounding` map keyed by physical note, and switch songs MainStage-style, keeping held and pedaled voices on the old instrument until release (1.2, 1.3).
3. Serve pads same-origin, preferably via a fixed-port localhost server in Electron main instead of `app://`/`pads://` (1.4, 1.5).
4. Give every engine call an optional `when`, make internal timing event-time-based, and seed the RNG, so offline tests and the audition pack can work at all (1.7, 6.8).
5. Add `controller.js` as the single owner of `selectSong` and store→engine sync, plus a shared `music.js` holding keys-as-ints, the transpose formula and a units-bearing `PARAMS` table in one address grammar (4.1, 4.2, 4.5, 4.6).
6. Make the mod wheel multiplicative with an initial value of 1.0 so pads can't start silent (2.1).
7. Move reverb/delay/chorus to per-slot sends with filtered returns, use the multiband IR recipe, and run automated loudness calibration (3.1, 3.2, 3.4).
8. Add Restart audio plus a watchdog, a wake lock, and MIDI-disconnect note release (2.2–2.4).
9. Cap and preload sample memory for the whole setlist, and trim MP3 onsets (2.5, 2.6).
10. Replace analyser-polling tests with sample-exact capture, and add the stuck-note fuzz, click-detector and soak tests (6.1, 6.10–6.12).

Then cut chord-follow, choir, bend-morph and Program Change from v1 (5.1).
