# idle-cpu-ui critic (2026-09-29)

Scope: the UI side of the idle-CPU work (CONTRACT_CHANGES "## idle-cpu-ui"). Re-measured with the harness, re-ran the
suites, probed the wake paths in the real app. One bug fixed in place (below); the rest are small leftovers, none
blocking.

## Verified

`node tools/idle-cpu.mjs --only A,B,D,E,G2,W --measure 10 --settle 8 --no-offline` (this 2-CPU box at load 7–9 with
another agent's theme suite running, headless = 60 Hz):

| config | rAF/s | style recalcs/s | layouts/s | master reads/s | timers/s | main + comp % |
|---|---|---|---|---|---|---|
| A drone on | 26.2 | 25 | 0 | 52.4 | 33.8 | 4.3 |
| B drone off | 0 | 0 | 0 | 2 | 8.6 | 0.9 |
| D low-resource | 0 | 0 | 0 | 0 | 2.1 | 0.3 |
| E Edit, drone on | 24.4 | 24 | 0 | 48.8 (shared read) | 31.9 | 4.3 |
| W hidden (event) | 0 | 0 | 0 | 0 | 2.1 | 0.3 |
| G2 silent | 0 | 0 | 0 | 2 | 8.6 | 0.4 |

rAF/reads below 30/60 in A/E are the loaded box dropping frames, not a cap bug. The fixer's numbers hold.

Wake paths probed in the real app (scratch Playwright, not kept): a song switch that starts a drone (no key / pointer
input), a popover `droneToggle` bus command, a raw MIDI CC through `midi._inject`, a note with Edit › Keys open (slot
level meter lifts), a note in Perform (strip meter lifts), `rig:window-visible` false → true with the drone on. All wake
within one frame; 0 console errors.

## Fixed: a meter back from a gap replayed a stale bar

`meterClock` handed every tick `dt = min(100, now − lastRun)`, the loop's frame gap, and `FRAME_MS` on the first frame
after a stop. A meter that was blocked (low-resource, hidden window) or off screen (Edit's Master meter while Perform
shows, Perform strips while Edit shows) kept its old `level`, and on return released it at 20 dB/s from there.

Repro (before): drone on (bar ≈ 0.74), low-resource on, drone off, wait 4 s, low-resource off → the top bar shows
0.72 and falls for ~2 s although the output is already at −32 dBFS (0.47). Same for Edit's Master meter after leaving
Edit during a loud passage and coming back after it stopped.

Fix: `dt` is per meter (`now − e.last`, capped at 5 s), so the first tick after any gap releases straight to the
current level. The fast-attack / peak-hold / clip logic already used `now`, so nothing else changes; a meter woken from
sleep was at rest anyway. Test: ui-core `idle-cpu-ui critic: a meter back from low-resource shows the current level at
once` (fails on the old clock: 0.876 vs < 0.05).

## Remaining (not fixed; small)

1. **EQ editor open in normal mode runs at the display rate.** `eq-keyboard.js frame()` re-arms rAF every frame while
   open and draws the live spectrum (`getFloatFrequencyData` × 2–3) each frame: ~120 rAF/s on ProMotion while
   Advanced › Tone is open. Only while that panel is open, and the spectrum is its point, so not an idle cost; if the
   Mac shows it, route it through `meterClock` (30 fps) or skip frames by timestamp plus a pre-frame timeout as
   meterClock does. Repro: Edit › Keys › Advanced › Tone open, drone on, harness-style rAF counter → ≈ display Hz.
2. **Perform's runtime timer keeps ticking while Edit shows.** `perform.js runtimeTick` skips `readRuntime()` while
   `root.hidden` but still re-arms every 150 ms (6.6 timers/s of nothing in config E). Harmless; could use
   `RUNTIME_LOW_MS` while hidden (lamps would then catch up ≤ 1 s after returning; CC64 still lights at once).
3. **Recording clock** (`main.js recTimer`, 250 ms interval) keeps running under low-resource / a hidden window while
   recording. 4 timers/s, text writes 1/s; only while recording. There is no recorder level display to gate.
4. **Engine fx idle taps**: ~11.7 AnalyserNode reads/s in every config, including D and W (`fx.js _tapPeak`, the send
   effects' 4 Hz idle poll over 3 taps, 16 k-sample windows). Engine-side by design (it is what lets the reverb sleep);
   listed so the `an` column is not mistaken for a UI leak.
5. **Probe in Edit**: while silent, the 1 Hz safety probe reads the analysers once per visible stereo meter (top bar +
   Edit › Master: 4 reads/s instead of 2). It could reuse the shared `framePeaks` read. Negligible.
6. **L-24** stays unconfirmed (see "## idle-cpu-ui"); LOCAL should read `__rig.diag.drone` after a repro.
7. **Level meters have no probe.** If the top-bar meter is ever hidden (no current layout hides it) and sound starts
   without an activity event (a scheduled song change landing > 500 ms later), strip meters would stay asleep until
   the next input. Today the top-bar probe wakes every meter within 1 s.

## Suites (this run, load 7–10, another agent's suites in parallel)

ui-core 67/69 (`hardware-fixes 2b`, known; `H-v2 Quick sheet` TAP tempo at load 10, passes alone); edit-v2 `--only
integration` 2/2 files; mini 14/14 + mini-theme 14/14 (one earlier mini run failed at load ≈ 10 on 3 rAF frames/s; the test
now waits for ≥ 20 frames).
