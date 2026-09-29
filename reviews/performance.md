# Performance profile: 19 factory songs, perform loop, song switches (C6 critics, 2026-09-29)

Scope: what the app costs while someone **plays**, not idle (idle is `reviews/idle-cpu.md` / `idle-cpu-mac.md`).
Per factory song, a 20 s scripted loop through `controller.perform`, then 10 song switches each followed straight away
by 10 s of playing. Everything below is measured; lines marked *unverified* are inference.

## Method

- Harness: **`tools/profile.mjs`** (new, LOCAL-owned dir, written by this profiler). It serves `app/` with
  `server.js`, boots headless Chromium 141 (`--enable-precise-memory-info`, autoplay allowed, 1440×900, `midi`
  granted) and drives `window.__rig`.
  - `node tools/profile.mjs [--only slug,slug] [--loop 20] [--switches 10] [--no-profiler] [--json out.json]`
  - The loop (in-page timers, no Playwright round-trips): a 4-note chord every 1 s (C2+C4 E4 G4 → G → Am → F, bass
    note in the bass split), a melody note every 250 ms (200 ms long), sustain down on even bars and up on odd ones,
    and a 30 Hz mod-wheel triangle 0 → 1 → 0 every 4 s (`perform.wheel`). Then release, sustain up, wheel 0, +3 s.
  - A song's loop starts when the main thread had no long task for 3 s, no reverb unit is in flight and no sample
    request for 3 s (the first version waited only for long tasks and measured the neighbour warm-up by accident;
    that turned into finding 1).
- Per song:
  - `engine._debugStats()` every 250 ms (peak voices / nodes / decodedMB / pinnedMB) and 3 s after release.
  - **Per perform call**: the synchronous main-thread cost of each `perform.noteOn/noteOff/sustain/wheel`
    (controller → engine → voice graph → sync event listeners), and a 4-note chord's total.
  - **Lag**: the melody runs on absolute 250 ms deadlines; how late each fires is the queueing delay a MIDI message
    arriving then would see before its handler runs. Render-quantum overruns are not observable from the page, so
    lag + per-call cost is the input-latency proxy, and `/proc` is the audio-thread proxy.
  - Main thread: `PerformanceObserver('longtask')` and `long-animation-frame` (script attribution), CDP
    `Performance.getMetrics` deltas (TaskDuration / ScriptDuration / LayoutDuration / RecalcStyleDuration, thread
    ticks), CDP sampling `Profiler` (1 ms) → self time by `file:line:col function` and each hot function's callers.
  - Linux `/proc` per-thread CPU: renderer main, Web Audio render thread (`AudioOutputDevice`), reverb convolution
    background threads, compositor; GPU process; renderer RSS.
  - Memory after two forced GCs: `performance.memory` and CDP `Runtime.getHeapUsage`, CDP `Memory.getDOMCounters`
    (nodes, `jsEventListeners`), element count, and **live listeners** from an `addEventListener` /
    `removeEventListener` patch installed before any app script (WeakMap per target, `once` / `signal` handled, a
    FinalizationRegistry drops collected targets; reports by target kind and on detached nodes).
  - Sample fetches (`/samples|user-samples|pads/*.wav…`) during the loop.
- Switches: 10 selects in library order from the last song, so #1 is a **jump back to song 1** after the walk; per
  switch the load time with its long tasks and fetches, then the 10 s loop played immediately (neighbour warm-up
  under it).
- Also: `ConvolverNode.buffer =` cost per IR bucket (1.5–8 s, `1.1 × RT × sr` frames, stereo, median of 3).
- Box: the 2-CPU Linux container, shared with other agents. **Run 3 is the table below** (load 1–4 during the song
  loops, 5–8 during the switches). Run 1 (load 16–30) and run 2 (load 3–7, the quiesce bug) are quoted where they
  add something. On 2 CPUs the Web Audio thread (25–85 % of a core here) competes with the main thread, so **lag is
  inflated here** in proportion to the audio thread's load; the M2 Pro gives the audio thread its own core. Compare
  songs within the run; per-call costs are CPU-bound and transfer better than lag.

## Results per song (run 3)

Engine and input latency (20 s loop). "+3 s" = 3 s after release; pads, drones and long releases still sound then.

| Song | Load ms | Voices peak | Nodes peak → +3 s | Voices +3 s | Decoded / pinned MB | noteOn p50 / p95 / max ms | 4-note chord max ms | Lag p95 / max ms | Long tasks n / max ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| sunday-pad-piano | 89 | 44 | 623 → 447 | 16 | 653.1 / 332.9 | 0.9 / 3.1 / 11.5 | 15 | 1.6 / 13.8 | 1 / 64 |
| building-swell | 117 | 42 | 782 → 365 | 16 | 653.1 / 332.9 | 1.1 / 7.2 / 19.5 | 22.3 | 16.8 / 19.7 | 1 / 57 |
| prayer-wash | 92 | 24 | 565 → 428 | 16 | 653.1 / 332.9 | 0.8 / 7 / 10.1 | 16.1 | 14.7 / 39.7 | 0 / 0 |
| organ-swell | 138 | 31 | 604 → 428 | 13 | 653.1 / 417.1 | 1 / 6.6 / 18.3 | 20.2 | 7.8 / 15.8 | 0 / 0 |
| grand-piano | 80 | 20 | 179 → 138 | 0 | 653.1 / 417.1 | 0.3 / 2.3 / 6.1 | 2.1 | 4.2 / 7.2 | 0 / 0 |
| rhodes | 70 | 21 | 201 → 138 | 0 | 653.1 / 417.1 | 0.3 / 0.6 / 1.3 | 1.2 | 1.2 / 5.2 | 0 / 0 |
| felt-piano | 65 | 20 | 178 → 138 | 0 | 653.1 / 417.1 | 0.3 / 1.3 / 6.3 | 3.1 | 6.6 / 9.7 | 0 / 0 |
| lofi-rhodes | 99 | 13 | 245 → 154 | 0 | 653.1 / 417.1 | 0.5 / 1.8 / 8.2 | 9.2 | 9.5 / 25.3 | 0 / 0 |
| dusty-piano | 55 | 20 | 189 → 139 | 0 | 653.1 / 332.9 | 0.3 / 0.9 / 5.8 | 5 | 7.1 / 26.8 | 0 / 0 |
| glass-ocean | 81 | 42 | 528 → 413 | 26 | 653.1 / 332.9 | 1.2 / 8.5 / 23.4 | 26.8 | 44.9 / 119.6 | 17 / 108 |
| sub-shimmer | 279 | 25 | 485 → 420 | 19 | 653.1 / 332.9 | 0.7 / 2.3 / 8 | 6.9 | 23.3 / 48 | 2 / 65 |
| anthem | 110 | 41 | 564 → 337 | 10 | 653.1 / 568.9 | 1.1 / 6.9 / 17.9 | 20.9 | 37.6 / 69.5 | 7 / 95 |
| gospel-stab-b3 | 333 | 21 | 373 → 217 | 0 | 625.7 / 568.9 | 0.9 / 3.1 / 8.8 | 10.3 | 11.1 / 62.6 | 4 / 125 |
| upright-pad | 130 | 44 | 624 → 447 | 16 | 620.1 / 421.2 | 1.7 / 6 / 9.8 | 16.8 | 32.8 / 97.3 | 5 / 98 |
| clav-funk | 113 | 32 | 253 → 157 | 0 | 620.1 / 370.6 | 0.5 / 2.6 / 5.1 | 7.5 | 11.1 / 23.7 | 0 / 0 |
| music-box-lullaby | 85 | 49 | 522 → 378 | 16 | 620.1 / 370.6 | 1 / 4 / 11.4 | 12.8 | 16.8 / 28.5 | 1 / 50 |
| dream-juno | 71 | 42 | 733 → 411 | 16 | 620.1 / 370.6 | 2.3 / 12.7 / 122.3 | 127.2 | 80.4 / 142 | 24 / 160 |
| 80s-ballad | 139 | 34 | 650 → 190 | 0 | 620.1 / 185.3 | 2.3 / 10.5 / 21.2 | 53.6 | 37.3 / 84.5 | 18 / 148 |
| synthwave | 101 | 11 | 317 → 196 | 0 | 620.1 / 0 | 0.7 / 5.2 / 18.2 | 19.5 | 41.2 / 121.8 | 11 / 132 |

CPU and memory (same loops; ms/s = ms of main-thread time per second of wall time; % = of one core).

| Song | Main task ms/s | JS (profiler) ms/s | Layout ms/s | Style ms/s | Renderer % | Audio thread % | Main % | Reverb bg % | Compositor % | GPU % | Renderer RSS MB | Heap MB (GC’d; Δ loop) | DOM nodes | Elements | Listeners (patched / CDP) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| sunday-pad-piano | 206.3 | 18.8 | 44.9 | 9.8 | 90.3 | 50 | 21.9 | 7.2 | 6.7 | 22.6 | 1148 | 9.7 (+0.5) | 3089 | 2069 | 1030 / 1132 |
| building-swell | 217.9 | 22.3 | 46.6 | 10 | 115.1 | 69.8 | 22.9 | 10.4 | 7.2 | 25.6 | 1177 | 10 (+0.1) | 3156 | 2107 | 1050 / 1132 |
| prayer-wash | 211.1 | 20.3 | 47.4 | 9.7 | 110.4 | 62.4 | 22.2 | 14.1 | 6.8 | 21.7 | 1211 | 10 | 2658 | 1786 | 927 / 1029 |
| organ-swell | 212.5 | 18.4 | 45.9 | 9.8 | 102.5 | 56.8 | 22.5 | 11.5 | 7.3 | 24.5 | 1248 | 10.3 (+0.1) | 3277 | 2167 | 1077 / 1161 |
| grand-piano | 185.5 | 15.4 | 20.3 | 10.7 | 70.6 | 30.2 | 20.3 | 9.4 | 7.8 | 26.6 | 1246 | 10.3 | 3081 | 2064 | 1030 / 1048 |
| rhodes | 185.3 | 11.8 | 20.8 | 10.2 | 73.4 | 33.6 | 20.2 | 9.1 | 7.7 | 25.4 | 1263 | 10.4 | 3081 | 2064 | 1030 / 1048 |
| felt-piano | 201.5 | 16.6 | 22 | 11.3 | 81.9 | 36.4 | 21.9 | 12 | 8.4 | 29.7 | 1291 | 10.5 (+0.1) | 3081 | 2064 | 1030 / 1048 |
| lofi-rhodes | 180.3 | 19 | 19.9 | 9.9 | 76.4 | 38.5 | 19.4 | 8.2 | 7.4 | 25.5 | 1308 | 10.7 | 3166 | 2113 | 1054 / 1072 |
| dusty-piano | 186.4 | 18.5 | 20.3 | 10.8 | 71.6 | 34 | 20.2 | 6.4 | 7.8 | 25.8 | 1308 | 10.9 | 3081 | 2064 | 1030 / 1048 |
| glass-ocean | 188.4 | 24.8 | 42.1 | 8.4 | 103.8 | 63 | 19.7 | 10.6 | 6.1 | 21.5 | 1343 | 11 (+0.1) | 2669 | 1794 | 927 / 1009 |
| sub-shimmer | 221.2 | 18.8 | 49 | 10 | 111.8 | 63.3 | 23.2 | 13.2 | 7.1 | 22.5 | 1351 | 11.1 (+0.1) | 2673 | 1795 | 927 / 1027 |
| anthem | 206.6 | 23 | 47 | 9.6 | 105.1 | 64.3 | 21.6 | 8.3 | 6.7 | 24.8 | 1364 | 11.2 | 3095 | 2072 | 1030 / 1048 |
| gospel-stab-b3 | 231.3 | 19.5 | 50 | 10.9 | 97.2 | 55.7 | 24.5 | 4 | 7.9 | 27.9 | 1354 | 11.3 (+0.1) | 3292 | 2176 | 1077 / 1095 |
| upright-pad | 229.9 | 16.3 | 56.5 | 9.8 | 126.3 | 84.7 | 23.9 | 6.4 | 7 | 24.4 | 1366 | 11.3 | 3096 | 2072 | 1030 / 1132 |
| clav-funk | 218.1 | 18.2 | 45.8 | 10 | 86.5 | 46.9 | 23.1 | 3.9 | 7.4 | 24.6 | 1405 | 11.3 (−0.1) | 3096 | 2073 | 1030 / 1048 |
| music-box-lullaby | 219.1 | 22.7 | 45.1 | 10.2 | 113.2 | 66.9 | 23 | 10.3 | 7.7 | 27.4 | 1408 | 11.4 | 3103 | 2077 | 1030 / 1112 |
| dream-juno | 191.5 | 23.8 | 39.5 | 8.4 | 128.4 | 83.7 | 19.8 | 14.5 | 5.8 | 21.5 | 1447 | 11.4 | 2671 | 1794 | 927 / 1009 |
| 80s-ballad | 201.1 | 22.3 | 40.2 | 8.8 | 122.9 | 78.8 | 21.1 | 12.2 | 6.5 | 22.5 | 1457 | 11.4 | 3165 | 2112 | 1050 / 1068 |
| synthwave | 165.5 | 25.9 | 17.7 | 8.4 | 117.8 | 63.8 | 17.5 | 26.2 | 6.1 | 21.2 | 1462 | 11.6 (+0.1) | 3238 | 2153 | 1070 / 1088 |

Song switches, each followed at once by 10 s of playing (run 3; load 5–8).

| # | To | Load ms | Long tasks while loading n / max / total ms | Fetches while loading | Then playing 10 s: long n / max / total ms | Fetches while playing | noteOn p95 / max ms | Lag p95 / max ms |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | sunday-pad-piano (jump back) | 14248 | 25 / 144 / 1790 | 90 | 8 / 178 / 595 | 0 | 6.1 / 21.1 | 41.9 / 130.6 |
| 2 | building-swell | 500 | 1 / 404 / 404 | 0 | 10 / 362 / 940 | 0 | 10.4 / 17.2 | 58.1 / 245.3 |
| 3 | prayer-wash | 191 | 1 / 76 / 76 | 0 | 7 / 265 / 813 | 0 | 13.2 / 33.5 | 66.6 / 257.3 |
| 4 | organ-swell | 135 | 1 / 82 / 82 | 6 | 29 / 248 / 2476 | 74 | 8.7 / 14.7 | 144.3 / 253.6 |
| 5 | grand-piano | 94 | 1 / 81 / 81 | 0 | 3 / 61 / 166 | 0 | 2.1 / 6.8 | 19.6 / 51.2 |
| 6 | rhodes | 57 | 0 / 0 / 0 | 0 | 0 / 0 / 0 | 0 | 3.4 / 4.8 | 17 / 41.3 |
| 7 | felt-piano | 178 | 1 / 120 / 120 | 0 | 0 / 0 / 0 | 0 | 3.2 / 6 | 19.1 / 50.5 |
| 8 | lofi-rhodes | 90 | 1 / 67 / 67 | 0 | 1 / 87 / 87 | 0 | 3.8 / 13.3 | 23.7 / 33.9 |
| 9 | dusty-piano | 99 | 1 / 69 / 69 | 0 | 3 / 110 / 220 | 0 | 2.6 / 7.1 | 13.1 / 60.6 |
| 10 | glass-ocean | 249 | 1 / 181 / 181 | 0 | 40 / 261 / 3951 | 0 | 19.2 / 91.7 | 121.4 / 233 |

Other numbers:
- **Boot** to `__rig.ready` + running context: 10.6 s at load 1 (88.5 s at load 26 in run 1). Boot memory: heap 17 MB,
  3097 DOM nodes, 2075 elements, 1030 live listeners (element 918, window 27, EventTarget 31, MidiInput 14,
  AudioEngine 13, EditState 12, document 10). Biggest listener types: `click` 364, `keydown` 133, 38 each of the
  five setlist drag events.
- **The jump back to song 1** after walking the 19 songs: 14.2 s (run 3), 10.8 s (run 2), **37.6 s at load 20
  (run 1)**. Salamander (≈ 333 MB decoded) was evicted by the walk and re-fetched (90 fetches), with 25 long tasks
  up to 144 ms. This is the large-set design ("songs load as you go"), the same effect as the ≈ 58 s `next / prev`
  stall in `## idle-cpu-mac`. Nothing leaks: it is the cost of a cold heavy song.
- `ConvolverNode.buffer =` at 44.1 kHz, median of 3: 1.5 s bucket 16–41 ms, 3.8 s 26–81 ms, 5 s 33–120 ms, 6.5 s
  71–112 ms, 8 s 55–151 ms (runs 2 and 3; it scales with load). Synchronous on the main thread.
- **Leaks: none found.** Every song loop: DOM nodes Δ 0, live listeners Δ 0, heap Δ ≤ +0.5 MB after GC. Heap after
  all 19 loops and 10 switches: 11.8 MB (17 MB at boot, 9.7 after the first song, then about +0.1 MB per song).
  Across the switches the live listener count follows the song's UI (1070 → 927), 0 listeners sit on detached nodes,
  and CDP `jsEventListeners` agrees within about 100 (it also counts `on*` handlers). Voices reach 0 in every song
  with no sustaining layer (pianos, keys, stabs); pads and the drone still sound 3 s after release by design.
- Renderer RSS climbs with the walk (1148 → 1462 MB) while the JS heap and the decoded cache stay flat. A separate
  probe walked all 19 songs 3 times (a chord in each, GC, then measure): 679 MB at boot, then 1469, **1482, 1607**
  after laps 1, 2 and 3. The decoded cache was 670, 612 and 665 MB, and the heap 10.3–10.9 MB. So 800–940 MB of the
  renderer is not decoded samples, and lap 3 grew by 125 MB. That is **not conclusive**: it could be allocator
  retention or a slow native leak. See finding 6. The Mac's renderer `phys_footprint` was 1099 MB in the
  `.cloud-outbox` PERF line.

## Where the time goes

Steady state (quiet loops): main-thread work is 165–231 ms/s on this box (17–23 % of a core), and only 12–26 ms/s of
it is page JS. The rest is frame production: layout 18–57 ms/s, style 8–11 ms/s, and paint/compositing/`(program)`,
driven by the per-frame meter and wheel writes. Layout doubles, 18–22 → 40–57 ms/s, in every song whose mod wheel
drives a **slot fader**: `slots.1.gain` in 11 songs and `macro.intensity` in anthem and dream-juno. There the fader's
`--ind` indicator and the wheel badge move every frame. The piano songs drive `fx.reverb.returnGain`, and synthwave
drives `macro.wash`; neither moves a fader. The audio thread is 30–38 % of a core for the pianos and 47–85 % for the
pads and synths.

Profiler self time summed over the 19 loops (380 s), with callers:

| Self ms | Function | Main callers |
|---:|---|---|
| 1365 | `views/components/meter.js:40 apply` | meter.js:56 `frame` (rAF, every frame) |
| 826 | `views/components/readouts.js:71 render` | readouts.js:125 `set` |
| 734 | `views/components/util.js:41 setText` | readouts `render` 464, perform.js:1118 `setWheelBadge` 187, readouts.js:15 chord `set` 181 |
| 494 | `views/components/meter.js:28 peakOf` | meter.js:56 `frame` |
| 380 | `views/components/readouts.js:125 set` | perform.js:1366 `'wheel'` listener 228 (per CC event), perform.js:1230 `renderWheel` 79 |
| 362 | `views/components/levelMeter.js:37 frame` | levelMeter.js:13 `loop` |
| 204 | `views/components/fader.js:231 setIndicator` | perform.js:1230 `renderWheel` |
| 183 | `engine/audio.js:1032 slotLevel` | controller.js:2442 |
| 149 | `engine/audio.js:389 _emit` | note/chord/stats events |
| 147 | `engine/audio.js:1263 _applyWheels` | per wheel value |
| 131 | `engine/fx.js:604 _newUnit` | all in synthwave: fx.js:664 via `request()` (macro.wash) |
| 113 | `engine/fx.js:552 irKey` | audio.js:1309, every wheel value (string + `reverbBucket` logs) |

Loops that overlapped loading (runs 1 and 2) were dominated instead by `engine/sampler.js:162` (the `chans.map`
slice in `processSample`) with 1.6 s self, native `copyToChannel` 1.46 s and **GC 1.8 s** in one 20 s loop (run 1,
sunday-pad-piano), and `engine/fx.js:604 _newUnit`, whose single idle-callback task took 902 ms in a smoke run at
load 16.

## The 5 worst offenders

### 1. Neighbour warm-up decodes on the main thread while the song is being played (major)
- **Where:**
  - `engine/sampler.js:140–171` `processSample`: onset scan, then `d.slice(start, start + len)` (a new
    Float32Array of up to 16 s per channel) at :162, fades, the optional `limitMonoLoss`, then
    `out.copyToChannel` at :170.
  - It runs in `decodeAudioData().then` for each sample (LoAF invoker `BaseAudioContext.decodeAudioData.then`,
    `sampler.js`), with 6 concurrent jobs (`engine/audio.js:668`).
  - The warm-up is the large-set neighbour warm that starts right after a switch (controller pin window / warm,
    `## l8`).
- **Measured:**
  - Upright Pad right after its switch: 443 sample fetches in the first 10 s (clavinet 103, ep-wurli 164,
    music-box 88, celesta 88), then 0. No thrash: 0 fetches over the next 60 s idle and 20 s playing.
  - Run 2, where the loop overlapped this: upright-pad noteOn **p95 21 / max 105 ms**, gospel-stab **25.5 / 113.5
    ms**, with 192 and 65 fetches in the loop. The quiet run 3 gives 6 / 9.8 and 3.1 / 8.8.
  - The per-call max is GC landing inside `noteOn`: run 1 shows 1.8 s of GC in one loop, fed by the `slice`
    garbage.
  - Switch → organ-swell, then play at once (run 3): 74 fetches, 29 long tasks (2.5 s in total), **lag p95 144 /
    max 254 ms**.
- **Fixes:**
  - (a) `processSample`: apply the fade-in and fade-out in place on `buf.getChannelData(c)` (the decoded buffer
    is discarded anyway), run `limitMonoLoss` on `subarray`s, and `out.copyToChannel(d.subarray(start, start +
    len), c)`. That is one copy instead of two, and no 16 s garbage arrays.
  - (b) Throttle warm jobs while playing: 1 concurrent job (not 6) while `engine.sounding.size > 0` or within 2 s
    of the last note-on. The current song's own samples keep 6.
  - (c) Later: move the onset scan, fades and mono fix to a Worker (transfer the channel arrays), leaving only
    `new AudioBuffer` + `copyToChannel` on the main thread.
  - Owner: engine (**frozen**, report only) for (a) and (c); controller (cloud) for (b), if it passes a hint (for
    example `preload(…, {background:true})`).

### 2. The top-bar meter and slot meters write style every frame (major for steady state; idle-cpu R1, not landed)
- **Where:**
  - `views/components/meter.js:40 apply`, `:28 peakOf`, `:56 frame`: two `getFloatTimeDomainData` reads, a
    `transform` write, **`hold.style.left`** (layout) and two `classList.toggle`s every frame, even when the level
    is unchanged.
  - `views/components/levelMeter.js:37 frame` and `engine/audio.js:1032 slotLevel`: one analyser read per filled
    strip per frame.
- **Measured:**
  - Together about **2.7 s of JS self time over 380 s** (the biggest steady-state item).
  - A 9 s trace of a switch + play: 871 inline-style invalidations on `.lvl-cover` and 548 on `.meter-fill`.
  - `.song-loading-spin` still animates forever: 450 animation style invalidations in 9 s (idle-cpu R2).
- **Fix:**
  - idle-cpu R1: write only on change, move the hold with `transform`, cap at 30 fps, and stop re-arming rAF at
    level 0.
  - idle-cpu R2: the spinner animates only under `.song-block.loading`.
  - Owner: cloud UI (`idle-cpu-ui`).

### 3. The mod-wheel path relayouts every frame and does DOM work per CC (major while the wheel moves)
- **Where:**
  - `views/perform.js:1366–1370`: the `'wheel'` listener calls `wheel.set({pickup:false})` **synchronously on
    every wheel event** (MIDI CC rate), which writes `ghost.hidden` and `classList.toggle('pickup')` each time.
  - `views/components/readouts.js:71 render` (from `set`, :125): rewrites `--pos` and `aria-valuetext` every
    frame, unguarded, plus `setText`.
  - `views/components/fader.js:231 setIndicator`: `indicator.hidden = false` and `--ind` on the fader root every
    frame. The CSS positions it with **`bottom: calc(… var(--ind))`** (`app/styles.css:162`), which is layout.
  - `views/perform.js:1118 setWheelBadge` → `setText`.
- **Measured:**
  - Layout 40–57 ms/s in the 13 songs whose wheel moves a slot fader, against 18–22 ms/s in the 5 piano songs
    and synthwave: about **+25 ms/s of layout while the wheel moves**.
  - Self time: `render` 826, `setText` 734, `set` 380 (228 of it from the per-CC listener), `setIndicator` 204
    and `renderWheel` 199 ms.
  - Trace: 107 / 94 "#text Added to / Removed from layout" invalidations. `setText` assigns `textContent`, which
    replaces the Text node.
- **Fixes:**
  - (a) perform.js:1366: call `wheel.set({pickup…})` only when `det.pickup` / `det.hardware` changed, or inside
    `wheelRaf`.
  - (b) readouts `render`: skip `--pos` / `aria-valuetext` when the rounded value is unchanged.
  - (c) fader `setIndicator`: return early when the value and visibility are unchanged, and move the indicator
    with `transform: translateY(…)` on `.fader-indicator` itself instead of `bottom` + a custom property on the
    fader root.
  - (d) util.js:41 `setText`: when the element holds one Text node, set `el.firstChild.data = s`, which avoids the
    node replacement.
  - (e) CSS: `contain: layout paint` and `font-variant-numeric: tabular-nums` with a fixed width on
    `.wheel-value`, `.wheel-badge` and the drone readout, so a text change can't relayout the stage.
  - Owner: cloud UI (perform.js / components / styles.css).

### 4. Reverb convolvers are built on the main thread, including mid-song (major for macro.wash songs)
- **Where:** `engine/fx.js:604 _newUnit` → `conv.buffer = ir` (fx.js:609). Chromium partitions the IR
  synchronously, and it is called from:
  - `_unitAsync` after `idlePeriod(40, …)` (fx.js:666). An idle period with ≥ 40 ms left does not bound a
    16–151 ms call.
  - `Reverb.warm` for neighbours (fx.js:734; audio.js:654).
  - `Reverb.request` (fx.js:836) from `_applyWheels` when **macro.wash** moves the size across a bucket
    (audio.js:1309). `irKey` builds a string with log math on every wheel value: 113 ms self.
- **Measured:**
  - `conv.buffer` costs 16–151 ms per unit here (table above).
  - synthwave (wheel → macro.wash): 131 ms of `_newUnit` inside its 20 s loop, and lag max 122 ms.
  - Neighbour warms: one 902 ms `IdleRequestCallback` task (fx.js) in a smoke run at load 16, and 203 ms / 73 ms
    tasks right after the switches to grand-piano and rhodes in run 1.
- **Fixes:**
  - (a) For a song whose wheel or expression targets `macro.wash`, stage every bucket the sweep can reach
    (`reverbBucket(lerp(size, 0.9, 0…1))`, 2–4 units) in `prepare()`, so a sweep never builds a unit.
  - (b) Hold idle-time `warm` builds while notes sound (the `engine.sounding.size > 0` gate from finding 1).
  - (c) Cache `irKey` by `(size, damp)` or compare buckets numerically in `_applyWheels`.
  - (d) Optional: quantise `damp` to 3 steps in `irKey` (from 11) so fewer distinct units exist.
  - Owner: engine (**frozen**, report only).

### 5. The note-on path does synchronous fan-out and graph building per note (moderate; pads and synths)
- **Where:**
  - Voice graph construction: native `OscillatorNode` / `GainNode` / `BiquadFilterNode` / `connect` dominate
    the synth loops. In run 1 dream-juno spent 1229 ms in `connect` over 20 s. See `synth-extra.js:1018/1077`
    (`voice` / `_buildVoice`), `synth.js:224 sawStack`, `voice.js:800 osc`.
  - `voice.js:282 _playing` allocates an array on every `makeRoom` (:293) call.
  - `engine/audio.js:1680 _notesChanged` dispatches `'notes'` and runs `heldChord` / `chordName` for every note,
    and each listener runs inside the MIDI handler. Among them is `views/edit/shell.js:322 → :730 renderLeds`,
    which updates Edit's tab LEDs **while Edit is hidden** (81–173 ms self per run).
- **Measured:**
  - noteOn p50 is 0.3 ms for the pianos and 0.8–2.3 ms for the pads and synths.
  - A 4-note chord's worst case: dream-juno **127 ms** (p95 44), 80s-ballad 54, glass-ocean 27, against 1–5 ms for
    the pianos.
  - dream-juno's lag p95 is 80 ms, but its audio thread uses 84 % of a core on 2 CPUs, so part of that is
    contention.
- **Fixes:**
  - (a) Coalesce `'notes'` / `'chord'` to one emit per task (`queueMicrotask`). A chord from one MIDI packet is
    then one event, and the UI listeners run once. drone.notesChanged stays synchronous.
  - (b) Edit shell: skip `renderLeds` while `#view-edit` is hidden, and catch up in the show hook.
  - (c) `makeRoom`: count held/released voices incrementally and allocate only when stealing.
  - (d) *Unverified, needs a prototype:* pool per-voice `GainNode` / `BiquadFilterNode` stages (they can be
    re-used; oscillators can't) for synth-extra patches, to cut the per-note constructor and `connect` cost.
  - Owner: engine (**frozen**) for (a), (c) and (d); cloud UI for (b).

### 6. (memory, cause *unverified*) The renderer holds 800–940 MB beyond the decoded cache, possibly growing
- RSS after each 19-song lap was 1469, 1482 and 1607 MB (+13, then +125). Over the same laps the decoded cache was
  612–670 MB, the JS heap 10–11 MB and the engine nodes 196, all flat. Three laps can't tell allocator retention
  from a slow native leak (AudioBuffers or convolver kernels kept by a reference outside the JS heap).
- Likely contributors (not measured one by one): the full-length decoded buffers that `processSample` copies out of
  (garbage after the copy, but allocator pages are retained), the fetched compressed ArrayBuffers, and up to 10
  convolver units plus 12 cached IRs (`REVERB_UNITS_MAX`, `IR_CACHE_MAX`).
- Fix (a) of finding 1 shrinks the first of these.
- To decide: the Mac soak should log the renderer's `phys_footprint` per row (requested of LOCAL). Growth that
  doesn't level off over 30 min is a leak. To attribute: `chrome://memory-internals`, or a native heap dump
  (`--memlog=renderer`) after 3 laps.

## What is fine
- Nothing leaks during play or switching: DOM, listeners, heap and engine nodes return to baseline (see above).
- A wheel call costs p95 0.3–1.9 ms, and sustain is cheap. In the piano songs (grand, rhodes, felt, dusty) noteOn is
  0.3 ms median and a 4-note chord ≤ 5 ms.
- Song switches between warm songs load in 57–500 ms, with at most one long task (≤ 181 ms, except 404 ms into
  building-swell) while loading.
- 0 console errors in all three runs.

## Requests
- LOCAL (appended to `reviews/for-local.md`): run `node tools/profile.mjs --json …` on the Mac. It has no /proc
  there, but the per-call cost, lag, long tasks, LoAF, CDP metrics and memory all work. Then run the Upright Pad
  switch-and-play check on the built app.
- Cloud UI (`idle-cpu-ui`): findings 2, 3 and 5b.
- Engine (frozen): findings 1a/1c, 4, 5a/5c/5d. The controller side of 1b.
