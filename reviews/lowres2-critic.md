# lowres2 critic: frozen drone + audio sleep (2026-09-29)

Scope: the builder's `## lowres2` work (engine/drone-freeze.js, drone.js, audio.js sleep, controller input clock,
midi.js 'input'). Verified by re-running the builder's suites and by adversarial cases in
`test/phase1/engine/critic-lowres2.mjs` (runner: `node test/phase1/engine/critic-run.mjs [case…]`, one page per case,
renderer RSS from this browser's own processes, forced GC over CDP). Box: 2 CPUs shared with other agents (load 5–7
throughout), headless Chromium, 44.1 kHz. Fixed items are marked **fixed**; open items have repro steps.

## Results per brief item

| # | Case | Result |
|---|------|--------|
| 1 | key change during a crossfade (live → frozen, frozen → frozen, thaw, render in flight) | right end state every time (frozen in the new key, or live with 1 layer and send 0.4), 0 stale swaps, 0 clicks, `_fzOut` 0. Dips are the live drone's own key-change dip (drone-osc 2 s attack vs a 0.3 s song fade; live control −10.6 … −11.6 dB): −7.4 … −16.6 dB, see R5 |
| 2 | low-resource on/off 5× in 3 s | **fixed** (#2): 5 offline renders per storm (2 at once) → 1, then 0 (kept loop); voices 3 → 0 → 3, 1 layer, `_fzOut` 0, level ±1.6 dB (the live drone's drift) |
| 3 | song switch while frozen | synth new key → frozen in it (voices 0); off → loop gone, nothing pending; files → loop gone, files play; `continueAcrossSongs:false` → refrozen in the new key |
| 4 | sustain pedal held, no notes | **bug, fixed** (#4): it slept 2 s after the pedal went down (`sleepBlockers()` was `[]`). Now `['pedal']`; sleeps 2.29 s after release |
| 5 | MIDI note 1 ms after sleep | during the 150 ms ramp: sleep cancelled, note at once (6.9 ms); `suspend()` pending: 29.8 … 50.1 ms; asleep: 42.8 … 50.6 ms (≤ 80). No race: Chromium sets `ctx.state` to 'suspended' synchronously, so `wake()` resumes |
| 6 | asleep → popover `record` | awake in 20 ms, stays awake while recording, asleep 1.98 s after stop |
| 7 | asleep → MIDI hot-plug | awake in 20 ms (`lastInputKind: 'hotplug'`), output peak 0, 0 clicks |
| 8 | re-render (20 s loop) while a pad chord is held | skipped render quanta per 20 s: 2 … 11 with renders vs 13 … 44 without (the shared box); longest hole 2.9 … 20 ms with vs 5.8 … 70 ms without; 0 clicks. No audio-thread evidence against it. Main thread: one 74 ms long task per render, see R4 |
| 9 | memory after 20 re-renders | `droneFreezeMB` 6.7 → 6.7, decoded / pinned 0 → 0, nodes 121 → 121, renderer RSS 147.4 → 147.3 MB (after GC), JS heap 9.5 → 9.7 MB, `_fzOut` 0 |

Also measured: frozen vs live, same key, whole loops: stereo power +0.59 dB (4 s loop) / −0.08 dB (20 s), L/R correlation
0.92 vs 0.94 live.

## Fixed in this pass

- **#1 Frozen → frozen swaps beat (engine drone.js `_freezeSwap`).** A re-render of the same voicing (brightness,
  movement, width, trim, reverb) is the same seeded render with a parameter changed, so the new loop is coherent with the
  playing one; started at offset 0 against a loop at an arbitrary position, the equal-power sum dipped −8.0 / −3.5 /
  −3.4 dB mid-swap (6 swaps). Now it starts at the old loop's position (`start(t, offset)`, `t0` kept in step) and
  crossfades linearly; worst over 12 swaps −1.8 dB (the drone's own 100 ms window spread). Different key / voicing
  (brightness across 0.6) keeps the equal-power swap.
- **#2 Toggle storms render again and again.** Every off → on started a new 20 s render (≈ 1–3 s of a core), even with
  nothing changed, and they overlapped. Now: the last loop is kept (`_fz.last`, one buffer; usually the one playing);
  on → with the same inputs swaps it back without rendering (`droneFreezeReused`); on again before a thaw's 1.5 s lead
  ends keeps the loop untouched (`_unthaw`: its fade cancelled at level 1, the silent thaw layer ended, send closed);
  one render at a time (a request made meanwhile runs when it ends); the first freeze also waits for a live layer still
  fading in (was: immediate, which could swap a loop in over one still waiting to fade). Cost: the kept loop
  (6.7 MB @44.1 k, 7.3 MB @48 k) stays while thawed; counted in `droneFreezeMB`.
- **#4 Pedal.** `engine.sleepBlockers()` adds `'pedal'` while the sustain pedal is down.
- Tests: `realtime.droneFreezeReuse` (new: 1 render, 0 on churn, 4 un-thaws with the level within ±1.5 dB of a
  steady loop, aligned phase error 0, linear fade, swap dip ≥ −1.5 dB vs the quietest window of a whole loop);
  `realtime.audioSleep` step 5b (pedal held 3 s awake with blocker 'pedal', asleep 1.8–4.5 s after release).

## Open (larger; repro steps)

- **R1 Live ↔ frozen swaps can beat hard.** The loop and a fresh live layer play the same partials at unrelated phases,
  so the equal-power crossfade can cancel. Measured (same key, `critic-run.mjs swapLevel`, 3 runs × 2): live → frozen
  −0.9 … −5.5 dB, thaw −0.5 … **−16.1 dB** (100 ms windows, mid-crossfade), bumps up to +3 dB. The thaw is what Ryan
  hears whenever the window shows. Repro: `node test/phase1/engine/critic-run.mjs swapLevel` and read
  `liveToFrozen` / `thaw` (not gated). Options: (a) a shorter swap for live ↔ frozen only (0.1–0.2 s: the hole
  shrinks to tens of ms, but the timbre switch gets audible); (b) measure the correlation of the two signals on two
  AnalyserNodes at swap time and pick the swap moment / gain law (fragile: the drift moves the phase); (c) R2 so it
  happens rarely.
- **R2 The popover counts as "window visible" (controller `setWindowVisible`, LOCAL main.js).** Opening it turns
  low-resource off: thaw (live synth, reverb awake), close → freeze again. With #2 an open/close under 1.5 s is free
  and a longer one reuses the loop, but each still pays R1 twice. Suggest: the popover does not end low-resource (it
  has no meters and no audio of its own); only the main window does.
- **R3 The reverb send taps `drone.out`, after the loop joins.** During every swap the loop (which carries its own
  baked reverb) is fed to the live reverb too (reverb of reverb while `sendGate` > 0), and after a freeze the live
  reverb's tail rings on over the baked one for the IR's length (cathedral 7 s). Repro: freeze with
  `fx.reverb.size` 1 and compare the wet level 0–7 s after the swap with a steady loop. Fix: join the loop after the
  send tap (e.g. its own gain into `wheel`, or tap the send from a pre-loop bus).
- **R4 74 ms main-thread task per render.** `renderDroneLoop` builds the offline graph (Drone + drone-osc) and, after
  the render, crossfades the seam, copies 2 × 20 s into a new AudioBuffer and scans it (`seamCheck`) on the UI thread.
  PerformanceObserver saw one 74 ms long task per render; a MIDI note arriving then waits for it (menu-bar mode: hidden
  window, player still playing). Options: run the post-processing in chunks / an idle callback, or defer a
  re-render while notes are held (start it after ~1 s without input).
- **R5 Key change on a drone with a short song fade dips 10–17 dB** (drone-osc 2 s attack vs a 0.3 s fade; the live
  path, not lowres2): with the loop in play the dip varied −7.4 … −16.6 vs −10.6 … −11.6 live. With the default 4 s
  fade it doesn't show.
- **R6 Still pending from the builder:** C9 `perform.js renderQuick` `audio: a`, C9 `main.js renderAudioStatus`
  'asleep', `views/mini.js` 'asleep' text, LOCAL Energy Impact re-measure.
- Unrelated flake seen once under load: `offline.sampleRetry` (`flakyAttempts` 3 vs 2); passed on the re-run.
