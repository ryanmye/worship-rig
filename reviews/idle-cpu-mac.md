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
