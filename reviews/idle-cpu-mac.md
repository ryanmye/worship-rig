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
| (h) "hidden" (locked screen), Sunday Pad, drone on (see note) | **44.8** | 45.5 | 13.3 | 13.3 | 91.0 | 10.5 | 0.6 | 10.2 (121) | 5.3 | 122.3 | 20.7 / 9.5 / 5.8 / 3.9+3.8 |
| (h) hidden, **unlocked screen**, System Events `visible=false` (run 4, see below) | **49.3** | 48.3 | 13.9 | 13.7 | 109.9 | 13.4 | 0.6 | 13.0 (120) | 6.5 | 120.4 | 23.2 / 11.2 / 6.5 / 3.6+3.5 |
| (h) hidden, unlocked, ⌘H (`app.hide`) (run 3) | **48.6** | 48.6 | 13.7 | 13.4 | 108.3 | 13.2 | 0.6 | 12.9 (120) | 5.6 | 120.4 | 22.9 / 11.0 / 6.6 / 3.6+3.5 |
| (h) minimised, unlocked, `AXMinimized` (run 3) | **49.3** | 49.0 | 13.9 | 13.6 | 108.0 | 13.3 | 0.5 | 12.7 (120) | 5.5 | 120.4 | 23.3 / 11.1 / 6.6 / 3.7+3.6 |
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

## (h) re-measured on an unlocked screen (2026-09-29, about 02:40–03:00 UTC)

- Build: `dist/mac-arm64/Worship Rig.app` rebuilt 21:36 local. `app/`, `main.js` and `preload.js` are the same as
  in the run above. The screen was unlocked (`IOConsoleLocked` = false) and Ryan was at the Mac.
- Method: same as above. Before each window: Sunday Pad + Piano with the drone set to `synth`, then 10 s of
  settling. The window is 20 s, and the rAF counter runs while the app is still hidden. Afterwards the drone was
  restored to `off`.
- Visible references in the same session: 48.1 (run 4), and 49.3 / 50.2 / 49.1 (run 3) renderer %, all with
  GPU 13–14 %. These are 4–5 points above the locked-screen baseline (44.4). Nothing measurable changes when the
  app is hidden.

| state (unlocked) | renderer cputime | GPU | rAF/s | `visibilityState` | `document.hasFocus()` | Task ms/s |
|---|---|---|---|---|---|---|
| visible (run 4) | 48.1 | 13.5 | 120.4 | visible | true | 111.2 |
| hidden, System Events `set visible … to false` (run 4) | 49.3 | 13.9 | 120.4 | **visible** | true | 109.9 |
| hidden, ⌘H after `activate` (run 3) | 48.6 | 13.7 | 120.4 | **visible** | true | 108.3 |
| minimised, `AXMinimized` = true (run 3) | 49.3 | 13.9 | 120.4 | **visible** | true | 108.0 |

- In all three hidden or minimised states, `get visible of process` read `false` (or `AXMinimized` read `true`),
  so the OS did hide the window. The page never saw it: `visibilityState` stayed `visible`, no
  `visibilitychange` fired, rAF kept running at 120 /s, and CPU is unchanged, both in the renderer and in the
  GPU process.
- After unhiding or restoring, rAF was 120–121 /s and the page was visible, so it came back fine.
- The cause is the shell config: `backgroundThrottling: false` plus the `disable-renderer-backgrounding` and
  `disable-background-timer-throttling` switches in `main.js` also turn off Chromium's occlusion and hidden
  handling. A hidden Worship Rig therefore costs exactly as much as a visible one: about 49 % renderer and 14 %
  GPU with the drone on.
- Suggestion for C7 / L-22: in the shell, forward BrowserWindow `hide` / `minimize` / `show` / `restore`
  (and possibly `occluded`) to the renderer over IPC, and have the UI stop its rAF loops (meters, readout) while
  hidden. Audio must keep running, which is why `backgroundThrottling` is off. This would save the main-thread,
  compositor and GPU share (about 17 + 14 points) without touching audio.
- Other runs:
  - Run 2 is discarded. In it, the h1 System Events window read 58.9 % and ended with the drone `off`.
  - In run 3's h1, the drone also went from `synth` to `off` in both the store and the engine partway through
    the window, so run 3's h1 figure (45.5 %) is not used.
  - Two traced probes (18 s and 42 s hidden, hooking `store.set` and `store.subscribe`) and the clean run 4 did
    not reproduce the flip. The only events were one blur/focus pair on the drone segment button.
  - Most likely something outside my script changed the drone while Ryan was using the Mac, for example the menu
    bar mini window. This is not a confirmed bug. It is only worth a look if it shows up again.

## Build 0816b89: idle-cpu part 1 + low-resource + menu-bar (2026-09-29, 04:00–04:10 UTC)

- Build: `dist/mac-arm64/Worship Rig.app` from 23:40 local. That is c0d64c2 plus 0816b89, which only changes a
  comment in `main.js`, so the build matches main 0816b89.
- The screen was unlocked. The method is the same as above: Sunday Pad + Piano, 10 s settle, a 20 s window,
  renderer and GPU CPU from `ps -o time`, `Performance.getMetrics`, and a 2 s rAF counter.
- New in this section:
  - RSS is the sum of every Electron process of the app.
  - At each window's start and end I logged `controller.status.{lowResource, windowVisible}`, the attributes
    `html[data-low-resource]` and `html[data-window-hidden]`, `rig.getMenuBarState().windowVisible`, and the page's
    `rig:window-visible` / `menu` / `lowResource` events.
- **State at launch:** the library had `settings.lowResource = true` and `settings.menuBarMode = true`, left over
  from earlier use. My first pass therefore measured everything in low-resource mode, and I discarded it.
  - Only one thing from it is kept: with low-resource on from launch, the first window read 44 %, then 31 % a
    minute later. So the idle trim takes a while to act.
  - Pass 2 set both settings to `false` first. At the end both are `false` (`rig-shell.json` `menuBarMode:false`,
    dock back), the drone is back to `off`, and the app was reopened with a plain `open`.

| config | renderer cputime (ps) | GPU | Task / Script / Style ms/s | style recalcs/s | rAF/s (counter) | `data-low-resource` / `data-window-hidden` | `visibilityState` | status lowResource / windowVisible | RSS all procs MB | renderer threads (audio / main / compositor / reverb-bg) |
|---|---|---|---|---|---|---|---|---|---|---|
| (a) drone on, visible | **40.2** (40.4) | 12.7 | 80.3 / 7.0 / 12.3 | 121 | 120.4 | – / – | visible | false / true | 517 | 17.9 / 8.3 / 5.6 / 7.8 |
| (b) drone off, visible | **7.6** (6.9) | 0.0 | 4.7 / 3.0 / 0.0 | 0 | 120.1 | – / – | visible | false / true | 532 | 5.8 / 0.6 / – / 1.0 |
| (c) low-resource on (`settings.lowResource`), drone on | **31.0** (31.1) | 0.0 | 3.4 / 2.6 / 0.0 | 0 | 119.8 | **yes** / – | visible | true / true | 529 | 21.1 / <0.5 / – / 9.5 |
| (c2) same, 33 s later | **30.9** (31.0) | 0.0 | 3.5 / 2.6 / 0.0 | 0 | 120.6 | yes / – | visible | true / true | 505 | 20.9 / – / – / 9.5 |
| (d0) ⌘H, menu-bar mode **off**, drone on | **44.6** (44.2) | 14.1 | 89.1 / 7.3 / 13.7 | 120 | 120.2 | – / – | visible | false / **true** | 505 | 20.3 / 9.2 / 6.0 / 8.6 |
| (d1) ⌘H, menu-bar mode **on**, drone on | **40.0** (39.7) | 12.7 | 79.5 / 6.6 / 11.9 | 120 | 120.3 | – / – | visible | false / **true** | 519 | 17.9 / 8.3 / 5.4 / 8.0 |
| (d2) red close button, menu-bar mode on (hide to menu bar), drone on | **28.8** (28.5) | 0.0 | 3.4 / 2.6 / 0.0 | 0 | 120.2 | yes / **yes** | visible | true (auto) / false | 511 | 19.5 / – / – / 8.9 |
| (d2b) same, 33 s later | **26.2** (26.4) | 0.0 | 2.9 / 2.2 / 0.0 | 0 | 120.3 | yes / yes | visible | true (auto) / false | 477 | 17.9 / – / – / 8.1 |

- The rAF column is my own counter. It keeps running because `backgroundThrottling` is off, which is expected.
  Whether the page's loops are running shows in the style recalcs and Task ms/s columns: 121 /s and about 80 ms/s
  when they run, 0 /s and 3–5 ms/s when they sleep.
- Heap was 5.2–6.0 MB in every row.

### Before and after, against the first run (build e6da619, screen locked; the unlocked visible reference in the first run was 48–50 %)

| | first run: renderer / GPU | now: renderer / GPU |
|---|---|---|
| drone on, visible | 44.4 / 13.2 | **40.2 / 12.7** |
| drone off, visible | 35.1 / 2.4 | **7.6 / 0.0** |
| low-resource | 45.1 / 13.1 (attribute only, no mode existed) | **31.0 / 0.0** (drone on) |
| hidden, ⌘H | 49.3 / 13.9 (unlocked) | **44.6 / 14.1** (menu-bar off), **40.0 / 12.7** (menu-bar on): no change |
| hidden to menu bar (close button) | not available | **28.8 → 26.2 / 0.0** |

### Findings

- **Silence is now nearly free.** With the drone off, the renderer dropped from 35.1 to 7.6 % and the GPU from
  2.4 to 0. No style recalcs happen, so the meters sleep, and the audio thread is at 5.8 %. This is the main
  effect of the idle-cpu part 1 engine fix.
- **With the drone sounding, the cost stays.** In the visible drone-on case (a), about 18 points are audio, 8 are
  reverb convolution, and 14 are main thread plus compositor, with the meters animating at 120 Hz. GPU is 12.7.
  - Low-resource hides the meters and removes the whole UI and GPU share: Task drops from 80 to 3 ms/s, and GPU
    from 12.7 to 0.
  - What remains (31 %) is the drone synth on the audio thread (21 %) plus two reverb convolution threads
    (9.5 %). To go lower, the drone's reverb send, or the convolver itself, would have to be trimmed in
    low-resource mode.
- **Hide-to-menu-bar works.** In menu-bar mode, the red close button made the page receive
  `rig:window-visible {visible:false}`, the menu id `windowHidden`, and `lowResource {on:true, auto:true}`.
  `data-window-hidden` appeared, the meters stopped, GPU went to 0, and the renderer reached 26 % after about
  45 s. Showing the window again (`open` → `activate` → `showMain`) sent `windowShown`, turned low-resource off
  (auto), and returned the page's loops to 120 recalcs/s.
- **⌘H (app hide) is not detected. This is a bug to fix (NEEDS CLOUD).** With menu-bar mode off or on, ⌘H hid
  the app, and System Events `visible` read `false`. But no `rig:window-visible` or `windowHidden` event reached
  the page, and `rig.getMenuBarState().windowVisible` stayed `true` because `win.isVisible()` is still true
  after `app.hide()`. So nothing throttles and the cost is unchanged (40–45 %). Suggestions:
  - In `main.js`, listen to `app.on('did-resign-active')`/`'hide'`-equivalents. On macOS these are the
    `browser-window-blur` event plus `app.isHidden()`, or `win.on('hide')` does not fire for NSApp hide.
  - Or poll `app.isHidden()` on blur.
  - Or treat `win.isVisible() && !app.isHidden()` as "shown" in `windowShownNow`, and send `windowHidden` on
    app hide.
- **Minimise was not re-tested in this build.** The code sends `windowHidden` on `minimize` (`main.js:1141`).
- **Popover (e):** skipped. A tray click can't be scripted from here.
- **RSS:** all Electron processes together were 477–532 MB (`ps` RSS, which understates because of compressed
  pages; see PERF). Low-resource and hide-to-menu-bar moved it by only about −30 to −50 MB within a minute,
  because the current song stays pinned.

## Build d582e68: ⌘H detection (2026-09-29, 04:28–04:40 UTC)

- Build: `dist/mac-arm64/Worship Rig.app`, built 00:27 local from d582e68, which includes b74defa (`app.on('hide')`
  and `app.on('show')` → `rig:window-visible`, and `windowShownNow` checks `app.isHidden()`).
- A Worship Rig started at 00:24, before this build, was still running on 8438. I quit it and relaunched with
  `--remote-debugging-port=9333`.
- The screen was unlocked. Method as above: Sunday Pad + Piano with the drone on (`synth`), 10 s settle, 20 s
  window. I hid the app with ⌘H via System Events after `activate`, and showed it again with `open -a` (activate).
- Settings started as `lowResource:false` and `menuBarMode:false`. At the end they are back to that, the drone is
  back to `off`, and the app was reopened with a plain `open`.

| config | renderer cputime (ps) | GPU | Task ms/s | style recalcs/s | page got `rig:window-visible` | `data-low-resource` / `data-window-hidden` | status lowResource / windowVisible | `getMenuBarState().windowVisible` | RSS MB |
|---|---|---|---|---|---|---|---|---|---|
| (1) visible, menu-bar off | **41.4** (41.0) | 12.5 | 79.8 | 120 | – | – / – | false / true | true | 713 (just launched) |
| (2) ⌘H, menu-bar **off** | **39.2** (38.9) | 11.9 | 73.4 | 120 | **yes**, `false` | – / – | false / **true** | **false** | 550 |
| (2r) shown again, menu-bar off | **41.6** (42.0) | 12.6 | 79.9 | 120 | yes, `true` | – / – | false / true | true | 485 |
| (3) ⌘H, menu-bar **on** | **29.3** (28.8) | 0.0 | 3.3 | 0 | yes, `false`, plus `windowHidden` and `lowResource {on:true, auto:true}` | yes / yes | true / false | false | 474 |
| (3b) same, 33 s later | **29.5** (29.1) | 0.0 | 3.5 | 0 | – | yes / yes | true / false | false | 468 |
| (4) unhidden, menu-bar on | **40.9** (40.6) | 12.4 | 77.8 | 120 | yes, `true`, plus `windowShown` and `lowResource {on:false}` | – / – | false / true | true | 492 |

- **With menu-bar mode on, ⌘H now works (HIDE_OK).** Main detects the hide, and the page switches to automatic
  low-resource. The meters stop (0 recalcs/s), GPU goes to 0, and the renderer drops from about 41 % to
  29 %, the same as the close-button path in the previous section (26–29 %). Unhiding brings everything back
  within one window, including low-resource switching off automatically.
- **With menu-bar mode off, ⌘H is only half done.** Main now sends `rig:window-visible false`, and
  `getMenuBarState().windowVisible` reads `false`. But the page ignores the event: `app/js/main.js` acts only on
  the `windowHidden` / `windowShown` menu ids, and `sendWindowEvent` sends those only in menu-bar mode.
  - So the meters keep running at 120 Hz while the app is hidden (39 %, GPU 12 %), even though the idle-cpu R4
    comment intends that "a hidden window hides the meters the way low-resource does".
  - Suggestion (small, needs cloud): in `app/js/main.js`, listen to the DOM event `rig:window-visible` and toggle
    `data-window-hidden` from it, whatever the menu-bar mode. That hides the meters only; no low-resource.
  - This would save about 12 GPU points and about 10 renderer points (main thread plus compositor) while the
    app is hidden with menu-bar mode off.

### Energy

- **A (`powermetrics`): unavailable.** `sudo -n` needs a password, so I skipped it and did not prompt.
- **B (battery): not meaningful.** The Mac is on AC (`ExternalConnected = Yes`, `FullyCharged`,
  `InstantAmperage = 0`), so the battery current says nothing about the app.
  - `PowerTelemetryData.SystemLoad` (whole-system mW on AC) refreshes only about once a minute. It read 14.4,
    23.0, 20.3, 17.7 and 16.1 W across the run. That is whole-system power, including both displays and every
    other app, too coarse and too noisy to attribute 20 s states.
  - **An energy measurement of the app needs the Mac unplugged, or `sudo powermetrics`.**
- **Used instead (no root needed):** macOS "Energy Impact", which is `top -stats power`, the same figure Activity
  Monitor shows. For each state I summed it over all Worship Rig processes and averaged 4 × 5 s samples (20 s).
  I also give the CPU seconds the app used per 20 s, summed over all its processes from `ps -o time`. This was a
  separate pass right after the table above.

| state (drone on) | Energy Impact, all app processes | of which renderer / GPU / audio service | app CPU seconds per 20 s (renderer / GPU / audio) | Energy Impact sum over all processes on the Mac |
|---|---|---|---|---|
| visible, menu-bar off | **50.0** | 38.0 / 11.6 / 0.3 | 10.99 (8.35 / 2.54 / 0.10) | 298.6 |
| ⌘H, menu-bar off | **54.2** | 41.0 / 12.9 / 0.3 | 11.85 (9.00 / 2.75 / 0.10) | 261.5 |
| ⌘H, menu-bar on (auto low-resource) | **29.7** | 29.3 / 0.0 / 0.3 | 6.51 (6.38 / 0.01 / 0.10) | 238.7 |
| closed to menu bar, close button (auto low-resource) | **29.6** | 29.2 / 0.0 / 0.3 | 6.50 (6.38 / 0.01 / 0.10) | 233.7 |
| app quit | **0** | – | 0 | 225.8 |

- Hidden in menu-bar mode, the app uses about 40 % less energy than visible (Energy Impact 50 → 30, CPU seconds
  11.0 → 6.5). All of what remains is the renderer's audio: the drone synth and reverb convolution. The main
  process, the audio service and the network process are all near 0.
- The whole-machine sum (last column) moves with everything else running on the Mac, such as Chrome and
  Claude. Use it only as a rough check: quitting the app lowers it by about 8–73 points.
- `pmset -g therm`: no thermal warning, no performance warning, and no CPU power status recorded.
- Idle wakeups: `powermetrics` was unavailable, and my `top IDLEW` parse did not come through, so they are not
  reported.

## Build 1ce40b4: lowres2 + idle-cpu-ui + themes (2026-09-30, 05:20–05:30 UTC)

- Build: `dist/mac-arm64/Worship Rig.app` built 01:13 local from the merge 1ce40b4. `app/`, `main.js` and
  `preload.js` are the same at HEAD 6b5523e. It includes lowres2 + lowres2-scope (frozen drone and audio sleep, both
  only inside low-resource mode), idle-cpu-ui (one shared meter clock, ≤ 30 frames/s, stops when silent, hidden or
  in low-resource), 8 themes with Sanctuary as the default, and the popover theming.
- Setup: the screen was unlocked, and the Mac was on AC. Ryan was at the Mac. I quit the running app and relaunched it
  with `--remote-debugging-port=9333`. Playwright 1.56 attached over CDP to `http://127.0.0.1:8438/`. The processes
  were one renderer (38510), GPU (38508), main (38506) and the audio service (38519).
- Method: the same as the sections above.
  - Sunday Pad + Piano with the drone set to `synth` (the library copy has `off`). 10 s settle, then a 20 s window.
  - Renderer, GPU and main %CPU come from `ps -o time=` deltas.
  - Energy Impact is `top -l 5 -s 5 -stats pid,cpu,power -pid …` over every app process. The first sample is dropped,
    and the remaining 4 × 5 s are averaged.
  - Recalcs and layouts come from CDP `Performance.getMetrics` deltas.
  - "rAF/s" counts the page's own `requestAnimationFrame` calls (a wrapper on `window.requestAnimationFrame`), not a
    probe loop. This build's meters therefore show up directly.
  - Audio status is `controller.status.audio` with `engine.sleepState`. Frozen is `engine._debugStats().droneFrozen`.
  - I read `engine.analyserL` peak at the start and end of each window, to show the drone is still audible.
- Starting state: `settings.lowResource = true`, `menuBarMode = true`, `audioSleepSec` absent (so 30), theme
  `sanctuary`, and the Sunday Pad drone `off`. I set `audioSleepSec` to 10 for the sleep test.
- One discarded run: the first state 1 window ended with the drone `off`. `__rig.diag.drone` recorded it as `synth →
  off` at input `pointer`, with the focused element `drone-on` and the call site `onTile.js:50 → setDroneOn`.
  - That is a real click on the Drone tile about 11 s into the window. Most likely Ryan hearing the drone. It is not
    the L-24 flip.
  - The diag hook works: it named the cause in one read. The window was re-run and the drone stayed on.

| state | renderer % | GPU % | Energy Impact (app) | recalcs/s | rAF/s | Task ms/s | audio | drone frozen |
|---|---|---|---|---|---|---|---|---|
| (1) visible, menu-bar off, drone on (Sanctuary) | **47.0** / 45.0 / 45.2 | 10.9 / 10.8 / 10.6 | **57.0** / 55.2 / 54.9 | 29.1 | 30.2 | 58–62 | running | no (live) |
| (1t) same, theme Classic | 38.9 | 8.9 | 47.0 | 29.2 | 30.3 | 50 | running | no (live) |
| (2) low-resource on (`settings.lowResource`), visible, drone on | **11.6** → 10.7 (+20 s) | 0.0 | **11.8** → 11.0 | 0 | 0 | 3–6 | running (peak 0.065–0.072, live was 0.068) | **yes** (1 render, 1041 ms; frozen 1.3 s after the switch) |
| (3) low-resource on, drone off, idle ≥ `audioSleepSec` (10) | **0.1** | 0.0 | **0.1** | 0 | 0 | 0.6 | **asleep** (ctx `suspended`) | – |
| (4) ⌘H, menu-bar mode **off**, drone on | **35.9** | **0.0** | **35.6** | **0** | **0** | 3.2 | running | no (live; low-resource stays off) |
| (5) menu-bar mode on, red close button (hide-on-close), drone on | **9.8** → 9.8 (+20 s) | 0.0 | **10.0** → 10.1 | 0 | 0 | 3.3 | running | **yes** (reused the kept loop, 279 ms after close) |
| (6) app quit | 0 | 0 | **0** | – | – | – | – | – |

- The main process was 0–0.1 % (Energy 0–0.1) in every row except the discarded one. The audio service was 0.5–0.6 %
  (Energy about 0.5) whenever the context ran, and 0 while asleep.
- Rows (1), (1r) and (1t Sanctuary) are three windows of the same config, 6 min apart. The Classic-vs-Sanctuary pair
  (1t) was taken back to back, and the thread split came from `ps -M` deltas (thread roles inferred from their size
  and order, as in the first run; no `sample` this time).
  - Audio render thread: 21.5 (Classic) vs 24.8 (Sanctuary).
  - Reverb convolution: 4.3 + 4.1 vs 4.8 + 4.5.
  - Compositor: 3.2 vs 3.8.
  - GPU: 8.9 vs 10.6.
  - So Sanctuary costs about +2 GPU and +1 compositor. The rest of the 6-point gap is audio-thread noise between
    windows.

### Before and after (previous build: sections "Build 0816b89" and "Build d582e68" above)

| | before: renderer / GPU / Energy | now: renderer / GPU / Energy |
|---|---|---|
| visible, drone on | 40.2–41.6 / 12.5–12.7 / 50.0 (theme Classic then) | **45–47 / 10.8 / 55–57** (Sanctuary); **38.9 / 8.9 / 47** (Classic). rAF 120 → **30**, recalcs 121 → **29** |
| low-resource, visible, drone on | 31.0 / 0 / – (live drone synth 21 + convolvers 9.5) | **10.7–11.6 / 0 / 11–12** (frozen loop, reverb asleep) |
| silent | drone off, awake: 7.6 / 0 / – | low-resource + asleep: **0.1 / 0 / 0.1** |
| ⌘H, menu-bar off | 39.2 / 11.9 / 54.2 (meters ran) | **35.9 / 0 / 35.6** (meters stop, `data-window-hidden` set) |
| hidden to menu bar (close or ⌘H), drone on | 26.2–29.5 / 0 / 29.6–29.7 | **9.8 / 0 / 10.0** |
| quit | 0 | 0 |

### Findings

- **The frozen drone does what lowres2 promised.** Low-resource with the drone sounding went from 31 % (Energy about
  30) to 11 % (Energy 11), and hidden-to-menu-bar went from 26–29 % to 9.8 % (Energy 10).
  - The drone stays audible: the analyser peak was 0.057–0.075 frozen vs 0.054–0.073 live.
  - `fxAsleep` includes the reverb.
  - The first freeze rendered in 1041 ms and was playing 1.3 s after `settings.lowResource` → true. The close-button
    path reused the kept loop (279 ms, no render).
- **Audio sleep brings the idle app to about zero.** In low-resource mode with the drone off, the context suspended
  5.6 s after the drone was switched off: the drone's 5 s fade, then the sleep tick, since the input clock was already
  past 10 s. The whole app then reads 0.1 % and Energy 0.1, against 7.6 % for silent-but-awake in the previous build.
  - As designed (lowres2-scope), a sounding drone blocks sleep: `sleepBlockers()` = `['drone']` after 76 s in
    low-resource.
  - Outside low-resource the context never sleeps.
- **Wake latency (3 trials, asleep for ≥ 1 s each).** Two trials used `midi._inject([0x90,60,70])` through the real
  MidiInput path, and one used `controller.perform.noteOn`.
  - `ctx.state` running = `status.audio` running = `sleepState` awake: **21 / 12 / 12 ms** after the injection. The
    engine's own `lastWake.ms` read 17.3 / 10.3 / 8.0, with the note queued, a 5 ms wake ramp and 20 ms lead.
  - First analyser frame above 1e-3: **80 / 71 / 59 ms**. That includes the 20 ms note lead and the analyser's
    2048-sample window, so it is an upper bound on the added latency, not the latency itself.
- **⌘H with menu-bar mode off is fixed (R4).** The page got `rig:window-visible {visible:false}` and set
  `html[data-window-hidden]`. Recalcs, rAF and GPU all went to 0, and Energy fell from 55 to 36 (−35 %).
  - The drone stays live here, as intended: no low-resource, so no freeze.
  - `open -a` brought back `{visible:true}` and cleared the attribute.
- **Visible drone-on is not cheaper.** The meters now run at 30 rAF/s and 29 recalcs/s (was 120/121), with 0 layouts.
  But the renderer total is dominated by the audio thread (21–25 %) and the two reverb convolution threads (about 9 %).
  - The UI saving (GPU 12.7 → 8.9 on Classic) is partly eaten by Sanctuary's heavier compositing (+2 GPU).
  - The next lever for the visible case is audio, not UI.

### Popover theme check (real Electron popover)

- In menu-bar mode, with the window closed to the menu bar, I clicked the real tray item through System Events
  (`click menu bar item 1 of menu bar 2`). That creates the Electron popover, and `mini.html` appeared as its own CDP
  target, so no headless stand-in was needed.
- In the main page I ran `store.set('settings.theme', …)` for `classic`, `sanctuary` and `daylight-day`, then
  `sanctuary` again. The popover's `html[data-theme]` followed each one, **without a reload** (`performance.timeOrigin`
  unchanged):

  | theme | follow time (includes the CDP round-trip) | popover sheet | popover card background |
  |---|---|---|---|
  | `classic` | 21 ms | `/mini.css` only | `rgb(27, 25, 22)` |
  | `sanctuary` | 33 ms | `/themes/sanctuary-v2/theme.css` | `rgb(22, 9, 19)` (= swatch `#160913`) |
  | `daylight-day` | 33 ms | `/themes/daylight-v2/theme.css` | `rgb(243, 239, 231)` (= `#f3efe7`), `data-mode=light` |
  | `sanctuary` (again) | 27 ms | same as above | same as above |

- Screenshots were taken at 320×440 into the scratch folder (`popover-{classic,sanctuary,daylight-day}.png`). All
  are opaque cards with correct contrast.
- Opening the popover while the app was hidden did **not** thaw the drone. Low-resource stayed on, the drone stayed
  frozen, and no `rig:window-visible` or `lowResource` event fired.
  - `status.popoverOpen` stayed `false`, because LOCAL `main.js` does not send `popoverShown` / `popoverHidden` yet.
    That is the lowres2-scope R2 request, still open for LOCAL.

### Restored

- The theme is `sanctuary` and the drone is `off` (the object is identical to the original).
- `lowResource` and `menuBarMode` are back to **true / true**, the values found at start, not off.
- `audioSleepSec` is now `30`. It was absent before, and `store.set` cannot delete it; 30 is the default, so the
  behaviour is identical.
- The app was quit, which left 0 processes and 0 Energy Impact. It was reopened with a plain `open`, with no debug
  port.
