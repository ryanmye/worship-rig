# E3 skeptic: ui-core read races (v11-decisions, v11-metronome, polish-2A banners)

**Verdict: VERIFIED** (with four small skeptic fixes, below). The three fixes are test-only. Every touched test still
fails on a genuine app bug, on the web engine and on `rig-devhost`: 7 injected bugs, all caught. One of them, "Esc
folds the strip and also panics", passes the HEAD suite under a 600 ms event delay, so HEAD's banners check was
vacuous in exactly the way PARITY describes. The reproductions hold: HEAD fails all three at 200 ms and at 600 ms, and
the fixed suite passes all three. E3 does not change web runtime: in interleaved base and fixed pairs on the same box,
the fixed run was the faster one both times.

Tree: `/home/claude/wt-e3` (lane-e3, uncommitted on `3e1d006`). Fresh `rig-devhost` (g++ Release, Ninja) in a scratch
dir outside the repo. Bug injections went into a scratch copy of the repo, never into the worktree's `app/`. The box
was shared with one heavy agent (load 4-8 during the timing runs).

## Gates

| gate | result |
|---|---|
| No `app/` change | yes: `git diff` touches `test/phase2/ui-core/run.mjs` and 3 docs only. No untracked files apart from the `node_modules` symlink |
| Knobs not in shipped code | yes: `RIG_TEST_EVENT_DELAY_MS` / `RIG_TEST_NOTE_ON_DELAY_MS` live only in `run.mjs` (`DELAY_IN_PAGE`). When they are unset the page is never touched. On the web engine they do nothing (no `_onEvent`) |
| Repro, HEAD suite + knobs (devhost `--no-adapter`, `--grep`, one test per run) | banners FAIL "that Esc did not panic" (note-on delay 200 / 600); v11-metronome FAIL strict-equal (event delay 200 / 600); v11-decisions FAIL deep-equal (event delay 200 / 600) |
| Repro, fixed suite + knobs | 3/3 pass with the single knob at 200 / 600, and with both knobs at 600. After the skeptic fixes: 3/3 pass with both knobs at 200 and at 600. The knob reports `on` |
| Injected bugs (fixed suite; web with no knob, devhost with both knobs at 600) | 7 / 7 fail on both engines (table below) |
| Cleanup hooks on failure | run on fail; no cascade. With a forced `assert.fail` under Lock while the click runs, v11-decisions and "no console errors" pass (web and devhost). The HEAD suite cascades on both engines (v11-decisions fails after a 30 s wait) |
| Waits bounded, clear | `waitState` wraps `waitForFunction` with a 5 s timeout. Its error names the state and snapshots `clickState()`, `holds(60)` and `holds(64)`. `freshStats` is bounded at 4 s with a 25 ms poll. E3 adds no sleeps (the 100-250 ms `waitForTimeout`s in these tests were already there) |
| Web runtime x 4 (interleaved H / F / H / F) | 78/78 every time. Sums: H1 374 s, F1 350 s, H2 349 s, F2 328 s |
| Devhost `--no-adapter` x 1 | 78/78, 317 s. No bridge error reply; the two known warns; `sanitizer: (none)` |
| Style | 2 code lines over 120 and 1 doc line over 120: fixed. No eslint config in the repo; the rest of the style was checked by eye |

### Injected bugs (scratch copy; restored and checked against the worktree after each)

| bug (where) | test | web | devhost, both knobs at 600 |
|---|---|---|---|
| Panic doesn't release notes (`panic()` without `allNotesOff`) | v11-decisions | FAIL "Panic released note 64 and stopped the click" | FAIL, same |
| Esc doesn't panic (`case 'Escape'` empty) | v11-decisions | FAIL (was a bare 30 s timeout; now "Esc (the Panic key) turned the click chip off", 5 s) | FAIL, same |
| Next keeps the old tempo (no `setTempo` on a new song) | v11-metronome | FAIL (snapshot `bpm 100`) | FAIL |
| Next keeps the old meter (no `setTimeSig` on a new song) | v11-metronome | FAIL (snapshot `sig 4/4`) | FAIL |
| Next drops the held note (`allNotesOff` at the start / at the end of `applySongLevel`) | v11-metronome | FAIL, both | FAIL, both (also with no knob) |
| Esc folds the strip **and** panics (`overlay.js` without `preventDefault` / `stopPropagation`) | banners | FAIL "that Esc did not panic" | FAIL (also with no knob). **HEAD suite with event delay 600: PASS** (vacuous) |

### Runtime (ms; H = HEAD suite, F = fixed, run alternately on the same box)

| run | load | banners | v11-metronome | v11-decisions | other 75 | total |
|---|---|---|---|---|---|---|
| web H1 | 4.4-8.0 | 1112 | 3917 | 281 | 368.5 s | 373.8 s |
| web F1 | 7.7-8.0 | 1232 | 3695 | 362 | 344.1 s | 349.4 s |
| web H2 | 5.7-7.7 | 1161 | 3792 | 400 | 343.2 s | 348.6 s |
| web F2 | 4.8-5.7 | 1171 | 3648 | 315 | 322.4 s | 327.6 s |
| devhost F | 4.1-5.0 | 2620 | 4680 | 319 | 309.2 s | 316.8 s |

**Settled:** on the web engine the three touched tests are within ±0.2 s of base, the metronome test is slightly
faster, and each fixed run was 21-25 s faster than the base run before it. The builder's 5-11% was load. The
untouched 75 tests account for all of the swing. On devhost, banners costs about 1 s more because of the skeptic's
second stats frame (F1 below).

## Findings

- **F1 (fixed, banners).** After Esc the test waited for one stats frame and ignored what `freshStats` returned. The
  first frame-counter change can come from a frame the core built before it read the Esc, still in flight. In that
  case an Esc-panics bug passes. The window is a few ms per second, so this is a false pass and not a flake. Now
  `assert.ok(freshStats(2))`. This costs about 1 s on the bridge and nothing on the web.
- **F2 (fixed, v11-decisions).** The two `aria-pressed === 'false'` waits after Panic and after Esc were bare 30 s
  `waitForFunction`s. "Esc doesn't panic" failed after 35.7 s with "Timeout 30000ms exceeded". Both are now
  `waitState` calls with names (5 s; this is page state, set synchronously).
- **F3 (fixed).** The knobs could silently do nothing: they rely on `bridge-engine.js:255`
  `onEvent: (m) => this._onEvent(m)` being late-bound. `installEventDelay` now prints
  `# E3 event delay knobs (a / b ms): on | off: not the bridge engine`.
- **F4 (fixed).** Line length: the `waitState` throw, the metronome condition, and `REPICKUP.md`. `PARITY.md`: the
  banners row now says two frames, and an E3-skeptic note was added under the proof paragraph.
- **F5 (no defect).** None of the waits makes an assertion vacuous. Each wait condition is the asserted state, or
  stricter than it. A missing state fails the wait (5 s) with a snapshot, and the strict assert still runs after it.
  On the web engine the waits are true at once.

## Open items (low)

- O1. `ui-core-devhost.mjs` echoes only `ok` / `not ok` lines, so the F3 notice is in the TAP and not in the
  console report. Widen its regex to `^# E3` (line 105 is already 120 characters, so it needs a reflow).
- O2. The `waitState` messages say "core `notes` / `click` event" on the web engine as well. Cosmetic.
- O3. The v11-metronome hook resets `songs.<b>.timeSig` to `null` rather than to the original value. This was
  already so before E3, and is fine for the factory song.
- O4. The v11-decisions hook's `noteOff(64)` goes through the controller. After a Panic bug like the one injected
  above, the controller has forgotten the note, so the engine keeps it. Only "no console errors" follows, so nothing
  is masked today. If a test is ever added after it, use `allNotesOff`.
- O5. Pre-existing sleeps over 50 ms in the touched tests (`waitForTimeout` 100 / 150 / 250 for layout settling).
  E3 did not add them.
