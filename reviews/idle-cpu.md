# Idle CPU: profile, causes, fixes (idle-cpu profiler, 2026-09-28)

Starting point (Mac, built app, Perform, *Sunday Pad + Piano* with the drone on, nothing played): renderer ≈ 47.5 % of
one core, GPU 2.7 %, main process 0.2 %; GarageBand idle 2.3 %. `reviews/idle-cpu-mac.md` has the per-thread Mac
split (audio thread 21 %, two reverb convolution threads ~8 %, main 9 %, compositor 6 %, GPU 13 %). This report
reproduces that split on Linux, attributes it, and fixes the biggest engine-side cause.

- Harness: `tools/idle-cpu.mjs` (new). It serves the app with `server.js`, boots it in headless Chromium
  (`--enable-precise-memory-info`), selects the song by name, waits for the song switch's background work to finish
  (ready, no reverb unit in flight, decoded MB and long-task count stable for 3 s), then settles 10 s and measures
  20 s per configuration.
  - Renderer CPU per thread from `/proc/<pid>/task/*/stat`: `main`, `audio` (`AudioOutputDevice`, the Web Audio render
    thread), `reverbBg` (`Reverb convolution background thread`s), `compositor`, `raster`, `pool`; the GPU and browser
    processes. This is the only source that sees the audio thread in realtime.
  - CDP `Performance.getMetrics` deltas: TaskDuration, ScriptDuration, LayoutDuration, RecalcStyleDuration (main
    thread only), as % of wall time, plus layouts and style recalcs per second.
  - Page counters installed before any app script: timer / rAF / idle-callback firings per second with call sites,
    AnalyserNode reads/s, DOM mutations/s (with the top targets), long tasks, running CSS/Web animations, live
    started source nodes by class, `engine._debugStats()`, reverb units (IR length, connected).
  - DSP estimate: an `OfflineAudioContext` engine is given the live engine's `getState()` and renders 20 s; CPU of
    the offline render thread / 20 s = the graph's audio-thread share. Caveat: every offline render runs the
    convolver for its first IR-length seconds (6.6 s here) whatever the input, so idle configs read high.
  - `--emulate-prefix` connects every fresh instrument at once, as the engine did before fix #1 (A/B the fix).
  - `node tools/idle-cpu.mjs [--only A,B,…] [--measure 20] [--settle 10] [--no-offline] [--json out.json]`.
- Box: the 2-CPU Linux container, load average 10–36 from other agents' suites during every run. Absolute numbers
  swing ±3–4 points between runs; compare configurations inside one run, and the Mac report for absolute values.
  Headless Chromium runs rAF at 60–120/s here (the Mac: 120/s, ProMotion).

## Results

Renderer % of one core (threads), GPU process %, CDP main-thread %, DSP estimate, and page counters per second.
**Post-fix** = run 4 (fix #1 in). **Pre-fix** = run 2 (the engine as it was; K is from run 3, which had only the
connect-on-first-note half of the fix, so after one note it behaved like the old engine). Run 5 is
`--emulate-prefix` on the fixed tree, run right after run 4:

| | A | B | G1 | G2 |
|---|---|---|---|---|
| run 5, pre-fix emulated | 52.9 | 30.1 (audio 16.9, reverbBg 6.7) | 16.9 | 17.4 |
| run 4, post-fix | 47.2 | 15.6 (audio 8.3, reverbBg 0) | 15.0 | 15.9 |

Main table:

| cfg | what | renderer (pre → post) | main | audio | reverbBg | compositor | GPU | CDP task / script / style | DSP est. | rAF | timers | analyser reads | DOM mut. | live osc / sources | voices | reverb units |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | Sunday, Perform, drone on | 43.4 → 47.2 (noise) | 9.7 | 23.8 | 7.1 | 5.3 | 2.9 | 9.1 / 1.8 / 0.8 | 19.3 | 102 | 7.7 | 204 | 84 | 24 / 31 | 3 | 9 |
| B | drone off | **31.3 → 15.6** | 4.8 | 8.3 (was 18.4) | **0 (was 6.2)** | 2.4 | 1.1 | 4.4 / 1.6 / 0.5 | 6.3 | 116 | 7.7 | 233 | 8.7 | 9 / 16 | 0 | 9 |
| K | drone off, after one note | **30.2 → 14.2** | 3.9 | 8.1 (was 16.0) | **0 (was 7.1)** | 1.9 | 0.9 | 3.6 / 1.2 / 0.4 | – | 91 | 7.4 | 181 | 8.3 | 9 / 17 | 0 | 9 |
| C1 | A + reverb returnGain 0 | 41.2 → 44.1 | 8.9 | 21.6 | 7.1 | 5.1 | 2.9 | 8.4 / 1.8 / 0.8 | 17.1 | 118 | 7.6 | 236 | 95 | 24 / 31 | 3 | 9 |
| C2 | A + reverb unit disconnected, idle units dropped | 32.4 → 27.3 | 8.5 | 12.8 | 0 | 4.8 | 2.7 | 8.0 / 1.7 / 0.7 | 11.7 | 110 | 7.7 | 220 | 91 | 24 / 31 | 3 | 1 |
| D | A + low-resource (meters hidden, taps off) | 33.4 → 28.5 | **0.2** | 19.9 | 6.5 | 1.6 | 0.9 | 0.2 / 0.1 / 0 | – | 0 | 7.6 | 0 | 6.6 | 24 / 30 | 3 | 1 |
| E | A in Edit | 43.1 → 41.4 | 9.2 | 19.6 | 6.5 | 4.4 | 6.4 | 8.5 / 1.9 / 0.5 | – | 172 | 7.8 | 287 | 166 | 24 / 31 | 3 | 9 |
| I | A + hidden spinner paused | – → 40.8 | 7.9 | 20.5 | 6.9 | 4.0 | 2.5 | 7.3 / 1.7 / 0.4 | – | 113 | 7.7 | 225 | 88 | 24 / 31 | 3 | 9 |
| J | D + hidden spinner paused (UI floor) | – → 28.6 | 0.2 | 21.3 | 7.1 | **0** | **0** | 0.2 / 0.1 / 0 | – | 0 | 7.7 | 0 | 6.6 | 24 / 30 | 3 | 1 |
| F1 | A + `setWindowVisible(false)`, menu-bar mode off | 47.9 → 38.5 | 7.4 | 20.1 | 6.0 | 4.1 | 2.2 | 7.0 / 1.3 / 0.6 | – | 91 | 7.5 | 181 | 77 | 24 / 31 | 3 | 9 |
| F2 | same, menu-bar mode on (auto low-resource) | 33.6 → 29.0 | 0.2 | 19.8 | 6.9 | 1.8 | 0.9 | 0.2 / 0.1 / 0 | – | 0 | 7.6 | 0 | 6.6 | 24 / 30 | 3 | 1 |
| H | Sunday, C chord held (playing) | 52.2 → 48.4 | 7.1 | 30.2 | 6.0 | 4.1 | 8.6 | 6.7 / 1.2 / 0.6 | 33.3 | 70 | 7.7 | 139 | 97 | 48 / 55 | 7 | 9 |
| G1 | Glass Ocean (synth only) | 16.4 → 15.0 | 4.2 | 8.2 | 0 | 2.4 | 1.0 | 3.9 / 1.4 / 0.5 | 13.5 | 109 | 7.7 | 217 | 8.5 | 9 / 18 | 0 | 9 |
| G2 | Grand Piano (sampler only) | 17.1 → 15.9 | 5.0 | 7.9 | 0 | 2.6 | 1.1 | 4.6 / 1.4 / 0.5 | 7.0 | 106 | 7.5 | 159 | 8.3 | 8 / 13 | 0 | 9 |

Counts that do not depend on load:

- **Timers**: 7.7 firings/s in every config: `perform.js` 150 ms `runtimeTimer` 6.6/s and the controller's 1 s
  watchdog. `main.js:547` (the "Loading n/m" ticker, 2/s) only runs until `status.ready`. No engine timer fires
  while idle (the engine uses `AudioTimer`; `idle engine/fx.js:511` = reverb warming, only right after a switch).
- **rAF**: 2 loops, `meter.js:57` (top-bar meter) and `levelMeter.js:16` (strip meters), each once per frame, in
  every config except low-resource. Neither stops at silence (B / G1 / G2 run them at the full frame rate).
- **AnalyserNode reads**: 2 per frame (`meter.js` reads analyserL + analyserR, 2 × 2048 samples) + 1 per frame per
  filled strip (`slotLevel`, 256 samples). 0 in low-resource.
- **DOM mutations**: drone on 80–95/s (`.meter-fill@style` ≈ 60/s, `.meter-hold@style` ≈ 5/s, meter
  `aria-valuenow` 2/s), drone off 8.6/s. The steady 6.6/s floor is `.pedal-lamp@aria-label`, rewritten by every
  150 ms `readRuntime` tick with the same value.
- **Running animations**: 1 in Perform in every config: `spin@song-loading-spin`, the "Loading…" spinner, which is
  `opacity: 0` (styles.css:657–660) but animates forever. 0 in Edit (display:none there).
- **Oscillators / sources**: 9 oscillators + 7 ConstantSources with nothing playing (chorus LFO ×2, lofi wow/flutter,
  the instruments' shared LFOs/bend constants); the drone adds 15 oscillators (3 voices × 4 saws + 1 triangle) and
  the drift/unison sources.
- **Convolvers**: 9 pooled reverb units (IRs 87 318 – 465 696 frames stereo at 44.1 kHz, i.e. 2.0 – 10.6 s), one
  connected. Sunday's is `5|0.5`: 291 060 frames = 6.6 s stereo.
- **Long tasks** while idle: 0–5 per 20 s, all from other work (none from the app's idle loops).
- **Memory**: renderer RSS 1149 MB in A (Mac phys footprint 1099 MB). Decoded samples are 653 MB of it (cap 700,
  333 MB pinned: the setlist); JS heap ≈ 10 MB. (Later rows read higher because each offline estimate decodes its own
  copy of the song's samples.)

Realtime attribution without any UI (blank page, engine only, `AudioOutputDevice` + reverb threads, pre-fix):

| step | audio | reverbBg |
|---|---|---|
| bare AudioContext | 1.1 | 0 |
| engine started, empty patch (static FX graph) | 5.9 | 0 |
| + Sunday's slots, idle (piano + warm-pad) | 14.7 | 5.7 |
| same − the reverb unit | 9.0 | 0 |
| + drone synth | 22.1 | 6.9 |
| same − the reverb unit | 17.0 | 0 |
| same − chorus and delay inputs | 13.9 | 0 |

Static graph on silence (engine, empty patch; each step removes one more part): 4.7 → −chorus 3.8 → −delay 2.4 →
−reverb 2.0 → −lofi/EQ/glue 1.2 → −master chain 1.2 (bare context 0.7). The delay's feedback loop and the chorus's
LFO-modulated delays never go idle in Chromium.

## Ranked causes (Mac baseline ≈ 44–47 % of a core, drone on)

1. **DSP for the sounding drone path, ≈ 29 points on the Mac** (audio 21 + reverb threads 8). Here the drone path is
   A − B ≈ 15 audio + 7 reverbBg. The largest single part is the reverb convolution: a 6.6 s stereo IR fed without a
   break (C1 → C2: −8.8 audio, −7.1 reverbBg ≈ 16 points here). Next are the drone's 3 voices (15 oscillators, 12
   StereoPanners, 6 biquads, drift sources: ≈ 4–7), then chorus and delay (≈ 3). This is real work while a drone
   sounds, so it can only get cheaper by sounding different (a shorter IR, fewer drone oscillators). Not changed.
2. **An idle warm-pad kept the whole wet chain running: a leak, now fixed (engine, fix #1).** When Sunday Pad was
   loaded, its warm-pad's output was never flagged silent by Chromium, whether the pad had never been played or had
   been played and released. So its strip, EQ, sends, the reverb convolver (+ background thread), chorus and delay
   processed zeros for as long as the song stayed loaded. Evidence:
   - B pre-fix: audio 18.4 + reverbBg 6.2 with nothing sounding, against G1/G2 ≈ 8 + 0. The Mac's (b) row, 35.1 %
     with 8.5 reverb-thread points while silent, is the same leak.
   - Cutting the pad's output stops it; cutting the piano's or the drone's doesn't (in-app bisect).
   - Of all 19 synth/organ patches and the first 5 samplers, only `warm-pad` leaks. `drone-osc` shares its
     `monoBelow` stage.
   - Plain Web Audio repro: GainNode with no inputs → highpass → the `monoBelow` topology → ConvolverNode keeps the
     convolver busy (reverb thread 3–4.5 %, audio 5.5–6.7 % vs 0.8–1.2 %). Without monoBelow's mid→merger branch, or
     with a started-and-stopped source instead of the empty bus, it goes idle.
   - The Chromium mechanism is unverified (it is probably in the silence-hint propagation). Fix: see below.
   - Result: B 31.3 → 15.6, K 30.2 → 14.2. With the drone on, the saving is the pad chain only (≈ 3–4 points,
     inside this box's noise).
3. **Meter rAF loops at display rate: main ≈ 8–10, compositor ≈ 3–4, plus GPU raster (Mac: main 9, compositor 6,
   GPU up to 11).** A → D removes 9.5 main, 3.7 compositor and 2 GPU points here. `meter.js` writes `transform`, the
   hold's `left` (a layout property), 2 class toggles and `aria-valuenow` every frame, with no change check.
   `levelMeter.js` does check for changes, but both loops re-arm rAF forever at level 0. On ProMotion that is 120/s.
   UI side (request R1).
4. **The hidden "Loading…" spinner animates forever: compositor ≈ 1.6–2 points, GPU ≈ 1 here (D → J: compositor
   1.6 → 0, GPU 0.9 → 0).** On the Mac a permanently running animation keeps frame production and composition going
   at 120 Hz, even when everything else is still. It is a one-line CSS fix (R2).
5. **The static FX graph on silence: ≈ 4 points audio here** (delay feedback loop 1.4, chorus 0.9, lofi/EQ/glue 0.8,
   reverb 0.4). This is what remains on the audio thread with nothing sounding (B / G1 / G2 ≈ 8). Engine idea, not
   done: see "Not done".
6. **A hidden window changes nothing outside menu-bar mode.** F1 = A within noise. The auto low-resource path is
   gated on `settings.menuBarMode` (menubar-A). Electron runs with `backgroundThrottling: false`, so a hidden window
   probably keeps rAF and the meters (unverified; the Mac run had the screen locked). Request R4.
7. **The 150 ms `readRuntime` tick**: 6.6 `aria-label` rewrites/s with an unchanged value, plus the drone dB readout
   re-layout on the Mac (5–6 layouts/s with the drone on). Small (R3).
8. **Memory (1.1 GB footprint)** is mostly decoded samples: 653 MB, with the LRU cap at 700 and 333 MB pinned for the
   setlist. The pooled reverb units add roughly 10 convolvers' FFT kernels and the IR cache (estimated tens of MB;
   not measured). The JS heap is ≈ 10 MB. Not CPU; see R5.

Not a cause: page JS (CDP script 1.2–1.9 %; the Mac profile agrees at ≈ 1 %), timers (7.7/s), long tasks, and the
analyser node processing itself (removing both analysers changed nothing measurable).

## Fixes

### Done (engine; `## idle-cpu` in CONTRACT_CHANGES.md)

- **#1: slot instruments are connected to their strip only while they play.** In `audio.js`:
  - `_armSlot(sc)` connects `inst.output → strip.input` just before a note (the poly and mono paths).
  - `_pollIdleSlots` (AudioTimer, every 0.5 s while any slot is armed; realtime only) disconnects an instrument
    that has had no live voice for `SLOT_IDLE_DISARM_SEC` = 2 s.
  - `prepare()` no longer connects.
  - In `drone.js`, the drone's reusable drone-osc instruments connect when taken for a layer and disconnect when
    returned to the idle pool.
  - A disconnected instrument isn't pulled at all, so an idle slot should also cost nothing inside the instrument.
    The organ patches read 2–3 audio points above the other patches in the connected idle sweep; the fixed build was
    not re-swept.
  - Tests: engine `offline.idleArm` (not armed after commit, the poly and mono paths arm, a reused instance keeps its
    connection, the first note sounds) and `realtime.idleDisarm` (disarmed 2.0–3.0 s after the last voice ended, a
    held note stays connected, the next note re-arms and sounds).

- Engine suite (`node test/phase1/engine/run.mjs`, load 20–30): 68 of 72 passed. The 4 failures were load, not the
  fix:
  - `stuckNoteFuzz` and `realInstrumentsSmoke` hit the 120 s timeout. Re-run alone, both pass.
    `stuckNoteFuzz` takes 36.1 s on the fixed tree against 38.2 s on a pre-fix copy, back to back.
  - `droneFiles` failed with no audible window at load 30 and passes at load 3–11.
  - `eqCpu` gives its soft "box load" warning.

### Requested (UI / LOCAL; also in `reviews/for-local.md` and CONTRACT_CHANGES `## idle-cpu`)

- **R1 (meters: the largest UI item).**
  - `meter.js`: write only on change (quantise like `levelMeter`). Move the hold with `transform: translateX()`,
    not `left`. Toggle `clip` / `hot` only when they change.
  - Both loops: cap at 30 fps, and stop re-arming rAF once the level has decayed to 0 and the analyser peak stays
    0. Restart on the next non-zero read, by polling at ≤ 4 Hz or on the controller's `notes` / drone events.
  - Expected: most of D's saving without hiding the meters, ≈ 8–10 main + 3–4 compositor points here, and up to
    11 GPU points on the Mac with the drone on.
- **R2 (spinner, one line, styles.css):** animate the spinner only while loading:
  `.song-loading-spin { animation: none } .song-block.loading .song-loading-spin { animation: spin .8s linear
  infinite }`. Expected: compositor and GPU at idle ≈ 0 when the meters are still (J).
- **R3 (perform.js `readRuntime`):** skip `setAttribute('aria-label')` / text writes whose value is unchanged. Give
  the drone dB readout a fixed-width cell, so a changing number doesn't re-lay out the row.
- **R4 (hidden window, LOCAL + controller):**
  - Electron main should send `windowHidden` / `windowShown` (menubar-B already asks for this).
  - The controller should pause the UI loops on `status.windowVisible === false` even outside menu-bar mode.
    Meters only; the audio policy is unchanged, so a hidden window's MIDI switch still preloads. For example,
    main.js sets `data-low-resource`-style meter hiding when `!windowVisible`.
  - Re-check rAF in a hidden or minimized window on an unlocked Mac.
- **R5 (memory, for Ryan to decide):** the decoded-sample cap (`cacheMB`, 700) and the 10-unit reverb pool
  (`REVERB_UNITS_MAX`) trade memory for instant switches. Low-resource mode already trims both.
- **R6 (decision, not requested):** suspending the AudioContext after N s of silence (drone off, no voices) would
  remove the last ≈ 8 audio points (L-22: ≈ 19 on the Mac). But `resume()` latency makes the first note after it
  late, so it is only acceptable in hidden low-resource mode with the drone off, if at all.

### Not done

- **An idle sleep for the static FX graph** (chorus, delay, lofi, glue): disconnect the returns after N s with no
  voice and the drone off, and reconnect on the next note. It is worth ≈ 4 audio points here. It was not done
  because the delay loop can still hold audible echoes for minutes at feedback 0.9 (0.9^n with a 1.9 s time).
  Reconnecting would replay a stale tail, unless the line is rebuilt, which costs a click-free swap design.
- **The drone's cost** (≈ 4–7 points) and **the reverb IR length** (6.6 s for size 0.62: 1.1 × the longest band's
  RT60, so the last ~9 % is below −60 dB): both change the sound, so they are left for a listening pass.

## Engine fixer (idle-cpu #2–#4, 2026-09-28 late)

Engine-only changes (`app/js/engine/**`, `shared/automation.js`); UI requests are refreshed in CONTRACT_CHANGES
`## idle-cpu` › "Engine fixer" and `reviews/for-local.md`. The UI fixers landed R1 (meters: 30 fps cap, loop stops at
silence, write-on-change) and R3 while this ran, so the UI columns moved too; the back-to-back table isolates the
engine.

### Measurements (2-CPU box, renderer % of one core; audio = Web Audio thread, rbg = reverb background threads)

Back to back, same UI tree, the pre-change `app/js/engine/` + `automation.js` (a shadow copy) vs this change
(load 14–34, so ±3 points):

| cfg | before: renderer / audio / rbg | after: renderer / audio / rbg |
|---|---|---|
| A Sunday, drone on | 34.3 / 19.6 / 6.1 | 33.0 / 17.2 / 6.4 |
| B drone off | 7.8 / 7.4 / 0 | **5.1 / 4.1 / 0** |
| G1 Glass Ocean | 9.2 / 8.1 / 0.7 | **6.5 / 4.6 / 1.0** |
| G2 Grand Piano | 7.6 / 7.2 / 0 | **4.3 / 3.5 / 0** |

Full post run (23:08–23:17, load 3–20): A 36.0 (audio 18.3, rbg 6.1, main 6.5, compositor 4.2), B 9.4 (audio 4.2),
K 9.8 (4.4), C1 42.7, D 27.4 (18.9 / 7.7), J 27.6 (19.5 / 7.4), H playing 53.0 (28.8 / 7.6), G1 6.7 (5.2), G2 5.1
(4.2). Start of this task (22:10, load 6–13, old UI): A 43.9 (20.5 / 6.8), B 15.3 (7.9), J 25.2 (18.9 / 6.1),
G2 13.4 (7.1). `fxAsleep` in stats: B / K / G1 / G2 all three; A / D / J delay + chorus (the drone feeds the reverb).

What A's DSP is (J = UI floor, in-app bisect after the fixes, load 5–8): drone on 17.7 audio + 6.5–7.2 rbg;
drone.gain 0 (voices still pulled) 9.4 + 0; drone.out cut 3.9 + 0; drone off 4.0 + 0. So the sounding drone costs
≈ 5.5 points of voices and ≈ 8 audio + 7 rbg ≈ 15 points of reverb (a 6.6 s stereo IR fed continuously) plus the
master chain carrying it. **Target A ≤ 15 % is not reachable without changing the sound**: A's DSP alone is ≈ 23–25
points on this box. Offline DSP estimate: A 16.1 % (unchanged), B 6.3 % (the offline graph never sleeps, by design,
and every offline render runs the convolver for its first IR length); the ≤ 3 % target does not apply to a sounding
drone.

### Chromium behaviour measured (plain Web Audio, headless Chromium 1194)

1. **A converged `setTargetAtTime` never ends.** 60 peaking biquads whose gain had converged 16 s earlier: 11.3 %
   vs 7.0–8.3 % static; + a `setValueAtTime(target)` after it: 8.0 %. `automationRate = 'k-rate'` does not help
   (14.0 %). Worse, a GainNode at 0 reached by setTarget is not flagged silent: osc → gain(setTarget 0) → 3 s
   convolver stayed at 13.2 % forever; with the pinning `setValueAtTime(0)` it went idle (2.5 %).
2. **A convolver whose input is removed (or gated to exactly 0) stops after its tail and restarts without losing
   its onset.** Plain test: an impulse after 3 s idle gives the same onset (±1 render quantum) whether the input was
   kept active, silent, disconnected or gated. In the engine, reverb and echo onsets after a wake match a
   never-sleeping reference to the sample (16.44 ms / 244.01 ms after the dry onset).

### Changes

- **#2 send effects sleep** (fx.js `FxGraph.enableIdleSleep / idleTick / wakeAll`, audio.js `_pollFx`, realtime
  only). One AnalyserNode tap per effect (reverb, delay, chorus input; plus both delay lines' loop LPFs), read every
  `FX_IDLE_POLL_SEC` = 0.25 s over a window ≥ 1.25 × the poll (16384 frames), so reads cover time without gaps (a
  late poll restarts the count). An effect sleeps when no slot instrument is connected (armed, incl. retiring) and
  its tap stays below `FX_IDLE_THRESHOLD` = 1e-5 (−100 dBFS) for `FX_IDLE_HOLD_SEC` = 1 s (delay: + its loop
  period, so a whole round trip was seen empty). Sleep = reverb: the active unit's input is disconnected (the tail
  rings out; no sleep during an IR crossfade); delay / chorus: return disconnected from the FX sum (the loop is then
  unreachable, not processed) and the delay's loop taps detached. Wake = `_armSlot` (every note, before it sounds),
  a new drone layer / pad file (Drone option `wake`), or a tap reading signal (backstop). A delay loop only sleeps
  with its content below −100 dBFS, so no stale echo can replay. Offline renders keep the always-on graph.
- **#3 `rampTo` pins its target** (shared/automation.js): `setValueAtTime(value, when + RAMP_SETTLE_TC × τ)`,
  `RAMP_SETTLE_TC` = 12 (residual step e^−12 ≈ 6e-6 of the move). Every helper starts with cancel-and-hold, so a
  later call removes a pending pin. No `rampTo` targets a DelayNode.delayTime (where a sub-sample step could tick).
- **#4 drone parked at gain 0** (drone.js `DRONE_PARK_SEC` = 10): a synth or files drone left at drone.gain 0 for
  10 s fades its layers out (voices end); a key or mode set while parked is remembered; the gain coming back
  restarts it in the latest key with the voice's own attack. Dips shorter than 10 s are untouched. Worth ≈ 5.5
  points while parked.
- Checked, nothing to change: drone mode 'off' ends every voice and returns the instruments disconnected
  (`droneOffNoVoices`); released voices end and disconnect (0 live voices / voice nodes at idle, `fxIdleSleep`);
  per-voice drift/walk sources stop with their voice; shared LFOs of a disconnected instrument or a sleeping chorus
  are not pulled. The IR worker and warming: 0 idle callbacks/s and 0.0 worker CPU in every idle config. Master clip
  oversample is 'none'; lofi's 4x shaper is only connected while lofi is engaged (Sunday: 0). The chorus and tape
  LFOs on `delayTime` stay a-rate (k-rate would step the read point ≈ 2.4 samples per quantum: zipper).

### Tests

Engine `realtime.fxIdleSleep` (sleep + wake vs a never-sleeping reference: onsets equal to 0.5 ms, no extra click,
0 voices / voice nodes at idle), `realtime.droneOffNoVoices`, `offline.droneParkGain0`; `realtime.lowResource` had a
pre-existing race (fails 2 of 3 on the pre-change engine too: the start-up reverb unit still fading) and now waits for
the fade. `test/unit/shared/automation.test.mjs` updated for the pin (+1 test).

Runs: engine suite at load ≈ 7: 73/75 (the `lowResource` race, since fixed and 3/3 alone; `eqCpu` soft warning). A
second full run at load 40–100: 68/75, all 7 failures runner timeouts; re-run one by one: `fxIdleSleep`,
`droneOffNoVoices`, `slotWidthEq`, `washAcrossCommit`, `realInstrumentsSmoke` pass; `stuckNoteFuzz` passes with a
600 s bound on both engines (pre-change 374.5 s, this change 349.0 s, back to back at load ≈ 45). Unit shared
225/225. Instruments suite at load ≈ 40: 140/143 with this change vs 139/143 on the pre-change engine, the same
"perf × realtime" checks failing on both (0.3–0.4× at that load). The phase-2 eq suite could not boot within its
30 s `__rig.ready` bound at load ≈ 45 (the pre-change tree took 189 s to ready there too); not validated.

### Left for Ryan / later

- **The sounding drone's reverb (≈ 15 points here, ≈ 8 reverb-thread points on the Mac)** is the largest remaining
  cost. Options, all audible to some degree: a shorter IR on the drone send (e.g. its own 2–3 s unit), trimming the
  IR at its −60 dB point (6.6 → 6.0 s, ≈ −9 % of the convolution), or rendering the synth drone + its reverb once
  per key into a seamless loop and playing that (files-mode path; ≈ 8 MB per key, near-zero idle CPU).
- The drone's own voices (≈ 5.5 points: 3 voices × 4 saws + sub, 4 StereoPanners, 2 biquads each).
