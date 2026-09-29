# Idle CPU on the Mac (IDLE_CPU_MAC, ground truth for L-22)

- Date: 2026-09-28, 23:43–23:56 UTC.
- Commit: the repo was at 9583603. The build is `dist/mac-arm64/Worship Rig.app` from e6da619 (built 18:41).
  `app/`, `main.js` and `preload.js` are unchanged between e6da619 and HEAD, so the build matches the tree.
- Machine: MacBook Pro, Apple M2 Pro (10 cores), 16 GB RAM, macOS 26.4 (25E5207k). The built-in Liquid Retina
  XDR display is ProMotion. An external 1920×1080 display was also attached. The screen was **locked** for the
  whole run (`IOConsoleLocked` = true).
- Launch: `open -a … --args --remote-debugging-port=9333`. Playwright 1.56 attached over CDP to the main page
  (`http://127.0.0.1:8438/`). There was one renderer (pid 16449) and one GPU process (pid 16447).
- No notes were played in any configuration. `engine.setLowResource` does **not** exist in this build.

## Method

- Before each window: make the change, then wait 10 s.
- Window: 20 s. CPU was read two ways. The first is `ps -o time=` at the start and end of the window, divided by
  wall time (the "cputime" column, which is the preferred figure). The second is the average of 10 `ps -o %cpu`
  samples taken every 2 s (the "ps" column).
  - A scripting slip in the first run: `ps -p R,G` prints rows in pid order, so the renderer and GPU columns of
    the %cpu samples were swapped. They are un-swapped in the table below, and the corrected script is kept in
    the scratch folder. With that fix, ps and cputime agree to within 2 points everywhere. `top -l 3 -s 5`
    during (b) read 28–40 %, which is consistent.
- CDP `Performance.getMetrics` deltas over the same window are given in ms of main-thread time per second of
  wall time, along with style recalcs per second.
- Per-thread renderer CPU comes from `ps -M` utime+stime deltas. Thread names come from one `sample` snapshot,
  matched by thread order. The thread count was 38 in every configuration, so the order held.
- The rAF rate was measured with a 2 s `requestAnimationFrame` counter after each window.
- Library note: the library copy of *Sunday Pad + Piano* (`song_mukw6p8u019li35`, factoryId
  `factory:sunday-pad-piano`) had `drone.mode` = `off`, although the factory preset has `synth`. For "as built"
  I set it to `synth` through `store.set('songs.<id>.drone.mode', …)`. Afterwards I restored the original drone
  object (`off`) and the startup song (Organ Swell), and set the view back to Perform.

## Results (renderer and GPU in % of one core)

| config | renderer cputime | renderer ps | GPU cputime | GPU ps | Task ms/s | Script ms/s | Layout ms/s | Style ms/s (recalcs/s) | heap MB | rAF/s | renderer threads (audio / main / compositor / reverb-bg) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| (a) Perform, Sunday Pad + Piano, drone synth | **44.4** | 43.0 | 13.2 | 12.5 | 85.0 | 10.4 | 0.6 | 9.4 (121) | 5.1 | 122.0 | 21.0 / 8.9 / 5.7 / 4.0+3.8 |
| (b) same, drone off | **35.1** | 34.4 | 2.4 | 2.2 | 55.1 | 10.8 | 0.0 | 8.1 (121) | 5.8 | 121.3 | 17.4 / 5.8 / 3.3 / 4.3+4.2 |
| (c) Edit view (drone on) | **43.5** | 44.9 | 15.1 | 14.7 | 91.2 | 13.0 | 0.8 | 5.6 (73) | 5.2 | 122.2 | 20.5 / 9.6 / 4.9 / 3.9+3.7 |
| (d) Settings open (drone on) | **44.6** | 44.8 | 13.5 | 13.5 | 95.4 | 10.6 | 0.7 | 10.3 (121) | 5.8 | 122.7 | 20.2 / 10.0 / 6.1 / 3.7+3.6 |
| (e) `html[data-low-resource="1"]` (no `engine.setLowResource`) | **45.1** | 45.3 | 13.1 | 12.1 | 91.5 | 10.6 | 0.5 | 10.5 (122) | 5.1 | 120.7 | 21.0 / 9.5 / 5.8 / 3.9+3.7 |
| (f) Glass Ocean (synth only, drone off) | **24.4** | 24.5 | 2.4 | 2.3 | 55.8 | 11.0 | 0.0 | 8.3 (121) | 5.4 | 121.6 | 11.3 / 5.9 / 3.4 / 1.9+1.8 |
| (g) Grand Piano (sampler only, drone off) | **19.3** | 17.5 | 2.3 | 2.0 | 60.3 | 9.7 | 0.0 | 8.6 (121) | 5.6 | 121.4 | 9.0 / 6.3 / 3.2 / – |
| (h) "hidden", Sunday Pad, drone on (see note) | **44.8** | 45.5 | 13.3 | 13.3 | 91.0 | 10.5 | 0.6 | 10.2 (121) | 5.3 | 122.3 | 20.7 / 9.5 / 5.8 / 3.9+3.8 |
| (i) (a) after 5 min idle, last 20 s | **45.4** | 45.1 | 13.9 | 13.4 | 94.1 | 10.5 | 0.6 | 10.3 (121) | 5.1 | 120.5 | 20.6 / 9.9 / 5.9 / 3.9+3.8 |

- Thread names:
  - "audio" is `AudioOutputDevice`, the Web Audio render thread.
  - "main" is the main thread (CrRendererMain).
  - "compositor" is `Compositor`.
  - "reverb-bg" is two `Reverb convolution background thread`s. The renderer had 16 of these threads, and at
    most two were busy.
- Layouts per second were 5–6 with the drone on and 0 with it off. The heap delta over each window was within
  ±0.35 MB. There were 2450–2880 DOM nodes.
- (h) did not hide anything that the renderer could see. `System Events … set visible of process "Worship Rig"
  to false` ran without error, and `get visible` returned `false` afterwards. But with the screen locked,
  `document.visibilityState` stayed `visible` and rAF stayed at 122 /s. CDP `Browser.getWindowForTarget` does
  not exist in Electron, so minimizing over CDP was not possible either.
  - Also note that `main.js` sets `backgroundThrottling: false`, `disable-renderer-backgrounding` and
    `disable-background-timer-throttling`. So even an unlocked hide or minimize probably keeps rAF and timers
    running. This needs a re-check on an unlocked screen.
- Refresh rate: `system_profiler` prints no refresh rate on this macOS. rAF runs at 120.5–122.7 /s in every
  configuration, which means 120 Hz ProMotion.

## CPU profile, main thread, 10 s in (a) (1 ms sampling, 7796 samples)

The main thread was idle for 92.4 % of the 10 s. JS plus native work was 7.6 %.

| # | function (self time) | ms | % of all samples | % of busy |
|---|---|---|---|---|
| 1 | `(program)`: native Blink work (rAF dispatch, style, paint, commit) | 657.5 | 6.57 | 86.2 |
| 2 | `apply` `js/views/components/meter.js:40` | 23.6 | 0.24 | 3.1 |
| 3 | `peakOf` `js/views/components/meter.js:28` | 12.0 | 0.12 | 1.6 |
| 4 | `requestAnimationFrame` (native) | 10.6 | 0.11 | 1.4 |
| 5 | `renderDroneReadout` `js/views/perform.js:1223` | 6.1 | 0.06 | 0.8 |
| 6 | `frame` `js/views/components/meter.js:56` | 5.8 | 0.06 | 0.8 |
| 7 | `slotLevel` `js/engine/audio.js:963` | 5.2 | 0.05 | 0.7 |
| 8 | `setAttribute` (native) | 5.1 | 0.05 | 0.7 |
| 9 | `loop` `js/views/components/levelMeter.js:13` | 5.0 | 0.05 | 0.7 |
| 10 | anonymous `js/views/perform.js:1319` (the 150 ms `readRuntime` interval) | 3.8 | 0.04 | 0.5 |

- Next in the list: `parsePath` `shared/params.js:154` 3.8 ms, `setText` `components/util.js:41` 3.8 ms,
  `getFloatTimeDomainData` 2.6 ms, GC 2.5 ms.
- Page JS is therefore about 1 % of a core. The raw profile is `profile-a.cpuprofile` in the scratch folder
  (not committed).

## Conclusions

- **When silent, the audio graph dominates, not the JS.** In baseline (a), the renderer's 44 % splits into:
  - the Web Audio render thread, 21 %;
  - two reverb convolution background threads, about 8 %;
  - the main thread, 9 %;
  - the compositor, 6 %.

  Page JS is only about 1 % of a core (the profile above). The earlier L-22 estimate of "about 27 points UI" was
  too high. The UI side (main + compositor) is 9–16 points of the renderer, plus 2–15 points in the GPU process.
- **The drone is the biggest single toggle.** Turning it on adds 9 renderer points and 11 GPU points (a vs b).
  Only about 4 of those are on the audio thread. The rest is UI: a sounding drone moves the meters and the
  "· −9.1 dB" readout, which gives layout 6 /s and GPU raster at 120 Hz. So with the drone on, the app is not
  idle, and a low-resource mode that keeps the drone should throttle the meters that show it.
- **The sampler doesn't matter when idle.** Grand Piano (sampler only) is the cheapest configuration at 19 %.
  Cost follows the song's synth and FX graph: Grand Piano 19, Glass Ocean 24, Sunday Pad with the drone off 35.
  The two busy reverb convolution threads are about 8 points by themselves on Sunday Pad.
- **The 120 Hz loop never stops.** Every configuration runs 121 style recalcs /s and 55–95 ms/s of main-thread
  tasks, even when fully silent (b, f, g). The reason is that `meter.js` `frame` re-arms rAF every frame and
  writes `transform` and classes at level 0. Edit and Settings change nothing (43.5–44.6 %). The
  `data-low-resource` attribute is inert, because nothing reads it. The load does not settle: after 5 min it is
  45.4 %, the same as baseline.
- **What low-resource mode should stop first:**
  1. Silent audio. Suspend the AudioContext after N s with no voices and the drone off, or disconnect idle
     sends and convolvers. That is 9–26 points; L-22 measured about 19 points for a suspend.
  2. The meter rAF loops (`meter.js` and `levelMeter.js`). Stop them when the peak stays at 0, and cap them at
     30 fps otherwise. That is roughly 5–8 renderer points plus up to 11 GPU points when the drone is sounding.
  3. The 150 ms `readRuntime` / `renderDroneReadout` interval. It is small, but it causes the layouts.
- The hidden-window behaviour is **not measured** because the screen was locked (see the note on (h)). Because of
  `backgroundThrottling: false`, a hidden window probably keeps the full load; check on an unlocked screen.
